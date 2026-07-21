import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { projectRoot } from './testPaths.mjs';

const publicRoot = path.join(projectRoot, 'app/public');

function ruleBlock(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
}

test('the dungeon screen is the obsidian ground filling the layout edge-to-edge (direct-background standard, self-contained --dungeon-* tokens)', async () => {
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  const screen = ruleBlock(css, '#academy-dungeon-screen.active');
  assert.ok(screen, '#academy-dungeon-screen.active rule should exist');
  // Direct-background (いきなり背景) standard: the obsidian ground fills the layout edge-to-edge, painted via the
  // self-contained var(--dungeon-bg-0) token (no re-pinned literals). The play panels below carry their own cards.
  assert.match(screen, /background:\s*var\(--dungeon-bg-0\)/, 'the screen paints the obsidian ground token');
  // No floating-frame chrome: the old border / frame radius / inner-ring + drop-shadow that read as a window on the
  // body's navy gradient is gone, so no navy is revealed as a border (nor at rounded corners).
  assert.doesNotMatch(screen, /border:|border-radius:|box-shadow:/, 'the dungeon screen drops the floating-window border / radius / shadow chrome (edge-to-edge obsidian, no navy-gradient border)');
  // The inner padding stays inside the viewport-bound height.
  assert.match(screen, /box-sizing:\s*border-box/, 'border-box keeps the inner padding inside the bound height');
  // The viewport-height / internal-scroll chain is preserved (mechanics unchanged).
  assert.match(screen, /height:\s*100%/, 'the screen still fills the viewport-bound height');
  assert.match(screen, /overflow-y:\s*auto/, 'the screen keeps its scroll safety');
});

test('the dungeon play panels adopt the obsidian --dungeon-* panel surface tokens', async () => {
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  for (const selector of ['.dungeon-hud', '.dungeon-chat', '.dungeon-dock']) {
    const block = ruleBlock(css, selector);
    assert.ok(block, `${selector} rule should exist`);
    assert.match(block, /border:\s*1px solid var\(--dungeon-line\)/, `${selector} adopts the amber hairline border`);
    assert.match(block, /background:\s*var\(--dungeon-panel\)/, `${selector} adopts the obsidian translucent panel surface`);
    assert.match(block, /box-shadow:\s*0 14px 34px var\(--dungeon-shadow\)/, `${selector} carries the obsidian panel drop shadow`);
    assert.match(block, /backdrop-filter:\s*blur\(16px\)/, `${selector} blurs over the obsidian ground like its siblings`);
    assert.match(block, /border-radius:\s*var\(--radius-card\)/, `${selector} nests the card radius inside the frame radius`);
  }
  // The map grid takes the same obsidian panel surface but intentionally NO backdrop blur — the
  // camera-transformed board lives inside it (the board-protection exception, unchanged).
  const grid = ruleBlock(css, '.dungeon-grid');
  assert.match(grid, /background:\s*var\(--dungeon-panel\)/, 'the map grid uses the obsidian panel surface');
  assert.doesNotMatch(grid, /backdrop-filter/, 'the camera-transformed map grid keeps no backdrop blur');
  assert.match(grid, /border-radius:\s*var\(--radius-card\)/, 'the map grid nests the card radius');
});

test('the dungeon shell/panel surfaces pin no literal color (obsidian tokens only)', async () => {
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  for (const selector of ['#academy-dungeon-screen.active', '.dungeon-hud', '.dungeon-chat', '.dungeon-dock', '.dungeon-grid']) {
    const block = ruleBlock(css, selector);
    assert.doesNotMatch(block, /rgba\(|rgb\(|#[0-9a-fA-F]{3,6}\b/, `${selector} surfaces are token-only (no literal color pin)`);
  }
});

test('the chat send button border matches the menu button .dungeon-hud-button (amber hairline + pill, token-only)', async () => {
  const html = await readFile(path.join(publicRoot, 'index.html'), 'utf8');
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  // The send button stays the .dungeon-spell pill (background/label/size) with .dungeon-talk-send as
  // the scoping hook; it is not the academy CTA.
  assert.match(html, /<button id="dungeon-talk-send"[^>]*class="dungeon-spell dungeon-talk-send"/, 'the send button keeps the .dungeon-spell pill + .dungeon-talk-send hook');
  assert.doesNotMatch(html, /<button id="dungeon-talk-send"[^>]*class="academy-map-action-button/, 'the send button is not the academy CTA class');
  // Its border is aligned to the menu button .dungeon-hud-button — the same amber hairline token + pill
  // radius, consumed via var() (no re-pinned literal). It is no longer the spell pill's currentColor edge.
  const sendButton = ruleBlock(css, '#dungeon-talk-send');
  assert.ok(sendButton, '#dungeon-talk-send rule should exist');
  assert.match(sendButton, /border:\s*1px solid var\(--dungeon-line\)/, 'the send button border uses the menu-button amber hairline token');
  assert.match(sendButton, /border-radius:\s*var\(--radius-pill\)/, 'the send button uses the menu-button pill radius token');
  assert.doesNotMatch(sendButton, /currentColor/, 'the send button border is no longer the spell pill currentColor edge');
  assert.doesNotMatch(sendButton, /rgba\(|rgb\(|#[0-9a-fA-F]{3,6}\b/, 'the send button border is token-only (no literal color pin)');
});

test('the send button keeps the menu-button border in its disabled state (the disabled cue is on the label, not a faded edge)', async () => {
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  // .dungeon-spell:disabled fades the whole pill — including its border — to opacity 0.4, but the menu
  // button .dungeon-hud-button never disables. The send button is disabled in normal play (companion
  // down, or a turn in flight), so without this override its edge drops to a washed-out amber and stops
  // matching the menu button. The disabled state keeps the border at full strength (opacity: 1, not the
  // spell-pill 0.4 fade) and moves the disabled cue onto a muted ink token instead of the edge.
  const disabled = ruleBlock(css, '#dungeon-talk-send:disabled');
  assert.ok(disabled, '#dungeon-talk-send:disabled rule should exist');
  assert.match(disabled, /opacity:\s*1\b/, 'the disabled send button does not fade its border (opacity stays 1, unlike the .dungeon-spell:disabled 0.4 fade)');
  assert.match(disabled, /color:\s*var\(--dungeon-ink-dim\)/, 'the disabled cue is carried on the muted ink token, not on the border');
  // The shared spell-pill disabled fade is left intact for the magic/heal pills.
  assert.match(css, /\.dungeon-spell:disabled \{ opacity: 0\.4; cursor: not-allowed; \}/, 'the spell-pill disabled fade still dims the attack/heal pills');
});

test('the dungeon eyebrows are recolored to amber lamplight in-scope (the shared base .eyebrow stays byte-equal)', async () => {
  const html = await readFile(path.join(publicRoot, 'index.html'), 'utf8');
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  // The dungeon entry keeps the base eyebrow class in markup...
  const screen = html.match(/<section id="academy-dungeon-screen"[\s\S]*?\n {6}<\/section>/)?.[0] ?? html.match(/<section id="academy-dungeon-screen"[\s\S]*/)?.[0] ?? '';
  assert.match(screen, /<p class="eyebrow">Practical Dungeon<\/p>/, 'the entry uses the base eyebrow class');
  // ...but the dungeon recolors it to amber lamplight in-scope (id-scoped so the shared base .eyebrow is untouched);
  // the retreat confirm's JS-built eyebrow (Retreat) is toned by the same in-scope rule.
  assert.match(css, /#academy-dungeon-screen \.eyebrow\s*\{\s*color:\s*var\(--dungeon-amber\)/, 'the dungeon eyebrow is amber lamplight in-scope');
});

test('the dungeon controls keep their pill style on the obsidian palette (spells / heal / menu / close)', async () => {
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  // Spell pills keep their pill style (currentColor element border over the obsidian chip surface).
  assert.match(ruleBlock(css, '.dungeon-spell'), /border:\s*1px solid currentColor[\s\S]*background:\s*var\(--dungeon-chip\)/, 'attack spell buttons keep their pill style over the obsidian chip');
  // The self-heal keeps its distinct amber restore accent.
  assert.match(css, /\.dungeon-spell-heal \{ color: var\(--dungeon-amber\); \}/, 'the self-heal keeps its amber restore accent');
  // Menu + close buttons keep their chip-pill style on the obsidian palette.
  assert.match(ruleBlock(css, '.dungeon-hud-button'), /border:\s*1px solid var\(--dungeon-line\)[\s\S]*background:\s*var\(--dungeon-chip\)/, 'the menu button keeps its chip-pill style on the obsidian palette');
  assert.match(ruleBlock(css, '.dungeon-icon-button'), /border:\s*1px solid var\(--dungeon-line\)[\s\S]*background:\s*var\(--dungeon-chip\)/, 'the close button keeps its chip-pill style on the obsidian palette');
});

test('the retreat confirm action buttons are recolored to the obsidian chip-pill family in-scope (the shared academy CTA stays byte-equal)', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  // The retreat confirm's buttons are the shared academy CTA class (.academy-map-action-button) built in app.js:
  // a .primary (撤退する) / .secondary (続ける) pair inside the dedicated modal. That shared class otherwise wears
  // the warm-gold academy chrome, so the in-scope recolor below is what keeps the obsidian confirm on-palette.
  assert.match(js, /function openDungeonRetreatConfirm\(\)[\s\S]*?className = 'academy-map-action-button primary'[\s\S]*?className = 'academy-map-action-button secondary'/, 'the retreat confirm floats a primary/secondary CTA pair');

  // Every confirm-scoped academy CTA rule consumes only the obsidian --dungeon-* layer (no literal color pin,
  // no warm-gold shared chrome token / raw channel). The scope is #dungeon-retreat-confirm so the base is untouched.
  const popupButtonCss = [...css.matchAll(/#dungeon-retreat-confirm \.academy-map-action-button[^{]*\{[^}]*\}/g)].map((m) => m[0]).join('\n');
  assert.ok(popupButtonCss, 'the #dungeon-retreat-confirm academy CTA recolor rules should exist');
  assert.doesNotMatch(popupButtonCss, /#[0-9a-fA-F]{3,6}\b|rgba?\(/, 'the confirm buttons pin no literal color (obsidian tokens only)');
  assert.doesNotMatch(popupButtonCss, /var\(--(btn-|text-strong|text-muted|border-academy|shadow-map|surface-|border-warm|accent-gold|c-)/, 'the confirm buttons drop every warm-gold shared chrome token / raw channel');
  // The chip-pill family: obsidian chip + amber hairline + ivory ink, matching .dungeon-hud-button / .dungeon-icon-button.
  assert.match(ruleBlock(css, '#dungeon-retreat-confirm .academy-map-action-button'), /border:\s*1px solid var\(--dungeon-line\)[\s\S]*background:\s*var\(--dungeon-chip\)[\s\S]*color:\s*var\(--dungeon-ink-strong\)/, 'the confirm button base wears the obsidian chip-pill (amber hairline + chip surface + ivory ink)');
  assert.match(ruleBlock(css, '#dungeon-retreat-confirm .academy-map-action-button.primary'), /border-color:\s*var\(--dungeon-amber\)[\s\S]*background:\s*var\(--dungeon-inset\)/, 'the primary confirm carries the amber-edged emphasis');
  assert.match(ruleBlock(css, '#dungeon-retreat-confirm .academy-map-action-button.secondary'), /background:\s*var\(--dungeon-chip\)/, 'the secondary keeps the calmer chip surface');
  assert.match(ruleBlock(css, '#dungeon-retreat-confirm .academy-map-action-button:hover:not(:disabled)'), /border-color:\s*var\(--dungeon-amber\)[\s\S]*background:\s*var\(--dungeon-inset\)/, 'hover lifts to the amber edge over the inset surface');
  assert.match(ruleBlock(css, '#dungeon-retreat-confirm .academy-map-action-button:disabled'), /color:\s*var\(--dungeon-ink-dim\)[\s\S]*cursor:\s*not-allowed/, 'the disabled cue is the muted ink token (retreat confirm off the entrance/stairs)');

  // The shared academy CTA base is unchanged — proving this is an in-scope recolor, not a shared-layer edit.
  assert.match(css, /\n\.academy-map-action-button \{[^}]*background:\s*var\(--btn-secondary-bg\)/, 'the shared academy CTA base stays byte-equal (still the warm-gold chrome on every other screen)');
});

test('the entry surface launch buttons are recolored to the same obsidian chip-pill family in-scope (shared academy CTA stays byte-equal)', async () => {
  const html = await readFile(path.join(publicRoot, 'index.html'), 'utf8');
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  // The entry launch buttons (#dungeon-enter = ダンジョンに潜る primary, #dungeon-back-to-map = 学院マップに戻る
  // secondary) are the shared academy CTA class, hosted on the obsidian entry card (#dungeon-entry). Without the
  // in-scope recolor they wear the warm-gold academy chrome on the obsidian ground (the same gap the menu popup had).
  assert.match(html, /<button id="dungeon-enter"[^>]*class="academy-map-action-button primary"/, 'the enter button is the shared CTA primary');
  assert.match(html, /<button id="dungeon-back-to-map"[^>]*class="academy-map-action-button secondary"/, 'the back-to-map button is the shared CTA secondary');

  // Every entry-scoped academy CTA rule consumes only the obsidian --dungeon-* layer (no literal color pin, no
  // warm-gold shared chrome token / raw channel). The scope is #dungeon-entry so the shared base stays untouched.
  const entryButtonCss = [...css.matchAll(/#dungeon-entry \.academy-map-action-button[^{]*\{[^}]*\}/g)].map((m) => m[0]).join('\n');
  assert.ok(entryButtonCss, 'the #dungeon-entry academy CTA recolor rules should exist');
  assert.doesNotMatch(entryButtonCss, /#[0-9a-fA-F]{3,6}\b|rgba?\(/, 'the entry buttons pin no literal color (obsidian tokens only)');
  assert.doesNotMatch(entryButtonCss, /var\(--(btn-|text-strong|text-muted|border-academy|shadow-map|surface-|border-warm|accent-gold|c-)/, 'the entry buttons drop every warm-gold shared chrome token / raw channel');
  // Same chip-pill family as the menu popup CTAs (obsidian chip + amber hairline + ivory ink).
  assert.match(ruleBlock(css, '#dungeon-entry .academy-map-action-button'), /border:\s*1px solid var\(--dungeon-line\)[\s\S]*background:\s*var\(--dungeon-chip\)[\s\S]*color:\s*var\(--dungeon-ink-strong\)/, 'the entry button base wears the obsidian chip-pill');
  assert.match(ruleBlock(css, '#dungeon-entry .academy-map-action-button.primary'), /border-color:\s*var\(--dungeon-amber\)[\s\S]*background:\s*var\(--dungeon-inset\)/, 'the enter (primary) carries the amber-edged emphasis');
  assert.match(ruleBlock(css, '#dungeon-entry .academy-map-action-button.secondary'), /background:\s*var\(--dungeon-chip\)/, 'the back-to-map (secondary) keeps the calmer chip surface');
  assert.match(ruleBlock(css, '#dungeon-entry .academy-map-action-button:hover:not(:disabled)'), /border-color:\s*var\(--dungeon-amber\)[\s\S]*background:\s*var\(--dungeon-inset\)/, 'hover lifts to the amber edge over the inset surface');
  assert.match(ruleBlock(css, '#dungeon-entry .academy-map-action-button:disabled'), /color:\s*var\(--dungeon-ink-dim\)[\s\S]*cursor:\s*not-allowed/, 'the disabled cue is the muted ink token');

  // The shared academy CTA base is still byte-equal after adding the entry recolor too.
  assert.match(css, /\n\.academy-map-action-button \{[^}]*background:\s*var\(--btn-secondary-bg\)/, 'the shared academy CTA base stays byte-equal');
});
