// 奏楽堂 (concert hall): the routing "奏楽堂" destination orchestration — a stay-type content destination
// of the same family as the 大書庫 (routingLibrary.mjs).
//
// The authored catalog (3 axes / guidance / performer) strict-loads in concertHallCatalog.mjs; the
// 収蔵 mutable surface lives in concertHallPieces.mjs; the content-result shape lives in
// routingContentResult.mjs; the LLM stages live in llm/concertHallGeneration.mjs. This module is the
// feature owner that composes them into arrival, candidate gathering, composition and the commit
// write-path (収蔵 append first, then the content-result merge). The HTTP surface
// (server/concertHallApi.mjs) stays thin.
//
// The S1 candidate materials are gathered from the surfaces the slot already keeps — the latest content
// result, the inventory names, the last ≤3 read books of the 収蔵庫, the current buddy and the elapsed
// weeks — and nothing new is recorded for them: buildConcertHallCandidates reads and never writes.
//
// The LLM is injected as a `generators` object ({ generatePiece }) so this module carries no LM config;
// the API resolves mock vs real. Arrival and 再演 touch no generator, so they succeed with LM unconfigured.
// The outcome is pure lore + 収蔵: no parameter effect, no conversation injection, no screen BGM.

import { loadInventory } from './economy.mjs';
import { loadLibraryCollection } from './libraryCollection.mjs';
import { loadHomunculiSurface } from './homunculusSurface.mjs';
import { isHomunculusIdFormat } from './companionRoster.mjs';
import { appendConcertHallPiece, loadConcertHallPieces, makeConcertHallEntryId } from './concertHallPieces.mjs';
import {
  ROUTING_CONTENT_RESULT_STATE_KEY,
  mergeConcertHallContentResult,
  readRoutingContentResult,
  requireRoutingContentWeek
} from './routingContentResult.mjs';

export const CONCERT_HALL_DESTINATION_ID = 'concert_hall';

const RUNTIME_STATE_PATH = 'game_data/runtime_state.json';
// The 収蔵庫 books offered as materials: the most recently read ones, newest last in the list.
export const CONCERT_HALL_BOOK_CANDIDATE_MAX = 3;

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`concert hall ${label} is required`);
  return value.trim();
}

function requireCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object' || !catalog.axes || !catalog.guidance || !catalog.performer) {
    throw new Error('concert hall catalog is required (loadConcertHallCatalog)');
  }
  return catalog;
}

function assertGenerators(generators) {
  if (!generators || typeof generators !== 'object') throw new Error('concert hall generators are required');
  if (typeof generators.generatePiece !== 'function') throw new Error('concert hall generators.generatePiece must be a function');
  return generators;
}

// The direction label of a stored / composed piece, resolved from the catalog axes. A direction id the
// catalog does not know is corrupt state (the shelf was written against another catalog), not a default.
export function concertHallDirectionLabel(catalog, directionId) {
  const entry = requireCatalog(catalog).axes.directions.find((candidate) => candidate.id === directionId);
  if (!entry) throw new Error(`concert hall direction id is not in the catalog: ${directionId}`);
  return entry.label;
}

// Builds the arrival view: the current week, the performer's display lines (voice withheld — it is a
// prompt instruction, not a display line) and the shelf as identities. No generator, no LM config.
export async function buildConcertHallArrival({ state, storage, catalog } = {}) {
  if (!storage) throw new Error('concert hall arrival requires storage');
  const checkedCatalog = requireCatalog(catalog);
  const week = requireRoutingContentWeek(state);
  const surface = await loadConcertHallPieces({ storage });
  return {
    week,
    performer: {
      name: checkedCatalog.performer.name,
      greeting: checkedCatalog.performer.greeting,
      input_placeholder: checkedCatalog.performer.input_placeholder,
      empty_shelf: checkedCatalog.performer.empty_shelf
    },
    pieces: surface.entries.map((entry) => ({
      entry_id: entry.entry_id,
      title: entry.title,
      direction_label: concertHallDirectionLabel(checkedCatalog, entry.direction_id),
      composed_week: entry.composed_week
    }))
  };
}

// One line naming what the latest content result was, as a material the performer may draw on. Every
// kind of the closed content-result vocabulary has a branch; a kind without one is a desync and throws.
function contentResultEventLabel(record) {
  const { detail } = record;
  switch (record.kind) {
    case 'training':
      return detail.outcome === 'skipped' ? '鍛錬の一週間を休んだ' : '鍛錬に打ち込んだ一週間';
    case 'dungeon': {
      const outcome = { cleared: '踏破した', retreated: '途中で撤退した', dead: '全滅して戻った' }[detail.outcome];
      if (!outcome) throw new Error(`concert hall event label has no dungeon outcome: ${detail.outcome}`);
      return `ダンジョンを${detail.floor_reached}階まで進み、${outcome}`;
    }
    case 'errand':
      return detail.achieved ? `依頼「${detail.title}」を達成した` : `依頼「${detail.title}」を果たせなかった`;
    case 'alchemy':
      return `調合で「${detail.name}」を仕上げた`;
    case 'study_circle':
      return detail.achieved ? `研究会「${detail.theme_name}」で成果を得た` : `研究会「${detail.theme_name}」に加わった`;
    case 'workshop':
      return `工房で「${detail.name}」を打ち上げた`;
    case 'library':
      return `大書庫で${detail.books.map((book) => `『${book.title}』`).join('・')}を読んだ`;
    case 'homunculus': {
      const action = { created: 'を錬成した', conversation: 'と言葉を交わした', farewell: 'に別れを告げた' }[detail.action];
      if (!action) throw new Error(`concert hall event label has no homunculus action: ${detail.action}`);
      return `錬成室でホムンクルス${detail.display_name}${action}`;
    }
    case 'arena': {
      const outcome = {
        champion: '優勝した',
        eliminated: '敗退した',
        spectated_champion: 'バディーの優勝を見届けた',
        spectated_eliminated: 'バディーの敗退を見届けた'
      }[detail.outcome];
      if (!outcome) throw new Error(`concert hall event label has no arena outcome: ${detail.outcome}`);
      return `闘技会で${detail.wins}勝し、${outcome}`;
    }
    case 'auction': {
      const won = detail.lots.filter((lot) => lot.result === 'won_by_player');
      return won.length
        ? `競売場で${won.map((lot) => `「${lot.item_name}」`).join('・')}を落札した`
        : '競売場の夜会で競り合いを眺めた';
    }
    case 'lounge':
      return `談話室で${detail.participants.map((participant) => participant.character_name).join('・')}と語らった`;
    case 'concert_hall':
      return `奏楽堂で${detail.pieces.map((piece) => `〈${piece.title}〉`).join('・')}を奏でた`;
    case 'overlook':
      return '星見の窓から学院を眺めた';
    default:
      throw new Error(`concert hall event label has no branch for kind: ${record.kind}`);
  }
}

// Resolves the current buddy to {id, label} across both rosters (a selectable character's profile, an
// ACTIVE homunculus' surface entry). A dangling id throws — the hub start fails on it the same way.
async function buddyCandidate({ state, storage }) {
  if (!Object.prototype.hasOwnProperty.call(state, 'current_buddy_character_id')) {
    throw new Error('runtime_state.current_buddy_character_id is required');
  }
  const buddyId = state.current_buddy_character_id;
  if (buddyId === null) return null;
  const id = requireNonEmptyString(buddyId, 'runtime_state.current_buddy_character_id');
  if (isHomunculusIdFormat(id)) {
    const surface = await loadHomunculiSurface({ storage });
    const active = surface.active.find((entry) => entry.homunculus_id === id);
    if (!active) throw new Error(`concert hall buddy homunculus is not active: ${id}`);
    return { id: `buddy_${id}`, label: active.display_name };
  }
  const profile = await storage.readJson(`game_data/characters/${id}/profile.json`);
  return { id: `buddy_${id}`, label: requireNonEmptyString(profile?.display_name, `${id} display_name`) };
}

// Gathers the closed S1 candidate set from the surfaces the slot already keeps. `root` is the slot root
// the inventory reader decorates names from; `storage` reads the runtime surfaces. Read-only: no state
// key and no surface is written.
export async function buildConcertHallCandidates({ state, storage, root } = {}) {
  if (!storage) throw new Error('concert hall candidates require storage');
  if (!root) throw new Error('concert hall candidates require root');
  const week = requireRoutingContentWeek(state);
  const record = readRoutingContentResult(state);
  const events = record ? [{ id: `event_${record.kind}`, label: contentResultEventLabel(record) }] : [];
  const inventory = await loadInventory({ root });
  const items = inventory.items.map((item) => ({ id: `item_${item.item_id}`, label: requireNonEmptyString(item.name, `inventory ${item.item_id} name`) }));
  const collection = await loadLibraryCollection({ storage });
  const books = collection.entries.slice(-CONCERT_HALL_BOOK_CANDIDATE_MAX)
    .map((entry) => ({ id: `book_${entry.entry_id}`, label: `『${entry.title}』` }));
  const buddy = await buddyCandidate({ state, storage });
  return { events, items, books, buddy, week };
}

// Runs the multi-stage composition through the injected generator. `onStage` receives every stage in
// order (materials → direction → guidance → skeleton → section × N) for the SSE. Returns the generation
// result ({ materials, direction, guidance, skeleton, score, narration }); nothing is written here.
export async function composeConcertHallPiece({ freeText, candidates, catalog, generators, onStage } = {}) {
  const text = requireNonEmptyString(freeText, 'free text');
  if (!candidates || typeof candidates !== 'object') throw new Error('concert hall compose requires candidates');
  const checkedCatalog = requireCatalog(catalog);
  assertGenerators(generators);
  if (typeof onStage !== 'function') throw new Error('concert hall compose requires onStage');
  return generators.generatePiece({
    freeText: text,
    candidates,
    axes: checkedCatalog.axes,
    guidanceCatalog: checkedCatalog.guidance,
    performer: { name: checkedCatalog.performer.name, voice: checkedCatalog.performer.voice },
    onStage
  });
}

// Commits one composed piece: ① append it to 収蔵 (the permanent surface, written first), ② fold its
// identity into the routing content-result slot (append within the same concert-hall week, else a fresh
// record). When the append throws, the content result is not written. Returns { entry, content_result, week }.
export async function commitConcertHallPiece({ storage, state, catalog, piece, now } = {}) {
  if (!storage) throw new Error('concert hall commit requires storage');
  if (!piece || typeof piece !== 'object' || !piece.score || !piece.direction || !piece.materials || !piece.narration) {
    throw new Error('concert hall commit requires a composed piece');
  }
  const checkedCatalog = requireCatalog(catalog);
  const recordedAt = requireNonEmptyString(now, 'commit now');
  const week = requireRoutingContentWeek(state);

  const surface = await loadConcertHallPieces({ storage });
  const entry = {
    entry_id: makeConcertHallEntryId({ now: recordedAt, seq: surface.entries.length }),
    title: piece.score.title,
    direction_id: piece.direction.direction_id,
    subject_id: piece.direction.subject_id,
    motif_category_id: piece.direction.motif_category_id,
    materials: [...piece.materials.materials],
    narration: {
      materials: piece.narration.materials,
      direction: piece.narration.direction,
      guidance: [...piece.narration.guidance],
      skeleton: [...piece.narration.skeleton]
    },
    score: piece.score,
    composed_week: week
  };
  await appendConcertHallPiece({ storage, entry });

  const identity = { entry_id: entry.entry_id, title: entry.title, direction_label: concertHallDirectionLabel(checkedCatalog, entry.direction_id) };
  const existing = readRoutingContentResult(state);
  const record = mergeConcertHallContentResult({ existing, week, now: recordedAt, piece: identity });
  await storage.writeJson(RUNTIME_STATE_PATH, { ...state, [ROUTING_CONTENT_RESULT_STATE_KEY]: record });

  return { entry, content_result: record, week };
}
