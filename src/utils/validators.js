// 入力バリデーションの共通処理
// ルートごとに「項目定義（spec）」を用意し、validateFields() で
// 型・必須・桁数・範囲・形式をまとめてチェックする。
// エラーがあれば項目別の詳細を付けた 400 エラーを投げる。
const { badRequest } = require('./httpError');

// PostgreSQL の INTEGER 型の上限（stock / threshold / slip_seq など）
const PG_INTEGER_MAX = 2147483647;

// 文字数を数える（PostgreSQL の VARCHAR(n) は「文字数」で制限するため、
// サロゲートペアを1文字として数えるようコードポイント単位で数える）
function charLength(str) {
  return [...str].length;
}

// 値が未指定（undefined / null / 空文字）かどうか
function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

// 'YYYY-MM-DD' 形式かつ実在する日付かどうか（2026-02-30 などを弾く）
function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 1;
}

// JAN コードのチェックデジット検証（8桁 / 13桁共通）
// 右端（チェックデジット）を除いた桁を右から数えて、奇数番目×3・偶数番目×1 の合計を求め、
// (10 - 合計 % 10) % 10 がチェックデジットと一致すれば正しい。
function isValidJanCheckDigit(jan) {
  if (!/^(\d{8}|\d{13})$/.test(jan)) return false;
  const digits = jan.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  digits.reverse().forEach((d, i) => {
    sum += i % 2 === 0 ? d * 3 : d;
  });
  return (10 - (sum % 10)) % 10 === check;
}

// JAN コードの形式チェック（エラーメッセージを返す。正常なら null）
function janCdError(value, label = 'jan_cd') {
  if (typeof value !== 'string') return `${label} は文字列で指定してください`;
  if (!/^(\d{8}|\d{13})$/.test(value)) return `${label} は8桁または13桁の数字で指定してください`;
  if (!isValidJanCheckDigit(value)) return `${label} のチェックデジットが正しくありません`;
  return null;
}

// 1項目をチェックし、エラーメッセージ（正常なら null）と変換後の値を返す
function checkField(name, value, rule) {
  // 未指定の扱い
  if (value === undefined || value === null) {
    if (rule.required) return { error: `${name} は必須です` };
    return { skip: true };
  }

  switch (rule.type) {
    case 'string': {
      if (typeof value !== 'string') return { error: `${name} は文字列で指定してください` };
      // PostgreSQL の文字列型は NUL 文字を格納できないため事前に弾く
      if (value.includes('\u0000')) return { error: `${name} に使用できない文字が含まれています` };
      // allowEmpty: false の項目（パスワードなど）は、空文字・空白のみを「未指定（NULL）」として
      // 扱わずにエラーとする（trim: false の項目でも空白のみの値は受け付けない）
      if (rule.allowEmpty === false && value.trim() === '') {
        return { error: `${name} は空文字や空白のみでは指定できません` };
      }
      const v = rule.trim === false ? value : value.trim();
      if (v === '') {
        if (rule.required) return { error: `${name} は必須です` };
        // 任意項目の空文字は NULL として扱う
        return { value: null };
      }
      if (rule.minLength && charLength(v) < rule.minLength) {
        return { error: `${name} は${rule.minLength}文字以上で指定してください` };
      }
      if (rule.maxLength && charLength(v) > rule.maxLength) {
        return { error: `${name} は${rule.maxLength}文字以内で指定してください` };
      }
      if (rule.maxBytes && Buffer.byteLength(v, 'utf8') > rule.maxBytes) {
        return { error: `${name} は${rule.maxBytes}バイト以内で指定してください` };
      }
      if (rule.pattern && !rule.pattern.test(v)) {
        return { error: rule.patternMessage || `${name} の形式が正しくありません` };
      }
      return { value: v };
    }
    case 'integer': {
      // "1" のような文字列や 1.5、true などは受け付けない
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        return { error: `${name} は整数で指定してください` };
      }
      const min = rule.min ?? 0;
      const max = rule.max ?? PG_INTEGER_MAX;
      if (value < min || value > max) return { error: `${name} は${min}〜${max}の範囲で指定してください` };
      return { value };
    }
    case 'enum': {
      if (!rule.values.includes(value)) {
        return { error: `${name} は ${rule.values.join(' / ')} のいずれかで指定してください` };
      }
      return { value };
    }
    case 'date': {
      if (!isValidDateString(value)) return { error: `${name} は YYYY-MM-DD 形式の正しい日付で指定してください` };
      return { value };
    }
    case 'jan': {
      const err = janCdError(value, name);
      if (err) return { error: err };
      return { value };
    }
    default:
      throw new Error(`未知の型定義です: ${rule.type}`);
  }
}

// リクエストボディが JSON オブジェクトであることを確認する（配列・null・プリミティブを弾く）
function assertPlainObject(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('リクエストボディは JSON オブジェクトで指定してください');
  }
}

// 定義（spec）に従って入力を一括チェックする
// - 定義にない項目が含まれていればエラー（項目名の打ち間違いを検知するため）
// - 戻り値は定義に含まれ、かつ指定された項目のみを持つオブジェクト
function validateFields(input, spec, { allowUnknown = false } = {}) {
  assertPlainObject(input);
  const errors = [];
  const result = {};

  if (!allowUnknown) {
    for (const key of Object.keys(input)) {
      if (!Object.prototype.hasOwnProperty.call(spec, key)) {
        errors.push({ field: key, message: `${key} は指定できない項目です` });
      }
    }
  }

  for (const [name, rule] of Object.entries(spec)) {
    const checked = checkField(name, input[name], rule);
    if (checked.error) {
      errors.push({ field: name, message: checked.error });
    } else if (!checked.skip) {
      result[name] = checked.value;
    }
  }

  if (errors.length > 0) {
    throw badRequest('入力内容に誤りがあります', errors);
  }
  return result;
}

// クエリ文字列用：値が配列（?a=1&a=2）などの場合を弾き、文字列か undefined を返す
// （自身のプロパティのみ参照する。NUL 文字は PostgreSQL の文字列に渡せないため 400 にする）
function queryString(query, name) {
  const v = Object.prototype.hasOwnProperty.call(query, name) ? query[name] : undefined;
  if (v === undefined) return undefined;
  if (typeof v !== 'string') {
    throw badRequest('入力内容に誤りがあります', [{ field: name, message: `${name} は1つだけ指定してください` }]);
  }
  if (v.includes('\u0000')) {
    throw badRequest('入力内容に誤りがあります', [{ field: name, message: `${name} に使用できない文字が含まれています` }]);
  }
  return v;
}

// クエリ文字列の整数値（limit / offset / update_seq など）を変換・チェックする
function queryInteger(query, name, { min = 0, max = PG_INTEGER_MAX, required = false, defaultValue } = {}) {
  const raw = queryString(query, name);
  if (raw === undefined || raw === '') {
    if (required) {
      throw badRequest('入力内容に誤りがあります', [{ field: name, message: `${name} は必須です` }]);
    }
    return defaultValue;
  }
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max) {
    throw badRequest('入力内容に誤りがあります', [
      { field: name, message: `${name} は${min}〜${max}の整数で指定してください` },
    ]);
  }
  return Number(raw);
}

// 一覧取得のページング（limit は既定100・最大1000、offset は0以上）
function parsePaging(query) {
  return {
    limit: queryInteger(query, 'limit', { min: 1, max: 1000, defaultValue: 100 }),
    offset: queryInteger(query, 'offset', { min: 0, max: PG_INTEGER_MAX, defaultValue: 0 }),
  };
}

// クエリ文字列で許可していないパラメータが含まれていれば 400 にする
function assertAllowedQuery(query, allowed) {
  const unknown = Object.keys(query).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw badRequest(
      '入力内容に誤りがあります',
      unknown.map((k) => ({ field: k, message: `${k} は指定できない検索条件です` }))
    );
  }
}

// LIKE 検索用に % _ \ をエスケープする（利用者の入力をワイルドカードとして解釈させない）
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

module.exports = {
  PG_INTEGER_MAX,
  charLength,
  isBlank,
  isValidDateString,
  isValidJanCheckDigit,
  janCdError,
  validateFields,
  assertPlainObject,
  queryString,
  queryInteger,
  parsePaging,
  assertAllowedQuery,
  escapeLike,
};
