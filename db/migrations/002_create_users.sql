-- =============================================================================
-- 002: ユーザマスタ（users）の作成
-- ログイン認証・ロール判定・アクセストークン管理に使用する。
-- =============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS users (
    -- ユーザID（ログインID）
    user_id          VARCHAR(50)  NOT NULL,
    -- 氏名（ユーザ管理画面で検索対象）
    user_name        VARCHAR(100) NOT NULL,
    -- パスワード（平文は保存しない。ハッシュ化した値を格納する）
    password_hash    VARCHAR(255) NOT NULL,
    -- ロール（admin: 管理者 / general: 一般 の2種のみ）
    role             VARCHAR(10)  NOT NULL DEFAULT 'general',
    -- アクセストークン本体（未ログイン時は NULL）
    token            VARCHAR(512),
    -- トークン有効期限（発行から1日後を設定する想定）
    token_expires_at TIMESTAMPTZ,

    -- ===== 共通項目 =====
    -- 登録時刻
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- 登録者（初期管理者ユーザ作成時は登録者が存在しないため NULL 許容）
    created_by       VARCHAR(50),
    -- 更新時刻
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- 更新者（初期管理者ユーザ作成時は更新者が存在しないため NULL 許容）
    updated_by       VARCHAR(50),
    -- 削除フラグ（論理削除）
    is_deleted       BOOLEAN      NOT NULL DEFAULT FALSE,
    -- 更新シーケンス（楽観ロック用）
    update_seq       INTEGER      NOT NULL DEFAULT 0,

    CONSTRAINT pk_users PRIMARY KEY (user_id),
    -- ロールは2種類のみ許可
    CONSTRAINT ck_users_role CHECK (role IN ('admin', 'general')),
    -- トークンと有効期限は必ずセットで保持する
    CONSTRAINT ck_users_token_pair CHECK (
        (token IS NULL AND token_expires_at IS NULL)
        OR (token IS NOT NULL AND token_expires_at IS NOT NULL)
    ),
    CONSTRAINT ck_users_update_seq CHECK (update_seq >= 0),
    -- 登録者・更新者はユーザマスタを自己参照する
    CONSTRAINT fk_users_created_by FOREIGN KEY (created_by)
        REFERENCES users (user_id) ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_users_updated_by FOREIGN KEY (updated_by)
        REFERENCES users (user_id) ON UPDATE CASCADE ON DELETE RESTRICT
);

-- トークン照会（validatetoken）用。トークンは一意であること
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_token ON users (token) WHERE token IS NOT NULL;
-- 氏名検索用
CREATE INDEX IF NOT EXISTS idx_users_user_name ON users (user_name);

-- 更新時刻・更新シーケンスの自動更新トリガー
-- 再実行できるよう作り直す（CI/CD のデプロイで毎回マイグレーションを流すため）
DROP TRIGGER IF EXISTS trg_users_set_update_columns ON users;
CREATE TRIGGER trg_users_set_update_columns
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION fn_set_update_columns();

COMMENT ON TABLE  users                  IS 'ユーザマスタ：ログインユーザの認証情報・ロール・アクセストークンを管理する';
COMMENT ON COLUMN users.user_id          IS 'ユーザID（ログインID）';
COMMENT ON COLUMN users.user_name        IS '氏名';
COMMENT ON COLUMN users.password_hash    IS 'パスワードのハッシュ値（平文保存禁止）';
COMMENT ON COLUMN users.role             IS 'ロール（admin:管理者 / general:一般）';
COMMENT ON COLUMN users.token            IS 'アクセストークン本体';
COMMENT ON COLUMN users.token_expires_at IS 'トークン有効期限';
COMMENT ON COLUMN users.created_at       IS '登録時刻';
COMMENT ON COLUMN users.created_by       IS '登録者（ユーザID。初期管理者はNULL）';
COMMENT ON COLUMN users.updated_at       IS '更新時刻';
COMMENT ON COLUMN users.updated_by       IS '更新者（ユーザID。初期管理者はNULL）';
COMMENT ON COLUMN users.is_deleted       IS '削除フラグ（TRUE:論理削除済み）';
COMMENT ON COLUMN users.update_seq       IS '更新シーケンス（楽観ロック用。UPDATE毎に+1）';

COMMIT;
