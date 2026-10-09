// src/routes/auth.js のユニットテスト
// AAA パターン（Arrange/Act/Assert）で記述する
//
// DB には接続せず、jest.mock で pool.query をモックする。
// パスワード照合は本物の bcrypt を使う。
jest.mock('../../src/db/pool', () => ({
  query: jest.fn(),
  connect: jest.fn(),
  on: jest.fn(),
}));

const request = require('supertest');
const bcrypt = require('bcrypt');
const pool = require('../../src/db/pool');
const app = require('../../src/app');
const { TOKEN_PATTERN, TOKEN_TTL_MS, generateToken, hashToken } = require('../../src/auth/token');

const PASSWORD = 'password123';
let passwordHash;
const EXPIRES_AT = '2026-10-09T00:00:00.000Z';

beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 4);
});

// login の SQL ごとの応答を設定する
//   user    : ユーザ照会の結果（null なら該当なし）
//   updated : トークン保存の UPDATE が更新できたか
function mockLogin({ user = { user_id: 'user01', user_name: '山田太郎', role: 'general' }, updated = true } = {}) {
  pool.query.mockImplementation(async (sql) => {
    if (/SELECT user_id, user_name, role, password_hash/.test(sql)) {
      return { rows: user ? [{ ...user, password_hash: passwordHash }] : [] };
    }
    if (/UPDATE users\s+SET token = \$1/.test(sql)) {
      return updated ? { rows: [{ token_expires_at: EXPIRES_AT }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
}

beforeEach(() => {
  pool.query.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('POST /api/login', () => {
  test('正常系: トークンを発行し、DB にはハッシュ値と1日後の有効期限を保存する', async () => {
    // Arrange
    mockLogin();

    // Act
    const res = await request(app).post('/api/login').send({ user_id: 'user01', password: PASSWORD });

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(TOKEN_PATTERN);
    expect(res.body).toMatchObject({
      expires_at: EXPIRES_AT,
      user: { user_id: 'user01', user_name: '山田太郎', role: 'general' },
    });
    expect(res.body.user).not.toHaveProperty('password_hash');

    const [selectSql, selectParams] = pool.query.mock.calls[0];
    expect(selectSql).toContain('is_deleted = FALSE');
    expect(selectParams).toEqual(['user01']);

    const [, updateParams] = pool.query.mock.calls[1];
    expect(updateParams).toEqual([hashToken(res.body.token), TOKEN_TTL_MS, 'user01']);
  });

  test('異常系: パスワードが違うと 401 でトークンを保存しない', async () => {
    // Arrange
    mockLogin();

    // Act
    const res = await request(app).post('/api/login').send({ user_id: 'user01', password: 'wrong-password' });

    // Assert
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('ユーザIDまたはパスワードが正しくありません');
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('異常系: ユーザが存在しない（削除済みを含む）場合もパスワード不一致と同じ 401', async () => {
    // Arrange
    mockLogin({ user: null });
    const compare = jest.spyOn(bcrypt, 'compare');

    // Act
    const res = await request(app).post('/api/login').send({ user_id: 'nobody', password: PASSWORD });

    // Assert
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('ユーザIDまたはパスワードが正しくありません');
    // 応答時間でユーザの有無を推測されないよう、該当なしでも照合を行う
    expect(compare).toHaveBeenCalledTimes(1);
  });

  test('異常系: 照合後にユーザが削除されトークンを保存できなかった場合は 401', async () => {
    // Arrange
    mockLogin({ updated: false });

    // Act
    const res = await request(app).post('/api/login').send({ user_id: 'user01', password: PASSWORD });

    // Assert
    expect(res.status).toBe(401);
  });

  test.each([
    ['user_id なし', { password: PASSWORD }],
    ['password なし', { user_id: 'user01' }],
    ['password が空', { user_id: 'user01', password: '' }],
    ['password が文字列でない', { user_id: 'user01', password: 12345678 }],
    ['password が72バイト超', { user_id: 'user01', password: 'a'.repeat(73) }],
    ['user_id が51文字', { user_id: 'a'.repeat(51), password: PASSWORD }],
    ['未定義の項目', { user_id: 'user01', password: PASSWORD, role: 'admin' }],
  ])('異常系: 入力不正（%s）は 400 で DB を照会しない', async (_, body) => {
    // Act
    const res = await request(app).post('/api/login').send(body);

    // Assert
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('異常系: 配列ボディは 400', async () => {
    // Act
    const res = await request(app).post('/api/login').send([]);

    // Assert
    expect(res.status).toBe(400);
  });
});

describe('GET /api/validatetoken', () => {
  test('正常系: 有効なトークンならログインユーザと有効期限を返す', async () => {
    // Arrange
    const token = generateToken();
    pool.query.mockResolvedValue({
      rows: [{ user_id: 'admin', user_name: '管理者', role: 'admin', token_expires_at: EXPIRES_AT }],
    });

    // Act
    const res = await request(app).get('/api/validatetoken').set('Authorization', `Bearer ${token}`);

    // Assert
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      valid: true,
      expires_at: EXPIRES_AT,
      user: { user_id: 'admin', user_name: '管理者', role: 'admin' },
    });
  });

  test('異常系: 無効なトークンなら 401', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app).get('/api/validatetoken').set('Authorization', `Bearer ${generateToken()}`);

    // Assert
    expect(res.status).toBe(401);
  });
});

describe('POST /api/logout', () => {
  test('正常系: 自分のトークンのみ無効化して 204', async () => {
    // Arrange
    const token = generateToken();
    pool.query
      .mockResolvedValueOnce({ rows: [{ user_id: 'user01', user_name: '山田太郎', role: 'general', token_expires_at: EXPIRES_AT }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    // Act
    const res = await request(app).post('/api/logout').set('Authorization', `Bearer ${token}`);

    // Assert
    expect(res.status).toBe(204);
    const [sql, params] = pool.query.mock.calls[1];
    expect(sql).toMatch(/SET token = NULL, token_expires_at = NULL/);
    expect(params).toEqual(['user01', hashToken(token)]);
  });
});
