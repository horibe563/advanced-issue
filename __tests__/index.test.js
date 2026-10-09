// src/index.js（サーバー起動・終了処理）のユニットテスト
// AAA パターン（Arrange/Act/Assert）で記述する
//
// 実際にポートを listen しないよう ../src/app をモックし、listen の引数と
// SIGINT / SIGTERM 受信時の終了処理（server.close → pool.end → process.exit）を検証する。
// .env の PORT に影響されないよう dotenv もモックする。
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../src/app', () => ({ listen: jest.fn() }));
jest.mock('../src/db/pool', () => ({ end: jest.fn(), on: jest.fn() }));

const ORIGINAL_PORT = process.env.PORT;

let app;
let pool;
let server;
let signalHandlers;
let exitSpy;
let logSpy;
let errorSpy;

// index.js を読み込み直す（モジュールキャッシュを消して毎回トップレベルを実行する）
function loadIndex() {
  jest.isolateModules(() => {
    app = require('../src/app');
    pool = require('../src/db/pool');
    server = { close: jest.fn((cb) => cb()) };
    app.listen.mockImplementation((port, cb) => {
      cb();
      return server;
    });
    require('../src/index');
  });
}

// pool.end().finally(...) の完了を待つ
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  signalHandlers = {};
  jest.spyOn(process, 'on').mockImplementation((event, handler) => {
    signalHandlers[event] = handler;
    return process;
  });
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  if (ORIGINAL_PORT === undefined) delete process.env.PORT;
  else process.env.PORT = ORIGINAL_PORT;
});

describe('src/index.js', () => {
  test('正常系: 環境変数 PORT で listen し、起動ログを出す', () => {
    // Arrange
    process.env.PORT = '4567';

    // Act
    loadIndex();

    // Assert
    expect(app.listen).toHaveBeenCalledWith(4567, expect.any(Function));
    expect(logSpy).toHaveBeenCalledWith('サーバーが起動しました: http://localhost:4567');
  });

  test('正常系: PORT 未設定・不正な値なら 3000 で listen する', () => {
    // Arrange
    process.env.PORT = 'abc';

    // Act
    loadIndex();

    // Assert
    expect(app.listen).toHaveBeenCalledWith(3000, expect.any(Function));
  });

  test.each(['SIGINT', 'SIGTERM'])('正常系: %s 受信でサーバー停止 → プール終了 → exit(0)', async (signal) => {
    // Arrange
    loadIndex();
    pool.end.mockResolvedValue();

    // Act
    signalHandlers[signal]();
    await flush();

    // Assert
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(logSpy).toHaveBeenCalledWith(`${signal} を受信しました。サーバーを停止します`);
  });

  test('異常系: プールの終了に失敗してもログを出して exit(0) する', async () => {
    // Arrange
    loadIndex();
    const err = new Error('end failed');
    pool.end.mockRejectedValue(err);

    // Act
    signalHandlers.SIGTERM();
    await flush();

    // Assert
    expect(errorSpy).toHaveBeenCalledWith('DB 接続プールの終了に失敗しました', err);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
