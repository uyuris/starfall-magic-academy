# Data Surface

Definitions, seed state, fixtures, and mutable runtime/play state are separated here.

## Current boundaries

- `definitions/game_data/` — canonical structured definitions used by the runtime, including locations, event flags, stage flags, shop catalog, and world settings.
- `seeds/game_data/` — starting templates for runtime state, inventory, and player parameters.
- `mutable/game_data/` — active local runtime/play outputs. This includes active-slot metadata, per-slot play data, runtime parameters, logs, and mutable character continuity surfaces.

Do not promote mutable play outputs back into `definitions/` or `content/` unless they are intentionally curated as authored canonical content.
