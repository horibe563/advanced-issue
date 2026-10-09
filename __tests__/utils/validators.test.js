// src/utils/validators.js のユニットテスト
// AAA パターン（Arrange/Act/Assert）で記述する
// 純粋な関数のみのため DB・モックは使わない
const {
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
} = require('../../src/utils/validators');
const { HttpError } = require('../../src/utils/httpError');

// 例外として投げられた HttpError を取り出す（投げられなければテスト失敗）
function catchError(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('例外が投げられませんでした');
}

describe('charLength', () => {
  test('正常系: サロゲートペア（絵文字）を1文字として数える', () => {
    // Arrange
    const value = 'a😀あ';

    // Act
    const len = charLength(value);

    // Assert: String.length では 4 になるが、コードポイント単位では 3
    expect(value.length).toBe(4);
    expect(len).toBe(3);
  });
});

describe('isBlank', () => {
  test.each([
    [undefined, true],
    [null, true],
    ['', true],
    ['   ', true],
    ['a', false],
    [0, false],
    [false, false],
  ])('正常系: isBlank(%p) は %p を返す', (value, expected) => {
    // Act / Assert
    expect(isBlank(value)).toBe(expected);
  });
});

describe('isValidDateString', () => {
  test.each(['2026-10-08', '2024-02-29', '2026-12-31', '9999-12-31'])('正常系: %s は正しい日付', (value) => {
    // Act / Assert
    expect(isValidDateString(value)).toBe(true);
  });

  test.each([
    ['2026-02-30', '存在しない日'],
    ['2025-02-29', 'うるう年でない年の2/29'],
    ['2026-13-01', '存在しない月'],
    ['2026-00-10', '0月'],
    ['0000-01-01', '0年'],
    ['2026/10/08', '区切り文字が違う'],
    ['2026-1-8', '桁数不足'],
    ['20261008', '区切りなし'],
    ['2026-10-08T00:00:00', '時刻付き'],
    ['', '空文字'],
  ])('異常系: %s（%s）は不正な日付', (value) => {
    // Act / Assert
    expect(isValidDateString(value)).toBe(false);
  });

  test.each([null, undefined, 20261008, {}])('異常系: 文字列以外（%p）は不正な日付', (value) => {
    // Act / Assert
    expect(isValidDateString(value)).toBe(false);
  });
});

describe('isValidJanCheckDigit', () => {
  test.each(['4901234567894', '4512345678906', '1234567890128', '49012347'])(
    '正常系: %s はチェックデジットが正しい',
    (jan) => {
      // Act / Assert
      expect(isValidJanCheckDigit(jan)).toBe(true);
    }
  );

  test.each(['4901234567890', '4901234567895', '49012340'])('異常系: %s はチェックデジットが誤り', (jan) => {
    // Act / Assert
    expect(isValidJanCheckDigit(jan)).toBe(false);
  });

  test.each(['490123456789', '1234567', '490123456789a', ''])('異常系: 桁数・文字種が不正な %p は false', (jan) => {
    // Act / Assert
    expect(isValidJanCheckDigit(jan)).toBe(false);
  });
});

describe('janCdError', () => {
  test('正常系: 正しい JAN コードなら null を返す', () => {
    // Act / Assert
    expect(janCdError('4901234567894')).toBeNull();
    expect(janCdError('49012347')).toBeNull();
  });

  test('異常系: 文字列以外は型エラーのメッセージを返す', () => {
    // Act / Assert（数値で送られた JAN は先頭の 0 が落ちるため文字列のみ許可）
    expect(janCdError(4901234567894)).toBe('jan_cd は文字列で指定してください');
  });

  test.each(['123', '123456789', '12345678901234', '490123456789X'])('異常系: 桁数・形式が不正な %s', (value) => {
    // Act / Assert
    expect(janCdError(value)).toBe('jan_cd は8桁または13桁の数字で指定してください');
  });

  test('異常系: チェックデジット誤りのメッセージを返す', () => {
    // Act / Assert
    expect(janCdError('4901234567890')).toBe('jan_cd のチェックデジットが正しくありません');
  });

  test('正常系: ラベルを指定するとメッセージの項目名に使われる', () => {
    // Act / Assert
    expect(janCdError(1, 'code')).toBe('code は文字列で指定してください');
  });
});

describe('assertPlainObject', () => {
  test('正常系: オブジェクトなら例外を投げない', () => {
    // Act / Assert
    expect(() => assertPlainObject({ a: 1 })).not.toThrow();
  });

  test.each([[null], [[]], [[{ a: 1 }]], ['abc'], [1], [undefined]])('異常系: %p は 400 になる', (body) => {
    // Act
    const err = catchError(() => assertPlainObject(body));

    // Assert
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(400);
    expect(err.message).toBe('リクエストボディは JSON オブジェクトで指定してください');
  });
});

describe('validateFields', () => {
  describe('string 型', () => {
    test('正常系: 前後の空白を除去して返す（trim 既定）', () => {
      // Act
      const result = validateFields({ name: '  商品A  ' }, { name: { type: 'string' } });

      // Assert
      expect(result).toEqual({ name: '商品A' });
    });

    test('正常系: trim: false の項目は前後の空白を残す', () => {
      // Act
      const result = validateFields({ pw: ' abc ' }, { pw: { type: 'string', trim: false } });

      // Assert
      expect(result).toEqual({ pw: ' abc ' });
    });

    test('正常系: 任意項目の空文字は null（NULL として登録）に変換する', () => {
      // Act
      const result = validateFields({ spec: '   ' }, { spec: { type: 'string' } });

      // Assert
      expect(result).toEqual({ spec: null });
    });

    test('異常系: 必須項目の空文字は「必須です」になる', () => {
      // Act
      const err = catchError(() => validateFields({ name: ' ' }, { name: { type: 'string', required: true } }));

      // Assert
      expect(err.status).toBe(400);
      expect(err.details).toEqual([{ field: 'name', message: 'name は必須です' }]);
    });

    test.each([123, true, {}, []])('異常系: 文字列以外（%p）は型エラー', (value) => {
      // Act
      const err = catchError(() => validateFields({ name: value }, { name: { type: 'string' } }));

      // Assert
      expect(err.details).toEqual([{ field: 'name', message: 'name は文字列で指定してください' }]);
    });

    test('異常系: NUL 文字を含む文字列は 400', () => {
      // Act
      const err = catchError(() => validateFields({ name: 'a\u0000b' }, { name: { type: 'string' } }));

      // Assert
      expect(err.details[0].message).toBe('name に使用できない文字が含まれています');
    });

    test('正常系: maxLength ちょうどは許可し、サロゲートペアは1文字として数える', () => {
      // Arrange
      const value = '😀'.repeat(5);

      // Act
      const result = validateFields({ name: value }, { name: { type: 'string', maxLength: 5 } });

      // Assert
      expect(result.name).toBe(value);
    });

    test('異常系: maxLength を超えると 400', () => {
      // Act
      const err = catchError(() => validateFields({ name: 'a'.repeat(6) }, { name: { type: 'string', maxLength: 5 } }));

      // Assert
      expect(err.details[0].message).toBe('name は5文字以内で指定してください');
    });

    test('異常系: minLength 未満は 400', () => {
      // Act
      const err = catchError(() => validateFields({ pw: 'abc' }, { pw: { type: 'string', minLength: 8 } }));

      // Assert
      expect(err.details[0].message).toBe('pw は8文字以上で指定してください');
    });

    test('異常系: maxBytes（UTF-8 のバイト数）を超えると 400', () => {
      // Arrange: 「あ」は UTF-8 で3バイト。25文字 = 75バイト > 72バイト
      const value = 'あ'.repeat(25);

      // Act
      const err = catchError(() => validateFields({ pw: value }, { pw: { type: 'string', maxBytes: 72 } }));

      // Assert
      expect(err.details[0].message).toBe('pw は72バイト以内で指定してください');
    });

    test('異常系: pattern に一致しない場合は patternMessage を返す', () => {
      // Arrange
      const spec = { id: { type: 'string', pattern: /^[a-z]+$/, patternMessage: '英小文字のみ' } };

      // Act
      const err = catchError(() => validateFields({ id: 'ABC' }, spec));

      // Assert
      expect(err.details[0].message).toBe('英小文字のみ');
    });

    test('異常系: patternMessage がない場合は既定のメッセージを返す', () => {
      // Act
      const err = catchError(() => validateFields({ id: 'ABC' }, { id: { type: 'string', pattern: /^[a-z]+$/ } }));

      // Assert
      expect(err.details[0].message).toBe('id の形式が正しくありません');
    });

    test.each(['', '   ', '\t\n'])('異常系: allowEmpty: false の項目は空文字・空白のみ（%p）を 400 にする', (value) => {
      // Arrange（パスワードの空文字を NULL 扱いにして 500 になった不具合の回帰テスト）
      const spec = { password: { type: 'string', trim: false, allowEmpty: false, minLength: 8 } };

      // Act
      const err = catchError(() => validateFields({ password: value }, spec));

      // Assert
      expect(err.status).toBe(400);
      expect(err.details).toEqual([{ field: 'password', message: 'password は空文字や空白のみでは指定できません' }]);
    });
  });

  describe('integer 型', () => {
    test('正常系: 範囲内の整数を返す（境界値 min / max）', () => {
      // Arrange
      const spec = { n: { type: 'integer', min: 1, max: 10 } };

      // Act / Assert
      expect(validateFields({ n: 1 }, spec)).toEqual({ n: 1 });
      expect(validateFields({ n: 10 }, spec)).toEqual({ n: 10 });
    });

    test('正常系: min / max 省略時は 0〜PG_INTEGER_MAX', () => {
      // Act / Assert
      expect(validateFields({ n: PG_INTEGER_MAX }, { n: { type: 'integer' } })).toEqual({ n: PG_INTEGER_MAX });
      expect(() => validateFields({ n: -1 }, { n: { type: 'integer' } })).toThrow(HttpError);
      expect(() => validateFields({ n: PG_INTEGER_MAX + 1 }, { n: { type: 'integer' } })).toThrow(HttpError);
    });

    test.each([['1'], [1.5], [true], [NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1]])(
      '異常系: 整数でない値（%p）は 400',
      (value) => {
        // Act
        const err = catchError(() => validateFields({ n: value }, { n: { type: 'integer' } }));

        // Assert
        expect(err.details[0].message).toBe('n は整数で指定してください');
      }
    );

    test('異常系: 範囲外は範囲のメッセージを返す', () => {
      // Act
      const err = catchError(() => validateFields({ n: 0 }, { n: { type: 'integer', min: 1, max: 10 } }));

      // Assert
      expect(err.details[0].message).toBe('n は1〜10の範囲で指定してください');
    });
  });

  describe('enum 型', () => {
    test('正常系: 定義済みの値を返す', () => {
      // Act / Assert
      expect(validateFields({ t: 'in' }, { t: { type: 'enum', values: ['in', 'out'] } })).toEqual({ t: 'in' });
    });

    test.each(['constructor', '__proto__', 'toString', 'IN', 1])(
      '異常系: 定義外の値（%p）は 400（プロトタイプのプロパティ名も通さない）',
      (value) => {
        // Act
        const err = catchError(() => validateFields({ t: value }, { t: { type: 'enum', values: ['in', 'out'] } }));

        // Assert
        expect(err.details[0].message).toBe('t は in / out のいずれかで指定してください');
      }
    );
  });

  describe('date 型・jan 型', () => {
    test('正常系: 正しい日付・JAN コードを返す', () => {
      // Act
      const result = validateFields(
        { d: '2026-10-08', jan: '4901234567894' },
        { d: { type: 'date' }, jan: { type: 'jan' } }
      );

      // Assert
      expect(result).toEqual({ d: '2026-10-08', jan: '4901234567894' });
    });

    test('異常系: 不正な日付・JAN コードは項目ごとのエラーをまとめて返す', () => {
      // Act
      const err = catchError(() =>
        validateFields({ d: '2026-02-30', jan: '4901234567890' }, { d: { type: 'date' }, jan: { type: 'jan' } })
      );

      // Assert
      expect(err.details).toEqual([
        { field: 'd', message: 'd は YYYY-MM-DD 形式の正しい日付で指定してください' },
        { field: 'jan', message: 'jan のチェックデジットが正しくありません' },
      ]);
    });
  });

  describe('共通', () => {
    test('正常系: 未指定（undefined / null）の任意項目は結果に含めない', () => {
      // Act
      const result = validateFields({ b: null }, { a: { type: 'string' }, b: { type: 'integer' } });

      // Assert
      expect(result).toEqual({});
    });

    test('異常系: 必須項目が null の場合は「必須です」', () => {
      // Act
      const err = catchError(() => validateFields({ a: null }, { a: { type: 'integer', required: true } }));

      // Assert
      expect(err.details).toEqual([{ field: 'a', message: 'a は必須です' }]);
    });

    test('異常系: 定義にない項目は 400（項目名の打ち間違いを検知する）', () => {
      // Act
      const err = catchError(() => validateFields({ a: 'x', typo: 1 }, { a: { type: 'string' } }));

      // Assert
      expect(err.status).toBe(400);
      expect(err.message).toBe('入力内容に誤りがあります');
      expect(err.details).toEqual([{ field: 'typo', message: 'typo は指定できない項目です' }]);
    });

    test('正常系: allowUnknown: true なら定義にない項目を無視する', () => {
      // Act
      const result = validateFields({ a: 'x', other: 1 }, { a: { type: 'string' } }, { allowUnknown: true });

      // Assert
      expect(result).toEqual({ a: 'x' });
    });

    test('異常系: 項目定義の型が未知の場合はプログラムの誤りとして例外（HttpError ではない）', () => {
      // Act
      const err = catchError(() => validateFields({ a: 1 }, { a: { type: 'unknown' } }));

      // Assert
      expect(err).not.toBeInstanceOf(HttpError);
      expect(err.message).toBe('未知の型定義です: unknown');
    });

    test('異常系: 入力がオブジェクトでない場合は 400', () => {
      // Act / Assert
      expect(() => validateFields([], {})).toThrow('リクエストボディは JSON オブジェクトで指定してください');
    });
  });
});

describe('queryString', () => {
  test('正常系: 指定された文字列を返す', () => {
    // Act / Assert
    expect(queryString({ a: 'x' }, 'a')).toBe('x');
  });

  test('正常系: 未指定なら undefined を返す（プロトタイプのプロパティは参照しない）', () => {
    // Act / Assert
    expect(queryString({}, 'a')).toBeUndefined();
    expect(queryString({}, 'toString')).toBeUndefined();
    expect(queryString({}, 'constructor')).toBeUndefined();
  });

  test('異常系: 同じ名前が複数指定された（配列）場合は 400', () => {
    // Act
    const err = catchError(() => queryString({ a: ['1', '2'] }, 'a'));

    // Assert
    expect(err.status).toBe(400);
    expect(err.details).toEqual([{ field: 'a', message: 'a は1つだけ指定してください' }]);
  });

  test('異常系: NUL 文字（%00）を含む場合は 400', () => {
    // Act
    const err = catchError(() => queryString({ a: 'x\u0000' }, 'a'));

    // Assert
    expect(err.status).toBe(400);
    expect(err.details).toEqual([{ field: 'a', message: 'a に使用できない文字が含まれています' }]);
  });
});

describe('queryInteger', () => {
  test('正常系: 数字の文字列を数値に変換する', () => {
    // Act / Assert
    expect(queryInteger({ n: '42' }, 'n')).toBe(42);
  });

  test('正常系: 未指定・空文字なら既定値を返す', () => {
    // Act / Assert
    expect(queryInteger({}, 'n', { defaultValue: 5 })).toBe(5);
    expect(queryInteger({ n: '' }, 'n', { defaultValue: 5 })).toBe(5);
    expect(queryInteger({}, 'n')).toBeUndefined();
  });

  test('異常系: required で未指定なら 400', () => {
    // Act
    const err = catchError(() => queryInteger({}, 'n', { required: true }));

    // Assert
    expect(err.details).toEqual([{ field: 'n', message: 'n は必須です' }]);
  });

  test.each(['-1', '1.5', 'abc', '1e3', ' 1', '0x10', '9007199254740993', '11'])('異常系: %p は 400', (raw) => {
    // Act
    const err = catchError(() => queryInteger({ n: raw }, 'n', { min: 0, max: 10 }));

    // Assert
    expect(err.status).toBe(400);
    expect(err.details[0].message).toBe('n は0〜10の整数で指定してください');
  });
});

describe('parsePaging', () => {
  test('正常系: 未指定なら limit=100, offset=0', () => {
    // Act / Assert
    expect(parsePaging({})).toEqual({ limit: 100, offset: 0 });
  });

  test('正常系: 指定値を返す（limit の上限 1000）', () => {
    // Act / Assert
    expect(parsePaging({ limit: '1000', offset: '20' })).toEqual({ limit: 1000, offset: 20 });
  });

  test.each([[{ limit: '0' }], [{ limit: '1001' }], [{ offset: '-1' }]])('異常系: 範囲外 %p は 400', (query) => {
    // Act / Assert
    expect(() => parsePaging(query)).toThrow(HttpError);
  });
});

describe('assertAllowedQuery', () => {
  test('正常系: 許可されたパラメータのみなら例外を投げない', () => {
    // Act / Assert
    expect(() => assertAllowedQuery({ a: '1' }, ['a', 'b'])).not.toThrow();
  });

  test('異常系: 許可されていないパラメータはすべて列挙して 400', () => {
    // Act
    const err = catchError(() => assertAllowedQuery({ a: '1', x: '2', y: '3' }, ['a']));

    // Assert
    expect(err.status).toBe(400);
    expect(err.details).toEqual([
      { field: 'x', message: 'x は指定できない検索条件です' },
      { field: 'y', message: 'y は指定できない検索条件です' },
    ]);
  });
});

describe('escapeLike', () => {
  test('正常系: LIKE のワイルドカード（% _ \\）をエスケープする', () => {
    // Act / Assert
    expect(escapeLike('10%_off\\')).toBe('10\\%\\_off\\\\');
  });

  test('正常系: ワイルドカードを含まない文字列はそのまま', () => {
    // Act / Assert
    expect(escapeLike('商品A')).toBe('商品A');
  });
});
