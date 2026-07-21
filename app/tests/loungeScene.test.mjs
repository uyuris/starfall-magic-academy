// 談話室 authored scene: catalog loads the authored「寮の談話室」+ visible_situation pool from the definitions
// surface, the validator fail-fasts on malformed catalogs, and the week-seed draw is deterministic and pool-bound.

import test from 'node:test';
import assert from 'node:assert/strict';

import { projectRoot } from './testPaths.mjs';
import {
  loadLoungeSceneCatalog,
  validateLoungeSceneCatalog,
  selectLoungeVisibleSituation,
  resolveLoungeScene
} from '../src/llm/loungeScene.mjs';

test('the authored lounge scene catalog loads with the fixed location and a pool of at least ten situations', async () => {
  const catalog = await loadLoungeSceneCatalog({ root: projectRoot });
  assert.equal(catalog.location_name, '寮の談話室');
  assert.ok(catalog.visible_situations.length >= 10, 'the authored pool has at least ten situations');
  assert.equal(new Set(catalog.visible_situations).size, catalog.visible_situations.length, 'situations are distinct');
  for (const situation of catalog.visible_situations) {
    assert.equal(typeof situation, 'string');
    assert.ok(situation.trim().length > 0);
  }
});

test('the lounge scene validator fail-fasts on malformed catalogs', () => {
  assert.throws(() => validateLoungeSceneCatalog(null), /must be an object/);
  assert.throws(() => validateLoungeSceneCatalog({ location_name: '', visible_situations: [] }), /location_name is required/);
  assert.throws(() => validateLoungeSceneCatalog({ location_name: '寮の談話室', visible_situations: 'x' }), /must be an array/);
  assert.throws(() => validateLoungeSceneCatalog({ location_name: '寮の談話室', visible_situations: ['a', 'b'] }), /at least/);
  const eight = Array.from({ length: 8 }, (_, index) => `情景${index}`);
  assert.throws(() => validateLoungeSceneCatalog({ location_name: '寮の談話室', visible_situations: [...eight.slice(0, 7), eight[0]] }), /duplicate/);
  assert.throws(() => validateLoungeSceneCatalog({ location_name: '寮の談話室', visible_situations: eight, extra: true }), /unexpected key/);
});

test('the week-seed visible_situation draw is deterministic, week-varying, and drawn from the pool', async () => {
  const catalog = await loadLoungeSceneCatalog({ root: projectRoot });
  const week4a = selectLoungeVisibleSituation({ catalog, week: 4 });
  const week4b = selectLoungeVisibleSituation({ catalog, week: 4 });
  assert.equal(week4a, week4b, 'the same week draws the same situation');
  assert.ok(catalog.visible_situations.includes(week4a), 'the draw is from the authored pool');

  const drawn = new Set();
  for (let week = 0; week < 20; week += 1) {
    drawn.add(selectLoungeVisibleSituation({ catalog, week }));
  }
  assert.ok(drawn.size > 1, 'the situation varies across weeks');
});

test('resolveLoungeScene returns the location and the week-drawn situation together', async () => {
  const scene = await resolveLoungeScene({ root: projectRoot, week: 7 });
  assert.equal(scene.location_name, '寮の談話室');
  const catalog = await loadLoungeSceneCatalog({ root: projectRoot });
  assert.equal(scene.visible_situation, selectLoungeVisibleSituation({ catalog, week: 7 }));
});
