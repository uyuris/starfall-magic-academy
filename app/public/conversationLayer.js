// 昼の会話画面の見せ方の層。見せ方だけを持ち、会話の中身・進み方・送信・終了・SSE は製品のまま通す（製品の要素を押し、製品の描いた
// 言葉を読む）。app.js が #conversation-day-screen の data-conversation-kind に会話の種類を立てる — 学院マップから相手を選んで
// 入る会話（学院の人・山林の生き物）は field、依頼は errand、研究会は study-circle、ホムンクルスは atelier、出来事は event。印の立った
// 会話はどれも一つの形で見せ、種類ごとに違うのは地にする場所の絵と場所の名だけ。印が無い会話（卒業）では何も描かず何も押さず、
// 製品の要素への手入れはすべて元に戻す:
// - 地: 会話の画面に着いたら、いまの会話の舞台（app.js の読み口の conversationStage()）の絵を --cl-stage-art に置く。依頼・研究会・
//   ホムンクルスは種類ごとに決まった場所の絵、学院の会話と出来事はいま居る舞台（出来事はイベントの場所）の横長の絵。
//   会話の途中で場所が移ったら（app.js が stageMoves() を呼ぶ）、人を光へ溶かし、地と名を新しい場所へ置き直し、人を現す。
//   移動を知らせたターンが失敗したら（app.js が stageReturns() を呼ぶ）、地と名がいる場所と違うときだけ、同じ見せ方でいる場所へ戻す。
//   場所が移るのはいま居る舞台を地にする会話（field・event）だけで、ほかの種類で移れば落ちる。
//   行先は地図のピンの外（山林・雪の中庭）にもなり得るので、地は地図のピンではなく舞台そのものから引く。絵の無い舞台は落ちる。
// - 舞台の名: 週の字の脇にその舞台の名を置き、押すと製品の額の釦（#conversation-day-stage-image・この層では見えない）を押して、
//   製品の舞台の詳細の小窓を開く。
// - 顔: 製品が言葉ごとに描く顔（.message-face）は CSS で隠し、いちばん新しい相手の言葉の顔の絵と名を読んで、一人の人に移す。人は
//   製品の言葉の欄（.conversation-day-chat-panel）の中へ移し、CSS が左下の隅（左の印の列のすぐ右・言葉の列の左）に立たせる。絵が
//   替わるたびに二枚の層を透明度で溶け替える（動きを減らす設定では CSS が移ろいを消し、切り替えるだけ）。顔を押すと製品の相手の名を
//   押す（製品の相手の小窓が開く）。顔の絵の地（人ごとの単色）は描くときに抜き（matteFace）、舞台の光を薄く乗せる（litFace）。
//   どちらも絵ごと（光は舞台の光ごと）に一度だけ作る。相手の id を data-partner に出す（CSS が苔火の据え方に使う）。表情が替わる
//   たびに、その顔の溶かし方（faceFade・印のある顔の一覧 conversationFaceMarks.json を引く）を data-face-fade に出す。
// - 舞台の光: 舞台の絵の色から光の色を読み（stageLight）、人の絵に乗せ、人が現れる・消える光の色にする（--cl-light-rgb）。
// - 閉じる: 会話を終えるを押すと、製品の釦の前でいったん受け、人が光へ溶けて消えてから（動きを減らす設定では待たずに）製品の
//   会話を終えるを押す。製品が自分で会話を終えるとき（相手が会話を切り上げた）は、製品が partnerLeaves() を待ってから終える。
//   どちらも消えるあいだは場所だけが残る。
// - 書く口・送る・終える: 札と使い方の一文を外し、露台の紋（製品の露台の釦の紋の写し）を置く。名は aria-label に持たせる。
// - 左の印: 製品の六つの印そのもの。字は CSS で消すので、読み上げの名を釦に持たせる。
// - 会話へ移るあいだ（passage*）: 学院の会話・出来事・ホムンクルスへ移る読み込みは、箱・字・夜の絵・星座を出さず、読み込みの画面の上で場へ入って
//   いく移り変わりにする。夜から行き先の場所が満ち、舞台の名が灯り、相手が立つ左下の隅の明るみが LM を待つあいだ息をする。応答が
//   始まると（app.js が passageArrives を呼ぶ）、場所が満ちきってから明るみが顔へ譲り、顔が現れきったところで返る。app.js がそこで
//   会話の画面へ移り、層は読み込みの顔と同じ絵をそのまま現れた姿で受け取る（場所・顔・名は同じ場所にあり、移っても何も動かない）。
//   待ちが長引くと場所が少し沈んで明るみの息がゆっくりになり、失敗すると明るみが消えて場所が夜へ沈む（passageStops）。

function requireNode(selector, root = document) {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`conversation layer: product node ${selector} is missing`);
  return node;
}

const screen = requireNode('#conversation-day-screen');
const stream = requireNode('#conversation-day-message-stream');
const input = requireNode('#conversation-day-input');
const parts = requireNode('#cl-parts').content;
const face = requireNode('#cl-face', parts);
const faceWell = requireNode('.cl-face-well', face);
const faceLayers = [...face.querySelectorAll('.cl-face-layer')];
const faceName = requireNode('.cl-face-name', face);
const stageName = requireNode('#cl-stage-name', parts);
if (faceLayers.length !== 2) throw new Error(`conversation layer: expected 2 face layers, got ${faceLayers.length}`);

let product = null;
let stageLightReady = null;
let shownLayer = null;
let shownSrc = null;
let faceRequest = 0;

// ── 製品の要素の見せ方を整える（印が立っている間だけ。下りたら元に戻す） ──────────────────────────────────────
// 手入れごとに戻し方を積み、戻すときは積んだ逆の順に戻す。
const restorers = [];

function keepAttributes(node, names) {
  const saved = names.map((name) => [name, node.getAttribute(name)]);
  restorers.push(() => {
    for (const [name, value] of saved) {
      if (value === null) node.removeAttribute(name);
      else node.setAttribute(name, value);
    }
  });
}

function keepChildren(node) {
  const saved = [...node.childNodes];
  restorers.push(() => node.replaceChildren(...saved));
}

function copyTerraceMark(sourceSelector, className) {
  const mark = requireNode(sourceSelector).cloneNode(true);
  mark.setAttribute('class', className);
  return mark;
}

function dressControls() {
  restorers.push(() => {
    screen.style.removeProperty('--cl-stage-art');
    screen.style.removeProperty('--cl-light-rgb');
    delete screen.dataset.clStage;
    delete screen.dataset.clLight;
  });
  requireNode('#conversation-day-screen .conversation-day-chat-panel').append(face);
  restorers.push(() => face.remove());
  requireNode('#conversation-day-week').after(stageName);
  restorers.push(() => stageName.remove());
  const composer = requireNode('#conversation-day-screen .conversation-day-composer');
  const writeMark = copyTerraceMark('#routing-hub-screen .routing-hub-composer .terrace-write-mark', 'cl-write-mark');
  composer.prepend(writeMark);
  restorers.push(() => writeMark.remove());
  keepAttributes(input, ['placeholder', 'aria-label']);
  input.removeAttribute('placeholder');
  input.setAttribute('aria-label', '話しかける');
  for (const [buttonSelector, markSelector] of [['#conversation-day-send', '#routing-hub-send svg'], ['#conversation-day-end', '#routing-hub-end svg']]) {
    const button = requireNode(buttonSelector);
    const label = button.textContent.trim();
    if (!label) throw new Error(`conversation layer: product button ${buttonSelector} has no name`);
    keepAttributes(button, ['aria-label']);
    keepChildren(button);
    button.setAttribute('aria-label', label);
    button.replaceChildren(copyTerraceMark(markSelector, 'cl-way-mark'));
  }
  for (const button of document.querySelectorAll('.conversation-day-category-button')) {
    keepAttributes(button, ['aria-label']);
    button.setAttribute('aria-label', requireNode('.conversation-day-category-label', button).textContent);
  }
}

function undressControls() {
  while (restorers.length > 0) restorers.pop()();
}

// ── 地: いまの会話の舞台の絵 ─────────────────────────────────────────────────────────────────────────────
// node: 読み口の舞台（id・displayName・backgroundUrl）。
function placeStageArt(node) {
  screen.style.setProperty('--cl-stage-art', `url('${node.backgroundUrl}')`);
  screen.dataset.clStage = node.id;
  stageName.textContent = node.displayName;
  stageLightReady = stageLight(node.backgroundUrl).then((light) => {
    if (screen.dataset.clStage === node.id) {
      screen.style.setProperty('--cl-light-rgb', light.join(' '));
      screen.dataset.clLight = light.join(' ');
    }
    return light;
  });
}

// ── 舞台の光: 舞台の絵の色を読み、色相を残して明るく澄ませた色にする ───────────────────────────────────────────
// 舞台の光は上から来るので、絵を小さく描いた上半分の画素の平均の色を HSL で読み、彩度を STAGE_LIGHT_SATURATION 以上・明るさを STAGE_LIGHT_LIGHTNESS に揃える
// （夕暮れの中庭は紫がかった光、昼の山林は緑の光、のように舞台の色の向きだけを残す）。絵ごとに一度だけ読む。
const STAGE_LIGHT_SAMPLE = [48, 28];
const STAGE_LIGHT_SATURATION = 0.42;
const STAGE_LIGHT_LIGHTNESS = 0.66;
const stageLights = new Map();

function hslToRgb(h, s, l) {
  const k = (n) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map((n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))));
}

async function readStageLight(url) {
  const image = new Image();
  image.src = url;
  await image.decode();
  const [width, height] = STAGE_LIGHT_SAMPLE;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height / 2);
  const sum = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c += 1) sum[c] += data[i + c];
  const [r, g, b] = sum.map((value) => value / (data.length / 4) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) throw new Error(`conversation layer: the stage art ${url} has no hue to light the person with`);
  const d = max - min;
  const hue = (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
  const lightness = (max + min) / 2;
  const saturation = d / (1 - Math.abs(2 * lightness - 1));
  return hslToRgb(hue, Math.max(saturation, STAGE_LIGHT_SATURATION), STAGE_LIGHT_LIGHTNESS);
}

export function stageLight(url) {
  if (!stageLights.has(url)) stageLights.set(url, readStageLight(url));
  return stageLights.get(url);
}

stageName.addEventListener('click', () => requireNode('#conversation-day-stage-image').click());

// ── 顔の絵の地を抜く ─────────────────────────────────────────────────────────────────────────────────────
// 顔の絵は人ごとの地の上に描かれている。地の色は絵の外周から読み、描くときに抜く:
// - 地の色: 外周の淡い縁（絵の端の数画素）を避けた内側の輪を区画に分け、揃った区画が輪に沿って続くいちばん長い連なりを地とする。
//   地でない区画（髪や服がかかった所）は輪に沿って両隣の地の区画から補い、四辺の色から面を張る（場所ごとの地の色）。
// - 抜く所: 輪の地の区画から地続きで、その場の地の色に近い所。顔の中の地に近い色（肌・白目）は地続きでないので抜かない。
//   地続きは幅のある道だけで辿る: 地に近い所を半径 MATTE_OPEN だけ削った芯の中を辿り、そこから MATTE_REACH 画素だけ地に近い所へ
//   広げる。地と同じ色の髪や服は、輪郭の線の切れ目（芯の通らない細い隙間）でしか地とつながらないので、抜けが中へ流れ込まない。
//   外周の淡い縁は道に使わず、内側で抜けた所の真外と地にごく近い所だけを抜く（絵の下の縁に沿う地の帯から服の裾へ回り込まない）。髪の房の間や
//   首の脇に閉じ込められた地は、地にごく近い色の塊のうち、広げた所がほぼ一様なもの（肌や髪の陰影は一様でない）だけを抜く。
//   毛先と毛先のあいだの地は、口が芯の通らない細さでも外の抜けに接している袋なので、地に近い色の塊のうち、輪から地続きに抜けた所に
//   接し、広げた所の多くが地に近いものを抜く。絵の下の縁から地続きの抜けが届く深さに触れる塊は、縁の外へ続く服とみて抜かない。
//   はぐれた毛束と髪の本体に両端まで挟まれた地は、外の抜けに接しない細長い袋なので、広げた所の多くが地に近く、長い辺が
//   MATTE_SLIVER_LENGTH 以上で、平均の幅（広さを長い辺で割った値）が MATTE_SLIVER_WIDTH 以下で、外の抜けから MATTE_SLIVER_GAP 画素の内に
//   届く（はぐれた毛束は細い）ものを抜く（肌や地と同じ色の服の面は幅があり、地と同じ色の髪の筋は髪の奥にあって外の抜けから遠い）。
// - 際: 抜けきった所に接する画素は地と輪郭の色の混ざりとみて、混ざりの割合を透明度にし、どの透ける画素も色から地の色を差し引く
//   （地の色が細い縁として残らない）。
// - かけら: 抜けの縁には、地の揺らぎ（絵の圧縮の滲み）が幅 1 画素の切れ端として残る。周り 8 画素のうち 5 以上が抜けている
//   画素は、地から近ければ（全員・全表情の切れ端は地から 160 未満）抜き、抜いて新たにそうなった隣も同じに見る。
//   地から遠い画素（線の芯・毛先・光の粒）は細くても残る。
// - 体の範囲: 体の内側が地と同じ色で透けて描かれた絵は、その範囲（FACE_BODIES）の中を毛先のあいだの地としては抜かない。範囲の外と
//   ほかの段は同じ決まりで抜く。
const MATTE_INSET = 8;
const MATTE_DEPTH = 8;
const MATTE_SEGMENTS = 10;
const MATTE_UNIFORM = 10;
const MATTE_UNIFORM_SHARE = 0.8;
const MATTE_LINK = 10;
const MATTE_MIN_RUN = 6;
const MATTE_CLEAR = 12;
const MATTE_SOLID = 30;
const MATTE_OPEN = 3;
const MATTE_REACH = 6;
const MATTE_POCKET = 6;
const MATTE_POCKET_AREA = 24;
const MATTE_POCKET_FLAT = 0.55;
const MATTE_BAG_NEAR = 0.6;
const MATTE_BAG_FLOOR = MATTE_INSET + MATTE_DEPTH + MATTE_REACH;
const MATTE_SLIVER_LENGTH = 60;
const MATTE_SLIVER_WIDTH = 12;
const MATTE_SLIVER_GAP = 6;
const MATTE_EDGE_REACH = 2;
const MATTE_FRAGMENT_CLEAR = 0.1;
const MATTE_FRAGMENT_OPEN = 5;
const MATTE_FRAGMENT_NEAR = 160;

// 体の範囲: visual set ごとに、絵の幅と高さに対する楕円の中心と半径。
const FACE_BODIES = new Map([
  // creature_004 の球の中は、地と同じ色の透けた体の内側として描かれている。
  ['creature_004', { cx: 0.51, cy: 0.56, rx: 0.31, ry: 0.38 }],
]);

// 製品の顔の絵の URL から、その絵の体の範囲を引く（範囲を持たない絵は undefined）。
export function faceBody(src) {
  const match = /\/character_visual_sets\/([^/]+)\/face_emotions\//.exec(src);
  if (!match) throw new Error(`conversation layer: face ${src} is not a character visual set face`);
  return FACE_BODIES.get(match[1]);
}

// 印（汗の粒・渦・驚きの線・ため息の雲など、頭の脇に描かれた気持ちの印）のある人の顔: visual set の id → 表情の一覧。頭と髪を
// 景色へ溶かすと印まで溶けて消えるので、この顔は窓の溶かしのまま描く。一覧が読めなければ落ちる。
const faceMarks = fetch(new URL('./conversationFaceMarks.json', import.meta.url)).then(async (response) => {
  if (!response.ok) throw new Error(`conversation layer: face marks answered ${response.status}`);
  return new Map(Object.entries(await response.json()).map(([set, expressions]) => [set, new Set(expressions)]));
});

// 顔の溶かし（顔の窓の data-face-fade）: 地を切り抜いた人の顔（visual_set_<番号> の印の無い表情）は頭と髪を景色へ溶かす head、
// 印のある顔と、切り抜いていない顔（生き物・ホムンクルス・案内人など）は窓の溶かしの window。
export async function faceFade(src) {
  const match = /\/character_visual_sets\/([^/]+)\/face_emotions\/([^/.]+)\.jpg$/.exec(src);
  if (!match) throw new Error(`conversation layer: face ${src} is not a character visual set face`);
  const [, set, expression] = match;
  const marks = await faceMarks;
  return /^visual_set_\d+$/.test(set) && !marks.get(set)?.has(expression) ? 'head' : 'window';
}

function median(values) {
  const sorted = Float64Array.from(values).sort();
  return sorted[sorted.length >> 1];
}

function colorDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function neighbors4(p, width, count) {
  const x = p % width;
  return [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p >= width ? p - width : -1, p + width < count ? p + width : -1];
}

function neighbors8(p, width, count) {
  const x = p % width;
  const around = [];
  for (let dy = -width; dy <= width; dy += width) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if ((dx === 0 && dy === 0) || (dx < 0 && x === 0) || (dx > 0 && x === width - 1)) continue;
      const q = p + dy + dx;
      if (q >= 0 && q < count) around.push(q);
    }
  }
  return around;
}

// 輪の区画（上・右・下・左の順に輪を一周・区画ごとの画素の位置を持つ）と地とした区画の印、地の色（地の区画の中央値）と、地の区画がその色から離れる最大。
export function readGround(data, width, height) {
  const sides = [
    (t, s) => [t, MATTE_INSET + s],
    (t, s) => [width - 1 - MATTE_INSET - s, t],
    (t, s) => [width - 1 - t, height - 1 - MATTE_INSET - s],
    (t, s) => [MATTE_INSET + s, height - 1 - t]
  ];
  const segments = [];
  for (const [side, at] of sides.entries()) {
    const length = (side % 2 === 0 ? width : height) - 2 * MATTE_INSET;
    for (let k = 0; k < MATTE_SEGMENTS; k += 1) {
      const from = MATTE_INSET + Math.floor((k * length) / MATTE_SEGMENTS);
      const to = MATTE_INSET + Math.floor(((k + 1) * length) / MATTE_SEGMENTS);
      const channels = [[], [], []];
      const pixels = [];
      for (let t = from; t < to; t += 1) {
        for (let s = 0; s < MATTE_DEPTH; s += 1) {
          const [x, y] = at(t, s);
          pixels.push(y * width + x);
          const i = (y * width + x) * 4;
          for (let c = 0; c < 3; c += 1) channels[c].push(data[i + c]);
        }
      }
      const color = channels.map(median);
      let near = 0;
      for (let j = 0; j < channels[0].length; j += 1) {
        if (colorDistance([channels[0][j], channels[1][j], channels[2][j]], color) <= MATTE_UNIFORM) near += 1;
      }
      segments.push({ color, pixels, uniform: near / channels[0].length >= MATTE_UNIFORM_SHARE });
    }
  }
  const n = segments.length;
  const visited = new Uint8Array(n);
  let run = [];
  for (let start = 0; start < n; start += 1) {
    if (visited[start] || !segments[start].uniform) continue;
    const chain = [start];
    visited[start] = 1;
    for (let h = 0; h < chain.length; h += 1) {
      for (const next of [(chain[h] + 1) % n, (chain[h] + n - 1) % n]) {
        if (visited[next] || !segments[next].uniform || colorDistance(segments[next].color, segments[chain[h]].color) > MATTE_LINK) continue;
        visited[next] = 1;
        chain.push(next);
      }
    }
    if (chain.length > run.length) run = chain;
  }
  const inGround = new Uint8Array(n);
  for (const index of run) inGround[index] = 1;
  const colors = run.map((index) => segments[index].color);
  const color = run.length ? [0, 1, 2].map((c) => median(colors.map((entry) => entry[c]))) : null;
  const spread = run.length ? Math.max(...colors.map((entry) => colorDistance(entry, color))) : null;
  return { segments, inGround, run: run.length, color, spread };
}

// 場所ごとの地の色（RGB を 3 つずつ並べた面）。地でない区画は輪に沿って両隣の地の区画から補い、四辺から Coons の面を張る。
function groundField({ segments, inGround }, width, height) {
  const n = segments.length;
  const filled = segments.map((segment, index) => {
    if (inGround[index]) return segment.color;
    let back = 1;
    while (!inGround[(index - back + n) % n]) back += 1;
    let ahead = 1;
    while (!inGround[(index + ahead) % n]) ahead += 1;
    const a = segments[(index - back + n) % n].color;
    const b = segments[(index + ahead) % n].color;
    const w = back / (back + ahead);
    return [0, 1, 2].map((c) => a[c] + (b[c] - a[c]) * w);
  });
  // 上は左→右・右は上→下・下は右→左・左は下→上に並んでいるので、下と左は逆に読んで、どの辺も 0..1 の位置で引く。
  const side = (index, reversed) => {
    const values = filled.slice(index * MATTE_SEGMENTS, (index + 1) * MATTE_SEGMENTS);
    if (reversed) values.reverse();
    return (u) => {
      const p = Math.min(Math.max(u * MATTE_SEGMENTS - 0.5, 0), MATTE_SEGMENTS - 1);
      const lo = Math.floor(p);
      const hi = Math.min(lo + 1, MATTE_SEGMENTS - 1);
      return [0, 1, 2].map((c) => values[lo][c] + (values[hi][c] - values[lo][c]) * (p - lo));
    };
  };
  const top = side(0, false);
  const right = side(1, false);
  const bottom = side(2, true);
  const left = side(3, true);
  const corner = (a, b) => [0, 1, 2].map((c) => (a[c] + b[c]) / 2);
  const c00 = corner(top(0), left(0));
  const c10 = corner(top(1), right(0));
  const c01 = corner(bottom(0), left(1));
  const c11 = corner(bottom(1), right(1));
  const columns = Array.from({ length: width }, (_, x) => [top(x / (width - 1)), bottom(x / (width - 1))]);
  const field = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const v = y / (height - 1);
    const l = left(v);
    const r = right(v);
    for (let x = 0; x < width; x += 1) {
      const u = x / (width - 1);
      const [t, b] = columns[x];
      const o = (y * width + x) * 3;
      for (let c = 0; c < 3; c += 1) {
        field[o + c] = (1 - v) * t[c] + v * b[c] + (1 - u) * l[c] + u * r[c]
          - ((1 - u) * (1 - v) * c00[c] + u * (1 - v) * c10[c] + (1 - u) * v * c01[c] + u * v * c11[c]);
      }
    }
  }
  return field;
}

// 顔の絵（RGBA の画素・その場で書き換える）の地を抜く。body（faceBody）の範囲の中は毛先のあいだの地として抜かない。輪に地の連なりを読めない絵は落ちる。
export function matteFace(data, width, height, label, body) {
  const ground = readGround(data, width, height);
  if (ground.run < MATTE_MIN_RUN) {
    throw new Error(`conversation layer: face ${label} has no single ground on its rim (longest run ${ground.run} of ${ground.segments.length} segments, needs ${MATTE_MIN_RUN})`);
  }
  const field = groundField(ground, width, height);
  const count = width * height;
  const distance = new Float32Array(count);
  for (let p = 0; p < count; p += 1) {
    distance[p] = Math.hypot(data[p * 4] - field[p * 3], data[p * 4 + 1] - field[p * 3 + 1], data[p * 4 + 2] - field[p * 3 + 2]);
  }

  // 輪から地続きの所: 地に近い所を半径 MATTE_OPEN の四角で削った芯を、輪の揃った区画から辿り、地に近い所へ MATTE_REACH 画素広げる。
  // 外周の淡い縁（MATTE_INSET の帯）は辿らず、最後に、内側の一番近い画素が抜けているか、それ自身が地にごく近ければ抜く。
  const near = new Uint8Array(count);
  for (let p = 0; p < count; p += 1) near[p] = distance[p] < MATTE_SOLID ? 1 : 0;
  // 削りは行と列に分けて見る（絵の外は地に近いとみる）。
  const across = new Uint8Array(count);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let all = 1;
      for (let d = Math.max(x - MATTE_OPEN, 0); d <= Math.min(x + MATTE_OPEN, width - 1) && all; d += 1) all = near[y * width + d];
      across[y * width + x] = all;
    }
  }
  const core = new Uint8Array(count);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let all = 1;
      for (let d = Math.max(y - MATTE_OPEN, 0); d <= Math.min(y + MATTE_OPEN, height - 1) && all; d += 1) all = across[d * width + x];
      core[y * width + x] = all;
    }
  }
  const inFrame = (p) => {
    const x = p % width;
    const y = (p - x) / width;
    return x < MATTE_INSET || y < MATTE_INSET || x >= width - MATTE_INSET || y >= height - MATTE_INSET;
  };
  const reached = new Uint8Array(count);
  const queue = new Int32Array(count);
  let tail = 0;
  for (const segment of ground.segments) {
    if (!segment.uniform) continue;
    for (const p of segment.pixels) {
      if (reached[p] || !core[p] || distance[p] >= MATTE_CLEAR) continue;
      reached[p] = 1;
      queue[tail++] = p;
    }
  }
  for (let head = 0; head < tail; head += 1) {
    for (const q of neighbors4(queue[head], width, count)) {
      if (q < 0 || reached[q] || !core[q] || inFrame(q)) continue;
      reached[q] = 1;
      queue[tail++] = q;
    }
  }
  let front = queue.subarray(0, tail);
  for (let step = 0; step < MATTE_REACH && front.length; step += 1) {
    const next = [];
    for (const p of front) {
      for (const q of neighbors8(p, width, count)) {
        if (reached[q] || !near[q] || inFrame(q)) continue;
        reached[q] = 1;
        next.push(q);
      }
    }
    front = next;
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      if (!near[p] || !inFrame(p)) continue;
      const inner = Math.min(Math.max(y, MATTE_INSET), height - 1 - MATTE_INSET) * width + Math.min(Math.max(x, MATTE_INSET), width - 1 - MATTE_INSET);
      if (reached[inner] || distance[p] < MATTE_CLEAR) reached[p] = 1;
    }
  }

  // 閉じ込められた地: 地にごく近い色の塊を広げ、広げた所がほぼ一様なら抜く。
  const outside = reached.slice();
  const stamp = new Int32Array(count);
  let pocketId = 0;
  let pockets = 0;
  for (let s = 0; s < count; s += 1) {
    if (reached[s] || stamp[s] || distance[s] >= MATTE_POCKET) continue;
    pocketId += 1;
    const core = [s];
    stamp[s] = pocketId;
    for (let h = 0; h < core.length; h += 1) {
      for (const q of neighbors4(core[h], width, count)) {
        if (q < 0 || reached[q] || stamp[q] === pocketId || distance[q] >= MATTE_POCKET) continue;
        stamp[q] = pocketId;
        core.push(q);
      }
    }
    if (core.length < MATTE_POCKET_AREA) continue;
    const region = [...core];
    for (let h = 0; h < region.length; h += 1) {
      for (const q of neighbors4(region[h], width, count)) {
        if (q < 0 || reached[q] || stamp[q] === pocketId || distance[q] >= MATTE_SOLID) continue;
        stamp[q] = pocketId;
        region.push(q);
      }
    }
    let flat = 0;
    for (const p of region) if (distance[p] < MATTE_POCKET) flat += 1;
    if (flat / region.length < MATTE_POCKET_FLAT) continue;
    for (const p of region) reached[p] = 1;
    pockets += 1;
  }

  // 毛先のあいだの地: 地に近い（MATTE_CLEAR 未満）色の塊を地に近い所（MATTE_SOLID 未満）へ広げた所は、その塊を含む MATTE_SOLID 未満の
  // 4 近傍の塊そのものなので、塊ごとに一度だけ判定する。MATTE_BAG_NEAR 以上が地に近く、絵の下の縁から MATTE_BAG_FLOOR の内に触れず、
  // 地に近い色の画素が輪から地続きに抜けた所に接するか、接しなくても細長く（長い辺が MATTE_SLIVER_LENGTH 以上で、広さが長い辺の
  // MATTE_SLIVER_WIDTH 倍以下）、輪から地続きに抜けた所から MATTE_SLIVER_GAP 画素（8 近傍の歩数）の内に届くなら抜く。
  // 抜けた所からの歩数は、閉じた細長い袋が出たときに一度だけ数える。
  let gap = null;
  const reachGap = () => {
    const steps = new Uint8Array(count).fill(MATTE_SLIVER_GAP + 1);
    let edge = [];
    for (let p = 0; p < count; p += 1) {
      if (!outside[p] || inFrame(p)) continue;
      steps[p] = 0;
      edge.push(p);
    }
    for (let step = 1; step <= MATTE_SLIVER_GAP && edge.length; step += 1) {
      const next = [];
      for (const p of edge) {
        for (const q of neighbors8(p, width, count)) {
          if (steps[q] <= step) continue;
          steps[q] = step;
          next.push(q);
        }
      }
      edge = next;
    }
    return steps;
  };
  const inBody = (p) => {
    if (!body) return false;
    const x = p % width;
    const y = (p - x) / width;
    return ((x / width - body.cx) / body.rx) ** 2 + ((y / height - body.cy) / body.ry) ** 2 <= 1;
  };
  const bag = new Uint8Array(count);
  for (let s = 0; s < count; s += 1) {
    if (reached[s] || bag[s] || distance[s] >= MATTE_CLEAR) continue;
    const region = [s];
    bag[s] = 1;
    for (let h = 0; h < region.length; h += 1) {
      for (const q of neighbors4(region[h], width, count)) {
        if (q < 0 || reached[q] || bag[q] || distance[q] >= MATTE_SOLID) continue;
        bag[q] = 1;
        region.push(q);
      }
    }
    let near = 0;
    let opens = false;
    let floor = false;
    let left = width;
    let right = 0;
    let top = height;
    let bottom = 0;
    for (const p of region) {
      if (distance[p] < MATTE_CLEAR) {
        near += 1;
        if (!opens) opens = neighbors4(p, width, count).some((q) => q >= 0 && outside[q] && !inFrame(q));
      }
      if (p >= (height - MATTE_BAG_FLOOR) * width) floor = true;
      const x = p % width;
      const y = (p - x) / width;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    if (floor || near / region.length < MATTE_BAG_NEAR) continue;
    const length = Math.max(right - left, bottom - top) + 1;
    if (!opens) {
      if (length < MATTE_SLIVER_LENGTH || region.length > MATTE_SLIVER_WIDTH * length) continue;
      gap ??= reachGap();
      if (!region.some((p) => gap[p] <= MATTE_SLIVER_GAP)) continue;
    }
    for (const p of region) if (!inBody(p)) reached[p] = 1;
  }

  const alpha = new Float32Array(count).fill(1);
  for (let p = 0; p < count; p += 1) {
    if (!reached[p]) continue;
    const t = Math.min(Math.max((distance[p] - MATTE_CLEAR) / (MATTE_SOLID - MATTE_CLEAR), 0), 1);
    alpha[p] = t * t * (3 - 2 * t);
  }

  // 際: 抜けきった画素に接する画素は、地と、その近くでいちばん地から遠い色（輪郭）の混ざりとみる。
  const edge = new Float32Array(count).fill(-1);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      if (alpha[p] === 0) continue;
      let touches = false;
      for (let dy = -1; dy <= 1 && !touches; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < width && ny < height && alpha[ny * width + nx] === 0) {
            touches = true;
            break;
          }
        }
      }
      if (!touches) continue;
      let far = p;
      for (let dy = -MATTE_EDGE_REACH; dy <= MATTE_EDGE_REACH; dy += 1) {
        for (let dx = -MATTE_EDGE_REACH; dx <= MATTE_EDGE_REACH; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (distance[ny * width + nx] > distance[far]) far = ny * width + nx;
        }
      }
      let along = 0;
      let span = 0;
      for (let c = 0; c < 3; c += 1) {
        const g = field[p * 3 + c];
        along += (data[p * 4 + c] - g) * (data[far * 4 + c] - g);
        span += (data[far * 4 + c] - g) ** 2;
      }
      if (span < MATTE_SOLID * MATTE_SOLID) continue;
      edge[p] = Math.min(Math.max(along / span, 0), 1);
    }
  }
  for (let p = 0; p < count; p += 1) if (edge[p] >= 0) alpha[p] = Math.min(alpha[p], edge[p]);

  // かけら: 周り 8 画素のうち 5 以上が抜けている地に近い画素を抜き、抜いた所の隣を見直す。
  const isFragment = (p) => {
    if (alpha[p] < MATTE_FRAGMENT_CLEAR || distance[p] >= MATTE_FRAGMENT_NEAR) return false;
    let open = 0;
    for (const q of neighbors8(p, width, count)) if (alpha[q] < MATTE_FRAGMENT_CLEAR) open += 1;
    return open >= MATTE_FRAGMENT_OPEN;
  };
  const looked = new Int32Array(count);
  let fragments = [];
  for (let p = 0; p < count; p += 1) if (isFragment(p)) fragments.push(p);
  for (let round = 1; fragments.length; round += 1) {
    for (const p of fragments) alpha[p] = 0;
    const next = [];
    for (const p of fragments) {
      for (const q of neighbors8(p, width, count)) {
        if (looked[q] === round) continue;
        looked[q] = round;
        if (isFragment(q)) next.push(q);
      }
    }
    fragments = next;
  }

  for (let p = 0; p < count; p += 1) {
    const a = alpha[p];
    if (a >= 1) continue;
    for (let c = 0; c < 3; c += 1) {
      const g = field[p * 3 + c];
      data[p * 4 + c] = a > 0 ? Math.min(255, Math.max(0, g + (data[p * 4 + c] - g) / a)) : 0;
    }
    data[p * 4 + 3] = Math.round(a * 255);
  }
  return { ground: ground.color, spread: ground.spread, run: ground.run, pockets };
}

// 製品の顔の絵（同じ origin）を読み、地を抜いた絵の object URL にする。絵ごとに一度だけ作る。
const mattedFaces = new Map();

async function drawMatted(src) {
  const image = new Image();
  image.src = src;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  matteFace(pixels.data, canvas.width, canvas.height, src, faceBody(src));
  context.putImageData(pixels, 0, 0);
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((result) => (result ? resolve(result) : reject(new Error(`conversation layer: face ${src} did not encode`))), 'image/png');
  });
  return URL.createObjectURL(blob);
}

export function mattedFace(src) {
  if (!mattedFaces.has(src)) mattedFaces.set(src, drawMatted(src));
  return mattedFaces.get(src);
}

// 地を抜いた絵に舞台の光を薄く乗せる: 光の色を一番強い色の成分で 1 に揃えた色で照らし（LIT_TINT の割合だけ掛ける）、光の色を
// LIT_GLOW の割合だけ明るく重ねる。上ほど強く（舞台の光は上から来る）、透明度は変えない。
const LIT_TINT = [0.34, 0.18];
const LIT_GLOW = [0.12, 0.04];
const litFaces = new Map();

async function drawLit(src, light) {
  const image = new Image();
  image.src = await mattedFace(src);
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width, height } = pixels;
  const peak = Math.max(...light);
  const color = light.map((value) => value / peak);
  for (let y = 0; y < height; y += 1) {
    const v = y / (height - 1);
    const tint = LIT_TINT[0] + (LIT_TINT[1] - LIT_TINT[0]) * v;
    const glow = LIT_GLOW[0] + (LIT_GLOW[1] - LIT_GLOW[0]) * v;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (data[i + 3] === 0) continue;
      for (let c = 0; c < 3; c += 1) {
        const lit = data[i + c] * (1 - tint + tint * color[c]);
        data[i + c] = Math.round(lit + (light[c] - lit) * glow);
      }
    }
  }
  context.putImageData(pixels, 0, 0);
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((result) => (result ? resolve(result) : reject(new Error(`conversation layer: lit face ${src} did not encode`))), 'image/png');
  });
  return URL.createObjectURL(blob);
}

export function litFace(src, light) {
  const key = `${src} ${light.join(' ')}`;
  if (!litFaces.has(key)) litFaces.set(key, drawLit(src, light));
  return litFaces.get(key);
}

// ── 顔: いちばん新しい相手の言葉の顔へ溶け替える ───────────────────────────────────────────────────────────
function latestPartnerRow() {
  const rows = stream.querySelectorAll('.chat-message.character-message');
  return rows.length ? rows[rows.length - 1] : null;
}

// 製品は相手の言葉の行の data-expression に、その行の顔の表情を書く。表情の名は撮影の確かめに使う。
function expressionOf(row) {
  const { expression } = row.dataset;
  if (!expression) throw new Error('conversation layer: a partner row has no data-expression');
  return expression;
}

// 見えている層はいつも一枚。人が居る間の表情の移りは、今の層が舞台の光に明るみきったところで次の層へ入れ替え、次の層が明るみから
// 落ち着く（二つの層を重ねて溶け替えない）。人が居ない・溶けて去る途中なら、明るみを挟まずに入れ替える。動きを減らす設定では
// 明るみの動きが無いので、すぐ入れ替わる。
async function showFace(src, expression) {
  const request = ++faceRequest;
  const [lit, fade] = await Promise.all([stageLightReady.then((light) => litFace(src, light)), faceFade(src)]);
  if (request !== faceRequest) return;
  const next = faceLayers.find((layer) => layer !== shownLayer);
  next.src = lit;
  next.dataset.faceSrc = src;
  await next.decode();
  if (request !== faceRequest) return;
  const outgoing = shownLayer;
  const changing = outgoing !== null && face.classList.contains('is-present') && !face.classList.contains('is-leaving');
  if (changing) {
    outgoing.classList.remove('is-settling');
    outgoing.classList.add('is-rising');
    await animationsFinish(outgoing);
    if (request !== faceRequest) return;
  }
  for (const layer of faceLayers) layer.classList.remove('is-rising', 'is-settling', 'is-shown');
  next.classList.add('is-shown');
  if (changing) next.classList.add('is-settling');
  shownLayer = next;
  face.dataset.faceFade = fade;
  face.dataset.expression = expression;
  face.classList.add('is-present');
  face.classList.remove('is-awaiting', 'is-leaving');
  face.dataset.faceChanges = String(Number(face.dataset.faceChanges ?? 0) + 1);
}

function followPartner() {
  const row = latestPartnerRow();
  if (!row) return;
  const image = requireNode('.message-face img', row);
  const speaker = requireNode('.message-speaker', row);
  if (!row.dataset.characterId) throw new Error('conversation layer: a partner row has no data-character-id');
  face.dataset.partner = row.dataset.characterId;
  if (faceName.textContent !== speaker.textContent) {
    faceName.textContent = speaker.textContent;
    faceWell.setAttribute('aria-label', `${speaker.textContent}を見る`);
    input.setAttribute('aria-label', `${speaker.textContent}に話しかける`);
  }
  const src = image.getAttribute('src');
  if (!src || src === shownSrc) return;
  shownSrc = src;
  showFace(src, expressionOf(row)).catch((error) => {
    console.error(`conversation layer: face ${src} did not load`, error);
  });
}

function resetFace() {
  faceRequest += 1;
  shownSrc = null;
  shownLayer = null;
  for (const layer of faceLayers) {
    layer.classList.remove('is-shown', 'is-rising', 'is-settling');
    layer.removeAttribute('src');
    delete layer.dataset.faceSrc;
  }
  faceName.textContent = '';
  delete face.dataset.partner;
  delete face.dataset.expression;
  delete face.dataset.faceFade;
  face.dataset.faceChanges = '0';
  face.classList.remove('is-present', 'is-leaving', 'is-arrived');
  face.classList.add('is-awaiting');
}

// 会話へ移るあいだに現れた顔を、現れきった姿のまま受け取る（cl-emerge を掛け直さない）。地と名は placeStageArt が同じ舞台を置いた後。
function receiveFace({ stage, light, faceSrc, lit, fade, name, characterId }) {
  const placed = product.conversationStage();
  if (placed.id !== stage.id || placed.displayName !== stage.displayName || placed.backgroundUrl !== stage.backgroundUrl) {
    throw new Error(`conversation layer: the passage showed ${JSON.stringify(stage)} but the conversation is at ${JSON.stringify(placed)}`);
  }
  screen.style.setProperty('--cl-light-rgb', light.join(' '));
  screen.dataset.clLight = light.join(' ');
  const [first] = faceLayers;
  first.src = lit;
  first.dataset.faceSrc = faceSrc;
  first.classList.add('is-shown');
  shownLayer = first;
  shownSrc = faceSrc;
  faceName.textContent = name;
  faceWell.setAttribute('aria-label', `${name}を見る`);
  input.setAttribute('aria-label', `${name}に話しかける`);
  face.dataset.partner = characterId;
  face.dataset.faceFade = fade;
  face.dataset.expression = 'neutral';
  face.classList.remove('is-awaiting');
  face.classList.add('is-present', 'is-arrived');
}

// 顔を押すと、製品の相手の名（いちばん新しい相手の言葉の名）を押して、製品の相手の小窓を開く。
faceWell.addEventListener('click', () => {
  const row = latestPartnerRow();
  if (row) requireNode('.message-speaker', row).click();
});

// ── 閉じる: 人が光へ溶けて消えてから、製品の会話を終える ────────────────────────────────────────────────────────
const endButton = requireNode('#conversation-day-end');
let releasingEnd = false;

async function animationsFinish(node) {
  // 動きを今の style で立ててから読む。
  void getComputedStyle(node).opacity;
  for (const animation of node.getAnimations()) {
    await animation.finished.catch((error) => {
      // 画面が閉じるなどで動きが止められたら、待つものは無い。
      if (error.name !== 'AbortError') throw error;
    });
  }
}

async function leaveFace() {
  if (face.classList.contains('is-leaving')) throw new Error('conversation layer: the person is already leaving');
  face.classList.remove('is-arrived');
  face.classList.add('is-leaving');
  await animationsFinish(face);
}

// 卒業の会話では人は消えない: 会話を終えると、相手の顔・名・最後の一言がそのまま場所の絵の上に残り、星の道へ続く（metaJourney.js の
// walkGraduationRoad）。
function partnerStaysOnEnd() {
  return product.isGraduationConversation();
}

// 製品が会話を終える前に待つ口。印の立った会話の画面に人が居れば、人が光へ溶けて消えるまで待つ（居なければ・卒業の会話ではすぐ返る）。
export function partnerLeaves() {
  if (!layerActive || !face.classList.contains('is-present') || face.classList.contains('is-leaving') || partnerStaysOnEnd()) return Promise.resolve();
  return leaveFace();
}

// 札の部屋から会話に移ったとき、app.js が札を退かせる前に待つ口。印の立った会話の画面で、相手が光の中から現れきるまで待つ（印の
// 立った会話の画面でなければすぐ返る。動きを減らす設定では現れた時点で返る）。
export function partnerEmerged() {
  if (!layerActive) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => check());
    function check() {
      if (!face.classList.contains('is-present')) return;
      observer.disconnect();
      animationsFinish(face).then(resolve, reject);
    }
    observer.observe(face, { attributes: true, attributeFilter: ['class'] });
    check();
  });
}

endButton.addEventListener('click', (event) => {
  if (releasingEnd || !layerActive || !face.classList.contains('is-present') || partnerStaysOnEnd()) return;
  event.stopImmediatePropagation();
  if (face.classList.contains('is-leaving')) return;
  const release = () => {
    releasingEnd = true;
    endButton.click();
    releasingEnd = false;
  };
  leaveFace().then(release, (error) => {
    release();
    throw error;
  });
}, { capture: true });

// ── 途中の移動: 人が光へ溶けて消え、地と名が新しい場所へ移ろい、移ろい終えてから人が新しい場所の光の中から現れる ───────────
// 着く動き（場所が先・人が遅れて光から現れる cl-emerge）と閉じる動き（cl-recede）をそのまま並べる。人が現れ終えたら返る（app.js は
// それを待ってから新しい場所での最初の言葉を出す）。動きを減らす設定では動きが無いので、待たずに切り替わる。
// 現れるのは消えたときに見えていた顔の絵（地を抜き終えている）を新しい場所の光で照らし直したもので、まだ地を抜いている途中の新しい
// 表情は待たない。表情は人が現れてから、いつもの溶け替えで追いつく。
const stageGround = requireNode('#conversation-day-screen .conversation-day-background');

// 場所が移るのは、いま居る舞台を地にする会話の種類だけ（依頼・研究会・ホムンクルスの舞台は種類ごとに決まっている）。
const STAGE_MOVING_KINDS = new Set(['field', 'event']);

export async function stageMoves(locationId) {
  if (!layerActive) return;
  if (!STAGE_MOVING_KINDS.has(screen.dataset.conversationKind)) {
    throw new Error(`conversation layer: a ${screen.dataset.conversationKind} conversation has a fixed stage and cannot move to ${locationId}`);
  }
  // 溶け替えの途中の表情が移動の途中で現れないよう、待っている顔の要求を打ち切る。
  faceRequest += 1;
  const src = shownLayer?.dataset.faceSrc;
  // 新しい場所の光と、その光で照らした顔の絵は、人が溶けて地が移ろう間に作っておく。
  const relit = src ? stageLight(product.location(locationId).backgroundUrl).then((light) => litFace(src, light)) : null;
  if (src) await leaveFace();
  placeStageArt(product.location(locationId));
  await animationsFinish(stageGround);
  if (!src) return;
  await relit;
  shownSrc = src;
  await showFace(src, face.dataset.expression);
  await animationsFinish(face);
  followPartner();
}

// ── 失敗したターンの後: 地と名をいる場所へ戻す ─────────────────────────────────────────────────────────────
// 移動を知らせたターンが失敗したら、app.js がサーバーから読み直したいる場所でこれを呼ぶ。地がすでにいる場所なら何もしない。違えば
// 途中の移動と同じ見せ方（人が溶ける → 地と名 → 人が現れる）でいる場所へ移す。
export async function stageReturns(locationId) {
  if (!layerActive || screen.dataset.clStage === locationId) return;
  await stageMoves(locationId);
}

// ── 会話へ移るあいだ: 読み込みの画面の上で、夜から行き先の場所が満ち、応答が始まると顔が現れる ─────────────────────────
// 段は #academy-loading-screen の data-conversation-passage に立てる（CSS が段ごとの見せ方を持つ）:
//   dark（行き先がまだ分からない・夜だけ）→ waiting（場所が満ち、満ちきると明るみが息をする）→ long-wait（PASSAGE_LONG_WAIT_MS を
//   過ぎても応答が始まらない・場所が少し沈み、息がゆっくりになる）→ arriving（明るみが顔へ譲り、顔が現れる）。
//   失敗は waiting・long-wait から stopped（明るみが消え、場所が夜へ沈む）。
// 段の外の呼び方（順の飛ばし・二重の始まり）は落ちる。
const loadingScreen = requireNode('#academy-loading-screen');
const passage = requireNode('.cl-passage', loadingScreen);
const passageStage = requireNode('.cl-passage-stage', passage);
const passageGlow = requireNode('.cl-passage-glow', passage);
const passageFaceSlot = requireNode('.cl-passage-face', passage);
const passageWeek = requireNode('.cl-passage-week', passage);
const passageStageName = requireNode('.cl-passage-stage-name', passage);
const productWeek = requireNode('#conversation-day-week');
const passageFace = face.cloneNode(true);
passageFace.removeAttribute('id');
passageFace.classList.remove('is-awaiting');
passageFaceSlot.append(passageFace);
const passageFaceLayer = requireNode('.cl-face-layer', passageFace);
const passageFaceName = requireNode('.cl-face-name', passageFace);

// 応答が始まらないまま、場所が満ちはじめてからこれだけ経つと「待ちが長引いた」に移る。LM の応答の始まりは、開幕の言葉を流す会話
// （学院・出来事）で数秒、開幕の言葉を一度に返す会話（ホムンクルス）でも十数秒に収まる。
export const PASSAGE_LONG_WAIT_MS = 20000;

let passagePlaced = null;
let passageLongWait = null;
// 応答が始まって現れた顔（会話の画面に着いたら、層がこれをそのまま受け取る）。
let passageHandoff = null;

function passageStep() {
  return loadingScreen.dataset.conversationPassage;
}

function requirePassageStep(steps, action) {
  if (!steps.includes(passageStep())) {
    throw new Error(`conversation layer: the passage cannot ${action} at step ${JSON.stringify(passageStep() ?? null)}`);
  }
}

// 有限の動き（息のような繰り返しは除く）が終わるまで待つ。動きを減らす設定では動きが無いので、すぐ返る。
async function finiteAnimationsFinish(node) {
  void getComputedStyle(node).opacity;
  for (const animation of node.getAnimations()) {
    if (animation.effect.getComputedTiming().iterations === Infinity) continue;
    await animation.finished.catch((error) => {
      if (error.name !== 'AbortError') throw error;
    });
  }
}

// 段を替える直前の場所と明るみの見え方を写す。次の段の動き（明るみが消える・場所が戻る／沈む）はそこから始まる。
function holdPassageLook() {
  const stageLook = getComputedStyle(passageStage);
  loadingScreen.style.setProperty('--cl-passage-held-opacity', stageLook.opacity);
  loadingScreen.style.setProperty('--cl-passage-held-filter', stageLook.filter);
  loadingScreen.style.setProperty('--cl-passage-held-glow', getComputedStyle(passageGlow).opacity);
}

function clearPassageLongWait() {
  clearTimeout(passageLongWait);
  passageLongWait = null;
}

export function passageShowing() {
  return passageStep() !== undefined;
}

// 移り変わりを始める（夜だけ）。週の字は会話の画面と同じ字を見えないまま置き、舞台の名を会話の画面と同じ場所に立たせる。
export function passageBegins() {
  if (passageShowing()) throw new Error('conversation layer: the passage has already begun');
  passagePlaced = null;
  passageHandoff = null;
  passageWeek.textContent = productWeek.textContent;
  passageStageName.textContent = '';
  passageFaceLayer.removeAttribute('src');
  passageFaceLayer.classList.remove('is-shown');
  passageFaceName.textContent = '';
  delete passageFace.dataset.partner;
  delete passageFace.dataset.faceFade;
  passageFace.classList.remove('is-present');
  loadingScreen.dataset.conversationPassage = 'dark';
}

// 行き先の場所（読み口の舞台の形 { id, displayName, backgroundUrl }）が分かった: 夜から満ちはじめる。
export function passagePlaces(stage) {
  requirePassageStep(['dark'], 'place the stage');
  passagePlaced = { stage, light: stageLight(stage.backgroundUrl) };
  loadingScreen.style.setProperty('--cl-stage-art', `url('${stage.backgroundUrl}')`);
  passageStageName.textContent = stage.displayName;
  passagePlaced.light.then((light) => {
    if (passagePlaced?.stage === stage) loadingScreen.style.setProperty('--cl-light-rgb', light.join(' '));
  });
  loadingScreen.dataset.conversationPassage = 'waiting';
  passageLongWait = setTimeout(() => {
    passageLongWait = null;
    if (passageStep() !== 'waiting') return;
    loadingScreen.dataset.conversationPassage = 'long-wait';
  }, PASSAGE_LONG_WAIT_MS);
}

// 応答が始まった: 場所が満ちきるのを待ち、明るみが顔へ譲って顔が現れる。現れきったら返る。
// partner: { characterId, faceSrc（製品が相手の言葉に出す顔の絵）, name }。
export async function passageArrives({ characterId, faceSrc, name }) {
  requirePassageStep(['waiting', 'long-wait'], 'arrive');
  clearPassageLongWait();
  const { stage } = passagePlaced;
  const light = await passagePlaced.light;
  const [lit, fade] = await Promise.all([litFace(faceSrc, light), faceFade(faceSrc)]);
  passageFaceLayer.src = lit;
  await passageFaceLayer.decode();
  await finiteAnimationsFinish(passageStage);
  requirePassageStep(['waiting', 'long-wait'], 'arrive');
  passageFaceLayer.classList.add('is-shown');
  passageFaceName.textContent = name;
  passageFace.dataset.partner = characterId;
  passageFace.dataset.faceFade = fade;
  loadingScreen.style.setProperty('--cl-light-rgb', light.join(' '));
  holdPassageLook();
  loadingScreen.dataset.conversationPassage = 'arriving';
  passageFace.classList.add('is-present');
  await finiteAnimationsFinish(passageFace);
  passageHandoff = { stage, light, faceSrc, lit, fade, name, characterId };
}

// 失敗した: 明るみが消え、場所が夜へ沈む。沈みきったら返る（動きを減らす設定では待たずに返る）。行き先がまだ夜のうち（dark）は
// 沈むものが無いので待たない。
export async function passageStops() {
  requirePassageStep(['dark', 'waiting', 'long-wait'], 'stop');
  clearPassageLongWait();
  const placed = passageStep() !== 'dark';
  holdPassageLook();
  loadingScreen.dataset.conversationPassage = 'stopped';
  if (placed) await finiteAnimationsFinish(passageStage);
}

// 読み込みの画面を離れた: 移り変わりを下ろす（顔の受け渡しは、会話の画面に着いた層が受け取るまで残す）。
export function passageEnds() {
  clearPassageLongWait();
  passagePlaced = null;
  delete loadingScreen.dataset.conversationPassage;
  for (const property of ['--cl-stage-art', '--cl-light-rgb', '--cl-passage-held-opacity', '--cl-passage-held-filter', '--cl-passage-held-glow']) {
    loadingScreen.style.removeProperty(property);
  }
}

// ── 起動: 製品の起動（タイトルを出すまで）を待ち、印が立てば整え、印の立った会話の画面に着くたびに地と顔を整える ──────────
function waitForProductBoot() {
  return new Promise((resolve) => {
    const check = () => {
      if (document.querySelector('#journey')?.dataset.journeyReady === 'true') {
        resolve();
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

let dressed = false;
let layerActive = false;

function followKind() {
  const marked = screen.dataset.conversationKind !== undefined;
  if (marked && !dressed) {
    dressControls();
    dressed = true;
  } else if (!marked && dressed) {
    undressControls();
    dressed = false;
  }
  const active = marked && screen.classList.contains('active');
  if (active && !layerActive) {
    resetFace();
    // 着いた場所は着いた瞬間から見える（前の会話の場所の絵から溶け替えない — 溶け替えは会話の途中の移動だけ）。
    stageGround.style.transition = 'none';
    placeStageArt(product.conversationStage());
    void getComputedStyle(stageGround).backgroundImage;
    stageGround.style.removeProperty('transition');
    if (passageHandoff) receiveFace(passageHandoff);
    passageHandoff = null;
    followPartner();
  }
  layerActive = active;
}

async function start(reading) {
  await waitForProductBoot();
  product = reading;
  resetFace();
  new MutationObserver(() => followKind()).observe(screen, { attributes: true, attributeFilter: ['class', 'data-conversation-kind'] });
  new MutationObserver(() => {
    if (layerActive) followPartner();
  }).observe(stream, { childList: true });
  followKind();
  face.dataset.clReady = 'true';
}

// reading: app.js の読み口（region・currentLocationId・location・conversationStage・nodes・isGraduationConversation）。
export function startConversationLayer(reading) {
  start(reading).catch((error) => {
    face.dataset.clReady = 'failed';
    throw error;
  });
}
