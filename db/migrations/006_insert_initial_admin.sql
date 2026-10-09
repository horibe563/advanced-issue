-- =============================================================================
-- 006: 初期管理者ユーザの投入
-- ユーザID: admin / パスワード: password でログインできるようにする。
-- パスワードは bcrypt（コスト10）でハッシュ化した値を格納している。
-- ※ 初回ログイン後、ユーザマスタ画面から必ずパスワードを変更すること。
-- =============================================================================
BEGIN;

-- 登録者・更新者が存在しないため created_by / updated_by は NULL とする
-- 既に admin が存在する場合は何もしない（再実行しても安全）
INSERT INTO users (user_id, user_name, password_hash, role)
VALUES (
    'admin',
    '管理者',
    '$2b$10$osJyMwZrnoKmqXi8X.a44OpP4gcEaHfhVU03dn3OATKzIB39fPc16',
    'admin'
)
ON CONFLICT (user_id) DO NOTHING;

COMMIT;
