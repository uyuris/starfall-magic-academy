// 夜の道行き: 開いてからハブに着くまで（門・広間・星の道・天文の部屋・露台）を、製品の画面の上に重ねた一枚の層（#journey）で
// 見せる。この層が持つのは見せ方と移り方だけで、製品の画面はこの層の下でそのまま動く: 選択肢を押すと、その handler の最初で
// 製品のボタンを押し（製品の読み込み・セーブの決まり・行き先・ロードの待ちと知らせの言葉はそのまま走る）、演出はその待ちの上に
// 重なるだけ。層は製品の画面の切り替え（.screen.active）を見て次の場所へ歩いて移り、製品の画面がハブになった時点で、演出の
// 残りを待たずに露台へ着く。遊びの中（ハブ・行き先の画面）では層は下りている。
//
// 設定の部屋の中身は製品の #settings-screen そのもの（style.css が部屋の器具の姿に描く）。ゲームの中から部屋を灯すときは
// 製品の画面を切り替えず、refreshSettings（製品の設定の読み込み）だけを走らせて、いまの画面の上に部屋を重ねる。
import { createLoadingConstellation } from './loadingConstellation.js';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function required(selector, root = document) {
  const element = root.querySelector(selector);
  if (!element) throw new Error(`meta journey: element ${selector} is missing`);
  return element;
}

// 場所ごとの「次の場所の方角」（絵の中の寄る先。style.css の --focus-x/--focus-y と同じ値）。
const FOCUS = {
  gate: [50, 31],
  hall: [50, 64],
  road: [69, 47],
  room: [16, 58],
  terrace: [50, 70]
};

// 選んだ足跡から伸びる道を描く時間。
const TRAIL_DRAW_MS = 1400;
// 選んだ足跡と伸びる道は、広間の絵と一緒に奥へ溶ける。星の道の知らせの言葉は、これが消えきってから灯る（style.css の
// .journey.is-gliding .journey-road.is-shown と同じ値）。
const HALL_HOLD_MS = 600;
const HALL_HOLD_REDUCED_MS = 300;
const HALL_DEPTH = [50, 66];
// 露台に着いてから層が下りきるまで。
const ARRIVAL_MS = 560;
const ARRIVAL_REDUCED_MS = 240;
// 層が溶け始めるまでの、露台だけが見える一目（ARRIVAL_MS に対する割合）。
const ARRIVAL_GLIMPSE = 0.36;

const dateFormat = new Intl.DateTimeFormat('ja-JP', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function startMetaJourney({ refreshSettings }) {
  if (typeof refreshSettings !== 'function') throw new Error('meta journey: refreshSettings must be a function');

  const product = {
    layout: required('.layout'),
    screens: {
      title: required('#title-screen'),
      slotLoad: required('#slot-load-screen'),
      settings: required('#settings-screen'),
      loading: required('#academy-loading-screen'),
      hub: required('#routing-hub-screen')
    },
    startNewGame: required('#start-new-game'),
    openLoad: required('#open-load-screen'),
    openSettings: required('#open-settings-screen'),
    titleStatus: required('#title-status'),
    slotList: required('#slot-load-list'),
    backToTitle: required('#back-to-title-screen'),
    resume: required('#slot-load-resume-play'),
    settingsBack: required('#settings-back-to-title'),
    loadingTitle: required('#academy-loading-title'),
    loadingStatus: required('#academy-loading-status'),
    loadingConstellation: required('#academy-loading-constellation'),
    hubEnd: required('#routing-hub-end')
  };

  const layer = required('#journey');
  const places = new Map([...layer.querySelectorAll('.journey-place')].map((element) => [element.dataset.place, element]));
  const panels = new Map([...layer.querySelectorAll('[data-scene-panel]')].map((element) => [element.dataset.scenePanel, element]));
  const flash = required('.journey-flash', layer);
  const title = required('.journey-title', layer);
  const gateStatus = required('.journey-gate-status', layer);
  const gateLoad = required('[data-journey-action="load"]', layer);
  const footprintList = required('.journey-footprints', layer);
  const trailSvg = required('.journey-hall-trail', layer);
  const trail = required('.journey-hall-trail-line', layer);
  const hallResume = required('[data-journey-action="hall-resume"]', layer);
  const roadCopy = required('.journey-road-copy', layer);
  const roadTitle = required('.journey-road-title', layer);
  const roadStatus = required('.journey-road-status', layer);
  const skyCanvas = required('#journey-sky', layer);

  // ── 星屑の空（五つの場所で一枚・ほとんど止まって見える速さ）。層が下りている遊びの中では描かない ─────────────
  const sky = (() => {
    const ctx = skyCanvas.getContext('2d');
    let width = 0;
    let height = 0;
    let stars = [];
    let falling = null;
    let frame = null;
    let seeded = false;
    const seedStars = () => {
      width = skyCanvas.clientWidth;
      height = skyCanvas.clientHeight;
      skyCanvas.width = width;
      skyCanvas.height = height;
      const count = Math.round((width * height) / 9000);
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height * 0.78,
        r: 0.35 + Math.random() * 1.05,
        base: 0.25 + Math.random() * 0.55,
        period: 7000 + Math.random() * 9000,
        phase: Math.random() * Math.PI * 2
      }));
      seeded = true;
    };
    const draw = (time) => {
      ctx.clearRect(0, 0, width, height);
      // 全体がゆっくり右へ流れる（1分でおよそ 6px）。
      const drift = reducedMotion.matches ? 0 : (time / 10000) % width;
      for (const star of stars) {
        const twinkle = reducedMotion.matches ? 1 : 0.7 + 0.3 * Math.sin(star.phase + (time / star.period) * Math.PI * 2);
        const x = (star.x + drift) % width;
        ctx.fillStyle = `rgba(214, 224, 255, ${star.base * twinkle})`;
        ctx.beginPath();
        ctx.arc(x, star.y, star.r, 0, Math.PI * 2);
        ctx.fill();
      }
      if (falling) drawFalling(time);
    };
    // 開いたときに降る星（ひとつだけ・速い動き）。題字の上の空で消え、消えたところで題字が灯る。
    const drawFalling = (time) => {
      const progress = Math.min(1, (time - falling.start) / falling.duration);
      const eased = 1 - (1 - progress) ** 2;
      const headX = falling.fromX + (falling.toX - falling.fromX) * eased;
      const headY = falling.fromY + (falling.toY - falling.fromY) * eased;
      const tail = 0.3;
      const tailX = headX - (falling.toX - falling.fromX) * tail;
      const tailY = headY - (falling.toY - falling.fromY) * tail;
      const gradient = ctx.createLinearGradient(tailX, tailY, headX, headY);
      const alpha = progress < 0.85 ? 1 : (1 - progress) / 0.15;
      gradient.addColorStop(0, 'rgba(214, 224, 255, 0)');
      gradient.addColorStop(1, `rgba(245, 248, 255, ${alpha})`);
      ctx.save();
      ctx.shadowColor = `rgba(190, 205, 255, ${alpha})`;
      ctx.shadowBlur = 14;
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(headX, headY);
      ctx.stroke();
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
      ctx.beginPath();
      ctx.arc(headX, headY, 3.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      if (progress >= 1) {
        const done = falling.done;
        falling = null;
        done();
      }
    };
    const loop = (time) => {
      draw(time);
      frame = requestAnimationFrame(loop);
    };
    return {
      run() {
        if (!seeded) seedStars();
        if (reducedMotion.matches) {
          draw(0);
          skyCanvas.dataset.sky = 'static';
          return;
        }
        skyCanvas.dataset.sky = 'animated';
        if (frame === null) frame = requestAnimationFrame(loop);
      },
      resize() {
        seedStars();
        if (reducedMotion.matches) draw(0);
      },
      fallOnce() {
        return new Promise((resolve) => {
          falling = {
            start: performance.now(),
            duration: 1300,
            fromX: width * 0.78,
            fromY: height * 0.04,
            toX: width * 0.56,
            toY: height * 0.44,
            done: resolve
          };
        });
      },
      stop() {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
      }
    };
  })();

  // ロードの星座: 製品の星座と同じ部品を星の道の空に描き、製品の読み込みの進みの通知（製品の星座に1本足されるごと）に1本ずつ結ぶ。
  const constellation = createLoadingConstellation({
    canvasSelector: '#journey-constellation',
    lineColorRgb: '198, 212, 255',
    nodeColorRgb: '224, 232, 255',
    random: Math.random
  });
  let productConstellationRevealed = 0;
  let constellationRunning = false;

  // ── 移り方 ───────────────────────────────────────────────────────────────────────────────────────────────
  let scene = null;
  let currentPlace = null;
  let running = [];
  let roadDrift = null;
  let roomMode = null;
  let leavingForGate = false;
  let arrivalPending = false;

  // 移る前の場面を層の data-from に残す（門と広間の間を移るとき、入る側の字は出る側の字が薄れきってから灯す。style.css）。
  // 層が下りている遊びの中（play）では空を描かない。
  function setScene(next) {
    if (scene !== null && next !== scene) layer.dataset.from = scene;
    scene = next;
    layer.dataset.scene = next;
    for (const [name, panel] of panels) panel.classList.toggle('is-shown', name === next);
    if (next === 'play') sky.stop();
    else sky.run();
  }

  function setPlace(name, { dim = false } = {}) {
    for (const [placeName, element] of places) {
      element.classList.toggle('is-current', placeName === name);
      element.style.zIndex = placeName === name ? '2' : '1';
    }
    places.get(name).style.opacity = dim ? '0.86' : '';
    currentPlace = name;
  }

  function track(animation) {
    running.push(animation);
    animation.finished.then(() => {
      running = running.filter((entry) => entry !== animation);
      animation.cancel();
    }, () => {
      running = running.filter((entry) => entry !== animation);
    });
    return animation;
  }

  function finishRunning() {
    for (const animation of [...running]) animation.finish();
  }

  function stopRoadDrift() {
    if (roadDrift) roadDrift.cancel();
    roadDrift = null;
  }

  function flashAt(placeName, { duration, peak }) {
    const [x, y] = FOCUS[placeName];
    flash.style.setProperty('--flash-x', `${x}%`);
    flash.style.setProperty('--flash-y', `${y}%`);
    return track(flash.animate([{ opacity: 0 }, { opacity: peak, offset: 0.45 }, { opacity: 0 }], { duration, easing: 'ease-out' }));
  }

  // 移り方の型。どれも場所の絵だけを動かし、空の層は切らない。
  //   pass      門をくぐる一瞬（速い）: 門の文字盤の奥へ一気に寄り、光が抜けて次の絵が落ち着く。
  //   glide     歩いて奥へ（ゆっくり）: 今の絵が次の場所の方角へ寄りながら薄れ、次の絵が少し手前から落ち着く。
  //   side      門の脇の部屋へ向き直る（ゆっくり）: 今の絵が右へ流れ、部屋の絵が左から入る。side-back はその逆。
  //   back      来た道を戻る（ゆっくり）: 戻る先の絵が寄った位置から引いて落ち着き、今の絵が薄れる。
  //   arrive    露台に着く一瞬（速い）: 星の道の消える点へ一気に寄り、光の中で露台の絵に替わる。
  // 動きを減らす設定では、どの型も短い溶け替わりだけになる。
  function walk(kind, to) {
    const from = currentPlace;
    const fromElement = places.get(from);
    const toElement = places.get(to);
    if (!toElement) throw new Error(`meta journey: unknown place ${to}`);
    if (from === to) return Promise.resolve();
    if (from === 'road') stopRoadDrift();
    setPlace(to);
    if (reducedMotion.matches) {
      track(fromElement.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 280, fill: 'both' }));
      return track(toElement.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 280, fill: 'both' })).finished.catch(() => {});
    }
    const [toX, toY] = FOCUS[to];
    toElement.style.transformOrigin = `${toX}% ${toY}%`;
    let incoming;
    if (kind === 'pass') {
      track(fromElement.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(2.6)' }], { duration: 700, easing: 'cubic-bezier(.55,0,.85,.4)', fill: 'both' }));
      flashAt(from, { duration: 900, peak: 0.85 });
      incoming = toElement.animate([{ opacity: 0, transform: 'scale(1.14)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 1100, delay: 320, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'both' });
    } else if (kind === 'glide') {
      track(fromElement.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.42)' }], { duration: 2200, easing: 'cubic-bezier(.45,0,.55,1)', fill: 'both' }));
      incoming = toElement.animate([{ opacity: 0, transform: 'scale(1.08)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 2000, delay: 500, easing: 'cubic-bezier(.3,.6,.4,1)', fill: 'both' });
    } else if (kind === 'side') {
      track(fromElement.animate([{ opacity: 1, transform: 'translateX(0) scale(1)' }, { opacity: 0, transform: 'translateX(9%) scale(1.08)' }], { duration: 1700, easing: 'cubic-bezier(.45,0,.55,1)', fill: 'both' }));
      incoming = toElement.animate([{ opacity: 0, transform: 'translateX(-7%) scale(1.05)' }, { opacity: 1, transform: 'translateX(0) scale(1)' }], { duration: 1700, delay: 200, easing: 'cubic-bezier(.3,.6,.4,1)', fill: 'both' });
    } else if (kind === 'side-back') {
      track(fromElement.animate([{ opacity: 1, transform: 'translateX(0) scale(1)' }, { opacity: 0, transform: 'translateX(-9%) scale(1.08)' }], { duration: 1700, easing: 'cubic-bezier(.45,0,.55,1)', fill: 'both' }));
      incoming = toElement.animate([{ opacity: 0, transform: 'translateX(7%) scale(1.05)' }, { opacity: 1, transform: 'translateX(0) scale(1)' }], { duration: 1700, delay: 200, easing: 'cubic-bezier(.3,.6,.4,1)', fill: 'both' });
    } else if (kind === 'back') {
      track(fromElement.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1800, easing: 'ease-in-out', fill: 'both' }));
      incoming = toElement.animate([{ opacity: 0, transform: 'scale(1.6)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 2600, easing: 'cubic-bezier(.25,.6,.35,1)', fill: 'both' });
    } else if (kind === 'arrive') {
      // 星の道の消える点へ一気に寄り、光の中で露台の絵が少し寄った位置から落ち着く（ハブの背景と同じ大きさで止まる）。
      track(fromElement.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.9)' }], { duration: 240, easing: 'cubic-bezier(.55,0,.85,.4)', fill: 'both' }));
      flashAt(from, { duration: 420, peak: 0.9 });
      incoming = toElement.animate([{ opacity: 0, transform: 'scale(1.06)' }, { opacity: 1, transform: 'scale(1)', offset: 0.3 }, { opacity: 1, transform: 'scale(1)' }], { duration: 480, delay: 40, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'both' });
    } else {
      throw new Error(`meta journey: unknown walk ${kind}`);
    }
    return track(incoming).finished.catch(() => {});
  }

  function startRoadDrift() {
    stopRoadDrift();
    if (reducedMotion.matches) return;
    roadDrift = places.get('road').animate([{ transform: 'scale(1)' }, { transform: 'scale(1.07)' }], { duration: 45000, easing: 'linear', fill: 'forwards' });
  }

  function fadeLayer(to, duration) {
    const animation = layer.animate([{ opacity: to === 1 ? 0 : 1 }, { opacity: to }], { duration: reducedMotion.matches ? 240 : duration, easing: 'ease', fill: 'both' });
    return animation.finished.then(() => animation.cancel(), () => {});
  }

  // ── 場所ごとの見せ方 ─────────────────────────────────────────────────────────────────────────────────────
  function lightTitle() {
    title.classList.add('is-lit');
  }

  function syncGate() {
    gateLoad.disabled = product.openLoad.disabled;
    const statusText = product.titleStatus.hidden ? '' : product.titleStatus.textContent.trim();
    gateStatus.textContent = statusText;
    gateStatus.hidden = statusText === '';
  }

  // 広間の足跡: 製品のセーブの札（#slot-load-list）をそのまま読み、奥へ一つずつ灯す。押すのは製品の札のボタン。
  function readProductSlots() {
    return [...product.slotList.querySelectorAll('.slot-load-item')].map((card) => {
      const degraded = card.classList.contains('slot-load-item-degraded');
      const buttons = [...card.querySelectorAll('.dialog-action-row button')];
      const meta = required('.slot-load-item-summary > p', card).textContent.split(' / ');
      if (degraded) {
        if (buttons.length !== 1) throw new Error('meta journey: a degraded slot card must hold exactly the delete button');
        const reason = required('.slot-load-item-degraded-reason', card).textContent;
        return { slotId: meta[0], updatedAt: meta[1] ?? '', summary: '', note: meta[2] ?? '', reason, load: null, remove: buttons[0] };
      }
      if (buttons.length !== 2) throw new Error('meta journey: a slot card must hold the load and delete buttons');
      const noteField = required('textarea', card);
      const slotId = noteField.name.replace(/^player_note_/, '');
      // まとめは要約行（ / 区切り）に混ぜず、独立した行から読む。まとめを持たないセーブの札には行が無い。
      const summary = card.querySelector('.slot-load-item-footprint-summary')?.textContent ?? '';
      return { slotId, updatedAt: meta[1], summary, note: noteField.value.trim(), reason: null, load: buttons[0].disabled ? null : buttons[0], remove: buttons[1] };
    });
  }

  // 足跡は広間の通路に左右交互に奥へ並ぶ。手前ほど大きく、通路の両脇へ広く開く（寄ったときの札が隣の天球儀に掛からない幅）。
  function footprintPosition(depthIndex, count) {
    const t = count === 1 ? 0.35 : (depthIndex / (count - 1)) * 0.9;
    const side = depthIndex % 2 === 0 ? -1 : 1;
    return {
      x: 50 + side * (20 - 19 * t),
      y: 87 - 19.5 * t,
      s: 1 - 0.5 * t
    };
  }

  function renderFootprints() {
    const slots = readProductSlots().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const items = slots.map((slot, depthIndex) => {
      const { x, y, s } = footprintPosition(depthIndex, slots.length);
      const item = document.createElement('li');
      item.className = 'journey-footprint';
      item.dataset.slotId = slot.slotId;
      item.style.setProperty('--x', `${x}%`);
      item.style.setProperty('--y', `${y}%`);
      item.style.setProperty('--s', String(s));
      item.style.setProperty('--breathe-delay', `${-depthIndex * 1.7}s`);
      item.dataset.x = String(x);
      item.dataset.y = String(y);
      if (!slot.load) item.classList.add('is-dormant');
      // 押せるのは足もとの光（pool）から支柱（stand）と天球儀（globe）までの一本。
      const light = document.createElement('button');
      light.type = 'button';
      light.className = 'journey-footprint-light';
      for (const part of ['pool', 'stand', 'globe']) {
        const span = document.createElement('span');
        span.className = `journey-footprint-${part}`;
        light.append(span);
      }
      const date = new Date(slot.updatedAt);
      const dateText = Number.isNaN(date.getTime()) ? slot.updatedAt : dateFormat.format(date);
      light.setAttribute('aria-label', [dateText, slot.summary, slot.note].filter(Boolean).join(' '));
      light.disabled = !slot.load;
      light.addEventListener('click', () => chooseFootprint(item, slot));
      const words = document.createElement('div');
      words.className = 'journey-footprint-words';
      const dateLine = document.createElement('p');
      dateLine.className = 'journey-footprint-date';
      dateLine.textContent = dateText;
      const summaryLine = document.createElement('p');
      summaryLine.className = 'journey-footprint-summary';
      summaryLine.textContent = slot.summary;
      const noteLine = document.createElement('p');
      noteLine.className = 'journey-footprint-note';
      noteLine.textContent = slot.note;
      const erase = document.createElement('button');
      erase.type = 'button';
      erase.className = 'journey-path journey-footprint-erase';
      erase.textContent = '消す';
      erase.addEventListener('click', () => slot.remove.click());
      words.append(dateLine, summaryLine, noteLine);
      // 読めないセーブの札は、読めない理由の一文を添える（製品の札の言葉をそのまま写す）。
      if (slot.reason) {
        const reasonLine = document.createElement('p');
        reasonLine.className = 'journey-footprint-reason';
        reasonLine.textContent = slot.reason;
        words.append(reasonLine);
      }
      words.append(erase);
      item.append(words, light);
      item.addEventListener('mouseenter', () => item.classList.add('is-near'));
      item.addEventListener('mouseleave', () => { if (!item.contains(document.activeElement)) item.classList.remove('is-near'); });
      item.addEventListener('focusin', () => item.classList.add('is-near'));
      item.addEventListener('focusout', (event) => { if (!item.contains(event.relatedTarget)) item.classList.remove('is-near'); });
      return item;
    });
    footprintList.replaceChildren(...items);
    hallResume.hidden = product.resume.disabled;
  }

  // 選ぶと、その足跡から広間の奥へ星の道がゆっくり伸びる。読み込みは押した瞬間に製品の札のボタンで始まる。
  // 道は画面の画素の座標で描く（viewBox を窓の大きさに合わせ、pathLength=1 の破線の1本で伸ばす）。
  function chooseFootprint(item, slot) {
    slot.load.click();
    for (const other of footprintList.children) other.classList.remove('is-near');
    item.classList.add('is-chosen');
    layer.classList.add('is-gliding');
    const width = layer.clientWidth;
    const height = layer.clientHeight;
    const x = (Number(item.dataset.x) / 100) * width;
    const y = (Number(item.dataset.y) / 100) * height;
    const hx = (HALL_DEPTH[0] / 100) * width;
    const hy = (HALL_DEPTH[1] / 100) * height;
    trailSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    // 床の上を通路の中ほどへ寄ってから奥へ折れる弧。
    trail.setAttribute('d', `M ${x} ${y} Q ${hx} ${y} ${hx} ${hy}`);
    trail.style.strokeDashoffset = '0';
    if (!reducedMotion.matches) {
      track(trail.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: TRAIL_DRAW_MS, easing: 'cubic-bezier(.45,.05,.55,.95)', fill: 'both' }));
    }
    layer.classList.add('is-passing');
    enterRoad('glide');
    const hallPanel = panels.get('hall');
    hallPanel.classList.add('is-shown');
    setTimeout(() => { if (scene !== 'hall') hallPanel.classList.remove('is-shown'); }, reducedMotion.matches ? HALL_HOLD_REDUCED_MS : HALL_HOLD_MS);
  }

  function clearHall() {
    trail.setAttribute('d', '');
    trail.style.strokeDashoffset = '';
    for (const item of footprintList.children) item.classList.remove('is-chosen', 'is-near');
  }

  function syncRoadCopy() {
    roadTitle.textContent = product.loadingTitle.textContent.trim();
    roadStatus.textContent = product.loadingStatus.textContent.trim();
  }

  let roadCopyTimer = null;
  function showRoadCopy() {
    syncRoadCopy();
    roadCopy.classList.remove('is-settled');
    clearTimeout(roadCopyTimer);
    roadCopyTimer = setTimeout(() => roadCopy.classList.add('is-settled'), 3000);
  }

  function enterRoad(kind) {
    setScene('road');
    showRoadCopy();
    walk(kind, 'road').then(() => {
      if (scene === 'road' && currentPlace === 'road') startRoadDrift();
    });
  }

  // 露台に着く: 製品がハブの画面を出した時点で呼ぶ。道の演出が途中でも残りを待たない。層はその場で押下を通し（ハブは製品が
  // 出したそのままの姿で押せる）、着いた一瞬（速い動き）を層の中だけで見せる: 星の道が消える点へ一気に寄って光り、露台の絵
  // （ハブの背景と同じ絵・同じ重ね）が満ちる。露台だけが見える一目のあと層が溶け、同じ絵の上にハブが立つ。
  async function arrive() {
    if (arrivalPending) return;
    arrivalPending = true;
    finishRunning();
    stopRoadDrift();
    setScene('arriving');
    const reduced = reducedMotion.matches;
    walk('arrive', 'terrace');
    // 溶けは着いた時刻から数える（ハブを出した直後の描画で最初の frame が遅れても、露台だけが見える一目は延びない）。一目の
    // 区切りは実時間の ARRIVAL_GLIMPSE で、easing は溶けていく区間にだけ掛ける。
    const dissolve = layer.animate(
      reduced
        ? [{ opacity: 1, easing: 'ease-in-out' }, { opacity: 0 }]
        : [{ opacity: 1 }, { opacity: 1, offset: ARRIVAL_GLIMPSE, easing: 'ease-in-out' }, { opacity: 0 }],
      { duration: reduced ? ARRIVAL_REDUCED_MS : ARRIVAL_MS, fill: 'both' }
    );
    dissolve.startTime = document.timeline.currentTime;
    await dissolve.finished;
    finishRunning();
    setScene('play');
    dissolve.cancel();
    clearHall();
    layer.classList.remove('is-passing', 'is-gliding');
    arrivalPending = false;
  }

  // 「今日はここまで」: 露台から星の道を逆にたどって門へ戻る。星は降らず、題字は灯ったまま。
  async function returnFromTerrace() {
    setPlace('terrace');
    setScene('road');
    showRoadCopy();
    await fadeLayer(1, 700);
    walk('back', 'road');
  }

  function gateFromReturn() {
    finishRunning();
    title.classList.add('is-lit');
    setScene('gate');
    walk('back', 'gate');
    syncGate();
    leavingForGate = false;
  }

  // ── 部屋（設定） ─────────────────────────────────────────────────────────────────────────────────────────
  async function openRoomInPlay() {
    roomMode = 'play';
    setPlace('room', { dim: true });
    setScene('room');
    document.body.classList.add('journey-room-lit');
    refreshSettings();
    await fadeLayer(1, 800);
  }

  async function closeRoomInPlay() {
    const settingsFade = product.screens.settings.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reducedMotion.matches ? 200 : 500, fill: 'forwards' });
    const layerFade = fadeLayer(0, 600);
    await settingsFade.finished;
    document.body.classList.remove('journey-room-lit');
    settingsFade.cancel();
    await layerFade;
    setScene('play');
    places.get('room').style.opacity = '';
    roomMode = null;
  }

  // ── 押す ─────────────────────────────────────────────────────────────────────────────────────────────────
  function reportJourneyError(error) {
    console.error(error);
  }

  const actions = {
    'new-game': () => {
      product.startNewGame.click();
      layer.classList.add('is-passing');
      enterRoad('pass');
    },
    load: () => {
      product.openLoad.click();
      setScene('hall');
      footprintList.replaceChildren();
      walk('pass', 'hall');
    },
    settings: () => {
      roomMode = 'title';
      product.openSettings.click();
      setScene('room');
      walk('side', 'room');
    },
    'hall-back': () => {
      product.backToTitle.click();
    },
    'hall-resume': () => {
      product.resume.click();
      layer.classList.add('is-passing');
      enterRoad('glide');
    },
    'room-back': () => {
      if (roomMode === 'play') {
        closeRoomInPlay().catch(reportJourneyError);
        return;
      }
      product.settingsBack.click();
    },
    'room-in-play': () => {
      openRoomInPlay().catch(reportJourneyError);
    }
  };

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-journey-action]');
    if (!button) return;
    const action = actions[button.dataset.journeyAction];
    if (!action) throw new Error(`meta journey: unknown action ${button.dataset.journeyAction}`);
    action();
  });

  // 「今日はここまで」は押されたことだけを覚える（製品の終わり方はそのまま走る）。
  product.hubEnd.addEventListener('click', () => {
    if (product.screens.hub.classList.contains('active')) leavingForGate = true;
  }, true);

  // ── 製品の画面の切り替えを見る ─────────────────────────────────────────────────────────────────────────
  function activeProductScreen() {
    for (const [name, element] of Object.entries(product.screens)) {
      if (element.classList.contains('active')) return name;
    }
    return product.layout.querySelector(':scope > .screen.active') ? 'other' : null;
  }

  let lastProductScreen = activeProductScreen();
  function onProductScreen() {
    const screen = activeProductScreen();
    if (screen === lastProductScreen) return;
    lastProductScreen = screen;
    if (screen === 'title') {
      layer.classList.remove('is-passing');
      if (leavingForGate) {
        gateFromReturn();
        return;
      }
      if (scene === 'hall') {
        setScene('gate');
        walk('back', 'gate');
      } else if (scene === 'room') {
        setScene('gate');
        walk('side-back', 'gate');
        roomMode = null;
      } else if (scene !== 'gate') {
        // 読み込みが途中で止まって門へ戻された（製品のエラーの戻し先）か、遊びの中からタイトルへ出た。静かに門へ。
        finishRunning();
        lightTitle();
        setScene('gate');
        walk('back', 'gate');
      }
      syncGate();
      return;
    }
    if (screen === 'slotLoad') {
      if (scene !== 'hall') {
        setScene('hall');
        walk('glide', 'hall');
      }
      renderFootprints();
      return;
    }
    if (screen === 'settings') {
      if (scene !== 'room') {
        roomMode = 'title';
        setScene('room');
        walk('side', 'room');
      }
      return;
    }
    if (screen === 'loading') {
      if (scene === 'play' && leavingForGate) {
        returnFromTerrace().catch(reportJourneyError);
        return;
      }
      if (scene === 'play') return;
      if (scene !== 'road') enterRoad('glide');
      return;
    }
    if (screen === 'hub') {
      if (scene === 'play') {
        if (roomMode === 'play') return;
        leavingForGate = false;
        return;
      }
      arrive().catch(reportJourneyError);
      return;
    }
    if (scene !== 'play') {
      // ハブ以外の遊びの画面（卒業の再入など）には層を持ち込まない。
      finishRunning();
      fadeLayer(0, 400).then(() => setScene('play'));
    }
  }

  new MutationObserver(onProductScreen).observe(product.layout, { subtree: true, attributes: true, attributeFilter: ['class'] });
  new MutationObserver(syncGate).observe(product.openLoad, { attributes: true, attributeFilter: ['disabled'] });
  new MutationObserver(syncGate).observe(product.titleStatus, { attributes: true, childList: true, characterData: true, subtree: true });
  new MutationObserver(() => { if (scene === 'hall') renderFootprints(); }).observe(product.slotList, { childList: true });
  new MutationObserver(() => { hallResume.hidden = product.resume.disabled; }).observe(product.resume, { attributes: true, attributeFilter: ['disabled'] });
  new MutationObserver(() => { if (scene === 'road') syncRoadCopy(); }).observe(product.loadingTitle.parentElement, { childList: true, characterData: true, subtree: true });

  // 製品の星座が始まるとき（ロードの画面への本当の入り）にこちらも始め、1本足されるごとにこちらも1本結ぶ。
  new MutationObserver(() => {
    const loaderActive = document.body.classList.contains('academy-loading-screen-active');
    if (loaderActive && !constellationRunning) {
      constellationRunning = true;
      productConstellationRevealed = 0;
      constellation.start();
    }
    if (!loaderActive && constellationRunning) {
      constellationRunning = false;
      constellation.stop();
    }
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(() => {
    const revealed = Number(product.loadingConstellation.dataset.constellationRevealed ?? 0);
    if (revealed < productConstellationRevealed) productConstellationRevealed = 0;
    while (productConstellationRevealed < revealed) {
      productConstellationRevealed += 1;
      constellation.notifyProgress();
    }
  }).observe(product.loadingConstellation, { attributes: true, attributeFilter: ['data-constellation-revealed'] });

  window.addEventListener('resize', () => sky.resize());

  // ── 開いたとき ───────────────────────────────────────────────────────────────────────────────────────────
  // 配信された HTML が門（タイトル）を出しているふつうの起動では、星がひとつ降りて題字が灯る。デバッグの起動と開発用の画面の
  // 入口（?initialScreen=…）は遊びの画面から始まるので、層は下りたまま題字は灯っておく。
  setPlace('gate');
  if (lastProductScreen === 'title') {
    setScene('gate');
    if (reducedMotion.matches) lightTitle();
    else sky.fallOnce().then(lightTitle);
  } else {
    lightTitle();
    setScene('play');
  }
  syncGate();

  return {
    // 製品の起動が終わった（applyInitialScreenOverride まで走った）ことを知らせる。門の選択肢はここから受ける — それより前に
    // 押すと、開いた画面が起動の最後の showScreen('title') で門へ戻される。
    bootFinished() {
      layer.dataset.journeyReady = 'true';
    }
  };
}
