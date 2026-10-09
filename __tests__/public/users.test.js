// ユーザマスタ画面（public/users.html・public/js/users.js）のテスト
const { loadPage, login, mockFetch, flush, fill, submit } = require('./helpers/dom');

const ADMIN = { user_id: 'admin', user_name: '管理者', role: 'admin' };

// 一覧 API の応答
function userList(items, { total = items.length, offset = 0 } = {}) {
  return { status: 200, body: { total, count: items.length, limit: 100, offset, items } };
}

function user(overrides = {}) {
  return {
    user_id: 'u1',
    user_name: '山田 太郎',
    role: 'general',
    created_at: '2026-10-08T00:00:00.000Z',
    created_by: 'admin',
    updated_at: '2026-10-08T01:23:00.000Z',
    updated_by: 'admin',
    update_seq: 3,
    ...overrides,
  };
}

let requests;
let routes;
let els;

// 画面を読み込んでスクリプトを実行する
async function openPage({ loginUser = ADMIN, extraRoutes = {} } = {}) {
  loadPage('users.html');
  login(loginUser);
  routes = {
    'GET /api/validatetoken': { status: 200, body: { valid: true, user: loginUser } },
    'GET /api/usr': userList([user(), user({ user_id: 'admin', user_name: '管理者', role: 'admin', update_seq: 0 })]),
    ...extraRoutes,
  };
  requests = mockFetch(routes);
  jest.isolateModules(() => {
    require('../../public/js/users.js');
  });
  await flush();
  els = {
    message: document.getElementById('page-message'),
    searchSection: document.getElementById('search-section'),
    searchForm: document.getElementById('search-form'),
    resultSection: document.getElementById('result-section'),
    body: document.getElementById('user-body'),
    summary: document.getElementById('list-summary'),
    registerDialog: document.getElementById('register-dialog'),
    registerForm: document.getElementById('register-form'),
    registerMessage: document.getElementById('register-message'),
    passwordDialog: document.getElementById('password-dialog'),
    passwordForm: document.getElementById('password-form'),
    passwordMessage: document.getElementById('password-message'),
    passwordTarget: document.getElementById('password-target'),
  };
}

// /api/usr へのリクエストのみ
function usrRequests(method) {
  return requests.filter((r) => r.path.startsWith('/api/usr') && (!method || r.method === method));
}

// 検索ボタンを押して一覧を表示する
async function search(values = {}) {
  fill(els.searchForm, { user_id: '', user_name: '', ...values });
  submit(els.searchForm);
  await flush();
}

function rowButton(userId, action) {
  return els.body.querySelector(`button[data-action="${action}"][data-user="${userId}"]`);
}

// ログイン画面への遷移（users.js の 2秒後の setTimeout）を実行させずに、予約されたかだけを記録する
// （jsdom は画面遷移に対応していないため）
function holdReloginTimer() {
  const realSetTimeout = window.setTimeout;
  let scheduled = false;
  const spy = jest.spyOn(window, 'setTimeout').mockImplementation((fn, ms, ...args) => {
    if (ms === 2000) {
      scheduled = true;
      return 0;
    }
    return realSetTimeout(fn, ms, ...args);
  });
  return { scheduled: () => scheduled, restore: () => spy.mockRestore() };
}

function fieldError(form, field) {
  const el = form.querySelector(`[data-error-for="${field}"]`);
  return el.hidden ? null : el.textContent;
}

beforeEach(() => {
  localStorage.clear();
  jest.restoreAllMocks();
});

describe('初期表示', () => {
  test('検索窓のみ表示し、一覧は取得しない', async () => {
    await openPage();
    expect(els.searchSection.hidden).toBe(false);
    expect(els.resultSection.hidden).toBe(true);
    expect(els.registerDialog.open).toBe(false);
    expect(usrRequests()).toHaveLength(0);
    // トークンの確認は行う
    expect(requests.some((r) => r.path === '/api/validatetoken')).toBe(true);
  });

  test('管理者にはユーザマスタのメニューが表示される', async () => {
    await openPage();
    const links = [...document.querySelectorAll('.nav-list a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/index.html', '/form.html', '/users.html']);
  });

  test('一般ユーザが開いた場合は検索窓を隠して案内し、API を呼ばない', async () => {
    await openPage({ loginUser: { user_id: 'u1', user_name: '一般', role: 'general' } });
    expect(els.searchSection.hidden).toBe(true);
    expect(els.resultSection.hidden).toBe(true);
    expect(els.message.hidden).toBe(false);
    expect(els.message.textContent).toContain('管理者のみ利用できます');
    expect(usrRequests()).toHaveLength(0);
    // メニューも消える
    expect(document.querySelector('[data-admin-menu]')).toBeNull();
  });
});

describe('検索・一覧', () => {
  test('ユーザID・氏名を条件に GET /api/usr を呼び、一覧を表示する', async () => {
    await openPage();
    await search({ user_id: '  u ', user_name: '山田' });

    const [req] = usrRequests('GET');
    expect(req.query.get('user_id')).toBe('u');
    expect(req.query.get('user_name')).toBe('山田');
    expect(req.query.get('limit')).toBe('100');
    expect(req.query.get('offset')).toBe('0');
    expect(req.headers.Authorization).toBe('Bearer test-token');

    expect(els.resultSection.hidden).toBe(false);
    const rows = els.body.querySelectorAll('tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('u1');
    expect(rows[0].textContent).toContain('山田 太郎');
    expect(rows[0].textContent).toContain('一般');
    expect(rows[1].textContent).toContain('管理者');
    expect(els.summary.textContent).toBe('全 2 件');
  });

  test('条件が空欄なら検索条件を付けずに全件を取得する', async () => {
    await openPage();
    await search();
    const [req] = usrRequests('GET');
    expect(req.query.has('user_id')).toBe(false);
    expect(req.query.has('user_name')).toBe(false);
  });

  test('ログイン中のユーザ自身の行には「自分」と表示する', async () => {
    await openPage();
    await search();
    const adminRow = rowButton('admin', 'delete').closest('tr');
    expect(adminRow.querySelector('.badge-self').textContent).toBe('自分');
    expect(rowButton('u1', 'delete').closest('tr').querySelector('.badge-self')).toBeNull();
  });

  test('API から返った文字列は HTML として解釈せずに表示する', async () => {
    await openPage({
      extraRoutes: { 'GET /api/usr': userList([user({ user_name: '<img src=x onerror=alert(1)>' })]) },
    });
    await search();
    expect(els.body.querySelector('img')).toBeNull();
    expect(els.body.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  test('該当なしの場合はその旨を表示する', async () => {
    await openPage({ extraRoutes: { 'GET /api/usr': userList([]) } });
    await search({ user_id: 'zzz' });
    expect(els.body.textContent).toContain('該当するユーザはありません');
    expect(els.summary.textContent).toBe('全 0 件');
  });

  test('400 の項目別エラーを検索欄の近くに表示する', async () => {
    await openPage({
      extraRoutes: {
        'GET /api/usr': {
          status: 400,
          body: { error: '入力内容に誤りがあります', details: [{ field: 'user_id', message: 'user_id は50文字以内で指定してください' }] },
        },
      },
    });
    await search({ user_id: 'x' });
    expect(fieldError(els.searchForm, 'user_id')).toContain('50文字以内');
    expect(els.message.textContent).toContain('入力内容に誤りがあります');
  });

  test('通信エラーは画面上部に表示する', async () => {
    await openPage();
    global.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await search();
    expect(els.summary.textContent).toBe('ユーザ一覧を取得できませんでした');
    expect(els.message.textContent).toContain('サーバーに接続できません');
  });

  test('API が 403 を返した場合は権限なしの案内に切り替える', async () => {
    await openPage({ extraRoutes: { 'GET /api/usr': { status: 403, body: { error: 'この操作を行う権限がありません' } } } });
    await search();
    expect(els.searchSection.hidden).toBe(true);
    expect(els.resultSection.hidden).toBe(true);
    expect(els.message.textContent).toContain('管理者のみ利用できます');
  });

  test('「条件をクリア」で初期表示（検索窓のみ）に戻る', async () => {
    await openPage();
    await search({ user_id: 'u' });
    document.getElementById('search-clear').click();
    expect(els.resultSection.hidden).toBe(true);
    expect(els.body.children).toHaveLength(0);
    expect(els.searchForm.elements.namedItem('user_id').value).toBe('');
  });

  test('100件を超える場合はページを切り替えられる', async () => {
    const items = Array.from({ length: 100 }, (_, i) => user({ user_id: `u${i}` }));
    await openPage({ extraRoutes: { 'GET /api/usr': (req) => userList(items, { total: 150, offset: Number(req.query.get('offset')) }) } });
    await search();
    const next = document.getElementById('next-page');
    const prev = document.getElementById('prev-page');
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    expect(document.getElementById('page-info').textContent).toBe('1〜100 件目');

    next.click();
    await flush();
    expect(usrRequests('GET').at(-1).query.get('offset')).toBe('100');
    expect(prev.disabled).toBe(false);

    prev.click();
    await flush();
    expect(usrRequests('GET').at(-1).query.get('offset')).toBe('0');
  });

  test('「再読み込み」で同じ条件のまま再取得する', async () => {
    await openPage();
    await search({ user_name: '山田' });
    document.getElementById('reload-button').click();
    await flush();
    const gets = usrRequests('GET');
    expect(gets).toHaveLength(2);
    expect(gets[1].query.get('user_name')).toBe('山田');
  });
});

describe('ユーザ登録', () => {
  async function openRegister(extraRoutes) {
    await openPage({ extraRoutes });
    document.getElementById('register-open').click();
    expect(els.registerDialog.open).toBe(true);
  }

  const VALID = { user_id: ' newuser ', user_name: ' 新規 花子 ', role: 'admin', password: 'pass word1', password_confirm: 'pass word1' };

  test('POST /api/usr で登録し、登録したユーザIDで一覧を表示する', async () => {
    await openRegister({
      'POST /api/usr': { status: 201, body: user({ user_id: 'newuser', user_name: '新規 花子', role: 'admin', update_seq: 0 }) },
      'GET /api/usr': userList([user({ user_id: 'newuser', user_name: '新規 花子', role: 'admin' })]),
    });
    fill(els.registerForm, VALID);
    submit(els.registerForm);
    await flush();

    const [post] = usrRequests('POST');
    // ID・氏名は前後の空白を除き、パスワードはそのまま送る
    expect(post.body).toEqual({ user_id: 'newuser', user_name: '新規 花子', role: 'admin', password: 'pass word1' });
    expect(post.body).not.toHaveProperty('password_confirm');
    expect(post.body).not.toHaveProperty('update_seq');

    expect(els.registerDialog.open).toBe(false);
    expect(els.message.textContent).toContain('ユーザ「新規 花子」（ID: newuser、管理者）を登録しました');
    expect(els.searchForm.elements.namedItem('user_id').value).toBe('newuser');
    expect(usrRequests('GET').at(-1).query.get('user_id')).toBe('newuser');
    expect(els.resultSection.hidden).toBe(false);
    // 閉じたら入力中のパスワードは消える
    expect(els.registerForm.elements.namedItem('password').value).toBe('');
  });

  test('確認用パスワードが一致しない場合は送信しない', async () => {
    await openRegister();
    fill(els.registerForm, { ...VALID, password_confirm: 'different1' });
    submit(els.registerForm);
    await flush();
    expect(usrRequests('POST')).toHaveLength(0);
    expect(fieldError(els.registerForm, 'password_confirm')).toContain('一致しません');
    expect(els.registerDialog.open).toBe(true);
  });

  test('空欄の項目は送らず、API の 400 を各欄に表示する', async () => {
    await openRegister({
      'POST /api/usr': {
        status: 400,
        body: {
          error: '入力内容に誤りがあります',
          details: [
            { field: 'user_id', message: 'user_id は必須です' },
            { field: 'user_name', message: 'user_name は必須です' },
            { field: 'password', message: 'password は必須です' },
          ],
        },
      },
    });
    submit(els.registerForm);
    await flush();
    const [post] = usrRequests('POST');
    expect(post.body).toEqual({ role: 'general' });
    expect(fieldError(els.registerForm, 'user_id')).toContain('必須');
    expect(fieldError(els.registerForm, 'user_name')).toContain('必須');
    expect(fieldError(els.registerForm, 'password')).toContain('必須');
    // エラーは子画面の中に表示し、子画面は開いたままにする
    expect(els.registerMessage.hidden).toBe(false);
    expect(els.message.hidden).toBe(true);
    expect(els.registerDialog.open).toBe(true);
  });

  test('ユーザIDの重複（409）は子画面の中に表示する', async () => {
    await openRegister({
      'POST /api/usr': { status: 409, body: { error: '同じユーザIDが既に登録されています（削除済みのユーザを含む）' } },
    });
    fill(els.registerForm, VALID);
    submit(els.registerForm);
    await flush();
    expect(els.registerMessage.textContent).toContain('同じユーザIDが既に登録されています');
    expect(els.registerDialog.open).toBe(true);
  });

  test('開き直すと前回の入力・エラーは消えている', async () => {
    await openRegister();
    fill(els.registerForm, { ...VALID, password_confirm: 'x' });
    submit(els.registerForm);
    await flush();
    els.registerDialog.querySelector('[data-close-dialog]').click();
    expect(els.registerDialog.open).toBe(false);

    document.getElementById('register-open').click();
    expect(els.registerForm.elements.namedItem('user_id').value).toBe('');
    expect(fieldError(els.registerForm, 'password_confirm')).toBeNull();
    expect(els.registerMessage.hidden).toBe(true);
  });

  test('子画面の外側（背景）をクリックすると閉じる', async () => {
    await openRegister();
    els.registerDialog.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(els.registerDialog.open).toBe(false);
  });
});

describe('パスワード設定', () => {
  async function openPassword(userId, { loginUser = ADMIN, extraRoutes } = {}) {
    await openPage({ loginUser, extraRoutes });
    await search();
    rowButton(userId, 'password').click();
    expect(els.passwordDialog.open).toBe(true);
  }

  test('POST /api/usr に user_id・update_seq・password を送り、一覧を再取得する', async () => {
    await openPassword('u1', { extraRoutes: { 'POST /api/usr': { status: 200, body: user({ update_seq: 4 }) } } });
    expect(els.passwordTarget.textContent).toBe('対象：山田 太郎（ID: u1）');

    fill(els.passwordForm, { password: 'newpass12', password_confirm: 'newpass12' });
    submit(els.passwordForm);
    await flush();

    const [post] = usrRequests('POST');
    expect(post.body).toEqual({ user_id: 'u1', update_seq: 3, password: 'newpass12' });
    expect(els.passwordDialog.open).toBe(false);
    expect(els.message.textContent).toContain('ユーザ「u1」のパスワードを設定しました');
    expect(usrRequests('GET')).toHaveLength(2);
  });

  test('未入力・確認用の不一致は送信しない', async () => {
    await openPassword('u1');
    submit(els.passwordForm);
    await flush();
    expect(fieldError(els.passwordForm, 'password')).toContain('入力してください');

    fill(els.passwordForm, { password: 'newpass12', password_confirm: 'newpass13' });
    submit(els.passwordForm);
    await flush();
    expect(fieldError(els.passwordForm, 'password_confirm')).toContain('一致しません');
    expect(usrRequests('POST')).toHaveLength(0);
  });

  test('API の 400（8文字未満など）を欄の近くに表示する', async () => {
    await openPassword('u1', {
      extraRoutes: {
        'POST /api/usr': {
          status: 400,
          body: { error: '入力内容に誤りがあります', details: [{ field: 'password', message: 'password は8文字以上で指定してください' }] },
        },
      },
    });
    fill(els.passwordForm, { password: 'short', password_confirm: 'short' });
    submit(els.passwordForm);
    await flush();
    expect(fieldError(els.passwordForm, 'password')).toContain('8文字以上');
    expect(els.passwordDialog.open).toBe(true);
  });

  test('他の人が更新済み（409）の場合は一覧を再取得して案内する', async () => {
    await openPassword('u1', {
      extraRoutes: { 'POST /api/usr': { status: 409, body: { error: '他のユーザによって更新されています。' } } },
    });
    fill(els.passwordForm, { password: 'newpass12', password_confirm: 'newpass12' });
    submit(els.passwordForm);
    await flush();
    expect(els.passwordMessage.textContent).toContain('他のユーザによって更新されています');
    expect(els.passwordMessage.textContent).toContain('一覧を再読み込みしました');
    expect(usrRequests('GET')).toHaveLength(2);
  });

  test('自分自身のパスワードを変更した場合はトークンを消してログイン画面へ遷移する', async () => {
    await openPassword('admin', { extraRoutes: { 'POST /api/usr': { status: 200, body: user({ user_id: 'admin' }) } } });
    expect(els.passwordTarget.textContent).toContain('あなた自身');
    const relogin = holdReloginTimer();
    fill(els.passwordForm, { password: 'newpass12', password_confirm: 'newpass12' });
    submit(els.passwordForm);
    await flush();
    relogin.restore();

    expect(els.message.textContent).toContain('あなた自身のパスワードを変更しました');
    expect(localStorage.getItem('inventory.accessToken')).toBeNull();
    expect(relogin.scheduled()).toBe(true);
    // 一覧の再取得はしない（トークンが無効になっているため）
    expect(usrRequests('GET')).toHaveLength(1);
  });
});

describe('削除', () => {
  test('確認でキャンセルした場合は削除しない', async () => {
    await openPage();
    await search();
    jest.spyOn(window, 'confirm').mockReturnValue(false);
    rowButton('u1', 'delete').click();
    await flush();
    expect(usrRequests('DELETE')).toHaveLength(0);
  });

  test('DELETE /api/usr/:user_id?update_seq=N を呼び、一覧を再取得する', async () => {
    await openPage({ extraRoutes: { 'DELETE /api/usr/:id': { status: 204 } } });
    await search();
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    rowButton('u1', 'delete').click();
    await flush();

    expect(confirm.mock.calls[0][0]).toContain('ユーザ「山田 太郎」（ID: u1）を削除しますか？');
    const [del] = usrRequests('DELETE');
    expect(del.path).toBe('/api/usr/u1');
    expect(del.query.get('update_seq')).toBe('3');
    expect(els.message.textContent).toContain('ユーザ「u1」を削除しました');
    expect(usrRequests('GET')).toHaveLength(2);
  });

  test('最後の管理者の削除（409）はメッセージを表示して一覧を再取得する', async () => {
    await openPage({
      extraRoutes: {
        'DELETE /api/usr/:id': { status: 409, body: { error: '有効な管理者ユーザが1人もいなくなるため、この操作はできません' } },
      },
    });
    await search();
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    rowButton('admin', 'delete').click();
    await flush();
    // 自分自身の削除は確認文で警告する
    expect(confirm.mock.calls[0][0]).toContain('ログイン中のあなた自身です');
    expect(els.message.textContent).toContain('有効な管理者ユーザが1人もいなくなる');
    expect(els.message.textContent).toContain('一覧を再読み込みしました');
    expect(usrRequests('GET')).toHaveLength(2);
    // 失敗時はトークンを消さない
    expect(localStorage.getItem('inventory.accessToken')).toBe('test-token');
  });

  test('自分自身を削除した場合はトークンを消してログイン画面へ遷移する', async () => {
    await openPage({ extraRoutes: { 'DELETE /api/usr/:id': { status: 204 } } });
    await search();
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    const relogin = holdReloginTimer();
    rowButton('admin', 'delete').click();
    await flush();
    relogin.restore();
    expect(els.message.textContent).toContain('あなた自身）を削除しました');
    expect(localStorage.getItem('inventory.accessToken')).toBeNull();
    expect(relogin.scheduled()).toBe(true);
    expect(usrRequests('GET')).toHaveLength(1);
  });

  test('既に削除されていた（404）場合も一覧を再取得する', async () => {
    await openPage({ extraRoutes: { 'DELETE /api/usr/:id': { status: 404, body: { error: '指定されたユーザが見つかりません' } } } });
    await search();
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    rowButton('u1', 'delete').click();
    await flush();
    expect(els.message.textContent).toContain('指定されたユーザが見つかりません');
    expect(usrRequests('GET')).toHaveLength(2);
  });
});
