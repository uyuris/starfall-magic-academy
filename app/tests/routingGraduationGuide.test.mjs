import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeRoutingGraduationGuideContext,
  normalizeGraduationGuidePersonaOption,
  parseGraduationGuideSelectionAnswer,
  buildGraduationGuideSelectionNarration
} from '../src/routingGraduationGuide.mjs';

const CANDIDATES = [
  { character_id: 'character_003', display_name: 'みっつめ' },
  { character_id: 'character_002', display_name: 'ふたつめ' },
  { character_id: 'character_001', display_name: 'ひとつめ' }
];

// The guide persona (案内人自身) is the always-present option alongside the memory-ranked candidates: its id is
// the fixed routing persona actor id, its display name the effective variant proper name.
const GUIDE_PERSONA = { character_id: 'lina', display_name: 'ルミ' };

test('normalizeRoutingGraduationGuideContext passes undefined through and validates a present value', () => {
  assert.equal(normalizeRoutingGraduationGuideContext(undefined), undefined);
  assert.deepEqual(
    normalizeRoutingGraduationGuideContext({ candidates: CANDIDATES }),
    { candidates: CANDIDATES }
  );
  assert.throws(() => normalizeRoutingGraduationGuideContext({ candidates: [] }), /non-empty array/);
  assert.throws(
    () => normalizeRoutingGraduationGuideContext({ candidates: [{ character_id: 'lina', display_name: 'x' }] }),
    /must be a character id/
  );
  assert.throws(
    () => normalizeRoutingGraduationGuideContext({ candidates: [{ character_id: 'character_001', display_name: '' }] }),
    /display_name is required/
  );
  assert.throws(
    () => normalizeRoutingGraduationGuideContext({ candidates: [CANDIDATES[0], CANDIDATES[0]] }),
    /duplicate character ids/
  );
});

test('normalizeGraduationGuidePersonaOption accepts the routing persona option and rejects a non-persona / empty one', () => {
  assert.deepEqual(normalizeGraduationGuidePersonaOption(GUIDE_PERSONA), GUIDE_PERSONA);
  assert.throws(() => normalizeGraduationGuidePersonaOption(null), /must be an object/);
  assert.throws(
    () => normalizeGraduationGuidePersonaOption({ character_id: 'character_001', display_name: 'x' }),
    /character_id must be lina/
  );
  assert.throws(
    () => normalizeGraduationGuidePersonaOption({ character_id: 'lina', display_name: '' }),
    /display_name is required/
  );
});

test('parseGraduationGuideSelectionAnswer resolves a candidate id, the guide persona, none, and rejects an off-list answer', () => {
  assert.deepEqual(parseGraduationGuideSelectionAnswer('character_002', CANDIDATES, GUIDE_PERSONA), CANDIDATES[1]);
  // The guide persona (案内人自身) is a permanent option outside the candidate list.
  assert.deepEqual(parseGraduationGuideSelectionAnswer('lina', CANDIDATES, GUIDE_PERSONA), GUIDE_PERSONA);
  assert.equal(parseGraduationGuideSelectionAnswer('none', CANDIDATES, GUIDE_PERSONA), null);
  assert.equal(parseGraduationGuideSelectionAnswer('None', CANDIDATES, GUIDE_PERSONA), null);
  assert.throws(() => parseGraduationGuideSelectionAnswer('character_099', CANDIDATES, GUIDE_PERSONA), /unknown graduation guide selection/);
  assert.throws(() => parseGraduationGuideSelectionAnswer('', CANDIDATES, GUIDE_PERSONA), /answer is required/);
  // The guide persona option is required (always presented), so a missing/malformed one fail-fasts.
  assert.throws(() => parseGraduationGuideSelectionAnswer('lina', CANDIDATES), /persona option must be an object/);
});

test('buildGraduationGuideSelectionNarration names the chosen partner (candidate or guide persona)', () => {
  assert.equal(
    buildGraduationGuideSelectionNarration(CANDIDATES[0]),
    '卒業の締めくくりを共に過ごす相手はみっつめに決まった。'
  );
  assert.equal(
    buildGraduationGuideSelectionNarration(GUIDE_PERSONA),
    '卒業の締めくくりを共に過ごす相手はルミに決まった。'
  );
  assert.throws(() => buildGraduationGuideSelectionNarration({ character_id: 'lina', display_name: '' }), /display_name is required/);
});
