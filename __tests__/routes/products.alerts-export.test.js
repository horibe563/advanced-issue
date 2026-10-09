// src/routes/products.js の在庫アラート（GET /api/products/alerts）・CSV 出力（GET /api/products/export）のユニットテスト
// AAA パターン（Arrange/Act/Assert）で記述する
//
// DB には接続せず、jest.mock で pool.query をモックする。src/index.js は listen するため src/app.js を使う。
// トークンなしで 401 になることは __tests__/middleware/auth.test.js で確認する。
jest.mock('../../src/db/pool', () => ({
  query: jest.fn(),
  connect: jest.fn(),
  on: jest.fn(),
}));
// 認証は常に admin でログイン済みとして扱う（トークン検証は middleware/auth.test.js でテストする）
jest.mock('../../src/middleware/auth', () => require('../helpers/mockAuth'));

const request = require('supertest');
const pool = require('../../src/db/pool');
const app = require('../../src/app');
const { pgError } = require('../helpers/mockDb');

const JAN = '4901234567894';
const JAN8 = '49012347';
const BOM = '\uFEFF';
const CSV_HEADER = 'JANコード,商品名,規格,商品名カナ,汎用項目1,汎用項目2,汎用項目3,在庫数,閾値,在庫アラート,更新日時,更新者';

// 在庫アラートの SQL が返す1行分のサンプルデータを生成する
function buildAlertRow(overrides = {}) {
  return {
    jan_cd: JAN,
    product_name: '商品A',
    product_spec: null,
    product_name_kana: null,
    stock: 3,
    threshold: 10,
    shortage: 7,
    updated_at: '2026-10-08T00:00:00.000Z',
    total_count: '1',
    ...overrides,
  };
}

// CSV 出力の SQL が返す1行分のサンプルデータを生成する
function buildExportRow(overrides = {}) {
  return {
    jan_cd: JAN,
    product_name: '商品A',
    product_spec: null,
    product_name_kana: null,
    generic_item1: null,
    generic_item2: null,
    generic_item3: null,
    stock: 100,
    threshold: 10,
    alert_label: '',
    updated_at_jst: '2026-10-08 09:00:00',
    updated_by: 'admin',
    ...overrides,
  };
}

// CSV のレスポンスをバイト列（Buffer）のまま受け取る
function rawBuffer(res, callback) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

// CSV のレスポンスを BOM を含めてそのまま文字列として受け取る
function rawText(res, callback) {
  let data = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => callback(null, data));
}

// 条件を満たすまで待つ（並行リクエストが pool.query に到達するのを待つ）
// リクエストは実際の HTTP 通信を挟むため、回数ではなく時間で待つ
// （回数で待つと、GitHub Actions など遅いマシンでは到達前に打ち切られてしまう）
async function waitFor(condition, { timeoutMs = 5000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (condition()) return;
  throw new Error('条件を満たしませんでした');
}

// 解決されるまで応答しない pool.query の結果（resolve / reject で完了させる）
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// CSV 出力を開始し、pool.query の応答待ちのまま止めておく（必ず resolve / reject すること）
async function startPendingExports(count) {
  const pendings = Array.from({ length: count }, () => deferred());
  pendings.forEach((d) => pool.query.mockImplementationOnce(() => d.promise));
  const responses = pendings.map(() => request(app).get('/api/products/export').then((res) => res));
  try {
    await waitFor(() => pool.query.mock.calls.length === count);
  } catch (err) {
    // 待ちきれなかった場合も応答待ちのリクエストを完了させる（残ると同時実行数を占有し、後続のテストまで 429 になる）
    pendings.forEach((d) => d.resolve({ rows: [] }));
    await Promise.allSettled(responses);
    throw err;
  }
  return { pendings, responses };
}

let consoleErrorSpy;
let consoleInfoSpy;

beforeEach(() => {
  pool.query.mockReset();
  pool.connect.mockReset();
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  // CSV 出力の監査ログ（成功時に1行出力される）
  consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('GET /api/products/alerts（在庫アラート）', () => {
  test('正常系: 在庫数 < 閾値 の削除されていない商品を不足数の大きい順 → JAN 順で返す', async () => {
    // Arrange
    pool.query.mockResolvedValue({
      rows: [
        buildAlertRow({ jan_cd: JAN8, stock: 0, threshold: 20, shortage: 20, total_count: '5' }),
        buildAlertRow({ total_count: '5' }),
      ],
    });

    // Act
    const res = await request(app).get('/api/products/alerts');

    // Assert
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 5, count: 2, limit: 100, offset: 0 });
    expect(res.body.items).toEqual([
      {
        jan_cd: JAN8,
        product_name: '商品A',
        product_spec: null,
        product_name_kana: null,
        stock: 0,
        threshold: 20,
        shortage: 20,
        updated_at: '2026-10-08T00:00:00.000Z',
      },
      {
        jan_cd: JAN,
        product_name: '商品A',
        product_spec: null,
        product_name_kana: null,
        stock: 3,
        threshold: 10,
        shortage: 7,
        updated_at: '2026-10-08T00:00:00.000Z',
      },
    ]);
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    const normalized = sql.replace(/\s+/g, ' ');
    expect(normalized).toContain('WHERE is_deleted = FALSE AND stock < threshold');
    expect(normalized).toContain('(threshold - stock) AS shortage');
    expect(normalized).toContain('ORDER BY (threshold - stock) DESC, jan_cd');
    expect(normalized).toContain('LIMIT $1 OFFSET $2');
    expect(params).toEqual([100, 0]);
  });

  test('正常系: limit・offset を SQL のパラメータに渡す', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [buildAlertRow({ total_count: '30' })] });

    // Act
    const res = await request(app).get('/api/products/alerts').query({ limit: '10', offset: '20' });

    // Assert
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 30, count: 1, limit: 10, offset: 20 });
    expect(pool.query.mock.calls[0][1]).toEqual([10, 20]);
  });

  test('正常系: 該当0件なら total=0 の空配列', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app).get('/api/products/alerts');

    // Assert
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 0, count: 0, limit: 100, offset: 0, items: [] });
  });

  test('正常系: /alerts は詳細取得（/:jan_cd）として扱われない', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app).get('/api/products/alerts');

    // Assert
    expect(res.status).toBe(200);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).not.toContain('jan_cd = $1');
  });

  test.each([
    [{ limit: '0' }, 'limit', 'limit は1〜1000の整数で指定してください'],
    [{ limit: '1001' }, 'limit', 'limit は1〜1000の整数で指定してください'],
    [{ limit: 'abc' }, 'limit', 'limit は1〜1000の整数で指定してください'],
    [{ offset: '-1' }, 'offset', 'offset は0〜2147483647の整数で指定してください'],
    [{ alert: 'true' }, 'alert', 'alert は指定できない検索条件です'],
    [{ jan_cd: JAN }, 'jan_cd', 'jan_cd は指定できない検索条件です'],
    [{ unknown: '1' }, 'unknown', 'unknown は指定できない検索条件です'],
  ])('異常系: 不正なクエリ %p は 400', async (query, field, message) => {
    // Act
    const res = await request(app).get('/api/products/alerts').query(query);

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field, message }]);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('異常系: DB エラー時は 500 で内部情報を返さない', async () => {
    // Arrange
    pool.query.mockRejectedValue(new Error('relation internal detail'));

    // Act
    const res = await request(app).get('/api/products/alerts');

    // Assert
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('internal detail');
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});

describe('GET /api/products/export（CSV 出力）', () => {
  test('正常系: BOM 付き UTF-8・CRLF の CSV を添付ファイルとして返す', async () => {
    // Arrange
    pool.query.mockResolvedValue({
      rows: [
        buildExportRow({ jan_cd: JAN8, product_name: '商品B', stock: 5, alert_label: '在庫不足' }),
        buildExportRow({ product_spec: '500ml', product_name_kana: 'ｼｮｳﾋﾝA', generic_item1: 'x' }),
      ],
    });

    // Act
    const res = await request(app).get('/api/products/export').buffer(true).parse(rawText);

    // Assert
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="inventory_\d{8}_\d{6}\.csv"$/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toBe(
      `${BOM}${CSV_HEADER}\r\n` +
        `${JAN8},商品B,,,,,,5,10,在庫不足,2026-10-08 09:00:00,admin\r\n` +
        `${JAN},商品A,500ml,ｼｮｳﾋﾝA,x,,,100,10,,2026-10-08 09:00:00,admin\r\n`
    );
  });

  test('正常系: ファイル名は JST の現在時刻（YYYYMMDD_HHmmss）', async () => {
    // Arrange
    // UTC 2026-10-08 15:04:05 → JST 2026-10-09 00:04:05（日付が繰り上がる）
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    jest.setSystemTime(new Date('2026-10-08T15:04:05Z'));
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app).get('/api/products/export');

    // Assert
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="inventory_20261009_000405.csv"');
  });

  test('正常系: 削除されていない商品を JAN 順で上限（50,000件）+ 1 件まで取得し、在庫不足・更新日時（JST）を SQL で組み立てる', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app).get('/api/products/export');

    // Assert
    expect(res.status).toBe(200);
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    const normalized = sql.replace(/\s+/g, ' ');
    expect(normalized).toContain('WHERE is_deleted = FALSE ORDER BY jan_cd LIMIT $1');
    expect(normalized).toContain("CASE WHEN stock < threshold THEN '在庫不足' ELSE '' END AS alert_label");
    expect(normalized).toContain("AT TIME ZONE 'Asia/Tokyo'");
    expect(params).toEqual([50001]);
  });

  test('正常系: 該当0件でもヘッダー行のみの CSV を返す', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app).get('/api/products/export').buffer(true).parse(rawText);

    // Assert
    expect(res.status).toBe(200);
    expect(res.body).toBe(`${BOM}${CSV_HEADER}\r\n`);
  });

  test('正常系: 一覧と同じ検索条件を SQL の条件・パラメータに反映する（ワイルドカードはエスケープ）', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app)
      .get('/api/products/export')
      .query({ jan_cd: JAN, product_name: ' 100%_A ', product_name_kana: 'ｼｮｳﾋﾝ', alert: 'true' });

    // Assert
    expect(res.status).toBe(200);
    const [sql, params] = pool.query.mock.calls[0];
    const normalized = sql.replace(/\s+/g, ' ');
    expect(normalized).toContain(
      'WHERE is_deleted = FALSE AND jan_cd = $1 AND product_name ILIKE $2 AND product_name_kana ILIKE $3 AND stock < threshold'
    );
    expect(normalized).toContain('LIMIT $4');
    expect(params).toEqual([JAN, '%100\\%\\_A%', '%ｼｮｳﾋﾝ%', 50001]);
  });

  test.each([
    ['true', 'stock < threshold'],
    ['false', 'stock >= threshold'],
  ])('正常系: alert=%s で在庫数と閾値による絞り込みを行う（%s）', async (alert, condition) => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app).get('/api/products/export').query({ alert });

    // Assert
    expect(res.status).toBe(200);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain(`WHERE is_deleted = FALSE AND ${condition}`);
    expect(params).toEqual([50001]);
  });

  test('正常系: 空文字・空白のみの検索条件は無視する', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app).get('/api/products/export').query({ jan_cd: '', product_name: '  ', alert: '' });

    // Assert
    expect(res.status).toBe(200);
    expect(pool.query.mock.calls[0][1]).toEqual([50001]);
  });

  test('正常系: カンマ・改行・ダブルクォートはクォートし、数式になり得る文字列には \' を付ける', async () => {
    // Arrange
    pool.query.mockResolvedValue({
      rows: [
        buildExportRow({
          product_name: '=HYPERLINK("http://example.com")',
          product_spec: '1,000g',
          generic_item1: '1行目\n2行目',
          generic_item2: '-1',
          generic_item3: '@SUM(A1)',
          updated_by: null,
        }),
      ],
    });

    // Act
    const res = await request(app).get('/api/products/export').buffer(true).parse(rawText);

    // Assert
    expect(res.status).toBe(200);
    const lines = res.body.slice(1).split('\r\n');
    expect(lines[1]).toBe(
      `${JAN},"'=HYPERLINK(""http://example.com"")","1,000g",,"1行目\n2行目",'-1,'@SUM(A1),100,10,,2026-10-08 09:00:00,`
    );
  });

  test('正常系: ちょうど上限（50,000件）なら出力できる', async () => {
    // Arrange
    const row = buildExportRow();
    pool.query.mockResolvedValue({ rows: Array.from({ length: 50000 }, () => row) });

    // Act
    const res = await request(app).get('/api/products/export').buffer(true).parse(rawText);

    // Assert
    expect(res.status).toBe(200);
    // ヘッダー行 + 50,000 行（末尾の CRLF の後は空文字）
    expect(res.body.split('\r\n')).toHaveLength(50002);
  });

  test('異常系: 上限（50,000件）を超える場合は 400', async () => {
    // Arrange
    const row = buildExportRow();
    pool.query.mockResolvedValue({ rows: Array.from({ length: 50001 }, () => row) });

    // Act
    const res = await request(app).get('/api/products/export');

    // Assert
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.body).toEqual({ error: '出力件数が上限（50,000件）を超えています。条件を絞ってください' });
  });

  test.each([
    [{ limit: '10' }, 'limit', 'limit は指定できない検索条件です'],
    [{ offset: '0' }, 'offset', 'offset は指定できない検索条件です'],
    [{ unknown: '1' }, 'unknown', 'unknown は指定できない検索条件です'],
    [{ alert: 'yes' }, 'alert', 'alert は true または false で指定してください'],
    [{ alert: 'TRUE' }, 'alert', 'alert は true または false で指定してください'],
    [{ jan_cd: '49012345678901' }, 'jan_cd', 'jan_cd は13桁以内の数字で指定してください'],
    [{ jan_cd: 'abc' }, 'jan_cd', 'jan_cd は13桁以内の数字で指定してください'],
    [{ product_name: 'あ'.repeat(201) }, 'product_name', 'product_name は200文字以内で指定してください'],
    [{ product_name_kana: 'ｱ'.repeat(201) }, 'product_name_kana', 'product_name_kana は200文字以内で指定してください'],
  ])('異常系: 不正な検索条件 %p は 400', async (query, field, message) => {
    // Act
    const res = await request(app).get('/api/products/export').query(query);

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field, message }]);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('異常系: 同じ検索条件の複数指定（配列）は 400', async () => {
    // Act
    const res = await request(app).get('/api/products/export?product_name=a&product_name=b');

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'product_name', message: 'product_name は1つだけ指定してください' }]);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('異常系: DB エラー時は 500 で内部情報を返さない', async () => {
    // Arrange
    pool.query.mockRejectedValue(new Error('relation internal detail'));

    // Act
    const res = await request(app).get('/api/products/export');

    // Assert
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('internal detail');
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});

describe('GET /api/products/export（応答の形式）', () => {
  test('正常系: ETag を付けず、Content-Length は BOM を含む本文のバイト数、先頭は UTF-8 の BOM（EF BB BF）', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [buildExportRow({ product_name: '日本語の商品名' })] });

    // Act
    const res = await request(app).get('/api/products/export').buffer(true).parse(rawBuffer);

    // Assert
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeUndefined();
    expect(Number(res.headers['content-length'])).toBe(res.body.length);
    const text = res.body.toString('utf8');
    expect(Buffer.byteLength(text)).toBe(res.body.length);
    expect([...res.body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(text.startsWith(`${BOM}${CSV_HEADER}\r\n`)).toBe(true);
  });

  test('正常系: If-None-Match を付けても 304 にならない（キャッシュさせない）', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app).get('/api/products/export').set('If-None-Match', '*');

    // Assert
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('GET /api/products/export（同時実行数の制限）', () => {
  const BUSY = { error: '他のCSV出力が処理中です。しばらくしてから再度実行してください' };

  test('異常系: 2件が処理中の間の3件目は 429 で、DB を照会しない', async () => {
    // Arrange
    const { pendings, responses } = await startPendingExports(2);

    try {
      // Act
      const res = await request(app).get('/api/products/export');

      // Assert
      expect(res.status).toBe(429);
      expect(res.body).toEqual(BUSY);
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(pool.query).toHaveBeenCalledTimes(2);
    } finally {
      pendings.forEach((d) => d.resolve({ rows: [] }));
    }
    // 処理中だった2件は正常に完了する
    const done = await Promise.all(responses);
    expect(done.map((r) => r.status)).toEqual([200, 200]);
  });

  test('正常系: 処理中の出力が完了すれば、再び2件まで受け付ける（429 で枠を減らさない）', async () => {
    // Arrange
    const first = await startPendingExports(2);
    const busy = await request(app).get('/api/products/export');
    first.pendings.forEach((d) => d.resolve({ rows: [] }));
    await Promise.all(first.responses);
    pool.query.mockReset();

    // Act
    const second = await startPendingExports(2);
    const third = await request(app).get('/api/products/export');
    second.pendings.forEach((d) => d.resolve({ rows: [] }));
    const done = await Promise.all(second.responses);

    // Assert
    expect(busy.status).toBe(429);
    expect(done.map((r) => r.status)).toEqual([200, 200]);
    expect(third.status).toBe(429);
  });

  test.each([
    ['DB エラー（500）', () => pool.query.mockRejectedValueOnce(new Error('db down')), 500],
    ['タイムアウト（57014 → 503）', () => pool.query.mockRejectedValueOnce(pgError('57014', 'canceling statement')), 503],
    ['件数上限超過（400）', () => pool.query.mockResolvedValueOnce({ rows: Array.from({ length: 50001 }, () => ({})) }), 400],
  ])('正常系: %s の後も枠を解放し、続けて出力できる', async (_, arrange, expectedStatus) => {
    // Arrange：上限（2件）より多い回数失敗させる（枠が解放されなければ 3回目以降が 429 になる）
    const statuses = [];
    for (let i = 0; i < 3; i += 1) {
      arrange();
      statuses.push((await request(app).get('/api/products/export')).status);
    }
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app).get('/api/products/export');

    // Assert
    expect(statuses).toEqual([expectedStatus, expectedStatus, expectedStatus]);
    expect(res.status).toBe(200);
  });

  test('正常系: 処理中の1件が DB エラーで終わったら、その枠で次の出力を受け付ける', async () => {
    // Arrange
    const { pendings, responses } = await startPendingExports(2);
    pendings[0].reject(new Error('db down'));
    const [failed] = await Promise.all([responses[0]]);
    pool.query.mockResolvedValueOnce({ rows: [] });

    try {
      // Act
      const res = await request(app).get('/api/products/export');

      // Assert
      expect(failed.status).toBe(500);
      expect(res.status).toBe(200);
    } finally {
      pendings[1].resolve({ rows: [] });
      await responses[1];
    }
  });

  test.each([
    [{ alert: 'yes' }, 'alert'],
    [{ unknown: '1' }, 'unknown'],
    [{ jan_cd: 'abc' }, 'jan_cd'],
  ])('異常系: 入力エラー %p は処理中が2件でも 429 ではなく 400 で、枠を消費しない', async (query, field) => {
    // Arrange
    const { pendings, responses } = await startPendingExports(2);

    try {
      // Act
      const res = await request(app).get('/api/products/export').query(query);

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.details[0].field).toBe(field);
      expect(pool.query).toHaveBeenCalledTimes(2);
    } finally {
      pendings.forEach((d) => d.resolve({ rows: [] }));
      await Promise.all(responses);
    }
  });

  test('正常系: 入力エラーを繰り返しても枠を消費しない', async () => {
    // Arrange
    for (let i = 0; i < 3; i += 1) {
      await request(app).get('/api/products/export').query({ alert: 'yes' });
    }
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app).get('/api/products/export');

    // Assert
    expect(res.status).toBe(200);
  });
});

describe('GET /api/products/export（監査ログ）', () => {
  // console.info に出力された監査ログ（JSON）を取り出す
  function auditLogs() {
    return consoleInfoSpy.mock.calls.map(([line]) => JSON.parse(line));
  }

  test('正常系: 成功時に誰が・どの条件で・何件出力したかを JSON で1行出力する', async () => {
    // Arrange
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    jest.setSystemTime(new Date('2026-10-09T01:02:03.000Z'));
    pool.query.mockResolvedValue({ rows: [buildExportRow(), buildExportRow({ jan_cd: JAN8 })] });

    // Act
    const res = await request(app).get('/api/products/export').query({ product_name: ' 商品 ', alert: 'true' });

    // Assert
    expect(res.status).toBe(200);
    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    expect(auditLogs()).toEqual([
      {
        event: 'products.export',
        user_id: 'admin',
        // 指定された検索条件のみ（指定値のまま）
        filters: { product_name: ' 商品 ', alert: 'true' },
        rows: 2,
        at: '2026-10-09T01:02:03.000Z',
      },
    ]);
  });

  test('正常系: 検索条件なしなら filters は空、0件なら rows は 0', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    await request(app).get('/api/products/export');

    // Assert
    expect(auditLogs()).toEqual([
      { event: 'products.export', user_id: 'admin', filters: {}, rows: 0, at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
    ]);
  });

  test('正常系: 監査ログにトークン（Authorization ヘッダー）を含めない', async () => {
    // Arrange
    const token = 'a'.repeat(64);
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    await request(app).get('/api/products/export').set('Authorization', `Bearer ${token}`);

    // Assert
    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const [line] = consoleInfoSpy.mock.calls[0];
    expect(line).not.toContain(token);
    expect(line).not.toMatch(/Bearer|authorization|token|password/i);
    expect(Object.keys(JSON.parse(line)).sort()).toEqual(['at', 'event', 'filters', 'rows', 'user_id']);
  });

  test('異常系: 入力エラー（400）では出力しない', async () => {
    // Act
    const res = await request(app).get('/api/products/export').query({ alert: 'yes' });

    // Assert
    expect(res.status).toBe(400);
    expect(consoleInfoSpy).not.toHaveBeenCalled();
  });

  test('異常系: 件数上限超過（400）では出力しない', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: Array.from({ length: 50001 }, () => ({})) });

    // Act
    const res = await request(app).get('/api/products/export');

    // Assert
    expect(res.status).toBe(400);
    expect(consoleInfoSpy).not.toHaveBeenCalled();
  });

  test('異常系: DB エラー（500）では出力しない', async () => {
    // Arrange
    pool.query.mockRejectedValue(new Error('db down'));

    // Act
    const res = await request(app).get('/api/products/export');

    // Assert
    expect(res.status).toBe(500);
    expect(consoleInfoSpy).not.toHaveBeenCalled();
  });

  test('異常系: 同時実行数超過（429）では出力しない', async () => {
    // Arrange
    const { pendings, responses } = await startPendingExports(2);

    try {
      // Act
      const res = await request(app).get('/api/products/export');

      // Assert
      expect(res.status).toBe(429);
      expect(consoleInfoSpy).not.toHaveBeenCalled();
    } finally {
      pendings.forEach((d) => d.resolve({ rows: [] }));
      await Promise.all(responses);
    }
    // 処理中だった2件の完了分のみ出力される
    expect(consoleInfoSpy).toHaveBeenCalledTimes(2);
  });
});
