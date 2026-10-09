// 画面共通の DOM 操作・メッセージ表示
// XSS 対策：API から返った文字列は必ず textContent / createTextNode で表示し、innerHTML は使わない。

// 要素を作る小さなヘルパー
//   attrs.className / attrs.text（textContent）/ attrs.dataset / その他は setAttribute
//   children は文字列（テキストノードになる）または Node
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className') el.className = value;
    else if (key === 'text') el.textContent = String(value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// 数値を3桁区切りで表示する
export function formatNumber(value) {
  return typeof value === 'number' ? value.toLocaleString('ja-JP') : String(value ?? '');
}

// 今日の日付（ブラウザのローカル時刻）を YYYY-MM-DD で返す
export function todayString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// メッセージ領域に表示する
//   type: 'success' | 'error' | 'warning' | 'info'
//   items: 箇条書きで添える文字列の配列（任意）
export function showMessage(el, type, text, items = []) {
  el.replaceChildren();
  el.className = `message message-${type}`;
  // エラーは読み上げを優先させる
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.append(h('p', { text }));
  if (items.length > 0) {
    el.append(h('ul', {}, items.map((item) => h('li', { text: item }))));
  }
  el.hidden = false;
  if (type === 'error' || type === 'warning') {
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

// メッセージ領域を消す
export function hideMessage(el) {
  el.replaceChildren();
  el.hidden = true;
}

// フォーム内の項目別エラー表示をすべて消す
export function clearFieldErrors(form) {
  for (const control of form.querySelectorAll('.is-invalid')) {
    control.classList.remove('is-invalid');
    control.removeAttribute('aria-invalid');
  }
  for (const errEl of form.querySelectorAll('[data-error-for]')) {
    errEl.replaceChildren();
    errEl.hidden = true;
  }
}

// 項目に対応する入力欄とエラー表示欄を探す（非表示の欄は対象外）
function findField(form, field) {
  if (field === '') return null;
  const errEl = form.querySelector(`[data-error-for="${CSS.escape(field)}"]`);
  const control = form.querySelector(`[name="${CSS.escape(field)}"]`);
  if (!errEl || !control || control.closest('[hidden]')) return null;
  return { control, errEl };
}

// API の details（[{ field, message }]）を各入力欄の近くに表示し、欄を強調する
// 対応する欄が見つからなかった details を返す（呼び出し側で画面上部に表示する）
export function showFieldErrors(form, details) {
  const unmatched = [];
  let firstControl = null;
  for (const { field, message } of details) {
    const found = findField(form, field);
    if (!found) {
      unmatched.push({ field, message });
      continue;
    }
    found.control.classList.add('is-invalid');
    found.control.setAttribute('aria-invalid', 'true');
    found.errEl.append(h('span', { className: 'field-error-text', text: message }));
    found.errEl.hidden = false;
    if (!firstControl) firstControl = found.control;
  }
  // 最初の誤りの欄にフォーカスして修正しやすくする
  if (firstControl) firstControl.focus();
  return unmatched;
}

// API エラーを画面に表示する共通処理
//   messageEl  : 画面上部などのメッセージ領域
//   form       : 400 の details を欄ごとに表示するフォーム（任意）
//   onConflict : 409 のときの追加処理（任意。戻り値の文字列を案内として添える）
export async function showApiError(err, { messageEl, form, onConflict } = {}) {
  // ApiError 以外（画面側のバグなど）は内部情報を出さずに汎用メッセージにする
  if (!err || err.name !== 'ApiError') {
    console.error(err);
    showMessage(messageEl, 'error', '予期しないエラーが発生しました。画面を再読み込みしてください');
    return;
  }

  if (err.kind === 'network' || err.kind === 'parse') {
    showMessage(messageEl, 'error', err.message);
    return;
  }

  if (err.status === 400) {
    const unmatched = form ? showFieldErrors(form, err.details) : err.details;
    const items = unmatched.map((d) => (d.field ? `${d.field}: ${d.message}` : d.message));
    const matchedCount = err.details.length - unmatched.length;
    const text = matchedCount > 0 ? `${err.message}（強調表示した項目を確認してください）` : err.message;
    showMessage(messageEl, 'error', text, items);
    return;
  }

  if (err.status === 409 && onConflict) {
    const guide = await onConflict(err);
    showMessage(messageEl, 'error', err.message, guide ? [guide] : []);
    return;
  }

  // 404 / 409 / 413 / 500 など：API の error メッセージをそのまま表示する
  showMessage(messageEl, 'error', `${err.message}（HTTP ${err.status}）`);
}

// 送信中はボタンを無効にして二重送信を防ぐ
export function setBusy(button, busy, busyLabel = '送信中…') {
  if (busy) {
    if (button.dataset.label === undefined) button.dataset.label = button.textContent;
    button.textContent = busyLabel;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  } else {
    if (button.dataset.label !== undefined) {
      button.textContent = button.dataset.label;
      delete button.dataset.label;
    }
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

// 他の画面から戻ったとき・画面にフォーカスが戻ったときに callback を呼ぶ
// （focus と visibilitychange が続けて発生するため、短時間の重複呼び出しはまとめる）
export function onPageReactivate(callback, minIntervalMs = 1000) {
  let last = 0;
  const run = () => {
    const now = Date.now();
    if (now - last < minIntervalMs) return;
    last = now;
    callback();
  };
  // ブラウザの「戻る」でキャッシュから復元された場合
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) run();
  });
  window.addEventListener('focus', run);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') run();
  });
  // 初回の読み込み直後に focus が来ても二重に取得しないよう、起点の時刻を記録しておく
  last = Date.now();
}

// 同じ一覧の取得が重なったとき、古い応答で新しい表示を上書きしないための連番
export function createLatestGuard() {
  let seq = 0;
  return {
    next() {
      seq += 1;
      return seq;
    },
    isLatest(id) {
      return id === seq;
    },
  };
}
