import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { projectRoot } from './testPaths.mjs';

const publicRoot = path.join(projectRoot, 'app/public');

test('the HUD renders player and companion HP/MP bars in parallel, player-only when solo', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  // A party row holds an actor card per member; the companion card is only added when present
  // (absent = omitted), and a downed companion still gets a card (not omitted). Each card name is a clickable
  // button opening the actor detail (主人公 → hero detail, companion → companion detail).
  assert.match(js, /function renderDungeonHud\(view\)[\s\S]*party\.className = 'dn-hud-party'[\s\S]*party\.append\(dungeonActorBars\('主人公', view\.player, false, \(\) => openDungeonHeroDetail\(\)\)\)[\s\S]*if \(view\.companion\) party\.append\(dungeonActorBars\(view\.companion\.name, view\.companion, view\.companion\.down, \(\) => openDungeonCompanionDetail\(view\.companion\)\)\)/, 'player always shown; companion card added whenever a companion exists; names open the detail');
  // Each actor card carries a clickable name + HP + MP bars; a downed member adds a 戦闘不能 marker but KEEPS
  // its bars (only an absent companion is omitted). No default-value option fallback.
  assert.match(js, /function dungeonActorBars\(name, actor, down, onNameClick\)[\s\S]*dn-hud-actor-name[\s\S]*if \(down\)[\s\S]*戦闘不能[\s\S]*\}[\s\S]*dungeonBarEl\('HP', actor\.hp, actor\.max_hp[\s\S]*dungeonBarEl\('MP', actor\.mp, actor\.max_mp/, 'a party card shows name (+ a downed marker) and always its HP+MP bars');
  assert.doesNotMatch(js, /function dungeonActorBars\([^)]*=\s*false/, 'dungeonActorBars takes an explicit down (no default-value fallback)');
});

test('party HUD styles use semantic tokens (no literal rgba) and harmonize with the HUD', async () => {
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  assert.match(css, /\.dn-hud-party \{[\s\S]*display: flex[\s\S]*flex-wrap: nowrap[\s\S]*\}/, 'party row lays the cards out side by side on one non-wrapping row (reflow-stable height)');
  assert.match(css, /\.dn-hud-actor \{[\s\S]*background: var\(--dungeon-chip\)[\s\S]*border: 1px solid var\(--dungeon-line/, 'actor cards consume the obsidian dungeon surface/border tokens');
  assert.match(css, /\.dn-hud-actor-name \{[\s\S]*color: var\(--dungeon-ink-strong\)/, 'the actor name uses the dungeon ivory ink token');
  assert.match(css, /\.dn-hud-actor \.dn-hud-bar \{[\s\S]*min-width: 0/, 'bars inside a card fill the card instead of the standalone min-width');
  // No raw rgba()/hex colors introduced in the party HUD block (token-only).
  const block = css.match(/\.dn-hud-party \{[\s\S]*?\.dn-hud-bar \{/)?.[0] ?? '';
  assert.doesNotMatch(block, /rgba\(|#[0-9a-fA-F]{3,6}\b/, 'party HUD styles introduce no literal rgba/hex colors');
});

test('the HUD keeps a content-stable height while the vitals stay visible and 持ち帰り moves to the hero detail', async () => {
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');

  // Height stability (unchanged contract): the status and party rows never wrap, and the status does
  // not clip — a widening turn / HP/MP text cannot add a line and resize the map viewport mid-run.
  assert.match(css, /\.dungeon-hud-status \{[\s\S]*flex-wrap: nowrap[\s\S]*min-width: 0[\s\S]*\}/, 'the HUD status row does not wrap');
  assert.match(css, /\.dn-hud-party \{[\s\S]*flex-wrap: nowrap[\s\S]*min-width: 0[\s\S]*\}/, 'the party row stays on one line');
  const statusBlock = css.match(/\.dungeon-hud-status \{[\s\S]*?\}/)?.[0] ?? '';
  assert.doesNotMatch(statusBlock, /overflow:\s*hidden/, 'the status row does not clip its content');
  // The 戦闘不能 marker rides the name row, so the card keeps exactly head + HP + MP across down states.
  assert.match(js, /function dungeonActorBars\(name, actor, down, onNameClick\)[\s\S]*dn-hud-actor-head[\s\S]*head\.append\(nameEl\)[\s\S]*if \(down\)[\s\S]*head\.append\(state\)[\s\S]*\}[\s\S]*card\.append\(head\)/, 'the downed marker rides the name row (constant card height)');
  assert.doesNotMatch(js, /card\.append\(state\)/, 'the downed marker is never a separate card row');

  // ① HP/MP bars stay visible: the track holds a minimum width and the party/cards take the freed
  // width (grow), so a tight card never squeezes the bar to nothing.
  assert.match(css, /\.dn-hud-bar-track \{[\s\S]*min-width: 72px[\s\S]*\}/, 'the HP/MP bar track keeps a visible minimum width');
  assert.match(css, /\.dn-hud-party \{[\s\S]*flex: 1 1 auto[\s\S]*\}/, 'the party takes the width freed by removing the header gains chip');
  assert.match(css, /\.dn-hud-actor \{[\s\S]*flex: 1 1 200px[\s\S]*\}/, 'the actor cards grow to fill the freed width');

  // ② 持ち帰り is not on the header (no gains chip in JS or CSS); it now lives in the hero detail's 獲得予定
  // section (opened from the 主人公 party-card name). The header menu button / menu layer is gone entirely.
  assert.doesNotMatch(js, /dn-hud-chip--gains/, 'no gains chip class is built on the HUD header');
  assert.doesNotMatch(css, /dn-hud-chip--gains/, 'no orphan gains-chip CSS remains');
  assert.doesNotMatch(js, /dungeonGainsChip|dungeonGainsText|dungeonGainsCount/, 'the header gains-chip/text/count helpers are gone');
  assert.doesNotMatch(js, /dungeonChipEl\('持/, 'no carry-home chip is built on the header');
  assert.doesNotMatch(js, /openDungeonMenu|openDungeonGains/, 'the menu / carry-home popup is removed (folded into the hero detail)');
  assert.doesNotMatch(js, /dungeonMaterialCount/, 'the removed 品目数 helper leaves no trace (materials moved to the column)');
  // The hero detail's 獲得予定 section carries ONLY the pending 能力上昇 breakdown (magic + abilities in the
  // gains grid) + the 獲得予定装備; the picked-up materials are not duplicated here (they live in the column).
  assert.match(js, /function buildDungeonDetailAcquisition\(view\)[\s\S]*pending_gains_preview[\s\S]*DUNGEON_MAGIC_LABELS[\s\S]*DUNGEON_ABILITY_LABELS[\s\S]*dungeon-gains-grid[\s\S]*まだ持ち帰る能力上昇はありません。[\s\S]*獲得予定装備/, 'the 獲得予定 section renders the pending-gains breakdown with its explicit empty note');
  const acqFn = js.match(/function buildDungeonDetailAcquisition\(view\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(acqFn, '', 'buildDungeonDetailAcquisition is present');
  assert.doesNotMatch(acqFn, /material_buffer|拾った素材/, 'the 獲得予定 section renders no materials (no double display)');

  // The 拾った素材 column is rendered from view.material_buffer (display name + count), fail-fasting on a
  // broken contract, with an explicit empty note — the sole in-run home of the picked-up materials.
  assert.match(js, /function renderDungeonMaterials\(view\)[\s\S]*view\.material_buffer[\s\S]*if \(!Array\.isArray\(buffer\)\) throw[\s\S]*fillDungeonItemColumn\(list, buffer, buildDungeonMaterialRow, 'まだ拾った素材はありません。'\)/, 'the material column reads view.material_buffer, fail-fasts on a broken contract, and names an explicit empty state');
  assert.match(js, /function buildDungeonMaterialRow\(item\)[\s\S]*item\.display_name[\s\S]*×\$\{item\.quantity\.toLocaleString\('ja-JP'\)\}/, 'a material row shows the server display name and the picked-up count');

  // The 獲得予定 section chrome consumes only --dungeon-* tokens (no literal colors).
  assert.match(css, /\.dungeon-gains-subhead \{[^}]*color:\s*var\(--dungeon-amber\)/, 'the section sub-heading burns the amber accent token');
  assert.match(css, /\.dungeon-gains-empty \{[^}]*color:\s*var\(--dungeon-ink-dim\)/, 'the empty-state note reads in the dim ink token');
  const gainsChrome = (css.match(/\.dungeon-gains[\w-]*\s*\{[^}]*\}/g) ?? []).join('\n');
  assert.doesNotMatch(gainsChrome, /rgba\(|#[0-9a-fA-F]{3,6}\b/, 'the carry-home chrome introduces no literal rgba/hex colors');
});
