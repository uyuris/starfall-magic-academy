// 競売場 (auction house) HTTP surface: the routing-destination server routes for `auction` → `academy-auction`.
// It exposes the weekly slot state, entry (week slot build), the per-utterance streamed master口上 / character
// reactions (SSE, 1 request = 1 utterance), the structured NPC bid turn, the player bid/pass, and the atomic lot
// resolution. The handler stays thin — the bid loop, LLM generation, award writers, and content result live in
// routingAuctionSession; thrown status errors are mapped to JSON (or SSE error events on an already-open stream).
//
// Every LLM-backed route resolves the LM config first, so an unconfigured/unreachable LM fails fast (503) with
// nothing consumed — the errand/study/workshop/atelier contract. All routes are routing-only (loop never reaches
// them, so loop runtime_state is untouched).

import { resolvePostContentScreen } from '../playMode.mjs';
import {
  getAuctionState,
  enterAuction,
  streamMasterOpening,
  streamMasterGoad,
  streamMasterHammer,
  streamReaction,
  resolveNpcBidTurn,
  applyPlayerBid,
  applyPlayerPass,
  resolveAuctionLot,
  listConsignableItems,
  submitConsignment,
  skipConsignment,
  streamConsignmentOpening,
  streamConsignmentReaction,
  streamConsignmentHammer,
  resolveConsignmentNpcBidTurn,
  resolveConsignmentLot
} from '../routingAuctionSession.mjs';

const ROUTES = new Set([
  'GET /api/auction/state',
  'POST /api/auction/enter',
  'POST /api/auction/lot/opening/stream',
  'POST /api/auction/lot/reaction/stream',
  'POST /api/auction/lot/goad/stream',
  'POST /api/auction/lot/hammer/stream',
  'POST /api/auction/npc-bid',
  'POST /api/auction/bid',
  'POST /api/auction/lot/resolve',
  // consignment (player-listed lot・出品側)
  'GET /api/auction/consignment/options',
  'POST /api/auction/consignment/submit',
  'POST /api/auction/consignment/skip',
  'POST /api/auction/consignment/opening/stream',
  'POST /api/auction/consignment/reaction/stream',
  'POST /api/auction/consignment/hammer/stream',
  'POST /api/auction/consignment/npc-bid',
  'POST /api/auction/consignment/resolve'
]);

const STREAM_ROUTES = new Set([
  'POST /api/auction/lot/opening/stream',
  'POST /api/auction/lot/reaction/stream',
  'POST /api/auction/lot/goad/stream',
  'POST /api/auction/lot/hammer/stream',
  'POST /api/auction/consignment/opening/stream',
  'POST /api/auction/consignment/reaction/stream',
  'POST /api/auction/consignment/hammer/stream'
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
    throw statusError('auction content requires routing mode', 409, { errorCode: 'ROUTING_MODE_REQUIRED' });
  }
}

// Maps a session throw to a client-error status: a bad request / missing bidder / state conflict is the caller's
// 400/404/409; the LM config/connection error carries its own 503; the economy writer's insufficient-funds throw
// (`insufficient_money`, a plain untagged Error) is a 400 — the same message-prefix classification the workshop /
// atelier API mappers use for the shared consumeInventoryItems throw. Anything else (e.g. a generation gate
// violation on malformed LLM output that is not tagged 503) propagates to the top-level 500 handler.
function auctionClientErrorStatus(error) {
  if (error?.statusCode === 400 || error?.statusCode === 404 || error?.statusCode === 409) return error.statusCode;
  if (error?.statusCode === 503) return 503;
  if (/^insufficient_/.test(error?.message ?? '')) return 400;
  return null;
}

function auctionErrorPayload(error) {
  return { error: error.message, ...(error.errorCode ? { error_code: error.errorCode } : {}) };
}

function sendAuctionError(res, sendJson, error) {
  const status = auctionClientErrorStatus(error);
  if (status === null) throw error;
  return sendJson(res, auctionErrorPayload(error), status);
}

export function canHandleAuctionApiRoute(method, pathname) {
  return ROUTES.has(`${method} ${pathname}`);
}

// Runs a streamed master/reaction speech over SSE: opens the stream, forwards each chat delta as assistant_delta,
// emits assistant_complete + result on success, and an error event on failure (the LM config was already resolved
// as JSON 503 before the stream opened). `generate(onDelta)` returns the session result carrying `utterance`.
async function runAuctionSpeechStream({ res, openSse, sendSseEvent, generate }) {
  openSse(res);
  try {
    sendSseEvent(res, 'status', { phase: 'chat_started' });
    const result = await generate((delta) => sendSseEvent(res, 'assistant_delta', { delta }));
    sendSseEvent(res, 'assistant_complete', { content: result.utterance });
    sendSseEvent(res, 'result', result);
  } catch (error) {
    sendSseEvent(res, 'error', auctionErrorPayload(error));
  } finally {
    res.end();
  }
}

export async function handleAuctionApi({
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
  if (!canHandleAuctionApiRoute(req.method, url.pathname)) return false;
  assertRoutingMode(activePlayMode);
  const root = context.activeRoot ?? context.root;
  const authoringRoot = context.root;
  const postContentScreen = resolvePostContentScreen({ mode: activePlayMode.mode, loopScreen: 'academy-map' });
  const route = `${req.method} ${url.pathname}`;

  // A streamed route resolves the LM config as a JSON 503 BEFORE opening the SSE stream (so an unconfigured LM is a
  // clean 503, not an in-stream error). A non-stream LM route does the same inline below.
  if (STREAM_ROUTES.has(route)) {
    let config;
    try {
      config = await resolveLmStudioConfig();
    } catch (error) {
      return sendAuctionError(res, sendJson, error);
    }
    const body = await readBody(req);
    if (route === 'POST /api/auction/lot/opening/stream') {
      return runAuctionSpeechStream({ res, openSse, sendSseEvent, generate: (onDelta) => streamMasterOpening({ root, config, lotIndex: body.lot_index, priorUtterances: body.prior_utterances, onDelta }) });
    }
    if (route === 'POST /api/auction/lot/reaction/stream') {
      return runAuctionSpeechStream({ res, openSse, sendSseEvent, generate: (onDelta) => streamReaction({ root, authoringRoot, config, lotIndex: body.lot_index, characterId: body.character_id, priorReactions: body.prior_reactions, onDelta }) });
    }
    if (route === 'POST /api/auction/lot/goad/stream') {
      return runAuctionSpeechStream({ res, openSse, sendSseEvent, generate: (onDelta) => streamMasterGoad({ root, config, lotIndex: body.lot_index, current: body.current, bidderName: body.bidder_name, priorUtterances: body.prior_utterances, onDelta }) });
    }
    if (route === 'POST /api/auction/lot/hammer/stream') {
      return runAuctionSpeechStream({ res, openSse, sendSseEvent, generate: (onDelta) => streamMasterHammer({ root, config, lotIndex: body.lot_index, priorUtterances: body.prior_utterances, onDelta }) });
    }
    if (route === 'POST /api/auction/consignment/opening/stream') {
      return runAuctionSpeechStream({ res, openSse, sendSseEvent, generate: (onDelta) => streamConsignmentOpening({ root, config, priorUtterances: body.prior_utterances, onDelta }) });
    }
    if (route === 'POST /api/auction/consignment/reaction/stream') {
      return runAuctionSpeechStream({ res, openSse, sendSseEvent, generate: (onDelta) => streamConsignmentReaction({ root, authoringRoot, config, characterId: body.character_id, priorReactions: body.prior_reactions, onDelta }) });
    }
    // consignment hammer
    return runAuctionSpeechStream({ res, openSse, sendSseEvent, generate: (onDelta) => streamConsignmentHammer({ root, config, priorUtterances: body.prior_utterances, onDelta }) });
  }

  if (req.method === 'GET' && url.pathname === '/api/auction/state') {
    return sendJson(res, await getAuctionState({ root, authoringRoot }));
  }

  if (req.method === 'POST' && url.pathname === '/api/auction/enter') {
    // Validate the LM is configured before building the week slot (subsequent steps require it); the draw itself
    // is LM-free, so the resolved config is used only as the pre-build gate.
    try {
      await resolveLmStudioConfig();
      return sendJson(res, await enterAuction({ root, authoringRoot, postContentScreen }));
    } catch (error) {
      return sendAuctionError(res, sendJson, error);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/auction/npc-bid') {
    const body = await readBody(req);
    try {
      const config = await resolveLmStudioConfig();
      return sendJson(res, await resolveNpcBidTurn({
        root,
        authoringRoot,
        config,
        lotIndex: body.lot_index,
        characterId: body.character_id,
        current: body.current,
        highestBidder: body.highest_bidder ?? null,
        highestBidderName: body.highest_bidder_name ?? null,
        history: body.history
      }));
    } catch (error) {
      return sendAuctionError(res, sendJson, error);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/auction/bid') {
    const body = await readBody(req);
    try {
      if (body.pass === true) {
        return sendJson(res, await applyPlayerPass({ root, lotIndex: body.lot_index }));
      }
      return sendJson(res, await applyPlayerBid({ root, lotIndex: body.lot_index, current: body.current, addAmount: body.add_amount }));
    } catch (error) {
      return sendAuctionError(res, sendJson, error);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/auction/lot/resolve') {
    const body = await readBody(req);
    try {
      // A player win needs the LLM (naming / persona); resolve the config first so an unconfigured LM is a 503
      // with nothing consumed. An NPC win / 流札 does not call the model, but the pre-gate is harmless and uniform.
      const config = await resolveLmStudioConfig();
      return sendJson(res, await resolveAuctionLot({
        root,
        authoringRoot,
        config,
        lotIndex: body.lot_index,
        winner: body.winner ?? null,
        amount: body.amount ?? null,
        postContentScreen
      }));
    } catch (error) {
      return sendAuctionError(res, sendJson, error);
    }
  }

  // ----- consignment (player-listed lot・出品側) JSON routes -----

  if (req.method === 'GET' && url.pathname === '/api/auction/consignment/options') {
    try {
      return sendJson(res, await listConsignableItems({ root }));
    } catch (error) {
      return sendAuctionError(res, sendJson, error);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/auction/consignment/submit') {
    const body = await readBody(req);
    try {
      return sendJson(res, await submitConsignment({ root, authoringRoot, source: body.source }));
    } catch (error) {
      return sendAuctionError(res, sendJson, error);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/auction/consignment/skip') {
    try {
      return sendJson(res, await skipConsignment({ root }));
    } catch (error) {
      return sendAuctionError(res, sendJson, error);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/auction/consignment/npc-bid') {
    const body = await readBody(req);
    try {
      const config = await resolveLmStudioConfig();
      return sendJson(res, await resolveConsignmentNpcBidTurn({
        root,
        authoringRoot,
        config,
        characterId: body.character_id,
        current: body.current,
        highestBidder: body.highest_bidder ?? null,
        highestBidderName: body.highest_bidder_name ?? null,
        history: body.history
      }));
    } catch (error) {
      return sendAuctionError(res, sendJson, error);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/auction/consignment/resolve') {
    const body = await readBody(req);
    try {
      // An NPC win / 流札 never calls the model (no naming/persona on the consigner side), so this route is LM-free.
      return sendJson(res, await resolveConsignmentLot({
        root,
        authoringRoot,
        winner: body.winner ?? null,
        amount: body.amount ?? null
      }));
    } catch (error) {
      return sendAuctionError(res, sendJson, error);
    }
  }

  return sendJson(res, { error: 'not found' }, 404);
}
