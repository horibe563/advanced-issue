// 認証・認可ミドルウェア
//   requireAuth  : Authorization: Bearer <token> を検証し、ログインユーザを req.user に設定する
//                  トークンなし・形式不正・該当なし・期限切れ・削除済みユーザはすべて 401
//   requireAdmin : requireAuth の後に置き、管理者ロール以外は 403
const pool = require('../db/pool');
const asyncHandler = require('../utils/asyncHandler');
const { unauthorized, forbidden } = require('../utils/httpError');
const { TOKEN_PATTERN, hashToken } = require('../auth/token');

// Authorization ヘッダーからトークンを取り出す（形式が不正なら null）
function extractToken(req) {
  const header = req.get('Authorization');
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match || !TOKEN_PATTERN.test(match[1])) return null;
  return match[1];
}

const requireAuth = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);
  if (!token) throw unauthorized();

  const { rows } = await pool.query(
    `SELECT user_id, user_name, role, token_expires_at
       FROM users
      WHERE token = $1 AND token_expires_at > now() AND is_deleted = FALSE`,
    [hashToken(token)]
  );
  if (rows.length === 0) throw unauthorized();

  req.user = rows[0];
  req.tokenHash = hashToken(token);
  next();
});

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return next(forbidden('この操作は管理者のみ実行できます'));
  return next();
}

module.exports = { requireAuth, requireAdmin, extractToken };
