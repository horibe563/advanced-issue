// API 通信の共通処理（public/js/api.js）のテスト
// fetch はモックし、送信内容（ヘッダー・クエリ）とエラーの ApiError 化を確認する
const { login, mockFetch } = require('./helpers/dom');

let api;
let consoleErrorSpy;

function loadApi() {
  jest.isolateModules(() => {
    api = require('../../public/js/api.js');
  });
}

// 中断（AbortController.abort）されるまで応答しない fetch の応答
function hang(req) {
  return new Promise((_, reject) => {
    req.signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      reject(err);
    });
  });
}

// jsdom は画面遷移に対応していないため、ログイン画面への遷移は「遷移しようとしたこと」で確認する
function navigationAttempted() {
  return consoleErrorSpy.mock.calls.some(([err]) => String(err).includes('Not implemented: navigation'));
}

// Blob の中身を文字列で読む（jsdom の Blob には text() がないため FileReader を使う）
function readBlob(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

// Promise の失敗（例外）を値として受け取る
function rejectionOf(promise) {
  return promise.then(
    () => {
      throw new Error('例外が投げられませんでした');
    },
    (err) => err
  );
}

beforeEach(() => {
  localStorage.clear();
  jest.restoreAllMocks();
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  loadApi();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('filenameFromDisposition', () => {
  test.each([
    ['attachment; filename="inventory_20261009_000405.csv"', 'inventory_20261009_000405.csv'],
    ['attachment; filename=inventory.csv', 'inventory.csv'],
    ['attachment; FILENAME = "a-b_c.1.csv"', 'a-b_c.1.csv'],
    ['attachment;filename="x.csv"; size=10', 'x.csv'],
    ['attachment; filename="x.CSV"', 'x.CSV'],
  ])('正常系: %p からファイル名 %p を取り出す', (disposition, expected) => {
    // Act
    const result = api.filenameFromDisposition(disposition);

    // Assert
    expect(result).toBe(expected);
  });

  test.each([
    ['パストラバーサル', 'attachment; filename="../x.csv"'],
    ['ディレクトリ区切り', 'attachment; filename="dir/x.csv"'],
    ['先頭が .（隠しファイル）', 'attachment; filename=".hidden"'],
    ['null', null],
    ['undefined', undefined],
    ['filename がない', 'attachment'],
    ['filename*= のみ（RFC 5987 形式は対象外）', "attachment; filename*=UTF-8''%E5%9C%A8%E5%BA%AB.csv"],
    ['空のファイル名', 'attachment; filename=""'],
    ['長すぎる（101文字）', `attachment; filename="${'a'.repeat(97)}.csv"`],
    ['日本語', 'attachment; filename="在庫.csv"'],
    ['空白を含む', 'attachment; filename="a b.csv"'],
    ['拡張子が .csv でない', 'attachment; filename="inventory.exe"'],
    ['.csv の後に別の拡張子', 'attachment; filename="a.csv.exe"'],
    ['拡張子がない', 'attachment; filename="inventory"'],
    ['.csv のみ', 'attachment; filename=".csv"'],
  ])('正常系: 不正・取得できない場合（%s）は既定の inventory.csv', (_, disposition) => {
    // Act
    const result = api.filenameFromDisposition(disposition);

    // Assert
    expect(result).toBe('inventory.csv');
  });

  test('正常系: 100文字ちょうどなら受け付ける', () => {
    // Arrange
    const name = `${'a'.repeat(96)}.csv`;

    // Act
    const result = api.filenameFromDisposition(`attachment; filename="${name}"`);

    // Assert
    expect(result).toBe(name);
  });
});

describe('apiDownload', () => {
  test('正常系: { blob, filename } を返し、トークン・Accept・クエリを付けて送る', async () => {
    // Arrange
    login();
    const requests = mockFetch({
      'GET /api/products/export': {
        status: 200,
        rawBody: 'JANコード,商品名\r\n',
        headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="inventory_20261009_000405.csv"' },
      },
    });

    // Act
    const result = await api.apiDownload('/products/export', {
      product_name: '商品 A&B',
      product_name_kana: '',
      alert: 'true',
      jan_cd: undefined,
      x: null,
    });

    // Assert
    expect(result.filename).toBe('inventory_20261009_000405.csv');
    expect(result.blob).toBeInstanceOf(Blob);
    expect(await readBlob(result.blob)).toBe('JANコード,商品名\r\n');
    expect(requests).toHaveLength(1);
    const [req] = requests;
    expect(req.method).toBe('GET');
    expect(req.headers.Authorization).toBe('Bearer test-token');
    expect(req.headers.Accept).toBe('text/csv, application/json');
    expect(req.headers).not.toHaveProperty('Content-Type');
    // 空文字・undefined・null の項目は付けない
    expect([...req.query.entries()]).toEqual([
      ['product_name', '商品 A&B'],
      ['alert', 'true'],
    ]);
  });

  test('正常系: Content-Disposition がない場合のファイル名は inventory.csv', async () => {
    // Arrange
    login();
    mockFetch({ 'GET /api/products/export': { status: 200, rawBody: 'a\r\n', headers: { 'Content-Type': 'text/csv; charset=utf-8' } } });

    // Act
    const result = await api.apiDownload('/products/export');

    // Assert
    expect(result.filename).toBe('inventory.csv');
  });

  test('正常系: Content-Type の大文字小文字・前後の空白は区別しない', async () => {
    // Arrange
    login();
    mockFetch({ 'GET /api/products/export': { status: 200, rawBody: 'a\r\n', headers: { 'Content-Type': ' Text/CSV ' } } });

    // Act
    const result = await api.apiDownload('/products/export');

    // Assert
    expect(result.filename).toBe('inventory.csv');
  });

  test.each([
    ['application/json', { 'Content-Type': 'application/json' }],
    ['text/html', { 'Content-Type': 'text/html' }],
    ['Content-Type なし', {}],
  ])('異常系: 成功ステータスだが CSV でない応答（%s）は kind parse で保存させない', async (_, headers) => {
    // Arrange
    login();
    mockFetch({ 'GET /api/products/export': { status: 200, rawBody: '{"items":[]}', headers } });

    // Act
    const err = await rejectionOf(api.apiDownload('/products/export'));

    // Assert
    expect(err).toMatchObject({ name: 'ApiError', kind: 'parse', status: 200, message: 'サーバーの応答を解釈できませんでした' });
  });

  test('異常系: res.headers がない応答も kind parse', async () => {
    // Arrange
    login();
    global.fetch = jest.fn(async () => ({ status: 200, ok: true, blob: async () => new Blob(['a']) }));

    // Act
    const err = await rejectionOf(api.apiDownload('/products/export'));

    // Assert
    expect(err.kind).toBe('parse');
  });

  test('正常系: トークンがなければ Authorization ヘッダーを付けない', async () => {
    // Arrange
    const requests = mockFetch({ 'GET /api/products/export': { status: 200, rawBody: '', headers: { 'Content-Type': 'text/csv' } } });

    // Act
    await api.apiDownload('/products/export');

    // Assert
    expect(requests[0].headers).not.toHaveProperty('Authorization');
  });

  test('異常系: 400 は API の error・details を持つ ApiError（kind http）', async () => {
    // Arrange
    login();
    mockFetch({
      'GET /api/products/export': {
        status: 400,
        body: { error: '入力内容に誤りがあります', details: [{ field: 'alert', message: 'alert は true または false で指定してください' }] },
      },
    });

    // Act
    const err = await rejectionOf(api.apiDownload('/products/export', { alert: 'x' }));

    // Assert
    expect(err).toBeInstanceOf(api.ApiError);
    expect(err).toMatchObject({
      name: 'ApiError',
      kind: 'http',
      status: 400,
      message: '入力内容に誤りがあります',
      details: [{ field: 'alert', message: 'alert は true または false で指定してください' }],
    });
    expect(localStorage.getItem('inventory.accessToken')).toBe('test-token');
  });

  test('異常系: 件数上限超過（400・details なし）は error のメッセージを使う', async () => {
    // Arrange
    login();
    mockFetch({
      'GET /api/products/export': { status: 400, body: { error: '出力件数が上限（100,000件）を超えています。条件を絞ってください' } },
    });

    // Act
    const err = await rejectionOf(api.apiDownload('/products/export'));

    // Assert
    expect(err.message).toBe('出力件数が上限（100,000件）を超えています。条件を絞ってください');
    expect(err.details).toEqual([]);
  });

  test('異常系: 401 はトークンを消してログイン画面へ遷移し、ApiError を投げる', async () => {
    // Arrange
    login();
    mockFetch({ 'GET /api/products/export': { status: 401, body: { error: '認証が必要です' } } });

    // Act
    const err = await rejectionOf(api.apiDownload('/products/export'));

    // Assert
    expect(err).toMatchObject({ kind: 'http', status: 401 });
    expect(localStorage.getItem('inventory.accessToken')).toBeNull();
    expect(localStorage.getItem('inventory.loginUser')).toBeNull();
    expect(navigationAttempted()).toBe(true);
  });

  test('異常系: JSON でないエラー本文は既定のメッセージ', async () => {
    // Arrange
    login();
    mockFetch({ 'GET /api/products/export': { status: 500, rawBody: '<html>Internal Server Error</html>' } });

    // Act
    const err = await rejectionOf(api.apiDownload('/products/export'));

    // Assert
    expect(err).toMatchObject({ kind: 'http', status: 500, message: 'サーバー内部でエラーが発生しました', details: [] });
  });

  test.each([
    [429, '他の処理が実行中です。しばらく待ってから再度お試しください'],
    [503, 'サーバーが混み合っているか、処理に時間がかかりすぎたため中断しました。時間をおいて再度お試しください'],
  ])('異常系: 本文のない %i は既定のメッセージ', async (status, message) => {
    // Arrange
    login();
    mockFetch({ 'GET /api/products/export': { status } });

    // Act
    const err = await rejectionOf(api.apiDownload('/products/export'));

    // Assert
    expect(err).toMatchObject({ kind: 'http', status, message });
  });

  test('異常系: 既定のメッセージがないステータスは HTTP ステータスを含めたメッセージ', async () => {
    // Arrange
    login();
    mockFetch({ 'GET /api/products/export': { status: 502, rawBody: '' } });

    // Act
    const err = await rejectionOf(api.apiDownload('/products/export'));

    // Assert
    expect(err.message).toBe('サーバーとの通信でエラーが発生しました（HTTP 502）');
  });

  test('異常系: ネットワークエラーは kind network・status 0', async () => {
    // Arrange
    login();
    mockFetch({
      'GET /api/products/export': () => {
        throw new TypeError('Failed to fetch');
      },
    });

    // Act
    const err = await rejectionOf(api.apiDownload('/products/export'));

    // Assert
    expect(err).toMatchObject({ kind: 'network', status: 0, message: 'サーバーに接続できません。ネットワークの状態を確認してください' });
  });

  test('異常系: タイムアウトは 60秒（15秒では打ち切らない）', async () => {
    // Arrange
    jest.useFakeTimers();
    login();
    mockFetch({ 'GET /api/products/export': hang });
    let settled = null;
    const promise = api.apiDownload('/products/export').catch((err) => err);
    promise.then((v) => {
      settled = v;
    });

    // Act
    await jest.advanceTimersByTimeAsync(15000);
    const before = settled;
    await jest.advanceTimersByTimeAsync(45000);
    const err = await promise;

    // Assert
    expect(before).toBeNull();
    expect(err).toMatchObject({ kind: 'network', message: expect.stringContaining('タイムアウト') });
  });
});

describe('apiGet / apiPost / apiDelete', () => {
  test('正常系: apiGet は JSON を返し、Accept: application/json とトークンを付ける', async () => {
    // Arrange
    login();
    const requests = mockFetch({ 'GET /api/products': { status: 200, body: { total: 0, items: [] } } });

    // Act
    const data = await api.apiGet('/products', { limit: 100, offset: 0, product_name: '' });

    // Assert
    expect(data).toEqual({ total: 0, items: [] });
    expect(requests[0].headers).toMatchObject({ Accept: 'application/json', Authorization: 'Bearer test-token' });
    expect(requests[0].query.toString()).toBe('limit=100&offset=0');
  });

  test('正常系: apiPost は本文を JSON で送る', async () => {
    // Arrange
    login();
    const requests = mockFetch({ 'POST /api/products': { status: 201, body: { jan_cd: '1' } } });

    // Act
    const data = await api.apiPost('/products', { jan_cd: '1' });

    // Assert
    expect(data).toEqual({ jan_cd: '1' });
    expect(requests[0].headers['Content-Type']).toBe('application/json');
    expect(requests[0].body).toEqual({ jan_cd: '1' });
  });

  test('正常系: apiDelete の 204 は null を返し、本文を読まない', async () => {
    // Arrange
    login();
    const text = jest.fn();
    global.fetch = jest.fn(async () => ({ status: 204, ok: true, text }));

    // Act
    const data = await api.apiDelete('/products/1', { update_seq: 0 });

    // Assert
    expect(data).toBeNull();
    expect(text).not.toHaveBeenCalled();
    expect(global.fetch.mock.calls[0][0]).toBe('/api/products/1?update_seq=0');
    expect(global.fetch.mock.calls[0][1].method).toBe('DELETE');
  });

  test('正常系: 本文が空の成功応答は null', async () => {
    // Arrange
    mockFetch({ 'GET /api/x': { status: 200 } });

    // Act
    const data = await api.apiGet('/x');

    // Assert
    expect(data).toBeNull();
  });

  test('異常系: 成功ステータスだが JSON でない本文は kind parse', async () => {
    // Arrange
    mockFetch({ 'GET /api/x': { status: 200, rawBody: '<html>' } });

    // Act
    const err = await rejectionOf(api.apiGet('/x'));

    // Assert
    expect(err).toMatchObject({ kind: 'parse', status: 200, message: 'サーバーの応答を解釈できませんでした' });
  });

  test('異常系: details が配列でない・要素が不正でも [{ field, message }] に揃える', async () => {
    // Arrange
    mockFetch({
      'GET /api/a': { status: 400, body: { error: 'e', details: 'x' } },
      'GET /api/b': { status: 400, body: { details: [null, 1, { field: 'f' }, { message: 'm' }] } },
    });

    // Act
    const errA = await rejectionOf(api.apiGet('/a'));
    const errB = await rejectionOf(api.apiGet('/b'));

    // Assert
    expect(errA.details).toEqual([]);
    expect(errB.message).toBe('入力内容に誤りがあります');
    expect(errB.details).toEqual([
      { field: 'f', message: '' },
      { field: '', message: 'm' },
    ]);
  });

  test('異常系: apiPost の redirectOn401: false では 401 でもトークンを消さない（ログイン API 用）', async () => {
    // Arrange
    login();
    mockFetch({ 'POST /api/login': { status: 401, body: { error: 'ユーザIDまたはパスワードが違います' } } });

    // Act
    const err = await rejectionOf(api.apiPost('/login', {}, { redirectOn401: false }));

    // Assert
    expect(err).toMatchObject({ status: 401, message: 'ユーザIDまたはパスワードが違います' });
    expect(localStorage.getItem('inventory.accessToken')).toBe('test-token');
    expect(navigationAttempted()).toBe(false);
  });

  test('異常系: apiGet の 401 はトークンを消してログイン画面へ遷移する', async () => {
    // Arrange
    login();
    mockFetch({ 'GET /api/products': { status: 401 } });

    // Act
    const err = await rejectionOf(api.apiGet('/products'));

    // Assert
    expect(err.message).toBe('ログインの有効期限が切れました。再度ログインしてください');
    expect(localStorage.getItem('inventory.accessToken')).toBeNull();
    expect(navigationAttempted()).toBe(true);
  });

  test('異常系: apiGet のタイムアウトは 15秒', async () => {
    // Arrange
    jest.useFakeTimers();
    mockFetch({ 'GET /api/products': hang });
    const promise = api.apiGet('/products').catch((err) => err);

    // Act
    await jest.advanceTimersByTimeAsync(15000);
    const err = await promise;

    // Assert
    expect(err).toMatchObject({
      kind: 'network',
      status: 0,
      message: 'サーバーからの応答がありません（タイムアウト）。時間をおいて再度お試しください',
    });
  });
});

describe('セッション（localStorage）', () => {
  test('正常系: saveSession / getToken / getLoginUser / clearSession', () => {
    // Act
    api.saveSession('tok', { user_id: 'u1', role: 'general' });

    // Assert
    expect(api.getToken()).toBe('tok');
    expect(api.getLoginUser()).toEqual({ user_id: 'u1', role: 'general' });
    api.clearSession();
    expect(api.getToken()).toBeNull();
    expect(api.getLoginUser()).toBeNull();
  });

  test.each([
    ['JSON でない', '{broken'],
    ['オブジェクトでない', '"text"'],
  ])('正常系: 保管しているログインユーザが%s場合は null', (_, value) => {
    // Arrange
    localStorage.setItem('inventory.loginUser', value);

    // Act / Assert
    expect(api.getLoginUser()).toBeNull();
  });

  test('正常系: localStorage が使えない環境でも例外にしない', () => {
    // Arrange
    const proto = Object.getPrototypeOf(window.localStorage);
    jest.spyOn(proto, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    jest.spyOn(proto, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    jest.spyOn(proto, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    // Act / Assert
    expect(() => api.saveSession('tok', {})).not.toThrow();
    expect(api.getToken()).toBeNull();
    expect(api.getLoginUser()).toBeNull();
    expect(() => api.clearSession()).not.toThrow();
  });
});
