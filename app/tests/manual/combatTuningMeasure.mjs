// 回復と回避の調整の形を、闘技会とダンジョンの同じ測りに並べる手回しの道具（*.test.mjs ではないので npm test は拾わない）:
//
//   node app/tests/manual/combatTuningMeasure.mjs --repo-root <絶対パス> --unit <絶対パス> --out <絶対パス> --forms <形,...>
//   node app/tests/manual/combatTuningMeasure.mjs --compare --out <絶対パス> --forms <形,...>
//
// どの引数も必須で既定値は無い。--forms は下の FORMS の名（current・D・rec・strong）を並べ、一つずつ子 process で順に回す（並列にしない）。
// 回し終えると --compare と同じ表を出す。--limit <N> を足すと、各組・各型の最初の N 件だけを回す（所要の当たり）。
//   --repo-root  測る作品の木。app/src・content・data/definitions・data/seeds を読むだけで、書かない。
//   --unit       二十週目の主人公とバディーの入場の写し（lead root の slot_002 から抜いた slot002-player-unit.json）。
//   --out        <形>/ ごとに matches.tsv・swing.tsv・summary.json・dungeon-runs.tsv・dungeon-summary.json を書く。
//
// 形の差し方: 作品の file は書き換えない。子 process に module の load hook を登録し、--repo-root/app/src の module の source を、
// 読み込む時にメモリの上だけで置き換える（置き換える前の文字列がちょうど1か所にあることを確かめ、無ければ止まる）。置き換えが全部
// 当たったことは、読み込みの後に hook から受け取った一覧で確かめる。current は値を置き換えず、--repo-root の作品の決まりのまま回す。
// どの形でも dungeonEngine.mjs の末尾に、ダンジョンの手番の関数を保存を通さずに呼ぶための export を1行足す（振る舞いは変えない）。
// 大会は作らず、保存・runtime_state・storage には触れない。
//
// 闘技会の組（前の調べ arena-round-cap-why-rate と同じ組・seed。matches.tsv の行は前の調べの道具と同じ形）:
//   students1v1 学院生 172 人の総当たり 14,706 試合 / students2v2 学院生の二人組 2,000 試合 / buddy1v1 バディー対学院生 1,026 試合 /
//   protagonist1v1・protagonist2v2 二十週目の主人公（筋書きの手）の 1,026・2,000 試合。
// 揺らぎの組（swing.tsv）: 同じ顔合わせを SWING_SEEDS 個の seed で回す（左右は seed ごとに入れ替える）。顔合わせは
//   学院生 1 対 1 が SWING_PAIRS 組、2 対 2 が SWING_TEAMS 組、バディー・主人公 1 対 1 が対戦相手 171 人、主人公 2 対 2 が SWING_TEAMS 組。
// ダンジョン（前の調べ arena-round-cap-tuning-candidates と同じ seed・同じ筋書きの手）: 序盤（新しい遊びの値・装備なし、
//   バディーは作者の値）300 本と、二十週目（--unit の主人公とバディー）100 本。筋書きの手は dungeon の節の頭に書く。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MessageChannel, receiveMessageOnPort } from 'node:worker_threads';

// ----- 形（値はここだけ。CURRENT は今の作品の値で、形の値が CURRENT と違う所だけを置き換える） -----
// 今の作品（揺らぎ中）: 回復 (光＋水)/5、回避 9 ＋ 敏捷×0.28、魔法も受け手の回避 % で外れる、回復を選ぶ線は体力の三分の一。
const CURRENT = { heal_divisor: 5, evasion_base: 9, evasion_per_agility: 0.28, ai_heal_line_divisor: 3 };
const FORMS = {
  current: { ...CURRENT },
  // 案 D: 回復 (光＋水)/4、回避 6 ＋ 敏捷×0.22、回復を選ぶ線は体力の半分。
  D: { ...CURRENT, heal_divisor: 4, evasion_base: 6, evasion_per_agility: 0.22, ai_heal_line_divisor: 2 },
  // 推奨: 案 D ＋ 回復を選ぶ線を体力の三分の一へ。
  rec: { ...CURRENT, heal_divisor: 4, evasion_base: 6, evasion_per_agility: 0.22 },
  // 揺らぎ強: 回復 (光＋水)/6、回避 12 ＋ 敏捷×0.36。
  strong: { ...CURRENT, heal_divisor: 6, evasion_base: 12, evasion_per_agility: 0.36 }
};

const evasionExpr = (base, per) => `${base} + Math.round(agility * ${per})`;
const FEEL_EXPORT = '\nexport const __feel = { loadFloor, playerMove, playerCast, playerHealingSpell, playerHealingSpellState, playerSpellManaCost, playerUseItem, runCompanionTurn, runEnemyTurns, recoverTurnVitals, tickPlayerEvasionBuff, revealAround, buildCompanionRunState, onStairs, nearestVisibleEnemy, livingEnemyAt };\n';

function formEdits(form) {
  const edits = { 'dungeon/dungeonEngine.mjs': [{ append: FEEL_EXPORT }] };
  const add = (rel, old, next) => (edits[rel] ??= []).push({ old, new: next });
  if (form.heal_divisor !== CURRENT.heal_divisor) {
    add('dungeon/dungeonStats.mjs', `return Math.max(8, Math.round((lightPower + waterPower) / ${CURRENT.heal_divisor}));`,
      `return Math.max(8, Math.round((lightPower + waterPower) / ${form.heal_divisor}));`);
  }
  if (form.evasion_base !== CURRENT.evasion_base || form.evasion_per_agility !== CURRENT.evasion_per_agility) {
    add('dungeon/dungeonStats.mjs', `evasion: ${evasionExpr(CURRENT.evasion_base, CURRENT.evasion_per_agility)},`,
      `evasion: ${evasionExpr(form.evasion_base, form.evasion_per_agility)},`);
  }
  if (form.ai_heal_line_divisor !== CURRENT.ai_heal_line_divisor) {
    add('dungeon/combatAi.mjs', `healingSpell.can_use && actor.hp <= Math.floor(actor.max_hp / ${CURRENT.ai_heal_line_divisor})`,
      `healingSpell.can_use && actor.hp <= Math.floor(actor.max_hp / ${form.ai_heal_line_divisor})`);
  }
  return edits;
}

// load hook（子 process の hook thread で動く）。置き換えた module の URL を port で返す。
const HOOKS = `
let edits; let port;
export async function initialize(data) { edits = new Map(Object.entries(data.edits)); port = data.port; }
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const list = edits.get(url);
  if (!list) return result;
  let source = String(result.source);
  for (const e of list) {
    if (e.append !== undefined) { source += e.append; continue; }
    const count = source.split(e.old).length - 1;
    if (count !== 1) throw new Error(url + ': anchor count ' + count + ': ' + JSON.stringify(e.old));
    source = source.replace(e.old, () => e.new);
  }
  port.postMessage(url);
  return { ...result, source, shortCircuit: true };
}
`;

// ----- 引数 -----
const args = process.argv.slice(2);
function arg(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} is required`);
  return args[index + 1];
}
function optionalArg(name) {
  return args.includes(name) ? arg(name) : null;
}
const outRoot = path.resolve(arg('--out'));
const formNames = arg('--forms').split(',');
for (const name of formNames) if (!FORMS[name]) throw new Error(`unknown form: ${name} (known: ${Object.keys(FORMS).join(',')})`);
const limitArg = optionalArg('--limit');
const limit = limitArg === null ? Infinity : Number(limitArg);
if (!(limit > 0)) throw new Error(`--limit must be positive: ${limitArg}`);

if (args.includes('--compare')) {
  compare(outRoot, formNames);
} else if (args.includes('--child')) {
  if (formNames.length !== 1) throw new Error('--child runs exactly one form');
  await runForm(formNames[0]);
} else {
  const repoRoot = path.resolve(arg('--repo-root'));
  const unitFile = path.resolve(arg('--unit'));
  // 子 process は pane の TEAM_* を継がない（作品の module が live queue を見ないように）。
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TEAM_')));
  for (const name of formNames) {
    const started = Date.now();
    const childArgs = [fileURLToPath(import.meta.url), '--child', '--repo-root', repoRoot, '--unit', unitFile, '--out', outRoot, '--forms', name];
    if (limitArg !== null) childArgs.push('--limit', limitArg);
    const child = spawnSync(process.execPath, childArgs, { stdio: 'inherit', env });
    if (child.status !== 0) throw new Error(`form ${name} failed: status ${child.status} signal ${child.signal}`);
    console.log(`FORM ${name} seconds=${((Date.now() - started) / 1000).toFixed(1)}`);
  }
  compare(outRoot, formNames);
}

// ===== 一つの形を回す（子 process） =====
async function runForm(formName) {
  const repoRoot = path.resolve(arg('--repo-root'));
  const unitFile = path.resolve(arg('--unit'));
  const outDir = path.join(outRoot, formName);
  const srcUrl = (rel) => pathToFileURL(path.join(repoRoot, 'app/src', rel)).href;
  const edits = Object.fromEntries(Object.entries(formEdits(FORMS[formName])).map(([rel, list]) => [srcUrl(rel), list]));
  const { port1, port2 } = new MessageChannel();
  register(`data:text/javascript,${encodeURIComponent(HOOKS)}`, { data: { edits, port: port2 }, transferList: [port2] });

  const imp = (rel) => import(srcUrl(rel));
  const arena = await imp('arena/arenaEngine.mjs');
  const { createRng, deriveSeed } = await imp('dungeon/dungeonRng.mjs');
  const stats = await imp('dungeon/dungeonStats.mjs');
  const { applyEquipmentToCombatStats } = await imp('equipment.mjs');
  const resolution = await imp('dungeon/combatResolution.mjs');
  const geometry = await imp('dungeon/combatGeometry.mjs');
  const { normalizeParameters, magicParameterDefinitions } = await imp('parameters.mjs');
  const { MP_RESERVE_INITIAL_PERCENT } = await imp('mpReserve.mjs');
  const engine = await imp('dungeon/dungeonEngine.mjs');
  const { emptyPendingGains } = await imp('dungeon/dungeonRewards.mjs');
  const { emptyMaterialBuffer } = await imp('dungeon/dungeonMaterials.mjs');
  const { emptyEquipmentBuffer } = await imp('dungeon/dungeonEquipmentDrops.mjs');
  const applied = new Set();
  for (let message = receiveMessageOnPort(port1); message; message = receiveMessageOnPort(port1)) applied.add(message.message);
  port1.close();
  const missing = Object.keys(edits).filter((url) => !applied.has(url));
  if (missing.length) throw new Error(`form ${formName}: edits not applied to ${missing.join(', ')}`);
  if (!engine.__feel) throw new Error('dungeonEngine.mjs has no __feel export');

  const ctx = {
    repoRoot, arena, createRng, deriveSeed, stats, applyEquipmentToCombatStats, resolution, geometry, normalizeParameters,
    magicParameterDefinitions, MP_RESERVE_INITIAL_PERCENT, engine, emptyPendingGains, emptyMaterialBuffer, emptyEquipmentBuffer
  };
  const unit = JSON.parse(readFileSync(unitFile, 'utf8'));
  mkdirSync(outDir, { recursive: true });
  console.log(`FORM ${formName} ${JSON.stringify(FORMS[formName])} edited=${Object.keys(edits).map((u) => path.basename(fileURLToPath(u))).join(',')}`);
  await runArena(ctx, unit, outDir, formName);
  runDungeon(ctx, unit, outDir, formName);
}

// ===== 闘技会 =====
async function runArena(ctx, unit, outDir, formName) {
  const { repoRoot, arena, createRng, deriveSeed, stats, applyEquipmentToCombatStats, resolution, geometry, normalizeParameters, magicParameterDefinitions, MP_RESERVE_INITIAL_PERCENT } = ctx;
  const { ARENA_MAX_ROUNDS, runArenaMatchAuto, createArenaMatch, arenaStep, arenaMatchView } = arena;
  const { hasLineOfSight, manhattan } = geometry;

  // 前の調べと同じ組と seed（変えると前の数と並べられない）。
  const SEED_BASE = 0x7ca9_0001;
  const GROUP_SALT = { students1v1: 1, students2v2: 2, buddy1v1: 3, protagonist1v1: 4, protagonist2v2: 5 };
  const STUDENTS_2V2_MATCHES = 2000;
  const BUDDY_SEEDS_PER_OPPONENT = 6;
  const PROTAGONIST_SEEDS_PER_OPPONENT = 6;
  const PROTAGONIST_2V2_MATCHES = 2000;
  // 揺らぎの組。
  const SWING_SEED_BASE = 0x7ca9_0003;
  const SWING_SEEDS = 12;
  const SWING_PAIRS = 800;
  const SWING_TEAMS = 200;
  const ROSTER_SIZE = 172; // content/characters/character_001..172。下で profile の id と照らす。

  const matchSeed = (group, index) => deriveSeed(deriveSeed(SEED_BASE, GROUP_SALT[group]), index + 1);
  const swingSeed = (group, matchup, k) => deriveSeed(deriveSeed(deriveSeed(SWING_SEED_BASE, GROUP_SALT[group]), matchup + 1), k + 1);

  function charDescriptor(index) {
    const id = `character_${String(index).padStart(3, '0')}`;
    const profile = JSON.parse(readFileSync(path.join(repoRoot, 'content/characters', id, 'profile.json'), 'utf8'));
    if (profile.character_id && profile.character_id !== id) throw new Error(`profile id mismatch: ${id}`);
    return { actor_id: id, name: profile.display_name, kind: 'character', parameters: normalizeParameters(profile.parameters), equipment: null, mp_reserve_percent: MP_RESERVE_INITIAL_PERCENT, controller: 'ai' };
  }
  const roster = Array.from({ length: ROSTER_SIZE }, (_, i) => charDescriptor(i + 1));
  const protagonistSnap = unit.actors.find((a) => a.kind === 'protagonist');
  const buddySnap = unit.actors.find((a) => a.kind !== 'protagonist');
  if (!protagonistSnap || !buddySnap) throw new Error('unit file must hold the protagonist and the buddy');
  const snapDescriptor = (a, controller) => ({ actor_id: a.actor_id, name: a.name, kind: a.kind, parameters: a.parameters, equipment: a.equipment, mp_reserve_percent: a.mp_reserve_percent, controller });
  const buddy = snapDescriptor(buddySnap, 'ai');
  const protagonist = snapDescriptor(protagonistSnap, 'player');
  const opponentsOfBuddy = roster.filter((d) => d.actor_id !== buddy.actor_id);

  const pickDistinct = (rng, pool, n) => rng.shuffle(pool).slice(0, n);
  const take = (list) => list.slice(0, Math.min(list.length, limit));
  function buildGroup(group) {
    const list = [];
    if (group === 'students1v1') {
      for (let i = 0; i < roster.length; i += 1) for (let j = i + 1; j < roster.length; j += 1) list.push({ teamA: [roster[i]], teamB: [roster[j]] });
    } else if (group === 'students2v2') {
      const rng = createRng(deriveSeed(SEED_BASE, 20));
      for (let k = 0; k < STUDENTS_2V2_MATCHES; k += 1) {
        const [a1, a2, b1, b2] = pickDistinct(rng, roster, 4);
        list.push({ teamA: [a1, a2], teamB: [b1, b2] });
      }
    } else if (group === 'buddy1v1') {
      for (const opp of opponentsOfBuddy) for (let k = 0; k < BUDDY_SEEDS_PER_OPPONENT; k += 1) list.push(k % 2 === 0 ? { teamA: [buddy], teamB: [opp] } : { teamA: [opp], teamB: [buddy] });
    } else if (group === 'protagonist1v1') {
      for (const opp of opponentsOfBuddy) for (let k = 0; k < PROTAGONIST_SEEDS_PER_OPPONENT; k += 1) list.push(k % 2 === 0 ? { teamA: [protagonist], teamB: [opp] } : { teamA: [opp], teamB: [protagonist] });
    } else if (group === 'protagonist2v2') {
      const rng = createRng(deriveSeed(SEED_BASE, 50));
      for (let k = 0; k < PROTAGONIST_2V2_MATCHES; k += 1) {
        const [b1, b2] = pickDistinct(rng, opponentsOfBuddy, 2);
        list.push(k % 2 === 0 ? { teamA: [protagonist, buddy], teamB: [b1, b2] } : { teamA: [b1, b2], teamB: [protagonist, buddy] });
      }
    } else throw new Error(`unknown group: ${group}`);
    return take(list).map((m, index) => ({ ...m, index, seed: matchSeed(group, index) }));
  }
  // 揺らぎの顔合わせ: side1 と side2 を固定し、seed k ごとに左右を入れ替える。
  function buildSwing(group) {
    const matchups = [];
    if (group === 'students1v1') {
      const pairs = [];
      for (let i = 0; i < roster.length; i += 1) for (let j = i + 1; j < roster.length; j += 1) pairs.push([[roster[i]], [roster[j]]]);
      matchups.push(...pickDistinct(createRng(deriveSeed(SWING_SEED_BASE, 10)), pairs, SWING_PAIRS));
    } else if (group === 'students2v2') {
      const rng = createRng(deriveSeed(SWING_SEED_BASE, 20));
      for (let k = 0; k < SWING_TEAMS; k += 1) { const [a1, a2, b1, b2] = pickDistinct(rng, roster, 4); matchups.push([[a1, a2], [b1, b2]]); }
    } else if (group === 'buddy1v1') {
      for (const opp of opponentsOfBuddy) matchups.push([[buddy], [opp]]);
    } else if (group === 'protagonist1v1') {
      for (const opp of opponentsOfBuddy) matchups.push([[protagonist], [opp]]);
    } else if (group === 'protagonist2v2') {
      const rng = createRng(deriveSeed(SWING_SEED_BASE, 50));
      for (let k = 0; k < SWING_TEAMS; k += 1) { const [b1, b2] = pickDistinct(rng, opponentsOfBuddy, 2); matchups.push([[protagonist, buddy], [b1, b2]]); }
    } else throw new Error(`unknown group: ${group}`);
    const list = [];
    take(matchups).forEach(([side1, side2], matchup) => {
      for (let k = 0; k < SWING_SEEDS; k += 1) {
        list.push({ matchup, k, side1, side2, seed: swingSeed(group, matchup, k), teamA: k % 2 === 0 ? side1 : side2, teamB: k % 2 === 0 ? side2 : side1 });
      }
    });
    return list;
  }

  // ----- 全員 AI の試合の手番ごとの読み（前の調べの道具と同じ。手番の持ち主が合わなければ止まる） -----
  const charSum = (text) => { let s = 0; for (const c of text) s += c.charCodeAt(0); return s; };
  function combatProfile(d) {
    const parameters = normalizeParameters(d.parameters);
    const s = applyEquipmentToCombatStats(stats.deriveCombatStats(parameters), d.equipment ?? null);
    const element = magicParameterDefinitions.map((x) => ({ key: x.key, v: Number(parameters.magic[x.key].value) })).reduce((b, c) => (c.v > b.v ? c : b)).key;
    return { speed: s.speed, element, archetype: stats.companionAiArchetype(parameters), spellCost: resolution.equippedSpellManaCost(element, parameters, d.equipment ?? null), parameters, equipment: d.equipment ?? null, reserve: d.mp_reserve_percent };
  }
  function roundOrder(seed, round, living, profiles) {
    const tie = (id) => deriveSeed(deriveSeed(seed, round + 1), charSum(id));
    return living.slice().sort((a, b) => profiles.get(b).speed - profiles.get(a).speed || tie(a) - tie(b) || (a < b ? -1 : a > b ? 1 : 0));
  }
  const boardOf = (view) => ({ width: view.width, height: view.height, tiles: view.tiles });
  function analyzeAuto(seed, teamA, teamB, result) {
    const profiles = new Map([...teamA, ...teamB].map((d) => [d.actor_id, combatProfile(d)]));
    const turns = result.turns;
    let prev = structuredClone(turns[0].view.actors);
    let round = 0; let order = []; let pos = 0;
    const rows = [];
    for (let t = 1; t < turns.length; t += 1) {
      const view = turns[t].view;
      if (view.round !== round) {
        if (view.round !== round + 1) throw new Error(`round jump ${round} -> ${view.round}`);
        if (round > 0) for (const a of prev) if (!a.down) { a.hp = Math.min(a.max_hp, a.hp + resolution.TURN_HEALTH_REGEN); a.mp = Math.min(a.max_mp, a.mp + resolution.TURN_MANA_REGEN); }
        round = view.round;
        order = roundOrder(seed, round, prev.filter((a) => !a.down).map((a) => a.actor_id), profiles);
        pos = 0;
      }
      while (pos < order.length && prev.find((a) => a.actor_id === order[pos]).down) pos += 1;
      const actorId = order[pos];
      pos += 1;
      if (!actorId) throw new Error(`no actor for turn ${t}`);
      const before = prev.find((a) => a.actor_id === actorId);
      const after = view.actors.find((a) => a.actor_id === actorId);
      const p = profiles.get(actorId);
      for (const other of view.actors) {
        if (other.actor_id === actorId) continue;
        const o = prev.find((a) => a.actor_id === other.actor_id);
        if (o.x !== other.x || o.y !== other.y || o.mp !== other.mp || other.hp > o.hp) throw new Error(`turn ${t}: a non-acting actor changed (${other.actor_id})`);
      }
      const events = turns[t].events;
      const visible = prev.filter((a) => a.team !== before.team && !a.down).filter((e) => hasLineOfSight(boardOf(view), before, e));
      const aboveReserve = resolution.mpAboveReserve({ mp: before.mp, max_mp: before.max_mp, mp_reserve_percent: p.reserve });
      let kind;
      if (events.some((e) => e.kind === 'cast')) kind = 'cast';
      else if (events.some((e) => e.kind === 'melee')) kind = events.some((e) => e.kind === 'melee' && e.hit) ? 'melee' : 'melee-miss';
      else if (after.mp < before.mp && after.hp > before.hp) kind = 'heal';
      else if (after.x !== before.x || after.y !== before.y) kind = 'move';
      else kind = 'idle';
      const couldCast = before.mp >= p.spellCost && visible.length > 0;
      const attacked = kind === 'cast' || kind === 'melee' || kind === 'melee-miss';
      let held = '';
      if (couldCast && !attacked) held = kind === 'heal' ? 'healed' : (!aboveReserve ? 'reserve' : 'range');
      rows.push({ kind, held });
      prev = structuredClone(view.actors);
    }
    return rows;
  }

  // ----- 主人公の筋書きの手（前の調べと同じ）: 1) 体力半分以下で回復が使えれば回復 2) 見える敵がいて払える魔法があれば
  // 「威力×属性の有利」が一番大きい魔法 3) 隣の敵へ体当たり 4) 一番近い敵へ一歩 5) 待つ。消耗品は使わない。
  const ADV = { light: 'dark', dark: 'light', fire: 'wind', wind: 'earth', earth: 'water', water: 'fire' };
  function policyActions(view) {
    const me = view.actors.find((a) => a.actor_id === view.player_actor_id);
    const enemies = view.actors.filter((a) => a.team !== me.team && !a.down);
    const visible = enemies.filter((e) => hasLineOfSight(boardOf(view), me, e)).sort((a, b) => manhattan(me.x, me.y, a.x, a.y) - manhattan(me.x, me.y, b.x, b.y));
    const actions = [];
    if (view.healing_spell.can_use && me.hp <= Math.floor(me.max_hp / 2)) actions.push({ type: 'heal_spell' });
    if (visible.length) {
      const target = visible[0];
      const castable = view.castable_elements.filter((c) => c.mp_cost <= me.mp).map((c) => ({ ...c, value: c.power * (ADV[c.element] === target.element ? 1.4 : 1) })).sort((a, b) => b.value - a.value);
      if (castable.length) actions.push({ type: 'cast', element: castable[0].element });
    }
    const nearest = enemies.slice().sort((a, b) => manhattan(me.x, me.y, a.x, a.y) - manhattan(me.x, me.y, b.x, b.y))[0];
    if (nearest) {
      const dirs = [['right', 1, 0], ['left', -1, 0], ['down', 0, 1], ['up', 0, -1]]
        .map(([d, dx, dy]) => ({ d, dist: manhattan(me.x + dx, me.y + dy, nearest.x, nearest.y) }))
        .filter((c) => c.dist < manhattan(me.x, me.y, nearest.x, nearest.y)).sort((a, b) => a.dist - b.dist);
      for (const c of dirs) actions.push({ type: 'move', direction: c.d });
    }
    actions.push({ type: 'wait' });
    return actions;
  }
  async function playProtagonist({ seed, teamA, teamB }, tally) {
    const match = createArenaMatch({ seed, teamA, teamB });
    const counts = { heal_spell: 0, cast: 0, move: 0, wait: 0, errors: 0 };
    let view = arenaMatchView(match);
    let steps = 0;
    const step = async (action) => { const res = await arenaStep({ root: repoRoot, match, ...(action ? { action } : {}) }); tallyEvents(res.events ?? [], tally); return res; };
    while (match.status === 'active') {
      if (!view.player_actor_id) { view = (await step(null)).view; continue; }
      const rejected = new Set();
      let acted = false;
      while (!acted && match.status === 'active' && view.player_actor_id) {
        const action = policyActions(view).find((a) => !rejected.has(JSON.stringify(a)));
        if (!action) throw new Error('protagonist policy found no legal action (wait must always act)');
        const res = await step(action);
        view = res.view;
        if (res.view.action_error) { counts.errors += 1; rejected.add(JSON.stringify(action)); continue; }
        counts[action.type] += 1;
        acted = true;
      }
      steps += 1;
      if (steps > ARENA_MAX_ROUNDS * 4) throw new Error('protagonist match did not end');
    }
    return { winner: match.winner, rounds: match.round, actors: match.actors.map((a) => ({ team: a.team, down: a.down || a.hp <= 0 })), counts };
  }

  // 攻撃の当たり外れ: 体当たりは event の hit、魔法は外れると damage 0（当たれば 1 以上）。
  function tallyEvents(events, tally) {
    for (const e of events) {
      if (e.kind === 'melee') { tally.melee += 1; if (!e.hit) tally.melee_miss += 1; }
      if (e.kind === 'cast' && Number.isFinite(e.damage)) { tally.cast += 1; if (e.damage === 0) tally.cast_miss += 1; }
    }
  }
  const capped = (rounds, actors) => rounds >= ARENA_MAX_ROUNDS && ['a', 'b'].every((t) => actors.some((a) => a.team === t && !a.down));
  const ids = (team) => team.map((d) => d.actor_id).join('+');
  async function play(group, m, tally) {
    if (group.startsWith('protagonist')) {
      const r = await playProtagonist(m, tally);
      return { rounds: r.rounds, winner: r.winner, isCap: capped(r.rounds, r.actors), cols: [r.counts.cast, '', r.counts.heal_spell, r.counts.move, r.counts.wait, ''] };
    }
    const result = await runArenaMatchAuto({ seed: m.seed, teamA: m.teamA, teamB: m.teamB });
    for (const turn of result.turns) tallyEvents(turn.events ?? [], tally);
    const isCap = capped(result.rounds, result.turns[result.turns.length - 1].view.actors);
    const k = { cast: 0, melee: 0, 'melee-miss': 0, heal: 0, move: 0, idle: 0 };
    let held = 0;
    for (const r of analyzeAuto(m.seed, m.teamA, m.teamB, result)) { k[r.kind] += 1; if (r.held) held += 1; }
    return { rounds: result.rounds, winner: result.winner, isCap, cols: [k.cast, k.melee + k['melee-miss'], k.heal, k.move, k.idle, held] };
  }

  const quant = (xs, q) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
  const summary = { form: formName, values: FORMS[formName], ARENA_MAX_ROUNDS, SEED_BASE, SWING_SEED_BASE, SWING_SEEDS, groups: {}, swing: {} };
  const tsv = ['group\tindex\tseed\tteam_a\tteam_b\trounds\tcapped\twinner\tturns_cast\tturns_melee\tturns_heal\tturns_move\tturns_idle\tturns_could_cast_held'];
  const swingTsv = ['group\tmatchup\tk\tseed\tside1\tside2\tteam_a\trounds\tcapped\twinner_side'];
  for (const group of Object.keys(GROUP_SALT)) {
    const started = process.hrtime.bigint();
    const tally = { melee: 0, melee_miss: 0, cast: 0, cast_miss: 0 };
    const rounds = [];
    let cap = 0;
    const list = buildGroup(group);
    for (const m of list) {
      const r = await play(group, m, tally);
      rounds.push(r.rounds);
      if (r.isCap) cap += 1;
      tsv.push([group, m.index, m.seed, ids(m.teamA), ids(m.teamB), r.rounds, r.isCap ? 1 : 0, r.winner, ...r.cols].join('\t'));
    }
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    const totalRounds = rounds.reduce((a, b) => a + b, 0);
    summary.groups[group] = {
      matches: list.length, capped: cap, rounds_median: quant(rounds, 0.5), rounds_p90: quant(rounds, 0.9), rounds_max: Math.max(...rounds),
      decided_rounds_median: quant(rounds.filter((x) => x < ARENA_MAX_ROUNDS), 0.5), total_rounds: totalRounds, ...tally, seconds: Number(seconds.toFixed(1))
    };
    console.log(`${formName} GROUP ${group} matches=${list.length} capped=${cap} rounds median=${quant(rounds, 0.5)} p90=${quant(rounds, 0.9)} max=${Math.max(...rounds)} melee_miss=${tally.melee_miss}/${tally.melee} cast_miss=${tally.cast_miss}/${tally.cast} seconds=${seconds.toFixed(1)}`);
  }
  for (const group of Object.keys(GROUP_SALT)) {
    const started = process.hrtime.bigint();
    const tally = { melee: 0, melee_miss: 0, cast: 0, cast_miss: 0 };
    const list = buildSwing(group);
    let cap = 0;
    for (const m of list) {
      const r = await play(group, m, tally);
      if (r.isCap) cap += 1;
      const winnerTeam = r.winner === 'a' ? m.teamA : m.teamB;
      swingTsv.push([group, m.matchup, m.k, m.seed, ids(m.side1), ids(m.side2), m.k % 2 === 0 ? 'side1' : 'side2', r.rounds, r.isCap ? 1 : 0, winnerTeam === m.side1 ? 'side1' : 'side2'].join('\t'));
    }
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    summary.swing[group] = { matches: list.length, capped: cap, ...tally, seconds: Number(seconds.toFixed(1)) };
    console.log(`${formName} SWING ${group} matches=${list.length} capped=${cap} seconds=${seconds.toFixed(1)}`);
  }
  writeFileSync(path.join(outDir, 'matches.tsv'), tsv.join('\n') + '\n');
  writeFileSync(path.join(outDir, 'swing.tsv'), swingTsv.join('\n') + '\n');
  writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
}

// ===== ダンジョン =====
// 作品のダンジョンの手番の関数をメモリの上で呼ぶ。run は prepareDungeonRun と同じ形（保存の読み書きを除く）、一手は dungeonAction と
// 同じ順（主人公の手 → 見え方 → バディー → 敵 → 毎手の戻り → 回避の残り → 手番＋1 → 見え方）。
// 筋書きの手（前の調べと同じ。上から最初に動けたもの）: 1) 体力半分以下で回復が使えれば回復 2) 体力三分の一以下で癒し草があれば使う
// 3) 見える敵がいれば、払える魔法のうち「威力×属性の有利」が一番大きいもの → 払えず魔力の雫があれば使う → 隣なら体当たり → 近づく
// 4) 見える敵がいなければ階段への最短の道 5) 待つ。危ない時（三分の一以下・回復も癒し草も無い）は 3 を飛ばし、近い方の安全な場所
// （入口か階段）へ歩く。安全な場所で敵が見えず、体力半分以下で回復も使えなければ撤退。階段にいれば降りる。
function runDungeon(ctx, unit, outDir, formName) {
  const { repoRoot, engine, createRng, deriveSeed, stats, applyEquipmentToCombatStats, resolution, geometry, normalizeParameters, magicParameterDefinitions, MP_RESERVE_INITIAL_PERCENT, emptyPendingGains, emptyMaterialBuffer, emptyEquipmentBuffer } = ctx;
  const F = engine.__feel;
  const { isWalkable, manhattan } = geometry;
  const SEED_BASE = 0x7ca9_0002;
  const PROFILE_SALT = { early: 1, week20: 2 };
  const RUNS_PER_PROFILE = { early: 300, week20: 100 };
  const TURN_CAP = 6000;

  const protagonistSnap = unit.actors.find((a) => a.kind === 'protagonist');
  const buddySnap = unit.actors.find((a) => a.kind !== 'protagonist');
  const seedParams = JSON.parse(readFileSync(path.join(repoRoot, 'data/seeds/game_data/runtime/player_parameters.json'), 'utf8'));
  const buddyProfile = JSON.parse(readFileSync(path.join(repoRoot, 'content/characters', buddySnap.actor_id, 'profile.json'), 'utf8'));
  const PROFILES = {
    early: {
      hero: { parameters: seedParams, equipment: null },
      companion: { character_id: buddySnap.actor_id, name: buddyProfile.display_name, parameters: buddyProfile.parameters, equipment: null, reserve: MP_RESERVE_INITIAL_PERCENT }
    },
    week20: {
      hero: { parameters: protagonistSnap.parameters, equipment: protagonistSnap.equipment },
      companion: { character_id: buddySnap.actor_id, name: buddySnap.name, parameters: buddySnap.parameters, equipment: buddySnap.equipment, reserve: buddySnap.mp_reserve_percent }
    }
  };

  function buildRun(profile, seed) {
    const parameters = normalizeParameters(profile.hero.parameters);
    const playerStats = applyEquipmentToCombatStats(stats.deriveCombatStats(parameters), profile.hero.equipment);
    const c = profile.companion;
    const maxHp = resolution.combatMaxHp(playerStats.max_hp);
    const run = {
      run_id: `dr_${seed}`, seed, status: 'active', floor: 1, max_floors: engine.MAX_FLOORS, turn: 0,
      parameters, player_stats: playerStats, equipment: profile.hero.equipment,
      player: { x: 0, y: 0, hp: maxHp, max_hp: maxHp, mp: playerStats.max_mp, max_mp: playerStats.max_mp },
      enemies: [], items: [], inventory: [], material_buffer: emptyMaterialBuffer(), equipment_buffer: emptyEquipmentBuffer(),
      revive_used: false, pending_gains: emptyPendingGains(), log: [],
      companion: F.buildCompanionRunState({ character_id: c.character_id, name: c.name, parameters: c.parameters }, c.equipment, c.reserve),
      width: 0, height: 0, tiles: [], entrance: { x: 0, y: 0 }, stairs: { x: 0, y: 0 }, explored: []
    };
    F.loadFloor(run, 1);
    return run;
  }

  const ADV = { light: 'dark', dark: 'light', fire: 'wind', wind: 'earth', earth: 'water', water: 'fire' };
  const DIRS = [['up', 0, -1], ['down', 0, 1], ['left', -1, 0], ['right', 1, 0]];
  function firstStep(run, goal, throughEnemies) {
    const start = `${run.player.x},${run.player.y}`;
    const seen = new Map([[start, null]]);
    const queue = [[run.player.x, run.player.y]];
    while (queue.length) {
      const [x, y] = queue.shift();
      if (x === goal.x && y === goal.y) {
        let key = `${x},${y}`;
        while (seen.get(key) && seen.get(key).from !== start) key = seen.get(key).from;
        return seen.get(key)?.dir ?? null;
      }
      for (const [dir, dx, dy] of DIRS) {
        const nx = x + dx; const ny = y + dy; const key = `${nx},${ny}`;
        if (seen.has(key) || !isWalkable(run, nx, ny)) continue;
        if (!throughEnemies && !(nx === goal.x && ny === goal.y) && F.livingEnemyAt(run, nx, ny)) continue;
        seen.set(key, { from: `${x},${y}`, dir });
        queue.push([nx, ny]);
      }
    }
    return null;
  }
  const holding = (run, kind) => run.inventory.some((entry) => entry.kind === kind && entry.count > 0);
  const inDanger = (run) => run.player.hp <= Math.floor(run.player.max_hp / 3) && !F.playerHealingSpellState(run).can_use && !holding(run, 'heal_herb');
  const onSafeTile = (run) => (run.player.x === run.stairs.x && run.player.y === run.stairs.y) || (run.player.x === run.entrance.x && run.player.y === run.entrance.y);
  const nearerSafeTile = (run) => (manhattan(run.player.x, run.player.y, run.entrance.x, run.entrance.y) < manhattan(run.player.x, run.player.y, run.stairs.x, run.stairs.y) ? run.entrance : run.stairs);
  function policyActions(run) {
    const me = run.player;
    const actions = [];
    if (F.playerHealingSpellState(run).can_use && me.hp <= Math.floor(me.max_hp / 2)) actions.push({ type: 'heal_spell' });
    if (me.hp <= Math.floor(me.max_hp / 3) && holding(run, 'heal_herb')) actions.push({ type: 'use_item', item_kind: 'heal_herb' });
    const target = F.nearestVisibleEnemy(run);
    if (inDanger(run)) {
      const safe = nearerSafeTile(run);
      const step = firstStep(run, safe, false) ?? firstStep(run, safe, true);
      if (step) actions.push({ type: 'move', direction: step });
    } else if (target) {
      const castable = magicParameterDefinitions.map((d) => d.key)
        .map((element) => ({ element, cost: F.playerSpellManaCost(run, element), value: run.player_stats.spell_power[element] * (ADV[element] === target.element ? 1.4 : 1) }))
        .filter((c) => c.cost <= me.mp).sort((a, b) => b.value - a.value);
      if (castable.length) actions.push({ type: 'cast', element: castable[0].element });
      else if (holding(run, 'mana_dew')) actions.push({ type: 'use_item', item_kind: 'mana_dew' });
      const step = manhattan(me.x, me.y, target.x, target.y) === 1
        ? DIRS.find(([, dx, dy]) => me.x + dx === target.x && me.y + dy === target.y)[0]
        : (firstStep(run, target, false) ?? firstStep(run, target, true));
      if (step) actions.push({ type: 'move', direction: step });
    } else {
      const step = firstStep(run, run.stairs, false) ?? firstStep(run, run.stairs, true);
      if (step) actions.push({ type: 'move', direction: step });
    }
    actions.push({ type: 'wait' });
    return actions;
  }
  function applyAction(run, rng, action) {
    if (action.type === 'move') { const [, dx, dy] = DIRS.find(([d]) => d === action.direction); return F.playerMove(run, rng, dx, dy); }
    if (action.type === 'cast') return F.playerCast(run, rng, action.element);
    if (action.type === 'heal_spell') return F.playerHealingSpell(run);
    if (action.type === 'use_item') return F.playerUseItem(run, action.item_kind);
    if (action.type === 'wait') return { acted: true };
    throw new Error(`unknown action ${action.type}`);
  }

  function playRun(profile, seed) {
    const run = buildRun(profile, seed);
    const s = { outcome: null, floor: 1, turns: 0, hero_damage_taken: 0, hero_heals: 0, herbs: 0, dews: 0, enemy_melee: 0, enemy_melee_hit: 0, companion_down: false, kills: 0, floor_turns: [],
      enemy_melee_on_hero: 0, enemy_melee_on_hero_hit: 0, hero_melee: 0, hero_melee_miss: 0, hero_cast: 0, hero_cast_miss: 0 };
    let floorStart = 0;
    const countKills = () => run.enemies.filter((e) => e.hp <= 0).length;
    while (true) {
      if (run.turn >= TURN_CAP) { s.outcome = 'stuck'; break; }
      if (onSafeTile(run) && !F.nearestVisibleEnemy(run) && run.player.hp <= Math.floor(run.player.max_hp / 2) && !F.playerHealingSpellState(run).can_use) { s.outcome = 'retreated'; break; }
      if (F.onStairs(run) && !F.nearestVisibleEnemy(run)) {
        s.kills += countKills();
        s.floor_turns.push(run.turn - floorStart);
        if (run.floor >= run.max_floors) { s.outcome = 'cleared'; break; }
        F.loadFloor(run, run.floor + 1);
        F.recoverTurnVitals(run);
        run.turn += 1;
        floorStart = run.turn;
        continue;
      }
      run.turn_events = [];
      const rng = createRng(deriveSeed(run.seed, 100000 + run.turn));
      let acted = false;
      for (const action of policyActions(run)) {
        const castTarget = action.type === 'cast' ? F.nearestVisibleEnemy(run) : null;
        const castTargetHp = castTarget ? castTarget.hp : null;
        const res = applyAction(run, rng, action);
        if (!res.acted) continue;
        if (action.type === 'heal_spell') s.hero_heals += 1;
        if (action.item_kind === 'heal_herb') s.herbs += 1;
        if (action.item_kind === 'mana_dew') s.dews += 1;
        // 主人公の魔法の外れ: 当たれば 1 以上削るので、狙った敵の体力が動かなければ外れ。
        if (action.type === 'cast') { s.hero_cast += 1; if (castTarget.hp === castTargetHp) s.hero_cast_miss += 1; }
        for (const e of run.turn_events) if (e.kind === 'melee') { s.hero_melee += 1; if (!e.hit) s.hero_melee_miss += 1; }
        acted = true;
        break;
      }
      if (!acted) throw new Error('hero policy found no legal action (wait always acts)');
      F.revealAround(run, run.player, run.player_stats, 'player', 'turn reveal');
      F.runCompanionTurn(run, rng);
      const hpBeforeEnemies = run.player.hp;
      const enemyPhaseFrom = run.turn_events.length;
      if (run.player.hp > 0) F.runEnemyTurns(run, rng);
      s.hero_damage_taken += Math.max(0, hpBeforeEnemies - run.player.hp);
      for (const e of run.turn_events) if (e.kind === 'enemy_attack') { s.enemy_melee += 1; if (e.hit) s.enemy_melee_hit += 1; }
      for (const e of run.turn_events.slice(enemyPhaseFrom)) {
        if (e.kind === 'enemy_attack' && e.to.x === run.player.x && e.to.y === run.player.y) { s.enemy_melee_on_hero += 1; if (e.hit) s.enemy_melee_on_hero_hit += 1; }
      }
      if (run.player.hp > 0) F.recoverTurnVitals(run);
      F.tickPlayerEvasionBuff(run);
      run.turn += 1;
      F.revealAround(run, run.player, run.player_stats, 'player', 'turn reveal');
      if (run.companion && run.companion.down) s.companion_down = true;
      if (run.player.hp <= 0) { s.outcome = 'dead'; s.kills += countKills(); break; }
    }
    s.floor = run.floor;
    s.turns = run.turn;
    return s;
  }

  const quant = (xs, q) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
  const sum = (rows, key) => rows.reduce((a, r) => a + r[key], 0);
  const summary = { form: formName, SEED_BASE, RUNS_PER_PROFILE, TURN_CAP, profiles: {} };
  const tsv = ['profile\tindex\tseed\toutcome\tfloor\tturns\thero_damage_taken\thero_heals\therbs\tdews\tenemy_melee\tenemy_melee_hit\tcompanion_down\tkills\tenemy_melee_on_hero\tenemy_melee_on_hero_hit\thero_melee\thero_melee_miss\thero_cast\thero_cast_miss'];
  for (const [name, profile] of Object.entries(PROFILES)) {
    const started = process.hrtime.bigint();
    const n = Math.min(RUNS_PER_PROFILE[name], limit);
    const rows = [];
    for (let i = 0; i < n; i += 1) {
      const seed = deriveSeed(deriveSeed(SEED_BASE, PROFILE_SALT[name]), i + 1);
      const r = playRun(profile, seed);
      rows.push(r);
      tsv.push([name, i, seed, r.outcome, r.floor, r.turns, r.hero_damage_taken, r.hero_heals, r.herbs, r.dews, r.enemy_melee, r.enemy_melee_hit, r.companion_down ? 1 : 0, r.kills,
        r.enemy_melee_on_hero, r.enemy_melee_on_hero_hit, r.hero_melee, r.hero_melee_miss, r.hero_cast, r.hero_cast_miss].join('\t'));
    }
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    const by = (o) => rows.filter((r) => r.outcome === o).length;
    const totalFloors = rows.reduce((a, r) => a + r.floor_turns.length + (r.outcome === 'dead' ? 1 : 0), 0);
    const p = {
      runs: n, dead: by('dead'), retreated: by('retreated'), cleared: by('cleared'), stuck: by('stuck'),
      floor_reached_median: quant(rows.map((r) => r.floor), 0.5), turns_per_cleared_floor_median: quant(rows.flatMap((r) => r.floor_turns), 0.5),
      hero_damage_per_floor: Number((sum(rows, 'hero_damage_taken') / totalFloors).toFixed(1)),
      enemy_melee_on_hero: sum(rows, 'enemy_melee_on_hero'), enemy_melee_on_hero_hit: sum(rows, 'enemy_melee_on_hero_hit'),
      hero_melee: sum(rows, 'hero_melee'), hero_melee_miss: sum(rows, 'hero_melee_miss'), hero_cast: sum(rows, 'hero_cast'), hero_cast_miss: sum(rows, 'hero_cast_miss'),
      companion_down_runs: rows.filter((r) => r.companion_down).length, seconds: Number(seconds.toFixed(1))
    };
    summary.profiles[name] = p;
    console.log(`${formName} DUNGEON ${name} runs=${n} dead=${p.dead} retreated=${p.retreated} cleared=${p.cleared} stuck=${p.stuck} enemy_melee_on_hero_hit=${p.enemy_melee_on_hero_hit}/${p.enemy_melee_on_hero} hero_melee_miss=${p.hero_melee_miss}/${p.hero_melee} hero_cast_miss=${p.hero_cast_miss}/${p.hero_cast} hero_dmg/floor=${p.hero_damage_per_floor} seconds=${p.seconds}`);
  }
  writeFileSync(path.join(outDir, 'dungeon-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(path.join(outDir, 'dungeon-runs.tsv'), tsv.join('\n') + '\n');
}

// ===== 並べる =====
// 揺らぎの物差し:
//   upset = 顔合わせごとに、SWING_SEEDS 試合で勝ちの少ない側の勝ち数を足し、全試合数で割る（上限まで行った試合は作品の判定＝体力の割合の勝者）。
//   rounds_cv = 顔合わせごとの「決着までの回り」の変動係数（標準偏差 ÷ 平均）の、顔合わせを通した中央値。
//   rounds_iqr = 顔合わせごとの回りの四分位の幅（p75 − p25）の中央値。上限まで行った試合は 300 回りとして入る。
function compare(outRoot, names) {
  const readTsv = (file) => {
    const [head, ...lines] = readFileSync(file, 'utf8').trimEnd().split('\n');
    const keys = head.split('\t');
    return lines.map((line) => Object.fromEntries(line.split('\t').map((v, i) => [keys[i], v])));
  };
  const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
  const quant = (xs, q) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
  const groups = ['students1v1', 'students2v2', 'buddy1v1', 'protagonist1v1', 'protagonist2v2'];
  console.log('ARENA form\tgroup\tcapped/matches\trounds_median\tupset\trounds_cv_median\trounds_iqr_median\tmelee_miss\tcast_miss\tmisses_per_round');
  for (const name of names) {
    const summary = JSON.parse(readFileSync(path.join(outRoot, name, 'summary.json'), 'utf8'));
    const swingRows = readTsv(path.join(outRoot, name, 'swing.tsv'));
    for (const group of groups) {
      const g = summary.groups[group];
      const byMatchup = new Map();
      for (const r of swingRows.filter((x) => x.group === group)) {
        if (!byMatchup.has(r.matchup)) byMatchup.set(r.matchup, []);
        byMatchup.get(r.matchup).push(r);
      }
      let minority = 0; let total = 0;
      const cvs = []; const iqrs = [];
      for (const rs of byMatchup.values()) {
        const w1 = rs.filter((r) => r.winner_side === 'side1').length;
        minority += Math.min(w1, rs.length - w1);
        total += rs.length;
        const rounds = rs.map((r) => Number(r.rounds));
        const mean = rounds.reduce((a, b) => a + b, 0) / rounds.length;
        cvs.push(Math.sqrt(rounds.reduce((a, b) => a + (b - mean) ** 2, 0) / rounds.length) / mean);
        iqrs.push(quant(rounds, 0.75) - quant(rounds, 0.25));
      }
      const misses = g.melee_miss + g.cast_miss;
      console.log([`ARENA ${name}`, group, `${g.capped}/${g.matches} (${pct(g.capped, g.matches)})`, g.rounds_median, `${minority}/${total} (${pct(minority, total)})`,
        quant(cvs, 0.5).toFixed(2), quant(iqrs, 0.5), `${g.melee_miss}/${g.melee} (${pct(g.melee_miss, g.melee)})`, `${g.cast_miss}/${g.cast} (${pct(g.cast_miss, g.cast)})`,
        (misses / g.total_rounds).toFixed(2)].join('\t'));
    }
  }
  console.log('DUNGEON form\tprofile\tdead/runs\tenemy_melee_hits_hero\thero_melee_miss\thero_cast_miss\tretreated\tcleared\thero_dmg_per_floor\tcompanion_down_runs');
  for (const name of names) {
    const d = JSON.parse(readFileSync(path.join(outRoot, name, 'dungeon-summary.json'), 'utf8'));
    for (const [profile, p] of Object.entries(d.profiles)) {
      console.log([`DUNGEON ${name}`, profile, `${p.dead}/${p.runs}`, `${p.enemy_melee_on_hero_hit}/${p.enemy_melee_on_hero} (${pct(p.enemy_melee_on_hero_hit, p.enemy_melee_on_hero)})`,
        `${p.hero_melee_miss}/${p.hero_melee} (${pct(p.hero_melee_miss, p.hero_melee)})`, `${p.hero_cast_miss}/${p.hero_cast} (${pct(p.hero_cast_miss, p.hero_cast)})`,
        p.retreated, p.cleared, p.hero_damage_per_floor, `${p.companion_down_runs}/${p.runs}`].join('\t'));
    }
  }
}
