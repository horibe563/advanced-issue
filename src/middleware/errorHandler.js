// 共通エラーハンドラ・404 ハンドラ
// - HttpError（ルートで明示的に投げたもの）はそのステータスとメッセージを返す
// - express.json() の JSON パースエラー・サイズ超過は 400 / 413 を返す
// - PostgreSQL の制約違反などはクライアント起因として 400 / 409 に変換する（タイムアウトによる中断は 503）
//   （ルート側のバリデーションをすり抜けた場合の保険）
// - それ以外は 500 とし、スタックトレースや SQL などの内部情報は返さずサーバーログにのみ出力する
const { HttpError } = require('../utils/httpError');

// PostgreSQL のエラーコード → HTTP ステータス・メッセージの対応表
const PG_ERROR_MAP = {
  '23505': { status: 409, message: '同じキーのデータが既に存在します' }, // 一意制約違反
  '23503': { status: 409, message: '関連するデータが存在しないか、参照されているため処理できません' }, // 外部キー違反
  '23514': { status: 400, message: '入力値が制約を満たしていません' }, // CHECK 制約違反
  '23502': { status: 400, message: '必須項目が指定されていません' }, // NOT NULL 違反
  '22001': { status: 400, message: '入力値が長すぎます' }, // 文字列長超過
  '22003': { status: 400, message: '数値が範囲外です' }, // 数値範囲外
  '22P02': { status: 400, message: '入力値の形式が正しくありません' }, // 型変換エラー
  '22021': { status: 400, message: '入力値に使用できない文字が含まれています' }, // 文字コード不正（NUL 文字など）
  '22007': { status: 400, message: '日付の形式が正しくありません' },
  '22008': { status: 400, message: '日付が範囲外です' },
  '40001': { status: 409, message: '同時更新が発生しました。再度実行してください' }, // シリアライズ失敗
  '40P01': { status: 409, message: '同時更新が発生しました。再度実行してください' }, // デッドロック検出
  '57014': { status: 503, message: '処理に時間がかかりすぎたため中断しました。条件を絞って再度実行してください' }, // statement_timeout 等によるキャンセル
};

// どのルートにも一致しなかったリクエスト
function notFoundHandler(req, res) {
  res.status(404).json({ error: 'リクエストされたリソースが見つかりません' });
}

// 引数が4つでないと Express にエラーハンドラとして認識されないため next も受け取る
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // ルートで明示的に投げたエラー
  if (err instanceof HttpError) {
    const body = { error: err.message };
    if (err.details) body.details = err.details;
    return res.status(err.status).json(body);
  }
  // express.json() が不正な JSON を受け取った場合
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'リクエストボディの JSON 形式が不正です' });
  }
  // express.json() の上限サイズを超えるボディ
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'リクエストボディが大きすぎます' });
  }
  // 文字コード不正など、body-parser が 4xx と判定したもの
  // （err.message には内部情報が含まれ得るため返さない）
  const status = err.status || err.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return res.status(status).json({ error: 'リクエストが不正です' });
  }
  // PostgreSQL のエラー（クライアント起因と判断できるもの）
  // 自身のプロパティのみ参照する（err.code が 'constructor' や '__proto__' の場合に
  // Object.prototype のプロパティを対応ありと誤判定し、status が undefined になるのを防ぐ）
  if (typeof err.code === 'string' && Object.hasOwn(PG_ERROR_MAP, err.code)) {
    // 原因調査のため、制約名などはサーバーログにのみ残す
    console.warn('DB 制約エラー', { code: err.code, constraint: err.constraint, detail: err.detail });
    const mapped = PG_ERROR_MAP[err.code];
    return res.status(mapped.status).json({ error: mapped.message });
  }
  // 想定外のエラー
  console.error(err);
  return res.status(500).json({ error: 'サーバー内部でエラーが発生しました' });
}

module.exports = { notFoundHandler, errorHandler };
