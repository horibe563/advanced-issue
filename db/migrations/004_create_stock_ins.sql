-- =============================================================================
-- 004: 入庫履歴（stock_ins）の作成
-- 商品ごとの入庫実績を記録する。訂正時も元の行は上書きせず、同一伝票NOで行を追加する。
--   伝票フラグ 1:正（加算） / 2:負（減算）
--   例）伝票NO=A001 の数量3（フラグ1）を -1 訂正する場合、
--       伝票NO=A001・伝票フラグ2・数量1 の行を追加する（実数量 = 3 - 1 = 2）
-- =============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS stock_ins (
    -- 入庫履歴ID（サロゲートキー）
    id            BIGINT       GENERATED ALWAYS AS IDENTITY,
    -- 伝票NO（元伝票と訂正伝票で同一の値を使う）
    slip_no       BIGINT       NOT NULL,
    -- 伝票シーケンスNO（同一伝票NO内の連番。元伝票=1、訂正ごとに+1）
    slip_seq      INTEGER      NOT NULL,
    -- JANコード（商品マスタ参照）
    jan_cd        VARCHAR(13)  NOT NULL,
    -- 入庫日
    stock_in_date DATE         NOT NULL,
    -- 入庫数（正の整数。符号は伝票フラグで表す）
    quantity      INTEGER      NOT NULL,
    -- 伝票フラグ（1: 正 / 2: 負）
    slip_flag     SMALLINT     NOT NULL DEFAULT 1,

    -- ===== 共通項目 =====
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_by    VARCHAR(50)  NOT NULL,
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_by    VARCHAR(50)  NOT NULL,
    is_deleted    BOOLEAN      NOT NULL DEFAULT FALSE,
    update_seq    INTEGER      NOT NULL DEFAULT 0,

    CONSTRAINT pk_stock_ins PRIMARY KEY (id),
    -- 伝票NO＋伝票シーケンスNOで一意
    CONSTRAINT uq_stock_ins_slip UNIQUE (slip_no, slip_seq),
    -- 伝票NOは1以上
    CONSTRAINT ck_stock_ins_slip_no CHECK (slip_no >= 1),
    -- 伝票シーケンスNOは1以上
    CONSTRAINT ck_stock_ins_slip_seq CHECK (slip_seq >= 1),
    -- 入庫数は正の整数
    CONSTRAINT ck_stock_ins_quantity CHECK (quantity > 0),
    -- 伝票フラグは 1:正 / 2:負 の2種のみ
    CONSTRAINT ck_stock_ins_slip_flag CHECK (slip_flag IN (1, 2)),
    CONSTRAINT ck_stock_ins_update_seq CHECK (update_seq >= 0),
    -- JANコード → 商品マスタ（履歴が残る商品は物理削除不可）
    CONSTRAINT fk_stock_ins_jan_cd FOREIGN KEY (jan_cd)
        REFERENCES products (jan_cd) ON UPDATE CASCADE ON DELETE RESTRICT,
    -- 登録者・更新者 → ユーザマスタ
    CONSTRAINT fk_stock_ins_created_by FOREIGN KEY (created_by)
        REFERENCES users (user_id) ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_stock_ins_updated_by FOREIGN KEY (updated_by)
        REFERENCES users (user_id) ON UPDATE CASCADE ON DELETE RESTRICT
);

-- 商品別履歴表示（在庫変動履歴子画面）用：JANコード＋入庫日
CREATE INDEX IF NOT EXISTS idx_stock_ins_jan_cd_date ON stock_ins (jan_cd, stock_in_date);
-- 期間指定での履歴一覧用：入庫日
CREATE INDEX IF NOT EXISTS idx_stock_ins_date ON stock_ins (stock_in_date);

-- 更新時刻・更新シーケンスの自動更新トリガー
-- 再実行できるよう作り直す（CI/CD のデプロイで毎回マイグレーションを流すため）
DROP TRIGGER IF EXISTS trg_stock_ins_set_update_columns ON stock_ins;
CREATE TRIGGER trg_stock_ins_set_update_columns
    BEFORE UPDATE ON stock_ins
    FOR EACH ROW EXECUTE FUNCTION fn_set_update_columns();

COMMENT ON TABLE  stock_ins               IS '入庫履歴：商品ごとの入庫実績（元伝票・訂正伝票）を記録する';
COMMENT ON COLUMN stock_ins.id            IS '入庫履歴ID（自動採番）';
COMMENT ON COLUMN stock_ins.slip_no       IS '伝票NO（元伝票と訂正伝票で同一）';
COMMENT ON COLUMN stock_ins.slip_seq      IS '伝票シーケンスNO（同一伝票NO内の連番。元伝票=1）';
COMMENT ON COLUMN stock_ins.jan_cd        IS 'JANコード（商品マスタ参照）';
COMMENT ON COLUMN stock_ins.stock_in_date IS '入庫日';
COMMENT ON COLUMN stock_ins.quantity      IS '入庫数（正の整数。符号は伝票フラグで表す）';
COMMENT ON COLUMN stock_ins.slip_flag     IS '伝票フラグ（1:正 / 2:負）';
COMMENT ON COLUMN stock_ins.created_at    IS '登録時刻';
COMMENT ON COLUMN stock_ins.created_by    IS '登録者（ユーザID）';
COMMENT ON COLUMN stock_ins.updated_at    IS '更新時刻';
COMMENT ON COLUMN stock_ins.updated_by    IS '更新者（ユーザID）';
COMMENT ON COLUMN stock_ins.is_deleted    IS '削除フラグ（TRUE:論理削除済み）';
COMMENT ON COLUMN stock_ins.update_seq    IS '更新シーケンス（楽観ロック用。UPDATE毎に+1）';

COMMIT;
