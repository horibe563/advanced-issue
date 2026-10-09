// 入出庫伝票NOの採番（入庫・出庫で共通の連番）
// 入出庫登録（routes/stockinout.js）と商品登録時の初期入庫（routes/products.js）で共通利用する。
//
// 採番方法
//   - アドバイザリロック（pg_advisory_xact_lock。トランザクション終了で自動解放）で採番処理を直列化する
//   - 入庫・出庫の両テーブルを通した伝票NOの最大値 + 1 を新しい伝票NOとする
// 注意
//   - 必ずトランザクション内のクライアント（withTransaction の client）から呼び出すこと。
//     ロックはトランザクション終了まで保持されるため、採番した伝票NOの INSERT も同じトランザクションで行う。

// 伝票NO採番の排他に使うアドバイザリロックのキー（入庫・出庫で共通）
const SLIP_NO_LOCK_KEY = 'stockinout_slip_no';

/**
 * 新しい伝票NOを採番する
 * @param {import('pg').PoolClient} client トランザクション中のクライアント
 * @returns {Promise<number>} 新しい伝票NO
 */
async function nextSlipNo(client) {
  if (!client || typeof client.query !== 'function') {
    // プログラムの誤り（pool を渡した等）。アドバイザリロックが即解放されてしまうため受け付けない
    throw new Error('nextSlipNo にはトランザクション中のクライアントを渡してください');
  }
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [SLIP_NO_LOCK_KEY]);
  const { rows } = await client.query(
    `SELECT GREATEST(
              (SELECT COALESCE(MAX(slip_no), 0) FROM stock_ins),
              (SELECT COALESCE(MAX(slip_no), 0) FROM stock_outs)
            ) + 1 AS next_no`
  );
  const slipNo = Number(rows[0].next_no);
  // BIGINT の値が JavaScript で正確に扱える範囲を超えた場合は採番できない
  if (!Number.isSafeInteger(slipNo)) {
    throw new Error('伝票NOが採番可能な上限を超えました');
  }
  return slipNo;
}

module.exports = { SLIP_NO_LOCK_KEY, nextSlipNo };
