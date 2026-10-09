// src/db/transaction.js のユニットテスト
// AAA パターン（Arrange/Act/Assert）で記述する
// pool.connect をモックし、BEGIN / COMMIT / ROLLBACK と release の呼び出しを検証する
jest.mock('../../src/db/pool', () => ({
  query: jest.fn(),
  connect: jest.fn(),
  on: jest.fn(),
}));

const pool = require('../../src/db/pool');
const { withTransaction } = require('../../src/db/transaction');

let client;

beforeEach(() => {
  client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
  pool.connect.mockResolvedValue(client);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('withTransaction', () => {
  test('正常系: BEGIN → callback → COMMIT の順に実行し、callback の戻り値を返す', async () => {
    // Arrange
    const callback = jest.fn(async (c) => {
      await c.query('SELECT 1');
      return 'result';
    });

    // Act
    const result = await withTransaction(callback);

    // Assert
    expect(result).toBe('result');
    expect(callback).toHaveBeenCalledWith(client);
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('異常系: callback が例外を投げたら ROLLBACK して同じ例外を再送出し、接続を返却する', async () => {
    // Arrange
    const error = new Error('処理失敗');

    // Act / Assert
    await expect(
      withTransaction(async () => {
        throw error;
      })
    ).rejects.toBe(error);
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('異常系: ROLLBACK 自体が失敗しても元の例外を優先し、ログに残す', async () => {
    // Arrange
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const original = new Error('元の例外');
    const rollbackErr = new Error('接続断');
    client.query.mockImplementation(async (sql) => {
      if (sql === 'ROLLBACK') throw rollbackErr;
      return { rows: [] };
    });

    // Act / Assert
    await expect(
      withTransaction(async () => {
        throw original;
      })
    ).rejects.toBe(original);
    expect(consoleErrorSpy).toHaveBeenCalledWith('ROLLBACK に失敗しました', rollbackErr);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('異常系: COMMIT が失敗した場合も ROLLBACK して例外を再送出する', async () => {
    // Arrange
    const commitErr = new Error('COMMIT 失敗');
    client.query.mockImplementation(async (sql) => {
      if (sql === 'COMMIT') throw commitErr;
      return { rows: [] };
    });

    // Act / Assert
    await expect(withTransaction(async () => 'ok')).rejects.toBe(commitErr);
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('異常系: 接続の取得に失敗した場合は例外をそのまま返す（release は呼ばない）', async () => {
    // Arrange
    const connectErr = new Error('timeout exceeded when trying to connect');
    pool.connect.mockRejectedValue(connectErr);
    const callback = jest.fn();

    // Act / Assert
    await expect(withTransaction(callback)).rejects.toBe(connectErr);
    expect(callback).not.toHaveBeenCalled();
    expect(client.release).not.toHaveBeenCalled();
  });
});
