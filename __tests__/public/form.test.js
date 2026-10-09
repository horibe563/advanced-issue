// 商品登録・入出庫登録画面（public/form.html・public/js/form.js）のテスト
// 画面共通のログイン確認（auth.js）・表示処理（ui.js）のうち、この画面で通る箇所もあわせて確認する
const { loadPage, login, mockFetch, flush, fill, submit, mockNavigation, setUrl } = require('./helpers/dom');

const ADMIN = { user_id: 'admin', user_name: '管理者', role: 'admin' };
const JAN = '4901234567894';
const JAN8 = '49012347';
const XSS = '<img src=x onerror="window.__xss=1">';

function product(overrides = {}) {
  return { jan_cd: JAN, product_name: '商品A', stock: 1200, threshold: 10, is_alert: false, ...overrides };
}

function historyItem(overrides = {}) {
  return {
    type: 'in',
    id: 1,
    slip_no: 1001,
    slip_seq: 1,
    jan_cd: JAN,
    product_name: '商品A',
    date: '2026-10-09',
    quantity: 10,
    slip_flag: 1,
    stock_delta: 10,
    ...overrides,
  };
}

// 一覧 API の応答
function list(items, { total = items.length, limit = 100 } = {}) {
  return { status: 200, body: { total, count: items.length, limit, offset: 0, items } };
}

// 商品登録 API の応答
function createdProduct(overrides = {}) {
  return { status: 201, body: { ...product({ stock: 0, threshold: 0 }), initial_slip_no: null, ...overrides } };
}

// 入出庫登録 API の応答
function createdSlip(overrides = {}, productOverrides = {}) {
  return {
    status: 201,
    body: {
      ...historyItem({ slip_no: 1002 }),
      ...overrides,
      product: { jan_cd: JAN, product_name: '商品A', stock: 1210, threshold: 10, is_alert: false, ...productOverrides },
    },
  };
}

let requests;
let navigations;
let els;
let consoleErrorSpy;
// 画面のスクリプトが window / document に登録したイベントリスナー（テストごとに外す）
let addedListeners;

// window / document への addEventListener を記録する
function recordListeners() {
  addedListeners = [];
  for (const target of [window, document]) {
    const original = target.addEventListener;
    jest.spyOn(target, 'addEventListener').mockImplementation(function addEventListener(type, listener, options) {
      addedListeners.push({ target, type, listener, options });
      return original.call(this, type, listener, options);
    });
  }
}

// 画面を読み込んでスクリプトを実行する
async function openPage({ url = '/form.html', routes = {}, user = ADMIN, loggedIn = true } = {}) {
  setUrl(url);
  loadPage('form.html');
  if (loggedIn) login(user);
  navigations = mockNavigation();
  requests = mockFetch({
    'GET /api/validatetoken': { status: 200, body: { valid: true, user } },
    'GET /api/products': list([product(), product({ jan_cd: JAN8, product_name: '商品B', stock: 3, threshold: 1500, is_alert: true })]),
    'GET /api/stockinout': list([historyItem(), historyItem({ type: 'out', slip_no: 1000, slip_seq: 2, slip_flag: 2, quantity: 5, stock_delta: 5 })], { limit: 20 }),
    'POST /api/products': createdProduct(),
    'POST /api/stockinout': createdSlip(),
    'POST /api/logout': { status: 204 },
    ...routes,
  });
  recordListeners();
  jest.isolateModules(() => {
    require('../../public/js/form.js');
  });
  await flush();
  els = {
    message: document.getElementById('page-message'),
    headerUser: document.getElementById('header-user'),
    productForm: document.getElementById('product-form'),
    productSubmit: document.getElementById('product-submit'),
    stockForm: document.getElementById('stock-form'),
    stockSubmit: document.getElementById('stock-submit'),
    correctionNote: document.getElementById('correction-note'),
    dateLabelNote: document.getElementById('s-date-label-note'),
    janList: document.getElementById('jan-list'),
    miniStockBody: document.getElementById('mini-stock-body'),
    miniStockSummary: document.getElementById('mini-stock-summary'),
    miniStockReload: document.getElementById('mini-stock-reload'),
    recentBody: document.getElementById('recent-body'),
    recentSummary: document.getElementById('recent-summary'),
    recentReload: document.getElementById('recent-reload'),
  };
}

// 指定したパスへのリクエストのみ
function requestsTo(path, method = 'GET') {
  return requests.filter((r) => r.path === path && r.method === method);
}

function cellTexts(tr) {
  return [...tr.querySelectorAll('td')].map((td) => td.textContent);
}

function fieldError(form, name) {
  return form.querySelector(`[data-error-for="${name}"]`);
}

function messageItems() {
  return [...els.message.querySelectorAll('li')].map((li) => li.textContent);
}

// 入出庫登録の種別（新規 / 訂正）を切り替える
function selectMode(mode) {
  const radio = els.stockForm.querySelector(`input[name="mode"][value="${mode}"]`);
  radio.checked = true;
  radio.dispatchEvent(new window.Event('change', { bubbles: true }));
}

// 入出庫登録の新規伝票を送信する
async function submitNewSlip(values = {}) {
  fill(els.stockForm, { type: 'in', jan_cd: JAN, quantity: '10', date: '2026-10-09', ...values });
  submit(els.stockForm);
  await flush();
}

// 訂正伝票を送信する
async function submitCorrection(values = {}) {
  selectMode('correction');
  fill(els.stockForm, { type: 'in', slip_no: '1001', quantity: '1', slip_flag: '2', date: '', ...values });
  submit(els.stockForm);
  await flush();
}

// 応答を手動で返すハンドラ（送信中の状態を確認する）
function deferred() {
  const d = {};
  d.handler = () =>
    new Promise((resolve) => {
      d.respond = resolve;
    });
  return d;
}

beforeEach(() => {
  localStorage.clear();
  jest.restoreAllMocks();
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  delete window.__xss;
});

afterEach(() => {
  for (const { target, type, listener, options } of addedListeners ?? []) {
    target.removeEventListener(type, listener, options);
  }
  addedListeners = [];
  jest.useRealTimers();
  setUrl('/');
});

describe('ログイン確認（auth.js）', () => {
  test('異常系：トークンがない場合は API を呼ばずにログイン画面へ遷移する（戻り先を next に付ける）', async () => {
    // Arrange・Act
    await openPage({ url: '/form.html?jan_cd=4901234567894', loggedIn: false });

    // Assert
    expect(navigations[0]).toBe(`/login.html?next=${encodeURIComponent('/form.html?jan_cd=4901234567894')}`);
    expect(requestsTo('/api/validatetoken')).toHaveLength(0);
    expect(els.headerUser.hidden).toBe(true);
  });

  test('正常系：ヘッダーにログインユーザ名を表示し、ログアウトでトークンを無効化してログイン画面へ遷移する', async () => {
    // Arrange
    await openPage();
    expect(els.headerUser.hidden).toBe(false);
    expect(els.headerUser.querySelector('.header-user-name').textContent).toBe('管理者 さん');

    // Act
    els.headerUser.querySelector('button').click();
    await flush();

    // Assert
    expect(requestsTo('/api/logout', 'POST')).toHaveLength(1);
    expect(requestsTo('/api/logout', 'POST')[0].headers.Authorization).toBe('Bearer test-token');
    expect(localStorage.getItem('inventory.accessToken')).toBeNull();
    expect(localStorage.getItem('inventory.loginUser')).toBeNull();
    expect(navigations).toEqual(['/login.html']);
  });

  test('異常系：ログアウト API が失敗しても手元のトークンを消してログイン画面へ遷移する', async () => {
    // Arrange
    await openPage({
      routes: {
        'POST /api/logout': () => {
          throw new TypeError('Failed to fetch');
        },
      },
    });

    // Act
    els.headerUser.querySelector('button').click();
    await flush();

    // Assert
    expect(localStorage.getItem('inventory.accessToken')).toBeNull();
    expect(navigations).toEqual(['/login.html']);
  });

  test('正常系：ユーザ名がない場合はユーザIDを表示する', async () => {
    // Arrange・Act
    const user = { user_id: 'u1', role: 'general' };
    await openPage({ user });

    // Assert
    expect(els.headerUser.querySelector('.header-user-name').textContent).toBe('u1 さん');
  });
});

describe('初期表示', () => {
  test('正常系：簡易在庫一覧と直近の入出庫履歴を件数を指定して取得し、表示する', async () => {
    // Arrange・Act
    await openPage();

    // Assert
    expect(requestsTo('/api/products')).toHaveLength(1);
    expect(requestsTo('/api/products')[0].query.get('limit')).toBe('100');
    expect(requestsTo('/api/stockinout')).toHaveLength(1);
    expect(requestsTo('/api/stockinout')[0].query.get('limit')).toBe('20');

    const stockRows = els.miniStockBody.querySelectorAll('tr');
    expect(stockRows).toHaveLength(2);
    expect(cellTexts(stockRows[0])).toEqual(['正常', JAN, '商品A', '1,200', '10']);
    expect(stockRows[0].className).toBe('');
    expect(cellTexts(stockRows[1])).toEqual(['在庫不足', JAN8, '商品B', '3', '1,500']);
    expect(stockRows[1].className).toBe('row-alert');
    expect(els.miniStockSummary.textContent).toBe('全 2 件');

    const recentRows = els.recentBody.querySelectorAll('tr');
    expect(recentRows).toHaveLength(2);
    expect(cellTexts(recentRows[0])).toEqual(['2026-10-09', '入庫', '1001', '1', JAN, '商品A', '1：正', '10', '+10']);
    expect(recentRows[0].className).toBe('');
    expect(cellTexts(recentRows[1])).toEqual(['2026-10-09', '出庫', '1000', '2', JAN, '商品A', '2：負（訂正）', '5', '+5']);
    expect(recentRows[1].className).toBe('row-correction');
    expect(els.recentSummary.textContent).toBe('新しい順に 2 件（全 2 件）');
  });

  test('正常系：在庫への影響がマイナスの行は delta-minus で表示する', async () => {
    // Arrange・Act
    await openPage({
      routes: { 'GET /api/stockinout': list([historyItem({ type: 'out', quantity: 3, stock_delta: -3 })]) },
    });

    // Assert
    const delta = els.recentBody.querySelector('tr td:last-child');
    expect(delta.textContent).toBe('-3');
    expect(delta.className).toBe('num delta-minus');
  });

  test('正常系：JAN の入力候補（datalist）に商品の JAN と商品名を設定する', async () => {
    // Arrange・Act
    await openPage();

    // Assert
    const options = [...els.janList.querySelectorAll('option')];
    expect(options.map((o) => [o.value, o.label])).toEqual([
      [JAN, '商品A'],
      [JAN8, '商品B'],
    ]);
  });

  test('正常系：商品が表示件数より多い場合は、一部のみ表示している旨を表示する', async () => {
    // Arrange・Act
    await openPage({ routes: { 'GET /api/products': list([product()], { total: 1500 }) } });

    // Assert
    expect(els.miniStockSummary.textContent).toBe(
      '全 1,500 件のうち JAN 順に 1 件を表示（すべては在庫状況画面で確認できます）'
    );
  });

  test('正常系：データがない場合は空の案内を表示する', async () => {
    // Arrange・Act
    await openPage({ routes: { 'GET /api/products': list([]), 'GET /api/stockinout': list([]) } });

    // Assert
    expect(els.miniStockBody.textContent).toBe('商品はまだ登録されていません');
    expect(els.miniStockBody.querySelector('td').getAttribute('colspan')).toBe('5');
    expect(els.miniStockSummary.textContent).toBe('全 0 件');
    expect(els.recentBody.textContent).toBe('入出庫履歴はまだありません');
    expect(els.recentBody.querySelector('td').getAttribute('colspan')).toBe('9');
    expect(els.recentSummary.textContent).toBe('新しい順に 0 件（全 0 件）');
  });

  test('正常系：XSS を含む文字列はタグとして解釈せず文字列のまま表示する', async () => {
    // Arrange・Act
    await openPage({
      routes: {
        'GET /api/products': list([product({ product_name: XSS })]),
        'GET /api/stockinout': list([historyItem({ product_name: XSS })]),
      },
    });

    // Assert
    expect(els.miniStockBody.querySelector('img')).toBeNull();
    expect(els.recentBody.querySelector('img')).toBeNull();
    expect(cellTexts(els.miniStockBody.querySelector('tr'))[2]).toBe(XSS);
    expect(cellTexts(els.recentBody.querySelector('tr'))[5]).toBe(XSS);
    expect(els.janList.querySelector('option').label).toBe(XSS);
    expect(window.__xss).toBeUndefined();
  });

  test('正常系：日付の初期値は当日、入出庫は新規伝票のモードで表示する', async () => {
    // Arrange
    jest.useFakeTimers({ doNotFake: ['setTimeout', 'setInterval', 'setImmediate', 'nextTick', 'queueMicrotask'] });
    jest.setSystemTime(new Date(2026, 0, 5, 9, 0, 0));

    // Act
    await openPage();

    // Assert
    const date = els.stockForm.elements.namedItem('date');
    expect(date.value).toBe('2026-01-05');
    expect(date.defaultValue).toBe('2026-01-05');
    expect(els.stockForm.querySelector('[data-mode="new"]').hidden).toBe(false);
    expect(els.stockForm.querySelectorAll('[data-mode="correction"]:not([hidden])')).toHaveLength(0);
    expect(els.correctionNote.hidden).toBe(true);
    expect(els.dateLabelNote.textContent).toBe('省略時は当日');
  });

  test('正常系：?jan_cd= が JAN の形式なら入出庫の JAN 欄に入れ、数量欄にフォーカスする', async () => {
    // Arrange・Act
    await openPage({ url: `/form.html?jan_cd=${JAN8}` });

    // Assert
    expect(els.stockForm.elements.namedItem('jan_cd').value).toBe(JAN8);
    expect(document.activeElement).toBe(els.stockForm.elements.namedItem('quantity'));
    // 商品登録の JAN 欄には入れない
    expect(els.productForm.elements.namedItem('jan_cd').value).toBe('');
  });

  test.each([['123'], ['49012345678941'], ['abcdefgh'], [encodeURIComponent(XSS)]])(
    '異常系：?jan_cd=%s のように JAN の形式でない値は入れない',
    async (value) => {
      // Arrange・Act
      await openPage({ url: `/form.html?jan_cd=${value}` });

      // Assert
      expect(els.stockForm.elements.namedItem('jan_cd').value).toBe('');
    }
  );

  test('異常系：一覧の取得に失敗した場合は、取得できなかった旨と API のエラーを表示する', async () => {
    // Arrange・Act
    await openPage({
      routes: {
        'GET /api/products': { status: 500, body: { error: 'サーバー内部でエラーが発生しました' } },
        'GET /api/stockinout': { status: 500, body: { error: 'サーバー内部でエラーが発生しました' } },
      },
    });

    // Assert
    expect(els.miniStockSummary.textContent).toBe('在庫状況を取得できませんでした');
    expect(els.recentSummary.textContent).toBe('入出庫履歴を取得できませんでした');
    expect(els.message.hidden).toBe(false);
    expect(els.message.textContent).toBe('サーバー内部でエラーが発生しました（HTTP 500）');
  });

  test('異常系：通信エラーの場合は接続できない旨を表示する', async () => {
    // Arrange・Act
    await openPage({
      routes: {
        'GET /api/stockinout': () => {
          throw new TypeError('Failed to fetch');
        },
      },
    });

    // Assert
    expect(els.recentSummary.textContent).toBe('入出庫履歴を取得できませんでした');
    expect(els.message.textContent).toBe('サーバーに接続できません。ネットワークの状態を確認してください');
    // 在庫一覧は表示できている
    expect(els.miniStockBody.querySelectorAll('tr')).toHaveLength(2);
  });

  test('異常系：成功ステータスで JSON でない応答の場合は解釈できない旨を表示する', async () => {
    // Arrange・Act
    await openPage({ routes: { 'GET /api/products': { status: 200, rawBody: '<html>' } } });

    // Assert
    expect(els.miniStockSummary.textContent).toBe('在庫状況を取得できませんでした');
    expect(els.message.textContent).toBe('サーバーの応答を解釈できませんでした');
  });
});

describe('一覧の再読み込み', () => {
  test('正常系：再読み込みボタンでそれぞれの一覧だけを取り直す', async () => {
    // Arrange
    await openPage();

    // Act
    els.miniStockReload.click();
    await flush();

    // Assert
    expect(requestsTo('/api/products')).toHaveLength(2);
    expect(requestsTo('/api/stockinout')).toHaveLength(1);

    // Act
    els.recentReload.click();
    await flush();

    // Assert
    expect(requestsTo('/api/products')).toHaveLength(2);
    expect(requestsTo('/api/stockinout')).toHaveLength(2);
  });

  test('正常系：取得中は「読み込み中…」を表示する', async () => {
    // Arrange
    await openPage();
    const pending = deferred();
    requests = mockFetch({ 'GET /api/products': pending.handler });

    // Act
    els.miniStockReload.click();
    await flush();

    // Assert
    expect(els.miniStockSummary.textContent).toBe('読み込み中…');
    pending.respond(list([product()]));
    await flush();
    expect(els.miniStockSummary.textContent).toBe('全 1 件');
  });

  test('正常系：取得が重なった場合は古い応答で新しい表示を上書きしない', async () => {
    // Arrange
    await openPage();
    const first = deferred();
    const second = deferred();
    const handlers = [first, second];
    mockFetch({ 'GET /api/products': (req) => handlers.shift().handler(req) });
    els.miniStockReload.click();
    els.miniStockReload.click();
    await flush();

    // Act（新しい応答が先に、古い応答が後に返る）
    second.respond(list([product({ product_name: '新しい応答' })]));
    await flush();
    first.respond(list([product({ product_name: '古い応答' })]));
    await flush();

    // Assert
    expect(cellTexts(els.miniStockBody.querySelector('tr'))[2]).toBe('新しい応答');
  });

  test('正常系：取得が重なった場合は古い取得の失敗も表示しない', async () => {
    // Arrange
    await openPage();
    const first = deferred();
    const second = deferred();
    const handlers = [first, second];
    mockFetch({ 'GET /api/stockinout': (req) => handlers.shift().handler(req) });
    els.recentReload.click();
    els.recentReload.click();
    await flush();

    // Act
    second.respond(list([historyItem()]));
    await flush();
    first.respond({ status: 500, body: { error: '古いエラー' } });
    await flush();

    // Assert
    expect(els.recentSummary.textContent).toBe('新しい順に 1 件（全 1 件）');
    expect(els.message.hidden).toBe(true);
  });

  test('正常系：古い在庫一覧の取得の失敗も表示しない', async () => {
    // Arrange
    await openPage();
    const first = deferred();
    const second = deferred();
    const handlers = [first, second];
    mockFetch({ 'GET /api/products': (req) => handlers.shift().handler(req) });
    els.miniStockReload.click();
    els.miniStockReload.click();
    await flush();

    // Act
    second.respond(list([product()]));
    await flush();
    first.respond({ status: 500, body: { error: '古いエラー' } });
    await flush();

    // Assert
    expect(els.miniStockSummary.textContent).toBe('全 1 件');
    expect(els.message.hidden).toBe(true);
  });
});

describe('画面に戻ったときの自動更新（ui.js の onPageReactivate）', () => {
  let now;

  beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  test('正常系：フォーカスが戻ったときは一覧を取り直す', async () => {
    // Arrange
    await openPage();
    now += 1000;

    // Act
    window.dispatchEvent(new window.Event('focus'));
    await flush();

    // Assert
    expect(requestsTo('/api/products')).toHaveLength(2);
    expect(requestsTo('/api/stockinout')).toHaveLength(2);
  });

  test('正常系：読み込み直後や短時間に続けて発生したときは取り直さない', async () => {
    // Arrange
    await openPage();

    // Act（読み込み直後）
    window.dispatchEvent(new window.Event('focus'));
    await flush();

    // Assert
    expect(requestsTo('/api/products')).toHaveLength(1);

    // Act（focus と visibilitychange が続けて発生）
    now += 1500;
    window.dispatchEvent(new window.Event('focus'));
    document.dispatchEvent(new window.Event('visibilitychange'));
    await flush();

    // Assert
    expect(requestsTo('/api/products')).toHaveLength(2);
  });

  test('正常系：タブが表示状態に戻ったとき（visibilitychange）は一覧を取り直す', async () => {
    // Arrange
    await openPage();
    now += 1000;

    // Act
    document.dispatchEvent(new window.Event('visibilitychange'));
    await flush();

    // Assert
    expect(document.visibilityState).toBe('visible');
    expect(requestsTo('/api/products')).toHaveLength(2);
  });

  test('正常系：タブが非表示になったとき（visibilitychange）は取り直さない', async () => {
    // Arrange
    await openPage();
    now += 1000;
    jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

    // Act
    document.dispatchEvent(new window.Event('visibilitychange'));
    await flush();

    // Assert
    expect(requestsTo('/api/products')).toHaveLength(1);
  });

  test('正常系：ブラウザの「戻る」でキャッシュから復元されたとき（pageshow の persisted）は一覧を取り直す', async () => {
    // Arrange
    await openPage();
    now += 1000;

    // Act（通常の表示では取り直さない）
    window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: false }));
    await flush();

    // Assert
    expect(requestsTo('/api/products')).toHaveLength(1);

    // Act（キャッシュからの復元）
    window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: true }));
    await flush();

    // Assert
    expect(requestsTo('/api/products')).toHaveLength(2);
    expect(requestsTo('/api/stockinout')).toHaveLength(2);
  });
});

describe('商品登録', () => {
  test('正常系：入力した項目だけを送り（数値は number）、成功メッセージを表示して一覧を更新する', async () => {
    // Arrange
    await openPage();
    fill(els.productForm, {
      jan_cd: ` ${JAN} `,
      product_name: '商品A',
      product_spec: '',
      product_name_kana: '   ',
      generic_item1: '汎用1',
      stock: '',
      threshold: '5',
    });

    // Act
    submit(els.productForm);
    await flush();

    // Assert
    const posts = requestsTo('/api/products', 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ jan_cd: JAN, product_name: '商品A', generic_item1: '汎用1', threshold: 5 });
    expect(posts[0].headers['Content-Type']).toBe('application/json');
    expect(els.message.className).toBe('message message-success');
    expect(els.message.querySelector('p').textContent).toBe(`商品「商品A」（JAN: ${JAN}）を登録しました`);
    expect(messageItems()).toEqual([]);
    // 入力をクリアし、続けて登録できるよう JAN 欄にフォーカスする
    expect(els.productForm.elements.namedItem('jan_cd').value).toBe('');
    expect(els.productForm.elements.namedItem('threshold').value).toBe('');
    expect(document.activeElement).toBe(els.productForm.elements.namedItem('jan_cd'));
    // 一覧を自動で更新する
    expect(requestsTo('/api/products')).toHaveLength(2);
    expect(requestsTo('/api/stockinout')).toHaveLength(2);
    expect(els.productSubmit.disabled).toBe(false);
  });

  test('正常系：初期在庫を指定した場合は、初期入庫伝票と在庫不足の案内を添える', async () => {
    // Arrange
    await openPage({
      routes: { 'POST /api/products': createdProduct({ stock: 1500, threshold: 2000, is_alert: true, initial_slip_no: 1003 }) },
    });
    fill(els.productForm, { jan_cd: JAN, product_name: '商品A', stock: '1500', threshold: '2000' });

    // Act
    submit(els.productForm);
    await flush();

    // Assert
    expect(requestsTo('/api/products', 'POST')[0].body).toEqual({
      jan_cd: JAN,
      product_name: '商品A',
      stock: 1500,
      threshold: 2000,
    });
    expect(messageItems()).toEqual([
      '初期入庫伝票（伝票NO: 1003、数量: 1,500）を作成しました',
      '在庫数が閾値を下回っているため、在庫状況では「在庫不足」と表示されます',
    ]);
  });

  test('正常系：成功メッセージの商品名は XSS を含んでも文字列のまま表示する', async () => {
    // Arrange
    await openPage({ routes: { 'POST /api/products': createdProduct({ product_name: XSS }) } });
    fill(els.productForm, { jan_cd: JAN, product_name: XSS });

    // Act
    submit(els.productForm);
    await flush();

    // Assert
    expect(els.message.querySelector('img')).toBeNull();
    expect(els.message.textContent).toContain(XSS);
    expect(window.__xss).toBeUndefined();
  });

  test('正常系：送信中はボタンを無効にして「登録中…」と表示し、応答後に戻す', async () => {
    // Arrange
    const pending = deferred();
    await openPage({ routes: { 'POST /api/products': pending.handler } });
    fill(els.productForm, { jan_cd: JAN, product_name: '商品A' });

    // Act
    submit(els.productForm);
    await flush();

    // Assert（応答待ち）
    expect(els.productSubmit.disabled).toBe(true);
    expect(els.productSubmit.textContent).toBe('登録中…');
    expect(els.productSubmit.getAttribute('aria-busy')).toBe('true');

    // Act（応答）
    pending.respond(createdProduct());
    await flush();

    // Assert（応答後）
    expect(els.productSubmit.disabled).toBe(false);
    expect(els.productSubmit.textContent).toBe('商品を登録');
    expect(els.productSubmit.hasAttribute('aria-busy')).toBe(false);
  });

  test('異常系：400 の項目別エラーは各欄に表示し、欄がない項目は画面上部に表示する', async () => {
    // Arrange
    await openPage({
      routes: {
        'POST /api/products': {
          status: 400,
          body: {
            error: '入力内容に誤りがあります',
            details: [
              { field: 'jan_cd', message: 'JAN コードのチェックデジットが正しくありません' },
              { field: 'threshold', message: '0 以上の整数を指定してください' },
              { field: 'unknown', message: '不明な項目です' },
              { message: '項目のないエラー' },
            ],
          },
        },
      },
    });
    fill(els.productForm, { jan_cd: '4901234567890', product_name: '商品A', threshold: '1.5' });

    // Act
    submit(els.productForm);
    await flush();

    // Assert
    const jan = els.productForm.elements.namedItem('jan_cd');
    expect(jan.classList.contains('is-invalid')).toBe(true);
    expect(jan.getAttribute('aria-invalid')).toBe('true');
    expect(fieldError(els.productForm, 'jan_cd').hidden).toBe(false);
    expect(fieldError(els.productForm, 'jan_cd').textContent).toBe('JAN コードのチェックデジットが正しくありません');
    expect(fieldError(els.productForm, 'threshold').textContent).toBe('0 以上の整数を指定してください');
    expect(document.activeElement).toBe(jan);
    expect(els.message.querySelector('p').textContent).toBe('入力内容に誤りがあります（強調表示した項目を確認してください）');
    expect(messageItems()).toEqual(['unknown: 不明な項目です', '項目のないエラー']);
    // 入力値は残す
    expect(jan.value).toBe('4901234567890');
    expect(els.productSubmit.disabled).toBe(false);
    // 一覧は更新しない
    expect(requestsTo('/api/products')).toHaveLength(1);
  });

  test('異常系：400 で欄に対応する項目がない場合は、強調表示の案内を付けずに表示する', async () => {
    // Arrange
    await openPage({
      routes: { 'POST /api/products': { status: 400, body: { error: '不正なリクエストです', details: [] } } },
    });
    fill(els.productForm, { jan_cd: JAN, product_name: '商品A' });

    // Act
    submit(els.productForm);
    await flush();

    // Assert
    expect(els.message.querySelector('p').textContent).toBe('不正なリクエストです');
    expect(messageItems()).toEqual([]);
  });

  test('異常系：409（JAN の重複）は API のメッセージを表示する', async () => {
    // Arrange
    await openPage({
      routes: { 'POST /api/products': { status: 409, body: { error: 'この JAN コードの商品は既に登録されています' } } },
    });
    fill(els.productForm, { jan_cd: JAN, product_name: '商品A' });

    // Act
    submit(els.productForm);
    await flush();

    // Assert
    expect(els.message.className).toBe('message message-error');
    expect(els.message.textContent).toBe('この JAN コードの商品は既に登録されています（HTTP 409）');
    // 入力値は残し、一覧は更新しない
    expect(els.productForm.elements.namedItem('jan_cd').value).toBe(JAN);
    expect(requestsTo('/api/products')).toHaveLength(1);
  });

  test('異常系：数値欄に数値として読めない値がある場合は送信せず欄にエラーを表示する', async () => {
    // Arrange
    await openPage();
    fill(els.productForm, { jan_cd: JAN, product_name: '商品A' });
    // ブラウザは type="number" の欄に数値として読めない文字があると value を空にし validity.badInput を立てる
    Object.defineProperty(els.productForm.elements.namedItem('stock'), 'validity', { value: { badInput: true } });
    // Infinity のように有限でない値
    Object.defineProperty(els.productForm.elements.namedItem('threshold'), 'value', { value: '1e999' });

    // Act
    submit(els.productForm);
    await flush();

    // Assert
    expect(requestsTo('/api/products', 'POST')).toHaveLength(0);
    expect(fieldError(els.productForm, 'stock').textContent).toBe('数値を入力してください');
    expect(fieldError(els.productForm, 'threshold').textContent).toBe('数値を入力してください');
    expect(els.message.querySelector('p').textContent).toBe(
      '入力内容に誤りがあります（強調表示した項目を確認してください）'
    );
    expect(messageItems()).toEqual([]);
    expect(document.activeElement).toBe(els.productForm.elements.namedItem('stock'));
  });

  test('異常系：通信エラーの場合は接続できない旨を表示し、入力値を残す', async () => {
    // Arrange
    await openPage({
      routes: {
        'POST /api/products': () => {
          throw new TypeError('Failed to fetch');
        },
      },
    });
    fill(els.productForm, { jan_cd: JAN, product_name: '商品A' });

    // Act
    submit(els.productForm);
    await flush();

    // Assert
    expect(els.message.textContent).toBe('サーバーに接続できません。ネットワークの状態を確認してください');
    expect(els.productForm.elements.namedItem('product_name').value).toBe('商品A');
    expect(els.productSubmit.disabled).toBe(false);
  });

  test('異常系：想定外の応答（本文なし）で画面側の処理が失敗した場合は、内部情報を出さず汎用メッセージを表示する', async () => {
    // Arrange
    await openPage({ routes: { 'POST /api/products': { status: 201 } } });
    fill(els.productForm, { jan_cd: JAN, product_name: '商品A' });

    // Act
    submit(els.productForm);
    await flush();

    // Assert
    expect(els.message.textContent).toBe('予期しないエラーが発生しました。画面を再読み込みしてください');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.any(TypeError));
    expect(els.productSubmit.disabled).toBe(false);
  });

  test('正常系：前回のエラー表示は再送信時と「入力をクリア」で消す', async () => {
    // Arrange
    await openPage({
      routes: {
        'POST /api/products': {
          status: 400,
          body: { error: '入力内容に誤りがあります', details: [{ field: 'product_name', message: '必須です' }] },
        },
      },
    });
    submit(els.productForm);
    await flush();
    expect(fieldError(els.productForm, 'product_name').hidden).toBe(false);

    // Act
    els.productForm.reset();

    // Assert
    expect(fieldError(els.productForm, 'product_name').hidden).toBe(true);
    expect(fieldError(els.productForm, 'product_name').textContent).toBe('');
    expect(els.productForm.elements.namedItem('product_name').classList.contains('is-invalid')).toBe(false);
  });

  test('異常系：401 のときはトークンを消してログイン画面へ遷移する', async () => {
    // Arrange
    await openPage({ routes: { 'POST /api/products': { status: 401, body: { error: 'ログインが必要です' } } } });
    fill(els.productForm, { jan_cd: JAN, product_name: '商品A' });

    // Act
    submit(els.productForm);
    await flush();

    // Assert
    expect(localStorage.getItem('inventory.accessToken')).toBeNull();
    expect(navigations).toEqual([`/login.html?next=${encodeURIComponent('/form.html')}`]);
  });
});

describe('入出庫登録：モードの切り替え', () => {
  test('正常系：訂正伝票に切り替えると伝票NO・伝票フラグを表示し、JAN を隠す', async () => {
    // Arrange
    await openPage();

    // Act
    selectMode('correction');

    // Assert
    expect(els.stockForm.querySelector('[data-mode="new"]').hidden).toBe(true);
    for (const el of els.stockForm.querySelectorAll('[data-mode="correction"]')) {
      expect(el.hidden).toBe(false);
    }
    expect(els.correctionNote.hidden).toBe(false);
    expect(els.dateLabelNote.textContent).toBe('任意（省略時は当日）');

    // Act（新規伝票に戻す）
    selectMode('new');

    // Assert
    expect(els.stockForm.querySelector('[data-mode="new"]').hidden).toBe(false);
    expect(els.correctionNote.hidden).toBe(true);
    expect(els.dateLabelNote.textContent).toBe('省略時は当日');
  });

  test('正常系：切り替え時に前のモードの項目別エラーを消す', async () => {
    // Arrange
    await openPage({
      routes: {
        'POST /api/stockinout': { status: 400, body: { error: '入力内容に誤りがあります', details: [{ field: 'quantity', message: '必須です' }] } },
      },
    });
    await submitNewSlip({ quantity: '' });
    expect(fieldError(els.stockForm, 'quantity').hidden).toBe(false);

    // Act
    selectMode('correction');

    // Assert
    expect(fieldError(els.stockForm, 'quantity').hidden).toBe(true);
  });

  test('正常系：モード以外の欄の変更では表示を切り替えない', async () => {
    // Arrange
    await openPage();
    selectMode('correction');

    // Act
    const type = els.stockForm.elements.namedItem('type');
    type.value = 'out';
    type.dispatchEvent(new window.Event('change', { bubbles: true }));

    // Assert
    expect(els.correctionNote.hidden).toBe(false);
  });

  test('正常系：「入力をクリア」で新規伝票のモードと当日の日付に戻る', async () => {
    // Arrange
    await openPage();
    const date = els.stockForm.elements.namedItem('date');
    const today = date.value;
    selectMode('correction');
    date.value = '2026-01-01';

    // Act
    els.stockForm.reset();
    await flush();

    // Assert
    expect(els.stockForm.elements.namedItem('mode').value).toBe('new');
    expect(els.stockForm.querySelector('[data-mode="new"]').hidden).toBe(false);
    expect(els.correctionNote.hidden).toBe(true);
    expect(date.value).toBe(today);
  });
});

describe('入出庫登録：新規伝票', () => {
  test('正常系：新規伝票の項目だけを送り（数量は number）、成功メッセージを表示して一覧を更新する', async () => {
    // Arrange
    await openPage();
    // 訂正用の欄に値が残っていても送らない
    fill(els.stockForm, { slip_no: '999', slip_flag: '2' });

    // Act
    await submitNewSlip({ jan_cd: ` ${JAN} ` });

    // Assert
    const posts = requestsTo('/api/stockinout', 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ type: 'in', jan_cd: JAN, date: '2026-10-09', quantity: 10 });
    expect(els.message.className).toBe('message message-success');
    expect(els.message.querySelector('p').textContent).toBe('入庫伝票を登録しました（伝票NO: 1002）');
    expect(messageItems()).toEqual([`商品A（JAN: ${JAN}）の在庫数: 1,210（+10）`]);
    // 続けて登録できるよう、数量だけ消して種別・JAN・日付は残す
    expect(els.stockForm.elements.namedItem('quantity').value).toBe('');
    expect(els.stockForm.elements.namedItem('jan_cd').value).toBe(` ${JAN} `);
    expect(els.stockForm.elements.namedItem('date').value).toBe('2026-10-09');
    // 一覧を自動で更新する
    expect(requestsTo('/api/products')).toHaveLength(2);
    expect(requestsTo('/api/stockinout')).toHaveLength(2);
    expect(els.stockSubmit.disabled).toBe(false);
  });

  test('正常系：日付が空欄の場合は送らない（API 側で当日になる）', async () => {
    // Arrange
    await openPage();

    // Act
    await submitNewSlip({ type: 'out', date: '' });

    // Assert
    expect(requestsTo('/api/stockinout', 'POST')[0].body).toEqual({ type: 'out', jan_cd: JAN, quantity: 10 });
  });

  test('正常系：登録後の在庫数が閾値を下回った場合は警告として表示する', async () => {
    // Arrange
    await openPage({
      routes: {
        'POST /api/stockinout': createdSlip(
          { type: 'out', stock_delta: -1200, quantity: 1200 },
          { stock: 0, threshold: 1500, is_alert: true }
        ),
      },
    });

    // Act
    await submitNewSlip({ type: 'out', quantity: '1200' });

    // Assert
    expect(els.message.className).toBe('message message-warning');
    expect(els.message.querySelector('p').textContent).toBe('出庫伝票を登録しました（伝票NO: 1002）');
    expect(messageItems()).toEqual([`商品A（JAN: ${JAN}）の在庫数: 0（-1,200）`, '在庫数が閾値（1,500）を下回っています']);
  });

  test('正常系：成功メッセージの商品名は XSS を含んでも文字列のまま表示する', async () => {
    // Arrange
    await openPage({ routes: { 'POST /api/stockinout': createdSlip({}, { product_name: XSS }) } });

    // Act
    await submitNewSlip();

    // Assert
    expect(els.message.querySelector('img')).toBeNull();
    expect(messageItems()[0]).toContain(XSS);
    expect(window.__xss).toBeUndefined();
  });

  test('正常系：送信中はボタンを無効にして「登録中…」と表示し、応答後に戻す', async () => {
    // Arrange
    const pending = deferred();
    await openPage({ routes: { 'POST /api/stockinout': pending.handler } });

    // Act
    await submitNewSlip();

    // Assert（応答待ち）
    expect(els.stockSubmit.disabled).toBe(true);
    expect(els.stockSubmit.textContent).toBe('登録中…');

    // Act（応答）
    pending.respond(createdSlip());
    await flush();

    // Assert（応答後）
    expect(els.stockSubmit.disabled).toBe(false);
    expect(els.stockSubmit.textContent).toBe('入出庫を登録');
  });

  test('異常系：400 の項目別エラーは表示中の欄に表示する', async () => {
    // Arrange
    await openPage({
      routes: {
        'POST /api/stockinout': {
          status: 400,
          body: {
            error: '入力内容に誤りがあります',
            details: [
              { field: 'jan_cd', message: 'jan_cd は必須です' },
              { field: 'quantity', message: '1 以上の整数を指定してください' },
            ],
          },
        },
      },
    });

    // Act
    await submitNewSlip({ jan_cd: '', quantity: '0' });

    // Assert
    expect(requestsTo('/api/stockinout', 'POST')[0].body).toEqual({ type: 'in', date: '2026-10-09', quantity: 0 });
    expect(fieldError(els.stockForm, 'jan_cd').textContent).toBe('jan_cd は必須です');
    expect(fieldError(els.stockForm, 'quantity').textContent).toBe('1 以上の整数を指定してください');
    expect(els.message.querySelector('p').textContent).toBe('入力内容に誤りがあります（強調表示した項目を確認してください）');
    expect(messageItems()).toEqual([]);
    // 入力値は残す
    expect(els.stockForm.elements.namedItem('quantity').value).toBe('0');
  });

  test('異常系：404（商品が存在しない）は API のメッセージを表示し、一覧は更新しない', async () => {
    // Arrange
    await openPage({
      routes: { 'POST /api/stockinout': { status: 404, body: { error: '指定された JAN コードの商品が見つかりません' } } },
    });

    // Act
    await submitNewSlip();

    // Assert
    expect(els.message.textContent).toBe('指定された JAN コードの商品が見つかりません（HTTP 404）');
    expect(requestsTo('/api/products')).toHaveLength(1);
    expect(requestsTo('/api/stockinout')).toHaveLength(1);
    expect(els.stockForm.elements.namedItem('quantity').value).toBe('10');
  });

  test('異常系：409（在庫不足）は一覧を再読み込みし、再操作の案内を添える', async () => {
    // Arrange
    await openPage({
      routes: { 'POST /api/stockinout': { status: 409, body: { error: '在庫数が不足しています（現在の在庫数: 3）' } } },
    });

    // Act
    await submitNewSlip({ type: 'out', quantity: '5' });

    // Assert
    expect(els.message.className).toBe('message message-error');
    expect(els.message.querySelector('p').textContent).toBe('在庫数が不足しています（現在の在庫数: 3）');
    expect(messageItems()).toEqual([
      '最新の在庫状況・履歴を再読み込みしました。内容を確認してから、もう一度操作してください',
    ]);
    expect(requestsTo('/api/products')).toHaveLength(2);
    expect(requestsTo('/api/stockinout')).toHaveLength(2);
    expect(els.stockSubmit.disabled).toBe(false);
  });

  test('異常系：数量欄に数値として読めない値がある場合は送信せず欄にエラーを表示する', async () => {
    // Arrange
    await openPage();
    Object.defineProperty(els.stockForm.elements.namedItem('quantity'), 'validity', { value: { badInput: true } });

    // Act
    await submitNewSlip({ quantity: '' });

    // Assert
    expect(requestsTo('/api/stockinout', 'POST')).toHaveLength(0);
    expect(fieldError(els.stockForm, 'quantity').textContent).toBe('数値を入力してください');
  });
});

describe('入出庫登録：訂正伝票', () => {
  test('正常系：訂正伝票の項目だけを送り（伝票NO・数量・伝票フラグは number）、訂正の成功メッセージを表示する', async () => {
    // Arrange
    await openPage({
      routes: {
        'POST /api/stockinout': createdSlip({ slip_no: 1001, slip_seq: 2, slip_flag: 2, quantity: 1, stock_delta: -1 }, { stock: 1199 }),
      },
    });
    // 新規伝票用の JAN 欄に値が残っていても送らない
    fill(els.stockForm, { jan_cd: JAN });

    // Act
    await submitCorrection();

    // Assert
    const posts = requestsTo('/api/stockinout', 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ type: 'in', slip_no: 1001, quantity: 1, slip_flag: 2 });
    expect(els.message.className).toBe('message message-success');
    expect(els.message.querySelector('p').textContent).toBe('入庫伝票（伝票NO: 1001）の訂正を登録しました（SEQ: 2）');
    expect(messageItems()).toEqual([`商品A（JAN: ${JAN}）の在庫数: 1,199（-1）`]);
    expect(requestsTo('/api/products')).toHaveLength(2);
    expect(requestsTo('/api/stockinout')).toHaveLength(2);
  });

  test('異常系：伝票NO が未入力の場合は送信せず、伝票NO 欄にエラーを表示する', async () => {
    // Arrange
    await openPage();

    // Act
    await submitCorrection({ slip_no: '' });

    // Assert
    expect(requestsTo('/api/stockinout', 'POST')).toHaveLength(0);
    expect(fieldError(els.stockForm, 'slip_no').hidden).toBe(false);
    expect(fieldError(els.stockForm, 'slip_no').textContent).toBe('訂正する伝票の伝票NOを入力してください');
    expect(document.activeElement).toBe(els.stockForm.elements.namedItem('slip_no'));
  });

  test('異常系：伝票NO が数値として読めない場合は「数値を入力してください」のみ表示する', async () => {
    // Arrange
    await openPage();
    Object.defineProperty(els.stockForm.elements.namedItem('slip_no'), 'validity', { value: { badInput: true } });

    // Act
    await submitCorrection({ slip_no: '' });

    // Assert
    expect(requestsTo('/api/stockinout', 'POST')).toHaveLength(0);
    expect(fieldError(els.stockForm, 'slip_no').textContent).toBe('数値を入力してください');
  });

  test('異常系：400 で隠れている欄（JAN）のエラーは画面上部に表示する', async () => {
    // Arrange
    await openPage({
      routes: {
        'POST /api/stockinout': {
          status: 400,
          body: { error: '入力内容に誤りがあります', details: [{ field: 'jan_cd', message: '元伝票の JAN コードと一致しません' }] },
        },
      },
    });

    // Act
    await submitCorrection();

    // Assert
    expect(fieldError(els.stockForm, 'jan_cd').hidden).toBe(true);
    expect(els.message.querySelector('p').textContent).toBe('入力内容に誤りがあります');
    expect(messageItems()).toEqual(['jan_cd: 元伝票の JAN コードと一致しません']);
  });

  test('異常系：404（訂正する伝票が存在しない）は API のメッセージを表示する', async () => {
    // Arrange
    await openPage({
      routes: { 'POST /api/stockinout': { status: 404, body: { error: '指定された伝票が見つかりません' } } },
    });

    // Act
    await submitCorrection({ slip_no: '9999' });

    // Assert
    expect(els.message.textContent).toBe('指定された伝票が見つかりません（HTTP 404）');
    expect(requestsTo('/api/products')).toHaveLength(1);
  });

  test('異常系：409（訂正で在庫がマイナスになる）は一覧を再読み込みする', async () => {
    // Arrange
    await openPage({
      routes: { 'POST /api/stockinout': { status: 409, body: { error: '在庫数が不足しています' } } },
    });

    // Act
    await submitCorrection();

    // Assert
    expect(els.message.querySelector('p').textContent).toBe('在庫数が不足しています');
    expect(messageItems()).toHaveLength(1);
    expect(requestsTo('/api/products')).toHaveLength(2);
    expect(requestsTo('/api/stockinout')).toHaveLength(2);
  });
});
