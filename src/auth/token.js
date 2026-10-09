// アクセストークンの発行・ハッシュ化
// - トークンは推測できないよう暗号論的乱数（32バイト）から作る
// - DB には SHA-256 のハッシュ値のみ保存し、DB が漏えいしてもトークンをそのまま使われないようにする
//   （トークン自体が十分長い乱数のため、bcrypt のような低速ハッシュは不要）
const crypto = require('crypto');

// 有効期限は発行から1日（要件「トークンの有効期限は一日」）
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

// 発行するトークンの形式（32バイトの16進表記 = 64文字）
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { TOKEN_TTL_MS, TOKEN_PATTERN, generateToken, hashToken };
