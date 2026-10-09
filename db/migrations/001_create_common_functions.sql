-- =============================================================================
-- 001: 共通関数の作成
-- 全テーブル共通の「更新時刻」「更新シーケンス」を UPDATE 時に自動更新する
-- トリガー関数を定義する。
-- =============================================================================
BEGIN;

-- 更新時刻・更新シーケンスの自動更新トリガー関数
--   - updated_at  : UPDATE 実行時刻（now()）で上書きする
--   - update_seq  : 楽観ロック用。更新前の値 + 1 を必ず設定する
--                   （アプリ側は WHERE update_seq = :取得時の値 で更新し、
--                     更新件数 0 件なら競合として扱う想定）
CREATE OR REPLACE FUNCTION fn_set_update_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    NEW.update_seq := OLD.update_seq + 1;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION fn_set_update_columns() IS
    '共通トリガー関数：UPDATE 時に更新時刻(updated_at)を現在時刻に、更新シーケンス(update_seq)を +1 に自動設定する';

COMMIT;
