// src/utils/operator.js のユニットテスト
// AAA パターン（Arrange/Act/Assert）で記述する
const { getOperatorId } = require('../../src/utils/operator');
const { HttpError } = require('../../src/utils/httpError');

describe('getOperatorId', () => {
  test('正常系: requireAuth が設定したログインユーザのIDを返す', () => {
    // Act / Assert
    expect(getOperatorId({ user: { user_id: 'user01' } })).toBe('user01');
  });

  test.each([[{}], [{ user: {} }], [{ user: { user_id: '' } }], [undefined]])(
    '異常系: ログインユーザがない場合は 401 を投げる（%p）',
    (req) => {
      // Act / Assert
      expect(() => getOperatorId(req)).toThrow(HttpError);
      expect(() => getOperatorId(req)).toThrow(expect.objectContaining({ status: 401 }));
    }
  );
});
