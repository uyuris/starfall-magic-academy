// 星見の窓（学院を俯瞰で眺める画面）の札と線の置き場を決める純関数。
// hover の段階 1（一言の札）・段階 2（関係の線と気持ちの札）、結末の跡の札、出会っている二人の
// 一言の札を、画面の寸法・部品の矩形・コマの中心と半径・札の実測寸法から決める。DOM を参照しないので
// node の test から直接 import できる。座標はどれも画面の CSS px（左上原点・y は下向き）。
//
// 矩形は { left, top, right, bottom }。線は path（{ type: 'line' } と { type: 'arc' } の列）で返し、
// 円弧は canvas の arc(center.x, center.y, radius, startAngle, endAngle, anticlockwise) にそのまま渡せる。
// 段階 1 の関数が決めた一言の札を段階 2 の関数は入力として受け取り、動かさずに返す。

export const OVERLOOK_LINE_WIDTH = Object.freeze({ core: 3, casing: 7 });

const SAY_GAP = 10;
const PART_CLEARANCE = 6;
const LABEL_CLEARANCE = 4;
const LINE_CLEARANCE = 12;
const COMA_CLEARANCE_TIGHT = 4;
const LINE_GAP_WIDE = 12;
const LINE_GAP_TIGHT = 7.5;
const FEELING_GAP = 6;
const STEP_AWAY = 4;
const EDGE_INSET = 6;
const EDGE_LINE_OFFSET = 15.5;
const TRACE_GAP = 12;
const PAIR_GAP = 10;
const SAGITTA_STEP_WIDE = 4;
const RING_ANGLE_STEP_DEG = 10;
const BIARC_JUNCTIONS = Object.freeze([0.25, 0.5, 0.75]);
const END_TOLERANCE = 1e-6;
const SCREEN_TOLERANCE = 1e-7;

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

// 左（進む向きの左）を正にした回し角の並び: step, -step, 2step, -2step, ..., 180。
function alternatingAngles(step) {
  const angles = [];
  for (let a = step; a < 180; a += step) angles.push(a, -a);
  angles.push(180);
  return angles;
}

const STAGE3_ROTATIONS = Object.freeze(alternatingAngles(10));
// 段 4 の出る点・入る点の回し角の組。回す角の和の小さい順、同じ和なら出る側の小さい順、左を先に。
const STAGE4_PAIRS = Object.freeze((() => {
  const angles = [0, ...alternatingAngles(5)];
  const pairs = [];
  for (const exit of angles) for (const entry of angles) pairs.push([exit, entry]);
  pairs.sort((a, b) => (Math.abs(a[0]) + Math.abs(a[1])) - (Math.abs(b[0]) + Math.abs(b[1]))
    || Math.abs(a[0]) - Math.abs(b[0])
    || Number(a[0] < 0) - Number(b[0] < 0)
    || Math.abs(a[1]) - Math.abs(b[1])
    || Number(a[1] < 0) - Number(b[1] < 0));
  return pairs;
})());

const SIDE_ORDER_SAY = Object.freeze(['above', 'below', 'right', 'left']);
const SIDE_TIE_ORDER_SAY = Object.freeze(['right', 'left', 'above', 'below']);
const SIDE_ORDER_FEELING = Object.freeze(['below', 'above', 'right', 'left']);

// ---------------------------------------------------------------------------
// 入力の検査（fail-fast）

function fail(message) {
  throw new Error(`overlookLayout: ${message}`);
}

function requireFinite(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${name} must be a finite number`);
  return value;
}

function requirePositive(name, value) {
  requireFinite(name, value);
  if (!(value > 0)) fail(`${name} must be positive`);
  return value;
}

function requireRect(name, rect) {
  if (!rect || typeof rect !== 'object') fail(`${name} must be a rect`);
  for (const key of ['left', 'top', 'right', 'bottom']) requireFinite(`${name}.${key}`, rect[key]);
  if (!(rect.right > rect.left) || !(rect.bottom > rect.top)) fail(`${name} must have positive width and height`);
  return rect;
}

// 画面の部品（上部バー・出るボタン・「顔ぶれ」のボタン・開いているときの顔ぶれの一覧の枠）の矩形の列。
function requireParts(parts) {
  if (!Array.isArray(parts)) fail('parts must be an array of rects');
  parts.forEach((rect, i) => requireRect(`parts[${i}]`, rect));
  return parts;
}

function requireScreen(screen) {
  if (!screen || typeof screen !== 'object') fail('screen must be { width, height }');
  requirePositive('screen.width', screen.width);
  requirePositive('screen.height', screen.height);
  return screen;
}

function requireComas(comas) {
  if (!Array.isArray(comas)) fail('comas must be an array');
  const byId = new Map();
  comas.forEach((coma, i) => {
    if (!coma || typeof coma !== 'object') fail(`comas[${i}] must be { id, x, y }`);
    if (typeof coma.id !== 'string' || coma.id === '') fail(`comas[${i}].id must be a non-empty string`);
    requireFinite(`comas[${i}].x`, coma.x);
    requireFinite(`comas[${i}].y`, coma.y);
    if (byId.has(coma.id)) fail(`duplicate coma id ${coma.id}`);
    byId.set(coma.id, coma);
  });
  return byId;
}

function requireComa(byId, id, name) {
  const coma = byId.get(id);
  if (!coma) fail(`${name} ${id} is not in comas`);
  return coma;
}

// hover を受けるコマの前提: 中心が画面の内側にあり、縁がどの部品からも 6 px 以上離れる。
// 部品の下に掛かったコマは部品の側のものとして扱い、呼び手はこの前提のコマにだけ hover を渡す。
function requireHoverable(hover, radius, parts, screen) {
  if (!insideScreen(hover.x, hover.y, screen.width, screen.height)) {
    fail(`the hovered coma ${hover.id} must have its centre inside the screen`);
  }
  parts.forEach((part, i) => {
    if (!(pointRectDistance(hover.x, hover.y, part) - radius >= PART_CLEARANCE)) {
      fail(`the hovered coma ${hover.id} must keep its rim ${PART_CLEARANCE} px clear of parts[${i}]`);
    }
  });
}

function requirePoint(name, point) {
  if (!point || typeof point !== 'object') fail(`${name} must be { x, y }`);
  requireFinite(`${name}.x`, point.x);
  requireFinite(`${name}.y`, point.y);
  return point;
}

// ---------------------------------------------------------------------------
// 矩形

function makeRect(left, top, right, bottom) {
  return { left, top, right, bottom };
}

function rectFromInput(rect) {
  return solidRect(makeRect(rect.left, rect.top, rect.right, rect.bottom));
}

// 線との距離を測る矩形は4辺の線分を持つ。
function solidRect(rect) {
  const { left, top, right, bottom } = rect;
  return {
    left,
    top,
    right,
    bottom,
    edges: [
      makeLine(left, top, right, top),
      makeLine(right, top, right, bottom),
      makeLine(right, bottom, left, bottom),
      makeLine(left, bottom, left, top)
    ]
  };
}

function plainRect(rect) {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function rectDistance(a, b) {
  const dx = Math.max(0, a.left - b.right, b.left - a.right);
  const dy = Math.max(0, a.top - b.bottom, b.top - a.bottom);
  return Math.hypot(dx, dy);
}

function pointRectDistance(x, y, rect) {
  const dx = Math.max(0, rect.left - x, x - rect.right);
  const dy = Math.max(0, rect.top - y, y - rect.bottom);
  return Math.hypot(dx, dy);
}

function pointInRect(x, y, rect) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function rectInsideScreen(rect, width, height) {
  return rect.left >= 0 && rect.top >= 0 && rect.right <= width && rect.bottom <= height;
}

function rectTouchesScreen(rect, width, height) {
  return rect.right > 0 && rect.bottom > 0 && rect.left < width && rect.top < height;
}

function centeredRect(cx, cy, width, height) {
  return makeRect(cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2);
}

// 円（中心と半径）の 真上・真下・右・左 に、円の縁から gap 離して置く矩形。
function rectBesideCircle(cx, cy, radius, side, gap, width, height) {
  const reach = radius + gap;
  switch (side) {
    case 'above': return makeRect(cx - width / 2, cy - reach - height, cx + width / 2, cy - reach);
    case 'below': return makeRect(cx - width / 2, cy + reach, cx + width / 2, cy + reach + height);
    case 'right': return makeRect(cx + reach, cy - height / 2, cx + reach + width, cy + height / 2);
    case 'left': return makeRect(cx - reach - width, cy - height / 2, cx - reach, cy + height / 2);
    default: return fail(`unknown side ${side}`);
  }
}

// 矩形（枠）の 真上・真下・右・左 に、枠から gap 離して置く矩形。
function rectBesideBox(box, side, gap, width, height) {
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  switch (side) {
    case 'above': return makeRect(cx - width / 2, box.top - gap - height, cx + width / 2, box.top - gap);
    case 'below': return makeRect(cx - width / 2, box.bottom + gap, cx + width / 2, box.bottom + gap + height);
    case 'right': return makeRect(box.right + gap, cy - height / 2, box.right + gap + width, cy + height / 2);
    case 'left': return makeRect(box.left - gap - width, cy - height / 2, box.left - gap, cy + height / 2);
    default: return fail(`unknown side ${side}`);
  }
}

// ---------------------------------------------------------------------------
// 線の部品: 線分と円弧。どれも始点 (x0, y0)・終点 (x1, y1) と外接枠 box を持つ。

function mod(a, m) {
  const r = a % m;
  return r < 0 ? r + m : r;
}

function makeLine(x0, y0, x1, y1) {
  return {
    type: 'line',
    x0,
    y0,
    x1,
    y1,
    box: makeRect(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1))
  };
}

function angleInArc(theta, a0, sweep) {
  if (sweep >= 0) return mod(theta - a0, TAU) <= sweep + 1e-12;
  return mod(a0 - theta, TAU) <= -sweep + 1e-12;
}

function makeArc(cx, cy, r, a0, sweep) {
  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a0 + sweep);
  const y1 = cy + r * Math.sin(a0 + sweep);
  let left = Math.min(x0, x1);
  let right = Math.max(x0, x1);
  let top = Math.min(y0, y1);
  let bottom = Math.max(y0, y1);
  for (let k = 0; k < 4; k += 1) {
    const a = k * Math.PI / 2;
    if (!angleInArc(a, a0, sweep)) continue;
    const px = cx + r * Math.cos(a);
    const py = cy + r * Math.sin(a);
    left = Math.min(left, px);
    right = Math.max(right, px);
    top = Math.min(top, py);
    bottom = Math.max(bottom, py);
  }
  return { type: 'arc', cx, cy, r, a0, sweep, x0, y0, x1, y1, box: makeRect(left, top, right, bottom) };
}

function primPoint(prim, t) {
  if (prim.type === 'line') return [prim.x0 + (prim.x1 - prim.x0) * t, prim.y0 + (prim.y1 - prim.y0) * t];
  const a = prim.a0 + prim.sweep * t;
  return [prim.cx + prim.r * Math.cos(a), prim.cy + prim.r * Math.sin(a)];
}

function subPrim(prim, t0, t1) {
  if (prim.type === 'line') {
    const [ax, ay] = primPoint(prim, t0);
    const [bx, by] = primPoint(prim, t1);
    return makeLine(ax, ay, bx, by);
  }
  return makeArc(prim.cx, prim.cy, prim.r, prim.a0 + prim.sweep * t0, prim.sweep * (t1 - t0));
}

function arcParamOfAngle(arc, theta) {
  if (arc.sweep >= 0) {
    const d = mod(theta - arc.a0, TAU);
    return d <= arc.sweep + 1e-12 ? d / arc.sweep : null;
  }
  const d = mod(arc.a0 - theta, TAU);
  return d <= -arc.sweep + 1e-12 ? d / -arc.sweep : null;
}

// 3 点を通る円弧（P0 → Pm → P1）。3 点が一直線なら null。
function arcThrough(x0, y0, xm, ym, x1, y1) {
  const d = 2 * (x0 * (ym - y1) + xm * (y1 - y0) + x1 * (y0 - ym));
  if (Math.abs(d) < 1e-12) return null;
  const s0 = x0 * x0 + y0 * y0;
  const sm = xm * xm + ym * ym;
  const s1 = x1 * x1 + y1 * y1;
  const ux = (s0 * (ym - y1) + sm * (y1 - y0) + s1 * (y0 - ym)) / d;
  const uy = (s0 * (x1 - xm) + sm * (x0 - x1) + s1 * (xm - x0)) / d;
  const r = Math.hypot(x0 - ux, y0 - uy);
  const a0 = Math.atan2(y0 - uy, x0 - ux);
  const am = Math.atan2(ym - uy, xm - ux);
  const a1 = Math.atan2(y1 - uy, x1 - ux);
  let sweep = mod(a1 - a0, TAU);
  if (!(mod(am - a0, TAU) < sweep)) sweep -= TAU;
  return makeArc(ux, uy, r, a0, sweep);
}

// P で向き T に接し Q を通る円弧（一直線なら線分）。Q が後ろ向きの一直線なら null。
function arcTangentThrough(px, py, tx, ty, qx, qy) {
  const vx = qx - px;
  const vy = qy - py;
  const v2 = vx * vx + vy * vy;
  if (v2 < 1e-18) return null;
  const nx = ty;
  const ny = -tx;
  const vn = vx * nx + vy * ny;
  if (Math.abs(vn) < 1e-9 * Math.sqrt(v2)) {
    return vx * tx + vy * ty > 0 ? makeLine(px, py, qx, qy) : null;
  }
  const rho = v2 / (2 * vn);
  const ox = px + rho * nx;
  const oy = py + rho * ny;
  const r = Math.abs(rho);
  const a0 = Math.atan2(py - oy, px - ox);
  const a1 = Math.atan2(qy - oy, qx - ox);
  const turning = (px - ox) * ty - (py - oy) * tx;
  const sweep = turning > 0 ? mod(a1 - a0, TAU) : -mod(a0 - a1, TAU);
  return makeArc(ox, oy, r, a0, sweep);
}

// P0 で向き T0 に出て P1 に向き T1 で入る、二つの円弧を接線でつないだ線。
// junction は 0 に近いほどつなぎ目が P0 の近く、1 に近いほど P1 の近く。
function biarc(p0x, p0y, t0x, t0y, p1x, p1y, t1x, t1y, junction) {
  const vx = p1x - p0x;
  const vy = p1y - p0y;
  const v2 = vx * vx + vy * vy;
  const k = junction / (1 - junction);
  const vt0 = vx * t0x + vy * t0y;
  const vt1 = vx * t1x + vy * t1y;
  const tt = t0x * t1x + t0y * t1y;
  const a = 2 * k * (1 - tt);
  const b = 2 * (k * vt0 + vt1);
  let d1;
  if (a < 1e-12) {
    if (b <= 1e-12) return null;
    d1 = v2 / b;
  } else {
    d1 = (-b + Math.sqrt(b * b + 4 * a * v2)) / (2 * a);
  }
  if (!(d1 > 1e-9)) return null;
  const d0 = k * d1;
  const q0x = p0x + d0 * t0x;
  const q0y = p0y + d0 * t0y;
  const q1x = p1x - d1 * t1x;
  const q1y = p1y - d1 * t1y;
  const qx = q1x - q0x;
  const qy = q1y - q0y;
  const ql = Math.hypot(qx, qy);
  if (ql < 1e-9) return null;
  const jx = q0x + qx * d0 / (d0 + d1);
  const jy = q0y + qy * d0 / (d0 + d1);
  const first = arcTangentThrough(p0x, p0y, t0x, t0y, jx, jy);
  const second = arcTangentThrough(jx, jy, qx / ql, qy / ql, p1x, p1y);
  if (!first || !second) return null;
  return [first, second];
}

// ---------------------------------------------------------------------------
// 距離

function pointSegmentDistance(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

function pointPrimDistance(px, py, prim) {
  if (prim.type === 'line') return pointSegmentDistance(px, py, prim.x0, prim.y0, prim.x1, prim.y1);
  const dx = px - prim.cx;
  const dy = py - prim.cy;
  const d = Math.hypot(dx, dy);
  if (d > 1e-12 && angleInArc(Math.atan2(dy, dx), prim.a0, prim.sweep)) return Math.abs(d - prim.r);
  return Math.min(Math.hypot(px - prim.x0, py - prim.y0), Math.hypot(px - prim.x1, py - prim.y1));
}

function orientation(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function segmentSegmentDistance(a, b) {
  const d1 = orientation(b.x0, b.y0, b.x1, b.y1, a.x0, a.y0);
  const d2 = orientation(b.x0, b.y0, b.x1, b.y1, a.x1, a.y1);
  const d3 = orientation(a.x0, a.y0, a.x1, a.y1, b.x0, b.y0);
  const d4 = orientation(a.x0, a.y0, a.x1, a.y1, b.x1, b.y1);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(
    pointSegmentDistance(a.x0, a.y0, b.x0, b.y0, b.x1, b.y1),
    pointSegmentDistance(a.x1, a.y1, b.x0, b.y0, b.x1, b.y1),
    pointSegmentDistance(b.x0, b.y0, a.x0, a.y0, a.x1, a.y1),
    pointSegmentDistance(b.x1, b.y1, a.x0, a.y0, a.x1, a.y1)
  );
}

// 線分と円弧の距離: 端点どうしの組、交点、中心から線分へ下ろした垂線上の円の点を候補にする。
function segmentArcDistance(seg, arc) {
  let best = Math.min(
    pointPrimDistance(seg.x0, seg.y0, arc),
    pointPrimDistance(seg.x1, seg.y1, arc),
    pointSegmentDistance(arc.x0, arc.y0, seg.x0, seg.y0, seg.x1, seg.y1),
    pointSegmentDistance(arc.x1, arc.y1, seg.x0, seg.y0, seg.x1, seg.y1)
  );
  const dx = seg.x1 - seg.x0;
  const dy = seg.y1 - seg.y0;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-18) return best;
  const len = Math.sqrt(len2);
  const t = ((arc.cx - seg.x0) * dx + (arc.cy - seg.y0) * dy) / len2;
  const fx = seg.x0 + t * dx;
  const fy = seg.y0 + t * dy;
  const h = Math.hypot(arc.cx - fx, arc.cy - fy);
  if (h <= arc.r) {
    const off = Math.sqrt(arc.r * arc.r - h * h) / len;
    for (const tt of [t - off, t + off]) {
      if (tt < 0 || tt > 1) continue;
      const px = seg.x0 + tt * dx;
      const py = seg.y0 + tt * dy;
      if (angleInArc(Math.atan2(py - arc.cy, px - arc.cx), arc.a0, arc.sweep)) return 0;
    }
  }
  if (t >= 0 && t <= 1) {
    const nx = -dy / len;
    const ny = dx / len;
    for (const sign of [1, -1]) {
      if (!angleInArc(Math.atan2(sign * ny, sign * nx), arc.a0, arc.sweep)) continue;
      const px = arc.cx + sign * arc.r * nx;
      const py = arc.cy + sign * arc.r * ny;
      best = Math.min(best, Math.hypot(px - fx, py - fy));
    }
  }
  return best;
}

function circleIntersections(x0, y0, r0, x1, y1, r1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const d = Math.hypot(dx, dy);
  if (d < 1e-12 || d > r0 + r1 || d < Math.abs(r0 - r1)) return [];
  const a = (r0 * r0 - r1 * r1 + d * d) / (2 * d);
  const h2 = r0 * r0 - a * a;
  const h = h2 > 0 ? Math.sqrt(h2) : 0;
  const mx = x0 + a * dx / d;
  const my = y0 + a * dy / d;
  return [[mx + h * dy / d, my - h * dx / d], [mx - h * dy / d, my + h * dx / d]];
}

// 円弧どうしの距離: 端点と相手の円弧、交点、中心を結ぶ直線上の点の組を候補にする。
function arcArcDistance(a, b) {
  let best = Math.min(
    pointPrimDistance(a.x0, a.y0, b),
    pointPrimDistance(a.x1, a.y1, b),
    pointPrimDistance(b.x0, b.y0, a),
    pointPrimDistance(b.x1, b.y1, a)
  );
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9) {
    const overlap = angleInArc(a.a0, b.a0, b.sweep) || angleInArc(a.a0 + a.sweep, b.a0, b.sweep)
      || angleInArc(b.a0, a.a0, a.sweep) || angleInArc(b.a0 + b.sweep, a.a0, a.sweep);
    return overlap ? Math.min(best, Math.abs(a.r - b.r)) : best;
  }
  for (const [px, py] of circleIntersections(a.cx, a.cy, a.r, b.cx, b.cy, b.r)) {
    if (angleInArc(Math.atan2(py - a.cy, px - a.cx), a.a0, a.sweep)
      && angleInArc(Math.atan2(py - b.cy, px - b.cx), b.a0, b.sweep)) return 0;
  }
  const ux = dx / d;
  const uy = dy / d;
  for (const sa of [1, -1]) {
    if (!angleInArc(Math.atan2(sa * uy, sa * ux), a.a0, a.sweep)) continue;
    const pax = a.cx + sa * a.r * ux;
    const pay = a.cy + sa * a.r * uy;
    for (const sb of [1, -1]) {
      if (!angleInArc(Math.atan2(sb * uy, sb * ux), b.a0, b.sweep)) continue;
      const pbx = b.cx + sb * b.r * ux;
      const pby = b.cy + sb * b.r * uy;
      best = Math.min(best, Math.hypot(pax - pbx, pay - pby));
    }
  }
  return best;
}

function primPrimDistance(a, b) {
  if (a.type === 'line') return b.type === 'line' ? segmentSegmentDistance(a, b) : segmentArcDistance(a, b);
  return b.type === 'line' ? segmentArcDistance(b, a) : arcArcDistance(a, b);
}

function primRectDistance(prim, rect) {
  if (pointInRect(prim.x0, prim.y0, rect) || pointInRect(prim.x1, prim.y1, rect)) return 0;
  let best = Infinity;
  for (const edge of rect.edges) best = Math.min(best, primPrimDistance(prim, edge));
  return best;
}

function pathRectClear(prims, rect, gap) {
  for (const prim of prims) {
    if (rectDistance(prim.box, rect) > gap) continue;
    if (primRectDistance(prim, rect) <= gap) return false;
  }
  return true;
}

function pathsClear(a, b, gap) {
  // どの線も hover したコマの縁から出るので、出る点どうしが近ければ測るまでもない。
  if (Math.hypot(a[0].x0 - b[0].x0, a[0].y0 - b[0].y0) <= gap) return false;
  for (const pa of a) {
    for (const pb of b) {
      if (rectDistance(pa.box, pb.box) > gap) continue;
      if (primPrimDistance(pa, pb) <= gap) return false;
    }
  }
  return true;
}

function pathPointDistance(prims, x, y) {
  let best = Infinity;
  for (const prim of prims) best = Math.min(best, pointPrimDistance(x, y, prim));
  return best;
}

// 線の部品と直線 x = value（axis 'x'）・y = value（axis 'y'）の交わる媒介変数。
function axisParams(prim, axis, value) {
  if (prim.type === 'line') {
    const a = axis === 'x' ? prim.x0 : prim.y0;
    const b = axis === 'x' ? prim.x1 : prim.y1;
    if (Math.abs(b - a) < 1e-15) return [];
    const t = (value - a) / (b - a);
    return t >= 0 && t <= 1 ? [t] : [];
  }
  const c = axis === 'x' ? prim.cx : prim.cy;
  const q = (value - c) / prim.r;
  if (q < -1 || q > 1) return [];
  const base = axis === 'x' ? Math.acos(q) : Math.asin(q);
  const thetas = axis === 'x' ? [base, -base] : [base, Math.PI - base];
  const params = [];
  for (const theta of thetas) {
    const t = arcParamOfAngle(prim, theta);
    if (t !== null) params.push(t);
  }
  return params;
}

function circleParams(prim, cx, cy, radius) {
  if (prim.type === 'line') {
    const dx = prim.x1 - prim.x0;
    const dy = prim.y1 - prim.y0;
    const fx = prim.x0 - cx;
    const fy = prim.y0 - cy;
    const a = dx * dx + dy * dy;
    const b = 2 * (fx * dx + fy * dy);
    const c = fx * fx + fy * fy - radius * radius;
    const disc = b * b - 4 * a * c;
    if (a < 1e-18 || disc < 0) return [];
    const sq = Math.sqrt(disc);
    return [(-b - sq) / (2 * a), (-b + sq) / (2 * a)].filter((t) => t >= 0 && t <= 1);
  }
  const params = [];
  for (const [px, py] of circleIntersections(prim.cx, prim.cy, prim.r, cx, cy, radius)) {
    const t = arcParamOfAngle(prim, Math.atan2(py - prim.cy, px - prim.cx));
    if (t !== null) params.push(t);
  }
  return params;
}

function insideScreen(x, y, width, height) {
  return x >= -SCREEN_TOLERANCE && y >= -SCREEN_TOLERANCE && x <= width + SCREEN_TOLERANCE && y <= height + SCREEN_TOLERANCE;
}

// 部品が画面から最初に出る媒介変数。出なければ null。
function firstScreenExit(prim, width, height) {
  const params = [
    ...axisParams(prim, 'x', 0),
    ...axisParams(prim, 'x', width),
    ...axisParams(prim, 'y', 0),
    ...axisParams(prim, 'y', height)
  ].filter((t) => t > 0 && t < 1).sort((a, b) => a - b);
  const bounds = [0, ...params, 1];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const a = bounds[i];
    const b = bounds[i + 1];
    if (b - a < 1e-12) continue;
    const [mx, my] = primPoint(prim, (a + b) / 2);
    if (!insideScreen(mx, my, width, height)) return a;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 状態 4: 一言の札の置き場（段階 1）

function chordCrossesRect(chord, rect) {
  return !pathRectClear([chord], rect, LINE_CLEARANCE);
}

function comaFreeRect(rect, comas, radius) {
  return comas.every((coma) => pointRectDistance(coma.x, coma.y, rect) >= radius);
}

function partsClear(rect, parts) {
  return parts.every((part) => rectDistance(rect, part) >= PART_CLEARANCE);
}

export function placeSayLabel(input) {
  if (!input || typeof input !== 'object') fail('placeSayLabel needs an input object');
  const screen = requireScreen(input.screen);
  const parts = requireParts(input.parts);
  const radius = requirePositive('comaRadius', input.comaRadius);
  const byId = requireComas(input.comas);
  const hover = requireComa(byId, input.hoverId, 'hoverId');
  requireHoverable(hover, radius, parts, screen);
  const width = requirePositive('width', input.width);
  const height = requirePositive('height', input.height);
  if (!Array.isArray(input.targetIds)) fail('targetIds must be an array');
  const seen = new Set();
  const targets = input.targetIds.map((id) => {
    if (id === input.hoverId) fail(`targetIds must not contain the hovered coma ${id}`);
    if (seen.has(id)) fail(`duplicate target id ${id}`);
    seen.add(id);
    return requireComa(byId, id, 'targetIds');
  });
  const others = input.comas.filter((coma) => coma.id !== hover.id);
  const chords = targets.map((target) => makeLine(hover.x, hover.y, target.x, target.y));

  const usable = SIDE_ORDER_SAY
    .map((side) => ({ side, rect: rectBesideCircle(hover.x, hover.y, radius, side, SAY_GAP, width, height) }))
    .filter(({ rect }) => rectInsideScreen(rect, screen.width, screen.height) && partsClear(rect, parts));
  if (usable.length === 0) fail(`no say-label side of ${hover.id} is inside the screen and clear of the parts`);
  const comaFree = usable.filter(({ rect }) => comaFreeRect(rect, others, radius));
  const pool = comaFree.length > 0 ? comaFree : usable;
  const counted = pool.map((candidate) => {
    const solid = solidRect(candidate.rect);
    return { ...candidate, crossings: chords.filter((chord) => chordCrossesRect(chord, solid)).length };
  });
  const clear = counted.find(({ crossings }) => crossings === 0);
  const chosen = clear ?? [...counted].sort((a, b) => a.crossings - b.crossings
    || SIDE_TIE_ORDER_SAY.indexOf(a.side) - SIDE_TIE_ORDER_SAY.indexOf(b.side))[0];
  return { side: chosen.side, rect: plainRect(chosen.rect) };
}

// ---------------------------------------------------------------------------
// 状態 5: 線と気持ちの札（段階 2）

function alternatingStep(k) {
  if (k === 0) return 0;
  return k % 2 === 1 ? (k + 1) / 2 : -k / 2;
}

function rotate(x, y, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [x * c - y * s, x * s + y * c];
}

function buildRelationContext(input) {
  const screen = requireScreen(input.screen);
  const parts = requireParts(input.parts).map(rectFromInput);
  const radius = requirePositive('comaRadius', input.comaRadius);
  const byId = requireComas(input.comas);
  const hover = requireComa(byId, input.hoverId, 'hoverId');
  requireHoverable(hover, radius, parts, screen);
  const say = input.sayLabel;
  if (!say || typeof say !== 'object') fail('sayLabel must be the result of placeSayLabel');
  if (!SIDE_ORDER_SAY.includes(say.side)) fail(`sayLabel.side must be one of ${SIDE_ORDER_SAY.join(', ')}`);
  requireRect('sayLabel.rect', say.rect);
  if (!Array.isArray(input.targets)) fail('targets must be an array');

  const width = screen.width;
  const height = screen.height;
  const smax = Math.ceil(Math.hypot(width, height));
  const smax4 = Math.floor(smax / SAGITTA_STEP_WIDE);
  const ns1 = 2 * smax + 1;
  const ns4 = 2 * smax4 + 1;
  const rotBase = ns1;
  const biarcBase = rotBase + STAGE3_ROTATIONS.length * ns4;
  const total = biarcBase + STAGE4_PAIRS.length * BIARC_JUNCTIONS.length;

  const seen = new Set();
  const targets = input.targets.map((target, index) => {
    if (!target || typeof target !== 'object') fail(`targets[${index}] must be { id, width, height }`);
    if (target.id === hover.id) fail(`targets must not contain the hovered coma ${hover.id}`);
    if (seen.has(target.id)) fail(`duplicate target id ${target.id}`);
    seen.add(target.id);
    const coma = requireComa(byId, target.id, 'targets');
    const labelWidth = requirePositive(`targets[${index}].width`, target.width);
    const labelHeight = requirePositive(`targets[${index}].height`, target.height);
    const dist = Math.hypot(coma.x - hover.x, coma.y - hover.y);
    return {
      id: coma.id,
      index,
      x: coma.x,
      y: coma.y,
      dx: (coma.x - hover.x) / dist,
      dy: (coma.y - hover.y) / dist,
      dist,
      offscreen: !insideScreen(coma.x, coma.y, width, height),
      labelWidth,
      labelHeight,
      others: input.comas.filter((other) => other.id !== hover.id && other.id !== coma.id),
      memo: null,
      paths: new Map(),
      domains: new Map(),
      qualifiesForRotation: undefined
    };
  });
  const order = [...targets].sort((a, b) => a.dist - b.dist || a.index - b.index);
  const sayRect = rectFromInput(say.rect);
  return {
    width,
    height,
    diagonal: Math.hypot(width, height),
    radius,
    hover,
    comas: input.comas,
    parts,
    sayRect,
    fixedRects: [sayRect, ...parts],
    smax,
    smax4,
    ns1,
    ns4,
    rotBase,
    biarcBase,
    total,
    order,
    keySpace: targets.length * total,
    pairMemo: new Map(),
    prefixMemo: new Map(),
    grid: null
  };
}

// 段 1・2 の形: 二人の中心を通る円弧（膨らみ 0 は直線）を、コマの縁で切る。
function sagittaPrims(ctx, line, sagitta) {
  const { hover, radius } = ctx;
  if (sagitta === 0) {
    return [makeLine(hover.x + radius * line.dx, hover.y + radius * line.dy, line.x - radius * line.dx, line.y - radius * line.dy)];
  }
  const mx = (hover.x + line.x) / 2 + sagitta * line.dy;
  const my = (hover.y + line.y) / 2 - sagitta * line.dx;
  const arc = arcThrough(hover.x, hover.y, mx, my, line.x, line.y);
  if (!arc) return null;
  const leave = circleParams(arc, hover.x, hover.y, radius).filter((t) => t > 1e-12 && t < 1);
  if (leave.length === 0) return null;
  const t0 = Math.min(...leave);
  const enter = circleParams(arc, line.x, line.y, radius).filter((t) => t > t0 && t < 1);
  if (enter.length === 0) return null;
  return [subPrim(arc, t0, Math.min(...enter))];
}

// 段 3 の形: 出る点を回し、その点と相手の中心を通る円弧を相手の縁で切る。
function rotatedPrims(ctx, line, rotation, sagitta) {
  const { hover, radius } = ctx;
  const [ux, uy] = rotate(line.dx, line.dy, -rotation * DEG);
  const px = hover.x + radius * ux;
  const py = hover.y + radius * uy;
  let prim;
  if (sagitta === 0) {
    prim = makeLine(px, py, line.x, line.y);
  } else {
    const len = Math.hypot(line.x - px, line.y - py);
    const dx = (line.x - px) / len;
    const dy = (line.y - py) / len;
    prim = arcThrough(px, py, (px + line.x) / 2 + sagitta * dy, (py + line.y) / 2 - sagitta * dx, line.x, line.y);
    if (!prim) return null;
  }
  const enter = circleParams(prim, line.x, line.y, radius).filter((t) => t > 1e-12 && t < 1);
  if (enter.length === 0) return null;
  return [subPrim(prim, 0, Math.min(...enter))];
}

// 段 4 の形: 縁に垂直に出て縁に垂直に入る、二つの円弧を接線でつないだ線。
function biarcPrims(ctx, line, exitRotation, entryRotation, junction) {
  const { hover, radius } = ctx;
  const [u0x, u0y] = rotate(line.dx, line.dy, -exitRotation * DEG);
  const [u1x, u1y] = rotate(-line.dx, -line.dy, entryRotation * DEG);
  return biarc(
    hover.x + radius * u0x, hover.y + radius * u0y, u0x, u0y,
    line.x + radius * u1x, line.y + radius * u1y, -u1x, -u1y,
    junction
  );
}

function finishCandidate(ctx, line, prims, shape) {
  if (!prims) return null;
  let path = prims;
  let cut = null;
  if (line.offscreen) {
    if (!insideScreen(path[0].x0, path[0].y0, ctx.width, ctx.height)) return null;
    for (let i = 0; i < path.length; i += 1) {
      const exit = firstScreenExit(path[i], ctx.width, ctx.height);
      if (exit === null) continue;
      if (exit < 1e-12 && i === 0) return null;
      const head = exit < 1e-12 ? path.slice(0, i) : [...path.slice(0, i), subPrim(path[i], 0, exit)];
      const last = head[head.length - 1];
      path = head;
      cut = { x: last.x1, y: last.y1 };
      break;
    }
  }
  const boxInside = (box) => box.left >= -SCREEN_TOLERANCE && box.top >= -SCREEN_TOLERANCE
    && box.right <= ctx.width + SCREEN_TOLERANCE && box.bottom <= ctx.height + SCREEN_TOLERANCE;
  if (!path.every((prim) => boxInside(prim.box))) return null;
  if (pathPointDistance(path, ctx.hover.x, ctx.hover.y) < ctx.radius - END_TOLERANCE) return null;
  if (pathPointDistance(path, line.x, line.y) < ctx.radius - END_TOLERANCE) return null;
  return { prims: path, cut, shape };
}

function buildCandidate(ctx, line, idx) {
  if (idx < ctx.ns1) {
    const sagitta = idx - ctx.smax;
    return finishCandidate(ctx, line, sagittaPrims(ctx, line, sagitta), { kind: 'sagitta', sagitta });
  }
  if (idx < ctx.biarcBase) {
    const k = idx - ctx.rotBase;
    const exitRotation = STAGE3_ROTATIONS[Math.floor(k / ctx.ns4)];
    const sagitta = ((k % ctx.ns4) - ctx.smax4) * SAGITTA_STEP_WIDE;
    return finishCandidate(ctx, line, rotatedPrims(ctx, line, exitRotation, sagitta), { kind: 'rotated', exitRotation, sagitta });
  }
  const k = idx - ctx.biarcBase;
  const [exitRotation, entryRotation] = STAGE4_PAIRS[Math.floor(k / BIARC_JUNCTIONS.length)];
  const junction = BIARC_JUNCTIONS[k % BIARC_JUNCTIONS.length];
  return finishCandidate(
    ctx,
    line,
    biarcPrims(ctx, line, exitRotation, entryRotation, junction),
    { kind: 'biarc', exitRotation, entryRotation, junction }
  );
}

// 札・部品から 12 px より離れていなければ -Infinity、離れていれば端点以外のコマの縁との最小の離れ
// （12 px を超える離れは Infinity にまとめる）。候補ごとに一度だけ測って覚える。
function candidateScore(ctx, line, idx) {
  if (!line.memo) line.memo = new Float64Array(ctx.total).fill(Number.NaN);
  const cached = line.memo[idx];
  if (!Number.isNaN(cached)) return cached;
  const candidate = buildCandidate(ctx, line, idx);
  let score = -Infinity;
  if (candidate && ctx.fixedRects.every((rect) => pathRectClear(candidate.prims, rect, LINE_CLEARANCE))) {
    score = Infinity;
    for (const coma of line.others) {
      for (const prim of candidate.prims) {
        if (pointRectDistance(coma.x, coma.y, prim.box) - ctx.radius > LINE_CLEARANCE) continue;
        score = Math.min(score, pointPrimDistance(coma.x, coma.y, prim) - ctx.radius);
      }
    }
  }
  line.memo[idx] = score;
  if (score > COMA_CLEARANCE_TIGHT) {
    candidate.key = line.index * ctx.total + idx;
    line.paths.set(idx, candidate);
  }
  return score;
}

// 線どうしの離れ。同じ組は段と決め直しをまたいで何度も問われるので、呼び出しの中で覚える。
// 出る点どうしで決まる組は測るまでもないので覚えない。
function linesClear(ctx, a, b, gap) {
  if (Math.hypot(a.prims[0].x0 - b.prims[0].x0, a.prims[0].y0 - b.prims[0].y0) <= gap) return false;
  const lo = Math.min(a.key, b.key);
  const hi = Math.max(a.key, b.key);
  const key = (lo * ctx.keySpace + hi) * 2 + (gap === LINE_GAP_WIDE ? 1 : 0);
  let clear = ctx.pairMemo.get(key);
  if (clear === undefined) {
    clear = pathsClear(a.prims, b.prims, gap);
    ctx.pairMemo.set(key, clear);
  }
  return clear;
}

function comaClearanceOfStage(stage) {
  return stage === 5 ? COMA_CLEARANCE_TIGHT : LINE_CLEARANCE;
}

function lineGapOfStage(stage) {
  return stage === 1 ? LINE_GAP_WIDE : LINE_GAP_TIGHT;
}

// 段 3 で出る点を回すのは、段 1 の形のどの候補も札・部品・コマから離れられない線だけ。
function qualifiesForRotation(ctx, line) {
  if (line.qualifiesForRotation === undefined) {
    let found = false;
    for (let idx = 0; idx < ctx.ns1 && !found; idx += 1) found = candidateScore(ctx, line, idx) > LINE_CLEARANCE;
    line.qualifiesForRotation = !found;
  }
  return line.qualifiesForRotation;
}

function stageOrderSize(ctx, line, stage) {
  if (stage === 1) return ctx.ns1;
  let size = ctx.ns4;
  if (stage >= 3 && qualifiesForRotation(ctx, line)) size += STAGE3_ROTATIONS.length * ctx.ns4;
  if (stage >= 4) size += STAGE4_PAIRS.length * BIARC_JUNCTIONS.length;
  return size;
}

function stageOrderIndex(ctx, line, stage, position) {
  if (stage === 1) return ctx.smax + alternatingStep(position);
  if (position < ctx.ns4) return ctx.smax + SAGITTA_STEP_WIDE * alternatingStep(position);
  let k = position - ctx.ns4;
  if (stage >= 3 && qualifiesForRotation(ctx, line)) {
    const rotated = STAGE3_ROTATIONS.length * ctx.ns4;
    if (k < rotated) {
      return ctx.rotBase + Math.floor(k / ctx.ns4) * ctx.ns4 + ctx.smax4 + alternatingStep(k % ctx.ns4);
    }
    k -= rotated;
  }
  return ctx.biarcBase + k;
}

// 段ごとの候補の列のうち、札・部品・コマから離れるものだけを、必要になった所まで順に数える。
function domainAt(ctx, line, stage, k) {
  let domain = line.domains.get(stage);
  if (!domain) {
    domain = { next: 0, size: stageOrderSize(ctx, line, stage), valid: [] };
    line.domains.set(stage, domain);
  }
  const clearance = comaClearanceOfStage(stage);
  while (domain.valid.length <= k && domain.next < domain.size) {
    const idx = stageOrderIndex(ctx, line, stage, domain.next);
    domain.next += 1;
    if (candidateScore(ctx, line, idx) > clearance) domain.valid.push(idx);
  }
  return k < domain.valid.length ? domain.valid[k] : -1;
}

// 線を近い順に 1 本ずつ決める。決まらない線が出たら、1 本前の線を次の候補に替えて決め直す。
// 1 本前の線に次の候補が無ければ、この段では全部の線が決まらない。
// 決め方は前から順に進むだけなので、先頭から j 本の決まり方はその j 本（と段・避ける札）だけで決まる。
// 最後の段は同じ先頭を持つ線の組を何度も解くので、先頭ごとの決まり方を呼び出しの中で覚えて使い回す。
function solveStage(ctx, lines, stage, extraRects, extrasKey) {
  const gap = lineGapOfStage(stage);
  const prefixKeys = [];
  let key = `${stage}|${extrasKey}|`;
  for (const line of lines) {
    key += `${line.index},`;
    prefixKeys.push(key);
  }
  let start = 0;
  let chosen = [];
  let position = [];
  for (let j = lines.length; j >= 1; j -= 1) {
    const cached = ctx.prefixMemo.get(prefixKeys[j - 1]);
    if (cached === undefined) continue;
    if (cached === null) return null;
    start = j;
    chosen = cached.chosen.slice();
    position = cached.position.slice();
    break;
  }
  const remember = (j, state) => ctx.prefixMemo.set(prefixKeys[j], state && { chosen: chosen.slice(0, j + 1), position: position.slice(0, j + 1) });
  const clearOfExtras = (candidate) => extraRects.every((rect) => pathRectClear(candidate.prims, rect, LINE_CLEARANCE));
  const clearOfChosen = (candidate, upTo) => {
    for (let h = 0; h < upTo; h += 1) if (!linesClear(ctx, chosen[h], candidate, gap)) return false;
    return true;
  };
  for (let j = start; j < lines.length; j += 1) {
    const line = lines[j];
    // 1 本前の線にだけ阻まれた候補（1 本前の線を替えれば使えるかもしれない候補）を順に控える。
    const blockedByPrevious = [];
    let found = -1;
    for (let k = 0; ; k += 1) {
      const idx = domainAt(ctx, line, stage, k);
      if (idx < 0) break;
      const candidate = line.paths.get(idx);
      if (!clearOfExtras(candidate) || !clearOfChosen(candidate, j - 1)) continue;
      if (j === 0 || linesClear(ctx, chosen[j - 1], candidate, gap)) {
        found = k;
        break;
      }
      blockedByPrevious.push(k);
    }
    if (found >= 0) {
      position[j] = found;
      chosen[j] = line.paths.get(domainAt(ctx, line, stage, found));
      remember(j, true);
      continue;
    }
    if (blockedByPrevious.length === 0) {
      remember(j, null);
      return null;
    }
    const previous = lines[j - 1];
    let settled = false;
    for (let p = position[j - 1] + 1; !settled; p += 1) {
      const idx = domainAt(ctx, previous, stage, p);
      if (idx < 0) {
        remember(j, null);
        return null;
      }
      const replacement = previous.paths.get(idx);
      if (!clearOfExtras(replacement) || !clearOfChosen(replacement, j - 1)) continue;
      for (const k of blockedByPrevious) {
        const candidate = line.paths.get(domainAt(ctx, line, stage, k));
        if (!linesClear(ctx, replacement, candidate, gap)) continue;
        position[j - 1] = p;
        chosen[j - 1] = replacement;
        position[j] = k;
        chosen[j] = candidate;
        settled = true;
        break;
      }
    }
    remember(j, true);
  }
  return chosen;
}

function rectsKey(rects) {
  return rects.map((rect) => `${rect.left},${rect.top},${rect.right},${rect.bottom}`).join(';');
}

function solveLines(ctx, lines, extraRects) {
  if (lines.length === 0) return { stage: null, chosen: new Map() };
  const extrasKey = rectsKey(extraRects);
  for (let stage = 1; stage <= 5; stage += 1) {
    const chosen = solveStage(ctx, lines, stage, extraRects, extrasKey);
    if (chosen) return { stage, chosen: new Map(lines.map((line, i) => [line.id, chosen[i]])) };
  }
  return null;
}

// 届く道の確かめ: 端点以外のコマの縁から 4 px、一言の札・部品から 12 px より離れたまま、
// hover したコマの縁から相手の縁（画面の外の相手なら画面の端）まで 1 px の格子で辿れるか。
function reachGrid(ctx) {
  if (ctx.grid) return ctx.grid;
  const cols = Math.ceil(ctx.width);
  const rows = Math.ceil(ctx.height);
  const count = new Uint8Array(cols * rows);
  const markDisc = (cx, cy, rad, inclusive) => {
    const i0 = Math.max(0, Math.floor(cx - rad - 1));
    const i1 = Math.min(cols - 1, Math.ceil(cx + rad + 1));
    const j0 = Math.max(0, Math.floor(cy - rad - 1));
    const j1 = Math.min(rows - 1, Math.ceil(cy + rad + 1));
    for (let j = j0; j <= j1; j += 1) {
      for (let i = i0; i <= i1; i += 1) {
        const d = Math.hypot(i + 0.5 - cx, j + 0.5 - cy);
        if (inclusive ? d <= rad : d < rad) count[j * cols + i] += 1;
      }
    }
  };
  markDisc(ctx.hover.x, ctx.hover.y, ctx.radius, false);
  for (const coma of ctx.comas) {
    if (coma.id !== ctx.hover.id) markDisc(coma.x, coma.y, ctx.radius + COMA_CLEARANCE_TIGHT, true);
  }
  for (const rect of ctx.fixedRects) {
    const i0 = Math.max(0, Math.floor(rect.left - LINE_CLEARANCE - 1));
    const i1 = Math.min(cols - 1, Math.ceil(rect.right + LINE_CLEARANCE + 1));
    const j0 = Math.max(0, Math.floor(rect.top - LINE_CLEARANCE - 1));
    const j1 = Math.min(rows - 1, Math.ceil(rect.bottom + LINE_CLEARANCE + 1));
    for (let j = j0; j <= j1; j += 1) {
      for (let i = i0; i <= i1; i += 1) {
        if (pointRectDistance(i + 0.5, j + 0.5, rect) <= LINE_CLEARANCE) count[j * cols + i] += 1;
      }
    }
  }
  ctx.grid = { cols, rows, count };
  return ctx.grid;
}

const CELL_FREE = 0;
const CELL_BLOCKED = 1;
const CELL_GOAL = 2;

function reachable(ctx, line) {
  if (candidateScore(ctx, line, ctx.smax) > COMA_CLEARANCE_TIGHT) return true;
  const { cols, rows, count } = reachGrid(ctx);
  // 相手のコマは自分の線の端点なので、縁の外 4 px の帯を空け、縁のすぐ外の格子を行き先にする。
  const cells = new Uint8Array(cols * rows);
  for (let k = 0; k < cells.length; k += 1) cells[k] = count[k] > 0 ? CELL_BLOCKED : CELL_FREE;
  const near = ctx.radius + COMA_CLEARANCE_TIGHT;
  const goalReach = ctx.radius + 1.5;
  for (let j = Math.max(0, Math.floor(line.y - near - 1)); j <= Math.min(rows - 1, Math.ceil(line.y + near + 1)); j += 1) {
    for (let i = Math.max(0, Math.floor(line.x - near - 1)); i <= Math.min(cols - 1, Math.ceil(line.x + near + 1)); i += 1) {
      const d = Math.hypot(i + 0.5 - line.x, j + 0.5 - line.y);
      if (d > near) continue;
      const k = j * cols + i;
      if (count[k] - 1 + (d < ctx.radius ? 1 : 0) > 0) cells[k] = CELL_BLOCKED;
      else cells[k] = d < goalReach ? CELL_GOAL : CELL_FREE;
    }
  }
  if (line.offscreen) {
    for (let i = 0; i < cols; i += 1) {
      for (const k of [i, (rows - 1) * cols + i]) if (cells[k] === CELL_FREE) cells[k] = CELL_GOAL;
    }
    for (let j = 0; j < rows; j += 1) {
      for (const k of [j * cols, j * cols + cols - 1]) if (cells[k] === CELL_FREE) cells[k] = CELL_GOAL;
    }
  }
  const visited = new Uint8Array(cols * rows);
  const queue = new Int32Array(cols * rows);
  let head = 0;
  let tail = 0;
  const reach = ctx.radius + 1.5;
  for (let j = Math.max(0, Math.floor(ctx.hover.y - reach)); j <= Math.min(rows - 1, Math.ceil(ctx.hover.y + reach)); j += 1) {
    for (let i = Math.max(0, Math.floor(ctx.hover.x - reach)); i <= Math.min(cols - 1, Math.ceil(ctx.hover.x + reach)); i += 1) {
      const k = j * cols + i;
      if (Math.hypot(i + 0.5 - ctx.hover.x, j + 0.5 - ctx.hover.y) >= reach || cells[k] === CELL_BLOCKED) continue;
      visited[k] = 1;
      queue[tail] = k;
      tail += 1;
    }
  }
  while (head < tail) {
    const k = queue[head];
    head += 1;
    if (cells[k] === CELL_GOAL) return true;
    const i = k % cols;
    const neighbours = [
      i + 1 < cols ? k + 1 : -1,
      i > 0 ? k - 1 : -1,
      k + cols < cells.length ? k + cols : -1,
      k - cols >= 0 ? k - cols : -1
    ];
    for (const next of neighbours) {
      if (next < 0 || visited[next] || cells[next] === CELL_BLOCKED) continue;
      visited[next] = 1;
      queue[tail] = next;
      tail += 1;
    }
  }
  return false;
}

function screenEdgeOf(ctx, point) {
  if (Math.abs(point.y) < 1e-6) return 'top';
  if (Math.abs(point.y - ctx.height) < 1e-6) return 'bottom';
  if (Math.abs(point.x) < 1e-6) return 'left';
  if (Math.abs(point.x - ctx.width) < 1e-6) return 'right';
  return fail(`point (${point.x}, ${point.y}) is not on the screen edge`);
}

// 画面の外の相手の切れ目: 線があれば線が画面の端で切れる点、無ければ弦が画面の端で切れる点。
function cutPointOf(ctx, target, solution) {
  const candidate = solution.chosen.get(target.id);
  if (candidate && candidate.cut) return candidate.cut;
  const chord = makeLine(ctx.hover.x, ctx.hover.y, target.x, target.y);
  const exit = firstScreenExit(chord, ctx.width, ctx.height);
  if (exit === null) fail(`the chord to ${target.id} does not leave the screen`);
  const [x, y] = primPoint(chord, exit);
  return { x, y };
}

function edgeRect(ctx, edge, point, along, offset, width, height) {
  const reach = EDGE_LINE_OFFSET + offset;
  switch (edge) {
    case 'top':
    case 'bottom': {
      const top = edge === 'top' ? EDGE_INSET : ctx.height - EDGE_INSET - height;
      return along === 'right'
        ? makeRect(point.x + reach, top, point.x + reach + width, top + height)
        : makeRect(point.x - reach - width, top, point.x - reach, top + height);
    }
    default: {
      const left = edge === 'left' ? EDGE_INSET : ctx.width - EDGE_INSET - width;
      return along === 'above'
        ? makeRect(left, point.y - reach - height, left + width, point.y - reach)
        : makeRect(left, point.y + reach, left + width, point.y + reach + height);
    }
  }
}

function placeFeeling(ctx, target, solution, feelings, lineSet) {
  const lines = [...solution.chosen.values()];
  const width = target.labelWidth;
  const height = target.labelHeight;
  const otherComas = ctx.comas.filter((coma) => coma.id !== target.id);
  const usable = (rect) => rectInsideScreen(rect, ctx.width, ctx.height)
    && partsClear(rect, ctx.parts)
    && rectDistance(rect, ctx.sayRect) >= LABEL_CLEARANCE
    && feelings.every((feeling) => rectDistance(rect, feeling.rect) >= LABEL_CLEARANCE);
  const lineClear = (rect) => {
    const solid = solidRect(rect);
    return lines.every((candidate) => pathRectClear(candidate.prims, solid, LINE_CLEARANCE));
  };
  const comaFree = (rect) => comaFreeRect(rect, otherComas, ctx.radius);
  const done = (rect, placement, resolved = null) => ({ label: { targetId: target.id, rect, placement }, resolved });
  const maxOffset = ctx.diagonal;

  const ringSearch = (cx, cy, start) => {
    for (const avoidComas of [true, false]) {
      for (let rho = start; rho <= ctx.diagonal; rho += STEP_AWAY) {
        for (let angle = 0; angle < 360; angle += RING_ANGLE_STEP_DEG) {
          const rect = centeredRect(cx + rho * Math.sin(angle * DEG), cy - rho * Math.cos(angle * DEG), width, height);
          if (!usable(rect) || !lineClear(rect)) continue;
          if (avoidComas ? !comaFreeRect(rect, ctx.comas, ctx.radius) : pointRectDistance(target.x, target.y, rect) < ctx.radius) continue;
          return done(rect, { kind: 'ring', radius: rho, angle });
        }
      }
    }
    return null;
  };

  if (target.offscreen) {
    const point = cutPointOf(ctx, target, solution);
    const edge = screenEdgeOf(ctx, point);
    const alongs = edge === 'top' || edge === 'bottom' ? ['right', 'left'] : ['above', 'below'];
    for (let offset = 0; offset <= maxOffset; offset += STEP_AWAY) {
      for (const along of alongs) {
        const rect = edgeRect(ctx, edge, point, along, offset, width, height);
        if (usable(rect) && lineClear(rect)) return done(rect, { kind: 'edge', edge, along, offset });
      }
    }
    return ringSearch(point.x, point.y, STEP_AWAY);
  }

  const beside = (side, extra) => rectBesideCircle(target.x, target.y, ctx.radius, side, FEELING_GAP + extra, width, height);
  const base = SIDE_ORDER_FEELING.map((side) => ({ side, rect: beside(side, 0) })).filter(({ rect }) => usable(rect));
  let pool = base.filter(({ rect }) => comaFree(rect));
  if (pool.length === 0) {
    for (let extra = STEP_AWAY; extra <= maxOffset; extra += STEP_AWAY) {
      for (const side of SIDE_ORDER_FEELING) {
        const rect = beside(side, extra);
        if (usable(rect) && comaFree(rect) && lineClear(rect)) return done(rect, { kind: 'side', side, extra });
      }
    }
    pool = base;
  }
  for (const { side, rect } of pool) {
    if (lineClear(rect)) return done(rect, { kind: 'side', side, extra: 0 });
  }
  for (const { side, rect } of pool) {
    const obstacles = [...feelings.map((feeling) => solidRect(feeling.rect)), solidRect(rect)];
    const resolved = solveLines(ctx, lineSet, obstacles);
    if (resolved) return done(rect, { kind: 'side', side, extra: 0 }, resolved);
  }
  for (let extra = STEP_AWAY; extra <= maxOffset; extra += STEP_AWAY) {
    for (const side of SIDE_ORDER_FEELING) {
      const rect = beside(side, extra);
      if (usable(rect) && lineClear(rect)) return done(rect, { kind: 'side', side, extra });
    }
  }
  return ringSearch(target.x, target.y, ctx.radius + FEELING_GAP);
}

// 線（段 1〜5）→ 気持ちの札（置けなければ線の決め直し）。決まらなければ null。
function solveAll(ctx, lineSet) {
  let solution = solveLines(ctx, lineSet, []);
  if (!solution) return null;
  const feelings = [];
  for (const target of ctx.order) {
    const placed = placeFeeling(ctx, target, solution, feelings, lineSet);
    if (!placed) return null;
    if (placed.resolved) solution = placed.resolved;
    feelings.push(placed.label);
  }
  return { solution, feelings };
}

function outputPrim(prim) {
  if (prim.type === 'line') return { type: 'line', from: { x: prim.x0, y: prim.y0 }, to: { x: prim.x1, y: prim.y1 } };
  return {
    type: 'arc',
    center: { x: prim.cx, y: prim.cy },
    radius: prim.r,
    startAngle: prim.a0,
    endAngle: prim.a0 + prim.sweep,
    anticlockwise: prim.sweep < 0,
    from: { x: prim.x0, y: prim.y0 },
    to: { x: prim.x1, y: prim.y1 }
  };
}

export function placeRelationLines(input) {
  if (!input || typeof input !== 'object') fail('placeRelationLines needs an input object');
  const ctx = buildRelationContext(input);
  const unreachable = ctx.order.filter((line) => !reachable(ctx, line));
  let lineSet = ctx.order.filter((line) => !unreachable.includes(line));
  const dropped = [];
  let result = solveAll(ctx, lineSet);
  // 最後の段: 遠い順に一人ずつ、その線を外せば残りが決まる最初の相手を外す。
  // どの一人でも決まらなければ、いちばん遠い相手を外して繰り返す。
  while (!result) {
    if (lineSet.length === 0) fail('the feeling labels cannot be placed even without any line');
    const farFirst = [...lineSet].sort((a, b) => b.dist - a.dist || a.index - b.index);
    for (const line of farFirst) {
      const rest = lineSet.filter((other) => other !== line);
      const attempt = solveAll(ctx, rest);
      if (attempt) {
        dropped.push(line);
        lineSet = rest;
        result = attempt;
        break;
      }
    }
    if (!result) {
      dropped.push(farFirst[0]);
      lineSet = lineSet.filter((other) => other !== farFirst[0]);
    }
  }
  const { solution, feelings } = result;
  return {
    sayLabel: input.sayLabel,
    stage: solution.stage,
    lines: lineSet.map((line) => {
      const candidate = solution.chosen.get(line.id);
      return {
        targetId: line.id,
        shape: { ...candidate.shape },
        path: candidate.prims.map(outputPrim),
        cutAtEdge: candidate.cut ? { ...candidate.cut } : null
      };
    }),
    feelingLabels: feelings.map(({ targetId, rect, placement }) => ({ targetId, rect: plainRect(rect), placement })),
    linelessTargets: [
      ...unreachable.map((line) => ({ targetId: line.id, reason: 'unreachable' })),
      ...dropped.map((line) => ({ targetId: line.id, reason: 'dropped' }))
    ]
  };
}

// ---------------------------------------------------------------------------
// 状態 10: 結末の跡の札・書き込みの印の札

function traceLabelClear(rect, input) {
  return input.rects.every((other) => rectDistance(rect, other) >= LABEL_CLEARANCE)
    && input.comas.every((coma) => pointRectDistance(coma.x, coma.y, rect) >= input.comaRadius + LABEL_CLEARANCE)
    && partsClear(rect, input.parts);
}

function placeOneTraceLabel(point, width, height, input) {
  // 障害物の外側まで遠ざければ必ず空くので、そこまでで打ち切る。
  let reach = 0;
  const extend = (x, y) => {
    reach = Math.max(reach, Math.hypot(x - point.x, y - point.y));
  };
  for (const rect of [...input.rects, ...input.parts]) {
    extend(rect.left, rect.top);
    extend(rect.right, rect.bottom);
    extend(rect.left, rect.bottom);
    extend(rect.right, rect.top);
  }
  for (const coma of input.comas) extend(coma.x, coma.y);
  const limit = reach + input.comaRadius + PART_CLEARANCE + Math.max(width, height);
  for (let extra = 0; extra <= limit + STEP_AWAY; extra += STEP_AWAY) {
    for (const side of SIDE_ORDER_SAY) {
      const rect = rectBesideCircle(point.x, point.y, 0, side, TRACE_GAP + extra, width, height);
      if (traceLabelClear(rect, input)) return { side, extra, rect };
    }
  }
  return fail(`no trace-label place found around (${point.x}, ${point.y})`);
}

export function placeTraceLabels(input) {
  if (!input || typeof input !== 'object') fail('placeTraceLabels needs an input object');
  requireParts(input.parts);
  requirePositive('comaRadius', input.comaRadius);
  if (!Array.isArray(input.comas)) fail('comas must be an array');
  input.comas.forEach((coma, i) => requirePoint(`comas[${i}]`, coma));
  if (!Array.isArray(input.rects)) fail('rects must be an array');
  input.rects.forEach((rect, i) => requireRect(`rects[${i}]`, rect));
  if (!Array.isArray(input.labels)) fail('labels must be an array');
  const seen = new Set();
  input.labels.forEach((label, i) => {
    if (!label || typeof label !== 'object') fail(`labels[${i}] must be { id, x, y, width, height }`);
    if (typeof label.id !== 'string' || label.id === '') fail(`labels[${i}].id must be a non-empty string`);
    if (seen.has(label.id)) fail(`duplicate label id ${label.id}`);
    seen.add(label.id);
    requirePoint(`labels[${i}]`, label);
    requirePositive(`labels[${i}].width`, label.width);
    requirePositive(`labels[${i}].height`, label.height);
    if (label.rect !== undefined) requireRect(`labels[${i}].rect`, label.rect);
  });

  // 置いてある札は、ほかの札・枠に掛かるようになったときだけ置き直す。
  const kept = new Map();
  for (const label of input.labels) {
    if (label.rect === undefined) continue;
    const others = [...input.rects, ...kept.values()];
    if (others.every((rect) => rectDistance(label.rect, rect) >= LABEL_CLEARANCE)) kept.set(label.id, plainRect(label.rect));
  }
  const placed = new Map();
  for (const label of input.labels) {
    if (kept.has(label.id)) continue;
    const rects = [...input.rects, ...kept.values(), ...[...placed.values()].map(({ rect }) => rect)];
    const found = placeOneTraceLabel(label, label.width, label.height, { ...input, rects });
    placed.set(label.id, { side: found.side, extra: found.extra, rect: plainRect(found.rect) });
  }
  return input.labels.map((label) => (kept.has(label.id)
    ? { id: label.id, rect: kept.get(label.id), kept: true }
    : { id: label.id, ...placed.get(label.id), kept: false }));
}

// ---------------------------------------------------------------------------
// 状態 14: 出会っている二人を囲む輪と一言の札

function ringBox(ring) {
  const angle = ring.angleDeg * DEG;
  const c = Math.abs(Math.cos(angle));
  const s = Math.abs(Math.sin(angle));
  const innerW = ring.width / 2 - ring.cornerRadius;
  const innerH = ring.height / 2 - ring.cornerRadius;
  const halfW = c * innerW + s * innerH + ring.cornerRadius;
  const halfH = s * innerW + c * innerH + ring.cornerRadius;
  return makeRect(ring.x - halfW, ring.y - halfH, ring.x + halfW, ring.y + halfH);
}

export function placePairSayLabel(input) {
  if (!input || typeof input !== 'object') fail('placePairSayLabel needs an input object');
  const screen = requireScreen(input.screen);
  const parts = requireParts(input.parts);
  const radius = requirePositive('comaRadius', input.comaRadius);
  const width = requirePositive('width', input.width);
  const height = requirePositive('height', input.height);
  const ring = input.ring;
  if (!ring || typeof ring !== 'object') fail('ring must be { x, y, width, height, angleDeg, cornerRadius }');
  requirePoint('ring', ring);
  requirePositive('ring.width', ring.width);
  requirePositive('ring.height', ring.height);
  requireFinite('ring.angleDeg', ring.angleDeg);
  requireFinite('ring.cornerRadius', ring.cornerRadius);
  if (ring.cornerRadius < 0 || ring.cornerRadius * 2 > Math.min(ring.width, ring.height)) {
    fail('ring.cornerRadius must be between 0 and half of the shorter side');
  }
  const byId = requireComas(input.comas);
  if (!Array.isArray(input.pairIds) || input.pairIds.length !== 2 || input.pairIds[0] === input.pairIds[1]) {
    fail('pairIds must name the two comas in the ring');
  }
  input.pairIds.forEach((id) => requireComa(byId, id, 'pairIds'));
  if (!Array.isArray(input.dots)) fail('dots must be an array');
  input.dots.forEach((dot, i) => {
    requirePoint(`dots[${i}]`, dot);
    requirePositive(`dots[${i}].radius`, dot.radius);
  });
  if (!Array.isArray(input.rects)) fail('rects must be an array');
  input.rects.forEach((rect, i) => requireRect(`rects[${i}]`, rect));

  const others = input.comas.filter((coma) => !input.pairIds.includes(coma.id));
  const box = ringBox(ring);
  for (const side of SIDE_ORDER_SAY) {
    const rect = rectBesideBox(box, side, PAIR_GAP, width, height);
    if (!rectInsideScreen(rect, screen.width, screen.height)) continue;
    if (!partsClear(rect, parts)) continue;
    if (!input.dots.every((dot) => pointRectDistance(dot.x, dot.y, rect) - dot.radius >= LABEL_CLEARANCE)) continue;
    if (!input.rects.every((other) => rectDistance(rect, other) >= LABEL_CLEARANCE)) continue;
    if (!comaFreeRect(rect, others, radius)) continue;
    return { side, rect: plainRect(rect) };
  }
  return fail('no side of the pair ring leaves room for the say label');
}
