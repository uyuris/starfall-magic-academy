import test from 'node:test';
import assert from 'node:assert/strict';
import { BUDDY_VIEW_REQUEST_PATH, BUDDY_VIEW_KINDS, parseBuddyView } from '../public/buddyViewClient.js';

test('BUDDY_VIEW_REQUEST_PATH is the atelier-gate-independent relationships buddy read path', () => {
  assert.equal(BUDDY_VIEW_REQUEST_PATH, '/api/relationships/buddy');
});

test('BUDDY_VIEW_KINDS is the closed set of buddy kinds (character | homunculus)', () => {
  assert.deepEqual([...BUDDY_VIEW_KINDS], ['character', 'homunculus']);
});

test('parseBuddyView accepts the legitimate empty state (buddy null)', () => {
  assert.deepEqual(parseBuddyView({ buddy: null }), { buddy: null });
});

test('parseBuddyView accepts a selectable character buddy', () => {
  const view = parseBuddyView({
    buddy: { character_id: 'character_007', kind: 'character', display_name: 'セラ', face_url: '/canonical/x/face.jpg', affinity: 25 }
  });
  assert.deepEqual(view, {
    buddy: { character_id: 'character_007', kind: 'character', display_name: 'セラ', face_url: '/canonical/x/face.jpg', affinity: 25 }
  });
});

test('parseBuddyView accepts a homunculus buddy', () => {
  const view = parseBuddyView({
    buddy: { character_id: 'homunculus_001', kind: 'homunculus', display_name: 'ノクス', face_url: '/canonical/atelier/hp_007.jpg', affinity: 65 }
  });
  assert.equal(view.buddy.kind, 'homunculus');
  assert.equal(view.buddy.character_id, 'homunculus_001');
  assert.equal(view.buddy.display_name, 'ノクス');
  assert.equal(view.buddy.face_url, '/canonical/atelier/hp_007.jpg');
  assert.equal(view.buddy.affinity, 65);
});

test('parseBuddyView fails fast on a malformed envelope (never silently nulled)', () => {
  assert.throws(() => parseBuddyView(null), /must be an object/);
  assert.throws(() => parseBuddyView('nope'), /must be an object/);
  assert.throws(() => parseBuddyView([]), /must be an object/);
  assert.throws(() => parseBuddyView({}), /requires a buddy key/);
});

test('parseBuddyView fails fast on a present-but-broken buddy (no default-value completion)', () => {
  const base = { character_id: 'homunculus_001', kind: 'homunculus', display_name: 'ノクス', face_url: '/x.jpg', affinity: 65 };
  assert.throws(() => parseBuddyView({ buddy: 'nope' }), /must be an object or null/);
  assert.throws(() => parseBuddyView({ buddy: { ...base, kind: 'creature' } }), /kind must be one of/);
  assert.throws(() => parseBuddyView({ buddy: { ...base, kind: undefined } }), /kind must be one of/);
  assert.throws(() => parseBuddyView({ buddy: { ...base, character_id: '' } }), /character_id must be a non-empty string/);
  assert.throws(() => parseBuddyView({ buddy: { ...base, display_name: '' } }), /display_name must be a non-empty string/);
  assert.throws(() => parseBuddyView({ buddy: { ...base, face_url: 123 } }), /face_url must be a non-empty string/);
  assert.throws(() => parseBuddyView({ buddy: { ...base, affinity: 'x' } }), /affinity must be a finite number/);
  assert.throws(() => parseBuddyView({ buddy: { ...base, affinity: Infinity } }), /affinity must be a finite number/);
});
