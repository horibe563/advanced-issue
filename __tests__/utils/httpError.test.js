// src/utils/httpError.js のユニットテスト
// AAA パターン（Arrange/Act/Assert）で記述する
const { HttpError, badRequest, notFound, conflict } = require('../../src/utils/httpError');

describe('HttpError', () => {
  test('正常系: ステータス・メッセージ・詳細を保持する Error のサブクラス', () => {
    // Arrange
    const details = [{ field: 'a', message: 'x' }];

    // Act
    const err = new HttpError(418, 'メッセージ', details);

    // Assert
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('HttpError');
    expect(err.status).toBe(418);
    expect(err.message).toBe('メッセージ');
    expect(err.details).toBe(details);
  });

  test.each([
    [badRequest, 400],
    [notFound, 404],
    [conflict, 409],
  ])('正常系: ショートカット %p は %i の HttpError を返す', (factory, status) => {
    // Act
    const err = factory('msg');

    // Assert
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(status);
    expect(err.message).toBe('msg');
  });

  test('正常系: badRequest は項目別の詳細を付けられる', () => {
    // Act
    const err = badRequest('入力内容に誤りがあります', [{ field: 'a', message: 'b' }]);

    // Assert
    expect(err.details).toEqual([{ field: 'a', message: 'b' }]);
  });
});
