// src/app.js（Express アプリの組み立て・共通処理）のユニットテスト
// AAA パターン（Arrange/Act/Assert）で記述する
//
// 対象：JSON パース（不正 JSON・配列ボディ・サイズ超過）、404、500 で内部情報を返さないこと、
//       PG エラーコードの変換、セキュリティヘッダー、静的ファイル配信（public/）。
// DB には接続せず、src/db/pool をモックする（src/index.js は listen するため src/app.js を使う）。
jest.mock('../src/db/pool', () => ({
  query: jest.fn(),
  connect: jest.fn(),
  on: jest.fn(),
}));
// 認証は常に admin でログイン済みとして扱う（トークン検証は middleware/auth.test.js でテストする）
jest.mock('../src/middleware/auth', () => require('./helpers/mockAuth'));

const request = require('supertest');
const pool = require('../src/db/pool');
const app = require('../src/app');
const { pgError } = require('./helpers/mockDb');

const JAN = '4901234567894';

let consoleErrorSpy;

beforeEach(() => {
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('JSON リクエストボディ', () => {
  test.each(['/api/products', '/api/stockinout', '/api/usr'])('異常系: %s に不正な JSON を送ると 400', async (path) => {
    // Act
    const res = await request(app).post(path).set('Content-Type', 'application/json').send('{"jan_cd": "49012');

    // Assert
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'リクエストボディの JSON 形式が不正です' });
  });

  test('異常系: トップレベルがオブジェクト・配列以外（文字列）の JSON は 400（strict）', async () => {
    // Act
    const res = await request(app).post('/api/products').set('Content-Type', 'application/json').send('"abc"');

    // Assert
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'リクエストボディの JSON 形式が不正です' });
  });

  test.each(['/api/products', '/api/stockinout', '/api/usr'])('異常系: %s に配列ボディを送ると 400', async (path) => {
    // Act
    const res = await request(app).post(path).send([{ jan_cd: JAN }]);

    // Assert
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'リクエストボディは JSON オブジェクトで指定してください' });
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('異常系: PUT /api/products/:jan_cd に配列ボディを送ると 400', async () => {
    // Act
    const res = await request(app).put(`/api/products/${JAN}`).send([]);

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('リクエストボディは JSON オブジェクトで指定してください');
  });

  test('異常系: 10kb を超えるボディは 413', async () => {
    // Arrange
    const body = { jan_cd: JAN, name: 'a'.repeat(11 * 1024) };

    // Act
    const res = await request(app).post('/api/products').send(body);

    // Assert
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'リクエストボディが大きすぎます' });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('異常系: 未対応の文字コードは内部メッセージを返さず 4xx', async () => {
    // Act
    const res = await request(app)
      .post('/api/products')
      .set('Content-Type', 'application/json; charset=x-unknown')
      .send('{}');

    // Assert: body-parser は 415 を返す。エラーメッセージ（charset 名など）は返さない
    expect(res.status).toBe(415);
    expect(res.body).toEqual({ error: 'リクエストが不正です' });
  });

  test('異常系: Content-Type が JSON でない場合はボディが解析されず 400', async () => {
    // Act
    const res = await request(app).post('/api/products').set('Content-Type', 'text/plain').send('jan_cd=1');

    // Assert
    expect(res.status).toBe(400);
  });
});

describe('存在しないパス', () => {
  // GET / は静的配信（public/index.html）が返すため対象外（「静的ファイル配信」で確認する）
  test.each([
    ['get', '/api/unknown'],
    ['get', '/no-such-page.html'],
    ['post', '/api/products/extra/path'],
    ['patch', `/api/products/${JAN}`],
    ['delete', '/api/stockinout'],
  ])('異常系: %s %s は JSON 形式の 404', async (method, path) => {
    // Act
    const res = await request(app)[method](path);

    // Assert
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: 'リクエストされたリソースが見つかりません' });
  });
});

describe('DB エラー時のレスポンス', () => {
  test('異常系: 想定外の DB エラーは 500 とし、SQL・スタックなどの内部情報を返さない', async () => {
    // Arrange
    const err = new Error('column "password_hash" does not exist');
    err.stack = 'Error: ...\n    at /home/ubuntu/advanced-issue/src/routes/products.js:137';
    pool.query.mockRejectedValue(err);

    // Act
    const res = await request(app).get('/api/products');

    // Assert
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'サーバー内部でエラーが発生しました' });
    expect(res.text).not.toMatch(/password_hash|src\/routes|at /);
    expect(consoleErrorSpy).toHaveBeenCalledWith(err);
  });

  test('異常系: 接続の取得に失敗した場合も 500（内部情報なし）', async () => {
    // Arrange
    pool.connect.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5432'));

    // Act
    const res = await request(app).post('/api/products').send({ jan_cd: JAN, name: '商品A' });

    // Assert
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('ECONNREFUSED');
  });

  test.each([
    ['22P02', 400],
    ['23505', 409],
    ['23503', 409],
    ['23514', 400],
    ['40P01', 409],
  ])('異常系: ルート内で PG エラー %s が発生すると %i に変換される', async (code, status) => {
    // Arrange
    pool.query.mockRejectedValue(pgError(code, 'detail with constraint name'));

    // Act
    const res = await request(app).get(`/api/products/${JAN}`);

    // Assert
    expect(res.status).toBe(status);
    expect(res.text).not.toContain('constraint name');
  });
});

describe('セキュリティヘッダー', () => {
  test('正常系: X-Powered-By を返さず、helmet のヘッダーを付与する', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app).get('/api/products');

    // Assert
    expect(res.status).toBe(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('静的ファイル配信', () => {
  test('正常系: GET / は public/index.html を text/html で返し、CSP ヘッダーが付く', async () => {
    // Act
    const res = await request(app).get('/');

    // Assert
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<title>在庫状況');
    // helmet の既定の CSP（インラインスクリプトを許可しない）が静的ファイルにも適用される
    expect(res.headers['content-security-policy']).toMatch(/script-src 'self'/);
    expect(res.headers['content-security-policy']).toMatch(/script-src-attr 'none'/);
    // http（EC2 + Nginx）で配信しても CSS・JS が読めるよう、https への自動切り替えは指示しない
    expect(res.headers['content-security-policy']).not.toMatch(/upgrade-insecure-requests/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test.each([
    ['/form.html', /text\/html/],
    ['/style.css', /text\/css/],
    ['/js/api.js', /javascript/],
  ])('正常系: %s を配信する', async (path, type) => {
    // Act
    const res = await request(app).get(path);

    // Assert
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(type);
  });

  test('異常系: public/ の外のファイル（.env・src/）は配信しない', async () => {
    // Act
    const resEnv = await request(app).get('/../.env');
    const resSrc = await request(app).get('/%2e%2e/src/app.js');

    // Assert
    expect(resEnv.status).toBe(404);
    expect(resEnv.headers['content-type']).toMatch(/application\/json/);
    expect(resSrc.status).toBe(404);
    expect(resSrc.text).not.toContain('express.static');
  });
});
