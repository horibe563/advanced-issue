// フロントエンド（public/js）テスト用のヘルパー
// jsdom 上に public/*.html の body を読み込み、fetch をモックして画面のスクリプトを実行する。
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', '..', 'public');

// jsdom に未実装の API を補う
function installPolyfills() {
  if (!window.CSS) window.CSS = {};
  if (!window.CSS.escape) window.CSS.escape = (s) => String(s).replace(/["\\]/g, '\\$&');
  global.CSS = window.CSS;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  const proto = window.HTMLDialogElement && window.HTMLDialogElement.prototype;
  if (proto) {
    proto.showModal = function showModal() {
      this.setAttribute('open', '');
    };
    proto.close = function close() {
      if (!this.hasAttribute('open')) return;
      this.removeAttribute('open');
      this.dispatchEvent(new window.Event('close'));
    };
  }
}

// public/<file> の body を document に読み込む（script は読み込まない）
function loadPage(file) {
  installPolyfills();
  const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  document.body.innerHTML = doc.body.innerHTML;
}

// ログイン状態にする（api.js が使う localStorage のキー）
function login(user = { user_id: 'admin', user_name: '管理者', role: 'admin' }) {
  localStorage.setItem('inventory.accessToken', 'test-token');
  localStorage.setItem('inventory.loginUser', JSON.stringify(user));
}

// fetch のモック
//   routes: { 'GET /api/usr': (req) => ({ status, body }) | { status, body } }
//   req = { method, path, query(URLSearchParams), body(JSON), headers, signal }
// 応答には次の項目も指定できる（ファイル取得 apiDownload・JSON でない本文のテスト用）
//   headers: { 'Content-Disposition': '...' }（res.headers.get で大文字小文字を区別せず取得できる）
//   rawBody: 文字列（JSON に変換せずそのまま本文にする）
// handler は Promise を返してもよい（タイムアウトのテスト用）。例外を投げると fetch の reject（ネットワークエラー）になる
// 呼び出し履歴は mock.calls ではなく requests で確認する
function mockFetch(routes) {
  const requests = [];
  global.fetch = jest.fn(async (url, options = {}) => {
    const u = new URL(url, 'http://localhost');
    const method = options.method || 'GET';
    const req = {
      method,
      path: u.pathname,
      query: u.searchParams,
      body: options.body ? JSON.parse(options.body) : undefined,
      headers: options.headers || {},
      signal: options.signal,
    };
    requests.push(req);
    const handler = routes[`${method} ${u.pathname}`] ?? routes[`${method} ${u.pathname.replace(/\/[^/]+$/, '/:id')}`];
    const res = typeof handler === 'function' ? await handler(req) : handler;
    if (!res) throw new Error(`fetch のモックに ${method} ${u.pathname} がありません`);
    const status = res.status ?? 200;
    const text = () => {
      if (res.rawBody !== undefined) return res.rawBody;
      return res.body === undefined ? '' : JSON.stringify(res.body);
    };
    const headers = Object.fromEntries(Object.entries(res.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
      text: async () => text(),
      blob: async () => new Blob([text()], { type: headers['content-type'] || '' }),
    };
  });
  return requests;
}

// 非同期処理（fetch → 描画）が終わるのを待つ
async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// フォームの入力欄に値を入れる
function fill(form, values) {
  for (const [name, value] of Object.entries(values)) {
    form.elements.namedItem(name).value = value;
  }
}

// フォームを送信する（requestSubmit 相当。submit イベントだけを発生させる）
function submit(form) {
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

// 画面遷移（location.replace / assign）を記録する
// jsdom は画面遷移に対応しておらず location のメソッドも差し替えられないため、内部実装（Symbol(impl)）のメソッドをモックする。
// 戻り値の配列に遷移先の URL（引数のまま）が入る。jest.restoreAllMocks() で元に戻る
function mockNavigation() {
  const implSymbol = Object.getOwnPropertySymbols(window.location).find((s) => String(s) === 'Symbol(impl)');
  const impl = window.location[implSymbol];
  const navigations = [];
  for (const method of ['replace', 'assign']) {
    jest.spyOn(impl, method).mockImplementation((url) => {
      navigations.push(url);
    });
  }
  return navigations;
}

// 現在の URL（パス・クエリ）を変える（画面遷移はせず履歴だけ書き換える）
function setUrl(pathAndQuery) {
  window.history.replaceState(null, '', pathAndQuery);
}

module.exports = { loadPage, login, mockFetch, flush, fill, submit, mockNavigation, setUrl };
