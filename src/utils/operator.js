// 操作ユーザ（登録者・更新者）の取得
// トークン検証ミドルウェア（src/middleware/auth.js の requireAuth）が req.user に設定したユーザIDを返す。
const { unauthorized } = require('./httpError');

function getOperatorId(req) {
  const userId = req && req.user && req.user.user_id;
  // requireAuth を通っていないルートから呼ばれた場合に、登録者なしで書き込まないようにする
  if (typeof userId !== 'string' || userId === '') throw unauthorized();
  return userId;
}

module.exports = { getOperatorId };
