// src/utils/asyncHandler.js のユニットテスト
// AAA パターン（Arrange/Act/Assert）で記述する
const asyncHandler = require('../../src/utils/asyncHandler');

describe('asyncHandler', () => {
  test('正常系: ハンドラに req / res / next をそのまま渡し、成功時は next を呼ばない', async () => {
    // Arrange
    const fn = jest.fn().mockResolvedValue(undefined);
    const req = {};
    const res = {};
    const next = jest.fn();

    // Act
    await asyncHandler(fn)(req, res, next);
    await new Promise((resolve) => setImmediate(resolve));

    // Assert
    expect(fn).toHaveBeenCalledWith(req, res, next);
    expect(next).not.toHaveBeenCalled();
  });

  test('異常系: async 関数の reject を next(err) に渡す', async () => {
    // Arrange
    const error = new Error('失敗');
    const next = jest.fn();

    // Act
    asyncHandler(async () => {
      throw error;
    })({}, {}, next);
    await new Promise((resolve) => setImmediate(resolve));

    // Assert
    expect(next).toHaveBeenCalledWith(error);
  });

  test('異常系: 同期的に投げた例外は呼び出し元へ伝わる（Express が next に渡す）', () => {
    // Arrange
    const handler = asyncHandler(() => {
      throw new Error('同期エラー');
    });

    // Act / Assert
    expect(() => handler({}, {}, jest.fn())).toThrow('同期エラー');
  });
});
