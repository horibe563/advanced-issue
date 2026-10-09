// 画面共通のログイン確認（public/js/auth.js）のテスト
// 要件「Adminロールの場合のみユーザマスタメニューを表示する」
const { loadPage, login, mockFetch, flush } = require('./helpers/dom');

let requireLogin;

function loadAuth() {
  jest.isolateModules(() => {
    ({ requireLogin } = require('../../public/js/auth.js'));
  });
}

function menuLinks() {
  return [...document.querySelectorAll('.nav-list a')].map((a) => a.getAttribute('href'));
}

beforeEach(() => {
  localStorage.clear();
});

describe('ユーザマスタメニュー', () => {
  test.each(['index.html', 'form.html'])('%s：管理者にはユーザマスタのメニューを追加する', async (page) => {
    loadPage(page);
    const admin = { user_id: 'admin', user_name: '管理者', role: 'admin' };
    login(admin);
    mockFetch({ 'GET /api/validatetoken': { status: 200, body: { valid: true, user: admin } } });
    loadAuth();
    expect(requireLogin()).toBe(true);
    await flush();
    // validatetoken の後に再描画しても重複しない
    expect(menuLinks()).toEqual(['/index.html', '/form.html', '/users.html']);
    expect(document.getElementById('header-user').textContent).toContain('管理者 さん');
  });

  test('一般ユーザにはユーザマスタのメニューを表示しない', async () => {
    loadPage('index.html');
    const general = { user_id: 'u1', user_name: '一般', role: 'general' };
    login(general);
    mockFetch({ 'GET /api/validatetoken': { status: 200, body: { valid: true, user: general } } });
    loadAuth();
    requireLogin();
    await flush();
    expect(menuLinks()).toEqual(['/index.html', '/form.html']);
  });

  test('サーバ側でロールが一般に変わっていた場合はメニューを消す', async () => {
    loadPage('index.html');
    login({ user_id: 'u1', user_name: '元管理者', role: 'admin' });
    mockFetch({
      'GET /api/validatetoken': { status: 200, body: { valid: true, user: { user_id: 'u1', user_name: '元管理者', role: 'general' } } },
    });
    loadAuth();
    requireLogin();
    expect(menuLinks()).toContain('/users.html');
    await flush();
    expect(menuLinks()).not.toContain('/users.html');
    // 保管しているログインユーザも最新のロールに更新される
    expect(JSON.parse(localStorage.getItem('inventory.loginUser')).role).toBe('general');
  });
});
