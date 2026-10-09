// Jest のセットアップ（各テストファイルの実行前に読み込まれる）
//
// 安全装置：ユニットテストは DB に接続しない前提（src/db/pool をモックする）。
// モックし忘れたテストが .env の接続先（開発用 DB の todo_db）に書き込まないよう、
// 接続先を到達できないダミー値に差し替えておく。
// dotenv は既に設定済みの環境変数を上書きしないため、src/app.js や src/index.js が
// .env を読み込んでも、ここで設定した値が優先される。
process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = '1';
process.env.DB_NAME = 'unit_test_no_db';
process.env.DB_USER = 'unit_test_user';
process.env.DB_PASSWORD = 'unit_test_password';
// 接続を試みてもすぐ失敗するよう、接続待ちの上限を短くする
process.env.DB_CONNECTION_TIMEOUT_MS = '1000';
