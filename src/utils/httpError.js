// HTTP ステータス付きのアプリケーションエラー
// ルート内で throw すると共通エラーハンドラ（src/middleware/errorHandler.js）が
// status と message をそのままレスポンスに変換する。
// message はクライアントに返すため、内部情報（SQL・スタック等）を含めないこと。
class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    // 入力エラーの項目別詳細など（任意）
    this.details = details;
  }
}

// よく使うステータスのショートカット
const badRequest = (message, details) => new HttpError(400, message, details);
const notFound = (message) => new HttpError(404, message);
const conflict = (message) => new HttpError(409, message);
const unauthorized = (message = 'ログインしていないか、ログインの有効期限が切れています') => new HttpError(401, message);
const forbidden = (message) => new HttpError(403, message);
const tooManyRequests = (message) => new HttpError(429, message);

module.exports = { HttpError, badRequest, notFound, conflict, unauthorized, forbidden, tooManyRequests };
