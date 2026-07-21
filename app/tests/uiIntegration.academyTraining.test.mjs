import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runtimePublicReferenceRoot, runtimeSourceReferenceRoot, projectRoot } from './testPaths.mjs';
import { readUiSource, cssRuleBlock, assertBigframeShell, assertNoCoolOrSoftBorderToken } from './fixtures/uiSource.mjs';

const root = runtimePublicReferenceRoot;
const sourceRoot = runtimeSourceReferenceRoot;
const readFile = readUiSource;

test('academy training cards use symbol-first title-only choices and completed training returns to academy map through loading screen', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  assert.match(html, /6回行動すると学院マップへ戻ります。/, 'academy 鍛錬 help should name 学院マップ as the return screen');
  assert.match(html, /id="academy-loading-screen"[\s\S]*id="academy-loading-starfield"[\s\S]*id="academy-loading-title"[\s\S]*id="academy-loading-status"/, 'training completion should have a dedicated moonlight loading screen with a starfield ambient and destination copy hooks');
  assert.match(js, /const ACADEMY_LOADING_MINIMUM_MS = 1000;/, 'loading screen should enforce an about-one-second minimum display');
  assert.match(js, /const trainingCardImageUrls = \{[\s\S]*artifact_appraisal: '\/canonical\/ui\/card_images\/artifact_appraisal\.jpg'[\s\S]*wind_step: '\/canonical\/ui\/card_images\/wind_step\.jpg'[\s\S]*\}/, 'training cards should use the canonical card_images icon set by matching training id');
  assert.match(js, /const trainingOptions = \[[\s\S]*id: 'artifact_appraisal'[\s\S]*id: 'barrier_weaving'[\s\S]*id: 'broom_flight'[\s\S]*id: 'familiar_bonding'[\s\S]*id: 'potion_brewing'[\s\S]*id: 'rune_calligraphy'[\s\S]*id: 'spirit_listening'[\s\S]*id: 'star_observation'[\s\S]*\]/, 'generated card images that had no existing action should get corresponding new training choices');
  assert.match(js, /cardImage\.className = 'training-card-image'[\s\S]*cardImage\.src = training\.cardImageUrl[\s\S]*button\.append\(cardImage, body\)/, 'academy training cards should render the generated image as the main card visual');
  assert.match(js, /#academy-training-options[\s\S]*createTrainingOptionCard\(training, \{ compact: true \}\)/, 'academy 鍛錬 choices should render compact card-image choices');
  assert.match(js, /function waitForAcademyMapReadiness\(\)[\s\S]*waitForConversationFinalization\(\)/, 'loading should wait on the shared conversation finalization promise before reopening academy routes');
  assert.match(html, /id="academy-loading-title"/, 'loading screen title should be addressable so its destination copy can change per transition');
  assert.match(html, /id="academy-loading-status"/, 'loading screen status should be addressable so its destination copy can change per transition');
  assert.match(js, /function setAcademyLoadingDestinationCopy\(nextScreen, \{ copyKey = null, loadingCopy = null \} = \{\}\)[\s\S]*academy-conversation-session[\s\S]*会話セッションへ移動中[\s\S]*会話の準備を待っています[\s\S]*academy-training[\s\S]*次の一週間が始まります[\s\S]*会話を終えて、次の一週間の鍛錬予定を整えています[\s\S]*academy-map[\s\S]*学院マップへ移動中[\s\S]*会話セッションの整理と学院マップの準備を待っています/, 'loading screen copy should match the destination instead of always saying 学院マップ');
  assert.match(js, /async function showAcademyLoadingScreenUntilReady\(\{ readiness, nextScreen = null, refreshBeforeNextScreen = true, rerollAcademyMap = false, strictFieldRefresh = false, copyKey = null, loadingCopy = null \}\)[\s\S]*?showScreen\('academy-loading'\)[\s\S]*?try \{[\s\S]*?Promise\.all\(\[minimumDisplay, readiness\]\)[\s\S]*?if \(nextScreen != null && refreshBeforeNextScreen\) \{[\s\S]*?await refresh\(\{ strictField: strictFieldRefresh \}\);[\s\S]*?notifyAcademyLoadingProgress\(\);[\s\S]*?\}[\s\S]*?\} catch \(error\) \{[\s\S]*?reportLoadingError\(error\)[\s\S]*?throw error[\s\S]*?\}[\s\S]*?if \(nextScreen == null\) return;[\s\S]*?showScreen\(nextScreen, \{ rerollAcademyMap \}\)/, 'academy loading forwards the academy-map reroll flag, and runs the pre-arrival refresh INSIDE the try (strict field refresh) so a failed refresh reportLoadingErrors + rethrows before ever reaching showScreen(nextScreen) — the destination is not rendered on a stale field; the completed refresh boundary advances the loading constellation');
  assert.match(js, /async function runAssistantSseStream\(\{[\s\S]*onAssistantStreamStart = null[\s\S]*\}\)/, 'SSE helper should accept an entry callback for the moment assistant streaming starts');
  assert.match(js, /function notifyAssistantStreamStarted\(\)[\s\S]*onAssistantStreamStart\?\.\(\)/, 'SSE helper should notify callers exactly when the first assistant stream event arrives');
  assert.match(js, /if \(event === 'assistant_delta'\) \{[\s\S]*notifyAssistantStreamStarted\(\)/, 'assistant deltas should mark the opening stream as ready before the first completed bubble is available');
  // Completed training routes on the response's mode-resolved post_content_screen: routing returns
  // to the hub (interaction), loop keeps the event-aware academy-map loading route. An unexpected
  // screen fail-fasts (no silent default).
  assert.match(js, /async function routeAfterCompletedAcademyTraining\(postContentScreen\)[\s\S]*?postContentScreen === 'interaction'[\s\S]*?await returnToRoutingHubThroughLoadingScreen\(\);[\s\S]*?return;[\s\S]*?postContentScreen !== 'academy-map'[\s\S]*?throw new Error[\s\S]*?setAcademyLoadingDestinationCopy\('academy-map'\)[\s\S]*?showScreen\('academy-loading'\)[\s\S]*?const minimumDisplay = new Promise\(\(resolve\) => setTimeout\(resolve, ACADEMY_LOADING_MINIMUM_MS\)\)[\s\S]*?Promise\.all\(\[minimumDisplay, waitForAcademyMapReadiness\(\)\]\)[\s\S]*?const status = await refreshEventFlagStatus\(\)[\s\S]*?const autoStartFlag = \(status\.pending_events \?\? \[\]\)\.find\(\(flag\) => flag\.interaction\?\.location_id && flag\.character_id\)[\s\S]*?if \(autoStartFlag\) \{[\s\S]*?await startAcademyConversationSessionFromPendingEvent\(autoStartFlag\.id, \{ loadingAlreadyVisible: true \}\)[\s\S]*?return;[\s\S]*?\}[\s\S]*?await refresh\(\)[\s\S]*?showScreen\('academy-map'\)/, 'completed 鍛錬: routing returns to the hub through the loading interstitial, loop holds the loading screen through finalization then branches into a pending event session before the academy map fallback');
  assert.match(js, /async function startAcademyConversationSessionFromPendingEvent\(flagId, \{ loadingAlreadyVisible = false, allowDuringInFlight = false \} = \{\}\) \{[\s\S]*?await startConversationDayFromPendingEvent\(flagId, \{ loadingAlreadyVisible, allowDuringInFlight \}\);[\s\S]*?\n\}/, 'post-training pending events land on the daytime screen: the academy-map event landing delegates to startConversationDayFromPendingEvent (which keeps the loading-until-opening-stream flow and the allowDuringInFlight opt-in)');
  assert.match(js, /if \(result\.training_progress\?\.completed\) \{[\s\S]*await routeAfterCompletedAcademyTraining\(result\.post_content_screen\)[\s\S]*\}/, 'completed academy training should pass the response post_content_screen into the mode-aware return route instead of unconditionally opening the academy map');
  assert.match(js, /async function startEventFlagInteractionFromScreen\(flagId\) \{[\s\S]*?await startConversationDayFromPendingEvent\(flagId\);[\s\S]*?\n\}/, 'manual event starts land on the daytime conversation screen via startConversationDayFromPendingEvent (routing is official — no legacy immediate session start)');
  assert.match(js, /function createTrainingOptionCard\(training, \{ compact = false \} = \{\}\)/, 'training card renderer should support a compact academy-card mode');
  assert.match(js, /if \(!compact\) \{[\s\S]*training-effect-preview[\s\S]*training-weekday-bonus[\s\S]*description[\s\S]*\}/, 'detailed probability/effect text should only be appended outside compact academy cards');
  assert.match(js, /#academy-training-options[\s\S]*createTrainingOptionCard\(training, \{ compact: true \}\)/, 'academy 鍛錬 choices should render compact title-only cards');
  assert.match(html, /id="academy-training-result"[\s\S]*鍛錬状況[\s\S]*訓練可能回数: 残り 6 \/ 6[\s\S]*現在の曜日: 光曜（光）/, 'academy 鍛錬 right panel should use the former result area for remaining training count and current weekday');
  assert.match(js, /function renderAcademyTrainingProgressSummary\(progress = currentTrainingProgress\)[\s\S]*#academy-training-result[\s\S]*訓練可能回数: 残り \${remaining} \/ \${normalizedProgress\.actions_limit}[\s\S]*現在の曜日: \${day\.name}（\${day\.element_label}）/, 'academy 鍛錬 result area should render remaining action count and current weekday instead of effect details');
  assert.match(js, /function renderTrainingProgress\(progress = currentTrainingProgress\)[\s\S]*renderTrainingWeekday\(trainingDayForProgress\(currentTrainingProgress\)\)[\s\S]*renderAcademyTrainingProgressSummary\(currentTrainingProgress\)/, 'academy 鍛錬 progress summary should update whenever training progress changes');
  assert.match(js, /function renderTrainingResult\(result\) \{[\s\S]*document\.querySelectorAll\('#training-result'\)/, 'training result rendering should be limited to the legacy training result area');
  assert.doesNotMatch(js, /function renderTrainingResult\(result\) \{[\s\S]*document\.querySelectorAll\('#training-result, #academy-training-result'\)/, 'academy 鍛錬 should not replace the progress summary with detailed result effects');
  assert.match(js, /result\.training_progress\?\.completed[\s\S]*routeAfterCompletedAcademyTraining\(result\.post_content_screen\)/, 'completed 鍛錬 should route through the mode-aware loading path with the response post_content_screen instead of directly showing the map');
  assert.doesNotMatch(js, /result\.training_progress\?\.completed[\s\S]{0,200}showScreen\('academy-map'\)/, 'completed 鍛錬 must not bypass readiness-gated loading (its branch must route through routeAfterCompletedAcademyTraining, not a direct map call)');
  assert.match(css, /#academy-loading-screen\.active[\s\S]*display:\s*grid/, 'loading screen should render as a full-screen grid while active');
  // Moonlight loading surface (test-by-token): a single static night background (no image rotation) with a
  // silver starfield ambient, and the shell / copy card re-skinned to the meta-night token layer.
  const loadingBackgroundRule = css.match(/\.academy-loading-background\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(loadingBackgroundRule, /background:\s*\n?\s*var\(--meta-load-scrim\),\s*\n?\s*url\('\/canonical\/load\/loading_night\.jpg'\)/, 'loading screen should use canonical/load/loading_night.jpg under the tokenized moonlight scrim');
  assert.match(loadingBackgroundRule, /background-size:\s*cover/, 'loading night background should cover the loading frame');
  assert.doesNotMatch(loadingBackgroundRule, /#[0-9a-fA-F]{3,6}|rgba?\(/, 'loading background must not reintroduce raw color literals');
  // Flat full-screen-direct: the shell fills the screen edge-to-edge — the old bordered / radiused / shadowed
  // window that floated on the body gradient (and its min(1120px) width cap) is gone (いきなり背景 standard).
  const loadingShellRule = css.match(/\.academy-loading-shell\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(loadingShellRule, /width:\s*100%/, 'the flat loading shell should fill the screen width (no centered window cap)');
  assert.match(loadingShellRule, /height:\s*100%/, 'the flat loading shell should fill the screen height');
  assert.doesNotMatch(loadingShellRule, /border:|border-radius:|box-shadow:/, 'the flat loading shell drops the floating-window border / radius / shadow chrome');
  assert.doesNotMatch(loadingShellRule, /min\(1120px/, 'the flat loading shell drops the centered max-width window cap');
  assert.doesNotMatch(loadingShellRule, /#[0-9a-fA-F]{3,6}|rgba?\(/, 'loading shell must not reintroduce raw color literals');
  const loadingCopyRule = css.match(/\.academy-loading-copy\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(loadingCopyRule, /border:\s*1px solid var\(--meta-line-strong\)/, 'loading copy card border should consume the moonlight silver line token');
  assert.match(loadingCopyRule, /background:\s*var\(--meta-panel-strong\)/, 'loading copy card should use the deep-night moonlight panel so the copy reads over the art');
  assert.match(loadingCopyRule, /box-shadow:\s*0 0 0 1px var\(--meta-line\), 0 18px 44px var\(--meta-shadow\), 0 0 18px var\(--meta-glow\)/, 'loading copy card shadow should be the tokenized moonlight glow');
  assert.doesNotMatch(loadingCopyRule, /#[0-9a-fA-F]{3,6}|rgba?\(/, 'loading copy card must not reintroduce raw color literals');
  const loadingHeadingRule = css.match(/\.academy-loading-copy h2\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(loadingHeadingRule, /color:\s*var\(--meta-silver-strong\)/, 'loading title should consume the moonlight silver text token');
  assert.match(loadingHeadingRule, /text-shadow:\s*var\(--shadow-title-heading\)/, 'loading title should reuse the shared heading shadow token');
  assert.doesNotMatch(loadingHeadingRule, /#[0-9a-fA-F]{3,6}/, 'loading title must not hardcode a hex color');
  // The image-rotation mechanism is gone without a trace: no image element / frame / rotation state.
  assert.doesNotMatch(html, /academy-loading-image|academy-loading-image-frame/, 'the loading image element and its frame should be removed with the rotation mechanism');
  assert.doesNotMatch(js, /academyLoadingImageUrls|setAcademyLoadingImage|AcademyLoadingImageRotation|ACADEMY_LOADING_IMAGE_ROTATION/, 'the loading image rotation state and helpers should be removed without a trace');
  // The starfield ambient is the shared conversation-stage part, started/stopped by showScreen on the loading screen.
  assert.match(js, /const academyLoadingStarfield = createStarfieldAmbient\(\{ canvasSelector: '#academy-loading-starfield'/, 'the loading consumer should instantiate the shared starfield ambient over its own canvas');
  assert.match(js, /if \(name === 'academy-loading' && !loaderAlreadyActive\) academyLoadingStarfield\.start\(\)/, 'showScreen should start the loading starfield on a true entry to the loading screen (preserved across a continuous loader handoff)');
  assert.match(js, /if \(name !== 'academy-loading'\) academyLoadingStarfield\.stop\(\)/, 'showScreen should stop the loading starfield when leaving the loading screen');
  // Restrained motion: the copy still eases in on activation, and reduced motion drops the slide-up while keeping the ~3s autohide.
  assert.match(css, /#academy-loading-screen\.active \.academy-loading-copy\s*\{[^}]*animation:\s*academy-loading-copy-rise/, 'the loading copy should ease in on screen activation for a quiet, refined entrance');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*#academy-loading-screen\.active \.academy-loading-copy\s*\{[^}]*animation:\s*academy-loading-copy-autohide[^}]*3000ms[^}]*forwards/, 'reduced motion should keep the copy autohide (opacity fade) without the slide-up entrance');
  assert.match(css, /body:has\(#academy-training-screen\.active\) \.layout\s*\{[\s\S]*height:\s*calc\(100dvh - var\(--runtime-topbar-height, 88px\)\)[\s\S]*padding:\s*0;[\s\S]*overflow:\s*hidden/, 'academy training layout should be bounded by the actual viewport height like the academy map, and edge-to-edge (padding:0) so the flat obsidian screen fills it with no navy-gradient border inset (direct-background standard)');
  assert.match(css, /#academy-training-screen\.active\s*\{[\s\S]*display:\s*grid[\s\S]*height:\s*100%[\s\S]*min-height:\s*0[\s\S]*overflow:\s*hidden/, 'academy training active screen should fill the viewport-bound layout so Discipline Menu height follows screen size');
  assert.doesNotMatch(css, /#academy-training-screen\.active\s*\{[^}]*height:\s*max\(420px, calc\(100dvh/, 'academy training must not keep a 420px floor that prevents Discipline Menu from tracking small viewport heights');
  assert.match(css, /\.academy-training-frame\s*\{[\s\S]*box-sizing:\s*border-box[\s\S]*display:\s*flex[\s\S]*flex-direction:\s*column[\s\S]*height:\s*100%[\s\S]*min-height:\s*0/, 'academy training is a full-screen-direct obsidian frame (flex column: framed stage image then card board), no shell window');
  assert.match(css, /\.academy-training-stage\s*\{[\s\S]*flex:\s*0 0 auto[\s\S]*border:\s*1px solid var\(--training-line\)[\s\S]*border-radius:\s*18px[\s\S]*box-shadow:\s*inset 0 0 0 1px var\(--training-inner-ring\)/, 'the stage image sits in a fixed-height decorated obsidian frame (amber hairline + inner ring), the conversation-day standee-frame grammar');
  assert.match(html, /class="academy-training-panel-heading academy-training-status-heading"[\s\S]*Player Parameters[\s\S]*id="academy-training-status-title">主人公の現在値/, 'academy training player-parameter heading should share the same panel-heading structure as the discipline menu');
  assert.match(css, /\.academy-training-board\s*\{[\s\S]*--academy-training-panel-padding:\s*clamp\(8px, 1\.6dvh, 14px\)[\s\S]*--academy-training-panel-gap:\s*clamp\(5px, 0\.9dvh, 10px\)[\s\S]*flex:\s*1 1 auto[\s\S]*min-height:\s*0/, 'academy training panel padding responds to viewport height; the board fills the remaining frame height below the stage banner');
  assert.match(css, /\.academy-training-menu-panel\s*\{[\s\S]*grid-template-rows:\s*auto minmax\(0, 1fr\)[\s\S]*gap:\s*var\(--academy-training-panel-gap\)/, 'discipline menu should hug its heading (content height) then fill the remaining card board, leaving no dead space below the heading');
  assert.match(css, /\.academy-training-status-panel\s*\{[\s\S]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto[\s\S]*gap:\s*var\(--academy-training-panel-gap\)/, 'player parameters panel should hug its heading then fill the remaining height for parameters');
  assert.match(css, /\.academy-training-menu-panel > \.academy-training-panel-heading,\n\.academy-training-status-panel > \.academy-training-panel-heading\s*\{[\s\S]*align-items:\s*start[\s\S]*font-size:\s*clamp\(11px, 1\.4dvh, 12px\)/, 'both academy training headings should top-align and hug their content height (no fixed reserved height) so no dead space sits below the heading');
  assert.match(css, /\.training-options\.academy-training-options\s*\{[\s\S]*grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\)[\s\S]*grid-template-rows:\s*repeat\(4, minmax\(0, 1fr\)\)[\s\S]*aspect-ratio:\s*5 \/ 4[\s\S]*justify-self:\s*center[\s\S]*overflow:\s*visible/, 'academy training choices should use a centered fixed 5 by 4 square-card board (overflow visible so the top row hover lift is not clipped)');
  assert.match(css, /\.academy-training-options \.training-card-image\s*\{[\s\S]*position:\s*absolute[\s\S]*inset:\s*0[\s\S]*width:\s*100%[\s\S]*height:\s*100%[\s\S]*aspect-ratio:\s*1 \/ 1[\s\S]*object-fit:\s*cover/, 'academy training card images should keep the generated square image ratio while filling the whole card');
  assert.match(css, /\.academy-training-options \.training-option-card\.compact[\s\S]*grid-template-rows:\s*minmax\(0, 1fr\)[\s\S]*aspect-ratio:\s*1 \/ 1[\s\S]*min-height:\s*0[\s\S]*overflow:\s*hidden/, 'compact academy cards should match the square generated-card image ratio without bottom slack');
  assert.match(css, /\.academy-training-options \.training-option-card\s*\{[\s\S]*border-color:\s*var\(--training-line\)[\s\S]*background:\s*var\(--training-card\)/, 'academy training cards should consume the obsidian card border and surface tokens');
  assert.match(css, /\.academy-training-options \.training-option-card\.compact \.training-card-body\s*\{[\s\S]*position:\s*relative[\s\S]*align-self:\s*end[\s\S]*background:\s*var\(--training-caption\)/, 'academy training card titles should overlay the image at the bottom with the tokenized obsidian caption surface rather than reserving blank space below it');
  assert.match(css, /\.academy-training-options \.training-option-card\.compact \.training-icon\s*\{[\s\S]*display:\s*none/, 'academy card-image UI should not keep the old sprite icon as the primary visual');
  assert.doesNotMatch(css, /\.academy-training-options \.training-option-card\.compact::after/, 'academy card-image UI should not add the unwanted bottom-right decorative mark');
  assert.match(css, /\.academy-training-options \.training-option-card\.compact \.training-card-body small,[\s\S]*\.academy-training-options \.training-option-card\.compact \.training-effect-preview,[\s\S]*\.academy-training-options \.training-option-card\.compact \.training-weekday-bonus\s*\{[\s\S]*display:\s*none/, 'compact academy cards should hide explanatory effect/probability text');
});

test('academy 鍛錬 screen is restyled in the obsidian+amber conversation-day visual language over the framed training-ground stage image', async () => {
  const css = await readFile(`${root}/style.css`, 'utf8');

  // Dedicated obsidian+amber token layer (the conversation-day 黒夜 language) declared on .academy-training-screen
  // and consumed by every .academy-training-* rule, so the shared --routing-* / --cd-* / 学院 token layers stay
  // byte-equal. The only literal colors live in that one declaration block (test-by-token).
  const scopeCss = cssRuleBlock(css, '.academy-training-screen');
  assert.match(scopeCss, /--training-bg-0:[\s\S]*--training-ink:[\s\S]*--training-amber:/, 'the 鍛錬 screen declares its own obsidian / ink / amber token layer');
  assert.match(scopeCss, /color:\s*var\(--training-ink\)/, 'the obsidian scope reads its base text off the ink token');
  assert.doesNotMatch(scopeCss, /--errand-|--routing-|--cd-night-/, 'the 鍛錬 token layer does not redefine or borrow the --errand-* / --routing-* / --cd-night-* layers');

  // The stage image is the screen's face: the 昼下がりの鍛錬場 image under a tokenized obsidian veil, no literal pin.
  const stageImageCss = cssRuleBlock(css, '.academy-training-stage-image');
  assert.match(stageImageCss, /url\('\/canonical\/training\/background\.jpg'\)/, 'the stage image paints the canonical training-ground background image');
  assert.match(stageImageCss, /var\(--training-veil-strong\)/, 'the stage image veil consumes a --training-* token (legibility wash, no literal color)');

  // The corner ornaments (conversation-day corner_02 family) hug the stage frame corners over the image.
  const stageCornerCss = cssRuleBlock(css, '.academy-training-stage::before,\n.academy-training-stage::after');
  assert.match(stageCornerCss, /url\('\/canonical\/conversation_day\/ui\/corner_02\.png'\)/, 'the stage frame carries the conversation-day corner_02 ornament over the image (shared 黒夜 corner grammar)');

  // The stage is the fixed-height decorated obsidian banner (amber hairline), no shared map-shell frame tokens,
  // no cool/soft border drift.
  const stageCss = cssRuleBlock(css, '.academy-training-stage');
  assert.match(stageCss, /border:\s*1px solid var\(--training-line\)/, 'the stage frame uses the amber hairline border');
  assert.doesNotMatch(stageCss, /--surface-map-shell|--shadow-map-shell/, 'the stage frame does not consume the shared map-shell frame tokens');
  assertNoCoolOrSoftBorderToken(stageCss, 'training stage frame');

  // The id-scoped [hidden] guard keeps the utility row (the non-render 実践ダンジョン button + shared
  // weekday/progress hooks) hidden under author display rules.
  assert.match(css, /#academy-training-screen \[hidden\] \{\s*\n\s*display: none;/, 'the 鍛錬 screen carries the id-scoped [hidden] guard');

  // The decorative corner aura that only the old training shell carried is gone, matching the quiet obsidian frame.
  assert.doesNotMatch(css, /--surface-map-shell-aura/, 'the training-only corner aura token stays removed');
  assert.doesNotMatch(css, /\.academy-map-shell::before/, 'the corner aura pseudo-element stays removed entirely');

  // The hero is now the VISIBLE title caption overlaid on the veiled stage image (relative + raised), NOT a
  // display:none row. The 実践ダンジョン button + the legacy .training-weekday / .training-progress hooks live in the
  // non-render .academy-training-utility row (the hidden attribute + [hidden] guard), so those shared/legacy classes
  // stay byte-equal rather than being restyled behind a display:none.
  const heroCss = cssRuleBlock(css, '.academy-training-hero');
  assert.match(heroCss, /position:\s*relative[\s\S]*z-index:\s*1/, 'the 鍛錬 hero is the raised caption overlaid on the veiled stage image');
  assert.doesNotMatch(heroCss, /display:\s*none/, 'the 鍛錬 hero is a visible caption now, not a display:none row');

  // Obsidian panels: amber hairline over the translucent obsidian panel surface.
  assert.match(css, /\.academy-training-menu-panel,\s*\.academy-training-status-panel\s*\{[\s\S]*?border:\s*1px solid var\(--training-line\)[\s\S]*?background:\s*var\(--training-panel\)/, 'training panels adopt the amber hairline over the translucent obsidian panel surface');

  // Result summary box is tokenized to the obsidian soft-hairline / compact-panel language.
  const resultCss = cssRuleBlock(css, '.academy-training-result');
  assert.match(resultCss, /border:\s*1px solid var\(--training-line-soft\)/, 'result summary uses the soft obsidian hairline token');
  assert.match(resultCss, /border-radius:\s*var\(--radius-panel-compact\)/, 'result summary keeps the shared compact-panel radius');
  assert.match(resultCss, /background:\s*var\(--training-result\)/, 'result summary uses the obsidian result surface token');

  // Obsidian recolor of the shared training overlays is scoped to the 鍛錬 screen only (the legacy #training-screen
  // overlays keep the shared night rules), and consumes tokens with no literal pin.
  const effectOverlayCss = cssRuleBlock(css, '#academy-training-screen .training-effect-overlay');
  assert.match(effectOverlayCss, /background:\s*var\(--training-effect-bg\)/, 'the 鍛錬 effect burst consumes the obsidian background token, not an inline gradient');
  assert.match(effectOverlayCss, /color:\s*var\(--training-ink-strong\)/, 'the 鍛錬 effect burst recolors to obsidian ink');
  assert.doesNotMatch(effectOverlayCss, /#[0-9a-fA-F]{3,6}|rgba?\(|transparent/, 'the 鍛錬 effect burst override consumes tokens only (no raw color literal or transparent keyword in the rule body)');

  // Restrained entrance: a gentle opacity + rise when the screen activates, disabled under reduced motion.
  assert.match(css, /#academy-training-screen\.active \.academy-training-board\s*\{[\s\S]*animation:\s*academy-training-board-rise\s+\d+ms\s+ease/, 'entering 鍛錬 plays a restrained board entrance');
  assert.match(css, /@keyframes academy-training-board-rise\s*\{[\s\S]*opacity:\s*0[\s\S]*translateY\([\s\S]*opacity:\s*1[\s\S]*transform:\s*none/, 'board entrance is a gentle opacity and upward settle');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*\.academy-training-board\s*\{[\s\S]*animation:\s*none/, 'the board entrance is disabled under reduced motion');
});

test('training mode has full-screen compact rich cards, generated icons, six-action progress, effect guard, reset, and field return wiring', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  assert.match(html, /id="training-progress"/, 'training screen should show the six-action progress');
  assert.match(html, /id="training-weekday"/, 'training screen should show the current six-element weekday turn');
  assert.match(html, /id="training-day-transition"[\s\S]*aria-live="polite"/, 'training screen should include a day-transition animation layer');
  assert.match(html, /id="training-effect-overlay"[\s\S]*aria-live="polite"/, 'training screen should include a polite long effect overlay');
  assert.match(js, /const TRAINING_ACTION_LIMIT = 6;/, 'browser should know the six-action limit');
  assert.match(js, /let trainingEffectInFlight = false;/, 'browser should block repeated training actions while the effect is visible');
  assert.match(js, /let trainingActionInFlight = false;/, 'browser should block repeated training actions for the full click/effect/transition sequence');
  assert.match(js, /trainingCardImageUrls/, 'training cards should map canonical card_images files to training choices');
  assert.match(js, /className = 'training-card-image'/, 'training cards should render a canonical card image element');
  assert.match(js, /renderTrainingProgress/, 'training screen should render action progress');
  assert.match(js, /renderTrainingWeekday/, 'training screen should render the current weekday turn');
  assert.match(js, /weekdayBonusLabel/, 'training cards should explain which weekday doubles the matching elemental effect');
  assert.match(js, /direction === 'decrease'/, 'training results should display the new 50% one-point drawback rows');
  assert.match(js, /triggerTrainingDayTransition/, 'training should show a day-passing animation when the weekday advances');
  assert.match(js, /鍛錬後の自由時間です。学院マップへ遷移します。/, 'training completion copy should use the exact user-specified line');
  // 終了演出 mode-aware completion copy: a mid-week action shows the per-day line (next_day present); the
  // week's final action (no next_day) names the mode's post-training destination on the canonical
  // post_content_screen signal — routing returns to the hub, loop keeps the academy-map line — and a
  // missing/unknown signal fail-fasts instead of silently defaulting to the loop line.
  assert.match(js, /function trainingDayTransitionMessage\(result\) \{[\s\S]*?const nextDay = result\.training_progress\?\.next_day;[\s\S]*?if \(nextDay\) \{[\s\S]*?の訓練が終わり、夜が明けて\$\{nextDay\.name\}へ。[\s\S]*?\}[\s\S]*?const postContentScreen = result\.post_content_screen;[\s\S]*?postContentScreen === 'interaction'[\s\S]*?一週間の鍛錬が終了しました。ハブに戻ります。[\s\S]*?postContentScreen === 'academy-map'[\s\S]*?鍛錬後の自由時間です。学院マップへ遷移します。[\s\S]*?throw new Error\(`training day transition: unexpected post_content_screen \$\{JSON\.stringify\(postContentScreen\)\}`\)/, 'the day-transition copy branches the week-complete line on the canonical post_content_screen (routing hub / loop map) and fail-fasts on a missing/unknown signal');
  assert.match(js, /一週間の鍛錬が終了しました。ハブに戻ります。/, 'routing training completion copy should use the exact user-specified hub-return line');
  assert.match(js, /function triggerTrainingDayTransition\(result\) \{[\s\S]*?const message = trainingDayTransitionMessage\(result\);/, 'the day-transition overlay draws its copy from the mode-aware message helper');
  assert.doesNotMatch(js, /鍛錬が終わり、自由時間になりました。学院マップへと遷移します。/, 'training completion copy should no longer use the previous user wording');
  assert.doesNotMatch(js, /次の行動へ移ります。/, 'training completion copy should no longer use Air\'s generalized wording');
  assert.doesNotMatch(js, /フィールドへ戻ります。/, 'training completion copy should no longer mention returning to the old field flow');
  assert.match(js, /setTimeout\(\(\) => \{[\s\S]*trainingDayTransitionInFlight = false;[\s\S]*\}, 2000\)/, 'weekday transition should last about two seconds');
  assert.match(js, /await triggerTrainingEffect\(result\);[\s\S]*await refreshPrompt\(\);[\s\S]*await triggerTrainingDayTransition\(result\)/, 'weekday transition should wait until the numeric training effect has finished');
  assert.match(js, /triggerTrainingEffect/, 'clicking training should trigger a visible effect');
  assert.match(js, /return new Promise\(\(resolve\) => \{[\s\S]*setTimeout\(\(\) => \{[\s\S]*trainingEffectInFlight = false;[\s\S]*resolve\(\);[\s\S]*1000\)/, 'training click effect should keep the guard active for about one second and resolve only after it ends');
  assert.match(js, /function setTrainingButtonsDisabled\(disabled\)/, 'training buttons should share a central disabled-state helper');
  assert.match(js, /button\.disabled = disabled \|\| trainingActionInFlight \|\| trainingEffectInFlight \|\| trainingDayTransitionInFlight/, 'training buttons should stay disabled across the entire current action sequence');
  assert.match(js, /if \(trainingActionInFlight \|\| trainingEffectInFlight \|\| trainingDayTransitionInFlight\) \{[\s\S]*showProcessingToast\(\);[\s\S]*return;[\s\S]*\}/, 'clicking during the visible effect should not start the next action');
  assert.match(js, /trainingActionInFlight = true;[\s\S]*setTrainingButtonsDisabled\(true\);[\s\S]*const result = await postJson\('\/api\/training\/run'/, 'training clicks should disable the next action before the API request returns');
  assert.match(js, /finally \{[\s\S]*trainingActionInFlight = false;[\s\S]*setTrainingButtonsDisabled\(false\);[\s\S]*\}/, 'training action guard should always clear after the effect\/transition sequence settles');
  assert.match(js, /function resetTrainingResultDisplay\(\)/, 'training result display should have an explicit reset helper');
  assert.match(js, /function showScreen\(name, \{ rerollAcademyMap = false, skipDungeonRefresh = false \} = \{\}\) \{[\s\S]*if \(name !== 'training'\) resetTrainingResultDisplay\(\);/, 'leaving Training should clear the previous training result');
  assert.match(js, /function runTraining\(trainingId\)[\s\S]*if \(result\.training_progress\?\.completed\) \{[\s\S]*routeAfterCompletedAcademyTraining\(result\.post_content_screen\)/, 'sixth action should return through the mode-aware academy loading route with the response post_content_screen');
  assert.match(css, /#training-screen\.active[\s\S]*min-height: calc\(100vh - 140px\)/, 'training screen should be sized as a full-screen panel');
  assert.match(css, /\.training-grid[\s\S]*height: min\(720px, calc\(100vh - 220px\)\)/, 'training grid should fit within the viewport instead of growing indefinitely');
  assert.match(css, /\.training-options[\s\S]*grid-template-columns: repeat\(auto-fit, minmax\(180px, 1fr\)\)/, 'training cards should compact into a responsive grid');
  assert.match(css, /\.training-options[\s\S]*padding-top:\s*14px/, 'training option scroll area should reserve top room so first-row hover lift is not clipped');
  assert.match(css, /\.training-weekday[\s\S]*光曜/, 'training weekday badge should visually name the six-element weekday cycle');
  assert.match(css, /\.training-day-transition\.visible[\s\S]*animation: training-day-passage 2000ms/, 'weekday update should use an about two-second day-passing animation');
  assert.match(css, /@keyframes training-day-passage/, 'training day transition animation keyframes should exist');
  assert.match(css, /@keyframes training-day-passage[\s\S]*0% \{[^}]*blur\(4px\)[^}]*\}[\s\S]*18% \{[^}]*blur\(0\)[^}]*\}[\s\S]*58% \{[^}]*blur\(0\)[^}]*\}[\s\S]*100% \{[^}]*blur\(0\)[^}]*\}/, 'weekday transition should sharpen after the intro and stay sharp through the fade-out');
  assert.match(js, /\/canonical\/ui\/card_images\//, 'training cards should use canonical card image thumbnails');
  assert.match(css, /\.training-card-image[\s\S]*object-fit:\s*cover/, 'training cards should preserve thumbnail crop styling');
  assert.match(css, /\.training-effect-overlay\.visible[\s\S]*animation: training-effect-burst 1000ms/, 'training effect should have a one-second burst animation');
});
