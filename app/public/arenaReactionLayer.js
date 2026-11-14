// 闘技会の試合の「場の反応」: 盤の出来事から拾う瞬間の見分け（DOM に触れない）、客席の灯の層、場の音。
//
// 層は自分では時を刻まない。盤の出来事が着く時刻に app.js が一つずつ呼び、層はその場で CSS の値と Web Animations を置くだけで、
// 毎コマの処理（requestAnimationFrame・interval）を持たない。見えていない間（hide）は器ごと描かれず、動きも残さない。
// 灯と光は客席の上（盤の列）だけに置く: 器が右の列（持ち込み・呪文・記録）の手前で切れ、その外へは描かれない。

export const ARENA_REACTION = Object.freeze({
  bigHitRatio: 0.3,       // 大技: 一撃が受けた者の最大 HP のこの割合以上で、
  bigHitRecord: 1.1,      //       かつその試合のそれまでの最大の一撃のこの倍以上（同じ重さの二発目では沸かない）。会心は常に大技。
  edgeEnter: 0.3,         // 追い詰め: 組の HP の合計が最大の合計のこの割合以下になった時。
  edgeExit: 0.45,         //           この割合以上へ戻れば解ける。
  heatPerHit: 1.6,        // 当たりごとに熱へ足す量（× 受けた者の最大 HP に対する割合）。
  heatHalfLifeMs: 5200    // 熱の半減。
});

const STRIKE_KINDS = new Set(['melee', 'cast']);
const TEAMS = Object.freeze(['a', 'b']);

function teamRatio(actors, hpOf, team) {
  let hp = 0;
  let max = 0;
  for (const actor of actors) {
    if (actor.team !== team) continue;
    hp += hpOf(actor);
    max += actor.max_hp;
  }
  if (max <= 0) throw new Error(`arena reaction: team ${team} has no HP to read`);
  return hp / max;
}

// 試合に入る時（始まり・読み直し）の覚え: それまでの最大の一撃は試合の記録の行から、追い詰めはいまの HP から立て直す。
export function arenaReactionMemory(view) {
  let maxHit = 0;
  for (const entry of view.log) {
    if (entry.kind === 'strike' || entry.kind === 'critical') maxHit = Math.max(maxHit, entry.amount);
  }
  const edge = {};
  for (const team of TEAMS) {
    const ratio = teamRatio(view.actors, (actor) => actor.hp, team);
    edge[team] = ratio > 0 && ratio <= ARENA_REACTION.edgeEnter;
  }
  return { maxHit, edge };
}

// 一つの応答か見返しの一手の出来事から、場が動く出来事ごとの beat を出す（解いた順）。memory（maxHit・edge）は進める。
// beat: { index（events の中の位置）, ratio（当たりの重さ・当たりでなければ 0）, moments }。当たった打ち合いは必ず beat になり、
// 回復・蘇生は場の様子を変えた時だけ beat になる。
//   bighit  大技が決まった（team = 当てた側）
//   fall    一人が倒れた（team = 倒れた側）
//   edge    追い詰められた（team = 追い詰められた側）
//   ease    追い詰めが解けた（team = 解けた側）
// 出来事は受けた者の id を持たないので、組の HP は手の主の側から読む: 出来事の from は手の主の升（応答の後の位置か、同じ応答の中で
// 後から動いたなら前の位置 — 盤の番の受け渡しと同じ読み）で、打ち合いは相手の組の HP を減らし、回復と蘇生は手の主の組の HP を
// 戻す。受けた者は応答の中で動くので升では決め切れない: 重さ（最大 HP に対する割合）は相手の組のうち to の升に一番近い者の
// 最大 HP で読み、倒れたかどうかは応答の後の盤（倒れた者は動かない）で読む。
export function arenaReactionBeats(previous, view, events, memory) {
  const before = new Map(previous.actors.map((actor) => [actor.actor_id, actor]));
  const standing = view.actors.filter((actor) => !before.get(actor.actor_id).down);
  const on = (tile, actor) => actor.x === tile.x && actor.y === tile.y;
  const ownerOf = (event) => {
    const owner = standing.find((actor) => on(event.from, actor)) ?? standing.find((actor) => on(event.from, before.get(actor.actor_id)));
    if (!owner) throw new Error(`arena reaction: ${event.kind} from ${event.from.x},${event.from.y} matches no standing fighter`);
    return owner;
  };
  const span = (tile, actor) => {
    const was = before.get(actor.actor_id);
    return Math.min(Math.abs(actor.x - tile.x) + Math.abs(actor.y - tile.y), Math.abs(was.x - tile.x) + Math.abs(was.y - tile.y));
  };
  const hp = {};
  const max = {};
  for (const team of TEAMS) {
    hp[team] = previous.actors.filter((actor) => actor.team === team).reduce((sum, actor) => sum + actor.hp, 0);
    max[team] = view.actors.filter((actor) => actor.team === team).reduce((sum, actor) => sum + actor.max_hp, 0);
    if (max[team] <= 0) throw new Error(`arena reaction: team ${team} has no HP to read`);
  }
  const edges = (moments) => {
    for (const team of TEAMS) {
      const ratio = hp[team] / max[team];
      if (!memory.edge[team] && ratio > 0 && ratio <= ARENA_REACTION.edgeEnter) {
        memory.edge[team] = true;
        moments.push({ kind: 'edge', team });
      } else if (memory.edge[team] && ratio >= ARENA_REACTION.edgeExit) {
        memory.edge[team] = false;
        moments.push({ kind: 'ease', team });
      }
    }
  };
  // この応答で倒れた者ごとに、その升に着いた最後の打ち合いが倒した一撃。
  const felling = new Map();
  for (const actor of view.actors) {
    if (!actor.down || before.get(actor.actor_id).down) continue;
    const index = events.findLastIndex((event) => STRIKE_KINDS.has(event.kind) && event.hit && on(event.to, actor));
    if (index !== -1) felling.set(index, actor);
  }
  const beats = [];
  events.forEach((event, index) => {
    if (event.kind === 'heal' || event.kind === 'revive') {
      if (event.kind === 'heal' && event.resource !== 'hp') return;
      const { team } = ownerOf(event);
      hp[team] = Math.min(max[team], hp[team] + event.amount);
      const moments = [];
      edges(moments);
      if (moments.length) beats.push({ index, ratio: 0, moments });
      return;
    }
    if (!STRIKE_KINDS.has(event.kind) || !event.hit) return;
    const striker = ownerOf(event).team;
    const struck = striker === 'a' ? 'b' : 'a';
    const target = standing.filter((actor) => actor.team === struck).reduce((near, actor) => (near === null || span(event.to, actor) < span(event.to, near) ? actor : near), null);
    if (!target) throw new Error(`arena reaction: strike at ${event.to.x},${event.to.y} has no fighter of team ${struck} to land on`);
    const ratio = event.damage / target.max_hp;
    hp[struck] = Math.max(0, hp[struck] - event.damage);
    const moments = [];
    if (event.crit || (ratio >= ARENA_REACTION.bigHitRatio && event.damage >= memory.maxHit * ARENA_REACTION.bigHitRecord)) {
      moments.push({ kind: 'bighit', team: striker, ratio });
    }
    memory.maxHit = Math.max(memory.maxHit, event.damage);
    if (felling.has(index)) moments.push({ kind: 'fall', team: struck });
    edges(moments);
    beats.push({ index, ratio, moments });
  });
  return beats;
}

// すぐ解ける追い詰めは拾わない: 追い詰め（edge）の後、span 手のうちに同じ組の追い詰めが回復で解ける（ease）なら、二つとも無かった
// ことにする（声が出た直後に盤の HP が戻って食い違うのを防ぐ）。turns は手ごとの beat の列（主人公の試合は一つの応答で一手）。
export function dropBriefArenaEdges(turns, span) {
  const entries = [];
  turns.forEach((beats, turn) => {
    for (const beat of beats) for (const moment of beat.moments) entries.push({ beat, moment, turn });
  });
  const dropped = new Set();
  entries.forEach((entry, position) => {
    if (entry.moment.kind !== 'edge' || dropped.has(entry)) return;
    const eased = entries.slice(position + 1).find((later) => !dropped.has(later) && later.moment.kind === 'ease' && later.moment.team === entry.moment.team);
    if (!eased || eased.turn - entry.turn > span) return;
    dropped.add(entry);
    dropped.add(eased);
  });
  for (const { beat, moment } of dropped) beat.moments.splice(beat.moments.indexOf(moment), 1);
  return dropped.size / 2;
}

// ── 客席の灯の層 ──

// 会場の絵（assets/canonical/arena/stage.jpg・2000×1125）の上の場所。幅 1200 に縮めた写しで読んだ座標。絵は窓を覆う大きさ・
// 中央寄せで敷かれている（.venue-ground の background-attachment: fixed）。
const ART = Object.freeze({ width: 2000, height: 1125, read: 1200 });
const STAND_QUADS = Object.freeze([
  { n: 30, q: [[0, 300], [185, 268], [300, 352], [0, 392]] },
  { n: 20, q: [[300, 290], [505, 288], [505, 328], [345, 338]] },
  { n: 20, q: [[705, 288], [905, 290], [860, 338], [705, 328]] },
  { n: 30, q: [[1015, 268], [1200, 300], [1200, 392], [900, 352]] },
  { n: 10, q: [[520, 296], [690, 296], [690, 314], [520, 314]] }
]);
const BRAZIERS = Object.freeze([[45, 385, 90], [205, 440, 100], [990, 440, 100], [1160, 385, 90], [92, 358, 50], [190, 343, 46], [322, 325, 40], [388, 318, 36], [455, 315, 34], [515, 315, 34], [705, 315, 34], [765, 318, 36], [832, 322, 40], [900, 325, 40], [1017, 345, 46], [1115, 360, 50]]);
const LIGHT_COLORS = Object.freeze(['#ffd9a0', '#ffb98a', '#fff1cf', '#ff9f8a', '#ffe7b0']);
const LIGHT_SEED = 20261114;
// 場の様子ごとの灯の濃さの倍率（live = 試合の濃さ・hush = 静まり・rise = 高まり・won／lost = 決着の後）。
const MOOD_LEVELS = Object.freeze({ live: 1, hush: 0.16, rise: 1.5, won: 2.4, lost: 0.3 });
const MOODS = Object.freeze(Object.keys(MOOD_LEVELS));
const HEAT_RISE_MS = 260;
const HEAT_DECAY_STEPS = 4;      // 熱の引きを半減ごとの折れ線で置く段の数（その先は引き切った濃さのまま）
const ENDED_MOOD_AFTER_MS = 500; // 決着の弾けから、勝ち負けの濃さへ移り始めるまで（その間は、それまでの場の様子の闇と光が残る）
const ENDED_SETTLE_MS = 1400;    // 勝ち負けの濃さへ移る長さ
const EDGE_FADE_PX = 48;         // 器の、右の列の側の縁をぼかす幅

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// root: 層の器（#arena-reaction）。stage: 盤の列（.arena-stage）。side: 右の列（.arena-side）。器は screen（闘技会の画面）の左上から
// 盤の列の端までで、右の列には掛からない。
export function createArenaReactionLayer({ root, screen, stage, side }) {
  const hush = Object.assign(document.createElement('div'), { className: 'arena-reaction-hush' });
  const rise = Object.assign(document.createElement('div'), { className: 'arena-reaction-rise' });
  const lightsNode = Object.assign(document.createElement('div'), { className: 'arena-reaction-lights' });
  root.replaceChildren(hush, rise, lightsNode);
  let lights = [];
  let flares = [];
  let box = null;          // 器の大きさ（px）: 灯と光が描かれる範囲
  let builtFor = null;     // 灯を置いた時の窓と器の大きさ
  let shown = false;
  let mood = 'live';
  let heat = 0;
  let heatAt = 0;
  let swelling = [];
  let lightsAnimation = null;
  let endedTimer = null;   // 決着の弾けの後、器の場の様子を勝ち負けへ替える予定

  function fit() {
    const s = screen.getBoundingClientRect();
    const st = stage.getBoundingClientRect();
    const sd = side.getBoundingClientRect();
    // 右の列が盤の列の右にあれば器は盤の列の右の端まで、下に回っていれば（狭い窓）盤の列の下の端まで。
    const beside = sd.left >= st.right;
    const below = sd.top >= st.bottom;
    if (!beside && !below) throw new Error('arena reaction: the right rail is neither beside nor below the board column');
    box = { left: s.left, top: s.top, width: (beside ? st.right : s.right) - s.left, height: (below ? st.bottom : s.bottom) - s.top };
    // 灯と光を置ける範囲: 器から、右の列の側のぼかした縁を除いた所。
    box.reachX = box.width - (beside ? EDGE_FADE_PX : 0);
    box.reachY = box.height - (beside ? 0 : EDGE_FADE_PX);
    root.style.width = `${box.width}px`;
    root.style.height = `${box.height}px`;
    root.dataset.edge = beside ? 'right' : 'bottom';
    root.style.setProperty('--arena-reaction-edge', `${EDGE_FADE_PX}px`);
  }

  // 絵の上の点 → 器の中の点。
  function artPoint([x, y]) {
    const scale = Math.max(window.innerWidth / ART.width, window.innerHeight / ART.height);
    const k = ART.width / ART.read;
    return {
      x: (window.innerWidth - ART.width * scale) / 2 + x * k * scale - box.left,
      y: (window.innerHeight - ART.height * scale) / 2 + y * k * scale - box.top
    };
  }
  const inside = (at, margin) => at.x >= margin && at.y >= margin && at.x <= box.reachX - margin && at.y <= box.reachY - margin;

  function build() {
    fit();
    const key = `${window.innerWidth}x${window.innerHeight}:${Math.round(box.width)}x${Math.round(box.height)}`;
    if (builtFor === key) return;
    builtFor = key;
    for (const flare of flares) flare.node.remove();
    lights = [];
    flares = [];
    const random = seeded(LIGHT_SEED);
    const nodes = [];
    for (const { n, q } of STAND_QUADS) {
      for (let i = 0; i < n; i += 1) {
        const u = random();
        const v = random();
        const top = [q[0][0] + (q[1][0] - q[0][0]) * u, q[0][1] + (q[1][1] - q[0][1]) * u];
        const bottom = [q[3][0] + (q[2][0] - q[3][0]) * u, q[3][1] + (q[2][1] - q[3][1]) * u];
        const at = artPoint([top[0] + (bottom[0] - top[0]) * v, top[1] + (bottom[1] - top[1]) * v]);
        // 乱数は器の外の灯の分も同じだけ進める（窓の大きさが変わっても、残る灯の色と息は同じ）。
        const size = 2.4 + random() * 2.2;
        const color = LIGHT_COLORS[Math.floor(random() * LIGHT_COLORS.length)];
        const k = 0.6 + random() * 0.8;
        const period = 1.4 + random() * 2.2;
        const delay = -random() * 3;
        if (!inside(at, 8)) continue;
        const node = document.createElement('i');
        node.className = 'arena-reaction-light';
        node.style.left = `${at.x}px`;
        node.style.top = `${at.y}px`;
        node.style.setProperty('--s', `${size.toFixed(1)}px`);
        node.style.setProperty('--c', color);
        node.style.setProperty('--k', k.toFixed(2));
        node.style.setProperty('--t', `${period.toFixed(2)}s`);
        node.style.setProperty('--d', `${delay.toFixed(2)}s`);
        lights.push({ node, at });
        nodes.push(node);
      }
    }
    lightsNode.replaceChildren(...nodes);
    for (const [x, y, size] of BRAZIERS) {
      const at = artPoint([x, y]);
      const reach = size * 1.9;
      if (!inside(at, reach / 2)) continue;
      const node = document.createElement('i');
      node.className = 'arena-reaction-flare';
      node.style.left = `${at.x}px`;
      node.style.top = `${at.y}px`;
      node.style.setProperty('--s', `${reach}px`);
      flares.push({ node });
      root.append(node);
    }
  }

  const heatNow = () => heat * 0.5 ** ((performance.now() - heatAt) / ARENA_REACTION.heatHalfLifeMs);
  const level = (value, of) => Math.max(0, Math.min(1, (0.25 + 0.75 * value) * MOOD_LEVELS[of]));

  // 灯の濃さを、いまの熱といまの場の様子へ寄せ、その先の熱の引きを折れ線で置く（一つの動きを器に一つ置くだけ）。
  function relevel(riseMs = HEAT_RISE_MS) {
    const from = Number(getComputedStyle(lightsNode).opacity);
    lightsAnimation?.cancel();
    const now = heatNow();
    const total = riseMs + HEAT_DECAY_STEPS * ARENA_REACTION.heatHalfLifeMs;
    const frames = [{ opacity: from, offset: 0 }, { opacity: level(now, mood), offset: riseMs / total }];
    for (let step = 1; step <= HEAT_DECAY_STEPS; step += 1) {
      frames.push({ opacity: level(now * 0.5 ** step, mood), offset: (riseMs + step * ARENA_REACTION.heatHalfLifeMs) / total });
    }
    lightsAnimation = lightsNode.animate(frames, { duration: total, fill: 'forwards', easing: 'linear' });
  }

  // 決着の灯: 総立ちの間（holdMs）は試合の濃さのまま明るみ、その後に勝ち負けの濃さへ移って留まる。
  function relevelEnded(holdMs) {
    const from = Number(getComputedStyle(lightsNode).opacity);
    lightsAnimation?.cancel();
    const total = holdMs + ENDED_SETTLE_MS;
    const frames = [{ opacity: from, offset: 0 }];
    if (holdMs > 0) frames.push({ opacity: level(1, 'live'), offset: Math.min(HEAT_RISE_MS, holdMs) / total }, { opacity: level(1, 'live'), offset: holdMs / total });
    frames.push({ opacity: level(1, mood), offset: 1 });
    lightsAnimation = lightsNode.animate(frames, { duration: total, fill: 'forwards', easing: 'linear' });
  }

  function clearTransients() {
    for (const node of root.querySelectorAll('.arena-reaction-wave, .arena-reaction-ring, .arena-reaction-rays, .arena-reaction-spark')) node.remove();
    for (const animation of swelling) animation.cancel();
    swelling = [];
  }

  function transient(className, at, frames, options, vars = {}) {
    const node = document.createElement('i');
    node.className = className;
    node.style.left = `${at.x}px`;
    node.style.top = `${at.y}px`;
    for (const [key, value] of Object.entries(vars)) node.style.setProperty(key, value);
    root.append(node);
    const done = () => node.remove();
    node.animate(frames, { fill: 'forwards', ...options }).finished.then(done, done);
  }

  // 窓の座標の点（盤の上の着弾）→ 器の中の点。
  const local = (point) => ({ x: point.x - box.left, y: point.y - box.top });

  // どよめき: 客席の灯が着弾の場所から外へ波のように跳ね、篝火の焔がふくらみ、輪が広がり、火の粉が客席から上がる。前のどよめきが
  // まだ跳ねているうちに次が来たら（見返しの高速）、灯の波だけを掛け直し、輪と火の粉は足さない。
  function swell(point, strength) {
    if (!shown) return;
    const origin = local(point);
    const overlapping = swelling.some((animation) => animation.playState === 'running');
    for (const animation of swelling) animation.cancel();
    swelling = [];
    const far = Math.hypot(window.innerWidth, window.innerHeight);
    for (const light of lights) {
      const delay = (Math.hypot(light.at.x - origin.x, light.at.y - origin.y) / far) * 520;
      swelling.push(light.node.animate([
        { transform: 'translateY(0) scale(1)', filter: 'brightness(1)' },
        { transform: `translateY(${-5 - 7 * strength}px) scale(${1.6 + strength})`, filter: 'brightness(2.2)', opacity: 1, offset: 0.3 },
        { transform: 'translateY(0) scale(1)', filter: 'brightness(1)' }
      ], { duration: 900 + 500 * strength, delay, easing: 'ease-out' }));
    }
    for (const flare of flares) {
      swelling.push(flare.node.animate([{ opacity: 0, transform: 'scale(0.6)' }, { opacity: 0.5 + 0.4 * strength, transform: 'scale(1.15)', offset: 0.25 }, { opacity: 0, transform: 'scale(1)' }], { duration: 1100, easing: 'ease-out' }));
    }
    if (overlapping || !lights.length) return;
    transient('arena-reaction-wave', origin, [{ opacity: 0.85, transform: 'scale(0.02)' }, { opacity: 0, transform: `scale(${0.4 + 0.3 * strength})` }], { duration: 900, easing: 'ease-out' });
    const random = seeded(Math.round(performance.now()));
    const count = Math.round(14 + 22 * strength);
    for (let i = 0; i < count; i += 1) {
      const from = lights[Math.floor(random() * lights.length)].at;
      const drift = (random() - 0.5) * 60;
      transient('arena-reaction-spark', from, [
        { opacity: 0, transform: 'translate(0, 0)' },
        { opacity: 0.95, transform: `translate(${drift * 0.3}px, ${-30 - random() * 30}px)`, offset: 0.25 },
        { opacity: 0, transform: `translate(${drift}px, ${-110 - random() * 90}px)` }
      ], { duration: 1300 + random() * 700, delay: random() * 260, easing: 'ease-out' }, { '--s': `${(2 + random() * 2).toFixed(1)}px`, '--c': LIGHT_COLORS[Math.floor(random() * LIGHT_COLORS.length)] });
    }
  }

  return {
    // 試合の面が出る時: 灯を置き（窓の大きさが同じなら置き直さない）、場の様子と熱を渡された所から始める。
    show({ mood: startMood, heat: startHeat }) {
      if (!MOODS.includes(startMood)) throw new Error(`arena reaction: unknown mood ${startMood}`);
      root.hidden = false;
      shown = true;
      build();
      clearTransients();
      window.clearTimeout(endedTimer);
      mood = startMood;
      root.dataset.mood = mood;
      heat = startHeat;
      heatAt = performance.now();
      relevel();
    },
    // 試合の面を離れる時: 器ごと描かれなくなり、置いた動きも残さない。
    hide() {
      if (!shown) return;
      shown = false;
      window.clearTimeout(endedTimer);
      clearTransients();
      lightsAnimation?.cancel();
      lightsAnimation = null;
      root.hidden = true;
    },
    // 窓の大きさが変わった時（見えている間だけ）: 灯を置き直す。
    refit() {
      if (!shown) return;
      build();
    },
    // 当たり: 重さの分だけ熱が上がり、灯が明るむ。
    hit(ratio) {
      if (!shown) return;
      heat = Math.min(1, heatNow() + ratio * ARENA_REACTION.heatPerHit);
      heatAt = performance.now();
      relevel();
    },
    swell,
    // 場の様子（live / hush / rise）。静まりの闇は盤の中ほどを残して沈む。
    setMood(next, boardCenter) {
      if (!MOODS.includes(next)) throw new Error(`arena reaction: unknown mood ${next}`);
      if (!shown || mood === next) return;
      mood = next;
      const centre = local(boardCenter);
      hush.style.setProperty('--arena-reaction-bx', `${centre.x}px`);
      hush.style.setProperty('--arena-reaction-by', `${centre.y}px`);
      root.dataset.mood = mood;
      relevel(900);
    },
    // 決着: 一撃の場所から光条と輪が弾け、客席の灯が総立ちになる。勝ちは金の火の粉が降り、優勝は長く降る。負けは弾けた後に沈む。
    // still なら弾けを出さず、決着の後の濃さだけにする（畳まれた決着）。
    burst(point, { won, champion, still = false }) {
      if (!shown) return;
      const ended = won ? 'won' : 'lost';
      heat = 1;
      heatAt = performance.now();
      mood = ended;
      window.clearTimeout(endedTimer);
      if (still) {
        root.dataset.mood = ended;
        relevelEnded(0);
        return;
      }
      endedTimer = window.setTimeout(() => { root.dataset.mood = ended; }, ENDED_MOOD_AFTER_MS);
      const origin = local(point);
      const color = won ? 'rgb(255 226 160 / 0.75)' : 'rgb(255 150 140 / 0.6)';
      transient('arena-reaction-rays', origin, [{ opacity: 0, transform: 'scale(0.2) rotate(0deg)' }, { opacity: 0.95, transform: 'scale(0.8) rotate(5deg)', offset: 0.14 }, { opacity: 0.4, transform: 'scale(1) rotate(9deg)', offset: 0.6 }, { opacity: 0, transform: 'scale(1.08) rotate(12deg)' }], { duration: won ? 2100 : 1200, easing: 'ease-out' }, { '--arena-reaction-burst': color });
      for (const [delay, size] of [[0, 0.6], [140, 0.95]]) {
        transient('arena-reaction-ring', origin, [{ opacity: 1, transform: 'scale(0.02)' }, { opacity: 0, transform: `scale(${size})` }], { duration: 1100, delay, easing: 'ease-out' }, { '--arena-reaction-burst': color });
      }
      relevelEnded(ENDED_MOOD_AFTER_MS);
      swell(point, 1);
      if (!won) return;
      const random = seeded(Math.round(performance.now()) + 7);
      const count = champion ? 150 : 70;
      const span = champion ? 5200 : 2600;
      const reach = box.reachX;
      for (let i = 0; i < count; i += 1) {
        const from = { x: random() * reach, y: -10 - random() * 60 };
        const fall = box.reachY * (0.5 + random() * 0.5);
        const sway = Math.min(60, from.x, reach - from.x);
        transient('arena-reaction-spark', from, [
          { opacity: 0, transform: 'translate(0, 0)' },
          { opacity: 1, transform: `translate(${(random() - 0.5) * 30}px, ${fall * 0.2}px)`, offset: 0.15 },
          { opacity: 0, transform: `translate(${(random() - 0.5) * 2 * sway}px, ${fall}px)` }
        ], { duration: 1800 + random() * 1400, delay: 120 + random() * span, easing: 'ease-in' }, { '--s': `${(2.4 + random() * 2.6).toFixed(1)}px`, '--c': random() < 0.7 ? '#ffe2a0' : '#fff6dc' });
      }
    }
  };
}

// ── 場の音 ──
// 奏楽堂の単音（/canonical/concert_hall/<楽器>/<midi>.ogg・三半音おきの音源から一番近いものの速さを変えて鳴らす）と、雑音を人の
// 声の帯に濾した客席のざわめきだけで組む。output() は曲と同じ出口（{ context, destination }。音が出せない間は null）で、曲の
// on/off と音量に従う。静まりでは曲そのものを沈める（veilTracks / liftTrackVeil）。

const SAMPLE_STEP = 3;
const SAMPLE_BASE = 36;
const nearestSample = (midi) => SAMPLE_BASE + SAMPLE_STEP * Math.round((midi - SAMPLE_BASE) / SAMPLE_STEP);
const sampleUrl = (instrument, midi) => `/canonical/concert_hall/${instrument}/${nearestSample(midi)}.ogg`;
const SOUND_BUS_GAIN = 0.55;
const CROWD_SECONDS = 10;
const HUSH_VEIL = Object.freeze({ gain: 0.29, cutoffHz: 520, seconds: 1.1 });
const HUSH_LIFT_SECONDS = 1.2;

const tones = (instrument, midis, at, shape, step = 0) => midis.map((midi, index) => ({ instrument, midi, at: at + index * step, ...shape }));
// 音ごとの組み: seconds（鳴っている長さ）・crowd（[秒, 大きさ] の折れ線と、声の帯の高い方の山）・tones（単音）。
const SOUNDS = Object.freeze({
  // 始まり: 低い弦が開き、低いピアノが一つ鳴って、客席のざわめきが立つ。
  start: {
    seconds: 4,
    crowd: { points: [[1.2, 0.5], [2.6, 0.32], [4, 0]], high: 1500 },
    tones: [...tones('piano', [36], 0.9, { gain: 0.8, attack: 0.01, hold: 0.5, release: 1.6 }), ...tones('strings', [36, 43, 50], 0.1, { gain: 0.34, attack: 0.9, hold: 0.6, release: 1.8 })]
  },
  // 大技のどよめき: ざわめきが一息でふくらんで引く。
  swell: {
    seconds: 3,
    crowd: { points: [[0.05, 0.16], [0.4, 0.95], [1.1, 0.55], [3, 0]], high: 1500 },
    tones: tones('strings', [48], 0.05, { gain: 0.22, attack: 0.3, hold: 0.3, release: 1.2 })
  },
  // 静まり（追い詰められた）: 曲が遠のき（veil）、低いピアノが脈のように三つ。
  hush: {
    seconds: 4,
    crowd: null,
    tones: tones('piano', [36, 36, 36], 1.2, { gain: 0.5, attack: 0.01, hold: 0.1, release: 0.9 }, 1.2)
  },
  // 高まり（相手を追い詰めた）: 弦が重なって上がり、ざわめきが寄ってくる。
  rise: {
    seconds: 5,
    crowd: { points: [[0.2, 0.2], [3.8, 0.7], [5, 0]], high: 1500 },
    tones: [[48, 0.2], [55, 1.1], [62, 2], [67, 2.9]].map(([midi, at]) => ({ instrument: 'strings', midi, at, gain: 0.3, attack: 0.9, hold: 3.2 - at * 0.6, release: 1 }))
  },
  // 決着（勝ち）: 低い一打・弦の和音・ハープが駆け上がり・チェレスタがきらめき・客席が沸く。
  'finish-won': {
    seconds: 6,
    crowd: { points: [[0.05, 0.2], [0.35, 1], [2.4, 0.8], [6, 0]], high: 1800 },
    tones: [
      ...tones('piano', [36], 0, { gain: 0.9, attack: 0.01, hold: 0.4, release: 1.8 }),
      ...tones('strings', [48, 55, 60, 64], 0.02, { gain: 0.3, attack: 0.12, hold: 1.8, release: 1.6 }),
      ...tones('harp', [60, 64, 67, 72, 76, 79, 84], 0.1, { gain: 0.5, attack: 0.01, hold: 0.3, release: 1.4 }, 0.07),
      ...tones('celesta', [84, 88, 91, 96, 91, 96], 0.7, { gain: 0.4, attack: 0.01, hold: 0.2, release: 1.2 }, 0.16)
    ]
  },
  // 決着（負け）: 低い一打と短調の弦。客席は一度沸いて、すぐ引く。
  'finish-lost': {
    seconds: 5,
    crowd: { points: [[0.05, 0.2], [0.35, 0.7], [1.6, 0.2], [5, 0]], high: 1500 },
    tones: [...tones('piano', [36], 0, { gain: 0.9, attack: 0.01, hold: 0.4, release: 2 }), ...tones('strings', [45, 52, 57, 60], 0.05, { gain: 0.28, attack: 0.3, hold: 1.6, release: 2.2 })]
  },
  // 優勝の決着: 勝ちの決着に、もう二度の駆け上がりと長い歓声。
  'finish-champion': {
    seconds: 9,
    crowd: { points: [[0.05, 0.2], [0.35, 1], [5.5, 0.9], [9, 0]], high: 1900 },
    tones: [
      ...tones('piano', [36], 0, { gain: 0.9, attack: 0.01, hold: 0.4, release: 1.8 }),
      ...[[0.02, [48, 55, 60, 64]], [2.2, [53, 60, 65, 69]], [4.2, [55, 62, 67, 72]]].flatMap(([at, chord]) => tones('strings', chord, at, { gain: 0.3, attack: 0.15, hold: 1.9, release: 1.6 })),
      ...[[0.1, 0], [2.3, 5], [4.3, 7]].flatMap(([at, lift]) => tones('harp', [60, 64, 67, 72, 76, 79, 84].map((midi) => midi + lift), at, { gain: 0.5, attack: 0.01, hold: 0.3, release: 1.4 }, 0.07)),
      ...tones('celesta', [84, 88, 91, 96, 91, 96, 93, 96, 91, 96], 0.7, { gain: 0.4, attack: 0.01, hold: 0.2, release: 1.2 }, 0.45)
    ]
  }
});
export const ARENA_REACTION_SOUNDS = Object.freeze(Object.keys(SOUNDS));

export function createArenaReactionSound({ output, veilTracks, liftTrackVeil }) {
  const buffers = new Map();   // 音源の url → decode 済みの音（Promise）。一度だけ読む。
  const busyUntil = new Map(); // 音の名 → 鳴り終わる時刻（context の秒）。鳴っている間、同じ音は重ねない。
  let crowdBuffer = null;
  let bus = null;
  let busContext = null;
  let hushed = false;

  function load(context, url) {
    if (!buffers.has(url)) {
      buffers.set(url, fetch(url).then((response) => {
        if (!response.ok) throw new Error(`arena sound: ${url} answered ${response.status}`);
        return response.arrayBuffer();
      }).then((encoded) => context.decodeAudioData(encoded)).catch((error) => {
        buffers.delete(url);
        throw error;
      }));
    }
    return buffers.get(url);
  }

  function busFor({ context, destination }) {
    if (busContext !== context) {
      bus = context.createGain();
      bus.gain.value = SOUND_BUS_GAIN;
      bus.connect(destination);
      busContext = context;
      crowdBuffer = null;
    }
    return bus;
  }

  // 客席のざわめきの素: 低く寄せた雑音（一度だけ作り、どの音もこれを濾して使う）。
  function crowdNoise(context) {
    if (crowdBuffer) return crowdBuffer;
    const length = Math.ceil(CROWD_SECONDS * context.sampleRate);
    crowdBuffer = context.createBuffer(2, length, context.sampleRate);
    const random = seeded(LIGHT_SEED);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = crowdBuffer.getChannelData(channel);
      let brown = 0;
      for (let i = 0; i < length; i += 1) {
        const white = random() * 2 - 1;
        brown = (brown + 0.04 * white) / 1.04;
        data[i] = brown * 6 + white * 0.12;
      }
    }
    return crowdBuffer;
  }

  function playCrowd(context, out, at, seconds, { points, high }) {
    const source = context.createBufferSource();
    source.buffer = crowdNoise(context);
    const mix = context.createGain();
    mix.gain.setValueAtTime(0, at);
    for (const [t, value] of points) mix.gain.linearRampToValueAtTime(value, at + t);
    const nodes = [source, mix];
    for (const [frequency, q, weight, wobble] of [[520, 1.1, 1, 0.23], [high, 1.6, 0.55, 0.37]]) {
      const band = context.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = frequency;
      band.Q.value = q;
      const lfo = context.createOscillator();
      lfo.frequency.value = wobble;
      const depth = context.createGain();
      depth.gain.value = frequency * 0.22;
      lfo.connect(depth).connect(band.frequency);
      lfo.start(at);
      lfo.stop(at + seconds);
      const g = context.createGain();
      g.gain.value = weight;
      source.connect(band).connect(g).connect(mix);
      nodes.push(band, lfo, depth, g);
    }
    mix.connect(out);
    source.onended = () => { for (const node of nodes) node.disconnect(); };
    source.start(at, 0, seconds);
  }

  function playTone(context, out, buffer, at, { midi, gain, attack, hold, release }) {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = 2 ** ((midi - nearestSample(midi)) / 12);
    const g = context.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + attack);
    g.gain.setValueAtTime(gain, at + attack + hold);
    g.gain.linearRampToValueAtTime(0, at + attack + hold + release);
    source.connect(g).connect(out);
    source.onended = () => { source.disconnect(); g.disconnect(); };
    source.start(at);
    source.stop(at + attack + hold + release + 0.05);
  }

  function play(name) {
    const sound = SOUNDS[name];
    if (!sound) throw new Error(`arena sound: unknown sound ${name}`);
    const target = output();
    if (!target) return;
    const { context } = target;
    if ((busyUntil.get(name) ?? 0) > context.currentTime) return;
    busyUntil.set(name, context.currentTime + sound.seconds);
    Promise.all(sound.tones.map((tone) => load(context, sampleUrl(tone.instrument, tone.midi)))).then((loaded) => {
      const out = busFor(target);
      const at = context.currentTime + 0.02;
      if (sound.crowd) playCrowd(context, out, at, sound.seconds, sound.crowd);
      sound.tones.forEach((tone, index) => playTone(context, out, loaded[index], at + tone.at, tone));
    }).catch((error) => console.error(`arena sound: failed to play ${name}`, error));
  }

  return {
    play,
    // 試合に入る時に、その試合で鳴るかもしれない音源を先に読んでおく（音が出せない間は読まない）。
    prime() {
      const target = output();
      if (!target) return;
      for (const sound of Object.values(SOUNDS)) {
        for (const tone of sound.tones) load(target.context, sampleUrl(tone.instrument, tone.midi)).catch((error) => console.error('arena sound: failed to load a sample', error));
      }
    },
    // 静まり: 曲を沈め、脈を打つ。解ければ曲が戻る。
    setHush(on) {
      if (hushed === on) return;
      hushed = on;
      if (on) {
        veilTracks(HUSH_VEIL);
        play('hush');
      } else {
        liftTrackVeil(HUSH_LIFT_SECONDS);
      }
    }
  };
}
