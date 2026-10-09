# Subagent定義書

## backend-architect
- 役割：バックエンド部分を実装するエージェント
- 担当するタスク：DB/テーブルの構築　APIロジックの実装など　 `src/` 配下のサーバーサイドコードを担当
- 特に注意させること：frontend-deveoperの成果物との整合性を取ること

## frontend-developer
- 役割：フロントエンド部分を実装するエージェント
- 担当するタスク： `public/` 配下のクライアントサイドコードを担当
- 特に注意させること：バニラ HTML/CSS/JavaScript で実装する
  　　　　　　　　　　fetch API でバックエンドの REST API と通信する

## security-auditor
- 役割：セキュリティ観点でバックエンド・フロントエンドの成果物を評価する
- 担当するタスク：backend-architectとfrontend-developerの成果物をレビューし、セキュリティ観点で修正が必要箇所を提示し、修正を行わせる
- 特に注意させること：SQLインジェクション、CORS、DOS攻撃など一般的なセキュリティインシデントになりうる要素は全てレビューすること
