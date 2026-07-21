import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { projectRoot } from './testPaths.mjs';

const publicRoot = path.join(projectRoot, 'app/public');

test('the rich dungeon screen has full-bleed map, HUD, dock, chat sidebar, and popup; entry beside basic training and a tab', async () => {
  const html = await readFile(path.join(publicRoot, 'index.html'), 'utf8');
  assert.match(html, /<section id="academy-dungeon-screen"[\s\S]*id="academy-dungeon-title"/, 'dungeon screen section exists');
  assert.match(html, /data-screen="academy-training">鍛錬<\/button>\s*<button data-screen="academy-dungeon">実践<\/button>/, 'a 実践 tab sits next to 鍛錬');
  assert.match(html, /id="academy-training-open-dungeon"[^>]*>実践（自動生成ダンジョン）に潜る/, 'an entry to the dungeon sits on the basic-training screen');
  // HUD bar with status + retreat button + help icon (the menu button is gone; the conversation panel is
  // always on — no chat toggle)
  assert.match(html, /id="dungeon-hud-status"[\s\S]*id="dungeon-retreat-button"[\s\S]*id="dungeon-help-button"/, 'HUD bar aggregates status with the retreat + help buttons');
  assert.doesNotMatch(html, /id="dungeon-menu-button"|id="dungeon-chat-button"/, 'no menu button and no chat toggle button');
  // map column (stage) then the right rail (side) with the always-on conversation panel over items/dock
  assert.match(html, /class="dungeon-stage"[\s\S]*id="dungeon-grid"[\s\S]*class="dungeon-side"[\s\S]*id="dungeon-chat"[\s\S]*id="dungeon-chat-log"[\s\S]*id="dungeon-talk-send"/, 'the map column leads, then the right rail carries the always-on conversation panel');
  assert.doesNotMatch(html, /id="dungeon-chat-close"/, 'the always-on panel has no close button');
  // dock split: controls (spells) on the left, scrollable action log on the right; the dpad and
  // the wait/descend buttons are gone (movement + 待機 + 階段を降りる are keyboard actions now)
  assert.match(html, /class="dungeon-dock"[\s\S]*id="dungeon-spells"[\s\S]*id="dungeon-log"/, 'the dock splits into spell controls and a scrollable action log');
  assert.doesNotMatch(html, /id="dungeon-wait"|id="dungeon-descend"|id="dungeon-log-ribbon"|class="dungeon-dpad"|class="dungeon-move"/, 'the dpad and wait/descend buttons and the old log ribbon are removed');
  // popup modal root (inventory / stats / help / retreat live here, not always-on)
  assert.match(html, /id="dungeon-popup"[\s\S]*id="dungeon-popup-title"[\s\S]*id="dungeon-popup-body"/, 'a popup modal root exists for menu-driven panels');
});

test('app.js drives the rich dungeon: icon tokens, popups, compact chat, aggregated HUD', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  assert.match(js, /'academy-dungeon': document\.querySelector\('#academy-dungeon-screen'\)/, 'dungeon screen is registered');
  assert.match(js, /if \(name === 'academy-dungeon' && !skipDungeonRefresh\) refreshDungeonScreen\(\)/, 'showing the screen refreshes dungeon state (unless the enter flow already holds the board)');
  assert.match(js, /async function enterDungeon\(\)[\s\S]*endpoint: '\/api\/dungeon\/enter'/, 'enter streams the dungeon enter route through the shared SSE controller');
  assert.match(js, /async function dungeonDo\(action\)[\s\S]*postJson\('\/api\/dungeon\/action'/, 'actions post to the dungeon action route');
  // icon tokens: player crest (faceless), companion face via visual_set, enemy by archetype_id
  assert.match(js, /function dungeonTokenEl\(/, 'tokens are built as decorated icons');
  assert.match(js, /DUNGEON_CREST_SVG/, 'the faceless protagonist uses a CSS/SVG crest (no portrait asset)');
  assert.match(js, /function dungeonCompanionFaceUrl\(characterId\)[\s\S]*\/canonical\/character_visual_sets\/\$\{visualSetId\}\/face_emotions\/neutral\.jpg/, 'companion icon reuses the visual_set face image');
  // The map ally token resolves its face through the shared companion-token resolver (passing the whole run view
  // companion), so a homunculus companion — absent from the selectable roster — renders its entry-snapshot face_url
  // rather than degrading to a glyph. It must NOT resolve the ally token by the bare character_id (the old bug that
  // returned null for a homunculus and silently rendered the companion glyph).
  assert.match(js, /roleClass: 'dn-token--ally', imageUrl: dungeonCompanionTokenFaceUrl\(view\.companion\)/, 'the map ally token resolves its face via the shared companion-token resolver (whole companion, not a bare id)');
  assert.doesNotMatch(js, /roleClass: 'dn-token--ally', imageUrl: dungeonCompanionFaceUrl\(view\.companion\.character_id\)/, 'the map ally token no longer resolves a homunculus companion to null via the visual_set-only path');
  // The shared resolver: a homunculus companion (face_url marker) uses its face_url, a selectable companion resolves
  // the visual_set face by character_id, and a homunculus whose face_url is missing/blank fails fast (no silent glyph).
  assert.match(js, /function dungeonCompanionTokenFaceUrl\(companion\) \{\s*if \(!dungeonCompanionIsHomunculus\(companion\)\) return dungeonCompanionFaceUrl\(companion\.character_id\);[\s\S]*const faceUrl = companion\.face_url;\s*if \(typeof faceUrl !== 'string' \|\| faceUrl === ''\) \{\s*throw new Error\([\s\S]*homunculus dungeon companion is missing face_url/, 'the shared token resolver branches homunculus→face_url / selectable→visual_set and fails fast on a homunculus missing face_url');
  assert.match(js, /const DUNGEON_ASSET_BASE = '\/canonical\/dungeon'/, 'new dungeon art lives under /canonical/dungeon');
  assert.match(js, /function dungeonEnemyIconUrl\(archetypeId\)[\s\S]*enemies\/\$\{archetypeId\}\.png/, 'enemy icon resolves by archetype_id');
  assert.match(js, /img\.addEventListener\('error'[\s\S]*dn-token-glyph/, 'missing art falls back to a glyph (not a silent break)');
  // The menu layer is gone: 撤退 is a HUD button + dedicated confirm modal, ヘルプ a HUD icon button opening the
  // help popup, and the old stats popup content moved into the hero detail. The inventory popup is gone too —
  // floor pickups are used from the 拾ったアイテム column (the single use_item route).
  assert.doesNotMatch(js, /function openDungeonMenu|function openDungeonStats|DUNGEON_PARAM_REFLECTIONS|function openDungeonInventory/, 'the menu / stats popup / inventory popup are removed');
  assert.match(js, /function buildDungeonPickupRow\(item\)[\s\S]*dungeonDo\(\{ type: 'use_item', item_kind: item\.kind \}\)/, 'the 拾ったアイテム column row uses items via use_item');
  assert.match(js, /function openDungeonHelp\(\)[\s\S]*showDungeonPopup\('ヘルプ'/, 'the help popup is opened directly (from the HUD help icon)');
  // Retreat is a gated confirm in a dedicated modal (the confirm is disabled off the entrance/stairs).
  assert.match(js, /function openDungeonRetreatConfirm\(\)[\s\S]*const popup = document\.querySelector\('#dungeon-retreat-confirm'\)[\s\S]*can_retreat[\s\S]*popup\.hidden = false/, 'retreat is a gated confirm in the dedicated modal');
  // compact chat re-mounted on the shared streaming chat controller (per-message expression + cooldown reveal)
  assert.match(js, /function renderDungeonChat\(view\)[\s\S]*renderDungeonChatLog\(dungeonChatMessages\)/, 'chat renders the run-scoped history through the shared message-row renderer');
  assert.match(js, /function dungeonMessagesFromConversation\(conversation\)[\s\S]*conversation\?\.messages[\s\S]*role === 'user' \|\| message\.role === 'assistant'[\s\S]*face_emotion_variant_id/, 'companion chat maps from the full conversation.messages, carrying per-message expression');
  assert.match(js, /const dungeonChatSurface = \{[\s\S]*render: \(messages, options\) => renderDungeonChatLog\(messages, options\)[\s\S]*mapMessages: \(conversation\) => dungeonMessagesFromConversation\(conversation\)/, 'the dungeon mounts the shared controller with its own render target and conversation mapping');
  assert.match(js, /async function dungeonTalk\(\)[\s\S]*?surface: dungeonChatSurface,[\s\S]*?endpoint: '\/api\/dungeon\/companion\/talk\/stream'/, 'talk streams the companion turn through the shared SSE chat controller with the dungeon surface');
  // A failed send must roll the optimistic player line back out (restore the pre-send history), keeping the text to retry.
  assert.match(js, /async function dungeonTalk\(\)[\s\S]*?const previousMessages = dungeonChatMessages;[\s\S]*?catch \(error\) \{[\s\S]*?dungeonChatMessages = previousMessages;[\s\S]*?input\.value = text;/, 'a failed companion send rolls the optimistic line back out of the sidebar and restores the retry text');
  assert.doesNotMatch(js, /function syncDungeonChatFromConversation/, 'the old non-streaming sync helper is removed (talk now streams)');
  // The enter-time companion opening streams straight into the dungeon chat during enter through the
  // shared SSE controller with the dungeon surface (no held-then-revealed second step).
  assert.match(js, /async function enterDungeon\(\)[\s\S]*surface: dungeonChatSurface,[\s\S]*endpoint: '\/api\/dungeon\/enter'[\s\S]*onAssistantStreamStart: \(\) => showPlay\(\)/, 'the enter-time companion opening streams into the chat, leaving the loading screen on the first token');
  // Leaving the loading screen REQUIRES switching the active screen: renderDungeonPlay only unhides
  // #dungeon-play inside the dungeon screen, so showPlay must activate 'academy-dungeon' (skipping
  // its auto state-refetch since the board is already buffered) and then render the buffered board.
  assert.match(js, /const showPlay = \(\) => \{[\s\S]*showScreen\('academy-dungeon', \{ skipDungeonRefresh: true \}\);\s*renderDungeonPlay\(bufferedView\);/, 'on stream start showPlay activates the dungeon screen and reveals the buffered board (leaves the loading screen)');
  // skipDungeonRefresh suppresses the dungeon screen's auto state-refetch so the buffered reveal is
  // not overwritten by a redundant re-render mid-opening.
  assert.match(js, /name === 'academy-dungeon' && !skipDungeonRefresh\) refreshDungeonScreen\(\)/, 'showScreen can activate the dungeon screen without re-fetching its state');
  assert.doesNotMatch(js, /function revealDungeonCompanionOpening/, 'the held-then-revealed opening helper is removed (the opening now streams during enter)');
  // Always-on conversation panel: during a run the panel keeps its slot whether or not a
  // companion is present (no toggle). renderDungeonPlay always renders it; renderDungeonChat
  // only hides it when there is no view at all, and shows an explicit empty/disabled state
  // when there is no companion (it does not collapse the 6:4 layout).
  assert.match(js, /function renderDungeonChat\(view\)[\s\S]*chat\.hidden = false/, 'the conversation panel is shown during a run');
  assert.doesNotMatch(js, /function renderDungeonChat\(view\) \{\s*const chat = document\.querySelector\('#dungeon-chat'\);\s*if \(!view \|\| !view\.companion\)/, 'the panel is no longer hidden just because there is no companion');
  assert.match(js, /if \(!view\.companion\) \{[\s\S]*dungeon-chat-empty[\s\S]*同行者はいません[\s\S]*#dungeon-talk-send'\)\.disabled = true[\s\S]*#dungeon-talk-input'\)\.disabled = true/, 'with no companion the panel shows an explicit empty, disabled state (not hidden)');
  assert.match(js, /renderDungeonConsumables\(view\);\s*renderDungeonPickups\(view\);\s*renderDungeonMaterials\(view\);\s*renderDungeonChat\(view\);\s*renderDungeonGrid\(view\);/, 'renderDungeonPlay always renders the three item columns then the conversation panel');
  assert.doesNotMatch(js, /function toggleDungeonChat/, 'the chat toggle is gone (the panel is always on)');
  // Enter shows the loading screen first; an enter/opening failure returns to the room and surfaces
  // the error (never a silent solo run stuck on the loading screen).
  assert.match(js, /async function enterDungeon\(\)[\s\S]*showScreen\('academy-loading'\)[\s\S]*catch \(error\) \{[\s\S]*showScreen\('academy-room'\)[\s\S]*reportError\(error\)/, 'enter shows the loading screen and returns to the room on an enter/opening failure');
  // Exit hand-off: an ended run shows the result a beat, then auto-advances through the loading
  // screen to the mode-resolved next screen; a companion run's finalize -> bank -> clear runs in the
  // background.
  assert.match(js, /async function dungeonDo\(action\)[\s\S]*renderDungeonResult\(result\);\s*await dungeonExitToRoom\(result\)/, 'an ended run shows the result then hands off to the room');
  // The exit trusts the response's mode-resolved transition.next_screen (loop -> academy-room,
  // routing -> interaction) instead of hardcoding the room; it still backgrounds the companion
  // finalize. A run resumed from a held-finalize view has no transition, so the global play mode
  // resolves that recovery case explicitly (fail-fast on an unknown mode, never a silent default).
  assert.match(js, /async function dungeonExitToRoom\(result\)[\s\S]*?startDungeonBackgroundFinalize\(\)[\s\S]*?result\.transition\?\.next_screen[\s\S]*?currentPlayMode === 'routing' \? 'interaction' : 'academy-room'[\s\S]*?navigateToPostContentScreen\(nextScreen, \{ loadingCopy: DUNGEON_EXIT_LOADING_COPY \}\)/, 'the exit navigates to the mode-resolved next screen, not a hardcoded academy-room');
  assert.doesNotMatch(js.match(/async function dungeonExitToRoom\(result\)[\s\S]*?\n}\n/)?.[0] ?? '', /nextScreen: 'academy-room'/, 'the dungeon exit must not hardcode the academy-room return screen');
  assert.match(js, /function startDungeonBackgroundFinalize\(\)[\s\S]*postJson\('\/api\/dungeon\/finalize'/, 'the deferred companion finalize -> bank -> clear runs in the background');
  // Drain-on-exit for the routing dungeon return: the companion dungeon finalize (/api/dungeon/finalize)
  // is the dungeon's post-processing, and the hub it returns to opens on an empty queue (the hub->dungeon
  // dispatch already drained ルミ's finalization on exit, and the hub start no longer pre-drains). So on
  // the routing return (nextScreen === 'interaction'), the exit must drain the in-flight companion
  // finalize (activeDungeonFinalizationPromise) to completion under the loading screen BEFORE
  // navigateToPostContentScreen opens the hub — hub return happens only after the drain completes. Loop
  // (academy-room) keeps its un-awaited background finalize.
  assert.match(js, /async function dungeonExitToRoom\(result\)[\s\S]*?if \(nextScreen === 'interaction' && activeDungeonFinalizationPromise\) \{\s*await showAcademyLoadingScreenUntilReady\(\{[\s\S]*?readiness: \(async \(\) => \{ await activeDungeonFinalizationPromise; notifyAcademyLoadingProgress\(\); \}\)\(\),[\s\S]*?\}\);\s*\}\s*await navigateToPostContentScreen\(nextScreen, \{ loadingCopy: DUNGEON_EXIT_LOADING_COPY \}\)/, 'routing dungeon return drains the in-flight companion finalize to completion under the loading screen before opening the hub (hub return only after the drain), advancing the constellation when the finalize boundary completes');
  assert.doesNotMatch(js.match(/async function dungeonExitToRoom\(result\)[\s\S]*?\n}\n/)?.[0] ?? '', /await navigateToPostContentScreen\(nextScreen[\s\S]*?activeDungeonFinalizationPromise/, 'the finalize drain must come before (not after) the hub-opening navigation');
  assert.match(js, /async function refreshDungeonScreen\(\)[\s\S]*view\.pending_finalize[\s\S]*dungeonExitToRoom/, 'a run held awaiting finalize resumes its exit on the next dungeon visit');
  // Two-mode base form is surfaced, never silent: availability=false (incl. llm_busy while a
  // background finalize holds the gate) routes to a SOLO run, and the entry screen explains WHY via
  // dungeonReasonText (it is the dungeon's mandatory base form, not a silent downgrade).
  assert.match(js, /function dungeonReasonText\(reason\)[\s\S]*reason === 'llm_busy'[\s\S]*機械のみ/, 'the busy availability reason is surfaced as explicit solo-mode copy (not a silent downgrade)');
  assert.match(js, /function dungeonReasonText\(reason\)[\s\S]*reason === 'lmstudio_not_configured'[\s\S]*機械のみ/, 'the not-configured availability reason is surfaced as explicit solo-mode copy');
  assert.match(js, /async function renderDungeonEntry\(\)[\s\S]*\/api\/dungeon\/availability[\s\S]*availability\.available[\s\S]*dungeonReasonText\(availability\.reason\)/, 'the entry screen surfaces the availability reason when LLM is unavailable (solo mode is explained, not silent)');
  assert.match(js, /function renderDungeonChat\(view\)[\s\S]*#dungeon-talk-send'\)\.disabled = view\.companion\.down/, 'the chat is read-only when the companion is down');
  // The encounter sub-label is removed entirely: neither the element class nor its text is built.
  assert.doesNotMatch(js, /dungeon-chat-encounter/, 'the encounter sub-label element is removed from the chat header');
  assert.doesNotMatch(js, /遭遇 — 一緒に行動中/, 'the encounter sub-label text is removed');
  assert.match(js, /function renderDungeonHud\(view\)[\s\S]*dungeonActorBars\('主人公', view\.player, false, \(\) => openDungeonHeroDetail\(\)\)[\s\S]*if \(view\.companion\) party\.append\(dungeonActorBars\(view\.companion\.name, view\.companion, view\.companion\.down, \(\) => openDungeonCompanionDetail\(view\.companion\)\)\)/, 'HUD shows player + companion vitals in parallel party cards with clickable names');
  assert.match(js, /function dungeonActorBars\([\s\S]*dungeonBarEl\('HP'[\s\S]*dungeonBarEl\('MP'/, 'each party card aggregates HP/MP bars');
  assert.match(js, /function renderDungeonResult\(result\)[\s\S]*renderTrainingPlayerParameters\(result\.world\.player_parameters\)/, 'banked gains refresh the shown player parameters');
  assert.match(js, /DUNGEON_ARROW_DIRS[\s\S]*dungeonDo\(\{ type: 'move'/, 'arrow keys drive movement on the dungeon screen');
});

test('hidden dungeon containers stay hidden so no empty modal blocks the screen', async () => {
  const html = await readFile(path.join(publicRoot, 'index.html'), 'utf8');
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  // The popup and the play/result/chat panels start closed.
  assert.match(html, /id="dungeon-popup"[^>]*\shidden/, 'the modal popup is hidden by default');
  assert.match(html, /id="dungeon-play"[^>]*\shidden/, 'the play area is hidden until a run starts');
  // The container rules set display: flex/grid (would override the `hidden`
  // attribute). An id-scoped guard must force hidden dungeon elements to
  // display:none so `hidden` actually hides them (regression: empty blocking modal).
  assert.match(css, /#academy-dungeon-screen \[hidden\] \{\s*display: none;/, 'hidden dungeon elements are forced to display:none (overrides the .dungeon-* display rules)');
  // The popup must not have an !important display that would beat the guard.
  assert.doesNotMatch(css, /\.dungeon-popup \{[^}]*display:[^;]*!important/, 'the popup display rule must not use !important (the [hidden] guard must win)');
});

test('the dungeon screen styles consume the obsidian --dungeon-* token layer and stay rich', async () => {
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  assert.match(css, /\.dungeon-grid \{[\s\S]*var\(--dungeon-panel\)/, 'the map consumes the obsidian dungeon panel surface token');
  assert.match(css, /\.dn-token--enemy \{ color: var\(--dungeon-enemy\); \}/, 'enemy tokens keep their enemy identity color (tokenized)');
  assert.match(css, /\.dungeon-hud \{[\s\S]*var\(--dungeon-line\)[\s\S]*var\(--dungeon-panel\)/, 'the HUD bar consumes the obsidian dungeon border/panel surface tokens');
  assert.match(css, /\.dungeon-popup \{[\s\S]*position: fixed/, 'menu-driven panels render as a modal popup');
  assert.match(css, /@media \(max-width: 900px\) \{[\s\S]*\.dungeon-chat \{[\s\S]*bottom: 0/, 'narrow screens keep the chat as a bottom sheet (the existing positional relationship is preserved)');
});

test('field (dungeon) UX pass: animated movement overlay, 6:4 always-on chat, fixed-height log, IME-safe send', async () => {
  const html = await readFile(path.join(publicRoot, 'index.html'), 'utf8');
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');

  // 1. Movement animation — moving entities render in a persistent overlay keyed by identity
  //    (player / companion / enemy:<uid>) and are positioned by a transform the CSS transitions,
  //    so a tile change slides instead of teleporting. A new run/floor snaps (signature reset).
  assert.match(js, /function renderDungeonGrid\(view\)[\s\S]*className = 'dn-tiles'[\s\S]*className = 'dn-entities'/, 'the grid splits into a rebuilt tile layer and a persistent entity overlay');
  assert.match(js, /function upsertDungeonEntity\([\s\S]*node\.style\.transform = transform/, 'entities are positioned by transform so movement can transition');
  assert.match(js, /`enemy:\$\{enemy\.uid\}`/, 'enemies are keyed by their stable uid so each one animates independently');
  assert.match(js, /const signature = `\$\{view\.run_id\}:\$\{view\.floor\}`[\s\S]*dungeonEntityNodes\.clear\(\)/, 'a new run or floor snaps the overlay (no slide across the screen)');
  assert.match(css, /\.dn-entity \{[\s\S]*transition: transform/, 'entity nodes transition their transform (the slide)');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.dn-entity \{ transition: none; \}/, 'the slide respects reduced-motion');
  assert.doesNotMatch(js, /function renderDungeonGrid\(view\)[\s\S]*grid\.replaceChildren\(\.\.\.cells\)/, 'the grid no longer rebuilds entities into cells each render (that was the teleport)');

  // 2. Two-column play body: the map column (.dungeon-stage) takes the 6-share of the row width, the
  //    right rail (.dungeon-side: chat over item region over dock) the 5-share. The map fills its column,
  //    and the conversation panel takes the rail's vertical slack (its log scrolls internally).
  assert.match(css, /\.dungeon-stage \{[\s\S]*flex: 6/, 'the map column takes 6 of the play body');
  assert.match(css, /\.dungeon-side \{[\s\S]*flex: 5/, 'the right rail takes 5 of the play body');
  assert.match(css, /\.dungeon-grid \{[\s\S]*flex: 1/, 'the map fills its column');
  assert.match(css, /\.dungeon-chat \{[\s\S]*flex: 1 1 0/, 'the conversation panel takes the rail vertical slack');

  // 3. Fixed-height conversation log — the dungeon screen is viewport-bounded (so the flex
  //    chain resolves) and the log scrolls inside it instead of growing the page.
  assert.match(css, /body:has\(#academy-dungeon-screen\.active\) \.layout \{[\s\S]*?height: calc\(100dvh - var\(--runtime-topbar-height, 88px\)\);[\s\S]*?padding: 0;[\s\S]*?overflow: hidden;/, 'the dungeon screen is bounded to the viewport like the other play screens, edge-to-edge (padding:0) so the flat obsidian ground fills it with no navy-gradient border inset (direct-background standard)');
  assert.match(css, /\.dungeon-chat-log \{[\s\S]*overflow-y: auto/, 'the conversation log scrolls within its fixed-height panel');

  // 4. IME-safe send — Enter never submits mid-composition; the dungeon input matches the
  //    conversation-session input (shared guard + composing flag + the legacy keyCode 229).
  assert.match(js, /function enterShouldSubmit\(event, composing\)[\s\S]*event\.isComposing \|\| composing \|\| event\.keyCode === 229/, 'a shared Enter guard rejects submits during IME composition');
  assert.match(js, /dungeonTalkInput\.addEventListener\('compositionstart'[\s\S]*dungeonTalkInput\.addEventListener\('compositionend'/, 'the dungeon input tracks IME composition start/end');
  assert.match(js, /dungeonTalkInput\.addEventListener\('keydown'[\s\S]*enterShouldSubmit\(event, dungeonTalkIsComposing\)/, 'the dungeon input gates Enter through the shared IME-safe guard');
  assert.doesNotMatch(js, /addEventListener\('keydown', \(event\) => \{ if \(event\.key === 'Enter'\) \{ event\.preventDefault\(\); dungeonTalk/, 'the old unconditional Enter handler (sent mid-IME) is gone');
});

test('the floor entrance (arrival / retreat point) draws a distinct marker vs the down-stairs', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  // A dedicated up-stairs glyph (＜) mirrors the down-stairs (＞) — the two are distinguishable at a glance.
  assert.match(js, /const DUNGEON_GLYPHS = \{[^}]*stairs: '＞', entrance: '＜'/, 'the entrance has its own up-stairs glyph (＜), the mirror of the down-stairs (＞)');
  // renderDungeonGrid draws the entrance token from view.entrance, in the same explored-only tile pass as the
  // down-stairs (the fog rule is shared: both only render on an explored tile). No image asset — CSS-drawn token.
  assert.match(js, /if \(view\.stairs\.x === x && view\.stairs\.y === y\) \{[\s\S]*?roleClass: 'dn-token--stairs'[\s\S]*?\} else if \(view\.entrance\.x === x && view\.entrance\.y === y\) \{[\s\S]*?roleClass: 'dn-token--entrance', glyph: DUNGEON_GLYPHS\.entrance/, 'the entrance renders its own token from view.entrance in the same explored tile pass as the down-stairs');
  assert.doesNotMatch(js, /roleClass: 'dn-token--entrance'[^}]*imageUrl:/, 'the entrance marker is CSS-drawn (no image asset)');
  // The entrance token reads as the down-stairs counterpart: cool ally hue (not the down-stairs amber), so the two
  // features are color-distinct as well as glyph-distinct. Token-only styling (no literal color pin).
  assert.match(css, /\.dn-token--entrance \{ color: var\(--dungeon-ally\); \}/, 'the entrance token uses the cool ally hue (vs the amber down-stairs)');
  assert.match(css, /\.dn-token--entrance \.dn-token-glyph \{ color: var\(--dungeon-ally\); \}/, 'the entrance glyph carries the ally hue for a clear at-a-glance signal');
});

test('boss-chest equipment: the 持ち帰り popup and run-end result both show acquired equipment (fail-fast meta)', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  // The equipment meta line reuses the shared workshop closed-set label helpers (single source, fail-fast on an
  // out-of-set value) — NO private dungeon equipment label map is introduced.
  assert.match(js, /meta\.textContent = dungeonEquipmentInstanceMetaText\(item\)/, 'equipment rows read their meta via the shared workshop-vocabulary helper (dungeonEquipmentInstanceMetaText)');
  assert.doesNotMatch(js, /(DUNGEON_EQUIPMENT_KIND_LABELS|DUNGEON_EQUIPMENT_QUALITY_LABELS|dungeonEquipmentMetaLabel)/, 'no private dungeon equipment label map or bespoke meta labeler (workshop closed-set labels are the single source)');
  // The hero detail's 獲得予定 section consumes view.equipment_buffer under a 獲得予定装備 heading (throws if
  // the field is missing).
  assert.match(js, /function buildDungeonDetailAcquisition\(view\)[\s\S]*const equipmentBuffer = view\.equipment_buffer;\s*if \(!Array\.isArray\(equipmentBuffer\)\) throw new Error\('dungeon view is missing equipment_buffer'\)[\s\S]*獲得予定装備[\s\S]*buildDungeonEquipmentRows\(equipmentBuffer, 'まだ手に入れた装備はありません。'\)/, 'the 獲得予定 section shows the acquired equipment buffer');
  // The run-end result appends the equipment manifest (手に入れた / 失った装備) beside the materials section.
  assert.match(js, /function buildDungeonResultNodes\(result\)[\s\S]*const equipment = buildDungeonResultEquipment\(result\.equipment\);\s*if \(equipment\) nodes\.push\(equipment\)/, 'the run-end result appends the boss-chest equipment section');
  assert.match(js, /function buildDungeonResultEquipment\(equipment\)[\s\S]*equipment\.retained \? '手に入れた装備' : '失った装備'/, 'the run-end equipment section tones retained vs lost like materials');
  assert.match(js, /function buildDungeonResultEquipment\(equipment\)[\s\S]*if \(!Array\.isArray\(equipment\.items\)\) \{\s*throw new Error/, 'the run-end equipment section fails fast on a non-array manifest');
  // Token-only styling: equipment rows are one-per-line with a muted meta (no literal color pin).
  assert.match(css, /\.dungeon-equipment-grid \{ grid-template-columns: 1fr; \}/, 'equipment rows are single-column so the meta line has room');
  assert.match(css, /\.dungeon-equipment-meta \{ color: var\(--dungeon-ink-dim\)/, 'the equipment meta uses a muted token color');
});

test('elite ("光る個体") enemies read as a distinct glowing token (elite:true → dn-token--elite, token-only, reduced-motion-aware)', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  // The enemy token gains the dn-token--elite role class ONLY when the view marks the enemy elite.
  assert.match(js, /roleClass: `dn-token--enemy\$\{enemy\.elite \? ' dn-token--elite' : ''\}`/, 'an elite enemy token carries the dn-token--elite class');
  // Token-only amber halo (no literal color pin, no new art), and the pulse is gated behind prefers-reduced-motion:
  // no-preference so a reduced-motion user keeps a steady glow.
  assert.match(css, /\.dn-token--elite \{ box-shadow: 0 0 10px var\(--dungeon-glow\), 0 0 5px var\(--dungeon-amber\); \}/, 'the elite token has a token-only amber halo');
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{\s*\.dn-token--elite \{ animation: dn-elite-pulse/, 'the elite pulse runs only when motion is allowed (reduced-motion keeps a steady glow)');
  assert.match(css, /@keyframes dn-elite-pulse \{/, 'the elite pulse keyframes exist');
});

test('composite spells (貫通 / 回避): share the dock action row, rendered fail-fast from the engine-supplied states', async () => {
  const html = await readFile(path.join(publicRoot, 'index.html'), 'utf8');
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  // Markup: 回復・貫通・回避 share the single #dungeon-actions row between the attack spells and the controls hint.
  assert.match(html, /id="dungeon-spells"[\s\S]*id="dungeon-actions"[^>]*aria-label="回復・複合魔法"[\s\S]*dungeon-controls-hint/, 'the #dungeon-actions row sits between #dungeon-spells and the controls hint');
  // Rendered from the engine states with a full fail-fast contract check (like the self-heal), never recomputed.
  assert.match(js, /renderDungeonDock\(view\)[\s\S]*renderDungeonCompositeSpells\(view\)/, 'the dock renders the composite spells row');
  assert.match(js, /function renderDungeonCompositeSpells\(view\)[\s\S]*const pierce = view\.pierce_spell;\s*if \(!pierce\) throw new Error\('dungeon view is missing pierce_spell'\)/, 'pierce is rendered from view.pierce_spell (throws if missing)');
  assert.match(js, /function renderDungeonCompositeSpells\(view\)[\s\S]*const evasion = view\.evasion_spell;\s*if \(!evasion\) throw new Error\('dungeon view is missing evasion_spell'\)/, 'evasion is rendered from view.evasion_spell (throws if missing)');
  assert.match(js, /dungeonDo\(\{ type: pierce\.action_type \}\)/, 'the 貫通 button dispatches pierce_spell');
  assert.match(js, /dungeonDo\(\{ type: evasion\.action_type \}\)/, 'the 回避 button dispatches evasion_spell');
  // The active evasion buff surfaces its remaining turns and gets an is-active marker.
  assert.match(js, /if \(evasion\.active\) evasionButton\.classList\.add\('is-active'\)[\s\S]*残\$\{evasion\.turns_remaining\}/, 'an active evasion shows remaining turns and an is-active class');
  // Token-only styling (no literal color pin): 貫通 dark tint, 回避 wind tint, active ring in amber.
  assert.match(css, /\.dungeon-spell-pierce \{ color: var\(--dungeon-el-dark\); \}/, '貫通 uses the dark element token');
  assert.match(css, /\.dungeon-spell-evasion \{ color: var\(--dungeon-el-wind\); \}/, '回避 uses the wind element token');
  assert.match(css, /\.dungeon-spell-evasion\.is-active \{[\s\S]*var\(--dungeon-amber\)/, 'an active 回避 gets an amber ring');
});
