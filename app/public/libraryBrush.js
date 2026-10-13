// 大書庫の頁の上の筆の姿（濃い木の軸・真鍮の口金と天冠・墨を含んだ穂の毛の束と、紙に落ちる影）を一本描く。
// 筆は頁 24cm の紙に置く小筆で、寸法は cm で持ち、呼ぶ側が渡す pxPerCm（頁の紙の 1cm が何 px か）で画面へ写す。
// 写し方は読み手の側に座った右手の書き手の持ち方: 紙に 50°（法線から lean.tilt）・真手前から右へ lean.azimuth に倒し、
// 見下ろし VIEW で写す。影は灯り（左上の奥）の反対の右手前へ、高さ h の点が LIGHT × h だけずれた紙の上に落ちる。
// 穂は書く向きと逆へ、押さえの分だけ撓む（中ほどが最大、根元と穂先は動かない）。
//
// 描くのは二枚の canvas で、shadow は紙と乗算で重ねる影、body は筆。どちらも呼ぶ側の座標（transform 込み）で筆先を tip に置く。

// 筆の寸法（cm）。軸は口金を含めた長さで、筆先から上端までは hair + shaft。軸の径は上端で flare 倍に太る。
// bend は押さえきったときの穂の中ほどの撓み。
export const LIBRARY_BRUSH = { hair: 3.9, hairBase: 0.975, ferrule: 1.04, shaft: 22.1, dia: 1.04, flare: 1.08, cap: 1.2, bend: 0.4745 };
// 紙への持ち方（度）: 法線から tilt・真手前から右へ azimuth。
export const LIBRARY_BRUSH_LEAN = { tilt: 40, azimuth: 30 };
// 筆の canvas が筆先のまわりに取る範囲（cm・右と下が正）。持ち上げ 4cm までの筆と影が収まる。
export const LIBRARY_BRUSH_BOX = { left: -2.6, top: -6.5, right: 18.2, bottom: 22.1 };

const VIEW = 72;                 // 見下ろし（度）
const LIGHT = [0.26, 0.17];      // 高さ 1cm あたりの影のずれ（右・手前）
const RING = 0.32;               // 軸の輪を写す楕円の短径の割合（上端の切り口と同じ）
// 影の濃さ（筆先 0 → 上端の影 1 の位置・濃さ 0〜1）。
const SHADOW_FADE = [[0, 1], [0.12, 0.75], [0.3, 0.3], [0.55, 0.08], [0.8, 0]];

// 繰り返しの細部（木目・毛筋）の揺らぎ。毎フレーム同じ姿になるよう、番号から決まる値。
const jitter = (k) => {
  const x = Math.sin(k * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

// 穂の墨の際（根元 0 → 穂先 1 の位置）を、穂の幅の中の位置 -1〜1 に等間隔で並べた値。際はぎざぎざにずれる。
const INK_EDGE = [0.56, 0.52, 0.58, 0.5, 0.54, 0.51, 0.57, 0.53, 0.55];
// 穂の表面の毛並みの筋の数。
const HAIR_STRANDS = 14;
// 穂の半幅（根元の半幅に対する割合）: 口金の口から腹（根元から BELLY_AT）へなだらかに BELLY 倍に膨らみ、命毛へ丸くすぼまる。
const BELLY = 1.12;
const BELLY_AT = 0.36;

function contextOf(canvas, label) {
  if (!canvas || typeof canvas.getContext !== 'function') throw new Error(`library brush: the ${label} canvas is not a canvas`);
  const context = canvas.getContext('2d');
  if (!context) throw new Error(`library brush: no 2d context for the ${label} canvas`);
  return context;
}

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`library brush: ${label} is not a finite number: ${value}`);
  return value;
}

function inRange(value, low, high, label) {
  finite(value, label);
  if (value < low || value > high) throw new Error(`library brush: ${label} is outside ${low}..${high}: ${value}`);
  return value;
}

function pair(value, label) {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`library brush: ${label} is not a pair [x, y]`);
  return [finite(value[0], `${label}[0]`), finite(value[1], `${label}[1]`)];
}

// 筆を一本描く。canvases: { shadow, body }。tip: 筆先の位置（canvas の座標・px）。pxPerCm: 頁の紙の 1cm の px（正）。
// lean: { tilt, azimuth }（度）。bend: { dir, press } — 書く向きの単位ベクトル（画面）と押さえ 0〜1。lift: 筆先の紙からの高さ（cm・0 以上）。
// opacity: 0〜1。
export function paintLibraryBrush(canvases, { tip, pxPerCm, lean, bend, lift, opacity }) {
  if (!canvases) throw new Error('library brush: no canvases');
  const sg = contextOf(canvases.shadow, 'shadow');
  const bg = contextOf(canvases.body, 'body');
  const origin = pair(tip, 'tip');
  const s = finite(pxPerCm, 'pxPerCm');
  if (s <= 0) throw new Error(`library brush: pxPerCm must be positive: ${s}`);
  if (!lean) throw new Error('library brush: no lean');
  const tilt = inRange(lean.tilt, 0, 90, 'lean.tilt');
  const azimuth = inRange(lean.azimuth, -180, 180, 'lean.azimuth');
  if (!bend) throw new Error('library brush: no bend');
  const dir = pair(bend.dir, 'bend.dir');
  const press = inRange(bend.press, 0, 1, 'bend.press');
  const z = finite(lift, 'lift');
  if (z < 0) throw new Error(`library brush: lift must not be negative: ${z}`);
  inRange(opacity, 0, 1, 'opacity');

  const rad = (d) => (d * Math.PI) / 180;
  const [ta, az, vw] = [rad(tilt), rad(azimuth), rad(VIEW)];
  // 紙の上の cm（右・奥・上）→ 画面の px のずれ。奥は sin(見下ろし) で縮み、上は cos(見下ろし) で画面の上へ。
  const screen = ([dx, dy, dz]) => [s * dx, -s * Math.sin(vw) * dy - s * Math.cos(vw) * dz];
  const axis = [Math.sin(ta) * Math.sin(az), -Math.sin(ta) * Math.cos(az), Math.cos(ta)];
  const A = screen(axis);
  const raised = screen([0, 0, z]);
  const span = Math.hypot(A[0], A[1]);
  const u = [A[0] / span, A[1] / span];
  const n = [-u[1], u[0]];
  const angle = Math.atan2(n[1], n[0]);
  // 筆の上の点: 筆先から t cm、軸に直交して w px（+n が灯りの側）。
  const at = (t, w = 0) => [origin[0] + raised[0] + A[0] * t + n[0] * w, origin[1] + raised[1] + A[1] * t + n[1] * w];
  const shadowAt = (t) => {
    const h = axis[2] * t + z;
    const p = screen([axis[0] * t + LIGHT[0] * h, axis[1] * t - LIGHT[1] * h, 0]);
    return [origin[0] + p[0], origin[1] + p[1]];
  };
  const B = LIBRARY_BRUSH;
  const full = B.hair + B.shaft;
  const ferruleTop = B.hair + B.ferrule;
  const capFrom = full - B.cap;
  const r0 = (B.dia * s) / 2;
  const radius = (t) => r0 * (1 + (B.flare - 1) * Math.max(0, (t - ferruleTop) / (full - ferruleTop)));
  // 輪（軸に直交する円）。上端の面が手前を向くので、輪の手前の半分は筆先の側（-u）へ張り出す。既定はその見える半分。
  const ring = (g, t, r, from = 0, to = Math.PI, anticlockwise = false) => {
    const c = at(t);
    g.ellipse(c[0], c[1], r, r * RING, angle, from, to, anticlockwise);
  };
  // 円柱の面の上の点: 周の角 theta（0 が手前・+π/2 が灯りの側の縁）。
  const surface = (t, r, theta) => {
    const p = at(t, r * Math.sin(theta));
    const bulge = r * RING * Math.cos(theta);
    return [p[0] - u[0] * bulge, p[1] - u[1] * bulge];
  };
  // 軸に直交する向きの陰影（+n の灯りの側から -n へ）。
  const across = (g, t, r, stops) => {
    const gradient = g.createLinearGradient(...at(t, r), ...at(t, -r));
    for (const [offset, color] of stops) gradient.addColorStop(offset, color);
    return gradient;
  };
  // 筒の t0〜t1 の輪郭: 上端の側は輪の外側（+u）の半分、筆先の側は手前（-u）の半分で閉じる。
  const band = (g, t0, t1, r0a, r1a) => {
    g.beginPath();
    g.moveTo(...at(t0, r0a));
    g.lineTo(...at(t1, r1a));
    ring(g, t1, r1a, 0, Math.PI, true);
    g.lineTo(...at(t0, -r0a));
    ring(g, t0, r0a, Math.PI, 0, true);
    g.closePath();
  };
  // 円柱の面の上の線（周の角 theta に、長さに沿った揺れ sway(t) を足す）を t0〜t1 に引く。
  const surfaceLine = (g, t0, t1, theta, steps, sway) => {
    g.beginPath();
    for (let i = 0; i <= steps; i += 1) {
      const t = t0 + ((t1 - t0) * i) / steps;
      const p = surface(t, radius(t), theta + sway(t));
      if (i === 0) g.moveTo(...p);
      else g.lineTo(...p);
    }
  };
  const dpr = window.devicePixelRatio;
  const hairline = Math.max(0.35, 0.028 * s);

  // ── 影: 穂先に近い所ほど濃く鋭く、紙から高い所ほど淡く散る（灯りは広いので、高い所の影は紙に届く前にほどける）。
  // 濃さは筆先から影の先までの割合 SHADOW_FADE で落ち、軸の中ほどから先はほとんど紙に残らない。
  const sh0 = shadowAt(0);
  const sh1 = shadowAt(full);
  sg.save();
  for (const [blur, alpha, from, width] of [[0.063, 0.26, 0, 0.9], [0.21, 0.12, 0.1, 1.1]]) {
    const start = from ? shadowAt(full * from) : sh0;
    sg.save();
    sg.filter = `blur(${((blur + z * 0.104) * s * dpr).toFixed(2)}px)`;
    sg.globalAlpha = opacity * alpha * (1 - Math.min(0.7, z / 4));
    const fade = sg.createLinearGradient(...sh0, ...sh1);
    for (const [offset, k] of SHADOW_FADE) fade.addColorStop(offset, `rgba(52,32,16,${k})`);
    sg.strokeStyle = fade;
    sg.lineCap = 'round';
    sg.lineWidth = 2 * r0 * width;
    sg.beginPath();
    sg.moveTo(...start);
    sg.lineTo(...sh1);
    sg.stroke();
    sg.restore();
  }
  // 筆先が紙に触れている間の、穂先の下の濃い接地の影。
  if (z < 0.2) {
    sg.save();
    sg.globalAlpha = opacity * 0.35 * (1 - z / 0.2);
    sg.filter = `blur(${(0.05 * s * dpr).toFixed(2)}px)`;
    sg.fillStyle = 'rgba(30,18,8,1)';
    sg.beginPath();
    sg.ellipse(sh0[0] + 0.12 * s, sh0[1] + 0.06 * s, 0.32 * s, 0.14 * s, rad(20), 0, Math.PI * 2);
    sg.fill();
    sg.restore();
  }
  sg.restore();

  bg.save();
  bg.globalAlpha = opacity;
  bg.lineCap = 'round';
  bg.lineJoin = 'round';

  // ── 穂: 口金の口から一つの塊として出て、腹で膨らみ、命毛へ丸くすぼまる。根元は乾いた狐色の毛、根元から 0.5〜0.58 から先は
  // 墨を含んで黒く、その際は毛並みに沿ってぎざぎざに吸い上がる。毛の束の重なりは塊の表面の毛並み（淡い筋）として見せる。
  // 書いている間は書く向きと逆へ撓む。
  const wb = B.hairBase * s;
  const sway = [-dir[0] * press * B.bend * s, -dir[1] * press * B.bend * s];
  // 半幅: 口金の口では根元の幅のまま出て、腹（根元から BELLY_AT）へなだらかに BELLY 倍まで膨らみ、命毛へ丸くすぼまる。
  const halfAt = (f) => {
    if (f < BELLY_AT) {
      const x = f / BELLY_AT;
      return (wb / 2) * (1 + (BELLY - 1) * x * x * (3 - 2 * x));
    }
    const g = (f - BELLY_AT) / (1 - BELLY_AT);
    return (wb / 2) * BELLY * Math.pow(Math.max(0, 1 - Math.pow(g, 1.5)), 1.15);
  };
  // f: 根元 0 → 穂先 1、side: 穂の幅の中の位置（-1〜1）。
  const hairAt = (f, side) => {
    const p = at(B.hair * (1 - f), halfAt(f) * side);
    const k = 2 * f * (1 - f);
    return [p[0] + sway[0] * k, p[1] + sway[1] * k];
  };
  const steps = 24;
  const hairOutline = () => {
    bg.beginPath();
    bg.moveTo(...hairAt(0, 1));
    for (let i = 1; i <= steps; i += 1) bg.lineTo(...hairAt(i / steps, 1));
    for (let i = steps - 1; i >= 0; i -= 1) bg.lineTo(...hairAt(i / steps, -1));
    bg.closePath();
  };
  const line = Math.max(0.7, 0.05 * s);
  // 塊の地: 乾いた毛の色（灯りの側が明るい）。
  bg.fillStyle = across(bg, B.hair * (1 - BELLY_AT), halfAt(BELLY_AT), [[0, '#e2b878'], [0.3, '#c8955a'], [0.7, '#9a6a38'], [1, '#6e4a26']]);
  hairOutline();
  bg.fill();
  bg.save();
  hairOutline();
  bg.clip();
  // 墨: 穂先から、幅の中の位置ごとにずれた墨の際（INK_EDGE）まで。際の手前は毛が墨を吸って灰に沈む。
  const inkEdge = (side) => {
    const k = Math.min(INK_EDGE.length - 1, Math.max(0, ((side + 1) / 2) * (INK_EDGE.length - 1)));
    const i = Math.floor(k);
    const j = Math.min(INK_EDGE.length - 1, i + 1);
    return INK_EDGE[i] + (INK_EDGE[j] - INK_EDGE[i]) * (k - i);
  };
  // 墨の所: 際の線を幅の端から端へ引き、そこから穂の縁に沿って穂先へ回って閉じる（縁は clip の外まで張り出す）。
  const inkArea = (shift) => {
    const from = (side) => Math.max(0, inkEdge(side) - shift);
    bg.beginPath();
    for (let i = 0; i <= 32; i += 1) {
      const side = -1 + (2 * i) / 32;
      const p = hairAt(from(side), side * 1.2);
      if (i === 0) bg.moveTo(...p);
      else bg.lineTo(...p);
    }
    for (let i = 1; i <= 12; i += 1) bg.lineTo(...hairAt(from(1) + ((1 - from(1)) * i) / 12, 1.2));
    for (let i = 12; i >= 0; i -= 1) bg.lineTo(...hairAt(from(-1) + ((1 - from(-1)) * i) / 12, -1.2));
    bg.closePath();
  };
  bg.fillStyle = 'rgba(70,48,28,0.55)';
  inkArea(0.05);
  bg.fill();
  const ink = bg.createLinearGradient(...hairAt(0.5, 0), ...hairAt(1, 0));
  ink.addColorStop(0, '#1e140c');
  ink.addColorStop(1, '#050302');
  bg.fillStyle = ink;
  inkArea(0);
  bg.fill();
  // 毛並み: 根元から命毛へ寄っていく淡い筋（明るい筋と暗い筋が交互）。乾いた所でははっきり、墨の所では鈍い照りだけ。
  for (let k = 0; k < HAIR_STRANDS; k += 1) {
    const side = -0.92 + (1.84 * (k + 0.5 * jitter(k + 200))) / HAIR_STRANDS;
    const light = k % 2 === 0;
    const edge = inkEdge(side);
    const reach = 0.9 + 0.08 * jitter(k + 210);
    const strand = bg.createLinearGradient(...hairAt(0, side), ...hairAt(reach, side * 0.2));
    const dryColor = light ? `rgba(250,226,180,${0.22 + 0.12 * jitter(k + 220)})` : `rgba(70,42,16,${0.22 + 0.1 * jitter(k + 230)})`;
    strand.addColorStop(0, dryColor);
    strand.addColorStop(Math.max(0, edge / reach - 0.04), dryColor);
    strand.addColorStop(Math.min(1, edge / reach + 0.04), light ? 'rgba(220,206,186,0.1)' : 'rgba(0,0,0,0)');
    strand.addColorStop(1, 'rgba(0,0,0,0)');
    bg.strokeStyle = strand;
    bg.lineWidth = hairline * (0.8 + 0.4 * jitter(k + 240));
    bg.beginPath();
    bg.moveTo(...hairAt(0, side));
    for (let i = 1; i <= 16; i += 1) {
      const f = (reach * i) / 16;
      bg.lineTo(...hairAt(f, side * (1 - 0.8 * (f / reach) ** 2)));
    }
    bg.stroke();
  }
  // 墨の吸い上げ: 墨の際から根元の側へ、毛並みに沿って上る黒い筋（際をぎざぎざにする）。
  bg.strokeStyle = 'rgba(16,10,5,0.6)';
  bg.lineWidth = line * 0.8;
  for (let k = 0; k < 9; k += 1) {
    const side = -0.85 + (1.7 * (k + 0.5 * jitter(k + 300))) / 9;
    const edge = inkEdge(side);
    bg.beginPath();
    bg.moveTo(...hairAt(edge - 0.05 - 0.08 * jitter(k + 310), side));
    bg.lineTo(...hairAt(edge + 0.03, side * 0.95));
    bg.stroke();
  }
  // 腹の丸み: 灯りの側（+n）は明るく、陰の側は暗く沈む。
  bg.fillStyle = across(bg, B.hair * (1 - BELLY_AT), halfAt(BELLY_AT), [[0, 'rgba(255,236,200,0.16)'], [0.3, 'rgba(255,236,200,0)'], [0.6, 'rgba(10,6,2,0)'], [1, 'rgba(10,6,2,0.42)']]);
  hairOutline();
  bg.fill();
  // 濡れの照り: 墨を含んだ腹の灯りの側に、細い強い照りとその周りの琥珀のにじみ。
  const sheen = (side, from, to, width, color) => {
    bg.strokeStyle = color;
    bg.lineWidth = width;
    bg.beginPath();
    bg.moveTo(...hairAt(from, side));
    for (let i = 1; i <= 10; i += 1) bg.lineTo(...hairAt(from + ((to - from) * i) / 10, side * (1 - 0.25 * (i / 10))));
    bg.stroke();
  };
  sheen(0.5, 0.6, 0.9, Math.max(1, wb * 0.16), 'rgba(255,190,110,0.12)');
  sheen(0.48, 0.62, 0.86, Math.max(0.7, wb * 0.06), 'rgba(255,242,218,0.42)');
  // 命毛の先の墨の照り。
  const tipGlint = hairAt(0.9, 0.2);
  bg.fillStyle = 'rgba(255,240,214,0.55)';
  bg.beginPath();
  bg.arc(tipGlint[0], tipGlint[1], Math.max(0.4, wb * 0.045), 0, Math.PI * 2);
  bg.fill();
  // 口金の口の下の陰（毛が口金へ入る所）。
  const mouthShade = bg.createLinearGradient(...hairAt(0, 0), ...hairAt(0.1, 0));
  mouthShade.addColorStop(0, 'rgba(10,6,2,0.5)');
  mouthShade.addColorStop(1, 'rgba(10,6,2,0)');
  bg.fillStyle = mouthShade;
  hairOutline();
  bg.fill();
  bg.restore();
  // 穂の輪郭: 紙から穂を切り分ける暗い縁（乾いた根元の淡い色が紙に溶けないように）。
  bg.strokeStyle = 'rgba(40,24,10,0.75)';
  bg.lineWidth = line * 0.9;
  hairOutline();
  bg.stroke();
  // ほつれ毛: 腹の縁から、塊を外れて浮く毛が二本。
  bg.lineWidth = Math.max(0.5, hairline);
  for (const [side, from, to, out] of [[1.0, 0.22, 0.46, 0.12], [-1.0, 0.26, 0.44, -0.1]]) {
    bg.strokeStyle = 'rgba(206,166,108,0.6)';
    bg.beginPath();
    bg.moveTo(...hairAt(from, side));
    const mid = hairAt((from + to) / 2, side + out);
    const end = hairAt(to, side + out * 0.6);
    bg.quadraticCurveTo(mid[0], mid[1], end[0], end[1]);
    bg.stroke();
  }

  // ── 軸: 濃い木（紫檀の色）を漆で磨いた丸軸。上端へわずかに太る。
  const shaftFrom = ferruleTop - 0.02;
  const wood = (t) => across(bg, t, radius(t), [[0, '#7a4c2a'], [0.1, '#9a6538'], [0.26, '#714424'], [0.55, '#3e2311'], [0.84, '#1e1007'], [1, '#2e1a0c']]);
  bg.fillStyle = wood((shaftFrom + capFrom) / 2);
  band(bg, shaftFrom, capFrom, radius(shaftFrom), radius(capFrom));
  bg.fill();
  bg.save();
  band(bg, shaftFrom, capFrom, radius(shaftFrom), radius(capFrom));
  bg.clip();
  // 木目: 周に沿って並ぶ年輪の筋（縁ほど詰まる）が、長さに沿ってゆるく波打つ。暗い筋と明るい筋を交互に。
  const grains = 18;
  for (let k = 0; k < grains; k += 1) {
    const theta = -Math.PI / 2 + (Math.PI * (k + 0.2 + 0.6 * jitter(k))) / grains;
    const phase = jitter(k + 40) * Math.PI * 2;
    const wave = (t) => 0.07 * Math.sin(t * 0.55 + phase) + 0.025 * Math.sin(t * 2.1 + phase * 1.7);
    const dark = k % 3 !== 1;
    bg.strokeStyle = dark ? `rgba(14,7,2,${0.32 + 0.25 * jitter(k + 80)})` : `rgba(196,132,76,${0.16 + 0.14 * jitter(k + 90)})`;
    bg.lineWidth = hairline * (dark ? 0.9 + 0.9 * jitter(k + 60) : 0.7);
    surfaceLine(bg, shaftFrom, capFrom, theta, 48, wave);
    bg.stroke();
  }
  // 板目の山形: 灯りの側の面に、先の尖った筋が入れ子に三つずつ。
  for (const [t0, length, center, widthFrac] of [[7.2, 3.4, 0.25, 0.32], [13.5, 4.2, -0.1, 0.36], [19.4, 2.8, 0.4, 0.26]]) {
    for (let ring2 = 0; ring2 < 3; ring2 += 1) {
      const w = widthFrac * (1 - ring2 * 0.28);
      const len = length * (1 - ring2 * 0.22);
      bg.strokeStyle = `rgba(16,8,3,${0.38 - ring2 * 0.08})`;
      bg.lineWidth = hairline * 0.9;
      bg.beginPath();
      for (let i = 0; i <= 20; i += 1) {
        const a = -1 + (2 * i) / 20;
        const t = t0 + len * (1 - a * a);
        const p = surface(t, radius(t), (center + w * a) * (Math.PI / 2));
        if (i === 0) bg.moveTo(...p);
        else bg.lineTo(...p);
      }
      bg.stroke();
    }
  }
  // 漆の艶: 灯りの側に細い強い照り（磨いた面の映り込みで所々途切れる）と、広い柔らかな照り。暗い側の縁に琥珀の照り返し。
  // 照りの強さは長さに沿って映り込みの明暗で揺れる（stops: [位置 0〜1, 強さ 0〜1]）。
  const gloss = (theta, width, [r, g, b, alpha], stops) => {
    const t0 = shaftFrom + 0.15;
    const t1 = capFrom - 0.15;
    const along = bg.createLinearGradient(...surface(t0, radius(t0), theta), ...surface(t1, radius(t1), theta));
    for (const [offset, k] of stops) along.addColorStop(offset, `rgba(${r},${g},${b},${(alpha * k).toFixed(3)})`);
    bg.strokeStyle = along;
    bg.lineWidth = width;
    bg.beginPath();
    bg.moveTo(...surface(t0, radius(t0), theta));
    bg.lineTo(...surface(t1, radius(t1), theta));
    bg.stroke();
  };
  const reflection = [[0, 0], [0.06, 0.7], [0.2, 1], [0.32, 0.45], [0.4, 0.9], [0.55, 0.6], [0.63, 0.25], [0.72, 0.85], [0.88, 0.7], [1, 0]];
  gloss(0.62, r0 * 0.6, [255, 200, 130, 0.12], [[0, 0], [0.1, 1], [0.9, 1], [1, 0]]);
  gloss(0.66, r0 * 0.18, [255, 232, 196, 0.42], reflection);
  gloss(0.7, Math.max(0.4, r0 * 0.05), [255, 248, 232, 0.7], reflection.map(([o, k]) => [o, k * k]));
  gloss(-1.15, r0 * 0.12, [255, 168, 84, 0.2], [[0, 0], [0.15, 1], [0.85, 1], [1, 0]]);
  bg.restore();
  // 象嵌の帯: 口金の少し上に、真鍮の細い線が二本。
  for (const t of [ferruleTop + 0.55, ferruleTop + 0.68]) {
    bg.strokeStyle = 'rgba(66,40,12,0.9)';
    bg.lineWidth = hairline * 1.6;
    bg.beginPath();
    ring(bg, t, radius(t));
    bg.stroke();
    bg.strokeStyle = across(bg, t, radius(t), [[0, '#ffe6a6'], [0.3, '#d6a654'], [0.7, '#7a5220'], [1, '#a77a36']]);
    bg.lineWidth = hairline * 1.1;
    bg.beginPath();
    ring(bg, t, radius(t));
    bg.stroke();
  }

  // ── 真鍮の陰影（口金と天冠で共通）。
  const brass = (t, r) => across(bg, t, r, [[0, '#a87b38'], [0.08, '#ffefb8'], [0.2, '#e8c26a'], [0.42, '#b4843a'], [0.7, '#6e4a1c'], [0.9, '#3a260c'], [1, '#6e4f22']]);
  // 縁の輪: 溝（暗い線）と、その手前の盛り上がり（照り）。
  const rim = (t, r, toward) => {
    bg.strokeStyle = 'rgba(52,30,8,0.9)';
    bg.lineWidth = hairline * 1.4;
    bg.beginPath();
    ring(bg, t, r);
    bg.stroke();
    bg.strokeStyle = across(bg, t, r, [[0, 'rgba(255,240,196,0.4)'], [0.12, 'rgba(255,248,220,0.95)'], [0.5, 'rgba(214,170,90,0.6)'], [1, 'rgba(120,84,36,0.5)']]);
    bg.lineWidth = hairline * 1.1;
    bg.beginPath();
    ring(bg, t + toward * 0.06, r);
    bg.stroke();
  };

  // ── 天冠: 軸の上端の真鍮の冠。冠の口に輪、上の面（手前を向く楕円）に彫りの輪と小さな鋲。
  const rc0 = radius(capFrom) * 1.02;
  const rc1 = radius(full) * 1.02;
  bg.fillStyle = brass((capFrom + full) / 2, rc1);
  band(bg, capFrom, full, rc0, rc1);
  bg.fill();
  rim(capFrom + 0.05, rc0, 1);
  rim(capFrom + 0.32, (rc0 + rc1) / 2, 1);
  // 冠の胴の照り。
  bg.strokeStyle = 'rgba(255,250,232,0.75)';
  bg.lineWidth = Math.max(0.4, r0 * 0.07);
  bg.beginPath();
  bg.moveTo(...surface(capFrom + 0.4, rc0, 0.68));
  bg.lineTo(...surface(full - 0.08, rc1, 0.68));
  bg.stroke();
  const face = at(full);
  const faceFill = bg.createLinearGradient(...at(full, rc1), ...at(full, -rc1));
  faceFill.addColorStop(0, '#fff2c4');
  faceFill.addColorStop(0.35, '#d9ad58');
  faceFill.addColorStop(0.8, '#80561e');
  faceFill.addColorStop(1, '#5a3c12');
  bg.fillStyle = faceFill;
  bg.beginPath();
  bg.ellipse(face[0], face[1], rc1, rc1 * RING, angle, 0, Math.PI * 2);
  bg.fill();
  bg.strokeStyle = 'rgba(255,236,186,0.8)';
  bg.lineWidth = hairline;
  bg.stroke();
  bg.strokeStyle = 'rgba(70,44,12,0.75)';
  bg.lineWidth = hairline;
  bg.beginPath();
  bg.ellipse(face[0], face[1], rc1 * 0.62, rc1 * 0.62 * RING, angle, 0, Math.PI * 2);
  bg.stroke();
  bg.fillStyle = 'rgba(255,248,224,0.9)';
  bg.beginPath();
  bg.ellipse(face[0] + n[0] * rc1 * 0.12, face[1] + n[1] * rc1 * 0.12, rc1 * 0.16, rc1 * 0.16 * RING, angle, 0, Math.PI * 2);
  bg.fill();

  // ── 口金: 真鍮の筒。口（穂の側）へ少しすぼまり、上の輪・口の巻き返し・中ほどの彫りの帯（菱の連なりと縁の細線）を持つ。
  const rf1 = r0 * 1.04;
  const rf0 = r0 * 0.96;
  const ferruleAt = (t) => rf0 + ((rf1 - rf0) * (t - B.hair)) / B.ferrule;
  bg.fillStyle = brass(B.hair + B.ferrule / 2, rf1);
  band(bg, B.hair, ferruleTop, rf0, rf1);
  bg.fill();
  rim(ferruleTop - 0.06, rf1, -1);
  rim(B.hair + 0.07, rf0, 1);
  // 口の巻き返し: 口の縁の太い照りと、その内側の影。
  bg.strokeStyle = 'rgba(28,16,4,0.85)';
  bg.lineWidth = hairline * 1.3;
  bg.beginPath();
  ring(bg, B.hair, rf0 * 0.98);
  bg.stroke();
  // 彫りの帯。
  const engraveFrom = B.hair + B.ferrule * 0.3;
  const engraveTo = B.hair + B.ferrule * 0.7;
  for (const t of [engraveFrom, engraveTo]) {
    bg.strokeStyle = 'rgba(62,38,10,0.75)';
    bg.lineWidth = hairline * 0.8;
    bg.beginPath();
    ring(bg, t, ferruleAt(t));
    bg.stroke();
  }
  const lozenges = 9;
  const tMid = (engraveFrom + engraveTo) / 2;
  const halfLen = (engraveTo - engraveFrom) * 0.36;
  for (let i = 0; i < lozenges; i += 1) {
    const theta = -Math.PI / 2 + (Math.PI * (i + 0.5)) / lozenges;
    const r = ferruleAt(tMid);
    const halfWide = Math.cos(theta) * r * (Math.PI / lozenges) * 0.42;
    const point = (t, w) => {
      const p = surface(t, r, theta);
      return [p[0] + n[0] * w, p[1] + n[1] * w];
    };
    bg.fillStyle = `rgba(58,34,8,${0.55 + 0.3 * Math.cos(theta)})`;
    bg.beginPath();
    bg.moveTo(...point(tMid - halfLen, 0));
    bg.lineTo(...point(tMid, halfWide));
    bg.lineTo(...point(tMid + halfLen, 0));
    bg.lineTo(...point(tMid, -halfWide));
    bg.closePath();
    bg.fill();
    bg.fillStyle = `rgba(255,240,200,${0.3 + 0.4 * Math.max(0, Math.sin(theta + 0.6))})`;
    bg.beginPath();
    bg.arc(...point(tMid, halfWide * 0.2), Math.max(0.25, halfWide * 0.18), 0, Math.PI * 2);
    bg.fill();
  }
  // 口金の照り: 灯りの側の強い一筋と、暗い側の縁の琥珀の照り返し。
  bg.strokeStyle = 'rgba(255,252,236,0.85)';
  bg.lineWidth = Math.max(0.45, r0 * 0.08);
  bg.beginPath();
  bg.moveTo(...surface(B.hair + 0.16, ferruleAt(B.hair + 0.16), 0.7));
  bg.lineTo(...surface(ferruleTop - 0.14, ferruleAt(ferruleTop - 0.14), 0.7));
  bg.stroke();
  bg.strokeStyle = 'rgba(255,176,84,0.35)';
  bg.lineWidth = Math.max(0.4, r0 * 0.07);
  bg.beginPath();
  bg.moveTo(...surface(B.hair + 0.12, ferruleAt(B.hair + 0.12), -1.04));
  bg.lineTo(...surface(ferruleTop - 0.1, ferruleAt(ferruleTop - 0.1), -1.04));
  bg.stroke();

  bg.restore();
}
