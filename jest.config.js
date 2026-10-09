// Jest 設定ファイル
// バックエンド（src/）は node 環境、フロントエンド（public/js/）は jsdom 環境で、それぞれ別の project としてテストする
module.exports = {
  // カバレッジ計測を有効にする（projects 使用時は計測対象をここで指定する必要がある）
  collectCoverage: true,
  collectCoverageFrom: ['<rootDir>/src/**/*.js', '<rootDir>/public/js/**/*.js'],
  coverageDirectory: 'coverage',
  coverageReporters: ['lcov', 'text'],
  // 要件 N2（テストカバレッジ 70% 以上）を下回ったらテストを失敗させる
  coverageThreshold: {
    global: { statements: 70, branches: 70, functions: 70, lines: 70 },
  },

  projects: [
    {
      displayName: 'backend',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/__tests__/**/*.test.js'],
      testPathIgnorePatterns: ['<rootDir>/__tests__/public/'],
      // テスト実行前に読み込む設定（誤って実 DB に接続しないよう接続先をダミーに差し替える）
      setupFiles: ['<rootDir>/jest.setup.js'],
      // テストごとにモックの呼び出し履歴をリセットする
      clearMocks: true,
    },
    {
      displayName: 'frontend',
      testEnvironment: 'jsdom',
      testMatch: ['<rootDir>/__tests__/public/**/*.test.js'],
      // 画面のスクリプトは ES Modules（type="module"）のため、テスト時のみ CommonJS に変換して読み込む
      transform: {
        '^.+\\.js$': ['babel-jest', { plugins: ['@babel/plugin-transform-modules-commonjs'] }],
      },
      clearMocks: true,
    },
  ],
};
