// src/middleware/auth.js のユニットテスト（app に組み込んだ状態で確認する）
// AAA パターン（Arrange/Act/Assert）で記述する
//
// DB には接続せず、jest.mock で pool.query をモックする。
// 業務 API（products / stockinout / usr）がトークンなしでは呼べないこと、
// usr は管理者のみ呼べることを確認する。
jest.mock('../../src/db/pool', () => ({
  query: jest.fn(),
  connect: jest.fn(),
  on: jest.fn(),
}));

const request = require('supertest');
const pool = require('../../src/db/pool');
const app = require('../../src/app');
const { generateToken, hashToken } = require('../../src/auth/token');

const TOKEN = generateToken();

// トークン照会で返すログインユーザ
function loginUser(overrides = {}) {
  return { user_id: 'user01', user_name: '山田太郎', role: 'general', token_expires_at: '2026-10-09T00:00:00.000Z', ...overrides };
}

// トークン照会の SQL にはログインユーザを、それ以外（業務 API の SQL）には空の一覧を返す
function mockTokenLookup(user) {
  pool.query.mockImplementation(async (sql) => {
    if (/FROM users\s+WHERE token = \$1/.test(sql)) return { rows: user ? [user] : [] };
    return { rows: [], rowCount: 0 };
  });
}

const PROTECTED = [
  ['get', '/api/products'],
  ['get', '/api/products/alerts'],
  ['get', '/api/products/export'],
  ['get', '/api/products/4901234567894'],
  ['post', '/api/products'],
  ['put', '/api/products/4901234567894'],
  ['delete', '/api/products/4901234567894?update_seq=0'],
  ['get', '/api/stockinout'],
  ['post', '/api/stockinout'],
  ['get', '/api/usr'],
  ['post', '/api/usr'],
  ['delete', '/api/usr/user01?update_seq=0'],
  ['get', '/api/validatetoken'],
  ['post', '/api/logout'],
];

beforeEach(() => {
  pool.query.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('requireAuth', () => {
  test.each(PROTECTED)('異常系: %s %s はトークンなしでは 401 になり、DB を照会しない', async (method, path) => {
    // Act
    const res = await request(app)[method](path).send({});

    // Assert
    expect(res.status).toBe(401);
    expect(res.body.error).toEqual(expect.any(String));
    expect(pool.query).not.toHaveBeenCalled();
  });

  test.each([
    ['Bearer の後が空', 'Bearer '],
    ['スキームが違う', `Basic ${TOKEN}`],
    ['トークンの形式が違う', 'Bearer abc'],
    ['大文字の16進', `Bearer ${TOKEN.toUpperCase()}`],
    ['余分な値', `Bearer ${TOKEN} extra`],
  ])('異常系: Authorization ヘッダーが不正（%s）なら 401', async (_, header) => {
    // Act
    const res = await request(app).get('/api/products').set('Authorization', header);

    // Assert
    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('異常系: 該当するトークンがない（期限切れ・削除済みユーザを含む）なら 401', async () => {
    // Arrange
    mockTokenLookup(null);

    // Act
    const res = await request(app).get('/api/products').set('Authorization', `Bearer ${TOKEN}`);

    // Assert
    expect(res.status).toBe(401);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('token_expires_at > now()');
    expect(sql).toContain('is_deleted = FALSE');
    // DB にはハッシュ値で照会する（平文のトークンは渡さない）
    expect(params).toEqual([hashToken(TOKEN)]);
  });

  test('正常系: 有効なトークンなら業務 API を呼び出せる', async () => {
    // Arrange
    mockTokenLookup(loginUser());

    // Act
    const res = await request(app).get('/api/products').set('Authorization', `Bearer ${TOKEN}`);

    // Assert
    expect(res.status).toBe(200);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  test('正常系: スキーム名の大文字小文字は区別しない', async () => {
    // Arrange
    mockTokenLookup(loginUser());

    // Act
    const res = await request(app).get('/api/stockinout').set('Authorization', `bearer ${TOKEN}`);

    // Assert
    expect(res.status).toBe(200);
  });

  test('異常系: トークン照会で DB エラーなら 500', async () => {
    // Arrange
    pool.query.mockRejectedValue(new Error('db down'));

    // Act
    const res = await request(app).get('/api/products').set('Authorization', `Bearer ${TOKEN}`);

    // Assert
    expect(res.status).toBe(500);
  });
});

describe('requireAdmin', () => {
  test.each([
    ['get', '/api/usr'],
    ['post', '/api/usr'],
    ['delete', '/api/usr/user01?update_seq=0'],
  ])('異常系: 一般ユーザは %s %s を呼べず 403', async (method, path) => {
    // Arrange
    mockTokenLookup(loginUser({ role: 'general' }));

    // Act
    const res = await request(app)[method](path).set('Authorization', `Bearer ${TOKEN}`).send({});

    // Assert
    expect(res.status).toBe(403);
    // トークン照会のみで、ユーザマスタの SQL は実行しない
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('正常系: 管理者は /api/usr を呼び出せる', async () => {
    // Arrange
    mockTokenLookup(loginUser({ user_id: 'admin', role: 'admin' }));

    // Act
    const res = await request(app).get('/api/usr').set('Authorization', `Bearer ${TOKEN}`);

    // Assert
    expect(res.status).toBe(200);
  });

  test('異常系: req.user がない場合は 403', () => {
    // Arrange
    const { requireAdmin } = require('../../src/middleware/auth');
    const next = jest.fn();

    // Act
    requireAdmin({}, {}, next);

    // Assert
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });
});
