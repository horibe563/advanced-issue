// ユーザマスタ（管理者のみ）
//   - 初期表示は検索窓のみ（要件）。検索すると GET /api/usr の結果を一覧表示する（ID・氏名の部分一致、100件ずつ）
//   - 「ユーザを登録する」：子画面から POST /api/usr（update_seq なし = 新規登録）
//   - 「パスワード設定」：子画面から POST /api/usr（update_seq あり = 更新。楽観ロック）
//   - 「削除」：確認のうえ DELETE /api/usr/:user_id?update_seq=N（論理削除・楽観ロック）
//   - 自分自身のパスワード変更・削除はサーバ側でトークンが無効になるため、完了後にログイン画面へ遷移する
// 権限の判定はサーバ側（requireAdmin）で行う。画面側の判定は表示の切り替えのためだけに使う。
import { apiGet, apiPost, apiDelete, getLoginUser, clearSession } from './api.js';
import { requireLogin } from './auth.js';
import {
  h,
  formatNumber,
  showMessage,
  hideMessage,
  clearFieldErrors,
  showFieldErrors,
  showApiError,
  setBusy,
  createLatestGuard,
} from './ui.js';
import { label, emptyRow } from './format.js';

const PAGE_SIZE = 100;
const USER_COLUMNS = 5;

// ロールの表示名
export const ROLE_LABELS = { admin: '管理者', general: '一般' };

// 自分自身の操作後にログイン画面へ遷移するまでの待ち時間（メッセージを読めるようにする）
const RELOGIN_DELAY_MS = 2000;

const els = {
  message: document.getElementById('page-message'),
  searchSection: document.getElementById('search-section'),
  searchForm: document.getElementById('search-form'),
  searchButton: document.getElementById('search-button'),
  searchClear: document.getElementById('search-clear'),
  registerOpen: document.getElementById('register-open'),
  resultSection: document.getElementById('result-section'),
  reload: document.getElementById('reload-button'),
  summary: document.getElementById('list-summary'),
  body: document.getElementById('user-body'),
  prev: document.getElementById('prev-page'),
  next: document.getElementById('next-page'),
  pageInfo: document.getElementById('page-info'),
  registerDialog: document.getElementById('register-dialog'),
  registerForm: document.getElementById('register-form'),
  registerSubmit: document.getElementById('register-submit'),
  registerMessage: document.getElementById('register-message'),
  passwordDialog: document.getElementById('password-dialog'),
  passwordForm: document.getElementById('password-form'),
  passwordSubmit: document.getElementById('password-submit'),
  passwordMessage: document.getElementById('password-message'),
  passwordTarget: document.getElementById('password-target'),
};

// 画面の状態
const state = {
  // 検索ボタンを押した時点の条件（入力途中の値で自動更新しないよう分けて持つ）
  query: { user_id: '', user_name: '' },
  offset: 0,
  // 表示中のユーザ（update_seq 参照用）。ユーザID → ユーザ
  items: new Map(),
  // パスワード設定の対象ユーザ
  passwordTarget: null,
};

const listGuard = createLatestGuard();

// ログイン中のユーザ自身かどうか
function isSelf(userId) {
  const me = getLoginUser();
  return Boolean(me) && me.user_id === userId;
}

// 管理者以外が開いた場合（または API が 403 を返した場合）は操作部分を隠して案内する
function showForbidden() {
  els.searchSection.hidden = true;
  els.resultSection.hidden = true;
  if (els.registerDialog.open) els.registerDialog.close();
  if (els.passwordDialog.open) els.passwordDialog.close();
  showMessage(els.message, 'error', 'ユーザマスタは管理者のみ利用できます', ['在庫状況画面に戻って操作してください']);
}

// 自分自身のトークンが無効になった後、ログイン画面へ遷移する
function reloginLater() {
  clearSession();
  setTimeout(() => window.location.replace('/login.html'), RELOGIN_DELAY_MS);
}

// API エラーの表示（403 は権限なしの案内に切り替える）
async function handleError(err, options) {
  if (err && err.name === 'ApiError' && err.status === 403) {
    showForbidden();
    return;
  }
  await showApiError(err, options);
}

// 日時（ISO 文字列）をローカル時刻で表示する
export function formatDateTime(value) {
  if (typeof value !== 'string' || value === '') return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
}

// ---- 一覧 ----

// 一覧を取得して表示する
async function loadUsers() {
  const id = listGuard.next();
  clearFieldErrors(els.searchForm);
  els.resultSection.hidden = false;
  els.summary.textContent = '読み込み中…';
  try {
    const data = await apiGet('/usr', {
      user_id: state.query.user_id,
      user_name: state.query.user_name,
      limit: PAGE_SIZE,
      offset: state.offset,
    });
    if (!listGuard.isLatest(id)) return;

    // 削除などで現在のページが空になった場合は最後のページに戻る
    if (data.items.length === 0 && state.offset > 0 && data.total > 0) {
      state.offset = Math.floor((data.total - 1) / PAGE_SIZE) * PAGE_SIZE;
      await loadUsers();
      return;
    }
    renderUsers(data);
  } catch (err) {
    if (!listGuard.isLatest(id)) return;
    els.summary.textContent = 'ユーザ一覧を取得できませんでした';
    await handleError(err, { messageEl: els.message, form: els.searchForm });
  }
}

// 一覧の描画（文字列はすべて textContent で表示する）
function renderUsers(data) {
  state.items = new Map(data.items.map((u) => [u.user_id, u]));

  if (data.items.length === 0) {
    emptyRow(els.body, USER_COLUMNS, '該当するユーザはありません');
  } else {
    els.body.replaceChildren(...data.items.map(userRow));
  }

  els.summary.textContent = `全 ${formatNumber(data.total)} 件`;
  const from = data.total === 0 ? 0 : state.offset + 1;
  const to = state.offset + data.items.length;
  els.pageInfo.textContent = `${formatNumber(from)}〜${formatNumber(to)} 件目`;
  els.prev.disabled = state.offset === 0;
  els.next.disabled = to >= data.total;
}

// ユーザ1行分
function userRow(u) {
  const self = isSelf(u.user_id);
  return h(
    'tr',
    {},
    h(
      'td',
      {},
      h('span', { className: 'mono', text: u.user_id }),
      self ? h('span', { className: 'badge badge-self', text: '自分' }) : null
    ),
    h('td', { text: u.user_name ?? '' }),
    h('td', {}, h('span', { className: `badge badge-role-${u.role}`, text: label(ROLE_LABELS, u.role) })),
    h('td', { text: formatDateTime(u.updated_at) }),
    h(
      'td',
      {},
      h(
        'div',
        { className: 'row-actions' },
        h('button', {
          type: 'button',
          className: 'btn btn-small',
          dataset: { action: 'password', user: u.user_id },
          'aria-label': `${u.user_id} のパスワードを設定`,
          text: 'パスワード設定',
        }),
        h('button', {
          type: 'button',
          className: 'btn btn-small btn-danger',
          dataset: { action: 'delete', user: u.user_id },
          'aria-label': `${u.user_id} を削除`,
          text: '削除',
        })
      )
    )
  );
}

// ---- 削除 ----

// ユーザの削除（確認 → DELETE。409 は楽観ロックの不一致・最後の管理者として一覧を再取得する）
async function deleteUser(button, user) {
  const self = isSelf(user.user_id);
  const lines = [
    `ユーザ「${user.user_name ?? ''}」（ID: ${user.user_id}）を削除しますか？`,
    '削除したユーザはログインできなくなり、同じユーザIDでは再登録できません。',
  ];
  if (self) lines.push('※ ログイン中のあなた自身です。削除するとすぐにログアウトされます。');
  if (!window.confirm(lines.join('\n'))) return;

  setBusy(button, true, '削除中…');
  try {
    await apiDelete(`/usr/${encodeURIComponent(user.user_id)}`, { update_seq: user.update_seq });
    if (self) {
      showMessage(els.message, 'success', `ユーザ「${user.user_id}」（あなた自身）を削除しました`, ['ログイン画面に移動します']);
      reloginLater();
      return;
    }
    showMessage(els.message, 'success', `ユーザ「${user.user_id}」を削除しました`);
    await loadUsers();
  } catch (err) {
    await handleError(err, {
      messageEl: els.message,
      onConflict: async () => {
        await loadUsers();
        return '一覧を再読み込みしました。最新の内容を確認してから、もう一度操作してください';
      },
    });
    // 他の人が既に削除していた場合（404）も一覧を最新にする
    if (err && err.status === 404) await loadUsers();
  } finally {
    if (button.isConnected) setBusy(button, false);
  }
}

// ---- 子画面（登録・パスワード設定）共通 ----

// パスワードと確認欄の一致を確認する（一致しなければ確認欄のエラーを返す）
function checkPasswordConfirm(form) {
  const password = form.elements.namedItem('password').value;
  const confirm = form.elements.namedItem('password_confirm').value;
  if (password !== '' && password !== confirm) {
    return [{ field: 'password_confirm', message: 'パスワードと確認用のパスワードが一致しません' }];
  }
  return [];
}

// 子画面を開く（前回の入力・エラーは消しておく）
function openDialog(dialog, form, messageEl) {
  form.reset();
  clearFieldErrors(form);
  hideMessage(messageEl);
  if (!dialog.open) dialog.showModal();
  const first = form.querySelector('input');
  if (first) first.focus();
}

// 子画面の外側（背景）クリック・「閉じる」「キャンセル」で閉じる。閉じたら入力中のパスワードを消す
for (const [dialog, form] of [
  [els.registerDialog, els.registerForm],
  [els.passwordDialog, els.passwordForm],
]) {
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.closest('[data-close-dialog]')) dialog.close();
  });
  dialog.addEventListener('close', () => form.reset());
}

// ---- 登録 ----

els.registerOpen.addEventListener('click', () => {
  hideMessage(els.message);
  openDialog(els.registerDialog, els.registerForm, els.registerMessage);
});

els.registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideMessage(els.registerMessage);
  clearFieldErrors(els.registerForm);

  const form = els.registerForm.elements;
  // ユーザID・氏名は前後の空白を除く。パスワードは空白もパスワードの一部として扱うため加工しない（API と同じ）
  const body = {
    user_id: form.namedItem('user_id').value.trim(),
    user_name: form.namedItem('user_name').value.trim(),
    role: form.namedItem('role').value,
    password: form.namedItem('password').value,
  };
  // 空欄は送らず、API の「必須です」の案内に任せる
  for (const key of Object.keys(body)) {
    if (body[key] === '') delete body[key];
  }

  const errors = checkPasswordConfirm(els.registerForm);
  if (errors.length > 0) {
    showFieldErrors(els.registerForm, errors);
    showMessage(els.registerMessage, 'error', '入力内容に誤りがあります（強調表示した項目を確認してください）');
    return;
  }

  setBusy(els.registerSubmit, true, '登録中…');
  try {
    const created = await apiPost('/usr', body);
    els.registerDialog.close();
    showMessage(
      els.message,
      'success',
      `ユーザ「${created.user_name ?? ''}」（ID: ${created.user_id}、${label(ROLE_LABELS, created.role)}）を登録しました`
    );
    // 登録したユーザが一覧で確認できるよう、そのユーザIDで検索する
    els.searchForm.reset();
    els.searchForm.elements.namedItem('user_id').value = created.user_id;
    state.query = { user_id: created.user_id, user_name: '' };
    state.offset = 0;
    await loadUsers();
  } catch (err) {
    await handleError(err, { messageEl: els.registerMessage, form: els.registerForm });
  } finally {
    setBusy(els.registerSubmit, false);
  }
});

// ---- パスワード設定 ----

function openPasswordDialog(user) {
  state.passwordTarget = user;
  hideMessage(els.message);
  const note = isSelf(user.user_id) ? '（あなた自身。設定後はログアウトされます）' : '';
  els.passwordTarget.textContent = `対象：${user.user_name ?? ''}（ID: ${user.user_id}）${note}`;
  openDialog(els.passwordDialog, els.passwordForm, els.passwordMessage);
}

els.passwordForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideMessage(els.passwordMessage);
  clearFieldErrors(els.passwordForm);

  const user = state.passwordTarget;
  if (!user) return;
  const password = els.passwordForm.elements.namedItem('password').value;

  const errors =
    password === ''
      ? [{ field: 'password', message: '新しいパスワードを入力してください' }]
      : checkPasswordConfirm(els.passwordForm);
  if (errors.length > 0) {
    showFieldErrors(els.passwordForm, errors);
    showMessage(els.passwordMessage, 'error', '入力内容に誤りがあります（強調表示した項目を確認してください）');
    return;
  }

  setBusy(els.passwordSubmit, true, '設定中…');
  try {
    await apiPost('/usr', { user_id: user.user_id, update_seq: user.update_seq, password });
    els.passwordDialog.close();
    if (isSelf(user.user_id)) {
      showMessage(els.message, 'success', 'あなた自身のパスワードを変更しました', [
        '新しいパスワードで再度ログインしてください。ログイン画面に移動します',
      ]);
      reloginLater();
      return;
    }
    showMessage(els.message, 'success', `ユーザ「${user.user_id}」のパスワードを設定しました`, [
      'このユーザはログアウトされ、次回から新しいパスワードでログインします',
    ]);
    await loadUsers();
  } catch (err) {
    await handleError(err, {
      messageEl: els.passwordMessage,
      form: els.passwordForm,
      onConflict: async () => {
        await loadUsers();
        return '一覧を再読み込みしました。子画面を閉じ、最新の内容でもう一度操作してください';
      },
    });
  } finally {
    setBusy(els.passwordSubmit, false);
  }
});

// ---- 検索・一覧のイベント ----

els.searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideMessage(els.message);
  const form = new FormData(els.searchForm);
  state.query = {
    user_id: String(form.get('user_id') ?? '').trim(),
    user_name: String(form.get('user_name') ?? '').trim(),
  };
  state.offset = 0;
  setBusy(els.searchButton, true, '検索中…');
  try {
    await loadUsers();
  } finally {
    setBusy(els.searchButton, false);
  }
});

// 条件のクリア（初期表示と同じく検索窓のみに戻す）
els.searchClear.addEventListener('click', () => {
  listGuard.next(); // 取得中の応答があっても表示しない
  els.searchForm.reset();
  clearFieldErrors(els.searchForm);
  hideMessage(els.message);
  state.query = { user_id: '', user_name: '' };
  state.offset = 0;
  state.items = new Map();
  els.body.replaceChildren();
  els.resultSection.hidden = true;
});

els.reload.addEventListener('click', () => {
  hideMessage(els.message);
  loadUsers();
});

els.prev.addEventListener('click', () => {
  state.offset = Math.max(0, state.offset - PAGE_SIZE);
  loadUsers();
});

els.next.addEventListener('click', () => {
  state.offset += PAGE_SIZE;
  loadUsers();
});

// 一覧の各行のボタン（イベント委譲）
els.body.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-action]');
  if (!button) return;
  const user = state.items.get(button.dataset.user);
  if (!user) return;
  if (button.dataset.action === 'password') openPasswordDialog(user);
  if (button.dataset.action === 'delete') deleteUser(button, user);
});

// ---- 初期化 ----

// ログイン確認（トークンがなければログイン画面へ遷移する）
if (requireLogin()) {
  const me = getLoginUser();
  // 保管しているログインユーザが管理者でなければ、API を呼ぶ前に案内する
  if (me && me.role !== 'admin') showForbidden();
  else els.searchForm.elements.namedItem('user_id').focus();
}
