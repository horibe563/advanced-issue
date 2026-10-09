// src/routes/usr.js のユニットテスト
// AAA パターン（Arrange/Act/Assert）で記述する
//
// DB には接続せず、jest.mock で pool.query / pool.connect（client.query / release）をモックする。
// 新規登録は pool.query、更新・削除はトランザクション（client.query）を使う。
// パスワードのハッシュ化は本物の bcrypt を使い、DB に渡す値が平文でないこと・照合できることを確認する。
jest.mock('../../src/db/pool', () => ({
  query: jest.fn(),
  connect: jest.fn(),
  on: jest.fn(),
}));
// 認証は常に admin でログイン済みとして扱う（トークン検証は middleware/auth.test.js でテストする）
jest.mock('../../src/middleware/auth', () => require('../helpers/mockAuth'));

const request = require('supertest');
const bcrypt = require('bcrypt');
const pool = require('../../src/db/pool');
const app = require('../../src/app');
const { mockTransactionClient, callsMatching, executedSql } = require('../helpers/mockDb');

// レスポンスに含めてはいけない項目
const SECRET_FIELDS = ['password', 'password_hash', 'token', 'token_expires_at'];

// DB から返るユーザ1行分（SELECT_COLUMNS に対応する列のみ）
function buildUser(overrides = {}) {
  return {
    user_id: 'user01',
    user_name: '山田太郎',
    role: 'general',
    created_at: '2026-10-08T00:00:00.000Z',
    created_by: 'admin',
    updated_at: '2026-10-08T00:00:00.000Z',
    updated_by: 'admin',
    update_seq: 0,
    ...overrides,
  };
}

// RETURNING 句（レスポンスとして返す列）を取り出す
function returningClause(sql) {
  return sql.split('RETURNING')[1] ?? '';
}

// 更新・削除用のトランザクションのモック
//   admins  : 行ロックした有効な管理者の user_id 一覧
//   updated : UPDATE が返す行（null なら0件 = 楽観ロック失敗 or 存在しない）
//   exists  : UPDATE 0件時の存在確認の結果
function mockUserTransaction({ admins = ['admin'], updated = buildUser({ update_seq: 1 }), exists = true } = {}) {
  return mockTransactionClient([
    [/SELECT user_id FROM users WHERE role = 'admin'/, { rows: admins.map((id) => ({ user_id: id })) }],
    [/UPDATE users/, { rows: updated ? [updated] : [], rowCount: updated ? 1 : 0 }],
    [/SELECT 1 FROM users/, { rows: exists ? [{}] : [] }],
  ]);
}

beforeEach(() => {
  pool.query.mockReset();
  pool.connect.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GET /api/usr（一覧）', () => {
  test('正常系: ユーザ一覧を返し、パスワードハッシュ・トークンを含めない', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [{ ...buildUser({ user_id: 'admin', role: 'admin' }), total_count: '2' }, { ...buildUser(), total_count: '2' }] });

    // Act
    const res = await request(app).get('/api/usr');

    // Assert
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, count: 2, limit: 100, offset: 0 });
    expect(res.body.items[0]).not.toHaveProperty('total_count');
    const [sql, params] = pool.query.mock.calls[0];
    for (const field of SECRET_FIELDS) expect(sql).not.toContain(field);
    expect(sql).toContain('is_deleted = FALSE');
    expect(sql).toMatch(/ORDER BY user_id/);
    expect(params).toEqual([100, 0]);
  });

  test('正常系: 0件なら total=0', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app).get('/api/usr');

    // Assert
    expect(res.body).toEqual({ total: 0, count: 0, limit: 100, offset: 0, items: [] });
  });

  test('正常系: ID・氏名の部分一致（空白除去・ワイルドカードはエスケープ）とロールで絞り込む', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app).get('/api/usr').query({ user_id: ' user_0 ', user_name: '山田%', role: 'general' });

    // Assert
    expect(res.status).toBe(200);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('user_id ILIKE $1 AND user_name ILIKE $2 AND role = $3');
    expect(params).toEqual(['%user\\_0%', '%山田\\%%', 'general', 100, 0]);
  });

  test('正常系: 空文字・空白のみの検索条件は無視する', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app).get('/api/usr').query({ user_id: ' ', user_name: '', role: '' });

    // Assert
    expect(res.status).toBe(200);
    expect(pool.query.mock.calls[0][1]).toEqual([100, 0]);
  });

  test.each([
    [{ role: 'root' }, 'role', 'role は admin / general のいずれかで指定してください'],
    [{ user_id: 'a'.repeat(51) }, 'user_id', 'user_id は50文字以内で指定してください'],
    [{ user_name: 'あ'.repeat(101) }, 'user_name', 'user_name は100文字以内で指定してください'],
    [{ password_hash: 'x' }, 'password_hash', 'password_hash は指定できない検索条件です'],
  ])('異常系: 検索条件 %p は 400', async (query, field, message) => {
    // Act
    const res = await request(app).get('/api/usr').query(query);

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field, message }]);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test.each(['user_id', 'user_name', 'role'])('異常系: クエリ %s に NUL 文字（%%00）を含むと 400（監査修正の回帰テスト）', async (field) => {
    // Act
    const res = await request(app).get(`/api/usr?${field}=a%00b`);

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field, message: `${field} に使用できない文字が含まれています` }]);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('POST /api/usr（新規登録）', () => {
  test('正常系: パスワードを bcrypt でハッシュ化して登録し、201 でハッシュ・トークンを含まないユーザ情報を返す', async () => {
    // Arrange
    pool.query.mockImplementation(async (sql, params) => ({
      rows: [buildUser({ user_id: params[0], user_name: params[1], role: params[3] })],
    }));

    // Act
    const res = await request(app).post('/api/usr').send({ user_id: 'user01', user_name: ' 山田太郎 ', password: 'Passw0rd!' });

    // Assert
    expect(res.status).toBe(201);
    expect(res.body).toEqual(buildUser());
    for (const field of SECRET_FIELDS) expect(res.body).not.toHaveProperty(field);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (user_id) DO NOTHING');
    for (const field of SECRET_FIELDS) expect(returningClause(sql)).not.toContain(field);
    // [user_id, user_name, password_hash, role, operator]（ロール省略時は general）
    expect(params[0]).toBe('user01');
    expect(params[1]).toBe('山田太郎');
    expect(params[3]).toBe('general');
    expect(params[4]).toBe('admin');
    // DB には平文ではなく bcrypt（コスト10）のハッシュを渡す
    expect(params[2]).not.toBe('Passw0rd!');
    expect(params[2]).toMatch(/^\$2[aby]\$10\$/);
    await expect(bcrypt.compare('Passw0rd!', params[2])).resolves.toBe(true);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('正常系: パスワードの前後の空白はパスワードの一部として扱う（trim しない）', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [buildUser()] });

    // Act
    const res = await request(app).post('/api/usr').send({ user_id: 'user01', user_name: '山田', password: '  pass word  ' });

    // Assert
    expect(res.status).toBe(201);
    const hash = pool.query.mock.calls[0][1][2];
    await expect(bcrypt.compare('  pass word  ', hash)).resolves.toBe(true);
    await expect(bcrypt.compare('pass word', hash)).resolves.toBe(false);
  });

  test('正常系: role=admin を指定して登録できる', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [buildUser({ role: 'admin' })] });

    // Act
    const res = await request(app).post('/api/usr').send({ user_id: 'admin2', user_name: '管理者2', password: 'password1', role: 'admin' });

    // Assert
    expect(res.status).toBe(201);
    expect(pool.query.mock.calls[0][1][3]).toBe('admin');
  });

  test('正常系: update_seq: null は新規登録として扱う', async () => {
    // Arrange
    pool.query.mockResolvedValue({ rows: [buildUser()] });

    // Act
    const res = await request(app).post('/api/usr').send({ user_id: 'user01', user_name: '山田', password: 'password1', update_seq: null });

    // Assert
    expect(res.status).toBe(201);
  });

  test('異常系: 同じユーザID（削除済みを含む）が既にあれば 409', async () => {
    // Arrange: ON CONFLICT DO NOTHING で RETURNING が0件
    pool.query.mockResolvedValue({ rows: [] });

    // Act
    const res = await request(app).post('/api/usr').send({ user_id: 'admin', user_name: '重複', password: 'password1' });

    // Assert
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: '同じユーザIDが既に登録されています（削除済みのユーザを含む）' });
  });

  test.each([
    [{ user_name: '山田', password: 'password1' }, 'user_id', 'user_id は必須です'],
    [{ user_id: 'user 01', user_name: '山田', password: 'password1' }, 'user_id', 'user_id は半角英数字と . _ - のみで指定してください'],
    [{ user_id: ' user01', user_name: '山田', password: 'password1' }, 'user_id', 'user_id は半角英数字と . _ - のみで指定してください'],
    [{ user_id: 'ユーザ', user_name: '山田', password: 'password1' }, 'user_id', 'user_id は半角英数字と . _ - のみで指定してください'],
    [{ user_id: 'a'.repeat(51), user_name: '山田', password: 'password1' }, 'user_id', 'user_id は50文字以内で指定してください'],
    [{ user_id: 1, user_name: '山田', password: 'password1' }, 'user_id', 'user_id は文字列で指定してください'],
    [{ user_id: 'user01', password: 'password1' }, 'user_name', 'user_name は必須です'],
    [{ user_id: 'user01', user_name: 'あ'.repeat(101), password: 'password1' }, 'user_name', 'user_name は100文字以内で指定してください'],
    [{ user_id: 'user01', user_name: '山田' }, 'password', 'password は必須です'],
    [{ user_id: 'user01', user_name: '山田', password: 'short' }, 'password', 'password は8文字以上で指定してください'],
    [{ user_id: 'user01', user_name: '山田', password: 'あ'.repeat(25) }, 'password', 'password は72バイト以内で指定してください'],
    [{ user_id: 'user01', user_name: '山田', password: 12345678 }, 'password', 'password は文字列で指定してください'],
    [{ user_id: 'user01', user_name: '山田', password: 'password1', role: 'root' }, 'role', 'role は admin / general のいずれかで指定してください'],
    [{ user_id: 'user01', user_name: '山田', password: 'password1', token: 'x' }, 'token', 'token は指定できない項目です'],
    [{ user_id: 'user01', user_name: '山田', password: 'password1', password_hash: 'x' }, 'password_hash', 'password_hash は指定できない項目です'],
  ])('異常系: 入力 %p は 400', async (body, field, message) => {
    // Act
    const res = await request(app).post('/api/usr').send(body);

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details).toContainEqual({ field, message });
    expect(pool.query).not.toHaveBeenCalled();
  });

  test.each([
    ['空文字', ''],
    ['空白のみ', '        '],
    ['全角空白・タブのみ', '　\t　\t　\t　\t'],
  ])('異常系: パスワードが%sなら 400（監査修正の回帰テスト：500 にならない）', async (label, password) => {
    // Act
    const res = await request(app).post('/api/usr').send({ user_id: 'user01', user_name: '山田', password });

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'password', message: 'password は空文字や空白のみでは指定できません' }]);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('POST /api/usr（更新）', () => {
  test('正常系: update_seq を指定すると楽観ロック付きで指定項目のみ更新し、200 を返す', async () => {
    // Arrange
    const client = mockUserTransaction({ updated: buildUser({ user_name: '山田花子', update_seq: 4 }) });

    // Act
    const res = await request(app).post('/api/usr').send({ user_id: 'user01', user_name: '山田花子', update_seq: 3 });

    // Assert
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ user_name: '山田花子', update_seq: 4 });
    for (const field of SECRET_FIELDS) expect(res.body).not.toHaveProperty(field);
    const [[sql, params]] = callsMatching(client.query, /UPDATE users/);
    expect(sql).toMatch(/SET user_name = \$1, updated_by = \$2/);
    expect(sql).toMatch(/WHERE user_id = \$3 AND is_deleted = FALSE AND update_seq = \$4/);
    for (const field of SECRET_FIELDS) expect(returningClause(sql)).not.toContain(field);
    expect(params).toEqual(['山田花子', 'admin', 'user01', 3]);
    // パスワードを変更しない場合はトークンを無効化しない
    expect(sql).not.toContain('token = NULL');
    expect(executedSql(client.query).at(-1)).toBe('COMMIT');
  });

  test('正常系: パスワード変更時はハッシュ化して保存し、トークンと有効期限を NULL にする', async () => {
    // Arrange
    const client = mockUserTransaction();

    // Act
    const res = await request(app).post('/api/usr').send({ user_id: 'user01', password: 'newPassw0rd', update_seq: 0 });

    // Assert
    expect(res.status).toBe(200);
    const [[sql, params]] = callsMatching(client.query, /UPDATE users/);
    expect(sql).toMatch(/password_hash = \$1, token = NULL, token_expires_at = NULL, updated_by = \$2/);
    expect(params[0]).not.toBe('newPassw0rd');
    await expect(bcrypt.compare('newPassw0rd', params[0])).resolves.toBe(true);
    for (const field of SECRET_FIELDS) expect(res.body).not.toHaveProperty(field);
  });

  test('正常系: 一般 → 管理者への昇格は管理者数の確認をしない', async () => {
    // Arrange
    const client = mockUserTransaction({ updated: buildUser({ role: 'admin' }) });

    // Act
    const res = await request(app).post('/api/usr').send({ user_id: 'user01', role: 'admin', update_seq: 0 });

    // Assert
    expect(res.status).toBe(200);
    expect(callsMatching(client.query, /role = 'admin'/)).toHaveLength(0);
    expect(callsMatching(client.query, /UPDATE users/)[0][1]).toEqual(['admin', 'admin', 'user01', 0]);
  });

  test('正常系: 他に有効な管理者がいれば管理者を一般に降格できる', async () => {
    // Arrange
    const client = mockUserTransaction({ admins: ['admin', 'admin2'], updated: buildUser({ user_id: 'admin2' }) });

    // Act
    const res = await request(app).post('/api/usr').send({ user_id: 'admin2', role: 'general', update_seq: 0 });

    // Assert
    expect(res.status).toBe(200);
    // 管理者行を行ロックしてから数える
    const [[sql]] = callsMatching(client.query, /SELECT user_id FROM users WHERE role = 'admin'/);
    expect(sql).toMatch(/is_deleted = FALSE FOR UPDATE/);
  });

  test('異常系: 最後の管理者を一般に降格しようとすると 409', async () => {
    // Arrange
    const client = mockUserTransaction({ admins: ['admin'] });

    // Act
    const res = await request(app).post('/api/usr').send({ user_id: 'admin', role: 'general', update_seq: 0 });

    // Assert
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: '有効な管理者ユーザが1人もいなくなるため、この操作はできません' });
    expect(callsMatching(client.query, /UPDATE users/)).toHaveLength(0);
    expect(executedSql(client.query)).toContain('ROLLBACK');
  });

  test('異常系: update_seq が一致しない（他のユーザが更新済み）場合は 409', async () => {
    // Arrange
    mockUserTransaction({ updated: null, exists: true });

    // Act
    const res = await request(app).post('/api/usr').send({ user_id: 'user01', user_name: '山田', update_seq: 0 });

    // Assert
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: '他のユーザによって更新されています。最新の情報を取得してから再度実行してください' });
  });

  test('異常系: 存在しない（削除済みの）ユーザの更新は 404', async () => {
    // Arrange
    mockUserTransaction({ updated: null, exists: false });

    // Act
    const res = await request(app).post('/api/usr').send({ user_id: 'nobody', user_name: '山田', update_seq: 0 });

    // Assert
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: '指定されたユーザが見つかりません' });
  });

  test('異常系: 更新する項目がない場合は 400', async () => {
    // Arrange
    mockUserTransaction();

    // Act
    const res = await request(app).post('/api/usr').send({ user_id: 'user01', update_seq: 0 });

    // Assert
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: '更新する項目（user_name / password / role）を1つ以上指定してください' });
  });

  test.each([
    [{ user_id: 'user01', user_name: '', update_seq: 0 }, 'user_name', 'user_name は必須です'],
    [{ user_id: 'user01', user_name: 'A', update_seq: '0' }, 'update_seq', 'update_seq は整数で指定してください'],
    [{ user_id: 'user01', user_name: 'A', update_seq: -1 }, 'update_seq', 'update_seq は0〜2147483647の範囲で指定してください'],
    [{ user_name: 'A', update_seq: 0 }, 'user_id', 'user_id は必須です'],
  ])('異常系: 入力 %p は 400', async (body, field, message) => {
    // Act
    const res = await request(app).post('/api/usr').send(body);

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details).toContainEqual({ field, message });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test.each([
    ['空文字', ''],
    ['空白のみ', '   '],
  ])('異常系: 更新でもパスワードが%sなら 400（監査修正の回帰テスト）', async (label, password) => {
    // Act
    const res = await request(app).post('/api/usr').send({ user_id: 'user01', password, update_seq: 0 });

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'password', message: 'password は空文字や空白のみでは指定できません' }]);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/usr/:user_id（論理削除）', () => {
  test('正常系: 削除フラグを立ててトークンを無効化し、204 を返す', async () => {
    // Arrange
    const client = mockUserTransaction({ admins: ['admin'] });

    // Act
    const res = await request(app).delete('/api/usr/user01').query({ update_seq: '2' });

    // Assert
    expect(res.status).toBe(204);
    const [[sql, params]] = callsMatching(client.query, /UPDATE users/);
    expect(sql).not.toMatch(/DELETE FROM/);
    expect(sql).toMatch(/SET is_deleted = TRUE, token = NULL, token_expires_at = NULL, updated_by = \$1/);
    expect(sql).toMatch(/WHERE user_id = \$2 AND is_deleted = FALSE AND update_seq = \$3/);
    expect(params).toEqual(['admin', 'user01', 2]);
    expect(executedSql(client.query).at(-1)).toBe('COMMIT');
  });

  test('正常系: 他に管理者がいれば管理者を削除できる', async () => {
    // Arrange
    mockUserTransaction({ admins: ['admin', 'admin2'] });

    // Act
    const res = await request(app).delete('/api/usr/admin2').query({ update_seq: '0' });

    // Assert
    expect(res.status).toBe(204);
  });

  test('異常系: 最後の管理者は削除できない（409）', async () => {
    // Arrange
    const client = mockUserTransaction({ admins: ['admin'] });

    // Act
    const res = await request(app).delete('/api/usr/admin').query({ update_seq: '0' });

    // Assert
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: '有効な管理者ユーザが1人もいなくなるため、この操作はできません' });
    expect(callsMatching(client.query, /UPDATE users/)).toHaveLength(0);
  });

  test('異常系: update_seq が一致しない場合は 409', async () => {
    // Arrange
    mockUserTransaction({ updated: null, exists: true });

    // Act
    const res = await request(app).delete('/api/usr/user01').query({ update_seq: '0' });

    // Assert
    expect(res.status).toBe(409);
  });

  test('異常系: 存在しないユーザは 404', async () => {
    // Arrange
    mockUserTransaction({ updated: null, exists: false });

    // Act
    const res = await request(app).delete('/api/usr/nobody').query({ update_seq: '0' });

    // Assert
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: '指定されたユーザが見つかりません' });
  });

  test.each([
    ['/api/usr/user01', 'update_seq', 'update_seq は必須です'],
    ['/api/usr/user01?update_seq=x', 'update_seq', 'update_seq は0〜2147483647の整数で指定してください'],
    ['/api/usr/user01?update_seq=0&hard=1', 'hard', 'hard は指定できない検索条件です'],
    ['/api/usr/user%2001?update_seq=0', 'user_id', 'user_id は半角英数字と . _ - のみで指定してください'],
  ])('異常系: %s は 400', async (path, field, message) => {
    // Act
    const res = await request(app).delete(path);

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field, message }]);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
