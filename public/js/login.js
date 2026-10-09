// ログイン画面
// ユーザID・パスワードで /api/login を呼び、受け取ったトークンを localStorage に保管して元の画面（既定はトップ）へ遷移する。
import { apiPost, saveSession, clearSession } from './api.js';
import { showMessage, hideMessage, clearFieldErrors, showFieldErrors } from './ui.js';

const form = document.getElementById('login-form');
const message = document.getElementById('page-message');
const submitButton = document.getElementById('login-button');

// ログイン後の既定の遷移先
const DEFAULT_NEXT = '/index.html';

// 制御文字（タブ・改行など）。URL の解析時に除去されるため、/<TAB>/evil.example.com が
// //evil.example.com（外部サイト）として扱われる迂回に使われる
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

// ログイン後の遷移先。オープンリダイレクトを防ぐため、同一オリジンのパスのみ許可する
//   1. 文字列のチェック（多層防御）：/ で始まり、// や /\ で始まらず、制御文字を含まないこと
//      （javascript: や form.html のような相対パスはここで拒否する）
//   2. ブラウザと同じ規則で URL として解析し、オリジンが現在の画面と同じであること
//   許可した場合も解析後の pathname + search + hash を返す（解析前の文字列はそのまま使わない）
function nextPath() {
  const next = new URLSearchParams(window.location.search).get('next');
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) {
    return DEFAULT_NEXT;
  }
  if (CONTROL_CHARS.test(next)) return DEFAULT_NEXT;

  let url;
  try {
    url = new URL(next, window.location.origin);
  } catch {
    return DEFAULT_NEXT;
  }
  if (url.origin !== window.location.origin) return DEFAULT_NEXT;
  return url.pathname + url.search + url.hash;
}

// ログイン画面を開いた時点で古いトークンは破棄する
clearSession();

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideMessage(message);
  clearFieldErrors(form);

  const userId = form.elements.user_id.value;
  const password = form.elements.password.value;
  const missing = [];
  if (userId.trim() === '') missing.push({ field: 'user_id', message: 'ユーザIDを入力してください' });
  if (password === '') missing.push({ field: 'password', message: 'パスワードを入力してください' });
  if (missing.length > 0) {
    showFieldErrors(form, missing);
    showMessage(message, 'error', '入力内容に誤りがあります');
    return;
  }

  submitButton.disabled = true;
  try {
    const data = await apiPost('/login', { user_id: userId.trim(), password }, { redirectOn401: false });
    saveSession(data.token, data.user);
    window.location.replace(nextPath());
  } catch (err) {
    form.elements.password.value = '';
    showMessage(message, 'error', err.message);
    form.elements.password.focus();
  } finally {
    submitButton.disabled = false;
  }
});
