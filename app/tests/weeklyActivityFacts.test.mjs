// Weekly-activity facts: the authored fact lines about a conversation partner's own arena/auction
// participation, and their wiring into the conversation actor-context block. Covers the pure composers
// (participation phrasing, per-round win/loss, 主人公 match, champion, auction awards/流札/non-participant,
// week prefix), the state-reading entry point (slot absence, malformed throw-through, elapsed_weeks gate),
// the actor-context merge, and the prompt wiring (participant shows facts, non-participant does not).

import test from 'node:test';
import assert from 'node:assert/strict';

import { fixtureRoot as createFixtureRoot } from './helpers.mjs';
import { projectRoot } from './testPaths.mjs';
import { ensureSelectableCharacterStorage } from '../src/characterCatalog.mjs';
import {
  buildWeeklyActivityFactSections,
  composeArenaFactSection,
  composeAuctionFactSection,
  appendWeeklyActivityFacts
} from '../src/weeklyActivityFacts.mjs';
import { normalizeConversationActorContext } from '../src/llm/conversationActorContext.mjs';
import {
  arenaWeekSeed,
  assembleArenaUnits,
  createArenaTournamentSlot,
  validateArenaTournamentSlot,
  ARENA_TOURNAMENT_STATE_KEY,
  ARENA_ROUND_COUNT
} from '../src/arena/arenaTournament.mjs';
import {
  ROUTING_AUCTION_STATE_KEY,
  loadAuctionCatalog,
  drawWeeklyAuctionLots,
  buildAuctionSlot,
  recordAuctionLotAward
} from '../src/routingAuction.mjs';
import { runConversationOpening } from '../src/llm/conversationPipeline.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// ---------- hand-built slot shapes (composers do not validate; readers do) ----------

function arenaActor(actorId, name) {
  return { actor_id: actorId, name };
}

function arenaMatch({ id, round, index, teamA, teamB, winner }) {
  return { match_id: id, round, index, team_a_unit_id: teamA, team_b_unit_id: teamB, winner_unit_id: winner, seed: 1 };
}

// ---------- arena composer ----------

test('composeArenaFactSection frames a solo opponent as entering alone', () => {
  const slot = {
    week: 3, mode: 'solo', player_unit_id: 'u0',
    units: [
      { unit_id: 'u0', actors: [arenaActor('protagonist', '主人公')] },
      { unit_id: 'u1', actors: [arenaActor('character_005', 'アリス')] }
    ],
    matches: []
  };
  const section = composeArenaFactSection(slot, 'character_005', 3);
  assert.equal(section.title, '闘技会');
  assert.deepEqual(section.entries[0], { title: '出場', body: '今週の闘技会に一人で出場した。' });
  assert.equal(section.entries.length, 1);
});

test('composeArenaFactSection frames the pair buddy as paired with the protagonist and an opponent by teammate', () => {
  const pair = {
    week: 3, mode: 'pair', player_unit_id: 'u0',
    units: [
      { unit_id: 'u0', actors: [arenaActor('protagonist', '主人公'), arenaActor('character_009', 'ミナ')] },
      { unit_id: 'u1', actors: [arenaActor('character_005', 'アリス'), arenaActor('character_006', 'ボブ')] }
    ],
    matches: []
  };
  assert.equal(composeArenaFactSection(pair, 'character_009', 3).entries[0].body, '今週の闘技会に主人公とペアで出場した。');
  assert.equal(composeArenaFactSection(pair, 'character_005', 3).entries[0].body, '今週の闘技会にボブと組んで出場した。');
});

test('composeArenaFactSection frames a spectate-mode buddy as a solo entry the protagonist watched', () => {
  const spectate = {
    week: 3, mode: 'spectate', player_unit_id: 'u0',
    units: [
      { unit_id: 'u0', actors: [arenaActor('homunculus_003', 'エコー')] },
      { unit_id: 'u1', actors: [arenaActor('character_005', 'アリス')] }
    ],
    matches: []
  };
  assert.equal(
    composeArenaFactSection(spectate, 'homunculus_003', 3).entries[0].body,
    '今週の闘技会に単独で出場した（主人公は観戦していた）。'
  );
});

test('composeArenaFactSection lists per-round win/loss naming opponents, surfaces the 主人公 match, and names the champion', () => {
  const slot = {
    week: 3, mode: 'solo', player_unit_id: 'u0',
    units: [
      { unit_id: 'u0', actors: [arenaActor('protagonist', '主人公')] },
      { unit_id: 'u1', actors: [arenaActor('character_005', 'アリス')] },
      { unit_id: 'u2', actors: [arenaActor('character_006', 'ボブ')] },
      { unit_id: 'u3', actors: [arenaActor('character_007', 'カレン')] }
    ],
    matches: [
      arenaMatch({ id: 'r0_m0', round: 0, index: 0, teamA: 'u1', teamB: 'u2', winner: 'u1' }),
      arenaMatch({ id: 'r1_m0', round: 1, index: 0, teamA: 'u1', teamB: 'u0', winner: 'u0' }),
      arenaMatch({ id: 'r3_m0', round: ARENA_ROUND_COUNT - 1, index: 0, teamA: 'u0', teamB: 'u3', winner: 'u0' })
    ]
  };
  const section = composeArenaFactSection(slot, 'character_005', 3);
  assert.deepEqual(section.entries, [
    { title: '出場', body: '今週の闘技会に一人で出場した。' },
    { title: '1回戦', body: 'ボブと対戦して勝った。' },
    { title: '準々決勝', body: '主人公に敗れた。' },
    { title: '優勝者', body: '主人公が優勝した。' }
  ]);
});

test('composeArenaFactSection states the partner won when its unit takes the final', () => {
  const slot = {
    week: 3, mode: 'solo', player_unit_id: 'u0',
    units: [
      { unit_id: 'u0', actors: [arenaActor('protagonist', '主人公')] },
      { unit_id: 'u1', actors: [arenaActor('character_005', 'アリス')] },
      { unit_id: 'u2', actors: [arenaActor('character_006', 'ボブ')] },
      { unit_id: 'u3', actors: [arenaActor('character_007', 'カレン')] }
    ],
    matches: [
      arenaMatch({ id: 'r0_m0', round: 0, index: 0, teamA: 'u1', teamB: 'u2', winner: 'u1' }),
      arenaMatch({ id: 'r3_m0', round: ARENA_ROUND_COUNT - 1, index: 0, teamA: 'u1', teamB: 'u3', winner: 'u1' })
    ]
  };
  const section = composeArenaFactSection(slot, 'character_005', 3);
  assert.deepEqual(section.entries.at(-2), { title: '決勝', body: 'カレンと対戦して勝った。' });
  assert.deepEqual(section.entries.at(-1), { title: '優勝', body: '今週の闘技会で優勝した。' });
});

test('composeArenaFactSection returns null for a non-entrant', () => {
  const slot = {
    week: 3, mode: 'solo', player_unit_id: 'u0',
    units: [{ unit_id: 'u0', actors: [arenaActor('protagonist', '主人公')] }],
    matches: []
  };
  assert.equal(composeArenaFactSection(slot, 'character_099', 3), null);
});

test('composeArenaFactSection prefixes a past-week slot with 先日 and fails fast on a future week', () => {
  const slot = {
    week: 2, mode: 'solo', player_unit_id: 'u0',
    units: [
      { unit_id: 'u0', actors: [arenaActor('protagonist', '主人公')] },
      { unit_id: 'u1', actors: [arenaActor('character_005', 'アリス')] }
    ],
    matches: []
  };
  assert.equal(composeArenaFactSection(slot, 'character_005', 5).entries[0].body, '先日の闘技会に一人で出場した。');
  assert.throws(() => composeArenaFactSection({ ...slot, week: 6 }, 'character_005', 5), /ahead of the current week/);
});

// ---------- auction composer ----------

function auctionSlotFixture(overrides = {}) {
  return {
    week: 5,
    bidders: [
      { character_id: 'character_004', display_name: 'ノラ' },
      { character_id: 'character_002', display_name: 'リズ' }
    ],
    lots: [
      { lot_index: 0, item: { name: '銀の護符' } },
      { lot_index: 1, item: { name: '古い魔導書' } },
      { lot_index: 2, item: { name: '火竜の卵' } }
    ],
    status: 'closed',
    current_lot_index: 3,
    awards: [
      { lot_index: 0, outcome: 'awarded', winner_character_id: 'player', amount: 900 },
      { lot_index: 1, outcome: 'awarded', winner_character_id: 'character_004', amount: 8500 },
      { lot_index: 2, outcome: 'passed_in', winner_character_id: null, amount: null }
    ],
    ...overrides
  };
}

test('composeAuctionFactSection states each resolved lot from the seated bidder perspective', () => {
  const slot = auctionSlotFixture();
  const forWinner = composeAuctionFactSection(slot, 'character_004', 5);
  assert.equal(forWinner.title, '競売');
  assert.deepEqual(forWinner.entries, [
    { title: '参加', body: '今週の競売に参加した。' },
    { title: '結果', body: '「銀の護符」は主人公が900Gで落札した。' },
    { title: '結果', body: '「古い魔導書」は自分が8500Gで落札した。' },
    { title: '結果', body: '「火竜の卵」は流札した。' }
  ]);

  // The other seated bidder sees the same award named by the winner's display name.
  const forOther = composeAuctionFactSection(slot, 'character_002', 5);
  assert.deepEqual(forOther.entries[2], { title: '結果', body: '「古い魔導書」はノラが8500Gで落札した。' });
});

test('composeAuctionFactSection states only resolved lots and returns null for a non-bidder', () => {
  const partial = auctionSlotFixture({
    status: 'in_progress',
    current_lot_index: 1,
    awards: [{ lot_index: 0, outcome: 'awarded', winner_character_id: 'player', amount: 900 }]
  });
  const section = composeAuctionFactSection(partial, 'character_004', 5);
  assert.deepEqual(section.entries, [
    { title: '参加', body: '今週の競売に参加した。' },
    { title: '結果', body: '「銀の護符」は主人公が900Gで落札した。' }
  ]);
  assert.equal(composeAuctionFactSection(partial, 'character_099', 5), null);
});

test('composeAuctionFactSection prefixes a past-week auction with 先日', () => {
  const slot = auctionSlotFixture({ week: 3 });
  assert.equal(composeAuctionFactSection(slot, 'character_004', 5).entries[0].body, '先日の競売に参加した。');
});

// ---------- state entry point (reads through the real slot readers) ----------

async function validAuctionSlotInState({ week, participantIndex = 0 } = {}) {
  const catalog = await loadAuctionCatalog({ root: projectRoot });
  const roster = Array.from({ length: 8 }, (_, index) => ({
    character_id: `character_${String(index + 1).padStart(3, '0')}`,
    display_name: `キャラ${index + 1}`
  }));
  const draw = drawWeeklyAuctionLots({ week, roster, soldLedger: [], previousLotItemIds: [], catalog });
  let slot = buildAuctionSlot(draw);
  slot = recordAuctionLotAward(slot, { lotIndex: 0, outcome: 'awarded', winnerCharacterId: 'player', amount: slot.lots[0].initial_price });
  return { slot, participantId: draw.bidders[participantIndex].character_id };
}

test('buildWeeklyActivityFactSections returns no sections when neither slot is held', () => {
  assert.deepEqual(buildWeeklyActivityFactSections({}, 'character_005'), []);
});

test('buildWeeklyActivityFactSections propagates a malformed slot throw from the readers', () => {
  assert.throws(() => buildWeeklyActivityFactSections({ [ARENA_TOURNAMENT_STATE_KEY]: { bogus: true } }, 'character_005'));
  assert.throws(() => buildWeeklyActivityFactSections({ [ROUTING_AUCTION_STATE_KEY]: { bogus: true } }, 'character_005'));
});

test('buildWeeklyActivityFactSections composes an auction fact section for a seated bidder', async () => {
  const { slot, participantId } = await validAuctionSlotInState({ week: 5 });
  const sections = buildWeeklyActivityFactSections({ [ROUTING_AUCTION_STATE_KEY]: slot, elapsed_weeks: 5 }, participantId);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].title, '競売');
  assert.equal(sections[0].entries[0].body, '今週の競売に参加した。');
});

test('buildWeeklyActivityFactSections fails fast when a slot is held but elapsed_weeks is missing', async () => {
  const { slot, participantId } = await validAuctionSlotInState({ week: 5 });
  assert.throws(
    () => buildWeeklyActivityFactSections({ [ROUTING_AUCTION_STATE_KEY]: slot }, participantId),
    /elapsed_weeks must be a non-negative integer/
  );
});

// ---------- actor-context merge ----------

test('appendWeeklyActivityFacts appends fact sections after the base sections and stays a valid actor context', async () => {
  const base = { sections: [{ title: '好感度', entries: [{ title: '主人公への好感度', body: '主人公への好感度: 25/100' }] }] };
  const { slot, participantId } = await validAuctionSlotInState({ week: 5 });
  const merged = appendWeeklyActivityFacts(base, { [ROUTING_AUCTION_STATE_KEY]: slot, elapsed_weeks: 5 }, participantId);
  assert.equal(merged.sections[0].title, '好感度');
  assert.equal(merged.sections[1].title, '競売');
  // The merged shape must satisfy the actor-context normalizer used by the prompt renderer.
  assert.doesNotThrow(() => normalizeConversationActorContext(merged));
});

test('appendWeeklyActivityFacts returns the base unchanged when there are no facts and null when nothing contributes', () => {
  const base = { sections: [{ title: '好感度', entries: [{ title: 't', body: 'b' }] }] };
  const noFacts = appendWeeklyActivityFacts(base, {}, 'character_004');
  assert.deepEqual(noFacts.sections, base.sections);
  assert.equal(appendWeeklyActivityFacts(null, {}, 'character_004'), null);
});

// ---------- prompt wiring ----------

async function fixtureRoot() {
  return createFixtureRoot('magic-adv-weekly-facts-');
}

async function injectRuntimeState(root, patch) {
  const statePath = path.join(root, 'game_data/runtime_state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  await fs.writeFile(statePath, JSON.stringify({ ...state, ...patch }, null, 2));
}

async function openingPromptFor(root, characterId) {
  let captured = '';
  await runConversationOpening({
    root,
    id: `conv_weekly_facts_${characterId}`,
    characterId,
    now: '2026-05-05T06:00:00.000+09:00',
    chatProvider: async ({ prompt }) => {
      captured = prompt;
      return 'はい。';
    }
  });
  return captured;
}

test('a conversation opening injects auction facts for a seated bidder and omits them for a non-participant', async () => {
  const root = await fixtureRoot();
  const { slot, participantId } = await validAuctionSlotInState({ week: 4 });
  await injectRuntimeState(root, { [ROUTING_AUCTION_STATE_KEY]: slot, elapsed_weeks: 4 });
  await ensureSelectableCharacterStorage({ root, characterId: participantId });

  const participantPrompt = await openingPromptFor(root, participantId);
  assert.match(participantPrompt, /会話相手コンテキスト:/);
  assert.match(participantPrompt, /競売:/);
  assert.match(participantPrompt, /今週の競売に参加した。/);

  // lina is not a seated bidder, so no auction facts reach her prompt.
  const nonParticipantPrompt = await openingPromptFor(root, 'lina');
  assert.doesNotMatch(nonParticipantPrompt, /競売:/);
});

test('a conversation opening injects arena facts for a bracket entrant and omits them for a non-participant', async () => {
  const root = await fixtureRoot();
  const opponents = Array.from({ length: 15 }, (_, index) => {
    const id = `character_${String(index + 101).padStart(3, '0')}`;
    return { character_id: id, display_name: `opp-${id}`, parameters: paramsAll(5), mp_reserve_percent: 30 };
  });
  const { playerUnit, opponentUnits } = assembleArenaUnits({
    mode: 'solo',
    protagonist: { parameters: paramsAll(30), equipment: null, mp_reserve_percent: 30 },
    opponents
  });
  const slot = resolveTeamAWins(createArenaTournamentSlot({ seed: arenaWeekSeed(4), week: 4, mode: 'solo', playerUnit, opponentUnits }));
  validateArenaTournamentSlot(slot);
  await injectRuntimeState(root, { [ARENA_TOURNAMENT_STATE_KEY]: slot, elapsed_weeks: 4 });

  const entrantId = 'character_101';
  await ensureSelectableCharacterStorage({ root, characterId: entrantId });
  const entrantPrompt = await openingPromptFor(root, entrantId);
  assert.match(entrantPrompt, /闘技会:/);
  assert.match(entrantPrompt, /今週の闘技会に一人で出場した。/);

  const nonParticipantPrompt = await openingPromptFor(root, 'lina');
  assert.doesNotMatch(nonParticipantPrompt, /闘技会:/);
});

// ---------- arena fixture helpers ----------

const ARENA_ELEMENTS = ['light', 'dark', 'fire', 'water', 'earth', 'wind'];

function paramsAll(value) {
  const magic = Object.fromEntries(ARENA_ELEMENTS.map((key) => [key, { value }]));
  const abilities = {
    strength: { value }, agility: { value }, academics: { value }, magical_power: { value }, charisma: { value }
  };
  return { magic, abilities };
}

// Deterministically resolves the whole bracket by making team_a win every match, propagating each winner
// into its parent slot. Produces a valid, fully-resolved slot without invoking the combat engine.
function resolveTeamAWins(slot) {
  for (let round = 0; round < ARENA_ROUND_COUNT; round += 1) {
    for (const match of slot.matches.filter((candidate) => candidate.round === round)) {
      const winner = match.team_a_unit_id;
      match.winner_unit_id = winner;
      if (round < ARENA_ROUND_COUNT - 1) {
        const parent = slot.matches.find((candidate) => candidate.match_id === `r${round + 1}_m${Math.floor(match.index / 2)}`);
        parent[match.index % 2 === 0 ? 'team_a_unit_id' : 'team_b_unit_id'] = winner;
      }
    }
  }
  return slot;
}
