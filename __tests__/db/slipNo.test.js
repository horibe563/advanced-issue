// src/db/slipNo.js のユニットテスト
// AAA パターン（Arrange/Act/Assert）で記述する
// クライアントをモックし、採番の手順（アドバイザリロック → 入庫・出庫共通の MAX + 1）を検証する
const { SLIP_NO_LOCK_KEY, nextSlipNo } = require('../../src/db/slipNo');

// next_no を返すクライアントのモック
function buildClient(nextNo) {
  return {
    query: jest.fn(async (sql) => (/GREATEST/.test(sql) ? { rows: [{ next_no: nextNo }] } : { rows: [] })),
  };
}

describe('nextSlipNo', () => {
  test('正常系: アドバイザリロックを取得してから採番し、数値で返す', async () => {
    // Arrange: BIGINT は pg から文字列で返る
    const client = buildClient('12');

    // Act
    const slipNo = await nextSlipNo(client);

    // Assert
    expect(slipNo).toBe(12);
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls[0]).toEqual(['SELECT pg_advisory_xact_lock(hashtext($1))', [SLIP_NO_LOCK_KEY]]);
  });

  test('正常系: 伝票NOは入庫・出庫の両テーブルを通した最大値 + 1（共通の連番）', async () => {
    // Arrange
    const client = buildClient('1');

    // Act
    await nextSlipNo(client);

    // Assert: トランザクション終了で解放される xact ロックを使い、両テーブルを参照する
    const sql = client.query.mock.calls[1][0];
    expect(client.query.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    expect(sql).toMatch(/GREATEST\(/);
    expect(sql).toMatch(/MAX\(slip_no\), 0\) FROM stock_ins/);
    expect(sql).toMatch(/MAX\(slip_no\), 0\) FROM stock_outs/);
    expect(sql).toMatch(/\+ 1 AS next_no/);
  });

  test('異常系: 採番結果が安全な整数の範囲を超えた場合は例外', async () => {
    // Arrange
    const client = buildClient('9007199254740993');

    // Act / Assert
    await expect(nextSlipNo(client)).rejects.toThrow('伝票NOが採番可能な上限を超えました');
  });

  test.each([[undefined], [null], [{}], [{ query: 'not function' }]])(
    '異常系: クライアント以外（%p）を渡すとプログラムの誤りとして例外',
    async (client) => {
      // Act / Assert
      await expect(nextSlipNo(client)).rejects.toThrow('nextSlipNo にはトランザクション中のクライアントを渡してください');
    }
  );
});
