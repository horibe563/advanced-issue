// 商品マスタ（products）のルート
//   GET    /api/products            一覧（クエリで絞り込み。在庫数 < 閾値 のアラートフラグ付き）
//   GET    /api/products/alerts     在庫アラート（在庫数 < 閾値 の商品を不足数の大きい順に）
//   GET    /api/products/export     CSV 出力（一覧と同じ検索条件で全件。上限 50,000 件・同時実行 2 件まで）
//   GET    /api/products/:jan_cd    詳細
//   POST   /api/products            登録（stock > 0 のときは初期入庫伝票を同じトランザクションで作成）
//   PUT    /api/products/:jan_cd    更新（楽観ロック：update_seq 必須）
//   DELETE /api/products/:jan_cd    論理削除（楽観ロック：クエリ update_seq 必須）
// SQL はすべてパラメータ化クエリで実行する（列名は固定のホワイトリストからのみ組み立てる）。
const express = require('express');
const pool = require('../db/pool');
const { withTransaction } = require('../db/transaction');
const { nextSlipNo } = require('../db/slipNo');
const asyncHandler = require('../utils/asyncHandler');
const { badRequest, notFound, conflict, tooManyRequests } = require('../utils/httpError');
const { getOperatorId } = require('../utils/operator');
const { toCsv } = require('../utils/csv');
const {
  PG_INTEGER_MAX,
  janCdError,
  validateFields,
  assertPlainObject,
  queryString,
  queryInteger,
  parsePaging,
  assertAllowedQuery,
  escapeLike,
} = require('../utils/validators');

const router = express.Router();

// レスポンスで返す列（is_alert は「在庫数 < 閾値」のときに true）
const SELECT_COLUMNS = `
  jan_cd, product_name, product_spec, product_name_kana,
  generic_item1, generic_item2, generic_item3,
  stock, threshold, (stock < threshold) AS is_alert,
  created_at, created_by, updated_at, updated_by, update_seq`;

// 商品情報の項目定義（桁数は db/migrations/003_create_products.sql の列定義に合わせる）
const PRODUCT_INFO_SPEC = {
  product_name: { type: 'string', maxLength: 200 },
  product_spec: { type: 'string', maxLength: 200 },
  product_name_kana: { type: 'string', maxLength: 200 },
  generic_item1: { type: 'string', maxLength: 255 },
  generic_item2: { type: 'string', maxLength: 255 },
  generic_item3: { type: 'string', maxLength: 255 },
  threshold: { type: 'integer', min: 0, max: PG_INTEGER_MAX },
};

// 登録時の項目定義
const CREATE_SPEC = {
  jan_cd: { type: 'jan', required: true },
  ...PRODUCT_INFO_SPEC,
  product_name: { ...PRODUCT_INFO_SPEC.product_name, required: true },
  stock: { type: 'integer', min: 0, max: PG_INTEGER_MAX },
};

// 更新時の項目定義（在庫数は入出庫 API でのみ変更するため対象外）
const UPDATE_SPEC = {
  ...PRODUCT_INFO_SPEC,
  update_seq: { type: 'integer', required: true, min: 0, max: PG_INTEGER_MAX },
};

// 画面側の項目名 name を DB 列名 product_name に読み替える
// （name と product_name が両方指定され、値が異なる場合は曖昧なので 400）
function normalizeNameField(body) {
  assertPlainObject(body);
  if (!Object.prototype.hasOwnProperty.call(body, 'name')) return body;
  const { name, ...rest } = body;
  if (rest.product_name !== undefined && rest.product_name !== name) {
    throw badRequest('入力内容に誤りがあります', [
      { field: 'name', message: 'name と product_name は同時に異なる値を指定できません' },
    ]);
  }
  return { ...rest, product_name: name };
}

// パスパラメータの JAN コードをチェックする
function parseJanParam(req) {
  const err = janCdError(req.params.jan_cd);
  if (err) throw badRequest('入力内容に誤りがあります', [{ field: 'jan_cd', message: err }]);
  return req.params.jan_cd;
}

// 楽観ロックで更新件数が0件だった場合の原因を判定する（存在しない → 404、シーケンス不一致 → 409）
async function throwNotFoundOrConflict(janCd) {
  const { rows } = await pool.query('SELECT 1 FROM products WHERE jan_cd = $1 AND is_deleted = FALSE', [janCd]);
  if (rows.length === 0) throw notFound('指定された商品が見つかりません');
  throw conflict('他のユーザによって更新されています。最新の情報を取得してから再度実行してください');
}

// 一覧・CSV 出力で共通の検索条件
const SEARCH_QUERY_KEYS = ['jan_cd', 'product_name', 'product_name_kana', 'alert'];

// 検索条件（jan_cd / product_name / product_name_kana / alert）をチェックし、
// WHERE 句の条件とパラメータを組み立てる（一覧・CSV 出力で共通）
function buildSearchConditions(query) {
  const conditions = ['is_deleted = FALSE'];
  const params = [];

  const janCd = queryString(query, 'jan_cd');
  if (janCd !== undefined && janCd !== '') {
    if (!/^\d{1,13}$/.test(janCd)) {
      throw badRequest('入力内容に誤りがあります', [{ field: 'jan_cd', message: 'jan_cd は13桁以内の数字で指定してください' }]);
    }
    params.push(janCd);
    conditions.push(`jan_cd = $${params.length}`);
  }

  // 部分一致検索（LIKE のワイルドカードはエスケープする）
  for (const field of ['product_name', 'product_name_kana']) {
    const value = queryString(query, field);
    if (value !== undefined && value.trim() !== '') {
      if ([...value].length > 200) {
        throw badRequest('入力内容に誤りがあります', [{ field, message: `${field} は200文字以内で指定してください` }]);
      }
      params.push(`%${escapeLike(value.trim())}%`);
      conditions.push(`${field} ILIKE $${params.length}`);
    }
  }

  const alert = queryString(query, 'alert');
  if (alert !== undefined && alert !== '') {
    if (alert !== 'true' && alert !== 'false') {
      throw badRequest('入力内容に誤りがあります', [{ field: 'alert', message: 'alert は true または false で指定してください' }]);
    }
    conditions.push(alert === 'true' ? 'stock < threshold' : 'stock >= threshold');
  }

  return { conditions, params };
}

// 一覧取得
// クエリ: jan_cd（完全一致）, product_name / product_name_kana（部分一致）,
//         alert（true: 在庫数 < 閾値 の商品のみ / false: それ以外のみ）, limit, offset
router.get(
  '/',
  asyncHandler(async (req, res) => {
    assertAllowedQuery(req.query, [...SEARCH_QUERY_KEYS, 'limit', 'offset']);
    const { conditions, params } = buildSearchConditions(req.query);

    const { limit, offset } = parsePaging(req.query);
    params.push(limit, offset);

    const sql = `
      SELECT ${SELECT_COLUMNS}, COUNT(*) OVER() AS total_count
        FROM products
       WHERE ${conditions.join(' AND ')}
       ORDER BY jan_cd
       LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const { rows } = await pool.query(sql, params);

    // total_count はページングに関係なく条件に一致した総件数
    const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
    const items = rows.map(({ total_count, ...row }) => row); // eslint-disable-line no-unused-vars
    res.json({ total, count: items.length, limit, offset, items });
  })
);

// 在庫アラート（在庫数 < 閾値 の商品）
// 並び順：不足数（閾値 − 在庫数）の大きい順 → JAN コード順
// クエリ: limit, offset のみ
// ※ /:jan_cd より前に登録する（"alerts" が JAN コードとして検証され 400 になるのを防ぐ）
router.get(
  '/alerts',
  asyncHandler(async (req, res) => {
    assertAllowedQuery(req.query, ['limit', 'offset']);
    const { limit, offset } = parsePaging(req.query);

    const { rows } = await pool.query(
      `SELECT jan_cd, product_name, product_spec, product_name_kana,
              stock, threshold, (threshold - stock) AS shortage, updated_at,
              COUNT(*) OVER() AS total_count
         FROM products
        WHERE is_deleted = FALSE AND stock < threshold
        ORDER BY (threshold - stock) DESC, jan_cd
        LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    // total_count はページングに関係なくアラート対象の総件数
    const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
    const items = rows.map(({ total_count, ...row }) => row); // eslint-disable-line no-unused-vars
    res.json({ total, count: items.length, limit, offset, items });
  })
);

// CSV 出力の件数上限（超える場合は条件を絞ってもらう）
const EXPORT_MAX_ROWS = 50000;

// CSV 出力の同時実行数の上限（このプロセス内。大量出力の連打による DB・メモリの負荷を抑える）
const EXPORT_MAX_CONCURRENCY = 2;
let exportRunning = 0;

// CSV の列定義（見出し → DB の列名）
const EXPORT_COLUMNS = [
  ['JANコード', 'jan_cd'],
  ['商品名', 'product_name'],
  ['規格', 'product_spec'],
  ['商品名カナ', 'product_name_kana'],
  ['汎用項目1', 'generic_item1'],
  ['汎用項目2', 'generic_item2'],
  ['汎用項目3', 'generic_item3'],
  ['在庫数', 'stock'],
  ['閾値', 'threshold'],
  ['在庫アラート', 'alert_label'],
  ['更新日時', 'updated_at_jst'],
  ['更新者', 'updated_by'],
];

// Excel で UTF-8 として認識させるための BOM
const UTF8_BOM = '\uFEFF';

// 現在時刻（JST）を 'YYYYMMDD_HHmmss' 形式にする（ダウンロードファイル名用）
function jstTimestamp(date = new Date()) {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${jst.getUTCFullYear()}${pad(jst.getUTCMonth() + 1)}${pad(jst.getUTCDate())}_` +
    `${pad(jst.getUTCHours())}${pad(jst.getUTCMinutes())}${pad(jst.getUTCSeconds())}`
  );
}

// CSV 出力
// クエリ: 一覧と同じ検索条件（jan_cd / product_name / product_name_kana / alert）。ページングなし
// 条件に一致する全件を JAN コード順に出力する（上限 50,000 件。超える場合は 400）
// 同時実行は 2 件まで（超える場合は 429）。成功時は監査ログを1行出力する
// ※ /:jan_cd より前に登録する
router.get(
  '/export',
  asyncHandler(async (req, res) => {
    assertAllowedQuery(req.query, SEARCH_QUERY_KEYS);
    const { conditions, params } = buildSearchConditions(req.query);
    const operator = getOperatorId(req);

    if (exportRunning >= EXPORT_MAX_CONCURRENCY) {
      throw tooManyRequests('他のCSV出力が処理中です。しばらくしてから再度実行してください');
    }
    // 増やした直後から finally で必ず減らす（DB エラー・上限超過の 400 でも漏らさない）
    exportRunning += 1;
    try {
      await sendExportCsv(req, res, { conditions, params, operator });
    } finally {
      exportRunning -= 1;
    }
  })
);

// CSV 出力の本体（検索 → 上限チェック → CSV 生成 → 送信 → 監査ログ）
async function sendExportCsv(req, res, { conditions, params, operator }) {
  // 上限を超えたかどうかを判定するため、上限 + 1 件まで取得する
  params.push(EXPORT_MAX_ROWS + 1);

  // updated_at は TIMESTAMPTZ のため、JST に変換して文字列化する
  const sql = `
    SELECT jan_cd, product_name, product_spec, product_name_kana,
           generic_item1, generic_item2, generic_item3,
           stock, threshold,
           CASE WHEN stock < threshold THEN '在庫不足' ELSE '' END AS alert_label,
           to_char(updated_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI:SS') AS updated_at_jst,
           updated_by
      FROM products
     WHERE ${conditions.join(' AND ')}
     ORDER BY jan_cd
     LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);
  if (rows.length > EXPORT_MAX_ROWS) {
    throw badRequest('出力件数が上限（50,000件）を超えています。条件を絞ってください');
  }

  const csv = toCsv(
    EXPORT_COLUMNS.map(([label]) => label),
    rows.map((row) => EXPORT_COLUMNS.map(([, column]) => row[column]))
  );

  // res.send は本文全体の ETag を計算するため使わず、Buffer をそのまま返す
  const body = Buffer.from(UTF8_BOM + csv, 'utf8');
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="inventory_${jstTimestamp()}.csv"`,
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  });
  res.status(200).end(body);

  // 監査ログ（誰が・どの条件で・何件出力したか）。認証情報（パスワード・トークン）は含めない
  const filters = {};
  for (const key of SEARCH_QUERY_KEYS) {
    if (Object.hasOwn(req.query, key)) filters[key] = req.query[key]; // buildSearchConditions で文字列であることを確認済み
  }
  console.info(
    JSON.stringify({ event: 'products.export', user_id: operator, filters, rows: rows.length, at: new Date().toISOString() })
  );
}

// 詳細取得
router.get(
  '/:jan_cd',
  asyncHandler(async (req, res) => {
    const janCd = parseJanParam(req);
    const { rows } = await pool.query(
      `SELECT ${SELECT_COLUMNS} FROM products WHERE jan_cd = $1 AND is_deleted = FALSE`,
      [janCd]
    );
    if (rows.length === 0) throw notFound('指定された商品が見つかりません');
    res.json(rows[0]);
  })
);

// 登録
// 初期在庫（stock）の扱い（方針 b）
//   - products.stock に初期値をそのまま登録し、stock > 0 のときは同じトランザクションで
//     初期入庫の伝票（stock_ins：slip_flag=1, quantity=stock, 入庫日=当日, slip_seq=1）を
//     「履歴として」作成する。在庫数への加算は行わない（products.stock に既に反映済みのため二重加算しない）
//   - stock = 0 または省略時は伝票を作らない
//   - 伝票NOは入出庫登録と同じ共通の採番処理（nextSlipNo）を使う
//   - レスポンスに作成した伝票NOを initial_slip_no として含める（伝票なしの場合は null）
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = validateFields(normalizeNameField(req.body), CREATE_SPEC);
    const operator = getOperatorId(req);
    const initialStock = input.stock ?? 0;

    const result = await withTransaction(async (client) => {
      // 既に同じ JAN コードがあれば何もしない（RETURNING が0件になる）→ 409
      const { rows } = await client.query(
        `INSERT INTO products (
           jan_cd, product_name, product_spec, product_name_kana,
           generic_item1, generic_item2, generic_item3,
           stock, threshold, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
         ON CONFLICT (jan_cd) DO NOTHING
         RETURNING ${SELECT_COLUMNS}`,
        [
          input.jan_cd,
          input.product_name,
          input.product_spec ?? null,
          input.product_name_kana ?? null,
          input.generic_item1 ?? null,
          input.generic_item2 ?? null,
          input.generic_item3 ?? null,
          initialStock,
          input.threshold ?? 0,
          operator,
        ]
      );
      if (rows.length === 0) {
        // 論理削除済みの商品も主キーが残っているため同じ JAN では登録できない
        throw conflict('同じ JAN コードの商品が既に登録されています（削除済みの商品を含む）');
      }

      let initialSlipNo = null;
      if (initialStock > 0) {
        // 初期入庫伝票の作成（在庫数は products.stock に登録済みのため、ここでは加算しない）
        initialSlipNo = await nextSlipNo(client);
        await client.query(
          `INSERT INTO stock_ins (slip_no, slip_seq, jan_cd, stock_in_date, quantity, slip_flag, created_by, updated_by)
           VALUES ($1, 1, $2, CURRENT_DATE, $3, 1, $4, $4)`,
          [initialSlipNo, input.jan_cd, initialStock, operator]
        );
      }
      return { ...rows[0], initial_slip_no: initialSlipNo };
    });

    res.status(201).location(`/api/products/${input.jan_cd}`).json(result);
  })
);

// 更新（指定された項目のみ更新する。update_seq が一致しない場合は 409）
router.put(
  '/:jan_cd',
  asyncHandler(async (req, res) => {
    const janCd = parseJanParam(req);
    const body = normalizeNameField(req.body);
    if (Object.prototype.hasOwnProperty.call(body, 'stock') || Object.prototype.hasOwnProperty.call(body, 'jan_cd')) {
      throw badRequest('入力内容に誤りがあります', [
        { field: 'stock / jan_cd', message: '在庫数は入出庫登録で、JAN コードは変更できません' },
      ]);
    }
    // 必須項目（商品名）を空にする更新は許可しない
    const input = validateFields(body, {
      ...UPDATE_SPEC,
      product_name: { ...UPDATE_SPEC.product_name, required: body.product_name !== undefined },
    });

    const { update_seq: updateSeq, ...fields } = input;
    const columns = Object.keys(fields); // validateFields により定義済みの列名のみ
    if (columns.length === 0) throw badRequest('更新する項目を1つ以上指定してください');

    const params = columns.map((c) => fields[c]);
    const setClause = columns.map((c, i) => `${c} = $${i + 1}`).join(', ');
    params.push(getOperatorId(req), janCd, updateSeq);
    const n = params.length;

    // update_seq・updated_at はトリガー（fn_set_update_columns）で自動更新される
    const { rows } = await pool.query(
      `UPDATE products
          SET ${setClause}, updated_by = $${n - 2}
        WHERE jan_cd = $${n - 1} AND is_deleted = FALSE AND update_seq = $${n}
       RETURNING ${SELECT_COLUMNS}`,
      params
    );
    if (rows.length === 0) await throwNotFoundOrConflict(janCd);
    res.json(rows[0]);
  })
);

// 論理削除（クエリ ?update_seq= 必須。一致しない場合は 409）
router.delete(
  '/:jan_cd',
  asyncHandler(async (req, res) => {
    const janCd = parseJanParam(req);
    assertAllowedQuery(req.query, ['update_seq']);
    const updateSeq = queryInteger(req.query, 'update_seq', { required: true });

    const { rowCount } = await pool.query(
      `UPDATE products
          SET is_deleted = TRUE, updated_by = $1
        WHERE jan_cd = $2 AND is_deleted = FALSE AND update_seq = $3`,
      [getOperatorId(req), janCd, updateSeq]
    );
    if (rowCount === 0) await throwNotFoundOrConflict(janCd);
    res.status(204).end();
  })
);

module.exports = router;
