import test from 'node:test';
import assert from 'node:assert/strict';
import { diaryRequestPath, parseDiaryEntries } from '../public/diaryViewClient.js';

test('diaryRequestPath encodes the character id into the read query', () => {
  assert.equal(diaryRequestPath('character_007'), '/api/diary?character_id=character_007');
  assert.equal(diaryRequestPath('lina'), '/api/diary?character_id=lina');
});

test('diaryRequestPath fails fast on a missing or non-string character id (no silent fallback)', () => {
  assert.throws(() => diaryRequestPath(''), /non-empty character_id/);
  assert.throws(() => diaryRequestPath(undefined), /non-empty character_id/);
  assert.throws(() => diaryRequestPath(null), /non-empty character_id/);
  assert.throws(() => diaryRequestPath(7), /non-empty character_id/);
});

test('parseDiaryEntries returns entries in the received order without re-sorting (backend owns chronology)', () => {
  const payload = {
    character_id: 'character_003',
    entries: [
      { id: 'conv_2', type: 'memory', text: '二番目の記憶', source_conversation_id: 'c2', work_record_id: null, tags: [] },
      { id: 'conv_1', type: 'memory', text: '一番目の記憶', source_conversation_id: 'c1', work_record_id: null, tags: ['x'] },
      { id: 'mem_9', type: 'memory', text: '三番目の記憶', source_conversation_id: 'c3', work_record_id: 'w1', tags: [] }
    ]
  };
  const entries = parseDiaryEntries(payload);
  // Order is preserved exactly as received — no id/prefix re-sort on the client.
  assert.deepEqual(entries.map((entry) => entry.text), ['二番目の記憶', '一番目の記憶', '三番目の記憶']);
  // The very same array is returned (identity), so nothing is copied/transformed that could drop entries/fields.
  assert.equal(entries, payload.entries);
});

test('parseDiaryEntries accepts an existing character with zero memories (empty is a valid state, not an error)', () => {
  assert.deepEqual(parseDiaryEntries({ character_id: 'character_050', entries: [] }), []);
});

test('parseDiaryEntries fails fast on a broken response shape (never a silent empty list)', () => {
  assert.throws(() => parseDiaryEntries(null), /must be an object/);
  assert.throws(() => parseDiaryEntries('nope'), /must be an object/);
  assert.throws(() => parseDiaryEntries({ character_id: 'x' }), /entries array/);
  assert.throws(() => parseDiaryEntries({ entries: 'nope' }), /entries array/);
  assert.throws(() => parseDiaryEntries({ entries: [null] }), /entry must be an object/);
  assert.throws(() => parseDiaryEntries({ entries: [{ id: 'a' }] }), /text string/);
  assert.throws(() => parseDiaryEntries({ entries: [{ text: 123 }] }), /text string/);
});
