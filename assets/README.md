# Assets Surface

Canonical asset sources are separated from the authored public shell and from provenance archives.

## Runtime surface

`/generated/*` remains only as a compatibility route and resolves from canonical-backed asset classes:

- `assets/canonical/backgrounds`
- `assets/canonical/title`
- `assets/canonical/load`
- `assets/canonical/ui/card_images`
- `assets/canonical/character_visual_sets`

The live runtime image surface is:

- `/canonical/*` for direct canonical reads
- `/generated/*` for compatibility reads backed by canonical asset classes

Character visual sets live under:

- `assets/canonical/character_visual_sets`

## Retired runtime routes

Retired legacy routes that should not be revived on the live runtime surface:

- `/source-assets/*`
- `/source-sheet-assets/*`
- `/source-sheet-crops/*`
- `/v5-assets/*`
- `/v5-additional-assets/*`

Do not keep duplicated generated PNG mirrors under `app/public/imported_runtime_staging/`, `imports/snapshots/runtime-staging/`, or `assets/runtime_exports/`.

Do not keep duplicate `character_visual_sets` mirrors under `assets/source_archives/imported_generations/` or `imports/snapshots/runtime-staging/`; provenance belongs in manifests and origin maps, not duplicate runtime trees.

## Provenance note

The shipped image assets currently committed to this repository were generated through Codex-driven workflows using OpenAI image generation, then curated and organized for this project's runtime surfaces.

The repository may keep internal source-path references, manifests, hashes, and identity notes for production continuity, but those references are not a public reuse grant and should not be read as a promise that the full generation history or prompt/session logs are published in-repo.

## Reuse boundary

Unless a separate written permission says otherwise, project assets in this repository are not granted for third-party reuse just because the repository is visible.

That includes, at minimum:

- character art
- UI art
- background art
- title/load imagery
- generated/derived shipping assets produced through the project's Codex/OpenAI image-generation workflows

If a future release needs a broader reuse grant, document it explicitly. Until then, treat the asset surface as project-owned and all-rights-reserved.
