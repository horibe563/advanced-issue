// Express アプリケーションの組み立て
// サーバ起動（listen）は src/index.js で行い、このファイルは app を export するだけにする
// （supertest からポートを使わずにテストできるようにするため）
// テスト（supertest）から app.js を直接読み込む場合にも DB 接続情報が使えるよう、ここでも .env を読み込む
// （pool.js は読み込み時に process.env を参照するため、ルートより先に読み込むこと）
require('dotenv').config({ quiet: true });

const path = require('path');
const express = require('express');
const helmet = require('helmet');

const productsRouter = require('./routes/products');
const stockInOutRouter = require('./routes/stockinout');
const usrRouter = require('./routes/usr');
const authRouter = require('./routes/auth');
const { requireAuth, requireAdmin } = require('./middleware/auth');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();

// レスポンスヘッダーから Express を使っていること(X-Powered-By)を隠す
app.disable('x-powered-by');

// セキュリティ関連のレスポンスヘッダーを付与する
// - EC2 では Nginx 経由の http で配信するため、CSP の upgrade-insecure-requests だけは外す
//   （有効なままだとブラウザが CSS・JS を https で取りに行き、画面が読み込めなくなる）
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: { upgradeInsecureRequests: null },
    },
  })
);

// JSON リクエストボディを扱う
// - 巨大なボディによる負荷を避けるため 10kb に制限する
// - strict: true（既定）でオブジェクト・配列以外のトップレベル値を拒否する
app.use(express.json({ limit: '10kb', strict: true }));

// 静的ファイル（フロントエンドの画面）を配信する
// - 起動時のカレントディレクトリに左右されないよう、このファイルの位置を基準に public/ を指定する
// - helmet() の既定の CSP が有効なため、画面側はインラインのスクリプト・スタイルを使わない
// - API ルートより前に置くが、public/ に api/ ディレクトリは置かないため /api/* とは競合しない
app.use(express.static(path.join(__dirname, '..', 'public')));

// API ルート
// 認証（login / validatetoken / logout）。login 以外は各ルート内でトークンを検証する
app.use('/api', authRouter);
// 業務 API はログインユーザ（有効なトークンを持つユーザ）のみ呼び出せる
app.use('/api/products', requireAuth, productsRouter);
app.use('/api/stockinout', requireAuth, stockInOutRouter);
// ユーザマスタは管理者のみ操作できる（要件「管理画面はAdminユーザのみが操作可能」）
app.use('/api/usr', requireAuth, requireAdmin, usrRouter);

// どのルートにも一致しなかったリクエストは JSON 形式の 404 を返す
app.use(notFoundHandler);

// 共通エラーハンドラ（必ず最後に登録する）
app.use(errorHandler);

module.exports = app;
