// Dungeon consumables use-UI contract (source-regex): the always-on consumables band, the four
// target_mode flows (auto / aim / ally / revive), the aim overlay + LoS mirror, and the closed-set
// action_error mapping that fail-fasts on an unknown code. Real Blink layout + the interactive flows are
// verified separately by the render harness app/tests/manual/dungeonConsumablesRender.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { projectRoot } from './testPaths.mjs';

const publicRoot = path.join(projectRoot, 'app/public');

test('index.html carries the always-on three-column item region and the targeting prompt', async () => {
  const html = await readFile(path.join(publicRoot, 'index.html'), 'utf8');
  // The item region sits between the stage and the dock as three adjacent columns in order: 持ち込んだアイテム
  // (consumables) / 拾ったアイテム (floor pickups) / 拾った素材 (materials). Each column has a label + an
  // internally-scrolling list; the brought column carries #dungeon-consumables-list and the pickup column
  // carries #dungeon-pickups-list (both use flows), the materials column carries #dungeon-materials-list (display).
  assert.match(html, /id="dungeon-items"[\s\S]*id="dungeon-brought"[\s\S]*class="dungeon-item-column-label">持ち込んだアイテム<[\s\S]*id="dungeon-consumables-list"[\s\S]*id="dungeon-pickups"[\s\S]*class="dungeon-item-column-label">拾ったアイテム<[\s\S]*id="dungeon-pickups-list"[\s\S]*id="dungeon-materials"[\s\S]*class="dungeon-item-column-label">拾った素材<[\s\S]*id="dungeon-materials-list"/, 'the item region holds 持ち込んだ / 拾ったアイテム / 拾った素材 columns in order, each a labelled list; the brought and pickup columns carry the use-flow lists, the materials column the display list');
  assert.match(html, /id="dungeon-grid"[^>]*><\/div>\s*<div id="dungeon-consumable-prompt"[^>]*hidden[^>]*>[\s\S]*?<\/div>\s*<\/div>\s*<div class="dungeon-side">/, 'the targeting prompt sits in the map column (stage) right after the board so it floats over it, and the stage closes into the right rail');
  assert.match(html, /class="dungeon-stage"[\s\S]*class="dungeon-side"[\s\S]*id="dungeon-items"[\s\S]*class="dungeon-dock"/, 'the document orders the map column, then the right rail with the item region and the dock stacked');
  assert.match(html, /id="dungeon-consumable-prompt"[^>]*\shidden/, 'the prompt starts hidden');
});

test('app.js renders the consumables column from view.consumables and resolves each target_mode', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  // renderDungeonPlay lays all three item columns out before the grid (fixed region height keeps the cell size stable).
  assert.match(js, /renderDungeonDock\(view\);\s*\/\/[\s\S]*?renderDungeonConsumables\(view\);\s*renderDungeonPickups\(view\);\s*renderDungeonMaterials\(view\);\s*renderDungeonChat\(view\);\s*renderDungeonGrid\(view\);/, 'renderDungeonPlay renders the consumable, pickup, and material columns before the grid');
  // The column is built from the engine-authoritative view.consumables; a missing contract throws (fail-fast).
  assert.match(js, /function renderDungeonConsumables\(view\)[\s\S]*if \(!Array\.isArray\(view\.consumables\)\) throw new Error\('dungeon view is missing consumables'\)/, 'the column reads view.consumables and fail-fasts when the contract is missing');
  // The shared column filler keeps an empty list visible with an explicit empty note (常設) rather than collapsing.
  assert.match(js, /function renderDungeonConsumables\(view\)[\s\S]*fillDungeonItemColumn\(list, view\.consumables[\s\S]*消耗品はありません。/, 'an empty consumables list keeps the column with an explicit empty note (常設)');
  assert.match(js, /function fillDungeonItemColumn\(listEl, rows, buildRow, emptyText\)[\s\S]*rows\.length === 0[\s\S]*dungeon-item-column-empty[\s\S]*rows\.map\(buildRow\)/, 'the shared column filler renders a row per entry or a single quiet empty note');
  // A chip carries item_id + target_mode, is tinted by element (shared .dn-el-* hue class), and shows qty.
  assert.match(js, /function buildDungeonConsumableChip\(view, row\)[\s\S]*dataset\.itemId = row\.item_id[\s\S]*dataset\.targetMode = row\.target_mode[\s\S]*classList\.add\(`dn-el-\$\{row\.element\}`\)/, 'a chip carries item_id + target_mode and reuses the shared per-element hue class');
  assert.match(js, /function dungeonConsumableSummaryText\(row\)[\s\S]*case 'attack_single'[\s\S]*case 'attack_area'[\s\S]*case 'heal'[\s\S]*case 'heal_full'[\s\S]*case 'mp_restore'[\s\S]*case 'mp_restore_full'[\s\S]*case 'revive'[\s\S]*default: throw new Error/, 'the chip summary covers every effect_kind and throws on an unknown one');
  // Click routing by target_mode: auto/revive fire immediately, aim arms the board, ally opens the pick.
  assert.match(js, /function onDungeonConsumableClick\(view, row\)[\s\S]*dungeonConsumableTargeting\?\.item_id === row\.item_id\) \{ cancelDungeonConsumableTargeting\(\); return; \}[\s\S]*target_mode === 'auto' \|\| row\.target_mode === 'revive'\) \{ useDungeonConsumable\(row\.item_id\); return; \}[\s\S]*target_mode === 'aim'\) \{ enterDungeonAimMode[\s\S]*target_mode === 'ally'\) \{ openDungeonAllyTargetPrompt[\s\S]*throw new Error\(`unknown consumable target_mode/, 'a chip click resolves each target_mode and throws on an unknown one; re-clicking the armed chip cancels');
  // use_consumable action shape (item_id + optional target/aim), through the shared dungeonDo action path.
  assert.match(js, /function useDungeonConsumable\(itemId, extra = \{\}\)[\s\S]*dungeonDo\(\{ type: 'use_consumable', item_id: itemId, \.\.\.extra \}\)/, 'use posts a use_consumable action with the collected target/aim');
});

test('app.js renders the 拾ったアイテム pickup column from view.inventory and uses items via use_item', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  // The middle 拾ったアイテム column reads the run's floor pickups (view.inventory); a missing/mis-typed
  // contract throws (fail-fast, no silent empty), and an empty list keeps the column with an explicit note.
  assert.match(js, /function renderDungeonPickups\(view\)[\s\S]*document\.querySelector\('#dungeon-pickups-list'\)[\s\S]*if \(!Array\.isArray\(view\.inventory\)\) throw new Error\('dungeon view is missing inventory'\)/, 'the pickup column reads view.inventory and fail-fasts when the contract is missing');
  assert.match(js, /function renderDungeonPickups\(view\)[\s\S]*fillDungeonItemColumn\(list, view\.inventory, buildDungeonPickupRow,[\s\S]*拾ったアイテムはありません。/, 'an empty pickup list keeps the column with an explicit empty note (常設), reusing the shared column filler');
  // Each pickup row is a use button that fires the same use_item action the removed menu inventory did
  // (turn cost / effect / log unchanged); a mis-shaped entry throws (fail-fast).
  assert.match(js, /function buildDungeonPickupRow\(item\)[\s\S]*throw new Error\(`dungeon inventory item requires a non-empty kind[\s\S]*throw new Error\(`dungeon inventory item requires a non-empty name[\s\S]*throw new Error\(`dungeon inventory item requires a numeric count/, 'a pickup row fail-fasts on a mis-shaped inventory entry (kind / name / count)');
  assert.match(js, /function buildDungeonPickupRow\(item\)[\s\S]*className = 'dungeon-item-use-row'[\s\S]*dungeonDo\(\{ type: 'use_item', item_kind: item\.kind \}\)/, 'a pickup row is a use button that posts use_item by kind through the shared dungeonDo path');
});

test('app.js has no menu inventory popup — the pickup column is the single use_item route', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  assert.doesNotMatch(js, /function openDungeonInventory/, 'the menu inventory popup is removed (no duplicate use route)');
  assert.doesNotMatch(js, /openDungeonInventory\(\)/, 'nothing opens the removed inventory popup');
  assert.doesNotMatch(js, /dungeon-inventory-item|dungeon-inventory-list/, 'the inventory popup DOM hooks are gone');
  // The menu layer itself is gone: 撤退 is a HUD button + dedicated confirm, ヘルプ a HUD icon button, and the
  // stats / carry-home moved to the hero detail. So there is no menu open/item builder at all.
  assert.doesNotMatch(js, /function openDungeonMenu|function dungeonMenuButton|dungeon-menu-item|dungeon-menu-list/, 'the menu layer (open / item builder / list) is removed entirely');
  // use_item is used ONLY from the pickup column row (the single route).
  assert.match(js, /function buildDungeonPickupRow\(item\)[\s\S]*dungeonDo\(\{ type: 'use_item', item_kind: item\.kind \}\)/, 'the 拾ったアイテム column row is the sole use_item route');
});

test('app.js aim mode mirrors the engine line-of-sight gate and blocks illegal tiles client-side', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  // The valid-tile predicate matches planConsumable: in-bounds + explored + floor + LoS from the player.
  assert.match(js, /function dungeonAimTileValid\(view, x, y\)[\s\S]*!view\.explored\[y\]\[x\][\s\S]*view\.tiles\[y\]\[x\] !== 'floor'[\s\S]*dungeonHasLineOfSight\(view, view\.player, \{ x, y \}\)/, 'a legal landing tile is in-bounds, explored, floor, and has LoS from the player');
  // LoS mirrors dungeonEngine.hasLineOfSight (rounded steps strictly between endpoints must be floor).
  assert.match(js, /function dungeonHasLineOfSight\(view, from, to\)[\s\S]*const steps = Math\.max\(Math\.abs\(dx\), Math\.abs\(dy\)\)[\s\S]*for \(let step = 1; step < steps; step \+= 1\)[\s\S]*Math\.round\(from\.x \+ \(dx \* step\) \/ steps\)[\s\S]*view\.tiles\[y\]\[x\] !== 'floor'\) return false/, 'client LoS mirrors the engine walk');
  // Arming lays the overlay grid inside the camera-transformed board and shows the aim prompt.
  assert.match(js, /function enterDungeonAimMode\(view, row\)[\s\S]*buildDungeonAimOverlay\(view, row\)[\s\S]*classList\.add\('dn-aiming'\)[\s\S]*showDungeonConsumablePrompt/, 'arming builds the aim overlay, the aim cursor, and the prompt');
  assert.match(js, /function buildDungeonAimOverlay\(view, row\)[\s\S]*querySelector\('#dungeon-grid \.dn-board'\)[\s\S]*className = 'dn-aim'[\s\S]*dungeonAimTileValid\(view, x, y\)\) cell\.classList\.add\('dn-aim-valid'\)/, 'the overlay is a per-tile grid appended into .dn-board, marking legal tiles');
  // Hover previews the Manhattan-radius blast; an illegal tile is inert (client-blocked — server is final).
  assert.match(js, /function paintDungeonAimBlast\(row, cx, cy\)[\s\S]*Math\.abs\(Number\(cell\.dataset\.x\) - cx\) \+ Math\.abs\(Number\(cell\.dataset\.y\) - cy\)[\s\S]*<= row\.radius\) cell\.classList\.add\('dn-aim-blast'\)/, 'hover paints the Manhattan-radius blast preview');
  assert.match(js, /function onDungeonAimClick\(event, row\)[\s\S]*if \(!cell \|\| !cell\.classList\.contains\('dn-aim-valid'\)\) return;[\s\S]*useDungeonConsumable\(row\.item_id, \{ aim: \{ x: Number\(cell\.dataset\.x\), y: Number\(cell\.dataset\.y\) \} \}\)/, 'clicking an illegal tile sends nothing; a legal tile sends aim:{x,y}');
  // Esc / re-click / 中止 cancel; while targeting, no key drives a move.
  assert.match(js, /if \(dungeonConsumableTargeting\) \{\s*if \(event\.key === 'Escape'\) \{ event\.preventDefault\(\); cancelDungeonConsumableTargeting\(\); \}\s*return;\s*\}/, 'while targeting, Escape cancels and no key drives a move');
});

test('app.js ally/revive gating: companion pick and the once-per-run revive disable state', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  // Ally pick: 主人公 always; companion only when present and not down.
  assert.match(js, /function openDungeonAllyTargetPrompt\(view, row\)[\s\S]*const companionUsable = !!view\.companion && !view\.companion\.down[\s\S]*label: '主人公'[\s\S]*useDungeonConsumable\(row\.item_id, \{ target: 'player' \}\)[\s\S]*useDungeonConsumable\(row\.item_id, \{ target: 'companion' \}\)[\s\S]*disabled: !companionUsable/, 'the ally pick offers 主人公 always and the companion only when it is present and not down');
  // Revive is render-gated on view.revive_used and a downed companion.
  assert.match(js, /function dungeonConsumableDisabledState\(view, row\)[\s\S]*target_mode === 'revive'[\s\S]*if \(view\.revive_used\) return \{ disabled: true[\s\S]*使い切り[\s\S]*if \(!view\.companion \|\| !view\.companion\.down\) return \{ disabled: true[\s\S]*対象なし/, 'revive disables on a spent revive_used or the absence of a downed companion');
});

test('app.js maps every dungeon action_error code and throws on an unknown one (no silent generic)', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  // The full closed set the engine can surface, each with a readable line — including the new consumable vocab.
  for (const code of [
    'blocked', 'not_on_stairs', 'no_target', 'insufficient_mp', 'hp_full', 'no_item', 'unknown_item',
    'unknown_element', 'retreat_not_here', 'invalid_aim', 'invalid_target', 'revive_used',
    'unknown_consumable', 'invalid_consumable'
  ]) {
    assert.match(js, new RegExp(`DUNGEON_ACTION_ERROR_MESSAGES = \\{[\\s\\S]*${code}:`), `action_error map includes ${code}`);
  }
  // An unknown code throws (fail-fast) instead of the old `?? generic` fallback.
  assert.match(js, /function dungeonActionErrorText\(code\)[\s\S]*Object\.prototype\.hasOwnProperty\.call\(DUNGEON_ACTION_ERROR_MESSAGES, code\)[\s\S]*throw new Error\(`unknown dungeon action_error code/, 'an unknown action_error code throws');
  assert.doesNotMatch(js, /return messages\[code\] \?\? `行動できません/, 'the old silent generic fallback is removed');
});

test('style.css styles the item columns, chips, prompt, and aim overlay with --dungeon-* tokens only', async () => {
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  // The three-column region + column surfaces consume the obsidian dungeon tokens; the region height is fixed
  // (camera stability), the columns split the row evenly, and each list scrolls internally.
  assert.match(css, /\.dungeon-items \{[\s\S]*height: 132px[\s\S]*\}/, 'the item region is fixed-height (content-independent stage height)');
  assert.match(css, /\.dungeon-item-column \{[\s\S]*flex: 1 1 0[\s\S]*var\(--dungeon-panel\)/, 'each column splits the row evenly over the obsidian panel token');
  assert.match(css, /\.dungeon-item-column-list \{[\s\S]*overflow-y: auto/, 'each column list absorbs overflow with an internal scroll');
  assert.match(css, /\.dungeon-item-column-label \{[\s\S]*var\(--dungeon-amber\)/, 'the column label burns the amber accent token');
  assert.match(css, /\.dungeon-item-row-qty \{[\s\S]*var\(--dungeon-amber\)/, 'the material count reads in the amber token');
  // The 拾ったアイテム pickup row is a use button (currentColor-free: obsidian chip + amber hairline) that
  // reveals a hover/focus affordance; its text shares the shared row-font-size token.
  assert.match(css, /\.dungeon-item-use-row \{[\s\S]*var\(--dungeon-chip\)[\s\S]*cursor: pointer[\s\S]*font-size: var\(--dungeon-row-font-size\)/, 'the pickup use-row is a clickable chip over the obsidian token at the shared row font size');
  // Row-font-size unification: the action log line and all three columns' row text share the one token so
  // they read equal (the fix for the oversized 拾った column text).
  assert.match(css, /--dungeon-row-font-size:/, 'a shared row-font-size token is defined in the dungeon token scope');
  assert.match(css, /\.dungeon-log p \{[\s\S]*font-size: var\(--dungeon-row-font-size\)/, 'the action log line reads at the shared row font size');
  assert.match(css, /\.dungeon-item-row \{[\s\S]*font-size: var\(--dungeon-row-font-size\)/, 'the materials/pickup row reads at the shared row font size');
  assert.match(css, /\.dungeon-consumable-name \{[\s\S]*font-size: var\(--dungeon-row-font-size\)/, 'the consumable name reads at the shared row font size');
  assert.match(css, /\.dungeon-consumable \{[\s\S]*border: 1px solid currentColor[\s\S]*background: var\(--dungeon-chip\)/, 'a chip takes a currentColor border (element-tintable) over the obsidian chip token');
  assert.match(css, /\.dungeon-consumable\[data-armed="true"\] \{[\s\S]*var\(--dungeon-amber\)/, 'the armed chip is marked with the amber accent');
  assert.match(css, /\.dungeon-consumable-prompt \{[\s\S]*position: absolute[\s\S]*var\(--dungeon-amber\)[\s\S]*var\(--dungeon-panel\)/, 'the targeting prompt floats over the board on the obsidian panel with an amber edge');
  assert.match(css, /\.dn-aim \{[\s\S]*position: absolute[\s\S]*grid-template-columns: repeat\(var\(--dn-cols, 11\), var\(--dn-cell\)\)/, 'the aim overlay is a tile grid inside the board matching the runtime cell size');
  assert.match(css, /\.dn-aim-valid \{[\s\S]*var\(--dungeon-line\)/, 'legal aim tiles carry the amber hairline token');
  assert.match(css, /\.dn-aim-blast \{[\s\S]*var\(--dungeon-inner-ring\)[\s\S]*var\(--dungeon-glow\)/, 'the blast preview uses the amber ring/glow tokens');
  // No literal colors pinned in the new item-column / consumable rules (token discipline): the block reads
  // only var()/px/none (a bare `10px` radius is fine; literal hex/rgb colors are not).
  const block = css.slice(css.indexOf('/* --- item columns'), css.indexOf('/* --- popup modal ---'));
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, 'the item-column CSS pins no literal hex colors');
  assert.doesNotMatch(block, /\brgb\(/, 'the item-column CSS pins no literal rgb() colors');
});
