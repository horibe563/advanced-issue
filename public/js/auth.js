// 画面共通のログイン確認・ヘッダーのログインユーザ表示
// ログインが必要な画面は、読み込み時に requireLogin() を呼ぶ（要件「各画面でアクセストークンのチェックを行う」）。
//   - トークンがなければ、API を呼ぶ前にログイン画面へ遷移する
//   - トークンがあれば validatetoken で有効か確認する（無効なら api.js が 401 を受けてログイン画面へ遷移する）
import { apiGet, apiPost, getToken, getLoginUser, saveSession, clearSession, redirectToLogin } from './api.js';
import { h } from './ui.js';

// 管理者のみ「ユーザマスタ」メニューを表示する（要件「Adminロールの場合のみユーザマスタメニューを表示する」）
// 表示の切り替えのみで、権限の判定はサーバ側（/api/usr の requireAdmin）で行う
function renderAdminMenu(user) {
  const list = document.querySelector('.site-header .nav-list');
  if (!list) return;
  const existing = list.querySelector('[data-admin-menu]');
  if (user.role === 'admin') {
    if (!existing) {
      list.append(h('li', { 'data-admin-menu': true }, h('a', { href: '/users.html', text: 'ユーザマスタ' })));
    }
  } else if (existing) {
    existing.remove();
  }
}

// ヘッダーにログインユーザ名とログアウトボタンを表示する
function renderHeaderUser(user) {
  if (!user) return;
  renderAdminMenu(user);
  const area = document.getElementById('header-user');
  if (!area) return;
  const logoutButton = h('button', { type: 'button', className: 'btn btn-small btn-header', text: 'ログアウト' });
  logoutButton.addEventListener('click', logout);
  area.replaceChildren(h('span', { className: 'header-user-name', text: `${user.user_name ?? user.user_id} さん` }), logoutButton);
  area.hidden = false;
}

// ログイン確認。トークンがない場合は false を返し、ログイン画面へ遷移する
export function requireLogin() {
  if (!getToken()) {
    redirectToLogin();
    return false;
  }
  renderHeaderUser(getLoginUser());
  apiGet('/validatetoken')
    .then((data) => {
      if (data && data.user) {
        saveSession(getToken(), data.user);
        renderHeaderUser(data.user);
      }
    })
    // 401 は api.js がログイン画面へ遷移させる。通信エラー等は各画面の API 呼び出し側で表示されるため無視する
    .catch(() => {});
  return true;
}

// ログアウト：サーバ側のトークンを無効化し、失敗しても手元のトークンは消してログイン画面へ
export async function logout() {
  try {
    await apiPost('/logout', undefined, { redirectOn401: false });
  } catch {
    // 期限切れ・通信エラーでもログアウト扱いにする
  }
  clearSession();
  window.location.replace('/login.html');
}
