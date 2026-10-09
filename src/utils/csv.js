// CSV 生成の共通処理（DB・HTTP に依存しない純粋関数）
// - RFC 4180 に従い、" , CR LF を含む値は "" で囲み、値の中の " は "" にする
// - 改行は CRLF。null / undefined は空文字として出力する
// - CSV インジェクション対策：表計算ソフトで数式として解釈されないよう、
//   次の「文字列」の値は先頭に ' を付ける（値そのものは変えない。数値型の値は対象外）
//     ・先頭（空白類・BOM を挟んでもよい）が = + - @ または全角の ＝ ＋ － ＠
//     ・先頭がタブ・CR・LF

// 数式として解釈され得る先頭（\uFF1D ＝ / \uFF0B ＋ / \uFF0D － / \uFF20 ＠、\uFEFF は BOM）
const FORMULA_PREFIX = /^[\s\uFEFF]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]|^[\t\r\n]/;

// 1つの値を CSV のフィールド文字列に変換する
function formatCsvValue(value) {
  if (value === null || value === undefined) return '';
  let s;
  if (typeof value === 'string') {
    s = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  } else {
    // 数値・真偽値などはそのまま文字列化する（負の数値も ' を付けない）
    s = String(value);
  }
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// 1行分（値の配列）を CSV の1行に変換する（改行は含まない）
function toCsvLine(values) {
  return values.map(formatCsvValue).join(',');
}

// ヘッダー（列名の配列）とデータ行（値の配列の配列）から CSV 文字列を生成する
// 各行の末尾（最終行を含む）に CRLF を付ける。BOM は付けない（呼び出し側で付与する）
function toCsv(header, rows) {
  if (!Array.isArray(header) || !Array.isArray(rows)) {
    throw new TypeError('header と rows は配列で指定してください');
  }
  return [header, ...rows].map((r) => `${toCsvLine(r)}\r\n`).join('');
}

module.exports = { formatCsvValue, toCsvLine, toCsv };
