// ユーザマスタ（users）のルート
//   GET    /api/usr             ユーザ一覧（ID・氏名の部分一致、ロールで絞り込み）
//   POST   /api/usr             登録（update_seq なし）・更新（update_seq あり。楽観ロック）
//   DELETE /api/usr/:user_id    論理削除（楽観ロック：クエリ update_seq 必須）
// パスワードは bcrypt でハッシュ化して保存し、レスポンスにはパスワードハッシュ・トークンを含めない。
// 管理者のみ操作可能とする認可チェックは src/app.js で requireAuth / requireAdmin を通して行う。
const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db/pool');
const { withTransaction } = require('../db/transaction');
const asyncHandler = require('../utils/asyncHandler');
const { badRequest, notFound, conflict } = require('../utils/httpError');
const { getOperatorId } = require('../utils/operator');
const {
  PG_INTEGER_MAX,
  validateFields,
  assertPlainObject,
  queryString,
  queryInteger,
  parsePaging,
  assertAllowedQuery,
  escapeLike,
} = require('../utils/validators');

const router = express.Router();

// bcrypt のコスト（db/migrations/006 の初期管理者と同じ 10）
const BCRYPT_COST = 10;

// レスポンスで返す列（password_hash・token・token_expires_at は絶対に含めない）
const SELECT_COLUMNS = 'user_id, user_name, role, created_at, created_by, updated_at, updated_by, update_seq';

// 項目定義（桁数は db/migrations/002_create_users.sql の列定義に合わせる）
const USER_SPEC = {
  // ユーザID：英数字と . _ - のみ、50文字以内（前後の空白は許可しない）
  user_id: {
    type: 'string',
    required: true,
    trim: false,
    maxLength: 50,
    pattern: /^[A-Za-z0-9._-]+$/,
    patternMessage: 'user_id は半角英数字と . _ - のみで指定してください',
  },
  user_name: { type: 'string', maxLength: 100 },
  // パスワード：8文字以上、bcrypt が扱える72バイト以内（前後の空白もパスワードの一部として扱う）
  // allowEmpty: false … 空文字を NULL に変換せず 400 にする（空白のみのパスワードも 400）
  password: { type: 'string', trim: false, allowEmpty: false, minLength: 8, maxBytes: 72 },
  role: { type: 'enum', values: ['admin', 'general'] },
  // 更新シーケンス：指定ありなら更新、なしなら新規登録
  update_seq: { type: 'integer', min: 0, max: PG_INTEGER_MAX },
};

// 「有効な管理者が1人もいなくなる」操作を防ぐ
// 管理者行を行ロックしてから数えることで、同時に2人を降格・削除するケースにも対応する
async function assertAnotherAdminExists(client, userId) {
  const { rows } = await client.query(
    `SELECT user_id FROM users WHERE role = 'admin' AND is_deleted = FALSE FOR UPDATE`
  );
  if (!rows.some((r) => r.user_id !== userId)) {
    throw conflict('有効な管理者ユーザが1人もいなくなるため、この操作はできません');
  }
}

// 楽観ロックで更新件数が0件だった場合の原因を判定する（存在しない → 404、シーケンス不一致 → 409）
async function throwNotFoundOrConflict(client, userId) {
  const { rows } = await client.query('SELECT 1 FROM users WHERE user_id = $1 AND is_deleted = FALSE', [userId]);
  if (rows.length === 0) throw notFound('指定されたユーザが見つかりません');
  throw conflict('他のユーザによって更新されています。最新の情報を取得してから再度実行してください');
}

// 一覧取得
// クエリ: user_id / user_name（部分一致）, role（admin / general）, limit, offset
router.get(
  '/',
  asyncHandler(async (req, res) => {
    assertAllowedQuery(req.query, ['user_id', 'user_name', 'role', 'limit', 'offset']);
    const conditions = ['is_deleted = FALSE'];
    const params = [];

    for (const [field, max] of [['user_id', 50], ['user_name', 100]]) {
      const value = queryString(req.query, field);
      if (value !== undefined && value.trim() !== '') {
        if ([...value.trim()].length > max) {
          throw badRequest('入力内容に誤りがあります', [{ field, message: `${field} は${max}文字以内で指定してください` }]);
        }
        params.push(`%${escapeLike(value.trim())}%`);
        conditions.push(`${field} ILIKE $${params.length}`);
      }
    }

    const role = queryString(req.query, 'role');
    if (role !== undefined && role !== '') {
      if (role !== 'admin' && role !== 'general') {
        throw badRequest('入力内容に誤りがあります', [{ field: 'role', message: 'role は admin / general のいずれかで指定してください' }]);
      }
      params.push(role);
      conditions.push(`role = $${params.length}`);
    }

    const { limit, offset } = parsePaging(req.query);
    params.push(limit, offset);

    const { rows } = await pool.query(
      `SELECT ${SELECT_COLUMNS}, COUNT(*) OVER() AS total_count
         FROM users
        WHERE ${conditions.join(' AND ')}
        ORDER BY user_id
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
    const items = rows.map(({ total_count, ...row }) => row); // eslint-disable-line no-unused-vars
    res.json({ total, count: items.length, limit, offset, items });
  })
);

// 登録・更新
//   登録: { user_id, user_name, password, role? }                 → 201
//   更新: { user_id, update_seq, user_name?, password?, role? }   → 200（指定項目のみ更新）
router.post(
  '/',
  asyncHandler(async (req, res) => {
    assertPlainObject(req.body);
    const isUpdate = req.body.update_seq !== undefined && req.body.update_seq !== null;
    const input = validateFields(req.body, {
      ...USER_SPEC,
      // 新規登録時は氏名・パスワード必須
      user_name: { ...USER_SPEC.user_name, required: !isUpdate || req.body.user_name !== undefined },
      password: { ...USER_SPEC.password, required: !isUpdate },
    });
    const operator = getOperatorId(req);

    // bcrypt は CPU 負荷が高いため、トランザクション（ロック保持）の外でハッシュ化しておく
    // （バリデーション済みのため文字列のはずだが、null 等を bcrypt に渡して 500 にならないよう型も確認する）
    if (input.password !== undefined && typeof input.password !== 'string') {
      throw badRequest('入力内容に誤りがあります', [{ field: 'password', message: 'password は文字列で指定してください' }]);
    }
    const passwordHash = input.password !== undefined ? await bcrypt.hash(input.password, BCRYPT_COST) : undefined;

    if (!isUpdate) {
      // 新規登録（論理削除済みを含め、同じユーザIDがあれば 409）
      const { rows } = await pool.query(
        `INSERT INTO users (user_id, user_name, password_hash, role, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (user_id) DO NOTHING
         RETURNING ${SELECT_COLUMNS}`,
        [input.user_id, input.user_name, passwordHash, input.role ?? 'general', operator]
      );
      if (rows.length === 0) throw conflict('同じユーザIDが既に登録されています（削除済みのユーザを含む）');
      return res.status(201).json(rows[0]);
    }

    // 更新
    const user = await withTransaction(async (client) => {
      const sets = [];
      const params = [];
      if (input.user_name !== undefined) {
        params.push(input.user_name);
        sets.push(`user_name = $${params.length}`);
      }
      if (input.role !== undefined) {
        // 管理者 → 一般 への降格で管理者が不在にならないか確認する
        if (input.role === 'general') await assertAnotherAdminExists(client, input.user_id);
        params.push(input.role);
        sets.push(`role = $${params.length}`);
      }
      if (passwordHash !== undefined) {
        params.push(passwordHash);
        sets.push(`password_hash = $${params.length}`);
        // パスワード変更時は既存のトークンを無効化し、再ログインさせる
        sets.push('token = NULL', 'token_expires_at = NULL');
      }
      if (sets.length === 0) throw badRequest('更新する項目（user_name / password / role）を1つ以上指定してください');

      params.push(operator, input.user_id, input.update_seq);
      const n = params.length;
      const { rows } = await client.query(
        `UPDATE users SET ${sets.join(', ')}, updated_by = $${n - 2}
          WHERE user_id = $${n - 1} AND is_deleted = FALSE AND update_seq = $${n}
         RETURNING ${SELECT_COLUMNS}`,
        params
      );
      if (rows.length === 0) await throwNotFoundOrConflict(client, input.user_id);
      return rows[0];
    });
    return res.json(user);
  })
);

// 論理削除（クエリ ?update_seq= 必須）。削除時はトークンも無効化する
router.delete(
  '/:user_id',
  asyncHandler(async (req, res) => {
    const { user_id: userId } = validateFields({ user_id: req.params.user_id }, { user_id: USER_SPEC.user_id });
    assertAllowedQuery(req.query, ['update_seq']);
    const updateSeq = queryInteger(req.query, 'update_seq', { required: true });

    await withTransaction(async (client) => {
      // 最後の管理者は削除させない
      await assertAnotherAdminExists(client, userId);
      const { rowCount } = await client.query(
        `UPDATE users
            SET is_deleted = TRUE, token = NULL, token_expires_at = NULL, updated_by = $1
          WHERE user_id = $2 AND is_deleted = FALSE AND update_seq = $3`,
        [getOperatorId(req), userId, updateSeq]
      );
      if (rowCount === 0) await throwNotFoundOrConflict(client, userId);
    });
    res.status(204).end();
  })
);

module.exports = router;
