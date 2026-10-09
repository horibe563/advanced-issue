
## Agent Team の役割定義

Agent Teams でこのプロジェクトを開発する際は以下の役割を使用すること：

- **Backend Agent**：`src/` 配下のサーバーサイドコードを担当
  - Express ルートと pg を使った DB 操作のパターンに従う
  - バリデーション・エラーハンドリングを必ず実装する
- **Frontend Agent**：`public/` 配下のクライアントサイドコードを担当
  - バニラ HTML/CSS/JavaScript で実装する
  - fetch API でバックエンドの REST API と通信する
  - C-前半で作成した既存の public/ のスタイルと整合性を保つ
- **Test Agent**：`__tests__/` 配下のテストコードを担当
  - バックエンドは Jest + supertest、フロントエンドは Jest + jsdom でテストする
- **Review Agent**：全出力のセキュリティ・コード品質をレビューする
