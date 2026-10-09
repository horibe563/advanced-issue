// 画面表示用の変換（public/js/format.js）のテスト
let format;

beforeAll(() => {
  jest.isolateModules(() => {
    format = require('../../public/js/format.js');
  });
});

const XSS = '<img src=x onerror="window.__xss=1">';

describe('label', () => {
  test.each([
    ['in', '入庫'],
    ['out', '出庫'],
  ])('正常系：種別 %s は「%s」になる', (value, expected) => {
    // Arrange・Act
    const result = format.label(format.TYPE_LABELS, value);

    // Assert
    expect(result).toBe(expected);
  });

  test.each([
    [1, '1：正'],
    [2, '2：負（訂正）'],
    ['1', '1：正'],
    ['2', '2：負（訂正）'],
  ])('正常系：伝票フラグ %p は「%s」になる', (value, expected) => {
    // Arrange・Act
    const result = format.label(format.SLIP_FLAG_LABELS, value);

    // Assert
    expect(result).toBe(expected);
  });

  test.each([
    ['TYPE_LABELS', 'move', 'move'],
    ['SLIP_FLAG_LABELS', 3, '3'],
    ['SLIP_FLAG_LABELS', 0, '0'],
  ])('異常系：%s にない値 %p はそのまま文字列にする', (mapName, value, expected) => {
    // Arrange・Act
    const result = format.label(format[mapName], value);

    // Assert
    expect(result).toBe(expected);
  });

  test.each([[null], [undefined]])('異常系：%p は空文字にする', (value) => {
    // Arrange・Act
    const result = format.label(format.TYPE_LABELS, value);

    // Assert
    expect(result).toBe('');
  });

  test.each([['toString'], ['__proto__'], ['constructor'], ['hasOwnProperty']])(
    '異常系：プロトタイプのプロパティ名 %s は対応表の値にならず、文字列のまま返す',
    (value) => {
      // Arrange・Act
      const result = format.label(format.TYPE_LABELS, value);

      // Assert
      expect(result).toBe(value);
    }
  );
});

describe('formatDelta', () => {
  test.each([
    [10, '+10'],
    [1234567, '+1,234,567'],
    [-3, '-3'],
    [-1234, '-1,234'],
    [0, '0'],
  ])('正常系：%p は「%s」になる（正の値のみ + を付ける）', (value, expected) => {
    // Arrange・Act
    const result = format.formatDelta(value);

    // Assert
    expect(result).toBe(expected);
  });

  test.each([['5'], [null], [undefined]])('異常系：数値以外（%p）は空文字にする', (value) => {
    // Arrange・Act
    const result = format.formatDelta(value);

    // Assert
    expect(result).toBe('');
  });
});

describe('stockBadge', () => {
  test('正常系：在庫不足のときは「在庫不足」のバッジ', () => {
    // Arrange・Act
    const badge = format.stockBadge(true);

    // Assert
    expect(badge.tagName).toBe('SPAN');
    expect(badge.className).toBe('badge badge-alert');
    expect(badge.textContent).toBe('在庫不足');
  });

  test('正常系：在庫不足でないときは「正常」のバッジ', () => {
    // Arrange・Act
    const badge = format.stockBadge(false);

    // Assert
    expect(badge.tagName).toBe('SPAN');
    expect(badge.className).toBe('badge badge-ok');
    expect(badge.textContent).toBe('正常');
  });
});

describe('emptyRow', () => {
  test('正常系：tbody の中身を、列をまたいだ案内の1行に置き換える', () => {
    // Arrange
    const tbody = document.createElement('tbody');
    tbody.innerHTML = '<tr><td>古い行1</td></tr><tr><td>古い行2</td></tr>';

    // Act
    format.emptyRow(tbody, 5, '商品はまだ登録されていません');

    // Assert
    const rows = tbody.querySelectorAll('tr');
    expect(rows).toHaveLength(1);
    const cells = rows[0].querySelectorAll('td');
    expect(cells).toHaveLength(1);
    expect(cells[0].getAttribute('colspan')).toBe('5');
    expect(cells[0].className).toBe('empty');
    expect(cells[0].textContent).toBe('商品はまだ登録されていません');
  });

  test('正常系：XSS を含む文言はタグとして解釈せず文字列のまま表示する', () => {
    // Arrange
    const tbody = document.createElement('tbody');
    delete window.__xss;

    // Act
    format.emptyRow(tbody, 9, XSS);

    // Assert
    expect(tbody.querySelector('img')).toBeNull();
    expect(tbody.querySelector('td').textContent).toBe(XSS);
    expect(window.__xss).toBeUndefined();
  });
});
