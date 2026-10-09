// 認証のルート
//   POST /api/login          ユーザID・パスワードで認証し、アクセストークンを発行する（有効期限1日）
//   GET  /api/validatetoken  トークンが有効か確認し、ログインユーザの情報を返す
//   POST /api/logout         トークンを無効化する
// - login は要件表では GET だが、パスワードを URL（アクセスログ・履歴）に残さないため POST とする（tasklog の決定事項）
// - 発行したトークンはレスポンスで1回だけ返し、DB にはハッシュ値のみ保存する
// - ユーザが存在しない・パスワード不一致・削除済みは区別せず同じ 401 を返す（ユーザIDの存在を推測させない）
const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db/pool');
const asyncHandler = require('../utils/asyncHandler');
const { unauthorized } = require('../utils/httpError');
const { requireAuth } = require('../middleware/auth');
const { TOKEN_TTL_MS, generateToken, hashToken } = require('../auth/token');
const { validateFields, assertPlainObject } = require('../utils/validators');

const router = express.Router();

const LOGIN_FAILED_MESSAGE = 'ユーザIDまたはパスワードが正しくありません';

// ユーザが存在しない場合も bcrypt.compare を実行し、応答時間からユーザIDの存在を推測されないようにする
// （値は "dummy-password" をコスト10でハッシュ化したもの。どのパスワードとも一致しない用途でのみ使う）
const DUMMY_HASH = '$2b$10$wBAiIeK3upAvJjIXw8I0Lumacll/Uu5NpQ9d4fYZlITJoPJozp38e';

const LOGIN_SPEC = {
  user_id: { type: 'string', required: true, trim: false, maxLength: 50 },
  // bcrypt が扱える72バイトを超えるものは照合しない（usr.js の登録時の制限と同じ）
  password: { type: 'string', required: true, trim: false, allowEmpty: false, maxBytes: 72 },
};

// レスポンスで返すログインユーザの情報
function toUserInfo(row) {
  return { user_id: row.user_id, user_name: row.user_name, role: row.role };
}

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    assertPlainObject(req.body);
    const input = validateFields(req.body, LOGIN_SPEC);

    const { rows } = await pool.query(
      'SELECT user_id, user_name, role, password_hash FROM users WHERE user_id = $1 AND is_deleted = FALSE',
      [input.user_id]
    );
    const user = rows[0];
    const matched = await bcrypt.compare(input.password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !matched) throw unauthorized(LOGIN_FAILED_MESSAGE);

    // 新しいトークンで上書きする（同じユーザの以前のトークンは無効になる）
    // 有効期限は DB 側の時刻で計算し、requireAuth の now() 比較とずれないようにする
    const token = generateToken();
    const { rows: updated } = await pool.query(
      `UPDATE users
          SET token = $1, token_expires_at = now() + ($2 * interval '1 millisecond')
        WHERE user_id = $3 AND is_deleted = FALSE
       RETURNING token_expires_at`,
      [hashToken(token), TOKEN_TTL_MS, user.user_id]
    );
    // 照合の直後に削除された場合
    if (updated.length === 0) throw unauthorized(LOGIN_FAILED_MESSAGE);

    res.json({ token, expires_at: updated[0].token_expires_at, user: toUserInfo(user) });
  })
);

router.get('/validatetoken', requireAuth, (req, res) => {
  res.json({ valid: true, expires_at: req.user.token_expires_at, user: toUserInfo(req.user) });
});

router.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    // 別の端末で再ログインして差し替わったトークンは消さないよう、ハッシュ値も条件にする
    await pool.query(
      'UPDATE users SET token = NULL, token_expires_at = NULL WHERE user_id = $1 AND token = $2',
      [req.user.user_id, req.tokenHash]
    );
    res.status(204).end();
  })
);

module.exports = router;
