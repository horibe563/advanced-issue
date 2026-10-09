// API 通信の共通処理
// すべての画面はこのファイルの apiGet / apiPost / apiDelete（ファイル取得は apiDownload）を経由して /api と通信する。
//
// エラーは必ず ApiError として投げる（呼び出し側は err.kind / err.status で分岐する）
//   kind = 'network' : fetch 自体の失敗（サーバ停止・ネットワーク断・タイムアウト）。status は 0
//   kind = 'http'    : HTTP エラー（res.ok が false）。API の { error, details } を message / details に入れる
//   kind = 'parse'   : 成功ステータスだが本文が JSON として解釈できない
// 204（本文なし）や本文が空の成功応答は null を返す。
//
// 認証：ログイン時に受け取ったアクセストークンを localStorage に保管し（要件）、
// すべてのリクエストに Authorization: Bearer <token> として付ける。
// 401（未ログイン・期限切れ）が返ったらトークンを消してログイン画面へ遷移する。

const API_BASE = '/api';

// localStorage のキー
const TOKEN_KEY = 'inventory.accessToken';
const USER_KEY = 'inventory.loginUser';

// ログイン画面のパス（ログイン後に元の画面へ戻れるよう next を付ける）
const LOGIN_PAGE = '/login.html';

// localStorage はプライベートモード等で例外になり得るため、失敗しても画面を壊さない
function storageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 保存できない場合は次回のリクエストで 401 となり、ログイン画面へ戻る
  }
}

function storageRemove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 何もしない
  }
}

export function getToken() {
  return storageGet(TOKEN_KEY);
}

// ログインユーザ（{ user_id, user_name, role }）。画面表示用で、権限判定はサーバ側で行う
export function getLoginUser() {
  try {
    const user = JSON.parse(storageGet(USER_KEY) ?? 'null');
    return user && typeof user === 'object' ? user : null;
  } catch {
    return null;
  }
}

export function saveSession(token, user) {
  storageSet(TOKEN_KEY, token);
  storageSet(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  storageRemove(TOKEN_KEY);
  storageRemove(USER_KEY);
}

// ログイン画面へ遷移する（現在の画面をログイン後の戻り先にする）
export function redirectToLogin() {
  const here = window.location.pathname + window.location.search;
  const url = new URL(LOGIN_PAGE, window.location.origin);
  if (window.location.pathname !== LOGIN_PAGE) url.searchParams.set('next', here);
  window.location.replace(url.pathname + url.search);
}

// 応答が返らない場合に打ち切るまでの時間（ミリ秒）
const TIMEOUT_MS = 15000;

// API のエラー本文に error がない場合に使うステータス別の既定メッセージ
const DEFAULT_MESSAGES = {
  400: '入力内容に誤りがあります',
  401: 'ログインの有効期限が切れました。再度ログインしてください',
  403: 'この操作を行う権限がありません',
  404: '対象のデータが見つかりません',
  409: '他の操作と競合したため処理できませんでした',
  413: '送信するデータが大きすぎます',
  429: '他の処理が実行中です。しばらく待ってから再度お試しください',
  500: 'サーバー内部でエラーが発生しました',
  503: 'サーバーが混み合っているか、処理に時間がかかりすぎたため中断しました。時間をおいて再度お試しください',
};

// API 通信のエラー
export class ApiError extends Error {
  constructor(message, { status = 0, kind = 'http', details = [] } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
    // 入力エラーの項目別詳細 [{ field, message }]（400 のときのみ）
    this.details = details;
  }
}

// クエリ文字列を組み立てる（undefined / null / 空文字の項目は付けない）
function buildUrl(path, query) {
  const url = new URL(API_BASE + path, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.pathname + url.search;
}

// details を [{ field, message }] の形に揃える（想定外の形でも画面が壊れないようにする）
function normalizeDetails(details) {
  if (!Array.isArray(details)) return [];
  return details
    .filter((d) => d !== null && typeof d === 'object')
    .map((d) => ({ field: String(d.field ?? ''), message: String(d.message ?? '') }));
}

// 送信の共通処理（トークンの付与・タイムアウト・ネットワークエラーの ApiError 化）
//   readBody(res) で本文を読む（本文の読み込みもタイムアウトの対象にする）
//   戻り値は { res, payload }（payload は readBody の結果）
async function send(method, path, { query, body, accept, readBody, timeoutMs = TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const options = {
    method,
    headers: { Accept: accept },
    signal: controller.signal,
  };
  const token = getToken();
  if (token) options.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  try {
    const res = await fetch(buildUrl(path, query), options);
    const payload = await readBody(res);
    return { res, payload };
  } catch (err) {
    // fetch の reject（ネットワークエラー）またはタイムアウトによる中断
    const message =
      err && err.name === 'AbortError'
        ? 'サーバーからの応答がありません（タイムアウト）。時間をおいて再度お試しください'
        : 'サーバーに接続できません。ネットワークの状態を確認してください';
    throw new ApiError(message, { kind: 'network' });
  } finally {
    clearTimeout(timer);
  }
}

// 本文を JSON として解釈する（空の本文は null）
function parseJson(text) {
  if (text === '') return { data: null, parseFailed: false };
  try {
    return { data: JSON.parse(text), parseFailed: false };
  } catch {
    return { data: null, parseFailed: true };
  }
}

// 401 の処理と HTTP エラー（res.ok が false）の ApiError 化
//   data: エラー本文を JSON として解釈した値（{ error, details }。解釈できなければ null）
function throwIfHttpError(res, data, redirectOn401) {
  // 未ログイン・トークン期限切れ：トークンを消してログイン画面へ
  if (res.status === 401 && redirectOn401) {
    clearSession();
    redirectToLogin();
  }

  if (!res.ok) {
    const apiMessage = data && typeof data.error === 'string' && data.error !== '' ? data.error : null;
    const message =
      apiMessage ?? DEFAULT_MESSAGES[res.status] ?? `サーバーとの通信でエラーが発生しました（HTTP ${res.status}）`;
    throw new ApiError(message, {
      status: res.status,
      kind: 'http',
      details: data ? normalizeDetails(data.details) : [],
    });
  }
}

// 共通のリクエスト処理（JSON の API 用）
//   redirectOn401: false にすると 401 でもログイン画面へ遷移せず ApiError を投げる（ログイン API 用）
async function apiRequest(method, path, { query, body, redirectOn401 = true } = {}) {
  // 本文は一度テキストで読み、JSON かどうかを後で判定する（JSON でない応答にも対応するため）
  const { res, payload: text } = await send(method, path, {
    query,
    body,
    accept: 'application/json',
    readBody: (r) => (r.status === 204 ? '' : r.text()),
  });

  const { data, parseFailed } = parseJson(text);
  throwIfHttpError(res, data, redirectOn401);

  // 成功ステータスだが JSON でない応答
  if (parseFailed) {
    throw new ApiError('サーバーの応答を解釈できませんでした', { status: res.status, kind: 'parse' });
  }

  // 204 や本文が空の場合は null
  return data;
}

// GET（query はオブジェクトで指定する）
export function apiGet(path, query) {
  return apiRequest('GET', path, { query });
}

// POST（body は JSON に変換して送る）
//   options.redirectOn401: false で 401 時にログイン画面へ遷移しない
export function apiPost(path, body, options = {}) {
  return apiRequest('POST', path, { body, ...options });
}

// DELETE（成功時は 204 のため null が返る）
export function apiDelete(path, query) {
  return apiRequest('DELETE', path, { query });
}

// ファイル取得（CSV 出力など）はデータ量が多く時間がかかるため、タイムアウトを長めにする
const DOWNLOAD_TIMEOUT_MS = 60000;

// Content-Disposition から取れない・不正な場合のファイル名
const DEFAULT_DOWNLOAD_FILENAME = 'inventory.csv';

// 保存するファイル名として許可する形式（英数字・_ - . のみ、拡張子 .csv 必須。先頭の . と長すぎる名前は不可）
const SAFE_FILENAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,95}\.csv$/i;

// Content-Disposition（attachment; filename="xxx.csv"）からファイル名を取り出す
// サーバーの値をそのまま保存名にしないよう、許可した文字だけのものに限る
export function filenameFromDisposition(disposition) {
  if (typeof disposition !== 'string') return DEFAULT_DOWNLOAD_FILENAME;
  // filename*=（RFC 5987 形式）は対象外。filename="..." または filename=... を読む
  const match = /(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(disposition);
  const name = match ? (match[1] ?? match[2]) : '';
  return SAFE_FILENAME.test(name) ? name : DEFAULT_DOWNLOAD_FILENAME;
}

// ファイルのダウンロード（GET）。認証ヘッダーが必要なため fetch で Blob として受け取る
//   成功時は { blob, filename } を返す（保存は呼び出し側で行う）
//   エラー時は apiGet と同じく ApiError を投げる（本文の JSON { error, details } を使う）
export async function apiDownload(path, query) {
  const { res, payload } = await send('GET', path, {
    query,
    accept: 'text/csv, application/json',
    // 成功時はファイルの中身、エラー時は JSON のメッセージを読む
    readBody: (r) => (r.ok ? r.blob() : r.text()),
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
  });

  if (!res.ok) throwIfHttpError(res, parseJson(payload).data, true);

  const getHeader = (name) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null);

  // 成功ステータスだが CSV でない応答（想定外の内容をファイルとして保存しない）
  const contentType = getHeader('Content-Type');
  if (typeof contentType !== 'string' || !contentType.trim().toLowerCase().startsWith('text/csv')) {
    throw new ApiError('サーバーの応答を解釈できませんでした', { status: res.status, kind: 'parse' });
  }

  return { blob: payload, filename: filenameFromDisposition(getHeader('Content-Disposition')) };
}
