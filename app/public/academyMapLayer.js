// 学院マップの見せ方の層。見せ方だけを持ち、仕組みは製品のものを押して通す:
// - 舞台・そこにいる人・ピンの座標・舞台の様子の一文は、app.js が startAcademyMapLayer に渡す読み口から読む。
// - ピンの並びは製品の #academy-map-stage-layer の釦の並びと1対1（読み口の nodes() と同じ順）。数が合わなければ落ちる。
// - 舞台を覗くときは製品のピンを押して選ばれた舞台を製品に持たせ（製品の舞台の窓はこの層の CSS で見えない）、窓はすぐ閉じる。
//   「ここに行く」は製品の #academy-map-go-button を、閉じるは製品の #academy-map-close-button を押す。
// - 着いた後の相手選びは、製品が開く #academy-map-companion-popup（この層の CSS で見えない）の候補のカードを読み、押すと製品の
//   カードを押す。閉じると製品の閉じるを押して、地図に留まる。
// - 左の印・学院と山林の札・週・印から開く画面は製品の要素そのもので、この層は CSS で置き場と見た目だけを変える。
// - 舞台の覗きと相手選びは、舞台の絵を画面そのものにして、顔と字をその上の夜に直に置く。覗きの「ここに行く」は字を出さない印
//   （露台の送る釦の紋の写し）で、名は製品の釦の字を aria-label に持たせる。
// - 顔の下の名は「・」の所でだけ折れる（「・」で切った語ごとに折れない一続きにする）。
// - 右の顔の列は、学院では名の頭の音の行（ア〜ワ）で絞れる。地図の絵はピンが印の列と顔の列の間に収まるいちばん大きい大きさに
//   し、絵の外は同じ絵をぼかした地で埋める。
// 層は製品の起動（タイトルを出すまで）が済んでから整い、製品が学院マップに着いたときに働き始める。

document.documentElement.classList.add('ap-page');

const layer = document.querySelector('#ap');
const peek = document.querySelector('#ap-peek');
const pick = document.querySelector('#ap-pick');
const peopleFlow = layer.querySelector('.ap-people-flow');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
// 開く・閉じるは透明度とぼかしの移ろいだけ。閉じた窓を hidden に戻すのは移ろいが済んでから（動きを減らす設定ではすぐ）。
const POPUP_FADE_MS = 420;

let product = null;
let nodes = [];
let chosenCharacterId = null;
let peekNodeIndex = null;
let pressingProductPin = false;

function requireNode(selector) {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`academy map layer: product node ${selector} is missing`);
  return node;
}

function productPins() {
  const pins = [...requireNode('#academy-map-stage-layer').children];
  if (pins.length !== nodes.length) {
    throw new Error(`academy map layer: ${pins.length} product pins for ${nodes.length} map nodes (the pin order no longer matches)`);
  }
  return pins;
}

// ── 人から選ぶ道 ───────────────────────────────────────────────────────────────────────────────────────────
// 名の頭の音の行。学院の人の名は片仮名で始まり、頭の字（濁音・半濁音・小書きを含む）がどの行にも無い名は落ちる。
const KANA_ROWS = [
  ['ア', 'アイウエオヴァィゥェォ'],
  ['カ', 'カキクケコガギグゲゴ'],
  ['サ', 'サシスセソザジズゼゾ'],
  ['タ', 'タチツテトダヂヅデド'],
  ['ナ', 'ナニヌネノ'],
  ['ハ', 'ハヒフヘホバビブベボパピプペポ'],
  ['マ', 'マミムメモ'],
  ['ヤ', 'ヤユヨャュョ'],
  ['ラ', 'ラリルレロ'],
  ['ワ', 'ワヲン']
];
const peopleIndex = layer.querySelector('.ap-people-index');
let indexRow = null;

function kanaRowOf(displayName) {
  const row = KANA_ROWS.find(([, heads]) => heads.includes(displayName[0]));
  if (!row) throw new Error(`academy map layer: the name ${JSON.stringify(displayName)} does not start with a kana of the index rows`);
  return row[0];
}

// 舞台はピンの上から下（同じ高さなら左から）の順に並べ、舞台ごとの顔をひとまとまりにする。収まらない分は列の中で流す。
// 頭の音の行を選んでいる間は、その行の人だけを名の順に一列に並べ、顔の脇に名（「・」の前の語）を添える。
// 頭の音の行は学院だけ（山林の列はいま居る舞台の生き物だけで、名は漢字）。
function renderPeople() {
  const indexed = product.region() === 'academy';
  const occupants = nodes.flatMap((node, index) => node.occupants.map((person) => ({ person, node, index })));
  const rowCounts = new Map(KANA_ROWS.map(([row]) => [row, 0]));
  if (indexed) {
    for (const { person } of occupants) {
      const row = kanaRowOf(person.displayName);
      rowCounts.set(row, rowCounts.get(row) + 1);
    }
  }
  if (!indexed || rowCounts.get(indexRow) === 0) indexRow = null;
  renderIndex(indexed, rowCounts);
  peopleFlow.classList.toggle('is-indexed', indexRow !== null);
  layer.classList.toggle('has-people', occupants.length > 0);
  if (indexRow !== null) {
    const collator = new Intl.Collator('ja');
    const row = occupants
      .filter(({ person }) => kanaRowOf(person.displayName) === indexRow)
      .sort((a, b) => collator.compare(a.person.displayName, b.person.displayName));
    peopleFlow.replaceChildren(...row.map(({ person, node, index }) => {
      const button = personButton(person, node, index, indexed);
      const name = document.createElement('span');
      name.className = 'ap-person-name';
      name.textContent = person.displayName.split('・')[0];
      button.append(name);
      return button;
    }));
    return;
  }
  const groups = nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.occupants.length > 0)
    .sort((a, b) => a.node.point.y - b.node.point.y || a.node.point.x - b.node.point.x);
  peopleFlow.replaceChildren(...groups.map(({ node, index }) => {
    const group = document.createElement('div');
    group.className = 'ap-people-group';
    group.dataset.nodeIndex = String(index);
    group.append(...node.occupants.map((person) => personButton(person, node, index, indexed)));
    return group;
  }));
}

function personButton(person, node, index, indexed) {
  const button = faceButton(person, 'ap-person');
  button.dataset.nodeIndex = String(index);
  if (indexed) button.dataset.kanaRow = kanaRowOf(person.displayName);
  button.setAttribute('aria-label', `${person.displayName}（${node.displayName}）`);
  return button;
}

// 頭の音の行の印: 字だけの釦を縦に並べ、いま居る人のいない行は押せない。選んでいる行をもう一度押すと全員の列に戻る。
function renderIndex(indexed, rowCounts) {
  peopleIndex.hidden = !indexed;
  peopleIndex.replaceChildren(...(indexed ? KANA_ROWS : []).map(([row]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ap-people-index-row';
    button.dataset.row = row;
    button.textContent = row;
    button.disabled = rowCounts.get(row) === 0;
    button.setAttribute('aria-pressed', String(row === indexRow));
    return button;
  }));
}

peopleIndex.addEventListener('click', (event) => {
  const button = event.target.closest('.ap-people-index-row');
  if (!button || button.disabled) return;
  indexRow = indexRow === button.dataset.row ? null : button.dataset.row;
  lightNode(null);
  renderPeople();
  peopleFlow.scrollTop = 0;
});

// 顔の下の名: 「・」で切った語ごとに折れない一続きにし、行は語の間（「・」の後ろ）でだけ替わる。
function faceName(displayName) {
  const name = document.createElement('span');
  name.className = 'ap-face-name';
  displayName.split('・').forEach((part, index, parts) => {
    if (index > 0) name.append(document.createElement('wbr'));
    const word = document.createElement('span');
    word.className = 'ap-face-name-word';
    word.textContent = index < parts.length - 1 ? `${part}・` : part;
    name.append(word);
  });
  return name;
}

function faceButton(person, className) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.dataset.characterId = person.characterId;
  button.classList.toggle('is-buddy', person.isBuddy);
  button.classList.toggle('is-enemy', person.isEnemy);
  button.classList.toggle('is-creature', person.isCreature);
  const face = document.createElement('img');
  face.src = person.faceUrl;
  face.alt = '';
  face.decoding = 'async';
  button.append(face);
  return button;
}

// 顔に指を乗せると、その人のいる舞台のピンが灯り、ほかのピンは沈む。ピンに指を乗せると、そこにいる人の顔が灯る。
function lightNode(index) {
  const pins = productPins();
  requireNode('#academy-map-stage-layer').classList.toggle('ap-pins-quiet', index !== null);
  pins.forEach((pin, pinIndex) => pin.classList.toggle('ap-pin-lit', pinIndex === index));
  // 列の子（舞台のまとまり、または頭の音で並べた一人ずつ）のうち、その舞台のものが灯る。
  for (const entry of peopleFlow.children) entry.classList.toggle('is-lit', entry.dataset.nodeIndex === String(index));
}

peopleFlow.addEventListener('pointerover', (event) => {
  const person = event.target.closest('.ap-person');
  if (person) lightNode(Number(person.dataset.nodeIndex));
});
peopleFlow.addEventListener('pointerleave', () => lightNode(null));
peopleFlow.addEventListener('focusin', (event) => {
  const person = event.target.closest('.ap-person');
  if (person) lightNode(Number(person.dataset.nodeIndex));
});
peopleFlow.addEventListener('focusout', () => lightNode(null));
peopleFlow.addEventListener('click', (event) => {
  const person = event.target.closest('.ap-person');
  if (!person) return;
  openPeek(Number(person.dataset.nodeIndex), person.dataset.characterId);
});

// ── 場所から選ぶ道（製品のピン） ─────────────────────────────────────────────────────────────────────────────
function bindPins() {
  const stageLayer = requireNode('#academy-map-stage-layer');
  // 人の押下は捕捉の段で止めて覗きを開き、製品のピンの押下は覗きの中からこの層が押すときだけ通す。
  stageLayer.addEventListener('click', (event) => {
    if (pressingProductPin) return;
    const pin = event.target.closest('.academy-map-node');
    if (!pin) return;
    event.stopPropagation();
    openPeek(productPins().indexOf(pin), null);
  }, true);
  stageLayer.addEventListener('pointerover', (event) => {
    const pin = event.target.closest('.academy-map-node');
    if (pin) lightNode(productPins().indexOf(pin));
  });
  stageLayer.addEventListener('pointerleave', () => lightNode(null));
  // 製品がピンを置き直したら（地域の切り替え・移動の後の描き直し）、舞台と人を読み直す。
  new MutationObserver(() => syncFromProduct()).observe(stageLayer, { childList: true });
}

function syncFromProduct() {
  nodes = product.nodes();
  productPins();
  document.documentElement.dataset.apRegion = product.region();
  fitMap();
  renderPeople();
}

// 地図を画面そのものに近づける: 地図の絵の大きさは、ピンの左右の端（地図の中の割合）が左の印の列と右の顔の列の間に収まる
// いちばん大きい大きさ（画面の高さまで）で、CSS がこの二つの割合から決める。地図の絵の縁の外は、同じ絵（製品が地図に敷く
// 背景そのもの）をぼかして沈めた地で埋める。
function fitMap() {
  const xs = nodes.map((node) => node.point.x);
  if (xs.length === 0) throw new Error(`academy map layer: no map pins in region ${product.region()}`);
  const root = document.documentElement.style;
  root.setProperty('--ap-pin-x0', String(Math.min(...xs)));
  root.setProperty('--ap-pin-x1', String(Math.max(...xs)));
  const art = getComputedStyle(requireNode('#academy-map-screen .academy-map-canvas')).backgroundImage;
  if (!art.includes('url(')) throw new Error(`academy map layer: the product map canvas has no map art (${art})`);
  root.setProperty('--ap-map-art', art);
}

// ── 窓の開け閉め ───────────────────────────────────────────────────────────────────────────────────────────
const closeTimers = new WeakMap();

function showPopup(popup) {
  clearTimeout(closeTimers.get(popup));
  popup.hidden = false;
  void popup.offsetWidth;
  popup.classList.add('is-open');
  document.documentElement.classList.add('ap-popup-open');
}

function hidePopup(popup) {
  popup.classList.remove('is-open');
  if (!peek.classList.contains('is-open') && !pick.classList.contains('is-open')) {
    document.documentElement.classList.remove('ap-popup-open');
  }
  const delay = reducedMotion.matches ? 0 : POPUP_FADE_MS;
  closeTimers.set(popup, setTimeout(() => { popup.hidden = true; }, delay));
}

function setArt(popup, node) {
  popup.querySelector('.ap-popup-art').style.backgroundImage = `url('${node.backgroundUrl}')`;
}

// ── 舞台の覗き ─────────────────────────────────────────────────────────────────────────────────────────────
function openPeek(index, characterId) {
  const node = nodes[index];
  if (!node) throw new Error(`academy map layer: no map node at index ${index}`);
  const pin = productPins()[index];
  // 製品のピンを押して、選ばれた舞台を製品に持たせる。製品の舞台の窓はこの層では見えないので、開いたらすぐ閉じる
  // （閉じるの釦は押さない — 製品の閉じるの釦は選ばれた舞台を手放す）。
  pressingProductPin = true;
  try {
    pin.click();
  } finally {
    pressingProductPin = false;
  }
  const dialog = requireNode('#academy-map-location-dialog');
  if (dialog.open) dialog.close();
  peekNodeIndex = index;
  chosenCharacterId = characterId;
  setArt(peek, node);
  peek.dataset.kind = node.kind;
  peek.querySelector('.ap-popup-name').textContent = node.displayName;
  const situation = peek.querySelector('.ap-peek-situation');
  situation.textContent = node.situation;
  situation.hidden = node.situation === '';
  const faces = peek.querySelector('.ap-peek-faces');
  faces.replaceChildren(...node.occupants.map((person) => {
    const button = faceButton(person, 'ap-peek-face');
    button.setAttribute('aria-label', person.displayName);
    button.setAttribute('aria-pressed', String(person.characterId === characterId));
    button.append(faceName(person.displayName));
    return button;
  }));
  faces.hidden = node.occupants.length === 0;
  syncChosen(faces);
  lightNode(index);
  showPopup(peek);
}

function syncChosen(container) {
  container.classList.toggle('has-chosen', chosenCharacterId !== null);
  for (const button of container.children) {
    const chosen = button.dataset.characterId === chosenCharacterId;
    button.classList.toggle('is-chosen', chosen);
    if (button.hasAttribute('aria-pressed')) button.setAttribute('aria-pressed', String(chosen));
  }
}

// 覗きの中の顔は、話したい人の印（押すと灯り、もう一度押すと外れる）。印は着いた後の相手選びへ持ち越す。
peek.querySelector('.ap-peek-faces').addEventListener('click', (event) => {
  const face = event.target.closest('.ap-peek-face');
  if (!face) return;
  chosenCharacterId = chosenCharacterId === face.dataset.characterId ? null : face.dataset.characterId;
  syncChosen(event.currentTarget);
});

function closePeek() {
  // 購買への沈みの最中は閉じない（製品の閉じるは選ばれた舞台を手放し、沈みの後の「ここに行く」が空振りする）。
  if (peek.hidden || peek.classList.contains('is-sinking')) return;
  requireNode('#academy-map-close-button').click();
  peekNodeIndex = null;
  chosenCharacterId = null;
  lightNode(null);
  hidePopup(peek);
}

// 購買へ行くときは、覗きの絵を購買の画面の地と同じ深夜へ沈めてから（字・顔・印は先に薄れる）製品の「ここに行く」を押す。沈めの層は
// 購買の画面の地と同じ部品（.shop-night-grade・.shop-night-tint）なので、沈みきった覗きの絵がそのまま購買の画面の地になる。
const SHOP_NIGHT_SINK_MS = 900;

function sinkPeekIntoShopNight() {
  const sink = document.createElement('div');
  sink.className = 'ap-night-sink';
  const grade = document.createElement('div');
  grade.className = 'shop-night-grade';
  const tint = document.createElement('div');
  tint.className = 'shop-night-tint';
  sink.append(grade, tint);
  peek.querySelector('.ap-popup-art').append(sink);
  void sink.offsetWidth;
  peek.classList.add('is-sinking');
  return new Promise((resolve) => setTimeout(resolve, SHOP_NIGHT_SINK_MS));
}

function liftPeekSink() {
  peek.classList.remove('is-sinking');
  peek.querySelector('.ap-night-sink')?.remove();
}

peek.querySelector('[data-ap-action="go"]').addEventListener('click', async () => {
  if (peek.classList.contains('is-sinking')) return;
  if (peekNodeIndex === null) throw new Error('academy map layer: go pressed without a peeked stage');
  // 製品の「ここに行く」。購買・採取はそれぞれの画面へ、舞台は移動を確定して地図に着き、製品が相手選びを開く。
  peek.classList.add('is-leaving');
  if (nodes[peekNodeIndex].kind === 'shop' && !reducedMotion.matches) await sinkPeekIntoShopNight();
  requireNode('#academy-map-go-button').click();
  peekNodeIndex = null;
  lightNode(null);
  hidePopup(peek);
  setTimeout(() => {
    peek.classList.remove('is-leaving');
    liftPeekSink();
  }, reducedMotion.matches ? 0 : POPUP_FADE_MS);
});

// ── 相手選び（製品の相手選びの窓が開いたら、その候補で開く） ───────────────────────────────────────────────
function productCompanionPopup() {
  return requireNode('#academy-map-companion-popup');
}

function openPick() {
  const productBody = requireNode('#academy-map-companion-popup-body');
  const node = nodes.find((entry) => entry.id === product.currentLocationId());
  if (!node) throw new Error(`academy map layer: the arrived stage ${product.currentLocationId()} is not on the map`);
  setArt(pick, node);
  pick.querySelector('.ap-popup-name').textContent = requireNode('#academy-map-companion-popup-stage').textContent;
  const cards = [...productBody.querySelectorAll('button.academy-map-companion-card[data-character-id]')];
  const occupantById = new Map(node.occupants.map((person) => [person.characterId, person]));
  const faces = pick.querySelector('.ap-pick-faces');
  faces.replaceChildren(...cards.map((card) => {
    const person = occupantById.get(card.dataset.characterId);
    if (!person) throw new Error(`academy map layer: companion ${card.dataset.characterId} is not among the stage's people`);
    const button = faceButton(person, 'ap-pick-face');
    button.append(faceName(person.displayName));
    return button;
  }));
  if (chosenCharacterId !== null && !occupantById.has(chosenCharacterId)) chosenCharacterId = null;
  syncChosen(faces);
  faces.hidden = cards.length === 0;
  const empty = pick.querySelector('.ap-pick-empty');
  const productEmpty = productBody.querySelector('.academy-map-companion-empty');
  empty.hidden = !productEmpty;
  empty.textContent = productEmpty ? productEmpty.textContent : '';
  showPopup(pick);
}

pick.querySelector('.ap-pick-faces').addEventListener('click', (event) => {
  const face = event.target.closest('.ap-pick-face');
  if (!face) return;
  const card = requireNode('#academy-map-companion-popup-body').querySelector(`button.academy-map-companion-card[data-character-id="${CSS.escape(face.dataset.characterId)}"]`);
  if (!card) throw new Error(`academy map layer: product companion card ${face.dataset.characterId} is missing`);
  chosenCharacterId = null;
  hidePopup(pick);
  card.click();
});

function closePick() {
  if (pick.hidden) return;
  chosenCharacterId = null;
  hidePopup(pick);
  const closer = productCompanionPopup().querySelector('[data-am-companion-close]');
  if (!closer) throw new Error('academy map layer: product companion close is missing');
  if (!productCompanionPopup().hidden) closer.click();
}

for (const closer of layer.querySelectorAll('[data-ap-close]')) {
  closer.addEventListener('click', () => (closer.dataset.apClose === 'peek' ? closePeek() : closePick()));
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!pick.hidden) closePick();
  else if (!peek.hidden) closePeek();
});

function bindCompanionPopup() {
  const popup = productCompanionPopup();
  new MutationObserver(() => {
    if (!popup.hidden) {
      syncFromProduct();
      openPick();
    } else if (pick.classList.contains('is-open')) {
      chosenCharacterId = null;
      hidePopup(pick);
    }
  }).observe(popup, { attributes: true, attributeFilter: ['hidden'] });
}

// ── 覗きの「ここに行く」の印: 露台の送る釦の紋を写し、名は製品の「ここに行く」の字を読み上げの名に持たせる ──────────
function dressGoWay() {
  const way = peek.querySelector('[data-ap-action="go"]');
  const label = requireNode('#academy-map-go-button').textContent.trim();
  if (!label) throw new Error('academy map layer: product #academy-map-go-button has no name');
  const mark = requireNode('#routing-hub-send svg').cloneNode(true);
  mark.setAttribute('class', 'ap-sigil-mark');
  way.setAttribute('aria-label', label);
  way.replaceChildren(mark);
}

// ── 左の印の名（製品の札の字は CSS で消すので、読み上げの名を釦に持たせる） ─────────────────────────────────
function nameRailButtons() {
  for (const button of document.querySelectorAll('.academy-map-category-button')) {
    const label = button.querySelector('.academy-map-category-label');
    if (!label) throw new Error('academy map layer: product rail label is missing');
    button.setAttribute('aria-label', label.textContent);
  }
}

// ── 起動: 製品の起動（タイトルを出すまで）が済んだら印を整え、製品が学院マップに着くのを待つ ─────────────────────────
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

function waitForMapArrival() {
  return new Promise((resolve) => {
    const check = () => {
      if (document.querySelector('#academy-map-screen.active') && requireNode('#academy-map-stage-layer').children.length > 0) {
        resolve();
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

async function start(reading) {
  await waitForProductBoot();
  product = reading;
  nameRailButtons();
  dressGoWay();
  bindPins();
  bindCompanionPopup();
  await waitForMapArrival();
  syncFromProduct();
  layer.dataset.apReady = 'true';
}

// reading: app.js の読み口（region・currentLocationId・nodes）。
export function startAcademyMapLayer(reading) {
  start(reading).catch((error) => {
    layer.dataset.apReady = 'failed';
    throw error;
  });
}
