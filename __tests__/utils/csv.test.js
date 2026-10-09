// src/utils/csv.js のユニットテスト
// AAA パターン（Arrange/Act/Assert）で記述する
// 純粋な関数のみのため DB・モックは使わない
const { formatCsvValue, toCsvLine, toCsv } = require('../../src/utils/csv');

describe('formatCsvValue', () => {
  test.each([
    ['abc', 'abc'],
    ['商品A', '商品A'],
    ['', ''],
    [' 前後の空白 ', ' 前後の空白 '],
  ])('正常系: 特殊文字を含まない文字列 %p はそのまま出力する', (value, expected) => {
    // Act
    const result = formatCsvValue(value);

    // Assert
    expect(result).toBe(expected);
  });

  test.each([
    ['a,b', '"a,b"'],
    ['a"b', '"a""b"'],
    ['"', '""""'],
    ['a\nb', '"a\nb"'],
    ['a\r\nb', '"a\r\nb"'],
    ['a\rb', '"a\rb"'],
  ])('正常系: カンマ・ダブルクォート・改行を含む %p は "" で囲み、" は "" にする（RFC 4180）', (value, expected) => {
    // Act
    const result = formatCsvValue(value);

    // Assert
    expect(result).toBe(expected);
  });

  test.each([null, undefined])('正常系: %p は空文字にする', (value) => {
    // Act
    const result = formatCsvValue(value);

    // Assert
    expect(result).toBe('');
  });

  test.each([
    [0, '0'],
    [100, '100'],
    [-5, '-5'],
    [1.5, '1.5'],
    [true, 'true'],
    [false, 'false'],
  ])('正常系: 数値・真偽値 %p は文字列化する（負の数値に \' は付けない）', (value, expected) => {
    // Act
    const result = formatCsvValue(value);

    // Assert
    expect(result).toBe(expected);
  });

  describe('CSV インジェクション対策', () => {
    test.each([
      ['=SUM(A1:A2)', "'=SUM(A1:A2)"],
      ['+81-3-1234', "'+81-3-1234"],
      ['-5', "'-5"],
      ['@cmd', "'@cmd"],
      ['\tTAB', "'\tTAB"],
    ])('正常系: 数式として解釈され得る文字で始まる文字列 %p は先頭に \' を付ける', (value, expected) => {
      // Act
      const result = formatCsvValue(value);

      // Assert
      expect(result).toBe(expected);
    });

    test.each([
      [' =1', "' =1"],
      ['  -1', "'  -1"],
      ['\uFEFF+1', "'\uFEFF+1"],
      ['\u3000@x', "'\u3000@x"],
      ['\u00A0=1', "'\u00A0=1"],
    ])('正常系: 空白類・BOM の後に数式の記号が続く文字列 %p も先頭に \' を付ける', (value, expected) => {
      // Act
      const result = formatCsvValue(value);

      // Assert
      expect(result).toBe(expected);
    });

    test.each([
      ['＝SUM(A1)', "'＝SUM(A1)"],
      ['＋1', "'＋1"],
      ['－1', "'－1"],
      ['＠x', "'＠x"],
      [' ＝1', "' ＝1"],
    ])('正常系: 全角の ＝ ＋ － ＠ で始まる文字列 %p も先頭に \' を付ける', (value, expected) => {
      // Act
      const result = formatCsvValue(value);

      // Assert
      expect(result).toBe(expected);
    });

    test('正常系: LF で始まる文字列は \' を付けたうえで "" で囲む', () => {
      // Act
      const result = formatCsvValue('\nabc');

      // Assert
      expect(result).toBe('"\'\nabc"');
    });

    test('正常系: CR で始まる文字列は \' を付けたうえで "" で囲む', () => {
      // Act
      const result = formatCsvValue('\rabc');

      // Assert
      expect(result).toBe('"\'\rabc"');
    });

    test.each([
      ['=HYPERLINK("http://example.com","x")', '"\'=HYPERLINK(""http://example.com"",""x"")"'],
      ['=1,2', '"\'=1,2"'],
      ['-a\nb', '"\'-a\nb"'],
    ])('正常系: クォートが必要な値 %p は \' を付けてから "" で囲む', (value, expected) => {
      // Act
      const result = formatCsvValue(value);

      // Assert
      expect(result).toBe(expected);
    });

    test.each(['a=b', 'a-b', ' x', '\u3000x', "'=1", 'x＝1', 'a－b'])('正常系: 先頭以外の記号を含む文字列 %p には \' を付けない', (value) => {
      // Act
      const result = formatCsvValue(value);

      // Assert
      expect(result).toBe(value);
    });
  });
});

describe('toCsvLine', () => {
  test('正常系: 各値を変換してカンマで連結する（改行は含まない）', () => {
    // Act
    const result = toCsvLine(['a', 'b,c', null, 10, '=1']);

    // Assert
    expect(result).toBe('a,"b,c",,10,\'=1');
  });

  test('正常系: 空配列は空文字', () => {
    // Act
    const result = toCsvLine([]);

    // Assert
    expect(result).toBe('');
  });
});

describe('toCsv', () => {
  test('正常系: ヘッダー行とデータ行を CRLF 区切りで出力し、最終行の末尾にも CRLF を付ける', () => {
    // Act
    const result = toCsv(['JANコード', '商品名'], [['4901234567894', '商品A'], ['49012347', 'B,"C"']]);

    // Assert
    expect(result).toBe('JANコード,商品名\r\n4901234567894,商品A\r\n49012347,"B,""C"""\r\n');
  });

  test('正常系: データ行が0件ならヘッダー行のみ', () => {
    // Act
    const result = toCsv(['a', 'b'], []);

    // Assert
    expect(result).toBe('a,b\r\n');
  });

  test('正常系: BOM は付けない（呼び出し側で付与する）', () => {
    // Act
    const result = toCsv(['a'], [['b']]);

    // Assert
    expect(result.charCodeAt(0)).not.toBe(0xfeff);
  });

  test.each([
    ['header が配列でない', 'a,b', []],
    ['rows が配列でない', ['a'], null],
    ['header が undefined', undefined, []],
  ])('異常系: %s場合は TypeError', (_, header, rows) => {
    // Act / Assert
    expect(() => toCsv(header, rows)).toThrow(TypeError);
    expect(() => toCsv(header, rows)).toThrow('header と rows は配列で指定してください');
  });
});
