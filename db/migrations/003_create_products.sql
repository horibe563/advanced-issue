-- =============================================================================
-- 003: 商品マスタ（products）の作成
-- 商品情報と現在の在庫数・アラート用閾値を管理する。
-- =============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS products (
    -- JANコード（8桁 または 13桁の数字）
    jan_cd            VARCHAR(13)  NOT NULL,
    -- 商品名
    product_name      VARCHAR(200) NOT NULL,
    -- 商品規格
    product_spec      VARCHAR(200),
    -- 商品名カナ
    product_name_kana VARCHAR(200),
    -- 汎用項目1〜3（用途未定の予備項目）
    generic_item1     VARCHAR(255),
    generic_item2     VARCHAR(255),
    generic_item3     VARCHAR(255),
    -- 在庫数（入出庫登録時に更新する）
    stock             INTEGER      NOT NULL DEFAULT 0,
    -- 閾値（在庫数がこの値を下回ったらアラート表示）
    threshold         INTEGER      NOT NULL DEFAULT 0,

    -- ===== 共通項目 =====
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_by        VARCHAR(50)  NOT NULL,
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_by        VARCHAR(50)  NOT NULL,
    is_deleted        BOOLEAN      NOT NULL DEFAULT FALSE,
    update_seq        INTEGER      NOT NULL DEFAULT 0,

    CONSTRAINT pk_products PRIMARY KEY (jan_cd),
    -- JANコードは8桁または13桁の数字のみ
    CONSTRAINT ck_products_jan_cd CHECK (jan_cd ~ '^([0-9]{8}|[0-9]{13})$'),
    -- 在庫数・閾値は0以上
    CONSTRAINT ck_products_stock CHECK (stock >= 0),
    CONSTRAINT ck_products_threshold CHECK (threshold >= 0),
    CONSTRAINT ck_products_update_seq CHECK (update_seq >= 0),
    -- 登録者・更新者 → ユーザマスタ
    CONSTRAINT fk_products_created_by FOREIGN KEY (created_by)
        REFERENCES users (user_id) ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_products_updated_by FOREIGN KEY (updated_by)
        REFERENCES users (user_id) ON UPDATE CASCADE ON DELETE RESTRICT
);

-- 商品名・商品名カナでの検索用
CREATE INDEX IF NOT EXISTS idx_products_product_name      ON products (product_name);
CREATE INDEX IF NOT EXISTS idx_products_product_name_kana ON products (product_name_kana);

-- 更新時刻・更新シーケンスの自動更新トリガー
-- 再実行できるよう作り直す（CI/CD のデプロイで毎回マイグレーションを流すため）
DROP TRIGGER IF EXISTS trg_products_set_update_columns ON products;
CREATE TRIGGER trg_products_set_update_columns
    BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION fn_set_update_columns();

COMMENT ON TABLE  products                   IS '商品マスタ：商品情報・在庫数・アラート閾値を管理する';
COMMENT ON COLUMN products.jan_cd            IS 'JANコード（8桁または13桁）';
COMMENT ON COLUMN products.product_name      IS '商品名';
COMMENT ON COLUMN products.product_spec      IS '商品規格';
COMMENT ON COLUMN products.product_name_kana IS '商品名カナ';
COMMENT ON COLUMN products.generic_item1     IS '汎用項目1';
COMMENT ON COLUMN products.generic_item2     IS '汎用項目2';
COMMENT ON COLUMN products.generic_item3     IS '汎用項目3';
COMMENT ON COLUMN products.stock             IS '在庫数（0以上）';
COMMENT ON COLUMN products.threshold         IS '在庫アラート閾値（在庫数がこれを下回るとアラート表示。0以上）';
COMMENT ON COLUMN products.created_at        IS '登録時刻';
COMMENT ON COLUMN products.created_by        IS '登録者（ユーザID）';
COMMENT ON COLUMN products.updated_at        IS '更新時刻';
COMMENT ON COLUMN products.updated_by        IS '更新者（ユーザID）';
COMMENT ON COLUMN products.is_deleted        IS '削除フラグ（TRUE:論理削除済み）';
COMMENT ON COLUMN products.update_seq        IS '更新シーケンス（楽観ロック用。UPDATE毎に+1）';

COMMIT;
