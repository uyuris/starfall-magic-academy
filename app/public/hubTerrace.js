// 露台のハブ（#routing-hub-screen）の描き方の片割れ。見た目は hubTerrace.css が持ち、ここは次を持つ:
// - 紋と空の絵: 左の列から開く画面の紋（能力の名前は hubTerraceSigils.svg の symbol・戻る・処分の確かめ・星の揺り籠の操作は
//   ここの SVG）と、空を知らせる点線の絵。名前は読み上げの側（aria-label）にだけ持たせ、title は置かない。
// - 行き先の名: 案内人の言葉に出た行き先の名に淡い光を差し、指を乗せるとその行き先の画面の絵を露台の向こうに透かす。
// - 送り出しの幕: 行き先が決まった応答（routing_draining の destination_id）で、その行き先の絵を露台の向こうでゆっくり開き、
//   送り出しの言葉が灯りきってから幕で画面を満たす。ハブを離れたら（または幕の上に行き先へ入る待ちが置かれたら）その場で
//   満たしきり、行き先の画面（またはハブ）が出たところで幕を上げる。
// - 戻った週: 行き先から戻った直後（いまの週に適用済みの週進行）なら、ハブの開始が済んで会話のあるハブが出たところで、
//   その場所の絵を露台の向こうに置いてから薄れさせる。
// - 開いている間の左の列: 帯・装備の小窓が開いている間に別の印か天球儀を押すと、離れる側を製品の閉じる釦で閉じてから押された
//   側を開き、いま開いている印を押すと閉じる。揺り籠が開いている間は、その下に隠れる左の列を inert にする。
// 製品への要求は足さない（読むのは app.js が既に受け取った応答だけ）。

// 行き先 → その行き先の画面がいま使っている一枚の絵。行き先の id と名はハブの開始の応答（routing_destinations）で届き、
// この表と id の集合に過不足があれば throw する（setDestinations）。
const DESTINATION_ART = Object.freeze({
  'academy-map': '/canonical/academy_map/overview.jpg',
  training: '/canonical/training/background.jpg',
  dungeon: '/canonical/dungeon/entrance.png',
  errand: '/canonical/errand/stage.jpg',
  alchemy: '/canonical/alchemy/stage.jpg',
  study_circle: '/canonical/study_circle/stage.jpg',
  workshop: '/canonical/workshop/stage.jpg',
  library: '/canonical/library/stage.jpg',
  arena: '/canonical/arena/stage.jpg',
  auction: '/canonical/auction/stage.jpg',
  lounge: '/canonical/lounge/stage.jpg',
  concert_hall: '/canonical/concert_hall/stage.jpg',
  overlook: '/canonical/academy_overlook/field_map.jpg',
  homunculus: '/canonical/atelier/stage.jpg',
  title: '/canonical/title/title_night.jpg'
});

// 釦の紋（defs を持たない平らな塗り・同じ紋が一画面に何度も出るため）。
const SIGILS = Object.freeze({
  back: '<svg class="terrace-sigil terrace-sigil-back" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M4 16 L14 7 V12.5 C21 12.5 27 15.5 28 24 C25 19.5 21 18.5 14 18.5 V25 Z" fill="#2a3070" stroke="#dde3f6" stroke-width="1.3" stroke-linejoin="round" /><path d="M24.50 5.10 L25.17 6.83 L26.90 7.50 L25.17 8.17 L24.50 9.90 L23.83 8.17 L22.10 7.50 L23.83 6.83 Z" fill="#e8c877" /></svg>',
  keep: '<svg class="terrace-sigil terrace-sigil-keep" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M7 6 H22 A3 3 0 0 1 25 9 V26 H10 A3 3 0 0 1 7 23 Z" fill="#2a3070" stroke="#dde3f6" stroke-width="1.3" stroke-linejoin="round" /><path d="M10 26 A3 3 0 0 1 10 20 H25" fill="none" stroke="#dde3f6" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" /><path d="M16.00 10.00 L16.84 12.16 L19.00 13.00 L16.84 13.84 L16.00 16.00 L15.16 13.84 L13.00 13.00 L15.16 12.16 Z" fill="#e8c877" /></svg>',
  dispose: '<svg class="terrace-sigil terrace-sigil-dispose" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M16 3.5 C20 8.5 24.5 12 23.5 18.5 A7.5 7.5 0 0 1 8.5 18.5 C8 13.5 11.5 11.5 12 7.5 C13.8 9.8 14.7 11 15.5 12.3 C16.8 9.6 17 6.8 16 3.5 Z" fill="#2a3070" stroke="#dde3f6" stroke-width="1.3" stroke-linejoin="round" /><path d="M6 27 H26 M9.5 24 H22.5" fill="none" stroke="#dde3f6" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" /></svg>',
  plant: '<svg class="terrace-sigil terrace-sigil-plant" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M4.5 23 H27.5" fill="none" stroke="#dde3f6" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M16 23 V14" fill="#2a3070" stroke="#dde3f6" stroke-width="1.3" stroke-linejoin="round" /><path d="M16 16 C11 16 8.5 12.5 8.5 9 C13 9 16 12 16 16 Z" fill="#2a3070" stroke="#dde3f6" stroke-width="1.3" stroke-linejoin="round" /><path d="M16 14 C20 14 23 11 23 7 C19 7 16 10 16 14 Z" fill="#2a3070" stroke="#dde3f6" stroke-width="1.3" stroke-linejoin="round" /><ellipse cx="16" cy="26.5" rx="3" ry="1.6" fill="#e8c877" /></svg>',
  harvest: '<svg class="terrace-sigil terrace-sigil-harvest" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M6 17 H26 L23 27 H9 Z" fill="#2a3070" stroke="#dde3f6" stroke-width="1.3" stroke-linejoin="round" /><path d="M11 17 C11 12 13 9 16 9 C19 9 21 12 21 17" fill="#2a3070" stroke="#dde3f6" stroke-width="1.3" stroke-linejoin="round" /><path d="M16.00 2.90 L16.73 4.77 L18.60 5.50 L16.73 6.23 L16.00 8.10 L15.27 6.23 L13.40 5.50 L15.27 4.77 Z" fill="#e8c877" /><path d="M9.5 21.5 H22.5" fill="none" stroke="#dde3f6" stroke-width="1.0" stroke-linecap="round" stroke-linejoin="round" /></svg>',
  byproduct: '<svg class="terrace-sigil terrace-sigil-byproduct" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M8 12 C8 9 11 8 16 8 C21 8 24 9 24 12 L26 25 C26 27 22 28 16 28 C10 28 6 27 6 25 Z" fill="#2a3070" stroke="#dde3f6" stroke-width="1.3" stroke-linejoin="round" /><path d="M11 8 C12 5 20 5 21 8" fill="none" stroke="#dde3f6" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" /><path d="M16.00 14.00 L17.12 16.88 L20.00 18.00 L17.12 19.12 L16.00 22.00 L14.88 19.12 L12.00 18.00 L14.88 16.88 Z" fill="#e8c877" /></svg>',
  name: '<svg class="terrace-sigil terrace-sigil-name" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M26.5 4 C17.5 6 11.5 13 9 22 L10.5 23.5 C19.5 21 25.5 14 26.5 4 Z" fill="#2a3070" stroke="#dde3f6" stroke-width="1.2" stroke-linejoin="round" /><path d="M24.4 7 C18.6 11 13.6 16 10.2 22.6" fill="none" stroke="#dde3f6" stroke-width="0.8" stroke-linecap="round" stroke-linejoin="round" /><path d="M9 22 L5.2 27.6" fill="none" stroke="#dde3f6" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M24.50 23.80 L25.12 25.38 L26.70 26.00 L25.12 26.62 L24.50 28.20 L23.88 26.62 L22.30 26.00 L23.88 25.38 Z" fill="#e8c877" /></svg>',
  cage: '<svg class="terrace-sigil terrace-sigil-cage" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M7 27 V14 A9 9 0 0 1 25 14 V27 Z" fill="#2a3070" stroke="#dde3f6" stroke-width="1.3" stroke-linejoin="round" /><path d="M11.5 27 V10.5 M16 27 V5 M20.5 27 V10.5 M7 20 H25" fill="none" stroke="#dde3f6" stroke-width="1.0" stroke-linecap="round" stroke-linejoin="round" /><path d="M5 27 H27 M16 5 V2.5" fill="none" stroke="#dde3f6" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M16.00 14.10 L16.67 15.83 L18.40 16.50 L16.67 17.17 L16.00 18.90 L15.33 17.17 L13.60 16.50 L15.33 15.83 Z" fill="#e8c877" /></svg>',
  release: '<svg class="terrace-sigil terrace-sigil-release" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M3.5 20 C8 12 14 10 20 12 C16 13.5 13.5 16 12.5 19 C17 16.5 22 16.5 27.5 19 C21 21 15 24 9 24 Z" fill="#2a3070" stroke="#dde3f6" stroke-width="1.3" stroke-linejoin="round" /><path d="M23.00 4.80 L23.90 7.10 L26.20 8.00 L23.90 8.90 L23.00 11.20 L22.10 8.90 L19.80 8.00 L22.10 7.10 Z" fill="#e8c877" /><path d="M27.50 11.90 L27.95 13.05 L29.10 13.50 L27.95 13.95 L27.50 15.10 L27.05 13.95 L25.90 13.50 L27.05 13.05 Z" fill="#e8c877" /></svg>'
});

// 空を知らせる点線の絵。装備（gear）と持ち物（pouch）の二枚は一揃い: 丸い点を線分ごとの pathLength で等間隔に割り付け
// （角と端に必ず点が乗る）、金の灯りを同じ左上の座に置く。
const EMPTY_ART = Object.freeze({
  person: '<svg class="terrace-empty-art terrace-empty-person" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><circle cx="32" cy="22" r="9" fill="none" stroke="#dde3f6" stroke-width="1.1" stroke-dasharray="2.6 2.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M14 54 C14 41 22 35 32 35 C42 35 50 41 50 54" fill="none" stroke="#dde3f6" stroke-width="1.1" stroke-dasharray="2.6 2.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M32.00 19.40 L32.73 21.27 L34.60 22.00 L32.73 22.73 L32.00 24.60 L31.27 22.73 L29.40 22.00 L31.27 21.27 Z" fill="#e8c877" /></svg>',
  pouch: '<svg class="terrace-empty-art terrace-empty-pouch" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><g fill="none" stroke="#dde3f6" stroke-width="1.8" stroke-dasharray="0 1" stroke-linecap="round"><path d="M27 26 C18 30 13 37 13 44" pathLength="7" /><path d="M13 44 C13 51 21 54 32 54" pathLength="7" /><path d="M32 54 C43 54 51 51 51 44" pathLength="7" /><path d="M51 44 C51 37 46 30 37 26" pathLength="7" /><path d="M27 26 L37 26" pathLength="3" /><path d="M27 26 C26 23 24 20 23 17" pathLength="3" /><path d="M23 17 C28 19 36 19 41 17" pathLength="5" /><path d="M41 17 C40 20 38 23 37 26" pathLength="3" /></g><path d="M14.00 11.40 L14.73 13.27 L16.60 14.00 L14.73 14.73 L14.00 16.60 L13.27 14.73 L11.40 14.00 L13.27 13.27 Z" fill="#e8c877" /></svg>',
  diary: '<svg class="terrace-empty-art terrace-empty-diary" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><path d="M32 16 C24 12 16 12 8 14 V50 C16 48 24 48 32 52 C40 48 48 48 56 50 V14 C48 12 40 12 32 16 Z" fill="none" stroke="#dde3f6" stroke-width="1.1" stroke-dasharray="2.6 2.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M32 16 V52" fill="none" stroke="#dde3f6" stroke-width="1.1" stroke-dasharray="2.6 2.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M20.00 27.80 L20.62 29.38 L22.20 30.00 L20.62 30.62 L20.00 32.20 L19.38 30.62 L17.80 30.00 L19.38 29.38 Z" fill="#e8c877" /></svg>',
  shelf: '<svg class="terrace-empty-art terrace-empty-shelf" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><path d="M6 50 H58" fill="none" stroke="#dde3f6" stroke-width="1.3" stroke-linecap="round" /><path d="M12 50 V22 H19 V50 M22 50 V28 H28 V50 M33 50 V18 H40 V50" fill="none" stroke="#dde3f6" stroke-width="1.1" stroke-dasharray="2.6 2.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M48.00 37.60 L48.67 39.33 L50.40 40.00 L48.67 40.67 L48.00 42.40 L47.33 40.67 L45.60 40.00 L47.33 39.33 Z" fill="#e8c877" /></svg>',
  gear: '<svg class="terrace-empty-art terrace-empty-gear" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><g fill="none" stroke="#dde3f6" stroke-width="1.8" stroke-dasharray="0 1" stroke-linecap="round"><path d="M23.87 35.18 L42.96 16.09" pathLength="8" /><path d="M42.96 16.09 L50.38 13.62" pathLength="2" /><path d="M50.38 13.62 L47.91 21.04" pathLength="2" /><path d="M47.91 21.04 L28.82 40.13" pathLength="8" /><path d="M23.87 35.18 L28.82 40.13" pathLength="2" /><path d="M18.56 29.88 L34.12 45.44" pathLength="6" /><path d="M26.34 37.66 L18.28 45.72" pathLength="3" /><path d="M13.84 47.56 A2.6 2.6 0 1 1 19.04 47.56 A2.6 2.6 0 1 1 13.84 47.56" pathLength="5" /></g><path d="M14.00 11.40 L14.73 13.27 L16.60 14.00 L14.73 14.73 L14.00 16.60 L13.27 14.73 L11.40 14.00 L13.27 13.27 Z" fill="#e8c877" /></svg>',
  pot: '<svg class="terrace-empty-art terrace-empty-pot" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><path d="M16 36 H48 L44 56 H20 Z M14 32 H50 V36 H14 Z" fill="none" stroke="#dde3f6" stroke-width="1.1" stroke-dasharray="2.6 2.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M32.00 19.20 L32.78 21.22 L34.80 22.00 L32.78 22.78 L32.00 24.80 L31.22 22.78 L29.20 22.00 L31.22 21.22 Z" fill="#e8c877" /></svg>',
  nest: '<svg class="terrace-empty-art terrace-empty-nest" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><path d="M10 40 C10 52 54 52 54 40 M10 40 C18 34 46 34 54 40 M14 44 C22 40 42 40 50 44" fill="none" stroke="#dde3f6" stroke-width="1.1" stroke-dasharray="2.6 2.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M32.00 23.20 L32.78 25.22 L34.80 26.00 L32.78 26.78 L32.00 28.80 L31.22 26.78 L29.20 26.00 L31.22 25.22 Z" fill="#e8c877" /></svg>',
  cage: '<svg class="terrace-empty-art terrace-empty-cage" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><path d="M16 56 V28 A16 16 0 0 1 48 28 V56 Z M24 56 V20 M32 56 V12 M40 56 V20 M16 42 H48" fill="none" stroke="#dde3f6" stroke-width="1.1" stroke-dasharray="2.6 2.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M12 56 H52" fill="none" stroke="#dde3f6" stroke-width="1.3" stroke-linecap="round" /></svg>'
});

function svgFrom(markup) {
  const template = document.createElement('template');
  template.innerHTML = markup;
  return template.content.firstElementChild;
}

function nameForReadingOnly(element, name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(`hub terrace: ${element.className || element.localName} has no name to read out`);
  }
  element.setAttribute('aria-label', name.trim());
}

// 釦を紋の釦にする（名前は aria-label・中身は紋だけ）。
export function dressSigilButton(button, sigil, name) {
  if (!Object.hasOwn(SIGILS, sigil)) throw new Error(`hub terrace: unknown sigil ${JSON.stringify(sigil)}`);
  nameForReadingOnly(button, name);
  button.classList.add('terrace-sigil-button');
  button.replaceChildren(svgFrom(SIGILS[sigil]));
  return button;
}

// 能力の紋: flagship が通した hubTerraceSigils.svg の symbol（id は sigil-<能力の key>）。製品の静的配信は .svg を
// text/html で返し、外の file を指す <use href> は描かれないので、起動時に読み込んで symbol をハブの置き場
// （#terrace-sigil-symbols）へ写し、文書の中の <use href="#sigil-<key>"> で引く。
const ABILITY_SIGILS_URL = '/hubTerraceSigils.svg';
const SVG_NS = 'http://www.w3.org/2000/svg';

export async function loadAbilitySigils() {
  const response = await fetch(ABILITY_SIGILS_URL);
  if (!response.ok) throw new Error(`hub terrace: ${ABILITY_SIGILS_URL} answered ${response.status}`);
  const sheet = new DOMParser().parseFromString(await response.text(), 'image/svg+xml');
  if (sheet.querySelector('parsererror')) throw new Error(`hub terrace: ${ABILITY_SIGILS_URL} is not an SVG`);
  const symbols = sheet.documentElement.querySelectorAll(':scope > symbol[id^="sigil-"]');
  if (symbols.length === 0) throw new Error(`hub terrace: ${ABILITY_SIGILS_URL} has no sigil symbols`);
  required('#terrace-sigil-symbols').replaceChildren(...Array.from(symbols, (symbol) => document.importNode(symbol, true)));
}

// 能力の名前: 紋だけ（名前は role=img の aria-label）。
export function abilitySigilLabel(key, name) {
  const id = `sigil-${key}`;
  const symbol = document.getElementById(id);
  if (!(symbol instanceof SVGSymbolElement)) throw new Error(`hub terrace: no sigil symbol for the ability ${JSON.stringify(key)}`);
  const label = document.createElement('span');
  label.setAttribute('role', 'img');
  nameForReadingOnly(label, name);
  const sigil = document.createElementNS(SVG_NS, 'svg');
  sigil.setAttribute('class', `terrace-sigil terrace-sigil-ability terrace-sigil-${key}`);
  sigil.setAttribute('viewBox', symbol.getAttribute('viewBox'));
  sigil.setAttribute('aria-hidden', 'true');
  sigil.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${id}`);
  sigil.append(use);
  label.append(sigil);
  return label;
}

// 空を知らせる絵を element に置く（element は role=img・名前は製品の題と一文）。
export function fillWithEmptyArt(element, art, name) {
  if (!Object.hasOwn(EMPTY_ART, art)) throw new Error(`hub terrace: unknown empty picture ${JSON.stringify(art)}`);
  element.setAttribute('role', 'img');
  nameForReadingOnly(element, name);
  element.replaceChildren(svgFrom(EMPTY_ART[art]));
  return element;
}

// 送り出しの言葉の最後の断片が灯ってから画面を満たし始めるまでの間（製品の見送り読みポーズ 5 秒の内に満ち終わる長さ）。
const FILL_AFTER_SENDOFF_LIT_MS = 2200;

function required(selector, scope = document) {
  const node = scope.querySelector(selector);
  if (!node) throw new Error(`hub terrace: missing ${selector}`);
  return node;
}

// 送り出しの発話を製品の地の文の区切り（全角・半角の丸括弧の振る舞いを外した発話の断片）で見たときの最後の断片。
function lastSpokenPiece(content) {
  const pieces = content.split(/（[^（）]+）|\([^()]+\)/).map((piece) => piece.trim()).filter(Boolean);
  return pieces.length === 0 ? null : pieces[pieces.length - 1];
}

function paint(layer, url) {
  layer.style.backgroundImage = `url('${url}')`;
}

// 行き先から戻った直後: いまの週（elapsed_weeks）に適用済みの週進行があれば、それが戻ってきた場所。週進行が無いのは、
// まだどこへも行っていない週（新しく始めた週）。あるのに配列でなければ壊れた状態なので throw する。
function returnedDestinationId(state) {
  if (!Object.hasOwn(state, 'routing_week_progressions')) return null;
  if (!Array.isArray(state.routing_week_progressions)) {
    throw new Error(`hub terrace: runtime_state.routing_week_progressions must be an array when present, got ${JSON.stringify(state.routing_week_progressions)}`);
  }
  const applied = state.routing_week_progressions.filter((record) => record.phase === 'applied');
  const latest = applied[applied.length - 1];
  if (!latest || latest.elapsed_weeks !== state.elapsed_weeks || latest.destination_id === 'title') return null;
  return latest.destination_id;
}

// 行き先の場所の絵。行き先の画面の地は、送り出しの幕と同じこの一枚を引く。
export function destinationArt(id) {
  if (!Object.hasOwn(DESTINATION_ART, id)) throw new Error(`hub terrace: no art entry for the destination ${JSON.stringify(id)}`);
  return DESTINATION_ART[id];
}

// 行き先から露台へ戻る道の待ちの地にする、今週行ってきた場所の絵。行き先から戻る道でしか呼ばないので、
// 今週の週進行が無ければ throw する。
export function returnedPlaceArt(state) {
  const destinationId = returnedDestinationId(state);
  if (destinationId === null) throw new Error(`hub terrace: no destination has been visited in week ${JSON.stringify(state.elapsed_weeks)} to return from`);
  if (!Object.hasOwn(DESTINATION_ART, destinationId)) throw new Error(`hub terrace: no art entry for the returned destination ${JSON.stringify(destinationId)}`);
  return DESTINATION_ART[destinationId];
}

export function createHubTerrace() {
  const hub = required('#routing-hub-screen');
  const stream = required('#routing-hub-message-stream', hub);
  const peekArt = required('[data-terrace-art="peek"]', hub);
  const returnArt = required('[data-terrace-art="return"]', hub);
  const openingArt = required('[data-terrace-art="opening"]', hub);
  const curtain = required('#terrace-opened');
  const curtainArt = required('.terrace-opened-art', curtain);
  const infoPopup = required('#routing-hub-info-popup', hub);
  const equipmentPopup = required('#routing-hub-equipment-popup', hub);
  const cradle = required('#routing-hub-star-cradle', hub);
  const cradleGlobe = required('#routing-hub-cradle-globe', hub);

  // ── 行き先の一覧（ハブの開始の応答の routing_destinations）──────────────────
  // names: id → 名、byLabel: 名 → id、labelPattern: 言葉の中の名を長い順に探す式。ハブの開始が一度も済んでいない間は null。
  let places = null;

  function place(id) {
    if (places === null) throw new Error('hub terrace: the destinations have not arrived with a hub start yet');
    const label = places.names.get(id);
    if (label === undefined) throw new Error(`hub terrace: unknown destination ${JSON.stringify(id)}`);
    return { id, label, art: DESTINATION_ART[id] };
  }

  function setDestinations(destinations) {
    if (!Array.isArray(destinations) || destinations.length === 0) {
      throw new Error(`hub terrace: routing_destinations must be a non-empty array, got ${JSON.stringify(destinations)}`);
    }
    const names = new Map();
    for (const destination of destinations) {
      if (typeof destination?.id !== 'string' || typeof destination.label !== 'string' || destination.label === '') {
        throw new Error(`hub terrace: malformed routing destination ${JSON.stringify(destination)}`);
      }
      names.set(destination.id, destination.label);
    }
    const unmapped = [...names.keys()].filter((id) => !Object.hasOwn(DESTINATION_ART, id));
    const stale = Object.keys(DESTINATION_ART).filter((id) => !names.has(id));
    if (unmapped.length || stale.length) {
      throw new Error(`hub terrace: the destination art map is out of step with routing_destinations (unmapped: ${unmapped.join(',') || '-'} / stale: ${stale.join(',') || '-'})`);
    }
    const byLabel = new Map([...names].map(([id, label]) => [label, id]));
    const labelPattern = new RegExp(
      [...byLabel.keys()].sort((a, b) => b.length - a.length).map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
      'g'
    );
    places = { names, byLabel, labelPattern };
  }

  // ── 行き先の名に光を差す・覗く ──────────────────────────────────────────────
  function markPlaceNames(paragraph) {
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    for (const node of textNodes) {
      const text = node.nodeValue;
      const matches = [...text.matchAll(places.labelPattern)];
      if (matches.length === 0) continue;
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      for (const match of matches) {
        if (match.index > cursor) fragment.append(text.slice(cursor, match.index));
        const named = place(places.byLabel.get(match[0]));
        const span = document.createElement('span');
        span.className = 'terrace-place';
        span.dataset.destinationId = named.id;
        span.textContent = match[0];
        fragment.append(span);
        cursor = match.index + match[0].length;
      }
      if (cursor < text.length) fragment.append(text.slice(cursor));
      node.replaceWith(fragment);
    }
  }

  let peekedId = null;
  function showPeek(destinationId) {
    const { art } = place(destinationId);
    peekedId = destinationId;
    paint(peekArt, art);
    peekArt.classList.add('is-visible');
  }
  function hidePeek(destinationId) {
    if (peekedId !== destinationId) return;
    peekedId = null;
    peekArt.classList.remove('is-visible');
  }
  stream.addEventListener('pointerover', (event) => {
    const place = event.target.closest?.('.terrace-place');
    if (place) showPeek(place.dataset.destinationId);
  });
  stream.addEventListener('pointerout', (event) => {
    const place = event.target.closest?.('.terrace-place');
    if (place && !place.contains(event.relatedTarget)) hidePeek(place.dataset.destinationId);
  });

  // ── 送り出しの幕 ─────────────────────────────────────────────────────────────
  // sendoff: 送り出しの間だけ持つ（art = 幕の絵・tail = 送り出しの言葉の最後の断片・fillTimer = 満たし始めの予約・
  // leftHub = ハブを離れたか）。
  let sendoff = null;
  // 幕の絵の置き方の写し（hubTerrace.css の .terrace-opened-art が読む）。
  const CURTAIN_PLACEMENT_PROPERTIES = ['--terrace-opened-art-size', '--terrace-opened-art-position', '--terrace-opened-art-mask', '--terrace-opened-art-mask-composite'];

  function fillCurtain({ instant }) {
    if (instant) {
      clearTimeout(sendoff.fillTimer);
      curtain.classList.add('is-instant');
    }
    if (!curtain.hidden) return;
    curtain.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => curtain.classList.add('is-filled')));
  }

  function watchSendoffLit(rows) {
    if (sendoff === null || sendoff.tail === null || sendoff.fillTimer !== null) return;
    const paragraphs = [...rows].filter((row) => row.classList.contains('character-message')).flatMap((row) => [...row.querySelectorAll('.message-bubble p')]);
    const last = paragraphs[paragraphs.length - 1];
    if (last && last.textContent.trim() === sendoff.tail) {
      sendoff.fillTimer = setTimeout(() => fillCurtain({ instant: false }), FILL_AFTER_SENDOFF_LIT_MS);
    }
  }

  // ハブを離れた（読み込みの画面が出た・または幕の上に行き先へ入る待ちが置かれた）: 幕をその場で満たしきる。
  function leaveHub() {
    if (sendoff.leftHub) return;
    sendoff.leftHub = true;
    if (sendoff.fillTimer === null && curtain.hidden) {
      console.error(`hub terrace: the send-off's last piece was never lit on the terrace (expected: ${JSON.stringify(sendoff.tail)}); filling at hand-off`);
    }
    fillCurtain({ instant: true });
  }

  function liftCurtain() {
    if (sendoff !== null) clearTimeout(sendoff.fillTimer);
    sendoff = null;
    hub.classList.remove('terrace-is-opening');
    openingArt.style.backgroundImage = '';
    curtain.hidden = true;
    curtain.classList.remove('is-filled', 'is-instant');
    curtainArt.style.backgroundImage = '';
    for (const property of CURTAIN_PLACEMENT_PROPERTIES) curtainArt.style.removeProperty(property);
  }

  // ── 戻った週 ──────────────────────────────────────────────────────────────
  let fadedWeek = null;
  function fadeReturnedPlace(state) {
    const destinationId = returnedDestinationId(state);
    if (destinationId === null || fadedWeek === state.elapsed_weeks) return;
    fadedWeek = state.elapsed_weeks;
    const { art } = place(destinationId);
    paint(returnArt, art);
    returnArt.classList.remove('is-fading');
    returnArt.classList.add('is-present');
    // 着いた姿を一拍見せてから薄れさせる（2 フレーム待って transition の始点を確定させる）。
    requestAnimationFrame(() => requestAnimationFrame(() => {
      returnArt.classList.add('is-fading');
      returnArt.classList.remove('is-present');
    }));
  }

  // ── 開いている間の左の列 ─────────────────────────────────────────────────────
  function closeWithProductButton(popup) {
    if (!popup.hidden) required('.routing-hub-info-popup-close', popup).click();
  }
  hub.addEventListener('click', (event) => {
    const railButton = event.target.closest('.routing-hub-category-button');
    const onGlobe = cradleGlobe.contains(event.target);
    if (!railButton && !onGlobe) return;
    closeWithProductButton(equipmentPopup);
    const sameInfo = railButton && !infoPopup.hidden && infoPopup.dataset.category === railButton.dataset.routingCategory;
    if (sameInfo) event.stopPropagation();
    if (sameInfo || !railButton) closeWithProductButton(infoPopup);
  }, { capture: true });
  // 揺り籠は画面いっぱいに左の列を覆うので、開いている間は列を inert にして Tab の focus も届かせない。
  const rail = required('.routing-hub-category-rail', hub);
  const syncRailWithCradle = () => {
    rail.inert = !cradle.hidden;
  };
  syncRailWithCradle();
  new MutationObserver(syncRailWithCradle).observe(cradle, { attributes: true, attributeFilter: ['hidden'] });

  return {
    // 会話の行を描いた直後（stream に入る前）に呼ぶ: 行き先の名に光を差し、送り出しの最後の断片が灯ったかを見る。
    // ハブの開始の応答の routing_destinations を受け取る（絵の表と id の集合に過不足があれば throw）。
    setDestinations,
    // 失敗の報せに出す行き先の名（届いた一覧から id で引く・引けなければ throw）。
    destinationLabel(id) {
      return place(id).label;
    },
    markRows(rows) {
      for (const row of rows) {
        if (!row.classList.contains('character-message') && !row.classList.contains('narration-message')) continue;
        for (const paragraph of row.querySelectorAll('.message-bubble p')) markPlaceNames(paragraph);
      }
      watchSendoffLit(rows);
      return rows;
    },
    // routing_draining: 決まった行き先の絵を露台の向こうで開き始める。sendoffContent は送り出しの言葉（最後の assistant_complete）。
    // placement は行き先の画面が宣言した絵の置き方（app.js の placeArtPlacement の { size, position, edge }）で、幕の絵はこれで
    // 敷く（待ちの層・着いた画面と同じ置き方）。置き方が無ければ throw。
    beginSendoff(destinationId, sendoffContent, placement) {
      if (sendoff !== null) throw new Error('hub terrace: a send-off is already under way');
      if (typeof sendoffContent !== 'string') throw new Error('hub terrace: the send-off needs the send-off words');
      if (placement === null) throw new Error(`hub terrace: the send-off to ${destinationId} needs an art placement`);
      const { art } = place(destinationId);
      sendoff = { art, tail: lastSpokenPiece(sendoffContent), fillTimer: null, leftHub: false };
      hidePeek(peekedId);
      paint(openingArt, art);
      paint(curtainArt, art);
      curtainArt.style.setProperty('--terrace-opened-art-size', placement.size);
      curtainArt.style.setProperty('--terrace-opened-art-position', placement.position);
      if (placement.edge !== null) {
        curtainArt.style.setProperty('--terrace-opened-art-mask', placement.edge.mask);
        curtainArt.style.setProperty('--terrace-opened-art-mask-composite', placement.edge.maskComposite);
      }
      hub.classList.add('terrace-is-opening');
      watchSendoffLit(stream.children);
    },
    // 送り出しが途切れた（turn の stream・送り出しの後の失敗）: 幕を上げて露台に戻し、この週はもう薄れさせない。
    abortSendoff(state) {
      if (sendoff === null) return;
      liftCurtain();
      fadedWeek = state.elapsed_weeks;
    },
    // showScreen のたびに呼ぶ。送り出しの間は、ハブを離れたら満たしきり、行き先の画面かハブが出たら幕を上げる。
    screenShown(name, state) {
      if (sendoff === null) return;
      if (name === 'routing-hub') {
        if (!sendoff.leftHub) return;
        // 行き先に着けずにハブへ戻った: 幕を上げ、この週はもう薄れさせない（週は送り出しで進んでいる）。
        liftCurtain();
        fadedWeek = state.elapsed_weeks;
        return;
      }
      leaveHub();
      if (name !== 'academy-loading') liftCurtain();
    },
    // 行き先へ入る待ちを幕の上に置く（app.js の raiseSendoffPlaceVeil）: 画面は露台のまま、幕を満たしきってハブを離れたことにし、
    // 幕の絵を返す。幕は行き先の画面（またはハブ）が出たところで上がる。
    holdCurtainForWait() {
      if (sendoff === null) throw new Error('hub terrace: no send-off curtain to wait over');
      leaveHub();
      return sendoff.art;
    },
    // ハブの開始が済み、会話のあるハブが出た直後に呼ぶ: 戻った週なら、戻ってきた場所の絵を薄れさせる（週に一度）。
    hubStarted(state) {
      fadeReturnedPlace(state);
    }
  };
}
