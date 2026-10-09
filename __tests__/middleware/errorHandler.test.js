// src/middleware/errorHandler.js のユニットテスト
// AAA パターン（Arrange/Act/Assert）で記述する
// Express を介さず、res のモックに対してハンドラを直接呼び出す
const { notFoundHandler, errorHandler } = require('../../src/middleware/errorHandler');
const { HttpError } = require('../../src/utils/httpError');

// res.status(...).json(...) を記録するモック
function buildRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

// エラーハンドラを呼び出し、[status, body] を返す
function handle(err) {
  const res = buildRes();
  errorHandler(err, {}, res, jest.fn());
  return [res.status.mock.calls[0][0], res.json.mock.calls[0][0]];
}

// PG エラーを生成する
function pgError(code, extra = {}) {
  return Object.assign(new Error(`internal message for ${code}`), { code, ...extra });
}

let consoleErrorSpy;
let consoleWarnSpy;

beforeEach(() => {
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('notFoundHandler', () => {
  test('正常系: JSON 形式の 404 を返す', () => {
    // Arrange
    const res = buildRes();

    // Act
    notFoundHandler({}, res);

    // Assert
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'リクエストされたリソースが見つかりません' });
  });
});

describe('errorHandler', () => {
  test('正常系: HttpError はステータス・メッセージ・詳細をそのまま返す', () => {
    // Arrange
    const err = new HttpError(400, '入力内容に誤りがあります', [{ field: 'a', message: 'b' }]);

    // Act
    const [status, body] = handle(err);

    // Assert
    expect(status).toBe(400);
    expect(body).toEqual({ error: '入力内容に誤りがあります', details: [{ field: 'a', message: 'b' }] });
  });

  test('正常系: 詳細のない HttpError は details を含めない', () => {
    // Act
    const [status, body] = handle(new HttpError(409, '競合'));

    // Assert
    expect(status).toBe(409);
    expect(body).toEqual({ error: '競合' });
  });

  test('異常系: JSON パースエラーは 400', () => {
    // Act
    const [status, body] = handle(Object.assign(new Error('Unexpected token'), { type: 'entity.parse.failed', status: 400 }));

    // Assert
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'リクエストボディの JSON 形式が不正です' });
  });

  test('異常系: ボディサイズ超過は 413', () => {
    // Act
    const [status, body] = handle(Object.assign(new Error('too large'), { type: 'entity.too.large', status: 413 }));

    // Assert
    expect(status).toBe(413);
    expect(body).toEqual({ error: 'リクエストボディが大きすぎます' });
  });

  test.each([
    [{ status: 415 }, 415],
    [{ statusCode: 400 }, 400],
  ])('異常系: その他の 4xx（%p）は内部メッセージを返さず汎用メッセージにする', (props, expected) => {
    // Arrange
    const err = Object.assign(new Error('unsupported charset "FOO"'), props);

    // Act
    const [status, body] = handle(err);

    // Assert
    expect(status).toBe(expected);
    expect(body).toEqual({ error: 'リクエストが不正です' });
  });

  test.each([
    ['23505', 409, '同じキーのデータが既に存在します'],
    ['23503', 409, '関連するデータが存在しないか、参照されているため処理できません'],
    ['23514', 400, '入力値が制約を満たしていません'],
    ['23502', 400, '必須項目が指定されていません'],
    ['22001', 400, '入力値が長すぎます'],
    ['22003', 400, '数値が範囲外です'],
    ['22P02', 400, '入力値の形式が正しくありません'],
    ['22021', 400, '入力値に使用できない文字が含まれています'],
    ['22007', 400, '日付の形式が正しくありません'],
    ['22008', 400, '日付が範囲外です'],
    ['40001', 409, '同時更新が発生しました。再度実行してください'],
    ['40P01', 409, '同時更新が発生しました。再度実行してください'],
    ['57014', 503, '処理に時間がかかりすぎたため中断しました。条件を絞って再度実行してください'],
  ])('異常系: PG エラーコード %s は %i に変換する（内部情報は返さない）', (code, expectedStatus, message) => {
    // Arrange
    const err = pgError(code, { constraint: 'ck_secret_constraint', detail: 'Key (jan_cd)=(...) already exists.' });

    // Act
    const [status, body] = handle(err);

    // Assert
    expect(status).toBe(expectedStatus);
    expect(body).toEqual({ error: message });
    expect(JSON.stringify(body)).not.toContain('ck_secret_constraint');
    // 制約名などの調査情報はサーバーログにのみ残す
    expect(consoleWarnSpy).toHaveBeenCalledWith('DB 制約エラー', {
      code,
      constraint: 'ck_secret_constraint',
      detail: 'Key (jan_cd)=(...) already exists.',
    });
  });

  test.each([
    ['42P01', '存在しないテーブル'],
    ['57P01', '管理者による接続の切断'],
    ['__proto__', 'プロトタイプ名のコード'],
    ['constructor', 'プロトタイプ名のコード'],
  ])('異常系: 対応表にない PG エラーコード %s（%s）は 500', (code) => {
    // Act
    const [status, body] = handle(pgError(code));

    // Assert
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'サーバー内部でエラーが発生しました' });
  });

  test('異常系: 想定外のエラーは 500 とし、メッセージ・スタックを返さずログにのみ出力する', () => {
    // Arrange
    const err = new Error('relation "users" password_hash SELECT * FROM secret');

    // Act
    const [status, body] = handle(err);

    // Assert
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'サーバー内部でエラーが発生しました' });
    expect(JSON.stringify(body)).not.toMatch(/secret|SELECT|stack/);
    expect(consoleErrorSpy).toHaveBeenCalledWith(err);
  });

  test('異常系: ステータスが 5xx のエラーは 500 として扱う', () => {
    // Act
    const [status] = handle(Object.assign(new Error('x'), { status: 503 }));

    // Assert
    expect(status).toBe(500);
  });

  test('異常系: 文字列でないコード（数値の 23505）は PG エラーとして扱わない', () => {
    // Act
    const [status] = handle(Object.assign(new Error('x'), { code: 23505 }));

    // Assert
    expect(status).toBe(500);
  });
});
