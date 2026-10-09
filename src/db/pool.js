// PostgreSQL への接続プール設定
// 環境変数(DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD)から接続情報を読み込み、
// pg の Pool でコネクションプールを構築する。
// プールの上限・タイムアウトは以下の環境変数で上書きできる（未設定・空文字なら既定値）。
//   DB_POOL_MAX               プールの最大接続数（既定 10）
//   DB_STATEMENT_TIMEOUT_MS   1文あたりの実行時間の上限ミリ秒（既定 5000。超えると DB 側で中断）
//   DB_CONNECTION_TIMEOUT_MS  プールから接続を取得するまでの待ち時間の上限ミリ秒（既定 5000）
const { Pool } = require('pg');

// 正の整数の環境変数を読み込む（不正な値は設定ミスとして起動時に例外にする）
function readPositiveIntEnv(name, defaultValue, { min = 1, max = 2147483647 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`環境変数 ${name} は整数で指定してください`);
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`環境変数 ${name} は${min}〜${max}の範囲で指定してください`);
  }
  return value;
}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  // 最大接続数（DB の max_connections を食い潰さないよう上限を設ける）
  max: readPositiveIntEnv('DB_POOL_MAX', 10, { max: 1000 }),
  // 長時間実行される SQL を DB 側で打ち切る（接続ごとに statement_timeout を設定する）
  statement_timeout: readPositiveIntEnv('DB_STATEMENT_TIMEOUT_MS', 5000),
  // プールが満杯のときに接続取得を無期限に待たないようにする
  connectionTimeoutMillis: readPositiveIntEnv('DB_CONNECTION_TIMEOUT_MS', 5000),
});

// プール内の待機中(アイドル)クライアントで接続断などのエラーが起きた場合、
// リスナーが無いと 'error' イベントが未処理となりプロセスが落ちてしまう。
// ログ出力のみ行い、プロセスは継続させる(壊れたクライアントは pg がプールから破棄する)。
pool.on('error', (err) => {
  console.error('DB 接続プールでエラーが発生しました', err);
});

module.exports = pool;
