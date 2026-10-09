// src/routes/stockinout.js のユニットテスト
// AAA パターン（Arrange/Act/Assert）で記述する
//
// DB には接続せず、jest.mock で pool.query / pool.connect（client.query / release）をモックする。
// 登録（POST）はトランザクション内で「商品行の行ロック → 在庫数チェック → 伝票NO採番 → 履歴 INSERT → 在庫数 UPDATE」
// を行うため、client.query に SQL ごとの応答を設定し、実行された SQL・パラメータ・在庫数の計算結果を検証する。
// ※ 実 DB を使った同時実行（行ロック・アドバイザリロック）の検証は、CREATE DATABASE 権限がなく
//   テスト用 DB を用意できないため対象外（モックでは SQL に FOR UPDATE / pg_advisory_xact_lock が含まれることのみ確認する）。
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

// INSERT ... RETURNING の戻り値（パラメータから組み立てる）
function insertedRow(type) {
  return (sql, params) => ({
    rows: [
      {
        type,
        id: '15',
        slip_no: String(params[0]),
        slip_seq: params[1],
        jan_cd: params[2],
        date: params[3] ?? '2026-10-08',
        quantity: params[4],
        slip_flag: params[5],
        created_at: '2026-10-08T00:00:00.000Z',
        created_by: params[6],
        updated_at: '2026-10-08T00:00:00.000Z',
        updated_by: params[6],
        update_seq: 0,
      },
    ],
  });
}

// 入出庫登録のトランザクションをモックする
//   stock     : 行ロック時点の在庫数（null なら商品なし）
//   nextNo    : 新規伝票の採番結果
//   original  : 訂正対象の元伝票の JAN（null なら元伝票なし）
//   slipState : 訂正時の伝票の現在値（max_seq / net_quantity）
function mockStockTransaction({ type = 'in', stock = 10, nextNo = '3', original = JAN, slipState = { max_seq: 1, net_quantity: '3' } } = {}) {
  return mockTransactionClient([
    [/SELECT jan_cd FROM stock_(ins|outs)/, { rows: original ? [{ jan_cd: original }] : [] }],
    [/SELECT stock FROM products/, { rows: stock === null ? [] : [{ stock }] }],
    [/SELECT MAX\(slip_seq\)/, { rows: [slipState] }],
    [/pg_advisory_xact_lock/, { rows: [{}] }],
    [/GREATEST/, { rows: [{ next_no: nextNo }] }],
    [/INSERT INTO stock_(ins|outs)/, insertedRow(type)],
    [
      /UPDATE products SET stock/,
      (sql, params) => ({
        rows: [{ jan_cd: params[2], product_name: '商品A', stock: params[0], threshold: 10, is_alert: params[0] < 10, update_seq: 5 }],
      }),
    ],
  ]);
}

// UPDATE products に渡された新しい在庫数
function updatedStock(client) {
  const calls = callsMatching(client.query, /UPDATE products SET stock/);
  return calls.length > 0 ? calls[0][1][0] : undefined;
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

describe('POST /api/stockinout（新規伝票）', () => {
  test('正常系: 入庫で在庫数を加算し、伝票NOを採番して slip_seq=1 で登録する', async () => {
    // Arrange
    const client = mockStockTransaction({ type: 'in', stock: 10, nextNo: '3' });

    // Act
    const res = await request(app).post('/api/stockinout').send({ type: 'in', jan_cd: JAN, quantity: 5, date: '2026-10-01' });

    // Assert
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      type: 'in',
      id: 15,
      slip_no: 3,
      slip_seq: 1,
      jan_cd: JAN,
      product_name: '商品A',
      date: '2026-10-01',
      quantity: 5,
      slip_flag: 1,
      stock_delta: 5,
      created_by: 'admin',
      product: { jan_cd: JAN, stock: 15, is_alert: false },
    });
    const [[sql, params]] = callsMatching(client.query, /INSERT INTO stock_ins/);
    expect(sql).toContain('stock_in_date');
    expect(sql).toContain('COALESCE($4::date, CURRENT_DATE)');
    expect(params).toEqual([3, 1, JAN, '2026-10-01', 5, 1, 'admin']);
    expect(updatedStock(client)).toBe(15);
  });

  test('正常系: 出庫で在庫数を減算する（在庫数と同数まで出庫でき、在庫0になる）', async () => {
    // Arrange
    const client = mockStockTransaction({ type: 'out', stock: 10, nextNo: '4' });

    // Act
    const res = await request(app).post('/api/stockinout').send({ type: 'out', jan_cd: JAN, quantity: 10 });

    // Assert
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: 'out', slip_no: 4, slip_seq: 1, stock_delta: -10, product: { stock: 0, is_alert: true } });
    const [[sql, params]] = callsMatching(client.query, /INSERT INTO stock_outs/);
    expect(sql).toContain('stock_out_date');
    // 日付省略時は null を渡し DB の当日日付（CURRENT_DATE）にする
    expect(params).toEqual([4, 1, JAN, null, 10, 1, 'admin']);
    expect(updatedStock(client)).toBe(0);
  });

  test('正常系: 商品行を FOR UPDATE で行ロックしてから採番・登録し、すべて同じトランザクションで実行する', async () => {
    // Arrange
    const client = mockStockTransaction();

    // Act
    await request(app).post('/api/stockinout').send({ type: 'in', jan_cd: JAN, quantity: 1 });

    // Assert
    const sqls = executedSql(client.query);
    const indexOf = (pattern) => sqls.findIndex((s) => pattern.test(s));
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[indexOf(/SELECT stock FROM products/)]).toMatch(/is_deleted = FALSE FOR UPDATE$/);
    expect(indexOf(/FOR UPDATE/)).toBeLessThan(indexOf(/pg_advisory_xact_lock/));
    expect(indexOf(/pg_advisory_xact_lock/)).toBeLessThan(indexOf(/GREATEST/));
    expect(indexOf(/GREATEST/)).toBeLessThan(indexOf(/INSERT INTO stock_ins/));
    expect(indexOf(/INSERT INTO stock_ins/)).toBeLessThan(indexOf(/UPDATE products/));
    expect(sqls.at(-1)).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('正常系: 伝票NOは入庫・出庫で共通の連番（採番 SQL が両テーブルを参照する）', async () => {
    // Arrange
    const inClient = mockStockTransaction({ type: 'in', nextNo: '8' });
    const inRes = await request(app).post('/api/stockinout').send({ type: 'in', jan_cd: JAN, quantity: 1 });
    const outClient = mockStockTransaction({ type: 'out', nextNo: '9' });

    // Act
    const outRes = await request(app).post('/api/stockinout').send({ type: 'out', jan_cd: JAN, quantity: 1 });

    // Assert: 入庫でも出庫でも同じ採番処理（stock_ins / stock_outs の MAX + 1）を使う
    expect(inRes.body.slip_no).toBe(8);
    expect(outRes.body.slip_no).toBe(9);
    for (const client of [inClient, outClient]) {
      const [[sql]] = callsMatching(client.query, /GREATEST/);
      expect(sql).toMatch(/FROM stock_ins/);
      expect(sql).toMatch(/FROM stock_outs/);
    }
  });

  test('異常系: 出庫数が在庫数を超える（在庫不足）場合は 409 で、履歴も在庫も更新しない', async () => {
    // Arrange
    const client = mockStockTransaction({ type: 'out', stock: 5 });

    // Act
    const res = await request(app).post('/api/stockinout').send({ type: 'out', jan_cd: JAN, quantity: 6 });

    // Assert
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: '在庫数が不足しているため登録できません（現在の在庫数: 5）' });
    expect(callsMatching(client.query, /INSERT INTO|UPDATE products/)).toHaveLength(0);
    expect(executedSql(client.query)).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('異常系: 入庫で在庫数が INTEGER の上限を超える場合は 409', async () => {
    // Arrange
    mockStockTransaction({ type: 'in', stock: 2147483647 });

    // Act
    const res = await request(app).post('/api/stockinout').send({ type: 'in', jan_cd: JAN, quantity: 1 });

    // Assert
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: '在庫数の上限を超えるため登録できません' });
  });

  test('異常系: 存在しない（削除済みの）商品は 404', async () => {
    // Arrange
    const client = mockStockTransaction({ stock: null });

    // Act
    const res = await request(app).post('/api/stockinout').send({ type: 'in', jan_cd: JAN8, quantity: 1 });

    // Assert
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: '指定された商品が見つかりません' });
    expect(callsMatching(client.query, /INSERT INTO/)).toHaveLength(0);
  });

  test('異常系: 新規伝票で jan_cd を省略すると 400', async () => {
    // Act
    const res = await request(app).post('/api/stockinout').send({ type: 'in', quantity: 1 });

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'jan_cd', message: 'jan_cd は必須です' }]);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('異常系: 新規伝票で slip_flag=2（負）は 400（負は訂正伝票でのみ使う）', async () => {
    // Act
    const res = await request(app).post('/api/stockinout').send({ type: 'in', jan_cd: JAN, quantity: 1, slip_flag: 2 });

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details[0].field).toBe('slip_flag');
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('異常系: 伝票NOの一意制約違反（23505）が発生した場合は 409 に変換する', async () => {
    // Arrange
    mockTransactionClient([
      [/SELECT stock FROM products/, { rows: [{ stock: 1 }] }],
      [/GREATEST/, { rows: [{ next_no: '1' }] }],
      [/INSERT INTO stock_ins/, () => { throw pgError('23505'); }],
    ]);

    // Act
    const res = await request(app).post('/api/stockinout').send({ type: 'in', jan_cd: JAN, quantity: 1 });

    // Assert
    expect(res.status).toBe(409);
  });
});

describe('POST /api/stockinout（訂正伝票）', () => {
  test('正常系: 入庫の -1 訂正は同じ伝票NOで slip_seq を +1 し、在庫数を減算する', async () => {
    // Arrange: 元伝票（数量3・正）が slip_seq=1 で登録済み
    const client = mockStockTransaction({ type: 'in', stock: 10, slipState: { max_seq: 1, net_quantity: '3' } });

    // Act
    const res = await request(app).post('/api/stockinout').send({ type: 'in', slip_no: 5, quantity: 1, slip_flag: 2 });

    // Assert
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ slip_no: 5, slip_seq: 2, jan_cd: JAN, slip_flag: 2, quantity: 1, stock_delta: -1, product: { stock: 9 } });
    // 元伝票を上書きせず新しい行を追加する（UPDATE stock_ins は実行しない）
    expect(callsMatching(client.query, /UPDATE stock_ins/)).toHaveLength(0);
    const [[, params]] = callsMatching(client.query, /INSERT INTO stock_ins/);
    expect(params).toEqual([5, 2, JAN, null, 1, 2, 'admin']);
    // 訂正では伝票NOを採番しない
    expect(callsMatching(client.query, /GREATEST|pg_advisory_xact_lock/)).toHaveLength(0);
    // 元伝票は slip_seq=1 の行から商品を特定する
    const [[lookupSql, lookupParams]] = callsMatching(client.query, /SELECT jan_cd FROM stock_ins/);
    expect(lookupSql).toContain('slip_seq = 1');
    expect(lookupParams).toEqual([5]);
  });

  test('正常系: 2回目の訂正は slip_seq=3 になる', async () => {
    // Arrange
    mockStockTransaction({ type: 'in', slipState: { max_seq: 2, net_quantity: '2' } });

    // Act
    const res = await request(app).post('/api/stockinout').send({ type: 'in', slip_no: 5, quantity: 4, slip_flag: 1 });

    // Assert
    expect(res.status).toBe(201);
    expect(res.body.slip_seq).toBe(3);
    expect(res.body.slip_no).toBe(5);
  });

  test('正常系: 出庫の負の訂正（出庫の取り消し）は在庫数を加算する', async () => {
    // Arrange
    const client = mockStockTransaction({ type: 'out', stock: 0, slipState: { max_seq: 1, net_quantity: '3' } });

    // Act
    const res = await request(app).post('/api/stockinout').send({ type: 'out', slip_no: 2, quantity: 3, slip_flag: 2 });

    // Assert
    expect(res.status).toBe(201);
    expect(res.body.stock_delta).toBe(3);
    expect(updatedStock(client)).toBe(3);
  });

  test('正常系: slip_flag 省略時は 1（正）の訂正として扱い、元伝票と同じ jan_cd は指定できる', async () => {
    // Arrange
    const client = mockStockTransaction({ type: 'out', stock: 10 });

    // Act
    const res = await request(app).post('/api/stockinout').send({ type: 'out', slip_no: 2, quantity: 2, jan_cd: JAN });

    // Assert
    expect(res.status).toBe(201);
    expect(res.body.slip_flag).toBe(1);
    expect(updatedStock(client)).toBe(8);
  });

  test('異常系: 訂正後の伝票数量がマイナスになる場合は 409', async () => {
    // Arrange: 伝票数量は 3（正3）。負4の訂正は 3 - 4 = -1
    const client = mockStockTransaction({ type: 'in', stock: 100, slipState: { max_seq: 1, net_quantity: '3' } });

    // Act
    const res = await request(app).post('/api/stockinout').send({ type: 'in', slip_no: 5, quantity: 4, slip_flag: 2 });

    // Assert
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: '訂正後の伝票数量がマイナスになるため登録できません（現在の伝票数量: 3）' });
    expect(callsMatching(client.query, /INSERT INTO|UPDATE products/)).toHaveLength(0);
  });

  test('正常系: 訂正後の伝票数量がちょうど 0 になる訂正は許可する', async () => {
    // Arrange
    mockStockTransaction({ type: 'in', stock: 100, slipState: { max_seq: 1, net_quantity: '3' } });

    // Act
    const res = await request(app).post('/api/stockinout').send({ type: 'in', slip_no: 5, quantity: 3, slip_flag: 2 });

    // Assert
    expect(res.status).toBe(201);
  });

  test('異常系: 入庫の負の訂正で在庫数が不足する場合は 409', async () => {
    // Arrange: 入庫3を取り消したいが、既に出庫済みで在庫は2しかない
    mockStockTransaction({ type: 'in', stock: 2, slipState: { max_seq: 1, net_quantity: '3' } });

    // Act
    const res = await request(app).post('/api/stockinout').send({ type: 'in', slip_no: 5, quantity: 3, slip_flag: 2 });

    // Assert
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('在庫数が不足しているため登録できません（現在の在庫数: 2）');
  });

  test('異常系: 伝票シーケンスNOが上限に達した伝票は 409', async () => {
    // Arrange
    mockStockTransaction({ type: 'in', slipState: { max_seq: 2147483647, net_quantity: '3' } });

    // Act
    const res = await request(app).post('/api/stockinout').send({ type: 'in', slip_no: 5, quantity: 1 });

    // Assert
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'この伝票はこれ以上訂正できません' });
  });

  test('異常系: 指定した伝票NOの伝票がない（別種別の伝票NOを含む）場合は 404', async () => {
    // Arrange
    const client = mockStockTransaction({ type: 'out', original: null });

    // Act
    const res = await request(app).post('/api/stockinout').send({ type: 'out', slip_no: 99, quantity: 1 });

    // Assert
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: '指定された伝票NOの出庫伝票が見つかりません' });
    expect(callsMatching(client.query, /SELECT jan_cd FROM stock_outs/)).toHaveLength(1);
  });

  test('異常系: 元伝票と異なる jan_cd を指定すると 400', async () => {
    // Arrange
    mockStockTransaction({ type: 'in', original: JAN });

    // Act
    const res = await request(app).post('/api/stockinout').send({ type: 'in', slip_no: 5, quantity: 1, jan_cd: JAN8 });

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'jan_cd', message: '訂正伝票の jan_cd は元伝票と同じ値を指定してください' }]);
  });
});

describe('POST /api/stockinout（入力チェック）', () => {
  test.each([
    [{ jan_cd: JAN, quantity: 1 }, 'type', 'type は必須です'],
    [{ type: 'move', jan_cd: JAN, quantity: 1 }, 'type', 'type は in / out のいずれかで指定してください'],
    [{ type: 'in', jan_cd: JAN }, 'quantity', 'quantity は必須です'],
    [{ type: 'in', jan_cd: JAN, quantity: 0 }, 'quantity', 'quantity は1〜2147483647の範囲で指定してください'],
    [{ type: 'in', jan_cd: JAN, quantity: -1 }, 'quantity', 'quantity は1〜2147483647の範囲で指定してください'],
    [{ type: 'in', jan_cd: JAN, quantity: 2147483648 }, 'quantity', 'quantity は1〜2147483647の範囲で指定してください'],
    [{ type: 'in', jan_cd: JAN, quantity: '1' }, 'quantity', 'quantity は整数で指定してください'],
    [{ type: 'in', jan_cd: JAN, quantity: 1.5 }, 'quantity', 'quantity は整数で指定してください'],
    [{ type: 'in', jan_cd: '4901234567890', quantity: 1 }, 'jan_cd', 'jan_cd のチェックデジットが正しくありません'],
    [{ type: 'in', jan_cd: JAN, quantity: 1, slip_flag: 3 }, 'slip_flag', 'slip_flag は 1 / 2 のいずれかで指定してください'],
    [{ type: 'in', jan_cd: JAN, quantity: 1, slip_flag: '1' }, 'slip_flag', 'slip_flag は 1 / 2 のいずれかで指定してください'],
    [{ type: 'in', slip_no: 0, quantity: 1 }, 'slip_no', 'slip_no は1〜9007199254740991の範囲で指定してください'],
    [{ type: 'in', slip_no: '5', quantity: 1 }, 'slip_no', 'slip_no は整数で指定してください'],
    [{ type: 'in', jan_cd: JAN, quantity: 1, stock: 1 }, 'stock', 'stock は指定できない項目です'],
  ])('異常系: 入力 %p は 400', async (body, field, message) => {
    // Act
    const res = await request(app).post('/api/stockinout').send(body);

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details).toContainEqual({ field, message });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test.each([
    ['2026-02-30', '存在しない日'],
    ['2025-02-29', 'うるう年でない年の2/29'],
    ['2026/10/08', '区切り文字が違う'],
    ['2026-10-8', '桁数不足'],
    ['20261008', '区切りなし'],
    ['2026-10-08T09:00:00Z', '時刻付き'],
  ])('異常系: 日付 %s（%s）は 400', async (date) => {
    // Act
    const res = await request(app).post('/api/stockinout').send({ type: 'in', jan_cd: JAN, quantity: 1, date });

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'date', message: 'date は YYYY-MM-DD 形式の正しい日付で指定してください' }]);
  });

  test('異常系: 日付が文字列でない場合は 400', async () => {
    // Act
    const res = await request(app).post('/api/stockinout').send({ type: 'in', jan_cd: JAN, quantity: 1, date: 20261008 });

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details[0].field).toBe('date');
  });

  test('正常系: うるう年の 2/29 は登録できる', async () => {
    // Arrange
    mockStockTransaction();

    // Act
    const res = await request(app).post('/api/stockinout').send({ type: 'in', jan_cd: JAN, quantity: 1, date: '2024-02-29' });

    // Assert
    expect(res.status).toBe(201);
    expect(res.body.date).toBe('2024-02-29');
  });

  test.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    '異常系: type=%s（プロトタイプのプロパティ名）は 400（監査修正の回帰テスト）',
    async (type) => {
      // Act
      const res = await request(app).post('/api/stockinout').send({ type, jan_cd: JAN, quantity: 1 });

      // Assert: 500 にならず、SQL も実行しない
      expect(res.status).toBe(400);
      expect(res.body.details).toContainEqual({ field: 'type', message: 'type は in / out のいずれかで指定してください' });
      expect(pool.connect).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    }
  );
});

describe('GET /api/stockinout（一覧）', () => {
  // 一覧の1行分（DB から返る形）
  function historyRow(overrides = {}) {
    return {
      type: 'in',
      id: '1',
      slip_no: '1',
      slip_seq: 1,
      jan_cd: JAN,
      product_name: '商品A',
      date: '2026-10-01',
      sort_date: '2026-10-01',
      quantity: 3,
      slip_flag: 1,
      created_at: '2026-10-01T00:00:00.000Z',
      created_by: 'admin',
      updated_at: '2026-10-01T00:00:00.000Z',
      updated_by: 'admin',
      update_seq: 0,
      total_count: '3',
      ...overrides,
    };
  }

  test('正常系: 入庫・出庫をまとめて返し、BIGINT を数値に変換して stock_delta を付ける', async () => {
    // Arrange
    pool.query.mockResolvedValue({
      rows: [
        historyRow({ type: 'out', id: '2', slip_no: '2', quantity: 2 }),
        historyRow({ type: 'in', id: '3', slip_no: '1', slip_seq: 2, slip_flag: 2, quantity: 1 }),
        historyRow(),
      ],
    });

    // Act
    const res = await request(app).get('/api/stockinout');

    // Assert
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 3, count: 3, limit: 100, offset: 0 });
    expect(res.body.items.map((i) => [i.type, i.slip_no, i.slip_seq, i.stock_delta])).toEqual([
      ['out', 2, 1, -2],
      ['in', 1, 2, -1],
      ['in', 1, 1, 3],
    ]);
    // 内部用の列は返さない
    expect(res.body.items[0]).not.toHaveProperty('total_count');
    expect(res.body.items[0]).not.toHaveProperty('sort_date');
    expect(res.body.items[0].id).toBe(2);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/FROM stock_ins h[\s\S]*UNION ALL[\s\S]*FROM stock_outs h/);
    expect(sql).toMatch(/ORDER BY sort_date DESC, slip_no DESC, slip_seq DESC/);
    expect(sql).not.toMatch(/WHERE jan_cd/);
    expect(params).toEqual([100, 0]);
  });

  test('正常系: 0件なら total=0', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app).get('/api/stockinout');

    // Assert
    expect(res.body).toEqual({ total: 0, count: 0, limit: 100, offset: 0, items: [] });
  });

  test.each([
    ['in', 'stock_ins', 'stock_outs'],
    ['out', 'stock_outs', 'stock_ins'],
  ])('正常系: type=%s なら %s のみを検索する', async (type, included, excluded) => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app).get('/api/stockinout').query({ type });

    // Assert
    expect(res.status).toBe(200);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain(`FROM ${included} h`);
    expect(sql).not.toContain(`FROM ${excluded} h`);
    expect(sql).not.toContain('UNION ALL');
  });

  test('正常系: jan_cd・slip_no・期間で絞り込む（パラメータ化クエリ）', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app)
      .get('/api/stockinout')
      .query({ jan_cd: JAN, slip_no: '12', date_from: '2026-10-01', date_to: '2026-10-31', limit: '50', offset: '10' });

    // Assert
    expect(res.status).toBe(200);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('WHERE jan_cd = $1 AND slip_no = $2 AND sort_date >= $3::date AND sort_date <= $4::date');
    expect(sql).toContain('LIMIT $5 OFFSET $6');
    expect(params).toEqual([JAN, 12, '2026-10-01', '2026-10-31', 50, 10]);
  });

  test('正常系: date_from と date_to が同じ日なら検索できる', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app).get('/api/stockinout').query({ date_from: '2026-10-01', date_to: '2026-10-01' });

    // Assert
    expect(res.status).toBe(200);
  });

  test('正常系: 空文字の検索条件は無視する', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app).get('/api/stockinout').query({ type: '', jan_cd: '', slip_no: '', date_from: '', date_to: '' });

    // Assert
    expect(res.status).toBe(200);
    expect(pool.query.mock.calls[0][0]).toContain('UNION ALL');
    expect(pool.query.mock.calls[0][1]).toEqual([100, 0]);
  });

  test.each([
    [{ type: 'move' }, 'type', 'type は in / out のいずれかで指定してください'],
    [{ type: 'constructor' }, 'type', 'type は in / out のいずれかで指定してください'],
    [{ type: '__proto__' }, 'type', 'type は in / out のいずれかで指定してください'],
    [{ type: 'toString' }, 'type', 'type は in / out のいずれかで指定してください'],
    [{ jan_cd: '4901234567890' }, 'jan_cd', 'jan_cd のチェックデジットが正しくありません'],
    [{ date_from: '2026-02-30' }, 'date_from', 'date_from は YYYY-MM-DD 形式の正しい日付で指定してください'],
    [{ date_to: '2026/10/31' }, 'date_to', 'date_to は YYYY-MM-DD 形式の正しい日付で指定してください'],
    [{ date_from: '2026-10-31', date_to: '2026-10-01' }, 'date_from', 'date_from は date_to 以前の日付を指定してください'],
  ])('異常系: 検索条件 %p は 400', async (query, field, message) => {
    // Act
    const res = await request(app).get('/api/stockinout').query(query);

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field, message }]);
    expect(pool.query).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  test('異常系: 複数の検索条件エラーはまとめて返す', async () => {
    // Act
    const res = await request(app).get('/api/stockinout').query({ type: 'x', jan_cd: '1', date_from: 'x', date_to: 'y' });

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details.map((d) => d.field)).toEqual(['type', 'jan_cd', 'date_from', 'date_to']);
  });

  test.each([
    ['slip_no=0', 'slip_no'],
    ['slip_no=abc', 'slip_no'],
    ['limit=1001', 'limit'],
    ['unknown=1', 'unknown'],
    ['type=in&type=out', 'type'],
  ])('異常系: クエリ %s は 400', async (qs, field) => {
    // Act
    const res = await request(app).get(`/api/stockinout?${qs}`);

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details[0].field).toBe(field);
  });

  test.each(['type', 'jan_cd', 'date_from'])(
    '異常系: クエリ %s に NUL 文字（%%00）を含むと 400（監査修正の回帰テスト）',
    async (field) => {
      // Act
      const res = await request(app).get(`/api/stockinout?${field}=%00`);

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.details).toEqual([{ field, message: `${field} に使用できない文字が含まれています` }]);
      expect(pool.query).not.toHaveBeenCalled();
    }
  );

  test('異常系: DB エラーは 500 で内部情報を返さない', async () => {
    // Arrange
    pool.query.mockRejectedValue(new Error('relation "stock_ins" does not exist'));

    // Act
    const res = await request(app).get('/api/stockinout');

    // Assert
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('stock_ins');
  });
});
