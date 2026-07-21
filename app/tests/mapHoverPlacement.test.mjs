import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMapHoverTooltipPlacement } from '../public/mapHoverPlacement.js';

// 実プロジェクトのキャンバス/popup に近い寸法。popup は前タスク(map-popup-fix)で在室名を
// 縦積みにしたぶん背が高い前提。
const CANVAS_W = 1000;
const CANVAS_H = 560;
const TOOLTIP_W = 320;
const TOOLTIP_H = 220;
const GAP = 12;

function place(pointXPercent, pointYPercent, overrides = {}) {
  return computeMapHoverTooltipPlacement({
    canvasWidth: CANVAS_W,
    canvasHeight: CANVAS_H,
    tooltipWidth: TOOLTIP_W,
    tooltipHeight: TOOLTIP_H,
    pointXPercent,
    pointYPercent,
    gap: GAP,
    ...overrides
  });
}

function assertInsideCanvas({ left, top }, tooltipWidth = TOOLTIP_W, tooltipHeight = TOOLTIP_H, canvasWidth = CANVAS_W, canvasHeight = CANVAS_H) {
  assert.ok(left >= 0, `left ${left} must not overflow the canvas left edge`);
  assert.ok(top >= 0, `top ${top} must not overflow the canvas top edge`);
  assert.ok(left + tooltipWidth <= canvasWidth, `right edge ${left + tooltipWidth} must not overflow canvas width ${canvasWidth}`);
  assert.ok(top + tooltipHeight <= canvasHeight, `bottom edge ${top + tooltipHeight} must not overflow canvas height ${canvasHeight}`);
}

test('a comfortably-placed pin keeps the tooltip above-right of the anchor', () => {
  // 中央付近のピン: 上にも右にも余裕がある。
  const result = place(40, 60);
  const anchorX = 0.4 * CANVAS_W; // 400
  const anchorY = 0.6 * CANVAS_H; // 336
  assert.equal(result.left, anchorX + GAP, 'should sit to the right of the anchor by the gap');
  assert.equal(result.top, anchorY - GAP - TOOLTIP_H, 'should sit above the anchor by gap + popup height');
  assertInsideCanvas(result);
});

test('a top-edge pin (chapel_of_stars / forbidden_archive) flips the tooltip below and stays inside the frame', () => {
  // chapel_of_stars=y28, forbidden_archive_door=y20.6。背の高い popup では上に収まらない。
  for (const y of [28, 20.6, 8.9]) {
    const result = place(30, y);
    const anchorY = (y / 100) * CANVAS_H;
    // 上に収まらない（anchorY - gap - popupH < 0）ので下へ。
    assert.ok(anchorY - GAP - TOOLTIP_H < 0, `precondition: y=${y} should not fit above`);
    assert.equal(result.top, anchorY + GAP, `y=${y}: tooltip should flip below the pin`);
    assertInsideCanvas(result);
  }
});

test('a right-edge pin flips the tooltip to the left of the anchor', () => {
  // dormitory_lounge=x92.2 など右端のピン。
  const result = place(92.2, 50);
  const anchorX = 0.922 * CANVAS_W;
  assert.equal(result.left, anchorX - GAP - TOOLTIP_W, 'should flip to the left of the anchor');
  assertInsideCanvas(result);
});

test('a bottom-edge pin keeps the tooltip above and inside the frame', () => {
  // front_gate_morning=y91.7 など下端のピン。
  const result = place(40, 91.7);
  const anchorY = 0.917 * CANVAS_H;
  assert.equal(result.top, anchorY - GAP - TOOLTIP_H, 'bottom pins should keep the tooltip above');
  assertInsideCanvas(result);
});

test('extreme corner pins are clamped fully inside the canvas on every edge', () => {
  for (const [x, y] of [[0, 0], [100, 0], [0, 100], [100, 100], [98, 3], [2, 97]]) {
    assertInsideCanvas(place(x, y));
  }
});

test('a popup taller than the whole canvas is pinned to the top edge so its top (stage name) is never cut off', () => {
  // 病的に背の高い popup（キャンバスより高い）は物理的に収まりきらないが、ユーザーの不満は
  // 「上が切れる」こと。クランプで top=0 に固定し、少なくとも上端は切らない（下は overflow:hidden で切れる）。
  const result = place(50, 5, { tooltipHeight: CANVAS_H + 80 });
  assert.equal(result.top, 0, 'an oversized popup is pinned to the canvas top edge (no top overflow)');
  assert.ok(result.left >= 0 && result.left + TOOLTIP_W <= CANVAS_W, 'horizontal placement still stays inside the canvas');
});

test('placement scales with the live canvas size (no hard-coded pixel assumptions)', () => {
  const small = computeMapHoverTooltipPlacement({
    canvasWidth: 500, canvasHeight: 300, tooltipWidth: 320, tooltipHeight: 220,
    pointXPercent: 90, pointYPercent: 10, gap: GAP
  });
  assertInsideCanvas(small, 320, 220, 500, 300);
});
