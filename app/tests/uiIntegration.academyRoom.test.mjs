import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runtimePublicReferenceRoot, runtimeSourceReferenceRoot, projectRoot } from './testPaths.mjs';
import { readUiSource, cssRuleBlock, assertBigframeShell, assertNoCoolOrSoftBorderToken } from './fixtures/uiSource.mjs';

const root = runtimePublicReferenceRoot;
const sourceRoot = runtimeSourceReferenceRoot;
const readFile = readUiSource;

test('academy room hub replaces the old status hero, merges money into inventory, and routes load/training through the accepted controls', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  const roomBlock = html.match(/<section id="academy-room-screen"[\s\S]*?<section id="training-screen"/)?.[0] ?? '';
  assert.match(roomBlock, /<p class="eyebrow">My Room<\/p>[\s\S]*<h2 id="academy-room-title">自室<\/h2>[\s\S]*一週間の終わりに主人公の能力、現在のバディー、所持金と所持品を確認できます。/, 'room hero should replace STATUS/ステータス with the requested 自室 copy');
  assert.match(roomBlock, /class="academy-map-status-card academy-room-action-card"[\s\S]*class="academy-room-action-header-row"[\s\S]*class="academy-room-action-copy"[\s\S]*Actions[\s\S]*次の行動を選びます[\s\S]*class="academy-room-week-row"[\s\S]*Current Week[\s\S]*id="academy-room-week"[\s\S]*第1週[\s\S]*id="academy-room-start-training"[\s\S]*次の一週間に進む[\s\S]*id="academy-room-skip-training"[\s\S]*鍛錬をサボる[\s\S]*id="academy-room-open-load"[\s\S]*ロード/, 'former money-card area should become the three-button room action card with left-aligned actions copy and right-aligned current-week summary above the buttons');
  assert.doesNotMatch(roomBlock, /status-money-card|<span>Money<\/span>/, 'room hero should remove the old standalone money card');
  assert.doesNotMatch(roomBlock, /id="academy-room-inventory-title"|<p class="eyebrow">Inventory<\/p>/, 'inventory column should no longer keep the outer Inventory / 所持品 heading');
  assert.match(roomBlock, /academy-room-inventory-stack[\s\S]*academy-room-money-section[\s\S]*<p class="eyebrow">Money<\/p>[\s\S]*<h4>所持金<\/h4>[\s\S]*id="academy-room-money"[\s\S]*academy-room-items-section[\s\S]*<p class="eyebrow">Items<\/p>[\s\S]*<h4>所持品<\/h4>[\s\S]*id="academy-room-item-count"[\s\S]*id="academy-room-inventory-items"/, 'inventory column should read directly as Money / Items subsections');
  assert.doesNotMatch(roomBlock, /現在の所持金/, 'money block should not keep the extra helper label above the amount');

  assert.match(js, /const screens = \{[\s\S]*'academy-room': document\.querySelector\('#academy-room-screen'\)/, 'browser screen registry should add the academy-room screen');
  assert.match(js, /if \(name === 'academy-room'\) renderAcademyRoomScreen\(\);/, 'showScreen should render the room screen when it becomes active');
  assert.match(js, /let slotLoadCanResumePlay = false;/, 'front-end should track whether the current load-screen entry can resume play');
  const openLoadScreenFn = js.match(/async function openLoadScreen\(\{ canResumePlay = false \} = \{\}\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(openLoadScreenFn, '', 'the openLoadScreen function body should be locatable');
  assert.match(openLoadScreenFn, /if \(conversationFinalizationInFlight\) \{[\s\S]*showProcessingToast\(\);[\s\S]*return;[\s\S]*\}[\s\S]*slotLoadCanResumePlay = canResumePlay;[\s\S]*await refreshSaveSlots\(\);[\s\S]*showScreen\('slot-load'\);/, 'load screen entry should explicitly store whether play resume is allowed while preserving finalization blocking');
  assert.match(js, /function canResumeFromSlotLoad\(\) \{[\s\S]*return slotLoadCanResumePlay && Boolean\(currentActiveSlotId\) && !activeSlotIncompatible;[\s\S]*\}/, 'resume button enablement should require an entry context, an active slot, and a compatible (non-degraded) active slot');
  const loadSpecificSlotFn = js.match(/async function loadSpecificSlot\(slotId\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(loadSpecificSlotFn, '', 'the loadSpecificSlot function body should be locatable');
  assert.match(loadSpecificSlotFn, /if \(conversationFinalizationInFlight\) \{[\s\S]*showProcessingToast\(\);[\s\S]*return;[\s\S]*\}[\s\S]*showScreen\('academy-room'\);/, 'actual slot loading should also refuse to race finalization and land on academy-room after success');
  assert.match(js, /async function endConversation[\s\S]*current_screen: 'academy-room'[\s\S]*let transition = endingConversation[\s\S]*next_screen: 'academy-room'[\s\S]*const loadingReadiness = endingConversation \? finalization : Promise\.resolve\(\)[\s\S]*showAcademyLoadingScreenUntilReady\(\{[\s\S]*readiness: loadingReadiness[\s\S]*nextScreen: transition\.next_screen[\s\S]*copyKey: transition\.loading_copy_key/, 'conversation end should open academy-room after the fixed loading delay while keeping graduation completion on the finalization-awaited title transition');
  assert.match(js, /async function openAcademyRoomTraining\(\)[\s\S]*showAcademyLoadingScreenUntilReady\(\{[\s\S]*nextScreen: 'academy-training'[\s\S]*\}\)/, 'room training action should reuse the academy loading flow before academy-training');
  assert.match(js, /async function openAcademyRoomSkipTraining\(\)[\s\S]*postJson\('\/api\/academy\/week\/start', \{\}\)[\s\S]*postJson\('\/api\/training\/skip', \{\}\)[\s\S]*routeAfterCompletedAcademyTraining\(skipped\.post_content_screen\)/, 'room skip action should start the academy week, skip training without parameter gains, and then reuse the completed-training route with the response post_content_screen');
  // Regression guard (loop-room-skip-training-noop): BOTH the graduation and the loop (normal-week)
  // branches of the skip handler must forward the response post_content_screen. The loop branch
  // previously called routeAfterCompletedAcademyTraining() with NO argument, so postContentScreen was
  // undefined and the route fail-fasted ("unexpected post_content_screen undefined"); the rejection hit
  // .catch(reportError) and the loop "鍛錬をサボる" button looked like a silent no-op (no transition).
  const skipFnBody = js.match(/async function openAcademyRoomSkipTraining\(\)[\s\S]*?\n}\n/)?.[0] ?? '';
  assert.notEqual(skipFnBody, '', 'the skip handler body should be locatable for the no-arg-route guard');
  assert.doesNotMatch(skipFnBody, /routeAfterCompletedAcademyTraining\(\)/, 'the skip handler must never call routeAfterCompletedAcademyTraining() with no argument (undefined fail-fasts and makes the loop skip button a silent no-op); always forward skipped.post_content_screen');
  assert.equal((skipFnBody.match(/routeAfterCompletedAcademyTraining\(skipped\.post_content_screen\)/g) ?? []).length, 2, 'both the graduation-ending and the loop normal-week branches of the skip handler should route with skipped.post_content_screen');
  assert.match(js, /#academy-room-start-training[\s\S]*openAcademyRoomTraining\(\)\.catch\(reportError\)/, 'room training button should be wired through the loading-mediated room training helper');
  assert.match(js, /#academy-room-skip-training[\s\S]*openAcademyRoomSkipTraining\(\)\.catch\(reportError\)/, 'room skip button should be wired through the dedicated room skip helper');
  assert.match(js, /#academy-room-open-load[\s\S]*openLoadScreen\(\{ canResumePlay: true \}\)/, 'room load button should open the load screen with play-resume enabled');
  assert.match(js, /if \(tab\.dataset\.screen === 'slot-load'\) \{[\s\S]*openLoadScreen\(\{ canResumePlay: document\.body\.classList\.contains\('play-mode'\) \}\)/, 'topbar load route should pass an explicit play-mode resume context');

  assert.match(css, /body:has\(#academy-room-screen\.active\) \.layout \{[\s\S]*height: calc\(100dvh - var\(--runtime-topbar-height, 88px\)\)[\s\S]*overflow: hidden/, 'room layout should follow viewport height like the academy training screen family');
  assert.match(css, /#academy-room-screen\.active[\s\S]*display: grid[\s\S]*height: 100%[\s\S]*min-height: 0/, 'active room screen should fill the viewport-bound layout');
  assert.match(css, /\.academy-room-shell[\s\S]*grid-template-rows: auto minmax\(0, 1fr\)[\s\S]*height: 100%/, 'room shell should dedicate remaining height to the lower content area');
  assert.match(css, /\.academy-room-grid[\s\S]*grid-template-columns: minmax\(280px, 0\.9fr\) minmax\(320px, 1fr\) minmax\(360px, 1\.08fr\)[\s\S]*minmax\(0, 1fr\)/, 'room lower grid should size columns while keeping the content area height-aware');
  assert.match(css, /\.academy-room-hero[\s\S]*grid-template-columns:[\s\S]*gap:[\s\S]*align-items:/, 'room hero should keep a dedicated balanced two-block header layout');
  // Theme tokens are the source of truth (defined once in :root); the room
  // consumes them via var(). Assert the token definitions AND that the room
  // references them, instead of pinning literal color strings per rule.
  assert.match(css, /:root\b[\s\S]*--surface-bigframe:\s*rgb\(13 18 28\)/, 'theme should define the shared 大枠 outer-frame fill token');
  assert.match(css, /:root\b[\s\S]*--surface-panel:\s*rgb\(var\(--c-ink\) \/ 0\.38\)/, 'theme should define the translucent panel surface token');
  const roomShellCss = cssRuleBlock(css, '.academy-room-shell');
  assertBigframeShell(roomShellCss, 'room shell');
  assertNoCoolOrSoftBorderToken(roomShellCss, 'room shell');
  const roomPanelCss = cssRuleBlock(css, '.academy-room-panel');
  assert.match(roomPanelCss, /border:\s*1px solid var\(--border-warm\)[\s\S]*background:\s*var\(--surface-panel\)/, 'room panels should keep the translucent panel fill while using the same warm-gold border as the outer frame');
  assertNoCoolOrSoftBorderToken(roomPanelCss, 'room panels');
  assert.match(css, /\.academy-room-hero-copy > p:last-child\s*\{[\s\S]*max-width:\s*none[\s\S]*white-space:\s*nowrap/, 'room hero explanation should keep a wider single-line desktop presentation instead of wrapping early');
  assert.match(css, /\.academy-room-action-header-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) auto[\s\S]*align-items:\s*end/, 'room action header should reserve the left side for action copy and the right edge for the current-week summary');
  assert.match(css, /\.academy-room-week-row\s*\{[\s\S]*justify-items:\s*end[\s\S]*text-align:\s*right[\s\S]*gap:\s*6px/, 'current-week summary should right-align its label and week number with room for the two-line stack inside the action header');
  assert.match(css, /\.academy-room-action-card \.academy-room-action-copy > span\s*\{[\s\S]*font-size:\s*20px[\s\S]*font-weight:\s*600[\s\S]*letter-spacing:\s*0\.04em[\s\S]*line-height:\s*1\.1/, 'room action header should enlarge the Actions label relative to the helper copy');
});

test('conversation LM Studio runtime errors redirect only from loading context and stay visible in the conversation session', async () => {
  const html = await readFile(path.join(projectRoot, 'app/public/index.html'), 'utf8');
  const js = await readFile(path.join(projectRoot, 'app/public/app.js'), 'utf8');

  assert.match(html, /id="academy-conversation-session-status"[^>]*aria-live="polite"[^>]*hidden/, 'conversation session should expose a visible live status target for in-session LM Studio errors');
  assert.match(js, /const LM_STUDIO_RUNTIME_ERROR_CODES = new Set\(\[[\s\S]*LMSTUDIO_CONFIG_REQUIRED[\s\S]*LMSTUDIO_CONNECTION_UNAVAILABLE[\s\S]*\]\)/, 'front-end should recognize both config-required and connection-unavailable LM Studio runtime codes');
  assert.match(js, /function handleRuntimeApiError\(error, \{ allowSettingsRedirect = false \} = \{\}\)/, 'runtime error handling should make settings redirection an explicit opt-in');
  assert.match(js, /function reportLoadingError\(error\)[\s\S]*handleRuntimeApiError\(error, \{ allowSettingsRedirect: true \}\)/, 'loading contexts should opt in to the settings redirect for LM Studio runtime errors');
  assert.match(js, /async function showAcademyLoadingScreenUntilReady\([\s\S]*catch \(error\)[\s\S]*reportLoadingError\(error\)[\s\S]*throw error/, 'loading helper should break out of academy-loading by reporting LM Studio runtime errors before rethrowing');
  // Pending-event routes land through the shared daytime landing; its already-visible-loading path opts in to
  // the settings redirect on LM Studio runtime errors (reportLoadingError before rethrow).
  const pendingEventStarter = js.match(/async function startConversationDayFromPendingEvent\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(pendingEventStarter, /if \(loadingAlreadyVisible\) \{[\s\S]*catch \(error\)[\s\S]*reportLoadingError\(error\)[\s\S]*throw error/, 'pending-event routes that reuse an already-visible loading screen should still opt in to the settings redirect on LM Studio runtime errors');
  const reportConversationError = js.match(/function reportConversationError\(error\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(reportConversationError, /setConversationStatus\([\s\S]*tone: 'error'/, 'normal conversation errors should be displayed on the conversation screen');
  assert.doesNotMatch(reportConversationError, /showScreen\('settings'\)/, 'normal conversation errors must not navigate away to settings');
  assert.match(js, /async function runConversation\(\)[\s\S]*catch \(error\)[\s\S]*reportConversationError\(error\)[\s\S]*finally/, 'player-message generation should handle failures in-session before controls are re-enabled');
});

test('character authoring UI becomes read-only when runtime capabilities disable desktop editing', async () => {
  const html = await readFile(path.join(projectRoot, 'app/public/index.html'), 'utf8');
  const js = await readFile(path.join(projectRoot, 'app/public/app.js'), 'utf8');

  assert.match(html, /id="selected-character-source"/, 'character selection header should expose a source/status line for runtime capability messages');
  assert.match(js, /let characterAuthoringCapability = \{\s*enabled: true,\s*reason: null,\s*message: null\s*\};/, 'front-end should track character authoring capability from the runtime');
  assert.match(js, /function characterAuthoringEnabled\(\) \{[\s\S]*characterAuthoringCapability\?\.enabled !== false;[\s\S]*\}/, 'front-end should centralize the authoring-enabled check');
  assert.match(js, /characterAuthoringCapability = result\.capabilities\?\.character_authoring/, 'character refresh should ingest server capability metadata');
  assert.match(js, /selectedCharacterSource\.textContent = authoringEnabled \? '' : characterAuthoringMessage\(\);/, 'field companion panel should explain why editing is disabled on desktop');
  assert.match(js, /description\.readOnly = !authoringEnabled;[\s\S]*speakingBasis\.readOnly = !authoringEnabled;[\s\S]*saveButton\.disabled = !authoringEnabled;/, 'desktop-disabled authoring should set both textareas readOnly and disable save');
  assert.match(js, /async function saveSelectedCharacterDescription\(\) \{[\s\S]*if \(!characterAuthoringEnabled\(\)\) return;/, 'save handler should no-op before issuing a desktop-disallowed write request');
  assert.match(js, /デスクトップ版ではキャラクター説明の編集は無効です。ブラウザ実行で編集してください。/, 'desktop-disabled authoring should surface the explicit browser-only guidance');
});

test('academy conversation-session portraits use a scoped 1.25x center crop and reuse the standee media frame so the face border matches the adjacent standee', async () => {
  const css = await readFile(path.join(projectRoot, 'app/public/style.css'), 'utf8');

  assert.match(css, /#academy-conversation-session-message-stream \.message-face\s*\{[\s\S]*border-radius:\s*var\(--radius-session-media\)[\s\S]*border:\s*var\(--border-session-media\)[\s\S]*background:\s*var\(--surface-session-media\)[\s\S]*box-shadow:\s*var\(--shadow-session-media\)/, 'conversation-session stream face image should reuse the shared session media frame tokens so its border/shadow match the adjacent standee instead of the brighter portrait tokens');
  assert.match(css, /:root\b[\s\S]*--conversation-face-closeup-scale:\s*1\.25;/, 'root CSS should expose the scoped center-crop scale as a named token');
  assert.match(css, /#academy-conversation-session-message-stream \.message-face img\s*\{[\s\S]*object-fit:\s*cover;[\s\S]*transform:\s*scale\(var\(--conversation-face-closeup-scale\)\);[\s\S]*transform-origin:\s*center center;/, 'root CSS should apply a scoped 1.25x center crop to academy conversation-session portraits');
});

test('dungeon companion chat bubble avatar reuses the conversation-session center crop technique and token', async () => {
  const css = await readFile(path.join(projectRoot, 'app/public/style.css'), 'utf8');

  // The dungeon chat bubble-side avatar must show the same source center crop as the academy
  // conversation-session icon. It reuses the same --conversation-face-closeup-scale token rather
  // than a new value, so the two stay in sync. Display size stays the scoped 72px.
  assert.match(css, /\.dungeon-chat-log \.message-face\s*\{[\s\S]*width:\s*72px;[\s\S]*height:\s*72px;/, 'dungeon chat avatar should keep its scoped 72px display size');
  assert.match(css, /\.dungeon-chat-log \.message-face img\s*\{[\s\S]*object-fit:\s*cover;[\s\S]*transform:\s*scale\(var\(--conversation-face-closeup-scale\)\);[\s\S]*transform-origin:\s*center center;/, 'dungeon chat avatar should reuse the same center-crop closeup technique and token as the academy conversation-session portrait');
});

test('routing-hub and daytime chat faces reuse the conversation-session center crop technique and token so the 16-emotion sheet neighbors do not bleed into the frame', async () => {
  const css = await readFile(path.join(projectRoot, 'app/public/style.css'), 'utf8');

  // The routing-hub and daytime bubble-side faces must show the same source center crop as the academy
  // conversation-session icon, reusing the same --conversation-face-closeup-scale token rather than a new
  // value so a single token change moves every screen. Scoped to each stream: the shared .message-face base
  // and the conversation-session/dungeon rules stay byte-equal.
  assert.match(css, /\.routing-hub-message-stream \.message-face img\s*\{[\s\S]*object-fit:\s*cover;[\s\S]*transform:\s*scale\(var\(--conversation-face-closeup-scale\)\);[\s\S]*transform-origin:\s*center center;/, 'routing-hub chat face should reuse the same center-crop closeup technique and token as the academy conversation-session portrait');
  assert.match(css, /\.conversation-day-message-stream \.message-face img\s*\{[\s\S]*object-fit:\s*cover;[\s\S]*transform:\s*scale\(var\(--conversation-face-closeup-scale\)\);[\s\S]*transform-origin:\s*center center;/, 'daytime chat face should reuse the same center-crop closeup technique and token as the academy conversation-session portrait');
});

test('academy conversation-session standee frame matches the stage-image frame language and fills the frame with the image', async () => {
  const css = await readFile(path.join(projectRoot, 'app/public/style.css'), 'utf8');
  const block = cssRuleBlock(css, '#academy-conversation-session-character-standee');

  assert.match(css, /:root\b[\s\S]*--surface-session-media:\s*rgb\(var\(--c-ink\) \/ 0\.58\)/, 'theme should define the shared session media surface token');
  assert.match(css, /:root\b[\s\S]*--border-session-media:\s*1px solid rgb\(var\(--c-gold\) \/ 0\.28\)/, 'theme should define the shared session media border token');
  assert.match(css, /:root\b[\s\S]*--shadow-session-media:\s*inset 0 -42px 72px rgb\(0 0 0 \/ 0\.30\)/, 'theme should define the shared session media inner shadow token');
  assert.match(block, /(?:^|\n)\s*width:\s*100%;/, 'standee frame should span the left-panel frame width');
  assert.match(block, /(?:^|\n)\s*height:\s*clamp\(160px, calc\(100dvh - var\(--runtime-topbar-height, 0px\) - 340px\), 340px\);/, 'standee frame should keep the established responsive height as an actual frame height');
  assert.match(block, /border-radius:\s*var\(--radius-session-media\);/, 'standee should keep the same tokenized corner radius as the stage image');
  assert.match(block, /border:\s*var\(--border-session-media\);/, 'standee should use the same tokenized gold border opacity as the stage image');
  assert.match(block, /background-color:\s*var\(--surface-session-media\);/, 'standee should use the same tokenized dark card surface as the stage image');
  assert.match(block, /box-shadow:\s*var\(--shadow-session-media\);/, 'standee should use the tokenized stage-image inner shadow language');
  assert.match(block, /object-fit:\s*cover;/, 'standee image content should fill the frame instead of sitting inside it');
  assert.match(block, /object-position:\s*50% bottom;/, 'standee image content should remain bottom aligned');
  assert.doesNotMatch(block, /padding:\s*8px;|object-fit:\s*contain;|radial-gradient\(circle at 50% 18%|inset 0 1px 22px|drop-shadow\(/, 'standee frame should not keep inner padding, contain sizing, or the old blue halo / white inner glow / outer drop-shadow frame language');
});

test('new game intro uses scoped loading copy and avoids showing academy map before the mentor intro route', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const html = await readFile(path.join(root, 'index.html'), 'utf8');

  assert.match(html, /id="academy-loading-title">学院マップへ移動中<\//, 'loading screen baseline should still exist in HTML before JS rewrites the copy at runtime');
  assert.match(js, /title:\s*'イントロダクションに進みます'/, 'new-game intro loading title should use the requested wording');
  assert.match(js, /status:\s*'メンター役の生徒があなたをお出迎えしてくれるようです'/, 'new-game intro loading status should use the requested wording');
  assert.match(js, /title:\s*'卒業のときを迎えました'/, 'graduation ending start loading title should use the requested wording');
  assert.match(js, /status:\s*'エンディングセッションに遷移します。'/, 'graduation ending start loading status should use the requested wording');
  assert.match(js, /title:\s*'卒業しました。'/, 'graduation ending completion loading title should use the requested wording');
  assert.match(js, /status:\s*'スタート画面に遷移します。'/, 'graduation ending completion loading status should use the requested wording');
  assert.match(js, /'academy-conversation-session':\s*\{[\s\S]*title:\s*'会話セッションへ移動中'[\s\S]*status:\s*'会話の準備を待っています。'/, 'normal academy conversation-session copy should remain intact for non-intro routes');
  assert.match(js, /async function startNewGame\(\)[\s\S]*await refresh\(\)[\s\S]*await refreshSaveSlots\(\)[\s\S]*document\.body\.classList\.add\('play-mode'\)[\s\S]*if \(await routeNewGameIntroFromTitle\(\)\) return;[\s\S]*showScreen\('academy-map', \{ rerollAcademyMap: true \}\)[\s\S]*await routePendingEventFromAcademyMap\(\)/, 'new game should try the dedicated intro orchestrator before falling back to academy map');
  assert.match(js, /async function routeNewGameIntroFromTitle\(\)[\s\S]*refreshEventFlagStatus\(\)[\s\S]*event\.opening_mentor_intro\.ready[\s\S]*await startConversationDayFromPendingEvent\(introFlag\.id, \{ copyKey: 'new-game-intro' \}\)/, 'new-game intro route lands on the daytime conversation screen with intro-specific loading copy (startConversationDayFromPendingEvent holds academy-loading behind the copyKey)');
  assert.match(js, /async function routeNewGameIntroFromTitle\(\)[\s\S]*if \(!introFlag\) return false;[\s\S]*await startConversationDayFromPendingEvent\(introFlag\.id, \{ copyKey: 'new-game-intro' \}\);[\s\S]*return true;/, 'academy map should only remain as the fallback when the intro event is unavailable');
});

test('in-session stage move plays the cutoff, loads into the destination stage, then reveals the new-stage line in the same session', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  // Move narration/guidance are LLM context, not chat bubbles.
  assert.match(js, /function messagesFromConversation\(conversation\)[\s\S]*\.filter\(\(message\) => message\.role === 'user' \|\| message\.role === 'assistant'\)/, 'displayed messages should drop system (narration/guidance) messages so they never render as chat bubbles');

  // The conversation turn stream opts into the stage-move choreography.
  assert.match(js, /async function runConversationStream\(\{ playerInput, provider, refreshAfter = true \}\)[\s\S]*endpoint: '\/api\/conversation\/stream'[\s\S]*onStageMove: performStageMoveTransition/, 'the conversation turn stream should route stage moves through performStageMoveTransition');

  // On a move result, the stream reveals reply+cutoff but holds the new-stage opening line back.
  assert.match(js, /const stageMove = onStageMove \? \(finalResult\.stage_move \?\? null\) : null;/, 'the assistant stream should read the canonical top-level stage_move from the final result only when a stage-move handler is provided');
  assert.match(js, /if \(stageMove\) \{[\s\S]*surface\.setHistory\(surface\.mapMessages\(finalResult\.conversation\)\.slice\(0, -1\)\);[\s\S]*await onStageMove\(\{ result: finalResult, stageMove \}\);[\s\S]*\} else \{[\s\S]*await finishAssistantSegmentReveal\(\);/, 'on a move the stream should hold the opening line back and defer to the move handler instead of the normal final reveal');

  // The transition: loading screen tuned to the destination, then reveal the opening line in the same session.
  assert.match(js, /async function performStageMoveTransition\(\{ result, stageMove \}\)[\s\S]*showAcademyLoadingScreenUntilReady\(\{[\s\S]*readiness: \(async \(\) => \{ await refresh\(\); notifyAcademyLoadingProgress\(\); \}\)\(\)[\s\S]*nextScreen: 'academy-conversation-session'[\s\S]*loadingCopy: \{[\s\S]*title: `\$\{destinationName\}へ移動中`[\s\S]*await renderConversationResultSequentially\(result\);/, 'a confirmed move should refresh into the destination stage behind the loading screen (advancing the constellation when the refresh boundary completes), return to the session, and reveal the new-stage opening line');

  // No confirmation dialog on a move.
  const moveFn = js.match(/async function performStageMoveTransition\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.doesNotMatch(moveFn, /confirm\(|showModal\(/, 'stage move should not prompt a confirmation dialog');
});

test('academy room training enters graduation loading immediately and waits there only on the 50th graduation week', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  assert.match(js, /const GRADUATION_ENDING_WEEK = 50;/, 'browser graduation week threshold should be fixed at 50 weeks');
  assert.match(js, /function isEnteringGraduationEndingWeek\(\)[\s\S]*elapsed_weeks \?\? 0\) \+ 1 >= GRADUATION_ENDING_WEEK[\s\S]*ending_completed !== true/, 'browser should detect the graduation week from runtime elapsed weeks before starting the next academy week');
  assert.match(js, /function waitForConversationFinalization\(\)[\s\S]*activeConversationFinalizationPromise \?\? Promise\.resolve\(\)/, 'browser should expose the live conversation finalization promise for graduation-week waits');
  assert.match(js, /async function openAcademyRoomTraining\(\)[\s\S]*if \(isEnteringGraduationEndingWeek\(\)\) \{[\s\S]*const readiness = \(async \(\) => \{[\s\S]*await waitForConversationFinalization\(\);[\s\S]*const started = await postJson\('\/api\/academy\/week\/start', \{\}\);[\s\S]*\}\)\(\);[\s\S]*await showAcademyLoadingScreenUntilReady\(\{[\s\S]*readiness,[\s\S]*copyKey:\s*'graduation-ending-start'[\s\S]*\}\);[\s\S]*return;[\s\S]*\}/, 'graduation-week training should show the graduation loading screen immediately, then wait for finalization and week start inside that readiness flow');
  assert.match(js, /const readiness = \(async \(\) => \{[\s\S]*\}\)\(\);[\s\S]*await showAcademyLoadingScreenUntilReady\(\{[\s\S]*readiness,/, 'graduation-week branch should start the readiness task before awaiting the loading screen helper');
});

test('world parameter presets and field character detail action stay inside requested UI surfaces', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const worldBlock = html.match(/<section id="world-screen"[\s\S]*?<section id="field-screen"/)?.[0] ?? '';
  assert.match(worldBlock, /id="magic-parameter-presets"[\s\S]*data-parameter-preset-group="magic" data-parameter-preset-value="0"[\s\S]*data-parameter-preset-group="magic" data-parameter-preset-value="25"[\s\S]*data-parameter-preset-group="magic" data-parameter-preset-value="50"[\s\S]*data-parameter-preset-group="magic" data-parameter-preset-value="75"[\s\S]*data-parameter-preset-group="magic" data-parameter-preset-value="100"/, 'world screen should provide five magic proficiency preset buttons');
  assert.match(worldBlock, /id="ability-parameter-presets"[\s\S]*data-parameter-preset-group="abilities" data-parameter-preset-value="0"[\s\S]*data-parameter-preset-group="abilities" data-parameter-preset-value="25"[\s\S]*data-parameter-preset-group="abilities" data-parameter-preset-value="50"[\s\S]*data-parameter-preset-group="abilities" data-parameter-preset-value="75"[\s\S]*data-parameter-preset-group="abilities" data-parameter-preset-value="100"/, 'world screen should provide five basic-parameter preset buttons');
  const fieldCharacterDialog = html.match(/<dialog id="field-character-detail-dialog"[\s\S]*?<\/dialog>/)?.[0] ?? '';
  assert.match(fieldCharacterDialog, /id="start-field-character-from-detail"[\s\S]*>このキャラと会話する<[\s\S]*aria-label="キャラ詳細を閉じる"/, 'field character detail popup should put conversation start button to the left of close');
});

test('character detail and standee surfaces never fall back to generated face icons', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  const sourceSheetImageUrl = js.match(/function sourceSheetImageUrl\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.doesNotMatch(sourceSheetImageUrl, /view === 'face' \|\| view === 'standee'[\s\S]*character_faces_400/, 'standee view must not share the face-icon URL branch');
  assert.match(sourceSheetImageUrl, /view === 'standee'[\s\S]*characterSceneStandeeUrl/, 'standee view should resolve to the scene/standee artwork path');

  const fallback = js.match(/function fallbackSceneStandeeToFace\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.equal(fallback, '', 'detail/standee images should not have an error fallback that swaps the one-image artwork to a face icon');
  assert.doesNotMatch(js, /addEventListener\('error', fallbackSceneStandeeToFace\)/, 'detail/standee image error handling must not convert one-image surfaces into face icons');
});

test('academy room screen shows player parameters buddy money and a scrollable item list in academy visual style', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  const statusBlock = html.match(/<section id="academy-room-screen"[\s\S]*?<section id="training-screen"/)?.[0] ?? '';
  assert.match(html, /data-screen="academy-training"[\s\S]*>鍛錬<[\s\S]*data-screen="academy-room"[\s\S]*>自室</, 'academy room tab should sit to the right of academy training');
  assert.match(statusBlock, /class="academy-map-shell academy-room-shell"[\s\S]*class="academy-room-hero-copy"[\s\S]*id="academy-room-title">自室<[\s\S]*class="academy-map-status-card academy-room-action-card"[\s\S]*Actions[\s\S]*次の行動を選びます[\s\S]*id="academy-room-start-training"[^>]*class="academy-map-action-button secondary"[\s\S]*id="academy-room-open-load"[^>]*class="academy-map-action-button secondary"/, 'academy room action buttons should keep the balanced header while using the same secondary button contract as the conversation-session buttons');
  assert.match(statusBlock, /class="academy-map-status-card academy-room-action-card"[\s\S]*class="academy-room-action-header-row"[\s\S]*class="academy-room-action-copy"[\s\S]*Actions[\s\S]*次の行動を選びます[\s\S]*class="academy-room-week-row"[\s\S]*id="academy-room-week"[\s\S]*id="academy-room-start-training"[\s\S]*id="academy-room-skip-training"[\s\S]*id="academy-room-open-load"[\s\S]*class="panel-title-row academy-room-player-title-row"[\s\S]*id="academy-room-player-parameters"[^>]*class="academy-training-player-parameters training-player-parameters"[\s\S]*class="academy-room-panel app-card academy-room-relationship-panel"[\s\S]*id="academy-room-buddy-title"[\s\S]*id="academy-room-buddy-card"[\s\S]*id="academy-room-buddy-empty"[\s\S]*id="academy-room-enemy-title"[\s\S]*id="academy-room-enemy-list"[\s\S]*academy-room-money-section[\s\S]*class="panel-title-row academy-room-inventory-subtitle-row academy-room-money-row"[\s\S]*id="academy-room-money"[\s\S]*academy-room-items-section[\s\S]*id="academy-room-inventory-items"/, 'academy room should keep the current-week summary adjacent to the action copy inside the room action card while preserving the shared player-parameter, relationship, and inventory structure');
  assert.doesNotMatch(statusBlock, /id="academy-room-inventory-title"|現在の所持金/, 'academy room inventory should drop the outer inventory heading and the extra money helper label');
  assert.doesNotMatch(statusBlock, /class="academy-room-panel app-card academy-room-buddy-panel"/, 'academy room should not keep a separate narrow buddy panel');
  assert.match(js, /'academy-room': document\.querySelector\('#academy-room-screen'\)/, 'browser should register the academy room screen');
  assert.match(js, /if \(name === 'academy-room'\) renderAcademyRoomScreen\(\)/, 'switching to the academy room tab should render fresh room data');
  assert.match(js, /function renderTrainingPlayerParameters\(parameters = \{\}\) \{[\s\S]*'#training-player-parameters'[\s\S]*'#academy-training-player-parameters'[\s\S]*'#academy-room-player-parameters'[\s\S]*\}/, 'training/player-parameter helper should also render the academy room panel so the room uses the same parameter mechanism as the academy training right pane');
  assert.match(js, /function academyRoomDisplayedWeekNumber\(state = currentRuntimeState\) \{[\s\S]*elapsed_weeks[\s\S]*\+ 1[\s\S]*\}/, 'academy room should derive the play-facing displayed week from currentRuntimeState.elapsed_weeks + 1');
  assert.match(js, /function academyRoomDisplayedWeekLabel\(state = currentRuntimeState\) \{[\s\S]*第\$\{academyRoomDisplayedWeekNumber\(state\)\}週[\s\S]*\}/, 'academy room should format the displayed week as 第N週');
  assert.match(js, /function renderAcademyRoomScreen\(\)[\s\S]*#academy-room-week[\s\S]*academyRoomDisplayedWeekLabel\(currentRuntimeState\)[\s\S]*#academy-room-money[\s\S]*renderTrainingPlayerParameters\(currentWorld\?\.player_parameters \?\? \{\}\)[\s\S]*renderAcademyRoomBuddy\(\)[\s\S]*renderAcademyRoomEnemies\(\)[\s\S]*renderAcademyRoomInventoryItems\(currentInventory\)/, 'academy room render should update the current-week label before filling money, parameters, buddy, enemies, and inventory');
  assert.match(js, /async function refresh\(\{ strictField = false \} = \{\}\) \{[\s\S]*currentRuntimeState = state \?\? currentRuntimeState;[\s\S]*renderTrainingProgress\(currentTrainingProgress\);[\s\S]*if \(screens\['academy-room'\]\?\.classList\.contains\('active'\)\) renderAcademyRoomScreen\(\);/, 'refresh should rerender academy-room after currentRuntimeState updates so the room week display cannot stay stale');
  assert.match(js, /function renderAcademyRoomBuddy\(\)[\s\S]*#academy-room-buddy-card[\s\S]*#academy-room-buddy-empty[\s\S]*selectedAcademyBuddyCharacterId\(\)[\s\S]*selectableCharacters\.find[\s\S]*card\.classList\.add\('is-empty'\)[\s\S]*emptyContainer\.replaceChildren\(\)[\s\S]*card\.replaceChildren\(empty\)/, 'academy room buddy card should collapse into an inline empty state instead of leaving a blank reserved card above the message');
  assert.match(js, /function renderAcademyRoomEnemies\(\)[\s\S]*selectedAcademyEnemyCharacterIds\(\)[\s\S]*#academy-room-enemy-count[\s\S]*#academy-room-enemy-list/, 'academy room enemy list should use the same current-enemy resolver as academy map red pins');
  assert.match(js, /function renderAcademyRoomInventoryItems\(inventory = currentInventory\)[\s\S]*#academy-room-item-count[\s\S]*items\.map[\s\S]*className = 'academy-room-item-row'[\s\S]*item\.stat_effect[\s\S]*use\.textContent = '1個使う';[\s\S]*useInventoryItem\(item\.item_id, 1\)/, 'academy room inventory should render item rows, item count, and a 1個使う button spending one unit for usable items');
  assert.match(js, /function renderAcademyRoomInventoryItems\(inventory = currentInventory\)[\s\S]*useAll\.textContent = '全部使う';[\s\S]*useInventoryItem\(item\.item_id, item\.quantity\)[\s\S]*row\.append\(use, useAll\)/, 'academy room usable items should also carry a 全部使う button that spends the owned quantity in one use');
  // Same "border-box internal scrolling inside the height-aware layout" contract, checked per-rule (ref-ui-tokens
  // bounded-window 流儀) rather than one unbounded ordered scan across the shipped CSS. The three panel selectors
  // share a group rule, which cssRuleBlock cannot extract, so it is matched with a direct anchored regex on the
  // exact group head (ref-ui-tokens: cssRuleBlock returns '' for grouped selectors).
  const roomActiveCss = cssRuleBlock(css, '#academy-room-screen.active');
  assert.notEqual(roomActiveCss, '', 'the #academy-room-screen.active rule should exist');
  assert.match(roomActiveCss, /display:\s*grid[\s\S]*height:\s*100%/, 'active room screen should be a full-height grid');
  const roomGridCss = cssRuleBlock(css, '.academy-room-grid');
  assert.notEqual(roomGridCss, '', 'the .academy-room-grid rule should exist');
  assert.match(roomGridCss, /grid-template-columns:\s*minmax\(280px, 0\.9fr\) minmax\(320px, 1fr\) minmax\(360px, 1\.08fr\)/, 'room grid should size its three columns');
  const roomPanelsGroupRule = css.match(/\.academy-room-player-panel,\n\.academy-room-relationship-panel,\n\.academy-room-inventory-panel\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(roomPanelsGroupRule, '', 'the shared player/relationship/inventory panel group rule should exist');
  assert.match(roomPanelsGroupRule, /box-sizing:\s*border-box[\s\S]*grid-template-rows:\s*auto minmax\(0, 1fr\)/, 'the three room panels should be border-box heading+content grids');
  const roomPlayerParamsCss = cssRuleBlock(css, '#academy-room-player-parameters');
  assert.notEqual(roomPlayerParamsCss, '', 'the #academy-room-player-parameters rule should exist');
  assert.match(roomPlayerParamsCss, /overflow-y:\s*auto/, 'the player parameters region should scroll internally');
  const roomRelationshipListCss = cssRuleBlock(css, '.academy-room-relationship-list');
  assert.notEqual(roomRelationshipListCss, '', 'the .academy-room-relationship-list rule should exist');
  assert.match(roomRelationshipListCss, /overflow-y:\s*auto/, 'the relationship list should scroll internally');
  const roomInventoryItemsCss = cssRuleBlock(css, '.academy-room-inventory-items');
  assert.notEqual(roomInventoryItemsCss, '', 'the .academy-room-inventory-items rule should exist');
  assert.match(roomInventoryItemsCss, /overflow-y:\s*auto[\s\S]*max-height:\s*none/, 'the inventory items region should scroll internally with no max-height cap');
  assert.match(css, /\.academy-room-money-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) auto[\s\S]*align-items:\s*end[\s\S]*gap:\s*10px/, 'academy room money row should become a flat title row instead of a separate inset box');
  assert.match(css, /#academy-room-money\s*\{[\s\S]*justify-self:\s*end[\s\S]*text-align:\s*right[\s\S]*font-size:\s*24px/, 'academy room money amount should be right-aligned text instead of left-aligned content inside an inner card');
  assert.doesNotMatch(css, /\.academy-room-money-block\s*\{/, 'academy room money should no longer keep the old inset money block styling');
  assert.match(css, /\.academy-training-player-parameters\s*\{[\s\S]*min-height:\s*0[\s\S]*overflow:\s*auto/, 'academy room should be able to inherit the same academy-training player-parameter scroll container contract');
  assert.doesNotMatch(css, /#academy-room-player-parameters\s*\{[\s\S]*margin-top:\s*6px|#academy-room-player-parameters \.character-parameter-section\s*\{|#academy-room-player-parameters \.character-parameter-group\s*\{|#academy-room-player-parameters \.character-parameter-item\s*\{/, 'academy room should stop carrying a separate parameter-density override once it reuses the academy-training right-panel mechanism');
  // Same "current-week summary adjacent to the action copy, hero + empty-buddy layout preserved" contract, checked
  // per-rule via cssRuleBlock instead of one unbounded ordered scan across the shipped 550KB CSS (ref-ui-tokens
  // bounded-window 流儀). Each rule is extracted once and its properties asserted inside its own block; the rules
  // are independent non-conflicting selectors, so cross-rule source ordering was never the contract.
  const roomHeroCopyCss = cssRuleBlock(css, '.academy-room-hero-copy');
  assert.notEqual(roomHeroCopyCss, '', 'the .academy-room-hero-copy rule should exist');
  assert.match(roomHeroCopyCss, /max-width:[\s\S]*padding:/, 'room hero copy should keep its max-width + padding layout');
  const roomActionCardCss = cssRuleBlock(css, '.academy-room-action-card');
  assert.notEqual(roomActionCardCss, '', 'the .academy-room-action-card rule should exist');
  assert.match(roomActionCardCss, /align-content:\s*start/, 'the action card should top-align its stacked content');
  const roomActionHeaderRowCss = cssRuleBlock(css, '.academy-room-action-header-row');
  assert.notEqual(roomActionHeaderRowCss, '', 'the .academy-room-action-header-row rule should exist');
  assert.match(roomActionHeaderRowCss, /grid-template-columns:\s*minmax\(0, 1fr\) auto[\s\S]*align-items:\s*end[\s\S]*gap:\s*18px/, 'the action header row should reserve action copy left / week summary right');
  const roomWeekRowCss = cssRuleBlock(css, '.academy-room-week-row');
  assert.notEqual(roomWeekRowCss, '', 'the .academy-room-week-row rule should exist');
  assert.match(roomWeekRowCss, /justify-items:\s*end[\s\S]*text-align:\s*right[\s\S]*gap:\s*6px/, 'the current-week summary should right-align its label and week number');
  const roomActionCopyCss = cssRuleBlock(css, '.academy-room-action-copy');
  assert.notEqual(roomActionCopyCss, '', 'the .academy-room-action-copy rule should exist');
  assert.match(roomActionCopyCss, /justify-items:\s*start[\s\S]*align-content:\s*end/, 'the action copy should sit bottom-left inside the header');
  const roomActionCopySpanCss = cssRuleBlock(css, '.academy-room-action-card .academy-room-action-copy > span');
  assert.notEqual(roomActionCopySpanCss, '', 'the .academy-room-action-card .academy-room-action-copy > span rule should exist');
  assert.match(roomActionCopySpanCss, /font-size:\s*20px[\s\S]*font-weight:\s*600[\s\S]*letter-spacing:\s*0\.04em[\s\S]*line-height:\s*1\.1/, 'the Actions label should be enlarged relative to the helper copy');
  const roomWeekCss = cssRuleBlock(css, '#academy-room-week');
  assert.notEqual(roomWeekCss, '', 'the #academy-room-week rule should exist');
  assert.match(roomWeekCss, /font-size:\s*24px[\s\S]*letter-spacing:\s*0\.04em/, 'the week number should be enlarged');
  const roomEmptyBuddyCss = cssRuleBlock(css, '.academy-room-buddy-card.is-empty');
  assert.notEqual(roomEmptyBuddyCss, '', 'the .academy-room-buddy-card.is-empty rule should exist');
  assert.match(roomEmptyBuddyCss, /min-height:\s*0[\s\S]*padding:\s*0[\s\S]*border:\s*none[\s\S]*background:\s*none/, 'the empty buddy card should collapse to no reserved box');
  const roomEmptyBuddyHelpCss = cssRuleBlock(css, '.academy-room-buddy-card.is-empty .panel-help');
  assert.notEqual(roomEmptyBuddyHelpCss, '', 'the .academy-room-buddy-card.is-empty .panel-help rule should exist');
  assert.match(roomEmptyBuddyHelpCss, /white-space:\s*nowrap/, 'the empty buddy help text should stay on one line');
  // Button consumes shared tokens; the dark-gold conversation-session design
  // is preserved in the --btn-secondary-bg token value (single source).
  assert.match(css, /:root\b[\s\S]*--btn-secondary-bg:[\s\S]*rgb\(var\(--c-cream\) \/ 0\.16\)[\s\S]*rgb\(35 49 77 \/ 0\.82\)/, 'shared button token should keep the dark-gold conversation-session fill');
  const roomActionButtonCss = cssRuleBlock(css, '.academy-room-action-card .academy-map-action-button');
  assert.match(roomActionButtonCss, /width:\s*100%[\s\S]*min-width:\s*126px[\s\S]*max-width:\s*none[\s\S]*padding:\s*10px 13px[\s\S]*border-radius:\s*var\(--radius-pill\)[\s\S]*border:\s*var\(--border-academy-action-button\)[\s\S]*background:\s*var\(--btn-secondary-bg\)[\s\S]*color:\s*var\(--text-strong\)/, 'academy room action buttons should consume the exact shared button chrome while stretching to the room card width');
  assert.doesNotMatch(css, /#academy-room-start-training\.academy-map-action-button\s*\{[\s\S]*(?:border-color|background):/, 'room primary progression button should not override the shared button chrome');
});
