// 大書庫の画面（#academy-library-screen）の場面と動き。
// 場面: 到着 → 問いを渡す → 待つ → 本が並ぶ → 指を乗せる → 手に取って開く → めくる → 関連する本へ → 閉じる → 退出。
// 画面の状態は section の data-scene（と data-reading・本の data-open / data-ink / data-spread）に出す。
//
// 行き先との配線（到着の GET・退出のロードの被覆・BGM）と、LM の設定・接続の失敗を設定画面へ誘導すること、本文 read の
// flight guard、要求そのもの（postJson / getJson）は app.js が持ち、createLibraryScreen の引数で受け取る。この module は
// 画面の中の場面と動きだけを持つ。失敗は場所の中の短い一文（票か頁の紙の上のインクの字）で見せ、server の内部文は
// console へだけ渡す。
import { parseLibraryFootnotes, libraryFootnoteReadTarget } from './libraryFootnotesClient.js';
import { LIBRARY_BRUSH_BOX, LIBRARY_BRUSH_LEAN, paintLibraryBrush } from './libraryBrush.js';
import { LETTER_GAP, WORD_SPACE, createLanguage, placeLetter, shapeKey, wordWidth } from './libraryScript.js';

// 失敗の一文（説明の地の文は置かない）。
const SEARCH_FAILED_LINE = '書庫は答えを連れてこられませんでした';
const READ_FAILED_LINE = '今は写しを綴じられませんでした';
const ARRIVAL_FAILED_LINE = '今は書庫に入れませんでした';
const GATED_NOTE = '今は開けない';
const FOOTNOTES_HEADING = '関連する本';
const FOOTNOTES_FAILED_LINE = '関連する本を読み込めませんでした。';
const FOOTNOTES_RETRY_LABEL = '再試行';
const GATED_ERROR_CODE = 'LIBRARY_BOOK_GATED';

const gatedLine = (title) => `「${title}」${GATED_NOTE}`;

// 画面を離れた（または入り直した）あとに走り残った流れを止める印。報告しない。
class LeftScene extends Error {
  constructor() {
    super('library screen: the visit this flow belonged to has ended');
  }
}

// ── 動きの性格: 行き過ぎを持たない ease-out と、紙・革・灯りの速さ ────────────────────────────────
const EASE = 'cubic-bezier(0.22, 0.61, 0.36, 1)';
const REDUCED_FADE_MS = 120;

// ── 本ごとの姿: 本の id（生成本は題）から決まる値。同じ本はいつも同じ姿で出る ─────────────────────────
const COVER_IMAGES = {
  core: "url('/canonical/library/cover_core.jpg')",
  periphery: "url('/canonical/library/cover_periphery.jpg')"
};

function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function seededRandom(seed) {
  let state = seed || 1;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 生成の本の装丁: 暗い布か革の背に金か墨の題。本ごとの違いは装丁の色と背の飾り（帯・線・天地の革・題の革片）で出し、
// 明るさは絵の中の本にそろえる（紙の地は使わない）。地の模様は中核（革）と周縁（布）の表紙の絵を装丁の色に染めて使う。
const BINDINGS = {
  cloth: { image: 'periphery', cover: COVER_IMAGES.periphery, colors: ['#34445e', '#5c2a22', '#2e4834', '#4d3826', '#402e44', '#5a4a2c', '#303034'] },
  leather: { image: 'core', cover: COVER_IMAGES.core, colors: ['#6a2f1f', '#46291a', '#2e211a', '#553421', '#30402f', '#43222a'] }
};
const GOLD_INKS = ['#dcb96e', '#cfad64', '#e2c47e'];
const SUMI_INK = '#1c130c';
// 題の革片: 金の題は暗い革片、墨の題は鞣した明るめの革片に載せる。
const GOLD_PIECES = ['#1c1410', '#4e1c16', '#1d2738', '#2a3624'];
const SUMI_PIECES = ['#8a6c44', '#7c6848', '#86603a'];
const GOLD_RULE = 'rgb(214 176 100 / 0.85)';

function stripe(from, to, color) {
  return `linear-gradient(180deg, transparent ${from.toFixed(1)}%, ${color} ${from.toFixed(1)}%, ${color} ${to.toFixed(1)}%, transparent ${to.toFixed(1)}%)`;
}

// 背の綴じ目の盛り上がり（金の線を掛けたものと、空押しの暗い筋）。
function raisedBand(at, gilt) {
  return gilt
    ? `linear-gradient(180deg, transparent ${at.toFixed(1)}%, rgb(0 0 0 / 0.5) ${at.toFixed(1)}%, rgb(230 190 110 / 0.55) ${(at + 0.6).toFixed(1)}%, rgb(255 220 160 / 0.18) ${(at + 1.2).toFixed(1)}%, transparent ${(at + 2).toFixed(1)}%)`
    : `linear-gradient(180deg, transparent ${at.toFixed(1)}%, rgb(0 0 0 / 0.55) ${at.toFixed(1)}%, rgb(255 230 190 / 0.12) ${(at + 0.8).toFixed(1)}%, transparent ${(at + 1.6).toFixed(1)}%)`;
}

function bindingLook(r, between, pick) {
  const material = r() < 0.5 ? 'cloth' : 'leather';
  const binding = BINDINGS[material];
  const color = pick(binding.colors);
  const sumi = r() < 0.3;
  const piece = sumi ? pick(SUMI_PIECES) : (r() < 0.45 ? pick(GOLD_PIECES) : null);
  const deco = [];
  const bandCount = [0, 2, 3, 4, 5][Math.floor(r() * 5)];
  const gilt = r() < 0.6;
  for (let i = 0; i < bandCount; i += 1) deco.push(raisedBand(8 + (i * 80) / Math.max(1, bandCount - 1) + between(-1.5, 1.5), gilt));
  if (r() < 0.5) {
    // 天地の金の二本線。
    for (const at of [3.2, 95.2]) deco.push(stripe(at, at + 0.45, GOLD_RULE), stripe(at + 1.1, at + 1.4, GOLD_RULE));
  }
  if (r() < 0.4) {
    // 天地の革（半革装）: 布や革の地と色を変える。
    const cap = between(6, 10);
    const leather = pick(BINDINGS.leather.colors.filter((other) => other !== color));
    deco.push(stripe(0, cap, leather), stripe(100 - cap, 100, leather));
  }
  return {
    image: binding.image,
    cover: binding.cover,
    color,
    ink: sumi ? SUMI_INK : pick(GOLD_INKS),
    piece,
    deco: deco.join(', '),
    spinePos: between(36, 64)
  };
}

function bookLook(key, cover) {
  const r = seededRandom(hash32(`${cover}|${key}`));
  const between = (min, max) => min + (max - min) * r();
  const pick = (list) => list[Math.floor(r() * list.length)];
  const spots = [];
  const spotCount = 2 + Math.floor(r() * 2);
  for (let i = 0; i < spotCount; i += 1) {
    spots.push(`radial-gradient(circle at ${between(5, 95).toFixed(0)}% ${between(4, 96).toFixed(0)}%, rgb(255 236 200 / ${between(0.1, 0.24).toFixed(2)}), transparent ${between(8, 26).toFixed(0)}%)`);
  }
  const hueRange = cover === 'periphery' ? 26 : 12;
  const lightAngle = between(118, 152).toFixed(0);
  const lightA = between(0.08, 0.3).toFixed(2);
  const light = {
    '--light-angle': `${lightAngle}deg`,
    '--light-a': lightA
  };
  if (cover === 'generated') {
    const b = bindingLook(r, between, pick);
    return {
      frame: b.image,
      vars: {
        '--cover': b.cover,
        '--cover-face': COVER_FACES[b.image],
        '--paper': b.color,
        '--blend': 'luminosity',
        '--hue': '0deg',
        '--sat': between(0.9, 1.1).toFixed(2),
        '--bright': between(0.7, 0.84).toFixed(2),
        '--sepia': '0',
        '--spine-pos': `${b.spinePos.toFixed(1)}%`,
        '--deco': b.deco || 'none',
        '--wear': spots.join(', '),
        '--ink': b.ink,
        '--label': b.piece ?? 'transparent',
        ...light
      }
    };
  }
  const bandCount = cover === 'core' ? 4 + Math.floor(r() * 2) : 2;
  const bands = [];
  for (let i = 0; i < bandCount; i += 1) {
    const at = cover === 'core' ? 10 + (i * 78) / (bandCount - 1) + between(-2, 2) : (i === 0 ? between(6, 10) : between(88, 93));
    bands.push(raisedBand(at, true));
  }
  return {
    frame: cover,
    vars: {
      '--cover': COVER_IMAGES[cover],
      '--cover-face': COVER_FACES[cover],
      '--paper': '#ffffff',
      '--blend': 'multiply',
      '--hue': `${between(-hueRange, hueRange).toFixed(1)}deg`,
      '--sat': between(0.78, 1.14).toFixed(2),
      '--bright': between(0.8, 1.05).toFixed(2),
      '--sepia': '0',
      '--spine-pos': `${between(0, 6).toFixed(1)}%`,
      '--deco': bands.join(', '),
      '--wear': spots.join(', '),
      ...light
    }
  };
}

function applyLookVars(el, look) {
  for (const [name, value] of Object.entries(look.vars)) el.style.setProperty(name, value);
}

// ── 灯り（絵の上の層。座標は書庫の絵の中の位置） ─────────────────────────────────────────────────
// depth は通路の手前から奥への順（待ちの移ろいと退出の消灯の順）。depth の無い灯り（吊り灯）は待ちの間は落とす。
// depth のある灯りは絵の燭台の硝子の真ん中に置く（depth 4 は奥の格子扉の上の灯り）。
const LAMPS = [
  { x: 5.0, y: 51.25, size: 8, depth: 0 },
  { x: 42.5, y: 51.94, size: 6.5, depth: 0 },
  { x: 12.36, y: 51.67, size: 5.4, depth: 1 },
  { x: 36.67, y: 52.08, size: 5, depth: 1 },
  { x: 14.24, y: 52.22, size: 4, depth: 2 },
  { x: 32.43, y: 52.29, size: 3.6, depth: 2 },
  { x: 15.28, y: 52.43, size: 3, depth: 3 },
  { x: 22.99, y: 45.49, size: 3.2, depth: 4 },
  { x: 20.8, y: 28.2, size: 3.4 },
  { x: 23.5, y: 28.6, size: 3.8 },
  { x: 26.2, y: 27.8, size: 3.4 },
  { x: 75.5, y: 59.5, size: 7 }
];
const LAMP_DEPTHS = 5;

// 待つ: 灯りの明るみが手前（depth 0）から奥へ送られ、奥の格子扉の上の灯りで一度強まり、また手前へ戻る（書庫番が灯りを手に
// 奥へ探しに行く気配）。明るみは depth のある灯りに重ねた暈（燭台の硝子に締まった芯と壁に落ちる小さな暈）の不透明度で、
// 灯りそのものの息はそのまま続く。1周のうち SEEK_OUT を奥へ行き、残りで戻る。明るみの中心は奥の灯りを少し越えた
// SEEK_REACH まで届く。暈の強さは中心からの depth の距離のガウスで、奥の灯りだけ SEEK_FAR_GAIN 倍強い（その強さが不透明度 1）。
const SEEK_CYCLE_MS = 3200;
const SEEK_OUT = 0.6;
const SEEK_REACH = LAMP_DEPTHS - 0.4;
const SEEK_SPREAD = 0.55;
const SEEK_FAR_GAIN = 1.35;
const SEEK_STEPS = 64;
// 暈は待ちに入ると SEEK_FADE_MS で現れ、応答が来るとその時の明るさのまま SEEK_FADE_MS で引く。
const SEEK_FADE_MS = 400;

function seekKeyframes(depth) {
  const gain = depth === LAMP_DEPTHS - 1 ? SEEK_FAR_GAIN : 1;
  return Array.from({ length: SEEK_STEPS + 1 }, (_, step) => {
    const phase = step / SEEK_STEPS;
    const reach = phase < SEEK_OUT ? (phase / SEEK_OUT) * SEEK_REACH : (1 - (phase - SEEK_OUT) / (1 - SEEK_OUT)) * SEEK_REACH;
    const light = (Math.exp(-((reach - depth) ** 2) / SEEK_SPREAD) * gain) / SEEK_FAR_GAIN;
    return { offset: phase, opacity: light.toFixed(3) };
  });
}

// ── 棚: 書庫の絵の右の書架の 3 段に、本を絵の背の一本ずつの姿で並べる ─────────────────────────────────────────
// 右の書架は一点透視で、横の線（段の板の縁・本の天・金の帯）は消失点 SHELF_VP へ集まり、縦の線（背の縁）は縦のまま。値はどれも
// stage.jpg の上の実測で、単位は絵の幅を ART_UNIT としたときの絵の px。
// - 上の段（7 冊）と下の段（2 冊）: 本は絵の背の枠（左右の縁 xs・背の真ん中の列での天 tops と足もと floors）に当たる。背の地は
//   絵の背の画素そのもので、色だけ本ごとに寄せる。背の面は、背の真ん中の列を基準に、消失点の高さを軸として列ごとに縦に伸び
//   縮みさせた平らな面で、天（背の天の SPINE_HEADROOM 上。背の上の隙間は暗く、色の混ぜで変わらない）と地は消失点への線。題箋は
//   背の金の帯の無い間の真ん中（labels: 背の真ん中の列での y）に置く。下の段の 3 本目の背は絵の本のまま残す。
// - 真ん中の段（6 冊）: 段の奥の壁を奥行き u の面とみて（x = vx + C/u・y = vy + (Y − vy)/u。u = 1 の列が xRef）、本は厚み d・
//   高さ height の長方形の背としてこの面に置く。背は奥（左）ほど細く低く、天と足もと（床の板の縁の xRef での高さ）は消失点への
//   一本の線に並ぶ。背の地は、絵の真ん中の段の背の枠 source（sources の左右の縁・sourceTops の天）の画素を本の背の面へ写したもの。題箋の天は一本の線（labelTop）にそろい、
//   字の大きさは本の背の面の上で一定（画面では奥ほど小さい）。背が縮んで空いた段の口（mouth）は段の奥の暗がりで埋める。右の端の
//   本は画面の端で切れる（題箋が画面に収まる薄い本にしてある）。
// 本ごとの背の面・題箋は、平らに組んでから背の四辺形へ射影で写す（quadProjection）。
const ART_UNIT = 1440;
const SHELF_VP = [202.1, 754.7];
const SPINE_HEADROOM = 3;
const PAINTED_BAYS = {
  upper: {
    xs: [1145, 1162, 1176, 1199, 1222, 1240, 1263, 1278],
    tops: [524, 524, 510, 506, 500, 496, 500],
    floors: [645.75, 643.94, 641.77, 639.07, 636.67, 634.27, 632.04],
    labels: [592.39, 589.27, 584.64, 580.67, 576.63, 572.04, 564.5]
  },
  lower: { xs: [1306, 1346, 1394], tops: [875, 877], floors: [1042.2, 1056.5], labels: [966.82, 975.62], wide: true }
};
const MIDDLE_BAY = {
  mouth: { left: 1305, right: 1440, top: [[1306, 649.2], [1438, 636.0]], floor: [[1306, 824.5], [1438, 833.4]] },
  xRef: 1373.5,
  height: 159,
  firstLeft: 1307,
  labelTop: 703,
  books: [{ d: 0.02, source: 0 }, { d: 0.0195, source: 1 }, { d: 0.0205, source: 2 }, { d: 0.02, source: 3 }, { d: 0.02, source: 4 }, { d: 0.015, source: 3 }],
  sources: [1307, 1329, 1351, 1375, 1400, 1424, 1440],
  sourceTops: [674, 673, 669, 664, 661, 661]
};
// 題箋（絵の px・字の大きさは em。字の送りは CSS の字間込みで 1.04em）: 字の列の天地に空ける分の和、題箋の幅（字の大きさの倍・
// 背の幅から side を引いた幅まで）。上と下の段の字の大きさは背の幅から（(幅 − 4)×0.66 を 9〜11.5 に収める）、真ん中の段は middleChar。
// 下の段の副題のある題は、題を wideTitle・副題を wideSub の字で別の列に置き、題箋は背の幅の wideWidth 倍。下の段の副題の無い題が
// 一列では TITLE_MIN_SCALE で収まらないときは、題を 2 列に折って（titleHalves）同じ字で並べ、題箋は同じ幅。題箋は背の中の room
// （背の面の上の [天, 地]）に収め、収まらない題だけ字を小さくする。小さくできるのは TITLE_MIN_SCALE まで（それより小さい字は
// 棚を見渡して読めない）。
const LABEL = { ends: 1.1, widthEm: 1.75, side: 3, minChar: 9, maxChar: 11.5, middleChar: 11, wideTitle: 14, wideSub: 7.5, wideWidth: 0.74, foot: 4 };
const TITLE_MIN_SCALE = 0.72;
// 引き出す: 本は自分の載っている板の線に沿って通路の側（左）へ、背の右の縁の丈の PULL_REACH 倍だけ引き出され、PULL_SCALE に
// 近づく。横に出た分だけ、右隣の本の陰から表紙の面（開くときの表紙と同じ縦横比 COVER_ASPECT の面）が見えてくる。
const PULL_REACH = 0.78;
const PULL_SCALE = 1.03;
// 開くときの表紙（.academy-library-cover-leaf: 本の幅 74vh×1.699 の 47%、高さ 74vh の 99%）の横÷縦。
const COVER_ASPECT = (74 * 1.699 * 0.47) / (74 * 0.99);
// 棚へ押し込む: 1 冊 SHELVE_MS・SHELVE_STAGGER_MS ずつずらし。本は SHELVE_SHOWN の所で見えきる（本の跡の暗がりもそこまでに満ちる）。
const SHELVE_REACH = 1.6;
const SHELVE_MS = 900;
const SHELVE_STAGGER_MS = 120;
const SHELVE_SHOWN = 0.35;

function lineAt(xs, ys, x) {
  return ys[0] + ((ys[1] - ys[0]) * (x - xs[0])) / (xs[1] - xs[0]);
}

const throughVp = ([x0, y0]) => (x) => SHELF_VP[1] + ((y0 - SHELF_VP[1]) * (x - SHELF_VP[0])) / (x0 - SHELF_VP[0]);
const segmentLine = ([[x0, y0], [x1, y1]]) => (x) => lineAt([x0, x1], [y0, y1], x);

// 引き出す向き（引き出す量 1 あたり・絵の上）: 真左に、板の線 board（x → y）の上り分を足す。下へは向けない — 表紙の面の右の端は
// 棚に収まった背の右の縁に残り、そこの板は収まった足もとの高さにあるので、下へ向く分だけ表紙の面の足が板より下へ出る。
function pullAlong(board, [x0, x1]) {
  return [-1, Math.min(0, (board(x0) - board(x1)) / (x1 - x0))];
}

// 上と下の段の背: 背の面は [左の縁, 右の縁] × [天, 足もと]（背の真ん中の列での y）の長方形で、四隅は列ごとの伸び縮みで写す。
function paintedSlots(bay, key) {
  return bay.tops.map((spineTop, i) => {
    const [x0, x1] = [bay.xs[i], bay.xs[i + 1]];
    const centre = (x0 + x1) / 2;
    const top = spineTop - SPINE_HEADROOM;
    const floor = bay.floors[i];
    const [up, down] = [throughVp([centre, top]), throughVp([centre, floor])];
    const quad = [[x0, up(x0)], [x1, up(x1)], [x1, down(x1)], [x0, down(x0)]];
    const width = x1 - x0;
    const height = floor - top;
    const spine = height - SPINE_HEADROOM;
    return {
      bay: key,
      order: i,
      quad,
      pull: pullAlong(down, [x0, x1]),
      face: { width, height },
      source: quad,
      wide: bay.wide === true,
      char: Math.max(LABEL.minChar, Math.min(LABEL.maxChar, (width - 4) * 0.66)),
      label: { centre: bay.labels[i] - top },
      room: [SPINE_HEADROOM + spine * 0.06, height - spine * 0.04]
    };
  });
}

// 真ん中の段の背: 奥（左の柱）から手前へ、u を厚みの分ずつ減らして並べる。
function middleSlots() {
  const { mouth, xRef, height, firstLeft, labelTop, books, sources, sourceTops } = MIDDLE_BAY;
  const [vx, vy] = SHELF_VP;
  const C = xRef - vx;
  const uOf = (x) => C / (x - vx);
  const xOf = (u) => vx + C / u;
  const toPlane = (y, u) => vy + (y - vy) * u;
  const toScreen = (Y, u) => vy + (Y - vy) / u;
  const floor = segmentLine(mouth.floor);
  const floorY = toPlane(floor(xRef), 1);
  const topY = floorY - height;
  let u = uOf(firstLeft);
  return books.map(({ d, source }, i) => {
    const [u0, u1] = [u, u - d];
    u = u1;
    const [xa, xb] = [xOf(u0), xOf(u1)];
    const [sx0, sx1] = [sources[source], sources[source + 1]];
    const sourceTop = toPlane(sourceTops[source], uOf((sx0 + sx1) / 2));
    const quad = [[xa, toScreen(topY, u0)], [xb, toScreen(topY, u1)], [xb, toScreen(floorY, u1)], [xa, toScreen(floorY, u0)]];
    return {
      bay: 'middle',
      order: i,
      quad,
      pull: pullAlong(floor, [xa, xb]),
      face: { width: d * C, height },
      source: [[sx0, toScreen(sourceTop, uOf(sx0))], [sx1, toScreen(sourceTop, uOf(sx1))], [sx1, floor(sx1)], [sx0, floor(sx0)]],
      wide: false,
      char: LABEL.middleChar,
      label: { top: labelTop - topY },
      room: [labelTop - topY, height - LABEL.foot]
    };
  });
}

// 本を当てる背（上の段・真ん中の段・下の段の順）。
const SHELF_SLOTS = [...paintedSlots(PAINTED_BAYS.upper, 'upper'), ...middleSlots(), ...paintedSlots(PAINTED_BAYS.lower, 'lower')];
// 段の奥の暗がりの層: 真ん中の段の口（本が並ぶと暗がりが満ちる）と、上と下の段の本の下の背の形（引き出した本の跡。背の形より
// 少し内に取り、収まった本の縁から覗かない。本が棚へ押し込まれはじめると暗がりになる）。
const MIDDLE_MOUTH = (() => {
  const { left, right, top, floor } = MIDDLE_BAY.mouth;
  const [up, down] = [segmentLine(top), segmentLine(floor)];
  return [[left, up(left)], [right, up(right)], [right, down(right)], [left, down(left)]];
})();
const SHADE_INSET = 0.6;

function slotShade({ quad: [tl, tr, br, bl] }) {
  const i = SHADE_INSET;
  return [[tl[0] + i, tl[1] + i], [tr[0] - i, tr[1] + i], [br[0] - i, br[1] - i], [bl[0] + i, bl[1] - i]];
}

const boundsOf = (points) => {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return { left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
};
const artPct = (value) => pct((value / ART_UNIT) * 100);

// 背の題: 副題（「 — 」の後ろ）は同じ列に小さな字で続ける（本の背の副題の組み方）。
const SUBTITLE_SEPARATOR = ' — ';

function fillSpineTitle(el, title) {
  const at = title.indexOf(SUBTITLE_SEPARATOR);
  if (at < 0) {
    el.replaceChildren(document.createTextNode(title));
    return;
  }
  const subtitle = document.createElement('span');
  subtitle.className = 'academy-library-book-subtitle';
  subtitle.textContent = `— ${title.slice(at + SUBTITLE_SEPARATOR.length)}`;
  el.replaceChildren(document.createTextNode(title.slice(0, at)), subtitle);
}

function splitTitle(title) {
  const at = title.indexOf(SUBTITLE_SEPARATOR);
  return at < 0 ? { main: title, sub: null } : { main: title.slice(0, at), sub: title.slice(at + SUBTITLE_SEPARATOR.length) };
}

// 題箋の大きさ（字の大きさ 1 倍で・絵の px）。lengths は題を一列に書いた長さ（字の大きさ 1em あたり）: line は副題を同じ列に
// 続けたもの、main・sub は題と副題それぞれ、halves は副題の無い題を 2 列に折ったときの列の字（texts）と長さ（ems）で、折れない
// 一字の題は null（読むのは下の段で一列に収まらないときだけ）。返す題箋の halves は 2 列に折った列の字で、ほかは null。
function labelAt(slot, lengths) {
  if (slot.wide && lengths.sub !== null) {
    return { char: LABEL.wideTitle, sub: LABEL.wideSub, halves: null, width: slot.face.width * LABEL.wideWidth, height: Math.max(lengths.main * LABEL.wideTitle, lengths.sub * LABEL.wideSub) + LABEL.ends * LABEL.wideTitle };
  }
  const line = { char: slot.char, sub: null, halves: null, width: Math.min(slot.face.width - LABEL.side, slot.char * LABEL.widthEm), height: (lengths.line + LABEL.ends) * slot.char };
  if (!slot.wide || labelScale(slot, line) >= TITLE_MIN_SCALE || lengths.halves === null) return line;
  return { char: slot.char, sub: null, halves: lengths.halves.texts, width: slot.face.width * LABEL.wideWidth, height: (Math.max(...lengths.halves.ems) + LABEL.ends) * slot.char };
}

// 題箋を背の room に収める字の倍率（1 まで）。
function labelScale(slot, label) {
  return Math.min(1, (slot.room[1] - slot.room[0]) / label.height);
}

// 本を背へ当てる。本を置けるのは題箋が下限の字（TITLE_MIN_SCALE）で収まる背だけ（fits[本][背]）。届いた順に、残りの本が
// まだ全部どこかへ置ける限りで、いちばん前の背（上の段の奥 → 真ん中の段 → 下の段）へ置く。どう置いても入りきらないときだけ
// null。返すのは本ごとの背の index。
function assignSlots(fits) {
  // 残りの本 books を、空いた背 free へ全部置けるか（二部グラフの完全な割り当てがあるか）。
  const placeable = (books, free) => {
    const holder = new Map();
    const reach = (book, seen) => {
      for (const slot of free) {
        if (!fits[book][slot] || seen.has(slot)) continue;
        seen.add(slot);
        if (!holder.has(slot) || reach(holder.get(slot), seen)) {
          holder.set(slot, book);
          return true;
        }
      }
      return false;
    };
    return books.every((book) => reach(book, new Set()));
  };
  const free = SHELF_SLOTS.map((_slot, index) => index);
  const slotOf = [];
  for (let book = 0; book < fits.length; book += 1) {
    const rest = fits.map((_row, index) => index).slice(book + 1);
    const slot = free.find((candidate) => fits[book][candidate] && placeable(rest, free.filter((other) => other !== candidate)));
    if (slot === undefined) return null;
    slotOf.push(slot);
    free.splice(free.indexOf(slot), 1);
  }
  return slotOf;
}

// duration・delay は暗がりが満ちる長さと遅れ（ms）。
function buildShadeNode(points, { duration, delay }) {
  const node = document.createElement('div');
  node.className = 'academy-library-bay';
  node.style.setProperty('--shade-duration', `${duration}ms`);
  node.style.setProperty('--shade-delay', `${delay}ms`);
  const box = boundsOf(points);
  node.style.left = artPct(box.left);
  node.style.top = artPct(box.top);
  node.style.width = artPct(box.width);
  node.style.height = artPct(box.height);
  node.style.clipPath = `polygon(${points.map(([x, y]) => `${pct(((x - box.left) / box.width) * 100)} ${pct(((y - box.top) / box.height) * 100)}`).join(', ')})`;
  return node;
}

// 表紙の面の絵: 素材（900×1200 px）を面の丈に合わせて一様に縮め、背の側（左上）に付ける。面は絵より横に広いので、小口の側
// （右）に足りない COVER_FILL px（絵の px）を、外の罫より外の模様の無い帯（strip: 絵の x の [始め, 終わり)）で補う。絵を帯の
// 右端で縦に切ってそこから右の縁（擦れ・角の丸み）を面の右端へ付け、間は帯の列を鏡写しの順に並べて埋め、縁の手前では縁へ向かう
// 並びへ帯の幅でぼかして移る。帯の擦れの横筋が横へ繰り返されないよう、列ごとに縦へ最大 COVER_FILL_SHIFT px ずらす（ずれは天地と
// 両端で 0 へ細る）。組んだ一枚は絵の種類ごとに一度だけ作り、画面の root の --library-cover-face-<種類> に置く。生成の本も
// 同じ二枚（革は中核・布は周縁）を装丁の色に染めて使う。
const COVER_ART = {
  core: { src: '/canonical/library/cover_core.jpg', strip: [880, 887], seed: 11 },
  periphery: { src: '/canonical/library/cover_periphery.jpg', strip: [858, 882], seed: 13 }
};
const COVER_IMAGE_PX = [900, 1200];
const COVER_FILL = Math.round(COVER_IMAGE_PX[1] * COVER_ASPECT - COVER_IMAGE_PX[0]);
const COVER_FILL_SHIFT = 30;
const COVER_FACES = Object.fromEntries(Object.keys(COVER_ART).map((image) => [image, `var(--library-cover-face-${image})`]));

async function layCoverFace(image) {
  const { src, strip: [s0, s1], seed } = COVER_ART[image];
  const [w, h] = COVER_IMAGE_PX;
  const art = new Image();
  art.src = src;
  await art.decode();
  if (art.naturalWidth !== w || art.naturalHeight !== h) throw new Error(`cover art ${src} is ${art.naturalWidth}×${art.naturalHeight}, not ${w}×${h}`);
  const canvas = document.createElement('canvas');
  canvas.width = w + COVER_FILL;
  canvas.height = h;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(art, 0, 0);
  const source = g.getImageData(0, 0, w, h).data;
  g.drawImage(art, s1, 0, w - s1, h, s1 + COVER_FILL, 0, w - s1, h);
  const n = s1 - s0;
  const mirror = (t) => (t % (2 * n) < n ? s1 - 1 - (t % (2 * n)) : s0 + (t % (2 * n)) - n);
  const random = seededRandom(seed);
  const shiftOf = (j) => (random() - 0.5) * 2 * COVER_FILL_SHIFT * Math.min(1, j / 4, (COVER_FILL - 1 - j) / 4);
  const rowAt = (y, shift) => Math.min(h - 1, Math.max(0, Math.round(y + shift * Math.sin((Math.PI * y) / h))));
  const fill = g.createImageData(COVER_FILL, h);
  const out = fill.data;
  const put = (x, y, sx, sy, a) => {
    const i = (y * COVER_FILL + x) * 4;
    const k = (sy * w + sx) * 4;
    for (let c = 0; c < 3; c += 1) out[i + c] = out[i + c] * (1 - a) + source[k + c] * a;
    out[i + 3] = 255;
  };
  for (let j = 0; j < COVER_FILL; j += 1) {
    const fromLeft = mirror(j);
    const fromRight = mirror(COVER_FILL - 1 - j);
    const a = Math.min(1, Math.max(0, (j - (COVER_FILL - 1 - n)) / n));
    const shiftL = shiftOf(j);
    const shiftR = shiftOf(j);
    for (let y = 0; y < h; y += 1) {
      put(j, y, fromLeft, rowAt(y, shiftL), 1);
      if (a > 0) put(j, y, fromRight, rowAt(y, shiftR), a);
    }
  }
  g.putImageData(fill, s1, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error(`cover art ${src}: the laid face could not be encoded`);
  return URL.createObjectURL(blob);
}

function layCoverFaces(root) {
  return Promise.all(Object.keys(COVER_ART).map(async (image) => {
    root.style.setProperty(`--library-cover-face-${image}`, `url('${await layCoverFace(image)}')`);
  }));
}

// 表紙の金の題（棚で引き出したときと、手の中の表紙で同じもの）。副題は背と同じく小さな字で続ける。題のまとまりは、面の上の
// 内側の枠（中核の絵は額縁の中・周縁の絵は空押しの内枠の中）の真ん中に、左右も上下も揃えて置く。列は語の切れ目（仮名・約物・
// 空白の後ろで、仮名でない字が始まる所と、副題の頭）でだけ折る。一列で収まる大きさが下限に届かない題は、列の丈がいちばん
// 揃う切れ目で列を左へ足し、収まるいちばん大きい字にする。内側の枠は絵（900×1200 px）の中の真ん中と、真ん中に置いた長方形が
// 模様から 20px 離れて収まる大きさ（room: 半幅がその値以下なら、その半丈まで収まる）。額縁は天地が弧で細るので、幅の広い
// まとまりほど丈が短い。
const COVER_FRAMES = {
  core: { center: [474.5, 599], room: [[110, 308], [120, 293], [140, 261], [150, 243], [170, 224], [180, 211]] },
  periphery: { center: [470.5, 594], room: [[210, 444], [220, 427], [230, 402], [240, 398], [250, 392], [260, 386]] }
};
// 字の大きさは面の幅に対する割合（CSS の 10.5cqw・字間 0.08em・列の間 line-height 1.25 と同じ値）。
const COVER_TITLE_EM = 0.105;
const COVER_TITLE_ADVANCE = 1.08;
const COVER_TITLE_PITCH = 1.25;
const COVER_TITLE_MIN_SCALE = 0.62;
// 副題の字の大きさ（CSS の .academy-library-book-subtitle の 0.72em）。
const COVER_SUBTITLE_EM = 0.72;
// 閉じるときに押す蔵書票（面の %）: 票の箱の一辺（面の幅に対する %・CSS の width と同じ値）と、絵（512 px 四方）の中で描かれて
// いる所、題の字との間に空ける幅、箱の真ん中（内枠の右下の角。中核の絵では額縁の右下の段の角・CSS の left・top と同じ値）。
// 票はどの本でもここに押し、題の字はその描かれた所（と空ける幅）に掛からない。
const EX_LIBRIS = { size: 27, ink: [49 / 512, 32 / 512, 462 / 512, 478 / 512], clear: 1, at: [80, 77] };

const EX_LIBRIS_INK = (() => {
  const [x, y] = EX_LIBRIS.at;
  const width = EX_LIBRIS.size;
  const height = EX_LIBRIS.size * COVER_ASPECT;
  const [x0, y0, x1, y1] = EX_LIBRIS.ink;
  const clear = EX_LIBRIS.clear;
  return { x0: x + (x0 - 0.5) * width - clear, y0: y + (y0 - 0.5) * height - clear, x1: x + (x1 - 0.5) * width + clear, y1: y + (y1 - 0.5) * height + clear };
})();

const boxesMeet = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

// 語の切れ目: 前の字が仮名・約物（開きかっこを除く）・空白で、次の字がそのどれでもない（開きかっこは始まりの側）所。
const isPhraseTail = (char) => /[\p{Script=Hiragana}\s]/u.test(char) || (/\p{P}/u.test(char) && !/\p{Ps}/u.test(char));
const isPhraseHead = (char) => !isPhraseTail(char);

// 題を語の切れ目で句に分ける。句は字（text）・副題か（sub）・字の送りで数えた丈（length: 本題の字 1・副題の字 0.72。副題の
// 頭の「 — 」の分は最初の句に足す）。tooLong に当たる句は、その中の字の境目でも分けて一字ずつの句にする。
function coverTitlePhrases(title, tooLong = () => false) {
  const at = title.indexOf(SUBTITLE_SEPARATOR);
  const runs = at < 0 ? [{ chars: [...title], sub: false }] : [{ chars: [...title.slice(0, at)], sub: false }, { chars: [...title.slice(at + SUBTITLE_SEPARATOR.length)], sub: true }];
  const phrases = [];
  for (const { chars, sub } of runs) {
    const piece = (from, to) => {
      const text = chars.slice(from, to).join('');
      return sub
        ? { text: from === 0 ? `— ${text}` : text, sub, length: COVER_SUBTITLE_EM * (to - from + (from === 0 ? [...SUBTITLE_SEPARATOR].length : 0)) }
        : { text, sub, length: to - from };
    };
    let start = 0;
    for (let i = 1; i <= chars.length; i += 1) {
      if (i < chars.length && !(isPhraseTail(chars[i - 1]) && isPhraseHead(chars[i]))) continue;
      const phrase = piece(start, i);
      if (tooLong(phrase)) for (let char = start; char < i; char += 1) phrases.push(piece(char, char + 1));
      else phrases.push(phrase);
      start = i;
    }
  }
  return phrases;
}

// 句の並びを columns 列に分ける。最も長い列の丈がいちばん短くなる切り方（同じ丈なら前の列を長く）。(句の頭, 残りの列数) ごとに
// 一度だけ求める（句 m 個・columns 列で m²・columns 回の比べ）。
function splitCoverColumns(phrases, columns) {
  const start = [0];
  for (const phrase of phrases) start.push(start[start.length - 1] + phrase.length);
  const memo = new Map();
  const best = (from, left) => {
    if (left === 1) return { longest: start[phrases.length] - start[from], cuts: [] };
    const id = from * columns + left;
    if (memo.has(id)) return memo.get(id);
    let found = null;
    for (let cut = phrases.length - left + 1; cut > from; cut -= 1) {
      const rest = best(cut, left - 1);
      const longest = Math.max(start[cut] - start[from], rest.longest);
      if (!found || longest < found.longest) found = { longest, cuts: [cut, ...rest.cuts] };
    }
    memo.set(id, found);
    return found;
  };
  const { longest, cuts } = best(0, columns);
  const edges = [0, ...cuts, phrases.length];
  return { longest, columns: cuts.concat(phrases.length).map((to, index) => phrases.slice(edges[index], to)) };
}

// 副題の無い題を背の題箋の 2 列に折る: 語の切れ目で、長い方の列がいちばん短くなる所（題の半分より長い句はその中の字の境目でも
// 折る）。一字の題は折れない（null）。
function titleHalves(title) {
  const count = [...title].length;
  if (count < 2) return null;
  const phrases = coverTitlePhrases(title, (phrase) => phrase.length > Math.ceil(count / 2));
  return splitCoverColumns(phrases, 2).columns.map((column) => column.map((phrase) => phrase.text).join(''));
}

// 題の字の大きさ・列（句の並びの並び）と、題を置く長方形（面の % の left・right・top・bottom）。
// 長さは面の幅を 1 とした値。絵は面の丈に合わせて左上に付いているので、絵の 1 px は面の丈 ÷ 1200。
// 語の切れ目で 0.62 倍以上に組める最少の列数をとる。どの列数でも届かない題に限り、一列に置いても 0.62 倍に届かない句をその
// 中の字の境目でも折り、0.62 倍以上に組める最少の列数をとる。
function coverTitleLayout(title, image) {
  const { center, room } = COVER_FRAMES[image];
  const faceHeight = 1 / COVER_ASPECT;
  const unit = faceHeight / COVER_IMAGE_PX[1];
  const cx = center[0] * unit;
  const cy = center[1] * unit;
  // 列の丈は字の送りの計算どおりに出るので、ちょうどに合わせると端数で最後の一字がはみ出す。その分の余り。
  const slack = 1.02;
  // count 列で最も長い列の丈が longest のときの、まとまりの幅（字の箱の端から端。列の間は行の送り、両端の列は字の幅 1em）と
  // 列の丈（字の大きさ 1 で）、それがいちばん大きく収まる room と字の大きさ。
  const fitAt = (count, longest) => {
    const across = ((count - 1) * COVER_TITLE_PITCH + 1) * COVER_TITLE_EM;
    const along = longest * COVER_TITLE_EM * COVER_TITLE_ADVANCE;
    const fit = room
      .map(([halfWidth, halfHeight]) => ({ halfWidth, halfHeight, scale: Math.min(1, (2 * halfWidth * unit) / across, (2 * halfHeight * unit) / (along * slack)) }))
      .reduce((a, b) => (b.scale > a.scale ? b : a));
    return { ...fit, across, along };
  };
  const place = (phrases, count) => {
    const { longest, columns } = splitCoverColumns(phrases, count);
    const fit = fitAt(count, longest);
    if (fit.scale < COVER_TITLE_MIN_SCALE) return null;
    const group = {
      x0: (cx - (fit.across * fit.scale) / 2) * 100,
      x1: (cx + (fit.across * fit.scale) / 2) * 100,
      y0: ((cy - (fit.along * fit.scale) / 2) / faceHeight) * 100,
      y1: ((cy + (fit.along * fit.scale) / 2) / faceHeight) * 100
    };
    if (boxesMeet(group, EX_LIBRIS_INK)) throw new Error(`cover title reaches the ex-libris: ${title}`);
    return {
      scale: fit.scale,
      columns,
      left: (cx - fit.halfWidth * unit) * 100,
      right: (1 - cx - fit.halfWidth * unit) * 100,
      top: ((cy - fit.halfHeight * unit) / faceHeight) * 100,
      bottom: (1 - (cy + fit.halfHeight * unit) / faceHeight) * 100
    };
  };
  const phrases = coverTitlePhrases(title);
  for (let count = 1; count <= phrases.length; count += 1) {
    const layout = place(phrases, count);
    if (layout) return layout;
  }
  const letterCount = [...title.replace(SUBTITLE_SEPARATOR, '')].length;
  for (let count = 1; count <= letterCount; count += 1) {
    const pieces = coverTitlePhrases(title, (phrase) => fitAt(count, phrase.length).scale < COVER_TITLE_MIN_SCALE);
    if (pieces.length < count) continue;
    const layout = place(pieces, count);
    if (layout) return layout;
  }
  throw new Error(`cover title does not fit the ${image} frame at the smallest letters: ${title}`);
}

// 列は改行（br）で折る。副題は一つの span に入れ、列をまたぐときは span の中で折る（副題の頭の空きは最初の列にだけ付く）。
function buildCoverTitle(layout) {
  const node = document.createElement('span');
  node.className = 'academy-library-cover-title';
  let subtitle = null;
  layout.columns.forEach((column, index) => {
    if (index > 0) (subtitle ?? node).append(document.createElement('br'));
    for (const phrase of column) {
      if (!phrase.sub) {
        node.append(phrase.text);
        continue;
      }
      if (!subtitle) {
        subtitle = document.createElement('span');
        subtitle.className = 'academy-library-book-subtitle';
        node.append(subtitle);
      }
      subtitle.append(phrase.text);
    }
  });
  node.style.setProperty('--cover-title-scale', layout.scale.toFixed(3));
  for (const side of ['left', 'right', 'top', 'bottom']) node.style[side] = pct(layout[side]);
  return node;
}

// 表紙の面の中身: 本ごとの色合い（hue・saturate・brightness の filter）を掛ける地 -paint と、その外に置く金の題。題の金は
// 本ごとの色に引かれず、どの本でも同じ。
function coverFaceLayers(title, frame) {
  const paint = document.createElement('span');
  paint.className = 'academy-library-cover-paint';
  return [paint, buildCoverTitle(coverTitleLayout(title, frame))];
}

const pct = (value) => `${value.toFixed(3)}%`;

// 引き出した姿（CSS の [data-drawn] と同じ形）を reach 倍にしたもの。向きは本の段の pull（--pull-x・--pull-y）で、
// 表紙の面が見える幅は横に出た分。棚へ並ぶ・棚を空ける動きは、この向きの逆と順。
function pulledOut(reach) {
  return {
    transform: `translate(calc(var(--pull-dx) * var(--pull-x) * ${reach}), calc(var(--pull-dx) * var(--pull-y) * ${reach})) scale(${1 + (PULL_SCALE - 1) * reach})`,
    width: `calc(var(--pull-dx) * var(--pull-x) * ${-reach})`
  };
}

// 引き出した姿の逆（CSS の [data-drawn]::before）。本の当たりは、引き出しているあいだも棚に収まった箱に残る
// （指を置いた所から本が左へ離れても、指はまだ本の上にある）。
function pulledBack() {
  return `scale(${1 / PULL_SCALE}) translate(calc(var(--pull-dx) * var(--pull-x) * -1), calc(var(--pull-dx) * var(--pull-y) * -1))`;
}

// ── 頁の紙: 見開きの絵（book_spread.jpg・2000×1250）の上で測った頁の形 ─────────────────────────────────────────
// 開いた本は手前（下）ほど広い台形に描かれ、紙は綴じ目から頁の幅の 1/4 ほどの所で盛り上がって、外の縁と綴じ目へ落ちる。
// 頁に書かれるものは全部この紙の上に載せる: 平らに組んだ頁（頁の箱）を一枚として紙の反りの網で持ち上げ、紙の内側に取った
// 字の台形へ射影で写す（奥ほど小さく細い）。値はどれも絵の px。
const SPREAD_IMAGE = { width: 2000, height: 1250 };
// 字を置く台形。角は頁の箱の [左上, 右上, 右下, 左下] に当たる。外の縁・綴じ目・天地から、手前ほど広い余白を取り（奥の余白は
// 手前の 0.88 倍）、綴じ目の側は紙が綴じ目へ急に落ちる所（綴じ目から頁の幅の 1 割）より外に取る。
const PAGE_TEXT_QUADS = {
  left: [[338, 176], [936, 178], [933, 1063], [252, 1046]],
  right: [[1089, 179], [1689, 177], [1778, 1049], [1101, 1063]]
};
// 紙の外の縁と綴じ目（[奥, 手前]）。反りの位置（綴じ目からの距離・天地の位置）はこの四辺形の中で測る。
const PAGE_PAPER = {
  left: { gutter: [[1010, 130], [1017, 1145]], outer: [[270, 126], [175, 1122]] },
  right: { gutter: [[1015, 130], [1017, 1145]], outer: [[1757, 127], [1855, 1125]] }
};
// 紙の反り: 奥の縁で 50px、手前の縁で 33px 持ち上がる所が頂で、綴じ目からの距離（頁の幅に対する割合）での高さの割合は
// ARCH_PROFILE（天地の縁の実測を綴じ目の側から読んだもの）。
const ARCH_LIFT = { far: 50, near: 33 };
const ARCH_PROFILE = [[0, 0], [0.08, 0.6], [0.12, 0.84], [0.24, 1], [0.37, 0.94], [0.53, 0.68], [0.65, 0.48], [0.8, 0.24], [0.92, 0.06], [1, 0]];

function archProfile(distance) {
  const d = Math.min(1, Math.max(0, distance));
  for (let i = 1; i < ARCH_PROFILE.length; i += 1) {
    const [d1, v1] = ARCH_PROFILE[i];
    if (d <= d1) {
      const [d0, v0] = ARCH_PROFILE[i - 1];
      return v0 + ((v1 - v0) * (d - d0)) / (d1 - d0);
    }
  }
  return 0;
}

// 絵の上の一点が、その頁の紙の反りでどれだけ持ち上がるか（絵の px）。
function paperLift(side, [x, y]) {
  const { gutter, outer } = PAGE_PAPER[side];
  const top = lineAt([gutter[0][0], outer[0][0]], [gutter[0][1], outer[0][1]], x);
  const bottom = lineAt([gutter[1][0], outer[1][0]], [gutter[1][1], outer[1][1]], x);
  const depth = Math.min(1, Math.max(0, (y - top) / (bottom - top)));
  const gutterX = gutter[0][0] + (gutter[1][0] - gutter[0][0]) * depth;
  const outerX = outer[0][0] + (outer[1][0] - outer[0][0]) * depth;
  const lift = ARCH_LIFT.far + (ARCH_LIFT.near - ARCH_LIFT.far) * depth;
  return lift * archProfile((x - gutterX) / (outerX - gutterX));
}

// 幅 width・高さ height の箱を四辺形 quad（[左上, 右上, 右下, 左下]・同じ座標系の px）へ写す射影。forward / inverse は点を、
// css はその写しの matrix3d（transform-origin 0 0）を返す。
function quadProjection(width, height, quad) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / det;
  const h = (dx1 * dy3 - dx3 * dy1) / det;
  // 行列（行ごと）: [X·w, Y·w, w] = m · [x, y, 1]。
  const m = [
    [(x1 - x0 + g * x1) / width, (x3 - x0 + h * x3) / height, x0],
    [(y1 - y0 + g * y1) / width, (y3 - y0 + h * y3) / height, y0],
    [g / width, h / height, 1]
  ];
  const [[a, b, c], [d, e, f], [p, q, r]] = m;
  const inv = [
    [e * r - f * q, c * q - b * r, b * f - c * e],
    [f * p - d * r, a * r - c * p, c * d - a * f],
    [d * q - e * p, b * p - a * q, a * e - b * d]
  ];
  const apply = (n, [x, y]) => {
    const w = n[2][0] * x + n[2][1] * y + n[2][2];
    return [(n[0][0] * x + n[0][1] * y + n[0][2]) / w, (n[1][0] * x + n[1][1] * y + n[1][2]) / w];
  };
  const css = `matrix3d(${[a, d, 0, p, b, e, 0, q, 0, 0, 1, 0, c, f, 0, r].map((v) => Number(v.toFixed(9))).join(', ')})`;
  return { forward: (point) => apply(m, point), inverse: (point) => apply(inv, point), css };
}

// 見開きの絵を敷いた要素（見開き・めくる一枚の面）の上で、絵がどこにどの倍率で描かれているか（背景の大きさと位置は % で
// 書かれている）。
function percentPair(value, label) {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 2 || !parts.every((part) => /^-?[\d.]+%$/.test(part))) throw new Error(`library screen: ${label} must be two percentages, got ${JSON.stringify(value)}`);
  return parts.map((part) => Number.parseFloat(part) / 100);
}

function paintedFrame(painter) {
  const style = getComputedStyle(painter);
  const [sizeX, sizeY] = percentPair(style.backgroundSize, 'the spread picture size');
  const [posX, posY] = percentPair(style.backgroundPosition, 'the spread picture position');
  const width = painter.offsetWidth * sizeX;
  const height = painter.offsetHeight * sizeY;
  return {
    left: (painter.offsetWidth - width) * posX,
    top: (painter.offsetHeight - height) * posY,
    scaleX: width / SPREAD_IMAGE.width,
    scaleY: height / SPREAD_IMAGE.height
  };
}

// 字は一字ずつの span（.academy-library-glyph）に入れて組む（墨の一枚へ一字ずつ書き写し、見えない span は紙の上の字の場所へ
// 動かして当たりと選択を持たせるため）。改行はそのまま置く。
function glyphText(text) {
  const fragment = document.createDocumentFragment();
  for (const char of text) {
    if (char === '\n') {
      fragment.append('\n');
      continue;
    }
    const glyph = document.createElement('span');
    glyph.className = 'academy-library-glyph';
    glyph.textContent = char;
    fragment.append(glyph);
  }
  return fragment;
}

// 頁の上の細い線（題の下・脚注の上）。線は頁を紙へ載せるときに墨の一枚へ書く。
function pageRule() {
  const rule = document.createElement('span');
  rule.className = 'academy-library-page-rule';
  rule.setAttribute('aria-hidden', 'true');
  return rule;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// 頁の箱（平らに組む面）と紙の対応。箱を描いた要素（見開きか、めくる一枚の面の紙）が offsetParent で、紙の形はその要素の上の
// 絵から取る。projection は箱の上の点を紙の上の字の台形へ写し、lift は組みの上の一点を、紙の反りで持ち上がった先の点（同じ
// 箱の上・projection を掛ける前）へ写す。頁の字の一枚・当たりの span・待ちの線はどれもこの二つで紙へ載る。箱の位置は絵の
// 位置と同じく作った時に一度だけ読む（lift は一画の点ごとに呼ばれ、DOM を書いた直後でも寸法を読み直さない）。
function paperMap(boxEl, side) {
  const painter = boxEl.offsetParent;
  if (!painter) throw new Error('library screen: a page is laid on paper while it is not displayed');
  const frame = paintedFrame(painter);
  const box = { left: boxEl.offsetLeft, top: boxEl.offsetTop };
  const toLocal = ([x, y]) => [x * frame.scaleX + frame.left - box.left, y * frame.scaleY + frame.top - box.top];
  const toImage = ([x, y]) => [(x + box.left - frame.left) / frame.scaleX, (y + box.top - frame.top) / frame.scaleY];
  const projection = quadProjection(boxEl.offsetWidth, boxEl.offsetHeight, PAGE_TEXT_QUADS[side].map(toLocal));
  const lift = (point) => {
    const [x, y] = toImage(projection.forward(point));
    return projection.inverse(toLocal([x, y - paperLift(side, [x, y])]));
  };
  return { projection, lift };
}

// ── 頁の墨: 組んだ頁を一枚の canvas に書き、紙の反りの網（三角形ごとの affine）で写す ─────────────────────────────
// 字の span は組みと当たり・選択のために残し、見えない（opacity 0）。選んだ字には、その字の箱に淡い焦茶の地を一枚の上へ敷く
// （地も字と同じく反りに沿う）。墨の一枚は頁のインク（.academy-library-page-ink）の中に
// 置かれ、インクと同じ射影（matrix3d）で紙へ載り、インクごと紙と乗算される。墨は焦茶で、ごく薄いにじみと字ごとの濃淡を持つ
// （位置は動かさない）。濃淡は頁に書かれた字の並びから決まるので、同じ頁はめくる一枚の面の上でも同じ墨になる。
const SHEET_SCALE = 2;                  // 一枚の解像度（CSS px あたりの画素・devicePixelRatio に掛ける）
const SHEET_MESH = { columns: 40, rows: 28 };
const SHEET_BLEED_BLUR = 0.37;          // にじみの幅（CSS px）
const SHEET_DENSITY = [0.8, 0.94];      // 字ごとの墨の濃さの幅
// 約物の詰め: Chrome は隣り合う約物の空きを半分に詰め、詰めた字の span は半分の幅になる。開き括弧は左の空きが詰められるので、
// 詰めた分だけ左へ寄せて書く（閉じ括弧・句読点は右の空きなので、そのままの位置）。
const SHEET_OPENERS = new Set([...'「『（〈《【〔']);
const PRESSABLE = '.academy-library-footnote-link, .academy-library-page-retry';

const sheets = new WeakMap();
// 載せた頁のインク（選択が変わったとき、選択に掛かった頁と掛かっていた頁を描き直すため。外れたインクは次の変化で落とす）。
const laidInks = new Set();

function cssPx(value, label) {
  if (!/^-?[\d.]+px$/.test(value)) throw new Error(`library screen: ${label} must be a px length, got ${JSON.stringify(value)}`);
  return Number.parseFloat(value);
}

function colorAlpha(value) {
  const match = /^rgba?\(([^)]+)\)$/.exec(value);
  if (!match) throw new Error(`library screen: the page ink color must be rgb()/rgba(), got ${JSON.stringify(value)}`);
  const parts = match[1].split(/[\s,/]+/).filter(Boolean);
  return parts.length === 4 ? Number.parseFloat(parts[3]) : 1;
}

function screenToken(el, name) {
  const value = getComputedStyle(el).getPropertyValue(name).trim();
  if (!value) throw new Error(`library screen: ${name} is not defined`);
  return value;
}

// el の、ancestor（その offsetParent の鎖の上にある）の中での位置。
function offsetIn(el, ancestor) {
  let x = 0;
  let y = 0;
  for (let node = el; node !== ancestor; node = node.offsetParent) {
    if (!node) throw new Error('library screen: a page letter is not laid inside its ink');
    x += node.offsetLeft;
    y += node.offsetTop;
  }
  return [x, y];
}

// 一枚を書き直す（頁を載せたとき・押せる題の上で指や focus が出入りして下線の色が変わったとき）。
function paintSheet(ink) {
  const state = sheets.get(ink);
  const selection = window.getSelection();
  const selecting = !selection.isCollapsed && selection.containsNode(ink, true);
  state.selected = selecting;
  drawSheet(ink, state.sheet, { letters: state.letters, rules: state.rules, selection: selecting ? selection : null });
}

// 頁の字と罫（letters・rules・頁の全部かその一部）を target の canvas に書いて紙の反りの網で写す。band（平らな頁の y の範囲）を
// 渡すと、その範囲に掛かる網の段だけを写し、canvas もその範囲の大きさになる（訳しで一行ずつ墨を結ぶため）。flat は平らな一枚に
// 使い回す canvas。
function drawSheet(ink, target, { letters, rules, selection = null, band = null, flat = document.createElement('canvas') }) {
  const { map, letters: all } = sheets.get(ink);
  const width = ink.offsetWidth;
  const height = ink.offsetHeight;
  const scale = SHEET_SCALE * window.devicePixelRatio;
  const color = screenToken(ink, '--library-page-ink');
  const bleed = screenToken(ink, '--library-page-ink-bleed');
  const margin = Math.ceil(Math.max(0, ...all.map((letter) => letter.h)));

  // 平らな一枚: 頁の箱の外へ margin ずつ広げた範囲（はみ出した字の頭・下線も入る）。
  flat.width = Math.ceil((width + 2 * margin) * scale);
  flat.height = Math.ceil((height + 2 * margin) * scale);
  const f = flat.getContext('2d');
  if (!f) throw new Error('library screen: no 2d context for the page ink');
  f.setTransform(scale, 0, 0, scale, margin * scale, margin * scale);
  f.textBaseline = 'alphabetic';
  if (selection) {
    f.fillStyle = screenToken(ink, '--library-page-selection');
    for (const { glyph, x, y, w, h } of letters) if (selection.containsNode(glyph, true)) f.fillRect(x, y, w, h);
  }
  for (const { glyph, x, y, w, h, density } of letters) {
    const style = getComputedStyle(glyph);
    f.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const metrics = f.measureText(glyph.textContent);
    const ascent = metrics.fontBoundingBoxAscent;
    const baseline = y + (h * ascent) / (ascent + metrics.fontBoundingBoxDescent);
    const advance = metrics.width + (style.letterSpacing === 'normal' ? 0 : cssPx(style.letterSpacing, 'letter-spacing'));
    const trimmed = SHEET_OPENERS.has(glyph.textContent) && w < advance * 0.75 ? advance - w : 0;
    f.globalAlpha = colorAlpha(style.color) * density;
    f.shadowColor = bleed;
    f.shadowBlur = SHEET_BLEED_BLUR * scale;
    f.fillStyle = color;
    f.fillText(glyph.textContent, x - trimmed, baseline);
    if (style.textDecorationLine.split(' ').includes('underline')) {
      f.globalAlpha = 1;
      f.shadowBlur = 0;
      f.fillStyle = style.textDecorationColor;
      f.fillRect(x, baseline + cssPx(style.textUnderlineOffset, 'text-underline-offset'), w, cssPx(style.textDecorationThickness, 'text-decoration-thickness'));
    }
  }
  f.globalAlpha = 1;
  f.shadowBlur = 0;
  f.lineWidth = 1;
  for (const { left, top, width: ruleWidth, color: ruleColor } of rules) {
    f.strokeStyle = ruleColor;
    f.beginPath();
    f.moveTo(left, top);
    f.lineTo(left + ruleWidth, top);
    f.stroke();
  }

  // 網: 平らな一枚の格子の点を紙の反りで持ち上げた先へ、三角形ごとの affine で写す。
  const { columns, rows } = SHEET_MESH;
  const flatAt = (i, j) => [(i / columns) * (width + 2 * margin) - margin, (j / rows) * (height + 2 * margin) - margin];
  const nodes = Array.from({ length: rows + 1 }, (_r, j) => Array.from({ length: columns + 1 }, (_c, i) => map.lift(flatAt(i, j))));
  let firstRow = 0;
  let lastRow = rows - 1;
  if (band) {
    while (firstRow < rows - 1 && flatAt(0, firstRow + 1)[1] < band[0]) firstRow += 1;
    while (lastRow > firstRow && flatAt(0, lastRow)[1] > band[1]) lastRow -= 1;
  }
  const covered = nodes.slice(firstRow, lastRow + 2).flat();
  const left = Math.floor(Math.min(...covered.map(([x]) => x)));
  const top = Math.floor(Math.min(...covered.map(([, y]) => y)));
  const right = Math.ceil(Math.max(...covered.map(([x]) => x)));
  const bottom = Math.ceil(Math.max(...covered.map(([, y]) => y)));
  Object.assign(target.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
  target.width = Math.ceil((right - left) * scale);
  target.height = Math.ceil((bottom - top) * scale);
  const g = target.getContext('2d');
  if (!g) throw new Error('library screen: no 2d context for the page ink');
  const src = (i, j) => [((i / columns) * (width + 2 * margin)) * scale, ((j / rows) * (height + 2 * margin)) * scale];
  const dst = (i, j) => [(nodes[j][i][0] - left) * scale, (nodes[j][i][1] - top) * scale];
  const triangle = (s, d) => {
    const [[x0, y0], [x1, y1], [x2, y2]] = s;
    const [[u0, v0], [u1, v1], [u2, v2]] = d;
    const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    const a = ((u1 - u0) * (y2 - y0) - (u2 - u0) * (y1 - y0)) / det;
    const b = ((u2 - u0) * (x1 - x0) - (u1 - u0) * (x2 - x0)) / det;
    const c = ((v1 - v0) * (y2 - y0) - (v2 - v0) * (y1 - y0)) / det;
    const e = ((v2 - v0) * (x1 - x0) - (v1 - v0) * (x2 - x0)) / det;
    // 継ぎ目が出ないよう、切り抜きの三角形を重心から少し広げる。
    const cx = (u0 + u1 + u2) / 3;
    const cy = (v0 + v1 + v2) / 3;
    const grow = ([x, y]) => [x + (x - cx) * 0.04 + Math.sign(x - cx) * 0.35, y + (y - cy) * 0.04 + Math.sign(y - cy) * 0.35];
    g.save();
    g.beginPath();
    d.map(grow).forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.clip();
    g.setTransform(a, c, b, e, u0 - a * x0 - b * y0, v0 - c * x0 - e * y0);
    g.drawImage(flat, 0, 0);
    g.restore();
  };
  for (let j = firstRow; j <= lastRow; j += 1) {
    for (let i = 0; i < columns; i += 1) {
      triangle([src(i, j), src(i + 1, j), src(i, j + 1)], [dst(i, j), dst(i + 1, j), dst(i, j + 1)]);
      triangle([src(i + 1, j), src(i + 1, j + 1), src(i, j + 1)], [dst(i + 1, j), dst(i + 1, j + 1), dst(i, j + 1)]);
    }
  }
}

// 押せる題・再試行の上で指や focus が出入りすると下線の色が変わるので、一枚を次の描画で書き直す。
function watchPressable(ink) {
  let queued = false;
  const repaint = (event) => {
    const from = event.target.closest(PRESSABLE);
    const to = event.relatedTarget instanceof Element ? event.relatedTarget.closest(PRESSABLE) : null;
    if ((!from && !to) || from === to) return;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (ink.isConnected && sheets.has(ink)) paintSheet(ink);
    });
  };
  for (const type of ['pointerover', 'pointerout', 'focusin', 'focusout']) ink.addEventListener(type, repaint);
}

// 選択が変わったら、選択に掛かった頁と、前に描いたとき掛かっていた頁の一枚を次の描画で描き直す。
let selectionQueued = false;
function repaintSelection() {
  if (selectionQueued) return;
  selectionQueued = true;
  requestAnimationFrame(() => {
    selectionQueued = false;
    const selection = window.getSelection();
    for (const ink of laidInks) {
      if (!ink.isConnected || !sheets.has(ink)) {
        laidInks.delete(ink);
        continue;
      }
      const selecting = !selection.isCollapsed && selection.containsNode(ink, true);
      if (selecting || sheets.get(ink).selected) paintSheet(ink);
    }
  });
}
document.addEventListener('selectionchange', repaintSelection);

// 頁（.academy-library-page）の字を紙へ載せる。頁の大きさが変わったら（窓の大きさが変わったら）載せ直す。
function layPageOnPaper(pageEl, side) {
  const ink = pageEl.querySelector('.academy-library-page-ink');
  if (!ink) return;
  const map = paperMap(pageEl, side);
  ink.style.transform = map.projection.css;
  // 罫の span には高さ 1 の svg を置く（組みの深さは罫の上の margin と頭の下の margin が潰れずに足された深さ）。線は一枚に書く。
  for (const rule of ink.querySelectorAll('.academy-library-page-rule')) {
    if (rule.firstElementChild) continue;
    const line = document.createElementNS(SVG_NS, 'svg');
    line.setAttribute('width', '100%');
    line.setAttribute('height', '1');
    rule.append(line);
  }
  const glyphs = [...ink.querySelectorAll('.academy-library-glyph')];
  for (const glyph of glyphs) {
    glyph.style.left = '';
    glyph.style.top = '';
  }
  const random = seededRandom(hash32(glyphs.map((glyph) => glyph.textContent).join('')));
  const [low, high] = SHEET_DENSITY;
  const letters = glyphs.map((glyph) => {
    const [x, y] = offsetIn(glyph, ink);
    return { glyph, x, y, w: glyph.offsetWidth, h: glyph.offsetHeight, density: low + (high - low) * random() };
  });
  const rules = [...ink.querySelectorAll('.academy-library-page-rule')].map((rule) => {
    const [left, top] = offsetIn(rule, ink);
    return { left, top, width: rule.offsetWidth, color: getComputedStyle(rule).color };
  });
  // 見えない字の span を、一枚の上でその字が書かれた所（字の中心を持ち上げた先）へ動かす: 押せる題の当たりと字の選択は、見えて
  // いる字の上にある。
  for (const { glyph, x, y, w, h } of letters) {
    const centre = [x + w / 2, y + h / 2];
    const [lx, ly] = map.lift(centre);
    glyph.style.left = `${(lx - centre[0]).toFixed(2)}px`;
    glyph.style.top = `${(ly - centre[1]).toFixed(2)}px`;
  }
  let sheet = ink.querySelector(':scope > .academy-library-page-sheet');
  if (!sheet) {
    sheet = document.createElement('canvas');
    sheet.className = 'academy-library-page-sheet';
    sheet.setAttribute('aria-hidden', 'true');
    ink.prepend(sheet);
    watchPressable(ink);
  }
  sheets.set(ink, { map, letters, rules, sheet, selected: false });
  laidInks.add(ink);
  paintSheet(ink);
}

// 字の基線（字の span の箱の上端 top・高さ h から。墨の一枚の字と同じ決め方）。
function letterBaseline(context, glyph, top, h) {
  const style = getComputedStyle(glyph);
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const metrics = context.measureText(glyph.textContent);
  const ascent = metrics.fontBoundingBoxAscent;
  return top + (h * ascent) / (ascent + metrics.fontBoundingBoxDescent);
}

// ── 訳し: 載せた頁の墨を行に分ける（本文が届いたとき、行の順にこの世界の文字から日本語へ移るため） ─────────────────────────
// 行は字の span の箱の中心の高さで分け、罫は一本ずつの行にする。base は行の基線、size は字の大きさ、from・to は字の左右の端
// （行の頭の空白を除く）。値はどれも頁の箱（平らな組み）の px。
function pageLines(ink) {
  const { letters, rules } = sheets.get(ink);
  const context = document.createElement('canvas').getContext('2d');
  if (!context) throw new Error('library screen: no 2d context for the page lines');
  const rows = [];
  for (const letter of [...letters].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2))) {
    const centre = letter.y + letter.h / 2;
    const row = rows.at(-1);
    if (row && Math.abs(centre - row.centre) <= letter.h * 0.5) row.letters.push(letter);
    else rows.push({ centre, letters: [letter] });
  }
  const lines = rows.map(({ letters: line }) => {
    const first = line[0];
    const inked = line.filter((letter) => letter.glyph.textContent.trim());
    const span = inked.length ? inked : line;
    const kind = first.glyph.closest('.academy-library-page-title') ? 'title' : first.glyph.closest('.academy-library-page-category') ? 'category' : 'body';
    return {
      kind,
      letters: line,
      rules: [],
      base: letterBaseline(context, first.glyph, first.y, first.h),
      size: cssPx(getComputedStyle(first.glyph).fontSize, 'the page letter size'),
      from: Math.min(...span.map((letter) => letter.x)),
      to: Math.max(...span.map((letter) => letter.x + letter.w)),
      top: Math.min(...line.map((letter) => letter.y)),
      bottom: Math.max(...line.map((letter) => letter.y + letter.h))
    };
  });
  for (const rule of rules) lines.push({ kind: 'rule', letters: [], rules: [rule], base: rule.top, from: rule.left, to: rule.left + rule.width, top: rule.top, bottom: rule.top });
  return lines.sort((a, b) => a.base - b.base);
}

// 頁の一行ぶんの墨を、頁の一枚と同じ網で写した一枚（.academy-library-page-line）に書く。頁のインクへ置くのは呼ぶ側（描くのは
// 頁の寸法と字の style を読むので、DOM を書く前にまとめて描く）。
function paintPageLine(ink, line, flat) {
  const canvas = document.createElement('canvas');
  canvas.className = 'academy-library-page-line';
  canvas.setAttribute('aria-hidden', 'true');
  const reach = Math.max(4, ...line.letters.map((letter) => letter.h * 0.5));
  drawSheet(ink, canvas, { letters: line.letters, rules: line.rules, band: [line.top - reach, line.bottom + reach], flat });
  return canvas;
}

// 区切りごとに yield する仕事（generator）を、区切らずに最後まで進めて返り値を返す。
function drain(steps) {
  for (;;) {
    const { done, value } = steps.next();
    if (done) return value;
  }
}

// ── 応答の形: DOM に触れる前に確かめる（壊れた応答で半端な棚や頁を出さない） ─────────────────────────
function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`library: missing ${label}`);
  return value;
}

// 目録 N＋補充 (9−N)＝9、自由 6 の 15 冊。件数は DOM に触れる前に確かめる。
function validateSearch(result) {
  if (!result || typeof result !== 'object') throw new Error('library search: malformed result');
  const { catalog_books: catalog, generated_books: generated, free_books: free } = result;
  if (!Array.isArray(catalog) || !Array.isArray(generated) || !Array.isArray(free)) throw new Error('library search: result is missing a book list');
  if (catalog.length + generated.length !== 9) throw new Error(`library search: 目録+補充 must be 9, got ${catalog.length}+${generated.length}`);
  if (free.length !== 6) throw new Error(`library search: 自由 must be 6, got ${free.length}`);
  const books = catalog.map((book) => {
    const layer = requireString(book.layer, 'catalog book layer');
    if (layer !== 'core' && layer !== 'periphery') throw new Error(`library search: unexpected catalog layer ${JSON.stringify(layer)}`);
    const id = requireString(book.id, 'catalog book id');
    return { key: id, title: requireString(book.title, 'catalog book title'), cover: layer, target: { book_id: id } };
  });
  for (const book of [...generated, ...free]) {
    const title = requireString(book.title, 'generated book title');
    books.push({ key: `generated:${title}`, title, cover: 'generated', target: { generated_title: title } });
  }
  // 一つの棚に同じ題の本を二冊並べない。
  const titles = new Set();
  for (const book of books) {
    if (titles.has(book.title)) throw new Error(`library search: the shelf carries 「${book.title}」 twice`);
    titles.add(book.title);
  }
  return books;
}

// 同題解決（生成の題が目録の題と一致した本）は目録の本として返るので、layer は手に取った棚の本の姿と違ってよい。
function validateRead(response) {
  if (!response || typeof response !== 'object') throw new Error('library read: malformed response');
  const layer = requireString(response.layer, 'read layer');
  if (layer !== 'core' && layer !== 'periphery' && layer !== 'generated') throw new Error(`library read: unexpected layer ${JSON.stringify(layer)}`);
  return {
    title: requireString(response.title, 'read title'),
    category: requireString(response.category, 'read category'),
    layer,
    text: requireString(response.text, 'read text'),
    entryId: requireString(response.collection_entry_id, 'read collection_entry_id')
  };
}

// deps（どれも必須）:
// - loadArrival(): 到着の GET を済ませる（退出先を app.js が持つ）。
// - search(theme) / read(target) / footnotes(entryId): 大書庫 API の要求（payload を返し、失敗は reject）。
// - redirectRuntimeError(error): LM の設定・接続の失敗なら設定画面へ誘導して true。
// - leave(): ロードの被覆を経てハブへ戻る。
export function createLibraryScreen(deps) {
  for (const name of ['loadArrival', 'search', 'read', 'footnotes', 'redirectRuntimeError', 'leave', 'waitMark']) {
    if (typeof deps?.[name] !== 'function') throw new Error(`library screen: missing dependency ${name}`);
  }
  const root = document.querySelector('#academy-library-screen');
  if (!root) throw new Error('library screen: missing #academy-library-screen (broken markup)');
  const $ = (selector) => {
    const node = root.querySelector(selector);
    if (!node) throw new Error(`library screen: missing ${selector} (broken markup)`);
    return node;
  };

  const els = {
    art: $('.academy-library-art'),
    lamps: $('.academy-library-lamps'),
    dust: $('.academy-library-dust'),
    shelf: $('.academy-library-shelf'),
    slip: $('.academy-library-slip'),
    slipInput: $('.academy-library-slip-input'),
    slipHand: $('.academy-library-slip-hand'),
    slipNote: $('.academy-library-slip-note'),
    slipShade: $('.academy-library-slip-shade'),
    deskLight: $('.academy-library-desk-light'),
    exit: $('.academy-library-exit'),
    reading: $('.academy-library-reading'),
    book: $('.academy-library-book'),
    spread: $('.academy-library-spread'),
    pageLeft: $('.academy-library-page-left'),
    pageRight: $('.academy-library-page-right'),
    sketchLeft: $('.academy-library-sketch-left'),
    sketchRight: $('.academy-library-sketch-right'),
    brush: $('.academy-library-brush'),
    brushShadow: $('.academy-library-brush-shadow'),
    brushBody: $('.academy-library-brush-body'),
    coverLeaf: $('.academy-library-cover-leaf'),
    coverFace: $('.academy-library-cover-face'),
    exLibris: $('.academy-library-ex-libris'),
    close: $('.academy-library-close'),
    measure: $('.academy-library-measure')
  };

  const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const reduced = () => reducedQuery.matches;
  const syncMotion = () => { root.dataset.motion = reduced() ? 'reduced' : 'full'; };
  syncMotion();
  const isActive = () => root.classList.contains('active');
  let coverFaces = null;

  // 一度の訪れ（enter から次の enter / suspend まで）。流れは始めた訪れの番号を持ち、訪れが替わっていたら止まる。
  let visit = 0;
  const stay = (v) => async (promise) => {
    const value = await promise;
    if (v !== visit) throw new LeftScene();
    return value;
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // 1本の動きを走らせ、終わったら最後の姿を inline に置いて animation を外す（fill の残りを持ち越さない）。
  // 訪れが替わって動きが取り消されたときは LeftScene で止まる。
  async function run(el, keyframes, { duration, delay = 0, easing = EASE }) {
    const v = visit;
    const animation = el.animate(keyframes, { duration, delay, easing, fill: 'both' });
    try {
      await animation.finished;
    } catch (error) {
      if (error?.name === 'AbortError') throw new LeftScene();
      throw error;
    }
    if (v !== visit) throw new LeftScene();
    const last = keyframes[keyframes.length - 1];
    for (const [key, value] of Object.entries(last)) {
      if (key !== 'offset' && key !== 'easing') el.style[key] = value;
    }
    animation.cancel();
  }

  // 走り残った script の動きを取り消し、inline に置いた姿を外す（CSS の animation・transition には触れない）。
  const INLINE_KEYS = ['transform', 'opacity', 'filter', 'boxShadow', 'width', 'transformOrigin'];
  function cancelMotion() {
    for (const animation of root.getAnimations({ subtree: true })) {
      if (typeof CSSAnimation === 'function' && animation instanceof CSSAnimation) continue;
      if (typeof CSSTransition === 'function' && animation instanceof CSSTransition) continue;
      animation.cancel();
    }
    for (const el of [els.lamps, els.dust, els.slipShade, els.deskLight, els.book, els.spread, els.coverLeaf, els.exLibris, els.pageLeft, els.pageRight, els.brush]) {
      for (const key of INLINE_KEYS) el.style[key] = '';
    }
  }

  // 画面を離れた流れは黙って止まる。それ以外の失敗は console へ（画面には場所の一文だけを出す）。
  function quietly(error) {
    if (error instanceof LeftScene) return;
    console.error(error);
  }

  // LM の設定・接続の失敗は設定画面へ誘導する（検索・本文とも）。誘導したら true。
  function redirected(error) {
    if (error instanceof LeftScene) return false;
    return deps.redirectRuntimeError(error) === true;
  }

  // ── 灯り ─────────────────────────────────────────────────────────────────────────────────────
  function buildLamps() {
    els.lamps.replaceChildren();
    for (const [index, lamp] of LAMPS.entries()) {
      const node = document.createElement('span');
      node.className = 'academy-library-lamp';
      node.style.left = `${lamp.x}%`;
      node.style.top = `${lamp.y}%`;
      node.style.setProperty('--lamp-size', `${lamp.size}%`);
      node.style.setProperty('--breath', `${(4 + ((index * 7) % 5) * 0.5).toFixed(1)}s`);
      node.style.setProperty('--breath-delay', `${(-index * 0.83).toFixed(2)}s`);
      els.lamps.append(node);
      if (lamp.depth === undefined) continue;
      node.dataset.depth = String(lamp.depth);
      const glow = document.createElement('span');
      glow.className = 'academy-library-lamp-glow';
      glow.dataset.depth = String(lamp.depth);
      glow.style.left = `${lamp.x}%`;
      glow.style.top = `${lamp.y}%`;
      glow.style.setProperty('--lamp-size', `${lamp.size}%`);
      els.lamps.append(glow);
    }
  }

  // 待ちの間だけ、depth のある灯りの暈に明るみの送りを走らせる（応答まで途切れない）。動きを減らす設定では走らせない
  // （そのときの待ちの灯りは CSS の三か所の順の灯り）。場面か動きの設定が変わるたびに sync で合わせ直す。
  // 現れと引きは filter の opacity で掛け、送りの opacity とは別の値にする。
  const seek = (() => {
    let sweeps = [];
    function sync() {
      const glows = [...els.lamps.querySelectorAll('.academy-library-lamp-glow')];
      const waiting = root.dataset.scene === 'waiting' && !reduced();
      const sweeping = sweeps.some((sweep) => sweep.playState === 'running');
      if (waiting === sweeping) return;
      if (waiting) {
        sweeps = glows.map((glow) => glow.animate(seekKeyframes(Number(glow.dataset.depth)), { duration: SEEK_CYCLE_MS, iterations: Infinity }));
        for (const glow of glows) glow.animate([{ filter: 'opacity(0)' }, { filter: 'opacity(1)' }], { duration: SEEK_FADE_MS, easing: EASE });
        return;
      }
      for (const [index, sweep] of sweeps.entries()) {
        sweep.pause();
        const fade = glows[index].animate([{ filter: 'opacity(1)' }, { filter: 'opacity(0)' }], { duration: SEEK_FADE_MS, easing: EASE, fill: 'forwards' });
        fade.finished.then(() => { sweep.cancel(); fade.cancel(); }, () => {});
      }
      sweeps = [];
    }
    return { sync };
  })();

  // 消失点（通路の奥）の画面座標。
  function vanishingPoint() {
    const box = els.art.getBoundingClientRect();
    return { x: box.left + box.width * 0.232, y: box.top + box.height * 0.5 };
  }

  // ── 塵: 窓からの光の筋と灯りのまわりを、奥ほど小さく遅く漂う ───────────────────────────────────
  const dust = (() => {
    const canvas = els.dust;
    const context = canvas.getContext('2d');
    const random = seededRandom(20260928);
    let particles = [];
    let frame = 0;
    let handle = null;
    let last = 0;
    let fade = 1;
    let fadeTarget = 1;

    function spawn(forceInBeam) {
      const art = els.art.getBoundingClientRect();
      const z = random();
      const inBeam = forceInBeam ?? random() < 0.6;
      // 光の筋（絵の窓 x≈23〜33%・y≈12% から床の窓影 x≈20〜30%・y≈68% へ）の中か、画面全体に薄く。
      const t = random();
      const beamX = art.left + art.width * (0.23 + 0.1 * random() - 0.02 * t);
      const beamY = art.top + art.height * (0.12 + 0.56 * t);
      return {
        x: inBeam ? beamX : random() * window.innerWidth,
        y: inBeam ? beamY : random() * window.innerHeight,
        z,
        vx: (random() - 0.4) * (4 + z * 10),
        vy: (random() - 0.55) * (3 + z * 8),
        phase: random() * Math.PI * 2,
        beam: inBeam
      };
    }

    function resize() {
      const ratio = window.devicePixelRatio;
      canvas.width = Math.round(window.innerWidth * ratio);
      canvas.height = Math.round(window.innerHeight * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      particles = Array.from({ length: 150 }, () => spawn());
    }

    function draw(time) {
      context.clearRect(0, 0, window.innerWidth, window.innerHeight);
      for (const p of particles) {
        const twinkle = 0.55 + 0.45 * Math.sin(time / 1000 * (0.6 + p.z) + p.phase);
        const alpha = (p.beam ? 0.5 : 0.22) * (0.35 + p.z * 0.65) * twinkle * fade;
        const radius = 0.5 + p.z * 1.9;
        context.beginPath();
        context.fillStyle = `rgba(255, 226, 170, ${alpha.toFixed(3)})`;
        context.arc(p.x, p.y, radius, 0, Math.PI * 2);
        context.fill();
      }
    }

    function step(time) {
      const dt = last ? Math.min(0.05, (time - last) / 1000) : 0;
      last = time;
      fade += (fadeTarget - fade) * Math.min(1, dt * 3);
      for (const [index, p] of particles.entries()) {
        p.x += p.vx * dt;
        p.y += p.vy * dt + Math.sin(time / 1700 + p.phase) * 0.06;
        if (p.x < -10 || p.x > window.innerWidth + 10 || p.y < -10 || p.y > window.innerHeight + 10) particles[index] = spawn(p.beam);
      }
      draw(time);
      frame += 1;
      canvas.dataset.frame = String(frame);
      handle = requestAnimationFrame(step);
    }

    function stop() {
      if (handle !== null) cancelAnimationFrame(handle);
      handle = null;
      last = 0;
      canvas.dataset.running = 'false';
    }

    function restart() {
      stop();
      if (reduced()) {
        // 動きを減らす設定では塵は止まる（1枚だけ描いて置く）。
        draw(0);
        canvas.dataset.frame = String(frame);
        return;
      }
      canvas.dataset.running = 'true';
      handle = requestAnimationFrame(step);
    }

    return {
      start() { fade = 1; fadeTarget = 1; resize(); restart(); },
      resize() { resize(); if (reduced()) draw(0); },
      restart,
      stop,
      fadeOut() { fadeTarget = 0; if (reduced()) { fade = 0; draw(0); } }
    };
  })();

  reducedQuery.addEventListener('change', () => {
    syncMotion();
    if (isActive()) {
      dust.restart();
      seek.sync();
    }
  });

  // ── 請求票と机の灯り: 票は机の上に置いたまま動かない。渡すと、票を照らしていた机の灯りが票を離れて通路の奥へ移り、
  // 票は暗がりに沈む。本が並ぶと灯りが戻り、票は白紙になっている（字を消すのは票の中身の入れ替え）。
  function slipCentre() {
    const slip = els.slip;
    return { x: slip.offsetLeft + slip.offsetWidth / 2, y: slip.offsetTop + slip.offsetHeight / 2 };
  }

  function placeDeskLight() {
    const centre = slipCentre();
    els.deskLight.style.left = `${centre.x}px`;
    els.deskLight.style.top = `${centre.y}px`;
  }

  // 票の上のインクの一文（失敗のときだけ）。
  function setSlipNote(text) {
    els.slipNote.hidden = !text;
    els.slipNote.textContent = text ?? '';
  }

  async function slipLeaves() {
    const centre = slipCentre();
    const vp = vanishingPoint();
    els.slip.inert = true;
    if (reduced()) {
      await Promise.all([
        run(els.slipShade, [{ opacity: '0' }, { opacity: '1' }], { duration: REDUCED_FADE_MS }),
        run(els.deskLight, [{ opacity: '1' }, { opacity: '0' }], { duration: REDUCED_FADE_MS })
      ]);
      return;
    }
    await Promise.all([
      run(els.slipShade, [{ opacity: '0' }, { opacity: '0.35', offset: 0.3 }, { opacity: '1' }], { duration: 1400 }),
      run(els.deskLight, [
        { transform: 'translate(0, 0) scale(1)', opacity: '1' },
        { transform: `translate(${(vp.x - centre.x) * 0.55}px, ${(vp.y - centre.y) * 0.5}px) scale(0.45)`, opacity: '0.85', offset: 0.5 },
        { transform: `translate(${vp.x - centre.x}px, ${vp.y - centre.y}px) scale(0.08)`, opacity: '0' }
      ], { duration: 1800, easing: 'cubic-bezier(0.4, 0.1, 0.5, 1)' })
    ]);
  }

  // blank: 本が並んだときは、灯りが戻る前に票の字を消しておく。問いが届かなかったときは書いた票のまま灯りが戻る。
  async function slipReturns({ blank }) {
    const centre = slipCentre();
    const vp = vanishingPoint();
    if (blank) els.slipInput.value = '';
    if (reduced()) {
      await Promise.all([
        run(els.slipShade, [{ opacity: '1' }, { opacity: '0' }], { duration: REDUCED_FADE_MS }),
        run(els.deskLight, [{ opacity: '0' }, { opacity: '1' }], { duration: REDUCED_FADE_MS })
      ]);
    } else {
      await Promise.all([
        run(els.slipShade, [{ opacity: '1' }, { opacity: '0' }], { duration: 1200, delay: 300 }),
        run(els.deskLight, [
          { transform: `translate(${vp.x - centre.x}px, ${vp.y - centre.y}px) scale(0.08)`, opacity: '0' },
          { transform: 'translate(0, 0) scale(1)', opacity: '1' }
        ], { duration: 1500 })
      ]);
    }
    els.slip.inert = false;
  }

  // ── 棚 ────────────────────────────────────────────────────────────────────────────────────────
  // lays は本ごとの背の面を今の絵の大きさで組み直す手続き（射影は px で書くので、窓の大きさが変わると組み直す）。
  const shelfState = { books: [], nodes: [], lays: [] };

  // 題を一列に書いた長さ（字の大きさ 1em あたり）を画面の字そのもので測る。
  function measureTitles(books) {
    const measure = document.createElement('span');
    measure.className = 'academy-library-book-title-text academy-library-book-title-measure';
    els.shelf.append(measure);
    const em = (fill) => {
      fill();
      return measure.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(measure).fontSize);
    };
    try {
      return books.map((book) => {
        const { main, sub } = splitTitle(book.title);
        const halves = sub === null ? titleHalves(main) : null;
        return {
          line: em(() => fillSpineTitle(measure, book.title)),
          main: em(() => measure.replaceChildren(document.createTextNode(main))),
          sub: sub === null ? null : em(() => measure.replaceChildren(document.createTextNode(sub))),
          halves: halves && { texts: halves, ems: halves.map((half) => em(() => measure.replaceChildren(document.createTextNode(half)))) }
        };
      });
    } finally {
      measure.remove();
    }
  }

  // 本はその題箋が下限の字で収まる背にだけ置く（置き方は assignSlots）。下限の字でもどの背にも収まらない本があるとき、どう
  // 置いても背に入りきらないときは throw（棚を出さない）。
  function layoutShelf(books) {
    const lengths = measureTitles(books);
    const labels = lengths.map((length) => SHELF_SLOTS.map((slot) => labelAt(slot, length)));
    const fits = labels.map((row) => row.map((label, slot) => labelScale(SHELF_SLOTS[slot], label) >= TITLE_MIN_SCALE));
    books.forEach((book, index) => {
      if (!fits[index].includes(true)) throw new Error(`library screen: no painted spine holds 「${book.title}」 at the smallest title scale`);
    });
    const slotOf = assignSlots(fits);
    if (!slotOf) throw new Error(`library screen: the painted spines have no room for all ${books.length} books`);
    return slotOf.map((slot, index) => {
      const label = labels[index][slot];
      return { slot: SHELF_SLOTS[slot], label, scale: labelScale(SHELF_SLOTS[slot], label) };
    });
  }

  // 背の面（平らに組んだ背の地・色・題箋）を背の四辺形へ写す。単位は絵の px を今の絵の大きさの px に直したもの。背の地は絵の
  // source の四辺形を背の面へ写したもの（上と下の段では背そのものの所）。
  function layFace({ face, paint, label, text }, { slot, label: size, scale }, box) {
    const unit = els.art.getBoundingClientRect().width / ART_UNIT;
    const px = (value) => `${(value * unit).toFixed(3)}px`;
    const { width, height } = slot.face;
    face.style.width = px(width);
    face.style.height = px(height);
    face.style.transform = quadProjection(width * unit, height * unit, slot.quad.map(([x, y]) => [(x - box.left) * unit, (y - box.top) * unit])).css;
    const source = boundsOf(slot.source);
    const toSource = quadProjection(width * unit, height * unit, slot.source.map(([x, y]) => [(x - source.left) * unit, (y - source.top) * unit]));
    paint.style.width = px(source.width);
    paint.style.height = px(source.height);
    paint.style.backgroundSize = px(ART_UNIT);
    paint.style.backgroundPosition = `${px(-source.left)} ${px(-source.top)}`;
    paint.style.transform = quadProjection(source.width * unit, source.height * unit,
      [[0, 0], [source.width, 0], [source.width, source.height], [0, source.height]].map(([x, y]) => toSource.inverse([x * unit, y * unit]))).css;
    const labelWidth = Math.min(size.width, size.sub === null && size.halves === null ? size.char * scale * LABEL.widthEm : size.width);
    const labelHeight = size.height * scale;
    const labelTop = slot.label.top ?? Math.min(slot.room[1] - labelHeight, Math.max(slot.room[0], slot.label.centre - labelHeight / 2));
    label.style.left = px((width - labelWidth) / 2);
    label.style.top = px(labelTop);
    label.style.width = px(labelWidth);
    label.style.height = px(labelHeight);
    label.style.fontSize = px(size.char * scale);
    if (size.sub !== null) text.style.setProperty('--subtitle-scale', String(size.sub / size.char));
  }

  function buildBookNode(book, index, look, place) {
    const { slot } = place;
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'academy-library-book-item';
    node.dataset.cover = book.cover;
    node.dataset.index = String(index);
    node.setAttribute('aria-label', book.title);
    applyLookVars(node, look);
    // 箱は背の四辺形を囲む長方形。中の位置はどれも箱に対する %。
    const box = boundsOf(slot.quad);
    const [, tr, br] = slot.quad;
    const heightR = br[1] - tr[1];
    const bx = (x) => pct(((x - box.left) / box.width) * 100);
    const by = (y) => pct(((y - box.top) / box.height) * 100);
    node.style.left = artPct(box.left);
    node.style.top = artPct(box.top);
    node.style.width = artPct(box.width);
    node.style.height = artPct(box.height);
    node.style.setProperty('--order', String(slot.order));
    node.style.setProperty('--drawn-transform', pulledOut(1).transform);
    node.style.setProperty('--rest-transform', pulledBack());
    node.style.setProperty('--pull-dx', `calc(var(--library-art-size) * ${((heightR * PULL_REACH) / ART_UNIT).toFixed(5)})`);
    node.style.setProperty('--pull-x', String(slot.pull[0]));
    node.style.setProperty('--pull-y', slot.pull[1].toFixed(5));

    // 背: 背の面（地・色・題箋）を平らに組み、layFace が背の四辺形へ写す。
    const spine = document.createElement('span');
    spine.className = 'academy-library-book-spine';
    const face = document.createElement('span');
    face.className = 'academy-library-book-face';
    const paint = document.createElement('span');
    paint.className = 'academy-library-book-paint';
    const tint = document.createElement('span');
    tint.className = 'academy-library-book-tint';
    const label = document.createElement('span');
    label.className = 'academy-library-book-label';
    const text = document.createElement('span');
    text.className = 'academy-library-book-title-text';
    if (place.label.sub === null && place.label.halves === null) {
      fillSpineTitle(text, book.title);
    } else {
      const { main, sub } = splitTitle(book.title);
      const columns = (sub === null ? place.label.halves : [main, sub]).map((part, column) => {
        const el = document.createElement('span');
        el.className = column === 1 && sub !== null ? 'academy-library-book-title-column academy-library-book-subtitle-column' : 'academy-library-book-title-column';
        el.textContent = part;
        return el;
      });
      text.classList.add('academy-library-book-title-columns');
      text.replaceChildren(...columns);
    }
    label.append(text);
    face.append(paint, tint, label);
    spine.append(face);
    const lay = () => layFace({ face, paint, label, text }, place, box);

    // 表紙の面: 背の右の縁から、右隣の本の陰だった所へ。見える幅は引き出した分（--pull-dx）だけ。
    const reveal = document.createElement('span');
    reveal.className = 'academy-library-book-reveal';
    reveal.style.left = bx(br[0]);
    reveal.style.top = by(tr[1]);
    reveal.style.height = pct((heightR / box.height) * 100);
    const cover = document.createElement('span');
    cover.className = 'academy-library-book-cover';
    cover.style.setProperty('--cover-aspect', COVER_ASPECT.toFixed(4));
    const coverFace = document.createElement('span');
    coverFace.className = 'academy-library-cover-face';
    coverFace.append(...coverFaceLayers(book.title, look.frame));
    cover.append(coverFace);
    reveal.append(cover);
    node.append(spine, reveal);
    node.addEventListener('pointerenter', () => drawOut(node));
    node.addEventListener('pointerleave', () => pushBack(node));
    node.addEventListener('focus', () => drawOut(node));
    node.addEventListener('blur', () => pushBack(node));
    node.addEventListener('click', () => { openFromShelf(node, book).catch(quietly); });
    return { node, lay };
  }

  function layShelf() {
    for (const lay of shelfState.lays) lay();
  }

  function renderShelf(books) {
    const looks = books.map((book) => bookLook(book.key, book.cover));
    const places = layoutShelf(books);
    const built = books.map((book, index) => buildBookNode(book, index, looks[index], places[index]));
    const shades = [
      buildShadeNode(MIDDLE_MOUTH, { duration: 1400, delay: 200 }),
      ...places.flatMap(({ slot }, index) => (slot.bay === 'middle' ? [] : [buildShadeNode(slotShade(slot), { duration: SHELVE_MS * SHELVE_SHOWN, delay: index * SHELVE_STAGGER_MS })]))
    ];
    els.shelf.replaceChildren(...shades, ...built.map(({ node }) => node));
    shelfState.books = books;
    shelfState.nodes = built.map(({ node }) => node);
    shelfState.lays = built.map(({ lay }) => lay);
    layShelf();
  }

  // 通路の側から一冊ずつ、引き出したときと逆の向きで棚へ押し込まれる（1冊 0.9 秒・0.12 秒ずつずらし・弾まずに止まる）。
  // 入りきるまで表紙の面が見えていて、右隣の本の陰へ隠れていく。
  async function slideBooksIn() {
    if (reduced()) {
      await Promise.all(shelfState.nodes.map((node) => run(node, [{ opacity: '0' }, { opacity: '1' }], { duration: REDUCED_FADE_MS })));
      return;
    }
    const from = pulledOut(SHELVE_REACH);
    await Promise.all(shelfState.nodes.flatMap((node, index) => {
      const timing = { duration: SHELVE_MS, delay: index * SHELVE_STAGGER_MS };
      return [
        run(node, [
          { transform: from.transform, opacity: '0', filter: 'brightness(0.35)' },
          { opacity: '1', offset: SHELVE_SHOWN },
          { transform: 'none', opacity: '1', filter: 'none' }
        ], timing),
        run(node.querySelector('.academy-library-book-reveal'), [{ width: from.width }, { width: '0px' }], timing)
      ];
    }));
    for (const node of shelfState.nodes) {
      node.style.transform = '';
      node.style.filter = '';
      node.querySelector('.academy-library-book-reveal').style.width = '';
    }
  }

  // 検索を渡した時点で棚を空ける（失敗しても前の本は戻らない）。
  async function clearShelf() {
    const nodes = shelfState.nodes;
    shelfState.nodes = [];
    shelfState.books = [];
    shelfState.lays = [];
    els.shelf.dataset.leaving = 'true';
    try {
      if (nodes.length && !reduced()) {
        const to = pulledOut(SHELVE_REACH);
        await Promise.all(nodes.flatMap((node) => [
          run(node, [{ transform: 'none', opacity: '1' }, { transform: to.transform, opacity: '0' }], { duration: 600 }),
          run(node.querySelector('.academy-library-book-reveal'), [{ width: '0px' }, { width: to.width }], { duration: 600 })
        ]));
      }
      els.shelf.replaceChildren();
    } finally {
      delete els.shelf.dataset.leaving;
    }
  }

  // ── 指を乗せる: 本が通路の側（左）へ板に沿って引き出されながら少し手前へ寄り、右隣の本の陰から表紙の面と金の題が見えてくる。
  // 指を離すと同じ向きの逆で収まる（形と速さは CSS の [data-drawn]）。 ─────────────────────────────────────────
  function drawOut(node) {
    if (root.dataset.scene !== 'shelf') return;
    for (const other of shelfState.nodes) if (other !== node && other.dataset.taken !== 'true') delete other.dataset.drawn;
    node.dataset.drawn = 'true';
  }

  function pushBack(node) {
    if (node.dataset.taken === 'true') return;
    delete node.dataset.drawn;
  }

  // ── 問いを渡す → 待つ → 本が並ぶ ─────────────────────────────────────────────────────────────────
  // 空の票は渡らない（票は動かず、机の灯りも移らない）。待ちの間にもう一度渡す操作は受け付けない。
  let searchInFlight = false;

  async function handOver() {
    if (searchInFlight || root.dataset.arrived !== 'true' || !['arrival', 'shelf'].includes(root.dataset.scene)) return;
    const theme = els.slipInput.value.trim();
    if (!theme) {
      els.slipInput.focus();
      return;
    }
    const v = visit;
    const keep = stay(v);
    searchInFlight = true;
    setSlipNote('');
    els.slipInput.disabled = true;
    els.slipHand.disabled = true;
    root.dataset.scene = 'handing';
    const request = deps.search(theme).then(validateSearch);
    request.catch(() => {});
    try {
      await keep(Promise.all([slipLeaves(), clearShelf()]));
      root.dataset.scene = 'waiting';
      seek.sync();
      const books = await keep(request);
      renderShelf(books);
      for (const node of shelfState.nodes) node.style.opacity = '0';
      root.dataset.scene = 'returning';
      seek.sync();
      await keep(slideBooksIn());
      for (const node of shelfState.nodes) node.style.opacity = '';
      await keep(slipReturns({ blank: true }));
      root.dataset.scene = 'shelf';
    } catch (error) {
      if (error instanceof LeftScene || v !== visit) throw new LeftScene();
      if (redirected(error)) return;
      console.error(error);
      // 通路の灯りが戻って消え、票の字が机に戻る。棚は空のまま、票の上に一文。票を渡し直せば再試行になる。
      root.dataset.scene = 'returning';
      seek.sync();
      await keep(slipReturns({ blank: false }));
      setSlipNote(SEARCH_FAILED_LINE);
      root.dataset.scene = shelfState.nodes.length ? 'shelf' : 'arrival';
    } finally {
      if (v === visit) {
        els.slipInput.disabled = false;
        els.slipHand.disabled = false;
        searchInFlight = false;
      }
    }
  }

  // ── 手の中の本 ────────────────────────────────────────────────────────────────────────────────
  // body は本文を頁に割ったもの、pages は見開きに並べる頁（body の後ろに脚注・頁の一文の置き場を足し、頁の対に揃えたもの）、
  // tail は脚注・頁の一文を書く頁の index（書くものが無ければ null）。
  const reading = {
    book: null,
    result: null,
    body: [],
    pages: [],
    tail: null,
    spread: 0,
    footnotes: { state: 'idle', references: [] },
    pageNote: null,
    generation: 0,
    busy: false
  };

  function spreadCount() {
    return reading.pages.length / 2;
  }

  // ── 筆: 本文を待つ白い見開きに、手の無い小筆がひとりでにこの世界の文字を書き順どおりに一画ずつ書く ──────────────────────
  // 書く行は頁と同じ組みの行（最初の頁の題・層の名前・罫・本文）。待っている間は段落を知らないので、本文の行は行末まで満たす。
  // 字は頁の字と同じ射影と紙の反り（paperMap の projection と lift）で紙へ載り、墨は頁の字と同じ焦茶で紙と乗算する。左の頁の天
  // から右の頁の地まで書き終えたら、筆はその先で漂い、書いた字が紙へ沈み、新しい字で天から書き直す。
  // 筆の運びは書き手の緩急を持つ: 画の頭で穂を置き（入り）、送りで速め、画の終わりは止め（速さを落として沈む）か払い（速めたまま
  // 浮いて抜ける）。紙から離れている間は重さが無く、画と画の間は宙を弧を描いて滑り、行の終わりでは運んできた向きへふわりと漂って
  // から次の行の頭へ舞い戻る。筆の傾きは運ぶ向きへゆるやかに移ろう。
  // 本文が届くと（書き終わりの流れ・一呼吸）: 筆はすぐ紙から浮いて左の頁の天の上へ振りかぶり、その間に頁を割り付けて紙に載せ、
  // 訳しを支度する（支度はフレームごとに区切り、筆は動き続ける）。支度が済むと筆が見開きの上を一度大きく払うように滑り、その跡に
  // 沿ってまだ書いていない行のこの世界の文字が浮かぶ。筆が抜けるのと同時に、琥珀の光が同じ跡を追って行ごとに字をほどき、同じ行に
  // 日本語の墨（頁の一枚の一行）が結ぶ。まだ書いていなかった行は届いた頁の行に組んで浮かばせ、書いた行は訳しの光の中で頁の行へ移る。
  // 動きを減らす設定では筆を出さず、見開きの全部の行の字が淡く現れて濃くなり、届くと字がほどけて頁のインクが浮かぶ。
  const X_HEIGHT = 0.62;                // この世界の文字の体の高さ（行の字の大きさに対する割合）
  const INK_WIDTH = 0.14;               // 画の太さ（体の高さに対する割合）
  const INK_DENSITY = [0.8, 0.94];      // 字ごとの墨の濃さの幅（頁の字と同じ）
  // 筆の運び（本文の字の大きさ / 秒）と、画と画・語と語・行と行の間の移り（ms。移る道のりには本文の字の大きさあたり perEm を
  // 足す）。lead は書き始める前に筆が紙へ降りる間。行と行の間は、行の終わりで漂う間（その LINE_DRIFT の割合）と、次の行の頭へ
  // 舞い戻る間。
  const WRITE_SPEED = { title: 27.8, category: 27.8, body: 50, rule: 77.8 };
  const MOVE = { stroke: 40, word: 60, line: 520, perEm: 20, lead: 260 };
  const LINE_DRIFT = 0.4;
  const LINE_RESTS_MS = 900;            // 見開きを書き終えてから字が沈み始めるまで（筆は漂って待つ）
  const SINK_MS = 1400;                 // 書いた字が紙へ沈む長さ（筆はその間に左の頁の天へ戻る）
  const RELEASE_MS = 700;               // 本文が届かなかった: 字がほどける長さ
  // 本文が届いてから（ms）: 振りかぶり（windup 以上・頁の支度が済むまで。済まなければ天の上で漂い続ける）→ 払い（sweep。まだ
  // 書いていない行は筆が通る時刻から rise で浮かぶ）→ 筆が抜ける（exit）のと同時に、琥珀の光が同じ跡を追う（訳しの始まりを跡の
  // 順に glow の間へ配り、一行は perLine）。行の数に依らず、支度が済んでから頁が読めるまでは sweep + glow + perLine で決まる。
  const ARRIVAL = { windup: 300, sweep: 440, rise: 280, exit: 300, glow: 320, perLine: 300 };
  const PREPARE_BUDGET_MS = 8;          // 振りかぶりの間に、頁の支度へ一フレームで使う長さ
  // 払いの跡（頁の箱の幅・高さに対する割合）: 左の頁の天の頭から、左の頁の中ほど・右の頁の中ほどを通って右の頁の地の端へ。
  const TRAIL = [['left', 0.04, 0.05], ['left', 0.62, 0.5], ['right', 0.38, 0.55], ['right', 0.97, 0.97]];
  const GLOW = { widen: 2.2, blur: 0.55, peak: 0.55 };   // 訳しの光（画の太さの倍・ぼかし CSS px・いちばん明るい所の不透明）
  // 筆の置き方（cm と度。筆の姿と寸法は libraryBrush.js）。頁の紙の幅（1440×900 で本の幅 1131.5px のうち 460px）を頁 24cm と
  // みて、見下ろし view で写す。画と画の間は高々 travelLift まで持ち上がり、払いの画は endLift だけ浮いて抜ける。行の終わりは
  // 運んできた向きへ drift 漂って floatLift まで浮く。退くときは右手前へ leave・高さ lift まで上がって消える。書き終わりの流れでは
  // 払いの跡の頭から windup（右・下が正）の所へ sweepLift まで振りかぶり、glide の高さで見開きの上を払い、跡の先へ抜けながら lift
  // まで浮いて消える。傾きは運ぶ向きへ lean（紙の上の軸の水平成分）だけ寄り、leanMs で追いつく。tilt・azimuth は持ち上げ lift
  // までの筆と影が筆の canvas の範囲（LIBRARY_BRUSH_BOX）に収まる幅に留める。
  const BRUSH = {
    pageCm: 24, pageOfBook: 460 / 1131.53, view: 72, travelLift: 1.6, endLift: 0.35, drift: 0.8, floatLift: 1.3, leave: [2.09, 1.56], lift: 4,
    windup: [-1.4, -1.0], sweepLift: 2.2, glide: 0.3, lean: 0.12, leanMs: 220, tilt: [35, 45], azimuth: [20, 40]
  };
  const ramp = (x, from, to) => Math.min(1, Math.max(0, (x - from) / (to - from)));
  const easeInOut = (x) => 0.5 - Math.cos(Math.PI * Math.min(1, Math.max(0, x))) / 2;
  const easeOut = (x) => 1 - (1 - Math.min(1, Math.max(0, x))) ** 2;
  // 払いの進み: 静かに滑り出して速まり、速さを残したまま跡の先へ抜ける。
  const sweepEase = (x) => 0.5 * easeInOut(x) + 0.5 * (1 - Math.cos((Math.PI / 2) * Math.min(1, Math.max(0, x))));
  const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  const heading = (a, b) => {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
  };

  // 画の中の緩急: 画の時間の割合 τ（0〜1）に対する画の上の進み（0〜1）を、速さの形 speed(τ) を積んで作る。
  function cadence(speed) {
    const n = 64;
    const cum = [0];
    for (let i = 1; i <= n; i += 1) cum.push(cum[i - 1] + speed((i - 0.5) / n));
    return (tau) => {
      const x = Math.min(1, Math.max(0, tau)) * n;
      const i = Math.min(n - 1, Math.floor(x));
      return (cum[i] + (cum[i + 1] - cum[i]) * (x - i)) / cum[n];
    };
  }
  // 入りは遅く送りで速まる。止めは速さを落として沈んで止まり、払いは速めたまま抜ける。
  const CADENCE = {
    stop: cadence((t) => (t < 0.15 ? 0.3 + 0.9 * ramp(t, 0, 0.15) : t < 0.7 ? 1.2 : t < 0.92 ? 1.2 - 1.05 * ramp(t, 0.7, 0.92) : 0.08)),
    sweep: cadence((t) => (t < 0.15 ? 0.3 + 0.8 * ramp(t, 0, 0.15) : t < 0.65 ? 1.1 : 1.1 + 0.7 * ramp(t, 0.65, 1)))
  };

  // 筆の canvas: 筆先のまわりの LIBRARY_BRUSH_BOX を写す二枚（影と筆）を筆先の位置へ動かし、承認された筆の姿（paintLibraryBrush）
  // を描く。大きさは頁の紙の 1cm の px（s）で決まる。pose は筆先の紙の上の位置（見開きの px）・紙からの高さ z（cm）・書く向き dir
  // と押さえ press・不透明 opacity・傾き lean。筆の要素の data-lean は描いた傾き（tilt と azimuth の度）。
  const brush = (() => {
    const canvases = { shadow: els.brushShadow, body: els.brushBody };
    const contexts = Object.values(canvases).map((canvas) => {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('library screen: no 2d context for the brush');
      return context;
    });
    const pxPerCm = () => (els.spread.offsetWidth * BRUSH.pageOfBook) / BRUSH.pageCm;
    function draw({ tip, z, dir, press, opacity, lean }, s) {
      const box = LIBRARY_BRUSH_BOX;
      const dpr = window.devicePixelRatio;
      const width = (box.right - box.left) * s;
      const height = (box.bottom - box.top) * s;
      for (const canvas of Object.values(canvases)) {
        const [w, h] = [Math.ceil(width * dpr), Math.ceil(height * dpr)];
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
          canvas.style.width = `${width}px`;
          canvas.style.height = `${height}px`;
        }
      }
      for (const context of contexts) {
        context.setTransform(dpr, 0, 0, dpr, -box.left * s * dpr, -box.top * s * dpr);
        context.clearRect(box.left * s, box.top * s, width, height);
      }
      els.brush.style.transform = `translate(${(tip[0] + box.left * s).toFixed(2)}px, ${(tip[1] + box.top * s).toFixed(2)}px)`;
      els.brush.dataset.lean = `${lean.tilt.toFixed(2)} ${lean.azimuth.toFixed(2)}`;
      paintLibraryBrush(canvases, { tip: [0, 0], pxPerCm: s, lean, bend: { dir, press }, lift: z, opacity });
    }
    function hide() {
      for (const context of contexts) {
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, context.canvas.width, context.canvas.height);
      }
      els.brush.style.transform = '';
      delete els.brush.dataset.lean;
    }
    return { draw, hide, pxPerCm };
  })();

  const writer = (() => {
    let handle = null;
    let plan = null;
    let seed = 0;
    let lastTime = 0;
    let generation = 0;
    let finishTranslation = null;
    let shown = null;                   // いま描いている筆の姿（描いていなければ null）
    const boxes = { left: els.sketchLeft, right: els.sketchRight };
    const metrics = document.createElement('canvas').getContext('2d');
    if (!metrics) throw new Error('library screen: no 2d context for the brush lines');

    // 頁の組みの見えない枠で、最初の頁の題の行（字の左右の端）・層の名前の行・罫・本文の行の基線を測る。
    function measureRows(headTitle) {
      const measure = els.measure;
      const width = els.pageLeft.offsetWidth;
      const height = els.pageLeft.offsetHeight;
      measure.style.width = `${width}px`;
      measure.style.height = `${height}px`;
      const lineH = Number.parseFloat(getComputedStyle(els.pageLeft).lineHeight);
      if (!Number.isFinite(lineH) || lineH <= 0) throw new Error('library screen: the page line height is not a length');
      const probe = () => measure.querySelector(':scope > .academy-library-glyph');
      const at = (glyph) => ({
        centre: glyph.offsetTop + glyph.offsetHeight / 2,
        base: letterBaseline(metrics, glyph, glyph.offsetTop, glyph.offsetHeight),
        size: cssPx(getComputedStyle(glyph).fontSize, 'the page letter size')
      });
      measure.replaceChildren(glyphText('字'));
      const body = at(probe());
      const head = pageHead({ title: headTitle, category: '字' });
      measure.replaceChildren(head, glyphText('字'));
      const lines = [];
      for (const glyph of head.querySelectorAll('.academy-library-page-title .academy-library-glyph')) {
        const place = at(glyph);
        let row = lines.find((line) => Math.abs(line.centre - place.centre) <= glyph.offsetHeight * 0.5);
        if (!row) {
          row = { side: 'left', kind: 'title', ...place, from: Infinity, to: -Infinity };
          lines.push(row);
        }
        row.from = Math.min(row.from, glyph.offsetLeft);
        row.to = Math.max(row.to, glyph.offsetLeft + glyph.offsetWidth);
      }
      lines.push({ side: 'left', kind: 'category', ...at(head.querySelector('.academy-library-page-category .academy-library-glyph')), from: 0, to: width * 0.28 });
      const rule = head.querySelector('.academy-library-page-rule');
      lines.push({ side: 'left', kind: 'rule', base: rule.offsetTop, from: rule.offsetLeft, to: rule.offsetLeft + rule.offsetWidth });
      const headBody = at(probe());
      for (const [side, first] of [['left', headBody], ['right', body]]) {
        for (let k = 0; first.centre + k * lineH + lineH / 2 <= height; k += 1) {
          lines.push({ side, kind: 'body', base: first.base + k * lineH, size: first.size, from: 0, to: width });
        }
      }
      measure.replaceChildren();
      return { lineH, em: body.size, lines };
    }

    // 色を、紙と乗算したときに不透明 alpha で重ねたのと同じ姿になる不透明の色にする（一画ずつ書き足しても重なりが濃くならない）。
    function premixed(color, alpha = 1) {
      metrics.fillStyle = '#000';
      metrics.fillStyle = color;
      const value = metrics.fillStyle;
      const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value);
      const rgba = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(value);
      if (!hex && !rgba) throw new Error(`library screen: cannot read the colour ${JSON.stringify(color)}`);
      const channels = hex ? hex.slice(1).map((h) => Number.parseInt(h, 16)) : rgba.slice(1, 4).map(Number);
      const a = alpha * (rgba ? Number(rgba[4]) : 1);
      return `rgb(${channels.map((c) => Math.round(255 - a * (255 - c))).join(' ')})`;
    }

    function catmull(points, per = 8) {
      const out = [];
      const p = [points[0], ...points, points[points.length - 1]];
      for (let i = 1; i < p.length - 2; i += 1) {
        for (let k = 0; k < per; k += 1) {
          const t = k / per;
          const t2 = t * t;
          const t3 = t2 * t;
          const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
          out.push([f(p[i - 1][0], p[i][0], p[i + 1][0], p[i + 2][0]), f(p[i - 1][1], p[i][1], p[i + 1][1], p[i + 2][1])]);
        }
      }
      out.push(points[points.length - 1]);
      return out;
    }

    // 一画: 組みの上の点の並び（flat）と、紙の反りで持ち上げた先（lifted）。長さは組みの上で測る。
    function strokeOf(map, flat, extra) {
      const cum = [0];
      for (let i = 1; i < flat.length; i += 1) cum.push(cum[i - 1] + Math.hypot(flat[i][0] - flat[i - 1][0], flat[i][1] - flat[i - 1][1]));
      return { flat, lifted: flat.map(map.lift), cum, len: cum[cum.length - 1], next: 0, t0: 0, t1: 0, ...extra };
    }

    // 画の上の、頭から length の所（持ち上げた先の点）。
    function pointOf(stroke, length) {
      const { cum, lifted } = stroke;
      let i = 1;
      while (i < cum.length - 1 && cum[i] < length) i += 1;
      const k = cum[i] > cum[i - 1] ? Math.min(1, Math.max(0, (length - cum[i - 1]) / (cum[i] - cum[i - 1]))) : 0;
      return [lifted[i - 1][0] + (lifted[i][0] - lifted[i - 1][0]) * k, lifted[i - 1][1] + (lifted[i][1] - lifted[i - 1][1]) * k];
    }

    // 筆の圧（画の頭で押さえて少し太り、終わりへ細る）。
    const pressure = (u) => (u < 0.08 ? 0.75 + (u / 0.08) * 0.35 : u < 0.7 ? 1.1 - ((u - 0.08) / 0.62) * 0.2 : 0.9 - ((u - 0.7) / 0.3) * 0.45);

    // 画を、書いた所（stroke.next）から upto まで書き足す。罫は細い線、字は筆の圧の丸を 0.25px おきに置く。
    function inkStroke(g, stroke, upto, { color = stroke.color, widen = 1 } = {}) {
      if (stroke.rule) {
        if (upto <= stroke.next) return;
        g.strokeStyle = color;
        g.lineWidth = stroke.width * widen;
        g.beginPath();
        g.moveTo(...pointOf(stroke, stroke.next));
        for (let i = 1; i < stroke.cum.length && stroke.cum[i] < upto; i += 1) if (stroke.cum[i] > stroke.next) g.lineTo(...stroke.lifted[i]);
        g.lineTo(...pointOf(stroke, upto));
        g.stroke();
        stroke.next = upto;
        return;
      }
      g.fillStyle = color;
      g.beginPath();
      let d = stroke.next;
      for (; d <= upto; d += 0.25) {
        const [x, y] = pointOf(stroke, d);
        const r = ((stroke.width * widen) / 2) * pressure(d / stroke.len);
        g.moveTo(x + r, y);
        g.arc(x, y, r, 0, Math.PI * 2);
      }
      g.fill();
      stroke.next = d;
    }

    // 行の canvas（行の画の全部を囲む範囲・持ち上げた先の組みの px）を、行の置き場（.academy-library-sketch-row）へ置く。
    function rowCanvas(row, parent, widen = 1) {
      const pad = Math.max(...row.strokes.map((stroke) => stroke.width)) * widen + 2;
      const points = row.strokes.flatMap((stroke) => stroke.lifted);
      const left = Math.floor(Math.min(...points.map(([x]) => x)) - pad);
      const top = Math.floor(Math.min(...points.map(([, y]) => y)) - pad);
      const right = Math.ceil(Math.max(...points.map(([x]) => x)) + pad);
      const bottom = Math.ceil(Math.max(...points.map(([, y]) => y)) + pad);
      const scale = SHEET_SCALE * window.devicePixelRatio;
      const canvas = document.createElement('canvas');
      Object.assign(canvas.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
      canvas.width = Math.ceil((right - left) * scale);
      canvas.height = Math.ceil((bottom - top) * scale);
      const g = canvas.getContext('2d');
      if (!g) throw new Error('library screen: no 2d context for the brush lines');
      g.setTransform(scale, 0, 0, scale, -left * scale, -top * scale);
      parent.append(canvas);
      return g;
    }

    // 行に字を並べる。mode: full は行末まで（語を行の途中で切らない）、end は段落の終わりの行（句点で閉じる）、center は珍しい語を
    // 行の幅に収まるだけ（most まで）中央に寄せる（題・層の名前）。並べた字の画の列（平らな px）を返す。
    function layLine(plan, line, mode, most = 4) {
      const { lang, state } = plan;
      const size = line.size * X_HEIGHT;
      const gap = LETTER_GAP * size;
      const space = WORD_SPACE * size;
      const placed = [];
      const put = (letter, x, wordStart = false) => {
        const { strokes, advance } = placeLetter(letter, x, line.base, size);
        placed.push({ letter, strokes, wordStart });
        state.after = letter;
        return x + advance + gap;
      };
      const putWord = (word, x) => word.reduce((at, letter, k) => put(letter, at, k === 0), x);
      if (mode === 'center') {
        const words = [];
        let measure = -space - gap;
        while (words.length < most) {
          const word = lang.rareWord(words.length ? words.at(-1).at(-1) : state.after);
          const next = measure + wordWidth(word, size) + space;
          if (words.length && next > line.to - line.from) break;
          words.push(word);
          measure = next;
        }
        let x = (line.from + line.to) / 2 - measure / 2;
        words.forEach((word, i) => {
          x = putWord(word, x);
          if (i < words.length - 1) x += space - gap;
        });
        return placed;
      }
      const end = mode === 'end';
      let x = line.from;
      for (;;) {
        state.pending ??= lang.nextWord(state.after);
        const word = state.pending;
        if (x + wordWidth(word, size) > line.to + (end ? size * 2 : 0)) break;
        x = putWord(word, x);
        state.pending = null;
        state.inSentence += 1;
        if (state.inSentence >= state.target || (end && x > line.to - size * 3)) {
          x = put({ p: 'stop' }, x);
          state.inSentence = 0;
          state.target = lang.sentenceLength();
          if (end) break;
        } else if (lang.comma()) {
          x = put({ p: 'comma' }, x);
        }
        x += space - gap;
      }
      if (end && placed.length && placed.at(-1).letter.p !== 'stop') put({ p: 'stop' }, x);
      return placed;
    }

    // 一行（罫か字の行）を組み、画と行の置き場を作る。行の置き場の data-script は並べた字の形（語の頭に |）。
    function makeRow(plan, line, mode) {
      const map = plan.maps[line.side];
      const row = { side: line.side, kind: line.kind, base: line.base, strokes: [], script: [] };
      if (line.kind === 'rule') {
        const points = Array.from({ length: 25 }, (_, k) => [line.from + ((line.to - line.from) * k) / 24, line.base + 0.5]);
        row.strokes.push(strokeOf(map, points, { row, rule: true, width: 1, color: plan.colors.rule }));
      } else {
        const [low, high] = INK_DENSITY;
        const width = INK_WIDTH * line.size * X_HEIGHT;
        for (const { letter, strokes, wordStart } of layLine(plan, line, mode, line.kind === 'category' ? 1 : 4)) {
          const color = premixed(plan.colors.ink, low + (high - low) * plan.random());
          strokes.forEach((points, k) => row.strokes.push(strokeOf(map, catmull(points), { row, width, color, wordStart: wordStart && k === 0 })));
          row.script.push(`${wordStart ? '|' : ''}${shapeKey(letter)}`);
        }
      }
      row.stateAfter = { ...plan.state, pending: null };
      row.el = document.createElement('div');
      row.el.className = 'academy-library-sketch-row';
      row.el.dataset.kind = row.kind;
      row.el.dataset.script = row.script.join(' ');
      plan.layers[row.side].ink.append(row.el);
      row.g = row.strokes.length ? rowCanvas(row, row.el) : null;
      return row;
    }

    // 画の終わりの形: 終わりで巻き込む画（渦・結び）・短い画（点）・罫は止め、それ以外は払い。
    function endingOf(stroke, em) {
      if (stroke.rule || stroke.len < em * 0.3) return 'stop';
      const angle = (from, to) => {
        const [a, b] = [pointOf(stroke, stroke.len * from), pointOf(stroke, stroke.len * to)];
        return Math.atan2(b[1] - a[1], b[0] - a[0]);
      };
      const turn = Math.abs(((angle(0.85, 1) - angle(0.6, 0.75) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      return turn > Math.PI / 3 ? 'stop' : 'sweep';
    }

    // 見開きひとつぶんの字を組む: 題の行・層の名前の行・罫・本文の行。書く順に時刻を割り当てる（start は最初の行の前の間）。
    // from・fromLift は書き始める前の筆の所と高さ（無ければ最初の画の頭の上から降りる）。頁の箱の位置と大きさ・頁の紙の 1cm の
    // px は組んだ時に一度だけ読む（窓の大きさが変わると組み直す）。
    function compose(headTitle, { start, from, fromLift }) {
      const random = seededRandom(hash32(`${headTitle}|${seed}`));
      seed += 1;
      const lang = createLanguage(random);
      const { lineH, em, lines } = measureRows(headTitle);
      const maps = {};
      const layers = {};
      const frames = {};
      for (const side of ['left', 'right']) {
        maps[side] = paperMap(boxes[side], side);
        frames[side] = { left: boxes[side].offsetLeft, top: boxes[side].offsetTop, width: boxes[side].offsetWidth, height: boxes[side].offsetHeight };
        layers[side] = {};
        for (const [name, className] of [['ink', 'academy-library-sketch-ink'], ['glow', 'academy-library-sketch-glow']]) {
          const layer = document.createElement('div');
          layer.className = className;
          layer.style.transform = maps[side].projection.css;
          boxes[side].append(layer);
          layers[side][name] = layer;
        }
      }
      const colors = { ink: screenToken(els.book, '--library-page-ink'), rule: premixed(screenToken(els.book, '--library-parchment-rule')) };
      const state = { after: null, inSentence: 0, target: lang.sentenceLength(), pending: null };
      const next = {
        headTitle, random, lang, state, initial: { ...state }, lineH, em, maps, layers, frames, colors, pxPerCm: brush.pxPerCm(),
        rows: [], strokes: [], cursor: 0, elapsed: 0, from, fromLift
      };
      for (const line of lines) next.rows.push(makeRow(next, line, line.kind === 'title' || line.kind === 'category' ? 'center' : 'full'));
      let t = start;
      let prev = null;
      for (const row of next.rows) {
        t += MOVE.line;
        prev = null;
        const speed = (WRITE_SPEED[row.kind] * em) / 1000;
        for (const stroke of row.strokes) {
          if (prev && stroke.wordStart) t += MOVE.word;
          if (prev) t += MOVE.stroke + (Math.hypot(stroke.flat[0][0] - prev[0], stroke.flat[0][1] - prev[1]) / em) * MOVE.perEm;
          stroke.t0 = t;
          stroke.t1 = t + stroke.len / speed;
          stroke.ending = endingOf(stroke, em);
          stroke.endLift = stroke.ending === 'sweep' ? BRUSH.endLift : 0;
          t = stroke.t1;
          prev = stroke.flat.at(-1);
          next.strokes.push(stroke);
        }
      }
      next.end = t;
      return next;
    }

    // 組みの上の一点（その頁の箱の上・持ち上げた先）の、見開きの上の位置（px）。
    function spreadPoint(side, point) {
      const [x, y] = plan.maps[side].projection.forward(point);
      return [x + plan.frames[side].left, y + plan.frames[side].top];
    }

    // 時刻 t に画の頭から筆が進んだ長さ（画の緩急どおり）。
    const reachOf = (stroke, t) => stroke.len * CADENCE[stroke.ending]((t - stroke.t0) / (stroke.t1 - stroke.t0));

    // 画の終わりの筆先（見開きの px）と、運んできた向き。
    function endOf(stroke) {
      if (!stroke.end) {
        const tip = spreadPoint(stroke.row.side, pointOf(stroke, stroke.len));
        stroke.end = { tip, dir: heading(spreadPoint(stroke.row.side, pointOf(stroke, stroke.len * 0.9)), tip) };
      }
      return stroke.end;
    }

    // 画を書いている筆: 緩急どおりに進み、入りで穂を置き（押さえが増して紙へ降りきる）、止めでは沈み、払いでは押さえを抜いて浮く。
    // 穂は書く向きと逆へ撓む。
    function writing(stroke, t) {
      const tau = (t - stroke.t0) / (stroke.t1 - stroke.t0);
      const at = reachOf(stroke, t);
      const ahead = Math.min(stroke.len, at + stroke.len * 0.05);
      const tip = spreadPoint(stroke.row.side, pointOf(stroke, at));
      const behind = spreadPoint(stroke.row.side, pointOf(stroke, ahead - stroke.len * 0.05));
      const settle = ramp(tau, 0, 0.12);
      let press = 0.45 + 0.4 * settle;
      let z = 0.12 * (1 - settle);
      if (stroke.ending === 'stop') {
        press += 0.15 * ramp(tau, 0.75, 1);
      } else {
        const out = ramp(tau, 0.7, 1);
        press -= 0.65 * out;
        z += stroke.endLift * out * out;
      }
      return { tip, z, dir: heading(behind, spreadPoint(stroke.row.side, pointOf(stroke, ahead))), press: stroke.rule ? press * 0.35 : press, opacity: 1 };
    }

    // 行の終わり・見開きの終わりの筆: 書き終えた所から運んできた向きへ drift だけ漂って floatLift まで浮き（離れてから driftMs の
    // 間）、次の行の頭 next.to へ弧を描いて舞い戻る（next.span は画と画の間の全体）。次が無ければ、漂った所でゆっくり揺れて待つ。
    function floating(previous, since, next) {
      const s = plan.pxPerCm;
      const end = endOf(previous);
      const drift = [end.tip[0] + end.dir[0] * BRUSH.drift * s, end.tip[1] + end.dir[1] * BRUSH.drift * s - 0.3 * s];
      const driftMs = (next ? next.span : MOVE.line) * LINE_DRIFT;
      if (since < driftMs) {
        const k = easeOut(since / driftMs);
        return { tip: lerp(end.tip, drift, k), z: previous.endLift + (BRUSH.floatLift - previous.endLift) * k, dir: end.dir, press: 0, opacity: 1 };
      }
      if (!next) {
        const wave = (2 * Math.PI * (since - driftMs)) / 1600;
        return { tip: [drift[0], drift[1] - Math.sin(wave) * 0.12 * s], z: BRUSH.floatLift + Math.sin(wave) * 0.1, dir: end.dir, press: 0, opacity: 1 };
      }
      const e = easeInOut((since - driftMs) / (next.span - driftMs));
      const tip = lerp(drift, next.to, e);
      return { tip: [tip[0], tip[1] - Math.sin(Math.PI * e) * s], z: BRUSH.floatLift * (1 - e), dir: heading(drift, next.to), press: 0, opacity: 1 };
    }

    // 時刻 t（書き始めからの ms）の筆: 書いている画の上か、画と画の間を宙の弧で滑る途中か、行の終わりで漂ってから次の行の頭へ
    // 舞い戻る途中か、見開きを書き終えて漂っているところ。
    function brushAt(t) {
      const { strokes } = plan;
      let k = plan.cursor;
      while (k < strokes.length && strokes[k].t1 <= t) k += 1;
      if (k >= strokes.length) {
        const last = strokes[strokes.length - 1];
        return floating(last, t - last.t1, null);
      }
      const stroke = strokes[k];
      if (t >= stroke.t0) return writing(stroke, t);
      const previous = strokes[k - 1];
      const to = spreadPoint(stroke.row.side, pointOf(stroke, 0));
      if (previous && previous.row !== stroke.row) return floating(previous, t - previous.t1, { to, span: stroke.t0 - previous.t1 });
      const from = previous ? endOf(previous).tip : plan.from ?? to;
      const fromLift = previous ? previous.endLift : plan.fromLift;
      const u = ramp(t, previous ? previous.t1 : 0, stroke.t0);
      const e = easeInOut(u);
      const s = plan.pxPerCm;
      const rise = Math.min(BRUSH.travelLift, 0.25 + (Math.hypot(to[0] - from[0], to[1] - from[1]) / s) * 0.32);
      // 書き始め: 持ち上がった所から最初の画の頭へ降りる。ほかは宙を弧を描いて滑る（道の中ほどで持ち上がり、画面の上へ膨らむ）。
      const z = !previous && !plan.from ? (1 - e) * BRUSH.travelLift : fromLift * (1 - e) + Math.sin(Math.PI * u) * rise;
      const tip = lerp(from, to, e);
      return { tip: [tip[0], tip[1] - Math.sin(Math.PI * e) * rise * 0.3 * s], z, dir: heading(from, to), press: 0, opacity: 1 };
    }

    // 筆の傾き: 紙の上の軸の水平成分（x 右・y 奥）を、運ぶ向きへ運ぶ速さに応じて寄せた先へ leanMs で追わせる（止まると元の持ち方へ
    // 戻る）。画面の下は紙の手前で、奥行きは見下ろしで縮んで写る。
    const rad = (d) => (d * Math.PI) / 180;
    const BASE_LEAN = [Math.sin(rad(LIBRARY_BRUSH_LEAN.tilt)) * Math.sin(rad(LIBRARY_BRUSH_LEAN.azimuth)), -Math.sin(rad(LIBRARY_BRUSH_LEAN.tilt)) * Math.cos(rad(LIBRARY_BRUSH_LEAN.azimuth))];
    const lean = { x: BASE_LEAN[0], y: BASE_LEAN[1], tip: null };
    function leaning(tip, dt) {
      if (lean.tip && dt > 0) {
        const s = plan.pxPerCm;
        const dx = (tip[0] - lean.tip[0]) / s;
        const dy = -(tip[1] - lean.tip[1]) / (s * Math.sin(rad(BRUSH.view)));
        const moved = Math.hypot(dx, dy);
        const pull = moved ? (BRUSH.lean * Math.min(1, ((moved / dt) * 1000) / 12)) / moved : 0;
        const k = 1 - Math.exp(-dt / BRUSH.leanMs);
        lean.x += (BASE_LEAN[0] + dx * pull - lean.x) * k;
        lean.y += (BASE_LEAN[1] + dy * pull - lean.y) * k;
      }
      lean.tip = tip;
      const within = (value, [low, high]) => Math.min(high, Math.max(low, value));
      return {
        tilt: within((Math.asin(Math.min(1, Math.hypot(lean.x, lean.y))) * 180) / Math.PI, BRUSH.tilt),
        azimuth: within((Math.atan2(lean.x, -lean.y) * 180) / Math.PI, BRUSH.azimuth)
      };
    }

    // 筆を描く（dt は前に描いてからの ms。傾きの追いに使う）。
    function draw(pose, dt) {
      shown = pose;
      brush.draw({ ...pose, lean: leaning(pose.tip, dt) }, plan.pxPerCm);
    }

    function hideBrush() {
      shown = null;
      lean.x = BASE_LEAN[0];
      lean.y = BASE_LEAN[1];
      lean.tip = null;
      brush.hide();
    }

    function step(time) {
      const dt = lastTime ? Math.min(250, time - lastTime) : 0;
      lastTime = time;
      plan.elapsed += dt;
      const t = plan.elapsed;
      while (plan.cursor < plan.strokes.length && plan.strokes[plan.cursor].t0 <= t) {
        const stroke = plan.strokes[plan.cursor];
        inkStroke(stroke.row.g, stroke, reachOf(stroke, t));
        if (t < stroke.t1) break;
        plan.cursor += 1;
      }
      if (t >= plan.end + LINE_RESTS_MS) {
        // 見開きを書き終えた: 書いた字が紙へ沈むのと同時に、筆は漂っていた所から左の頁の天へ戻って新しい字で書き直す。
        const old = plan;
        for (const layer of Object.values(old.layers).flatMap((pair) => Object.values(pair))) {
          layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: SINK_MS, easing: EASE, fill: 'forwards' }).finished
            .then(() => layer.remove(), () => layer.remove());
        }
        const pose = brushAt(t);
        plan = compose(old.headTitle, { start: SINK_MS - MOVE.line, from: pose.tip, fromLift: pose.z });
      }
      draw(brushAt(plan.elapsed), dt);
      handle = requestAnimationFrame(step);
    }

    // 本文が届かなかった後: 筆が持ち上がって右手前へ退き、消える。
    function leave(from, mine) {
      return new Promise((resolve) => {
        let begin = null;
        let last = null;
        const frame = (now) => {
          if (mine !== generation) return resolve();
          begin ??= now;
          const k = Math.min(1, (now - begin) / ARRIVAL.exit);
          if (k >= 1) {
            hideBrush();
            return resolve();
          }
          const s = plan.pxPerCm;
          draw({ tip: [from.tip[0] + k * BRUSH.leave[0] * s, from.tip[1] + k * BRUSH.leave[1] * s], z: from.z + easeInOut(k) * (BRUSH.lift - from.z), dir: from.dir, press: 0, opacity: 1 - easeInOut(k) }, last === null ? 0 : now - last);
          last = now;
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
    }

    // 届いた頁の行（pages: 側ごとの頁のインクと pageLines）に、この世界の文字の行を組み直す。書いた画のある行は残し、まだ書いて
    // いない行は届いた頁の行（題・層の名前は中央に寄せ、本文は段落の終わりの行を句点で閉じる）に組み直す（一行組むごとに yield）。
    // 返すのは訳しの単位（頁の一行と、その場所のこの世界の文字の行）を訳す順に並べたもの。
    function* relay(pages) {
      const t = plan.elapsed;
      const kept = plan.rows.filter((row) => row.strokes.some((stroke) => stroke.t0 < t));
      for (const row of plan.rows) if (!kept.includes(row)) row.el.remove();
      plan.state = kept.length ? { ...kept.at(-1).stateAfter } : { ...plan.initial };
      const near = plan.lineH * 0.5;
      const units = [];
      const fresh = [];
      for (const { side, lines } of pages) {
        const body = lines.filter((line) => line.kind === 'body');
        const bodyRight = Math.max(0, ...body.map((line) => line.to));
        for (const line of lines) {
          const rule = line.kind === 'rule';
          const matched = kept.filter((row) => row.side === side && (row.kind === 'rule') === rule && Math.abs(row.base - line.base) < near);
          const unit = { side, base: line.base, line, rows: [...matched] };
          if (!matched.length) {
            let mode = 'center';
            if (line.kind === 'body') {
              const next = body[body.indexOf(line) + 1];
              mode = line.to < bodyRight - line.size * 1.5 || !next || next.base - line.base > line.size * 2.6 ? 'end' : 'full';
            }
            const row = makeRow(plan, { ...line, side }, mode);
            unit.rows.push(row);
            fresh.push(row);
            yield;
          }
          units.push(unit);
        }
      }
      for (const row of kept) {
        if (!units.some((unit) => unit.rows.includes(row))) units.push({ side: row.side, base: row.base, line: null, rows: [row] });
      }
      units.sort((a, b) => (a.side === b.side ? a.base - b.base : a.side === 'left' ? -1 : 1));
      return { units, kept, fresh };
    }

    // 書き終わりの流れの支度（区切りごとに yield）: 頁を割り付けて紙に載せる（laying）→ 読む段（頁の行・光の色・頁の一行ずつの
    // 墨を、DOM を書く前に読んで描く）→ 書く段（届いた頁の行への組み直し・まだ書いていない画の一枚・光の一枚・頁の一行の墨を、
    // どれも見えないまま置く）。返すのは訳しの単位（見開きの上の位置 point・頁の一行の墨 ink を持つ）と、行ごとの浮かぶ一枚と光の一枚。
    function* preparing(laying) {
      yield* laying;
      const pages = [['left', els.pageLeft], ['right', els.pageRight]].map(([side, page]) => {
        const ink = page.querySelector(':scope > .academy-library-page-ink');
        return { side, ink, lines: ink && sheets.has(ink) ? pageLines(ink) : [] };
      });
      yield;
      const glowColor = screenToken(els.book, '--library-translate-glow');
      const flat = document.createElement('canvas');
      const pageLineOf = new Map();
      for (const { ink, lines } of pages) {
        for (const line of lines) {
          pageLineOf.set(line, paintPageLine(ink, line, flat));
          yield;
        }
      }
      const { units, kept, fresh } = yield* relay(pages);
      const inkOf = Object.fromEntries(pages.map(({ side, ink }) => [side, ink]));
      // まだ書いていない画の一枚: 書いた画のある行は書き残しの画だけを別の一枚に、新しく組んだ行は行の一枚に書く。
      const blooms = new Map();
      for (const row of kept) {
        const rest = row.strokes.filter((stroke) => stroke.next < stroke.len);
        if (!rest.length) continue;
        const g = rowCanvas(row, row.el);
        g.canvas.style.opacity = '0';
        for (const stroke of rest) inkStroke(g, stroke, stroke.len);
        blooms.set(row, g.canvas);
        yield;
      }
      for (const row of fresh) {
        if (!row.g) continue;
        row.g.canvas.style.opacity = '0';
        for (const stroke of row.strokes) inkStroke(row.g, stroke, stroke.len);
        blooms.set(row, row.g.canvas);
        yield;
      }
      // 光の一枚は置く前に filter を掛けて描く（置いた canvas に filter を掛けると、そこで style の再計算を強いる）。
      const glows = new Map();
      for (const row of units.flatMap((unit) => unit.rows)) {
        if (!row.g) continue;
        const glow = rowCanvas(row, document.createDocumentFragment(), GLOW.widen);
        glow.filter = `blur(${(GLOW.blur * SHEET_SCALE * window.devicePixelRatio).toFixed(2)}px)`;
        for (const stroke of row.strokes) inkStroke(glow, { ...stroke, next: 0 }, stroke.len, { color: glowColor, widen: GLOW.widen });
        glow.canvas.style.opacity = '0';
        plan.layers[row.side].glow.append(glow.canvas);
        glows.set(row, glow.canvas);
        yield;
      }
      for (const unit of units) {
        const x = unit.line ? (unit.line.from + unit.line.to) / 2 : plan.frames[unit.side].width / 2;
        unit.point = spreadPoint(unit.side, [x, unit.base]);
        if (unit.line && inkOf[unit.side]) {
          unit.ink = pageLineOf.get(unit.line);
          unit.ink.style.opacity = '0';
          inkOf[unit.side].append(unit.ink);
        }
      }
      return { units, blooms, glows };
    }

    function clear() {
      if (handle !== null) cancelAnimationFrame(handle);
      handle = null;
      lastTime = 0;
      plan = null;
      finishTranslation = null;
      generation += 1;
      els.sketchLeft.replaceChildren();
      els.sketchRight.replaceChildren();
      for (const line of els.spread.querySelectorAll('.academy-library-page-line')) line.remove();
      if (els.book.dataset.ink === 'translating') els.book.dataset.ink = 'ready';
      delete els.book.dataset.writing;
      hideBrush();
    }

    return {
      // 開く前の白い見開きに、まだ書かれていない字を組んでおく（最初の頁の題の行は、これから開く本の題の長さ）。
      prepare(headTitle) {
        clear();
        plan = compose(headTitle, { start: MOVE.lead, from: null, fromLift: 0 });
      },
      // 組んでおいた字を書き始める。
      start() {
        if (!plan) throw new Error('library screen: the brush starts without prepared lines');
        els.book.dataset.writing = reduced() ? 'still' : 'moving';
        if (reduced()) {
          // 筆は出さず、見開きの全部の行の字が淡く現れて濃くなる。
          for (const stroke of plan.strokes) inkStroke(stroke.row.g, stroke, stroke.len);
          for (const pair of Object.values(plan.layers)) pair.ink.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 6000, easing: 'ease-out', fill: 'forwards' });
          return;
        }
        draw(brushAt(0), 0);
        handle = requestAnimationFrame(step);
      },
      // 筆が書いているか（本文が届いたとき、書き終わりの流れで訳すか）。
      moving() {
        return plan !== null && els.book.dataset.writing === 'moving';
      },
      // 本文が届いた（筆が書いている）: 書き終わりの流れで筆の字を頁の字へ訳す。laying は頁を割り付けて見開きを紙に載せる支度
      // （区切りごとに yield する generator）で、振りかぶりの間にフレームごとに区切って進める（data-writing が lifting）。支度が
      // 済むと筆が払い（sweeping・data-ink が translating）、跡に沿って行が浮かび、筆が抜けるのと同時に光が跡を追って訳す。訳し
      // 終えると頁のインクは頁の一枚に戻り（data-ink が ready）、返した promise が落着する。支度が throw したら筆が退いて字が
      // ほどけ、promise はその error で落ちる。
      translate(laying) {
        if (!this.moving()) throw new Error('library screen: the 本文 is translated while the brush is not writing');
        if (handle !== null) cancelAnimationFrame(handle);
        handle = null;
        lastTime = 0;
        const mine = ++generation;
        const s = plan.pxPerCm;
        const stopped = brushAt(plan.elapsed);
        const trail = TRAIL.map(([side, x, y]) => spreadPoint(side, [plan.frames[side].width * x, plan.frames[side].height * y]));
        const crest = [trail[0][0] + BRUSH.windup[0] * s, trail[0][1] + BRUSH.windup[1] * s];
        els.book.dataset.writing = 'lifting';
        const steps = preparing(laying);
        let prepared = null;
        let sweep = null;
        let begin = null;
        let last = null;
        return new Promise((resolve, reject) => {
          const fail = (error) => {
            finishTranslation = null;
            steps.return();
            this.release();
            reject(error);
          };
          finishTranslation = () => {
            finishTranslation = null;
            if (!prepared) {
              try {
                prepared = drain(steps);
              } catch (error) {
                fail(error);
                return;
              }
            }
            if (mine === generation) {
              clear();
              els.book.dataset.ink = 'ready';
            }
            resolve();
          };
          // 振りかぶり: 止まった所から浮いて、払いの跡の頭の手前（crest）へ弧を描いて上がる。支度が済まなければ crest の上で
          // 小さな八の字を描いて漂い続ける。
          const windingUp = (elapsed) => {
            if (elapsed < ARRIVAL.windup) {
              const k = easeInOut(elapsed / ARRIVAL.windup);
              const tip = lerp(stopped.tip, crest, k);
              return {
                tip: [tip[0], tip[1] - Math.sin(Math.PI * k) * s], z: stopped.z + (BRUSH.sweepLift - stopped.z) * easeOut(elapsed / ARRIVAL.windup),
                dir: heading(stopped.tip, crest), press: stopped.press * (1 - k), opacity: 1
              };
            }
            const wave = (2 * Math.PI * (elapsed - ARRIVAL.windup)) / 1400;
            return { tip: [crest[0] + Math.sin(wave) * 0.25 * s, crest[1] + Math.sin(2 * wave) * 0.1 * s], z: BRUSH.sweepLift + Math.sin(wave) * 0.12, dir: [1, 0], press: 0, opacity: 1 };
          };
          // 払いを始める: いまの筆の所から払いの跡を通る道を引き、訳しの単位ごとに筆が最も近くを通る時刻（跡の上の割合 p）から、
          // 行の浮かぶ時刻（筆が通る時刻）と訳しの時刻（光が跡を p の順に追う）を決める。
          const startSweep = (now, from) => {
            const path = catmull([from.tip, ...trail], 12);
            const cum = [0];
            for (let i = 1; i < path.length; i += 1) cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
            const total = cum.at(-1);
            const along = (p) => {
              const length = p * total;
              let i = 1;
              while (i < path.length - 1 && cum[i] < length) i += 1;
              const k = cum[i] > cum[i - 1] ? Math.min(1, Math.max(0, (length - cum[i - 1]) / (cum[i] - cum[i - 1]))) : 0;
              return { tip: lerp(path[i - 1], path[i], k), dir: heading(path[i - 1], path[i]) };
            };
            const passing = (point) => {
              let best = 0;
              for (let i = 1; i < path.length; i += 1) {
                if (Math.hypot(path[i][0] - point[0], path[i][1] - point[1]) < Math.hypot(path[best][0] - point[0], path[best][1] - point[1])) best = i;
              }
              return cum[best] / total;
            };
            // 払いの進みが p に届く時刻の割合（sweepEase は増えるだけなので二分で解く）。
            const reached = (p) => {
              let [low, high] = [0, 1];
              for (let i = 0; i < 24; i += 1) {
                const mid = (low + high) / 2;
                if (sweepEase(mid) < p) low = mid;
                else high = mid;
              }
              return high;
            };
            els.book.dataset.writing = 'sweeping';
            els.book.dataset.ink = 'translating';
            const { units, blooms, glows } = prepared;
            const rise = `translate(0, ${(plan.lineH * 0.18).toFixed(2)}px)`;
            const motions = [];
            for (const unit of units) {
              const p = passing(unit.point);
              const timing = { duration: ARRIVAL.perLine, delay: ARRIVAL.sweep + p * ARRIVAL.glow, fill: 'both' };
              for (const row of unit.rows) {
                const bloom = blooms.get(row);
                if (bloom) motions.push(bloom.animate([{ opacity: 0, transform: rise }, { opacity: 1, transform: 'none' }], { duration: ARRIVAL.rise, delay: reached(p) * ARRIVAL.sweep, easing: 'ease-out', fill: 'both' }).finished);
                if (!row.g) continue;
                motions.push(row.el.animate([{ opacity: 1 }, { opacity: 0 }], { ...timing, easing: 'linear' }).finished);
                motions.push(glows.get(row).animate([0, 0.71, 1, 0.71, 0].map((k) => ({ opacity: k * GLOW.peak })), { ...timing, easing: 'linear' }).finished);
              }
              if (unit.ink) motions.push(unit.ink.animate([{ opacity: 0 }, { opacity: 1 }], { ...timing, easing: 'ease-in-out' }).finished);
            }
            const gone = new Promise((done) => { sweep = { start: now, fromZ: from.z, total, along, gone: done }; });
            Promise.allSettled([...motions, gone]).then(() => { if (finishTranslation && mine === generation) finishTranslation(); else resolve(); });
          };
          // 払い: 跡の上を静かに滑り出して速まり、glide の高さまで降りて払う。抜ける: 速さを残して跡の先へ滑りながら浮き、消える。
          const sweeping = (t) => {
            if (t < ARRIVAL.sweep) {
              const k = sweepEase(t / ARRIVAL.sweep);
              const { tip, dir } = sweep.along(k);
              const z = sweep.fromZ + (BRUSH.glide - sweep.fromZ) * easeInOut(k / 0.2) + 0.3 * ramp(k, 0.85, 1) ** 2;
              return { tip, z, dir, press: 0.25, opacity: 1 };
            }
            const k = (t - ARRIVAL.sweep) / ARRIVAL.exit;
            if (k >= 1) return null;
            // 払いの終わりの速さ（sweepEase の終わりの傾きは π/4）から、抜けるあいだに速さを落としきる。
            const end = sweep.along(1);
            const reach = ((sweep.total * Math.PI) / 4) * (ARRIVAL.exit / ARRIVAL.sweep) * (k - (k * k) / 2);
            return {
              tip: [end.tip[0] + end.dir[0] * reach, end.tip[1] + end.dir[1] * reach], z: BRUSH.glide + 0.3 + (BRUSH.lift - BRUSH.glide - 0.3) * k * k,
              dir: end.dir, press: 0.25 * (1 - k), opacity: 1 - easeInOut(k)
            };
          };
          const frame = (now) => {
            if (mine !== generation) {
              steps.return();
              resolve();
              return;
            }
            begin ??= now;
            const dt = last === null ? 0 : now - last;
            last = now;
            if (!prepared) {
              const until = performance.now() + PREPARE_BUDGET_MS;
              try {
                for (;;) {
                  const { done, value } = steps.next();
                  if (done) {
                    prepared = value;
                    break;
                  }
                  if (performance.now() >= until) break;
                }
              } catch (error) {
                fail(error);
                return;
              }
            }
            if (prepared && !sweep && now - begin >= ARRIVAL.windup) startSweep(now, shown);
            const pose = sweep ? sweeping(now - sweep.start) : windingUp(now - begin);
            if (!pose) {
              handle = null;
              hideBrush();
              sweep.gone();
              return;
            }
            draw(pose, dt);
            handle = requestAnimationFrame(frame);
          };
          handle = requestAnimationFrame(frame);
        });
      },
      // 本文が届かなかった（または支度が throw した）: 筆が描かれていれば紙から離れて退き、字は上の行から順にほどけて消える。
      release() {
        if (!els.book.dataset.writing) return;
        if (handle !== null) cancelAnimationFrame(handle);
        handle = null;
        lastTime = 0;
        const mine = ++generation;
        const current = plan;
        const from = shown;
        els.book.dataset.writing = 'lifting';
        const fade = reduced() ? REDUCED_FADE_MS : RELEASE_MS;
        const rows = current ? current.rows : [];
        const motions = rows.map((row, i) => row.el.animate(
          [{ opacity: 0 }],
          { duration: fade, delay: reduced() ? 0 : (i / Math.max(1, rows.length)) * 260, easing: EASE, fill: 'forwards' }
        ).finished);
        if (current && from) motions.push(leave(from, mine));
        Promise.allSettled(motions).then(() => {
          if (mine === generation) clear();
        });
      },
      // 窓の大きさが変わった: 書いている途中なら、新しい頁の大きさで字を組み直して天から書き直す。書き終わりの流れの途中なら、
      // 支度を区切らずに済ませて訳し終えた姿にする（頁の一枚は呼ぶ側が載せ直す）。
      relayout() {
        if (finishTranslation) {
          finishTranslation();
          return;
        }
        const writing = els.book.dataset.writing;
        if (!plan || (writing !== 'moving' && writing !== 'still')) return;
        const headTitle = plan.headTitle;
        this.prepare(headTitle);
        this.start();
      },
      clear
    };
  })();

  // 本文を待つ: 本が開き終えた時点で届いていれば筆を出さない（組んでおいた字は捨てる）。届いていなければ届くまで筆が書く。
  // 届いた本文は showBook が頁に載せ、筆の字を訳す（writer.translate）。届かなかったときは筆が退いて字がほどける。
  // pending は要求を出した時点で作った { promise, settled() }。字は開く前に writer.prepare で組んでおく。
  async function awaitWithBrush(pending) {
    const keep = stay(visit);
    if (pending.settled()) {
      writer.clear();
      return keep(pending.promise);
    }
    writer.start();
    try {
      return await keep(pending.promise);
    } catch (error) {
      writer.release();
      throw error;
    }
  }

  // 要求がもう届いたかを、本が開き終えた時点で同期に読めるようにする。
  function tracked(promise) {
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    return { promise, settled: () => settled };
  }

  // 手の中の表紙: 棚で引き出したときの表紙と同じ look・同じ金の題。
  function setCoverLook(book) {
    const look = bookLook(book.key, book.cover);
    applyLookVars(els.coverFace, look);
    applyLookVars(els.coverLeaf, look);
    els.coverFace.replaceChildren(...coverFaceLayers(book.title, look.frame));
  }

  function leafRect() {
    return els.coverLeaf.getBoundingClientRect();
  }

  // 棚の本の位置と手元（閉じた表紙の位置）とのあいだを動かす。
  async function moveBookBetween(fromBox, toBox, { duration }) {
    const book = els.book;
    const bookBox = book.getBoundingClientRect();
    const leaf = leafRect();
    book.style.transformOrigin = `${leaf.left - bookBox.left}px ${leaf.top - bookBox.top}px`;
    const toTransform = (box) => `translate(${box.left - leaf.left}px, ${box.top - leaf.top}px) scale(${box.width / leaf.width}, ${box.height / leaf.height})`;
    await run(book, [{ transform: fromBox ? toTransform(fromBox) : 'none' }, { transform: toBox ? toTransform(toBox) : 'none' }], { duration });
  }

  async function openCover({ duration = 700 } = {}) {
    if (reduced()) {
      els.book.dataset.open = 'true';
      await run(els.spread, [{ opacity: '0' }, { opacity: '1' }], { duration: REDUCED_FADE_MS });
      els.spread.style.opacity = '';
      return;
    }
    await Promise.all([
      run(els.coverLeaf, [{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(-180deg)' }], { duration }),
      run(els.spread, [{ opacity: '0' }, { opacity: '1' }], { duration: duration / 2, delay: duration * 0.17 })
    ]);
    els.book.dataset.open = 'true';
    els.coverLeaf.style.transform = '';
    els.spread.style.opacity = '';
  }

  // heavy: 禁書の封の気配。灯りの引いた頁の上で、表紙がゆっくり重く閉じる。
  async function closeCover({ heavy = false, duration = 700 } = {}) {
    if (reduced()) {
      await run(els.spread, [{ opacity: '1' }, { opacity: '0' }], { duration: REDUCED_FADE_MS });
      els.book.dataset.open = 'false';
      els.spread.style.opacity = '';
      return;
    }
    els.book.dataset.open = 'false';
    const leafMs = heavy ? 1500 : duration;
    await Promise.all([
      run(els.coverLeaf, [{ transform: 'rotateY(-180deg)' }, { transform: 'rotateY(0deg)' }], { duration: leafMs, easing: heavy ? 'cubic-bezier(0.5, 0, 0.3, 1)' : EASE }),
      run(els.spread, [{ opacity: '1' }, { opacity: '0' }], { duration: heavy ? 700 : duration / 2, delay: heavy ? 800 : duration / 2 })
    ]);
    els.coverLeaf.style.transform = '';
    els.spread.style.opacity = '';
  }

  function resetBookPages() {
    writer.clear();
    els.pageLeft.replaceChildren();
    els.pageRight.replaceChildren();
    delete els.book.dataset.spread;
    delete els.book.dataset.sealed;
    delete els.book.dataset.more;
    els.book.dataset.ink = 'waiting';
    reading.pageNote = null;
  }

  // 本文の待ち: 表紙が開いて、白い見開きの上を筆が走って待ち、届いたら墨の線が字へほどけてインクが頁に浮かび上がる。
  // 開き終えた時点で届いていれば筆は出さない。
  async function openFromShelf(node, book) {
    if (root.dataset.scene !== 'shelf' || reading.busy) return;
    const v = visit;
    const keep = stay(v);
    reading.busy = true;
    root.dataset.scene = 'opening';
    setSlipNote('');
    const request = tracked(deps.read(book.target).then(validateRead));
    request.promise.catch(() => {});
    reading.book = { ...book, shelfNode: node };
    setCoverLook(book);
    resetBookPages();
    els.book.dataset.open = 'false';
    els.close.disabled = true;
    els.reading.hidden = false;
    root.dataset.reading = 'open';
    // 手に取るのは引き出して見えている表紙から（表紙の面の全体の位置。棚の本は引き出したまま隠れる）。
    node.dataset.drawn = 'true';
    const from = node.querySelector('.academy-library-book-cover').getBoundingClientRect();
    node.dataset.taken = 'true';
    try {
      if (!reduced()) await keep(moveBookBetween(from, null, { duration: 600 }));
      els.book.style.transform = '';
      writer.prepare(book.title);
      await keep(openCover());
      root.dataset.scene = 'reading';
      await keep(showBook(await keep(awaitWithBrush(request))));
    } catch (error) {
      if (error instanceof LeftScene || v !== visit) throw new LeftScene();
      if (redirected(error)) return;
      console.error(error);
      // 禁書は封の気配（筆が離れて頁が暗み、表紙が重く閉じる）で棚へ戻り、票の上に題と「今は開けない」を書く。
      // それ以外の失敗は本を開いたまま、白い頁に一文を書く（本を閉じれば同じ向きの逆で棚へ戻る）。
      if (error?.errorCode === GATED_ERROR_CODE) {
        await keep(returnBook({ stamp: false, sealed: true }));
        setSlipNote(gatedLine(book.title));
      } else {
        showReadFailure(READ_FAILED_LINE);
      }
    } finally {
      if (v === visit) {
        reading.busy = false;
        els.close.disabled = false;
      }
    }
  }

  // 本文の見開き割り。頁の大きさは頁の箱（平らに組んだ字の大きさ）から取る。
  function pageHead(result) {
    const head = document.createElement('div');
    head.className = 'academy-library-page-head';
    const title = document.createElement('p');
    title.className = 'academy-library-page-title';
    title.append(glyphText(result.title));
    const category = document.createElement('p');
    category.className = 'academy-library-page-category';
    category.append(glyphText(result.category));
    head.append(title, category, pageRule());
    return head;
  }

  // 頁に書くもの: 最初の頁なら題と層の名前、本文、脚注・頁の一文の置き場の頁ならその後ろに tail。
  function pageContent(page, tail) {
    return [...(page.head ? [pageHead(reading.result)] : []), glyphText(page.text), ...tail];
  }

  // 頁に収まるかを、頁の箱と同じ大きさの見えない枠で測る。枠の大きさは測り始めに一度だけ頁の箱に合わせ、測るたびには中身を
  // 差し替えるだけにする（寸法を読むのは収まりの一回）。測り終えたら中身を残さない: 脚注の題の button を枠に置いたままにしない。
  // reach は、本文を頁の頭から一度だけ組んで、頁の底に収まる字までの長さ（text の頭から）を字の下端から見積もる。
  // measureWith は測りを区切りごとに yield する generator で、その区切りをそのまま渡す（枠は最後の区切りまで頁の箱の寸法のまま）。
  function* measuringPage(measureWith) {
    const measure = els.measure;
    const height = els.pageLeft.offsetHeight;
    measure.style.width = `${els.pageLeft.offsetWidth}px`;
    measure.style.height = `${height}px`;
    const page = {
      fits(nodes) {
        measure.replaceChildren(...nodes);
        return measure.scrollHeight <= height + 0.5;
      },
      reach(withHead, text) {
        measure.replaceChildren(...pageContent({ head: withHead, text }, []));
        const glyphs = measure.querySelectorAll(':scope > .academy-library-glyph');
        const last = glyphs[glyphs.length - 1];
        // 組みの下端（scrollHeight）は最後の字の下端より行の余白のぶん深い。その差をどの字にも足して、頁の底と比べる。
        const below = measure.scrollHeight - (last.offsetTop + last.offsetHeight);
        let length = 0;
        let k = 0;
        for (const char of text) {
          if (char !== '\n') {
            const glyph = glyphs[k];
            k += 1;
            if (glyph.offsetTop + glyph.offsetHeight + below > height + 0.5) break;
          }
          length += char.length;
        }
        return length;
      }
    };
    try {
      return yield* measureWith(page);
    } finally {
      measure.replaceChildren();
    }
  }

  // 頁に収まる本文の長さ（text の頭から）。見積もり（page.reach）から一字・二字・四字…と広げて収まる長さと収まらない長さで挟み、
  // 挟んだ間を二分して境を決める。一回組んで測るごとに yield する。
  function* largestFit(page, text, withHead) {
    const fits = function* (count) {
      if (count === 0) return true;
      const fit = page.fits(pageContent({ head: withHead, text: text.slice(0, count) }, []));
      yield;
      return fit;
    };
    const guess = page.reach(withHead, text);
    yield;
    let lo = 0;
    let hi = text.length;
    if (yield* fits(guess)) {
      lo = guess;
      for (let step = 1; lo < hi; step *= 2) {
        const next = Math.min(hi, lo + step);
        if (!(yield* fits(next))) {
          hi = next - 1;
          break;
        }
        lo = next;
      }
    } else {
      hi = guess - 1;
      for (let step = 1; lo < hi; step *= 2) {
        const next = Math.max(lo, guess - step);
        if (yield* fits(next)) {
          lo = next;
          break;
        }
        hi = next - 1;
      }
    }
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (yield* fits(mid)) lo = mid;
      else hi = mid - 1;
    }
    // 行の途中で切れるときは、直前の句点・改行までさかのぼる（さかのぼりは 40 字まで）。
    if (lo < text.length) {
      const cut = Math.max(text.lastIndexOf('。', lo - 1), text.lastIndexOf('\n', lo - 1));
      if (cut >= 0 && lo - cut <= 40) return cut + 1;
    }
    return lo;
  }

  function* paginate(result) {
    return yield* measuringPage(function* (page) {
      const pages = [];
      let rest = result.text.trim();
      while (rest.length) {
        const withHead = pages.length === 0;
        const count = yield* largestFit(page, rest, withHead);
        if (count === 0) throw new Error('library screen: a page holds no text (page box too small)');
        pages.push({ head: withHead, text: rest.slice(0, count) });
        rest = rest.slice(count).replace(/^\n+/, '');
      }
      return pages;
    });
  }

  // ── 脚注（関連する本）と頁の一文: 本文の終わりの下に細い線、控えめな見出し、題を頁と同じインクの字で並べる ─────────────
  function setFootnotes(state, references) {
    reading.footnotes = { state, references };
    els.book.dataset.footnotes = state;
  }

  // 頁の紙の上のインクの一文（脚注の待ち・失敗、綴じられなかった本文、移れなかった本）。箱や帯には入れない。
  function pageNoteLine(text) {
    const line = document.createElement('p');
    line.className = 'academy-library-page-note';
    line.setAttribute('role', 'status');
    line.append(glyphText(text));
    return line;
  }

  function footnoteItem(reference) {
    const item = document.createElement('li');
    item.className = 'academy-library-footnotes-item';
    item.dataset.readable = String(reference.readable);
    if (!reference.readable) {
      // 禁書: 題を淡いインクで書き、「今は開けない」を字で添えるだけ。押しても開かない。
      const title = document.createElement('span');
      title.className = 'academy-library-footnote-sealed';
      title.append(glyphText(reference.title));
      const note = document.createElement('span');
      note.className = 'academy-library-footnote-sealed-note';
      note.append(glyphText(GATED_NOTE));
      item.append(title, note);
      return item;
    }
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'academy-library-footnote-link';
    link.dataset.kind = reference.book_id === null ? 'generated' : 'catalog';
    link.append(glyphText(reference.title));
    link.addEventListener('click', () => { followFootnote(reference).catch(quietly); });
    item.append(link);
    return item;
  }

  // 待つ間は画面の中の待ちの印（右下で待ちの紋が回る）、確定は見出しと題の並び、失敗は見出しと一文と「再試行」。0 件は脚注を書かない。
  function buildFootnotes() {
    const { state, references } = reading.footnotes;
    if (state === 'idle' || (state === 'ready' && references.length === 0)) return null;
    const section = document.createElement('section');
    section.className = 'academy-library-footnotes';
    section.dataset.state = state;
    section.append(pageRule());
    if (state === 'pending') {
      section.append(deps.waitMark());
      return section;
    }
    const heading = document.createElement('p');
    heading.className = 'academy-library-footnotes-heading';
    heading.append(glyphText(FOOTNOTES_HEADING));
    section.append(heading);
    if (state === 'failed') {
      const line = pageNoteLine(FOOTNOTES_FAILED_LINE);
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'academy-library-page-retry';
      retry.append(glyphText(FOOTNOTES_RETRY_LABEL));
      retry.addEventListener('click', () => {
        reading.generation += 1;
        setFootnotes('pending', []);
        refreshTail();
        requestFootnotes(reading.result, reading.generation);
      });
      line.append(retry);
      section.append(line);
      return section;
    }
    const list = document.createElement('ul');
    list.className = 'academy-library-footnotes-list';
    list.append(...references.map(footnoteItem));
    section.append(list);
    return section;
  }

  function buildTail() {
    const footnotes = buildFootnotes();
    return [...(footnotes ? [footnotes] : []), ...(reading.pageNote ? [pageNoteLine(reading.pageNote)] : [])];
  }

  // 脚注と頁の一文は本文の終わりの頁の下に書き、収まらなければ次の頁の頭に書く。見開きは頁の対で、足りない頁は白い頁。
  function placeTail() {
    const body = reading.body;
    const last = body.length - 1;
    const tail = buildTail();
    let at = null;
    if (tail.length) {
      at = Math.max(0, last);
      if (last >= 0 && !drain(measuringPage(function* (page) { return page.fits(pageContent(body[last], tail)); }))) at = last + 1;
    }
    const pages = body.slice();
    while (pages.length < (at ?? -1) + 1 || pages.length % 2 === 1) pages.push({ head: false, text: '' });
    reading.pages = pages;
    reading.tail = at;
    reading.spread = Math.max(0, Math.min(reading.spread, spreadCount() - 1));
  }

  function renderPageInto(pageEl, index) {
    pageEl.replaceChildren();
    const page = reading.pages[index];
    if (!page) return;
    const ink = document.createElement('div');
    ink.className = 'academy-library-page-ink';
    ink.append(...pageContent(page, index === reading.tail ? buildTail() : []));
    pageEl.append(ink);
  }

  function drawPage(pageEl, index, side) {
    renderPageInto(pageEl, index);
    layPageOnPaper(pageEl, side);
  }

  // 見開きを書いて紙に載せる。頁を組んだ後と紙に載せた後に yield する（組んだ字の寸法は次の区切りで読む）。
  function* renderingSpread() {
    const index = reading.spread;
    for (const [pageEl, page, side] of [[els.pageLeft, index * 2, 'left'], [els.pageRight, index * 2 + 1, 'right']]) {
      renderPageInto(pageEl, page);
      yield;
      layPageOnPaper(pageEl, side);
      yield;
    }
    els.book.dataset.spread = String(index);
    els.book.dataset.spreads = String(spreadCount());
    // 続きの手掛かり: 見開きが二つ以上ある本の一つ目の見開きだけ、右の頁の小口に残りの頁の重なりが見え、右下の角がわずかに反る。
    els.book.dataset.more = String(index === 0 && spreadCount() >= 2);
  }

  function renderSpread() {
    drain(renderingSpread());
  }

  // 脚注・頁の一文が変わったら置き場を決め直し、いまの見開きを書き直す（めくっている間は、めくり終わりに書き直す）。
  function refreshTail() {
    placeTail();
    if (root.dataset.scene !== 'turning') renderSpread();
  }

  // 本文を頁に載せる: 割り付け → 脚注の置き場 → 見開きを紙に載せる → 脚注の要求。筆が書いていたら、この支度を書き終わりの流れ
  // の振りかぶりの間に区切って進め、筆の字を頁の字へ訳し、訳し終えたら落着する promise を返す（筆が書いていなければ、支度を
  // 区切らずに進め、インクが頁に浮かび、null を返す）。
  function showBook(result) {
    reading.result = result;
    reading.generation += 1;
    reading.pageNote = null;
    setFootnotes('pending', []);
    const generation = reading.generation;
    const laying = (function* () {
      reading.body = yield* paginate(result);
      reading.spread = 0;
      placeTail();
      yield;
      yield* renderingSpread();
    })();
    // 脚注は頁が読めるようになってから頼む: 届いた脚注は見開きを書き直すので、訳しの間に頁の一行ずつの墨を差し替えない。
    if (writer.moving()) return writer.translate(laying).then(() => { requestFootnotes(result, generation); });
    try {
      drain(laying);
    } finally {
      writer.release();
    }
    requestFootnotes(result, generation);
    requestAnimationFrame(() => { els.book.dataset.ink = 'ready'; });
    return null;
  }

  // 本文を綴じられなかった・禁書だった（関連する本）: 本は開いたまま、白い頁に一文だけが浮かぶ。
  function showReadFailure(line) {
    reading.result = null;
    reading.body = [];
    reading.spread = 0;
    reading.generation += 1;
    reading.pageNote = line;
    setFootnotes('idle', []);
    placeTail();
    renderSpread();
    requestAnimationFrame(() => { els.book.dataset.ink = 'ready'; });
  }

  async function requestFootnotes(result, generation) {
    const v = visit;
    const isCurrent = () => v === visit && reading.generation === generation && reading.result === result && !els.reading.hidden;
    try {
      const payload = await deps.footnotes(result.entryId);
      const references = parseLibraryFootnotes(payload, { entryId: result.entryId, layer: result.layer });
      if (!isCurrent()) return;
      setFootnotes('ready', references);
    } catch (error) {
      if (!isCurrent()) return;
      console.error(error);
      setFootnotes('failed', []);
    }
    refreshTail();
  }

  // 関連する本へ: 題を押した瞬間に次の本の本文を頼み、書き上がりを待たずに移る。いまの頁のインクが引き（INK_RECEDE_MS）、
  // 本が閉じ（RELATE_CLOSE_MS）、表紙の題がいまの本の題から次の本の題へ書き直され（TITLE_MORPH_MS）、本が開く
  // （RELATE_OPEN_MS）。その間も本文の書き上げは裏で進み、開き終えてまだ届いていなければ筆が走って待つ。届かなかったら、開いた
  // 次の本の頁に一文（禁書は「「題」今は開けない」）を書く。
  const INK_RECEDE_MS = 300;
  const RELATE_CLOSE_MS = 600;
  const TITLE_MORPH_MS = 1000;
  const RELATE_OPEN_MS = 600;

  async function followFootnote(reference) {
    if (reading.busy || root.dataset.scene !== 'reading') return;
    const target = libraryFootnoteReadTarget(reference);
    const request = tracked(deps.read(target).then(validateRead));
    request.promise.catch(() => {});
    const v = visit;
    const keep = stay(v);
    reading.busy = true;
    root.dataset.scene = 'relating';
    els.close.disabled = true;
    const next = { key: reference.book_id ?? `generated:${reference.title}`, title: reference.title, cover: reference.layer, target, shelfNode: null };
    try {
      await keep(recedeInk());
      await keep(closeCover({ duration: RELATE_CLOSE_MS }));
      // 手放した本は棚の元の場所へ戻しておく（棚は本の後ろの暗がりにある）。
      const previousNode = reading.book?.shelfNode;
      if (previousNode && previousNode.isConnected) {
        previousNode.dataset.taken = 'false';
        delete previousNode.dataset.drawn;
      }
      reading.book = next;
      reading.result = null;
      resetBookPages();
      await keep(morphCoverTitle(next));
      writer.prepare(next.title);
      await keep(openCover({ duration: RELATE_OPEN_MS }));
      root.dataset.scene = 'reading';
      await keep(showBook(await keep(awaitWithBrush(request))));
    } catch (error) {
      if (error instanceof LeftScene || v !== visit) throw new LeftScene();
      if (redirected(error)) return;
      console.error(error);
      if (els.book.dataset.open !== 'true') await keep(openCover({ duration: RELATE_OPEN_MS }));
      showReadFailure(error?.errorCode === GATED_ERROR_CODE ? gatedLine(reference.title) : READ_FAILED_LINE);
    } finally {
      if (v === visit) {
        reading.busy = false;
        els.close.disabled = false;
        root.dataset.scene = 'reading';
      }
    }
  }

  // いまの頁のインクが紙へ引く。
  async function recedeInk() {
    const inks = [...els.spread.querySelectorAll(':scope > .academy-library-page > .academy-library-page-ink')];
    await Promise.all(inks.map((ink) => run(ink, [{ opacity: '1', filter: 'blur(0)' }, { opacity: '0', filter: 'blur(0.3vh)' }], { duration: reduced() ? REDUCED_FADE_MS : INK_RECEDE_MS })));
    els.book.dataset.ink = 'waiting';
  }

  // 題の字を一字ずつの span に分ける（表紙の題の書き直しで一字ずつほどけ・書かれるため。組みは変わらない）。
  function coverGlyphs(titleEl) {
    const walker = document.createTreeWalker(titleEl, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    for (const text of texts) {
      const fragment = document.createDocumentFragment();
      for (const char of text.data) {
        const glyph = document.createElement('span');
        glyph.className = 'academy-library-cover-glyph';
        glyph.textContent = char;
        fragment.append(glyph);
      }
      text.replaceWith(fragment);
    }
    return [...titleEl.querySelectorAll('.academy-library-cover-glyph')];
  }

  // 閉じた表紙の上で、いまの本の金の題が墨のようにほどけて消え、表紙が次の本の姿へ移りながら、次の本の題が天から一字ずつ
  // 書かれる。終わったら表紙は次の本の姿（setCoverLook と同じもの）になっている。
  async function morphCoverTitle(book) {
    const nextFace = document.createElement('div');
    nextFace.className = 'academy-library-cover-face';
    const look = bookLook(book.key, book.cover);
    applyLookVars(nextFace, look);
    const [nextPaint, nextTitle] = coverFaceLayers(book.title, look.frame);
    nextFace.append(nextPaint, nextTitle);
    els.coverLeaf.insertBefore(nextFace, els.exLibris);
    try {
      if (reduced()) {
        await run(nextFace, [{ opacity: '0' }, { opacity: '1' }], { duration: TITLE_MORPH_MS / 2 });
      } else {
        const oldGlyphs = coverGlyphs(els.coverFace.querySelector('.academy-library-cover-title'));
        const newGlyphs = coverGlyphs(nextTitle);
        for (const glyph of newGlyphs) glyph.style.opacity = '0';
        const unravel = TITLE_MORPH_MS * 0.45;
        const write = TITLE_MORPH_MS * 0.3;
        await Promise.all([
          ...oldGlyphs.map((glyph, index) => run(glyph, [
            { opacity: '1', filter: 'blur(0)', transform: 'translate(0, 0)' },
            { opacity: '0', filter: 'blur(0.12em)', transform: 'translate(-0.06em, 0.18em)' }
          ], { duration: unravel, delay: (index / oldGlyphs.length) * TITLE_MORPH_MS * 0.15, easing: 'ease-in' })),
          run(nextFace, [{ opacity: '0' }, { opacity: '1' }], { duration: TITLE_MORPH_MS * 0.6, delay: TITLE_MORPH_MS * 0.15 }),
          ...newGlyphs.map((glyph, index) => run(glyph, [
            { opacity: '0', filter: 'blur(0.12em)' },
            { opacity: '1', filter: 'blur(0)' }
          ], { duration: write, delay: TITLE_MORPH_MS * 0.4 + (index / newGlyphs.length) * (TITLE_MORPH_MS * 0.6 - write) }))
        ]);
      }
      setCoverLook(book);
    } finally {
      nextFace.remove();
    }
  }

  // ── めくる: 一枚の頁が背を軸に返る（0.7 秒）。スクロールはしない ───────────────────────────────────
  // めくる一枚の表は右頁の紙、裏は左頁の紙。面の中に見開きと同じ大きさ・同じ絵の置き方の紙（.academy-library-turn-paper）を
  // 敷き、静止した頁と同じ箱の頁を載せるので、改行・字の大きさと遠近・綴じ目の反りはその頁と同じになり、めくり始めと着地で
  // 字が動かない。
  function buildTurnFace(className, index, side) {
    const face = document.createElement('div');
    face.className = `academy-library-turn-face ${className}`;
    const paper = document.createElement('div');
    paper.className = 'academy-library-turn-paper';
    const pageEl = document.createElement('div');
    pageEl.className = `academy-library-page academy-library-page-${side}`;
    renderPageInto(pageEl, index);
    paper.append(pageEl);
    face.append(paper);
    return face;
  }

  function layTurnFaces() {
    for (const pageEl of els.spread.querySelectorAll('.academy-library-turn-paper > .academy-library-page')) {
      layPageOnPaper(pageEl, pageEl.classList.contains('academy-library-page-right') ? 'right' : 'left');
    }
  }

  async function turn(direction) {
    if (reading.busy || root.dataset.scene !== 'reading' || !reading.result) return;
    const target = reading.spread + (direction === 'forward' ? 1 : -1);
    if (target < 0 || target >= spreadCount()) return;
    const v = visit;
    reading.busy = true;
    root.dataset.scene = 'turning';
    const current = reading.spread;
    try {
      if (reduced()) {
        reading.spread = target;
        renderSpread();
        await Promise.all([els.pageLeft, els.pageRight].map((page) => run(page, [{ opacity: '0' }, { opacity: '1' }], { duration: REDUCED_FADE_MS })));
      } else {
        const leaf = document.createElement('div');
        leaf.className = 'academy-library-turn';
        leaf.dataset.direction = direction;
        els.book.dataset.more = 'false';
        if (direction === 'forward') {
          leaf.append(buildTurnFace('academy-library-turn-front', current * 2 + 1, 'right'), buildTurnFace('academy-library-turn-back', target * 2, 'left'));
          drawPage(els.pageRight, target * 2 + 1, 'right');
        } else {
          leaf.append(buildTurnFace('academy-library-turn-front', target * 2 + 1, 'right'), buildTurnFace('academy-library-turn-back', current * 2, 'left'));
          drawPage(els.pageLeft, target * 2, 'left');
        }
        els.spread.append(leaf);
        layTurnFaces();
        reading.spread = target;
        const [from, to] = direction === 'forward' ? ['rotateY(0deg)', 'rotateY(-180deg)'] : ['rotateY(-180deg)', 'rotateY(0deg)'];
        try {
          await run(leaf, [{ transform: from }, { transform: to }], { duration: 700 });
        } finally {
          leaf.remove();
        }
      }
      // めくっている間に脚注が届いていても、めくり終わりの見開きに書かれる。
      renderSpread();
    } finally {
      if (v === visit) {
        reading.busy = false;
        root.dataset.scene = 'reading';
      }
    }
  }

  // ── 閉じる: 表紙を閉じ、蔵書票が押されて琥珀の光、本は棚へ戻る ──────────────────────────────────────
  async function stampExLibris() {
    if (reduced()) {
      await run(els.exLibris, [{ opacity: '0' }, { opacity: '1' }], { duration: REDUCED_FADE_MS });
      await stay(visit)(sleep(400));
      return;
    }
    await Promise.all([
      run(els.exLibris, [
        { opacity: '0', transform: 'translate(-50%, -50%) scale(1.35)' },
        { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' }
      ], { duration: 520 }),
      run(els.coverLeaf, [
        { boxShadow: '1.2vh 2vh 3vh rgb(0 0 0 / 0.65), 0 0 0 rgb(229 180 90 / 0)' },
        { boxShadow: '1.2vh 2vh 3vh rgb(0 0 0 / 0.65), 0 0 6vh rgb(229 180 90 / 0.75)', offset: 0.45 },
        { boxShadow: '1.2vh 2vh 3vh rgb(0 0 0 / 0.65), 0 0 0 rgb(229 180 90 / 0)' }
      ], { duration: 820 })
    ]);
    els.coverLeaf.style.boxShadow = '';
  }

  // sealed: 禁書の封の気配（筆が離れて頁が暗み、表紙が重く閉じ、本はゆっくり棚へ戻る）。頁の明るさと本の動きだけで、印は描かない。
  async function returnBook({ stamp, sealed = false }) {
    const keep = stay(visit);
    root.dataset.scene = 'closing';
    if (sealed) {
      els.book.dataset.sealed = 'true';
      if (!reduced()) await keep(sleep(700));
    }
    if (els.book.dataset.open === 'true') await keep(closeCover({ heavy: sealed }));
    if (stamp) await keep(stampExLibris());
    const node = reading.book?.shelfNode;
    root.dataset.reading = 'closing';
    if (node && node.isConnected) {
      // 引き出したままの棚の本の表紙の位置へ戻し、そこから同じ向きの逆で棚へ収まる（指が乗っていれば引き出したまま）。
      const to = node.querySelector('.academy-library-book-cover').getBoundingClientRect();
      if (!reduced()) await keep(moveBookBetween(null, to, { duration: sealed ? 1000 : 600 }));
      node.dataset.taken = 'false';
      if (sealed || !node.matches(':hover')) delete node.dataset.drawn;
    } else if (!reduced()) {
      // 棚に無い本（栞から来た本）は奥の暗がりへ戻る。
      const vp = vanishingPoint();
      await keep(moveBookBetween(null, { left: vp.x, top: vp.y, width: 4, height: 5 }, { duration: 900 }));
    }
    hideReading();
    root.dataset.scene = 'shelf';
  }

  function hideReading() {
    writer.clear();
    els.reading.hidden = true;
    els.book.style.transform = '';
    els.book.style.transformOrigin = '';
    els.exLibris.style.opacity = '';
    els.exLibris.style.transform = '';
    delete els.book.dataset.sealed;
    delete els.book.dataset.more;
    delete root.dataset.reading;
    reading.generation += 1;
    reading.book = null;
    reading.result = null;
    reading.body = [];
    reading.pages = [];
    reading.tail = null;
    reading.pageNote = null;
    setFootnotes('idle', []);
  }

  async function closeBook() {
    if (reading.busy || root.dataset.scene !== 'reading') return;
    const v = visit;
    reading.busy = true;
    els.close.disabled = true;
    try {
      // 綴じられなかった本（本文の無い本）は収蔵されていないので、蔵書票を押さずに戻す。
      await returnBook({ stamp: reading.result !== null });
    } finally {
      if (v === visit) {
        reading.busy = false;
        els.close.disabled = false;
      }
    }
  }

  // ── 退出: 灯りが手前から奥へ順に落ち（約 1.2 秒）、ロードの被覆を経てハブへ戻る ─────────────────────
  async function leaveLibrary() {
    if (!['arrival', 'shelf'].includes(root.dataset.scene)) return;
    const v = visit;
    const keep = stay(v);
    const previousScene = root.dataset.scene;
    root.dataset.scene = 'exiting';
    dust.fadeOut();
    const lamps = [...els.lamps.children];
    const step = reduced() ? 0 : 1200 / (LAMP_DEPTHS + 1);
    for (let depth = 0; depth <= LAMP_DEPTHS; depth += 1) {
      for (const lamp of lamps) {
        const lampDepth = lamp.dataset.depth === undefined ? LAMP_DEPTHS : Number(lamp.dataset.depth);
        if (lampDepth === depth) lamp.dataset.out = 'true';
      }
      if (step) await keep(sleep(step));
    }
    await run(els.deskLight, [{ opacity: getComputedStyle(els.deskLight).opacity }, { opacity: '0' }], { duration: reduced() ? REDUCED_FADE_MS : 500 });
    root.dataset.scene = 'exited';
    try {
      await deps.leave();
    } catch (error) {
      // 出られなかったときは灯りを戻して、元の場面に留まる。
      if (v !== visit) throw error;
      for (const lamp of lamps) delete lamp.dataset.out;
      els.deskLight.style.opacity = '';
      dust.start();
      root.dataset.scene = previousScene;
      throw error;
    }
  }

  // ── 配線 ─────────────────────────────────────────────────────────────────────────────────────
  els.slip.addEventListener('submit', (event) => {
    event.preventDefault();
    handOver().catch(quietly);
  });
  els.slipInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      handOver().catch(quietly);
    }
  });
  els.exit.addEventListener('click', () => { leaveLibrary().catch(quietly); });
  els.close.addEventListener('click', () => { closeBook().catch(quietly); });
  // 頁を押すとめくる。脚注の中を押したとき・字を選んだときはめくらない。
  const turnsPage = (event) => !event.target.closest('.academy-library-footnotes') && window.getSelection().isCollapsed;
  els.pageRight.addEventListener('click', (event) => { if (turnsPage(event)) turn('forward').catch(quietly); });
  els.pageLeft.addEventListener('click', (event) => { if (turnsPage(event)) turn('backward').catch(quietly); });
  document.addEventListener('keydown', (event) => {
    if (!isActive() || els.reading.hidden) return;
    if (event.key === 'ArrowRight') turn('forward').catch(quietly);
    if (event.key === 'ArrowLeft') turn('backward').catch(quietly);
  });
  window.addEventListener('resize', () => {
    if (!isActive()) return;
    placeDeskLight();
    dust.resize();
    layShelf();
    if (!els.reading.hidden) {
      writer.relayout();
      layPageOnPaper(els.pageLeft, 'left');
      layPageOnPaper(els.pageRight, 'right');
      layTurnFaces();
    }
  });
  // 画面の倍率が変わった（窓を倍率の違う画面へ移した）: 頁の墨の一枚を新しい倍率で載せ直す。
  const watchResolution = () => {
    matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener('change', () => {
      watchResolution();
      if (!isActive() || els.reading.hidden) return;
      layPageOnPaper(els.pageLeft, 'left');
      layPageOnPaper(els.pageRight, 'right');
      layTurnFaces();
    }, { once: true });
  };
  watchResolution();

  // 画面を離れる: 走り残った流れを止め、塵を止める。次の enter で最初の姿から組み直す。
  function suspend() {
    visit += 1;
    writer.clear();
    dust.stop();
    cancelMotion();
  }

  // ── 到着: 絵は動かさず、奥の灯りがゆっくり明るみ、光の筋の中を塵が漂う ───────────────────────────
  async function enter() {
    suspend();
    const v = visit;
    searchInFlight = false;
    reading.busy = false;
    hideReading();
    els.book.dataset.open = 'false';
    els.book.dataset.ink = 'waiting';
    els.pageLeft.replaceChildren();
    els.pageRight.replaceChildren();
    els.close.disabled = false;
    shelfState.books = [];
    shelfState.nodes = [];
    shelfState.lays = [];
    els.shelf.replaceChildren();
    delete els.shelf.dataset.leaving;
    els.slipInput.value = '';
    els.slipInput.disabled = false;
    els.slipHand.disabled = false;
    els.slip.inert = false;
    setSlipNote('');
    delete root.dataset.arrived;
    root.dataset.scene = 'arrival';
    buildLamps();
    placeDeskLight();
    dust.start();
    if (!reduced()) {
      run(els.lamps, [{ opacity: '0' }, { opacity: '1' }], { duration: 2600 }).catch(quietly);
      run(els.dust, [{ opacity: '0' }, { opacity: '1' }], { duration: 2600 }).catch(quietly);
    }
    try {
      // 表紙の面の絵（COVER_FACES）は最初の訪れで一度だけ組み、組み上がるまで書庫を開けない。
      coverFaces ??= layCoverFaces(root);
      await Promise.all([deps.loadArrival(), coverFaces]);
    } catch (error) {
      if (v !== visit) return;
      if (redirected(error)) return;
      console.error(error);
      // 通常の遊びの経路では起きない。起きたときは票の上の一文で止める（票は渡せない）。
      els.slip.inert = true;
      setSlipNote(ARRIVAL_FAILED_LINE);
      return;
    }
    if (v !== visit) return;
    root.dataset.arrived = 'true';
  }

  return { enter, suspend };
}
