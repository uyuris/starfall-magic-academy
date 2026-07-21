// Unified actor-detail shell + retreat confirm + HUD name-click contract (source-regex). The fixed chat header
// is gone; the party-card names in the HUD open a single unified detail shell (image? / 能力値 / 装備 / 獲得予定),
// and 撤退 is a dedicated dungeon-styled confirm modal. Real Blink layout is covered by the render harnesses.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { projectRoot } from './testPaths.mjs';

const publicRoot = path.join(projectRoot, 'app/public');

test('the fixed chat header is removed — the conversation panel is just the log over the input row', async () => {
  const html = await readFile(path.join(publicRoot, 'index.html'), 'utf8');
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  // No chat header DOM (companion face cluster / stats container) remains inside #dungeon-chat.
  assert.doesNotMatch(html, /dungeon-chat-head|dungeon-chat-companion|dungeon-chat-stats/, 'the fixed chat header DOM is gone');
  assert.match(html, /<aside id="dungeon-chat"[^>]*>\s*<div id="dungeon-chat-log"/, 'the chat panel opens straight into the log (no header)');
  // No orphan chat-header CSS remains.
  assert.doesNotMatch(css, /\.dungeon-chat-head\b|\.dungeon-chat-companion\b|\.dungeon-chat-stats\b|\.dungeon-chat-heading\b|\.dungeon-chat-name\b/, 'the chat-header CSS is removed');
});

test('with no companion the chat panel shows the empty note in the log area (fail-closed, inputs disabled)', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  assert.match(
    js,
    /function renderDungeonChat\(view\)[\s\S]*chat\.hidden = false;[\s\S]*if \(!view\.companion\) \{[\s\S]*dungeon-chat-empty[\s\S]*同行者はいません[\s\S]*log\.replaceChildren\(empty\)[\s\S]*#dungeon-talk-send'\)\.disabled = true[\s\S]*#dungeon-talk-input'\)\.disabled = true/,
    'the no-companion branch shows the empty note in the log and disables the inputs (fail-closed)'
  );
  // The panel is only hidden when there is no view at all (still always-on during a run).
  assert.match(js, /function renderDungeonChat\(view\)[\s\S]*if \(!view\) \{\s*chat\.hidden = true;\s*return;\s*\}/, 'the panel hides only when there is no view');
  // No roster lookup / ability-bar composition remains in the chat renderer (that moved to the HUD name-click).
  assert.doesNotMatch(js, /function renderDungeonChat\(view\)[\s\S]*renderParameterGroup\(/, 'the chat renderer no longer composes ability bars');
});

test('the HUD party-card names are clickable buttons that open the actor detail', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  // dungeonActorBars takes an onNameClick and builds the name as a clickable button (the shared name-button
  // affordance), surfacing errors rather than swallowing them.
  assert.match(
    js,
    /function dungeonActorBars\(name, actor, down, onNameClick\)[\s\S]*const nameEl = document\.createElement\('button'\);[\s\S]*nameEl\.className = 'dn-hud-actor-name interaction-name-button';[\s\S]*nameEl\.addEventListener\('click', \(\) => \{ try \{ onNameClick\(\); \} catch \(error\) \{ reportError\(error\); \} \}\)/,
    'the party-card name is a clickable button that opens the detail and surfaces errors'
  );
  // The HUD wires 主人公 → hero detail and the companion → companion detail.
  assert.match(
    js,
    /function renderDungeonHud\(view\)[\s\S]*dungeonActorBars\('主人公', view\.player, false, \(\) => openDungeonHeroDetail\(\)\)[\s\S]*if \(view\.companion\) party\.append\(dungeonActorBars\(view\.companion\.name, view\.companion, view\.companion\.down, \(\) => openDungeonCompanionDetail\(view\.companion\)\)\)/,
    'the HUD wires the hero name to the hero detail and the companion name to the companion detail'
  );
});

test('the unified actor-detail shell assembles the shared section grammar (image? / 能力値 / 装備 / 獲得予定)', async () => {
  const html = await readFile(path.join(publicRoot, 'index.html'), 'utf8');
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  // A single shell instance replaces the old character-detail dialog + homunculus popup.
  assert.match(html, /<div id="dungeon-actor-detail" class="dungeon-actor-detail actor-detail-shell"[\s\S]*id="dungeon-actor-detail-title"[\s\S]*id="dungeon-actor-detail-body" class="actor-detail-body"/, 'the dungeon carries a single unified actor-detail shell instance');
  assert.doesNotMatch(html, /dungeon-character-detail-dialog|dungeon-homunculus-detail/, 'the old per-kind detail dialogs are gone');
  // The shared shell builder lays out the section grammar; a null image / acquisition omits that section.
  assert.match(
    js,
    /function buildActorDetailBody\(\{ imageNode = null, parameterNodes, equipmentNode, acquisitionNode = null \}\)[\s\S]*if \(imageNode\) sections\.append\(buildActorDetailSection\(null, \[imageNode\][\s\S]*buildActorDetailSection\('能力値', parameterNodes[\s\S]*buildActorDetailSection\('装備', \[equipmentNode\][\s\S]*if \(acquisitionNode\) sections\.append\(buildActorDetailSection\('獲得予定', \[acquisitionNode\]/,
    'the shell builder assembles image? / 能力値 / 装備 / 獲得予定? from the caller-supplied section nodes'
  );
});

test('the hero detail = 能力値 + 装備 + 獲得予定 (no image), all from the run view / world state (no fetch)', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  assert.match(
    js,
    /function openDungeonHeroDetail\(\)[\s\S]*const params = currentWorld\?\.player_parameters \?\? \{\};[\s\S]*parameterNodes: buildParameterGroups\(params\),[\s\S]*equipmentNode: buildDungeonDetailEquipment\(view\.equipment\),[\s\S]*acquisitionNode: buildDungeonDetailAcquisition\(view\)[\s\S]*openDungeonActorDetail\('主人公', body\)/,
    'the hero detail builds params (world) + equipment (run view) + the 獲得予定 section, no image'
  );
  // The hero detail issues no fetch (all data is already on the page / run view).
  assert.doesNotMatch(js.match(/function openDungeonHeroDetail\(\) \{[\s\S]*?\n}/)?.[0] ?? '', /\/api\//, 'the hero detail issues no fetch');
  // The 獲得予定 section folds in the old carry-home grammar (上昇能力 + 獲得予定装備), fail-fasting on the missing buffer.
  assert.match(
    js,
    /function buildDungeonDetailAcquisition\(view\)[\s\S]*pending_gains_preview[\s\S]*上昇能力[\s\S]*const equipmentBuffer = view\.equipment_buffer;\s*if \(!Array\.isArray\(equipmentBuffer\)\) throw new Error\('dungeon view is missing equipment_buffer'\)[\s\S]*獲得予定装備[\s\S]*buildDungeonEquipmentRows\(equipmentBuffer, 'まだ手に入れた装備はありません。'\)/,
    'the 獲得予定 section carries 上昇能力 + 獲得予定装備 and fail-fasts on a missing equipment_buffer'
  );
});

test('the companion detail = image + 能力値 + 装備 (selectable standee / homunculus face), fail-fast roster miss', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  // A homunculus draws its face + parameters from the run view companion (no fetch); a selectable resolves the
  // roster character for its standee + parameters, and a miss throws (same message as before — no silent no-op).
  assert.match(
    js,
    /function openDungeonCompanionDetail\(companion\)[\s\S]*const homunculus = dungeonCompanionIsHomunculus\(companion\);[\s\S]*if \(homunculus\) \{[\s\S]*image = \{ src: companion\.face_url[\s\S]*shape: 'face' \}[\s\S]*const character = selectableCharacters\.find\(\(item\) => item\.character_id === companion\.character_id\);\s*if \(!character\) throw new Error\(`dungeon companion not found in character roster: \$\{companion\.character_id\}`\)[\s\S]*characterSceneStandeeUrl\(character\)[\s\S]*shape: 'standee' \}/,
    'the companion detail branches homunculus→face / selectable→roster standee and fail-fasts on a roster miss'
  );
  assert.match(
    js,
    /function openDungeonCompanionDetail\(companion\)[\s\S]*imageNode: buildActorDetailImage\(image\),[\s\S]*parameterNodes: buildParameterGroups\(parameters\),[\s\S]*equipmentNode: buildDungeonDetailEquipment\(companion\.equipment\),[\s\S]*acquisitionNode: null[\s\S]*openDungeonActorDetail\(companion\.name, body\)/,
    'the companion detail is image + params + equipment, no 獲得予定 (that is the hero\'s)'
  );
  assert.doesNotMatch(js.match(/function openDungeonCompanionDetail\(companion\) \{[\s\S]*?\n}/)?.[0] ?? '', /\/api\//, 'the companion detail issues no fetch');
});

test('the read-only equipment section reuses the shared instance detail (no 解除), validating slots fail-fast', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  // Null equipment reads as both slots empty; a present snapshot's slots are validated before the DOM is touched
  // (fail-fast). Each occupied slot reuses buildDungeonEquipmentInstanceDetail (the read-only inner builder — the
  // entry UI's 解除 button is NOT added here).
  assert.match(
    js,
    /function buildDungeonDetailEquipment\(runEquipment\)[\s\S]*runEquipment === null[\s\S]*\{ weapon: null, amulet: null \}[\s\S]*validateDungeonEquipmentSlots\(runEquipment\.slots, 'dungeon detail equipment'\)[\s\S]*buildDungeonEquipmentInstanceDetail\(view\)[\s\S]*未装備/,
    'the equipment section null-safes the snapshot, validates slots fail-fast, and reuses the read-only instance detail'
  );
  const fn = js.match(/function buildDungeonDetailEquipment\(runEquipment\) \{[\s\S]*?\n}/)?.[0] ?? '';
  assert.doesNotMatch(fn, /dungeonUnequip|解除/, 'the detail equipment cards carry no 解除 (unequip) button');
});

test('the shell close is wired (× / backdrop) and the detail modal is hidden across renders', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  assert.match(js, /for \(const closer of document\.querySelectorAll\('#dungeon-actor-detail \[data-dungeon-actor-detail-close\]'\)\) \{\s*closer\.addEventListener\('click', \(\) => closeDungeonActorDetail\(\)\);/, 'the × / backdrop close hooks call closeDungeonActorDetail');
  assert.match(js, /function closeDungeonActorDetail\(\)[\s\S]*#dungeon-actor-detail'\);\s*if \(!popup\) \{\s*throw new Error/, 'closeDungeonActorDetail fail-fasts on missing markup');
  // The play / entry / result renders hide the detail modal so a stale detail never lingers.
  assert.match(js, /function renderDungeonPlay\(view\)[\s\S]*closeDungeonActorDetail\(\)/, 'renderDungeonPlay hides the detail modal');
});

test('the retreat confirm is a dedicated dungeon-styled modal (obsidian panel + amber inner-ring, centered)', async () => {
  const html = await readFile(path.join(publicRoot, 'index.html'), 'utf8');
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  // A dedicated modal, not the generic popup + entry action row.
  assert.match(html, /<div id="dungeon-retreat-confirm" class="dungeon-popup dungeon-retreat-confirm-popup"[\s\S]*dungeon-retreat-confirm-panel[\s\S]*id="dungeon-retreat-confirm-body"/, 'the retreat confirm is its own dungeon-styled modal');
  // The confirm builds an eyebrow + title + can_retreat-dependent message + the 撤退する / 続ける CTA pair, with
  // the primary disabled off the entrance/stairs (can_retreat contract preserved).
  assert.match(
    js,
    /function openDungeonRetreatConfirm\(\)[\s\S]*#dungeon-retreat-confirm-body'\);[\s\S]*view\?\.can_retreat[\s\S]*className = 'academy-map-action-button primary';\s*confirm\.textContent = '撤退する';\s*confirm\.disabled = !view\?\.can_retreat;[\s\S]*className = 'academy-map-action-button secondary';\s*cancel\.textContent = '続ける';[\s\S]*popup\.hidden = false/,
    'the confirm floats the 撤退する (primary, gated on can_retreat) / 続ける (secondary) CTA pair'
  );
  // dungeonRetreat closes the dedicated modal (not the generic popup).
  assert.match(js, /async function dungeonRetreat\(\)[\s\S]*closeDungeonRetreatConfirm\(\);\s*await dungeonDo\(\{ type: 'retreat' \}\)/, 'retreat closes the dedicated confirm modal then dispatches the action');
  // The panel wears the obsidian panel + amber inner-ring (the run-end result sibling), id-scoped, token-only.
  assert.match(css, /#academy-dungeon-screen \.dungeon-retreat-confirm-panel \{[\s\S]*box-shadow: 0 18px 44px var\(--dungeon-shadow\), inset 0 0 0 1px var\(--dungeon-inner-ring\)/, 'the confirm panel carries the obsidian shadow + amber inner-ring');
  const block = css.match(/\.dungeon-retreat-confirm-body \{[\s\S]*?\.dungeon-retreat-confirm-actions \{[^}]*\}/)?.[0] ?? '';
  assert.doesNotMatch(block, /rgba?\(|#[0-9a-fA-F]{3,6}\b/, 'the retreat confirm body/actions introduce no literal colors');
});

test('the HUD hosts a retreat button + a help icon button, and the menu button / menu layer is gone', async () => {
  const html = await readFile(path.join(publicRoot, 'index.html'), 'utf8');
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  assert.match(html, /<div class="dungeon-hud-buttons">\s*<button id="dungeon-retreat-button"[^>]*class="dungeon-hud-button"[^>]*>撤退<\/button>\s*<button id="dungeon-help-button"[^>]*class="dungeon-icon-button"[^>]*>\?<\/button>/, 'the HUD holds a retreat button + a help icon button');
  assert.doesNotMatch(html, /id="dungeon-menu-button"/, 'the menu button is gone');
  assert.doesNotMatch(js, /openDungeonMenu|dungeonMenuButton|dungeon-menu-item|dungeon-menu-list/, 'the menu layer (menu open / item builder) is gone');
  // The retreat button opens the confirm; the help button opens the existing help popup directly.
  assert.match(js, /#dungeon-retreat-button'\)\.addEventListener\('click', \(\) => \{ try \{ openDungeonRetreatConfirm\(\); \} catch \(error\) \{ reportError\(error\); \} \}\)/, 'the retreat button opens the confirm modal');
  assert.match(js, /#dungeon-help-button'\)\.addEventListener\('click', \(\) => openDungeonHelp\(\)\)/, 'the help icon button opens the help popup directly');
  // The old stats popup (能力値の詳細 / combat reflections) is removed — its content moved to the hero detail.
  assert.doesNotMatch(js, /openDungeonStats|DUNGEON_PARAM_REFLECTIONS|openDungeonGains/, 'the old stats / carry-home popups are removed (folded into the hero detail)');
});

test('the actor-detail shell keeps a screen-scoped token layer (arena-reusable structure, --dungeon-* only)', async () => {
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  // The structural actor-detail-* classes are toned via the .dungeon-actor-detail container scope, so the arena
  // mirror can reuse the same structure under its own token scope. The dungeon block pins no literal color.
  assert.match(css, /\.dungeon-actor-detail \.actor-detail-panel \{[\s\S]*background: var\(--dungeon-panel\)[\s\S]*inset 0 0 0 1px var\(--dungeon-inner-ring\)/, 'the shell panel is toned by the dungeon token layer');
  assert.match(css, /\.dungeon-actor-detail \.actor-detail-section-head \{[^}]*color: var\(--dungeon-amber\)/, 'the section heads burn the amber token');
  const block = css.match(/\.dungeon-actor-detail \{[\s\S]*?@media \(max-width: 640px\) \{\s*\.dungeon-actor-detail/)?.[0] ?? '';
  assert.ok(block, 'the .dungeon-actor-detail CSS block should be locatable');
  assert.doesNotMatch(block, /rgba?\(|#[0-9a-fA-F]{3,6}\b/, 'the actor-detail shell styles introduce no literal rgba/hex colors');
});
