// 回復と回避の調整の三つの形（推奨・揺らぎ中・揺らぎ強）で、同じ学院生の一対一と、同じバディーの試合を回し、闘技会の観戦の
// 見返しの画面で流れる姿を gif に撮る手回しの道具（*.test.mjs ではないので npm test は拾わない）:
//
//   <electron> app/tests/manual/combatFormsGifCapture.mjs --repo-root <絶対パス> --unit <絶対パス> --out <絶対パス>
//
// <electron> はリポの node_modules/.bin/electron。どの引数も必須で既定値は無い。--out は空でなければ止まる。
//   --repo-root  撮る作品の木。app/src・app/public・content・data を読むだけで、書かない。
//   --unit       二十週目の主人公とバディーの入場の写し（combatTuningMeasure.mjs の --unit と同じ slot002-player-unit.json）。
//                バディーはこの file の主人公でない actor。
//   --out        <組>-<形>.gif を 6 本と manifest.json（選んだ組と seed・events の数・形の効きの確かめ・gif の長さ）を書く。
//
// 形の差し方（combatTuningMeasure.mjs の形と同じ置き換え）: 作品の file は書き換えない。形ごとに子 process（PATH の node）を
// 起こし、module の load hook で --repo-root/app/src の module の source を、読み込む時にメモリの上だけで置き換える
// （置き換える前の文字列がちょうど1か所にあることを確かめ、無ければ止まる。置き換えが全部当たったことは hook から受け取った一覧で
// 確かめる）。揺らぎ中は今の作品の決まりで、置き換えない。推奨と揺らぎ強は回復の量と回避の計算だけを置き換える。
//
// 試合の選び方: 組と seed は測りの道具と同じ並び（学院生 1 対 1 は名簿の総当たりの順、バディー 1 対 1 は対戦相手ごとに 6 個の seed で
// 左右を入れ替える順。seed は measure の matchSeed）。どちらも全部を三つの形で回し、三つの形のどれでも「上限まで行かない・回復が
// 1回以上・魔法の外れが1回以上・手の数が MAX_TURNS 以下」になる最初の組を選ぶ。打撃は魔力の尽きた長い試合でしか出ないので条件に
// 入れない。三つの形のどれでも打撃の外れが出る組の数と、その中で手の数の最も少ない組は manifest の melee_miss に残す。
//
// 画面への出し方: 一時ディレクトリの新しいプレイ（routing・案内人 fallen_star・バディーは --unit のバディー）を、この process の中に
// 起こした作品の server で開き、露台からの本物の送り出しで闘技会へ行き、観戦を選んで、見ずに先へ進む紋で結果の段まで送る（大会は
// この使い捨てのプレイの中にだけ立ち、作品の保存には書かない）。表の一回戦のバディーの組と、バディーの出ない一回戦の最初の組の目を押し、
// その見返しの応答（/api/arena/match/<id>/replay）を CDP の Fetch で、子 process が回した試合の turns に差し替えて渡す。バディーの試合は
// 画面がバディーを左（自陣）に置くので、表の組の側とバディーの側が違えば、画面が映すのと同じ左右の映しを先にかけて渡す（画面が映し直して
// 回した試合のとおりに見える）。勝者の unit は、渡した turns の勝った側を表の組の unit に読み替える。LM は固定応答（知らない要求は
// 500 にして撮影ごと止める）。
//
// 撮り方: 見返しの盤が出た時から、凍らせずに #arena-match の矩形を Page.captureScreenshot で撮り続け（撮った時刻を残す）、最後の手の
// 決着の印が出てから HOLD_MS 撮って止める。速さは見返しの既定（低速・一手 1.1 秒）。gif は python3 ＋ Pillow で、TICK_MS ごとに
// その時刻までに撮れた最新のこまを置き（同じこまが続けば長さを足す）、こまを散らして集めた一枚から作った共通の 255 色で綴じる。
import electron from 'electron';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MessageChannel, receiveMessageOnPort } from 'node:worker_threads';

const VIEWPORT = { width: 1440, height: 900 };
const GIF_MAX_WIDTH = 960;
const TICK_MS = 80;
const HOLD_MS = 2500;
const SETTLE_MS = 1500;
const LM_WAIT_MS = 120000;
const HOST = '127.0.0.1';
const MAX_TURNS = 30;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ----- 形（combatTuningMeasure.mjs の CURRENT・FORMS と同じ値。CURRENT は今の作品＝揺らぎ中） -----
const CURRENT = { heal_divisor: 5, evasion_base: 9, evasion_per_agility: 0.28 };
const FORMS = {
  rec: { ...CURRENT, heal_divisor: 4, evasion_base: 6, evasion_per_agility: 0.22 },
  mid: { ...CURRENT },
  strong: { ...CURRENT, heal_divisor: 6, evasion_base: 12, evasion_per_agility: 0.36 }
};
const FORM_LABELS = { rec: '推奨', mid: '揺らぎ中', strong: '揺らぎ強' };
const GROUPS = ['students', 'buddy'];

const evasionExpr = (base, per) => `${base} + Math.round(agility * ${per})`;

function formEdits(form) {
  const edits = {};
  const add = (rel, old, next) => (edits[rel] ??= []).push({ old, new: next });
  if (form.heal_divisor !== CURRENT.heal_divisor) {
    add('dungeon/dungeonStats.mjs', `return Math.max(8, Math.round((lightPower + waterPower) / ${CURRENT.heal_divisor}));`,
      `return Math.max(8, Math.round((lightPower + waterPower) / ${form.heal_divisor}));`);
  }
  if (form.evasion_base !== CURRENT.evasion_base || form.evasion_per_agility !== CURRENT.evasion_per_agility) {
    add('dungeon/dungeonStats.mjs', `evasion: ${evasionExpr(CURRENT.evasion_base, CURRENT.evasion_per_agility)},`,
      `evasion: ${evasionExpr(form.evasion_base, form.evasion_per_agility)},`);
  }
  return edits;
}

// load hook（子 process の hook thread で動く）。置き換えた module の URL と置き換えの数を port で返す。
const HOOKS = `
let edits; let port;
export async function initialize(data) { edits = new Map(Object.entries(data.edits)); port = data.port; }
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const list = edits.get(url);
  if (!list) return result;
  let source = String(result.source);
  for (const e of list) {
    const count = source.split(e.old).length - 1;
    if (count !== 1) throw new Error(url + ': anchor count ' + count + ': ' + JSON.stringify(e.old));
    source = source.replace(e.old, () => e.new);
  }
  port.postMessage({ url, count: list.length });
  return { ...result, source, shortCircuit: true };
}
`;

// ===== 子 process: 一つの形で試合を回す =====
// --child scan  : 候補の全部を回し、組ごとの数（手の数・回復・外れ・上限）を --result に書く。
// --child turns : --pick の二つの試合を回し、turns と形の効きの確かめを --result に書く。
async function runChild(argv) {
  const opt = Object.fromEntries(argv.slice(1).reduce((pairs, value, index, list) => (index % 2 === 0 ? [...pairs, [value, list[index + 1]]] : pairs), []));
  const job = argv[0];
  for (const key of ['--repo-root', '--unit', '--form', '--result']) if (!opt[key]) throw new Error(`child: ${key} is required`);
  const form = FORMS[opt['--form']];
  if (!form) throw new Error(`child: unknown form ${opt['--form']}`);
  const repoRoot = opt['--repo-root'];
  const srcUrl = (rel) => pathToFileURL(path.join(repoRoot, 'app/src', rel)).href;
  const edits = Object.fromEntries(Object.entries(formEdits(form)).map(([rel, list]) => [srcUrl(rel), list]));
  const { port1, port2 } = new MessageChannel();
  register(`data:text/javascript,${encodeURIComponent(HOOKS)}`, { data: { edits, port: port2 }, transferList: [port2] });
  const imp = (rel) => import(srcUrl(rel));
  const arena = await imp('arena/arenaEngine.mjs');
  const { deriveSeed } = await imp('dungeon/dungeonRng.mjs');
  const { healingSpellAmount } = await imp('dungeon/dungeonStats.mjs');
  await imp('dungeon/combatResolution.mjs');
  await imp('dungeon/combatAi.mjs');
  const { normalizeParameters } = await imp('parameters.mjs');
  const { MP_RESERVE_INITIAL_PERCENT } = await imp('mpReserve.mjs');
  const applied = new Map();
  for (let message = receiveMessageOnPort(port1); message; message = receiveMessageOnPort(port1)) applied.set(message.message.url, message.message.count);
  port1.close();
  const missing = Object.entries(edits).filter(([url, list]) => applied.get(url) !== list.length).map(([url]) => url);
  if (missing.length) throw new Error(`form ${opt['--form']}: edits not applied to ${missing.join(', ')}`);
  const appliedEdits = Object.fromEntries([...applied].map(([url, count]) => [path.relative(path.join(repoRoot, 'app/src'), fileURLToPath(url)), count]));

  // 組と seed は測りの道具と同じ（SEED_BASE・GROUP_SALT・名簿の順・バディーの左右の入れ替え）。
  const SEED_BASE = 0x7ca9_0001;
  const GROUP_SALT = { students1v1: 1, buddy1v1: 3 };
  const BUDDY_SEEDS_PER_OPPONENT = 6;
  const ROSTER_SIZE = 172;
  const matchSeed = (group, index) => deriveSeed(deriveSeed(SEED_BASE, GROUP_SALT[group]), index + 1);
  const charDescriptor = (index) => {
    const id = `character_${String(index).padStart(3, '0')}`;
    const profile = JSON.parse(readFileSync(path.join(repoRoot, 'content/characters', id, 'profile.json'), 'utf8'));
    if (profile.character_id && profile.character_id !== id) throw new Error(`profile id mismatch: ${id}`);
    return { actor_id: id, name: profile.display_name, kind: 'character', parameters: normalizeParameters(profile.parameters), equipment: null, mp_reserve_percent: MP_RESERVE_INITIAL_PERCENT, controller: 'ai' };
  };
  const roster = Array.from({ length: ROSTER_SIZE }, (_, i) => charDescriptor(i + 1));
  const unit = JSON.parse(readFileSync(opt['--unit'], 'utf8'));
  const buddySnap = unit.actors.find((a) => a.kind !== 'protagonist');
  if (!buddySnap) throw new Error('unit file must hold the buddy');
  const buddy = { actor_id: buddySnap.actor_id, name: buddySnap.name, kind: buddySnap.kind, parameters: buddySnap.parameters, equipment: buddySnap.equipment, mp_reserve_percent: buddySnap.mp_reserve_percent, controller: 'ai' };
  const candidates = {
    students: (() => {
      const list = [];
      for (let i = 0; i < roster.length; i += 1) for (let j = i + 1; j < roster.length; j += 1) list.push({ teamA: [roster[i]], teamB: [roster[j]] });
      return list.map((m, index) => ({ ...m, index, seed: matchSeed('students1v1', index) }));
    })(),
    buddy: (() => {
      const list = [];
      for (const opp of roster.filter((d) => d.actor_id !== buddy.actor_id)) {
        for (let k = 0; k < BUDDY_SEEDS_PER_OPPONENT; k += 1) list.push(k % 2 === 0 ? { teamA: [buddy], teamB: [opp] } : { teamA: [opp], teamB: [buddy] });
      }
      return list.map((m, index) => ({ ...m, index, seed: matchSeed('buddy1v1', index) }));
    })()
  };
  const countEvents = (turns) => {
    const c = { heal: 0, melee: 0, melee_miss: 0, cast: 0, cast_miss: 0, whiff: 0, revive: 0 };
    for (const turn of turns) for (const e of turn.events) {
      if (e.kind === 'heal') c.heal += 1;
      if (e.kind === 'revive') c.revive += 1;
      if (e.kind === 'melee' || e.kind === 'cast') { c[e.kind] += 1; if (e.whiff) c.whiff += 1; else if (!e.hit) c[`${e.kind}_miss`] += 1; }
    }
    return c;
  };
  const run = async (m) => {
    const result = await arena.runArenaMatchAuto({ root: repoRoot, seed: m.seed, teamA: m.teamA, teamB: m.teamB });
    const capped = result.turns.at(-1).view.status === 'active';
    return { result, summary: { index: m.index, seed: m.seed, team_a: m.teamA.map((d) => d.actor_id), team_b: m.teamB.map((d) => d.actor_id), turns: result.turns.length - 1, rounds: result.rounds, winner: result.winner, capped, ...countEvents(result.turns) } };
  };

  if (job === 'scan') {
    const out = {};
    for (const group of GROUPS) { out[group] = []; for (const m of candidates[group]) out[group].push((await run(m)).summary); }
    writeFileSync(opt['--result'], JSON.stringify({ form: opt['--form'], applied_edits: appliedEdits, groups: out }));
    return;
  }
  if (job !== 'turns') throw new Error(`child: unknown job ${job}`);
  const pick = JSON.parse(opt['--pick']);
  const out = { form: opt['--form'], values: form, applied_edits: appliedEdits, matches: {} };
  for (const group of GROUPS) {
    const m = candidates[group][pick[group]];
    const { result, summary } = await run(m);
    // 形の効きの確かめ: 試合を作った時の actor の敏捷・stats の回避と防御（差しで受け手として読まれる値）と、回復の魔法の量。
    const created = arena.createArenaMatch({ seed: m.seed, teamA: m.teamA, teamB: m.teamB });
    const actors = created.actors.map((a) => ({
      actor_id: a.actor_id, name: a.name, team: a.team, agility: a.parameters.abilities.agility.value,
      evasion: a.stats.evasion, defense: a.stats.defense, accuracy: a.stats.accuracy, heal_potency: healingSpellAmount(a.parameters), max_hp: a.max_hp
    }));
    const heals = result.turns.flatMap((turn) => turn.events.filter((e) => e.kind === 'heal').map((e) => ({ resource: e.resource, source: e.source, amount: e.amount })));
    const spellMisses = result.turns.flatMap((turn) => turn.events.filter((e) => e.kind === 'cast' && !e.hit).map((e) => ({ damage: e.damage })));
    out.matches[group] = { summary, actors, heals, spell_misses: spellMisses, turns: result.turns };
  }
  writeFileSync(opt['--result'], JSON.stringify(out));
}

// ===== 親（Electron）: 形ごとに子を回し、試合を選んで撮る =====
function parseArgs(argv) {
  const known = ['--repo-root', '--unit', '--out'];
  const parsed = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!known.includes(argv[i])) throw new Error(`unexpected argument: ${argv[i]}`);
    if (argv[i + 1] === undefined) throw new Error(`missing value for ${argv[i]}`);
    parsed[argv[i]] = argv[i + 1];
  }
  for (const key of known) if (parsed[key] === undefined) throw new Error(`${key} is required`);
  for (const key of known) if (!path.isAbsolute(parsed[key])) throw new Error(`${key} must be absolute`);
  return { repoRoot: parsed['--repo-root'], unit: parsed['--unit'], out: parsed['--out'] };
}

function runChildProcess(options, job, form, resultFile, extra = []) {
  // 子は pane の TEAM_* を継がない（作品の module が live queue を見ないように）。
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TEAM_')));
  const started = Date.now();
  const child = spawnSync('node', [fileURLToPath(import.meta.url), '--child', job, '--repo-root', options.repoRoot, '--unit', options.unit, '--form', form, '--result', resultFile, ...extra],
    { stdio: ['ignore', 'inherit', 'inherit'], env });
  if (child.status !== 0) throw new Error(`child ${job} ${form} failed: status ${child.status} signal ${child.signal}`);
  console.log(`CHILD ${job} ${form} seconds=${((Date.now() - started) / 1000).toFixed(1)}`);
  return JSON.parse(readFileSync(resultFile, 'utf8'));
}

// 三つの形のどれでも条件に合う、候補の並びで最初の組。
function pickMatches(scans) {
  const fits = (s) => !s.capped && s.heal >= 1 && s.cast_miss >= 1 && s.turns <= MAX_TURNS;
  const pick = {};
  for (const group of GROUPS) {
    const count = scans[0].groups[group].length;
    for (const scan of scans) if (scan.groups[group].length !== count) throw new Error(`${group}: forms scanned different candidates`);
    const index = scans[0].groups[group].findIndex((_, i) => scans.every((scan) => fits(scan.groups[group][i])));
    if (index < 0) throw new Error(`${group}: no candidate fits every form (${count} scanned)`);
    pick[group] = index;
  }
  return pick;
}

// 三つの形のどれでも打撃の外れが出る組の数と、その中で（三つの形の長い方の）手の数が最も少ない組。
function meleeMissCandidates(scans) {
  return Object.fromEntries(GROUPS.map((group) => {
    const rows = scans[0].groups[group].map((_, i) => scans.map((scan) => scan.groups[group][i]));
    const both = rows.filter((row) => row.every((s) => s.melee_miss >= 1));
    const shortest = both.reduce((best, row) => (!best || Math.max(...row.map((s) => s.turns)) < Math.max(...best.map((s) => s.turns)) ? row : best), null);
    return [group, { candidates: rows.length, with_melee_miss_in_every_form: both.length, shortest: shortest && shortest.map((s) => ({ index: s.index, turns: s.turns, melee_miss: s.melee_miss, capped: s.capped })) }];
  }));
}

// ── 固定応答の LM ──
const FIXTURE_CHAT_MODEL = 'capture-chat';
const FIXTURE_REFLECTION_MODEL = 'capture-reflection';
const FIXTURE_PROMPT_ANSWERS = [
  ['場所移動の合意', 'false'],
  ['location_idを1つだけ返す', 'none'],
  ['character_idを1つだけ返す', 'none'],
  ['継続したいと思うか', 'true'],
  ['好感度の変化量を判定する', '0'],
  ['MP温存ライン', '30'],
  ['増減したユーザーの所持金を判定する', '0'],
  ['所持金判定', '0']
];
const ARENA_INTRO_MARKER = '次の試合の開始を告げる短い口上を書く。';
const ARENA_RESULT_MARKER = '結果を告げる実況を一文だけ書く。';

function createFixtureLm(hubLines) {
  return async function answer(body) {
    const prompt = body.messages.map((message) => message.content ?? '').join('\n');
    const schemaName = body.response_format?.json_schema?.name ?? null;
    if (schemaName === 'character_emotion_choice') return { kind: schemaName, content: JSON.stringify({ expression: 'neutral' }) };
    if (schemaName === 'work_record_recall_choice') return { kind: schemaName, content: JSON.stringify({ work_record_ids: [] }) };
    if (schemaName !== null) throw new Error(`fixture lm: unknown structured request ${schemaName}`);
    if (prompt.includes('destination_idを1つだけ返す')) {
      const matches = Object.entries(hubLines).filter(([, line]) => prompt.includes(line));
      return { kind: 'hub-destination', content: matches.length === 1 ? matches[0][0] : 'none' };
    }
    if (prompt.includes('これはイベントフラグ判定')) return { kind: 'event-flag', content: 'false' };
    if (prompt.includes(ARENA_INTRO_MARKER)) return { kind: 'arena-intro', content: '夜の闘技場に篝火が揺れ、魔法陣の上で影が向かい合う。' };
    if (prompt.includes(ARENA_RESULT_MARKER)) return { kind: 'arena-result', content: '篝火の円形の場に、この大会の結びが高く告げられた。' };
    for (const [marker, content] of FIXTURE_PROMPT_ANSWERS) if (prompt.includes(marker)) return { kind: marker, content };
    if (body.model === FIXTURE_CHAT_MODEL && body.stream === true) return { kind: 'chat', content: '（顔を上げて）ええ、行ってらっしゃい。' };
    if (body.model === FIXTURE_REFLECTION_MODEL && body.stream !== true) return { kind: 'reflection', content: '学院で主人公と少し話した。' };
    throw new Error(`fixture lm: unknown request: ${prompt.slice(-160)}`);
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => resolve(server.address().port));
  });
}
function closeServer(server) {
  return new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
}
async function writeJson(root, relativePath, value) {
  const full = path.join(root, relativePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function startProduct(repoRoot, buddyId) {
  const product = (relative) => import(path.join(repoRoot, 'app/src', relative));
  const { createServer } = await product('server.mjs');
  const { runtimePathsManifestFilename } = await product('runtimePaths.mjs');
  const { initializeNewPlayArea } = await product('playSession.mjs');
  const { routingDestinations } = await product('routingDestinations.mjs');
  const { setRelationshipDebugState } = await product('relationshipState.mjs');
  const hubLines = Object.fromEntries(routingDestinations.map((d) => [d.id, `今週は${d.label}に行きたい。`]));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'combat-forms-gif-'));
  const closers = [];
  const lmFailures = [];
  try {
    await fs.cp(path.join(repoRoot, 'data/definitions'), path.join(root, 'data/definitions'), { recursive: true });
    await fs.cp(path.join(repoRoot, 'data/seeds'), path.join(root, 'data/seeds'), { recursive: true });
    await fs.cp(path.join(root, 'data/seeds/game_data'), path.join(root, 'data/mutable/game_data'), { recursive: true });
    await writeJson(root, runtimePathsManifestFilename, {
      configRoot: path.join(root, 'app/config'),
      definitionsRoot: path.join(root, 'data/definitions/game_data'),
      seedsRoot: path.join(root, 'data/seeds/game_data'),
      mutableRoot: path.join(root, 'data/mutable/game_data'),
      characterContentRoot: path.join(repoRoot, 'content/characters'),
      creatureContentRoot: path.join(repoRoot, 'content/creatures'),
      canonicalAssetsRoot: path.join(repoRoot, 'assets/canonical'),
      publicRoot: path.join(repoRoot, 'app/public'),
      resourceRoot: root
    });
    const playArea = await initializeNewPlayArea({ root, playMode: 'routing', routingPersonaVariant: 'fallen_star' });
    await setRelationshipDebugState({ root: playArea.root, buddyCharacterId: buddyId });
    const answer = createFixtureLm(hubLines);
    const lm = createHttpServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let reply;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        reply = await answer(body);
      } catch (error) {
        lmFailures.push(error.message);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error.message) }));
        return;
      }
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: reply.content } }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      const characters = [...reply.content];
      for (let index = 0; index < characters.length; index += 3) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: characters.slice(index, index + 3).join('') } }] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    });
    const lmPort = await listen(lm);
    closers.push(() => closeServer(lm));
    await writeJson(root, 'app/config/lmstudio.json', {
      provider: 'lmstudio', base_url: `http://${HOST}:${lmPort}/v1`, chat_model: FIXTURE_CHAT_MODEL, reflection_model: FIXTURE_REFLECTION_MODEL,
      timeout_ms: 120000, stream: true, thinking_effort: null, mock_provider_enabled: false
    });
    const server = createServer({
      root,
      publicRoot: path.join(repoRoot, 'app/public'),
      canonicalAssetsRoot: path.join(repoRoot, 'assets/canonical'),
      playModeSettingsPath: path.join(root, 'app/config/play-mode.json'),
      conversationPopupSettingsPath: path.join(root, 'app/config/conversation-popup.json'),
      audioSettingsPath: path.join(root, 'app/config/audio.json'),
      lmStudioConfigPath: path.join(root, 'app/config/lmstudio.json')
    });
    const port = await listen(server);
    closers.push(() => closeServer(server));
    return {
      base: `http://${HOST}:${port}`, hubLines, lmFailures,
      async stop() { for (const close of closers.reverse()) await close(); await fs.rm(root, { recursive: true, force: true }); }
    };
  } catch (error) {
    for (const close of closers.reverse()) await close();
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

const PAGE_STATE = `(() => ({
  screens: [...document.querySelectorAll('.screen.active')].map((el) => el.id),
  arenaStage: document.querySelector('#academy-arena-screen')?.dataset.stage ?? null
}))()`;

// 見返しの応答の差し替え: serve(matchId, payload) を置いてから目を押すと、その match の /replay を payload で返す（一回きり）。
async function openPage(BrowserWindow, guard) {
  const win = new BrowserWindow({ width: VIEWPORT.width, height: VIEWPORT.height, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  const pageErrors = [];
  win.webContents.on('console-message', (event, level, message) => { if (level === 3) { pageErrors.push(message); console.log(`renderer-error: ${message}`); } });
  await win.loadURL('about:blank');
  const cdp = win.webContents.debugger;
  cdp.attach('1.3');
  const send = (method, params = {}) => cdp.sendCommand(method, params);
  await send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  const served = new Map();
  const servedLog = [];
  cdp.on('message', (event, method, params) => {
    if (method !== 'Fetch.requestPaused') return;
    const matchId = decodeURIComponent(/\/api\/arena\/match\/([^/]+)\/replay$/.exec(new URL(params.request.url).pathname)?.[1] ?? '');
    const payload = served.get(matchId);
    if (!payload) { send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }).catch(() => {}); servedLog.push({ matchId, served: false }); return; }
    served.delete(matchId);
    servedLog.push({ matchId, served: true });
    send('Fetch.fulfillRequest', {
      requestId: params.requestId, responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'application/json' }],
      body: Buffer.from(JSON.stringify(payload)).toString('base64')
    }).catch((error) => console.log(`fulfill failed: ${error.message}`));
  });
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/arena/match/*/replay', requestStage: 'Request' }] });
  const js = (expr) => win.webContents.executeJavaScript(expr);
  const page = {
    js, pageErrors, servedLog,
    serve(matchId, payload) { served.set(matchId, payload); },
    async load(url) {
      await win.loadURL(url);
      const m = await js('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })');
      if (m.w !== VIEWPORT.width || m.h !== VIEWPORT.height || m.dpr !== 1) throw new Error(`viewport ${JSON.stringify(m)}`);
    },
    async waitFor(predicate, label, timeoutMs = 30000) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        guard();
        if (await js(`(() => { try { return !!(${predicate}); } catch (e) { return false; } })()`)) return;
        await sleep(30);
      }
      throw new Error(`timed out waiting for ${label} (page: ${JSON.stringify(await js(PAGE_STATE).catch(() => null))})`);
    },
    async clickAt(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    },
    async click(selectorExpr, label) {
      const box = await js(`(() => { const el = ${selectorExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
      if (!box || box.w === 0 || box.h === 0) throw new Error(`${label} is not on screen`);
      await page.clickAt(box.x, box.y);
    },
    async type(selectorExpr, label, text) {
      await page.click(selectorExpr, label);
      for (const character of text) { await send('Input.insertText', { text: character }); await sleep(20); }
    },
    async moveAway() { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 }); },
    async shot(clip) {
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip });
      return Buffer.from(data, 'base64');
    },
    close() { win.destroy(); }
  };
  return page;
}

const motionSettled = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector)})].every((el) => el.getAnimations({ subtree: true }).every((a) => a.playState !== 'running' || a.effect.getComputedTiming().iterations === Infinity))`;
const IMAGES_LOADED = (selector) => `[...document.querySelectorAll(${JSON.stringify(`${selector} img`)})].every((img) => !img.getAttribute('src') || img.complete)`;
const LOADING_ACTIVE = "document.body.classList.contains('academy-loading-screen-active')";
const VEIL_UP = "(document.querySelector('#place-veil') && !document.querySelector('#place-veil').hidden)";
const HUB_READY = `document.querySelector('#routing-hub-screen.active') && !${VEIL_UP} && !document.querySelector('#routing-hub-input').disabled && document.querySelector('#journey').dataset.journeyReady === 'true'`;
const arrived = (id) => `document.querySelector('#${id}.active') && !${LOADING_ACTIVE} && !${VEIL_UP}`;
const settled = (id) => `${arrived(id)} && ${motionSettled(`#${id}`)} && ${IMAGES_LOADED(`#${id}`)}`;
const ARENA = 'academy-arena-screen';
const ARENA_STAGE = (stage) => `document.querySelector('#${ARENA}')?.dataset.stage === '${stage}'`;
const SELECTION_READY = `${ARENA_STAGE('selection')} && document.querySelectorAll('#arena-selection-modes .arena-floor-spot').length === 3`;
const ENTRY_READY = `${ARENA_STAGE('bracket')} && document.querySelector('#arena-bracket-ring .arena-ring-eye--entry') && document.querySelector('#arena-bracket-actions .arena-spectate-skip') && !document.querySelector('#arena-bracket').classList.contains('arena-bracket--entering')`;
const RESULT_UP = `${ARENA_STAGE('result')} && !document.querySelector('#arena-result').hidden`;
const RESULT_READY = `${RESULT_UP} && document.querySelector('#arena-result-flavor')?.dataset.state !== 'pending'`;
const REPLAY_UP = `${ARENA_STAGE('match')} && document.querySelector('#arena-grid .an-entity') && document.querySelector('.arena-replay-info')`;
const REPLAY_AT_END = "(() => { const t = document.querySelector('.arena-replay-info')?.textContent ?? ''; const [a, b] = t.split(' / '); return a && a === b; })()";
const MARK_SHOWN = "document.querySelector('#arena-mark')?.classList.contains('is-shown')";

async function walkToArenaResult(ctx) {
  const { page } = ctx;
  await page.load(`${ctx.product.base}/`);
  await page.waitFor("document.querySelector('#journey')?.dataset.journeyReady === 'true' && document.querySelector('#journey').dataset.scene === 'gate'", 'title gate');
  await sleep(SETTLE_MS);
  await page.click("document.querySelector('[data-journey-action=\"load\"]')", 'ロード');
  await page.waitFor("document.querySelector('#journey').dataset.scene === 'hall' && document.querySelector('.journey-footprint-light:not(:disabled)')", 'footprint hall');
  await sleep(SETTLE_MS);
  await page.click("document.querySelector('.journey-footprint-light:not(:disabled)')", 'slot footprint');
  await page.waitFor(HUB_READY, 'the terrace', LM_WAIT_MS);
  await page.waitFor(`${motionSettled('#routing-hub-screen')} && ${IMAGES_LOADED('#routing-hub-screen')}`, 'the terrace settled');
  await sleep(SETTLE_MS);
  await page.type("document.querySelector('#routing-hub-input')", 'terrace input', ctx.product.hubLines.arena);
  await sleep(300);
  await page.click("document.querySelector('#routing-hub-send')", 'terrace send');
  await page.waitFor("document.querySelector('#routing-hub-input').value === ''", 'the terrace send to fire');
  await page.waitFor(arrived(ARENA), 'arena arrived', LM_WAIT_MS);
  await page.waitFor(`${settled(ARENA)} && ${SELECTION_READY}`, 'the arena selection');
  await page.click("document.querySelector('#arena-selection-modes .arena-floor-spot[data-mode=\"spectate\"]')", '観戦の立ち位置');
  await page.waitFor(ENTRY_READY, 'the spectate entrance', LM_WAIT_MS);
  while (!(await page.js(`!!(${RESULT_UP})`))) {
    await page.click("document.querySelector('#arena-bracket-actions .arena-spectate-skip')", '見ずに先へ進む紋');
    await page.waitFor(`(${ENTRY_READY} || ${RESULT_UP})`, 'the next entry or the result stage', 15000);
  }
  await page.waitFor(`${settled(ARENA)} && ${RESULT_READY}`, 'the whole bracket revealed', LM_WAIT_MS);
}

// 画面の arenaMirrorReplayTurn と同じ左右の映し（映しを二度かければ元に戻る）。
function mirrorTurn(turn) {
  const { view } = turn;
  const flip = (team) => (team === 'a' ? 'b' : 'a');
  const mx = (x) => view.width - 1 - x;
  const status = { active: 'active', a_won: 'b_won', b_won: 'a_won' }[view.status];
  if (!status) throw new Error(`cannot mirror a turn with status ${JSON.stringify(view.status)}`);
  return {
    ...turn,
    view: { ...view, status, winner: view.winner === null ? null : flip(view.winner), tiles: view.tiles.map((row) => [...row].reverse()), actors: view.actors.map((actor) => ({ ...actor, team: flip(actor.team), x: mx(actor.x) })) },
    events: turn.events.map((event) => ({ ...event, from: { ...event.from, x: mx(event.from.x) }, to: { ...event.to, x: mx(event.to.x) } }))
  };
}

// 見返しを開き、盤が出てから決着の印の HOLD_MS 後まで撮り続けて、gif に綴じる。
async function filmReplay(ctx, { group, form, bracketMatch, payload, expectedMark }) {
  const { page } = ctx;
  page.serve(bracketMatch.match_id, payload);
  await page.click(`document.querySelector('#arena-bracket-ring .arena-ring-eye[data-match-id="${bracketMatch.match_id}"]')`, `${bracketMatch.match_id} の見返しの目`);
  await page.waitFor(REPLAY_UP, `the replay of ${bracketMatch.match_id}`, LM_WAIT_MS);
  await page.moveAway();
  const rect = await page.js("(() => { const r = document.querySelector('#arena-match').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; })()");
  const clip = { ...rect, scale: Math.min(1, GIF_MAX_WIDTH / rect.width) };
  const framesDir = path.join(ctx.tmp, `${group}-${form}`);
  await fs.mkdir(framesDir);
  const frames = [];
  const t0 = Date.now();
  let endAt = null;
  for (let n = 0; ; n += 1) {
    const t = Date.now() - t0;
    const bytes = await page.shot(clip);
    const file = `${String(n).padStart(5, '0')}.png`;
    await fs.writeFile(path.join(framesDir, file), bytes);
    frames.push({ file, t });
    if (endAt === null && n % 5 === 0 && await page.js(`!!(${REPLAY_AT_END} && ${MARK_SHOWN})`)) endAt = Date.now();
    if (endAt !== null && Date.now() - endAt >= HOLD_MS) break;
    if (t > 180000) throw new Error(`${group}-${form}: the replay did not end in 180 s`);
  }
  const ending = await page.js("({ info: document.querySelector('.arena-replay-info').textContent, mark: document.querySelector('#arena-mark').textContent, speed: [...document.querySelectorAll('.arena-replay-speed-button')].find((b) => b.getAttribute('aria-pressed') === 'true' || b.classList.contains('is-selected'))?.getAttribute('aria-label') ?? null })");
  const expectedInfo = `${payload.turns.length} / ${payload.turns.length}`;
  if (ending.info !== expectedInfo || ending.mark !== expectedMark) throw new Error(`${group}-${form}: ending ${JSON.stringify(ending)} (expected ${expectedInfo} ${expectedMark})`);
  await fs.writeFile(path.join(framesDir, 'frames.json'), JSON.stringify(frames));
  const gifPath = path.join(ctx.options.out, `${group}-${form}.gif`);
  const encoded = spawnSync('python3', ['-c', GIF_ENCODER, framesDir, gifPath, String(TICK_MS)], { encoding: 'utf8', cwd: framesDir });
  if (encoded.status !== 0) throw new Error(`gif encoder failed: ${encoded.stderr}`);
  const gif = JSON.parse(encoded.stdout.trim().split('\n').at(-1));
  await page.click("document.querySelector('#arena-match-back')", '表へ戻る紋');
  await page.waitFor(`(${ARENA_STAGE('bracket')} || ${RESULT_UP}) && ${settled(ARENA)}`, 'the bracket after the replay', 15000);
  const line = { group, form, gif: gifPath, captured_frames: frames.length, captured_ms: frames.at(-1).t, clip, ending, ...gif };
  console.log(`GIF ${JSON.stringify(line)}`);
  return line;
}

// こまの並び（frames.json の file と撮った時刻 t）を、tick ごとにその時刻までの最新のこまで並べ直し（同じこまが続けば長さを足す）、
// こまを散らして集めた一枚から作った共通の 255 色で、ディザ無しに綴じる。
const GIF_ENCODER = `
import json, os, sys
from PIL import Image
frames_dir, out_path, tick = sys.argv[1], sys.argv[2], int(sys.argv[3])
index = json.load(open(os.path.join(frames_dir, 'frames.json')))
runs = []
j = 0
for t in range(0, index[-1]['t'] + 1, tick):
    while j + 1 < len(index) and index[j + 1]['t'] <= t:
        j += 1
    if runs and runs[-1][0] == j:
        runs[-1][1] += tick
    else:
        runs.append([j, tick])
load = lambda k: Image.open(os.path.join(frames_dir, index[k]['file'])).convert('RGB')
first = load(0)
w, h = first.size
picks = [runs[int(i * (len(runs) - 1) / 15)][0] for i in range(16)]
sheet = Image.new('RGB', (w, h * len(picks)))
for n, k in enumerate(picks):
    sheet.paste(load(k), (0, h * n))
palette = sheet.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
images = [load(k).quantize(palette=palette, dither=Image.Dither.NONE) for k, _ in runs]
durations = [d for _, d in runs]
images[0].save(out_path, save_all=True, append_images=images[1:], duration=durations, loop=0, disposal=1)
print(json.dumps({'gif_frames': len(images), 'gif_seconds': round(sum(durations) / 1000, 2), 'gif_bytes': os.path.getsize(out_path), 'gif_size': [w, h]}))
`;

async function main() {
  const { app, BrowserWindow } = electron;
  const options = parseArgs(process.argv.slice(2));
  const existing = await fs.readdir(options.out).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
  if (existing.length) throw new Error(`--out ${options.out} is not empty`);
  await fs.mkdir(options.out, { recursive: true });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'combat-forms-gif-frames-'));
  const started = Date.now();
  try {
    // 1. 三つの形で候補を回し、どの形でも条件に合う最初の組を選ぶ。
    const forms = Object.keys(FORMS);
    const scans = forms.map((form) => runChildProcess(options, 'scan', form, path.join(tmp, `scan-${form}.json`)));
    const pick = pickMatches(scans);
    console.log(`PICK ${JSON.stringify(pick)}`);
    const played = Object.fromEntries(forms.map((form) => [form, runChildProcess(options, 'turns', form, path.join(tmp, `turns-${form}.json`), ['--pick', JSON.stringify(pick)])]));
    for (const form of forms) {
      for (const group of GROUPS) {
        const scanned = scans[forms.indexOf(form)].groups[group][pick[group]];
        const { summary } = played[form].matches[group];
        if (JSON.stringify(scanned) !== JSON.stringify(summary)) throw new Error(`${group}-${form}: the turns run differs from the scan (${JSON.stringify(scanned)} vs ${JSON.stringify(summary)})`);
      }
    }

    // 2. 観戦の大会を結果の段まで送り、表の一回戦の二つの組の見返しを差し替えて撮る。
    const unit = JSON.parse(readFileSync(options.unit, 'utf8'));
    const buddyId = unit.actors.find((a) => a.kind !== 'protagonist').actor_id;
    await app.whenReady();
    const product = await startProduct(options.repoRoot, buddyId);
    const guard = () => { if (product.lmFailures.length) throw new Error(`fixture LM 500: ${product.lmFailures.join(' | ')}`); };
    const page = await openPage(BrowserWindow, guard);
    const ctx = { options, product, page, tmp };
    const gifs = [];
    let bracket;
    try {
      await walkToArenaResult(ctx);
      const state = await page.js("fetch('/api/arena/state').then((r) => r.json())");
      if (state.mode !== 'spectate') throw new Error(`not a spectate tournament: ${state.mode}`);
      const buddyUnit = state.player_unit_id;
      const round1 = state.bracket.rounds[0];
      const buddyMatch = round1.find((m) => m.team_a_unit_id === buddyUnit || m.team_b_unit_id === buddyUnit);
      const studentMatch = round1.find((m) => m !== buddyMatch);
      bracket = { buddy_unit_id: buddyUnit, buddy_match: buddyMatch, student_match: studentMatch };
      console.log(`BRACKET ${JSON.stringify(bracket)}`);
      for (const form of forms) {
        for (const group of GROUPS) {
          const { summary, turns } = played[form].matches[group];
          const bracketMatch = group === 'buddy' ? buddyMatch : studentMatch;
          // バディーの試合: 回した試合のバディーの側と表のバディーの側が違えば、画面が映し直すぶんを先に映しておく。
          const playedBuddySide = summary.team_a.includes(buddyId) ? 'a' : 'b';
          const bracketBuddySide = buddyMatch.team_a_unit_id === buddyUnit ? 'a' : 'b';
          const mirrored = group === 'buddy' && playedBuddySide !== bracketBuddySide;
          const servedTurns = mirrored ? turns.map(mirrorTurn) : turns;
          const servedWinner = mirrored ? (summary.winner === 'a' ? 'b' : 'a') : summary.winner;
          const payload = { match_id: bracketMatch.match_id, round: bracketMatch.round, winner_unit_id: servedWinner === 'a' ? bracketMatch.team_a_unit_id : bracketMatch.team_b_unit_id, seed: summary.seed, turns: servedTurns };
          const buddyWon = group === 'buddy' && summary.winner === playedBuddySide;
          const expectedMark = group === 'buddy' && !buddyWon ? '敗退' : '勝ち上がり';
          gifs.push({ ...(await filmReplay(ctx, { group, form, bracketMatch, payload, expectedMark })), mirrored_for_screen: mirrored, buddy_won: group === 'buddy' ? buddyWon : null });
        }
      }
      guard();
      if (page.pageErrors.length) throw new Error(`renderer errors: ${page.pageErrors.join(' | ')}`);
      const unserved = page.servedLog.filter((entry) => !entry.served);
      if (unserved.length || page.servedLog.length !== gifs.length) throw new Error(`replay requests not served as planned: ${JSON.stringify(page.servedLog)}`);
    } finally {
      page.close();
      await product.stop();
    }

    const manifest = {
      seconds: (Date.now() - started) / 1000,
      selection: `学院生は名簿の総当たりの全部、バディーは対戦相手ごと 6 seed の全部（どちらも測りの道具と同じ並びと seed）を三つの形で回し、三つの形のどれでも上限まで行かず・回復と魔法の外れが 1 回以上・手の数 ${MAX_TURNS} 以下の最初の組`,
      pick, bracket, melee_miss: meleeMissCandidates(scans),
      forms: Object.fromEntries(forms.map((form) => [form, {
        label: FORM_LABELS[form], values: FORMS[form], applied_edits: played[form].applied_edits,
        matches: Object.fromEntries(GROUPS.map((group) => {
          const { summary, actors, heals, spell_misses } = played[form].matches[group];
          return [group, { summary, actors, heals, spell_misses }];
        }))
      }])),
      gifs
    };
    await fs.writeFile(path.join(options.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`run done in ${manifest.seconds.toFixed(1)} s`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--child') {
  runChild(process.argv.slice(3)).catch((error) => { console.error('CHILD FAILED', error.stack); process.exit(1); });
} else {
  const { app } = electron;
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.on('window-all-closed', () => {});
  main().then(() => app.exit(0)).catch((error) => { console.error('FAILED', error.stack); app.exit(1); });
}
