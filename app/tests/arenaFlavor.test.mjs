// 闘技会 LLM flavor (試合前口上 / 優勝・敗退実況一文): the prompt-contract of the two benchmark-confirmed templates
// (arenaGeneration.mjs), the slot flavor persistence + pure derivations (arenaTournament.mjs), the session's
// idempotent generate-and-persist with a mock LM, and the HTTP route wiring. No live LM — the prompt-contract
// tests assert on the built prompt string, and the session tests use a deterministic mock fetchImpl.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  buildArenaIntroPrompt,
  buildArenaResultPrompt,
  gateArenaIntro,
  gateArenaResultFlavor,
  generateArenaIntro,
  generateArenaResultFlavor,
  ARENA_INTRO_HARD_CAP,
  ARENA_RESULT_HARD_CAP,
  ARENA_GENERATION_FAILED_ERROR_CODE
} from '../src/llm/arenaGeneration.mjs';
import {
  ARENA_ROUND_COUNT, ARENA_ROUND_LABELS, ARENA_TOURNAMENT_STATE_KEY,
  arenaWeekSeed, assembleArenaUnits, createArenaTournamentSlot, validateArenaTournamentSlot,
  findPlayerCurrentMatch, arenaTournamentOutcome, isArenaTournamentTerminal,
  arenaIntroPromptInputs, arenaResultPromptInputs, arenaMatchIntro, setArenaMatchIntro,
  arenaResultFlavor, setArenaResultFlavor, findArenaIntroMatch
} from '../src/arena/arenaTournament.mjs';
import { generateArenaMatchIntro, generateArenaTournamentResultFlavor, withArenaWriteLock } from '../src/arena/arenaSession.mjs';
import { canHandleArenaApiRoute, handleArenaApi } from '../src/server/arenaApi.mjs';

const ELEMENTS = ['light', 'dark', 'fire', 'water', 'earth', 'wind'];

function params(value) {
  const magic = Object.fromEntries(ELEMENTS.map((key) => [key, { value }]));
  const abilities = { strength: { value }, agility: { value }, academics: { value }, magical_power: { value }, charisma: { value } };
  return { magic, abilities };
}
function protagonistInput(value) {
  return { parameters: params(value), equipment: null, mp_reserve_percent: 30 };
}
function buddyInput(value, { characterId = 'character_100' } = {}) {
  return { character_id: characterId, display_name: `buddy-${characterId}`, kind: 'character', parameters: params(value), equipment: null, mp_reserve_percent: 30 };
}
function opponentInputs(count, startIndex = 1) {
  return Array.from({ length: count }, (_, i) => {
    const id = `character_${String(startIndex + i).padStart(3, '0')}`;
    return { character_id: id, display_name: `opp-${id}`, parameters: params(5), mp_reserve_percent: 30 };
  });
}
function buildSlot({ mode, week = 3, protagonist = protagonistInput(30), buddy = null, opponents }) {
  const seed = arenaWeekSeed(week);
  const { playerUnit, opponentUnits } = assembleArenaUnits({ mode, protagonist, buddy, opponents });
  return createArenaTournamentSlot({ seed, week, mode, playerUnit, opponentUnits });
}

// Manually resolve a whole bracket for a pure terminal slot: the player unit wins each of its matches until
// `playerLosesAtRound` (null = champions), every non-player match goes to team_a. Mirrors the engine's
// advancement (winner fills the parent slot) without running combat.
function setWinner(slot, match, winnerUnitId) {
  match.winner_unit_id = winnerUnitId;
  if (match.round < ARENA_ROUND_COUNT - 1) {
    const parent = slot.matches.find((m) => m.match_id === `r${match.round + 1}_m${Math.floor(match.index / 2)}`);
    parent[match.index % 2 === 0 ? 'team_a_unit_id' : 'team_b_unit_id'] = winnerUnitId;
  }
}
function resolveBracket(slot, { playerLosesAtRound = null } = {}) {
  for (let round = 0; round < ARENA_ROUND_COUNT; round += 1) {
    for (const match of slot.matches.filter((m) => m.round === round)) {
      if (match.winner_unit_id !== null) continue;
      const isPlayerMatch = match.team_a_unit_id === slot.player_unit_id || match.team_b_unit_id === slot.player_unit_id;
      let winner;
      if (isPlayerMatch && playerLosesAtRound === round) {
        winner = match.team_a_unit_id === slot.player_unit_id ? match.team_b_unit_id : match.team_a_unit_id;
      } else if (isPlayerMatch) {
        winner = slot.player_unit_id;
      } else {
        winner = match.team_a_unit_id;
      }
      setWinner(slot, match, winner);
    }
  }
  return validateArenaTournamentSlot(slot);
}

// ----- Section A: prompt-contract (§3 口上 / §4 実況一文 verbatim) -----

test('the intro prompt carries every required 縛り section, the 確定情報, and the 字数 line', () => {
  const prompt = buildArenaIntroPrompt({ roundLabel: '準決勝', formatLabel: '二対二', eastNames: 'レオナ と セラ', westNames: 'ゴラン と ハーク' });
  // 話法名指し禁止 (紹介記事調・解説枠)
  assert.match(prompt, /試合を外から解説・要約する話法にしない/);
  assert.match(prompt, /紹介記事調・解説枠で書かない/);
  // 記号 / ト書き / 改行禁止
  assert.match(prompt, /引用符や鉤括弧で言葉を囲わない。改行せず一続きに。見出し・前置き・ト書き（丸括弧の動作描写）は書かない。/);
  // 陳腐語禁止 (散らし lever 1・always)
  assert.match(prompt, /陳腐な決まり文句や毎回同じ語り出し・同じ賛辞を避け、この一戦ならではの言葉で語る。同じ言い回しを繰り返さない。/);
  // 世界整合ガード
  assert.match(prompt, /実在の地名・人名・歴史、現代語・外来語、現代の器具や単位を混ぜない（この世界は星の残光と地脈の魔法が息づく古い学院世界である）。/);
  // 字数行
  assert.match(prompt, /長さは80〜140字くらい。/);
  // 確定情報 woven in
  assert.match(prompt, /- 番付: 準決勝/);
  assert.match(prompt, /- 形式: 二対二/);
  assert.match(prompt, /- 東方: レオナ と セラ/);
  assert.match(prompt, /- 西方: ゴラン と ハーク/);
});

test('the intro handoff block is conditional: absent with no prior intros, present with them', () => {
  const base = buildArenaIntroPrompt({ roundLabel: '1回戦', formatLabel: '一対一', eastNames: '主人公', westNames: 'レオナ' });
  assert.ok(!base.includes('この闘技会でこれまでに述べた口上'), 'no handoff header when 0 prior intros');

  const withPrior = buildArenaIntroPrompt({
    roundLabel: '準々決勝', formatLabel: '一対一', eastNames: '主人公', westNames: 'ゴラン',
    priorIntros: ['星の残光が集う中、第一回戦が始まる。', '地脈の唸りとともに、次なる一戦へ。']
  });
  assert.match(withPrior, /この闘技会でこれまでに述べた口上（語り出し・言い回しを繰り返さない。特に同じ書き出しで始めない）:/);
  assert.match(withPrior, /- 星の残光が集う中、第一回戦が始まる。/);
  assert.match(withPrior, /- 地脈の唸りとともに、次なる一戦へ。/);
});

test('the result prompt names the REAL champion in every one of the 4 outcomes', () => {
  const champion = buildArenaResultPrompt({ outcome: 'champion', championName: '主人公', finalistName: 'レオナ・クリムセイバー' });
  assert.match(champion, /- 優勝者: 主人公/);
  assert.match(champion, /- 主人公は決勝で レオナ・クリムセイバー を下して優勝した/);

  const eliminated = buildArenaResultPrompt({ outcome: 'eliminated', championName: 'ゴラン・トールワイト', defeatRoundLabel: '準決勝', defeaterName: 'レオナ・クリムセイバー' });
  assert.match(eliminated, /- 主人公は準決勝で レオナ・クリムセイバー に敗れて姿を消した/);
  assert.match(eliminated, /- この大会の優勝者は ゴラン・トールワイト/); // the real champion, not the defeater
  assert.match(eliminated, /主人公が敗れたことと、優勝者が誰かの両方に触れ、一文だけで書く。/);

  const specChamp = buildArenaResultPrompt({ outcome: 'spectated_champion', championName: 'ヴィオラ', buddyName: 'ヴィオラ' });
  assert.match(specChamp, /- 優勝者: ヴィオラ（主人公の相棒）/);
  assert.match(specChamp, /- ヴィオラ は決勝を制して優勝した/);

  const specElim = buildArenaResultPrompt({ outcome: 'spectated_eliminated', championName: 'イリス', buddyName: 'ユーゴ', defeatRoundLabel: '1回戦', defeaterName: 'ハーク・タロンプルーム' });
  assert.match(specElim, /- 主人公の相棒 ユーゴ は1回戦で ハーク・タロンプルーム に敗れて姿を消した/);
  assert.match(specElim, /- この大会の優勝者は イリス/);
  assert.match(specElim, /相棒が敗れたことと、優勝者が誰かの両方に触れ、一文だけで書く。/);
});

test('the result prompt carries the shared 縛り sections and 世界整合ガード', () => {
  const prompt = buildArenaResultPrompt({ outcome: 'champion', championName: '主人公', finalistName: 'レオナ' });
  assert.match(prompt, /結果を外から解説・要約する話法にしない/);
  assert.match(prompt, /引用符や鉤括弧で言葉を囲わない。改行せず一続きに。見出し・前置き・ト書き（丸括弧の動作描写）は書かない。/);
  assert.match(prompt, /陳腐な決まり文句や毎回同じ語り出し・同じ賛辞を避け、この結果ならではの言葉で語る。/);
  assert.match(prompt, /実在の地名・人名・歴史、現代語・外来語、現代の器具や単位を混ぜない（この世界は星の残光と地脈の魔法が息づく古い学院世界である）。/);
});

test('the result prompt fails fast on an unknown outcome and on a missing outcome-specific field', () => {
  assert.throws(() => buildArenaResultPrompt({ outcome: 'draw', championName: 'x' }), /outcome must be one of/);
  assert.throws(() => buildArenaResultPrompt({ outcome: 'champion', championName: '主人公' }), /finalistName is required/);
  assert.throws(() => buildArenaResultPrompt({ outcome: 'eliminated', championName: 'x', defeaterName: 'y' }), /defeatRoundLabel is required/);
});

test('the flavor gates reject empty and over-cap output as a structured 503', () => {
  for (const gate of [gateArenaIntro, gateArenaResultFlavor]) {
    assert.throws(() => gate(''), (error) => error.statusCode === 503 && error.errorCode === ARENA_GENERATION_FAILED_ERROR_CODE);
    assert.throws(() => gate('   '), (error) => error.statusCode === 503);
  }
  assert.throws(() => gateArenaIntro('あ'.repeat(ARENA_INTRO_HARD_CAP + 1)), (error) => error.statusCode === 503);
  assert.throws(() => gateArenaResultFlavor('あ'.repeat(ARENA_RESULT_HARD_CAP + 1)), (error) => error.statusCode === 503);
  assert.equal(gateArenaIntro('  星の残光が集う。  '), '星の残光が集う。'); // trims a valid utterance
});

test('the generate orchestrators require a resolved LM config (fail-fast, nothing consumed)', async () => {
  await assert.rejects(() => generateArenaIntro({ roundLabel: '1回戦', formatLabel: '一対一', eastNames: 'a', westNames: 'b' }), /lmStudioConfig is required/);
  await assert.rejects(() => generateArenaResultFlavor({ outcome: 'champion', championName: '主人公', finalistName: 'x' }), /lmStudioConfig is required/);
});

// ----- Section B: slot flavor persistence + pure derivations -----

test('a fresh slot starts with empty flavor fields at the bumped schema version', () => {
  const slot = buildSlot({ mode: 'solo', opponents: opponentInputs(15) });
  assert.deepEqual(slot.match_intros, {});
  assert.equal(slot.result_flavor, null);
  assert.equal(slot.version, 2);
  validateArenaTournamentSlot(slot); // the new keys pass strict validation
});

test('slot validation rejects malformed flavor fields', () => {
  const slot = buildSlot({ mode: 'solo', opponents: opponentInputs(15) });
  assert.throws(() => validateArenaTournamentSlot({ ...slot, match_intros: { r9_m9: 'x' } }), /references an unknown match/);
  assert.throws(() => validateArenaTournamentSlot({ ...slot, match_intros: { r0_m0: '  ' } }), /must be a non-empty string/);
  assert.throws(() => validateArenaTournamentSlot({ ...slot, result_flavor: '' }), /result_flavor must be a non-empty string or null/);
});

test('arenaIntroPromptInputs derives the 番付 / 形式 / 東西 names and the prior-intro handoff', () => {
  const slot = buildSlot({ mode: 'pair', protagonist: protagonistInput(30), buddy: buddyInput(25), opponents: opponentInputs(30) });
  const playerMatch = findPlayerCurrentMatch(slot);
  const inputs = arenaIntroPromptInputs(slot, playerMatch.match_id);
  assert.equal(inputs.roundLabel, ARENA_ROUND_LABELS[0]);
  assert.equal(inputs.formatLabel, '二対二');
  assert.ok(inputs.eastNames.includes(' と '), '2v2 unit names are joined with と');
  assert.deepEqual(inputs.priorIntros, []);

  // Resolve a non-player round-0 match so it becomes a viewable auto match, record an intro on it, and confirm
  // it feeds the handoff of another viewable match.
  const autoMatch = slot.matches.find((m) => m.round === 0 && m.team_a_unit_id !== slot.player_unit_id && m.team_b_unit_id !== slot.player_unit_id);
  setWinner(slot, autoMatch, autoMatch.team_a_unit_id);
  const withIntro = setArenaMatchIntro(slot, autoMatch.match_id, '星の残光が満ちる、序戦の幕開けだ。');
  const nextInputs = arenaIntroPromptInputs(withIntro, playerMatch.match_id);
  assert.deepEqual(nextInputs.priorIntros, ['星の残光が満ちる、序戦の幕開けだ。']);
});

test('setArenaMatchIntro is idempotent and gated to viewable matches', () => {
  const slot = buildSlot({ mode: 'solo', opponents: opponentInputs(15) });
  const playerMatch = findPlayerCurrentMatch(slot);
  const once = setArenaMatchIntro(slot, playerMatch.match_id, 'いざ、開幕の一戦。');
  assert.equal(arenaMatchIntro(once, playerMatch.match_id), 'いざ、開幕の一戦。');
  const again = setArenaMatchIntro(once, playerMatch.match_id, '別の口上（無視される）');
  assert.equal(arenaMatchIntro(again, playerMatch.match_id), 'いざ、開幕の一戦。'); // first generation is the truth

  // A future-round match (undetermined participant) and an unknown id fail fast.
  const futureMatch = slot.matches.find((m) => m.round === 1);
  assert.throws(() => findArenaIntroMatch(slot, futureMatch.match_id), (error) => error.statusCode === 409);
  assert.throws(() => findArenaIntroMatch(slot, 'r9_m9'), (error) => error.statusCode === 404);
});

test('arenaResultPromptInputs resolves the real champion for each outcome', () => {
  const champ = resolveBracket(buildSlot({ mode: 'solo', opponents: opponentInputs(15) }));
  assert.equal(arenaTournamentOutcome(champ), 'champion');
  const champInputs = arenaResultPromptInputs(champ);
  assert.equal(champInputs.outcome, 'champion');
  assert.ok(champInputs.finalistName, 'the final opponent is resolved');

  const elim = resolveBracket(buildSlot({ mode: 'solo', opponents: opponentInputs(15) }), { playerLosesAtRound: 0 });
  assert.equal(arenaTournamentOutcome(elim), 'eliminated');
  const elimInputs = arenaResultPromptInputs(elim);
  assert.equal(elimInputs.defeatRoundLabel, ARENA_ROUND_LABELS[0]);
  assert.ok(elimInputs.championName && elimInputs.defeaterName);
  assert.notEqual(elimInputs.championName, undefined);

  const specChamp = resolveBracket(buildSlot({ mode: 'spectate', buddy: buddyInput(30), opponents: opponentInputs(15) }));
  assert.equal(arenaResultPromptInputs(specChamp).outcome, 'spectated_champion');
  assert.ok(arenaResultPromptInputs(specChamp).buddyName);

  const specElim = resolveBracket(buildSlot({ mode: 'spectate', buddy: buddyInput(30), opponents: opponentInputs(15) }), { playerLosesAtRound: 1 });
  const specElimInputs = arenaResultPromptInputs(specElim);
  assert.equal(specElimInputs.outcome, 'spectated_eliminated');
  assert.ok(specElimInputs.buddyName && specElimInputs.championName && specElimInputs.defeaterName);
});

test('setArenaResultFlavor requires a terminal tournament and is idempotent', () => {
  const active = buildSlot({ mode: 'solo', opponents: opponentInputs(15) });
  assert.equal(isArenaTournamentTerminal(active), false);
  assert.throws(() => setArenaResultFlavor(active, 'x'), /before the tournament is terminal/);

  const terminal = resolveBracket(buildSlot({ mode: 'solo', opponents: opponentInputs(15) }));
  const once = setArenaResultFlavor(terminal, '覇者、ここに決す。');
  assert.equal(arenaResultFlavor(once), '覇者、ここに決す。');
  const again = setArenaResultFlavor(once, '別の実況（無視）');
  assert.equal(arenaResultFlavor(again), '覇者、ここに決す。');
});

// ----- Section C: session idempotent generate-and-persist (mock LM) -----

function mockLmConfig() {
  return { base_url: 'http://mock.local/v1', chat_model: 'mock-chat', stream: false, timeout_ms: 5000, thinking_effort: null };
}
function countingMockFetch() {
  const state = { calls: 0 };
  const fetchImpl = async (_url, options) => {
    state.calls += 1;
    const prompt = JSON.parse(options.body).messages[0].content;
    let content;
    if (prompt.includes('次の試合の開始を告げる短い口上を書く')) content = '星の残光が集いし刻、開幕の一戦が始まる。';
    else if (prompt.includes('結果を告げる実況を一文だけ書く')) content = '地脈の唸りを従え、覇者がここに立つ。';
    else throw new Error(`unexpected arena mock prompt:\n${prompt.slice(0, 80)}`);
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  return { fetchImpl, state };
}
function failingFetch() {
  return async () => { throw new TypeError('fetch failed'); };
}

async function flavorRoot(slot) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-arena-flavor-'));
  const fullPath = path.join(root, 'data/mutable/game_data/runtime_state.json');
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify({ elapsed_weeks: 3, [ARENA_TOURNAMENT_STATE_KEY]: slot }, null, 2)}\n`, 'utf8');
  return root;
}
async function readSlot(root) {
  const state = JSON.parse(await fs.readFile(path.join(root, 'data/mutable/game_data/runtime_state.json'), 'utf8'));
  return state[ARENA_TOURNAMENT_STATE_KEY];
}

test('generateArenaMatchIntro generates once, persists to the slot, and is idempotent on re-request', async (t) => {
  const slot = buildSlot({ mode: 'solo', opponents: opponentInputs(15) });
  const playerMatch = findPlayerCurrentMatch(slot);
  const root = await flavorRoot(slot);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { fetchImpl, state } = countingMockFetch();

  const first = await generateArenaMatchIntro({ root, config: mockLmConfig(), fetchImpl, matchId: playerMatch.match_id });
  assert.equal(first.intro, '星の残光が集いし刻、開幕の一戦が始まる。');
  assert.equal(state.calls, 1);
  assert.equal((await readSlot(root)).match_intros[playerMatch.match_id], first.intro);

  const second = await generateArenaMatchIntro({ root, config: mockLmConfig(), fetchImpl, matchId: playerMatch.match_id });
  assert.equal(second.intro, first.intro);
  assert.equal(state.calls, 1, 'the persisted intro is returned without a second LM call');
});

test('a match-intro generation failure persists nothing (independent of combat state)', async (t) => {
  const slot = buildSlot({ mode: 'solo', opponents: opponentInputs(15) });
  const playerMatch = findPlayerCurrentMatch(slot);
  const root = await flavorRoot(slot);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await assert.rejects(() => generateArenaMatchIntro({ root, config: mockLmConfig(), fetchImpl: failingFetch(), matchId: playerMatch.match_id }));
  assert.deepEqual((await readSlot(root)).match_intros, {}, 'no intro was written');
});

test('generateArenaTournamentResultFlavor is terminal-gated and idempotent', async (t) => {
  const active = buildSlot({ mode: 'solo', opponents: opponentInputs(15) });
  const activeRoot = await flavorRoot(active);
  t.after(() => fs.rm(activeRoot, { recursive: true, force: true }));
  await assert.rejects(
    () => generateArenaTournamentResultFlavor({ root: activeRoot, config: mockLmConfig(), fetchImpl: countingMockFetch().fetchImpl }),
    (error) => error.statusCode === 409 && error.errorCode === 'not_terminal'
  );

  const terminal = resolveBracket(buildSlot({ mode: 'solo', opponents: opponentInputs(15) }));
  const root = await flavorRoot(terminal);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { fetchImpl, state } = countingMockFetch();

  const first = await generateArenaTournamentResultFlavor({ root, config: mockLmConfig(), fetchImpl });
  assert.equal(first.outcome, 'champion');
  assert.equal(first.flavor, '地脈の唸りを従え、覇者がここに立つ。');
  assert.equal((await readSlot(root)).result_flavor, first.flavor);

  const second = await generateArenaTournamentResultFlavor({ root, config: mockLmConfig(), fetchImpl });
  assert.equal(second.flavor, first.flavor);
  assert.equal(state.calls, 1, 'the persisted result flavor is returned without a second LM call');
});

// ----- Section C2: write serialization (the flavor persist never clobbers a concurrent action write) -----

// A read-modify-write of a counter file with a forced yield between the read and the write — the shape of the
// arena runtime_state RMW. Serialized through withArenaWriteLock it must never lose an update; the unlocked
// control demonstrates the same interleave DOES lose one (so the lock is load-bearing, not incidental).
async function rmwCounter(root, { locked }) {
  const file = path.join(root, 'counter.json');
  const step = async () => {
    const current = JSON.parse(await fs.readFile(file, 'utf8')).n;
    await new Promise((resolve) => setTimeout(resolve, 5)); // force a scheduler yield between read and write
    await fs.writeFile(file, JSON.stringify({ n: current + 1 }));
  };
  return locked ? withArenaWriteLock(root, step) : step();
}

test('withArenaWriteLock serializes the runtime_state RMW so a concurrent write is never lost', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-arena-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'counter.json');

  await fs.writeFile(file, JSON.stringify({ n: 0 }));
  await Promise.all([rmwCounter(root, { locked: true }), rmwCounter(root, { locked: true })]);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).n, 2, 'the lock prevents the lost update');

  // Control: the same interleave without the lock loses an update — proving the serialization is what protects it.
  await fs.writeFile(file, JSON.stringify({ n: 0 }));
  await Promise.all([rmwCounter(root, { locked: false }), rmwCounter(root, { locked: false })]);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).n, 1, 'without the lock the concurrent RMW loses an update');
});

test('two concurrent intro persists (different matches) both land — no whole-slot clobber', async (t) => {
  // A viewable player match (interactive) + a resolved auto match: both can get an intro concurrently.
  const slot = buildSlot({ mode: 'solo', opponents: opponentInputs(15) });
  const playerMatch = findPlayerCurrentMatch(slot);
  const autoMatch = slot.matches.find((m) => m.round === 0 && m.team_a_unit_id !== slot.player_unit_id && m.team_b_unit_id !== slot.player_unit_id);
  setWinner(slot, autoMatch, autoMatch.team_a_unit_id);
  validateArenaTournamentSlot(slot);
  const root = await flavorRoot(slot);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { fetchImpl } = countingMockFetch();

  await Promise.all([
    generateArenaMatchIntro({ root, config: mockLmConfig(), fetchImpl, matchId: playerMatch.match_id }),
    generateArenaMatchIntro({ root, config: mockLmConfig(), fetchImpl, matchId: autoMatch.match_id })
  ]);
  const intros = (await readSlot(root)).match_intros;
  assert.ok(intros[playerMatch.match_id], 'the player match intro persisted');
  assert.ok(intros[autoMatch.match_id], 'the concurrent auto match intro persisted (not clobbered)');
});

// ----- Section D: HTTP route wiring -----

test('the arena API exposes the two flavor routes and resolves the LM config first (503 propagates)', async (t) => {
  assert.equal(canHandleArenaApiRoute('POST', '/api/arena/match/intro'), true);
  assert.equal(canHandleArenaApiRoute('POST', '/api/arena/result-flavor'), true);

  const slot = buildSlot({ mode: 'solo', opponents: opponentInputs(15) });
  const playerMatch = findPlayerCurrentMatch(slot);
  const root = await flavorRoot(slot);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // The LM config is resolved (ensureLmStudioConversationConfig) BEFORE the session runs — an unconfigured LM
  // (no cached config, no config path) is a clean 503 with nothing consumed.
  await assert.rejects(() => handleArenaApi({
    req: { method: 'POST' },
    res: {},
    url: { pathname: '/api/arena/match/intro' },
    context: { root },
    sendJson: () => {},
    readBody: async () => ({ match_id: playerMatch.match_id }),
    activePlayMode: { mode: 'routing' }
  }), (error) => error.statusCode === 503 && error.errorCode === 'LMSTUDIO_CONFIG_REQUIRED');
  assert.deepEqual((await readSlot(root)).match_intros, {}, 'a 503 config error consumed nothing');

  // A configured LM (cached on the context) drives the intro route end to end. handleArenaApi uses the
  // lmStudioClient default fetch, so stub globalThis.fetch for this one call.
  const { fetchImpl } = countingMockFetch();
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  t.after(() => { globalThis.fetch = realFetch; });
  let captured = null;
  await handleArenaApi({
    req: { method: 'POST' },
    res: {},
    url: { pathname: '/api/arena/match/intro' },
    context: { root, lmStudioConfig: { base_url: 'http://mock.local/v1', chat_model: 'mock-chat', stream: false } },
    sendJson: (_res, body) => { captured = body; },
    readBody: async () => ({ match_id: playerMatch.match_id }),
    activePlayMode: { mode: 'routing' }
  });
  assert.ok(captured && typeof captured.intro === 'string' && captured.intro.length > 0);
  assert.equal((await readSlot(root)).match_intros[playerMatch.match_id], captured.intro);
});
