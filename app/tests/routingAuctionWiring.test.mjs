import test from 'node:test';
import assert from 'node:assert/strict';

import { routingDestinations, isGatedRoutingDestination, buildRoutingDestinationNarration } from '../src/routingDestinations.mjs';
import { routingDestinationsForState } from '../src/routingDestinationSelection.mjs';
import { resolveRoutingDestinationDispatch } from '../src/routingDispatch.mjs';
import { buildRoutingMetaContext } from '../src/routingMetaContext.mjs';
import { buildAuctionContentResult } from '../src/routingContentResult.mjs';

// The auction (競売場) routing wiring: the destination catalog entry, the dispatch target, and the closed-auction
// content-result hub narration branch. These are the three seams the frontend auction screen depends on.

test('競売場 is a non-gated routing destination with a unique label and description', () => {
  const auction = routingDestinations.find((destination) => destination.id === 'auction');
  assert.ok(auction, 'the auction destination exists in the catalog');
  assert.equal(auction.label, '競売場');
  assert.ok(auction.description.length > 0, 'the auction destination carries a description');
  assert.equal(isGatedRoutingDestination('auction'), false, 'the auction is not gated (always offered)');
  // The label + description are unique in the catalog (validateRoutingDestinations enforces this at build time).
  assert.equal(routingDestinations.filter((d) => d.label === '競売場').length, 1, 'the 競売場 label is unique');
  assert.equal(routingDestinations.filter((d) => d.description === auction.description).length, 1, 'the auction description is unique');
  assert.match(buildRoutingDestinationNarration(auction), /行き先は競売場に決まった/, 'the destination narration names 競売場');
});

test('the auction is in the default candidate set and renders its catalog line in the hub meta context', () => {
  const ids = routingDestinationsForState({ elapsed_weeks: 6 }).map((destination) => destination.id);
  assert.ok(ids.includes('auction'), 'auction is a default (non-gated) candidate');
  const context = buildRoutingMetaContext({ state: { elapsed_weeks: 6 } });
  const auction = routingDestinations.find((destination) => destination.id === 'auction');
  assert.ok(context.includes(`競売場: ${auction.description}`), 'the hub meta context renders the 競売場 destination line');
});

test('resolveRoutingDestinationDispatch maps auction to the academy-auction screen', () => {
  const dispatch = resolveRoutingDestinationDispatch('auction');
  assert.equal(dispatch.destination_id, 'auction');
  assert.equal(dispatch.destination_label, '競売場');
  assert.equal(dispatch.next_screen, 'academy-auction');
  assert.deepEqual(dispatch.transition, { next_screen: 'academy-auction' });
});

// The base hub context shape (mirrors the arena test fixture): every required sub-context present so the only
// variable under test is content_result_context.
const BASE_HUB_CONTEXT = {
  persona_variant: 'fallen_star',
  recent_conversation_context: { kind: 'no_new_conversation', conversation_id: null, character_id: null, character_name: null, memory_text: null },
  relationship_context: { buddy: null, enemies: [] },
  alchemy_context: { recipe_count: 10 },
  study_circle_context: { theme_count: 20, weekly_offer_count: 3 },
  content_result_context: null
};

test('a closed-auction content result renders a one-line hub summary (kind auction branch does not throw)', () => {
  const record = buildAuctionContentResult({
    week: 6,
    now: '2026-07-10T00:00:00.000Z',
    lots: [
      { item_name: '番所の封蝋菓子', category: 'treasure', band: 'C', result: 'won_by_player', price: 450, winner_display_name: null },
      { item_name: '業物の剣', category: 'weapon_amulet', band: 'B', result: 'won_by_other', price: 2100, winner_display_name: 'セラ' },
      { item_name: '星図の天球儀', category: 'flavor', band: 'A', result: 'passed_in', price: null, winner_display_name: null }
    ]
  });
  const context = buildRoutingMetaContext({
    state: { elapsed_weeks: 6 },
    routingHubContext: { ...BASE_HUB_CONTEXT, content_result_context: { record, companion: null } }
  });
  // The single summary line names each lot's outcome and the player's own winnings — the hub prompt must build
  // (not throw) after a closed auction writes its content result.
  assert.match(context, /直近コンテンツ結果: 競売場（全3ロット）/, 'the auction content result renders a summary line');
  assert.match(context, /「番所の封蝋菓子」（C帯）を450Gで自分が落札/, 'a player-won lot is summarized with its price');
  assert.match(context, /「業物の剣」（B帯）はセラが2100Gで落札/, 'an NPC-won lot names the winner');
  assert.match(context, /「星図の天球儀」（A帯）は流札/, 'a passed-in lot is summarized as 流札');
  assert.match(context, /自分の落札品: 「番所の封蝋菓子」/, 'the line summarizes the player winnings');
});
