// 奏楽堂 HTTP surface: three routing-only routes over the feature owner (routingConcertHall.mjs).
//   GET  /api/concert-hall                     arrival (week / exit / performer / shelf) — LM 不要
//   POST /api/concert-hall/compose             { free_text } → SSE: `stage` per stage, then `done` | `error`
//   GET  /api/concert-hall/pieces/<entry_id>   one stored piece for 再演 — LM 不要
// Every route requires routing mode (409 ROUTING_MODE_REQUIRED). The compose route resolves the LM config
// as a JSON 503 BEFORE opening the stream (the auction discipline), reads every input before the first
// byte, and once the stream is open every failure closes it with an `error` event (HTTP stays 200).

import { resolvePostContentScreen } from '../playMode.mjs';
import { createStorageApi } from '../storage.mjs';
import { assertRecognizedRoutingProvider } from './routingProvider.mjs';
import { loadConcertHallCatalog, resolveConcertHallGuidance } from '../concertHallCatalog.mjs';
import { findConcertHallPiece } from '../concertHallPieces.mjs';
import {
  buildConcertHallArrival,
  buildConcertHallCandidates,
  commitConcertHallPiece,
  composeConcertHallPiece
} from '../routingConcertHall.mjs';
import { assembleConcertHallScore, generateConcertHallPiece } from '../llm/concertHallGeneration.mjs';

const RUNTIME_STATE_PATH = 'game_data/runtime_state.json';
const PIECE_ROUTE_PREFIX = '/api/concert-hall/pieces/';

const ROUTES = new Set([
  'GET /api/concert-hall',
  'POST /api/concert-hall/compose'
]);

function statusError(message, statusCode, { errorCode = null } = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (errorCode) error.errorCode = errorCode;
  return error;
}

function assertRoutingMode(activePlayMode) {
  if (!activePlayMode || typeof activePlayMode !== 'object') throw new Error('activePlayMode is required');
  if (activePlayMode.mode !== 'routing') {
    throw statusError('concert hall content requires routing mode', 409, { errorCode: 'ROUTING_MODE_REQUIRED' });
  }
}

// The piece route addresses one entry_id verbatim: exactly one non-empty segment after the prefix.
function pieceRouteEntryId(pathname) {
  if (!pathname.startsWith(PIECE_ROUTE_PREFIX)) return null;
  const rest = pathname.slice(PIECE_ROUTE_PREFIX.length);
  if (!rest || rest.includes('/')) return null;
  return decodeURIComponent(rest);
}

export function canHandleConcertHallApiRoute(method, pathname) {
  if (ROUTES.has(`${method} ${pathname}`)) return true;
  return method === 'GET' && pieceRouteEntryId(pathname) !== null;
}

// The compose body is closed: exactly { free_text }. An extra key is a caller that believes in an
// affordance this API does not have, so it is refused rather than ignored. The provider seam is the
// query string only (?provider=mock).
function assertComposeBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw statusError('request body must be an object', 400, { errorCode: 'CONCERT_HALL_BODY_INVALID' });
  }
  const unexpected = Object.keys(body).filter((key) => key !== 'free_text');
  if (unexpected.length > 0) {
    throw statusError(
      `unexpected body key(s) for this route: ${unexpected.join(', ')}`,
      400,
      { errorCode: 'CONCERT_HALL_BODY_UNEXPECTED_KEY' }
    );
  }
  if (typeof body.free_text !== 'string' || !body.free_text.trim()) {
    throw statusError('free_text must be a non-empty string', 400, { errorCode: 'CONCERT_HALL_FREE_TEXT_REQUIRED' });
  }
  return body.free_text.trim();
}

// The mock generator walks the same five stages as the real one with deterministic, gate-clean output
// and no LM call (the ?provider=mock affordance for tests): the first candidate material (if any), the
// first id of every axis, the catalog guidance, a two-section C-major skeleton inside the direction's
// tempo band, one melody note per beat, and the real machine voicing / score assembly.
function mockConcertHallGenerators() {
  return {
    generatePiece: async ({ freeText, candidates, axes, guidanceCatalog, performer, onStage }) => {
      const firstCandidate = [...candidates.events, ...candidates.items, ...candidates.books, ...(candidates.buddy ? [candidates.buddy] : [])][0];
      const materials = {
        materials: firstCandidate ? [firstCandidate.id] : [],
        motif_words: ['写し', '試し弾き'],
        remark: `${performer.name}が願いを聞き取り、材料を選んだ。`
      };
      await onStage({ stage: 'materials', payload: materials });
      const direction = {
        direction_id: axes.directions[0].id,
        subject_id: axes.subjects[0].id,
        motif_category_id: axes.motif_categories[0].id,
        remark: `「${freeText.slice(0, 12)}」の気分で一曲にしよう。`
      };
      await onStage({ stage: 'direction', payload: direction });
      const guidance = resolveConcertHallGuidance({ direction, axes, guidanceCatalog });
      await onStage({ stage: 'guidance', payload: { lines: guidance.lines } });
      const skeleton = {
        title: '写しの小品',
        key: 'C',
        mode: guidance.modes[0],
        tempo: guidance.tempo[0],
        meter: '4/4',
        sections: [
          { name: '始まり', bars: 4, chords: ['C', 'F', 'G', 'C'], character: '静かに始まる。' },
          { name: '終わり', bars: 4, chords: ['Am', 'F', 'G', 'C'], character: '穏やかに閉じる。' }
        ]
      };
      await onStage({ stage: 'skeleton', payload: skeleton });
      const sectionNotes = [];
      for (let index = 0; index < skeleton.sections.length; index += 1) {
        const pitches = ['C5', 'D5', 'E5', 'G5'];
        const melody = Array.from({ length: 16 }, (_unused, beat) => ({ pitch: pitches[beat % 4], start_beat: beat, duration_beats: 1 }));
        const notes = { melody, counter: [] };
        sectionNotes.push(notes);
        await onStage({ stage: 'section', index, payload: notes });
      }
      const score = assembleConcertHallScore({ skeleton, sectionNotes, guidance });
      return {
        materials,
        direction,
        guidance: guidance.lines,
        skeleton,
        score,
        narration: {
          materials: materials.remark,
          direction: direction.remark,
          guidance: guidance.lines,
          skeleton: skeleton.sections.map((section) => section.character)
        }
      };
    }
  };
}

function realConcertHallGenerators(config) {
  return {
    generatePiece: (args) => generateConcertHallPiece({ config, ...args })
  };
}

// The in-stream error envelope: a tagged error (generation gate, LM transport, piece surface) carries its
// own code and — for a generation failure — the stage it failed at; an untagged throw is a bug surfaced
// under CONCERT_HALL_INTERNAL_ERROR with its message, never swallowed.
function errorPayload(error) {
  return {
    code: error.errorCode ?? 'CONCERT_HALL_INTERNAL_ERROR',
    stage: error.stage ?? null,
    message: error.message
  };
}

export async function handleConcertHallApi({
  req,
  res,
  url,
  context,
  sendJson,
  readBody,
  activePlayMode,
  resolveLmStudioConfig,
  openSse,
  sendSseEvent
}) {
  if (!canHandleConcertHallApiRoute(req.method, url.pathname)) return false;
  assertRoutingMode(activePlayMode);
  const root = context.activeRoot ?? context.root;
  const storage = createStorageApi({ root });

  if (req.method === 'GET' && url.pathname === '/api/concert-hall') {
    // Arrival view for the stay-type concert hall screen: the week (display header), the
    // server-authoritative exit (routing → the routing hub), the performer's lines and the shelf.
    const catalog = await loadConcertHallCatalog({ root });
    const state = await storage.readJson(RUNTIME_STATE_PATH);
    const arrival = await buildConcertHallArrival({ state, storage, catalog });
    const postContentScreen = resolvePostContentScreen({ mode: activePlayMode.mode, loopScreen: 'academy-map' });
    return sendJson(res, {
      week: arrival.week,
      post_content_screen: postContentScreen,
      performer: arrival.performer,
      pieces: arrival.pieces
    });
  }

  if (req.method === 'GET') {
    const entryId = pieceRouteEntryId(url.pathname);
    return sendJson(res, await findConcertHallPiece({ storage, entryId }));
  }

  // POST /api/concert-hall/compose
  const freeText = assertComposeBody(await readBody(req));
  const requestedProvider = assertRecognizedRoutingProvider(url.searchParams.get('provider'));
  // The LM config is settled before the stream opens: an unconfigured LM is a clean JSON 503, never an
  // in-stream error. The mock provider touches no LM config.
  const generators = requestedProvider === 'mock'
    ? mockConcertHallGenerators()
    : realConcertHallGenerators(await resolveLmStudioConfig());
  const catalog = await loadConcertHallCatalog({ root });
  const state = await storage.readJson(RUNTIME_STATE_PATH);
  const candidates = await buildConcertHallCandidates({ state, storage, root });

  openSse(res);
  try {
    const piece = await composeConcertHallPiece({
      freeText,
      candidates,
      catalog,
      generators,
      onStage: async (stage) => sendSseEvent(res, 'stage', stage)
    });
    const commit = await commitConcertHallPiece({ storage, state, catalog, piece, now: new Date().toISOString() });
    sendSseEvent(res, 'done', { entry_id: commit.entry.entry_id, piece: commit.entry });
  } catch (error) {
    sendSseEvent(res, 'error', errorPayload(error));
  } finally {
    res.end();
  }
  return true;
}
