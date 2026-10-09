// src/routes/products.js のユニットテスト
// AAA パターン（Arrange/Act/Assert）で記述する
//
// DB には接続せず、jest.mock で pool.query / pool.connect（client.query / release）をモックする。
// 登録（POST）はトランザクション（withTransaction → pool.connect）を使うため client.query を、
// それ以外は pool.query を差し替える。src/index.js は listen するため src/app.js を使う。
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
const { mockTransactionClient, callsMatching, executedSql, pgError } = require('../helpers/mockDb');

const JAN = '4901234567894';
const JAN8 = '49012347';

// DB から返る商品1行分のサンプルデータを生成する
function buildProduct(overrides = {}) {
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
    is_alert: false,
    created_at: '2026-10-08T00:00:00.000Z',
    created_by: 'admin',
    updated_at: '2026-10-08T00:00:00.000Z',
    updated_by: 'admin',
    update_seq: 0,
    ...overrides,
  };
}

// 登録（POST）用のトランザクションのモック
// INSERT INTO products が返す行・採番結果を指定できる
function mockCreateTransaction({ inserted = (params) => buildProduct({ jan_cd: params[0], stock: params[7] }), nextNo = '7' } = {}) {
  return mockTransactionClient([
    [/INSERT INTO products/, (sql, params) => ({ rows: inserted ? [inserted(params)] : [], rowCount: inserted ? 1 : 0 })],
    [/pg_advisory_xact_lock/, { rows: [{}] }],
    [/GREATEST/, { rows: [{ next_no: nextNo }] }],
    [/INSERT INTO stock_ins/, { rows: [], rowCount: 1 }],
  ]);
}

let consoleErrorSpy;

beforeEach(() => {
  pool.query.mockReset();
  pool.connect.mockReset();
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GET /api/products（一覧）', () => {
  test('正常系: 削除されていない商品を JAN 順で返し、総件数・ページング情報を付ける', async () => {
    // Arrange
    pool.query.mockResolvedValue({
      rows: [
        { ...buildProduct({ jan_cd: JAN8, stock: 5, threshold: 10, is_alert: true }), total_count: '3' },
        { ...buildProduct(), total_count: '3' },
      ],
    });

    // Act
    const res = await request(app).get('/api/products');

    // Assert
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 3, count: 2, limit: 100, offset: 0 });
    expect(res.body.items).toHaveLength(2);
    // total_count は一覧の各行から取り除く
    expect(res.body.items[0]).not.toHaveProperty('total_count');
    expect(res.body.items[0].is_alert).toBe(true);
    expect(res.body.items[1].is_alert).toBe(false);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('is_deleted = FALSE');
    expect(sql).toContain('(stock < threshold) AS is_alert');
    expect(sql).toMatch(/ORDER BY jan_cd/);
    expect(params).toEqual([100, 0]);
  });

  test('正常系: 該当0件なら total=0 の空配列', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app).get('/api/products');

    // Assert
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 0, count: 0, limit: 100, offset: 0, items: [] });
  });

  test('正常系: jan_cd は完全一致、商品名・カナは前後の空白を除いた部分一致（ワイルドカードはエスケープ）', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app)
      .get('/api/products')
      .query({ jan_cd: JAN, product_name: ' 100%_A ', product_name_kana: 'ｼｮｳﾋﾝ', limit: '10', offset: '20' });

    // Assert
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ limit: 10, offset: 20 });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('jan_cd = $1');
    expect(sql).toContain('product_name ILIKE $2');
    expect(sql).toContain('product_name_kana ILIKE $3');
    expect(sql).toContain('LIMIT $4 OFFSET $5');
    expect(params).toEqual([JAN, '%100\\%\\_A%', '%ｼｮｳﾋﾝ%', 10, 20]);
  });

  test('正常系: 空文字・空白のみの検索条件は無視する', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app).get('/api/products').query({ jan_cd: '', product_name: '  ', alert: '' });

    // Assert
    expect(res.status).toBe(200);
    expect(pool.query.mock.calls[0][1]).toEqual([100, 0]);
  });

  test.each([
    ['true', 'stock < threshold'],
    ['false', 'stock >= threshold'],
  ])('正常系: alert=%s で在庫数と閾値による絞り込みを行う（%s）', async (alert, condition) => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app).get('/api/products').query({ alert });

    // Assert
    expect(res.status).toBe(200);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain(`WHERE is_deleted = FALSE AND ${condition}`);
  });

  test.each([
    [{ alert: 'yes' }, 'alert', 'alert は true または false で指定してください'],
    [{ alert: 'TRUE' }, 'alert', 'alert は true または false で指定してください'],
    [{ jan_cd: '49012345678901' }, 'jan_cd', 'jan_cd は13桁以内の数字で指定してください'],
    [{ jan_cd: 'abc' }, 'jan_cd', 'jan_cd は13桁以内の数字で指定してください'],
    [{ product_name: 'あ'.repeat(201) }, 'product_name', 'product_name は200文字以内で指定してください'],
    [{ limit: '0' }, 'limit', 'limit は1〜1000の整数で指定してください'],
    [{ limit: '1001' }, 'limit', 'limit は1〜1000の整数で指定してください'],
    [{ offset: '-1' }, 'offset', 'offset は0〜2147483647の整数で指定してください'],
    [{ unknown: '1' }, 'unknown', 'unknown は指定できない検索条件です'],
  ])('異常系: 不正な検索条件 %p は 400', async (query, field, message) => {
    // Act
    const res = await request(app).get('/api/products').query(query);

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field, message }]);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('異常系: 同じ検索条件の複数指定（配列）は 400', async () => {
    // Act
    const res = await request(app).get('/api/products?product_name=a&product_name=b');

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'product_name', message: 'product_name は1つだけ指定してください' }]);
  });

  test.each(['product_name', 'product_name_kana', 'jan_cd'])(
    '異常系: クエリ %s に NUL 文字（%%00）を含むと 400（監査修正の回帰テスト）',
    async (field) => {
      // Act
      const res = await request(app).get(`/api/products?${field}=abc%00`);

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.details).toEqual([{ field, message: `${field} に使用できない文字が含まれています` }]);
      expect(pool.query).not.toHaveBeenCalled();
    }
  );
});

describe('GET /api/products/:jan_cd（詳細）', () => {
  test('正常系: 指定した商品を返す', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [buildProduct()] });

    // Act
    const res = await request(app).get(`/api/products/${JAN}`);

    // Assert
    expect(res.status).toBe(200);
    expect(res.body).toEqual(buildProduct());
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('WHERE jan_cd = $1 AND is_deleted = FALSE');
    expect(params).toEqual([JAN]);
  });

  test('異常系: 存在しない（または削除済みの）商品は 404', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app).get(`/api/products/${JAN8}`);

    // Assert
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: '指定された商品が見つかりません' });
  });

  test.each([
    ['4901234567890', 'jan_cd のチェックデジットが正しくありません'],
    ['123', 'jan_cd は8桁または13桁の数字で指定してください'],
    ['abcdefgh', 'jan_cd は8桁または13桁の数字で指定してください'],
  ])('異常系: 不正な JAN コード %s は 400', async (jan, message) => {
    // Act
    const res = await request(app).get(`/api/products/${jan}`);

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'jan_cd', message }]);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('POST /api/products（登録）', () => {
  test('正常系: 201 と Location ヘッダーを返し、name を product_name として登録する', async () => {
    // Arrange
    const client = mockCreateTransaction();

    // Act
    const res = await request(app).post('/api/products').send({ jan_cd: JAN, name: '商品A', stock: 0, threshold: 10 });

    // Assert
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/products/${JAN}`);
    expect(res.body).toMatchObject({ jan_cd: JAN, product_name: '商品A', initial_slip_no: null });
    const [[sql, params]] = callsMatching(client.query, /INSERT INTO products/);
    expect(sql).toContain('ON CONFLICT (jan_cd) DO NOTHING');
    // 登録者・更新者は暫定で admin
    expect(params).toEqual([JAN, '商品A', null, null, null, null, null, 0, 10, 'admin']);
    expect(executedSql(client.query)[0]).toBe('BEGIN');
    expect(executedSql(client.query).at(-1)).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('正常系: 全項目を指定して登録できる（文字列は前後の空白を除去、空文字は NULL）', async () => {
    // Arrange
    const client = mockCreateTransaction();
    const body = {
      jan_cd: JAN8,
      product_name: ' 商品B ',
      product_spec: '500ml',
      product_name_kana: 'ｼｮｳﾋﾝB',
      generic_item1: 'g1',
      generic_item2: '',
      generic_item3: 'g3',
      threshold: 0,
    };

    // Act
    const res = await request(app).post('/api/products').send(body);

    // Assert
    expect(res.status).toBe(201);
    const [[, params]] = callsMatching(client.query, /INSERT INTO products/);
    expect(params).toEqual([JAN8, '商品B', '500ml', 'ｼｮｳﾋﾝB', 'g1', null, 'g3', 0, 0, 'admin']);
  });

  test('正常系: name と product_name が同じ値なら受け付ける', async () => {
    // Arrange
    mockCreateTransaction();

    // Act
    const res = await request(app).post('/api/products').send({ jan_cd: JAN, name: '商品A', product_name: '商品A' });

    // Assert
    expect(res.status).toBe(201);
  });

  describe('初期入庫伝票（監査修正の回帰テスト：方針 b）', () => {
    test('正常系: stock > 0 なら同じトランザクションで初期入庫伝票を1件作り、initial_slip_no を返す', async () => {
      // Arrange
      const client = mockCreateTransaction({ nextNo: '7' });

      // Act
      const res = await request(app).post('/api/products').send({ jan_cd: JAN, name: '商品A', stock: 100, threshold: 10 });

      // Assert
      expect(res.status).toBe(201);
      expect(res.body.stock).toBe(100);
      expect(res.body.initial_slip_no).toBe(7);
      const slipInserts = callsMatching(client.query, /INSERT INTO stock_ins/);
      expect(slipInserts).toHaveLength(1);
      const [sql, params] = slipInserts[0];
      // slip_seq=1・伝票フラグ1（正）・入庫日=当日
      expect(sql).toMatch(/VALUES \(\$1, 1, \$2, CURRENT_DATE, \$3, 1, \$4, \$4\)/);
      expect(params).toEqual([7, JAN, 100, 'admin']);
      // 伝票NOは入出庫と共通の採番処理（アドバイザリロック → MAX + 1）を使う
      const sqls = executedSql(client.query);
      expect(sqls.findIndex((s) => s.includes('pg_advisory_xact_lock'))).toBeLessThan(sqls.findIndex((s) => s.includes('GREATEST')));
      // 商品・伝票の INSERT は BEGIN〜COMMIT の間で実行される
      expect(sqls[0]).toBe('BEGIN');
      expect(sqls.at(-1)).toBe('COMMIT');
    });

    test('正常系: 在庫数は products.stock に登録するのみで二重加算しない（UPDATE products を実行しない）', async () => {
      // Arrange
      const client = mockCreateTransaction();

      // Act
      await request(app).post('/api/products').send({ jan_cd: JAN, name: '商品A', stock: 100 });

      // Assert
      const [[, params]] = callsMatching(client.query, /INSERT INTO products/);
      expect(params[7]).toBe(100);
      expect(callsMatching(client.query, /UPDATE products/)).toHaveLength(0);
    });

    test.each([
      ['stock=0', { stock: 0 }],
      ['stock 省略', {}],
      ['stock=null', { stock: null }],
    ])('正常系: %s なら伝票を作らず initial_slip_no は null', async (label, extra) => {
      // Arrange
      const client = mockCreateTransaction();

      // Act
      const res = await request(app).post('/api/products').send({ jan_cd: JAN, name: '商品A', ...extra });

      // Assert
      expect(res.status).toBe(201);
      expect(res.body.initial_slip_no).toBeNull();
      expect(callsMatching(client.query, /INSERT INTO stock_ins/)).toHaveLength(0);
      expect(callsMatching(client.query, /pg_advisory_xact_lock|GREATEST/)).toHaveLength(0);
      // 在庫数の既定値は 0
      expect(callsMatching(client.query, /INSERT INTO products/)[0][1][7]).toBe(0);
    });

    test('異常系: 初期入庫伝票の作成に失敗したら ROLLBACK し、商品も登録されない', async () => {
      // Arrange
      const client = mockTransactionClient([
        [/INSERT INTO products/, { rows: [buildProduct()] }],
        [/GREATEST/, { rows: [{ next_no: '1' }] }],
        [/INSERT INTO stock_ins/, () => { throw new Error('insert failed'); }],
      ]);

      // Act
      const res = await request(app).post('/api/products').send({ jan_cd: JAN, name: '商品A', stock: 5 });

      // Assert
      expect(res.status).toBe(500);
      const sqls = executedSql(client.query);
      expect(sqls).toContain('ROLLBACK');
      expect(sqls).not.toContain('COMMIT');
      expect(client.release).toHaveBeenCalledTimes(1);
    });
  });

  test('異常系: 同じ JAN コード（削除済みを含む）が既にあれば 409', async () => {
    // Arrange: ON CONFLICT DO NOTHING で RETURNING が0件
    const client = mockCreateTransaction({ inserted: null });

    // Act
    const res = await request(app).post('/api/products').send({ jan_cd: JAN, name: '商品A', stock: 10 });

    // Assert
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: '同じ JAN コードの商品が既に登録されています（削除済みの商品を含む）' });
    // 重複時は伝票も作らない
    expect(callsMatching(client.query, /INSERT INTO stock_ins/)).toHaveLength(0);
    expect(executedSql(client.query)).toContain('ROLLBACK');
  });

  test('異常系: 一意制約違反（23505）が発生した場合も 409 に変換する', async () => {
    // Arrange
    mockTransactionClient([[/INSERT INTO products/, () => { throw pgError('23505'); }]]);

    // Act
    const res = await request(app).post('/api/products').send({ jan_cd: JAN, name: '商品A' });

    // Assert
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: '同じキーのデータが既に存在します' });
  });

  test.each([
    [{ name: '商品A' }, 'jan_cd', 'jan_cd は必須です'],
    [{ jan_cd: '4901234567890', name: '商品A' }, 'jan_cd', 'jan_cd のチェックデジットが正しくありません'],
    [{ jan_cd: '490123456789', name: '商品A' }, 'jan_cd', 'jan_cd は8桁または13桁の数字で指定してください'],
    [{ jan_cd: '49012345678945', name: '商品A' }, 'jan_cd', 'jan_cd は8桁または13桁の数字で指定してください'],
    [{ jan_cd: 4901234567894, name: '商品A' }, 'jan_cd', 'jan_cd は文字列で指定してください'],
    [{ jan_cd: JAN }, 'product_name', 'product_name は必須です'],
    [{ jan_cd: JAN, name: '   ' }, 'product_name', 'product_name は必須です'],
    [{ jan_cd: JAN, name: 123 }, 'product_name', 'product_name は文字列で指定してください'],
    [{ jan_cd: JAN, name: 'あ'.repeat(201) }, 'product_name', 'product_name は200文字以内で指定してください'],
    [{ jan_cd: JAN, name: 'A', product_spec: 'x'.repeat(201) }, 'product_spec', 'product_spec は200文字以内で指定してください'],
    [{ jan_cd: JAN, name: 'A', generic_item1: 'x'.repeat(256) }, 'generic_item1', 'generic_item1 は255文字以内で指定してください'],
    [{ jan_cd: JAN, name: 'A', stock: -1 }, 'stock', 'stock は0〜2147483647の範囲で指定してください'],
    [{ jan_cd: JAN, name: 'A', stock: 2147483648 }, 'stock', 'stock は0〜2147483647の範囲で指定してください'],
    [{ jan_cd: JAN, name: 'A', stock: '10' }, 'stock', 'stock は整数で指定してください'],
    [{ jan_cd: JAN, name: 'A', stock: 1.5 }, 'stock', 'stock は整数で指定してください'],
    [{ jan_cd: JAN, name: 'A', threshold: true }, 'threshold', 'threshold は整数で指定してください'],
    [{ jan_cd: JAN, name: 'A', note: 'x' }, 'note', 'note は指定できない項目です'],
    [{ jan_cd: JAN, name: 'A', is_deleted: true }, 'is_deleted', 'is_deleted は指定できない項目です'],
    [{ jan_cd: JAN, name: 'A\u0000' }, 'product_name', 'product_name に使用できない文字が含まれています'],
  ])('異常系: 入力 %p は 400（%s）', async (body, field, message) => {
    // Act
    const res = await request(app).post('/api/products').send(body);

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('入力内容に誤りがあります');
    expect(res.body.details).toContainEqual({ field, message });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('異常系: name と product_name に異なる値を指定すると 400', async () => {
    // Act
    const res = await request(app).post('/api/products').send({ jan_cd: JAN, name: 'A', product_name: 'B' });

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'name', message: 'name と product_name は同時に異なる値を指定できません' }]);
  });

  test('異常系: 複数の入力エラーはまとめて返す', async () => {
    // Act
    const res = await request(app).post('/api/products').send({ jan_cd: '1', stock: -1, extra: 1 });

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details.map((d) => d.field)).toEqual(['extra', 'jan_cd', 'product_name', 'stock']);
  });
});

describe('PUT /api/products/:jan_cd（更新）', () => {
  test('正常系: 指定した項目のみ更新し、楽観ロック（update_seq）を条件にする', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [buildProduct({ product_name: '商品A改', threshold: 20, update_seq: 1 })] });

    // Act
    const res = await request(app).put(`/api/products/${JAN}`).send({ name: '商品A改', threshold: 20, update_seq: 0 });

    // Assert
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ product_name: '商品A改', threshold: 20, update_seq: 1 });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/SET product_name = \$1, threshold = \$2, updated_by = \$3/);
    expect(sql).toMatch(/WHERE jan_cd = \$4 AND is_deleted = FALSE AND update_seq = \$5/);
    expect(params).toEqual(['商品A改', 20, 'admin', JAN, 0]);
    // 在庫数は更新対象にしない
    expect(sql).not.toMatch(/stock =/);
  });

  test('正常系: 任意項目に空文字を指定すると NULL に更新する', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [buildProduct()] });

    // Act
    const res = await request(app).put(`/api/products/${JAN}`).send({ product_spec: '', update_seq: 3 });

    // Assert
    expect(res.status).toBe(200);
    expect(pool.query.mock.calls[0][1]).toEqual([null, 'admin', JAN, 3]);
  });

  test('異常系: update_seq が一致しない（他のユーザが更新済み）場合は 409', async () => {
    // Arrange: UPDATE は0件、存在確認では見つかる
    pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

    // Act
    const res = await request(app).put(`/api/products/${JAN}`).send({ threshold: 5, update_seq: 0 });

    // Assert
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: '他のユーザによって更新されています。最新の情報を取得してから再度実行してください' });
    expect(pool.query.mock.calls[1][0]).toContain('SELECT 1 FROM products WHERE jan_cd = $1 AND is_deleted = FALSE');
  });

  test('異常系: 存在しない（削除済みの）商品の更新は 404', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app).put(`/api/products/${JAN}`).send({ threshold: 5, update_seq: 0 });

    // Assert
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: '指定された商品が見つかりません' });
  });

  test.each([
    [{ stock: 50, update_seq: 0 }],
    [{ jan_cd: JAN8, update_seq: 0 }],
    [{ stock: null, threshold: 1, update_seq: 0 }],
  ])('異常系: 在庫数・JAN コードは変更できない %p → 400', async (body) => {
    // Act
    const res = await request(app).put(`/api/products/${JAN}`).send(body);

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([
      { field: 'stock / jan_cd', message: '在庫数は入出庫登録で、JAN コードは変更できません' },
    ]);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test.each([
    [{ threshold: 5 }, 'update_seq', 'update_seq は必須です'],
    [{ threshold: 5, update_seq: '0' }, 'update_seq', 'update_seq は整数で指定してください'],
    [{ threshold: 5, update_seq: -1 }, 'update_seq', 'update_seq は0〜2147483647の範囲で指定してください'],
    [{ product_name: '', update_seq: 0 }, 'product_name', 'product_name は必須です'],
    [{ product_name: null, update_seq: 0 }, 'product_name', 'product_name は必須です'],
    [{ threshold: -1, update_seq: 0 }, 'threshold', 'threshold は0〜2147483647の範囲で指定してください'],
    [{ unknown: 1, update_seq: 0 }, 'unknown', 'unknown は指定できない項目です'],
  ])('異常系: 入力 %p は 400', async (body, field, message) => {
    // Act
    const res = await request(app).put(`/api/products/${JAN}`).send(body);

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details).toContainEqual({ field, message });
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('異常系: 更新する項目がない場合は 400', async () => {
    // Act
    const res = await request(app).put(`/api/products/${JAN}`).send({ update_seq: 0 });

    // Assert
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: '更新する項目を1つ以上指定してください' });
  });

  test('異常系: 不正な JAN コードのパスは 400', async () => {
    // Act
    const res = await request(app).put('/api/products/4901234567890').send({ threshold: 1, update_seq: 0 });

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details[0].field).toBe('jan_cd');
  });
});

describe('DELETE /api/products/:jan_cd（論理削除）', () => {
  test('正常系: 削除フラグを立てて 204 を返し、その後の GET は 404 になる', async () => {
    // Arrange: 1回目は論理削除（1件更新）、2回目は詳細取得（削除済みのため0件）
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [] }).mockResolvedValueOnce({ rows: [] });

    // Act
    const del = await request(app).delete(`/api/products/${JAN}`).query({ update_seq: '2' });
    const get = await request(app).get(`/api/products/${JAN}`);

    // Assert
    expect(del.status).toBe(204);
    expect(del.text).toBe('');
    const [sql, params] = pool.query.mock.calls[0];
    // 物理削除（DELETE 文）ではなく is_deleted を更新する
    expect(sql).not.toMatch(/DELETE FROM/);
    expect(sql).toMatch(/SET is_deleted = TRUE, updated_by = \$1/);
    expect(sql).toMatch(/WHERE jan_cd = \$2 AND is_deleted = FALSE AND update_seq = \$3/);
    expect(params).toEqual(['admin', JAN, 2]);
    // 詳細取得は is_deleted = FALSE の行のみ対象
    expect(pool.query.mock.calls[1][0]).toContain('is_deleted = FALSE');
    expect(get.status).toBe(404);
  });

  test('異常系: update_seq が一致しない場合は 409', async () => {
    // Arrange
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] }).mockResolvedValueOnce({ rows: [{}] });

    // Act
    const res = await request(app).delete(`/api/products/${JAN}`).query({ update_seq: '0' });

    // Assert
    expect(res.status).toBe(409);
  });

  test('異常系: 存在しない（削除済みの）商品は 404', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rowCount: 0, rows: [] });

    // Act
    const res = await request(app).delete(`/api/products/${JAN}`).query({ update_seq: '0' });

    // Assert
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: '指定された商品が見つかりません' });
  });

  test.each([
    ['', 'update_seq', 'update_seq は必須です'],
    ['?update_seq=', 'update_seq', 'update_seq は必須です'],
    ['?update_seq=abc', 'update_seq', 'update_seq は0〜2147483647の整数で指定してください'],
    ['?update_seq=-1', 'update_seq', 'update_seq は0〜2147483647の整数で指定してください'],
    ['?update_seq=0&force=1', 'force', 'force は指定できない検索条件です'],
  ])('異常系: クエリ %p は 400', async (qs, field, message) => {
    // Act
    const res = await request(app).delete(`/api/products/${JAN}${qs}`);

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field, message }]);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('異常系: DB エラー時は 500 で内部情報を返さない', async () => {
    // Arrange
    pool.query.mockRejectedValue(new Error('deadlock internal detail'));

    // Act
    const res = await request(app).delete(`/api/products/${JAN}`).query({ update_seq: '0' });

    // Assert
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('internal detail');
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
