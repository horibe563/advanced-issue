# アーキテクチャ設計書（在庫管理アプリ）

## 1. システム構成

```
ブラウザ（public/ の HTML/CSS/JS。トークンは localStorage）
   │  fetch（Authorization: Bearer <token>）
   ▼
Nginx（EC2。http で受けて Node.js へ転送）
   ▼
Node.js + Express（pm2 で常駐。PORT=3000）
   ├─ helmet（セキュリティヘッダー。CSP の upgrade-insecure-requests のみ無効）
   ├─ express.json（10kb まで）
   ├─ express.static（public/）
   ├─ /api            認証（login / validatetoken / logout）
   ├─ /api/products   requireAuth
   ├─ /api/stockinout requireAuth
   ├─ /api/usr        requireAuth + requireAdmin
   ├─ notFoundHandler（JSON の 404）
   └─ errorHandler（HttpError・PostgreSQL のエラーコードを HTTP ステータスに変換）
   ▼
PostgreSQL（pg の Pool。最大10接続、statement_timeout 5秒）
```

- デプロイ：GitHub Actions（.github/workflows/ci.yml でテスト → deploy.yml で main への push 時に EC2 へ SSH デプロイ。マイグレーションを毎回適用し pm2 で再起動）
- サーバ起動（listen）は src/index.js、アプリの組み立ては src/app.js（supertest でポートを使わずにテストするため分割）

## 2. ディレクトリ構成

| パス | 内容 |
|------|------|
| src/index.js | サーバ起動 |
| src/app.js | Express アプリの組み立て（ミドルウェア・ルートの登録） |
| src/routes/ | auth.js / products.js / stockinout.js / usr.js |
| src/middleware/ | auth.js（requireAuth / requireAdmin）、errorHandler.js |
| src/auth/token.js | トークンの発行・SHA-256 ハッシュ化・有効期限（24時間） |
| src/db/ | pool.js（接続プール）、transaction.js（withTransaction）、slipNo.js（伝票NO の採番） |
| src/utils/ | validators.js（入力チェック）、httpError.js、asyncHandler.js、operator.js（更新者ID）、csv.js（CSV 生成） |
| public/ | login.html / index.html / form.html / users.html、style.css、js/ |
| db/migrations/ | 001〜006 の SQL（べき等。CI/CD で毎回適用） |
| \_\_tests\_\_/ | Jest（バックエンド：supertest、フロントエンド：jsdom） |

## 3. API エンドポイント一覧

- すべて JSON（CSV 出力を除く）。エラーは `{ error, details? }`（details は項目ごとの `{ field, message }`）
- 「認証」列：✔ = `Authorization: Bearer <token>` 必須（なし・不正・期限切れは 401）、管理者 = admin ロールのみ（それ以外は 403）
- 一覧の limit は 1〜1000（既定 100）、offset は 0 以上（既定 0）。許可していないクエリパラメータは 400

### 認証

| メソッド | パス | 認証 | 概要 |
|----------|------|------|------|
| POST | /api/login | - | ユーザID・パスワードで認証し、トークンを発行する（有効期限1日）。応答 `{ token, expires_at, user }`。失敗は理由を区別せず 401 |
| GET | /api/validatetoken | ✔ | トークンが有効か確認する。応答 `{ valid, expires_at, user }` |
| POST | /api/logout | ✔ | トークンを無効化する（204） |

### 商品マスタ

| メソッド | パス | 認証 | 概要 |
|----------|------|------|------|
| GET | /api/products | ✔ | 一覧。クエリ：jan_cd（完全一致）、product_name / product_name_kana（部分一致）、alert（true / false）、limit、offset。応答 `{ total, count, limit, offset, items }`（各商品に is_alert） |
| GET | /api/products/alerts | ✔ | **【C-後半で追加】在庫アラート**。在庫数 < 閾値 の商品を不足数（閾値 − 在庫数）の大きい順 → JAN コード順で返す。クエリは limit / offset のみ。応答 `{ total, count, limit, offset, items: [{ jan_cd, product_name, product_spec, product_name_kana, stock, threshold, shortage, updated_at }] }` |
| GET | /api/products/export | ✔ | **【C-後半で追加】CSV 出力**。一覧と同じ検索条件（jan_cd / product_name / product_name_kana / alert）の全件を JAN コード順で CSV にする（詳細は 5 章） |
| GET | /api/products/:jan_cd | ✔ | 詳細 |
| POST | /api/products | ✔ | 登録（201）。初期在庫が 1 以上なら初期入庫伝票も作成し、伝票NO を initial_slip_no で返す |
| PUT | /api/products/:jan_cd | ✔ | 更新（指定項目のみ。update_seq 必須で楽観ロック、不一致は 409）。stock・jan_cd は変更不可 |
| DELETE | /api/products/:jan_cd?update_seq= | ✔ | 論理削除（204） |

- /alerts・/export は /:jan_cd より前に登録している（"alerts" が JAN コードとして検証されて 400 になるのを防ぐ）

### 入出庫

| メソッド | パス | 認証 | 概要 |
|----------|------|------|------|
| GET | /api/stockinout | ✔ | 入出庫履歴の一覧。クエリ：type（in / out）、jan_cd、slip_no、date_from / date_to（YYYY-MM-DD）、limit、offset。各行に在庫への影響 stock_delta |
| POST | /api/stockinout | ✔ | 入出庫の登録（201）。新規伝票 `{ type, jan_cd, quantity, date? }`、訂正伝票 `{ type, slip_no, quantity, slip_flag, date? }`。履歴の追加と在庫数の更新を1トランザクションで行い、在庫がマイナスになる場合は 409 |

### ユーザマスタ

| メソッド | パス | 認証 | 概要 |
|----------|------|------|------|
| GET | /api/usr | 管理者 | 一覧。クエリ：user_id / user_name（部分一致）、role、limit、offset。パスワード・トークンは返さない |
| POST | /api/usr | 管理者 | update_seq なし＝登録（201）、あり＝更新（200。氏名・パスワード・ロール） |
| DELETE | /api/usr/:user_id?update_seq= | 管理者 | 論理削除（204）。有効な管理者が1人もいなくなる操作は 409 |

### 主なエラーステータス

| ステータス | 発生条件 |
|------------|----------|
| 400 | 入力チェックエラー、不正な JSON、CHECK / NOT NULL 違反など |
| 401 | トークンなし・不正・期限切れ、ログイン失敗 |
| 403 | 管理者以外がユーザマスタを操作 |
| 404 | 対象なし（削除済みを含む） |
| 409 | 楽観ロックの競合、重複登録、在庫不足、管理者がいなくなる操作 |
| 413 | リクエストボディが 10kb 超 |
| 429 | **【C-後半で追加】** CSV 出力の同時実行が上限（2件）を超えた |
| 503 | **【C-後半で追加】** SQL がタイムアウト（PostgreSQL 57014）した |
| 500 | 上記以外（内部情報は返さずサーバーログにのみ出力） |

## 4. DB スキーマ

- 全テーブル共通の項目：created_at / created_by（登録時刻・登録者）、updated_at / updated_by（更新時刻・更新者）、is_deleted（論理削除）、update_seq（楽観ロック）
- updated_at・update_seq は共通トリガー関数 fn_set_update_columns()（001）で UPDATE 時に自動更新する
- 登録者・更新者は users.user_id への外部キー
- C-後半の追加機能（アラート・CSV 出力）ではテーブル・列の追加はない（既存の products.stock / threshold を利用）

### users（ユーザマスタ／002）

| 列 | 型 | 制約・説明 |
|----|----|------------|
| user_id | VARCHAR(50) | PK。ログインID |
| user_name | VARCHAR(100) | NOT NULL。氏名（索引あり） |
| password_hash | VARCHAR(255) | NOT NULL。bcrypt（コスト10） |
| role | VARCHAR(10) | NOT NULL、既定 general。admin / general のみ |
| token | VARCHAR(512) | トークンの SHA-256 ハッシュ値（平文は保存しない）。一意（NULL 以外） |
| token_expires_at | TIMESTAMPTZ | トークン有効期限（発行から24時間）。token と必ずセットで NULL / 非NULL |
| 共通項目 | | created_by / updated_by は初期管理者のみ NULL 可 |

- 1ユーザ1トークン（再ログインで上書き、ログアウトで NULL）
- 初期データ（006）：admin ユーザ

### products（商品マスタ／003）

| 列 | 型 | 制約・説明 |
|----|----|------------|
| jan_cd | VARCHAR(13) | PK。8桁または13桁の数字 |
| product_name | VARCHAR(200) | NOT NULL（索引あり） |
| product_spec | VARCHAR(200) | 規格 |
| product_name_kana | VARCHAR(200) | 商品名カナ（索引あり） |
| generic_item1〜3 | VARCHAR(255) | 汎用項目 |
| stock | INTEGER | NOT NULL、既定 0、0 以上。入出庫登録時にアプリ側で更新 |
| threshold | INTEGER | NOT NULL、既定 0、0 以上。**stock < threshold で在庫アラート**（一覧の is_alert、/alerts、CSV の「在庫アラート」列で共通の定義） |
| 共通項目 | | |

### stock_ins（入庫履歴／004）・stock_outs（出庫履歴／005）

2テーブルは日付列名（stock_in_date / stock_out_date）以外は同じ構造。

| 列 | 型 | 制約・説明 |
|----|----|------------|
| id | BIGINT | PK（IDENTITY） |
| slip_no | BIGINT | NOT NULL、1 以上。伝票NO（入庫・出庫共通の採番。訂正伝票は元伝票と同じ） |
| slip_seq | INTEGER | NOT NULL、1 以上。同一伝票NO内の連番（元伝票=1） |
| jan_cd | VARCHAR(13) | NOT NULL。products への外部キー |
| stock_in_date / stock_out_date | DATE | NOT NULL。省略時は当日 |
| quantity | INTEGER | NOT NULL、1 以上 |
| slip_flag | SMALLINT | NOT NULL、既定 1。1:正 / 2:負 |
| 共通項目 | | |

- 一意制約：(slip_no, slip_seq)
- 索引：(jan_cd, 日付)、(日付)

### ER 図

```
users 1 ──< products（created_by / updated_by）
users 1 ──< stock_ins / stock_outs（created_by / updated_by）
products 1 ──< stock_ins（jan_cd）
products 1 ──< stock_outs（jan_cd）
```

## 5. C-後半の追加機能の設計

### 在庫アラート通知（GET /api/products/alerts）

- 対象：削除されていない商品のうち stock < threshold（閾値ちょうどは対象外）
- 画面：在庫状況画面（index.html）上部の「在庫アラート」カード。一覧と同じタイミング（初期表示・再読み込み・画面に戻ったとき・削除後）で更新し、取得エラーはカード内だけに表示する

### CSV 出力（GET /api/products/export）

- 列：JANコード, 商品名, 規格, 商品名カナ, 汎用項目1〜3, 在庫数, 閾値, 在庫アラート（在庫不足／空）, 更新日時（JST）, 更新者
- 形式：UTF-8（BOM 付き・Excel 対応）、改行 CRLF、RFC 4180 のクォート
- CSV インジェクション対策：先頭（空白類・BOM の後を含む）が = + - @（全角含む）、またはタブ・CR・LF の値は先頭に ' を付ける
- ヘッダー：`Content-Type: text/csv; charset=utf-8`、`Content-Disposition: attachment; filename="inventory_YYYYMMDD_HHmmss.csv"`、`Cache-Control: no-store`
- 負荷対策：最大 50,000件（超える場合は 400「条件を絞ってください」）、同時実行は1プロセスあたり2件まで（超えたら 429）、Buffer + Content-Length で返し ETag は計算しない
- 監査ログ：成功時に user_id・検索条件・件数・時刻を console.info で1行出力（トークンは含めない）
- 画面：在庫状況画面の「CSV出力」ボタン。認証ヘッダーが必要なため fetch → Blob → a[download] で保存する（タイムアウト 60秒、応答が text/csv でなければエラー、保存名は英数字と _ - . の .csv のみ許可）

## 6. 認証・セキュリティ

- トークン：32バイトの乱数（16進64文字）。DB には SHA-256 ハッシュのみ保存。有効期限は src/auth/token.js の TOKEN_TTL_MS（24時間）
- 画面：各画面の読み込み時に /api/validatetoken で確認し、401 ならログイン画面へ遷移（遷移先は同一オリジンのパスのみ許可）
- SQL はすべてプレースホルダ（$1…）。LIKE のワイルドカードはエスケープ
- 画面は textContent で表示し innerHTML は使わない。CSP によりインラインのスクリプト・スタイルは使わない
- ログインはユーザの有無・パスワード不一致を区別しない（存在しないユーザでも bcrypt で照合し応答時間をそろえる）
