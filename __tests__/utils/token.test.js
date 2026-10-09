// src/auth/token.js のユニットテスト
// AAA パターン（Arrange/Act/Assert）で記述する
const { TOKEN_TTL_MS, TOKEN_PATTERN, generateToken, hashToken } = require('../../src/auth/token');

describe('generateToken', () => {
  test('正常系: 64桁の16進文字列を毎回異なる値で発行する', () => {
    // Act
    const a = generateToken();
    const b = generateToken();

    // Assert
    expect(a).toMatch(TOKEN_PATTERN);
    expect(b).toMatch(TOKEN_PATTERN);
    expect(a).not.toBe(b);
  });
});

describe('hashToken', () => {
  test('正常系: 同じトークンは同じハッシュ値になり、元のトークンとは異なる', () => {
    // Arrange
    const token = generateToken();

    // Act / Assert
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(token);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});

test('有効期限は1日', () => {
  expect(TOKEN_TTL_MS).toBe(24 * 60 * 60 * 1000);
});
