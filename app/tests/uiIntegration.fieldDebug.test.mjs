import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runtimePublicReferenceRoot, runtimeSourceReferenceRoot, projectRoot } from './testPaths.mjs';
import { readUiSource, cssRuleBlock, assertBigframeShell, assertNoCoolOrSoftBorderToken } from './fixtures/uiSource.mjs';

const root = runtimePublicReferenceRoot;
const sourceRoot = runtimeSourceReferenceRoot;
const readFile = readUiSource;

test('shop screen is a full-bleed 深夜の学院 surface: own --shop-night-* token layer, hero money badge, two-panel board, inventory material badges, internal scroll (test-by-token)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  const shopBlock = html.match(/<section id="shop-screen"[\s\S]*?<section id="debug-screen"/)?.[0] ?? '';
  // Full-screen direct deep-night surface (学院マップと同族): the shop owns a .shop-night-shell — no shared
  // academy-map-shell / academy-shop-shell card 外殻. The hero carries the money badge + academy-map return, the
  // board keeps the two dedicated panels. All 7 維持必須 DOM hook ids survive.
  assert.match(shopBlock, /class="shop-night-shell"[\s\S]*class="shop-night-hero"[\s\S]*class="shop-night-hero-copy"[\s\S]*id="shop-title">購買<[\s\S]*class="shop-night-hero-actions"[\s\S]*class="shop-night-money-card"[\s\S]*id="shop-inventory-money"[\s\S]*id="shop-back-to-map"[^>]*>学院マップに戻る</, 'shop screen is a self-owned deep-night shell whose hero carries the player-money badge and the academy-map return action');
  assert.match(shopBlock, /class="shop-night-board"[\s\S]*class="shop-night-panel shop-inventory-column"[\s\S]*id="shop-inventory-title"[\s\S]*id="shop-inventory-items"[\s\S]*class="shop-night-panel shop-catalog-column"[\s\S]*id="shop-money-title"[\s\S]*id="shop-items"/, 'shop board keeps the inventory and catalog panels as deep-night panels with the required hook ids');
  assert.doesNotMatch(shopBlock, /academy-map-shell|academy-shop-shell|academy-shop-hero|academy-shop-board|academy-shop-panel|academy-shop-money-card|academy-shop-item-list/, 'the old academy shell 外殻 / academy-shop-* scaffolding must be gone from the shop markup');
  assert.doesNotMatch(shopBlock, /class="shop-shell"|shop-screen-heading|shop-heading-row|economy-panel app-card|id="shop-money"/, 'no legacy shop-shell / screen-heading / economy-panel / duplicate money scaffolding remains');
  assert.match(shopBlock, /各種霊薬を取り揃えている学院購買部。必要な道具や品物を売買できる。/, 'catalog column should use the requested academy-store description');
  assert.match(js, /function academyMapShopNode\(\) \{[\s\S]*description: '各種霊薬を取り揃えている学院購買部。必要な道具や品物を売買できる。'[\s\S]*visible_situation: '各種霊薬を取り揃えている学院購買部。必要な道具や品物を売買できる。'/, 'academy-map shop detail preview should reuse the requested academy-store description');
  assert.match(html, /id="economy-message-box" class="economy-message-box" role="status" aria-live="polite"/, 'economy actions should expose a global message box surface');

  // Renderer behavior is unchanged (money / owned items / sell + buy), driven from the same inventory/shop state.
  assert.match(js, /function renderShopInventoryColumn\(inventory = currentInventory\)[\s\S]*#shop-inventory-money[\s\S]*#shop-inventory-items[\s\S]*sellInventoryItem\(item\.item_id\)/, 'shop inventory column should render money, owned items, and sell actions from current inventory');
  assert.match(js, /function renderShop\(shop = currentShop\)[\s\S]*#shop-money-title[\s\S]*#shop-items[\s\S]*buyShopItem\(item\.item_id\)/, 'catalog renderer should keep the academy-store title and item list without depending on a duplicate money field');
  assert.doesNotMatch(js, /querySelector\('\#shop-money'\)|querySelector\("\#shop-money"\)/, 'catalog renderer should not query the removed duplicate money field');
  assert.match(js, /function refreshEconomy\(\)[\s\S]*renderInventory\(inventory\)[\s\S]*renderShopInventoryColumn\(inventory\)[\s\S]*renderShop\(shop\)/, 'economy refresh should keep legacy inventory, shop inventory column, and catalog in sync');
  assert.match(js, /function showEconomyMessage\(message\)[\s\S]*#economy-message-box[\s\S]*classList\.add\('visible'\)/, 'economy message helper should drive the global message box');
  assert.match(js, /async function buyShopItem\(itemId\)[\s\S]*showEconomyMessage\(`\$\{result\.item\.name \?\? result\.item\.item_id\}を\$\{moneyText\(result\.item\.buy_price\)\}で購入しました。`\)/, 'buy flow should announce the purchased item and price');
  assert.match(js, /async function sellInventoryItem\(itemId\)[\s\S]*showEconomyMessage\(`\$\{result\.item\.name \?\? result\.item\.item_id\}を\$\{moneyText\(result\.item\.sell_price\)\}で売却しました。`\)/, 'sell flow should announce the sold item and price');

  // 素材メタバッジ配線: the owned-items column appends the shared builder's 属性/T badges right after
  // name/quantity, guarded on a non-null return (non-materials render unchanged; the builder's fail-fast is the
  // shared one asserted in the four-surface test).
  const shopColumnFn = js.match(/function renderShopInventoryColumn\(inventory = currentInventory\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(shopColumnFn, '', 'renderShopInventoryColumn is present');
  assert.match(shopColumnFn, /card\.append\(title\);\s*const materialMeta = buildInventoryMaterialMeta\(item, 'shop-night-item-materia'\);\s*if \(materialMeta\) card\.append\(materialMeta\);\s*card\.append\(price, description, actionRow\);/, 'the owned-items column appends the material badges right after name/quantity, only when the item is a material');
  // 全部使う: usable rows carry a second use button that spends the owned quantity in one POST; both use buttons send
  // an explicit quantity (1 for 1個使う, 所持数 for 全部使う), and non-usable rows keep only the disabled 使えません.
  assert.match(shopColumnFn, /use\.textContent = item\.stat_effect \? '1個使う' : '使えません';[\s\S]*useInventoryItem\(item\.item_id, 1\)/, 'the shop 1個使う button spends one unit with an explicit quantity');
  assert.match(shopColumnFn, /if \(item\.stat_effect\) \{[\s\S]*useAll\.textContent = '全部使う';[\s\S]*useInventoryItem\(item\.item_id, item\.quantity\)[\s\S]*actionRow\.append\(useAll\);/, 'usable shop rows add a 全部使う button that spends the owned quantity in one use');

  // CSS test-by-token — full-bleed layout + own deep-night token layer, consumed by var() only.
  const shopSection = css.match(/\/\* ── 購買画面「深夜の学院」層[\s\S]*?(?=\/\* ── 採取画面（#gathering-screen 専用）)/)?.[0] ?? '';
  assert.notEqual(shopSection, '', 'the shop deep-night CSS section should exist');
  const shopTokenBlock = shopSection.match(/body:has\(#shop-screen\.active\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(shopTokenBlock, /--shop-night-0:\s*#05060f;[\s\S]*?--shop-night-silver:\s*#cdd6ea;[\s\S]*?--shop-night-starlight:\s*#9fb4ff;[\s\S]*?--shop-night-panel-strong:\s*rgb\(9 12 26 \/ 0\.82\);/, 'the shop declares its own deep-night token layer (deep-night / silver / starlight) on the purchasing-active body scope so both the #shop-screen subtree and the global #economy-message-box overlay inherit one literal source');
  assert.match(css, /body:has\(#shop-screen\.active\) \.layout\s*\{[\s\S]*height:\s*calc\(100dvh - var\(--runtime-topbar-height, 88px\)\)[\s\S]*padding:\s*0[\s\S]*overflow:\s*hidden/, 'the shop screen bleeds full-screen (padding:0) under the viewport-height layout constraint, like the academy map night surface');
  assert.match(css, /#shop-screen\.active\s*\{[\s\S]*display:\s*grid[\s\S]*height:\s*100%[\s\S]*min-height:\s*0/, 'active shop screen fills the bounded layout height');
  assert.match(css, /\.shop-night-shell\s*\{[\s\S]*grid-template-rows:\s*auto minmax\(0, 1fr\)[\s\S]*linear-gradient\(160deg, var\(--shop-night-1\), var\(--shop-night-0\) 62%\)/, 'the shop shell paints the deep-night ground from its own night token layer (no shared --surface-bigframe / --surface-map-shell window fill)');
  assert.doesNotMatch(shopSection, /--surface-bigframe|--surface-map-shell|--border-warm|--border-soft|--surface-panel|--surface-academy-training-orbit|--shadow-academy-training-panel|--accent-gold|--text-subtle|--eyebrow/, 'the shop night section consumes none of the old shared warm-chrome tokens');
  assert.match(css, /\.shop-night-hero\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) auto[\s\S]*align-items:\s*stretch/, 'shop hero reserves a right-side lane for the money badge and map return button');
  assert.match(css, /\.shop-night-hero-copy,\s*\.shop-night-panel\s*\{[\s\S]*border:\s*1px solid var\(--shop-night-line\)[\s\S]*background:\s*var\(--shop-night-panel\)/, 'hero copy and board panels are deep-night silver panels from the night token layer');
  assert.match(css, /\.shop-night-money-card\s*\{[\s\S]*border-radius:\s*var\(--radius-training-orbit-card\)[\s\S]*background:\s*var\(--shop-night-panel-strong\)/, 'the money badge is repainted as a deep-night panel (night tokens, not the warm training orbit-card fill)');
  assert.match(css, /\.shop-night-board\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)[\s\S]*min-height:\s*0/, 'shop board keeps equal-width two-column proportions');
  assert.match(css, /\.shop-night-panel\s*\{[\s\S]*grid-template-rows:\s*auto auto minmax\(0, 1fr\)[\s\S]*min-height:\s*0/, 'each shop panel reserves heading rows and lets only the item area stretch');
  assert.match(css, /#shop-inventory-items,\s*#shop-items\s*\{[\s\S]*overflow-y:\s*auto/, 'both trade lists scroll internally instead of growing the full page');
  assert.match(css, /#shop-screen \.economy-item-card\s*\{[\s\S]*border:\s*1px solid var\(--shop-night-line\)[\s\S]*background:\s*var\(--shop-night-panel\)/, 'the shared economy card is id-scoped into the night layer inside the shop (shared base untouched)');
  assert.match(css, /\.shop-night-item-materia span\s*\{[\s\S]*border:\s*1px solid var\(--shop-night-line\)[\s\S]*background:\s*var\(--shop-night-panel\)[\s\S]*color:\s*var\(--shop-night-silver-strong\)/, 'the owned-item material badges are deep-night silver pills from the night token layer');
  // The 学院マップに戻る button (#shop-back-to-map, shared .academy-map-action-button.secondary) is id-scope
  // recolored into the deep-night silver skin — the shared base still wears warm-gold, but nothing warm-gold
  // survives on the shop screen. Repaints every state (default / hover / focus-visible / active).
  assert.match(css, /#shop-screen \.academy-map-action-button\s*\{[\s\S]*border:\s*1px solid var\(--shop-night-line-strong\)[\s\S]*background:\s*var\(--shop-night-panel\)[\s\S]*color:\s*var\(--shop-night-silver-strong\)[\s\S]*box-shadow:\s*0 0 10px var\(--shop-night-glow\)/, 'the shop return button is repainted as a deep-night silver panel with a starlight hairline (night tokens, not the shared warm-gold chrome)');
  assert.match(css, /#shop-screen \.academy-map-action-button:hover:not\(:disabled\)\s*\{[\s\S]*border-color:\s*var\(--shop-night-starlight\)[\s\S]*background:\s*var\(--shop-night-panel-strong\)[\s\S]*box-shadow:\s*0 0 18px var\(--shop-night-glow\)/, 'hover brightens the night panel with the starlight edge (no warm-gold hover border / --shadow-map-button-hover)');
  assert.match(css, /#shop-screen \.academy-map-action-button:focus-visible\s*\{[\s\S]*border-color:\s*var\(--shop-night-starlight\)[\s\S]*box-shadow:\s*0 0 0 2px var\(--shop-night-glow\)/, 'focus rings with the starlight glow instead of the shared warm-gold focus');
  assert.match(css, /#shop-screen \.academy-map-action-button:active:not\(:disabled\)\s*\{[\s\S]*border-color:\s*var\(--shop-night-starlight\)[\s\S]*background:\s*var\(--shop-night-panel-strong\)/, 'active keeps the deep-night silver panel');
  assert.doesNotMatch(shopSection, /--c-gold|--c-cream|--btn-secondary-bg|--btn-primary-bg|--text-strong|--border-academy-action-button|--shadow-map-button/, 'no shop-scoped rule consumes any day/shared warm-gold button token (test-by-token night contract)');
  assert.match(css, /@media \(max-width: 980px\) \{[\s\S]*\.shop-night-hero\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)[\s\S]*\.shop-night-hero-actions\s*\{[\s\S]*justify-content:\s*flex-start[\s\S]*\.shop-night-board\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/, 'narrow screens stack the hero lane and collapse the shop board to one column');
  // test-by-token: outside the single token declaration block, no shop-scoped rule pins a literal color.
  const shopConsumers = shopSection.replace(shopTokenBlock, '');
  assert.doesNotMatch(shopConsumers, /#[0-9a-fA-F]{3,8}\b/, 'no shop-scoped rule pins a literal hex color (only the --shop-night-* declaration block declares literals)');
  assert.doesNotMatch(shopConsumers, /\brgba?\(/, 'no shop-scoped rule pins a literal rgb/rgba color (consume --shop-night-* tokens only)');
  // Old academy-shop-* / legacy shop scaffolding CSS is fully removed.
  assert.doesNotMatch(css, /\.academy-shop-shell\b|\.academy-shop-hero\b|\.academy-shop-board\b|\.academy-shop-panel\b|\.academy-shop-money-card\b|\.academy-shop-item-list\b|\.shop-shell\s*\{|\.shop-grid\s*\{|\.shop-column\s*\{|\.shop-heading-row\s*\{/, 'the old academy-shop-* and legacy shop scaffolding CSS must be removed so no dead rules linger');
  const economyMessageBoxCss = cssRuleBlock(css, '.economy-message-box');
  assert.notEqual(economyMessageBoxCss, '', 'the .economy-message-box rule should exist');
  assert.match(economyMessageBoxCss, /position:\s*fixed[\s\S]*opacity:\s*0[\s\S]*transform:/, 'economy message box stays an animated fixed overlay');
  const economyMessageBoxVisibleCss = cssRuleBlock(css, '.economy-message-box.visible');
  assert.notEqual(economyMessageBoxVisibleCss, '', 'the .economy-message-box.visible rule should exist');
  assert.match(economyMessageBoxVisibleCss, /opacity:\s*1/, 'the economy message box becomes visible on trade actions');
  // The 購買 feedback balloon (#economy-message-box) is a body-level fixed overlay outside #shop-screen, so a
  // `#shop-screen ...` descendant override can't reach it. While purchasing is active it is id-scope repainted into
  // the deep-night skin from the same --shop-night-* layer (no literal color), and the shared base stays untouched
  // (byte-equivalent) so other screens keep their tone. position/opacity/transform are the base's.
  assert.match(css, /body:has\(#shop-screen\.active\) \.economy-message-box\s*\{[\s\S]*border:\s*1px solid var\(--shop-night-line-strong\)[\s\S]*background:\s*var\(--shop-night-panel-strong\)[\s\S]*color:\s*var\(--shop-night-moon\)[\s\S]*box-shadow:\s*0 18px 44px var\(--shop-night-shadow\)/, 'the purchasing-active feedback balloon is repainted into the deep-night skin from the --shop-night-* layer only (shared base byte-equivalent)');
  assert.match(shopSection, /body:has\(#shop-screen\.active\) \.economy-message-box/, 'the balloon night skin lives in the shop deep-night section and is covered by its test-by-token literal-color check');
});

test('shop inventory column splits into 所持品／装備 tabs; the 装備 tab sells equipment instances with an equipped-gate', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  const shopBlock = html.match(/<section id="shop-screen"[\s\S]*?<section id="debug-screen"/)?.[0] ?? '';
  // The inventory column carries a two-tab bar (所持品 default active, 装備) over two panes. The 所持品 pane keeps
  // the existing help + #shop-inventory-items hook; the 装備 pane adds #shop-equipment-items and starts hidden so
  // the default view is byte-equivalent to the pre-tab 所持品 list.
  assert.match(shopBlock, /<div class="shop-inventory-tabs" role="tablist"[\s\S]*<button id="shop-inventory-tab-items"[^>]*class="shop-inventory-tab active" data-shop-inventory-tab="items"[^>]*aria-selected="true">所持品<[\s\S]*<button id="shop-inventory-tab-equipment"[^>]*data-shop-inventory-tab="equipment"[^>]*aria-selected="false">装備</, 'the inventory column exposes 所持品(既定active)/装備 tabs');
  assert.match(shopBlock, /<div class="shop-inventory-pane" data-shop-inventory-pane="items">\s*<p class="shop-night-panel-help">[\s\S]*<div id="shop-inventory-items" class="economy-item-list shop-night-item-list" aria-label="shop inventory items">/, 'the 所持品 pane keeps the existing help paragraph and #shop-inventory-items hook');
  assert.match(shopBlock, /<div class="shop-inventory-pane" data-shop-inventory-pane="equipment" hidden>[\s\S]*<div id="shop-equipment-items" class="economy-item-list shop-night-item-list" aria-label="shop equipment items">/, 'the 装備 pane starts hidden and carries the #shop-equipment-items list');

  // economy refresh also loads the equipment snapshot and renders the 装備 tab from it (same cadence as inventory/shop).
  assert.match(js, /function refreshEconomy\(\)[\s\S]*getJson\('\/api\/equipment'\)[\s\S]*renderShopInventoryColumn\(inventory\)[\s\S]*renderShop\(shop\)[\s\S]*renderShopEquipmentColumn\(equipment\)/, 'economy refresh fetches /api/equipment and renders the equipment column alongside inventory/shop');

  // The 装備 tab renders from instances + the parallel sales view (shared GET /api/equipment validator + a sales
  // validator that fail-fasts on a length / id / price / equipped mismatch — no client default price, no silent skip).
  assert.match(js, /function renderShopEquipmentColumn\(snapshot = currentShopEquipmentSnapshot\)[\s\S]*#shop-equipment-items[\s\S]*validateDungeonEquipmentSnapshot\(snapshot\)[\s\S]*validateShopEquipmentSales\(snapshot\.sales, view\.instances\)/, 'the equipment column renders from the shared snapshot instances paired with the sales view');
  assert.match(js, /function validateShopEquipmentSales\(rawSales, instances\)[\s\S]*sales length \$\{rawSales\.length\} must match instances length[\s\S]*sales\[\$\{index\}\]\.instance_id[\s\S]*must match instances[\s\S]*sell_price must be a positive integer[\s\S]*equipped must be a boolean/, 'the sales validator fail-fasts on length / id / price / equipped shape');

  // Each row shows name + the shared identity meta line + 売値; equipped rows disable the sell action and show a
  // 装備中 badge (the row stays visible — not silently hidden); unequipped rows wire the sell handler.
  assert.match(js, /function buildShopEquipmentCard\(entry\)[\s\S]*meta\.textContent = dungeonEquipmentInstanceMetaText\(instance\)[\s\S]*price\.textContent = `売値 \$\{moneyText\(sellPrice\)\}`/, 'each equipment row shows the identity meta line and 売値');
  assert.match(js, /if \(equipped\) \{\s*sell\.disabled = true;[\s\S]*shop-equipment-equipped-tag[\s\S]*equippedTag\.textContent = '装備中';[\s\S]*\} else \{\s*sell\.addEventListener\('click', \(\) => sellEquipmentInstance\(instance\.instance_id\)\.catch\(reportShopEquipmentSellError\)\);/, 'equipped rows disable sell + show 装備中; unequipped rows wire the sell action');

  // The sell flow posts sell-equipment, updates money/所持品 from the response inventory, re-fetches the equipment
  // list (the response carries none), and announces the sale through the shared economy message box.
  assert.match(js, /async function sellEquipmentInstance\(instanceId\)[\s\S]*postJson\('\/api\/shop\/sell-equipment', \{ instance_id: instanceId \}\)[\s\S]*renderInventory\(result\.inventory\)[\s\S]*renderShopInventoryColumn\(result\.inventory\)[\s\S]*renderShopEquipmentColumn\(await getJson\('\/api\/equipment'\)\)[\s\S]*showEconomyMessage\(`\$\{result\.sold_instance\.name\}を\$\{moneyText\(result\.sell_price\)\}で売却しました。`\)/, 'the sell flow posts sell-equipment, refreshes inventory + equipment, and announces the sale');

  // The two backend domain error codes surface through the economy message box (明示表示・自動リトライなし);
  // anything else re-raises to reportError (no silent mapping of an unexpected failure to a friendly message).
  assert.match(js, /SHOP_EQUIPMENT_SELL_ERROR_MESSAGES = \{\s*equipment_instance_equipped: '[^']+',\s*unknown_equipment_instance: '[^']+'/, 'both backend domain error codes map to economy messages');
  assert.match(js, /function reportShopEquipmentSellError\(error\)[\s\S]*SHOP_EQUIPMENT_SELL_ERROR_MESSAGES\[error\?\.payload\?\.error\][\s\S]*if \(!message\) \{\s*reportError\(error\);[\s\S]*showEconomyMessage\(message\)/, 'known domain codes show an economy message; an unknown error re-raises to reportError');

  // The tab switch toggles the active tab + visible pane and fail-fasts on an unknown tab; both tabs are wired.
  assert.match(js, /function selectShopInventoryTab\(tab\)[\s\S]*SHOP_INVENTORY_TABS\.includes\(tab\)[\s\S]*throw new Error\(`shop inventory tab is not a known value[\s\S]*\.shop-inventory-tab'\)[\s\S]*classList\.toggle\('active', active\)[\s\S]*\.shop-inventory-pane'\)[\s\S]*pane\.hidden = pane\.dataset\.shopInventoryPane !== tab/, 'the tab switch toggles the active tab + visible pane and fail-fasts on an unknown tab');
  assert.match(js, /for \(const tab of document\.querySelectorAll\('\.shop-inventory-tab'\)\) \{\s*tab\.addEventListener\('click', \(\) => \{\s*try \{ selectShopInventoryTab\(tab\.dataset\.shopInventoryTab\); \} catch \(error\) \{ reportError\(error\); \}/, 'both inventory tabs are wired to the tab switch');

  // The inactive pane is hidden by a scoped [hidden] guard over the author display:grid (ref-ui-tokens [hidden]
  // gotcha), and the 装備 list scrolls internally like the other trade lists — all token-only (no literal colors).
  assert.match(css, /\.shop-inventory-pane\[hidden\]\s*\{\s*display:\s*none;\s*\}/, 'the inactive inventory pane is hidden by the scoped [hidden] guard');
  assert.match(css, /#shop-equipment-items\s*\{[\s\S]*overflow-y:\s*auto/, 'the equipment list scrolls internally');
  const shopSection = css.match(/\/\* ── 購買画面「深夜の学院」層[\s\S]*?(?=\/\* ── 採取画面（#gathering-screen 専用）)/)?.[0] ?? '';
  const shopTokenBlock = shopSection.match(/body:has\(#shop-screen\.active\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  const shopConsumers = shopSection.replace(shopTokenBlock, '');
  assert.doesNotMatch(shopConsumers, /#[0-9a-fA-F]{3,8}\b/, 'the tab / pane rules pin no literal hex color (token-only)');
  assert.doesNotMatch(shopConsumers, /\brgba?\(/, 'the tab / pane rules pin no literal rgb/rgba color (consume --shop-night-* tokens only)');
});

test('debug screen exposes buddy and enemy relationship flag controls', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const debugBlock = html.match(/<section id="debug-screen"[\s\S]*<\/main>/)?.[0] ?? '';

  assert.match(debugBlock, /aria-label="relationship flags"[\s\S]*id="relationship-character-select"[\s\S]*id="set-debug-buddy"[\s\S]*id="clear-debug-buddy"[\s\S]*id="add-debug-enemy"[\s\S]*id="remove-debug-enemy"[\s\S]*id="clear-debug-enemies"[\s\S]*id="relationship-debug-status"/, 'debug screen should provide direct buddy/enemy flag controls and a current-state summary');
  assert.match(debugBlock, /経過週数[\s\S]*id="debug-elapsed-weeks"[\s\S]*id="set-debug-weeks"[\s\S]*id="debug-weeks-status"/, 'debug screen should expose direct elapsed-weeks editing controls for graduation testing');
  assert.match(js, /function renderRelationshipDebugControls\(\)[\s\S]*#relationship-character-select[\s\S]*currentRuntimeState\?\.current_buddy_character_id[\s\S]*current_enemy_character_ids/, 'browser should render relationship debug controls from current runtime state');
  assert.match(js, /function renderRelationshipDebugControls\(\)[\s\S]*document\.querySelector\('#debug-elapsed-weeks'\)[\s\S]*document\.querySelector\('#debug-weeks-status'\)[\s\S]*currentRuntimeState\?\.elapsed_weeks/, 'browser should render elapsed-weeks debug controls from current runtime state alongside relationship debug info');
  assert.match(js, /async function setDebugRelationships\([\s\S]*postJson\('\/api\/debug\/relationships'[\s\S]*buddy_character_id[\s\S]*enemy_character_ids/, 'browser relationship controls should persist through the debug relationships API');
  assert.match(js, /async function setDebugElapsedWeeks\([\s\S]*postJson\('\/api\/debug\/weeks'[\s\S]*elapsed_weeks/, 'browser elapsed-weeks controls should persist through the debug weeks API');
  for (const selector of ['#set-debug-buddy', '#clear-debug-buddy', '#add-debug-enemy', '#remove-debug-enemy', '#clear-debug-enemies']) {
    assert.match(js, new RegExp(`${selector.replace('#', '\\#')}[\\s\\S]*addEventListener`), `${selector} should be wired`);
  }
});

test('field and interaction controls are placed in the requested play/debug columns', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /<div id="field-left-column"[\s\S]*id="field-route-list"[\s\S]*id="field-location-detail-dialog"[\s\S]*<div id="field-right-column"[\s\S]*id="character-selection-list"/, 'field left column should contain movement choices and a location detail popup, while right column contains character selection');
  const fieldBlock = html.match(/<section id="field-screen"[\s\S]*?<section id="academy-conversation-session-screen"/)?.[0] ?? '';
  assert.doesNotMatch(fieldBlock, /id="current-location-card"|id="background-panel"/, 'field should not keep the old upper-left current-location panel inline');
  assert.match(fieldBlock, /id="field-current-location-button"[\s\S]*id="field-location-detail-dialog"[\s\S]*id="field-location-detail-title">現在地<[\s\S]*id="field-location-detail-image"[\s\S]*id="field-location-detail-text"/, 'field current location details should live in a popup opened from the movement panel');
  assert.match(fieldBlock, /id="selected-character-name-button"[\s\S]*id="field-character-detail-dialog"[\s\S]*id="field-character-detail-title">選択中のキャラ<[\s\S]*id="character-prompt-description"[\s\S]*id="character-speaking-basis"[\s\S]*id="character-memory-records"[\s\S]*id="character-skill-records"[\s\S]*id="character-work-records"/, 'field selected character name should open a popup containing description, speaking style, and character records');
  const fieldSelectionBlock = fieldBlock.match(/<section class="character-select-panel"[\s\S]*?<dialog id="field-character-detail-dialog"/)?.[0] ?? '';
  assert.doesNotMatch(fieldSelectionBlock, /id="character-prompt-description"|id="character-speaking-basis"|id="character-memory-records"|id="character-skill-records"|id="character-work-records"/, 'field character details should not stay inline under the selection list');
  const fieldCharacterDialog = fieldBlock.match(/<dialog id="field-character-detail-dialog"[\s\S]*?<\/dialog>/)?.[0] ?? '';
  assert.match(fieldCharacterDialog, /class="character-detail-layout"[\s\S]*id="field-character-detail-standee"[\s\S]*id="character-prompt-description"[\s\S]*id="character-speaking-basis"/, 'field character detail popup should show the scene standee to the left of editable information');
  const debugBlock = html.match(/<section id="debug-screen"[\s\S]*<\/main>/)?.[0] ?? '';
  assert.doesNotMatch(debugBlock, /runtime_state|asset resolver|continuity record status|Interaction Debug/, 'debug screen should remove the requested obsolete panels');
  assert.doesNotMatch(debugBlock, /id="state-json"|id="asset-json"|id="record-status"|id="provider-select"|id="refresh-prompt"|id="prompt-preview"|id="conversation-log"|id="work-record-recall-debug"/, 'debug screen should not keep obsolete runtime, asset, continuity, or interaction debug controls');
  assert.match(debugBlock, /id="set-all-flags-on"[\s\S]*id="flag-title-list"[\s\S]*id="llm-request-list"/, 'debug screen should keep flags with the all-on control at the top and recent LLM requests');
  assert.match(html, /id="flag-detail-dialog"[\s\S]*id="toggle-flag-active"[\s\S]*id="toggle-flag-judgment-flow"[\s\S]*id="flag-detail-body"/, 'flag detail popup should include individual on\/off and judgment-flow toggles before details');
});

test('the physical interaction screen is removed and field/creature/manual-event conversations route to the conversation session screen', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  // The physical screen, its topbar tab, and its screens-map entry are removed without a trace.
  assert.doesNotMatch(html, /id="interaction-screen"/, 'the physical interaction screen section is removed');
  assert.doesNotMatch(html, /data-screen="interaction"/, 'the interaction topbar tab is removed');
  assert.doesNotMatch(js, /interaction: document\.querySelector\('#interaction-screen'\)/, 'the screens map no longer registers a physical interaction screen');
  assert.doesNotMatch(js, /showScreen\('interaction'\)/, 'no caller shows the physical interaction screen (interaction survives only as the routing hub return token)');
  assert.doesNotMatch(js, /function (?:startInteractionFromField|openInteractionTab)\b/, 'the old field-interaction start and interaction-tab entry are deleted');
  assert.doesNotMatch(js, /#interaction-location|#interaction-character|#interaction-speaker|#character-standee\b|#player-input|#run-conversation\b|#end-conversation\b/, 'no old physical-screen DOM ids are referenced');

  // Field roster / detail / creature entries and the manual event start all land on the session screen.
  assert.match(js, /#start-selected-character'\)\.addEventListener\('click', \(\) => startAcademyConversationSessionFromCompanion\(activeCharacterId\)/, 'the field roster start button opens the conversation session screen');
  assert.match(js, /#start-field-character-from-detail'\)\.addEventListener\('click', \(\) => \{[\s\S]*?startAcademyConversationSessionFromCompanion\(activeCharacterId\)/, 'the field character detail start button opens the conversation session screen');

  // The non-physical interaction token stays intact (routing hub return + interaction API), NOT deleted.
  assert.match(js, /nextScreen === 'interaction'/, 'routing hub return still resolves the interaction token');
  assert.match(js, /postJson\('\/api\/interaction\/start'/, 'the /api/interaction/start API call is preserved');
});

test('field interaction entry adds a creature selection box wired to the shared field conversation pipeline', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  // A second selection box lives in the field right column, below the academy roster box and
  // its detail dialog, reusing the same panel/list chrome as the existing character box.
  const fieldBlock = html.match(/<section id="field-screen"[\s\S]*?<section id="academy-conversation-session-screen"/)?.[0] ?? '';
  assert.match(fieldBlock, /id="character-selection-list"[\s\S]*<dialog id="field-character-detail-dialog"[\s\S]*<section id="field-creature-select-panel" class="character-select-panel"[\s\S]*id="creature-select-title">話すクリーチャーを選ぶ<[\s\S]*id="creature-selection-list"/, 'the creature box sits below the academy character box and its detail dialog, sharing the character-select-panel chrome');
  // Creatures carry no authoring/continuity edit surfaces, so the creature box must not embed them.
  const creaturePanel = fieldBlock.match(/<section id="field-creature-select-panel"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.doesNotMatch(creaturePanel, /character-prompt-description|character-speaking-basis|character-memory-records|character-skill-records|character-work-records/, 'creature box must not include human-character edit or record surfaces');

  // The debug field box lists the FULL creature roster (allCreatureCandidates), not the
  // current-location encounter, and starts a conversation through the shared field pipeline.
  assert.match(js, /function renderField\(field\) \{[\s\S]*renderFieldCreatureSelector\(\);/, 'renderField should render the field creature selector');
  const creatureSelector = js.match(/function renderFieldCreatureSelector\(\)[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(creatureSelector, /allCreatureCandidates\.map\(/, 'debug field box lists the full creature roster (allCreatureCandidates)');
  assert.doesNotMatch(creatureSelector, /sanrinCreatureCandidatesFor|availableCreatureEncounterSummary|location/, 'debug field box must not gate on the current-location encounter');
  assert.match(creatureSelector, /panel\.hidden = allCreatureCandidates\.length === 0;/, 'debug field box shows whenever the roster is loaded');
  assert.match(creatureSelector, /startAcademyConversationSessionFromCompanion\(creature\.character_id\)/, 'selecting a creature starts a conversation through the shared field pipeline');

  // The roster is backend-driven (/api/creatures), registered as conversation actors, with no client default values.
  const refreshAllCreatures = js.match(/async function refreshAllCreatures\(\)[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(refreshAllCreatures, /allCreatureCandidates = \[\];[\s\S]*getJson\('\/api\/creatures'\)/, 'refreshAllCreatures clears the cached roster before loading so a failure leaves no stale creatures');
  assert.match(refreshAllCreatures, /registerCreatureCandidate\(summary\)/, 'refreshAllCreatures registers each summary as an actor candidate');
  assert.doesNotMatch(refreshAllCreatures, /\?\? \[\]|\.filter\(Boolean\)/, 'refreshAllCreatures must not default-fill or silently drop a malformed roster (fail fast)');
  // The full-roster load is scoped to the debug field screen only — production refresh must not depend on /api/creatures.
  assert.match(js, /if \(name === 'field'\) refreshAllCreatures\(\)\.catch\(reportError\)\.finally\(\(\) => renderFieldCreatureSelector\(\)\);/, 'opening the debug field screen loads the roster and rerenders the box in both outcomes (fail closed)');
  assert.doesNotMatch(js, /runRefreshTask\('all creatures'/, 'global refresh must not load /api/creatures (keeps production screens independent of the debug roster)');

  // The field conversation start pins the opening to the chosen actor so a creature id survives refresh, and — like
  // the other conversation starts (startConversationDay) — the opening-stream wait is covered by the shared academy
  // loading screen: the readiness block progresses the opening to its first assistant stream event, and
  // showAcademyLoadingScreenUntilReady switches to the conversation session screen only at stream start (so the
  // session screen is never shown empty while the opening streams).
  const startFromField = js.match(/async function startAcademyConversationSessionFromCompanion\(characterId\)[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(startFromField, /openingPromise = ensureOpeningUtterance\(\{ characterId, onAssistantStreamStart: markOpeningStreamStarted \}\);/, 'field conversation start pins the opening to the chosen actor (creature-safe) and releases the loading screen at stream start');
  assert.match(startFromField, /await showAcademyLoadingScreenUntilReady\(\{\s*readiness,\s*nextScreen: 'academy-conversation-session',\s*refreshBeforeNextScreen: false\s*\}\);/, 'the field conversation start is covered by the shared loading screen and switches to the conversation session screen on the opening stream start (no empty session screen while it streams)');
});

test('browser script wires field, interaction, and configured event-start routing', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  for (const endpoint of [
    '/api/characters',
    '/api/characters/profile',
    '/api/world',
    '/api/training/run',
    '/api/event-flags',
    '/api/event-flags/set',
    '/api/event-flags/all-on',
    '/api/event-flags/all-off',
    '/api/event-flags/start',
    '/api/academy/week/start',
    '/api/debug/relationships',
    '/api/debug/weeks',
    '/api/flags/judgment-flow',
    '/api/inventory',
    '/api/shop',
    '/api/shop/buy',
    '/api/shop/sell',
    '/api/field/move',
    '/api/interaction/start',
    '/api/conversation/opening',
    '/api/records/status',
    '/api/records/reset',
    '/api/conversation',
    '/api/conversation/edit-user-message',
    '/api/conversation/stream',
    '/api/conversation/end',
    '/api/slots',
    '/api/slots/load'
  ]) {
    assert.match(js, new RegExp(endpoint.replaceAll('/', '\\/')), `missing endpoint ${endpoint}`);
  }

  assert.match(js, /renderPlayerParametersEditor/, 'world screen should render editable player parameter inputs');
  assert.match(js, /#player-name/, 'world screen should wire an editable player name input');
  assert.match(js, /player_name/, 'world settings API calls should carry the player name');
  assert.match(js, /function setPlayerParameterGroupToValue\(group, value\)/, 'world preset buttons should set every parameter in one group to the selected value');
  assert.match(js, /\[0, 25, 50, 75, 100\]/, 'world preset buttons should use 0, 25, 50, 75, and 100');
  assert.match(js, /data-parameter-preset-group/, 'browser script should wire group-specific parameter preset buttons');
  assert.match(js, /#start-field-character-from-detail/, 'field character detail popup should wire a direct conversation start button');
  assert.match(js, /const trainingOptions = \[/, 'browser script should define selectable training options');
  assert.equal([...js.matchAll(/id:\s*'[^']+'/g)].filter((match) => js.slice(Math.max(0, match.index - 120), match.index).includes('trainingOptions') || js.slice(match.index, match.index + 220).includes('effectPreview')).length >= 12, true, 'browser training list should include many selectable options');
  assert.match(js, /function renderTrainingScreen\(\)/, 'training screen should render player parameters and training choices');
  assert.match(js, /runTraining\(training\.id\)/, 'training buttons should apply the selected training');
  assert.match(js, /postJson\('\/api\/training\/run'/, 'training actions should call the training API');
  assert.match(js, /renderTrainingResult/, 'training results should show randomized increases and decreases');
  assert.match(js, /function renderInteractionCharacterParameters\(character\)/, 'interaction detail popup should render selected-character parameters');
  assert.match(js, /function characterSceneStandeeUrl\(character = activeCharacter\(\)\)/, 'browser script should resolve character standees through the canonical standee contract');
  assert.match(js, /return character\?\.standee_url \?\? '';/, 'scene standees should use the canonical standee_url field');
  assert.match(js, /#field-character-detail-standee/, 'browser script should update the field character detail scene standee');
  assert.match(js, /#field-current-location-button/, 'field movement panel should expose the current location as a detail popup trigger');
  assert.match(js, /#field-location-detail-title/, 'field location detail popup title should sync to the current stage name');
  assert.match(js, /function renderFieldLocationDetail\(location\)/, 'field should render the old upper-left location panel content into a detail popup');
  assert.match(js, /function openFieldLocationDetail\(\)/, 'field current location name should open the location detail popup');
  assert.match(js, /moveToLocation\(candidate\.id, \{ showDetail: true \}\)/, 'selecting a movement destination should open the destination detail popup after moving');
  assert.match(js, /#selected-character-name-button/, 'field selected character name should be clickable for the detail popup');
  assert.match(js, /#field-character-detail-title/, 'field character detail popup title should sync to the selected character name');
  assert.match(js, /fieldCharacterDetailTitle\.textContent = selected\.display_name \?\? selected\.character_id/, 'field character detail popup title should be the selected character name');
  assert.match(js, /function openFieldCharacterDetail\(\)/, 'field selected character name should open the character detail popup');
  assert.match(js, /button\.addEventListener\('click',[\s\S]*openFieldCharacterDetail\(\)/, 'character selection should open the field character detail popup after selection');
  assert.match(js, /showModal\(\)/, 'detail popups should use dialog showModal when available');
  assert.match(js, /renderParameterGroup\('魔法習熟度', magicParameterDefinitions, parameters\.magic\)/, 'character parameter rendering should consume the selected character magic parameters');
  assert.match(js, /renderParameterGroup\('基礎能力', abilityParameterDefinitions, parameters\.abilities\)/, 'character parameter rendering should consume the selected character ability parameters');
  assert.match(js, /renderInteractionCharacterParameters\(selected\)/, 'changing selected character should refresh left-panel parameters');
  assert.match(js, /collectPlayerParameters/, 'world settings save should collect player parameter inputs');
  assert.match(js, /player_parameters/, 'world settings API calls should carry player parameters');
  assert.match(js, /function editableWorldDescription\(world = currentWorld\)[\s\S]*world\?\.world_description_base \?\? world\?\.world_description/, 'world settings editor should show the editable base text, not the flag-expanded prompt text');

  assert.doesNotMatch(js, /\/api\/events\/complete/);
  assert.match(js, /renderEventScreen/, 'event screen should render ready event flags and launch configured event interactions');
  assert.match(js, /event-pending-list/, 'event screen should show pending event flags');
  assert.match(js, /function startEventFlagInteractionFromScreen\(flagId\)/, 'event screen should be able to start the pending event (on the daytime conversation screen)');
  assert.match(js, /postJson\('\/api\/event-flags\/start'/, 'event start should call the event interaction API');
  assert.match(js, /function openEventTab\(\)/, 'opening the Event tab should check for auto-startable pending events');
  assert.match(js, /autoStartFlag/, 'event tab should auto-start a ready event that has a source character and interaction location');
  assert.match(js, /async function startEventFlagInteractionFromScreen\(flagId\) \{[\s\S]*?await startConversationDayFromPendingEvent\(flagId\);/, 'starting an event lands on the daytime conversation screen (routing is official — no legacy session screen argument)');
  assert.doesNotMatch(js, /renderEventCard/);
  assert.doesNotMatch(js, /current_event\s*\?\s*showScreen\('event'\)/);
  assert.doesNotMatch(js, /completeCurrentEvent/);
  assert.match(js, /function moveToLocation\(locationId, \{ showDetail = false, nextScreen = 'field', selectedVisibleSituation = null \} = \{\}\)[\s\S]*showScreen\(nextScreen\)/, 'field movement should stay in the Field screen by default');
  assert.match(js, /field-route-list/, 'field movement choices should render in a dedicated route list');
  assert.match(js, /field\.locations/, 'field movement choices should render every stage candidate, not only the current location hotspots');
  assert.doesNotMatch(js, /hotspot\.target === 'interaction:lina'/, 'field routes must not contain the old silver-leaf interaction/event-like route');
  assert.doesNotMatch(js, /interaction:lina/, 'field routes must not hard-code the old Lina interaction hotspot');
  assert.match(js, /location-card/, 'field movement choices should look like selectable place cards');
  assert.match(js, /route_label/, 'field movement choices should explain where the route goes');
  assert.doesNotMatch(js, /narrationIconUrl/, 'ground-text narration should not use an icon in Interaction');
  assert.doesNotMatch(js, /narration-face/, 'ground-text narration should not render a face/icon frame');
  assert.doesNotMatch(js, /character_name:\s*'地の文'/, 'ground-text narration should not set a visible speaker name');
  assert.match(js, /message\.role !== 'user' && message\.role !== 'narration'/, 'ground-text narration should omit both face icon and message speaker line');
  assert.doesNotMatch(js, /<small>\$\{character\.visual_set_id\}<\/small>/, 'character selection list should not show visual set/image filenames under names');
  assert.match(js, /revealCompletedAssistantText/, 'completed narration or speech segments should be able to pop in during streaming before the final result');
  assert.match(js, /completedAssistantPrefix/, 'streaming should detect completed assistant bubble segments without growing unfinished bubbles');
  assert.match(js, /popFromDisplayIndex/, 'newly completed bubble segments should be animated in order rather than all assistant content popping only at the end');
  assert.match(js, /renderConversationResultSequentially/, 'opening utterance should stagger split bubbles instead of popping all initial bubbles together');
  assert.match(js, /const CONVERSATION_POPUP_COOLDOWN_DEFAULT_MS = 500;/, 'the standard popup cooldown must remain 500ms by default');
  assert.match(js, /function conversationPopupCooldownMs\(\)\s*\{\s*return conversationPopupSettings\.cooldown_ms;\s*\}/, 'a single getter should supply the configurable popup cooldown');
  assert.match(js, /await sleep\(conversationPopupCooldownMs\(\)\)/, 'opening split bubbles should pace pop-ins by the configurable popup cooldown (default 500ms)');
  assert.match(js, /await runOpeningConversationStream\(\{ characterId, provider, onAssistantStreamStart \}\)/, 'LM Studio opening utterance should use the streaming reveal path (forwarding the chosen characterId) instead of waiting for a complete JSON response');
  assert.match(js, /\/api\/conversation\/opening\/stream/, 'opening utterance should have a streaming endpoint so first bubbles can pop as soon as their text is complete');
  assert.match(js, /surface\.commitState\(finalResult\)/, 'opening final result should reconcile canonical state (through the surface) without replacing already revealed bubbles');
  assert.match(js, /scheduleAssistantSegmentReveal/, 'streaming should schedule completed bubble reveals at most once per animation frame');
  assert.match(js, /requestAnimationFrame\(\(\) => \{[\s\S]*revealCompletedAssistantText\(\)/, 'assistant delta handling should coalesce pop-in work through requestAnimationFrame');
  assert.doesNotMatch(js, /stream-status/, 'removed Interaction Debug panel should not keep a stream status DOM target');
  assert.match(js, /async function revealNextAssistantSegment/, 'streaming should reveal queued assistant bubble segments through one cooldown-controlled path');
  assert.match(js, /await assistantRevealCooldownGate;/, 'streaming reveal should wait the cooldown gate before every popup so each gap honors the cooldown');
  assert.match(js, /assistantRevealCooldownGate = sleep\(conversationPopupCooldownMs\(\)\);/, 'streaming reveal should arm the cooldown gate from the configurable popup cooldown after each popup');
  assert.doesNotMatch(js, /assistantRevealFastForward/, 'the assistant_complete fast-forward that skipped the cooldown must be removed entirely so completion never drains popups below the cooldown');
  assert.match(js, /event === 'assistant_complete'/, 'streaming should receive the completed assistant text independently from final result reconciliation');
  assert.match(js, /queueAssistantSegments\(assistantText\)/, 'completed assistant text should be queued for pop-in immediately, not only after the final result event');
  assert.match(js, /if \(event === 'assistant_complete'\) \{[\s\S]*queueAssistantSegments\(assistantText\);[\s\S]*assistantRevealPromise = revealNextAssistantSegment\(\);[\s\S]*setStreamStatus\(`\$\{statusPrefix\}: assistant text completed`\);[\s\S]*\}/, 'assistant_complete should reveal the completed bubble through the pop-in queue without waiting for final result handling');
  assert.match(js, /surface\.commitState\(finalResult\)/, 'final stream result should update canonical state (through the surface) without re-rendering already revealed assistant bubbles');
  assert.match(js, /const CONVERSATION_EDIT_ITEM_ID = 'eternel_cube';/, 'past player message editing should be unlocked by the Eterneru Cube item');
  assert.match(js, /function hasConversationEditItem\(inventory = currentInventory\)/, 'browser script should centralize the inventory gate for message editing');
  assert.match(js, /const isPlayerUtteranceTail =[\s\S]*message\.role === 'user' \|\| message\.role === 'player-narration'[\s\S]*displayList\[index \+ 1\]\.__message_index !== message\.__message_index/, 'a split player utterance should expose its edit affordance only on the last bubble of that utterance, including a narration-only utterance with no plain user-speech bubble');
  assert.match(js, /if \(allowEdit && isPlayerUtteranceTail && hasConversationEditItem\(\)\)/, 'past player messages should render exactly one edit button, on the utterance tail, only while the required item is owned and the surface allows editing');
  assert.match(js, /className = 'message-edit-button'/, 'eligible past player messages should render an edit button');
  assert.match(js, /function editUserMessageAtIndex\(messageIndex\)/, 'browser script should edit a past user message by conversation message index');
  assert.match(js, /if \(!hasConversationEditItem\(\)\) return;/, 'editing should be blocked client-side when the item is no longer owned');
  assert.match(js, /postJson\('\/api\/conversation\/edit-user-message'/, 'editing a user message should call the rewind-and-regenerate API');
  assert.match(js, /message_index: messageIndex/, 'edit API should send the selected conversation message index');
  assert.match(js, /await renderConversationResultSequentially\(result\)/, 'edited user input should resume conversation from the rewound turn and pop regenerated assistant bubbles in the normal sequential order');
  assert.doesNotMatch(js, /renderConversationResult\(result, \{ revealAssistant: true \}\);\n\s*setStreamStatus\('edit: completed'\)/, 'edited regenerated replies should not pop all assistant bubbles together through the immediate renderer');
  // The regenerate is a NON-streaming LLM call (no SSE ticks), so the wait is surfaced on the shared conversation
  // status line (setStreamStatus immediate) BEFORE the POST and cleared on every outcome in finally — the 応答中
  // state is visible while regenerating and never lingers as a stale responding indicator.
  const editFn = js.match(/async function editUserMessageAtIndex\(messageIndex\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(editFn, '', 'editUserMessageAtIndex should exist');
  assert.match(editFn, /setStreamStatus\('返答を再生成しています…', \{ immediate: true \}\);[\s\S]*?postJson\('\/api\/conversation\/edit-user-message'/, 'the regenerate wait shows a visible 応答中 status before the POST (the non-streaming edit wait is not left silent)');
  assert.match(editFn, /\} finally \{[\s\S]*?conversationRequestInFlight = false;[\s\S]*?setConversationStatus\(''\);/, 'the 応答中 status is cleared in finally on every outcome (success or failure — no lingering responding state)');
  assert.match(js, /if \(conversationRequestInFlight\) \{[\s\S]*showProcessingToast\(\);[\s\S]*return;[\s\S]*\}/, 'editing should be blocked while a conversation request is still running');
  assert.match(js, /if \(!window\.confirm\(/, 'editing a past player message should confirm because later turns are discarded');
  assert.match(js, /if \(!completed\.trim\(\)\) return;/, 'streaming should not queue an empty assistant segment that renders as a name-only bubble before narration text');
  assert.match(js, /filter\(\(segment\) => \(segment\.content \?\? ''\)\.trim\(\)\)/, 'streaming should ignore blank split assistant segments before rendering pop-in bubbles');
  assert.match(js, /let assistantExpression = 'neutral'/, 'streaming should default assistant expression before the model-selected emotion arrives');
  assert.match(js, /event === 'assistant_emotion'/, 'streaming should accept the model-selected emotion before assistant deltas');
  assert.match(js, /face_emotion_variant_id:\s*`face_\$\{assistantExpression\}`/, 'streaming assistant bubbles should use the selected emotion icon');
  assert.doesNotMatch(js, /face_emotion_variant_id:\s*'face_neutral'/, 'streaming assistant bubbles should not force the neutral icon after emotion selection');
  assert.match(js, /\/canonical\/character_visual_sets\/\$\{visualSetId\}\/face_emotions\/\$\{expression\}\.jpg/, 'face icons should resolve canonical face_emotions routes');
  assert.doesNotMatch(js, /view === 'face'\) return character\.face_url/, 'face icons should not reuse the character-list neutral face_url for dialogue emotions');
  assert.doesNotMatch(js, /assistantText \+= data\.delta;[\s\S]*renderMessageStream\(nextMessages\)/, 'streaming deltas should not re-render a growing assistant bubble on every token');
  assert.match(js, /function renderInteractionLocation\(location\)/, 'the conversation-session stage renderer keeps the stage image and name in sync with field state');
  assert.match(js, /renderInteractionLocation\(location\)/, 'field rendering should keep the conversation-session stage in sync with the current field location');
  assert.match(js, /location\?\.background_url/, 'conversation-session stage preview should use the same field background image URL when available');
  assert.match(js, /async function startAcademyConversationSessionFromCompanion\(characterId\) \{[\s\S]*if \(conversationRequestInFlight\) \{[\s\S]*showProcessingToast\(\);[\s\S]*return;[\s\S]*\}/, 'starting a conversation from the field should be blocked while background conversation processing is still running');
  assert.match(js, /function conversationShouldAutoEnd\(result\)[\s\S]*conversation_continuation\?\.continue_conversation === false/, 'browser should detect a false continuation judgment as an automatic conversation-end trigger');
  assert.match(js, /const FINAL_REPLY_AUTO_END_DELAY_MS = 3000;/, 'automatic conversation end should wait three seconds after the final reply popup so it remains readable');
  assert.match(js, /async function autoEndConversationAfterFinalReply\(result\)[\s\S]*await sleep\(FINAL_REPLY_AUTO_END_DELAY_MS\)[\s\S]*await endConversation\(\{ allowDuringInFlight: true \}\)/, 'automatic cutoff ending should wait after the final reply popup, then reuse the end-conversation process');
  assert.match(js, /let currentAssistantQueuedSegmentCount = 0;[\s\S]*let assistantCompleteCount = 0;/, 'streaming reveal should track completed assistant messages separately so a later cutoff reply is not suppressed by the normal reply segment count');
  assert.match(js, /function beginNextAssistantMessage\(\) \{[\s\S]*assistantText = '';[\s\S]*currentAssistantQueuedSegmentCount = 0;[\s\S]*\}/, 'a second assistant_complete event should reset per-assistant segment accounting before queueing the final cutoff reply');
  assert.match(js, /if \(event === 'assistant_complete'\) \{[\s\S]*if \(assistantCompleteCount > 0\) beginNextAssistantMessage\(\);[\s\S]*queueAssistantSegments\(assistantText\);[\s\S]*assistantCompleteCount \+= 1;[\s\S]*assistantRevealPromise = revealNextAssistantSegment\(\);/, 'each assistant_complete, including the cutoff final reply, should go through the pop-in reveal queue');
  assert.match(js, /const result = await runConversationStream\(\{ playerInput, provider, refreshAfter: false \}\)[\s\S]*if \(await autoEndConversationAfterFinalReply\(result\)\) return;[\s\S]*await refresh\(\)/, 'streaming conversation should auto-finalize after a false continuation result instead of only refreshing the active conversation');
  assert.match(js, /if \(conversationShouldAutoEnd\(result\) \|\| isRoutingTurnDispatch\(result\) \|\| isRoutingGraduationGuideSelection\(result\)\) \{[\s\S]*await renderConversationResultSequentially\(result\)[\s\S]*\} else \{[\s\S]*renderConversationResult\(result, \{ revealAssistant: true \}\)[\s\S]*\}[\s\S]*if \(await autoEndConversationAfterFinalReply\(result\)\) return;/, 'non-streaming conversation should render the cutoff reply (or routing send-off / graduation guide selection) before auto-finalizing');
  assert.match(js, /function setConversationControlsDisabled\(disabled\)[\s\S]*#academy-conversation-session-run-conversation[\s\S]*#academy-conversation-session-end-conversation/, 'conversation in-flight guards should disable both the old interaction buttons and the academy session buttons');
  assert.match(js, /let conversationFinalizationInFlight = false;/, 'browser should track the conversation-end finalization phase separately so academy map navigation can be locked until placement reroll is safe');
  assert.match(js, /function setAcademyMapNavigationDisabled\(disabled\)[\s\S]*data-screen="academy-map"[\s\S]*aria-disabled/, 'academy map tab should be visibly disabled while conversation finalization is running');
  assert.match(js, /function showScreen\(name, \{ rerollAcademyMap = false, skipDungeonRefresh = false \} = \{\}\)[\s\S]*if \(name === 'academy-map' && conversationFinalizationInFlight\) \{[\s\S]*showProcessingToast\(\);[\s\S]*return;[\s\S]*\}/, 'academy map cannot be opened while conversation-end processing is still running');
  assert.match(js, /function ensureAcademyMapCharacterAssignments\(\{ force = false \} = \{\}\)[\s\S]*if \(force \|\| !Object\.keys\(academyMapCharacterAssignments\)\.length\)/, 'academy map placement should only reroll on explicit force or initial empty setup, not on relationship or character signature changes elsewhere');
  assert.doesNotMatch(js, /signature !== academyMapAssignmentSignature/, 'relationship and character refreshes should not implicitly reroll academy map placement outside the conversation-end pass');
  const endConversationFn = js.match(/async function endConversation\(\{ allowDuringInFlight = false \} = \{\}\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(endConversationFn, '', 'the endConversation function body should be locatable');
  assert.match(endConversationFn, /conversationRequestInFlight && !allowDuringInFlight[\s\S]*showProcessingToast\(\);[\s\S]*return;[\s\S]*setConversationControlsDisabled\(true\)[\s\S]*conversationFinalizationInFlight = true;[\s\S]*setAcademyMapNavigationDisabled\(true\)[\s\S]*clearVisibleConversation\(\);[\s\S]*let transition = endingConversation[\s\S]*next_screen: 'academy-room'[\s\S]*const finalization = \(async \(\) => \{[\s\S]*postJson\('\/api\/conversation\/end'[\s\S]*const loadingReadiness = endingConversation \? finalization : Promise\.resolve\(\)[\s\S]*showAcademyLoadingScreenUntilReady\(\{[\s\S]*readiness:\s*loadingReadiness[\s\S]*nextScreen: transition\.next_screen[\s\S]*copyKey: transition\.loading_copy_key/, 'ending a conversation should route to 自室 after the fixed loading delay while still using finalization-backed loading for the graduation title transition');
  assert.match(js, /finalization_status:\s*'running'/, 'endConversation should record that memory\/skill\/work-record finalization is currently running');
  assert.match(js, /const finalization = \(async \(\) => \{[\s\S]*await refresh\(\);[\s\S]*ensureAcademyMapCharacterAssignments\(\{ force: true \}\)[\s\S]*finally \{[\s\S]*conversationFinalizationInFlight = false;[\s\S]*setAcademyMapNavigationDisabled\(false\);[\s\S]*\}\s*\}\)\(\);/, 'academy map placement should reroll only after conversation-end processing and refresh have finished, then unlock map navigation');
  assert.match(js, /async function endConversation\(\{ allowDuringInFlight = false \} = \{\}\)[\s\S]*finally \{[\s\S]*conversationRequestInFlight = false;[\s\S]*setConversationControlsDisabled\(false\);[\s\S]*\}/, 'ending a conversation should clear conversation controls after the fixed loading transition');
  assert.match(js, /showAcademyLoadingScreenUntilReady\(\{[\s\S]*readiness:\s*loadingReadiness[\s\S]*nextScreen: transition\.next_screen[\s\S]*copyKey: transition\.loading_copy_key[\s\S]*\}\);[\s\S]*finally \{\s*conversationRequestInFlight = false;\s*setConversationControlsDisabled\(false\);\s*\}/, 'conversation-end loading should clear the chat controls after the fixed room-loading or graduation title-loading transition completes; the map lock is still cleared inside the background finalization block');
  assert.doesNotMatch(js, /renderWorkRecordRecallDebug\(result\.conversation\?\.work_record_recall\)/, 'interaction debug recall output should not be wired to the removed debug panel');
  assert.doesNotMatch(js, /work-record-recall-debug/, 'browser script should not update the removed work-record recall debug panel');
});

test('player parenthetical ground text splits into its own darker-navy player-narration bubble', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  // The split is generalized so the same matcher serves character and player ground text.
  assert.match(js, /function splitMessageContent\(message, makeNarrationPart\)/, 'paren splitting should be generalized to take a narration-part factory so player and character ground text share one matcher');
  assert.match(js, /function splitAssistantContent\(message\)\s*\{[\s\S]*splitMessageContent\(message,/, 'assistant splitting should delegate to the generalized splitter');
  assert.match(js, /function splitPlayerContent\(message\)\s*\{[\s\S]*splitMessageContent\(message,/, 'player splitting should delegate to the generalized splitter');

  // Assistant ground-text part stays byte-equivalent: narration role with its face/expression fields.
  assert.match(js, /role: 'narration',\s*content: narration,\s*face_emotion_variant_id: 'narration_face',\s*expression: 'narration'/, 'character ground-text parts must remain the narration role with the narration face/expression so existing behavior is unchanged');
  // Player ground-text part is the player-narration role with no face/expression fields.
  assert.match(js, /role: 'player-narration',\s*content: narration\s*\}/, 'player ground-text parts should be the player-narration role and carry no face/expression fields');

  // displayMessages now splits user as well as assistant, and never re-splits an already-produced narration part.
  assert.match(js, /if \(message\.role === 'assistant'\) return splitAssistantContent\(message\)\.map\(withIndex\)/, 'assistant messages should still split into character speech and narration bubbles');
  assert.match(js, /if \(message\.role === 'user'\) return splitPlayerContent\(message\)\.map\(withIndex\)/, 'user messages should split into player speech and player-narration bubbles');
  assert.match(js, /__message_index: entry\.__message_index \?\? messageIndex/, 'display split should preserve an existing message index so re-fed segments stay idempotent and keep one edit button per utterance');

  // createMessageRows wiring: class name, no face/speaker frame, player-side pop-in suppression.
  assert.match(js, /message\.role === 'player-narration' \? 'player-narration-message'/, 'player ground-text rows should get the player-narration-message class');
  assert.match(js, /message\.role !== 'user' && message\.role !== 'narration' && message\.role !== 'player-narration'/, 'player ground text, like character ground text, should omit the face icon and speaker name');
  assert.match(js, /index >= popFromDisplayIndex && message\.role !== 'user' && message\.role !== 'player-narration'/, "the player's own ground text should not pop in like a revealed character bubble");

  // CSS: player-narration sits on the player (right) lane and is a clearly darker navy than the normal player bubble.
  assert.match(css, /\.player-narration-message\s*\{[\s\S]*justify-content:\s*flex-end/, 'player ground-text bubble should sit on the player (right) lane, not the left character lane');
  assert.match(css, /\.player-narration-message \.message-bubble\s*\{[\s\S]*background:\s*rgba\(30, 38, 68, 0\.85\)[\s\S]*border-color:\s*rgba\(112, 138, 204, 0\.5\)[\s\S]*font-style:\s*normal/, 'player ground-text bubble should be a deeper, more opaque navy that reads as clearly darker than the translucent normal player bubble across plausible chat backdrops');
  assert.match(css, /\.player-message \.message-bubble\s*\{[\s\S]*background:\s*rgba\(89, 113, 176, 0\.28\)/, 'normal player bubble should stay the lighter navy so the player-narration bubble reads as clearly darker');
});

test('interaction composer sends on plain Enter but blocks Enter while conversation processing is still running', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  assert.match(html, /id="conversation-processing-toast"[\s\S]*role="status"[\s\S]*aria-live="polite"[\s\S]*処理中です。しばらくお待ちください。/, 'interaction screen should include a polite processing popup for blocked Enter submissions');
  assert.match(js, /let playerInputIsComposing = false;/, 'composer should track IME composition state explicitly for macOS Japanese input');
  assert.match(js, /let conversationRequestInFlight = false;/, 'composer should track whether a conversation request is still running');
  assert.match(js, /let processingToastTimer = null;/, 'processing popup should keep one timeout handle so repeated Enter does not stack timers');
  assert.match(js, /function showProcessingToast\(\)/, 'blocked Enter should use a centralized popup helper');
  assert.match(js, /conversation-processing-toast/, 'browser script should update the processing popup element');
  assert.match(js, /setTimeout\(\(\) => \{[\s\S]*classList\.remove\('visible'\)[\s\S]*\}, 1000\)/, 'processing popup should disappear after about one second');
  assert.match(js, /addEventListener\('compositionstart',[\s\S]*playerInputIsComposing = true/, 'compositionstart should mark the player input as composing');
  assert.match(js, /addEventListener\('compositionend',[\s\S]*playerInputIsComposing = false/, 'compositionend should mark the player input as no longer composing');
  assert.match(js, /function shouldSubmitPlayerInput\(event\)/, 'Enter submission decision should be centralized');
  assert.match(js, /event\.key !== 'Enter'[\s\S]*return false/, 'non-Enter keys should not submit');
  assert.match(js, /event\.shiftKey[\s\S]*return false/, 'Shift+Enter should remain available for inserting a newline');
  assert.match(js, /event\.isComposing \|\| composing \|\| event\.keyCode === 229[\s\S]*return false/, 'Enter must not submit while IME composition\/conversion is active or reported as keyCode 229');
  assert.match(js, /function shouldSubmitPlayerInput\(event\) \{\s*return enterShouldSubmit\(event, playerInputIsComposing\);/, 'the player composer feeds its tracked composing flag into the shared IME-safe Enter guard');
  assert.match(js, /if \(conversationRequestInFlight\) \{[\s\S]*showProcessingToast\(\);[\s\S]*return;[\s\S]*\}/, 'runConversation should return early while recall\/prewarm or conversation processing is still active');
  assert.match(js, /conversationRequestInFlight = true;[\s\S]*setConversationControlsDisabled\(true\)/, 'conversation processing should start before disabling the send buttons');
  assert.match(js, /finally \{[\s\S]*conversationRequestInFlight = false;[\s\S]*setConversationControlsDisabled\(false\);[\s\S]*\}/, 'conversation processing should always clear the Enter guard with the send buttons');
  const composerEnterHandler = js.match(/if \(shouldSubmitPlayerInput\(event\)\) \{[\s\S]*?runConversation\(\)\.catch\(reportError\);/)?.[0] ?? '';
  assert.notEqual(composerEnterHandler, '', 'the composer keydown handler that submits via runConversation should exist');
  assert.match(composerEnterHandler, /if \(shouldSubmitPlayerInput\(event\)\) \{[\s\S]*event\.preventDefault\(\);[\s\S]*if \(conversationRequestInFlight\) \{[\s\S]*showProcessingToast\(\);[\s\S]*return;[\s\S]*\}[\s\S]*runConversation\(\)\.catch\(reportError\)/, 'plain Enter should prevent duplicate send and show the popup when the send button is already blocked');
  assert.match(css, /\.processing-toast\s*\{[\s\S]*position:\s*fixed[\s\S]*opacity:\s*0[\s\S]*pointer-events:\s*none/, 'processing popup should be a non-blocking fixed toast');
  assert.match(css, /\.processing-toast\.visible\s*\{[\s\S]*opacity:\s*1/, 'processing popup should become visible through a class');
});

test('processing toast remains outside inactive screens so blocked field interaction entry can display it', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const sessionBlock = html.match(/<section id="academy-conversation-session-screen"[\s\S]*?<section id="routing-hub-screen"/)?.[0] ?? '';
  assert.doesNotMatch(sessionBlock, /id="conversation-processing-toast"/, 'processing toast should not be nested inside the conversation session screen so it can display over any screen');
  assert.match(html, /<div id="conversation-processing-toast" class="processing-toast" role="status" aria-live="polite">処理中です。しばらくお待ちください。<\/div>/, 'shared processing toast should still exist once at document level');
});

test('conversation input lock guards opening generation and bounds post-turn refresh waits', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  assert.match(js, /const REFRESH_TASK_TIMEOUT_MS = \d+;/, 'refresh path should define a bounded wait for post-turn API synchronization');
  assert.match(js, /async function runRefreshTask\(label, taskFactory, \{ timeoutMs = REFRESH_TASK_TIMEOUT_MS, fallbackValue = null \} = \{\}\)/, 'refresh path should funnel awaited sync work through a timeout-guarded helper');
  assert.match(js, /Promise\.race\(\[[\s\S]*setTimeout\(/, 'refresh guard should race each sync task against a timeout instead of waiting forever');
  assert.match(js, /reportError\(new Error\(`refresh timeout: \$\{label\}`\)\)/, 'timed-out refresh tasks should surface a concrete diagnostic label');
  assert.match(js, /await Promise\.all\(\[[\s\S]*runRefreshTask\('characters', \(\) => refreshCharacters\(\)\)[\s\S]*runRefreshTask\('world settings', \(\) => refreshWorldSettings\(\)\)[\s\S]*runRefreshTask\('economy', \(\) => refreshEconomy\(\)\)[\s\S]*\]\)/, 'initial refresh fan-out should use the timeout guard for the first post-turn API group');
  assert.match(js, /const \[state, field\] = await Promise\.all\(\[[\s\S]*runRefreshTask\('state', \(\) => getJson\('\/api\/state'\), \{ fallbackValue: currentRuntimeState \}\)[\s\S]*runRefreshTask\('field', \(\) => getJson\('\/api\/field'\), \{ fallbackValue: currentField \}\)[\s\S]*\]\)/, 'state and field refresh should fall back to the last known values when a post-turn fetch stalls');
  assert.match(js, /await Promise\.all\(\[[\s\S]*runRefreshTask\('record status', \(\) => refreshRecordStatus\(\)\)[\s\S]*runRefreshTask\('flag status', \(\) => refreshFlagStatus\(\)\)[\s\S]*runRefreshTask\('event flag status', \(\) => refreshEventFlagStatus\(\)\)[\s\S]*runRefreshTask\('llm request log', \(\) => refreshLlmRequestLog\(\)\)[\s\S]*runRefreshTask\('save slots', \(\) => refreshSaveSlots\(\)\)[\s\S]*\]\)/, 'secondary refresh fan-out should also be bounded so optional panels cannot keep the composer locked forever');
  assert.match(js, /async function runConversation\(\) \{[\s\S]*conversationRequestInFlight = true;[\s\S]*setConversationControlsDisabled\(true\);[\s\S]*const provider = conversationProvider\(\);[\s\S]*try \{[\s\S]*if \(messageHistory\.length === 0\) await ensureOpeningUtterance\(\);/, 'first-turn opening generation should run inside the guarded try/finally so a stall or throw cannot strand the input lock');
});

test('visual polish separates debug layout and gives field route cards clear affordance', async () => {
  const css = await readFile(`${root}/style.css`, 'utf8');

  assert.match(css, /\.eyebrow\s*\{[\s\S]*color:\s*var\(--eyebrow\)/, 'shared eyebrow text should consume the eyebrow token');
  assert.match(css, /:root\b[\s\S]*--surface-app-card:\s*linear-gradient\(180deg, rgb\(255 250 240 \/ 0\.10\), rgb\(13 19 31 \/ 0\.50\)\)/, 'theme should define the shared app-card surface token');
  assert.match(css, /\.conversation-panel,[\s\S]*\.app-card\s*\{[\s\S]*border:\s*var\(--border-app-card\)[\s\S]*background:\s*var\(--surface-app-card\)[\s\S]*border-radius:\s*var\(--radius-card\)[\s\S]*box-shadow:\s*var\(--shadow-app-card\)/, 'shared app-card primitive should consume border/surface/radius/shadow tokens (world/field panels no longer share this warm primitive)');
  assert.match(css, /\.world-settings-panel\s*\{[\s\S]*background:\s*var\(--meta-panel\)/, 'world settings panel should be a deep-night moonlight panel (no warm shell surface)');
  assert.match(css, /\.parameter-preset-row\s*\{[\s\S]*display:\s*grid[\s\S]*grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\)/, 'world parameter presets should show five buttons in a row');
  assert.match(css, /\.parameter-preset-group\s*\{[\s\S]*margin-top/, 'world parameter preset groups should have compact spacing');
  assert.match(css, /\.message-stream\s*\{[\s\S]*height:\s*430px;[\s\S]*min-height:\s*430px;[\s\S]*max-height:\s*430px/, 'conversation message area should be taller while remaining fixed when messages appear');
  assert.match(css, /\.chat-composer\s*\{[\s\S]*font-size:\s*16px/, 'player input label should use the requested 16px size');
  assert.match(css, /\.layout\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/, 'main layout should not reserve an always-visible debug column');
  assert.match(css, /\.field-card\s*\{[\s\S]*grid-template-columns:\s*minmax\(420px,\s*1fr\) minmax\(360px,\s*0\.9fr\)/, 'field should keep movement and character selection columns');
  assert.doesNotMatch(css, /\.background-panel\s*\{/, 'old upper-left current-location panel CSS should be removed after moving details to popup');
  assert.match(css, /\.field-location-detail-dialog\s*\{[\s\S]*width:\s*min\(1240px, 96vw\);[\s\S]*max-width:\s*min\(1240px, 96vw\)/, 'field movement destination detail popup should set its actual width, not only a max-width, so every stage image grows consistently');
  assert.match(css, /\.field-location-detail-image\s*\{[\s\S]*aspect-ratio:\s*16 \/ 9/, 'field location detail popup should display the former current-location image area');
  assert.match(css, /\.field-left-column,\n\.field-right-column\s*\{[\s\S]*display:\s*grid/, 'left column should stack current location and movement choices');
  assert.match(css, /\.field-route-panel,\n\.character-select-panel\s*\{[\s\S]*background:\s*var\(--meta-panel\)/, 'field movement / character selection panels should be deep-night moonlight panels (no warm shell surface)');
  assert.match(css, /textarea\s*\{[\s\S]*box-sizing:\s*border-box/, 'textareas should stay inside their panels instead of overflowing right');
  assert.match(css, /\.narration-message\s*\{[\s\S]*justify-content:\s*flex-start/, 'ground-text narration should stay on the left character-message lane, not centered');
  assert.match(css, /\.narration-message \.message-bubble\s*\{[\s\S]*margin-left:\s*calc\(129px \+ 12px\)/, 'ground-text narration bubble should align its left edge with enlarged character speech bubbles');
  assert.match(css, /\.message-face\s*\{[\s\S]*width:\s*129px;[\s\S]*height:\s*129px;[\s\S]*flex:\s*0 0 129px/, 'conversation face images should be 1.5x the former 86px size');
  assert.match(css, /\.chat-message\.pop-in\s*\{[\s\S]*contain:\s*layout paint[\s\S]*animation:\s*bubble-pop-in\s+var\(--bubble-pop-in-duration\)[\s\S]*will-change:\s*transform, opacity/, 'SNS-style pop-in should animate the whole message row through the configurable duration variable so the icon and bubble settle together');
  assert.doesNotMatch(css, /var\(--bubble-pop-in-duration,/, 'the pop-in animation should not keep a CSS fallback because :root defines the variable and JS sets it');
  assert.match(css, /:root\s*\{[\s\S]*--bubble-pop-in-duration:\s*220ms;/, 'the default pop-in animation duration should be 220ms in :root, overridden via the settings preset');
  assert.doesNotMatch(css, /\.chat-message\.pop-in \.message-bubble\s*\{[\s\S]*animation:/, 'pop-in should not animate only the bubble because the icon can appear one pixel out of sync after settling');
  const bubbleKeyframes = css.match(/@keyframes bubble-pop-in[\s\S]*?\n\}/)?.[0] ?? '';
  assert.doesNotMatch(bubbleKeyframes, /scale\(/, 'SNS-style pop-in should avoid scale overshoot that can cause sub-pixel horizontal settling');
  assert.doesNotMatch(bubbleKeyframes, /filter:/, 'SNS-style pop-in should not animate filter because it causes expensive repaints');
  assert.doesNotMatch(bubbleKeyframes, /rotate\(/, 'SNS-style pop-in should avoid rotation because it increases paint/composition work for large bubbles');
  assert.match(css, /\.character-selection-list\s*\{[\s\S]*grid-template-columns:\s*repeat\(auto-fill, minmax\(260px, 1fr\)\)/, 'larger character icons may reduce the number of visible columns');
  assert.match(css, /\.character-option\s*\{[\s\S]*grid-template-columns:\s*112px 1fr/, 'character selection icons should be about twice the former width');
  assert.match(css, /\.character-option img\s*\{[\s\S]*width:\s*112px;[\s\S]*height:\s*112px/, 'character selection icons should be about twice the former size');
  assert.match(css, /\.asset-source-line\s*\{[\s\S]*display:\s*none/, 'selected character source/image filename line should be hidden');
  assert.match(css, /\.continuity-record-grid\s*\{[\s\S]*minmax\(min\(100%, 210px\), 1fr\)/, 'memory/skill/work record columns should shrink inside the panel');
  assert.match(css, /\.continuity-record-grid article\s*\{[\s\S]*min-width:\s*0/, 'memory cards should not force the panel wider');
  assert.match(css, /\.continuity-record-item\s*\{[\s\S]*overflow-wrap:\s*anywhere/, 'long memory text should wrap like skill/work-record text');
  assert.match(css, /\.field-route-list\s*\{[\s\S]*grid-template-columns/, 'field routes should use clear card layout');
  assert.match(css, /\.location-card\s*\{[\s\S]*min-height/, 'route choices should be large enough to read/click');
  assert.match(css, /\.location-card\.current/, 'current location should be visually marked');
  assert.match(css, /\.training-grid\s*\{[\s\S]*grid-template-columns/, 'training screen should organize choices and current player parameters');
  assert.match(css, /\.training-option-card\s*\{[\s\S]*text-align:\s*left/, 'training choices should read as selectable cards');
  assert.match(css, /\.training-effect-list\s*\{[\s\S]*display:\s*grid/, 'training effects should be shown as compact gain/loss rows');
  assert.match(css, /\.debug-grid\s*\{[\s\S]*grid-template-columns/, 'debug should have its own organized screen layout');
  assert.match(css, /\.app-card/, 'shared cards should use a polished card primitive');
  assert.match(css, /backdrop-filter/, 'UI should use glass-like depth rather than flat panels');
});

test('the off-palette sage-green (--eyebrow default) that floated on non-navy screens is harmonized to each screen scope', async () => {
  const css = await readFile(path.join(root, 'style.css'), 'utf8');

  // The meta moonlight loading screen: the "Loading" eyebrow settles into the night copy panel as
  // sunken moonlight silver instead of the shared sage-green --eyebrow default that floated over the art.
  const loadingEyebrow = cssRuleBlock(css, '.academy-loading-copy .eyebrow');
  assert.match(loadingEyebrow, /color:\s*var\(--meta-silver-dim\)/, 'the loading eyebrow should read as sunken moonlight silver');
  assert.doesNotMatch(loadingEyebrow, /#b6c891|var\(--eyebrow\)/i, 'the loading eyebrow carries no sage-green literal or shared-eyebrow token (test-by-token)');

  // The obsidian 鍛錬 screen has no sage-green float: its result panel shows neutral summary rows (訓練可能回数 /
  // 現在の曜日), and the effect-row increase/decrease semantic only renders in the legacy #training-result, so the
  // screen carries no scoped .training-effect.increase override — the amber eyebrows come from its own token layer.
  assert.doesNotMatch(css, /#academy-training-screen \.training-effect\.increase/, 'the obsidian 鍛錬 screen carries no scoped effect-gain override (effect rows only render on the legacy screen)');

  // The legacy dark #training-screen keeps the shared sage green as its navy-palette gain color: the
  // global rule is untouched.
  assert.match(css, /\.training-effect\.increase\s*\{\s*color:\s*#b6c891;\s*\}/, 'the legacy dark training screen keeps the shared sage-green gain color');
});

test('shared conversation and character-detail styling survives the physical interaction screen removal', async () => {
  const css = await readFile(`${root}/style.css`, 'utf8');
  assert.match(css, /\.standee-frame\s*\{[\s\S]*position:\s*sticky/, 'standee frame should stay fixed near the top while the chat panel scrolls');
  assert.match(css, /\.standee-frame\s*\{[\s\S]*top:\s*20px/, 'standee sticky position should have a top offset');
  assert.match(css, /\.chat-panel\s*\{[\s\S]*min-height:\s*680px/, 'conversation chat panel should be tall for the message stream');
  assert.match(css, /\.interaction-location-name-button\s*\{[\s\S]*font-size:\s*15px/, 'interaction location name button should be readable and matched with the character name');
  assert.match(css, /\.interaction-character-name-button\s*\{[\s\S]*font-size:\s*15px/, 'interaction character name button should match the location name button size');
  assert.match(css, /\.interaction-detail-dialog\s*\{[\s\S]*max-width:\s*min\(960px, 94vw\)/, 'interaction details should open in a wider popup with room for the square scene standee');
  assert.match(css, /\.field-character-detail-dialog\s*\{[\s\S]*width:\s*min\(1200px, 96vw\);[\s\S]*max-width:\s*min\(1200px, 96vw\)/, 'field character detail dialog should widen for the left square scene standee plus editable details');
  assert.match(css, /\.character-detail-layout\s*\{[\s\S]*grid-template-columns:\s*minmax\(360px, 440px\) minmax\(0, 1fr\)/, 'character detail dialogs should give the square standee a wider left column');
  assert.match(css, /\.character-detail-standee-frame\s*\{[\s\S]*aspect-ratio:\s*1 \/ 1/, 'character detail scene standee frame should be square');
  assert.match(css, /\.character-detail-standee\s*\{[\s\S]*height:\s*100%;[\s\S]*object-fit:\s*cover/, 'character detail scene standees should fill the square display range exactly');
  assert.match(css, /\.interaction-detail-backdrop\s*\{[\s\S]*position:\s*fixed/, 'fallback interaction detail backdrop should cover the viewport');
  assert.match(css, /\.interaction-name-button\s*\{[\s\S]*cursor:\s*pointer/, 'clickable names should read as detail affordances');
  assert.match(css, /\.interaction-character-block\s*\{[\s\S]*border-top/, 'character image/name/description should remain grouped below the location preview');
  assert.match(css, /\.interaction-character-name\s*\{[\s\S]*font-size:\s*16px/, 'left character name under the image should be 16px');
  assert.match(css, /\.interaction-character-parameters\s*\{[\s\S]*margin-top:\s*12px/, 'left character parameters should sit directly below the description with small spacing');
  assert.match(css, /\.character-parameter-group\s*\{[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/, 'character parameter values should use a compact two-column grid in the left panel');
  assert.match(css, /:root\b[\s\S]*--surface-character-parameter-item:\s*rgb\(var\(--c-ink\) \/ 0\.32\)/, 'theme should define the shared character parameter chip surface token');
  assert.match(css, /\.character-parameter-section h4\s*\{[\s\S]*color:\s*var\(--accent-gold\)/, 'character parameter section headings should consume the gold accent token');
  assert.match(css, /\.character-parameter-item\s*\{[\s\S]*border:\s*var\(--border-character-parameter-item\)[\s\S]*border-radius:\s*var\(--radius-character-parameter-item\)[\s\S]*background:\s*var\(--surface-character-parameter-item\)/, 'character parameter chips should use the same tokenized warm academy border language');
});

test('debug screen keeps only flags and recent LLM requests, with the save/load controls removed without a trace', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');
  const debugBlock = html.match(/<section id="debug-screen"[\s\S]*<\/main>/)?.[0] ?? '';
  // Bounded to the debug screen alone (next screen is gathering) so absence checks do not read later screens.
  const debugMarkup = html.match(/<section id="debug-screen"[\s\S]*?<section id="gathering-screen"/)?.[0] ?? '';

  assert.doesNotMatch(debugBlock, /runtime_state|asset resolver|continuity record status|Interaction Debug/, 'debug screen should remove the requested obsolete panel titles');
  assert.doesNotMatch(debugBlock, /id="state-json"|id="asset-json"|id="record-status"|id="provider-select"|id="refresh-prompt"|id="prompt-preview"|id="conversation-log"|id="work-record-recall-debug"|id="refresh-assets"|id="reset-memory"|id="reset-skills"|id="reset-work-records"/, 'debug screen should remove the requested obsolete panel controls');
  assert.doesNotMatch(js, /#state-json|#asset-json|#record-status|#provider-select|#refresh-prompt|#prompt-preview|#conversation-log|#work-record-recall-debug|#refresh-assets|#reset-memory|#reset-skills|#reset-work-records/, 'browser script should not query removed debug-only elements');

  assert.match(debugBlock, /id="flag-title-list"[\s\S]*aria-label="flag title list"/, 'flags should render as clickable title rows');
  assert.match(html, /id="flag-detail-dialog"[\s\S]*id="flag-detail-title"[\s\S]*id="flag-detail-body"/, 'flag title clicks should open a detail dialog');
  assert.match(js, /function openFlagDetail\(flagId\)/, 'browser script should open flag details by id');
  assert.match(js, /flag-title-button/, 'flag titles should be rendered as buttons like recent LLM requests');
  assert.doesNotMatch(debugBlock, /<pre id="flag-status">/, 'flags should not remain a raw JSON pre block');

  // Save / Load は痕跡なく削除（markup / 専用ハンドラ / 専用 CSS すべて）。共有スロットロード画面の
  // refreshSaveSlots / loadSpecificSlot / world 画面の #save-world-description は別物なので残る。
  assert.doesNotMatch(debugMarkup, /Save \/ Load|class="save-load-layout"|id="save-slot-id"|id="create-save"|id="save-slots"|id="load-save"|save-panel|save-slot-field|save-slot-list/, 'the debug Save / Load panel and its controls should be gone from the markup');
  assert.doesNotMatch(js, /function createSave\b|function loadSave\b|#create-save|#load-save|#save-slots|#save-slot-id/, 'the debug save/load handlers and their element queries should be removed');
  assert.doesNotMatch(css, /\.save-load-layout|\.save-slot-field|\.save-slot-list|\.save-panel/, 'the debug save/load CSS should be removed without leaving dead rules');

  assert.doesNotMatch(html, /v4 source_images mock|source-mock-preview|source-mock-variant|source-mock-expression|randomize-source-mock|source-mock-caption/, 'v4 source_images mock UI should be removed');
  assert.doesNotMatch(js, /sourceMock|source-character-mock|source-mocks|source-mock/, 'browser v4 source mock logic should be removed');
});

test('debug screen wears the metaphysical-moonlight meta layer as a shell-less full-screen ground (token-only)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');
  const debugMarkup = html.match(/<section id="debug-screen"[\s\S]*?<section id="gathering-screen"/)?.[0] ?? '';

  // 全画面直接: no shell window / app-card wrapper anywhere in the debug markup — the heading + panel grid sit
  // directly on the moonlight ground.
  assert.doesNotMatch(debugMarkup, /app-card|academy-map-shell|debug-screen-shell|screen-shell/, 'the debug screen should drop the app-card / shell wrapper for the full-screen-direct moonlight ground');
  assert.match(debugMarkup, /<div class="debug-grid">\s*<section class="debug-panel" aria-label="stage flags">/, 'debug panels should keep the bare debug-panel class (no app-card) inside the grid');

  // Token scope: the debug screen joins the shared meta-night token block so it can consume var(--meta-*).
  assert.match(css, /#title-screen,\n#academy-loading-screen,\n#slot-load-screen,\n#settings-screen,\n#debug-screen,\n#world-screen,\n#field-screen,\n.topbar \{[\s\S]*--meta-night-0:[\s\S]*--meta-silver:[\s\S]*--meta-starlight:[\s\S]*\}/, 'the debug screen should join the shared meta-night token scope');

  // topbar-visible tab screen: fills the viewport below the persistent debug topbar and delegates scroll.
  assert.match(css, /\.layout:has\(#debug-screen\.active\)\s*\{[\s\S]*height:\s*calc\(100dvh - var\(--runtime-topbar-height, 88px\)\)[\s\S]*padding:\s*0[\s\S]*overflow:\s*hidden/, 'the debug route should fill the viewport below the persistent debug topbar');

  const debugActiveCss = cssRuleBlock(css, '#debug-screen.active');
  assert.notEqual(debugActiveCss, '', '#debug-screen.active should have a dedicated moonlight ground rule');
  assert.match(debugActiveCss, /display:\s*grid[\s\S]*grid-template-rows:\s*auto minmax\(0, 1fr\)/, 'the debug screen should split into a heading row and a scrolling panel grid');
  assert.match(debugActiveCss, /background:[\s\S]*var\(--meta-glow\)[\s\S]*linear-gradient\([\s\S]*var\(--meta-night-2\), var\(--meta-night-0\)/, 'the debug ground should be built from the moonlight night + glow tokens (no literal color pin)');

  const debugPanelCss = cssRuleBlock(css, '.debug-panel');
  assert.match(debugPanelCss, /border:\s*1px solid var\(--meta-line\)/, 'debug panel: silver hairline (token)');
  assert.match(debugPanelCss, /background:\s*var\(--meta-panel\)/, 'debug panel: deep-night moonlight surface (token)');
  assert.match(debugPanelCss, /box-shadow:\s*0 0 0 1px var\(--meta-line\), 0 12px 30px var\(--meta-shadow\)/, 'debug panel: moonlight resting shadow (token-only)');

  // The in-scope recolor consumes only var(--meta-*): no cool/soft border tokens, and the shared warm
  // primary/danger gradients are overridden inside the debug scope rather than globally.
  for (const selector of ['#debug-screen.active', '.debug-panel', '#debug-screen .primary-action', '#debug-screen .danger-action']) {
    const block = cssRuleBlock(css, selector);
    assert.notEqual(block, '', `${selector} should have a dedicated moonlight rule block`);
    assertNoCoolOrSoftBorderToken(block, selector);
  }
  assert.match(css, /#debug-screen \.primary-action\s*\{[\s\S]*border:\s*1px solid var\(--meta-starlight\)[\s\S]*background:\s*var\(--meta-night-2\)/, 'debug primary actions should hold emphasis with a starlight frame + bright moonlight fill in-scope');
  assert.match(css, /#debug-screen \.flag-title-button,\n#debug-screen \.llm-request-title-button\s*\{[\s\S]*border:\s*1px solid var\(--meta-line\)[\s\S]*background:\s*var\(--meta-panel-strong\)[\s\S]*color:\s*var\(--meta-silver\)/, 'debug flag / LLM-request title rows should recolor to the quiet moonlight silver family in-scope');
});

test('the debug topbar wears the metaphysical-moonlight meta chrome (token-only, mechanics-invariant tabs)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  // Token scope: the topbar joins the shared meta-night token block so its chrome can consume var(--meta-*)
  // — the tokens are declared on the topbar's own scope (never :root) exactly like the meta screens.
  assert.match(css, /#title-screen,\n#academy-loading-screen,\n#slot-load-screen,\n#settings-screen,\n#debug-screen,\n#world-screen,\n#field-screen,\n.topbar \{[\s\S]*--meta-night-0:[\s\S]*--meta-silver:[\s\S]*--meta-starlight:[\s\S]*\}/, 'the topbar should join the shared meta-night token scope');

  // The bar itself: deep-night silver ground + a starlight hairline, no warm gold literal pin.
  const topbarCss = cssRuleBlock(css, '.topbar');
  assert.notEqual(topbarCss, '', '.topbar should have a dedicated chrome rule');
  assert.match(topbarCss, /background:\s*var\(--meta-panel-strong\)/, 'topbar ground should be the deep-night moonlight panel token');
  assert.match(topbarCss, /border-bottom:\s*1px solid var\(--meta-line\)/, 'topbar underline should be the starlight hairline token');
  assert.doesNotMatch(topbarCss, /211, 180, 105|13, 19, 31|#[0-9a-fA-F]{3,6}/, 'topbar chrome must carry no literal color pin (token-only)');
  assert.match(css, /\.topbar h1\s*\{\s*color:\s*var\(--meta-silver-strong\);\s*\}/, 'topbar title should read as bright moonlight silver');
  assert.match(css, /\.topbar \.eyebrow\s*\{\s*color:\s*var\(--meta-silver-dim\);\s*\}/, 'topbar eyebrow should recolor to the quiet moonlight silver in-scope');

  // Tab buttons carry their OWN moonlit rule; the generic control rule no longer includes .screen-tabs button
  // so every other screen's buttons/inputs stay byte-equal.
  assert.doesNotMatch(css, /\.screen-tabs button,\n?button,\n?input,\n?textarea,\n?select\s*\{/, 'the tab buttons must be split out of the shared control rule so the generic warm control chrome is untouched');
  const tabCss = cssRuleBlock(css, '.screen-tabs button');
  assert.notEqual(tabCss, '', '.screen-tabs button should have a dedicated moonlight rule');
  assert.match(tabCss, /border:\s*1px solid var\(--meta-line\)/, 'tab chip: silver hairline (token)');
  assert.match(tabCss, /background:\s*var\(--meta-panel\)/, 'tab chip: deep-night moonlight surface (token)');
  assert.match(tabCss, /color:\s*var\(--meta-silver\)/, 'tab chip: quiet moonlight silver label (token)');
  assert.doesNotMatch(tabCss, /#[0-9a-fA-F]{3,6}|211, 180, 105|23314d/, 'tab chip must carry no literal color pin (token-only)');
  assert.match(css, /\.screen-tabs button:hover:not\(:disabled\),\n\.screen-tabs button:focus-visible\s*\{[\s\S]*border-color:\s*var\(--meta-starlight\)[\s\S]*background:\s*var\(--meta-panel-strong\)[\s\S]*box-shadow:\s*0 0 14px var\(--meta-glow\)/, 'tab chips should flare to a starlight frame + moonlight glow on hover/focus');

  const activeTabCss = cssRuleBlock(css, '.screen-tabs button.active');
  assert.notEqual(activeTabCss, '', '.screen-tabs button.active should have a dedicated moonlight rule');
  assert.match(activeTabCss, /border-color:\s*var\(--meta-starlight\)[\s\S]*background:\s*var\(--meta-night-2\)[\s\S]*color:\s*var\(--meta-silver-strong\)[\s\S]*box-shadow:\s*0 0 14px var\(--meta-glow\)/, 'the active tab should hold emphasis with a starlight frame + bright moonlight fill');
  assert.doesNotMatch(activeTabCss, /6f5b2d/, 'the old warm-gold active fill must be gone without a trace');

  // Mechanics-invariant: all 13 debug tabs stay present and wired to their data-screen routes.
  const tabScreens = ['world', 'field', 'shop', 'gathering', 'debug', 'title', 'academy-map', 'academy-conversation-session', 'academy-training', 'academy-dungeon', 'academy-room', 'slot-load', 'settings'];
  assert.equal(tabScreens.length, 13, 'the debug topbar carries exactly 13 tabs');
  const tabNav = html.match(/<nav class="screen-tabs"[\s\S]*?<\/nav>/)?.[0] ?? '';
  assert.notEqual(tabNav, '', 'the screen-tabs nav should be locatable');
  for (const screen of tabScreens) {
    assert.match(tabNav, new RegExp(`<button data-screen="${screen}"`), `tab route data-screen="${screen}" must survive the restyle`);
  }
  assert.match(tabNav, /<button data-screen="academy-map" class="active">/, 'academy-map should keep its initial active tab state');
});

test('server no longer exposes v4 source_images mock routes or imports its mock logic', async () => {
  const server = await readFile(`${sourceRoot}/server.mjs`, 'utf8');
  assert.doesNotMatch(server, /sourceImageMock|buildSourceCharacterMockRecipe|renderSourceCharacterMockSvg/);
  assert.doesNotMatch(server, /api\/source-character-mock|source-mocks/);
});

test('longer stage situations stay readable: the shared status card keeps its floor and the stage detail body wraps over a stable 16:9 image', async () => {
  const css = await readFile(`${root}/style.css`, 'utf8');

  // (a) The shared base status card (自室 / 訓練) keeps its fixed height floor. The 会話相手選択
  //     status card that used to relax it lived on the deleted companion screen; the conversation
  //     partner list is a bounded map popup now, so only the shared floor rule remains.
  const baseCard = cssRuleBlock(css, '.academy-map-status-card');
  assert.match(baseCard, /height:\s*132px/, 'shared base status card (自室 / 訓練) should keep its fixed height');
  assert.match(baseCard, /min-height:\s*132px/, 'shared base status card should keep its min-height floor');
  assert.doesNotMatch(css, /\.academy-companion-shell/, 'the deleted companion shell must leave no scoped status-card rule behind');

  // (b) The shared stage/location detail body text must wrap normally instead of
  //     forcing one nowrap line that horizontally scrolls and unbalances the dialog.
  const detailText = cssRuleBlock(css, '.academy-conversation-session-location-detail-text');
  assert.notEqual(detailText, '', 'stage/location detail text should own a rule');
  assert.doesNotMatch(detailText, /white-space:\s*nowrap/, 'stage/location detail body should no longer be forced onto a single nowrap line');
  assert.doesNotMatch(detailText, /overflow-x:\s*auto/, 'stage/location detail body should not rely on horizontal scrolling');
  assert.match(detailText, /overflow-wrap:\s*anywhere/, 'stage/location detail body should wrap at appropriate points for the longer situations');

  // (c) The stage/location detail image must keep its 16:9 ratio regardless of how
  //     long the body text is, so it never renders as a long, distorted slab.
  const detailImage = cssRuleBlock(css, '.field-location-detail-image');
  assert.notEqual(detailImage, '', 'stage/location detail image should own a rule');
  assert.match(detailImage, /aspect-ratio:\s*16\s*\/\s*9/, 'stage/location detail image should pin a 16:9 ratio so text length cannot distort it');
});

test('map-opened stage preview pins a fixed width and shows the whole 16:9 background', async () => {
  const css = await readFile(`${root}/style.css`, 'utf8');

  // Clicking a map node opens #academy-map-location-dialog (.academy-map-location-dialog),
  // whose eyebrow reads "Stage Preview". Without an explicit width the <dialog>
  // defaults to fit-content, so the box grows/shrinks with the description text.
  // Pin a fixed px width so the preview no longer depends on the situation length.
  const dialog = cssRuleBlock(css, '.academy-map-location-dialog');
  assert.notEqual(dialog, '', 'map location (stage preview) dialog should own a rule');
  assert.match(dialog, /width:\s*\d+px/, 'stage preview dialog should pin a fixed px width so it does not fit-content to the description length');

  // Its image must show the whole original background (2000x1125 = 16:9) at its
  // native ratio instead of a min-height slab cropped by cover.
  const image = cssRuleBlock(css, '.academy-map-location-image');
  assert.notEqual(image, '', 'map location (stage preview) image should own a rule');
  assert.match(image, /aspect-ratio:\s*16\s*\/\s*9/, 'stage preview image should pin the original 16:9 ratio');
  assert.match(image, /background-size:\s*contain/, 'stage preview image should contain (whole image visible) instead of cover');
  assert.match(image, /background-repeat:\s*no-repeat/, 'contained stage preview image should not tile');
});
