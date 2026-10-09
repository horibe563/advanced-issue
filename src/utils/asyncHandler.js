// 非同期ルートハンドラのラッパー
// Express 4 は async 関数内の reject を自動で next(err) に渡さないため、
// このラッパーで包んで共通エラーハンドラへ確実に渡す。
module.exports = function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
