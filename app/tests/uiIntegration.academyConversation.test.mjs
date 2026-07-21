import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runtimePublicReferenceRoot, runtimeSourceReferenceRoot, projectRoot } from './testPaths.mjs';
import { readUiSource, cssRuleBlock, assertBigframeShell, assertNoCoolOrSoftBorderToken } from './fixtures/uiSource.mjs';

const root = runtimePublicReferenceRoot;
const sourceRoot = runtimeSourceReferenceRoot;
const readFile = readUiSource;

test('academy conversation session is a map-styled added conversation screen with standee panel and shared details', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  assert.match(html, /data-screen="academy-map"[\s\S]*>学院マップ<[\s\S]*data-screen="academy-conversation-session"[\s\S]*>会話セッション</, 'conversation session tab should follow the academy map tab directly (the companion tab is gone)');
  assert.doesNotMatch(html, /id="interaction-screen"/, 'the physical interaction screen is removed; conversations run on the session screen');
  assert.match(html, /<section id="field-screen"[\s\S]*<section id="academy-conversation-session-screen"/, 'the conversation session screen follows the field screen once the physical interaction screen is gone');
  const sessionBlock = html.match(/<section id="academy-conversation-session-screen"[\s\S]*?<section id="academy-room-screen"/)?.[0] ?? '';
  assert.match(sessionBlock, /class="academy-map-shell academy-conversation-session-shell"/, 'conversation session should reuse the academy map and companion shell style');
  assert.doesNotMatch(sessionBlock, /<h2 id="academy-conversation-session-title">|確定した舞台と会話相手を見ながら会話します|CONFIRMED STAGE|academy-map-status-card/, 'session should remove the verbose top hero and confirmed-stage card');
  assert.doesNotMatch(sessionBlock, /Conversation Session|CONVERSATION SESSION|academy-conversation-session-header/, 'session should not keep the extra CONVERSATION SESSION label above the panels');
  assert.match(sessionBlock, /class="academy-conversation-session-grid"[\s\S]*class="standee-frame app-card academy-conversation-session-standee-frame"[\s\S]*class="conversation-panel chat-panel app-card academy-conversation-session-chat-panel"/, 'conversation session should keep the interaction two-panel structure inside the academy shell style');
  assert.match(sessionBlock, /class="academy-conversation-session-stage-card"[\s\S]*id="academy-conversation-session-location-image"[\s\S]*id="academy-conversation-session-location-name-button"[^>]*interaction-name-button[^>]*interaction-location-name-button[\s\S]*id="academy-conversation-session-character-standee"[\s\S]*id="academy-conversation-session-character-name-button"/, 'left session panel should integrate stage image and clickable stage name before the character standee/name, with the same name-button style as the character name');
  assert.match(sessionBlock, /id="academy-conversation-session-character-detail-dialog"[\s\S]*id="academy-conversation-session-character-detail-standee"[\s\S]*id="academy-conversation-session-character-parameters"/, 'session character detail should reuse the companion-style standee plus parameters layout');
  assert.doesNotMatch(sessionBlock, /interaction-character-description|character-prompt-description|character-speaking-basis|character-memory-records|character-skill-records|character-work-records/, 'session character detail should not show character description or edit/record surfaces');
  assert.match(sessionBlock, /id="academy-conversation-session-location-detail-dialog" class="interaction-detail-dialog field-location-detail-dialog"[\s\S]*id="academy-conversation-session-location-detail-title"[\s\S]*id="academy-conversation-session-location-detail-image"[\s\S]*id="academy-conversation-session-location-detail-text"/, 'session stage detail should use the wide stage-image dialog layout with the description below it');
  assert.doesNotMatch(sessionBlock, /academy-stage-detail-layout|academy-stage-detail-frame|academy-stage-detail-info/, 'session stage detail should not use the character-detail two-column stage layout');
  assert.doesNotMatch(sessionBlock, /<p class="speaker" id="academy-conversation-session-speaker">/, 'session right chat panel should not show the extra character-name line above messages');
  assert.match(sessionBlock, /id="academy-conversation-session-run-conversation" class="academy-map-action-button secondary"[\s\S]*id="academy-conversation-session-end-conversation" class="academy-map-action-button secondary"/, 'session chat action buttons should use the same academy detail button style');

  assert.match(js, /'academy-conversation-session': document\.querySelector\('#academy-conversation-session-screen'\)/, 'browser should register the new session screen');
  assert.match(js, /function renderAcademyConversationSessionScreen\(\)/, 'browser should render the added session screen separately');
  const conversationEntryFunction = js.match(/async function startAcademyConversationSessionFromCompanion\(characterId\)[\s\S]*?\n}\n\nasync function moveToLocation/)?.[0] ?? '';
  assert.match(conversationEntryFunction, /postJson\('\/api\/interaction\/start'[\s\S]*source_type: 'field'/, 'conversation partner start should still start a field-sourced interaction session');
  assert.match(conversationEntryFunction, /const openingStreamStarted = new Promise\(\(resolve\) => \{[\s\S]*openingStreamStartedResolve = resolve[\s\S]*\}\)/, 'conversation-session entry should create a readiness gate for the LM Studio opening stream start');
  assert.match(conversationEntryFunction, /ensureOpeningUtterance\(\{ characterId, onAssistantStreamStart: markOpeningStreamStarted \}\)/, 'conversation-session entry should start the opening utterance for the chosen actor while loading and observe the first assistant stream event');
  assert.match(conversationEntryFunction, /Promise\.race\(\[openingStreamStarted, openingPromise\]\)/, 'loading should wait for the opening stream to start, or surface an opening failure, rather than waiting for the full first reply');
  assert.match(conversationEntryFunction, /showAcademyLoadingScreenUntilReady\(\{[\s\S]*readiness[\s\S]*nextScreen: 'academy-conversation-session'[\s\S]*refreshBeforeNextScreen: false[\s\S]*\}\)[\s\S]*await openingPromise/, 'conversation partner start should enter the session at stream start and keep controls disabled until the opening reply finishes');
  assert.doesNotMatch(conversationEntryFunction, /await ensureOpeningUtterance\(\)/, 'conversation-session loading should not wait for the full first opening response before switching screens');
  // The happy path enters through the loading helper (nextScreen), never a direct bypass showScreen. The ONLY direct
  // showScreen('academy-conversation-session') is the loading-residual error un-strand in the catch (a non-settings
  // failure still on the loader returns here with the cause on the status line, then re-raises), so assert the
  // pre-catch body has none.
  const conversationEntryBeforeCatch = conversationEntryFunction.split('} catch (error) {')[0];
  assert.doesNotMatch(conversationEntryBeforeCatch, /showScreen\('academy-conversation-session'\)/, 'conversation partner start happy path should not bypass the loading screen (the only direct showScreen is the error un-strand in the catch)');
  assert.match(conversationEntryFunction, /\} catch \(error\) \{[\s\S]*?if \(isAcademyLoadingScreenActive\(\) && settingsRedirectErrorMessage\(error\) == null\) \{[\s\S]*?showScreen\('academy-conversation-session'\);[\s\S]*?setConversationStatus\(errorDisplayMessage\(error\), \{ tone: 'error' \}\);[\s\S]*?\}[\s\S]*?throw error;/, 'a non-settings start failure un-strands to the conversation session (cause on its status line) and RE-RAISES — never swallowed, never stranded on the loading screen');
  assert.match(js, /function startAcademyMapCompanionConversation\(characterId\)[\s\S]*closeAcademyMapCompanionPopup\(\);\s*\n\s*startConversationDay\(characterId\)\.catch\(reportError\);/, 'the map companion popup start action lands the academy-map character conversation on the daytime screen (routing is official — no legacy landing choice)');
  assert.match(js, /function openAcademyConversationSessionLocationDetail\(\)[\s\S]*openInteractionDetailDialog\('#academy-conversation-session-location-detail-dialog'\)/, 'session stage name should open the wide stage detail popup');
  assert.match(js, /function openAcademyConversationSessionCharacterDetail\(\)[\s\S]*openInteractionDetailDialog\('#academy-conversation-session-character-detail-dialog'\)/, 'session character name should open the companion-style character detail popup');
  assert.match(js, /#academy-conversation-session-character-standee[\s\S]*characterSceneStandeeUrl\(selected\)/, 'session right-panel character image should use the full scene standee rather than face icons');
  const sessionRenderFunction = js.match(/function renderAcademyConversationSessionScreen\(\)[\s\S]*?\n}\n/)?.[0] ?? '';
  assert.doesNotMatch(sessionRenderFunction, /sourceSheetImageUrl\(\{[^}]*view: 'face'/, 'session standee panel must not use the face crop resolver');

  assert.match(css, /#academy-conversation-session-screen\.active[\s\S]*display:\s*grid[\s\S]*height:\s*max\(420px, calc\(100dvh - var\(--runtime-topbar-height, 0px\) - 40px\)\)[\s\S]*min-height:\s*0[\s\S]*overflow:\s*visible/, 'session screen should use the measured topbar height instead of hiding overflow behind an artificial bottom band');
  assert.doesNotMatch(css, /body:has\(#academy-conversation-session-screen\.active\)\s*\{[\s\S]*overflow:\s*hidden/, 'session screen must not lock body overflow and mask broken bottom layout');
  assert.match(css, /:root\b[\s\S]*--surface-bigframe:\s*rgb\(13 18 28\)/, 'theme should define the shared 大枠 outer-frame fill token (mid-tone between body and inner panels)');
  assert.match(css, /\.academy-conversation-session-shell\s*\{[\s\S]*box-sizing:\s*border-box[\s\S]*grid-template-rows:\s*minmax\(0, 1fr\)[\s\S]*height:\s*100%[\s\S]*min-height:\s*0[\s\S]*padding:\s*14px[\s\S]*border:\s*1px solid var\(--border-warm\)[\s\S]*border-radius:\s*var\(--radius-frame\)[\s\S]*background:\s*var\(--surface-bigframe\)/, 'session shell should be a large outer frame (shared 大枠 fill + gold border) wrapping the session content');
  assert.match(css, /#academy-conversation-session-player-input\s*\{[\s\S]*resize:\s*none/, 'session player input must not be user-resizable (drag-resize breaks the session layout)');
  assert.match(css, /\.academy-conversation-session-grid\s*\{[\s\S]*--academy-conversation-session-left-width:\s*clamp\(270px, calc\(\(100dvh - var\(--runtime-topbar-height, 0px\) - 96px\) \* 0\.54\), 390px\)[\s\S]*grid-template-columns:\s*var\(--academy-conversation-session-left-width\) minmax\(0, 1fr\)[\s\S]*height:\s*100%/, 'session layout should derive a compact left visual column from the visible image/name stack and give the chat panel the remaining width');
  assert.match(css, /\.academy-conversation-session-stage-card[\s\S]*#academy-conversation-session-location-image\s*\{[\s\S]*width:\s*100%[\s\S]*aspect-ratio:\s*16 \/ 9[\s\S]*background-color:\s*var\(--surface-session-media\)[\s\S]*background-size:\s*contain/, 'session left panel should make the stage image frame tall enough for the full 16:9 image to fit edge-to-edge without vertical cropping');
  assert.match(css, /\.academy-conversation-session-stage-card \.interaction-location-name-button\s*\{[\s\S]*font-size:\s*15px[\s\S]*line-height:\s*1\.45[\s\S]*color:\s*var\(--accent-gold\)[\s\S]*font-weight:\s*700/, 'session left-panel stage name should match the character-name font size, color, and button style');
  assert.match(css, /\.interaction-character-name-button\s*\{[\s\S]*font-size:\s*15px[\s\S]*line-height:\s*1\.45[\s\S]*font-weight:\s*700/, 'session left-panel character name should be bold while keeping the shared name-button sizing');
  assert.match(css, /\.academy-conversation-session-chat-panel\s*\{[\s\S]*display:\s*grid[\s\S]*box-sizing:\s*border-box[\s\S]*grid-template-rows:\s*minmax\(0, 1fr\) auto auto[\s\S]*height:\s*100%/, 'session chat should remove the top speaker row and dedicate the freed space to the message stream without padding overflowing its grid cell');
  assert.match(css, /\.academy-conversation-session-button-row \.academy-map-action-button\s*\{[\s\S]*min-width:\s*126px[\s\S]*padding:\s*10px 13px[\s\S]*border-radius:\s*var\(--radius-pill\)[\s\S]*border:\s*var\(--border-academy-action-button\)[\s\S]*background:\s*var\(--btn-secondary-bg\)[\s\S]*color:\s*var\(--text-strong\)/, 'session send and end buttons should match tokenized academy-map stage-button sizing and pill shape');
  assert.match(css, /\.academy-conversation-session-button-row \.academy-map-action-button::before\s*\{[\s\S]*content:\s*none/, 'session send and end buttons should not show the map-node top marker');
  assert.match(css, /\.academy-conversation-session-standee-frame\s*\{[\s\S]*display:\s*flex[\s\S]*box-sizing:\s*border-box[\s\S]*flex-direction:\s*column[\s\S]*height:\s*100%[\s\S]*padding:\s*18px[\s\S]*overflow:\s*auto/, 'session left panel should use the same card padding as the chat panel while laying out captions sequentially');
  assert.match(css, /#academy-conversation-session-character-standee\s*\{[\s\S]*box-sizing:\s*border-box[\s\S]*display:\s*block[\s\S]*(?:^|\n)\s*width:\s*100%[\s\S]*(?:^|\n)\s*height:\s*clamp\(160px, calc\(100dvh - var\(--runtime-topbar-height, 0px\) - 340px\), 340px\)[\s\S]*border:\s*var\(--border-session-media\)[\s\S]*border-radius:\s*var\(--radius-session-media\)[\s\S]*object-fit:\s*cover[\s\S]*object-position:\s*50% bottom/, 'session left-panel character image should fill the fixed image-card frame with tokenized border and rounded corners');
  assert.match(css, /#academy-conversation-session-location-detail-dialog\s*\{[\s\S]*box-sizing:\s*border-box[\s\S]*width:\s*min\(1240px, 96vw\)[\s\S]*#academy-conversation-session-location-detail-dialog \.interaction-detail-card\s*\{[\s\S]*box-sizing:\s*border-box[\s\S]*#academy-conversation-session-location-detail-image\s*\{[\s\S]*box-sizing:\s*border-box[\s\S]*max-width:\s*100%[\s\S]*\.academy-conversation-session-location-detail-text\s*\{[\s\S]*white-space:\s*normal[\s\S]*overflow-wrap:\s*anywhere/, 'session stage detail should keep the wide stage-image dialog and the image inside the popup, and wrap the longer description instead of forcing one scrolling line');
  const sequentialRenderFunction = js.match(/async function renderConversationResultSequentially\(result\)[\s\S]*?\n}\n/)?.[0] ?? '';
  assert.match(sequentialRenderFunction, /commitConversationResultState\(result\)/, 'sequential reply reveal should commit the canonical raw conversation state after the last segment');
  assert.doesNotMatch(sequentialRenderFunction, /renderMessageStream\(fullMessages\)/, 'sequential reply reveal should not replace the finished DOM at the end because that makes character and narration bubbles jump horizontally');
  const streamingFunction = js.match(/async function runAssistantSseStream\(\{[\s\S]*?\n}\n\nasync function runOpeningConversationStream/)?.[0] ?? '';
  assert.match(streamingFunction, /finishAssistantSegmentReveal\(\)[\s\S]*surface\.commitState\(finalResult\)/, 'streaming reveal should commit canonical state after post-reply processing without replacing visible bubbles');
  assert.doesNotMatch(streamingFunction, /renderConversationResult\(finalResult, \{ revealAssistant: false \}\)/, 'streaming final reconciliation should not replace already-revealed character or narration bubbles when the send controls become available');
  assert.match(js, /function updateViewportMetrics\(\)[\s\S]*--runtime-topbar-height/, 'browser should measure the live wrapped topbar height for conversation-session viewport math');
  assert.match(js, /ResizeObserver[\s\S]*observe\(document\.querySelector\('\.topbar'\)\)/, 'browser should refresh session sizing when the topbar wraps or unwraps during resize');
  assert.match(js, /async function endConversation[\s\S]*clearVisibleConversation\(\);[\s\S]*let transition = endingConversation[\s\S]*next_screen: 'academy-room'[\s\S]*const loadingReadiness = endingConversation \? finalization : Promise\.resolve\(\)[\s\S]*showAcademyLoadingScreenUntilReady\(\{[\s\S]*readiness:\s*loadingReadiness[\s\S]*nextScreen: transition\.next_screen[\s\S]*refreshBeforeNextScreen: false[\s\S]*copyKey: transition\.loading_copy_key[\s\S]*\}\)/, 'ending an academy conversation session should use the fixed loading delay for 自室 while still waiting for finalization before the graduation title route');
  assert.doesNotMatch(js.match(/async function endConversation[\s\S]*?\n}\n/)?.[0] ?? '', /clearVisibleConversation\(\);\s*showScreen\('academy-room'\)/, 'conversation end should not bypass the room loading interstitial');
  assert.match(js, /finalization_status:\s*'running'[\s\S]*current_screen:\s*'academy-room'/, 'conversation-end running state should mirror the 自室 destination');
});

test('legacy training remains separate and academy 鍛錬 is added between conversation session and academy room', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  assert.doesNotMatch(html, /<button data-screen="training"/, 'legacy training tab should stay hidden from the topbar');
  assert.match(html, /data-screen="academy-conversation-session"[\s\S]*>会話セッション<[\s\S]*data-screen="academy-training"[\s\S]*>鍛錬<[\s\S]*data-screen="academy-room"[\s\S]*>自室</, 'new 鍛錬 tab should sit between conversation session and 自室');
  const trainingBlock = html.match(/<section id="training-screen"[\s\S]*?<section id="event-screen"/)?.[0] ?? '';
  const academyTrainingBlock = html.match(/<section id="academy-training-screen"[\s\S]*?<section id="academy-room-screen"/)?.[0] ?? '';
  assert.match(trainingBlock, /id="training-title">トレーニング</, 'existing training screen should keep the training title');
  assert.doesNotMatch(trainingBlock, /academy-map-shell training-shell/, 'existing training screen should not be replaced by the academy 鍛錬 shell');
  assert.match(academyTrainingBlock, /<div class="academy-training-frame">\s*\n\s*<div class="academy-training-stage">\s*\n\s*<div class="academy-training-stage-image" aria-hidden="true">/, 'new 鍛錬 is the obsidian full-screen-direct frame with the framed stage image layer (no shell window)');
  assert.doesNotMatch(academyTrainingBlock, /academy-map-shell|academy-training-shell|academy-training-backdrop/, 'new 鍛錬 drops the old day shell + full-bleed backdrop (no *-shell / backdrop 残骸)');
  assert.match(academyTrainingBlock, /id="academy-training-title"[^>]*>鍛錬<[\s\S]*id="academy-training-weekday"[\s\S]*id="academy-training-progress"/, 'new 鍛錬 keeps its title then the (non-render) weekday/progress hooks');
  assert.match(academyTrainingBlock, /id="academy-training-options"[\s\S]*id="academy-training-player-parameters"[\s\S]*id="academy-training-result"[\s\S]*id="academy-training-effect-overlay"[\s\S]*id="academy-training-day-transition"/, 'new 鍛錬 should have separate behavior hooks and effect overlays');
  assert.match(js, /'academy-training': document\.querySelector\('#academy-training-screen'\)/, 'browser should register the separate academy training screen');
  assert.match(js, /for \(const selector of \['#training-weekday', '#academy-training-weekday'\]/, 'weekday render should update both training surfaces');
  assert.match(js, /setTimeout\(\(\) => \{[\s\S]*overlay\.classList\.remove\('visible'\)[\s\S]*\}, 1000\)/, 'training effect timing should remain one second');
  assert.match(js, /setTimeout\(\(\) => \{[\s\S]*trainingDayTransitionInFlight = false[\s\S]*\}, 2000\)/, 'training day transition timing should remain two seconds');
  assert.match(css, /\.academy-training-frame\s*\{[\s\S]*height:\s*100%[\s\S]*min-height:\s*0/, '鍛錬 frame should occupy the active viewport-bound screen without hard-coding its own height');
  assert.match(css, /\.academy-training-screen\s*\{[\s\S]*--training-bg-0:[\s\S]*--training-panel:[\s\S]*color:\s*var\(--training-ink\)/, '鍛錬 screen should declare its own obsidian token scope and read base text off it');
  assert.match(css, /\.academy-training-stage-image\s*\{[\s\S]*background-image:[\s\S]*var\(--training-veil-strong\)[\s\S]*url\('\/canonical\/training\/background\.jpg'\)/, '鍛錬 stage image should show the afternoon training-ground image under the tokenized obsidian veil');
});

test('academy loading copy window auto-hides ~3s after its entrance lands so the key visual is revealed', async () => {
  const css = await readFile(`${root}/style.css`, 'utf8');

  // The slide-up entrance is preserved, and a second autohide animation runs on the same element.
  const copyActiveRule = css.match(/#academy-loading-screen\.active \.academy-loading-copy\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(copyActiveRule, /animation:[\s\S]*academy-loading-copy-rise 720ms ease both/, 'the slide-up entrance animation must stay unchanged');
  assert.match(copyActiveRule, /animation:[\s\S]*academy-loading-copy-autohide[\s\S]*forwards/, 'the copy window should also run an autohide animation that holds its faded-out end state');
  // Timer origin is the landed window (entrance complete), not screen open: delay = entrance duration + ~3s hold.
  assert.match(copyActiveRule, /academy-loading-copy-autohide[^,]*calc\(720ms \+ 3000ms\)/, 'the autohide delay should be the 720ms entrance plus a ~3s hold so the fade starts ~3s after the window lands, not when the screen opens');
  // The autohide is a gentle opacity fade (not an abrupt display:none) ending fully transparent so the image shows through.
  const autohideKeyframes = css.match(/@keyframes academy-loading-copy-autohide\s*\{[\s\S]*?\}\s*\}/)?.[0] ?? '';
  assert.match(autohideKeyframes, /from\s*\{\s*opacity:\s*1/, 'the autohide should start from the fully visible window');
  assert.match(autohideKeyframes, /to\s*\{\s*opacity:\s*0/, 'the autohide should end fully transparent so the loading key visual is unobscured');
  assert.doesNotMatch(autohideKeyframes, /display:\s*none/, 'the window should fade rather than be cut with display:none');
  // Under reduced motion the slide-up is dropped but the window still fades away (opacity only) after the ~3s hold so the image is still revealed.
  // Anchor on the loading-copy reduced-motion block specifically (the meta screens also carry a decor-drift
  // reduced-motion block), so this does not accidentally capture another reduced-motion media query.
  const reducedMotionLoading = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*(?:\/\*[\s\S]*?\*\/\s*)?#academy-loading-screen\.active \.academy-loading-copy\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(reducedMotionLoading, /#academy-loading-screen\.active \.academy-loading-copy\s*\{[^}]*animation:\s*academy-loading-copy-autohide[^}]*3000ms[^}]*forwards/, 'reduced motion should still fade the window out after a ~3s hold (no entrance offset because there is no slide-up) so the image is revealed');
});
