// 在庫状況（一覧画面）
//   - GET /api/products で一覧を表示（商品名・カナで検索、アラートのみ表示の切り替え、100件ずつのページング）
//   - 在庫数 < 閾値（is_alert）の行は色・バッジ「在庫不足」で強調する
//   - 「履歴」ボタンで GET /api/stockinout?jan_cd=... を子画面（dialog）に表示する（表示のみ）
//   - 「削除」ボタンで確認のうえ DELETE /api/products/:jan_cd?update_seq=N（論理削除・楽観ロック）
//   - form.html から戻ったとき・画面にフォーカスが戻ったときに一覧を自動で再取得する
//   - 上部の「在庫アラート」カードに GET /api/products/alerts（不足数の大きい順）を表示し、一覧と同じタイミングで更新する
//   - 「CSV出力」ボタンで GET /api/products/export（現在の検索条件）を取得してファイルとして保存する
import { apiGet, apiDelete, apiDownload } from './api.js';
import { requireLogin } from './auth.js';
import {
  h,
  formatNumber,
  showMessage,
  hideMessage,
  clearFieldErrors,
  showApiError,
  setBusy,
  onPageReactivate,
  createLatestGuard,
} from './ui.js';
import { TYPE_LABELS, SLIP_FLAG_LABELS, label, formatDelta, stockBadge, emptyRow } from './format.js';

// ログイン確認（トークンがなければログイン画面へ遷移する）
requireLogin();

const PAGE_SIZE = 100;
const PRODUCT_COLUMNS = 7;
const HISTORY_COLUMNS = 8;
const HISTORY_LIMIT = 1000; // API の上限
const ALERT_LIMIT = 100; // 在庫アラートに表示する最大件数
const REVOKE_DELAY_MS = 10000; // CSV のダウンロード用 URL を解放するまでの時間（保存の開始前に解放しないよう余裕を持たせる）

const els = {
  message: document.getElementById('page-message'),
  searchForm: document.getElementById('search-form'),
  searchButton: document.getElementById('search-button'),
  searchClear: document.getElementById('search-clear'),
  alertOnly: document.getElementById('search-alert-only'),
  reload: document.getElementById('reload-button'),
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
  exportButton: document.getElementById('export-button'),
};

// 画面の状態
const state = {
  // 検索ボタンを押した時点の条件（入力途中の値で自動更新しないよう分けて持つ）
  query: { product_name: '', product_name_kana: '' },
  offset: 0,
  total: 0,
  // 表示中の商品（削除時の update_seq 参照用）。JAN → 商品
  items: new Map(),
};

const listGuard = createLatestGuard();
const historyGuard = createLatestGuard();
const alertGuard = createLatestGuard();

// 一覧の検索条件（検索ボタンで確定した条件 + 在庫不足のみ表示）。一覧・CSV出力で共通
function currentSearchQuery() {
  return {
    product_name: state.query.product_name,
    product_name_kana: state.query.product_name_kana,
    alert: els.alertOnly.checked ? 'true' : undefined,
  };
}

// 一覧を取得して表示する
async function loadProducts() {
  const id = listGuard.next();
  clearFieldErrors(els.searchForm);
  els.summary.textContent = '読み込み中…';
  try {
    const data = await apiGet('/products', {
      ...currentSearchQuery(),
      limit: PAGE_SIZE,
      offset: state.offset,
    });
    if (!listGuard.isLatest(id)) return;

    // 削除などで現在のページが空になった場合は前のページに戻る
    if (data.items.length === 0 && state.offset > 0 && data.total > 0) {
      state.offset = Math.max(0, Math.floor((data.total - 1) / PAGE_SIZE) * PAGE_SIZE);
      await loadProducts();
      return;
    }
    renderProducts(data);
  } catch (err) {
    if (!listGuard.isLatest(id)) return;
    els.summary.textContent = '一覧を取得できませんでした';
    await showApiError(err, { messageEl: els.message, form: els.searchForm });
  }
}

// 一覧の描画（文字列はすべて textContent で表示する）
function renderProducts(data) {
  state.total = data.total;
  state.items = new Map(data.items.map((p) => [p.jan_cd, p]));

  if (data.items.length === 0) {
    emptyRow(els.body, PRODUCT_COLUMNS, '該当する商品はありません');
  } else {
    els.body.replaceChildren(...data.items.map(productRow));
  }

  const alertCount = data.items.filter((p) => p.is_alert).length;
  const filterNote = els.alertOnly.checked ? '（在庫不足のみ表示中）' : '';
  els.summary.textContent =
    `全 ${formatNumber(data.total)} 件${filterNote}` + (alertCount > 0 ? ` / このページの在庫不足: ${alertCount} 件` : '');

  const from = data.total === 0 ? 0 : state.offset + 1;
  const to = state.offset + data.items.length;
  els.pageInfo.textContent = `${formatNumber(from)}〜${formatNumber(to)} 件目`;
  els.prev.disabled = state.offset === 0;
  els.next.disabled = to >= data.total;
}

// 商品1行分
function productRow(p) {
  const tr = h(
    'tr',
    { className: p.is_alert ? 'row-alert' : '' },
    h('td', {}, stockBadge(p.is_alert)),
    h('td', { className: 'mono', text: p.jan_cd }),
    h(
      'td',
      {},
      h('span', { className: 'product-name', text: p.product_name }),
      p.product_name_kana ? h('span', { className: 'kana', text: p.product_name_kana }) : null
    ),
    h('td', { text: p.product_spec ?? '' }),
    h('td', { className: 'num stock', text: formatNumber(p.stock) }),
    h('td', { className: 'num', text: formatNumber(p.threshold) }),
    h(
      'td',
      {},
      h(
        'div',
        { className: 'row-actions' },
        h('button', {
          type: 'button',
          className: 'btn btn-small',
          dataset: { action: 'history', jan: p.jan_cd },
          'aria-label': `${p.product_name} の入出庫履歴を表示`,
          text: '履歴',
        }),
        h('a', {
          className: 'btn btn-small',
          href: `/form.html?jan_cd=${encodeURIComponent(p.jan_cd)}#stock-section`,
          'aria-label': `${p.product_name} の入出庫を登録`,
          text: '入出庫',
        }),
        h('button', {
          type: 'button',
          className: 'btn btn-small btn-danger',
          dataset: { action: 'delete', jan: p.jan_cd },
          'aria-label': `${p.product_name} を削除`,
          text: '削除',
        })
      )
    )
  );
  return tr;
}

// 在庫アラートを取得して表示する（エラーはカード内に表示し、一覧の表示は妨げない）
async function loadAlerts() {
  const id = alertGuard.next();
  try {
    const data = await apiGet('/products/alerts', { limit: ALERT_LIMIT });
    if (!alertGuard.isLatest(id)) return;
    hideMessage(els.alertMessage);
    renderAlerts(data);
  } catch (err) {
    if (!alertGuard.isLatest(id)) return;
    els.alertSummary.textContent = '在庫アラートを取得できませんでした';
    els.alertTableWrap.hidden = true;
    els.alertMore.hidden = true;
    await showApiError(err, { messageEl: els.alertMessage });
  }
}

// 在庫アラートの描画（文字列はすべて textContent で表示する）
function renderAlerts(data) {
  if (data.total === 0 || data.items.length === 0) {
    els.alertSummary.textContent = '閾値を下回っている商品はありません';
    els.alertBody.replaceChildren();
    els.alertTableWrap.hidden = true;
    els.alertMore.hidden = true;
    return;
  }

  els.alertSummary.textContent = `閾値を下回っている商品：${formatNumber(data.total)}件`;
  els.alertBody.replaceChildren(...data.items.map(alertRow));
  els.alertTableWrap.hidden = false;

  // 表示しきれない分は「在庫不足のみ表示」の一覧で確認してもらう
  const rest = data.total - data.items.length;
  if (rest > 0) {
    els.alertMore.textContent = `ほか ${formatNumber(rest)} 件あります。「在庫不足（アラート）の商品のみ表示」で確認できます`;
    els.alertMore.hidden = false;
  } else {
    els.alertMore.hidden = true;
  }
}

// 在庫アラート1行分（不足数 = 閾値 − 在庫数）
function alertRow(p) {
  return h(
    'tr',
    { className: 'row-alert' },
    h('td', { className: 'mono', text: p.jan_cd }),
    h(
      'td',
      {},
      h('span', { className: 'product-name', text: p.product_name }),
      p.product_name_kana ? h('span', { className: 'kana', text: p.product_name_kana }) : null
    ),
    h('td', { text: p.product_spec ?? '' }),
    h('td', { className: 'num stock', text: formatNumber(p.stock) }),
    h('td', { className: 'num', text: formatNumber(p.threshold) }),
    h('td', { className: 'num shortage', text: formatNumber(p.shortage) })
  );
}

// 一覧と在庫アラートをまとめて最新にする
function reloadAll() {
  loadProducts();
  loadAlerts();
}

// Blob をファイルとして保存する（a[download] をクリックしてブラウザの保存を開始する）
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: filename, hidden: true });
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // 保存の開始前に解放されないよう、少し待ってから URL を解放する
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
}

// CSV出力（現在の検索条件で全件。認証ヘッダーが必要なため fetch → Blob で受け取る）
async function exportCsv() {
  hideMessage(els.message);
  clearFieldErrors(els.searchForm);
  setBusy(els.exportButton, true, '出力中…');
  try {
    const { blob, filename } = await apiDownload('/products/export', currentSearchQuery());
    saveBlob(blob, filename);
    showMessage(els.message, 'success', `CSVファイル（${filename}）を出力しました`);
  } catch (err) {
    // 400（件数上限超過・条件の誤り）・429（同時実行の上限）・503（タイムアウト）などは画面上部に表示する
    await showApiError(err, { messageEl: els.message, form: els.searchForm });
  } finally {
    setBusy(els.exportButton, false);
  }
}

// 商品の削除（確認 → DELETE。409 は楽観ロックの不一致として一覧を再取得する）
async function deleteProduct(button, product) {
  const ok = window.confirm(
    `商品「${product.product_name}」（JAN: ${product.jan_cd}）を削除しますか？\n削除した商品は一覧に表示されなくなり、同じ JAN では再登録できません。`
  );
  if (!ok) return;

  setBusy(button, true, '削除中…');
  try {
    await apiDelete(`/products/${encodeURIComponent(product.jan_cd)}`, { update_seq: product.update_seq });
    showMessage(els.message, 'success', `商品「${product.product_name}」を削除しました`);
    await loadProducts();
  } catch (err) {
    await showApiError(err, {
      messageEl: els.message,
      onConflict: async () => {
        await loadProducts();
        return '一覧を再読み込みしました。最新の内容を確認してから、もう一度操作してください';
      },
    });
    // 他の人が既に削除していた場合（404）も一覧を最新にする
    if (err && err.status === 404) await loadProducts();
  } finally {
    // 一覧を再描画した場合はボタンが置き換わっているが、残っている場合に備えて戻す
    if (button.isConnected) setBusy(button, false);
    // 削除の成否にかかわらず（他の人の更新を含めて）在庫アラートも最新にする
    loadAlerts();
  }
}

// 入出庫履歴の子画面を開く
async function openHistory(product) {
  const id = historyGuard.next();
  els.historyProduct.textContent = `${product.product_name}（JAN: ${product.jan_cd}） 現在の在庫数: ${formatNumber(product.stock)}`;
  hideMessage(els.historyMessage);
  els.historySummary.textContent = '読み込み中…';
  els.historyBody.replaceChildren();
  if (!els.dialog.open) els.dialog.showModal();

  try {
    const data = await apiGet('/stockinout', { jan_cd: product.jan_cd, limit: HISTORY_LIMIT });
    if (!historyGuard.isLatest(id)) return;
    if (data.items.length === 0) {
      emptyRow(els.historyBody, HISTORY_COLUMNS, '入出庫履歴はありません');
    } else {
      els.historyBody.replaceChildren(...data.items.map(historyRow));
    }
    els.historySummary.textContent =
      data.total > data.count
        ? `全 ${formatNumber(data.total)} 件のうち新しい順に ${formatNumber(data.count)} 件を表示`
        : `全 ${formatNumber(data.total)} 件（新しい順）`;
  } catch (err) {
    if (!historyGuard.isLatest(id)) return;
    els.historySummary.textContent = '';
    await showApiError(err, { messageEl: els.historyMessage });
  }
}

// 履歴1行分
function historyRow(item) {
  return h(
    'tr',
    { className: item.slip_flag === 2 ? 'row-correction' : '' },
    h('td', { text: item.date }),
    h('td', { text: label(TYPE_LABELS, item.type) }),
    h('td', { className: 'mono', text: item.slip_no }),
    h('td', { className: 'num', text: item.slip_seq }),
    h('td', { text: label(SLIP_FLAG_LABELS, item.slip_flag) }),
    h('td', { className: 'num', text: formatNumber(item.quantity) }),
    h('td', { className: `num ${item.stock_delta < 0 ? 'delta-minus' : 'delta-plus'}`, text: formatDelta(item.stock_delta) }),
    h('td', { text: item.created_by ?? '' })
  );
}

// ---- イベント ----

// 検索（送信時のページ遷移を止めて API で再取得する）
els.searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideMessage(els.message);
  const form = new FormData(els.searchForm);
  state.query = {
    product_name: String(form.get('product_name') ?? '').trim(),
    product_name_kana: String(form.get('product_name_kana') ?? '').trim(),
  };
  state.offset = 0;
  setBusy(els.searchButton, true, '検索中…');
  try {
    await loadProducts();
  } finally {
    setBusy(els.searchButton, false);
  }
});

// 条件のクリア
els.searchClear.addEventListener('click', () => {
  els.searchForm.reset();
  hideMessage(els.message);
  state.query = { product_name: '', product_name_kana: '' };
  state.offset = 0;
  loadProducts();
});

// 「アラートのみ表示」は切り替えた時点で反映する
els.alertOnly.addEventListener('change', () => {
  state.offset = 0;
  loadProducts();
});

els.reload.addEventListener('click', () => {
  hideMessage(els.message);
  reloadAll();
});

els.exportButton.addEventListener('click', exportCsv);

els.prev.addEventListener('click', () => {
  state.offset = Math.max(0, state.offset - PAGE_SIZE);
  loadProducts();
});

els.next.addEventListener('click', () => {
  state.offset += PAGE_SIZE;
  loadProducts();
});

// 一覧の各行のボタン（イベント委譲）
els.body.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-action]');
  if (!button) return;
  const product = state.items.get(button.dataset.jan);
  if (!product) return;
  if (button.dataset.action === 'history') openHistory(product);
  if (button.dataset.action === 'delete') deleteProduct(button, product);
});

// 子画面を閉じる（Esc キーでも dialog 標準の動作で閉じる）
els.historyClose.addEventListener('click', () => els.dialog.close());
// 子画面の外側（背景）をクリックしたら閉じる
els.dialog.addEventListener('click', (e) => {
  if (e.target === els.dialog) els.dialog.close();
});

// 他の画面から戻ったとき・フォーカスが戻ったときに一覧と在庫アラートを最新にする（子画面表示中は除く）
onPageReactivate(() => {
  if (!els.dialog.open) reloadAll();
});

reloadAll();
