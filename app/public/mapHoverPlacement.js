// マップ hover tooltip の配置を、ピン座標(percent)・popup 実測サイズ・キャンバス実寸から
// 計算する純関数。固定の％閾値（旧実装の point.y<18 で下・point.x>68 で左）は使わず、
// 上に収まらなければ下、右に収まらなければ左へ寄せ、最後にキャンバス内へクランプする。
// これにより popup サイズが変わっても上端・下端・左右のピンで枠外へ出ない。キャンバスは
// overflow:hidden なので、クランプが「切れ」と「はみ出し」の両方を同時に防ぐ。
//
// 返り値 left/top は offsetParent(キャンバス)基準の px。app.js が DOM 実測値を渡し、
// この純関数の結果をそのまま style.left/top に設定する。DOM 参照を持たないので headless に
// 単体テストできる。
export function computeMapHoverTooltipPlacement({
  canvasWidth,
  canvasHeight,
  tooltipWidth,
  tooltipHeight,
  pointXPercent,
  pointYPercent,
  gap
}) {
  const anchorX = (pointXPercent / 100) * canvasWidth;
  const anchorY = (pointYPercent / 100) * canvasHeight;

  // 縦: 既定はピンの上。上端に収まらなければピンの下へ寄せる。
  let top = anchorY - gap - tooltipHeight;
  if (top < 0) top = anchorY + gap;
  // 横: 既定はピンの右。右端に収まらなければピンの左へ寄せる。
  let left = anchorX + gap;
  if (left + tooltipWidth > canvasWidth) left = anchorX - gap - tooltipWidth;

  // 端のピンでも枠外へ出さないよう、最終位置をキャンバス内にクランプする。
  left = Math.max(0, Math.min(left, canvasWidth - tooltipWidth));
  top = Math.max(0, Math.min(top, canvasHeight - tooltipHeight));

  return { left, top };
}
