// サーバーのエントリポイント
// 環境変数（DB接続情報・PORT）を .env から読み込んでから app を起動する
// ※ pool.js が読み込み時に process.env を参照するため、app より先に dotenv を読み込むこと
require('dotenv').config({ quiet: true });

const app = require('./app');
const pool = require('./db/pool');

const PORT = Number(process.env.PORT) || 3000;

const server = app.listen(PORT, () => {
  console.log(`サーバーが起動しました: http://localhost:${PORT}`);
});

// 終了シグナル受信時は新規受付を止め、DB 接続プールを閉じてから終了する
function shutdown(signal) {
  console.log(`${signal} を受信しました。サーバーを停止します`);
  server.close(() => {
    pool
      .end()
      .catch((err) => console.error('DB 接続プールの終了に失敗しました', err))
      .finally(() => process.exit(0));
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
