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
      // 札の値は札の要素が data 属性で持つ（要約行の字は見せ方なので読まない）。
      const value = (key, attribute) => {
        if (card.dataset[key] === undefined) throw new Error(`meta journey: a slot card must carry ${attribute}`);
        return card.dataset[key];
      };
      if (degraded) {
        if (buttons.length !== 1) throw new Error('meta journey: a degraded slot card must hold exactly the delete button');
        const reason = required('.slot-load-item-degraded-reason', card).textContent;
        return { slotId: value('slotId', 'data-slot-id'), updatedAt: value('updatedAt', 'data-updated-at'), summary: '', note: value('note', 'data-note'), reason, load: null, remove: buttons[0] };
      }
      if (buttons.length !== 2) throw new Error('meta journey: a slot card must hold the load and delete buttons');
      const noteField = required('textarea', card);
      const slotId = noteField.name.replace(/^player_note_/, '');
      // まとめは要約行（ / 区切り）に混ぜず、独立した行から読む。まとめを持たないセーブの札には行が無い。
      const summary = card.querySelector('.slot-load-item-footprint-summary')?.textContent ?? '';
      return { slotId, updatedAt: value('updatedAt', 'data-updated-at'), summary, note: noteField.value.trim(), reason: null, load: buttons[0].disabled ? null : buttons[0], remove: buttons[1] };
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

  // 星の道の知らせの言葉は製品の読み込みの字を写す。ただしハブへ入る字（製品が data-hub-entry の印を付ける・新しいゲーム・ロード・
  // プレイに戻る）は写さず、道行きだけにする。字が灯ったら 3 秒で落ち着かせる。
  let roadCopyTimer = null;
  function syncRoadCopy() {
    const wasHidden = roadCopy.hidden;
    roadTitle.textContent = product.loadingTitle.textContent.trim();
    roadStatus.textContent = product.loadingStatus.textContent.trim();
    roadCopy.hidden = product.screens.loading.hasAttribute('data-hub-entry');
    if (!wasHidden || roadCopy.hidden) return;
    roadCopy.classList.remove('is-settled');
    clearTimeout(roadCopyTimer);
    roadCopyTimer = setTimeout(() => roadCopy.classList.add('is-settled'), 3000);
  }

  // いま製品が出している字を灯し直す。
  function showRoadCopy() {
    roadCopy.hidden = true;
    syncRoadCopy();
  }

  // 押して星の道へ入った時点では、製品はまだこの道の字を出していない（前の読み込みの字が残っている）ので、字は製品が次に字を出した
  // ところで灯す（syncRoadCopy）。
  function enterRoad(kind) {
    setScene('road');
    roadCopy.hidden = true;
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

  // ── 卒業の終わり（walkGraduationRoad）────────────────────────────────────────────────────────────────────
  // 卒業の会話の最後の一言が出たあとの一続き。製品の画面はその下でそのまま（会話の画面のまま）で、タイトルへは app.js が移す。
  //   一言が残る  会話の画面で、相手の顔・名・最後の一言だけを場所の絵の上に残す（CSS が data-graduation-road で退かせる）。
  //   暮れ        学院の人は場所の絵に暮れの色と暗さを時間で重ね、案内人は露台の絵が沈む。暮れきったところで層（星の道の絵）が満ちる。
  //   星の道      一年に出会った人が出会った順に道の上で灯り（顔と名がそばに浮かぶ）、星になって空へ流れて線で結ばれる。
  //   道の終わり  流れた星が空の奥で一つの星座に揃い、卒業の相手が顔・名・最後の一言で道の終わりに迎える。
  //   締め        道の終わりを見せきってから、卒業の会話の締め（app.js）を走らせ、済むまで道の終わりの場面のまま待つ。
  // 押さなくても進み、押すと次へ早まる（一言 → 暮れ → 次の人 → 道の終わりを終える）。戻る・止まるは無い。字は人の名前と一言だけ。
  const graduation = {
    panel: required('.journey-graduation', layer),
    stage: required('.journey-graduation-stage', layer),
    sky: required('.journey-graduation-sky', layer),
    people: required('.journey-graduation-people', layer),
    partner: required('.journey-graduation-partner', layer),
    partnerFace: required('.journey-graduation-partner-face', layer),
    partnerName: required('.journey-graduation-partner-name', layer),
    partnerLine: required('.journey-graduation-partner-line', layer)
  };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // 舞台（1440×900）の座標。星が灯る道の上の一点と、流れた星が並ぶ空（出会った順・月を避けて道の終わりの塔の上へ続く）、
  // 道の終わりで揃う星座（相手にかからない左上の奥）。
  const ROAD_LIGHT = [884, 472];
  const ROAD_SKY = [[150, 360], [272, 268], [392, 318], [520, 236], [652, 286], [776, 206], [896, 262], [1006, 196], [1112, 250], [1214, 176]];
  const ROAD_END_SKY = [[96, 352], [176, 286], [262, 322], [330, 236], [470, 268], [552, 196], [640, 246], [730, 176], [808, 220], [880, 150]];
  const COMPANION_OFFSETS = [[22, -17], [-19, -21], [27, 13], [-25, 15]];
  // 間（ミリ秒）。一言は字数に応じて六秒から（一字 125ms）。一人は灯り・留まり・流れで、次の人は前の人が流れ始めて少しで灯る。
  const LAST_LINE_MIN_MS = 6000;
  const LAST_LINE_PER_CHAR_MS = 125;
  const DUSK_MS = 8000;
  const SINK_MS = 6500;
  const STAR_LIGHT_MS = 1200;
  const STAR_STAY_MS = 3500;
  const STAR_FLOW_MS = 1300;
  const STAR_NEXT_MS = 700;
  const GATHER_MS = 1800;
  const ROAD_END_MIN_MS = 10000;
  const MOTION_REDUCED_MS = 240;

  // 暮れ・沈みの重ね（場所の絵の層に掛ける filter と、.graduation-dusk の重ねの不透明度）。offset は時間の割合。
  const DUSK_KEYS = [
    { offset: 0, filter: 'brightness(1) saturate(1) sepia(0) hue-rotate(0deg)', sunset: 0, night: 0, lamp: 0, stars: 0, people: 1 },
    { offset: 0.25, filter: 'brightness(0.92) saturate(1.05) sepia(0.28) hue-rotate(-6deg)', sunset: 0.8, night: 0, lamp: 0.3, stars: 0, people: 0.75 },
    { offset: 0.5, filter: 'brightness(0.76) saturate(0.9) sepia(0.26) hue-rotate(-8deg)', sunset: 1, night: 0.3, lamp: 0.6, stars: 0.4, people: 0.25 },
    { offset: 0.75, filter: 'brightness(0.66) saturate(0.82) sepia(0.08) hue-rotate(0deg)', sunset: 0.2, night: 1, lamp: 1, stars: 1, people: 0 },
    { offset: 1, filter: 'brightness(0.66) saturate(0.82) sepia(0.08) hue-rotate(0deg)', sunset: 0.2, night: 1, lamp: 1, stars: 1, people: 0 }
  ];
  const SINK_KEYS = [
    { offset: 0, filter: 'brightness(1) saturate(1)', sunset: 0, night: 0, lamp: 0, stars: 0, people: 1, sink: 0 },
    { offset: 0.55, filter: 'brightness(0.55) saturate(0.8)', sunset: 0, night: 0.5, lamp: 0, stars: 0.6, people: 0.3, sink: 14 },
    { offset: 1, filter: 'brightness(0.62) saturate(0.8)', sunset: 0, night: 0.45, lamp: 0, stars: 1, people: 0, sink: 26 }
  ];
  // 星の道の絵が満ち始める割合（暮れきり・沈みきりのあと）。
  const DUSK_ROAD_FROM = 0.75;
  const SINK_ROAD_FROM = 0.55;

  let graduationRun = null;

  function graduationScale() {
    graduation.stage.style.setProperty('--graduation-scale', String(Math.max(window.innerWidth / 1440, window.innerHeight / 900)));
  }

  function svg(tag, attributes = {}) {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  }

  function rayPath(radius, inner) {
    return `M0 ${-radius} L${inner} ${-inner} L${radius} 0 L${inner} ${inner} L0 ${radius} L${-inner} ${inner} L${-radius} 0 L${-inner} ${-inner} Z`;
  }

  // 一人の星: 明るさ（0.35〜1.0）で芯・光の輪・光条の大きさと不透明度の両方を変える。寄り添う星は金の小さな星。
  function drawStar(person) {
    const b = person.brightness;
    const core = 1.2 + 6 * b;
    const glow = 4 + 50 * b;
    const star = svg('g', { class: 'journey-graduation-star', 'data-character-id': person.character_id, 'data-brightness': b });
    star.style.opacity = '0';
    const body = svg('g', { opacity: (0.5 + 0.5 * b).toFixed(3) });
    body.append(
      svg('circle', { r: glow.toFixed(1), fill: 'url(#journey-graduation-glow)' }),
      svg('path', { class: 'journey-graduation-star-ray', d: rayPath(core * 3.4, core * 0.55) }),
      svg('circle', { class: 'journey-graduation-star-core', r: core.toFixed(1) })
    );
    star.append(body);
    for (let i = 0; i < Math.min(person.companions, COMPANION_OFFSETS.length); i += 1) {
      const [dx, dy] = COMPANION_OFFSETS[i];
      const companion = svg('g', { transform: `translate(${dx} ${dy})`, opacity: '0.9', class: 'journey-graduation-companion' });
      companion.append(svg('circle', { r: 7, fill: 'url(#journey-graduation-glow)' }), svg('path', { class: 'journey-graduation-companion-ray', d: rayPath(4.8, 0.96) }));
      star.append(companion);
    }
    return star;
  }

  function placeTransform([x, y], scale) {
    return `translate(${x}px, ${y}px) scale(${scale})`;
  }

  // 暮れの空に灯り始める小さな星（決まった並び）。
  function faintStars(count) {
    let seed = 7;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const field = svg('svg', { viewBox: '0 0 1440 900', preserveAspectRatio: 'xMidYMid slice', class: 'graduation-dusk-stars' });
    for (let i = 0; i < count; i += 1) {
      field.append(svg('circle', {
        cx: (rand() * 1440).toFixed(1),
        cy: (rand() * 420).toFixed(1),
        r: (0.5 + rand() * 1.1).toFixed(2),
        fill: `rgba(214,224,255,${(0.85 * (0.35 + rand() * 0.65)).toFixed(2)})`
      }));
    }
    return field;
  }

  // 一続きの間の待ち: 押すと待ちが早く終わる。押下は一回で一つの待ちだけを縮める。
  function graduationHold(run, ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        if (run.release === done) run.release = null;
        resolve();
      }
      run.release = done;
    });
  }

  function graduationAnimate(run, element, keyframes, options) {
    const animation = element.animate(keyframes, { fill: 'both', ...options });
    run.animations.push(animation);
    return animation;
  }

  function onGraduationPress(event) {
    if (!graduationRun) return;
    event.preventDefault();
    event.stopPropagation();
    const run = graduationRun;
    for (const animation of run.animations) if (animation.playState === 'running') animation.finish();
    if (run.release) run.release();
  }

  function lastLinePhase(run) {
    run.screen.dataset.graduationRoad = 'last-line';
    const chars = run.road.partner.line.join('').length;
    return graduationHold(run, Math.max(LAST_LINE_MIN_MS, chars * LAST_LINE_PER_CHAR_MS));
  }

  // 暮れ（学院の人）・沈み（案内人）: 場所の絵に重ねを掛け、人と一言を退かせ、暮れきったところで層（星の道）を満たす。
  async function duskPhase(run, { onDusk }) {
    run.screen.dataset.graduationRoad = 'dusk';
    const keys = run.kind === 'hub' ? SINK_KEYS : DUSK_KEYS;
    const duration = reducedMotion.matches ? MOTION_REDUCED_MS * 4 : run.kind === 'hub' ? SINK_MS : DUSK_MS;
    const roadFrom = run.kind === 'hub' ? SINK_ROAD_FROM : DUSK_ROAD_FROM;
    const dusk = required('.graduation-dusk', run.screen);
    const parts = Object.fromEntries(['sunset', 'night', 'lamp'].map((name) => {
      const element = document.createElement('div');
      element.className = `graduation-dusk-${name}`;
      return [name, element];
    }));
    const stars = faintStars(110);
    dusk.replaceChildren(parts.sunset, parts.night, parts.lamp, stars);
    onDusk();
    graduationAnimate(run, run.backdrop, keys.map((key) => ({
      offset: key.offset,
      filter: key.filter,
      transform: key.sink === undefined ? 'none' : `translateY(${key.sink}px) scale(${(1 + 2.4 * key.sink / 900).toFixed(3)})`
    })), { duration, easing: 'linear' });
    for (const name of ['sunset', 'night', 'lamp']) {
      graduationAnimate(run, parts[name], keys.map((key) => ({ offset: key.offset, opacity: key[name] })), { duration, easing: 'linear' });
    }
    graduationAnimate(run, stars, keys.map((key) => ({ offset: key.offset, opacity: key.stars })), { duration, easing: 'linear' });
    graduationAnimate(run, run.frame, keys.map((key) => ({ offset: key.offset, opacity: key.people })), { duration, easing: 'linear' });
    // 星の道の層: 暮れきったところから満ちる。
    finishRunning();
    stopRoadDrift();
    setPlace('road');
    setScene('graduation');
    layer.classList.add('is-passing');
    graduationAnimate(run, layer, [{ opacity: 0 }, { opacity: 0, offset: roadFrom }, { opacity: 1 }], { duration, easing: 'ease-in-out' });
    await graduationHold(run, duration);
    for (const animation of run.animations) animation.finish();
    startRoadDrift();
  }

  function personTag(person) {
    const tag = document.createElement('figure');
    tag.className = 'journey-graduation-person';
    tag.dataset.characterId = person.character_id;
    const face = document.createElement('img');
    face.src = person.face_url;
    face.alt = '';
    const name = document.createElement('figcaption');
    name.textContent = person.name;
    tag.append(face, name);
    tag.style.left = `${ROAD_LIGHT[0] + 150}px`;
    tag.style.top = `${ROAD_LIGHT[1] - 6}px`;
    return tag;
  }

  // 星の道: 出会った順に一人ずつ灯り、星になって空へ流れる。押すと、いま留まっている人が流れ始めて次の人が灯る。
  async function starsPhase(run, { onStarLit }) {
    const { sky, people } = graduation;
    const reduced = reducedMotion.matches;
    const lines = svg('g', { class: 'journey-graduation-lines' });
    const starLayer = svg('g', { class: 'journey-graduation-stars' });
    sky.append(lines, starLayer);
    run.stars = [];
    run.lines = lines;
    let previous = null;
    for (const [index, person] of run.road.people.entries()) {
      const star = drawStar(person);
      starLayer.append(star);
      const tag = personTag(person);
      people.append(tag);
      run.stars.push(star);
      star.dataset.litAt = String(Math.round(performance.now()));
      graduation.panel.dataset.litCount = String(index + 1);
      onStarLit(index);
      graduationAnimate(run, star, [
        { opacity: 0, transform: placeTransform(ROAD_LIGHT, 0.4) },
        { opacity: 1, transform: placeTransform(ROAD_LIGHT, 1.25) }
      ], { duration: reduced ? MOTION_REDUCED_MS : STAR_LIGHT_MS, easing: 'cubic-bezier(.2,.7,.3,1)' });
      graduationAnimate(run, tag, [{ opacity: 0 }, { opacity: 1 }], { duration: reduced ? MOTION_REDUCED_MS : STAR_LIGHT_MS, easing: 'ease-out' });
      await graduationHold(run, STAR_LIGHT_MS + STAR_STAY_MS);
      // 流れ: 星は空の置き場へ、顔と名は薄れながら少し残って消える。前の星から線が伸びる。
      const slot = ROAD_SKY[index];
      graduationAnimate(run, star, [
        { opacity: 1, transform: placeTransform(ROAD_LIGHT, 1.25) },
        { opacity: 1, transform: placeTransform(slot, 0.85) }
      ], { duration: reduced ? MOTION_REDUCED_MS : STAR_FLOW_MS, easing: 'cubic-bezier(.45,0,.55,1)' });
      graduationAnimate(run, tag, [{ opacity: 1 }, { opacity: 0.3, offset: 0.5 }, { opacity: 0 }], { duration: reduced ? MOTION_REDUCED_MS : STAR_FLOW_MS * 2, easing: 'ease-in' });
      if (previous) {
        const segment = svg('path', { class: 'journey-graduation-line', d: `M${previous[0]} ${previous[1]} L${slot[0]} ${slot[1]}`, pathLength: 1, 'stroke-dasharray': 1 });
        lines.append(segment);
        graduationAnimate(run, segment, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: reduced ? MOTION_REDUCED_MS : STAR_FLOW_MS, delay: reduced ? 0 : STAR_FLOW_MS * 0.6, easing: 'ease-out' });
      }
      previous = slot;
      if (index < run.road.people.length - 1) await graduationHold(run, STAR_NEXT_MS);
    }
    await graduationHold(run, reduced ? MOTION_REDUCED_MS : STAR_FLOW_MS * 2);
  }

  // 道の終わり: 流れた星が空の奥で一つの星座に揃い、卒業の相手が顔・名・最後の一言で迎える。
  async function roadEndPhase(run) {
    const reduced = reducedMotion.matches;
    const gather = reduced ? MOTION_REDUCED_MS : GATHER_MS;
    graduationAnimate(run, run.lines, [{ opacity: 1 }, { opacity: 0 }], { duration: gather / 3 });
    const endLines = svg('g', { class: 'journey-graduation-lines' });
    const points = run.stars.map((_, index) => ROAD_END_SKY[index]);
    if (points.length > 1) {
      endLines.append(svg('path', { class: 'journey-graduation-line', d: points.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' '), opacity: 0.7 }));
    }
    graduation.sky.insertBefore(endLines, run.lines.nextSibling);
    run.stars.forEach((star, index) => {
      graduationAnimate(run, star, [
        { opacity: 1, transform: placeTransform(ROAD_SKY[index], 0.85) },
        { opacity: 1, transform: placeTransform(ROAD_END_SKY[index], 0.85) }
      ], { duration: gather, easing: 'cubic-bezier(.45,0,.55,1)' });
    });
    graduationAnimate(run, endLines, [{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }], { duration: gather, easing: 'ease-out' });
    const { partner } = run.road;
    graduation.partnerFace.src = partner.face_url;
    graduation.partnerName.textContent = partner.name;
    graduation.partnerLine.replaceChildren(...partner.line.map((text) => {
      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      return paragraph;
    }));
    graduationAnimate(run, graduation.partner, [{ opacity: 0, transform: 'translateX(-50%) translateY(14px)' }, { opacity: 1, transform: 'translateX(-50%) translateY(0)' }], {
      duration: reduced ? MOTION_REDUCED_MS : 1600,
      delay: reduced ? 0 : gather * 0.5,
      easing: 'ease-out'
    });
    graduation.panel.dataset.roadEnd = 'true';
    const chars = partner.line.join('').length;
    await graduationHold(run, Math.max(ROAD_END_MIN_MS, chars * LAST_LINE_PER_CHAR_MS) + gather);
  }

  // 一続きを下ろす: 製品の画面への手入れを戻し、層の場面の中身を空にする（層は星の道の絵のまま残り、製品がタイトルを出すと門へ戻る）。
  function clearGraduation(run) {
    document.removeEventListener('click', onGraduationPress, true);
    for (const animation of run.animations) animation.cancel();
    delete run.screen.dataset.graduationRoad;
    required('.graduation-dusk', run.screen).replaceChildren();
    graduation.sky.replaceChildren(graduation.sky.querySelector('defs'));
    graduation.people.replaceChildren();
    graduation.partner.style.opacity = '';
    graduation.partnerFace.removeAttribute('src');
    graduation.partnerName.textContent = '';
    graduation.partnerLine.replaceChildren();
    delete graduation.panel.dataset.litCount;
    delete graduation.panel.dataset.roadEnd;
    delete graduation.panel.dataset.ending;
    graduationRun = null;
  }

  function validateRoad(road) {
    if (!road || !Array.isArray(road.people) || road.people.length === 0) throw new Error('graduation road: people are required');
    if (road.people.length > ROAD_SKY.length) throw new Error(`graduation road: ${road.people.length} people exceed the ${ROAD_SKY.length} sky places`);
    if (!road.partner || !Array.isArray(road.partner.line) || road.partner.line.length === 0) throw new Error('graduation road: the partner line is required');
    if (!road.people.some((person) => person.character_id === road.partner.character_id)) throw new Error('graduation road: the partner must be on the road');
  }

  // app.js が卒業の会話の終わりで呼ぶ。from は会話の画面（'day' = 昼の会話・'hub' = 露台）。ending は卒業の会話の締めを始めて
  // その約束を返す関数で、道の終わりを見せきってから呼び、締めが済むまで道の終わりの場面のまま待ってから返る（締めは道のあいだに
  // 走らない）。onDusk は暮れ始め、onStarLit(index) は人が灯るたび。
  async function walkGraduationRoad({ road, from, ending, onDusk, onStarLit }) {
    if (graduationRun) throw new Error('graduation road: already walking');
    validateRoad(road);
    if (from !== 'day' && from !== 'hub') throw new Error(`graduation road: unknown screen ${from}`);
    if (typeof ending !== 'function') throw new Error('graduation road: ending must be a function');
    if (typeof onDusk !== 'function' || typeof onStarLit !== 'function') throw new Error('graduation road: onDusk and onStarLit are required');
    const screen = from === 'hub' ? product.screens.hub : required('#conversation-day-screen');
    const run = {
      road,
      kind: from,
      screen,
      backdrop: required(from === 'hub' ? '.routing-hub-backdrop' : '.conversation-day-backdrop', screen),
      frame: required(from === 'hub' ? '.routing-hub-frame' : '.conversation-day-frame', screen),
      animations: [],
      release: null
    };
    graduationRun = run;
    graduationScale();
    if (!graduation.sky.querySelector('defs')) {
      const defs = svg('defs');
      const glow = svg('radialGradient', { id: 'journey-graduation-glow' });
      glow.append(
        svg('stop', { offset: 0, 'stop-color': 'rgb(214,224,255)', 'stop-opacity': 0.85 }),
        svg('stop', { offset: 0.35, 'stop-color': 'rgb(159,180,255)', 'stop-opacity': 0.32 }),
        svg('stop', { offset: 1, 'stop-color': 'rgb(159,180,255)', 'stop-opacity': 0 })
      );
      defs.append(glow);
      graduation.sky.append(defs);
    }
    document.addEventListener('click', onGraduationPress, true);
    // 書く口に残った入力の焦点を外す（退いた書く口へ Enter が届かないように）。
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    try {
      await lastLinePhase(run);
      await duskPhase(run, { onDusk });
      await starsPhase(run, { onStarLit });
      await roadEndPhase(run);
      graduation.panel.dataset.ending = 'running';
      await ending();
    } finally {
      clearGraduation(run);
    }
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

  // 「今日はここまで」は押されたことだけを覚える（製品の終わり方はそのまま走る）。案内人との卒業の会話のあいだ（露台の
  // data-graduation）は門へ帰る押下ではない: 卒業の終わりは「卒業しました。」の箱でタイトルへ出る。
  product.hubEnd.addEventListener('click', () => {
    if (product.screens.hub.classList.contains('active') && !('graduation' in product.screens.hub.dataset)) leavingForGate = true;
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
      if (scene !== 'road') {
        enterRoad('glide');
        showRoadCopy();
      }
      return;
    }
    if (screen === 'hub') {
      if (scene === 'play') {
        if (roomMode === 'play') return;
        leavingForGate = false;
        return;
      }
      // 露台へ戻ってきた（案内の週の「今日はここまで」は会話が続く）なら、門へ帰る途中ではない。
      leavingForGate = false;
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
  new MutationObserver(() => { if (scene === 'road') syncRoadCopy(); }).observe(product.screens.loading, { attributes: true, attributeFilter: ['data-hub-entry'] });

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

  window.addEventListener('resize', () => {
    sky.resize();
    if (graduationRun) graduationScale();
  });

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
    walkGraduationRoad,
    // 製品の起動が終わった（applyInitialScreenOverride まで走った）ことを知らせる。門の選択肢はここから受ける — それより前に
    // 押すと、開いた画面が起動の最後の showScreen('title') で門へ戻される。
    bootFinished() {
      layer.dataset.journeyReady = 'true';
    }
  };
}
