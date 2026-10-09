// 画面表示用の変換（一覧画面・フォーム画面で共通）
import { h, formatNumber } from './ui.js';

// 入出庫の種別
export const TYPE_LABELS = { in: '入庫', out: '出庫' };

// 伝票フラグ（1:正 / 2:負）
export const SLIP_FLAG_LABELS = { 1: '1：正', 2: '2：負（訂正）' };

// 対応表から表示名を引く（未知の値はそのまま文字列にする）
export function label(map, value) {
  return Object.hasOwn(map, value) ? map[value] : String(value ?? '');
}

// 在庫への影響（+10 / -3）
export function formatDelta(delta) {
  if (typeof delta !== 'number') return '';
  return delta > 0 ? `+${formatNumber(delta)}` : formatNumber(delta);
}

// 在庫状態のバッジ（色だけに頼らず文字でも示す）
export function stockBadge(isAlert) {
  return isAlert
    ? h('span', { className: 'badge badge-alert', text: '在庫不足' })
    : h('span', { className: 'badge badge-ok', text: '正常' });
}

// 表に「データなし」などの1行を表示する
export function emptyRow(tbody, colspan, text) {
  tbody.replaceChildren(h('tr', {}, h('td', { colspan, className: 'empty', text })));
}
