// ログイン画面（public/login.html・public/js/login.js）のテスト
// 要件「ログイン時に受け取ったアクセストークンを localStorage に保管する」・オープンリダイレクト対策
const { loadPage, mockFetch, flush, fill, submit, mockNavigation, setUrl } = require('./helpers/dom');

const USER = { user_id: 'admin', user_name: '管理者', role: 'admin' };

let requests;
let navigations;
let els;

// 画面を読み込んでスクリプトを実行する
//   url: 画面の URL（?next= の確認用）
function openPage({ url = '/login.html', routes = {} } = {}) {
  setUrl(url);
  loadPage('login.html');
  navigations = mockNavigation();
  requests = mockFetch({
    'POST /api/login': { status: 200, body: { token: 'new-token', user: USER } },
    ...routes,
  });
  jest.isolateModules(() => {
    require('../../public/js/login.js');
  });
  els = {
    form: document.getElementById('login-form'),
    message: document.getElementById('page-message'),
    button: document.getElementById('login-button'),
    userId: document.getElementById('login-user-id'),
    password: document.getElementById('login-password'),
  };
}

async function loginWith(values = { user_id: 'admin', password: 'secret' }) {
  fill(els.form, values);
  submit(els.form);
  await flush();
}

function fieldError(name) {
  return els.form.querySelector(`[data-error-for="${name}"]`);
}

beforeEach(() => {
  localStorage.clear();
  jest.restoreAllMocks();
});

afterEach(() => {
  setUrl('/');
});

describe('初期表示', () => {
  test('正常系：画面を開いた時点で保管していた古いトークンとログインユーザを破棄する', () => {
    // Arrange
    localStorage.setItem('inventory.accessToken', 'old-token');
    localStorage.setItem('inventory.loginUser', JSON.stringify(USER));

    // Act
    openPage();

    // Assert
    expect(localStorage.getItem('inventory.accessToken')).toBeNull();
    expect(localStorage.getItem('inventory.loginUser')).toBeNull();
    expect(requests).toHaveLength(0);
  });
});

describe('ログイン成功', () => {
  test('正常系：ユーザID（前後の空白を除く）とパスワードを送り、トークンを保管してトップ画面へ遷移する', async () => {
    // Arrange
    openPage();

    // Act
    await loginWith({ user_id: '  admin  ', password: ' secret ' });

    // Assert
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', path: '/api/login' });
    // パスワードは空白も含めてそのまま送る
    expect(requests[0].body).toEqual({ user_id: 'admin', password: ' secret ' });
    // ログイン API には古いトークンを付けない
    expect(requests[0].headers.Authorization).toBeUndefined();
    expect(localStorage.getItem('inventory.accessToken')).toBe('new-token');
    expect(JSON.parse(localStorage.getItem('inventory.loginUser'))).toEqual(USER);
    expect(navigations).toEqual(['/index.html']);
    expect(els.message.hidden).toBe(true);
    expect(els.button.disabled).toBe(false);
  });

  test.each([
    ['/form.html', '/form.html'],
    ['/form.html?jan_cd=4901234567894', '/form.html?jan_cd=4901234567894'],
    ['/users.html#list', '/users.html#list'],
    ['/form.html?x=1#a', '/form.html?x=1#a'],
    // %2F はパス中の文字として扱われ、外部サイトにはならない（同一オリジンのパスとしてそのまま遷移する）
    ['/%2F/evil.example.com', '/%2F/evil.example.com'],
  ])('正常系：?next=%s（同一オリジンのパス）のときはその画面へ戻る', async (next, expected) => {
    // Arrange
    openPage({ url: `/login.html?next=${encodeURIComponent(next)}` });

    // Act
    await loginWith();

    // Assert
    expect(navigations).toEqual([expected]);
  });

  // オープンリダイレクト対策：外部サイトへ誘導できる値は無視してトップ画面へ遷移する
  test.each([
    ['絶対 URL', 'https://evil.example.com/'],
    ['プロトコル相対 URL', '//evil.example.com/path'],
    ['バックスラッシュ（ブラウザが // と解釈する）', '/\\evil.example.com'],
    ['javascript: URL', 'javascript:alert(1)'],
    ['相対パス', 'index.html'],
    ['空文字', ''],
    // URL の解析では制御文字（タブ・改行など）が取り除かれるため、/<TAB>/evil.example.com は //evil.example.com（外部サイト）になる
    ['/ の間にタブを挟んだ外部 URL', '/\t/evil.example.com'],
    ['/ の間に改行（LF）を挟んだ外部 URL', '/\n/evil.example.com'],
    ['/ の間に改行（CR）を挟んだ外部 URL', '/\r/evil.example.com'],
    ['NUL 文字を含む値', '/\u0000/evil.example.com'],
    ['DEL 文字を含む値', '/\u007F/evil.example.com'],
    ['先頭以外にタブを含む値', '/form.html\tx'],
    ['末尾に改行を含む値', '/form.html\n'],
  ])('異常系：?next= が%sのときはトップ画面へ遷移する', async (_, next) => {
    // Arrange
    openPage({ url: `/login.html?next=${encodeURIComponent(next)}` });

    // Act
    await loginWith();

    // Assert
    expect(navigations).toEqual(['/index.html']);
  });
});

// 同一オリジンの確認（URL の解析結果）は文字列のチェックを通った値では通常失敗しないため、URL をモックして確認する
describe('遷移先の URL 解析（多層防御）', () => {
  const OriginalURL = URL;

  // next の値（sentinel）を解析したときだけ factory の結果を返し、それ以外は本来の URL を使う
  function mockUrlFor(sentinel, factory) {
    jest.spyOn(global, 'URL').mockImplementation((input, base) =>
      input === sentinel ? factory() : new OriginalURL(input, base)
    );
  }

  test('異常系：URL として解析できない（例外）ときはトップ画面へ遷移する', async () => {
    // Arrange
    openPage({ url: `/login.html?next=${encodeURIComponent('/broken')}` });
    mockUrlFor('/broken', () => {
      throw new TypeError('Invalid URL');
    });

    // Act
    await loginWith();

    // Assert
    expect(navigations).toEqual(['/index.html']);
  });

  test('異常系：解析結果のオリジンが現在の画面と異なるときはトップ画面へ遷移する', async () => {
    // Arrange
    openPage({ url: `/login.html?next=${encodeURIComponent('/elsewhere')}` });
    mockUrlFor('/elsewhere', () => new OriginalURL('https://evil.example.com/elsewhere'));

    // Act
    await loginWith();

    // Assert
    expect(navigations).toEqual(['/index.html']);
  });
});

describe('ログイン失敗', () => {
  test('異常系：401 のときは API のメッセージを表示し、ログイン画面へ再遷移しない', async () => {
    // Arrange
    openPage({
      routes: { 'POST /api/login': { status: 401, body: { error: 'ユーザIDまたはパスワードが正しくありません' } } },
    });

    // Act
    await loginWith();

    // Assert
    expect(els.message.hidden).toBe(false);
    expect(els.message.className).toBe('message message-error');
    expect(els.message.getAttribute('role')).toBe('alert');
    expect(els.message.textContent).toBe('ユーザIDまたはパスワードが正しくありません');
    // パスワードは消してフォーカスし、ユーザIDは残す
    expect(els.password.value).toBe('');
    expect(document.activeElement).toBe(els.password);
    expect(els.userId.value).toBe('admin');
    expect(localStorage.getItem('inventory.accessToken')).toBeNull();
    expect(navigations).toEqual([]);
    expect(els.button.disabled).toBe(false);
  });

  test('異常系：401 で本文に error がないときは既定のメッセージを表示する', async () => {
    // Arrange
    openPage({ routes: { 'POST /api/login': { status: 401 } } });

    // Act
    await loginWith();

    // Assert
    expect(els.message.textContent).toBe('ログインの有効期限が切れました。再度ログインしてください');
    expect(navigations).toEqual([]);
  });

  test('異常系：ネットワークエラーのときは接続できない旨を表示する', async () => {
    // Arrange
    openPage({
      routes: {
        'POST /api/login': () => {
          throw new TypeError('Failed to fetch');
        },
      },
    });

    // Act
    await loginWith();

    // Assert
    expect(els.message.textContent).toBe('サーバーに接続できません。ネットワークの状態を確認してください');
    expect(els.password.value).toBe('');
    expect(navigations).toEqual([]);
    expect(els.button.disabled).toBe(false);
  });

  test('異常系：500 のときは API のメッセージを表示する', async () => {
    // Arrange
    openPage({ routes: { 'POST /api/login': { status: 500, body: { error: 'サーバー内部でエラーが発生しました' } } } });

    // Act
    await loginWith();

    // Assert
    expect(els.message.textContent).toBe('サーバー内部でエラーが発生しました');
  });
});

describe('入力チェック', () => {
  test('異常系：ユーザID・パスワードが未入力のときは送信せず、各欄にエラーを表示する', async () => {
    // Arrange
    openPage();

    // Act
    await loginWith({ user_id: '   ', password: '' });

    // Assert
    expect(requests).toHaveLength(0);
    expect(els.message.textContent).toBe('入力内容に誤りがあります');
    expect(fieldError('user_id').hidden).toBe(false);
    expect(fieldError('user_id').textContent).toBe('ユーザIDを入力してください');
    expect(fieldError('password').textContent).toBe('パスワードを入力してください');
    expect(els.userId.getAttribute('aria-invalid')).toBe('true');
    expect(els.password.classList.contains('is-invalid')).toBe(true);
    // 最初の誤りの欄にフォーカスする
    expect(document.activeElement).toBe(els.userId);
    expect(navigations).toEqual([]);
  });

  test('異常系：パスワードのみ未入力のときはパスワード欄だけエラーにする', async () => {
    // Arrange
    openPage();

    // Act
    await loginWith({ user_id: 'admin', password: '' });

    // Assert
    expect(requests).toHaveLength(0);
    expect(fieldError('user_id').hidden).toBe(true);
    expect(fieldError('password').hidden).toBe(false);
    expect(document.activeElement).toBe(els.password);
  });

  test('正常系：入力エラーの後で正しく入力して送信すると、前回のエラー表示を消す', async () => {
    // Arrange
    openPage({ routes: { 'POST /api/login': { status: 401, body: { error: '認証に失敗しました' } } } });
    await loginWith({ user_id: '', password: '' });

    // Act
    await loginWith({ user_id: 'admin', password: 'wrong' });

    // Assert
    expect(fieldError('user_id').hidden).toBe(true);
    expect(fieldError('password').hidden).toBe(true);
    expect(els.userId.classList.contains('is-invalid')).toBe(false);
    expect(els.message.textContent).toBe('認証に失敗しました');
  });
});

describe('送信中の状態', () => {
  test('正常系：応答を待つ間はログインボタンを無効にし、応答後に戻す', async () => {
    // Arrange
    let respond;
    openPage({
      routes: {
        'POST /api/login': () =>
          new Promise((resolve) => {
            respond = resolve;
          }),
      },
    });

    // Act
    await loginWith();

    // Assert（応答待ち）
    expect(els.button.disabled).toBe(true);
    expect(navigations).toEqual([]);

    // Act（応答）
    respond({ status: 401, body: { error: '認証に失敗しました' } });
    await flush();

    // Assert（応答後）
    expect(els.button.disabled).toBe(false);
    expect(els.message.textContent).toBe('認証に失敗しました');
  });
});
