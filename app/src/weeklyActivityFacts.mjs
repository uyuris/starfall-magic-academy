import { readArenaTournamentSlot, ARENA_ROUND_COUNT } from './arena/arenaTournament.mjs';
import { readAuctionSlot } from './routingAuction.mjs';

// Weekly-activity facts: authored (never LLM-generated) fact lines about the conversation partner's own
// participation in the current runtime state's arena tournament and auction. They are composed into extra
// conversation-actor-context sections so the partner's dialogue prompt can mention "who I beat / lost to"
// and "what was won at auction". Facts only — no interpretation, no evaluation; whether and how to bring
// them up is left to the model. Nothing here writes memory or state; it is a pure projection of the read
// slots. The partner is matched to a slot by dialogue actor id: an arena unit actor_id (character or
// homunculus) or an auction bidder character_id. An actor in neither slot yields no section.

const NAME_SEPARATOR = '・';

function requiredActorId(actorId) {
  if (typeof actorId !== 'string' || !actorId.trim()) {
    throw new Error('weekly activity facts require a dialogue actor id');
  }
  return actorId;
}

function currentWeekFromState(state) {
  const week = state.elapsed_weeks;
  if (!Number.isInteger(week) || week < 0) {
    throw new Error(`runtime_state.elapsed_weeks must be a non-negative integer: ${week}`);
  }
  return week;
}

// 「今週」 when the slot is this week, 「先日」 when it is an earlier week. A slot week ahead of the current
// week is an inconsistent state and fails fast rather than being mislabeled.
function weekPrefixLabel(slotWeek, currentWeek) {
  if (slotWeek === currentWeek) return '今週';
  if (slotWeek < currentWeek) return '先日';
  throw new Error(`weekly activity slot week ${slotWeek} is ahead of the current week ${currentWeek}`);
}

// Standard Japanese bracket naming counted back from the final, so it holds for any bracket depth:
// 決勝 / 準決勝 / 準々決勝, and 「N回戦」 for earlier rounds.
function arenaRoundLabel(round, roundCount) {
  const fromFinal = roundCount - 1 - round;
  if (fromFinal === 0) return '決勝';
  if (fromFinal === 1) return '準決勝';
  if (fromFinal === 2) return '準々決勝';
  return `${round + 1}回戦`;
}

function arenaUnitById(slot, unitId) {
  const unit = slot.units.find((candidate) => candidate.unit_id === unitId);
  if (!unit) throw new Error(`arena tournament unit not found: ${unitId}`);
  return unit;
}

function arenaUnitActorNames(slot, unitId) {
  return arenaUnitById(slot, unitId).actors.map((actor) => actor.name).join(NAME_SEPARATOR);
}

// The fact section for the partner's own arena unit, or null when the partner is not an entrant this week.
export function composeArenaFactSection(slot, actorId, currentWeek) {
  const unit = slot.units.find((candidate) => candidate.actors.some((actor) => actor.actor_id === actorId));
  if (!unit) return null;

  const prefix = weekPrefixLabel(slot.week, currentWeek);
  const isPlayerUnit = unit.unit_id === slot.player_unit_id;
  const entries = [];

  // Participation: how the partner entered. The player-unit buddy in pair/spectate mode is framed by the
  // protagonist's presence; every other entrant (opponent units, and any 1-actor unit) is framed by its own
  // roster.
  let participation;
  if (isPlayerUnit && slot.mode === 'pair') {
    participation = `${prefix}の闘技会に主人公とペアで出場した。`;
  } else if (isPlayerUnit && slot.mode === 'spectate') {
    participation = `${prefix}の闘技会に単独で出場した（主人公は観戦していた）。`;
  } else {
    const teammateNames = unit.actors
      .filter((actor) => actor.actor_id !== actorId)
      .map((actor) => actor.name)
      .join(NAME_SEPARATOR);
    participation = teammateNames
      ? `${prefix}の闘技会に${teammateNames}と組んで出場した。`
      : `${prefix}の闘技会に一人で出場した。`;
  }
  entries.push({ title: '出場', body: participation });

  // Per-round progress: every resolved match the unit played, oldest round first. Naming the opposing unit's
  // actors is also how a match against 主人公's unit surfaces (its actors include 主人公).
  const unitMatches = slot.matches
    .filter((match) => (
      (match.team_a_unit_id === unit.unit_id || match.team_b_unit_id === unit.unit_id)
      && match.winner_unit_id !== null
    ))
    .sort((a, b) => a.round - b.round);
  for (const match of unitMatches) {
    const opponentUnitId = match.team_a_unit_id === unit.unit_id ? match.team_b_unit_id : match.team_a_unit_id;
    if (opponentUnitId === null) throw new Error(`resolved arena match has an unknown opponent: ${match.match_id}`);
    const opponentNames = arenaUnitActorNames(slot, opponentUnitId);
    const won = match.winner_unit_id === unit.unit_id;
    entries.push({
      title: arenaRoundLabel(match.round, ARENA_ROUND_COUNT),
      body: won ? `${opponentNames}と対戦して勝った。` : `${opponentNames}に敗れた。`
    });
  }

  // Champion: the resolved final decides the tournament. The partner's own win is stated plainly; otherwise
  // the winning unit is named.
  const finalMatch = slot.matches.find((match) => match.round === ARENA_ROUND_COUNT - 1);
  if (finalMatch && finalMatch.winner_unit_id !== null) {
    if (finalMatch.winner_unit_id === unit.unit_id) {
      entries.push({ title: '優勝', body: `${prefix}の闘技会で優勝した。` });
    } else {
      entries.push({ title: '優勝者', body: `${arenaUnitActorNames(slot, finalMatch.winner_unit_id)}が優勝した。` });
    }
  }

  return { title: '闘技会', entries };
}

function auctionWinnerLabel(winnerId, actorId, bidders) {
  if (winnerId === 'player') return '主人公';
  if (winnerId === actorId) return '自分';
  const bidder = bidders.find((candidate) => candidate.character_id === winnerId);
  if (!bidder) throw new Error(`auction award winner is not a seated bidder: ${winnerId}`);
  return bidder.display_name;
}

// The fact section for the partner's auction attendance, or null when the partner did not sit as a bidder
// this week. Only resolved lots (present in awards) are stated; in-progress lots carry no fact.
export function composeAuctionFactSection(slot, actorId, currentWeek) {
  const seated = slot.bidders.some((bidder) => bidder.character_id === actorId);
  if (!seated) return null;

  const prefix = weekPrefixLabel(slot.week, currentWeek);
  const entries = [{ title: '参加', body: `${prefix}の競売に参加した。` }];

  for (const award of slot.awards) {
    const itemName = slot.lots[award.lot_index].item.name;
    if (award.outcome === 'passed_in') {
      entries.push({ title: '結果', body: `「${itemName}」は流札した。` });
    } else {
      const winnerLabel = auctionWinnerLabel(award.winner_character_id, actorId, slot.bidders);
      entries.push({ title: '結果', body: `「${itemName}」は${winnerLabel}が${award.amount}Gで落札した。` });
    }
  }

  return { title: '競売', entries };
}

// The weekly-activity fact sections for a dialogue actor, from the current runtime state. Empty array when
// the actor is in neither this week's arena nor auction (or neither is held). Slot readers validate the
// slots and throw on a present-but-malformed slot; that throw is not swallowed.
export function buildWeeklyActivityFactSections(state, actorId) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('runtime state is required to build weekly activity facts');
  }
  const id = requiredActorId(actorId);
  const arenaSlot = readArenaTournamentSlot(state);
  const auctionSlot = readAuctionSlot(state);
  if (!arenaSlot && !auctionSlot) return [];

  const currentWeek = currentWeekFromState(state);
  const sections = [];
  if (arenaSlot) {
    const arenaSection = composeArenaFactSection(arenaSlot, id, currentWeek);
    if (arenaSection) sections.push(arenaSection);
  }
  if (auctionSlot) {
    const auctionSection = composeAuctionFactSection(auctionSlot, id, currentWeek);
    if (auctionSection) sections.push(auctionSection);
  }
  return sections;
}

// Merges the weekly-activity fact sections onto a base conversation-actor-context snapshot (affinity + magic
// knowledge). Base sections keep their leading, KV-cache-stable position; fact sections are appended. Returns
// null when neither the base nor the facts contribute a section, matching the snapshot's null contract so an
// empty result renders no actor-context block.
export function appendWeeklyActivityFacts(baseContext, state, actorId) {
  const factSections = buildWeeklyActivityFactSections(state, actorId);
  const baseSections = baseContext?.sections ?? [];
  const sections = [...baseSections, ...factSections];
  if (sections.length === 0) return null;
  return { sections };
}
