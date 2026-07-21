import test from 'node:test';
import assert from 'node:assert/strict';
import { GRADUATION_PHASE2_REENTRY_SCREENS, parseGraduationPhase2Reentry } from '../public/graduationPhase2ReentryClient.js';
import { ROUTING_PERSONA_CHARACTER_ID } from '../public/routingFinalizeClient.js';

// task graduation-phase2-restore-frontend — the pure reader for the in-flight graduation phase-2 re-entry
// contract carried on POST /api/slots/load and GET /api/slots. It gates the load/resume phase-2 re-entry
// branch, so every shape assertion here is a fail-fast that keeps a malformed contract from being read as
// non-phase-2 (which would silently drop the player back to the hub / academy-room and restart graduation).

function guideVisual() {
  return {
    character_id: ROUTING_PERSONA_CHARACTER_ID,
    display_name: 'ルミ',
    visual_set_id: 'routing_lumi_fallen_star',
    face_url: '/canonical/routing/lumi/fallen_star/face_neutral.jpg',
    selection_icon_url: '/canonical/routing/lumi/fallen_star/icon.jpg',
    standee_url: '/canonical/routing/lumi/fallen_star/standee.jpg'
  };
}

function candidateContract(overrides = {}) {
  return { graduation_phase2_reentry: { character_id: 'character_001', screen: 'interaction', last_conversation_id: null, is_guide_persona: false, ...overrides } };
}

function guideContract(overrides = {}) {
  return { graduation_phase2_reentry: { character_id: ROUTING_PERSONA_CHARACTER_ID, screen: 'interaction', last_conversation_id: 'conv_1', is_guide_persona: true, routing_persona_visual: guideVisual(), ...overrides } };
}

test('the closed set of re-entry screens matches the backend entry-screen contract', () => {
  assert.deepEqual([...GRADUATION_PHASE2_REENTRY_SCREENS], ['interaction', 'academy-conversation-session']);
});

test('a null / absent contract resolves to null (the ordinary hub / post-content landing)', () => {
  assert.equal(parseGraduationPhase2Reentry({ graduation_phase2_reentry: null }, '/api/slots/load'), null);
  assert.equal(parseGraduationPhase2Reentry({}, '/api/slots'), null);
  assert.equal(parseGraduationPhase2Reentry(null, '/api/slots'), null);
});

test('a candidate (character_###) contract is returned verbatim with no persona visual', () => {
  const contract = candidateContract();
  const parsed = parseGraduationPhase2Reentry(contract, '/api/slots/load');
  assert.equal(parsed, contract.graduation_phase2_reentry);
  assert.equal(parsed.is_guide_persona, false);
  assert.equal('routing_persona_visual' in parsed, false);
});

test('a guide (lina) contract carries the persona visual and the legacy screen is accepted', () => {
  const parsed = parseGraduationPhase2Reentry(guideContract({ screen: 'academy-conversation-session' }), '/api/slots');
  assert.equal(parsed.is_guide_persona, true);
  assert.equal(parsed.character_id, ROUTING_PERSONA_CHARACTER_ID);
  assert.equal(parsed.screen, 'academy-conversation-session');
  assert.equal(parsed.routing_persona_visual.visual_set_id, 'routing_lumi_fallen_star');
});

test('last_conversation_id accepts a non-empty string or null but rejects an empty string', () => {
  assert.equal(parseGraduationPhase2Reentry(candidateContract({ last_conversation_id: 'conv_9' }), 's').last_conversation_id, 'conv_9');
  assert.throws(() => parseGraduationPhase2Reentry(candidateContract({ last_conversation_id: '' }), 's'), /last_conversation_id/);
});

test('a non-object contract throws (never silently read as non-phase-2)', () => {
  assert.throws(() => parseGraduationPhase2Reentry({ graduation_phase2_reentry: 'interaction' }, 's'), /must be an object or null/);
});

test('an empty / non-string character_id throws', () => {
  assert.throws(() => parseGraduationPhase2Reentry(candidateContract({ character_id: '' }), 's'), /character_id/);
  assert.throws(() => parseGraduationPhase2Reentry(candidateContract({ character_id: 123 }), 's'), /character_id/);
});

test('a screen outside the closed set throws', () => {
  assert.throws(() => parseGraduationPhase2Reentry(candidateContract({ screen: 'academy-room' }), 's'), /screen is outside the closed set/);
  assert.throws(() => parseGraduationPhase2Reentry(candidateContract({ screen: undefined }), 's'), /screen is outside the closed set/);
});

test('a non-boolean is_guide_persona throws', () => {
  assert.throws(() => parseGraduationPhase2Reentry(candidateContract({ is_guide_persona: 'false' }), 's'), /is_guide_persona must be a boolean/);
});

test('is_guide_persona must agree with character_id === the routing persona id', () => {
  // lina but flagged non-guide
  assert.throws(() => parseGraduationPhase2Reentry(guideContract({ is_guide_persona: false, routing_persona_visual: undefined }), 's'), /is_guide_persona must equal character_id/);
  // character_### but flagged guide
  assert.throws(() => parseGraduationPhase2Reentry(candidateContract({ is_guide_persona: true }), 's'), /is_guide_persona must equal character_id/);
});

test('a guide contract missing routing_persona_visual throws', () => {
  assert.throws(() => parseGraduationPhase2Reentry(guideContract({ routing_persona_visual: undefined }), 's'), /missing routing_persona_visual/);
});

test('a candidate contract carrying routing_persona_visual throws', () => {
  assert.throws(() => parseGraduationPhase2Reentry(candidateContract({ routing_persona_visual: guideVisual() }), 's'), /must not carry routing_persona_visual/);
});
