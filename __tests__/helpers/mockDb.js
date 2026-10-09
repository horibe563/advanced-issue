// テスト用の DB モックヘルパー
// jest.mock('../../src/db/pool') でモックした pool に対し、
// pool.connect() が返すクライアント（client.query / client.release）を組み立てる。
//
// client.query は「SQL に一致する正規表現 → 返す結果」のルール表で応答する。
// 呼び出し順に依存しないため、ルート内の SQL の順序が多少変わってもテストが壊れにくい。
//   rules: [[/INSERT INTO products/, { rows: [...] }], [/SELECT stock/, (sql, params) => ({ rows: [...] })], ...]
// - 値に関数を指定すると (sql, params) を受け取って結果を返す（例外を投げれば DB エラーを再現できる）
// - BEGIN / COMMIT / ROLLBACK と一致しない SQL は { rows: [], rowCount: 0 } を返す
const pool = require('../../src/db/pool');

// 共通の空結果
const EMPTY = { rows: [], rowCount: 0 };

function createClient(rules = []) {
  const client = {
    query: jest.fn(async (sql, params) => {
      for (const [pattern, result] of rules) {
        if (pattern.test(sql)) {
          const value = typeof result === 'function' ? await result(sql, params) : result;
          return value ?? EMPTY;
        }
      }
      return EMPTY;
    }),
    release: jest.fn(),
  };
  return client;
}

// pool.connect() がルール表どおりに応答するクライアントを返すよう設定し、そのクライアントを返す
function mockTransactionClient(rules = []) {
  const client = createClient(rules);
  pool.connect.mockResolvedValue(client);
  return client;
}

// client.query に渡された SQL のうち、パターンに一致する呼び出し（[sql, params]）を返す
function callsMatching(mockFn, pattern) {
  return mockFn.mock.calls.filter(([sql]) => pattern.test(sql));
}

// 実行された SQL 文の一覧（空白を詰めたもの）
function executedSql(mockFn) {
  return mockFn.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' ').trim());
}

// PostgreSQL のエラーを再現する（code は SQLSTATE）
function pgError(code, message = 'pg error') {
  const err = new Error(message);
  err.code = code;
  return err;
}

module.exports = { EMPTY, createClient, mockTransactionClient, callsMatching, executedSql, pgError };
