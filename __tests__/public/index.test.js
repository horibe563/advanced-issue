// 在庫状況画面（public/index.html・public/js/index.js）のテスト
const { loadPage, login, mockFetch, flush, fill, submit } = require('./helpers/dom');

const ADMIN = { user_id: 'admin', user_name: '管理者', role: 'admin' };
const JAN = '4901234567894';
const JAN8 = '49012347';

// 一覧 API の応答
function productList(items, { total = items.length, offset = 0 } = {}) {
  return { status: 200, body: { total, count: items.length, limit: 100, offset, items } };
}

// 在庫アラート API の応答
function alertList(items, { total = items.length } = {}) {
  return { status: 200, body: { total, count: items.length, limit: 100, offset: 0, items } };
}

function product(overrides = {}) {
  return {
    jan_cd: JAN,
    product_name: '商品A',
    product_spec: '500ml',
    product_name_kana: 'ｼｮｳﾋﾝA',
    stock: 1200,
    threshold: 10,
    is_alert: false,
    update_seq: 2,
    ...overrides,
  };
}

function alertItem(overrides = {}) {
  return {
    jan_cd: JAN8,
    product_name: '商品B',
    product_spec: null,
    product_name_kana: null,
    stock: 3,
    threshold: 1500,
    shortage: 1497,
    updated_at: '2026-10-08T00:00:00.000Z',
    ...overrides,
  };
}

const CSV_RESPONSE = {
  status: 200,
  rawBody: 'JANコード\r\n',
  headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="inventory_20261009_000405.csv"' },
};

let requests;
let els;
let consoleErrorSpy;

// 画面を読み込んでスクリプトを実行する
async function openPage({ routes = {} } = {}) {
  loadPage('index.html');
  login(ADMIN);
  requests = mockFetch({
    'GET /api/validatetoken': { status: 200, body: { valid: true, user: ADMIN } },
    'GET /api/products': productList([product(), product({ jan_cd: JAN8, product_name: '商品B', stock: 3, threshold: 1500, is_alert: true })]),
    'GET /api/products/alerts': alertList([alertItem()]),
    'GET /api/products/export': CSV_RESPONSE,
    ...routes,
  });
  jest.isolateModules(() => {
    require('../../public/js/index.js');
  });
  await flush();
  els = {
    message: document.getElementById('page-message'),
    searchForm: document.getElementById('search-form'),
    searchClear: document.getElementById('search-clear'),
    alertOnly: document.getElementById('search-alert-only'),
    reload: document.getElementById('reload-button'),
    exportButton: document.getElementById('export-button'),
    summary: document.getElementById('list-summary'),
    body: document.getElementById('product-body'),
    prev: document.getElementById('prev-page'),
    next: document.getElementById('next-page'),
    pageInfo: document.getElementById('page-info'),
    dialog: document.getElementById('history-dialog'),
    historyClose: document.getElementById('history-close'),
    historyProduct: document.getElementById('history-product'),
    historyMessage: document.getElementById('history-message'),
    historySummary: document.getElementById('history-summary'),
    historyBody: document.getElementById('history-body'),
    alertMessage: document.getElementById('alert-message'),
    alertSummary: document.getElementById('alert-summary'),
    alertTableWrap: document.getElementById('alert-table-wrap'),
    alertBody: document.getElementById('alert-body'),
    alertMore: document.getElementById('alert-more'),
  };
}

// 指定したパスへのリクエストのみ
function requestsTo(path, method = 'GET') {
  return requests.filter((r) => r.path === path && r.method === method);
}

function cellTexts(tr) {
  return [...tr.querySelectorAll('td')].map((td) => td.textContent);
}

function rowButton(jan, action) {
  return els.body.querySelector(`button[data-action="${action}"][data-jan="${jan}"]`);
}

// 検索ボタンを押して一覧を表示する
async function search(values = {}) {
  fill(els.searchForm, { product_name: '', product_name_kana: '', ...values });
  submit(els.searchForm);
  await flush();
}

// CSV の保存（URL.createObjectURL・a[download] のクリック・revokeObjectURL）を記録する
function mockSave() {
  const clicked = [];
  URL.createObjectURL = jest.fn(() => 'blob:http://localhost/1234');
  URL.revokeObjectURL = jest.fn();
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
    clicked.push({ href: this.getAttribute('href'), download: this.getAttribute('download'), connected: this.isConnected });
  });
  return clicked;
}

beforeEach(() => {
  localStorage.clear();
  jest.restoreAllMocks();
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  delete URL.createObjectURL;
  delete URL.revokeObjectURL;
});

describe('初期表示', () => {
  test('一覧と在庫アラートを取得して表示する', async () => {
    await openPage();
    expect(requestsTo('/api/products')).toHaveLength(1);
    expect(requestsTo('/api/products')[0].query.toString()).toBe('limit=100&offset=0');
    expect(requestsTo('/api/products/alerts')).toHaveLength(1);
    expect(requestsTo('/api/products/alerts')[0].query.toString()).toBe('limit=100');
    expect(els.body.querySelectorAll('tr')).toHaveLength(2);
    expect(els.summary.textContent).toBe('全 2 件 / このページの在庫不足: 1 件');
    expect(els.pageInfo.textContent).toBe('1〜2 件目');
    expect(els.prev.disabled).toBe(true);
    expect(els.next.disabled).toBe(true);
  });

  test('一覧の行：在庫不足は row-alert とバッジ、数値は3桁区切り', async () => {
    await openPage();
    const [normal, alert] = els.body.querySelectorAll('tr');
    expect(normal.className).toBe('');
    expect(cellTexts(normal).slice(0, 6)).toEqual(['正常', JAN, '商品AｼｮｳﾋﾝA', '500ml', '1,200', '10']);
    expect(alert.className).toBe('row-alert');
    expect(alert.querySelector('.badge-alert').textContent).toBe('在庫不足');
    expect(alert.querySelector('a').getAttribute('href')).toBe(`/form.html?jan_cd=${JAN8}#stock-section`);
  });

  test('一覧が0件なら「該当する商品はありません」', async () => {
    await openPage({ routes: { 'GET /api/products': productList([]) } });
    expect(els.body.textContent).toBe('該当する商品はありません');
    expect(els.summary.textContent).toBe('全 0 件');
    expect(els.pageInfo.textContent).toBe('0〜0 件目');
  });

  test('一覧の取得に失敗した場合は画面上部にエラーを表示する', async () => {
    await openPage({ routes: { 'GET /api/products': { status: 500, body: { error: 'サーバー内部でエラーが発生しました' } } } });
    expect(els.summary.textContent).toBe('一覧を取得できませんでした');
    expect(els.message.hidden).toBe(false);
    expect(els.message.textContent).toBe('サーバー内部でエラーが発生しました（HTTP 500）');
  });
});

describe('在庫アラートカード', () => {
  test('件数と行（JAN・商品名・規格・在庫数・閾値・不足数）を row-alert で表示する', async () => {
    await openPage({
      routes: {
        'GET /api/products/alerts': alertList([alertItem(), alertItem({ jan_cd: JAN, product_name: '商品A', product_name_kana: 'ｶﾅ', product_spec: '1kg', stock: 0, threshold: 5, shortage: 5 })]),
      },
    });
    expect(els.alertSummary.textContent).toBe('閾値を下回っている商品：2件');
    expect(els.alertTableWrap.hidden).toBe(false);
    expect(els.alertMore.hidden).toBe(true);
    expect(els.alertMessage.hidden).toBe(true);
    const rows = els.alertBody.querySelectorAll('tr');
    expect(rows).toHaveLength(2);
    expect([...rows].every((tr) => tr.className === 'row-alert')).toBe(true);
    expect(cellTexts(rows[0])).toEqual([JAN8, '商品B', '', '3', '1,500', '1,497']);
    expect(cellTexts(rows[1])).toEqual([JAN, '商品Aｶﾅ', '1kg', '0', '5', '5']);
    expect(rows[0].querySelector('.shortage').textContent).toBe('1,497');
    expect(rows[1].querySelector('.kana').textContent).toBe('ｶﾅ');
  });

  test('0件なら「ありません」を表示して表を隠す', async () => {
    await openPage({ routes: { 'GET /api/products/alerts': alertList([]) } });
    expect(els.alertSummary.textContent).toBe('閾値を下回っている商品はありません');
    expect(els.alertTableWrap.hidden).toBe(true);
    expect(els.alertMore.hidden).toBe(true);
    expect(els.alertBody.children).toHaveLength(0);
  });

  test('total が表示件数より多い場合は #alert-more に残りの件数を表示する', async () => {
    await openPage({ routes: { 'GET /api/products/alerts': alertList([alertItem()], { total: 1235 }) } });
    expect(els.alertSummary.textContent).toBe('閾値を下回っている商品：1,235件');
    expect(els.alertMore.hidden).toBe(false);
    expect(els.alertMore.textContent).toBe('ほか 1,234 件あります。「在庫不足（アラート）の商品のみ表示」で確認できます');
  });

  test('取得エラーはカード内のみに表示し、一覧は表示される', async () => {
    await openPage({ routes: { 'GET /api/products/alerts': { status: 500, body: { error: 'サーバー内部でエラーが発生しました' } } } });
    expect(els.alertSummary.textContent).toBe('在庫アラートを取得できませんでした');
    expect(els.alertTableWrap.hidden).toBe(true);
    expect(els.alertMore.hidden).toBe(true);
    expect(els.alertMessage.hidden).toBe(false);
    expect(els.alertMessage.textContent).toBe('サーバー内部でエラーが発生しました（HTTP 500）');
    // 画面上部のメッセージには出さず、一覧は表示される
    expect(els.message.hidden).toBe(true);
    expect(els.body.querySelectorAll('tr')).toHaveLength(2);
  });

  test('エラー後に再読み込みで取得できたらカード内のエラーを消す', async () => {
    await openPage({ routes: { 'GET /api/products/alerts': { status: 500, body: {} } } });
    expect(els.alertMessage.hidden).toBe(false);

    mockFetchReplace('GET /api/products/alerts', alertList([alertItem()]));
    els.reload.click();
    await flush();

    expect(els.alertMessage.hidden).toBe(true);
    expect(els.alertSummary.textContent).toBe('閾値を下回っている商品：1件');
  });

  test('商品名などの文字列は HTML として解釈せず textContent で表示する（XSS 対策）', async () => {
    const xss = '<img src=x onerror="window.__xss=1">';
    await openPage({
      routes: { 'GET /api/products/alerts': alertList([alertItem({ product_name: xss, product_name_kana: '<b>ｶﾅ</b>', product_spec: '<script>1</script>' })]) },
    });
    const row = els.alertBody.querySelector('tr');
    expect(row.querySelector('img')).toBeNull();
    expect(row.querySelector('b')).toBeNull();
    expect(row.querySelector('script')).toBeNull();
    expect(row.querySelector('.product-name').textContent).toBe(xss);
    expect(window.__xss).toBeUndefined();
  });
});

// openPage 後に特定のルートの応答だけ差し替える（同じ requests 配列に記録し続ける）
function mockFetchReplace(key, response) {
  const original = global.fetch;
  global.fetch = jest.fn(async (url, options = {}) => {
    const u = new URL(url, 'http://localhost');
    if (`${options.method || 'GET'} ${u.pathname}` === key) {
      requests.push({ method: options.method || 'GET', path: u.pathname, query: u.searchParams, headers: options.headers || {} });
      const status = response.status ?? 200;
      return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(response.body) };
    }
    return original(url, options);
  });
}

describe('CSV出力', () => {
  test('現在の検索条件で取得し、a[download] で保存して成功メッセージを表示する', async () => {
    await openPage();
    const clicked = mockSave();
    await search({ product_name: ' 商品 ', product_name_kana: 'ｼｮｳ' });
    // 検索後に入力欄を変えても、検索ボタンで確定した条件で出力する
    fill(els.searchForm, { product_name: '未確定', product_name_kana: '' });

    els.exportButton.click();
    await flush();

    const [req] = requestsTo('/api/products/export');
    expect([...req.query.entries()]).toEqual([
      ['product_name', '商品'],
      ['product_name_kana', 'ｼｮｳ'],
    ]);
    expect(req.headers.Authorization).toBe('Bearer test-token');
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(clicked).toEqual([{ href: 'blob:http://localhost/1234', download: 'inventory_20261009_000405.csv', connected: true }]);
    // クリック後にリンクは取り除く
    expect(document.querySelector('a[download]')).toBeNull();
    expect(els.message.hidden).toBe(false);
    expect(els.message.className).toBe('message message-success');
    expect(els.message.textContent).toBe('CSVファイル（inventory_20261009_000405.csv）を出力しました');
  });

  test('ダウンロード用の URL は保存の開始前に解放せず、10秒後に解放する', async () => {
    await openPage();
    mockSave();
    jest.useFakeTimers();

    els.exportButton.click();
    await jest.advanceTimersByTimeAsync(0);

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(9999);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/1234');
  });

  test('「在庫不足のみ表示」がチェックされていれば alert=true を付ける', async () => {
    await openPage();
    mockSave();
    els.alertOnly.checked = true;
    els.alertOnly.dispatchEvent(new window.Event('change'));
    await flush();

    els.exportButton.click();
    await flush();

    const [req] = requestsTo('/api/products/export');
    expect(req.query.toString()).toBe('alert=true');
  });

  test('条件なしなら検索条件を付けない', async () => {
    await openPage();
    mockSave();

    els.exportButton.click();
    await flush();

    expect(requestsTo('/api/products/export')[0].query.toString()).toBe('');
  });

  test('送信中はボタンを無効にし、完了後に戻す', async () => {
    let release;
    await openPage({
      routes: {
        'GET /api/products/export': () =>
          new Promise((resolve) => {
            release = () => resolve(CSV_RESPONSE);
          }),
      },
    });
    mockSave();

    els.exportButton.click();
    await flush();

    expect(els.exportButton.disabled).toBe(true);
    expect(els.exportButton.textContent).toBe('出力中…');
    expect(els.exportButton.getAttribute('aria-busy')).toBe('true');

    release();
    await flush();

    expect(els.exportButton.disabled).toBe(false);
    expect(els.exportButton.textContent).toBe('CSV出力');
    expect(els.exportButton.hasAttribute('aria-busy')).toBe(false);
  });

  test('400（件数上限超過）は画面上部にメッセージを表示し、保存しない', async () => {
    await openPage({
      routes: {
        'GET /api/products/export': { status: 400, body: { error: '出力件数が上限（100,000件）を超えています。条件を絞ってください' } },
      },
    });
    const clicked = mockSave();

    els.exportButton.click();
    await flush();

    expect(els.message.hidden).toBe(false);
    expect(els.message.className).toBe('message message-error');
    expect(els.message.textContent).toBe('出力件数が上限（100,000件）を超えています。条件を絞ってください');
    expect(clicked).toHaveLength(0);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(els.exportButton.disabled).toBe(false);
  });

  test('400 の details は対応する検索欄に表示する', async () => {
    await openPage({
      routes: {
        'GET /api/products/export': {
          status: 400,
          body: { error: '入力内容に誤りがあります', details: [{ field: 'product_name', message: 'product_name は200文字以内で指定してください' }] },
        },
      },
    });
    mockSave();

    els.exportButton.click();
    await flush();

    expect(els.message.textContent).toBe('入力内容に誤りがあります（強調表示した項目を確認してください）');
    const errEl = els.searchForm.querySelector('[data-error-for="product_name"]');
    expect(errEl.hidden).toBe(false);
    expect(errEl.textContent).toBe('product_name は200文字以内で指定してください');
  });

  test('CSV でない応答（Content-Type が text/csv でない）は保存せずにエラーを表示する', async () => {
    await openPage({
      routes: { 'GET /api/products/export': { status: 200, body: { items: [] }, headers: { 'Content-Type': 'application/json' } } },
    });
    const clicked = mockSave();

    els.exportButton.click();
    await flush();

    expect(els.message.className).toBe('message message-error');
    expect(els.message.textContent).toBe('サーバーの応答を解釈できませんでした');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(clicked).toHaveLength(0);
    expect(els.exportButton.disabled).toBe(false);
  });

  test.each([
    [429, { error: '他のCSV出力が処理中です。しばらくしてから再度実行してください' }, '他のCSV出力が処理中です。しばらくしてから再度実行してください（HTTP 429）'],
    [
      503,
      { error: '処理に時間がかかりすぎたため中断しました。条件を絞って再度実行してください' },
      '処理に時間がかかりすぎたため中断しました。条件を絞って再度実行してください（HTTP 503）',
    ],
    [503, undefined, 'サーバーが混み合っているか、処理に時間がかかりすぎたため中断しました。時間をおいて再度お試しください（HTTP 503）'],
  ])('%i（本文 %p）は画面上部にメッセージを表示し、ボタンを再び有効にする', async (status, body, message) => {
    await openPage({ routes: { 'GET /api/products/export': { status, body } } });
    mockSave();

    els.exportButton.click();
    await flush();

    expect(els.message.hidden).toBe(false);
    expect(els.message.className).toBe('message message-error');
    expect(els.message.textContent).toBe(message);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(els.exportButton.disabled).toBe(false);
    expect(els.exportButton.textContent).toBe('CSV出力');
  });

  test('ネットワークエラーは画面上部に表示する', async () => {
    await openPage({
      routes: {
        'GET /api/products/export': () => {
          throw new TypeError('Failed to fetch');
        },
      },
    });
    mockSave();

    els.exportButton.click();
    await flush();

    expect(els.message.textContent).toBe('サーバーに接続できません。ネットワークの状態を確認してください');
  });
});

describe('検索・ページング', () => {
  test('検索ボタンで商品名・カナ（前後の空白を除く）を指定して先頭から取得する', async () => {
    await openPage();
    await search({ product_name: '  商品  ', product_name_kana: ' ｼｮｳ ' });
    const last = requestsTo('/api/products').at(-1);
    expect(last.query.toString()).toBe(new URLSearchParams({ product_name: '商品', product_name_kana: 'ｼｮｳ', limit: '100', offset: '0' }).toString());
  });

  test('「在庫不足のみ表示」の切り替えで alert=true を付けて再取得する', async () => {
    await openPage();
    els.alertOnly.checked = true;
    els.alertOnly.dispatchEvent(new window.Event('change'));
    await flush();
    expect(requestsTo('/api/products').at(-1).query.get('alert')).toBe('true');
    expect(els.summary.textContent).toContain('（在庫不足のみ表示中）');
  });

  test('条件のクリアで検索条件を消して再取得する', async () => {
    await openPage();
    await search({ product_name: 'x' });
    els.searchClear.click();
    await flush();
    expect(els.searchForm.elements.namedItem('product_name').value).toBe('');
    expect(requestsTo('/api/products').at(-1).query.toString()).toBe('limit=100&offset=0');
  });

  test('400 の検索エラーは該当欄に表示する', async () => {
    await openPage();
    mockFetchReplace('GET /api/products', {
      status: 400,
      body: { error: '入力内容に誤りがあります', details: [{ field: 'product_name_kana', message: '200文字以内' }] },
    });
    await search({ product_name_kana: 'x' });
    const errEl = els.searchForm.querySelector('[data-error-for="product_name_kana"]');
    expect(errEl.hidden).toBe(false);
    expect(errEl.textContent).toBe('200文字以内');
  });

  test('次の100件・前の100件で offset を切り替える', async () => {
    const items = Array.from({ length: 100 }, (_, i) => product({ jan_cd: String(10000000 + i) }));
    await openPage({ routes: { 'GET /api/products': (req) => productList(items, { total: 250, offset: Number(req.query.get('offset')) }) } });
    expect(els.next.disabled).toBe(false);
    expect(els.pageInfo.textContent).toBe('1〜100 件目');

    els.next.click();
    await flush();
    expect(requestsTo('/api/products').at(-1).query.get('offset')).toBe('100');
    expect(els.pageInfo.textContent).toBe('101〜200 件目');
    expect(els.prev.disabled).toBe(false);

    els.prev.click();
    await flush();
    expect(requestsTo('/api/products').at(-1).query.get('offset')).toBe('0');
    expect(els.prev.disabled).toBe(true);
  });

  test('現在のページが空になった場合は最後のページに戻って再取得する', async () => {
    const items = Array.from({ length: 100 }, (_, i) => product({ jan_cd: String(10000000 + i) }));
    await openPage({
      routes: {
        'GET /api/products': (req) => {
          const offset = Number(req.query.get('offset'));
          return offset >= 100 ? productList([], { total: 100, offset }) : productList(items, { total: 101, offset });
        },
      },
    });
    els.next.click();
    await flush();
    const offsets = requestsTo('/api/products').map((r) => r.query.get('offset'));
    expect(offsets).toEqual(['0', '100', '0']);
    expect(els.pageInfo.textContent).toBe('1〜100 件目');
  });
});

describe('再読み込み', () => {
  test('再読み込みボタンで一覧と在庫アラートの両方を再取得する', async () => {
    await openPage();
    els.reload.click();
    await flush();
    expect(requestsTo('/api/products')).toHaveLength(2);
    expect(requestsTo('/api/products/alerts')).toHaveLength(2);
  });

  test('画面にフォーカスが戻ったら一覧と在庫アラートを再取得する（子画面表示中は除く）', async () => {
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    await openPage();
    now.mockReturnValue(1_005_000);

    window.dispatchEvent(new window.Event('focus'));
    await flush();
    expect(requestsTo('/api/products')).toHaveLength(2);
    expect(requestsTo('/api/products/alerts')).toHaveLength(2);

    els.dialog.showModal();
    now.mockReturnValue(1_010_000);
    window.dispatchEvent(new window.Event('focus'));
    await flush();
    expect(requestsTo('/api/products')).toHaveLength(2);
  });
});

describe('削除', () => {
  test('確認で「キャンセル」なら削除しない', async () => {
    await openPage({ routes: { 'DELETE /api/products/:id': { status: 204 } } });
    jest.spyOn(window, 'confirm').mockReturnValue(false);
    rowButton(JAN, 'delete').click();
    await flush();
    expect(requestsTo(`/api/products/${JAN}`, 'DELETE')).toHaveLength(0);
  });

  test('確認後に update_seq を付けて削除し、一覧と在庫アラートを再取得する', async () => {
    await openPage({ routes: { 'DELETE /api/products/:id': { status: 204 } } });
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    rowButton(JAN, 'delete').click();
    await flush();
    expect(confirm.mock.calls[0][0]).toContain(`商品「商品A」（JAN: ${JAN}）を削除しますか？`);
    const [del] = requestsTo(`/api/products/${JAN}`, 'DELETE');
    expect(del.query.toString()).toBe('update_seq=2');
    expect(els.message.textContent).toBe('商品「商品A」を削除しました');
    expect(requestsTo('/api/products')).toHaveLength(2);
    expect(requestsTo('/api/products/alerts')).toHaveLength(2);
  });

  test('409（他のユーザが更新済み）は一覧を再取得して案内する', async () => {
    await openPage({ routes: { 'DELETE /api/products/:id': { status: 409, body: { error: '他のユーザによって更新されています' } } } });
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    rowButton(JAN, 'delete').click();
    await flush();
    expect(els.message.textContent).toContain('他のユーザによって更新されています');
    expect(els.message.textContent).toContain('一覧を再読み込みしました');
    expect(requestsTo('/api/products')).toHaveLength(2);
    expect(requestsTo('/api/products/alerts')).toHaveLength(2);
  });

  test('404（既に削除済み）は一覧を再取得する', async () => {
    await openPage({ routes: { 'DELETE /api/products/:id': { status: 404, body: { error: '指定された商品が見つかりません' } } } });
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    rowButton(JAN, 'delete').click();
    await flush();
    expect(els.message.textContent).toBe('指定された商品が見つかりません（HTTP 404）');
    expect(requestsTo('/api/products')).toHaveLength(2);
  });

  test('一覧を再描画しない失敗（500）ではボタンを元に戻す', async () => {
    await openPage({ routes: { 'DELETE /api/products/:id': { status: 500, body: {} } } });
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    const button = rowButton(JAN, 'delete');
    button.click();
    await flush();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('削除');
  });
});

describe('入出庫履歴の子画面', () => {
  const historyItem = (overrides = {}) => ({
    date: '2026-10-08',
    type: 'in',
    slip_no: '7',
    slip_seq: 1,
    slip_flag: 1,
    quantity: 1000,
    stock_delta: 1000,
    created_by: 'admin',
    ...overrides,
  });

  test('履歴ボタンで子画面を開き、新しい順の履歴を表示する', async () => {
    await openPage({
      routes: {
        'GET /api/stockinout': { status: 200, body: { total: 2, count: 2, items: [historyItem(), historyItem({ type: 'out', slip_flag: 2, stock_delta: -5, quantity: 5, created_by: null })] } },
      },
    });
    rowButton(JAN, 'history').click();
    await flush();
    expect(els.dialog.open).toBe(true);
    expect(requestsTo('/api/stockinout')[0].query.toString()).toBe(`jan_cd=${JAN}&limit=1000`);
    expect(els.historyProduct.textContent).toBe(`商品A（JAN: ${JAN}） 現在の在庫数: 1,200`);
    expect(els.historySummary.textContent).toBe('全 2 件（新しい順）');
    const rows = els.historyBody.querySelectorAll('tr');
    expect(rows).toHaveLength(2);
    expect(rows[1].className).toBe('row-correction');
    expect(rows[1].querySelector('.delta-minus')).not.toBeNull();
  });

  test('件数が多い場合は表示件数を案内する', async () => {
    await openPage({ routes: { 'GET /api/stockinout': { status: 200, body: { total: 1500, count: 1, items: [historyItem()] } } } });
    rowButton(JAN, 'history').click();
    await flush();
    expect(els.historySummary.textContent).toBe('全 1,500 件のうち新しい順に 1 件を表示');
  });

  test('履歴が0件なら「入出庫履歴はありません」', async () => {
    await openPage({ routes: { 'GET /api/stockinout': { status: 200, body: { total: 0, count: 0, items: [] } } } });
    rowButton(JAN, 'history').click();
    await flush();
    expect(els.historyBody.textContent).toBe('入出庫履歴はありません');
  });

  test('取得エラーは子画面内に表示する', async () => {
    await openPage({ routes: { 'GET /api/stockinout': { status: 500, body: { error: 'エラー' } } } });
    rowButton(JAN, 'history').click();
    await flush();
    expect(els.historyMessage.hidden).toBe(false);
    expect(els.historyMessage.textContent).toBe('エラー（HTTP 500）');
    expect(els.historySummary.textContent).toBe('');
  });

  test('閉じるボタン・背景クリックで閉じる', async () => {
    await openPage({ routes: { 'GET /api/stockinout': { status: 200, body: { total: 0, count: 0, items: [] } } } });
    rowButton(JAN, 'history').click();
    await flush();
    els.historyClose.click();
    expect(els.dialog.open).toBe(false);

    rowButton(JAN, 'history').click();
    await flush();
    els.dialog.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(els.dialog.open).toBe(false);
  });
});
