# STARFALL MAGIC ACADEMY

STARFALL MAGIC ACADEMY is a local-first playable magic-academy adventure project with structured character continuity and LM Studio-backed conversations, built on two execution surfaces:

- a Node-powered browser runtime served from `app/public/`
- an Electron desktop wrapper over the same game/runtime surfaces

This repository is **public-facing development work**, not a polished store-ready release. The goal of the current repo state is that an outside reader can understand what the project is, run the local code/test surfaces, and see the current architectural direction without having to know the private migration history.

For the current packaged player release, the GitHub Release notes are the player-facing canonical copy. For a Japanese player-facing setup guide, see [`USER_README.ja.md`](USER_README.ja.md).

## What is here

- `app/` — local runtime server, browser shell, local config surface, and tests
- `electron/` — Electron desktop entrypoint
- `content/` — canonical authored character/content surfaces
- `data/definitions/` — canonical gameplay/world definitions
- `data/seeds/` — seed runtime data used to bootstrap play
- `data/mutable/` — ignored local mutable runtime/play state created while running locally
- `assets/` — tracked canonical runtime images/BGM, app icons, provenance/reuse documentation, and optional original generation inputs that are excluded from packages
- `.agents/docs/` — project documentation hub: requirements, architecture, specs, design briefs, reports, runbooks, and top-level `ref-*.md` references; indexed by `.agents/docs/REFERENCE.md`
- `tools/` — support scripts for import or asset workflows

## Current project posture

This repo currently aims to be a **local development/runtime repository with runnable code surfaces**.

That means:

- the browser and Electron code surfaces are real and runnable,
- tests and storage contracts are maintained in-repo,
- LM Studio-backed conversation features are part of the intended experience,
- some developer-facing authoring and debug routes still exist because this repo is also the active implementation surface.

This does **not** mean:

- the project is a finished commercial release,
- every local API is meant as a public server surface,
- assets are implicitly granted for third-party reuse.

## Requirements

- Node.js with native `fetch` support (Node 18+ recommended)
- npm
- LM Studio for normal gameplay/conversation progression
- a local model/environment that can run the configured LM Studio target; the current game premise is Gemma 4 31B-family local LLM conversation
- for the documented 24GB VRAM setup, `lmstudio-community` Gemma 4 31B `q4_k_m`, a 64,000 context window, evaluation batch size 2,048, 4bit KV cache quantization, Max Concurrent Predictions `1`, and Unified KV Cache disabled
- optional: Electron, through the packaged npm scripts below

The recommended packaged-play setup is to run the macOS build on a Mac and connect it to LM Studio's OpenAI-compatible API on the same local network. Windows play and same-machine `localhost` LM Studio can work, but they are less exercised for the current preview.

Install dependencies:

```bash
npm install
```

## Quick start: browser runtime

Start the local server:

```bash
npm start
```

The runtime starts on localhost by default:

- default URL: `http://127.0.0.1:4173`

On a fresh clone, the server should still start **without** `app/config/lmstudio.json`.
In that state, you can open the browser shell and settings surface, but normal gameplay/conversation progression requires LM Studio to be configured and running.

All canonical runtime assets currently used by the browser/Electron build are tracked in Git and packageable from a fresh clone. Original generation inputs and session logs are not part of the runtime contract; see `assets/README.md` for provenance and reuse boundaries.

## Quick start: Electron runtime

Run the desktop wrapper:

```bash
npm run electron
```

Development variant with devtools enabled:

```bash
npm run electron:dev
```

Packaging scripts:

```bash
npm run electron:dist
npm run electron:mac
npm run electron:win
npm run electron:pack
```

## LM Studio setup

Normal gameplay/conversation progression requires an OpenAI-compatible LM Studio endpoint.
The player-facing setup guidance is documented in [`USER_README.ja.md`](USER_README.ja.md). In short, the game is designed around Gemma 4 31B-family local LLM conversation. On the author's 24GB VRAM environment, that target requires careful LM Studio settings: `lmstudio-community` Gemma 4 31B `q4_k_m`, context size 64,000, evaluation batch size 2,048, 4bit KV cache quantization, Max Concurrent Predictions `1`, and Unified KV Cache disabled. Larger-VRAM environments may use less restrictive settings, but they are not locally verified by the author.

Committed example config:

- `app/config/lmstudio.example.json`

Ignored local config path actually used at runtime:

- `app/config/lmstudio.json`

Default example values point at same-machine LM Studio:

- `http://127.0.0.1:1234/v1`

If LM Studio runs on another machine on the same local network, configure the game to use that machine's LAN address instead of `127.0.0.1`.

### Behavior when LM Studio is not configured

- `npm start` still starts the local server
- the browser shell still loads
- the LM Studio settings surface remains available
- conversation/opening flows return a structured config-required error until settings are saved
- normal gameplay/conversation progression should be treated as unavailable until LM Studio is configured and running

This is intentional: missing LM Studio should not prevent the local server/settings surface from opening, but it is a **runtime requirement for the intended game experience**.

## Development and verification commands

Syntax / static sanity check:

```bash
npm run check
```

Main test suite:

```bash
npm test
```

### Change gates

The required checks after any code change:

```bash
npm run check   # syntax/static sanity
npm test        # main test suite
```

A quick boot check is `node scripts/smoke.mjs`, which starts the server and
verifies `GET /` returns HTTP 200; it passes without LM Studio configured.

The development workspace additionally wraps these gates in an internal
agent-team harness; that harness is development tooling and is not part of this
repository's public snapshot.

## Runtime surface boundaries

This repo exposes multiple kinds of local surfaces. They are not all the same thing.

### 1. Player-facing runtime surface

The ordinary browser/Electron play flow is the main user-facing surface.
This includes the core map, interaction, training, inventory, save/load, and conversation flows.

### 2. Authoring surface

Some routes allow editing world or character-authored data from the local runtime.
These are development-time conveniences for the active repo workflow, not a claim that the project is a multi-user hosted authoring service.

### 3. Debug / control surface

Some local debug routes exist for flags, relationship state, progression, and inspection.
These are for development and verification. They should be treated as local tooling surfaces, not as a hardened public API contract.

## Storage model

The current architecture separates:

- authored content under `content/`
- canonical definitions under `data/definitions/`
- seed bootstrap data under `data/seeds/`
- mutable runtime/play state under `data/mutable/`

Legacy `game_data/...` compatibility still exists in places, but the direction of the repo is **split authored/definitions/mutable surfaces**, not a return to one giant mutable tree.

## License and reuse

- Code/package license stance: see `LICENSE`
- Asset-specific reuse boundary: see `assets/README.md`

The current repo stance is conservative: visibility of the repository does **not** mean unrestricted reuse of project assets.

## Known limitations / honesty notes

- LM Studio-backed conversation/game progression requires local configuration and a sufficiently capable LM Studio environment before the game works as intended
- the current game premise is Gemma 4 31B-family local LLM conversation; the documented 24GB VRAM setup uses `lmstudio-community` Gemma 4 31B `q4_k_m`, context size 64,000, evaluation batch size 2,048, 4bit KV cache quantization, Max Concurrent Predictions `1`, and Unified KV Cache disabled
- larger-VRAM LM Studio settings may be relaxed, and disabling KV cache quantization may be preferable for performance, but this is not locally verified by the author
- the recommended packaged-play path is macOS on Mac connected to LM Studio over the local network; Windows and same-machine `localhost` play are less exercised for the current preview
- the current canonical runtime asset set is committed, while upstream generation history may still be incomplete; asset reuse remains prohibited unless separately licensed
- this is still an active development repository, so some developer-facing routes remain present in the local runtime
- packaging exists, but “publicly visible repo” should not be confused with “final distribution-ready release”
