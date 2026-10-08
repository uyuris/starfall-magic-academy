// 大書庫の画面（#academy-library-screen）の場面と動き。
// 場面: 到着 → 問いを渡す → 待つ → 本が並ぶ → 指を乗せる → 手に取って開く → めくる → 関連する本へ → 閉じる → 退出。
// 画面の状態は section の data-scene（と data-reading・本の data-open / data-ink / data-spread）に出す。
//
// 行き先との配線（到着の GET・退出のロードの被覆・BGM）と、LM の設定・接続の失敗を設定画面へ誘導すること、本文 read の
// flight guard、要求そのもの（postJson / getJson）は app.js が持ち、createLibraryScreen の引数で受け取る。この module は
// 画面の中の場面と動きだけを持つ。失敗は場所の中の短い一文（票か頁の紙の上のインクの字）で見せ、server の内部文は
// console へだけ渡す。
import { parseLibraryFootnotes, libraryFootnoteReadTarget } from './libraryFootnotesClient.js';

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
  const heightF = cover === 'core' ? between(0.9, 0.98) : between(0.86, 0.97);
  // 背の幅は絵の中の本の幅（絵の幅の約 1.4〜1.7%）の中で本ごとに決まり、題の長さでは変わらない。
  const spineW = between(1.48, 1.74);
  const spineGap = between(0.02, 0.12);
  const lightAngle = between(118, 152).toFixed(0);
  const lightA = between(0.08, 0.3).toFixed(2);
  const bgSize = Number(between(104, 116).toFixed(0));
  const bgX = Number(between(20, 80).toFixed(0));
  const bgY = Number(between(20, 80).toFixed(0));
  const light = {
    '--light-angle': `${lightAngle}deg`,
    '--light-a': lightA,
    '--bg-size': `${bgSize}%`,
    '--bg-pos': `${bgX}% ${bgY}%`
  };
  // 表紙の絵の置き方（--bg-size・--bg-pos と同じ値）。題はこれで面の上へ写した内側の枠の真ん中に置く。
  const frame = (image) => ({ image, size: bgSize / 100, x: bgX / 100, y: bgY / 100 });
  if (cover === 'generated') {
    const b = bindingLook(r, between, pick);
    return {
      heightF,
      spineW,
      spineGap,
      frame: frame(b.image),
      piece: b.piece === null ? 'none' : (b.ink === SUMI_INK ? 'sumi' : 'gold'),
      vars: {
        '--cover': b.cover,
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
    heightF,
    spineW,
    spineGap,
    frame: frame(cover),
    piece: 'none',
    vars: {
      '--cover': COVER_IMAGES[cover],
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
const LAMPS = [
  { x: 5.0, y: 50.2, size: 8, depth: 0 },
  { x: 41.0, y: 50.3, size: 6.5, depth: 0 },
  { x: 11.8, y: 49.9, size: 5.4, depth: 1 },
  { x: 35.4, y: 50.3, size: 5, depth: 1 },
  { x: 13.5, y: 50.1, size: 4, depth: 2 },
  { x: 31.3, y: 50.5, size: 3.6, depth: 2 },
  { x: 14.9, y: 50.5, size: 3, depth: 3 },
  { x: 22.3, y: 44.2, size: 3.2, depth: 4 },
  { x: 20.8, y: 28.2, size: 3.4 },
  { x: 23.5, y: 28.6, size: 3.8 },
  { x: 26.2, y: 27.8, size: 3.4 },
  { x: 75.5, y: 59.5, size: 7 }
];
const LAMP_DEPTHS = 5;
const SEEK_CYCLE_MS = 6000;

// ── 棚: 書庫の絵の中の棚の段に並べる ─────────────────────────────────────────────────────────────────
// 右の棚は通路と並行に立ち、一点透視で奥（消失点・絵の 23.2% / 50%）へ退く壁の面にある。本の背はその面の上の、縦の縁が
// 鉛直で天地の縁が消失点へ向かう四辺形で、奥（左）ほど低く細い。段の値はどれも stage.jpg の上で線分として実測したもの
// （絵の幅に対する %・絵は正方形）: x は左右の柱のあいだ（reach は本を置ける右端）、top は上の棚板の下の縁、bottom は本の
// 足もと（棚板の奥の縁）で、どちらも [左の柱, 右の柱] での値。lean は背の縦の縁の傾き（度・正は上が左）、squeeze は背の
// 幅の倍率 [左の柱, 右の柱]（絵の本の幅は消失点からの距離の 0.87 乗で詰まる。倍率 1 は x=95.5% の幅）。pull は引き出す向き
// [横, 縦]（引き出す量 1 あたり・絵の上）: 棚の面に垂直な向きは、奥の壁の横の線が水平（実測 0.5〜0.75°）なので真左の -1、
// そこへ手前（下）へ寄せる 0.2 を足す。
// 絵の中で手前にあるもの（卓上ランプ・その引き紐・梯子・机・机の上の本の山・四隅の飾り）に重ならず、1440×900 と
// 1920×1080 のどちらでも画面に収まる段だけを選んである。並べた段は奥の暗がりで埋め（絵の本は退く）、そこへ本を立てる。
// 段は背の高い順（長い題の本から置き場を選ぶ）。
const SHELF_BAYS = [
  { x: [90.7, 100], reach: 99.2, top: [58.74, 59.47], bottom: [72.0, 74.89], lean: -0.25, squeeze: [0.942, 1.054], pull: [-1, 0.2] },
  { x: [90.7, 100], reach: 99.2, top: [45.02, 44.08], bottom: [57.29, 57.9], lean: -0.25, squeeze: [0.942, 1.054], pull: [-1, 0.2] },
  { x: [79.2, 88.7], reach: 88.6, top: [34.94, 32.48], bottom: [45.97, 45.01], lean: -0.25, squeeze: [0.801, 0.918], pull: [-1, 0.2] },
  { x: [70.45, 74.4], reach: 74.3, top: [37.39, 36.37], bottom: [46.07, 45.58], lean: -0.25, squeeze: [0.691, 0.741], pull: [-1, 0.2] },
  { x: [63.15, 69.2], reach: 69.1, top: [56.34, 56.84], bottom: [64.91, 66.7], lean: -0.25, squeeze: [0.597, 0.675], pull: [-1, 0.2] },
  { x: [63.15, 69.2], reach: 69.1, top: [47.76, 47.18], bottom: [55.44, 55.84], lean: -0.25, squeeze: [0.597, 0.675], pull: [-1, 0.2] },
  { x: [63.15, 69.2], reach: 69.1, top: [39.29, 37.72], bottom: [46.82, 46.18], lean: -0.5, squeeze: [0.597, 0.675], pull: [-1, 0.2] },
  { x: [82.6, 88.7], reach: 88.6, top: [61.74, 62.22], bottom: [68.96, 70.59], lean: -0.25, squeeze: [0.843, 0.918], pull: [-1, 0.2] }
];
// 背の寸法（絵の幅に対する %）: 題の字の天地の余白。背の幅は本ごとの look.spineW に段の squeeze を掛けたもの（題の長さでは
// 変わらない）。題は背に一列で置く。字の大きさは CSS の --library-spine-font で、一列に収まらない題（目録の長い題）だけ字を
// 小さくする。小さくできるのは TITLE_MIN_SCALE まで（それより小さい字は棚を見渡して読めない）。
const SPINE_PAD_Y = 0.45;
const TITLE_MIN_SCALE = 0.72;
// 引き出す: 本は段の pull の向きへ、背の右の縁の丈の PULL_REACH 倍だけ引き出され、PULL_SCALE に近づく。
// 横に出た分だけ、右隣の本の陰から表紙の面（開くときの表紙と同じ縦横比 COVER_ASPECT の面）が見えてくる。
const PULL_REACH = 0.44;
const PULL_SCALE = 1.03;
// 開くときの表紙（.academy-library-cover-leaf: 本の幅 74vh×1.699 の 47%、高さ 74vh の 99%）の横÷縦。
const COVER_ASPECT = (74 * 1.699 * 0.47) / (74 * 0.99);
const SHELVE_REACH = 1.6;

function lineAt(xs, ys, x) {
  return ys[0] + ((ys[1] - ys[0]) * (x - xs[0])) / (xs[1] - xs[0]);
}

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

// 題を一列に書いたときの長さ（絵の幅に対する %・字の大きさはそのまま）。画面の字そのもので測る。
function titleLength(measure, title, artPx) {
  fillSpineTitle(measure, title);
  return (measure.getBoundingClientRect().height / artPx) * 100;
}

// 段の丈（絵の %）: 左右の柱での丈の小さいほう。
function bayHeight(bay) {
  return Math.min(bay.bottom[0] - bay.top[0], bay.bottom[1] - bay.top[1]);
}

// 段への置き方。本を置けるのは、その本の姿（heightF）の背で題が下限の字（TITLE_MIN_SCALE）に収まる段だけ（fits[本][段]。段は
// 背の高い順なので、収まる段は先頭からの連なり）。置ける段の少ない本（同じなら題の長い本）から順に、背の高い段を先に試し、
// 行き詰まれば戻って置き直す。段に入るかは段の右端の幅（いちばん太い squeeze）で見積もるので、段の中を届いた順に並べ直しても
// reach を越えない。どう置いても入りきらないときだけ null。返すのは段ごとの本の index（届いた順）。
function assignBays(fits, looks, lengths) {
  const rooms = SHELF_BAYS.map((bay) => bay.reach - bay.x[0]);
  const widest = SHELF_BAYS.map((bay) => bay.squeeze[1]);
  const used = SHELF_BAYS.map(() => 0);
  const spines = SHELF_BAYS.map(() => 0);
  const members = SHELF_BAYS.map(() => []);
  const lowest = fits.map((row) => row.lastIndexOf(true));
  const order = looks.map((_look, index) => index).sort((a, b) => lowest[a] - lowest[b] || lengths[b] - lengths[a] || a - b);
  // 見込みの無い枝を早く切る: 段 0〜k にしか置けない残りの本の背の幅が、段 0〜k に残る幅を越えるなら入りきらない。
  const hopeless = (next) => {
    let room = 0;
    let need = 0;
    let narrowest = Infinity;
    for (let bay = 0; bay < SHELF_BAYS.length; bay += 1) {
      room += rooms[bay] - spines[bay] * widest[bay];
      narrowest = Math.min(narrowest, widest[bay]);
      for (let k = next; k < order.length; k += 1) if (lowest[order[k]] === bay) need += looks[order[k]].spineW;
      if (need * narrowest > room) return true;
    }
    return false;
  };
  const place = (next) => {
    if (next === order.length) return true;
    if (hopeless(next)) return false;
    const index = order[next];
    const { spineW, spineGap } = looks[index];
    for (let bay = 0; bay <= lowest[index]; bay += 1) {
      const [usedBefore, spinesBefore] = [used[bay], spines[bay]];
      if (usedBefore + spineW * widest[bay] > rooms[bay]) continue;
      used[bay] = usedBefore + (spineW + spineGap) * widest[bay];
      spines[bay] = spinesBefore + spineW;
      members[bay].push(index);
      if (place(next + 1)) return true;
      members[bay].pop();
      [used[bay], spines[bay]] = [usedBefore, spinesBefore];
    }
    return false;
  };
  return place(0) ? members.map((set) => [...set].sort((a, b) => a - b)) : null;
}

// 背の四辺形（絵の %）: 縦の縁は x=left と x=left+width（lean だけ傾く）、足もとは段の bottom の線、天は段の高さの heightF 倍。
// 表紙の面は背の右の縁に付き、その縁の丈と COVER_ASPECT の横幅を持つ。order は段の中の並び（右ほど手前）。
function spineQuad(bay, left, width, heightF, titleScale, order) {
  const right = left + width;
  const bottomL = lineAt(bay.x, bay.bottom, left);
  const bottomR = lineAt(bay.x, bay.bottom, right);
  const heightL = (bottomL - lineAt(bay.x, bay.top, left)) * heightF;
  const heightR = (bottomR - lineAt(bay.x, bay.top, right)) * heightF;
  const lean = -Math.tan((bay.lean * Math.PI) / 180);
  return {
    left,
    width,
    order,
    titleScale,
    corners: [
      [left + heightL * lean, bottomL - heightL],
      [right + heightR * lean, bottomR - heightR],
      [right, bottomR],
      [left, bottomL]
    ],
    heightR,
    pullDistance: heightR * PULL_REACH,
    pull: bay.pull,
    bayLeft: bay.x[0]
  };
}

function buildBayNode(bay) {
  const node = document.createElement('div');
  node.className = 'academy-library-bay';
  const left = bay.x[0];
  const top = Math.min(...bay.top);
  const width = bay.x[1] - left;
  const height = Math.max(...bay.bottom) - top;
  node.style.left = `${left}%`;
  node.style.top = `${top}%`;
  node.style.width = `${width}%`;
  node.style.height = `${height}%`;
  const y = (value) => `${(((value - top) / height) * 100).toFixed(2)}%`;
  node.style.clipPath = `polygon(0% ${y(bay.top[0])}, 100% ${y(bay.top[1])}, 100% ${y(bay.bottom[1])}, 0% ${y(bay.bottom[0])})`;
  return node;
}

// 表紙の金の題（棚で引き出したときと、手の中の表紙で同じもの）。副題は背と同じく小さな字で続ける。題のまとまりは、その本の
// 絵の置き方で面の上へ写した内側の枠（中核の絵は額縁の中・周縁の絵は空押しの内枠の中）の真ん中に、左右も上下も揃えて置く。
// 一列が枠の丈に収まらない題は字を下限まで小さくし、それでも収まらなければ列を左へ足して、列のまとまり全体を真ん中に置く。
// 内側の枠は絵（900×1200 px）の中の真ん中と、真ん中に置いた長方形が模様から 20px 離れて収まる大きさ（room: 半幅がその値
// 以下なら、その半丈まで収まる）。額縁は天地が弧で細るので、幅の広いまとまりほど丈が短い。
const COVER_FRAMES = {
  core: { center: [474.5, 599], room: [[110, 308], [120, 293], [140, 261], [150, 243], [170, 224], [180, 211]] },
  periphery: { center: [470.5, 594], room: [[210, 444], [220, 427], [230, 402], [240, 398], [250, 392], [260, 386]] }
};
const COVER_IMAGE_PX = [900, 1200];
// 字の大きさは面の幅に対する割合（CSS の 10.5cqw・字間 0.08em・列の間 line-height 1.25 と同じ値）。
const COVER_TITLE_EM = 0.105;
const COVER_TITLE_ADVANCE = 1.08;
const COVER_TITLE_PITCH = 1.25;
const COVER_TITLE_MIN_SCALE = 0.62;
// 閉じるときに押す蔵書票（面の %）: 票の箱の一辺（面の幅に対する %・CSS の width と同じ値）と、絵（512 px 四方）の中で描かれて
// いる所、題の字との間に空ける幅、箱の真ん中の置き場。題の字が rest に押した票の描かれた所（と空ける幅）に掛かる本だけ、票を
// aside（内枠の右下の角。中核の絵では額縁の右下の段の角に押す）へ移す。aside は、枠に 2 列以内で収まるどの題にも、絵のどの
// 置き方でも掛からない所にある。
const EX_LIBRIS = { size: 27, ink: [49 / 512, 32 / 512, 462 / 512, 478 / 512], clear: 1, rest: [70, 71], aside: [80, 77] };

function exLibrisInk([x, y]) {
  const width = EX_LIBRIS.size;
  const height = EX_LIBRIS.size * COVER_ASPECT;
  const [x0, y0, x1, y1] = EX_LIBRIS.ink;
  const clear = EX_LIBRIS.clear;
  return { x0: x + (x0 - 0.5) * width - clear, y0: y + (y0 - 0.5) * height - clear, x1: x + (x1 - 0.5) * width + clear, y1: y + (y1 - 0.5) * height + clear };
}

const boxesMeet = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

// 題の字の大きさと、題を置く長方形（面の % の left・right・top・bottom）、蔵書票の置き場（面の %）。長さは面の幅を 1 とした値。
function coverTitleLayout(title, frame) {
  const { center, room } = COVER_FRAMES[frame.image];
  const unit = frame.size / COVER_IMAGE_PX[0];
  const faceHeight = 1 / COVER_ASPECT;
  const cx = (1 - frame.size) * frame.x + center[0] * unit;
  const cy = (faceHeight - (frame.size * COVER_IMAGE_PX[1]) / COVER_IMAGE_PX[0]) * frame.y + center[1] * unit;
  const roomFor = (halfWidth) => room.find(([hw]) => hw * unit >= halfWidth);
  const at = title.indexOf(SUBTITLE_SEPARATOR);
  const chars = at < 0 ? [...title].length : [...title.slice(0, at)].length + 0.72 * [...title.slice(at)].length;
  const em = (scale) => COVER_TITLE_EM * scale;
  // 列の長さは字の送りの計算どおりに出るので、ちょうどに合わせると端数で最後の一字が次の列へ落ちる。その分の余り。
  const slack = 1.02;
  // halfWidth・halfHeight は題を置く長方形、columns・length は題のまとまり（列の数と列の丈）。まとまりの幅は字の箱の端から端
  // （列の間は行の送り、両端の列は字の幅 1em）。
  const place = (scale, halfWidth, halfHeight, columns, length) => {
    const groupHalf = (((columns - 1) * COVER_TITLE_PITCH + 1) * em(scale)) / 2;
    const group = { x0: (cx - groupHalf) * 100, x1: (cx + groupHalf) * 100, y0: ((cy - length / 2) / faceHeight) * 100, y1: ((cy + length / 2) / faceHeight) * 100 };
    const exLibris = [EX_LIBRIS.rest, EX_LIBRIS.aside].find((spot) => !boxesMeet(group, exLibrisInk(spot)));
    if (!exLibris) throw new Error(`cover title reaches the ex-libris at both of its places: ${title}`);
    return {
      scale,
      exLibris,
      left: (cx - halfWidth) * 100,
      right: (1 - cx - halfWidth) * 100,
      top: ((cy - halfHeight) / faceHeight) * 100,
      bottom: (1 - (cy + halfHeight) / faceHeight) * 100
    };
  };
  const single = roomFor((em(1) * COVER_TITLE_PITCH) / 2);
  const scale = Math.min(1, (2 * single[1] * unit) / (chars * em(1) * COVER_TITLE_ADVANCE * slack));
  if (scale >= COVER_TITLE_MIN_SCALE) return place(scale, single[0] * unit, single[1] * unit, 1, chars * em(scale) * COVER_TITLE_ADVANCE);
  // 二列以上: 列の丈を字数で等分した長さにし（長方形の丈が列の丈になり、まとまりの天地が揃う）、それが枠に収まる最少の列数。
  const advance = em(COVER_TITLE_MIN_SCALE) * COVER_TITLE_ADVANCE;
  for (let columns = 2; ; columns += 1) {
    const fit = roomFor((columns * em(COVER_TITLE_MIN_SCALE) * COVER_TITLE_PITCH) / 2);
    if (!fit) throw new Error(`cover title does not fit the ${frame.image} frame at the smallest letters: ${title}`);
    const length = Math.ceil(chars / columns) * advance * slack;
    if (length <= 2 * fit[1] * unit) return place(COVER_TITLE_MIN_SCALE, fit[0] * unit, length / 2, columns, length);
  }
}

function buildCoverTitle(title, layout) {
  const node = document.createElement('span');
  node.className = 'academy-library-cover-title';
  fillSpineTitle(node, title);
  node.style.setProperty('--cover-title-scale', layout.scale.toFixed(3));
  for (const side of ['left', 'right', 'top', 'bottom']) node.style[side] = pct(layout[side]);
  return node;
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
// （指を置いた所から本が左下へ離れても、指はまだ本の上にある）。
function pulledBack() {
  return `scale(${1 / PULL_SCALE}) translate(calc(var(--pull-dx) * var(--pull-x) * -1), calc(var(--pull-dx) * var(--pull-y) * -1))`;
}

// ── 頁の紙: 見開きの絵（book_spread.jpg・2000×1250）の上で測った頁の形 ─────────────────────────────────────────
// 開いた本は手前（下）ほど広い台形に描かれ、紙は綴じ目から頁の幅の 1/4 ほどの所で盛り上がって、外の縁と綴じ目へ落ちる。
// 頁に書かれるものは全部この紙の上に載せる: 平らに組んだ頁の字（頁の箱）を、紙の内側に取った字の台形へ射影で写し（奥ほど
// 小さく細い）、字ごとに紙の反りの分だけ持ち上げる。値はどれも絵の px。
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

// 字は一字ずつの span（.academy-library-glyph）に入れて組む（紙の反りで一字ずつ持ち上げるため）。改行はそのまま置く。
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

// 頁の上の細い線（題の下・脚注の上）。線の形は頁を紙へ載せるときに反りに沿って引く。
function pageRule() {
  const rule = document.createElement('span');
  rule.className = 'academy-library-page-rule';
  rule.setAttribute('aria-hidden', 'true');
  return rule;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const RULE_SAMPLES = 24;

// 頁の箱（平らに組む面）と紙の対応。箱を描いた要素（見開きか、めくる一枚の面の紙）が offsetParent で、紙の形はその要素の上の
// 絵から取る。projection は組みの上の点を箱の上の点へ写し、liftAt は組みの上の一点を紙の反りの分だけ持ち上げる縦のずれを返す。
function paperMap(boxEl, side) {
  const painter = boxEl.offsetParent;
  if (!painter) throw new Error('library screen: a page is laid on paper while it is not displayed');
  const frame = paintedFrame(painter);
  const toLocal = ([x, y]) => [x * frame.scaleX + frame.left - boxEl.offsetLeft, y * frame.scaleY + frame.top - boxEl.offsetTop];
  const toImage = ([x, y]) => [(x + boxEl.offsetLeft - frame.left) / frame.scaleX, (y + boxEl.offsetTop - frame.top) / frame.scaleY];
  const projection = quadProjection(boxEl.offsetWidth, boxEl.offsetHeight, PAGE_TEXT_QUADS[side].map(toLocal));
  const liftAt = (point) => {
    const [x, y] = toImage(projection.forward(point));
    return projection.inverse(toLocal([x, y - paperLift(side, [x, y])]))[1] - point[1];
  };
  return { projection, liftAt };
}

// 頁（.academy-library-page）の字を紙へ載せる。頁の大きさが変わったら（窓の大きさが変わったら）載せ直す。
function layPageOnPaper(pageEl, side) {
  const ink = pageEl.querySelector('.academy-library-page-ink');
  if (!ink) return;
  const { projection, liftAt } = paperMap(pageEl, side);
  ink.style.transform = projection.css;
  const glyphs = [...ink.querySelectorAll('.academy-library-glyph')];
  for (const glyph of glyphs) glyph.style.top = '';
  const centres = glyphs.map((glyph) => [glyph.offsetLeft + glyph.offsetWidth / 2, glyph.offsetTop + glyph.offsetHeight / 2]);
  const rules = [...ink.querySelectorAll('.academy-library-page-rule')].map((rule) => ({ rule, left: rule.offsetLeft, top: rule.offsetTop, width: rule.offsetWidth }));
  glyphs.forEach((glyph, index) => { glyph.style.top = `${liftAt(centres[index]).toFixed(2)}px`; });
  for (const { rule, left, top, width } of rules) {
    const points = Array.from({ length: RULE_SAMPLES + 1 }, (_unused, i) => {
      const x = (width * i) / RULE_SAMPLES;
      return `${x.toFixed(2)} ${liftAt([left + x, top]).toFixed(2)}`;
    });
    const line = document.createElementNS(SVG_NS, 'svg');
    line.setAttribute('width', String(width));
    line.setAttribute('height', '1');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', `M ${points.join(' L ')}`);
    line.append(path);
    rule.replaceChildren(line);
  }
}

// ── 筆の線: 一行ぶんの墨の線を、続け字の山と輪（サイクロイド）を語ごとにつないで作る ─────────────────────────────
// 字ごとに、輪を作らない山（loop < 1）・足もとに輪を作る字（loop > 1）・丈の高い字が混ざり、語の長さ・字の幅・語の間・
// 行の傾きも行ごとの乱数で変わるので、同じ線は二度と出ない。値は頁の行の丈（lineH）に対する割合。
// 返すのは語ごとの点の列（組みの上の x と、行の中心からの縦のずれ）。
function sketchWords(random, { from, to, lineH, scale = 1 }) {
  const between = (min, max) => min + (max - min) * random();
  const words = [];
  let x = from;
  for (;;) {
    const letters = 2 + Math.floor(random() * 6);
    const widths = Array.from({ length: letters }, () => lineH * scale * between(0.26, 0.42));
    const length = widths.reduce((sum, width) => sum + width, 0);
    if (x + length > to) {
      // 行の終わりに残った幅が語に足りれば、短い語で行を埋める。
      if (to - x < lineH * scale * 0.6) break;
      widths.length = Math.max(1, Math.floor(((to - x) / length) * letters));
    }
    const points = [];
    const drift = between(-0.03, 0.03) * lineH;
    for (const width of widths) {
      const loop = random() < 0.4 ? between(1.3, 2.2) : between(0.2, 0.9);
      const rise = lineH * scale * 0.26 * (random() < 0.2 ? between(1.5, 2.1) : between(0.55, 1.1));
      const a = width / (2 * Math.PI);
      const start = points.length ? 1 : 0;
      for (let i = start; i <= 16; i += 1) {
        const t = (i / 16) * 2 * Math.PI;
        points.push([x + a * t - a * loop * Math.sin(t), lineH * scale * 0.14 - rise * (0.5 - 0.5 * Math.cos(t)) + drift * ((x - from + a * t) / lineH)]);
      }
      x += width;
    }
    words.push(points);
    x += lineH * scale * between(0.18, 0.46);
    if (x >= to) break;
  }
  return words;
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
      if (lamp.depth !== undefined) {
        node.dataset.depth = String(lamp.depth);
        node.style.setProperty('--depth-delay', `${(lamp.depth * SEEK_CYCLE_MS) / 6 / 1000}s`);
      }
      els.lamps.append(node);
    }
  }

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
    if (isActive()) dust.restart();
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
  const shelfState = { books: [], nodes: [] };

  // 本はその題が下限の字で収まる段にだけ置く（長い題の本ほど背の高い段へ。置き方は assignBays）。段の中は届いた順に並べる。
  // 下限の字でもどの段にも収まらない本があるとき、どう置いても段に入りきらないときは throw（棚を出さない）。
  function layoutShelf(books, looks) {
    const artPx = els.art.getBoundingClientRect().width;
    const measure = document.createElement('span');
    measure.className = 'academy-library-book-title-text academy-library-book-title-measure';
    els.shelf.append(measure);
    let lengths;
    try {
      lengths = books.map((book) => titleLength(measure, book.title, artPx));
    } finally {
      measure.remove();
    }
    const scales = books.map((_book, index) => SHELF_BAYS.map((bay) => Math.min(1, (bayHeight(bay) * looks[index].heightF - 2 * SPINE_PAD_Y) / lengths[index])));
    const fits = scales.map((row) => row.map((scale) => scale >= TITLE_MIN_SCALE));
    books.forEach((book, index) => {
      if (!fits[index].includes(true)) throw new Error(`library screen: no painted shelf holds 「${book.title}」 at the smallest title scale`);
    });
    const members = assignBays(fits, looks, lengths);
    if (!members) throw new Error(`library screen: the painted shelves have no room for all ${books.length} books`);
    const placements = new Array(books.length);
    const used = [];
    for (const [bayIndex, bay] of SHELF_BAYS.entries()) {
      if (!members[bayIndex].length) continue;
      used.push(bay);
      let x = bay.x[0];
      for (const [position, index] of members[bayIndex].entries()) {
        const look = looks[index];
        const squeeze = lineAt(bay.x, bay.squeeze, x);
        placements[index] = spineQuad(bay, x, look.spineW * squeeze, look.heightF, scales[index][bayIndex], position);
        x += (look.spineW + look.spineGap) * squeeze;
      }
    }
    return { placements, bays: used };
  }

  function buildBookNode(book, index, look, place) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'academy-library-book-item';
    node.dataset.cover = book.cover;
    node.dataset.index = String(index);
    node.dataset.piece = look.piece;
    node.setAttribute('aria-label', book.title);
    applyLookVars(node, look);
    // 箱は背の四辺形を囲む長方形。中の位置はどれも箱に対する %。
    const [tl, tr, br, bl] = place.corners;
    const boxLeft = Math.min(tl[0], bl[0]);
    const boxTop = Math.min(tl[1], tr[1]);
    const boxWidth = Math.max(tr[0], br[0]) - boxLeft;
    const boxHeight = Math.max(bl[1], br[1]) - boxTop;
    const bx = (x) => pct(((x - boxLeft) / boxWidth) * 100);
    const by = (y) => pct(((y - boxTop) / boxHeight) * 100);
    node.style.left = pct(boxLeft);
    node.style.top = pct(boxTop);
    node.style.width = pct(boxWidth);
    node.style.height = pct(boxHeight);
    node.style.setProperty('--order', String(place.order));
    node.style.setProperty('--drawn-transform', pulledOut(1).transform);
    node.style.setProperty('--rest-transform', pulledBack());
    node.style.setProperty('--title-scale', place.titleScale.toFixed(3));
    node.style.setProperty('--pull-dx', `calc(var(--library-art-size) * ${(place.pullDistance / 100).toFixed(5)})`);
    node.style.setProperty('--pull-x', String(place.pull[0]));
    node.style.setProperty('--pull-y', String(place.pull[1]));
    node.dataset.bayLeft = String(place.bayLeft);

    // 背: 四辺形で切り抜き、中の装丁は天地の縁の平均の勾配で傾ける（天地のずれは切り抜きが吸う）。
    const spine = document.createElement('span');
    spine.className = 'academy-library-book-spine';
    spine.style.clipPath = `polygon(${place.corners.map(([x, y]) => `${bx(x)} ${by(y)}`).join(', ')})`;
    const slopeTop = (tr[1] - tl[1]) / place.width;
    const slopeBottom = (br[1] - bl[1]) / place.width;
    const pad = (place.width * Math.abs(slopeTop - slopeBottom)) / 2 + 0.05;
    const skinHeight = Math.max(bl[1] - tl[1], br[1] - tr[1]) + 2 * pad;
    const skin = document.createElement('span');
    skin.className = 'academy-library-book-skin';
    skin.style.left = bx(bl[0]);
    skin.style.width = pct((place.width / boxWidth) * 100);
    skin.style.top = by(tl[1] - pad);
    skin.style.height = pct((skinHeight / boxHeight) * 100);
    skin.style.transform = `skewY(${Math.atan((slopeTop + slopeBottom) / 2).toFixed(4)}rad)`;
    const parts = ['face', 'deco', 'wear', 'light'].map((part) => {
      const el = document.createElement('span');
      el.className = `academy-library-book-${part}`;
      return el;
    });
    const title = document.createElement('span');
    title.className = 'academy-library-book-title';
    const titleText = document.createElement('span');
    titleText.className = 'academy-library-book-title-text';
    fillSpineTitle(titleText, book.title);
    title.append(titleText);
    skin.append(...parts, title);
    spine.append(skin);

    // 表紙の面: 背の右の縁から、右隣の本の陰だった所へ。見える幅は引き出した分（--pull-dx）だけ。
    const reveal = document.createElement('span');
    reveal.className = 'academy-library-book-reveal';
    reveal.style.left = bx(br[0]);
    reveal.style.top = by(tr[1]);
    reveal.style.height = pct((place.heightR / boxHeight) * 100);
    const cover = document.createElement('span');
    cover.className = 'academy-library-book-cover';
    cover.style.setProperty('--cover-aspect', COVER_ASPECT.toFixed(4));
    const coverFace = document.createElement('span');
    coverFace.className = 'academy-library-cover-face';
    coverFace.append(buildCoverTitle(book.title, coverTitleLayout(book.title, look.frame)));
    cover.append(coverFace);
    reveal.append(cover);
    node.append(spine, reveal);
    node.addEventListener('pointerenter', () => drawOut(node));
    node.addEventListener('pointerleave', () => pushBack(node));
    node.addEventListener('focus', () => drawOut(node));
    node.addEventListener('blur', () => pushBack(node));
    node.addEventListener('click', () => { openFromShelf(node, book).catch(quietly); });
    return node;
  }

  function renderShelf(books) {
    const looks = books.map((book) => bookLook(book.key, book.cover));
    const { placements, bays } = layoutShelf(books, looks);
    const nodes = books.map((book, index) => buildBookNode(book, index, looks[index], placements[index]));
    els.shelf.replaceChildren(...bays.map(buildBayNode), ...nodes);
    shelfState.books = books;
    shelfState.nodes = nodes;
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
      const timing = { duration: 900, delay: index * 120 };
      return [
        run(node, [
          { transform: from.transform, opacity: '0', filter: 'brightness(0.35)' },
          { opacity: '1', offset: 0.35 },
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

  // ── 指を乗せる: 本が通路の側（左）へ引き出されながら少し手前へ寄り、右隣の本の陰から表紙の面と金の題が見えてくる。
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
      const books = await keep(request);
      renderShelf(books);
      for (const node of shelfState.nodes) node.style.opacity = '0';
      root.dataset.scene = 'returning';
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

  // ── 筆: 本文を待つ白い見開きの行の上を、筆先が左から右へ走り、行の頭から墨の線が生まれていく ──────────────────────
  // 線は頁と同じ組み（行の丈・最初の頁の題と層の名前の行）の上に置き、頁の字と同じ射影と紙の反りで紙へ載せる（本文が届くと、
  // 線はその行の字へほどける）。左の頁の天から右の頁の地まで書き終えたら、書いた線が紙へ沈み、新しい線で天から書き直す。
  // 動きを減らす設定では筆を出さず、見開きの全部の行の線が静かに濃くなる。
  const WRITE_SPEED = 13;         // 筆が行の上を右へ進む速さ（行の丈 / 秒・見開きの一巡は 1440×900 で約 25 秒）
  const WRITE_SPEED_TITLE = 9;    // 題の行は少しゆっくり
  const TRAVEL_SPEED = 26;        // 語から語・行から行へ移る筆の速さ（行の丈 / 秒）
  const LINE_RESTS_MS = 900;      // 見開きを書き終えてから線が沈み始めるまで
  const SINK_MS = 1400;           // 書いた線が紙へ沈む長さ
  const RELEASE_MS = 700;         // 本文が届いて、線が字へほどける長さ

  const writer = (() => {
    let handle = null;
    let plan = null;
    let seed = 0;
    let lastTime = 0;
    let generation = 0;
    const boxes = { left: els.sketchLeft, right: els.sketchRight };

    // 頁の組みの見えない枠で、最初の頁の題の行（字の左右の端）・層の名前の行・本文の一行目の中心を測る。
    function measureRows(headTitle) {
      const measure = els.measure;
      const width = els.pageLeft.offsetWidth;
      measure.style.width = `${width}px`;
      measure.style.height = `${els.pageLeft.offsetHeight}px`;
      const lineH = Number.parseFloat(getComputedStyle(els.pageLeft).lineHeight);
      if (!Number.isFinite(lineH) || lineH <= 0) throw new Error('library screen: the page line height is not a length');
      const centre = (glyph) => glyph.offsetTop + glyph.offsetHeight / 2;
      const probe = () => measure.querySelector(':scope > .academy-library-glyph');
      measure.replaceChildren(glyphText('字'));
      const bodyTop = centre(probe());
      const head = pageHead({ title: headTitle, category: '字' });
      measure.replaceChildren(head, glyphText('字'));
      const titleRows = new Map();
      for (const glyph of head.querySelectorAll('.academy-library-page-title .academy-library-glyph')) {
        const y = Math.round(centre(glyph));
        const row = titleRows.get(y) ?? { y: centre(glyph), from: Infinity, to: -Infinity };
        row.from = Math.min(row.from, glyph.offsetLeft);
        row.to = Math.max(row.to, glyph.offsetLeft + glyph.offsetWidth);
        titleRows.set(y, row);
      }
      const categoryGlyph = head.querySelector('.academy-library-page-category .academy-library-glyph');
      const rows = {
        lineH,
        width,
        height: els.pageLeft.offsetHeight,
        title: [...titleRows.values()],
        category: { y: centre(categoryGlyph), from: 0, to: width * 0.28 },
        headBodyTop: centre(probe()),
        bodyTop
      };
      measure.replaceChildren();
      return rows;
    }

    // 見開きひとつぶんの線を組む: 題の行（太い線）・層の名前の行（細く淡い線）・本文の行。本文の行は段落の頭を一字下げ、段落の
    // 終わりの行は短い。返すのは紙へ載せた svg と、筆が辿る区間（書く・移る）の列。
    function compose(headTitle) {
      const random = seededRandom(hash32(`${headTitle}|${seed}`));
      seed += 1;
      const rows = measureRows(headTitle);
      const { lineH } = rows;
      const lines = [];
      for (const row of rows.title) lines.push({ side: 'left', y: row.y, from: row.from, to: row.to, kind: 'title' });
      lines.push({ side: 'left', ...rows.category, kind: 'category' });
      let paragraphLeft = 0;
      for (const [side, top] of [['left', rows.headBodyTop], ['right', rows.bodyTop]]) {
        for (let y = top; y + lineH / 2 <= rows.height; y += lineH) {
          const opening = paragraphLeft <= 0;
          if (opening) paragraphLeft = 2 + Math.floor(random() * 6);
          paragraphLeft -= 1;
          const closing = paragraphLeft === 0;
          const from = opening ? lineH * 0.55 : 0;
          const to = closing ? rows.width * (0.25 + random() * 0.55) : rows.width * (0.93 + random() * 0.07);
          lines.push({ side, y, from, to, kind: 'body' });
        }
      }
      const svgs = {};
      const maps = {};
      for (const side of ['left', 'right']) {
        const box = boxes[side];
        maps[side] = paperMap(box, side);
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', 'academy-library-sketch-lines');
        svg.setAttribute('width', String(box.offsetWidth));
        svg.setAttribute('height', String(box.offsetHeight));
        svg.style.transform = maps[side].projection.css;
        box.append(svg);
        svgs[side] = svg;
      }
      const segments = [];
      let at = null;
      for (const [index, line] of lines.entries()) {
        const scale = line.kind === 'title' ? 1.35 : 1;
        const words = sketchWords(random, { from: line.from, to: line.to, lineH, scale });
        const { liftAt } = maps[line.side];
        const lifted = ([x, dy]) => [x, line.y + dy + liftAt([x, line.y + dy])];
        for (const word of words) {
          const points = word.map(lifted);
          const path = document.createElementNS(SVG_NS, 'path');
          path.setAttribute('d', `M ${points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(' L ')}`);
          path.dataset.kind = line.kind;
          path.dataset.row = String(index);
          svgs[line.side].append(path);
          const length = path.getTotalLength();
          path.style.strokeDasharray = `${length} ${length}`;
          path.style.strokeDashoffset = String(length);
          const start = { side: line.side, point: points[0] };
          if (at) segments.push({ kind: 'travel', from: at, to: start, raise: at.side !== start.side || at.point[1] !== start.point[1] ? 1 : 0.35 });
          const speed = (line.kind === 'title' ? WRITE_SPEED_TITLE : WRITE_SPEED) * lineH;
          segments.push({ kind: 'stroke', side: line.side, path, length, ms: ((points[points.length - 1][0] - points[0][0]) / speed) * 1000 });
          at = { side: line.side, point: points[points.length - 1] };
        }
      }
      for (const segment of segments) {
        if (segment.kind !== 'travel') continue;
        const [a, b] = [spreadPoint(maps, segment.from), spreadPoint(maps, segment.to)];
        segment.ms = Math.max(40, (Math.hypot(b[0] - a[0], b[1] - a[1]) / (TRAVEL_SPEED * lineH)) * 1000);
      }
      return { svgs, maps, segments, lineH, index: 0, elapsed: 0, restMs: 0 };
    }

    // 組みの上の一点（その頁の箱の上）の、見開きの上の位置（px）。
    function spreadPoint(maps, { side, point }) {
      const [x, y] = maps[side].projection.forward(point);
      return [x + boxes[side].offsetLeft, y + boxes[side].offsetTop];
    }

    // 筆先を見開きの上の一点へ置く。lift は紙から離れた高さ（行の丈の倍数）。
    function placeBrush([x, y], lift) {
      els.brush.style.setProperty('--brush-lift', lift.toFixed(3));
      els.brush.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }

    function step(time) {
      const dt = lastTime ? Math.min(250, time - lastTime) : 0;
      lastTime = time;
      let left = dt;
      while (plan && left > 0) {
        if (plan.index >= plan.segments.length) {
          // 見開きを書き終えた: 筆は最後の字の上で少し止まり、線が紙へ沈むのと同時に左の頁の天へ戻って書き直す。
          plan.restMs += left;
          left = 0;
          if (plan.restMs >= LINE_RESTS_MS) {
            const old = plan;
            for (const svg of Object.values(old.svgs)) {
              svg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: SINK_MS, easing: EASE, fill: 'forwards' }).finished
                .then(() => svg.remove(), () => svg.remove());
            }
            plan = compose(old.headTitle);
            plan.headTitle = old.headTitle;
            const last = old.segments.filter((segment) => segment.kind === 'stroke').at(-1);
            const first = plan.segments.find((segment) => segment.kind === 'stroke');
            const from = { side: last.side, point: pointOf(last.path, last.length) };
            plan.segments.unshift({ kind: 'travel', from, to: { side: first.side, point: pointOf(first.path, 0) }, raise: 1.6, ms: SINK_MS });
          }
          break;
        }
        const segment = plan.segments[plan.index];
        const remaining = segment.ms - plan.elapsed;
        const used = Math.min(left, remaining);
        plan.elapsed += used;
        left -= used;
        const progress = segment.ms ? Math.min(1, plan.elapsed / segment.ms) : 1;
        if (segment.kind === 'stroke') {
          const drawn = segment.length * progress;
          segment.path.style.strokeDashoffset = String(segment.length - drawn);
          placeBrush(spreadPoint(plan.maps, { side: segment.side, point: pointOf(segment.path, drawn) }), 0);
        } else {
          const [a, b] = [spreadPoint(plan.maps, segment.from), spreadPoint(plan.maps, segment.to)];
          const eased = 0.5 - 0.5 * Math.cos(Math.PI * progress);
          placeBrush([a[0] + (b[0] - a[0]) * eased, a[1] + (b[1] - a[1]) * eased], segment.raise * Math.sin(Math.PI * progress));
        }
        if (progress >= 1) {
          plan.index += 1;
          plan.elapsed = 0;
        }
      }
      handle = requestAnimationFrame(step);
    }

    function pointOf(path, length) {
      const point = path.getPointAtLength(length);
      return [point.x, point.y];
    }

    function clear() {
      if (handle !== null) cancelAnimationFrame(handle);
      handle = null;
      lastTime = 0;
      plan = null;
      generation += 1;
      els.sketchLeft.replaceChildren();
      els.sketchRight.replaceChildren();
      delete els.book.dataset.writing;
      els.brush.style.transform = '';
    }

    return {
      // 開く前の白い見開きに、まだ書かれていない線を組んでおく（最初の頁の題の行には、これから開く本の題の長さの線）。
      prepare(headTitle) {
        clear();
        plan = compose(headTitle);
        plan.headTitle = headTitle;
      },
      // 組んでおいた線を書き始める。
      start() {
        if (!plan) throw new Error('library screen: the brush starts without prepared lines');
        els.book.dataset.writing = reduced() ? 'still' : 'moving';
        if (reduced()) {
          // 筆は出さず、見開きの全部の行の線が静かに濃くなる。
          for (const segment of plan.segments) if (segment.kind === 'stroke') segment.path.style.strokeDashoffset = '0';
          for (const svg of Object.values(plan.svgs)) svg.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 6000, easing: 'ease-out', fill: 'forwards' });
          return;
        }
        const first = plan.segments[0];
        placeBrush(spreadPoint(plan.maps, { side: first.side, point: pointOf(first.path, 0) }), 1.6);
        handle = requestAnimationFrame(step);
      },
      // 本文が届いた・届かなかった: 筆が紙から離れ、墨の線は上の行から順にほどけて消える（字は頁のインクとして浮かぶ）。
      release() {
        if (!els.book.dataset.writing) return;
        if (handle !== null) cancelAnimationFrame(handle);
        handle = null;
        lastTime = 0;
        const mine = ++generation;
        const current = plan;
        plan = null;
        els.book.dataset.writing = 'lifting';
        const fade = reduced() ? REDUCED_FADE_MS : RELEASE_MS;
        const svgs = [...els.sketchLeft.children, ...els.sketchRight.children];
        const paths = svgs.flatMap((svg) => [...svg.querySelectorAll('path')]);
        const rowCount = Math.max(1, ...paths.map((path) => Number(path.dataset.row) + 1));
        const motions = paths.map((path) => path.animate(
          [{ opacity: 0, strokeWidth: '0.05vh' }],
          { duration: fade, delay: reduced() ? 0 : (Number(path.dataset.row) / rowCount) * 260, easing: EASE, fill: 'forwards' }
        ).finished);
        if (current && !reduced()) {
          motions.push(els.brush.animate(
            [{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: `${(current.lineH * 0.6).toFixed(1)}px ${(-current.lineH * 2.2).toFixed(1)}px` }],
            { duration: 450, easing: EASE, fill: 'forwards' }
          ).finished);
        }
        Promise.allSettled(motions).then(() => {
          if (mine !== generation) return;
          for (const animation of els.brush.getAnimations()) animation.cancel();
          clear();
        });
      },
      // 窓の大きさが変わった: 書いている途中なら、新しい頁の大きさで線を組み直して天から書き直す。
      relayout() {
        const writing = els.book.dataset.writing;
        if (!plan || (writing !== 'moving' && writing !== 'still')) return;
        const headTitle = plan.headTitle;
        this.prepare(headTitle);
        this.start();
      },
      clear
    };
  })();

  // 本文を待つ: 本が開き終えた時点で届いていれば筆を出さない（組んでおいた線は捨てる）。届いていなければ届くまで筆が書く。
  // pending は要求を出した時点で作った { promise, settled() }。線は開く前に writer.prepare で組んでおく。
  async function awaitWithBrush(pending) {
    const keep = stay(visit);
    if (pending.settled()) {
      writer.clear();
      return keep(pending.promise);
    }
    writer.start();
    try {
      return await keep(pending.promise);
    } finally {
      writer.release();
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
    const layout = coverTitleLayout(book.title, look.frame);
    els.coverFace.replaceChildren(buildCoverTitle(book.title, layout));
    [els.exLibris.style.left, els.exLibris.style.top] = layout.exLibris.map((value) => `${value}%`);
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
      showBook(await keep(awaitWithBrush(request)));
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

  // 頁に収まるかを、頁の箱と同じ大きさの見えない枠で測る（測ったものは残さない: 脚注の題の button を枠に置いたままにしない）。
  function fitsOnPage(nodes) {
    const measure = els.measure;
    const height = els.pageLeft.offsetHeight;
    measure.style.width = `${els.pageLeft.offsetWidth}px`;
    measure.style.height = `${height}px`;
    measure.replaceChildren(...nodes);
    const fits = measure.scrollHeight <= height + 0.5;
    measure.replaceChildren();
    return fits;
  }

  function largestFit(text, withHead) {
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fitsOnPage(pageContent({ head: withHead, text: text.slice(0, mid) }, []))) lo = mid;
      else hi = mid - 1;
    }
    // 行の途中で切れるときは、直前の句点・改行までさかのぼる（さかのぼりは 40 字まで）。
    if (lo < text.length) {
      const cut = Math.max(text.lastIndexOf('。', lo - 1), text.lastIndexOf('\n', lo - 1));
      if (cut >= 0 && lo - cut <= 40) return cut + 1;
    }
    return lo;
  }

  function paginate(result) {
    const pages = [];
    let rest = result.text.trim();
    while (rest.length) {
      const withHead = pages.length === 0;
      const count = largestFit(rest, withHead);
      if (count === 0) throw new Error('library screen: a page holds no text (page box too small)');
      pages.push({ head: withHead, text: rest.slice(0, count) });
      rest = rest.slice(count).replace(/^\n+/, '');
    }
    return pages;
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
      if (last >= 0 && !fitsOnPage(pageContent(body[last], tail))) at = last + 1;
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

  function renderSpread() {
    const index = reading.spread;
    drawPage(els.pageLeft, index * 2, 'left');
    drawPage(els.pageRight, index * 2 + 1, 'right');
    els.book.dataset.spread = String(index);
    els.book.dataset.spreads = String(spreadCount());
    // 続きの手掛かり: 見開きが二つ以上ある本の一つ目の見開きだけ、右の頁の小口に残りの頁の重なりが見え、右下の角がわずかに反る。
    els.book.dataset.more = String(index === 0 && spreadCount() >= 2);
  }

  // 脚注・頁の一文が変わったら置き場を決め直し、いまの見開きを書き直す（めくっている間は、めくり終わりに書き直す）。
  function refreshTail() {
    placeTail();
    if (root.dataset.scene !== 'turning') renderSpread();
  }

  function showBook(result) {
    reading.result = result;
    reading.body = paginate(result);
    reading.spread = 0;
    reading.generation += 1;
    reading.pageNote = null;
    setFootnotes('pending', []);
    placeTail();
    renderSpread();
    // 本文が届いたらインクが頁に浮かぶ。
    requestAnimationFrame(() => { els.book.dataset.ink = 'ready'; });
    requestFootnotes(result, reading.generation);
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
      showBook(await keep(awaitWithBrush(request)));
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
    const nextTitle = buildCoverTitle(book.title, coverTitleLayout(book.title, look.frame));
    nextFace.append(nextTitle);
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
    if (!els.reading.hidden) {
      writer.relayout();
      layPageOnPaper(els.pageLeft, 'left');
      layPageOnPaper(els.pageRight, 'right');
      layTurnFaces();
    }
  });

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
      await deps.loadArrival();
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
