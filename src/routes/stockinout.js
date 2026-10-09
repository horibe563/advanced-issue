// 入出庫履歴（stock_ins / stock_outs）のルート
//   GET  /api/stockinout   入出庫履歴の一覧（jan_cd・種別・伝票NO・期間で絞り込み）
//   POST /api/stockinout   入庫・出庫の登録（新規伝票 / 訂正伝票）
//
// 入出庫伝票のルール（docs/requirements.md）
//   - 伝票フラグ 1:正 / 2:負。数量は常に正の整数で、正負は伝票フラグで表す
//   - 訂正は元の行を上書きせず、同一伝票NOで伝票シーケンスNOを +1 した行を追加する
//   - 伝票NOはアプリ側で採番する（本実装では入庫・出庫で共通の連番とする）
//   - 在庫数の加減算はアプリ側でトランザクション内で行い、商品行を行ロック（FOR UPDATE）して
//     同時更新による在庫数の不整合を防ぐ
const express = require('express');
const pool = require('../db/pool');
const { withTransaction } = require('../db/transaction');
const { nextSlipNo } = require('../db/slipNo');
const asyncHandler = require('../utils/asyncHandler');
const { badRequest, notFound, conflict } = require('../utils/httpError');
const { getOperatorId } = require('../utils/operator');
const {
  PG_INTEGER_MAX,
  janCdError,
  validateFields,
  queryString,
  queryInteger,
  parsePaging,
  assertAllowedQuery,
  isValidDateString,
} = require('../utils/validators');

const router = express.Router();

// 種別ごとのテーブル名・日付列名（SQL に埋め込むのはこの固定値のみ）
// 通常のオブジェクトリテラルだと TABLES['constructor'] や TABLES['__proto__'] のように
// プロトタイプのプロパティが参照できてしまい、検証をすり抜けて「FROM undefined」の SQL が組まれる。
// そのためプロトタイプを持たないオブジェクトにし、凍結して実行時の書き換えも防ぐ。
const TABLES = Object.freeze(
  Object.assign(Object.create(null), {
    in: Object.freeze({ table: 'stock_ins', dateColumn: 'stock_in_date', label: '入庫' }),
    out: Object.freeze({ table: 'stock_outs', dateColumn: 'stock_out_date', label: '出庫' }),
  })
);

// 種別が定義済み（in / out）かどうか（自身のプロパティのみを対象にする）
function isValidType(type) {
  return typeof type === 'string' && Object.hasOwn(TABLES, type);
}

// 種別に対応するテーブル定義を返す
// 呼び出し前に検証済みであることが前提だが、万一未定義の種別が来た場合は SQL を組まずに例外とする
function getTableDef(type) {
  if (!isValidType(type)) {
    throw new Error(`未定義の入出庫種別です: ${String(type)}`);
  }
  return TABLES[type];
}

// 伝票フラグ
const SLIP_FLAG_POSITIVE = 1; // 正
const SLIP_FLAG_NEGATIVE = 2; // 負

// 登録時の項目定義（桁数・範囲は db/migrations/004, 005 の列定義に合わせる）
const CREATE_SPEC = {
  // 種別（in: 入庫 / out: 出庫）
  type: { type: 'enum', values: ['in', 'out'], required: true },
  // 訂正時に指定する伝票NO（省略時は新規伝票として採番する）
  slip_no: { type: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER },
  // JAN コード（新規伝票では必須。訂正時は省略可、指定する場合は元伝票と一致すること）
  jan_cd: { type: 'jan' },
  // 入庫日 / 出庫日（省略時は DB の当日日付）
  date: { type: 'date' },
  // 数量（正の整数）
  quantity: { type: 'integer', required: true, min: 1, max: PG_INTEGER_MAX },
  // 伝票フラグ（省略時は 1:正）
  slip_flag: { type: 'enum', values: [SLIP_FLAG_POSITIVE, SLIP_FLAG_NEGATIVE] },
};

// 在庫数への影響（符号付き数量）を求める
// 入庫: 正=加算 / 負=減算、出庫: 正=減算 / 負=加算
function stockDelta(type, slipFlag, quantity) {
  const positive = slipFlag === SLIP_FLAG_POSITIVE;
  return (type === 'in') === positive ? quantity : -quantity;
}

// DB の行をレスポンス形式に変換する（BIGINT は文字列で返るため数値に変換する）
function toHistoryItem(row) {
  return {
    type: row.type,
    id: Number(row.id),
    slip_no: Number(row.slip_no),
    slip_seq: row.slip_seq,
    jan_cd: row.jan_cd,
    product_name: row.product_name,
    date: row.date,
    quantity: row.quantity,
    slip_flag: row.slip_flag,
    // 在庫数への影響（入庫・正なら +、出庫・正なら - など）
    stock_delta: stockDelta(row.type, row.slip_flag, row.quantity),
    created_at: row.created_at,
    created_by: row.created_by,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
    update_seq: row.update_seq,
  };
}

// 履歴1行分の SELECT（種別ごと。日付は 'YYYY-MM-DD' 文字列で返しタイムゾーンのずれを避ける）
function historySelect(type) {
  const { table, dateColumn } = getTableDef(type);
  return `
    SELECT '${type}' AS type, h.id, h.slip_no, h.slip_seq, h.jan_cd, p.product_name,
           to_char(h.${dateColumn}, 'YYYY-MM-DD') AS date, h.${dateColumn} AS sort_date,
           h.quantity, h.slip_flag,
           h.created_at, h.created_by, h.updated_at, h.updated_by, h.update_seq
      FROM ${table} h
      JOIN products p ON p.jan_cd = h.jan_cd
     WHERE h.is_deleted = FALSE`;
}

// 一覧取得
// クエリ: type（in / out）, jan_cd（完全一致）, slip_no, date_from, date_to（YYYY-MM-DD）, limit, offset
router.get(
  '/',
  asyncHandler(async (req, res) => {
    assertAllowedQuery(req.query, ['type', 'jan_cd', 'slip_no', 'date_from', 'date_to', 'limit', 'offset']);
    const errors = [];
    const conditions = [];
    const params = [];

    const type = queryString(req.query, 'type');
    if (type !== undefined && type !== '' && !isValidType(type)) {
      errors.push({ field: 'type', message: 'type は in / out のいずれかで指定してください' });
    }

    const janCd = queryString(req.query, 'jan_cd');
    if (janCd !== undefined && janCd !== '') {
      const err = janCdError(janCd);
      if (err) errors.push({ field: 'jan_cd', message: err });
      params.push(janCd);
      conditions.push(`jan_cd = $${params.length}`);
    }

    const slipNo = queryInteger(req.query, 'slip_no', { min: 1, max: Number.MAX_SAFE_INTEGER });
    if (slipNo !== undefined) {
      params.push(slipNo);
      conditions.push(`slip_no = $${params.length}`);
    }

    const dateFrom = queryString(req.query, 'date_from');
    const dateTo = queryString(req.query, 'date_to');
    for (const [field, value, op] of [['date_from', dateFrom, '>='], ['date_to', dateTo, '<=']]) {
      if (value === undefined || value === '') continue;
      if (!isValidDateString(value)) {
        errors.push({ field, message: `${field} は YYYY-MM-DD 形式の正しい日付で指定してください` });
        continue;
      }
      params.push(value);
      conditions.push(`sort_date ${op} $${params.length}::date`);
    }
    if (dateFrom && dateTo && isValidDateString(dateFrom) && isValidDateString(dateTo) && dateFrom > dateTo) {
      errors.push({ field: 'date_from', message: 'date_from は date_to 以前の日付を指定してください' });
    }

    const { limit, offset } = parsePaging(req.query);
    if (errors.length > 0) throw badRequest('入力内容に誤りがあります', errors);

    // 種別指定があれば該当テーブルのみ、なければ入庫・出庫を UNION ALL で結合する
    // （ここに来る時点で type は検証済み。historySelect 内でも getTableDef で再確認する）
    const types = type ? [type] : ['in', 'out'];
    const unionSql = types.map((t) => historySelect(t)).join(' UNION ALL ');
    params.push(limit, offset);

    const sql = `
      SELECT *, COUNT(*) OVER() AS total_count
        FROM (${unionSql}) hist
       ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY sort_date DESC, slip_no DESC, slip_seq DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const { rows } = await pool.query(sql, params);

    const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
    const items = rows.map(toHistoryItem);
    res.json({ total, count: items.length, limit, offset, items });
  })
);

// 入庫・出庫の登録
//   新規伝票: { type, jan_cd, quantity, date?, slip_flag?(1のみ) }
//   訂正伝票: { type, slip_no, quantity, slip_flag, date?, jan_cd?(元伝票と一致すること) }
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = validateFields(req.body, CREATE_SPEC);
    const { type, quantity } = input;
    const slipFlag = input.slip_flag ?? SLIP_FLAG_POSITIVE;
    const isCorrection = input.slip_no !== undefined;
    const { table, dateColumn, label } = getTableDef(type);
    const operator = getOperatorId(req);

    if (!isCorrection) {
      if (input.jan_cd === undefined) {
        throw badRequest('入力内容に誤りがあります', [{ field: 'jan_cd', message: 'jan_cd は必須です' }]);
      }
      // 元伝票は「正」で登録する（負の値は訂正伝票でのみ表現する）
      if (slipFlag !== SLIP_FLAG_POSITIVE) {
        throw badRequest('入力内容に誤りがあります', [
          { field: 'slip_flag', message: '新規伝票の slip_flag は 1（正）で指定してください。負の訂正は slip_no を指定して行います' },
        ]);
      }
    }

    const result = await withTransaction(async (client) => {
      let janCd = input.jan_cd;

      // 訂正伝票：対象の伝票NOから商品を特定する
      if (isCorrection) {
        const { rows } = await client.query(
          `SELECT jan_cd FROM ${table} WHERE slip_no = $1 AND is_deleted = FALSE AND slip_seq = 1`,
          [input.slip_no]
        );
        if (rows.length === 0) throw notFound(`指定された伝票NOの${label}伝票が見つかりません`);
        if (janCd !== undefined && janCd !== rows[0].jan_cd) {
          throw badRequest('入力内容に誤りがあります', [
            { field: 'jan_cd', message: '訂正伝票の jan_cd は元伝票と同じ値を指定してください' },
          ]);
        }
        janCd = rows[0].jan_cd;
      }

      // 商品行を行ロックする（同じ商品への入出庫・訂正はここで直列化される）
      const productRes = await client.query(
        'SELECT stock FROM products WHERE jan_cd = $1 AND is_deleted = FALSE FOR UPDATE',
        [janCd]
      );
      if (productRes.rows.length === 0) throw notFound('指定された商品が見つかりません');
      const currentStock = productRes.rows[0].stock;

      // 在庫数の加減算（マイナス在庫は許可しない）
      const delta = stockDelta(type, slipFlag, quantity);
      const newStock = currentStock + delta;
      if (newStock < 0) {
        throw conflict(`在庫数が不足しているため登録できません（現在の在庫数: ${currentStock}）`);
      }
      if (newStock > PG_INTEGER_MAX) {
        throw conflict('在庫数の上限を超えるため登録できません');
      }

      let slipNo;
      let slipSeq;
      if (isCorrection) {
        // 商品行ロック取得後に伝票の現在値を読み直す（同一伝票への同時訂正に備える）
        const { rows } = await client.query(
          `SELECT MAX(slip_seq) AS max_seq,
                  COALESCE(SUM(CASE WHEN slip_flag = 1 THEN quantity ELSE -quantity END), 0) AS net_quantity
             FROM ${table}
            WHERE slip_no = $1 AND is_deleted = FALSE`,
          [input.slip_no]
        );
        const netAfter = Number(rows[0].net_quantity) + (slipFlag === SLIP_FLAG_POSITIVE ? quantity : -quantity);
        if (netAfter < 0) {
          throw conflict(`訂正後の伝票数量がマイナスになるため登録できません（現在の伝票数量: ${rows[0].net_quantity}）`);
        }
        if (rows[0].max_seq >= PG_INTEGER_MAX) throw conflict('この伝票はこれ以上訂正できません');
        slipNo = input.slip_no;
        slipSeq = rows[0].max_seq + 1;
      } else {
        // 新規伝票NOの採番（共通処理：アドバイザリロック + 入庫・出庫共通の MAX + 1）
        slipNo = await nextSlipNo(client);
        slipSeq = 1;
      }

      // 履歴行の追加（日付省略時は DB の当日日付）
      const insertRes = await client.query(
        `INSERT INTO ${table} (slip_no, slip_seq, jan_cd, ${dateColumn}, quantity, slip_flag, created_by, updated_by)
         VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5, $6, $7, $7)
         RETURNING '${type}' AS type, id, slip_no, slip_seq, jan_cd,
                   to_char(${dateColumn}, 'YYYY-MM-DD') AS date, quantity, slip_flag,
                   created_at, created_by, updated_at, updated_by, update_seq`,
        [slipNo, slipSeq, janCd, input.date ?? null, quantity, slipFlag, operator]
      );

      // 在庫数の更新（update_seq・updated_at はトリガーで自動更新）
      const updateRes = await client.query(
        `UPDATE products SET stock = $1, updated_by = $2
          WHERE jan_cd = $3
         RETURNING jan_cd, product_name, stock, threshold, (stock < threshold) AS is_alert, update_seq`,
        [newStock, operator, janCd]
      );

      const product = updateRes.rows[0];
      return {
        ...toHistoryItem({ ...insertRes.rows[0], product_name: product.product_name }),
        product,
      };
    });

    res.status(201).json(result);
  })
);

module.exports = router;
