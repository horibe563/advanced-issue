// src/db/pool.js のユニットテスト
// AAA パターン（Arrange/Act/Assert）で記述する
//
// 本物の pg.Pool を使うと DB への接続を試みてしまうため、jest.mock('pg') で
// Pool コンストラクタをモックに差し替え、「環境変数から接続設定を組み立てて Pool に渡しているか」を検証する。
// セキュリティ監査で追加した max / statement_timeout / connectionTimeoutMillis の
// 読み込み（既定値・上書き・不正な値で例外）の回帰テストを含む。
jest.mock('pg', () => ({
  Pool: jest.fn(),
}));

// プール設定の環境変数（テストごとに削除してから必要なものだけ設定する）
const POOL_ENV_NAMES = ['DB_POOL_MAX', 'DB_STATEMENT_TIMEOUT_MS', 'DB_CONNECTION_TIMEOUT_MS'];

describe('src/db/pool.js', () => {
  const ORIGINAL_ENV = process.env;
  // jest.resetModules() で 'pg' のモックも作り直されるため、resetModules の後に取り直す
  let Pool;

  // pool.js を読み込み、Pool に渡された設定を返す
  function loadPoolConfig() {
    require('../../src/db/pool');
    return Pool.mock.calls[0][0];
  }

  beforeEach(() => {
    jest.resetModules();
    Pool = require('pg').Pool;
    // pool.js は生成直後に pool.on('error', ...) を呼ぶため、on を持つインスタンスを返す
    Pool.mockImplementation(() => ({ query: jest.fn(), on: jest.fn() }));
    process.env = {
      ...ORIGINAL_ENV,
      DB_HOST: 'test-host',
      DB_PORT: '5433',
      DB_NAME: 'test_db',
      DB_USER: 'test-user',
      DB_PASSWORD: 'test-password',
    };
    for (const name of POOL_ENV_NAMES) delete process.env[name];
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('正常系: 環境変数から接続設定を組み立て、プール設定は既定値を使う', () => {
    // Act
    const config = loadPoolConfig();

    // Assert: port は数値に変換して渡す
    expect(Pool).toHaveBeenCalledTimes(1);
    expect(config).toEqual({
      host: 'test-host',
      port: 5433,
      database: 'test_db',
      user: 'test-user',
      password: 'test-password',
      max: 10,
      statement_timeout: 5000,
      connectionTimeoutMillis: 5000,
    });
  });

  test('正常系: 空文字・空白のみの環境変数は既定値を使う', () => {
    // Arrange
    process.env.DB_POOL_MAX = '';
    process.env.DB_STATEMENT_TIMEOUT_MS = '   ';

    // Act
    const config = loadPoolConfig();

    // Assert
    expect(config.max).toBe(10);
    expect(config.statement_timeout).toBe(5000);
  });

  test('正常系: 環境変数で上書きできる（前後の空白は無視する）', () => {
    // Arrange
    process.env.DB_POOL_MAX = '20';
    process.env.DB_STATEMENT_TIMEOUT_MS = ' 3000 ';
    process.env.DB_CONNECTION_TIMEOUT_MS = '1500';

    // Act
    const config = loadPoolConfig();

    // Assert
    expect(config.max).toBe(20);
    expect(config.statement_timeout).toBe(3000);
    expect(config.connectionTimeoutMillis).toBe(1500);
  });

  test('正常系: 上限の境界値（DB_POOL_MAX=1000）は許可する', () => {
    // Arrange
    process.env.DB_POOL_MAX = '1000';

    // Act
    const config = loadPoolConfig();

    // Assert
    expect(config.max).toBe(1000);
  });

  test.each([
    ['DB_POOL_MAX', 'abc', '環境変数 DB_POOL_MAX は整数で指定してください'],
    ['DB_POOL_MAX', '-1', '環境変数 DB_POOL_MAX は整数で指定してください'],
    ['DB_POOL_MAX', '1.5', '環境変数 DB_POOL_MAX は整数で指定してください'],
    ['DB_POOL_MAX', '0', '環境変数 DB_POOL_MAX は1〜1000の範囲で指定してください'],
    ['DB_POOL_MAX', '1001', '環境変数 DB_POOL_MAX は1〜1000の範囲で指定してください'],
    ['DB_STATEMENT_TIMEOUT_MS', '5s', '環境変数 DB_STATEMENT_TIMEOUT_MS は整数で指定してください'],
    ['DB_STATEMENT_TIMEOUT_MS', '2147483648', '環境変数 DB_STATEMENT_TIMEOUT_MS は1〜2147483647の範囲で指定してください'],
    ['DB_CONNECTION_TIMEOUT_MS', '0', '環境変数 DB_CONNECTION_TIMEOUT_MS は1〜2147483647の範囲で指定してください'],
    ['DB_CONNECTION_TIMEOUT_MS', '99999999999999999999', '環境変数 DB_CONNECTION_TIMEOUT_MS は1〜2147483647の範囲で指定してください'],
  ])('異常系: %s=%p は設定ミスとして読み込み時に例外を投げる', (name, value, message) => {
    // Arrange
    process.env[name] = value;

    // Act / Assert
    expect(() => require('../../src/db/pool')).toThrow(message);
    expect(Pool).not.toHaveBeenCalled();
  });

  test('正常系: 生成した Pool インスタンスをそのまま export し、error リスナーを登録する', () => {
    // Arrange
    const instance = { query: jest.fn(), on: jest.fn() };
    Pool.mockImplementation(() => instance);

    // Act
    const pool = require('../../src/db/pool');

    // Assert
    expect(pool).toBe(instance);
    expect(instance.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  test('異常系: error リスナーはログ出力のみ行い、例外を投げない', () => {
    // Arrange
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const pool = require('../../src/db/pool');
    const listener = pool.on.mock.calls[0][1];
    const err = new Error('接続断');

    // Act / Assert
    expect(() => listener(err)).not.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalledWith('DB 接続プールでエラーが発生しました', err);
    consoleErrorSpy.mockRestore();
  });
});
