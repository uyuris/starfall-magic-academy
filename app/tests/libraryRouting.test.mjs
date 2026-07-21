import test from 'node:test';
import assert from 'node:assert/strict';

import { routingDestinations, parseRoutingDestinationAnswer } from '../src/routingDestinations.mjs';
import { resolveRoutingDestinationDispatch, isRoutingTitleDispatch } from '../src/routingDispatch.mjs';
import { routingDestinationsForState } from '../src/routingDestinationSelection.mjs';
import {
  buildLibraryContentResult,
  buildWorkshopContentResult,
  validateRoutingContentResult
} from '../src/routingContentResult.mjs';

const NOW = '2026-07-07T00:00:00.000Z';

function validLibraryRecord() {
  return {
    kind: 'library',
    destination_id: 'library',
    week: 8,
    recorded_at: NOW,
    trigger: 'library_reading_committed',
    detail: {
      outcome: 'completed',
      books: [
        { book_id: 'core_starfall_principle', title: '星降りの理', category: '世界の理', layer: 'core' },
        { book_id: 'periphery_essay_01', title: '星降りの晩の散歩', category: '随筆・紀行', layer: 'periphery' },
        { book_id: null, title: '自由枠の写本', category: '生成', layer: 'generated' }
      ]
    }
  };
}

// ----- catalog / dispatch / selection -----

test('library is a published routing destination that dispatches to academy-library as a normal week-progressing destination', () => {
  const entry = routingDestinations.find((destination) => destination.id === 'library');
  assert.ok(entry, 'library is in the routing catalog');
  assert.equal(entry.label, '大書庫');
  assert.ok(entry.description.length > 0);

  const parsed = parseRoutingDestinationAnswer('library');
  assert.equal(parsed.id, 'library');

  const dispatch = resolveRoutingDestinationDispatch('library');
  assert.equal(dispatch.next_screen, 'academy-library');
  assert.equal(dispatch.destination_label, '大書庫');
  // A normal content destination: not the neutral title exit.
  assert.equal(isRoutingTitleDispatch(dispatch), false);
});

test('library is offered in the default routing candidate set', () => {
  const candidates = routingDestinationsForState({ elapsed_weeks: 0 });
  assert.equal(candidates.some((destination) => destination.id === 'library'), true);
});

// ----- content result kind -----

test('buildLibraryContentResult builds a valid library record from the books read', () => {
  const books = validLibraryRecord().detail.books;
  const record = buildLibraryContentResult({ week: 8, now: NOW, books });
  assert.equal(record.kind, 'library');
  assert.equal(record.destination_id, 'library');
  assert.equal(record.trigger, 'library_reading_committed');
  assert.equal(record.week, 8);
  assert.deepEqual(record.detail, { outcome: 'completed', books });
  // the returned books are a faithful copy, not the caller's array
  assert.notEqual(record.detail.books, books);
});

test('buildLibraryContentResult requires a non-empty books array', () => {
  assert.throws(() => buildLibraryContentResult({ week: 8, now: NOW, books: [] }), /non-empty books array/);
  assert.throws(() => buildLibraryContentResult({ week: 8, now: NOW, books: null }), /requires a books array/);
});

test('validateRoutingContentResult enforces the library detail shape strictly', () => {
  assert.doesNotThrow(() => validateRoutingContentResult(validLibraryRecord()));

  const wrongDestination = validLibraryRecord();
  wrongDestination.destination_id = 'workshop';
  assert.throws(() => validateRoutingContentResult(wrongDestination), /destination_id must be 'library'/);

  const wrongTrigger = validLibraryRecord();
  wrongTrigger.trigger = 'workshop_craft_completed';
  assert.throws(() => validateRoutingContentResult(wrongTrigger), /trigger must be 'library_reading_committed'/);

  const badOutcome = validLibraryRecord();
  badOutcome.detail.outcome = 'partial';
  assert.throws(() => validateRoutingContentResult(badOutcome), /outcome must be 'completed'/);

  const extraDetailKey = validLibraryRecord();
  extraDetailKey.detail.note = 'x';
  assert.throws(() => validateRoutingContentResult(extraDetailKey), /has unexpected key: note/);

  const emptyBooks = validLibraryRecord();
  emptyBooks.detail.books = [];
  assert.throws(() => validateRoutingContentResult(emptyBooks), /non-empty books array/);

  const generatedWithId = validLibraryRecord();
  generatedWithId.detail.books = [{ book_id: 'x', title: 't', category: 'c', layer: 'generated' }];
  assert.throws(() => validateRoutingContentResult(generatedWithId), /generated book book_id must be null/);

  const coreWithoutId = validLibraryRecord();
  coreWithoutId.detail.books = [{ book_id: null, title: 't', category: 'c', layer: 'core' }];
  assert.throws(() => validateRoutingContentResult(coreWithoutId), /core book requires a non-empty book_id/);

  const badBookKey = validLibraryRecord();
  badBookKey.detail.books = [{ book_id: 'core_starfall_principle', title: 't', category: 'c', layer: 'core', text: 'leak' }];
  assert.throws(() => validateRoutingContentResult(badBookKey), /has unexpected key: text/);

  const badLayer = validLibraryRecord();
  badLayer.detail.books = [{ book_id: 'x', title: 't', category: 'c', layer: 'archive' }];
  assert.throws(() => validateRoutingContentResult(badLayer), /layer must be one of/);
});

test('adding the library kind does not disturb an existing content-result kind', () => {
  const workshop = buildWorkshopContentResult({
    week: 4,
    now: NOW,
    recipeId: 'craft_weapon_sword_fire_t2',
    instance: {
      instance_id: 'equip_w4', kind: 'weapon', weapon_type: 'sword', element: 'fire', tier: 2,
      quality: 'masterwork', name: '紅蓮の一刀', flavor: '熾火を宿した刃。',
      base_effects: { attack: 7 }, bonus_effects: { attack: 3 }
    }
  });
  assert.equal(workshop.kind, 'workshop');
  assert.doesNotThrow(() => validateRoutingContentResult(workshop));
});
