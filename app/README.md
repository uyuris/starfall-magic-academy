# App Surface

Executable application code, public runtime assets, config, and tests live here.

## Current implementation

- `src/server.mjs` is the Node HTTP entrypoint used by `npm start`.
- `src/server/*.mjs` contains route groups for save/load, LM Studio settings, debug flags, authoring, field/runtime state, progression/economy, continuity records, and conversation lifecycle/streaming.
- `public/index.html`, `public/style.css`, and `public/app.js` are the current authored browser shell. The shell is vanilla browser JavaScript, not a Vite/React build output.
- `config/lmstudio.example.json` documents the local LM Studio OpenAI-compatible connection shape.
- `tests/*.test.mjs` contains Node test-runner tests.

## Current route families

- Save/load and slots: `/api/save`, `/api/save-slots`, `/api/slots`, `/api/slots/load`.
- Play/session field state: `/api/new-game`, `/api/state`, `/api/field`, `/api/field/move`.
- Conversation lifecycle and streaming: `/api/interaction/start`, `/api/conversation`, `/api/conversation/opening`, `/api/conversation/end`, `/api/conversation/stream`, `/api/conversation/opening/stream`.
- Continuity/debug visibility: `/api/records/status`, `/api/records/reset`, `/api/prompt-preview`, `/api/debug/llm-requests`.
- Flags and event flags: `/api/flags`, `/api/flags/set`, `/api/flags/all-on`, `/api/flags/judgment-flow`, `/api/event-flags`, `/api/event-flags/set`, `/api/event-flags/start`, `/api/event-flags/completion/set`.
- Progression/economy: `/api/academy/week/start`, `/api/training/run`, `/api/training/skip`, `/api/inventory`, `/api/inventory/use`, `/api/shop`, `/api/shop/buy`, `/api/shop/sell`.
- Authoring/settings: `/api/characters`, `/api/characters/profile`, `/api/world`, `/api/settings/lmstudio`, `/api/settings/lmstudio/models`.

`assetCompositeApi.mjs` is currently a placeholder with no active routes.
