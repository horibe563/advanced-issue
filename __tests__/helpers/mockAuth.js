// ルートのテスト用の認証ミドルウェアのモック
// ルートのテストは業務ロジックに集中させるため、トークン検証（DB 照会）を行わず
// 常に管理者 admin でログインしているものとして req.user を設定する。
// トークン検証そのものは __tests__/middleware/auth.test.js でテストする。
//   jest.mock('../../src/middleware/auth', () => require('../helpers/mockAuth'));
const LOGIN_USER = { user_id: 'admin', user_name: '管理者', role: 'admin' };

module.exports = {
  LOGIN_USER,
  requireAuth: (req, res, next) => {
    req.user = { ...LOGIN_USER };
    next();
  },
  requireAdmin: (req, res, next) => next(),
};
