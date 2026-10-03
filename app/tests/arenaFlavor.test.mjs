// 残す (a): 闘技会の口上・実況の保存が runtime_state の並行 read-modify-write で他の書き込みを失わせ、slot を丸ごと書き潰す壊れ方から、プレイヤーの slot を守る。
// 闘技会 LLM flavor の保存の直列化: 口上の保存は runtime_state の read-modify-write で、並行する書き込みを失わせない。
// No live LM — the session tests use a deterministic mock fetchImpl.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  ARENA_ROUND_COUNT, ARENA_TOURNAMENT_STATE_KEY,
  arenaWeekSeed, assembleArenaUnits, createArenaTournamentSlot, validateArenaTournamentSlot,
  findPlayerCurrentMatch
} from '../src/arena/arenaTournament.mjs';
import { generateArenaMatchIntro, withArenaWriteLock } from '../src/arena/arenaSession.mjs';

const ELEMENTS = ['light', 'dark', 'fire', 'water', 'earth', 'wind'];

function params(value) {
  const magic = Object.fromEntries(ELEMENTS.map((key) => [key, { value }]));
  const abilities = { strength: { value }, agility: { value }, academics: { value }, magical_power: { value }, charisma: { value } };
  return { magic, abilities };
}
function protagonistInput(value) {
  return { parameters: params(value), equipment: null, mp_reserve_percent: 30 };
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

// Manually set a match winner. Mirrors the engine's advancement (winner fills the parent slot) without running combat.
function setWinner(slot, match, winnerUnitId) {
  match.winner_unit_id = winnerUnitId;
  if (match.round < ARENA_ROUND_COUNT - 1) {
    const parent = slot.matches.find((m) => m.match_id === `r${match.round + 1}_m${Math.floor(match.index / 2)}`);
    parent[match.index % 2 === 0 ? 'team_a_unit_id' : 'team_b_unit_id'] = winnerUnitId;
  }
}

// ----- Session generate-and-persist (mock LM) -----

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

// ----- Write serialization (the flavor persist never clobbers a concurrent action write) -----

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
