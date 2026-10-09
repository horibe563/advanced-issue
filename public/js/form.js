// 商品登録・入出庫登録（フォーム画面）
//   - 商品登録：POST /api/products（初期在庫 > 0 なら初期入庫伝票が自動で作られる）
//   - 入出庫登録：POST /api/stockinout（新規伝票 / 訂正伝票を切り替え）
//   - 同じページの「在庫状況（簡易）」「直近の入出庫履歴」は送信成功時に自動で更新する
// 送信ルール：数値の項目は JSON の number で送る（API は "10" のような文字列を 400 にする）。
//             空欄の任意項目は送らない。
import { apiGet, apiPost } from './api.js';
import { requireLogin } from './auth.js';
import {
  h,
  formatNumber,
  todayString,
  showMessage,
  hideMessage,
  clearFieldErrors,
  showFieldErrors,
  showApiError,
  setBusy,
  onPageReactivate,
  createLatestGuard,
} from './ui.js';
import { TYPE_LABELS, SLIP_FLAG_LABELS, label, formatDelta, stockBadge, emptyRow } from './format.js';

// ログイン確認（トークンがなければログイン画面へ遷移する）
requireLogin();

const MINI_STOCK_LIMIT = 100;
const RECENT_LIMIT = 20;

const els = {
  message: document.getElementById('page-message'),
  productForm: document.getElementById('product-form'),
  productSubmit: document.getElementById('product-submit'),
  stockForm: document.getElementById('stock-form'),
  stockSubmit: document.getElementById('stock-submit'),
  correctionNote: document.getElementById('correction-note'),
  dateLabelNote: document.getElementById('s-date-label-note'),
  dateInput: document.getElementById('s-date'),
  janList: document.getElementById('jan-list'),
  miniStockBody: document.getElementById('mini-stock-body'),
  miniStockSummary: document.getElementById('mini-stock-summary'),
  miniStockReload: document.getElementById('mini-stock-reload'),
  recentBody: document.getElementById('recent-body'),
  recentSummary: document.getElementById('recent-summary'),
  recentReload: document.getElementById('recent-reload'),
};

// 商品登録の項目（文字列・数値）
const PRODUCT_STRING_FIELDS = [
  'jan_cd',
  'product_name',
  'product_spec',
  'product_name_kana',
  'generic_item1',
  'generic_item2',
  'generic_item3',
];
const PRODUCT_NUMBER_FIELDS = ['stock', 'threshold'];

// 入出庫登録で送る項目（モードごと）
const STOCK_FIELDS = {
  new: { strings: ['type', 'jan_cd', 'date'], numbers: ['quantity'] },
  correction: { strings: ['type', 'date'], numbers: ['slip_no', 'quantity', 'slip_flag'] },
};

// ---- 入力値の取り出し ----

// フォームから送信用のオブジェクトを作る
//   文字列：前後の空白を除き、空なら送らない
//   数値  ：空なら送らない。入力があれば Number に変換する（整数かどうか等の検証は API に任せる）
// 戻り値の errors は画面側で判定できる誤り（数値欄に数値として読めない値が入っている）
function collect(form, { strings, numbers }) {
  const body = {};
  const errors = [];
  for (const name of strings) {
    const value = form.elements.namedItem(name).value.trim();
    if (value !== '') body[name] = value;
  }
  for (const name of numbers) {
    const input = form.elements.namedItem(name);
    // type="number" の欄に数値として解釈できない文字があるとブラウザは value を空にするため、validity で判定する
    if (input.validity && input.validity.badInput) {
      errors.push({ field: name, message: '数値を入力してください' });
      continue;
    }
    const value = input.value.trim();
    if (value === '') continue;
    const num = Number(value);
    if (!Number.isFinite(num)) {
      errors.push({ field: name, message: '数値を入力してください' });
      continue;
    }
    body[name] = num;
  }
  return { body, errors };
}

// 画面側で見つけた誤りを API の 400 と同じ形で表示する
function showClientErrors(form, errors) {
  const unmatched = showFieldErrors(form, errors);
  showMessage(
    els.message,
    'error',
    '入力内容に誤りがあります（強調表示した項目を確認してください）',
    unmatched.map((d) => d.message)
  );
}

// ---- 一覧（同じページ） ----

const miniGuard = createLatestGuard();
const recentGuard = createLatestGuard();

// 在庫状況（簡易）。JAN の入力候補（datalist）もここで更新する
async function loadMiniStock() {
  const id = miniGuard.next();
  els.miniStockSummary.textContent = '読み込み中…';
  try {
    const data = await apiGet('/products', { limit: MINI_STOCK_LIMIT });
    if (!miniGuard.isLatest(id)) return;
    if (data.items.length === 0) {
      emptyRow(els.miniStockBody, 5, '商品はまだ登録されていません');
    } else {
      els.miniStockBody.replaceChildren(
        ...data.items.map((p) =>
          h(
            'tr',
            { className: p.is_alert ? 'row-alert' : '' },
            h('td', {}, stockBadge(p.is_alert)),
            h('td', { className: 'mono', text: p.jan_cd }),
            h('td', { text: p.product_name }),
            h('td', { className: 'num stock', text: formatNumber(p.stock) }),
            h('td', { className: 'num', text: formatNumber(p.threshold) })
          )
        )
      );
    }
    els.miniStockSummary.textContent =
      data.total > data.count
        ? `全 ${formatNumber(data.total)} 件のうち JAN 順に ${formatNumber(data.count)} 件を表示（すべては在庫状況画面で確認できます）`
        : `全 ${formatNumber(data.total)} 件`;
    // JAN の入力候補（option の value / label も DOM プロパティで設定する）
    els.janList.replaceChildren(
      ...data.items.map((p) => {
        const option = document.createElement('option');
        option.value = p.jan_cd;
        option.label = p.product_name;
        return option;
      })
    );
  } catch (err) {
    if (!miniGuard.isLatest(id)) return;
    els.miniStockSummary.textContent = '在庫状況を取得できませんでした';
    await showApiError(err, { messageEl: els.message });
  }
}

// 直近の入出庫履歴
async function loadRecent() {
  const id = recentGuard.next();
  els.recentSummary.textContent = '読み込み中…';
  try {
    const data = await apiGet('/stockinout', { limit: RECENT_LIMIT });
    if (!recentGuard.isLatest(id)) return;
    if (data.items.length === 0) {
      emptyRow(els.recentBody, 9, '入出庫履歴はまだありません');
    } else {
      els.recentBody.replaceChildren(
        ...data.items.map((item) =>
          h(
            'tr',
            { className: item.slip_flag === 2 ? 'row-correction' : '' },
            h('td', { text: item.date }),
            h('td', { text: label(TYPE_LABELS, item.type) }),
            h('td', { className: 'mono', text: item.slip_no }),
            h('td', { className: 'num', text: item.slip_seq }),
            h('td', { className: 'mono', text: item.jan_cd }),
            h('td', { text: item.product_name }),
            h('td', { text: label(SLIP_FLAG_LABELS, item.slip_flag) }),
            h('td', { className: 'num', text: formatNumber(item.quantity) }),
            h('td', {
              className: `num ${item.stock_delta < 0 ? 'delta-minus' : 'delta-plus'}`,
              text: formatDelta(item.stock_delta),
            })
          )
        )
      );
    }
    els.recentSummary.textContent = `新しい順に ${formatNumber(data.count)} 件（全 ${formatNumber(data.total)} 件）`;
  } catch (err) {
    if (!recentGuard.isLatest(id)) return;
    els.recentSummary.textContent = '入出庫履歴を取得できませんでした';
    await showApiError(err, { messageEl: els.message });
  }
}

function reloadLists() {
  return Promise.all([loadMiniStock(), loadRecent()]);
}

// ---- 商品登録 ----

els.productForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideMessage(els.message);
  clearFieldErrors(els.productForm);

  const { body, errors } = collect(els.productForm, {
    strings: PRODUCT_STRING_FIELDS,
    numbers: PRODUCT_NUMBER_FIELDS,
  });
  if (errors.length > 0) {
    showClientErrors(els.productForm, errors);
    return;
  }

  setBusy(els.productSubmit, true, '登録中…');
  try {
    const created = await apiPost('/products', body);
    const items = [];
    if (created.initial_slip_no !== null && created.initial_slip_no !== undefined) {
      items.push(`初期入庫伝票（伝票NO: ${created.initial_slip_no}、数量: ${formatNumber(created.stock)}）を作成しました`);
    }
    if (created.is_alert) items.push('在庫数が閾値を下回っているため、在庫状況では「在庫不足」と表示されます');
    showMessage(els.message, 'success', `商品「${created.product_name}」（JAN: ${created.jan_cd}）を登録しました`, items);
    els.productForm.reset();
    els.productForm.elements.namedItem('jan_cd').focus();
    await reloadLists();
  } catch (err) {
    await showApiError(err, { messageEl: els.message, form: els.productForm });
  } finally {
    setBusy(els.productSubmit, false);
  }
});

els.productForm.addEventListener('reset', () => {
  clearFieldErrors(els.productForm);
});

// ---- 入出庫登録 ----

function currentMode() {
  return els.stockForm.elements.namedItem('mode').value === 'correction' ? 'correction' : 'new';
}

// 新規 / 訂正 の切り替え（対象外の欄は hidden 属性で隠し、送信もしない）
function applyMode() {
  const mode = currentMode();
  for (const el of els.stockForm.querySelectorAll('[data-mode]')) {
    el.hidden = el.dataset.mode !== mode;
  }
  els.correctionNote.hidden = mode !== 'correction';
  els.dateLabelNote.textContent = mode === 'correction' ? '任意（省略時は当日）' : '省略時は当日';
  clearFieldErrors(els.stockForm);
}

els.stockForm.addEventListener('change', (e) => {
  if (e.target.name === 'mode') applyMode();
});

els.stockForm.addEventListener('reset', () => {
  // reset イベントは値が戻る前に発生するため、戻った後でモードの表示を合わせる
  setTimeout(applyMode, 0);
});

els.stockForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideMessage(els.message);
  clearFieldErrors(els.stockForm);

  const mode = currentMode();
  const { body, errors } = collect(els.stockForm, STOCK_FIELDS[mode]);
  // API は slip_no がないと新規伝票として扱い「jan_cd は必須」を返すが、訂正モードでは JAN 欄を隠しているため
  // 利用者に分かるよう、伝票NO の未入力は画面側で止める
  if (mode === 'correction' && body.slip_no === undefined && !errors.some((d) => d.field === 'slip_no')) {
    errors.push({ field: 'slip_no', message: '訂正する伝票の伝票NOを入力してください' });
  }
  if (errors.length > 0) {
    showClientErrors(els.stockForm, errors);
    return;
  }

  setBusy(els.stockSubmit, true, '登録中…');
  try {
    const result = await apiPost('/stockinout', body);
    const kind = label(TYPE_LABELS, result.type);
    const title =
      mode === 'correction'
        ? `${kind}伝票（伝票NO: ${result.slip_no}）の訂正を登録しました（SEQ: ${result.slip_seq}）`
        : `${kind}伝票を登録しました（伝票NO: ${result.slip_no}）`;
    const items = [
      `${result.product.product_name}（JAN: ${result.product.jan_cd}）の在庫数: ${formatNumber(result.product.stock)}（${formatDelta(result.stock_delta)}）`,
    ];
    if (result.product.is_alert) {
      items.push(`在庫数が閾値（${formatNumber(result.product.threshold)}）を下回っています`);
    }
    showMessage(els.message, result.product.is_alert ? 'warning' : 'success', title, items);
    // 続けて登録しやすいよう、種別・JAN・日付は残して数量だけ消す
    els.stockForm.elements.namedItem('quantity').value = '';
    await reloadLists();
  } catch (err) {
    await showApiError(err, {
      messageEl: els.message,
      form: els.stockForm,
      // 在庫不足などの 409 は、在庫数が他の操作で変わっている可能性があるため一覧を最新にする
      onConflict: async () => {
        await reloadLists();
        return '最新の在庫状況・履歴を再読み込みしました。内容を確認してから、もう一度操作してください';
      },
    });
  } finally {
    setBusy(els.stockSubmit, false);
  }
});

// ---- 初期化 ----

// 日付の初期値は当日（「入力をクリア」でも当日に戻る）
els.dateInput.defaultValue = todayString();
els.dateInput.value = els.dateInput.defaultValue;

// 在庫状況画面の「入出庫」リンクから来た場合は JAN を入れておく
const janParam = new URLSearchParams(window.location.search).get('jan_cd');
if (janParam && /^(\d{8}|\d{13})$/.test(janParam)) {
  els.stockForm.elements.namedItem('jan_cd').value = janParam;
  els.stockForm.elements.namedItem('quantity').focus();
}

els.miniStockReload.addEventListener('click', () => loadMiniStock());
els.recentReload.addEventListener('click', () => loadRecent());

// 他の画面から戻ったとき・フォーカスが戻ったときも一覧を最新にする
onPageReactivate(reloadLists);

applyMode();
reloadLists();
