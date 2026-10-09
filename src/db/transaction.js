// トランザクション実行ヘルパー
// プールからクライアントを1つ取得し、BEGIN〜COMMIT の間で callback を実行する。
// callback が例外を投げた場合は ROLLBACK し、例外をそのまま呼び出し元へ再送出する。
const pool = require('./pool');

async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // ROLLBACK 自体が失敗した場合（接続断など）はログのみ出力し、元のエラーを優先する
      console.error('ROLLBACK に失敗しました', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { withTransaction };
