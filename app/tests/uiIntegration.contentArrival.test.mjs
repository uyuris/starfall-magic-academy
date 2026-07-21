import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runtimePublicReferenceRoot, runtimeSourceReferenceRoot, projectRoot } from './testPaths.mjs';
import { readUiSource, cssRuleBlock, assertBigframeShell, assertNoCoolOrSoftBorderToken } from './fixtures/uiSource.mjs';

const root = runtimePublicReferenceRoot;
const sourceRoot = runtimeSourceReferenceRoot;
const readFile = readUiSource;

// The offer boards (.academy-errand-board / .academy-study-circle-board) are overflow-y:auto
// internal-scroll containers. overflow-y:auto forces overflow-x to compute to auto too, so the board CLIPS its cards
// on every edge — including a card's hover envelope: the card lifts translateY(-4px) and grows a 0 0 0 3px focus ring,
// so its hover top reaches 7px above the resting box. The board padding must clear that envelope, or the TOP-ROW
// card's hover is cut by the scroll edge (the old 2px clipped it — うゆりすさん 2026-07-09 実プレイ). Assert the board
// padding's minimum >= the 7px envelope AND that the card KEEPS its lift (quality: the fix adds room, it does not drop
// the hover lift). Real-render before/after evidence: app/tests/manual/arrivalCardHoverClipRender.mjs.
const HOVER_ENVELOPE_PX = 7; // translateY(-4px) lift + 0 0 0 3px ring
function assertOfferBoardHoverClipClearance(css, boardSelector, cardHoverLiftRegex, label) {
  const boardCss = cssRuleBlock(css, boardSelector);
  const boardPad = boardCss.match(/padding:\s*([^;]+);/)?.[1] ?? '';
  const padMinMatch = boardPad.match(/clamp\(\s*([\d.]+)px/) || boardPad.match(/^\s*([\d.]+)px/);
  const padMinPx = padMinMatch ? Number(padMinMatch[1]) : NaN;
  assert.ok(Number.isFinite(padMinPx) && padMinPx >= HOVER_ENVELOPE_PX,
    `the ${label} board padding (${boardPad || 'missing'}) must clear the card hover envelope (translateY(-4px) lift + 0 0 0 3px ring = ${HOVER_ENVELOPE_PX}px) so the top-row card hover is not clipped by the internal-scroll edge`);
  assert.match(css, cardHoverLiftRegex,
    `the ${label} card keeps its hover lift (translateY(-4px)) — the clip fix adds board padding for clearance, it does NOT drop the hover lift (quality maintained)`);
}

test('errand arrival screen is a dedicated no-tab screen with a week header, an offers list, and no back/skip affordance (index.html + app.js)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  const block = html.match(/<section id="academy-errand-screen"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.notEqual(block, '', 'a dedicated #academy-errand-screen section should exist');
  assert.match(block, /id="academy-errand-title"/, 'the arrival carries a heading');
  assert.match(block, /id="academy-errand-week"/, 'the arrival carries the week counter');
  assert.match(block, /<p id="academy-errand-status"[^>]*aria-live="polite" hidden>/, 'the arrival carries a status live region, hidden by default (error banner only)');
  assert.match(block, /<ul id="academy-errand-offers"/, 'the arrival carries the offers list the cards render into');
  // The 生徒会室 background is the screen's face — shown in a framed stage image (aria-hidden), the
  // conversation-day standee-frame grammar, NOT a shell-window card. The old warm-parchment shell + the
  // light-motes ambient canvas are gone with no residue (destructive replacement, no inert markup).
  assert.match(block, /<div class="academy-errand-stage">\s*\n\s*<div class="academy-errand-stage-image" aria-hidden="true">/, 'the arrival carries the framed 生徒会室 stage image layer');
  assert.doesNotMatch(block, /academy-errand-shell|academy-errand-ambient|academy-errand-motes/, 'the old day shell + light-motes ambient are gone (no *-shell / *-ambient / *-motes 残骸)');
  // The routing dispatch already consumed the week and the conversation end is the only hub return, so the
  // arrival has NO back / skip affordance.
  assert.doesNotMatch(block, /戻る|スキップ|back-to-map|errand-back|errand-skip/i, 'the arrival has no back / skip affordance (the conversation end is the only hub return)');

  // Registered screen + the showScreen fetch hook; no tab (no-tab content screen).
  assert.match(js, /'academy-errand': document\.querySelector\('#academy-errand-screen'\)/, 'academy-errand is a registered screen');
  assert.match(js, /if \(name === 'academy-errand'\) refreshErrandScreen\(\)\.catch\(reportErrandScreenError\);/, 'showScreen fetches this week\'s offers when the errand arrival screen opens');
  assert.doesNotMatch(html, /data-screen="academy-errand"/, 'the errand arrival screen has no tab (no-tab content screen)');

  // Dev entry: ?initialScreen=academy-errand shows the arrival (the offer fetch is routing + save gated, so a
  // save-less reach fail-fasts on the fetch — the same runtime-state requirement as the daytime/routing dev entries).
  assert.match(js, /function requestedInitialAcademyErrand\(\)[\s\S]*?get\('initialScreen'\) === 'academy-errand'/, 'the dev entry reads ?initialScreen=academy-errand');
  assert.match(js, /if \(requestedInitialAcademyErrand\(\)\) \{ showScreen\('academy-errand'\); return; \}/, 'the initial-screen override displays the errand arrival screen');
});

test('errand offer fetch/render + start flow fail-fast, reuse the shared roster face helper, and land on the daytime conversation screen with no bespoke turn/end path (app.js + routingDispatchClient.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const dispatchClient = await readFile(path.join(root, 'routingDispatchClient.js'), 'utf8');

  // The dispatch mirror maps the errand destination to a screen that now EXISTS (before this task the mirror
  // pointed at a screen with no landing).
  assert.match(dispatchClient, /errand: 'academy-errand'/, 'the dispatch mirror maps the errand destination to the academy-errand screen');
  assert.match(js, /'academy-errand': document\.querySelector\('#academy-errand-screen'\)/, 'the errand dispatch destination now reaches a real registered screen');

  // FETCH + RENDER fail-fast: GET /api/errand, exactly three offers, per-offer required fields validated (no
  // silent empty / placeholder cards).
  assert.match(js, /async function refreshErrandScreen\(\)[\s\S]*?getJson\('\/api\/errand'\)[\s\S]*?renderErrandOffers\(offers\)/, 'the arrival fetches the weekly offers over GET /api/errand and renders them');
  // Fail closed + in-flight wait display: the prior offers are cleared and the 生成中 placeholder shown BEFORE the
  // fetch (one replaceChildren swap), so a failed / malformed refetch leaves no stale still-clickable cards (an
  // outdated errand must never remain presentable as valid) and the board is never a blank surface while the
  // weekly offers fetch/generation is in flight.
  assert.match(js, /async function refreshErrandScreen\(\)[\s\S]*?list\.replaceChildren\(buildErrandGeneratingPlaceholder\(\)\);[\s\S]*?getJson\('\/api\/errand'\)/, 'the arrival replaces the board with the generating placeholder BEFORE fetching (fail closed + in-flight wait display)');
  // A failed / malformed fetch clears the waiting card so the error banner is the only surface left — the 生成中
  // display never lingers past a resolution (no stuck wait / silent fallback).
  assert.match(js, /async function refreshErrandScreen\(\)[\s\S]*?catch \(error\) \{[\s\S]*?list\.replaceChildren\(\);[\s\S]*?throw error;/, 'a failed offer fetch clears the generating placeholder and rethrows so the error banner surfaces (wait display never lingers)');
  // End-button dispatch to errand: navigateToPostContentScreen does NOT special-case academy-errand, so it flows
  // through the generic loading interstitial → showScreen('academy-errand') — the same navigation the in-turn
  // performRoutingTurnDispatch uses. Both accepted dispatch entries therefore land on the arrival.
  const navFn = js.match(/async function navigateToPostContentScreen\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(navFn, '', 'navigateToPostContentScreen should exist');
  assert.doesNotMatch(navFn, /academy-errand/, 'academy-errand is not special-cased in navigateToPostContentScreen (end-button dispatch reaches the arrival through the generic loading → showScreen path, like the in-turn dispatch)');
  assert.match(js, /if \(!offers \|\| typeof offers !== 'object'\) \{[\s\S]*?throw new Error/, 'a malformed offers response throws (no silent fallback)');
  assert.match(js, /if \(!Array\.isArray\(errands\) \|\| errands\.length !== ACADEMY_ERRAND_OFFER_COUNT\) \{[\s\S]*?throw new Error/, 'a non-array / wrong-count offer set throws (exactly three offers)');
  assert.match(js, /第\$\{conversationStageWeek\(offers\.week\)\}週/, 'the week header reuses the shared conversationStageWeek (fail-fast on a bad week, no fabricated week)');
  const cardFn = js.match(/function buildErrandCard\(errand\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(cardFn, '', 'buildErrandCard should exist');
  // The card body is the appeal (当人の語り) — situation is no longer read on the card (it stays scene-injection
  // / daytime-scene material). The card validates title / appeal / errand_id fail-fast.
  assert.match(cardFn, /assertErrandOfferString\(errand\.errand_id, 'errand_id'\)[\s\S]*?assertErrandOfferString\(errand\.title, 'title'\)[\s\S]*?assertErrandOfferString\(errand\.appeal, 'appeal'\)/, 'each card validates its required string fields (title / appeal / errand_id) fail-fast');
  assert.doesNotMatch(cardFn, /assertErrandOfferString\(errand\.situation/, 'the errand card no longer reads situation (appeal replaced it as the card body)');
  // 達成条件 is the internal judgment value only: the card does NOT read condition_text and renders no condition
  // element or 達成条件 label — the condition is never shown to the player.
  assert.doesNotMatch(cardFn, /condition_text/, 'the errand card does not read condition_text (internal judgment value, not shown)');
  assert.doesNotMatch(cardFn, /academy-errand-card-condition|達成条件/, 'the errand card renders no 達成条件 element');
  assert.match(cardFn, /button\.append\(client, titleEl, appealEl, footer\)/, 'the card appends client / title / appeal / footer (no condition element)');
  assert.match(cardFn, /assertErrandOfferString\(errand\.client_character_id, 'client_character_id'\)[\s\S]*?assertErrandOfferString\(errand\.client_display_name, 'client_display_name'\)/, 'each card validates the client id + display name fail-fast');
  assert.match(cardFn, /if \(typeof reward !== 'number' \|\| !Number\.isFinite\(reward\) \|\| reward <= 0\) \{[\s\S]*?throw new Error/, 'reward_money must be a positive number (no ?? 0 default)');
  // The reward is rendered as a labeled footer (報酬 label + money chip) so the card reads as header→body→footer
  // — the presentation lift to the study circle card's density. Same data (reward_money only), same amber accent.
  assert.match(cardFn, /footer\.className = 'academy-errand-card-footer'/, 'the card builds a reward footer wrapper');
  assert.match(cardFn, /className = 'academy-errand-card-reward-label';[\s\S]*?textContent = '報酬'/, 'the reward footer carries the 報酬 label');
  assert.match(cardFn, /rewardEl\.textContent = moneyText\(reward\)/, 'the reward chip carries the money amount (moneyText, reward_money only)');

  // FACE: reuse the shared roster face fallback (selection icon → face → source-sheet face); an id absent from
  // the loaded roster is a data desync → throw (no invented face URL convention, no borrowed face).
  assert.match(js, /function errandClientFaceUrl\(characterId\) \{[\s\S]*?selectableCharacters\.find\([\s\S]*?throw new Error[\s\S]*?client\.selection_icon_url \?\? client\.face_url \?\? sourceSheetImageUrl\(\{ characterId, view: 'face' \}\)/, 'the errand card face reuses the shared roster face fallback and fail-fasts on a roster desync');

  // START: POST /api/errand/start (a pre-started conversation in one call, NOT /api/interaction/start),
  // validate conversation/state/client id + the errand display fields (title/situation), bind the actor FROM
  // THE RESPONSE, hold the errand scene, land on the DAYTIME conversation screen THROUGH the shared academy
  // loading screen (the one LM-backed start POST is covered by the interstitial, not awaited in place on the
  // frozen arrival), reveal the opening over the daytime stage surface.
  const startFn = js.match(/async function startErrand\(errandId\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(startFn, '', 'startErrand should exist');
  assert.match(startFn, /postJson\('\/api\/errand\/start', \{ errand_id: errandId \}\)/, 'the card selection starts the errand over POST /api/errand/start');
  assert.doesNotMatch(startFn, /\/api\/interaction\/start/, 'the errand start does NOT use the ordinary interaction-start path (the errand start returns a pre-started conversation)');
  assert.match(startFn, /if \(!result\.conversation \|\| typeof result\.conversation !== 'object'\) \{[\s\S]*?throw new Error/, 'a start response missing the conversation throws');
  assert.match(startFn, /if \(!result\.state \|\| typeof result\.state !== 'object'\) \{[\s\S]*?throw new Error/, 'a start response missing state throws');
  assert.match(startFn, /const errand = result\.errand;[\s\S]*?if \(!errand \|\| typeof errand !== 'object'\) \{[\s\S]*?throw new Error/, 'a start response missing the errand object throws');
  assert.match(startFn, /const clientCharacterId = errand\.client_character_id;[\s\S]*?throw new Error/, 'a start response missing the client id throws');
  // The errand display fields (title / situation) drive the daytime stage frame + detail popup — a missing/empty
  // one is broken state (fail-fast, no placeholder).
  assert.match(startFn, /if \(typeof errand\.title !== 'string' \|\| errand\.title\.trim\(\) === ''\) \{[\s\S]*?throw new Error/, 'a start response errand missing a title throws (errand display field)');
  assert.match(startFn, /if \(typeof errand\.situation !== 'string' \|\| errand\.situation\.trim\(\) === ''\) \{[\s\S]*?throw new Error/, 'a start response errand missing a situation throws (errand display field)');
  assert.doesNotMatch(startFn, /condition_text/, 'the errand start no longer reads/validates condition_text (removed from the public start response)');
  assert.match(startFn, /const errandConversationId = result\.conversation\.id;[\s\S]*?throw new Error/, 'a start response missing the conversation id throws');
  // LOADING-COVERED START: the (session + opening) start POST is one LM-backed call, so the wait is covered by
  // the shared academy loading screen — the readiness block (POST + validation + state mutation) runs behind it,
  // and showAcademyLoadingScreenUntilReady owns the switch to conversation-day only once readiness resolves (no
  // 留まる区間 on the arrival, no bespoke parallel loader).
  assert.match(startFn, /const readiness = \(async \(\) => \{[\s\S]*?postJson\('\/api\/errand\/start', \{ errand_id: errandId \}\)[\s\S]*?\}\)\(\);/, 'the start POST + validation + state mutation run inside a readiness block (covered by the loading screen), not a bare in-place await on the frozen arrival');
  assert.match(startFn, /showAcademyLoadingScreenUntilReady\(\{\s*readiness,\s*nextScreen: 'conversation-day',\s*refreshBeforeNextScreen: false,\s*loadingCopy: \{[\s\S]*?\}\s*\}\)/, 'the loading screen covers the start wait and owns the switch to the daytime screen on resolve (nextScreen: conversation-day, own inline loadingCopy — reuses the shared helper, no new parallel loader)');
  // FAIL-FAST + NO STRANDING: a failed / malformed start rejects inside readiness; the helper reports it
  // (settings-redirect errors go to the settings screen) and rethrows WITHOUT switching, so the loading screen is
  // never terminal. startErrand catches only to un-strand — a non-settings-redirect error returns to the errand
  // arrival (its showScreen re-fetches the offers, so a retry is possible) with the cause on the arrival status
  // line — then RE-RAISES (throw error) so the card click handler's `.catch(reportError)` still logs it once. No
  // swallow, no silent retry, no loading residue. The in-flight/controls reset runs in finally regardless.
  assert.match(startFn, /\} catch \(error\) \{[\s\S]*?if \(settingsRedirectErrorMessage\(error\) == null\) \{[\s\S]*?showScreen\('academy-errand'\);[\s\S]*?setErrandScreenStatus\(errorDisplayMessage\(error\), \{ tone: 'error' \}\);[\s\S]*?\}[\s\S]*?throw error;/, 'a failed start un-strands to the errand arrival (offers re-fetched, cause shown) for non-settings-redirect errors and re-raises — never swallowed, never stranded on the loading screen');
  assert.match(startFn, /\} finally \{[\s\S]*?conversationRequestInFlight = false;/, 'the in-flight/controls state is reset in finally regardless of outcome');
  assert.match(cardFn, /button\.addEventListener\('click', \(\) => startErrand\(errandId\)\.catch\(reportError\)\)/, 'a failed / malformed start still surfaces through the standard reportError path (no silent retry)');
  // SINGLE-FLIGHT: the conversationRequestInFlight guard prevents a second start POST (double card press); the
  // second press hits showProcessingToast and returns, and the synchronous loading-screen switch removes the cards.
  assert.match(startFn, /if \(conversationRequestInFlight\) \{\s*showProcessingToast\(\);\s*return;\s*\}\s*conversationRequestInFlight = true;/, 'a second card press is a no-op (conversationRequestInFlight single-flight — no second start POST)');
  assert.match(startFn, /activeCharacterId = clientCharacterId;/, 'the actor is bound from the response (never a pinned character id)');
  assert.match(startFn, /currentRuntimeState = result\.state;/, 'the post-start state is adopted from the response');
  assert.match(startFn, /clearVisibleConversation\(\);[\s\S]*?conversationDayStage\.surface\.setHistory\(\[\]\);[\s\S]*?showAcademyLoadingScreenUntilReady\(\{[\s\S]*?nextScreen: 'conversation-day'[\s\S]*?renderConversationDayStage\(\);[\s\S]*?revealResultSequentially\(conversationDayStage\.surface, result\)/, 'the errand conversation lands on the daytime conversation screen through the loading screen, paints the 依頼主 standee stage frame, and reveals the opening over the daytime stage surface');
  assert.doesNotMatch(startFn, /'lina'|ROUTING_PERSONA_CHARACTER_ID/, 'the errand actor id is bound from the response, never pinned');
  // The errand scene is held from the response as the single source for the stage frame / detail popup (set
  // after clearVisibleConversation, which drops it in lockstep with the errand id).
  assert.match(startFn, /activeErrandScene = errand;/, 'startErrand holds the errand scene (the start response errand) as the single source for the stage frame / detail popup');
  assert.doesNotMatch(startFn, /academyChatSurface|academy-conversation-session/, 'the errand start no longer touches the shared academy chat surface / v1 session screen (the daytime screen owns its own stage surface)');
  // NO hub / dispatch mechanics: the errand conversation is a plain routing-mode character conversation, so the
  // daytime turn and the existing routing drain-on-exit end path take it from there — the start never touches
  // the routing hub id / dispatch seam (routingTurnRequestBody is the shared turn-body helper the daytime turn
  // uses, not the start).
  assert.doesNotMatch(startFn, /routingHubConversationId|enterRoutingHubConversation|routing_dispatch|performRoutingTurnDispatch|routingTurnRequestBody/, 'the errand start sets no hub id / dispatch seam (plain daytime conversation)');

  // The errand turn carries the ERRAND conversation id (its own id, NOT the routing hub id): the backend
  // routes an active-errand turn through matchingActiveErrandForConversation, which fail-fasts unless the turn
  // carries the errand conversation id. routingTurnRequestBody attaches the hub id when the hub is active and
  // the errand id when an errand is active (mutually exclusive), and omits both otherwise (loop / normal
  // interaction bodies stay byte-equal). startErrand remembers the id; clearVisibleConversation drops it so no
  // stale id leaks into a later turn.
  assert.match(startFn, /activeErrandConversationId = errandConversationId;/, 'startErrand remembers the errand conversation id for the turn body');
  assert.match(js, /function isActiveErrandConversation\(\) \{[\s\S]*?typeof activeErrandConversationId === 'string' && activeErrandConversationId !== ''/, 'the errand-active guard requires a concrete conversation id (never sends id: undefined)');
  assert.match(js, /function routingTurnRequestBody\(extra\) \{[\s\S]*?if \(isRoutingHubActive\(\)\) body\.id = routingHubConversationId;[\s\S]*?else if \(isActiveErrandConversation\(\)\) body\.id = activeErrandConversationId;/, 'the turn body attaches the hub id or the errand id (mutually exclusive), and neither otherwise');
  assert.match(js, /function clearVisibleConversation\(\) \{[\s\S]*?activeErrandConversationId = null;[\s\S]*?activeErrandScene = null;/, 'clearing the visible conversation drops the errand id + scene (no stale errand state leaks into a later conversation)');
  // The existing end path is reused: no bespoke errand end / transition function is introduced. The daytime end
  // button routes an active errand through endRoutingConversation's content-return branch, so the errand
  // completion response (finalization_status 'drained' / transition.next_screen 'interaction' / errand_result)
  // flows through the existing routing drain-on-exit path unchanged.
  assert.doesNotMatch(js, /function (endErrand|finishErrand|navigateAfterErrand|errandPostContent|routeAfterErrand)/, 'no bespoke errand end/transition function — errand completion reuses the existing routing drain-on-exit end path');
  assert.doesNotMatch(js, /function runErrand(Turn|Conversation|Stream)/, 'no bespoke errand turn executor — errand turns reuse the daytime runConversationDayConversation / runConversationDayTurnStream');
});

test('errand daytime stage frame shows the 依頼主 standee and the detail popup shows 依頼の現場 + the errand title/situation, both fail-fast on broken errand scene state (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  // The fixed errand scene location label mirrors the backend server-built scene location_name (依頼の現場),
  // independent of the field's current stage.
  assert.match(js, /const ERRAND_SCENE_LOCATION_NAME = '依頼の現場';/, 'the errand scene location label is the fixed 依頼の現場 (mirrors the backend scene location_name)');

  // Shared resolve + validate for the errand scene: the held start-response errand, fail-fast (no placeholder /
  // other-stage substitution) on a missing scene / display fields (title / situation / client_character_id) /
  // unresolvable client roster character / unresolvable 依頼主 standee.
  const sceneFn = js.match(/function conversationDayErrandResolvedScene\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(sceneFn, '', 'conversationDayErrandResolvedScene should exist');
  assert.match(sceneFn, /if \(!activeErrandScene \|\| typeof activeErrandScene !== 'object'\) \{[\s\S]*?throw new Error/, 'the errand scene resolver fails fast on a missing held scene (no placeholder)');
  assert.match(sceneFn, /if \(typeof title !== 'string' \|\| title\.trim\(\) === ''\) \{[\s\S]*?throw new Error/, 'the errand scene resolver fails fast on a missing/empty title (errand display field)');
  assert.match(sceneFn, /if \(typeof situation !== 'string' \|\| situation\.trim\(\) === ''\) \{[\s\S]*?throw new Error/, 'the errand scene resolver fails fast on a missing/empty situation (errand display field)');
  // condition_text is internal only: the scene resolver does not read or validate it (never shown to the player).
  assert.doesNotMatch(sceneFn, /condition_text|conditionText/, 'the errand scene resolver does not read condition_text (internal judgment value, not shown)');
  assert.match(sceneFn, /if \(typeof clientId !== 'string' \|\| clientId\.trim\(\) === ''\) \{[\s\S]*?throw new Error/, 'the errand scene resolver fails fast on a missing/empty client_character_id (errand display field)');
  assert.match(sceneFn, /const client = selectableCharacters\.find\(\(item\) => item\.character_id === clientId\);[\s\S]*?if \(!client\) \{[\s\S]*?throw new Error/, 'the errand scene resolver fails fast when the 依頼主 is not in the selectable roster (no other-character substitution)');
  assert.match(sceneFn, /const standeeUrl = characterSceneStandeeUrl\(client\);[\s\S]*?if \(!standeeUrl\) \{[\s\S]*?throw new Error/, 'the errand scene resolver reuses the shared standee helper and fails fast on an unresolvable 依頼主 standee (no placeholder)');

  // Stage frame: during an errand the frame shows the 依頼主 standee (not a field stage image), through the
  // shared resolve + validate, and returns before the field-stage branch.
  const stageRenderFn = js.match(/function renderConversationDayStage\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(stageRenderFn, /if \(isActiveErrandConversation\(\)\) \{[\s\S]*?const scene = conversationDayErrandResolvedScene\(\);[\s\S]*?image\.style\.backgroundImage = `url\('\$\{scene\.standeeUrl\}'\)`;[\s\S]*?image\.setAttribute\('aria-label', `\$\{ERRAND_SCENE_LOCATION_NAME\}の詳細を見る`\);[\s\S]*?return;/, 'the errand stage frame paints the 依頼主 standee (not a field stage image) and returns before the field-stage branch');

  // The errand scene 1:1 stage image url is a fixed content-stage constant (依頼の現場 舞台画像), independent of the
  // field's current stage — the detail popup shows this instead of the 依頼主 standee (the standee stays the frame's
  // clickable face).
  assert.match(js, /const ERRAND_SCENE_STAGE_IMAGE_URL = '\/canonical\/errand\/stage\.jpg';/, 'the errand scene 1:1 stage image url is the canonical errand/stage.jpg constant');

  // Detail popup: during an errand it shows 依頼の現場 (title) + the 1:1 errand stage image (errand/stage.jpg, marked
  // data-scene="errand" for the square sizing) + the errand title / situation as text, through the shared resolve +
  // validate, and returns before the field-stage branch. It shows NO 達成条件 (the condition is internal only). The
  // popup resets the scene marker on every open so a prior errand popup never leaks its square sizing onto a later
  // normal / study popup.
  const stagePopupFn = js.match(/function openConversationDayStagePopup\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(stagePopupFn, /delete popup\.dataset\.scene;/, 'the stage popup resets the scene marker on every open (no stale errand sizing leaks onto a later normal / study circle popup)');
  assert.match(stagePopupFn, /if \(isActiveErrandConversation\(\)\) \{[\s\S]*?const scene = conversationDayErrandResolvedScene\(\);[\s\S]*?title\.textContent = ERRAND_SCENE_LOCATION_NAME;[\s\S]*?image\.style\.backgroundImage = `url\('\$\{ERRAND_SCENE_STAGE_IMAGE_URL\}'\)`;[\s\S]*?popup\.dataset\.scene = 'errand';[\s\S]*?text\.textContent = `\$\{scene\.title\}\\n\\n\$\{scene\.situation\}`;[\s\S]*?popup\.hidden = false;[\s\S]*?return;/, 'the errand stage-detail popup shows 依頼の現場 + the 1:1 errand stage image (data-scene="errand") + the errand title/situation (no 達成条件), and returns before the field-stage branch');
  assert.doesNotMatch(stagePopupFn, /達成条件/, 'the errand stage-detail popup shows no 達成条件 (internal judgment value, not shown)');
});

test('errand arrival CSS: dedicated obsidian+amber token layer, framed stage image, viewport-fit + internal scroll, [hidden] guard, token-only cards (style.css)', async () => {
  const css = await readFile(`${root}/style.css`, 'utf8');

  // Dedicated obsidian+amber token layer (the conversation-day 黒夜 language), not borrowed from the alchemy /
  // routing / conversation-day layers.
  const screenCss = cssRuleBlock(css, '.academy-errand-screen');
  assert.match(screenCss, /--errand-bg-0:[\s\S]*--errand-ink:[\s\S]*--errand-amber:/, 'the errand screen defines its own obsidian / ink / amber token layer');
  assert.doesNotMatch(screenCss, /--alchemy-|--routing-|--cd-night-/, 'the errand token layer does not redefine or borrow the --alchemy-* / --routing-* / --cd-night-* layers');
  // The old warm-parchment vocabulary and its light-motes ambient token are gone (destructive replacement).
  assert.doesNotMatch(screenCss, /--errand-parchment|--errand-gold|--errand-sunbeam|--errand-mote-rgb|--errand-hover-glow|--errand-glow/, 'the warm parchment / ambient tokens are gone (no residue)');

  // New 構図: the frame is a 2-column grid (1:1 stage-image column + the offer board column), the stage is a 1:1
  // square sized by the --errand-stage-size token, and a narrow viewport degrades to a single-column vertical stack.
  assert.match(screenCss, /--errand-stage-size:/, 'the errand screen declares the 1:1 stage column size token');
  const frameCss = cssRuleBlock(css, '.academy-errand-frame');
  assert.match(frameCss, /display:\s*grid;/, 'the errand frame is a grid (1:1 stage column + offer board column)');
  assert.match(frameCss, /grid-template-columns:\s*var\(--errand-stage-size\) minmax\(0, 1fr\);/, 'the errand frame places the 1:1 stage column left of the offer board');
  const stageCss = cssRuleBlock(css, '.academy-errand-stage');
  assert.match(stageCss, /aspect-ratio:\s*1 \/ 1;/, 'the errand stage image column is a 1:1 square');
  // Overlap fix (root cause): the stage is box-sizing:border-box, so its padding + border stay INSIDE the
  // --errand-stage-size column instead of spilling ~padding+border px into the neighboring column (the same
  // "stage image overlaps the list" defect fixed on workshop). A content-box stage overflows the column.
  assert.match(stageCss, /box-sizing:\s*border-box;/, 'the errand stage is border-box so its padding/border stay within the stage column (no spill into the neighbor — the overlap fix)');
  assert.match(css, /@media \(max-width: 720px\) \{\s*\n\s*\.academy-errand-frame \{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/, 'a narrow viewport degrades the errand frame to a single-column vertical stack');

  // The background image is the screen's face — a framed stage image (token-veiled), corner ornaments over it.
  const stageImageCss = cssRuleBlock(css, '.academy-errand-stage-image');
  assert.notEqual(stageImageCss, '', 'the .academy-errand-stage-image rule should exist');
  assert.match(stageImageCss, /url\('\/canonical\/errand\/stage\.jpg'\)/, 'the stage image paints the new 1:1 canonical errand stage image');
  assert.match(stageImageCss, /var\(--errand-veil-strong\)/, 'the stage image veil consumes an --errand-* token (legibility wash, no literal color)');
  // The corner ornaments (conversation-day corner_02 family) hug the stage frame corners over the image.
  const stageBeforeCss = cssRuleBlock(css, '.academy-errand-stage::before,\n.academy-errand-stage::after');
  assert.match(stageBeforeCss, /url\('\/canonical\/conversation_day\/ui\/corner_02\.png'\)/, 'the stage frame carries the conversation-day corner_02 ornament over the image (shared 黒夜 corner grammar)');

  // The id-scoped [hidden] guard (keeps the status live region hidden under an author display rule).
  assert.match(css, /#academy-errand-screen \[hidden\] \{\s*\n\s*display: none;/, 'the errand screen carries the id-scoped [hidden] guard');

  // Viewport-fit + internal-scroll (the play-screen height constraint pattern), the offers board owns the scroll.
  assert.match(css, /body:has\(#academy-errand-screen\.active\) \.layout \{[\s\S]*?height: calc\(100dvh - var\(--runtime-topbar-height, 88px\)\);[\s\S]*?overflow: hidden;/, 'the errand layout uses the play-screen viewport-height constraint so the card board scroll resolves');
  // Direct-background (いきなり背景) standard: the layout has NO padding, so the flat obsidian screen fills it
  // edge-to-edge with no inset that would reveal the body's navy gradient as a border — no window-on-a-gradient
  // reading (the conversation-day daytime / workshop screens use the same padding:0).
  assert.match(css, /body:has\(#academy-errand-screen\.active\) \.layout \{[\s\S]*?padding: 0;[\s\S]*?\}/, 'the errand layout has padding:0 so the flat background fills the screen edge-to-edge (no gradient border / floating window)');
  const boardCss = cssRuleBlock(css, '.academy-errand-board');
  assert.match(boardCss, /min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/, 'the errand offers board owns the internal scroll (fixed-height absorb, no page growth)');
  assertOfferBoardHoverClipClearance(css, '.academy-errand-board',
    /\.academy-errand-card-button:hover,\s*\n\.academy-errand-card-button:focus-visible \{[\s\S]*?transform:\s*translateY\(-4px\);/, 'errand');

  // Test-by-token: the card consumes var(--errand-*) / the shared radius tokens with no literal color pin.
  const cardCss = cssRuleBlock(css, '.academy-errand-card-button');
  assert.match(cardCss, /background:\s*var\(--errand-card\);/, 'the card background consumes the errand card token');
  assert.match(cardCss, /border-radius:\s*var\(--radius-card\);/, 'the card consumes the shared card radius token');
  assert.doesNotMatch(cardCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the card rule has no literal color pin (token-only)');

  // Card is a flex column so the reward footer can anchor to the bottom edge (fills the card height so a short
  // offer reads as header→body→footer instead of trailing off into empty space — the density lift that brings
  // the errand card up to the study circle card's finish).
  assert.match(cardCss, /display:\s*flex;[\s\S]*?flex-direction:\s*column;/, 'the card button is a flex column (so the reward footer anchors to the bottom edge)');
  const footerCss = cssRuleBlock(css, '.academy-errand-card-footer');
  assert.notEqual(footerCss, '', 'the .academy-errand-card-footer rule should exist');
  assert.match(footerCss, /margin-top:\s*auto;/, 'the reward footer anchors to the card bottom (fills the card height)');
  assert.match(footerCss, /border-top:\s*1px solid var\(--errand-line\);/, 'the reward footer marks the payoff off from the body with a token hairline divider');
  assert.doesNotMatch(footerCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the reward footer rule has no literal color pin (token-only)');
  const rewardCss = cssRuleBlock(css, '.academy-errand-card-reward');
  assert.match(rewardCss, /background:\s*var\(--errand-amber-soft\);/, 'the reward chip consumes the errand amber token (the amber accent is kept — not shifted toward the study circle indigo)');
  assert.doesNotMatch(rewardCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the reward chip rule has no literal color pin (token-only)');

  // Typography parity with the study circle card (うゆりすさん 2026-07-10 実プレイ: the errand card was too large; the
  // study circle card is the 見やすい reference — match it). Each errand element's font-size / line-height is asserted
  // EQUAL to its study circle counterpart in the same style.css, so moving only ONE side fails (the parity is the
  // contract, not a free-standing number). The study circle side is the baseline and must not be touched.
  const fontSizeOf = (block) => block.match(/font-size:\s*([^;]+);/)?.[1]?.trim() ?? null;
  const lineHeightOf = (block) => block.match(/line-height:\s*([^;]+);/)?.[1]?.trim() ?? null;

  // title ↔ study circle card title (1.1rem / 700 / ink-strong).
  const titleCss = cssRuleBlock(css, '.academy-errand-card-title');
  const scTitleCss = cssRuleBlock(css, '.academy-study-circle-card-title');
  assert.equal(fontSizeOf(titleCss), fontSizeOf(scTitleCss), 'the errand card title font-size matches the study circle card title');
  assert.equal(fontSizeOf(titleCss), '1.1rem', 'the errand card title is the study circle baseline size (1.1rem)');

  // appeal body ↔ study circle card situation (no explicit font-size = inherits ~1rem body, 1.5 line-height, dim ink).
  const appealCss = cssRuleBlock(css, '.academy-errand-card-situation');
  const scAppealCss = cssRuleBlock(css, '.academy-study-circle-card-situation');
  assert.equal(fontSizeOf(appealCss), fontSizeOf(scAppealCss), 'the errand appeal body font-size matches the study circle appeal (both unset — inherits the body size)');
  assert.equal(fontSizeOf(appealCss), null, 'the errand appeal body carries no enlarged font-size pin (matches the study circle baseline — inherits ~1rem)');
  assert.equal(lineHeightOf(appealCss), lineHeightOf(scAppealCss), 'the errand appeal line-height matches the study circle appeal');
  assert.equal(lineHeightOf(appealCss), '1.5', 'the errand appeal reads at the study circle baseline line-height (1.5)');
  assert.match(appealCss, /color:\s*var\(--errand-ink-dim\);/, 'the errand appeal body reads at the dim label ink (the study circle appeal role — token-only)');

  // The 達成条件 element is gone from both cards (the condition is the internal judgment value, never shown), so the
  // per-card condition rules no longer exist — no orphaned .academy-*-card-condition* CSS残骸.
  assert.doesNotMatch(css, /academy-errand-card-condition|academy-study-circle-card-condition/, 'no card-condition CSS rules remain on either card (the condition display was removed)');

  // client name ↔ study circle host name (0.9rem, dim ink).
  const clientNameCss = cssRuleBlock(css, '.academy-errand-card-client-name');
  const scHostNameCss = cssRuleBlock(css, '.academy-study-circle-card-host-name');
  assert.equal(fontSizeOf(clientNameCss), fontSizeOf(scHostNameCss), 'the errand client name font-size matches the study circle host name');
  assert.equal(fontSizeOf(clientNameCss), '0.9rem', 'the errand client name is the study circle baseline size (0.9rem)');

  // reward footer chip ↔ study circle reward badge (not 1:1 in structure — footer chip vs badge — matched on the
  // study circle's visual weight, 0.9rem, so the payoff reads at the same rank as the study circle badge).
  const scRewardCss = cssRuleBlock(css, '.academy-study-circle-card-reward');
  assert.equal(fontSizeOf(rewardCss), fontSizeOf(scRewardCss), 'the errand reward chip font-size matches the study circle reward badge (parity on visual weight)');
  assert.equal(fontSizeOf(rewardCss), '0.9rem', 'the errand reward chip is the study circle baseline size (0.9rem)');

  // week counter ↔ study circle week counter (no explicit font-size = inherits ~1rem body).
  const weekCss = cssRuleBlock(css, '.academy-errand-week');
  const scWeekCss = cssRuleBlock(css, '.academy-study-circle-week');
  assert.equal(fontSizeOf(weekCss), fontSizeOf(scWeekCss), 'the errand week counter font-size matches the study circle week counter (both unset — inherits the body size)');
  assert.equal(fontSizeOf(weekCss), null, 'the errand week counter carries no font-size pin (matches the study circle baseline)');
});

// The in-flight weekly-offer waiting card. GET /api/errand generates this week's offers on the week's first entry
// (文面のみ LLM), so that first fetch can take a visible beat; while it is in flight the offers board shows a 生成中
// waiting card (a live region + a non-color pulse) instead of a blank surface. renderErrandOffers' replaceChildren
// swaps it for the real cards on success; a failed fetch clears it so the error banner is the only surface left.
test('errand arrival: the in-flight generating placeholder is a non-interactive live-region card built into the offers list, and its CSS is token-only with a reduced-motion legible fallback (app.js + style.css)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  // The builder returns a plain <li> live region (announced when inserted), with a 選定中 label and a non-color
  // pulse of dots — and NO button / interactive affordance (a half-generated offer is never selectable).
  const buildFn = js.match(/function buildErrandGeneratingPlaceholder\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(buildFn, '', 'buildErrandGeneratingPlaceholder should exist');
  assert.match(buildFn, /createElement\('li'\)[\s\S]*?className = 'academy-errand-generating'/, 'the placeholder is an <li> in the offers list');
  assert.match(buildFn, /setAttribute\('role', 'status'\)[\s\S]*?setAttribute\('aria-live', 'polite'\)/, 'the placeholder is a polite live region so the generating state is announced');
  assert.match(buildFn, /className = 'academy-errand-generating-label';[\s\S]*?textContent = '今週の依頼を選定中…'/, 'the placeholder carries a readable 選定中 label (not motion-only)');
  assert.doesNotMatch(buildFn, /createElement\('button'\)|addEventListener/, 'the placeholder is non-interactive (no selectable half-offer)');

  // Test-by-token: the placeholder card + dots consume var(--errand-*) / shared radius tokens with no literal
  // color pin; motion is opacity/transform only (non-color shape values).
  const genCss = cssRuleBlock(css, '.academy-errand-generating');
  assert.notEqual(genCss, '', 'the .academy-errand-generating rule should exist');
  assert.match(genCss, /grid-column:\s*1 \/ -1;/, 'the placeholder spans the full offers grid');
  assert.match(genCss, /background:\s*var\(--errand-card\);/, 'the placeholder background consumes the errand card token');
  assert.match(genCss, /border-radius:\s*var\(--radius-card\);/, 'the placeholder consumes the shared card radius token');
  assert.doesNotMatch(genCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the placeholder card rule has no literal color pin (token-only)');
  const dotCss = cssRuleBlock(css, '.academy-errand-generating-dot');
  assert.match(dotCss, /background:\s*var\(--errand-amber\);/, 'the pulse dots consume the errand amber token');
  assert.match(dotCss, /animation:\s*academy-errand-generating-pulse/, 'the dots run the generating pulse animation');
  assert.doesNotMatch(dotCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the dot rule has no literal color pin (token-only)');
  const labelCss = cssRuleBlock(css, '.academy-errand-generating-label');
  assert.match(labelCss, /color:\s*var\(--errand-ink-dim\);/, 'the label color consumes an --errand-* ink token');
  assert.doesNotMatch(labelCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the label rule has no literal color pin (token-only)');

  // The pulse keyframes vary opacity/transform only (non-color), so the animation carries no literal color.
  const keyframes = css.match(/@keyframes academy-errand-generating-pulse \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(keyframes, '', 'the generating pulse keyframes should exist');
  assert.doesNotMatch(keyframes, /#[0-9a-fA-F]{3,6}\b|rgb\(|background|color:/, 'the pulse animates non-color shape values only (opacity / transform)');

  // Reduced motion: the pulse is frozen to a steady dim but the 選定中 label stays readable — the generating
  // state is still legible without motion (acceptance: prefers-reduced-motion still conveys 生成中).
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.academy-errand-generating-dot \{[^}]*animation:\s*none;/, 'a reduced-motion rule disables the generating pulse (the 選定中 label stays readable)');
});

test('errand arrival: the old light-motes ambient is fully removed (no function / instantiation / showScreen wiring / markup / CSS residue) — the framed stage image + dark veil now carry the mood (index.html + app.js + style.css)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  // Like the sibling alchemy / workshop arrivals, the errand arrival has NO ambient: the framed daytime stage
  // image under a dark veil carries the mood. The warm-parchment errand ambient (motes canvas + strategy fn +
  // showScreen start/stop wiring) is removed with no inert residue (destructive replacement, no dead code).
  assert.doesNotMatch(html, /academy-errand-ambient|academy-errand-motes/, 'the errand markup carries no ambient layer / motes canvas');
  assert.doesNotMatch(js, /createErrandScreenAmbient|errandScreenAmbient/, 'the errand ambient function + instantiation are gone from app.js (no inert code)');
  assert.doesNotMatch(js, /academy-errand-motes|--errand-mote-rgb/, 'no errand ambient canvas selector / mote-color token reference lingers in app.js');
  assert.doesNotMatch(css, /academy-errand-ambient|academy-errand-motes|--errand-sunbeam|--errand-mote-rgb/, 'the errand ambient CSS rules + tokens are gone from style.css');
});

// #academy-study-circle-screen is a no-tab content screen (like the errand / alchemy arrivals) rendered in the
// conversation-day 黒夜 visual language — the errand arrival's direct mirror — but with 星藍 (deep indigo-blue
// lamplight) as the accent in place of errand's amber: a 1:1 stage-image column (assets/canonical/study_circle/
// stage.jpg — the screen's face) beside this week's three offers as a horizontally placed, internally scrolling
// board. A routing dispatch to the study_circle destination navigates here through the existing loading interstitial
// (the mirror ROUTING_DISPATCH_SCREENS maps study_circle → academy-study-circle); showScreen fetches this week's
// three offers and renders the selectable cards. Selecting a card starts the host's conversation on the DAYTIME
// conversation screen (a pre-started conversation in one call, like the errand arrival), and ending it returns to the
// hub through the EXISTING routing drain-on-exit end path — no bespoke turn / end path.

test('study circle arrival screen is a dedicated no-tab screen with a 1:1 stage image, a week header, an offers list, and no back/skip affordance (index.html + app.js)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  const block = html.match(/<section id="academy-study-circle-screen"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.notEqual(block, '', 'a dedicated #academy-study-circle-screen section should exist');
  assert.match(block, /id="academy-study-circle-title"/, 'the arrival carries a heading');
  assert.match(block, /id="academy-study-circle-week"/, 'the arrival carries the week counter');
  assert.match(block, /<p id="academy-study-circle-status"[^>]*aria-live="polite" hidden>/, 'the arrival carries a status live region, hidden by default (error banner only)');
  assert.match(block, /<ul id="academy-study-circle-offers"/, 'the arrival carries the offers list the cards render into');
  // The 生徒会室 background is the screen's face — shown in a framed 1:1 stage image (aria-hidden), the
  // conversation-day standee-frame grammar, NOT a shell-window card. The old deep-night backdrop + starlight layers
  // are gone with no residue (destructive replacement, no inert markup).
  assert.match(block, /<div class="academy-study-circle-stage">\s*\n\s*<div class="academy-study-circle-stage-image" aria-hidden="true">/, 'the arrival carries the framed 生徒会室 1:1 stage image layer');
  assert.doesNotMatch(block, /academy-study-circle-shell|academy-study-circle-backdrop|academy-study-circle-starlight/, 'the old night backdrop + starlight layers are gone (no *-shell / *-backdrop / *-starlight 残骸)');
  // The routing dispatch already consumed the week and the conversation end is the only hub return, so the
  // arrival has NO back / skip affordance.
  assert.doesNotMatch(block, /戻る|スキップ|もどる|back-to-map/i, 'the arrival has no back / skip affordance (the conversation end is the only hub return)');

  // Registered screen + the showScreen fetch hook; no tab (no-tab content screen).
  assert.match(js, /'academy-study-circle': document\.querySelector\('#academy-study-circle-screen'\)/, 'academy-study-circle is a registered screen');
  assert.match(js, /if \(name === 'academy-study-circle'\) refreshStudyCircleScreen\(\)\.catch\(reportStudyCircleScreenError\);/, 'showScreen fetches this week\'s offers when the study circle arrival screen opens');
  assert.doesNotMatch(html, /data-screen="academy-study-circle"/, 'the study circle arrival screen has no tab (no-tab content screen)');

  // Dev entry: ?initialScreen=academy-study-circle shows the arrival (routing + save gated, like the errand / daytime dev entries).
  assert.match(js, /function requestedInitialAcademyStudyCircle\(\)[\s\S]*?get\('initialScreen'\) === 'academy-study-circle'/, 'the dev entry reads ?initialScreen=academy-study-circle');
  assert.match(js, /if \(requestedInitialAcademyStudyCircle\(\)\) \{ showScreen\('academy-study-circle'\); return; \}/, 'the initial-screen override displays the study circle arrival screen');
});

test('study circle offer fetch/render + start flow fail-fast, mirror the dispatch map, land on the daytime conversation screen with the study circle turn id wired, and reuse the existing turn/end path (app.js + routingDispatchClient.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const dispatchClient = await readFile(path.join(root, 'routingDispatchClient.js'), 'utf8');

  // The dispatch mirror maps the study circle destination to a screen that now EXISTS (before this task the mirror
  // lacked study_circle and validateRoutingDispatchScreen threw for it).
  assert.match(dispatchClient, /study_circle: 'academy-study-circle'/, 'the dispatch mirror maps the study_circle destination to the academy-study-circle screen');
  assert.match(js, /'academy-study-circle': document\.querySelector\('#academy-study-circle-screen'\)/, 'the study circle dispatch destination now reaches a real registered screen');

  // FETCH + RENDER fail-fast: GET /api/study-circle, exactly three offers, per-offer required fields validated.
  assert.match(js, /async function refreshStudyCircleScreen\(\)[\s\S]*?getJson\('\/api\/study-circle'\)[\s\S]*?renderStudyCircleOffers\(offers\)/, 'the arrival fetches the weekly offers over GET /api/study-circle and renders them');
  // Fail closed + in-flight wait display (the errand mirror): the prior offers are cleared and the 生成中 placeholder
  // shown BEFORE the fetch (one replaceChildren swap), so a failed / malformed refetch leaves no stale still-clickable
  // cards and the board is never a blank surface while the weekly offers fetch/generation is in flight.
  assert.match(js, /async function refreshStudyCircleScreen\(\)[\s\S]*?board\.replaceChildren\(buildStudyCircleGeneratingPlaceholder\(\)\);[\s\S]*?getJson\('\/api\/study-circle'\)/, 'the arrival replaces the board with the generating placeholder BEFORE fetching (fail closed + in-flight wait display)');
  // A failed / malformed fetch clears the waiting card so the error banner is the only surface left — the 生成中
  // display never lingers past a resolution (no stuck wait / silent fallback).
  assert.match(js, /async function refreshStudyCircleScreen\(\)[\s\S]*?catch \(error\) \{[\s\S]*?board\.replaceChildren\(\);[\s\S]*?throw error;/, 'a failed offer fetch clears the generating placeholder and rethrows so the error banner surfaces (wait display never lingers)');
  // End-button dispatch to study circle: navigateToPostContentScreen does NOT special-case it (generic loading → showScreen), like errand.
  const navFn = js.match(/async function navigateToPostContentScreen\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(navFn, '', 'navigateToPostContentScreen should exist');
  assert.doesNotMatch(navFn, /academy-study-circle/, 'academy-study-circle is not special-cased in navigateToPostContentScreen (both dispatch entries reach the arrival through the generic loading → showScreen path)');
  assert.match(js, /if \(!offers \|\| typeof offers !== 'object'\) \{[\s\S]*?throw new Error/, 'a malformed offers response throws (no silent fallback)');
  assert.match(js, /if \(!Array\.isArray\(list\) \|\| list\.length !== ACADEMY_STUDY_CIRCLE_OFFER_COUNT\) \{[\s\S]*?throw new Error/, 'a non-array / wrong-count offer set throws (exactly three offers)');
  assert.match(js, /第\$\{conversationStageWeek\(offers\.week\)\}週/, 'the week header reuses the shared conversationStageWeek (fail-fast on a bad week, no fabricated week)');

  const cardFn = js.match(/function buildStudyCircleCard\(offer\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(cardFn, '', 'buildStudyCircleCard should exist');
  // The card body is the appeal (当人の語り) — situation is no longer read on the card (it stays scene-injection
  // / daytime-scene material). The card validates theme id/name / venue / appeal fail-fast.
  assert.match(cardFn, /assertStudyCircleOfferString\(offer\.theme_id, 'theme_id'\)[\s\S]*?assertStudyCircleOfferString\(offer\.theme_name, 'theme_name'\)[\s\S]*?assertStudyCircleOfferString\(offer\.venue, 'venue'\)[\s\S]*?assertStudyCircleOfferString\(offer\.appeal, 'appeal'\)/, 'each card validates its required string fields (theme id/name, venue, appeal) fail-fast');
  assert.doesNotMatch(cardFn, /assertStudyCircleOfferString\(offer\.situation/, 'the study circle card no longer reads situation (appeal replaced it as the card body)');
  assert.match(cardFn, /assertStudyCircleOfferString\(offer\.title, 'title'\)/, 'each card validates the LLM-generated title fail-fast (added to the public offer, the card 主表示)');
  // 達成条件 is the internal judgment value only: the card does NOT read condition_text and renders no condition
  // element or 達成条件 label — the condition is never shown to the player.
  assert.doesNotMatch(cardFn, /condition_text/, 'the study circle card does not read condition_text (internal judgment value, not shown)');
  assert.doesNotMatch(cardFn, /academy-study-circle-card-condition|達成条件/, 'the study circle card renders no 達成条件 element');
  assert.match(cardFn, /button\.append\(host, titleEl, themeEl, venueEl, appealEl, rewards\)/, 'the card appends host / title / theme / venue / appeal / rewards (no condition element)');
  assert.match(cardFn, /assertStudyCircleOfferString\(offer\.host_display_name, 'host_display_name'\)[\s\S]*?assertStudyCircleOfferString\(offer\.host_face_url, 'host_face_url'\)/, 'each card validates the host name + the server-decorated host face url fail-fast (no invented face url convention)');
  assert.match(cardFn, /if \(!Array\.isArray\(rewardParams\) \|\| rewardParams\.length === 0\) \{[\s\S]*?throw new Error/, 'reward_params must be a non-empty array (no silent empty rewards)');
  assert.match(cardFn, /if \(typeof amount !== 'number' \|\| !Number\.isInteger\(amount\) \|\| amount <= 0\) \{[\s\S]*?throw new Error/, 'each reward amount must be a positive integer (no default-value fallback)');

  // START: POST /api/study-circle/start (a pre-started conversation in one call, NOT /api/interaction/start), landing
  // on the DAYTIME conversation screen THROUGH the shared academy loading screen (the one LM-backed start POST is
  // covered by the interstitial, not awaited in place on the frozen arrival) — the exact mirror of startErrand.
  const startFn = js.match(/async function startStudyCircle\(themeId\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(startFn, '', 'startStudyCircle should exist');
  assert.match(startFn, /postJson\('\/api\/study-circle\/start', \{ theme_id: themeId \}\)/, 'the card selection starts the study circle over POST /api/study-circle/start');
  assert.doesNotMatch(startFn, /\/api\/interaction\/start/, 'the study circle start does NOT use the ordinary interaction-start path (the start returns a pre-started conversation)');
  assert.match(startFn, /if \(!result\.conversation \|\| typeof result\.conversation !== 'object'\) \{[\s\S]*?throw new Error/, 'a start response missing the conversation throws');
  assert.match(startFn, /if \(!result\.state \|\| typeof result\.state !== 'object'\) \{[\s\S]*?throw new Error/, 'a start response missing state throws');
  assert.match(startFn, /const studyCircle = result\.study_circle;[\s\S]*?if \(!studyCircle \|\| typeof studyCircle !== 'object'\) \{[\s\S]*?throw new Error/, 'a start response missing the study_circle object throws');
  assert.match(startFn, /const hostCharacterId = studyCircle\.host_character_id;[\s\S]*?throw new Error/, 'a start response missing the host id throws');
  // The display fields (theme_name / venue / situation) drive the daytime stage frame + detail popup — fail-fast, no placeholder.
  assert.match(startFn, /if \(typeof studyCircle\.theme_name !== 'string' \|\| studyCircle\.theme_name\.trim\(\) === ''\) \{[\s\S]*?throw new Error/, 'a start response study_circle missing a theme_name throws (display field)');
  assert.match(startFn, /if \(typeof studyCircle\.venue !== 'string' \|\| studyCircle\.venue\.trim\(\) === ''\) \{[\s\S]*?throw new Error/, 'a start response study_circle missing a venue throws (display field)');
  assert.match(startFn, /if \(typeof studyCircle\.situation !== 'string' \|\| studyCircle\.situation\.trim\(\) === ''\) \{[\s\S]*?throw new Error/, 'a start response study_circle missing a situation throws (display field)');
  assert.doesNotMatch(startFn, /condition_text/, 'the study circle start no longer reads/validates condition_text (removed from the public start response)');
  assert.match(startFn, /const studyCircleConversationId = result\.conversation\.id;[\s\S]*?throw new Error/, 'a start response missing the conversation id throws');
  // LOADING-COVERED START (mirror of startErrand): the start POST + validation + state mutation run inside a readiness
  // block, and showAcademyLoadingScreenUntilReady owns the switch to conversation-day only once readiness resolves (no
  // 留まる区間 on the arrival, no bespoke parallel loader).
  assert.match(startFn, /const readiness = \(async \(\) => \{[\s\S]*?postJson\('\/api\/study-circle\/start', \{ theme_id: themeId \}\)[\s\S]*?\}\)\(\);/, 'the start POST + validation + state mutation run inside a readiness block (covered by the loading screen), not a bare in-place await on the frozen arrival');
  assert.match(startFn, /showAcademyLoadingScreenUntilReady\(\{\s*readiness,\s*nextScreen: 'conversation-day',\s*refreshBeforeNextScreen: false,\s*loadingCopy: \{[\s\S]*?\}\s*\}\)/, 'the loading screen covers the start wait and owns the switch to the daytime screen on resolve (nextScreen: conversation-day, own inline loadingCopy — reuses the shared helper, no new parallel loader)');
  // FAIL-FAST + NO STRANDING (mirror of startErrand): a failed / malformed start rejects inside readiness; the helper
  // reports it and rethrows WITHOUT switching, so the loading screen is never terminal. startStudyCircle catches only
  // to un-strand — a non-settings-redirect error returns to the study circle arrival (offers re-fetched, cause shown) —
  // then RE-RAISES so the card click handler's `.catch(reportError)` still logs it once. No swallow, no loading residue.
  assert.match(startFn, /\} catch \(error\) \{[\s\S]*?if \(settingsRedirectErrorMessage\(error\) == null\) \{[\s\S]*?showScreen\('academy-study-circle'\);[\s\S]*?setStudyCircleScreenStatus\(errorDisplayMessage\(error\), \{ tone: 'error' \}\);[\s\S]*?\}[\s\S]*?throw error;/, 'a failed start un-strands to the study circle arrival (offers re-fetched, cause shown) for non-settings-redirect errors and re-raises — never swallowed, never stranded on the loading screen');
  assert.match(startFn, /\} finally \{[\s\S]*?conversationRequestInFlight = false;/, 'the in-flight/controls state is reset in finally regardless of outcome');
  assert.match(cardFn, /button\.addEventListener\('click', \(\) => startStudyCircle\(themeId\)\.catch\(reportError\)\)/, 'a failed / malformed start still surfaces through the standard reportError path (no silent retry)');
  assert.match(startFn, /if \(conversationRequestInFlight\) \{\s*showProcessingToast\(\);\s*return;\s*\}\s*conversationRequestInFlight = true;/, 'a second card press is a no-op (conversationRequestInFlight single-flight — no second start POST)');
  assert.match(startFn, /activeCharacterId = hostCharacterId;/, 'the actor is bound from the response host (never a pinned character id)');
  assert.match(startFn, /currentRuntimeState = result\.state;/, 'the post-start state is adopted from the response');
  assert.match(startFn, /clearVisibleConversation\(\);[\s\S]*?conversationDayStage\.surface\.setHistory\(\[\]\);[\s\S]*?showAcademyLoadingScreenUntilReady\(\{[\s\S]*?nextScreen: 'conversation-day'[\s\S]*?renderConversationDayStage\(\);[\s\S]*?revealResultSequentially\(conversationDayStage\.surface, result\)/, 'the study circle conversation lands on the daytime conversation screen through the loading screen, paints the 主催 standee stage frame, and reveals the opening over the daytime stage surface');
  assert.match(startFn, /activeStudyCircleScene = studyCircle;/, 'startStudyCircle holds the study circle scene (the start response study_circle) as the single source for the stage frame / detail popup');
  assert.doesNotMatch(startFn, /'lina'|ROUTING_PERSONA_CHARACTER_ID/, 'the study circle actor id is bound from the response, never pinned');
  assert.doesNotMatch(startFn, /academyChatSurface|academy-conversation-session/, 'the study circle start does not touch the shared academy chat surface / v1 session screen (the daytime screen owns its own stage surface)');
  assert.doesNotMatch(startFn, /routingHubConversationId|enterRoutingHubConversation|routing_dispatch|performRoutingTurnDispatch|routingTurnRequestBody/, 'the study circle start sets no hub id / dispatch seam (plain daytime conversation)');

  // TURN ID WIRING: the study circle turn carries its OWN conversation id (the backend routes an active study circle
  // turn by the request conversation id + host actor — a missing id would 409 the turn as a context mismatch).
  assert.match(startFn, /activeStudyCircleConversationId = studyCircleConversationId;/, 'startStudyCircle remembers the study circle conversation id for the turn body');
  assert.match(js, /function isActiveStudyCircleConversation\(\) \{[\s\S]*?typeof activeStudyCircleConversationId === 'string' && activeStudyCircleConversationId !== ''/, 'the study-circle-active guard requires a concrete conversation id (never sends id: undefined)');
  assert.match(js, /function routingTurnRequestBody\(extra\) \{[\s\S]*?if \(isRoutingHubActive\(\)\) body\.id = routingHubConversationId;[\s\S]*?else if \(isActiveErrandConversation\(\)\) body\.id = activeErrandConversationId;[\s\S]*?else if \(isActiveStudyCircleConversation\(\)\) body\.id = activeStudyCircleConversationId;/, 'the turn body attaches the hub id, the errand id, or the study circle id (mutually exclusive), and none otherwise');
  assert.match(js, /function clearVisibleConversation\(\) \{[\s\S]*?activeStudyCircleConversationId = null;[\s\S]*?activeStudyCircleScene = null;/, 'clearing the visible conversation drops the study circle id + scene (no stale study circle state leaks into a later conversation)');
  // No bespoke study circle turn / end path — completion reuses the existing routing drain-on-exit end path and the daytime turn.
  assert.doesNotMatch(js, /function (endStudyCircle|finishStudyCircle|navigateAfterStudyCircle|studyCirclePostContent|routeAfterStudyCircle)/, 'no bespoke study circle end/transition function — completion reuses the existing routing drain-on-exit end path');
  assert.doesNotMatch(js, /function runStudyCircle(Turn|Conversation|Stream)/, 'no bespoke study circle turn executor — turns reuse the daytime runConversationDayConversation / runConversationDayTurnStream');
});

test('study circle daytime stage frame shows the 主催 standee and the detail popup shows the venue + the 1:1 study circle stage image + theme/situation, both fail-fast on broken study circle scene state (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  // Shared resolve + validate for the study circle scene: the held start-response study_circle, fail-fast (no
  // placeholder / other-stage substitution) on a missing scene / display fields / unresolvable host / standee.
  const sceneFn = js.match(/function conversationDayStudyCircleResolvedScene\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(sceneFn, '', 'conversationDayStudyCircleResolvedScene should exist');
  assert.match(sceneFn, /if \(!activeStudyCircleScene \|\| typeof activeStudyCircleScene !== 'object'\) \{[\s\S]*?throw new Error/, 'the scene resolver fails fast on a missing held scene (no placeholder)');
  assert.match(sceneFn, /if \(typeof themeName !== 'string' \|\| themeName\.trim\(\) === ''\) \{[\s\S]*?throw new Error/, 'the scene resolver fails fast on a missing/empty theme_name (display field)');
  assert.match(sceneFn, /if \(typeof venue !== 'string' \|\| venue\.trim\(\) === ''\) \{[\s\S]*?throw new Error/, 'the scene resolver fails fast on a missing/empty venue (display field)');
  assert.match(sceneFn, /if \(typeof situation !== 'string' \|\| situation\.trim\(\) === ''\) \{[\s\S]*?throw new Error/, 'the scene resolver fails fast on a missing/empty situation (display field)');
  // condition_text is internal only: the scene resolver does not read or validate it (never shown to the player).
  assert.doesNotMatch(sceneFn, /condition_text|conditionText/, 'the study circle scene resolver does not read condition_text (internal judgment value, not shown)');
  assert.match(sceneFn, /const host = selectableCharacters\.find\(\(item\) => item\.character_id === hostId\);[\s\S]*?if \(!host\) \{[\s\S]*?throw new Error/, 'the scene resolver fails fast when the 主催 is not in the selectable roster (no other-character substitution)');
  assert.match(sceneFn, /const standeeUrl = characterSceneStandeeUrl\(host\);[\s\S]*?if \(!standeeUrl\) \{[\s\S]*?throw new Error/, 'the scene resolver reuses the shared standee helper and fails fast on an unresolvable 主催 standee (no placeholder)');

  // Stage frame: during a study circle the frame shows the 主催 standee (not a field stage image), returns before the field branch.
  const stageRenderFn = js.match(/function renderConversationDayStage\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(stageRenderFn, /if \(isActiveStudyCircleConversation\(\)\) \{[\s\S]*?const scene = conversationDayStudyCircleResolvedScene\(\);[\s\S]*?image\.style\.backgroundImage = `url\('\$\{scene\.standeeUrl\}'\)`;[\s\S]*?image\.setAttribute\('aria-label', `\$\{scene\.venue\}の詳細を見る`\);[\s\S]*?return;/, 'the study circle stage frame paints the 主催 standee (not a field stage image) and returns before the field-stage branch');

  // The study circle scene 1:1 stage image url is a fixed content-stage constant (研究会の会場 舞台画像), independent of
  // the field's current stage — the detail popup shows this instead of the 主催 standee (the standee stays the frame's
  // clickable face). The errand branch's mirror.
  assert.match(js, /const STUDY_CIRCLE_SCENE_STAGE_IMAGE_URL = '\/canonical\/study_circle\/stage\.jpg';/, 'the study circle scene 1:1 stage image url is the canonical study_circle/stage.jpg constant');

  // Detail popup: during a study circle it shows the venue (title) + the new 1:1 study circle stage image
  // (study_circle/stage.jpg, marked data-scene="study-circle" for the square sizing) + the theme / situation as text,
  // through the shared resolve + validate, and returns before the field-stage branch. It shows NO 達成条件 (the
  // condition is internal only). The popup resets the scene marker on every open so a prior content-scene popup never
  // leaks onto a later popup.
  const stagePopupFn = js.match(/function openConversationDayStagePopup\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(stagePopupFn, /delete popup\.dataset\.scene;/, 'the stage popup resets the scene marker on every open (no stale content sizing leaks onto a later normal popup)');
  assert.match(stagePopupFn, /if \(isActiveStudyCircleConversation\(\)\) \{[\s\S]*?const scene = conversationDayStudyCircleResolvedScene\(\);[\s\S]*?title\.textContent = scene\.venue;[\s\S]*?image\.style\.backgroundImage = `url\('\$\{STUDY_CIRCLE_SCENE_STAGE_IMAGE_URL\}'\)`;[\s\S]*?popup\.dataset\.scene = 'study-circle';[\s\S]*?text\.textContent = `\$\{scene\.themeName\}\\n\\n\$\{scene\.situation\}`;[\s\S]*?popup\.hidden = false;[\s\S]*?return;/, 'the study circle stage-detail popup shows the venue + the 1:1 study circle stage image (data-scene="study-circle") + the theme/situation (no 達成条件), and returns before the field-stage branch');
  assert.doesNotMatch(stagePopupFn, /達成条件/, 'the study circle stage-detail popup shows no 達成条件 (internal judgment value, not shown)');
});

test('study circle arrival CSS: dedicated obsidian+star-indigo token layer, framed 1:1 stage image, viewport-fit + internal scroll, [hidden] guard, token-only cards (style.css)', async () => {
  const css = await readFile(`${root}/style.css`, 'utf8');

  // Dedicated obsidian + star-indigo token layer (the conversation-day 黒夜 language with the 星藍 accent), not
  // borrowed from the errand / alchemy / routing / conversation-day layers.
  const screenCss = cssRuleBlock(css, '.academy-study-circle-screen');
  assert.match(screenCss, /--study-circle-bg-0:[\s\S]*--study-circle-ink:[\s\S]*--study-circle-indigo:/, 'the study circle screen defines its own obsidian / ink / star-indigo token layer');
  assert.doesNotMatch(screenCss, /--errand-|--alchemy-|--routing-|--cd-night-/, 'the study circle token layer does not redefine or borrow the --errand-* / --alchemy-* / --routing-* / --cd-night-* layers');
  // The old deep-night backdrop vocabulary and its starlight tokens are gone (destructive replacement).
  assert.doesNotMatch(screenCss, /--study-circle-night|--study-circle-silver|--study-circle-starlight|--study-circle-moon|--study-circle-glow|--study-circle-line-strong/, 'the deep-night / silver / starlight tokens are gone (no residue)');

  // New 構図: the frame is a 2-column grid (1:1 stage-image column + the offer board column), the stage is a 1:1
  // square sized by the --study-circle-stage-size token, and a narrow viewport degrades to a single-column stack.
  assert.match(screenCss, /--study-circle-stage-size:/, 'the study circle screen declares the 1:1 stage column size token');
  const frameCss = cssRuleBlock(css, '.academy-study-circle-frame');
  assert.match(frameCss, /display:\s*grid;/, 'the study circle frame is a grid (1:1 stage column + offer board column)');
  assert.match(frameCss, /grid-template-columns:\s*var\(--study-circle-stage-size\) minmax\(0, 1fr\);/, 'the study circle frame places the 1:1 stage column left of the offer board');
  const stageCss = cssRuleBlock(css, '.academy-study-circle-stage');
  assert.match(stageCss, /aspect-ratio:\s*1 \/ 1;/, 'the study circle stage image column is a 1:1 square');
  // Overlap fix (root cause): the stage is box-sizing:border-box, so its padding + border stay INSIDE the
  // --study-circle-stage-size column instead of spilling ~padding+border px into the neighboring column (the same
  // "stage image overlaps the list" defect fixed on workshop). A content-box stage overflows the column.
  assert.match(stageCss, /box-sizing:\s*border-box;/, 'the study circle stage is border-box so its padding/border stay within the stage column (no spill into the neighbor — the overlap fix)');
  assert.match(css, /@media \(max-width: 720px\) \{\s*\n\s*\.academy-study-circle-frame \{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/, 'a narrow viewport degrades the study circle frame to a single-column vertical stack');

  // The background image is the screen's face — a framed 1:1 stage image (token-veiled), corner ornaments over it.
  const stageImageCss = cssRuleBlock(css, '.academy-study-circle-stage-image');
  assert.notEqual(stageImageCss, '', 'the .academy-study-circle-stage-image rule should exist');
  assert.match(stageImageCss, /url\('\/canonical\/study_circle\/stage\.jpg'\)/, 'the stage image paints the new 1:1 canonical study circle stage image');
  assert.match(stageImageCss, /var\(--study-circle-veil-strong\)/, 'the stage image veil consumes a --study-circle-* token (legibility wash, no literal color)');
  // The corner ornaments (conversation-day corner_02 family) hug the stage frame corners over the image.
  const stageBeforeCss = cssRuleBlock(css, '.academy-study-circle-stage::before,\n.academy-study-circle-stage::after');
  assert.match(stageBeforeCss, /url\('\/canonical\/conversation_day\/ui\/corner_02\.png'\)/, 'the stage frame carries the conversation-day corner_02 ornament over the image (shared 黒夜 corner grammar)');

  // The id-scoped [hidden] guard (keeps the status live region hidden under an author display rule).
  assert.match(css, /#academy-study-circle-screen \[hidden\] \{\s*\n\s*display: none;/, 'the study circle screen carries the id-scoped [hidden] guard');

  // Viewport-fit + internal-scroll (the play-screen height constraint pattern), the offers board owns the scroll.
  assert.match(css, /body:has\(#academy-study-circle-screen\.active\) \.layout \{[\s\S]*?height: calc\(100dvh - var\(--runtime-topbar-height, 88px\)\);[\s\S]*?padding: 0;[\s\S]*?overflow: hidden;/, 'the study circle layout uses the play-screen viewport-height constraint so the card board scroll resolves, and is edge-to-edge (padding:0) so the flat obsidian screen fills it with no navy-gradient border inset (direct-background standard)');
  const boardCss = cssRuleBlock(css, '.academy-study-circle-board');
  assert.match(boardCss, /min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/, 'the study circle offers board owns the internal scroll (fixed-height absorb, no page growth)');
  assertOfferBoardHoverClipClearance(css, '.academy-study-circle-board',
    /\.academy-study-circle-card-button:hover,\s*\n\.academy-study-circle-card-button:focus-visible \{[\s\S]*?transform:\s*translateY\(-4px\);/, 'study circle');

  // No shell-window card rule (full-screen direct, framed stage image).
  assert.doesNotMatch(css, /\.academy-study-circle-shell/, 'the study circle arrival defines no shell-window card rule (full-screen direct, framed stage image)');

  // Test-by-token: the card consumes var(--study-circle-*) / the shared radius tokens with no literal color pin.
  const cardCss = cssRuleBlock(css, '.academy-study-circle-card-button');
  assert.match(cardCss, /background:\s*var\(--study-circle-card\);/, 'the card background consumes the study circle card token');
  assert.match(cardCss, /border-radius:\s*var\(--radius-card\);/, 'the card consumes the shared card radius token');
  assert.doesNotMatch(cardCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the card rule has no literal color pin (token-only)');
});

// The in-flight weekly-offer waiting card (the errand mirror). GET /api/study-circle generates this week's offers on
// the week's first entry (文面のみ LLM), so that first fetch can take a visible beat; while it is in flight the offers
// board shows a 生成中 waiting card (a live region + a non-color pulse) instead of a blank surface.
// renderStudyCircleOffers' replaceChildren swaps it for the real cards on success; a failed fetch clears it so the
// error banner is the only surface left.
test('study circle arrival: the in-flight generating placeholder is a non-interactive live-region card built into the offers list, and its CSS is token-only with a reduced-motion legible fallback (app.js + style.css)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  // The builder returns a plain <li> live region (announced when inserted), with a 選定中 label and a non-color
  // pulse of dots — and NO button / interactive affordance (a half-generated offer is never selectable).
  const buildFn = js.match(/function buildStudyCircleGeneratingPlaceholder\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(buildFn, '', 'buildStudyCircleGeneratingPlaceholder should exist');
  assert.match(buildFn, /createElement\('li'\)[\s\S]*?className = 'academy-study-circle-generating'/, 'the placeholder is an <li> in the offers list');
  assert.match(buildFn, /setAttribute\('role', 'status'\)[\s\S]*?setAttribute\('aria-live', 'polite'\)/, 'the placeholder is a polite live region so the generating state is announced');
  assert.match(buildFn, /className = 'academy-study-circle-generating-label';[\s\S]*?textContent = '今週の研究会を選定中…'/, 'the placeholder carries a readable 選定中 label (not motion-only)');
  assert.doesNotMatch(buildFn, /createElement\('button'\)|addEventListener/, 'the placeholder is non-interactive (no selectable half-offer)');

  // Test-by-token: the placeholder card + dots consume var(--study-circle-*) / shared radius tokens with no literal
  // color pin; motion is opacity/transform only (non-color shape values).
  const genCss = cssRuleBlock(css, '.academy-study-circle-generating');
  assert.notEqual(genCss, '', 'the .academy-study-circle-generating rule should exist');
  assert.match(genCss, /grid-column:\s*1 \/ -1;/, 'the placeholder spans the full offers grid');
  assert.match(genCss, /background:\s*var\(--study-circle-card\);/, 'the placeholder background consumes the study circle card token');
  assert.match(genCss, /border-radius:\s*var\(--radius-card\);/, 'the placeholder consumes the shared card radius token');
  assert.doesNotMatch(genCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the placeholder card rule has no literal color pin (token-only)');
  const dotCss = cssRuleBlock(css, '.academy-study-circle-generating-dot');
  assert.match(dotCss, /background:\s*var\(--study-circle-indigo\);/, 'the pulse dots consume the study circle star-indigo token');
  assert.match(dotCss, /animation:\s*academy-study-circle-generating-pulse/, 'the dots run the generating pulse animation');
  assert.doesNotMatch(dotCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the dot rule has no literal color pin (token-only)');
  const labelCss = cssRuleBlock(css, '.academy-study-circle-generating-label');
  assert.match(labelCss, /color:\s*var\(--study-circle-ink-dim\);/, 'the label color consumes a --study-circle-* ink token');
  assert.doesNotMatch(labelCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the label rule has no literal color pin (token-only)');

  // The pulse keyframes vary opacity/transform only (non-color), so the animation carries no literal color.
  const keyframes = css.match(/@keyframes academy-study-circle-generating-pulse \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(keyframes, '', 'the generating pulse keyframes should exist');
  assert.doesNotMatch(keyframes, /#[0-9a-fA-F]{3,6}\b|rgb\(|background|color:/, 'the pulse animates non-color shape values only (opacity / transform)');

  // Reduced motion: the pulse is frozen to a steady dim but the 選定中 label stays readable.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.academy-study-circle-generating-dot \{[^}]*animation:\s*none;/, 'a reduced-motion rule disables the generating pulse (the 選定中 label stays readable)');
});

test('study circle arrival: the old deep-night backdrop + starlight are fully removed (no markup / CSS / token residue) — the framed 1:1 stage image + dark veil now carry the mood (index.html + style.css)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  // Like the sibling errand / alchemy / workshop arrivals, the study circle arrival now carries the mood with a framed
  // stage image under a dark veil. The old deep-night backdrop + CSS starlight layers (and the .academy-study-circle-
  // header block they sat beside) are removed with no inert residue (destructive replacement, no dead markup / CSS).
  assert.doesNotMatch(html, /academy-study-circle-backdrop|academy-study-circle-background|academy-study-circle-starlight|academy-study-circle-header/, 'the study circle markup carries no night backdrop / starlight / old header layer');
  assert.doesNotMatch(css, /academy-study-circle-backdrop|academy-study-circle-background|academy-study-circle-starlight|academy-study-circle-header|--study-circle-night-0|--study-circle-silver|--study-circle-moon|--study-circle-glow/, 'the study circle deep-night backdrop / starlight CSS rules + tokens are gone from style.css');
});

test('errand / study circle arrival offer-fetch retry: both arrivals surface an explicit retry button in the offer-fetch failure state that re-runs the refresh, keeping the error banner (index.html + app.js + style.css)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  // HTML: both heroes carry a retry button hidden by default (shown only in the fetch-failure state), placed
  // alongside the status live region — the error banner stays, the retry button is ADDED (not a replacement).
  const errandBlock = html.match(/<section id="academy-errand-screen"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.match(errandBlock, /<button type="button" id="academy-errand-retry" class="academy-errand-retry" hidden>[^<]+<\/button>/, 'the errand arrival carries a retry button hidden by default');
  const studyBlock = html.match(/<section id="academy-study-circle-screen"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.match(studyBlock, /<button type="button" id="academy-study-circle-retry" class="academy-study-circle-retry" hidden>[^<]+<\/button>/, 'the study circle arrival carries a retry button hidden by default');

  // JS: the refresh hides the retry on every fresh attempt and shows it in the fetch-failure catch (the board is
  // cleared, the error banner takes over, and the retry button is the only in-place recovery — no back / skip).
  const errandRefresh = js.match(/async function refreshErrandScreen\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(errandRefresh, /setErrandRetryVisible\(false\);/, 'refreshErrandScreen hides the retry button on a fresh attempt');
  assert.match(errandRefresh, /\} catch \(error\) \{[\s\S]*?list\.replaceChildren\(\);[\s\S]*?setErrandRetryVisible\(true\);[\s\S]*?throw error;/, 'a failed errand offer fetch clears the board, shows the retry button, and re-throws (error banner + retry, no silent fallback)');
  const studyRefresh = js.match(/async function refreshStudyCircleScreen\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(studyRefresh, /setStudyCircleRetryVisible\(false\);/, 'refreshStudyCircleScreen hides the retry button on a fresh attempt');
  assert.match(studyRefresh, /\} catch \(error\) \{[\s\S]*?board\.replaceChildren\(\);[\s\S]*?setStudyCircleRetryVisible\(true\);[\s\S]*?throw error;/, 'a failed study circle offer fetch clears the board, shows the retry button, and re-throws');

  // The retry buttons re-run the arrival refresh (the same fetch the showScreen hook makes) — the only recovery.
  assert.match(js, /document\.querySelector\('#academy-errand-retry'\)\.addEventListener\('click', \(\) => refreshErrandScreen\(\)\.catch\(reportErrandScreenError\)\)/, 'the errand retry button re-runs refreshErrandScreen');
  assert.match(js, /document\.querySelector\('#academy-study-circle-retry'\)\.addEventListener\('click', \(\) => refreshStudyCircleScreen\(\)\.catch\(reportStudyCircleScreenError\)\)/, 'the study circle retry button re-runs refreshStudyCircleScreen');

  // The show/hide helpers toggle the [hidden] attribute (the id-scoped [hidden] guard hides it in CSS) by reading
  // the static button directly — a missing element throws (fail-fast), matching the module-load click wiring; no
  // silent no-op guard.
  assert.match(js, /function setErrandRetryVisible\(visible\) \{\s*\n\s*document\.querySelector\('#academy-errand-retry'\)\.hidden = !visible;\s*\n\}/, 'setErrandRetryVisible toggles the retry button via the hidden attribute (direct read, no silent no-op guard)');
  assert.match(js, /function setStudyCircleRetryVisible\(visible\) \{\s*\n\s*document\.querySelector\('#academy-study-circle-retry'\)\.hidden = !visible;\s*\n\}/, 'setStudyCircleRetryVisible toggles the retry button via the hidden attribute (direct read, no silent no-op guard)');

  // CSS: both retry buttons are token-only (per-screen accent, no literal color pin — test-by-token).
  const errandRetryCss = cssRuleBlock(css, '.academy-errand-retry');
  assert.notEqual(errandRetryCss, '', 'the .academy-errand-retry rule should exist');
  assert.doesNotMatch(errandRetryCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the errand retry button rule has no literal color pin (token-only)');
  const studyRetryCss = cssRuleBlock(css, '.academy-study-circle-retry');
  assert.notEqual(studyRetryCss, '', 'the .academy-study-circle-retry rule should exist');
  assert.doesNotMatch(studyRetryCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the study circle retry button rule has no literal color pin (token-only)');
});

test('routing hub turn failure un-strands the player from the drain loading screen back to the hub (general loading-residual defense, not destination-limited) (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  // The loading-active guard the defense line reads.
  assert.match(js, /function isAcademyLoadingScreenActive\(\) \{[\s\S]*?screens\['academy-loading'\]\.classList\.contains\('active'\)/, 'a helper reports whether the academy-loading interstitial is the active screen');

  // In runRoutingHubConversation's catch: after the settings-redirect handling, if the drain loading screen is
  // active (the 見送り読みポーズ raised it and the dispatch then failed) the turn returns to the hub with the cause on
  // the hub status — NOT stranded on loading. General: gated only on the loading screen being active, not on any
  // specific destination id (so it defends every destination, including study circle, uniformly).
  const runFn = js.match(/async function runRoutingHubConversation\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(runFn, '', 'runRoutingHubConversation should exist');
  // Un-strand back to the hub when the loading screen is active, then show the cause on the hub error banner
  // (routingHubStage.setStatus(..., {tone:'error'})) — the same display surface as endRoutingConversation's
  // failed-end defense, so a decision-turn failure is visible on the hub the player is returned to.
  assert.match(runFn, /if \(handleRuntimeApiError\(error, \{ allowSettingsRedirect: true \}\)\) return;[\s\S]*?if \(isAcademyLoadingScreenActive\(\)\) showScreen\('routing-hub'\);\s*\n\s*routingHubStage\.setStatus\(errorDisplayMessage\(error\), \{ tone: 'error' \}\);/, 'the catch un-strands back to the hub when the drain loading screen is active, then shows the cause on the hub error banner (the same surface as the routing-end defense)');
  // General, not destination-limited: the defense line is gated only on the loading screen being active, never on a
  // specific destination id (so it defends every destination, including study circle, uniformly).
  const defenseLine = runFn.match(/if \(isAcademyLoadingScreenActive\(\)\) showScreen\('routing-hub'\);/)?.[0] ?? '';
  assert.notEqual(defenseLine, '', 'the loading-residual defense line should exist');
  assert.doesNotMatch(defenseLine, /study_circle|academy-study-circle|destination_id/, 'the defense line is general — not gated on the study circle (or any specific) destination');
});

// #academy-alchemy-screen is a no-tab STAY-and-craft content screen (like the workshop arrival). A routing dispatch
// to the alchemy destination navigates here through the existing loading interstitial (the mirror
// ROUTING_DISPATCH_SCREENS maps alchemy → academy-alchemy); showScreen fetches the full 56-recipe standing book.
// Crafting an affordable recipe (POST /api/alchemy/craft — a choice-cost recipe first prompts a single-element
// material pick) floats a result popup (the crafted item as the 主役) and, on 受け取る, keeps the player in the lab
// with the board re-fetched; leaving is an explicit 「調合室を出る」 to the server-authoritative post_content_screen
// (alchemy has no affordability guarantee, so the exit is always available — even with zero crafts).

test('alchemy lab screen is a dedicated no-tab stay-and-craft screen with a week header, a 分類 filter, an exit, a recipe book table, a choice picker, and a result popup (index.html + app.js)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  const block = html.match(/<section id="academy-alchemy-screen"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.notEqual(block, '', 'a dedicated #academy-alchemy-screen section should exist');
  assert.match(block, /class="screen academy-alchemy-screen"/, 'the alchemy screen carries its own screen class');
  assert.match(block, /id="academy-alchemy-title"/, 'the arrival carries a heading');
  assert.match(block, /id="academy-alchemy-week"/, 'the arrival carries the week counter');
  assert.match(block, /<p id="academy-alchemy-status"[^>]*aria-live="polite" hidden>/, 'the arrival carries a status live region, hidden by default (error banner only)');
  // The board is a non-scrolling frame wrapping the scrolling table (a sticky column-header row over the recipe
  // list), so the recipes read as a comparable table and the crafting overlay can cover the visible frame.
  assert.match(block, /<div class="academy-alchemy-board">\s*\n\s*<div class="academy-alchemy-table">/, 'the board wraps the scrolling table (the board is a non-scrolling frame for the crafting overlay)');
  assert.match(block, /<div class="academy-alchemy-head-row"[\s\S]*?<span class="academy-alchemy-col academy-alchemy-col-category"[^>]*>分類<\/span>[\s\S]*?<span class="academy-alchemy-col academy-alchemy-col-money"[^>]*>費用<\/span>/, 'the table carries the sticky column-header row (分類 … 費用) the rows align under');
  assert.match(block, /<ul id="academy-alchemy-recipes"/, 'the arrival carries the recipe book list the rows render into');
  // The 錬金術実習室 background is the screen's face — a framed stage image (aria-hidden), the conversation-day
  // standee-frame grammar, NOT a shell-window card (night full-screen direct, not the day shell). The OLD weekly
  // offer board (#academy-alchemy-offers / .academy-alchemy-card*) is gone with no residue (destructive migration).
  assert.match(block, /<div class="academy-alchemy-stage">\s*\n\s*<div class="academy-alchemy-stage-image" aria-hidden="true">/, 'the arrival carries the framed 錬金術実習室 stage image layer');
  assert.doesNotMatch(block, /academy-alchemy-shell|academy-alchemy-backdrop|academy-alchemy-offers|academy-alchemy-card/, 'the arrival is the night full-screen-direct book table, not the old offer board / day shell (no *-shell / *-offers / *-card 残骸)');
  // The 分類 filter container (chips built in JS) and the always-available exit.
  assert.match(block, /<div id="academy-alchemy-filter"/, 'the arrival carries the 分類 filter container');
  assert.match(block, /<button type="button" id="academy-alchemy-exit"[^>]*>調合室を出る<\/button>/, 'the arrival carries the explicit 「調合室を出る」 exit (always available — alchemy has no affordability guarantee)');
  // The single-element choice picker popup (a choice-cost recipe), hidden by default, with a cancel action.
  assert.match(block, /<div id="academy-alchemy-choice-popup"[^>]*hidden[^>]*role="dialog"/, 'the arrival carries the hidden choice picker popup (single-element material pick for a choice-cost recipe)');
  assert.match(block, /<div id="academy-alchemy-choice-body"/, 'the choice popup carries the body the element options render into');
  assert.match(block, /<button type="button" id="academy-alchemy-choice-cancel"/, 'the choice popup carries the cancel action (no consume)');
  // The on-screen result popup (the workshop/dungeon result-popup idiom), hidden by default, with an acknowledge button.
  assert.match(block, /<div id="academy-alchemy-result-popup"[^>]*hidden[^>]*role="dialog"/, 'the arrival carries the hidden result popup (on-screen modal, not a screen change)');
  assert.match(block, /<div id="academy-alchemy-result-body"/, 'the result popup carries the body the name/description/効果 render into');
  assert.match(block, /<button type="button" id="academy-alchemy-result-close"/, 'the result popup carries the acknowledge button that keeps the player in the lab');

  // Registered screen + the showScreen fetch hook; no tab (no-tab content screen). The 分類 filter resets only on a
  // fresh arrival (resetFilter: true), preserved across the post-craft re-fetches.
  assert.match(js, /'academy-alchemy': document\.querySelector\('#academy-alchemy-screen'\)/, 'academy-alchemy is a registered screen');
  assert.match(js, /if \(name === 'academy-alchemy'\) refreshAlchemyScreen\(\{ resetFilter: true \}\)\.catch\(reportAlchemyScreenError\);/, 'showScreen fetches the standing book (resetting the filter) when the alchemy lab screen opens');
  assert.doesNotMatch(html, /data-screen="academy-alchemy"/, 'the alchemy lab screen has no tab (no-tab content screen)');
  // The status line is the required error surface, so a missing status node is broken wiring → throw.
  assert.match(js, /function setAlchemyScreenStatus\([\s\S]*?const status = document\.querySelector\('#academy-alchemy-status'\);\s*\n\s*if \(!status\) \{[\s\S]*?throw new Error/, 'setAlchemyScreenStatus fails fast on missing status markup (no silent suppression of the error surface)');

  // Dev entry: ?initialScreen=academy-alchemy shows the arrival (the fetch is routing + save gated).
  assert.match(js, /function requestedInitialAcademyAlchemy\(\)[\s\S]*?get\('initialScreen'\) === 'academy-alchemy'/, 'the dev entry reads ?initialScreen=academy-alchemy');
  assert.match(js, /if \(requestedInitialAcademyAlchemy\(\)\) \{ showScreen\('academy-alchemy'\); return; \}/, 'the initial-screen override displays the alchemy lab screen');

  // The old weekly-offer / one-shot-completion schema is gone with no residue (destructive migration, not a compat layer).
  assert.doesNotMatch(js, /validateAlchemyOffersPayload|resolveAlchemyCompletion|ACADEMY_ALCHEMY_OFFER_COUNT|ACADEMY_ALCHEMY_RESULT_KIND_LABELS|\/api\/alchemy\/complete|completeAlchemyOffer|academy-alchemy-offers/, 'no old alchemy offer/completion symbols remain in app.js (destructive book migration, no residue)');
});

test('alchemy book fetch/render + stay-and-craft flow fail-fast, mirror the dispatch map, and leave via the server-authoritative exit (app.js + alchemyArrivalClient.js + routingDispatchClient.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const dispatchClient = await readFile(path.join(root, 'routingDispatchClient.js'), 'utf8');
  const client = await readFile(path.join(root, 'alchemyArrivalClient.js'), 'utf8');

  // The dispatch mirror maps the alchemy destination to the academy-alchemy screen (mirrors the backend target).
  assert.match(dispatchClient, /alchemy: 'academy-alchemy'/, 'the dispatch mirror maps the alchemy destination to the academy-alchemy screen');
  assert.match(js, /'academy-alchemy': document\.querySelector\('#academy-alchemy-screen'\)/, 'the alchemy dispatch destination reaches a real registered screen');

  // The fail-fast contract validators (book payload / recipe / craft-response validation) live in the
  // headless-testable module alchemyArrivalClient.js and are EXECUTABLY pinned in alchemyArrivalClient.test.mjs.
  // app.js imports and USES them (no inline re-implementation).
  assert.match(js, /import \{[\s\S]*?validateAlchemyBookPayload,[\s\S]*?resolveAlchemyCraft[\s\S]*?\} from '\.\/alchemyArrivalClient\.js'/, 'app.js imports the headless-testable alchemy book contract validators');
  // The client is the standing-book stay contract (56 recipes, no weekly-offer / completion residue).
  assert.match(client, /export const ALCHEMY_RECIPE_COUNT = 56;/, 'the client pins the full 56-recipe standing catalog count');
  assert.doesNotMatch(client, /validateAlchemyOffersPayload|resolveAlchemyCompletion|ACADEMY_ALCHEMY_OFFER_COUNT|ACADEMY_ALCHEMY_RESULT_KIND|\/api\/alchemy\/complete/, 'the client is the standing book contract (no weekly-offer / completion residue)');

  // FETCH + RENDER: GET /api/alchemy, then renderAlchemyBoard validates the WHOLE payload fail-fast before any DOM.
  assert.match(js, /async function refreshAlchemyScreen\(\{ resetFilter = false \} = \{\}\)[\s\S]*?getJson\('\/api\/alchemy'\)[\s\S]*?renderAlchemyBoard\(payload\)/, 'the arrival fetches the standing book over GET /api/alchemy and renders it');
  // Fail closed: the prior board is cleared BEFORE the fetch, so a failed / malformed refetch leaves no stale rows.
  assert.match(js, /async function refreshAlchemyScreen\([\s\S]*?document\.querySelector\('#academy-alchemy-recipes'\)\.replaceChildren\(\);[\s\S]*?getJson\('\/api\/alchemy'\)/, 'the arrival clears the board BEFORE fetching (fail closed: a failed refetch leaves no stale clickable rows)');
  // Dispatch to alchemy is NOT special-cased in navigateToPostContentScreen — it flows through the generic loading
  // interstitial → showScreen('academy-alchemy'), the same navigation performRoutingTurnDispatch uses.
  const navFn = js.match(/async function navigateToPostContentScreen\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(navFn, '', 'navigateToPostContentScreen should exist');
  assert.doesNotMatch(navFn, /academy-alchemy/, 'academy-alchemy is not special-cased in navigateToPostContentScreen (dispatch reaches the arrival through the generic loading → showScreen path)');

  // renderAlchemyBoard validates the payload fail-fast (via the shared validator) BEFORE any DOM mutation, holds the
  // server-authoritative exit, and reuses the shared conversationStageWeek for the header (no fabricated week).
  const renderFn = js.match(/function renderAlchemyBoard\(payload\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(renderFn, '', 'renderAlchemyBoard should exist');
  assert.match(renderFn, /const \{ week, recipes, postContentScreen \} = validateAlchemyBookPayload\(payload\);/, 'the whole GET /api/alchemy payload is validated fail-fast (shape / count / exit) before any DOM mutation');
  assert.match(renderFn, /alchemyExitScreen = postContentScreen;/, 'the server-authoritative exit is held for 「調合室を出る」 (no frontend-hardcoded default)');
  assert.match(renderFn, /第\$\{conversationStageWeek\(week\)\}週/, 'the week header reuses the shared conversationStageWeek (fail-fast on a bad week, no fabricated week)');
  assert.match(renderFn, /const sorted = sortAlchemyRecipes\(recipes\);/, 'the rows are sorted into 分類 order before mount');

  // ROW: buildAlchemyRow is pure DOM assembly over an ALREADY-VALIDATED normalized recipe — one aligned 5-column
  // record (分類・品名・効果・素材・費用), built from the shared alchemyArrivalClient label helper (no private
  // translation). Unaffordable rows are disabled (non-interactive); a fixed-cost recipe crafts on click, a
  // choice-cost recipe opens the single-element picker first.
  const rowFn = js.match(/function buildAlchemyRow\(recipe\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(rowFn, '', 'buildAlchemyRow should exist (the book is an aligned table)');
  assert.match(rowFn, /button\.disabled = !recipe\.affordable;/, 'unaffordable rows are disabled (never fire a craft)');
  assert.match(rowFn, /alchemyCategoryLabel\(recipe\.category\)/, 'the 分類 cell uses the shared category label helper (no private translation)');
  assert.match(rowFn, /recipe\.result\.name/, 'the 品名 cell shows the item name');
  assert.match(rowFn, /recipe\.result\.effect_summary/, 'the 効果 cell shows the backend effect summary');
  assert.match(rowFn, /（所持 \$\{cost\.held\}）/, 'each material cost row shows the held quantity alongside the required amount');
  assert.match(rowFn, /alchemyCostRow\([\s\S]*?cost\.short\)/, 'material rows pass their short flag to the shared cost-row helper (the 不足 affordance)');
  assert.match(rowFn, /if \(recipe\.affordable\) \{[\s\S]*?if \(recipe\.costs\.mode === 'choice'\) \{[\s\S]*?openAlchemyChoicePicker\(recipe\)[\s\S]*?\} else \{[\s\S]*?craftAlchemyRecipe\(recipe, null\)\.catch\(reportAlchemyScreenError\)/, 'only affordable rows are interactive; a choice-cost recipe opens the picker, a fixed-cost recipe crafts directly (failures surface through the reporter)');
  // data-short marking lives in the shared cost-row helper (materials, choice and money reuse it).
  const costRowFn = js.match(/function alchemyCostRow\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(costRowFn, /if \(short\) row\.dataset\.short = 'true';/, 'insufficient cost rows are marked (data-short) for the 不足 affordance');

  // CRAFT: POST /api/alchemy/craft { recipe_id, materials? } (a single call, NOT a conversation); the response is
  // resolved AGAINST the selected recipe (crafted recipe id + item identity must match — a divergence fail-fasts),
  // the authoritative state is adopted, and the result popup floats.
  const craftFn = js.match(/async function craftAlchemyRecipe\(recipe, materials\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(craftFn, '', 'craftAlchemyRecipe should exist');
  assert.match(craftFn, /postJson\('\/api\/alchemy\/craft', \{ recipe_id: recipe\.recipe_id, \.\.\.\(materials \? \{ materials \} : \{\}\) \}\)/, 'the selection crafts the recipe over POST /api/alchemy/craft, forwarding the choice materials when present');
  assert.doesNotMatch(craftFn, /\/api\/interaction\/start|\/api\/errand\/start|\/stream/, 'the alchemy craft is a single call (no conversation / interaction start / stream)');
  assert.match(craftFn, /const \{ state, display \} = resolveAlchemyCraft\(response, recipe\);/, 'the craft response is resolved against the selected recipe (fail-fast on missing fields / an identity divergence)');
  assert.match(craftFn, /currentRuntimeState = state;/, 'the post-craft state is adopted from the validated response');
  assert.match(craftFn, /openAlchemyResultPopup\(display\);/, 'a successful craft floats the result popup with the RESOLVED display (name/効果 from the response)');
  // FAIL-FAST: craftAlchemyRecipe does NOT catch/swallow its own failures — they reject to the caller's
  // `.catch(reportAlchemyScreenError)`; only the in-flight reset + the crafting-busy clear run in finally.
  assert.doesNotMatch(craftFn, /catch \(/, 'craftAlchemyRecipe does not catch/swallow its own failures (they reject and surface through the caller)');
  assert.match(craftFn, /\} finally \{[\s\S]*?alchemyCraftInFlight = false;/, 'craftAlchemyRecipe resets the in-flight guard in finally (no local error recovery)');
  assert.match(craftFn, /if \(alchemyCraftInFlight\) \{[\s\S]*?showProcessingToast\(\);[\s\S]*?return;/, 'a double craft is guarded by the in-flight flag');
  // IN-SCREEN CRAFT BUSY: alchemy is a stay screen (no transition to a loading screen), so the craft wait is covered
  // in place — setAlchemyCrafting(true) BEFORE the POST floats the 調合している… overlay and marks the board busy, and
  // the finally clears it on every outcome (success → result popup; failure → status-line error) so it never lingers.
  assert.match(craftFn, /setAlchemyCrafting\(true\);[\s\S]*?postJson\('\/api\/alchemy\/craft'/, 'the craft busy state is shown BEFORE the craft POST (the wait is covered in screen, not left on a frozen board)');
  assert.match(craftFn, /\} finally \{[\s\S]*?alchemyCraftInFlight = false;[\s\S]*?setAlchemyCrafting\(false\);/, 'the craft busy state is cleared in finally regardless of outcome (no lingering overlay)');
  const craftingSetterFn = js.match(/function setAlchemyCrafting\(active\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(craftingSetterFn, '', 'setAlchemyCrafting should exist');
  assert.match(craftingSetterFn, /board\.dataset\.crafting = 'true';[\s\S]*?board\.append\(buildAlchemyCraftingIndicator\(\)\)/, 'the busy setter marks the board (data-crafting) and floats the crafting overlay when active');
  assert.match(craftingSetterFn, /delete board\.dataset\.crafting;[\s\S]*?existing\.remove\(\)/, 'the busy setter clears the board marker and removes the overlay when inactive (no residue)');
  const craftingBuilderFn = js.match(/function buildAlchemyCraftingIndicator\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(craftingBuilderFn, /academy-alchemy-crafting-orbits[\s\S]*?academy-alchemy-crafting-dot[\s\S]*?label\.textContent = '調合している…'/, 'the crafting overlay mirrors the workshop 銘を刻んでいる… / errand 生成中 grammar (orbits + non-color dots + the 調合している… label)');

  // CHOICE PICKER: a choice-cost recipe opens the single-element picker; each option carries its held count and is
  // disabled when too few are held, and an enabled option crafts with the single-element materials payload.
  const pickerFn = js.match(/function openAlchemyChoicePicker\(recipe\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(pickerFn, '', 'openAlchemyChoicePicker should exist');
  assert.match(pickerFn, /optionButton\.disabled = !option\.enough;/, 'an option with too few materials held is disabled (never fires a craft)');
  assert.match(pickerFn, /craftAlchemyRecipe\(recipe, buildAlchemyChoiceMaterials\(option\.item_id, recipe\.costs\.choice\.quantity\)\)\.catch\(reportAlchemyScreenError\)/, 'an enabled option crafts with the single-element materials payload (failures surface through the reporter)');
  assert.match(js, /document\.querySelector\('#academy-alchemy-choice-cancel'\)\.addEventListener\('click', \(\) => hideAlchemyChoicePopup\(\)\)/, 'the choice cancel button closes the picker without consuming anything');

  // STAY: acknowledging the result closes the popup and RE-FETCHES the board (held/affordable changed) — it is NOT a
  // navigation (alchemy is a stay-and-craft screen; leaving is the separate 「調合室を出る」).
  const ackFn = js.match(/function acknowledgeAlchemyResult\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(ackFn, '', 'acknowledgeAlchemyResult should exist');
  assert.match(ackFn, /hideAlchemyResultPopup\(\);[\s\S]*?return refreshAlchemyScreen\(\);/, 'acknowledging the result closes the popup and re-fetches the board (stay-and-craft)');
  assert.doesNotMatch(ackFn, /navigateToPostContentScreen|returnToRoutingHubFromContent/, 'acknowledging a craft does NOT navigate away — the player stays in the lab');
  assert.match(js, /document\.querySelector\('#academy-alchemy-result-close'\)\.addEventListener\('click', \(\) => acknowledgeAlchemyResult\(\)\.catch\(reportAlchemyScreenError\)\)/, 'the acknowledge button is wired to the stay-and-refetch handler');

  // EXIT: 「調合室を出る」 returns to the hub via the HELD server-authoritative post_content_screen through the shared
  // loading-covered path (押下→ロード画面→迎え会話ストリーミング開始でハブ表示 — no bare enterRoutingHub under the
  // still-visible alchemy screen, which reads as a freeze). A double press is guarded by the shared in-flight flag; a
  // missing held screen fails fast (no fabricated default). This is the always-available way out (reachable with zero crafts).
  const exitFn = js.match(/async function exitAlchemy\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(exitFn, '', 'exitAlchemy should exist (async)');
  assert.match(exitFn, /if \(routingContentReturnInFlight\) \{[\s\S]*?showProcessingToast\(\);[\s\S]*?return;[\s\S]*?\}/, 'a double 調合室を出る is guarded by the shared routing-content-return in-flight flag (no second hub return starts)');
  assert.match(exitFn, /const nextScreen = alchemyExitScreen;[\s\S]*?if \(typeof nextScreen !== 'string' \|\| nextScreen === ''\) \{[\s\S]*?throw new Error[\s\S]*?\}[\s\S]*?routingContentReturnInFlight = true;[\s\S]*?await returnToRoutingHubFromContent\(nextScreen\)/, 'the exit uses the held server-authoritative post_content_screen, fails fast when it is missing, and returns to the hub through the shared loading-covered path');
  assert.match(exitFn, /\} finally \{[\s\S]*?routingContentReturnInFlight = false;[\s\S]*?\}/, 'the in-flight flag is released in finally');
  assert.doesNotMatch(exitFn, /navigateToPostContentScreen/, 'the alchemy exit goes through the loading-covered shared path, not the bare-enterRoutingHub navigateToPostContentScreen (no freeze)');
  assert.match(js, /document\.querySelector\('#academy-alchemy-exit'\)\.addEventListener\('click', \(\) => exitAlchemy\(\)\.catch\(reportAlchemyScreenError\)\)/, 'the 「調合室を出る」 button is wired to the exit handler (rejections surface through the alchemy reporter)');
});

test('alchemy lab CSS: dedicated obsidian+amber token layer, framed stage image (border-box, no board overlap), viewport-fit + internal scroll, aligned subgrid table, non-lifting inset-ring row hover, scroll-independent crafting overlay, [hidden] guard, token-only rows, filter/exit, choice + result popups (style.css)', async () => {
  const css = await readFile(`${root}/style.css`, 'utf8');

  // Dedicated obsidian+amber token layer (the conversation-day 黒夜 language), not borrowed from the workshop /
  // errand / routing / conversation-day layers.
  const screenCss = cssRuleBlock(css, '.academy-alchemy-screen');
  assert.match(screenCss, /--alchemy-bg-0:[\s\S]*--alchemy-ink:[\s\S]*--alchemy-amber:/, 'the alchemy screen defines its own obsidian / ink / amber token layer');
  assert.doesNotMatch(screenCss, /--workshop-|--errand-|--routing-|--cd-night-/, 'the alchemy token layer does not redefine or borrow the --workshop-* / --errand-* / --routing-* / --cd-night-* layers');
  assert.match(screenCss, /--alchemy-stage-size:/, 'the alchemy screen declares the 1:1 stage column size token');
  assert.match(screenCss, /--alchemy-row-grid:/, 'the alchemy screen declares the shared row/column-template geometry token');

  // 構図: the frame is a 2-column / 2-row grid — the 1:1 stage-image column spans both rows on the left, the right
  // column holds the filter/exit controls (top row) over the recipe board (bottom row).
  const frameCss = cssRuleBlock(css, '.academy-alchemy-frame');
  assert.match(frameCss, /display:\s*grid;/, 'the alchemy frame is a grid (1:1 stage column + controls/board column)');
  assert.match(frameCss, /grid-template-columns:\s*var\(--alchemy-stage-size\) minmax\(0, 1fr\);/, 'the alchemy frame places the 1:1 stage column left of the right controls/board column');
  assert.match(frameCss, /grid-template-rows:\s*auto minmax\(0, 1fr\);/, 'the alchemy right column is a controls row over a board row');
  const stageCss = cssRuleBlock(css, '.academy-alchemy-stage');
  assert.match(stageCss, /aspect-ratio:\s*1 \/ 1;/, 'the alchemy stage image column is a 1:1 square');
  assert.match(stageCss, /grid-row:\s*1 \/ span 2;/, 'the alchemy stage spans both right-column rows on the left');
  // Overlap invariant: the stage is box-sizing:border-box, so its padding + border stay INSIDE the
  // --alchemy-stage-size column instead of spilling past it into the board column (the sibling of the workshop
  // overlap fix — a content-box stage covers the neighbouring board).
  assert.match(stageCss, /box-sizing:\s*border-box;/, 'the alchemy stage is border-box so its padding/border stay within the stage column (no spill over the board)');
  const controlsCss = cssRuleBlock(css, '.academy-alchemy-controls');
  assert.match(controlsCss, /grid-column:\s*2;[\s\S]*?grid-row:\s*1;/, 'the alchemy filter/exit controls sit in the top-right row');
  const boardPlacementCss = cssRuleBlock(css, '.academy-alchemy-board');
  assert.match(boardPlacementCss, /grid-column:\s*2;[\s\S]*?grid-row:\s*2;/, 'the alchemy recipe board sits in the bottom-right row');
  assert.match(css, /@media \(max-width: 820px\) \{\s*\n\s*\.academy-alchemy-frame \{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/, 'a narrow viewport degrades the alchemy frame to a single-column vertical stack');

  // The background image is the screen's face — a framed stage image (token-veiled), corner ornaments over it.
  const stageImageCss = cssRuleBlock(css, '.academy-alchemy-stage-image');
  assert.notEqual(stageImageCss, '', 'the .academy-alchemy-stage-image rule should exist');
  assert.match(stageImageCss, /url\('\/canonical\/alchemy\/stage\.jpg'\)/, 'the stage image paints the 1:1 canonical alchemy stage image');
  assert.match(stageImageCss, /var\(--alchemy-veil-strong\)/, 'the stage image veil consumes an --alchemy-* token (legibility wash, no literal color)');
  const stageBeforeCss = cssRuleBlock(css, '.academy-alchemy-stage::before,\n.academy-alchemy-stage::after');
  assert.match(stageBeforeCss, /url\('\/canonical\/conversation_day\/ui\/corner_02\.png'\)/, 'the stage frame carries the conversation-day corner_02 ornament over the image (shared 黒夜 corner grammar)');

  // The id-scoped [hidden] guard (keeps the status line, popups, and filtered-out rows hidden).
  assert.match(css, /#academy-alchemy-screen \[hidden\] \{\s*\n\s*display: none;/, 'the alchemy screen carries the id-scoped [hidden] guard');

  // Viewport-fit + internal-scroll (the play-screen height constraint). The board is a NON-scrolling frame
  // (overflow:hidden) and the inner .academy-alchemy-table owns the scroll — so the crafting overlay (a child of the
  // board) covers the visible frame and stays in view regardless of scroll position.
  assert.match(css, /body:has\(#academy-alchemy-screen\.active\) \.layout \{[\s\S]*?height: calc\(100dvh - var\(--runtime-topbar-height, 88px\)\);[\s\S]*?padding: 0;[\s\S]*?overflow: hidden;/, 'the alchemy layout uses the play-screen viewport-height constraint so the dense board scroll resolves, and is edge-to-edge (padding:0) so the flat obsidian screen fills it with no navy-gradient border inset (direct-background standard)');
  const boardCss = cssRuleBlock(css, '.academy-alchemy-board');
  assert.match(boardCss, /min-height:\s*0;[\s\S]*?overflow:\s*hidden;/, 'the alchemy board is a non-scrolling frame (the crafting overlay covers its visible viewport)');
  const tableCss = cssRuleBlock(css, '.academy-alchemy-table');
  assert.match(tableCss, /min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/, 'the inner table owns the internal scroll (fixed-height absorb, no page growth)');
  assert.match(tableCss, /grid-template-columns:\s*var\(--alchemy-row-grid\);/, 'the table declares the shared 5-column template (the master grid the header + rows subgrid off)');
  const headRowCss = cssRuleBlock(css, '.academy-alchemy-head-row');
  assert.match(headRowCss, /grid-template-columns:\s*subgrid;/, 'the sticky header row is a subgrid of the table (its columns match the rows)');
  assert.match(headRowCss, /position:\s*sticky;[\s\S]*?top:\s*0;/, 'the column-header row is sticky so the labels stay visible while the rows scroll');

  // Test-by-token: the recipe row consumes var(--alchemy-*) / shared tokens, no literal pin. The row is a full-bleed
  // subgrid so its cells line up under the header columns, and its hover is an INSET ring (no translate lift) so the
  // internal-scroll edge never clips a hover envelope (the workshop table grammar, not the old lifting-card board).
  const rowCss = cssRuleBlock(css, '.academy-alchemy-row-button');
  assert.match(rowCss, /grid-template-columns:\s*subgrid;/, 'the recipe row is a subgrid of the table (its cells line up under the header columns)');
  assert.match(rowCss, /background:\s*var\(--alchemy-card\);/, 'the row background consumes the alchemy card token');
  assert.doesNotMatch(rowCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the row rule has no literal color pin (token-only)');
  assert.match(css, /\.academy-alchemy-row-button:hover:not\(:disabled\),\s*\n\.academy-alchemy-row-button:focus-visible:not\(:disabled\) \{[\s\S]*?box-shadow:\s*inset 0 0 0 1px var\(--alchemy-amber-soft\);/, 'the row hover uses an inset amber ring (the amber-soft token)');
  const rowHoverBlock = css.match(/\.academy-alchemy-row-button:hover:not\(:disabled\),\s*\n\.academy-alchemy-row-button:focus-visible:not\(:disabled\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.doesNotMatch(rowHoverBlock, /translateY/, 'the row hover does not lift (translateY) — the inset ring avoids clipping the hover against the internal-scroll edge');
  const exitCss = cssRuleBlock(css, '.academy-alchemy-exit');
  assert.notEqual(exitCss, '', 'the .academy-alchemy-exit rule should exist');
  assert.doesNotMatch(exitCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the exit button rule has no literal color pin (token-only)');
  const chipCss = cssRuleBlock(css, '.academy-alchemy-filter-chip[aria-pressed="true"]');
  assert.match(chipCss, /background:\s*var\(--alchemy-amber\);/, 'the active 分類 filter chip consumes the alchemy amber token (no literal color)');

  // The in-flight craft overlay + busy state consume var(--alchemy-*) / shared shape tokens only (no literal pin) —
  // the same test-by-token discipline as the rows, in the alchemy token layer. It is absolutely positioned over the
  // non-scrolling board (inset:0), so 調合している… stays fully in view no matter how far the list is scrolled.
  const craftingCss = cssRuleBlock(css, '.academy-alchemy-crafting');
  assert.notEqual(craftingCss, '', 'the .academy-alchemy-crafting overlay rule should exist');
  assert.match(craftingCss, /position:\s*absolute;[\s\S]*?inset:\s*0;/, 'the crafting overlay covers the board frame (inset:0 over the non-scrolling board — scroll-independent visibility)');
  assert.match(craftingCss, /background:\s*var\(--alchemy-veil-strong\);/, 'the crafting overlay veil consumes an --alchemy-* token');
  assert.doesNotMatch(craftingCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the crafting overlay rule has no literal color pin (token-only)');
  const craftingDotCss = cssRuleBlock(css, '.academy-alchemy-crafting-dot');
  assert.match(craftingDotCss, /background:\s*var\(--alchemy-amber\);/, 'the crafting pulse dots consume the alchemy amber token (no literal color)');

  // The choice picker + result popup are scrimmed on-screen overlays consuming the alchemy scrim token (no literal pin).
  const choiceCss = cssRuleBlock(css, '.academy-alchemy-choice-popup');
  assert.notEqual(choiceCss, '', 'the .academy-alchemy-choice-popup rule should exist');
  assert.match(choiceCss, /background:\s*var\(--alchemy-result-scrim\);/, 'the choice picker scrim consumes an --alchemy-* token');
  const popupCss = cssRuleBlock(css, '.academy-alchemy-result-popup');
  assert.notEqual(popupCss, '', 'the .academy-alchemy-result-popup rule should exist');
  assert.match(popupCss, /background:\s*var\(--alchemy-result-scrim\);/, 'the result popup scrim consumes an --alchemy-* token');
});

// #academy-workshop-screen is a no-tab content screen (like the alchemy arrival). A routing dispatch to the
// workshop destination navigates here through the existing loading interstitial (the mirror ROUTING_DISPATCH_SCREENS
// maps workshop → academy-workshop); showScreen fetches this week's full 96-recipe board. Unlike the alchemy
// arrival it is a STAY-and-craft screen: crafting an affordable recipe (POST /api/workshop/craft) floats a result
// popup (name/flavor as the 主役) and, on 受け取る, keeps the player in the workshop with the board re-fetched;
// leaving is an explicit 「工房を出る」 to the server-authoritative post_content_screen (the workshop has no
// affordability guarantee, so the exit is always available — even with zero crafts).

test('workshop arrival screen is a dedicated no-tab stay-and-craft screen with a week header, 種別/ティア/属性 filters, an exit, a recipe board with an empty-state, and a result popup (index.html + app.js)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  const block = html.match(/<section id="academy-workshop-screen"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.notEqual(block, '', 'a dedicated #academy-workshop-screen section should exist');
  assert.match(block, /class="screen academy-workshop-screen"/, 'the workshop screen carries its own screen class');
  assert.match(block, /id="academy-workshop-title"/, 'the arrival carries a heading');
  assert.match(block, /id="academy-workshop-week"/, 'the arrival carries the week counter');
  assert.match(block, /<p id="academy-workshop-status"[^>]*aria-live="polite" hidden>/, 'the arrival carries a status live region, hidden by default (error banner only)');
  // The board is a non-scrolling frame wrapping the scrolling table (a sticky column-header row over the recipe
   // list), so the recipes read as a comparable table and the crafting overlay can cover the visible frame.
  assert.match(block, /<div class="academy-workshop-board">\s*\n\s*<div class="academy-workshop-table">/, 'the board wraps the scrolling table (the board is a non-scrolling frame for the crafting overlay)');
  assert.match(block, /<div class="academy-workshop-head-row"[\s\S]*?<span class="academy-workshop-col academy-workshop-col-kind"[^>]*>種別<\/span>[\s\S]*?<span class="academy-workshop-col academy-workshop-col-outlook"[^>]*>出来栄え見込み<\/span>/, 'the table carries the sticky column-header row (種別 … 出来栄え見込み) the rows align under');
  assert.match(block, /<ul id="academy-workshop-recipes"/, 'the arrival carries the recipe board list the rows render into');
  // The explicit empty-state message (revealed by JS when a filter combination matches no recipe — never a silently
  // blank table), inside the table so it spans the columns under the sticky header.
  assert.match(block, /<p id="academy-workshop-empty"[^>]*hidden>該当するレシピがありません<\/p>/, 'the arrival carries the hidden empty-state message shown when a filter combination matches no recipe');
  // The 鍛冶工房 background is the screen's face — a framed stage image (aria-hidden), the conversation-day
  // standee-frame grammar, NOT a shell-window card (night full-screen direct, not the day shell).
  assert.match(block, /<div class="academy-workshop-stage">\s*\n\s*<div class="academy-workshop-stage-image" aria-hidden="true">/, 'the arrival carries the framed 鍛冶工房 stage image layer');
  assert.doesNotMatch(block, /academy-workshop-shell|academy-workshop-backdrop/, 'the arrival is the night full-screen-direct frame, not a day shell (no *-shell / backdrop残骸)');
  // The three filter containers (種別 × ティア × 属性, chips built in JS) grouped left of the always-available exit.
  assert.match(block, /<div id="academy-workshop-filter"[^>]*aria-label="種別で絞り込み"/, 'the arrival carries the 種別 filter container');
  assert.match(block, /<div id="academy-workshop-tier-filter"[^>]*aria-label="ティアで絞り込み"/, 'the arrival carries the ティア filter container');
  assert.match(block, /<div id="academy-workshop-element-filter"[^>]*aria-label="属性で絞り込み"/, 'the arrival carries the 属性 filter container');
  assert.match(block, /<button type="button" id="academy-workshop-exit"[^>]*>工房を出る<\/button>/, 'the arrival carries the explicit 「工房を出る」 exit (always available — the workshop has no affordability guarantee)');
  // The on-screen result popup (the dungeon/alchemy result-popup idiom), hidden by default, with an acknowledge button.
  assert.match(block, /<div id="academy-workshop-result-popup"[^>]*hidden[^>]*role="dialog"/, 'the arrival carries the hidden result popup (on-screen modal, not a screen change)');
  assert.match(block, /<div id="academy-workshop-result-body"/, 'the result popup carries the body the name/flavor/identity render into');
  assert.match(block, /<button type="button" id="academy-workshop-result-close"/, 'the result popup carries the acknowledge button that keeps the player in the workshop');

  // Registered screen + the showScreen fetch hook; no tab (no-tab content screen). The 種別 filter resets only on
  // a fresh arrival (resetFilter: true), preserved across the post-craft re-fetches.
  assert.match(js, /'academy-workshop': document\.querySelector\('#academy-workshop-screen'\)/, 'academy-workshop is a registered screen');
  assert.match(js, /if \(name === 'academy-workshop'\) refreshWorkshopScreen\(\{ resetFilter: true \}\)\.catch\(reportWorkshopScreenError\);/, 'showScreen fetches this week\'s board (resetting the filter) when the workshop arrival screen opens');
  assert.doesNotMatch(html, /data-screen="academy-workshop"/, 'the workshop arrival screen has no tab (no-tab content screen)');
  // The status line is the required error surface, so a missing status node is broken wiring → throw.
  assert.match(js, /function setWorkshopScreenStatus\([\s\S]*?const status = document\.querySelector\('#academy-workshop-status'\);\s*\n\s*if \(!status\) \{[\s\S]*?throw new Error/, 'setWorkshopScreenStatus fails fast on missing status markup (no silent suppression of the error surface)');

  // Dev entry: ?initialScreen=academy-workshop shows the arrival (the fetch is routing + save gated).
  assert.match(js, /function requestedInitialAcademyWorkshop\(\)[\s\S]*?get\('initialScreen'\) === 'academy-workshop'/, 'the dev entry reads ?initialScreen=academy-workshop');
  assert.match(js, /if \(requestedInitialAcademyWorkshop\(\)\) \{ showScreen\('academy-workshop'\); return; \}/, 'the initial-screen override displays the workshop arrival screen');
});

test('workshop board fetch/render + stay-and-craft flow fail-fast, mirror the dispatch map, withhold the confirmed quality, and leave via the server-authoritative exit (app.js + routingDispatchClient.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const dispatchClient = await readFile(path.join(root, 'routingDispatchClient.js'), 'utf8');

  // The dispatch mirror maps the workshop destination to the academy-workshop screen (mirrors the backend target).
  assert.match(dispatchClient, /workshop: 'academy-workshop'/, 'the dispatch mirror maps the workshop destination to the academy-workshop screen');
  assert.match(js, /'academy-workshop': document\.querySelector\('#academy-workshop-screen'\)/, 'the workshop dispatch destination reaches a real registered screen');

  // The fail-fast contract validators (payload / recipe / craft-response validation, the withheld-roll leak guard)
  // live in the headless-testable module workshopArrivalClient.js and are EXECUTABLY pinned in
  // workshopArrivalClient.test.mjs. app.js imports and USES them (no inline re-implementation).
  assert.match(js, /import \{[\s\S]*?validateWorkshopArrivalPayload,[\s\S]*?resolveWorkshopCraft[\s\S]*?\} from '\.\/workshopArrivalClient\.js'/, 'app.js imports the headless-testable workshop contract validators');

  // FETCH + RENDER: GET /api/workshop, then renderWorkshopBoard validates the WHOLE payload fail-fast before any DOM.
  assert.match(js, /async function refreshWorkshopScreen\(\{ resetFilter = false \} = \{\}\)[\s\S]*?getJson\('\/api\/workshop'\)[\s\S]*?renderWorkshopBoard\(payload\)/, 'the arrival fetches the weekly board over GET /api/workshop and renders it');
  // Fail closed: the prior board is cleared BEFORE the fetch, so a failed / malformed refetch leaves no stale cards.
  assert.match(js, /async function refreshWorkshopScreen\([\s\S]*?document\.querySelector\('#academy-workshop-recipes'\)\.replaceChildren\(\);[\s\S]*?getJson\('\/api\/workshop'\)/, 'the arrival clears the board BEFORE fetching (fail closed: a failed refetch leaves no stale clickable cards)');
  // Dispatch to workshop is NOT special-cased in navigateToPostContentScreen — it flows through the generic
  // loading interstitial → showScreen('academy-workshop'), the same navigation performRoutingTurnDispatch uses.
  const navFn = js.match(/async function navigateToPostContentScreen\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(navFn, '', 'navigateToPostContentScreen should exist');
  assert.doesNotMatch(navFn, /academy-workshop/, 'academy-workshop is not special-cased in navigateToPostContentScreen (dispatch reaches the arrival through the generic loading → showScreen path)');

  // renderWorkshopBoard validates the payload fail-fast (via the shared validator) BEFORE any DOM mutation, holds
  // the server-authoritative exit, and reuses the shared conversationStageWeek for the header (no fabricated week).
  const renderFn = js.match(/function renderWorkshopBoard\(payload\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(renderFn, '', 'renderWorkshopBoard should exist');
  assert.match(renderFn, /const \{ week, recipes, postContentScreen \} = validateWorkshopArrivalPayload\(payload\);/, 'the whole GET /api/workshop payload is validated fail-fast (shape / count / leak / exit) before any DOM mutation');
  assert.match(renderFn, /workshopExitScreen = postContentScreen;/, 'the server-authoritative exit is held for 「工房を出る」 (no frontend-hardcoded default)');
  assert.match(renderFn, /第\$\{conversationStageWeek\(week\)\}週/, 'the week header reuses the shared conversationStageWeek (fail-fast on a bad week, no fabricated week)');
  // The 3-axis filter (種別 × ティア × 属性): renderWorkshopBoard holds the normalized recipes, renders the three
  // filter groups from them, and re-applies the current filter after (re)building the board.
  assert.match(renderFn, /workshopBoardRecipes = sorted;[\s\S]*?renderWorkshopFilters\(sorted\);[\s\S]*?applyWorkshopFilter\(\);/, 'renderWorkshopBoard holds the normalized recipes, renders the 3 filter groups, and re-applies the current filter');

  // FILTER (3-axis AND, client-side, no re-fetch): renderWorkshopFilters builds 種別 (WORKSHOP_CATEGORY_ORDER) +
  // ティア (data-derived workshopTierValues) + 属性 (WORKSHOP_ELEMENTS) chip groups; applyWorkshopFilter decides
  // visibility through the shared workshopVisibleRecipes predicate (no inline re-derivation) and reveals the
  // explicit empty-state when nothing matches; resetFilter resets EVERY axis (not just 種別).
  const filtersFn = js.match(/function renderWorkshopFilters\(recipes\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(filtersFn, '', 'renderWorkshopFilters should exist');
  assert.match(filtersFn, /'#academy-workshop-filter', 'category',[\s\S]*?WORKSHOP_CATEGORY_ORDER/, 'the 種別 group is built from the frozen category order');
  assert.match(filtersFn, /'#academy-workshop-tier-filter', 'tier',[\s\S]*?workshopTierValues\(recipes\)/, 'the ティア group is built from the data-derived tiers present this week');
  assert.match(filtersFn, /'#academy-workshop-element-filter', 'element',[\s\S]*?WORKSHOP_ELEMENTS/, 'the 属性 group is built from the frozen element closed set');
  const applyFn = js.match(/function applyWorkshopFilter\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(applyFn, '', 'applyWorkshopFilter should exist (no-arg: it reads the shared workshopFilter state)');
  assert.match(applyFn, /workshopVisibleRecipes\(workshopBoardRecipes, workshopFilter\)/, 'the board visibility is decided by the shared workshopVisibleRecipes predicate (no inline re-derivation of the 3-axis match)');
  assert.match(applyFn, /row\.hidden = !visibleIds\.has\(button\.dataset\.recipeId\)/, 'each row is toggled hidden by whether its recipe is in the visible set (the hidden-toggle mechanism)');
  assert.match(applyFn, /setWorkshopBoardEmpty\(visibleIds\.size === 0\)/, 'applyWorkshopFilter reveals the explicit empty-state when the filter matches no recipe');
  const emptyFn = js.match(/function setWorkshopBoardEmpty\(empty\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(emptyFn, /document\.querySelector\('#academy-workshop-empty'\);\s*\n\s*if \(!node\)[\s\S]*?throw new Error/, 'setWorkshopBoardEmpty fails fast on missing empty-state markup (no silent blank table)');
  assert.match(js, /function resetWorkshopFilter\(\)[\s\S]*?workshopFilter\.category = WORKSHOP_FILTER_ALL;[\s\S]*?workshopFilter\.tier = WORKSHOP_FILTER_ALL;[\s\S]*?workshopFilter\.element = WORKSHOP_FILTER_ALL;/, 'resetWorkshopFilter resets all three axes (a fresh arrival is すべて on every axis)');
  assert.match(js, /if \(resetFilter\) resetWorkshopFilter\(\);/, 'refreshWorkshopScreen resets every filter axis on a fresh arrival (resetFilter)');

  // ROW: buildWorkshopRow is pure DOM assembly over an ALREADY-VALIDATED normalized recipe — one aligned 7-column
  // record (種別・属性・T・基礎効果・素材・金額・出来栄え見込み), built from the shared workshopArrivalClient label
  // helpers (no private translation). Unaffordable rows are disabled (non-interactive); only affordable rows wire
  // the craft click. The row shows the S-derived 出来栄え見込み (outlook) — NEVER a confirmed quality (the arrival
  // withholds it), so the row builder never consults workshopQualityLabel (which is popup-only, post-craft).
  const rowFn = js.match(/function buildWorkshopRow\(recipe\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(rowFn, '', 'buildWorkshopRow should exist (the card grid is now an aligned table row)');
  assert.match(rowFn, /button\.disabled = !recipe\.affordable;/, 'unaffordable rows are disabled (never fire a craft)');
  assert.match(rowFn, /if \(recipe\.affordable\) \{[\s\S]*?button\.addEventListener\('click', \(\) => craftWorkshopRecipe\(recipe\)\.catch\(reportWorkshopScreenError\)\)/, 'only affordable rows wire the craft handler, and a failed craft surfaces through the workshop reporter (no silent retry)');
  assert.match(rowFn, /workshopKindLabelFull\(recipe\)/, 'the 種別 cell uses the shared kind/weapon_type label helper (no private translation)');
  assert.match(rowFn, /workshopElementLabel\(recipe\.element\)/, 'the 属性 cell uses the shared element label helper');
  assert.match(rowFn, /`T\$\{recipe\.tier\}`/, 'the T cell shows the tier');
  assert.match(rowFn, /for \(const effect of recipe\.base_effects\) effectsCell\.append\(workshopEffectChip\(effect\)\)/, 'the 基礎効果 cell renders the recipe base-effect chips');
  assert.match(rowFn, /（所持 \$\{cost\.held\}）/, 'each material cost row shows the held quantity alongside the required amount');
  assert.match(rowFn, /workshopCostRow\([\s\S]*?cost\.short\)/, 'material rows pass their short flag to the shared cost-row helper (the 不足 affordance)');
  assert.match(rowFn, /outlookCell\.dataset\.band = String\(recipe\.outlook\.band\);[\s\S]*?outlookCell\.textContent = recipe\.outlook\.label;/, 'the 出来栄え見込み cell shows the S-derived outlook label with its band (the header labels the column), never a confirmed quality');
  assert.doesNotMatch(rowFn, /workshopQualityLabel/, 'the row never renders the confirmed quality (the arrival withholds it — quality is popup-only, post-craft)');
  // data-short marking lives in the shared cost-row helper (materials and money reuse it).
  const costRowFn = js.match(/function workshopCostRow\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(costRowFn, /if \(short\) row\.dataset\.short = 'true';/, 'insufficient cost rows are marked (data-short) for the 不足 affordance');

  // CRAFT: POST /api/workshop/craft { recipe_id } (a single call, NOT a conversation); the response is resolved
  // AGAINST the selected recipe (crafted recipe id + item identity must match — a divergence fail-fasts), the
  // authoritative state is adopted, and the result popup floats.
  const craftFn = js.match(/async function craftWorkshopRecipe\(recipe\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(craftFn, '', 'craftWorkshopRecipe should exist');
  assert.match(craftFn, /postJson\('\/api\/workshop\/craft', \{ recipe_id: recipe\.recipe_id \}\)/, 'the card selection crafts the recipe over POST /api/workshop/craft');
  assert.doesNotMatch(craftFn, /\/api\/interaction\/start|\/api\/errand\/start|\/stream/, 'the workshop craft is a single call (no conversation / interaction start / stream)');
  assert.match(craftFn, /const \{ state, display \} = resolveWorkshopCraft\(response, recipe\);/, 'the craft response is resolved against the selected recipe (fail-fast on missing fields / an identity divergence)');
  assert.match(craftFn, /currentRuntimeState = state;/, 'the post-craft state is adopted from the validated response');
  assert.match(craftFn, /openWorkshopResultPopup\(display\);/, 'a successful craft floats the result popup with the RESOLVED display (name/flavor from the response)');
  // FAIL-FAST: craftWorkshopRecipe does NOT catch/swallow its own failures — they reject to the click handler's
  // `.catch(reportWorkshopScreenError)`; only the in-flight reset + the crafting-busy clear run in finally (materials
  // stay unconsumed).
  assert.doesNotMatch(craftFn, /catch \(/, 'craftWorkshopRecipe does not catch/swallow its own failures (they reject and surface through the click handler)');
  assert.match(craftFn, /\} finally \{[\s\S]*?workshopCraftInFlight = false;/, 'craftWorkshopRecipe only resets the in-flight guard in finally (no local error recovery)');
  assert.match(craftFn, /if \(workshopCraftInFlight\) \{[\s\S]*?showProcessingToast\(\);[\s\S]*?return;/, 'a double craft is guarded by the in-flight flag');
  // IN-SCREEN CRAFT BUSY: the workshop is a stay screen (no transition to a loading screen), so the LM-backed craft
  // wait is covered in place — setWorkshopCrafting(true) BEFORE the POST floats the 銘を刻んでいる… overlay and marks
  // the board busy, and the finally clears it on every outcome (success → the result popup floats; failure → the
  // status-line error) so the overlay never lingers.
  assert.match(craftFn, /setWorkshopCrafting\(true\);[\s\S]*?postJson\('\/api\/workshop\/craft'/, 'the craft busy state is shown BEFORE the craft POST (the wait is covered in screen, not left on a frozen board)');
  assert.match(craftFn, /\} finally \{[\s\S]*?workshopCraftInFlight = false;[\s\S]*?setWorkshopCrafting\(false\);/, 'the craft busy state is cleared in finally regardless of outcome (no lingering overlay)');
  const craftingSetterFn = js.match(/function setWorkshopCrafting\(active\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(craftingSetterFn, '', 'setWorkshopCrafting should exist');
  assert.match(craftingSetterFn, /board\.dataset\.crafting = 'true';[\s\S]*?board\.append\(buildWorkshopCraftingIndicator\(\)\)/, 'the busy setter marks the board (data-crafting) and floats the crafting overlay when active');
  assert.match(craftingSetterFn, /delete board\.dataset\.crafting;[\s\S]*?existing\.remove\(\)/, 'the busy setter clears the board marker and removes the overlay when inactive (no residue)');
  const craftingBuilderFn = js.match(/function buildWorkshopCraftingIndicator\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(craftingBuilderFn, /academy-workshop-crafting-orbits[\s\S]*?academy-workshop-crafting-dot[\s\S]*?label\.textContent = '銘を刻んでいる…'/, 'the crafting overlay mirrors the errand 生成中 grammar (orbits + non-color dots + the 銘を刻んでいる… label)');

  // STAY: acknowledging the result closes the popup and RE-FETCHES the board (held/affordable changed) — it is NOT
  // a navigation (the workshop is a stay-and-craft screen; leaving is the separate 「工房を出る」).
  const ackFn = js.match(/function acknowledgeWorkshopResult\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(ackFn, '', 'acknowledgeWorkshopResult should exist');
  assert.match(ackFn, /hideWorkshopResultPopup\(\);[\s\S]*?return refreshWorkshopScreen\(\);/, 'acknowledging the result closes the popup and re-fetches the board (stay-and-craft)');
  assert.doesNotMatch(ackFn, /navigateToPostContentScreen/, 'acknowledging a craft does NOT navigate away — the player stays in the workshop');
  assert.match(js, /document\.querySelector\('#academy-workshop-result-close'\)\.addEventListener\('click', \(\) => acknowledgeWorkshopResult\(\)\.catch\(reportWorkshopScreenError\)\)/, 'the acknowledge button is wired to the stay-and-refetch handler');

  // EXIT: 「工房を出る」 returns to the hub via the HELD server-authoritative post_content_screen through the shared
  // loading-covered path (押下→ロード画面→迎え会話ストリーミング開始でハブ表示 — no bare enterRoutingHub under the
  // still-visible workshop screen, which reads as a freeze). A double press is guarded by the shared in-flight
  // flag; a missing held screen fails fast (no fabricated default). This is the always-available way out
  // (reachable with zero crafts).
  const exitFn = js.match(/async function exitWorkshop\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(exitFn, '', 'exitWorkshop should exist (async)');
  assert.match(exitFn, /if \(routingContentReturnInFlight\) \{[\s\S]*?showProcessingToast\(\);[\s\S]*?return;[\s\S]*?\}/, 'a double 工房を出る is guarded by the shared routing-content-return in-flight flag (no second hub return starts)');
  assert.match(exitFn, /const nextScreen = workshopExitScreen;[\s\S]*?if \(typeof nextScreen !== 'string' \|\| nextScreen === ''\) \{[\s\S]*?throw new Error[\s\S]*?\}[\s\S]*?routingContentReturnInFlight = true;[\s\S]*?await returnToRoutingHubFromContent\(nextScreen\)/, 'the exit uses the held server-authoritative post_content_screen, fails fast when it is missing, and returns to the hub through the shared loading-covered path');
  assert.match(exitFn, /\} finally \{[\s\S]*?routingContentReturnInFlight = false;[\s\S]*?\}/, 'the in-flight flag is released in finally');
  // The exit does NOT use navigateToPostContentScreen (its interaction branch is a bare enterRoutingHub with no
  // loading screen — the freeze). It goes through the loading-covered returnToRoutingHubFromContent instead.
  assert.doesNotMatch(exitFn, /navigateToPostContentScreen/, 'the workshop exit goes through the loading-covered shared path, not the bare-enterRoutingHub navigateToPostContentScreen (no freeze)');
  assert.match(js, /document\.querySelector\('#academy-workshop-exit'\)\.addEventListener\('click', \(\) => exitWorkshop\(\)\.catch\(reportWorkshopScreenError\)\)/, 'the 「工房を出る」 button is wired to the exit handler (rejections surface through the workshop reporter)');
});

test('workshop arrival CSS: dedicated obsidian+amber token layer, framed stage image (border-box, no board overlap), viewport-fit + internal scroll, aligned subgrid table, scroll-independent crafting overlay, [hidden] guard, token-only rows, filter/exit, result popup (style.css)', async () => {
  const css = await readFile(`${root}/style.css`, 'utf8');

  // Dedicated obsidian+amber token layer (the conversation-day 黒夜 language), not borrowed from the alchemy /
  // errand / routing / conversation-day layers.
  const screenCss = cssRuleBlock(css, '.academy-workshop-screen');
  assert.match(screenCss, /--workshop-bg-0:[\s\S]*--workshop-ink:[\s\S]*--workshop-amber:/, 'the workshop screen defines its own obsidian / ink / amber token layer');
  assert.doesNotMatch(screenCss, /--alchemy-|--errand-|--routing-|--cd-night-/, 'the workshop token layer does not redefine or borrow the --alchemy-* / --errand-* / --routing-* / --cd-night-* layers');

  // New 構図: the frame is a 2-column / 2-row grid — the 1:1 stage-image column spans both rows on the left, and the
  // right column holds the filter/exit controls (top row) over the recipe board (bottom row). The stage is a 1:1
  // square sized by the --workshop-stage-size token; a narrow viewport degrades to a single-column vertical stack.
  assert.match(screenCss, /--workshop-stage-size:/, 'the workshop screen declares the 1:1 stage column size token');
  const frameCss = cssRuleBlock(css, '.academy-workshop-frame');
  assert.match(frameCss, /display:\s*grid;/, 'the workshop frame is a grid (1:1 stage column + controls/board column)');
  assert.match(frameCss, /grid-template-columns:\s*var\(--workshop-stage-size\) minmax\(0, 1fr\);/, 'the workshop frame places the 1:1 stage column left of the right controls/board column');
  assert.match(frameCss, /grid-template-rows:\s*auto minmax\(0, 1fr\);/, 'the workshop right column is a controls row over a board row');
  const stageCss = cssRuleBlock(css, '.academy-workshop-stage');
  assert.match(stageCss, /aspect-ratio:\s*1 \/ 1;/, 'the workshop stage image column is a 1:1 square');
  assert.match(stageCss, /grid-row:\s*1 \/ span 2;/, 'the workshop stage spans both right-column rows on the left');
  // Overlap fix (root cause): the stage is box-sizing:border-box, so its padding + border stay INSIDE the
  // --workshop-stage-size column instead of spilling ~padding+border px into the board column (the reported
  // "stage image overlaps the recipe list"). A content-box stage overflows the column and covers the board.
  assert.match(stageCss, /box-sizing:\s*border-box;/, 'the workshop stage is border-box so its padding/border stay within the stage column (no spill over the board — the overlap fix)');
  const controlsCss = cssRuleBlock(css, '.academy-workshop-controls');
  assert.match(controlsCss, /grid-column:\s*2;[\s\S]*?grid-row:\s*1;/, 'the workshop filter/exit controls sit in the top-right row');
  // The 「工房を出る」 exit is pinned to the screen's top-right corner: the controls bar does not wrap (so the exit
  // never drops below the filters) and top-aligns its children — top-right of the frame's top-right cell = the
  // screen's top-right. The filter/exit flex sizing is asserted where those rules are read below.
  assert.match(controlsCss, /flex-wrap:\s*nowrap;/, 'the controls bar does not wrap, so the exit stays on the top row (never drops below the filters)');
  assert.match(controlsCss, /align-items:\s*flex-start;/, 'the controls bar top-aligns its children so the exit sits at the top-right corner');
  assert.match(controlsCss, /justify-content:\s*space-between;/, 'the controls bar pushes the exit to the right of the filter block');
  const boardPlacementCss = cssRuleBlock(css, '.academy-workshop-board');
  assert.match(boardPlacementCss, /grid-column:\s*2;[\s\S]*?grid-row:\s*2;/, 'the workshop recipe board sits in the bottom-right row');
  assert.match(css, /@media \(max-width: 820px\) \{\s*\n\s*\.academy-workshop-frame \{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/, 'a narrow viewport degrades the workshop frame to a single-column vertical stack');

  // The background image is the screen's face — a framed stage image (token-veiled), corner ornaments over it.
  const stageImageCss = cssRuleBlock(css, '.academy-workshop-stage-image');
  assert.notEqual(stageImageCss, '', 'the .academy-workshop-stage-image rule should exist');
  assert.match(stageImageCss, /url\('\/canonical\/workshop\/stage\.jpg'\)/, 'the stage image paints the new 1:1 canonical workshop stage image');
  assert.match(stageImageCss, /var\(--workshop-veil-strong\)/, 'the stage image veil consumes a --workshop-* token (legibility wash, no literal color)');
  // The corner ornaments (conversation-day corner_02 family) hug the stage frame corners over the image.
  const stageBeforeCss = cssRuleBlock(css, '.academy-workshop-stage::before,\n.academy-workshop-stage::after');
  assert.match(stageBeforeCss, /url\('\/canonical\/conversation_day\/ui\/corner_02\.png'\)/, 'the stage frame carries the conversation-day corner_02 ornament over the image (shared 黒夜 corner grammar)');

  // The id-scoped [hidden] guard (keeps the status line, result popup, and filtered-out cards hidden).
  assert.match(css, /#academy-workshop-screen \[hidden\] \{\s*\n\s*display: none;/, 'the workshop screen carries the id-scoped [hidden] guard');

  // Viewport-fit + internal-scroll (the play-screen height constraint pattern). The board is a NON-scrolling frame
  // (overflow:hidden) and the inner .academy-workshop-table owns the scroll — so the crafting overlay (a child of
  // the board) covers the visible frame and stays in view regardless of scroll position.
  assert.match(css, /body:has\(#academy-workshop-screen\.active\) \.layout \{[\s\S]*?height: calc\(100dvh - var\(--runtime-topbar-height, 88px\)\);[\s\S]*?overflow: hidden;/, 'the workshop layout uses the play-screen viewport-height constraint so the dense board scroll resolves');
  // Direct-background (いきなり背景) standard: the layout has NO padding, so the flat obsidian screen fills it
  // edge-to-edge with no inset that would reveal the body's navy gradient as a border — no window-on-a-gradient
  // reading (the conversation-day daytime screen uses the same padding:0).
  assert.match(css, /body:has\(#academy-workshop-screen\.active\) \.layout \{[\s\S]*?padding: 0;[\s\S]*?\}/, 'the workshop layout has padding:0 so the flat background fills the screen edge-to-edge (no gradient border / floating window)');
  const boardCss = cssRuleBlock(css, '.academy-workshop-board');
  assert.match(boardCss, /min-height:\s*0;[\s\S]*?overflow:\s*hidden;/, 'the workshop board is a non-scrolling frame (the crafting overlay covers its visible viewport)');
  const tableCss = cssRuleBlock(css, '.academy-workshop-table');
  assert.match(tableCss, /min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/, 'the inner table owns the internal scroll (fixed-height absorb, no page growth)');
  // Aligned-column table: the table is the master grid on the shared --workshop-row-grid template, and the header
  // row + every recipe row are subgrids of it — so the columns line up exactly top-to-bottom (independent per-row
  // grids drift; subgrid removes that).
  assert.match(tableCss, /grid-template-columns:\s*var\(--workshop-row-grid\);/, 'the table declares the shared 7-column template (the master grid the header + rows subgrid off)');
  assert.match(screenCss, /--workshop-row-grid:/, 'the workshop screen declares the shared row/column-template geometry token');
  const headRowCss = cssRuleBlock(css, '.academy-workshop-head-row');
  assert.match(headRowCss, /grid-template-columns:\s*subgrid;/, 'the sticky header row is a subgrid of the table (its columns match the rows)');
  assert.match(headRowCss, /position:\s*sticky;[\s\S]*?top:\s*0;/, 'the column-header row is sticky so the labels stay visible while the rows scroll');

  // Test-by-token: the recipe row + the filter chip + the exit button consume var(--workshop-*) / shared tokens,
  // no literal pin. The row is a full-bleed subgrid so its cells line up under the header columns.
  const rowCss = cssRuleBlock(css, '.academy-workshop-row-button');
  assert.match(rowCss, /grid-template-columns:\s*subgrid;/, 'the recipe row is a subgrid of the table (its cells line up under the header columns)');
  assert.match(rowCss, /background:\s*var\(--workshop-card\);/, 'the row background consumes the workshop card token');
  assert.doesNotMatch(rowCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the row rule has no literal color pin (token-only)');
  const exitCss = cssRuleBlock(css, '.academy-workshop-exit');
  assert.notEqual(exitCss, '', 'the .academy-workshop-exit rule should exist');
  assert.doesNotMatch(exitCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the exit button rule has no literal color pin (token-only)');
  assert.match(exitCss, /flex:\s*0 0 auto;/, 'the exit is a fixed-size item that never shrinks or wraps off the top-right corner');
  // The 3 filter groups (種別 × ティア × 属性) sit together in a flex wrapper; the empty-state message spans the
  // table columns and consumes a --workshop-* token (no literal color pin).
  const filtersCss = cssRuleBlock(css, '.academy-workshop-filters');
  assert.notEqual(filtersCss, '', 'the .academy-workshop-filters wrapper rule should exist');
  assert.match(filtersCss, /display:\s*flex;/, 'the three filter groups lay out together (flex, wrapping)');
  assert.match(filtersCss, /flex:\s*1 1 auto;/, 'the filter block takes the remaining width, keeping the exit pinned to the top-right');
  const emptyCss = cssRuleBlock(css, '.academy-workshop-empty');
  assert.notEqual(emptyCss, '', 'the .academy-workshop-empty rule should exist');
  assert.match(emptyCss, /grid-column:\s*1 \/ -1;/, 'the empty-state message spans every table column under the sticky header');
  assert.match(emptyCss, /color:\s*var\(--workshop-ink-dim\);/, 'the empty-state message consumes a --workshop-* ink token');
  assert.doesNotMatch(emptyCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the empty-state rule has no literal color pin (token-only)');

  // The in-flight craft overlay + busy state consume var(--workshop-*) / shared shape tokens only (no literal pin) —
  // the same test-by-token discipline as the rows, in the workshop token layer. It is absolutely positioned over
  // the non-scrolling board (inset:0), so 銘を刻んでいる… stays fully in view no matter how far the list is scrolled.
  const craftingCss = cssRuleBlock(css, '.academy-workshop-crafting');
  assert.notEqual(craftingCss, '', 'the .academy-workshop-crafting overlay rule should exist');
  assert.match(craftingCss, /position:\s*absolute;[\s\S]*?inset:\s*0;/, 'the crafting overlay covers the board frame (inset:0 over the non-scrolling board — scroll-independent visibility)');
  assert.match(craftingCss, /background:\s*var\(--workshop-veil-strong\);/, 'the crafting overlay veil consumes a --workshop-* token');
  assert.doesNotMatch(craftingCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the crafting overlay rule has no literal color pin (token-only)');
  const craftingDotCss = cssRuleBlock(css, '.academy-workshop-crafting-dot');
  assert.match(craftingDotCss, /background:\s*var\(--workshop-amber\);/, 'the crafting pulse dots consume the workshop amber token (no literal color)');
  assert.doesNotMatch(craftingDotCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the crafting dot rule has no literal color pin (token-only)');

  // The result popup is a scrimmed on-screen overlay consuming the workshop scrim token (no literal pin).
  const popupCss = cssRuleBlock(css, '.academy-workshop-result-popup');
  assert.notEqual(popupCss, '', 'the .academy-workshop-result-popup rule should exist');
  assert.match(popupCss, /background:\s*var\(--workshop-result-scrim\);/, 'the result popup scrim consumes a --workshop-* token');
});

test('library arrival screen is a dedicated no-tab search-driven stay screen with a 1:1 stage image, four rotated corner ornaments, a theme search + exit, a shelf board, and a 見開き reading view (index.html + app.js)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  const block = html.match(/<section id="academy-library-screen"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.notEqual(block, '', 'a dedicated #academy-library-screen section should exist');
  assert.match(block, /class="screen academy-library-screen"/, 'the library screen carries its own screen class');
  assert.match(block, /id="academy-library-title"/, 'the arrival carries a heading');
  assert.match(block, /id="academy-library-week"/, 'the arrival carries the week counter');
  assert.match(block, /<p id="academy-library-status"[^>]*aria-live="polite" hidden>/, 'the arrival carries a status live region, hidden by default (error banner only)');
  // The 書庫全景 background is the screen's face — a framed 1:1 stage image (aria-hidden), the conversation-day
  // standee-frame grammar, NOT a shell window (night full-screen direct, not a day shell).
  assert.match(block, /<div class="academy-library-stage">\s*\n\s*<div class="academy-library-stage-image" aria-hidden="true">/, 'the arrival carries the framed 書庫全景 stage image layer');
  assert.doesNotMatch(block, /academy-library-shell|academy-library-backdrop/, 'the arrival is the night full-screen-direct frame, not a day shell (no *-shell / backdrop残骸)');
  // Four corner ornaments (the 書庫専用 corner_library.png, one asset rotated for all four corners).
  assert.match(block, /<span class="academy-library-corner academy-library-corner-tl"[^>]*><\/span>[\s\S]*?academy-library-corner-tr[\s\S]*?academy-library-corner-bl[\s\S]*?academy-library-corner-br/, 'the stage carries the four rotated corner ornaments');
  // The テーマ search box + the always-available exit.
  assert.match(block, /<form id="academy-library-search-form"[^>]*>/, 'the arrival carries the theme search form');
  assert.match(block, /<input type="text" id="academy-library-search-input"/, 'the arrival carries the theme search input');
  assert.match(block, /<button type="submit" id="academy-library-search-button"[^>]*>探す<\/button>/, 'the arrival carries the search submit button');
  assert.match(block, /<button type="button" id="academy-library-exit"[^>]*>書庫を出る<\/button>/, 'the arrival carries the explicit 「書庫を出る」 exit (always available — the library needs zero reads to leave)');
  // The shelf board + its empty-state prompt (the 収蔵庫 lives in the hub drawer, not here).
  assert.match(block, /<p id="academy-library-shelf-empty"/, 'the arrival carries the empty-state search prompt');
  assert.match(block, /<ul id="academy-library-shelf"/, 'the arrival carries the shelf list the searched covers render into');
  // The on-screen reading view (the result-popup idiom), hidden by default: a 見開き book frame with a parchment page,
  // the title/category/text, the 蔵書票 (ex libris) stamp, and a close action.
  assert.match(block, /<div id="academy-library-reading-popup"[^>]*hidden[^>]*role="dialog"/, 'the arrival carries the hidden reading view (on-screen modal, not a screen change)');
  assert.match(block, /<div class="academy-library-reading-spread" aria-hidden="true">/, 'the reading view carries the 見開き book spread frame layer');
  assert.match(block, /<h3 id="academy-library-reading-title"/, 'the reading view carries the title node');
  assert.match(block, /<p id="academy-library-reading-category"/, 'the reading view carries the category node');
  assert.match(block, /<div id="academy-library-reading-text"/, 'the reading view carries the fragment text body');
  assert.match(block, /<span id="academy-library-reading-stamp"/, 'the reading view carries the 蔵書票 (ex libris) stamp element for the 収蔵 flourish');
  assert.match(block, /<button type="button" id="academy-library-reading-close"[^>]*>本を閉じる<\/button>/, 'the reading view carries the close action that runs the 収蔵 flourish');

  // Registered screen + the showScreen fetch hook; no tab (no-tab content screen).
  assert.match(js, /'academy-library': document\.querySelector\('#academy-library-screen'\)/, 'academy-library is a registered screen');
  assert.match(js, /if \(name === 'academy-library'\) refreshLibraryScreen\(\)\.catch\(reportLibraryScreenError\);/, 'showScreen fetches the arrival envelope when the library screen opens');
  assert.doesNotMatch(html, /data-screen="academy-library"/, 'the library arrival screen has no tab (no-tab content screen)');
  // The status line is the required error surface, so a missing status node is broken wiring → throw.
  assert.match(js, /function setLibraryScreenStatus\([\s\S]*?const status = document\.querySelector\('#academy-library-status'\);\s*\n\s*if \(!status\) \{[\s\S]*?throw new Error/, 'setLibraryScreenStatus fails fast on missing status markup (no silent suppression of the error surface)');

  // Dev entry: ?initialScreen=academy-library shows the arrival (the fetch is routing + save gated).
  assert.match(js, /function requestedInitialAcademyLibrary\(\)[\s\S]*?get\('initialScreen'\) === 'academy-library'/, 'the dev entry reads ?initialScreen=academy-library');
  assert.match(js, /if \(requestedInitialAcademyLibrary\(\)\) \{ showScreen\('academy-library'\); return; \}/, 'the initial-screen override displays the library arrival screen');
});

test('library search/read stay flow fail-fast, mirror the dispatch map, cover every LLM wait with an in-screen busy, commit reads to the 収蔵庫, and leave via the server-authoritative exit (app.js + routingDispatchClient.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const dispatchClient = await readFile(path.join(root, 'routingDispatchClient.js'), 'utf8');

  // The dispatch mirror maps the library destination to the academy-library screen (mirrors the backend target).
  assert.match(dispatchClient, /library: 'academy-library'/, 'the dispatch mirror maps the library destination to the academy-library screen');
  assert.match(js, /'academy-library': document\.querySelector\('#academy-library-screen'\)/, 'the library dispatch destination reaches a real registered screen');

  // ARRIVAL: GET /api/library carries only the week + server-authoritative exit; the shelf is cleared BEFORE the
  // fetch (fail closed: a failed re-entry leaves no stale, still-clickable covers), and the exit is held for 「書庫を出る」.
  const refreshFn = js.match(/async function refreshLibraryScreen\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(refreshFn, '', 'refreshLibraryScreen should exist (async)');
  assert.match(refreshFn, /clearLibraryShelf\(\);[\s\S]*?getJson\('\/api\/library'\)/, 'the arrival clears the shelf BEFORE fetching (fail closed)');
  assert.match(refreshFn, /const \{ week, postContentScreen \} = validateLibraryArrivalPayload\(payload\);/, 'the whole arrival payload is validated fail-fast (week / exit) before the header is set');
  assert.match(refreshFn, /libraryExitScreen = postContentScreen;/, 'the server-authoritative exit is held for 「書庫を出る」 (no frontend-hardcoded default)');
  assert.match(refreshFn, /第\$\{conversationStageWeek\(week\)\}週/, 'the week header reuses the shared conversationStageWeek (no fabricated week)');

  // Dispatch to library is NOT special-cased in navigateToPostContentScreen — it flows through the generic loading
  // interstitial → showScreen('academy-library'), the same navigation the other content dispatches use.
  const navFn = js.match(/async function navigateToPostContentScreen\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(navFn, '', 'navigateToPostContentScreen should exist');
  assert.doesNotMatch(navFn, /academy-library/, 'academy-library is not special-cased in navigateToPostContentScreen (dispatch reaches the arrival through the generic loading → showScreen path)');

  // SEARCH: POST /api/library/search { theme }. An empty theme is a visible prompt (no POST); the LLM wait is covered
  // by the board busy shown BEFORE the POST; a failed search REJECTS (no self-catch) and only the busy/in-flight clear
  // runs in finally. A double submit is guarded by the in-flight flag.
  const searchFn = js.match(/async function searchLibrary\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(searchFn, '', 'searchLibrary should exist (async)');
  assert.match(searchFn, /if \(!theme\) \{[\s\S]*?setLibraryScreenStatus\([\s\S]*?return;/, 'an empty theme shows a visible prompt and issues no search POST');
  assert.match(searchFn, /if \(librarySearchInFlight\) \{[\s\S]*?showProcessingToast\(\);[\s\S]*?return;/, 'a double search is guarded by the in-flight flag');
  assert.match(searchFn, /setLibraryBusy\(true, '司書が奥の書架を探している…'\);[\s\S]*?postJson\('\/api\/library\/search', \{ theme \}\)/, 'the search busy is shown BEFORE the search POST (the LLM wait is covered in screen)');
  assert.match(searchFn, /\} finally \{[\s\S]*?librarySearchInFlight = false;[\s\S]*?setLibraryBusy\(false\);/, 'the search busy + in-flight guard are cleared in finally regardless of outcome');
  assert.doesNotMatch(searchFn, /catch \(/, 'searchLibrary does not catch/swallow its own failures (they reject and surface through the reporter)');

  // READ: POST /api/library/read (catalog=book_id, generated=generated_title). The periphery/generated LLM wait is
  // covered by the same board busy shown BEFORE the POST; on success the reading view floats; a failed read REJECTS
  // (nothing consumed — the shelf is still valid) with only the busy/in-flight clear in finally. Single-flight guarded.
  const readFn = js.match(/async function readLibraryBook\(book\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(readFn, '', 'readLibraryBook should exist (async)');
  assert.match(readFn, /if \(libraryReadInFlight\) \{[\s\S]*?showProcessingToast\(\);[\s\S]*?return;/, 'a double read is guarded by the in-flight flag');
  assert.match(readFn, /setLibraryBusy\(true, '司書が写しを綴じている…'\);[\s\S]*?postJson\('\/api\/library\/read', book\.target\)/, 'the read busy covers the periphery/generated LLM wait BEFORE the read POST');
  assert.match(readFn, /openLibraryReadingPopup\(reading\);/, 'a successful read floats the reading view with the validated fragment');
  assert.match(readFn, /\} finally \{[\s\S]*?libraryReadInFlight = false;[\s\S]*?setLibraryBusy\(false\);/, 'the read busy + in-flight guard are cleared in finally regardless of outcome');
  assert.doesNotMatch(readFn, /catch \(/, 'readLibraryBook does not catch/swallow its own failures (they reject and surface through the reporter)');

  // The busy overlay is a single covered board state (setLibraryBusy) mirroring the workshop 銘を刻んでいる… grammar.
  const busySetterFn = js.match(/function setLibraryBusy\(active, label = ''\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(busySetterFn, '', 'setLibraryBusy should exist');
  assert.match(busySetterFn, /board\.dataset\.busy = 'true';[\s\S]*?board\.append\(buildLibraryBusyIndicator\(label\)\)/, 'the busy setter marks the board (data-busy) and floats the busy overlay when active');
  assert.match(busySetterFn, /delete board\.dataset\.busy;[\s\S]*?existing\.remove\(\)/, 'the busy setter clears the board marker and removes the overlay when inactive (no residue)');

  // SHELF: the search result is flattened fail-fast — catalog books keep their layer (core=革装 / periphery=布装 cover)
  // and read by book_id; generated + free books use the 無銘の写本 cover and read by generated_title.
  const shelfFn = js.match(/function validateLibrarySearchShelf\(result\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(shelfFn, '', 'validateLibrarySearchShelf should exist');
  assert.match(shelfFn, /cover: layer,[\s\S]*?target: \{ book_id:/, 'catalog books carry their layer cover + book_id read target');
  assert.match(shelfFn, /cover: 'generated', target: \{ generated_title: title \}/, 'generated + free books carry the 写本 cover + generated_title read target');
  // One shelf card picks its 装丁 by layer (data-cover) with the title overlaid, and clicking reads it.
  const cardFn = js.match(/function buildLibraryBookCard\(book\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(cardFn, '', 'buildLibraryBookCard should exist');
  assert.match(cardFn, /item\.dataset\.cover = book\.cover;/, 'the cover 装丁 is chosen by the book layer (data-cover)');
  assert.match(cardFn, /button\.addEventListener\('click', \(\) => readLibraryBook\(book\)\.catch\(reportLibraryScreenError\)\)/, 'clicking a cover reads the book (rejections surface through the reporter)');

  // 収蔵 flourish (本を閉じる): the read already committed to the 収蔵庫 server-side, so closing is a pure presentation
  // step — the stamp animation plays and animationend hides the view, and prefers-reduced-motion omits it (closes at
  // once), so the close never depends on an animation a reduced-motion user has turned off.
  const collectFn = js.match(/function collectAndCloseLibraryReading\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(collectFn, '', 'collectAndCloseLibraryReading should exist');
  assert.match(collectFn, /prefers-reduced-motion: reduce[\s\S]*?hideLibraryReadingPopup\(\);[\s\S]*?return;/, 'reduced-motion omits the 収蔵 flourish and closes at once');
  assert.match(collectFn, /stamp\.addEventListener\('animationend', \(\) => hideLibraryReadingPopup\(\), \{ once: true \}\);[\s\S]*?popup\.dataset\.collecting = 'true';/, 'otherwise the stamp animation plays and animationend closes the view (no timer)');

  // EXIT: 「書庫を出る」 returns to the hub via the HELD server-authoritative post_content_screen through the shared
  // loading-covered path (not the bare-enterRoutingHub navigateToPostContentScreen). A double press is guarded; a
  // missing held screen fails fast (no fabricated default). Always available (reachable with zero reads).
  const exitFn = js.match(/async function exitLibrary\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(exitFn, '', 'exitLibrary should exist (async)');
  assert.match(exitFn, /if \(routingContentReturnInFlight\) \{[\s\S]*?showProcessingToast\(\);[\s\S]*?return;[\s\S]*?\}/, 'a double 書庫を出る is guarded by the shared routing-content-return in-flight flag');
  assert.match(exitFn, /const nextScreen = libraryExitScreen;[\s\S]*?if \(typeof nextScreen !== 'string' \|\| nextScreen === ''\) \{[\s\S]*?throw new Error[\s\S]*?\}[\s\S]*?routingContentReturnInFlight = true;[\s\S]*?await returnToRoutingHubFromContent\(nextScreen\)/, 'the exit uses the held server-authoritative post_content_screen, fails fast when missing, and returns through the shared loading-covered path');
  assert.doesNotMatch(exitFn, /navigateToPostContentScreen/, 'the library exit goes through the loading-covered shared path, not the bare-enterRoutingHub navigateToPostContentScreen (no freeze)');

  // Wiring: the search form submits (preventDefault), the close runs the flourish, and the exit is handled.
  assert.match(js, /document\.querySelector\('#academy-library-search-form'\)\.addEventListener\('submit',/, 'the search form submit is wired');
  assert.match(js, /document\.querySelector\('#academy-library-reading-close'\)\.addEventListener\('click', \(\) => collectAndCloseLibraryReading\(\)\)/, 'the close button runs the 収蔵 flourish');
  assert.match(js, /document\.querySelector\('#academy-library-exit'\)\.addEventListener\('click', \(\) => exitLibrary\(\)\.catch\(reportLibraryScreenError\)\)/, 'the 「書庫を出る」 button is wired to the exit handler');
});

test('library arrival CSS: dedicated ink-and-leather --library-* token layer, framed 1:1 stage image (border-box) with four rotated corner ornaments, viewport-fit + internal scroll, layer-picked 3:4 covers, in-screen busy, and a warm-parchment 見開き reading view with a 収蔵 stamp flourish (style.css)', async () => {
  const css = await readFile(`${root}/style.css`, 'utf8');

  // Dedicated ink-and-leather (obsidian + amber) token layer, not borrowed from the workshop / alchemy / errand /
  // routing / conversation-day layers.
  const screenCss = cssRuleBlock(css, '.academy-library-screen');
  assert.match(screenCss, /--library-bg-0:[\s\S]*--library-ink:[\s\S]*--library-amber:/, 'the library screen defines its own obsidian / ink / amber token layer');
  assert.doesNotMatch(screenCss, /--workshop-|--alchemy-|--errand-|--routing-|--cd-night-/, 'the library token layer does not redefine or borrow the --workshop-* / --alchemy-* / --errand-* / --routing-* / --cd-night-* layers');
  assert.match(screenCss, /--library-stage-size:/, 'the library screen declares the 1:1 stage column size token');
  assert.match(screenCss, /--library-parchment:[\s\S]*--library-parchment-ink:/, 'the reading page declares its warm 生成り parchment + 鉄褐色 ink tokens (程々の明度, 明暗反転)');

  // 2-column / 2-row frame: the 1:1 stage column left, the search/exit controls over the shelf on the right.
  const frameCss = cssRuleBlock(css, '.academy-library-frame');
  assert.match(frameCss, /grid-template-columns:\s*var\(--library-stage-size\) minmax\(0, 1fr\);/, 'the library frame places the 1:1 stage column left of the right controls/shelf column');
  assert.match(frameCss, /grid-template-rows:\s*auto minmax\(0, 1fr\);/, 'the library right column is a controls row over a shelf row');
  const stageCss = cssRuleBlock(css, '.academy-library-stage');
  assert.match(stageCss, /aspect-ratio:\s*1 \/ 1;/, 'the library stage image column is a 1:1 square');
  assert.match(stageCss, /grid-row:\s*1 \/ span 2;/, 'the library stage spans both right-column rows on the left');
  assert.match(stageCss, /box-sizing:\s*border-box;/, 'the library stage is border-box so its padding/border stay within the stage column (no spill over the shelf)');
  assert.match(css, /@media \(max-width: 820px\) \{\s*\n\s*\.academy-library-frame \{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/, 'a narrow viewport degrades the library frame to a single-column vertical stack');

  // The stage image is the screen's face — a framed 書庫全景 (token-veiled), corner ornaments over it.
  const stageImageCss = cssRuleBlock(css, '.academy-library-stage-image');
  assert.match(stageImageCss, /url\('\/canonical\/library\/stage\.jpg'\)/, 'the stage image paints the canonical library 書庫全景 stage image');
  assert.match(stageImageCss, /var\(--library-veil-strong\)/, 'the stage image veil consumes a --library-* token (legibility wash, no literal color)');
  // Four corners: the 書庫専用 corner_library.png, the SAME asset rotated for all four (TL 0 / TR 90 / BR 180 / BL 270).
  const cornerCss = cssRuleBlock(css, '.academy-library-corner');
  assert.match(cornerCss, /url\('\/canonical\/library\/corner_library\.png'\)/, 'the corner ornament paints the 書庫専用 corner asset');
  assert.match(cssRuleBlock(css, '.academy-library-corner-tl'), /transform:\s*rotate\(0deg\);/, 'the top-left corner is the un-rotated asset');
  assert.match(cssRuleBlock(css, '.academy-library-corner-tr'), /transform:\s*rotate\(90deg\);/, 'the top-right corner rotates the same asset 90°');
  assert.match(cssRuleBlock(css, '.academy-library-corner-br'), /transform:\s*rotate\(180deg\);/, 'the bottom-right corner rotates the same asset 180°');
  assert.match(cssRuleBlock(css, '.academy-library-corner-bl'), /transform:\s*rotate\(270deg\);/, 'the bottom-left corner rotates the same asset 270°');

  // The id-scoped [hidden] guard (keeps the status line, shelf prompt, and reading view hidden).
  assert.match(css, /#academy-library-screen \[hidden\] \{\s*\n\s*display: none;/, 'the library screen carries the id-scoped [hidden] guard');

  // Viewport-fit + internal-scroll: the board is a NON-scrolling frame (the busy overlay covers it) and the inner
  // shelf owns the scroll.
  assert.match(css, /body:has\(#academy-library-screen\.active\) \.layout \{[\s\S]*?height: calc\(100dvh - var\(--runtime-topbar-height, 88px\)\);[\s\S]*?padding: 0;[\s\S]*?overflow: hidden;/, 'the library layout uses the play-screen viewport-height constraint so the shelf scroll resolves, and is edge-to-edge (padding:0) so the flat obsidian screen fills it with no navy-gradient border inset (direct-background standard)');
  const boardCss = cssRuleBlock(css, '.academy-library-board');
  assert.match(boardCss, /min-height:\s*0;[\s\S]*?overflow:\s*hidden;/, 'the library board is a non-scrolling frame (the busy overlay covers its visible viewport)');
  const shelfCss = cssRuleBlock(css, '.academy-library-shelf');
  assert.match(shelfCss, /overflow-y:\s*auto;/, 'the inner shelf owns the internal scroll (fixed-height absorb, no page growth)');

  // Covers are 3:4 装丁 picked by layer (data-cover), token-only card (no literal color pin).
  assert.match(cssRuleBlock(css, ".academy-library-book[data-cover='core'] .academy-library-cover"), /url\('\/canonical\/library\/cover_core\.jpg'\)/, 'core books use the 革装金箔 cover');
  assert.match(cssRuleBlock(css, ".academy-library-book[data-cover='periphery'] .academy-library-cover"), /url\('\/canonical\/library\/cover_periphery\.jpg'\)/, 'periphery books use the 布装彩色 cover');
  assert.match(cssRuleBlock(css, ".academy-library-book[data-cover='generated'] .academy-library-cover"), /url\('\/canonical\/library\/cover_generated\.jpg'\)/, 'generated / free books use the 無銘の写本 cover');
  const cardCss = cssRuleBlock(css, '.academy-library-book-button');
  assert.match(cardCss, /aspect-ratio:\s*3 \/ 4;/, 'the cover is a 3:4 装丁');
  assert.doesNotMatch(cardCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the cover button rule has no literal color pin (token-only)');

  // In-screen busy overlay (token-only), the same non-color pulse grammar as the workshop overlay.
  const busyCss = cssRuleBlock(css, '.academy-library-busy');
  assert.match(busyCss, /position:\s*absolute;[\s\S]*?inset:\s*0;/, 'the busy overlay covers the board frame (inset:0 over the non-scrolling board — scroll-independent visibility)');
  assert.match(busyCss, /background:\s*var\(--library-veil-strong\);/, 'the busy overlay veil consumes a --library-* token');
  assert.doesNotMatch(busyCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the busy overlay rule has no literal color pin (token-only)');
  assert.match(cssRuleBlock(css, '.academy-library-busy-dot'), /background:\s*var\(--library-amber\);/, 'the busy pulse dots consume the library amber token (no literal color)');

  // Reading view: scrimmed overlay + the 16:10 見開き book frame + the warm 生成り parchment page (明暗反転, 程々の明度).
  assert.match(cssRuleBlock(css, '.academy-library-reading-popup'), /background:\s*var\(--library-reading-scrim\);/, 'the reading view scrim consumes a --library-* token');
  const readingFrameCss = cssRuleBlock(css, '.academy-library-reading-frame');
  assert.match(readingFrameCss, /url\('\/canonical\/library\/book_spread\.jpg'\)/, 'the reading frame is the 16:10 見開き book image');
  assert.match(readingFrameCss, /aspect-ratio:\s*16 \/ 10;/, 'the reading frame keeps the 見開き aspect ratio');
  const pageCss = cssRuleBlock(css, '.academy-library-reading-page');
  assert.match(pageCss, /color:\s*var\(--library-parchment-ink\);/, 'the reading text is 鉄褐色 ink (明暗反転)');
  assert.match(pageCss, /var\(--library-parchment\)/, 'the page ground is the warm 生成り parchment (程々の明度, off pure white)');
  // The 収蔵 stamp is the ex libris asset, and the flourish is a CSS animation attenuated under reduced-motion.
  assert.match(cssRuleBlock(css, '.academy-library-reading-stamp'), /url\('\/canonical\/library\/ex_libris\.png'\)/, 'the 収蔵 stamp paints the ex libris asset');
  assert.match(css, /\.academy-library-reading-popup\[data-collecting='true'\] \.academy-library-reading-stamp \{\s*\n\s*animation:\s*academy-library-collect-stamp/, 'closing the view presses the 蔵書票 stamp in via a CSS animation');
  assert.match(css, /\.academy-library-reading-popup\[data-collecting='true'\] \.academy-library-reading-stamp \{\s*\n\s*animation-duration:\s*120ms;/, 'the 収蔵 flourish is attenuated under reduced-motion');
});

// ── 錬成室 arrival screen: the routing "homunculus" (錬成室) destination's landing surface ─────────────────
// #academy-atelier-screen is a no-tab stay screen (like the workshop / library). A routing dispatch to the
// homunculus destination navigates here through the existing loading interstitial (the mirror
// ROUTING_DISPATCH_SCREENS maps homunculus → academy-atelier); showScreen fetches GET /api/atelier and renders the
// 3 slots / 銘棚 / cost. Synthesis and farewell are LLM-backed and loading-covered; the first conversation enters
// the daytime screen as a pre-started atelier conversation (POST /api/atelier/conversation/start, NOT
// /api/interaction/start). The homunculus is a non-selectable per-slot actor (like the routing persona).

test('atelier arrival screen is a dedicated no-tab stay screen with a 1:1 stage image, four rotated corner ornaments, 3 slots, a 銘棚, a synthesis form + blind confirm, a one-way farewell confirm + speech 見せ場, and a server-authoritative exit (index.html + app.js)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  const block = html.match(/<section id="academy-atelier-screen"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.notEqual(block, '', 'a dedicated #academy-atelier-screen section should exist');
  assert.match(block, /class="screen academy-atelier-screen"/, 'the atelier screen carries its own screen class');
  assert.match(block, /id="academy-atelier-title"/, 'the arrival carries a heading');
  assert.match(block, /id="academy-atelier-week"/, 'the arrival carries the week counter');
  assert.match(block, /<p id="academy-atelier-status"[^>]*aria-live="polite" hidden>/, 'the arrival carries a status live region, hidden by default (error banner only)');

  // The 錬成室全景 background is the screen's face — a framed 1:1 stage image (aria-hidden), the conversation-day
  // standee-frame grammar, NOT a shell window (night full-screen direct).
  assert.match(block, /<div class="academy-atelier-stage">\s*\n\s*<div class="academy-atelier-stage-image" aria-hidden="true">/, 'the arrival carries the framed 錬成室全景 stage image layer');
  assert.doesNotMatch(block, /academy-atelier-shell|academy-atelier-backdrop/, 'the arrival is the night full-screen-direct frame, not a day shell (no *-shell / backdrop残骸)');
  // Four corner ornaments (the 錬成室専用 corner_atelier.png, one asset rotated for all four corners).
  assert.match(block, /<span class="academy-atelier-corner academy-atelier-corner-tl"[^>]*><\/span>[\s\S]*?academy-atelier-corner-tr[\s\S]*?academy-atelier-corner-bl[\s\S]*?academy-atelier-corner-br/, 'the stage carries the four rotated corner ornaments');

  // The 3 slots (うちの子) + 銘棚 containers, the synthesis form (mode radios + name + skeleton + material picker), the
  // blind confirm, the 錬成結果ビュー, the one-way farewell confirm, and the farewell-speech 見せ場.
  assert.match(block, /<ul id="academy-atelier-slots" class="academy-atelier-slots"/, 'the arrival carries the うちの子 slots list');
  assert.match(block, /<ul id="academy-atelier-nameplates" class="academy-atelier-nameplates"/, 'the arrival carries the 銘棚 nameplate list');
  assert.match(block, /<form id="academy-atelier-synthesis-form"/, 'the arrival carries the synthesis form');
  assert.match(block, /name="atelier-mode" value="manual"[\s\S]*?name="atelier-mode" value="omakase"/, 'the synthesis form offers the manual / omakase modes');
  assert.match(block, /id="academy-atelier-name-input"[\s\S]*?id="academy-atelier-skeleton-input"/, 'the synthesis form carries the name + 骨子 inputs');
  // Material picker: the selection list + the running 選択 n / total line (populated by the picker from the arrival
  // materials). The old fixed-cost UI (money / fixed T4×5×3 preview) is gone with no trace.
  assert.match(block, /<ul id="academy-atelier-materials" class="academy-atelier-materials"/, 'the synthesis form carries the material picker list');
  assert.match(block, /id="academy-atelier-materials-total"/, 'the synthesis form carries the running selection total line');
  assert.doesNotMatch(block, /academy-atelier-cost|academy-atelier-name-input.*money|money_owned|money_cost/, 'the old fixed-cost UI (money / affordability) is gone with no trace');
  assert.doesNotMatch(block, /合計ちょうど\d+個/, 'the material picker hint carries no hardcoded required-total literal in markup (populated from the server value)');
  assert.match(block, /id="academy-atelier-confirm-popup"/, 'the arrival carries the blind-confirm dialog');
  // 錬成結果ビュー: the newborn's face + parameter list + consumed-material list.
  assert.match(block, /id="academy-atelier-result-popup"[\s\S]*?id="academy-atelier-result-parameter-list"[\s\S]*?id="academy-atelier-result-consumed-list"/, 'the arrival carries the 錬成結果ビュー with a parameter list + consumed-material list');
  assert.match(block, /id="academy-atelier-farewell-confirm-popup"/, 'the arrival carries the one-way farewell-confirm dialog');
  assert.match(block, /id="academy-atelier-farewell-speech-popup"[\s\S]*?id="academy-atelier-farewell-speech-text"/, 'the arrival carries the farewell-speech 見せ場');

  // Registered screen + the showScreen fetch hook; no tab (no-tab content screen).
  assert.match(js, /'academy-atelier': document\.querySelector\('#academy-atelier-screen'\)/, 'academy-atelier is a registered screen');
  assert.match(js, /if \(name === 'academy-atelier'\) refreshAtelierScreen\(\)\.catch\(reportAtelierScreenError\);/, 'showScreen fetches the arrival envelope when the atelier screen opens');
  assert.doesNotMatch(html, /data-screen="academy-atelier"/, 'the atelier arrival screen has no tab (no-tab content screen)');

  // Dev entry: ?initialScreen=academy-atelier shows the arrival (the fetch is routing + gate gated).
  assert.match(js, /function requestedInitialAcademyAtelier\(\)[\s\S]*?get\('initialScreen'\) === 'academy-atelier'/, 'the dev entry reads ?initialScreen=academy-atelier');
  assert.match(js, /if \(requestedInitialAcademyAtelier\(\)\) \{ showScreen\('academy-atelier'\); return; \}/, 'the initial-screen override displays the atelier arrival screen');
});

test('atelier flow: mirror the dispatch map, fetch + validate the arrival, cover synthesis / farewell LLM waits with the loading screen, enter the first conversation pre-started (NOT /api/interaction/start), gate the 1-visit conversation, and leave via the server-authoritative exit (app.js + routingDispatchClient.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const dispatchClient = await readFile(path.join(root, 'routingDispatchClient.js'), 'utf8');

  // The dispatch mirror maps the homunculus destination to the academy-atelier screen (mirrors the backend target).
  assert.match(dispatchClient, /homunculus: 'academy-atelier'/, 'the dispatch mirror maps the homunculus destination to the academy-atelier screen');
  assert.match(js, /'academy-atelier': document\.querySelector\('#academy-atelier-screen'\)/, 'the atelier dispatch destination reaches a real registered screen');

  // ARRIVAL: GET /api/atelier is validated by the headless-testable validator before any DOM mutation (fail-fast).
  const refreshFn = js.match(/async function refreshAtelierScreen\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(refreshFn, '', 'refreshAtelierScreen should exist (async)');
  assert.match(refreshFn, /getJson\('\/api\/atelier'\)/, 'the arrival fetches GET /api/atelier');
  assert.match(refreshFn, /validateAtelierArrivalPayload\(payload\)/, 'the arrival validates the envelope before rendering');
  assert.match(refreshFn, /atelierExitScreen = view\.postContentScreen/, 'the arrival holds the server-authoritative exit for 錬成室を出る');

  // SYNTHESIS: the LLM-backed 錬成 runs behind the shared loading screen (M-2026-07-06-001), and marks the birthed
  // child so the return plays its birth 演出 + first-conversation 導線. Nothing is consumed on failure.
  const synthFn = js.match(/async function submitAtelierSynthesis\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(synthFn, '', 'submitAtelierSynthesis should exist (async)');
  assert.match(synthFn, /postJson\('\/api\/atelier\/synthesize'/, 'synthesis POSTs /api/atelier/synthesize');
  assert.match(synthFn, /materials: params\.materials/, 'synthesis passes the selected materials [{item_id, quantity}] in the request body');
  assert.match(synthFn, /validateAtelierSynthesisResult\(payload\)/, 'synthesis validates the result');
  assert.match(synthFn, /showAcademyLoadingScreenUntilReady/, 'the synthesis wait is covered by the shared loading screen');
  assert.match(synthFn, /pendingBirthHomunculusId = result\.homunculus\.homunculus_id/, 'a successful synthesis marks the birthed child for the birth 演出');
  assert.match(synthFn, /openAtelierSynthesisResult\(result\)/, 'a successful synthesis opens the 錬成結果ビュー');

  // MATERIAL PICKER: the form renders the 24-material selection, and the submit is gated by isAtelierSelectionComplete
  // (exact total + within held); the old cost/money renderer is gone with no trace.
  const openFormFn = js.match(/function openAtelierSynthesisForm\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(openFormFn, /atelierMaterialSelection = \{\}/, 'opening the form resets the material selection');
  assert.match(openFormFn, /renderAtelierMaterialPicker\(atelierArrivalView\)/, 'opening the form renders the material picker from the held arrival view');
  const pickerFn = js.match(/function updateAtelierMaterialPicker\(view\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(pickerFn, '', 'updateAtelierMaterialPicker should exist');
  assert.match(pickerFn, /選択 \$\{total\} \/ \$\{view\.requiredMaterialTotal\}/, 'the picker shows the running 選択 n / required-total line');
  assert.match(pickerFn, /isAtelierSelectionComplete\(\{[\s\S]*?requiredTotal: view\.requiredMaterialTotal[\s\S]*?\}\)/, 'the submit is enabled only for a complete selection (exact total + within held)');
  const submitFormFn = js.match(/function submitAtelierSynthesisForm\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(submitFormFn, /atelierSelectionMaterials\(atelierMaterialSelection\)/, 'the form flattens the selection into the synthesize materials list');
  assert.doesNotMatch(js, /renderAtelierSynthesisCost|formatAtelierMoney|academy-atelier-cost/, 'the old cost/money renderer is gone with no trace');
  // The required total is never re-defined as a frontend literal: the picker's hint reads view.requiredMaterialTotal at render.
  const renderPickerFn = js.match(/function renderAtelierMaterialPicker\(view\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(renderPickerFn, /academy-atelier-materials-hint'\)\.textContent = `[^`]*\$\{view\.requiredMaterialTotal\}/, 'the picker hint restates the required total from the server value (no double-defined literal)');

  // PARAMETERS: the active slot and the 錬成結果ビュー both render the child's 11 parameters (label + value from the
  // server-normalized shape via atelierParameterRows — no frontend label map).
  assert.match(js, /function atelierParameterListItems\(parameters\)[\s\S]*?atelierParameterRows\(parameters\)/, 'the parameter rows come from the server shape (atelierParameterRows)');
  const slotFn = js.match(/function renderAtelierSlots\(view, birthId\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(slotFn, /renderAtelierParameterList\(entry\.parameters\)/, 'each active slot renders the child parameters');
  const resultFn = js.match(/function openAtelierSynthesisResult\(result\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(resultFn, /atelierParameterListItems\(result\.homunculus\.parameters\)/, 'the result view renders the newborn parameters');
  assert.match(resultFn, /result\.consumedMaterials/, 'the result view lists the consumed materials by display name');

  // FAREWELL: the LLM-backed お別れ runs behind the loading screen, then reveals the farewell-speech 見せ場.
  const farewellFn = js.match(/async function submitAtelierFarewell\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(farewellFn, '', 'submitAtelierFarewell should exist (async)');
  assert.match(farewellFn, /postJson\('\/api\/atelier\/farewell'/, 'farewell POSTs /api/atelier/farewell');
  assert.match(farewellFn, /showAcademyLoadingScreenUntilReady/, 'the farewell wait is covered by the loading screen');
  assert.match(farewellFn, /openAtelierFarewellSpeech\(farewell\)/, 'the farewell reveals the send-off speech 見せ場');

  // FIRST CONVERSATION: a pre-started atelier conversation (POST start + adopt response), NOT the /api/interaction/start path.
  const startFn = js.match(/async function startAtelierConversation\(homunculusId\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(startFn, '', 'startAtelierConversation should exist (async)');
  assert.match(startFn, /postJson\('\/api\/atelier\/conversation\/start'/, 'the first conversation POSTs /api/atelier/conversation/start');
  assert.doesNotMatch(startFn, /\/api\/interaction\/start/, 'the atelier conversation is pre-started (never calls /api/interaction/start)');
  assert.match(startFn, /nextScreen: 'conversation-day'/, 'the pre-started conversation lands on the daytime conversation screen');
  assert.match(startFn, /registerAtelierActorVisual\(parsed\.homunculus\)/, 'the homunculus non-selectable actor visual is registered from the start response');
  assert.match(startFn, /revealResultSequentially\(conversationDayStage\.surface, payload\)/, 'the server-built opening is revealed on the daytime surface');

  // 1 visit = 1 conversation: a spent visit disables the 会いに行く action (visible note, not silently hidden).
  assert.match(js, /if \(view\.conversationSpent\) \{[\s\S]{0,240}talk\.disabled = true;/, 'a spent visit disables the 会いに行く action');
  // max_active comes from the response (not a hardcoded 3 in the slot loop).
  assert.match(js, /for \(let index = 0; index < view\.maxActive; index \+= 1\)/, 'the slot row renders view.maxActive slots (no frontend-hardcoded 3)');

  // The atelier conversation carries its id on each daytime turn (the backend routes it by that id).
  assert.match(js, /else if \(isActiveAtelierConversation\(\)\) body\.id = activeAtelierConversationId;/, 'the daytime turn carries the atelier conversation id');
  // The homunculus visual resolves through the non-selectable actor registry (before the selectable roster).
  assert.match(js, /\?\? atelierActorById\(characterId\)/, 'the daytime speaker face resolves the homunculus actor before the selectable roster');

  // EXIT: 錬成室を出る leaves through the held server-authoritative post_content_screen.
  const exitFn = js.match(/async function exitAtelier\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(exitFn, '', 'exitAtelier should exist (async)');
  assert.match(exitFn, /returnToRoutingHubFromContent\(nextScreen\)/, 'the exit returns through the shared routing content return');
  assert.match(exitFn, /atelierExitScreen/, 'the exit uses the held post_content_screen');

  // The daytime stage frame + detail popup carry the atelier branch (錬成室 1:1 stage image, no standee).
  assert.match(js, /const ATELIER_SCENE_STAGE_IMAGE_URL = '\/canonical\/atelier\/stage\.jpg';/, 'the atelier scene 1:1 stage image url is the canonical atelier/stage.jpg constant');
  assert.match(js, /if \(isActiveAtelierConversation\(\)\) \{[\s\S]{0,260}ATELIER_SCENE_STAGE_IMAGE_URL/, 'the daytime stage frame / popup shows the 錬成室 1:1 stage image during an atelier conversation');
});

// ── 錬成室会話の actor ドリフト修正 ─────────────────────────────────────────────────────────────────
// Regression guard for the reported 実プレイ bug: after the first non-terminal 錬成室 daytime turn ran the
// post-turn refresh(), refreshCharacters() rewrote the homunculus actor to the roster head (character_001 /
// セラ) — the chat rows re-rendered as セラ, the end request 409'd (active atelier conversation actor
// mismatch), and the failed end ejected to the routing hub showing the pre-錬成室 hub history. The three fixes
// (single preservation predicate, pre-clear end-request snapshot, conversation-kind-discriminated failure
// destination) are frontend-only; the backend non-interference guard is correct and unchanged.
test('錬成室会話 actor drift fix: refreshCharacters preserves the live homunculus across a post-turn refresh, the end request is built from a pre-clear snapshot with an explicit conversation id, and a failed content end stays on the conversation screen (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const fn = (name) => {
    const match = js.match(new RegExp(`\\n(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`));
    if (!match) throw new Error(`function not found in app.js: ${name}`);
    return match[0];
  };

  // FIX 1 — single non-selectable-actor predicate + post-turn-refresh preservation.
  // refreshCharacters()' roster-head reset (selectableCharacters[0] = character_001 / セラ) is gated behind
  // ONE predicate, so a live homunculus is preserved the same way a routing persona / creature already was —
  // and a future non-selectable actor kind is added in exactly one place (structural re-fix of this class of
  // bug). The predicate resolves a live homunculus through atelierActorById (the same registry that renders
  // the daytime speaker face), a creature through isCreatureActorId, and the routing persona inside a live hub.
  const predicate = fn('isNonSelectableActiveActorId');
  assert.match(predicate, /isRoutingHubActive\(\) && characterId === ROUTING_PERSONA_CHARACTER_ID/, 'the predicate preserves the routing persona inside a live hub');
  assert.match(predicate, /isCreatureActorId\(characterId\)/, 'the predicate preserves a confirmed creature actor');
  assert.match(predicate, /atelierActorById\(characterId\)/, 'the predicate preserves a live 錬成室 homunculus actor (the drift fix)');
  assert.match(fn('refreshCharacters'), /if \(!isNonSelectableActiveActorId\(activeCharacterId\)\) \{\s*\n\s*activeCharacterId = selectableCharacters\[0\]\?\.character_id/, 'refreshCharacters gates the roster-head reset behind the single non-selectable-actor predicate, so a post-turn refresh no longer overwrites the homunculus with セラ');
  // The post-turn refresh is the exact trigger: a non-terminal daytime turn runs await refresh() (→
  // refreshCharacters). This is the code path the fix protects; asserting it keeps the regression anchored.
  assert.match(fn('runConversationDayConversation'), /await refresh\(\);/, 'the non-terminal daytime turn runs the post-turn refresh() that used to drift the actor');
  // atelierActorById only resolves while the atelier conversation is live and the id matches, so preservation
  // is scoped: it never keeps a stale homunculus after the conversation is deliberately cleared.
  assert.match(fn('atelierActorById'), /if \(!isActiveAtelierConversation\(\) \|\| !activeAtelierActor\) return null;\s*\n\s*if \(activeAtelierActor\.character_id !== characterId\) return null;\s*\n\s*return activeAtelierActor;/, 'the homunculus actor registry resolves only while its atelier conversation is live and the id matches (scoped preservation)');

  // FIX 2 — end request built from a pre-clear identity snapshot with an explicit atelier conversation id.
  // The actor id, atelier conversation id, and hub/atelier kind are captured BEFORE clearVisibleConversation()
  // nulls the atelier id / actor, so the end request never rebuilds from the post-clear (or refresh-drifted)
  // global actor, and a 錬成室 end sends its own conversation id explicitly instead of leaning on the server's
  // last_conversation_id fallback.
  const endFn = fn('endRoutingConversation');
  assert.match(endFn, /const hubActive = isRoutingHubActive\(\);\s*\n\s*const endingAtelierConversation = isActiveAtelierConversation\(\);\s*\n\s*const atelierConversationId = endingAtelierConversation \? activeAtelierConversationId : null;\s*\n\s*const endActorId = endingAtelierConversation \? activeAtelierActor\.character_id : activeCharacterId;\s*\n\s*clearVisibleConversation\(\);/, 'the end-request identity is snapshotted before clearVisibleConversation() destroys the atelier id / actor');
  assert.match(endFn, /const endBody = \{ character_id: endActorId, provider \};\s*\n\s*if \(hubActive && !isRoutingGraduationGuideActive\(\)\) endBody\.wrap_up = 'title';[\s\S]*?if \(endingAtelierConversation\) endBody\.conversation_id = atelierConversationId;/, 'the end body uses the snapshotted actor id, gates wrap_up on the snapshotted hub kind (and off during the graduation guide week), and sends the atelier conversation id explicitly');
  // The end request must not reconstruct the actor from the live global at request-build time.
  const endBodyBlock = endFn.match(/const endBody = \{[\s\S]*?const endRequest = postJson/)?.[0] ?? '';
  assert.notEqual(endBodyBlock, '', 'the end body construction block should exist');
  assert.doesNotMatch(endBodyBlock, /character_id: activeCharacterId/, 'the end body no longer rebuilds character_id from the mutable global activeCharacterId');

  // FIX 3 — the failed-end recovery destination is discriminated by the (snapshotted) conversation kind: a hub
  // end failure returns to the routing hub; a content-return end failure (錬成室 / errand / study circle) stays
  // on the conversation-day screen with the cause on its status line, instead of the old unconditional
  // showScreen('routing-hub') that surfaced the pre-content hub history as if it were live.
  assert.match(endFn, /if \(settingsRedirectErrorMessage\(error\) == null\) \{[\s\S]*?if \(hubActive\) \{\s*\n\s*showScreen\('routing-hub'\);\s*\n\s*routingHubStage\.setStatus\(errorDisplayMessage\(error\), \{ tone: 'error' \}\);\s*\n\s*\} else \{\s*\n\s*showScreen\('conversation-day'\);\s*\n\s*conversationDayStage\.setStatus\(errorDisplayMessage\(error\), \{ tone: 'error' \}\);\s*\n\s*\}/, 'a failed hub end returns to the routing hub; a failed content-return end stays on the conversation-day screen with the cause on its status line (no unconditional hub eject)');
  const catchBlock = endFn.match(/\} catch \(error\) \{[\s\S]*?\} finally \{/)?.[0] ?? '';
  assert.notEqual(catchBlock, '', 'the end catch block should exist');
  assert.doesNotMatch(catchBlock, /settingsRedirectErrorMessage\(error\) == null\) \{\s*\n\s*showScreen\('routing-hub'\)/, 'the failure recovery is no longer an unconditional showScreen(routing-hub)');
});

test('atelier arrival CSS: dedicated 冷たい月光の実験室 --atelier-* token layer, framed 1:1 stage image (border-box) with four rotated + offset-calibrated corner ornaments, a birth 演出 with reduced-motion fallback, and token-only slots / 銘棚 / dialogs (style.css)', async () => {
  const css = await readFile(`${root}/style.css`, 'utf8');

  // Dedicated 冷たい月光の実験室 (obsidian-indigo + mercury + afterglow) token layer, not borrowed from the deep-night
  // academy / library / workshop / alchemy / errand / routing / conversation-day layers.
  const screenCss = cssRuleBlock(css, '.academy-atelier-screen');
  assert.notEqual(screenCss, '', 'the .academy-atelier-screen rule should exist');
  assert.match(screenCss, /--atelier-bg-0:[\s\S]*--atelier-ink:[\s\S]*--atelier-glow:/, 'the atelier screen defines its own obsidian / mercury / afterglow token layer');
  assert.doesNotMatch(screenCss, /--am-night-|--library-|--workshop-|--alchemy-|--errand-|--routing-|--cd-night-/, 'the atelier token layer does not redefine or borrow the other screen layers');
  assert.match(screenCss, /--atelier-stage-size:/, 'the atelier screen declares the 1:1 stage column size token');
  assert.match(screenCss, /--atelier-corner-tl-dx:\s*0px;/, 'the atelier screen declares the corner calibration offsets (real declaration, initial 0px)');
  assert.match(screenCss, /background:\s*var\(--atelier-bg-0\);/, 'the screen fills with its own ground token');

  // Viewport-fit + internal-scroll, and edge-to-edge (padding:0) so the flat obsidian screen fills the layout with no
  // navy-gradient border inset behind it (the direct-background いきなり背景 standard the errand & dungeon screens use).
  assert.match(css, /body:has\(#academy-atelier-screen\.active\) \.layout \{[\s\S]*?height: calc\(100dvh - var\(--runtime-topbar-height, 88px\)\);[\s\S]*?padding: 0;[\s\S]*?overflow: hidden;/, 'the atelier layout is edge-to-edge (padding:0) so the flat obsidian screen fills it with no navy-gradient border inset (direct-background standard)');

  // The framed 1:1 stage image references atelier/stage.jpg under an --atelier-* veil (test-by-token, no literal color).
  const stageImageCss = cssRuleBlock(css, '.academy-atelier-stage-image');
  assert.match(stageImageCss, /url\('\/canonical\/atelier\/stage\.jpg'\)/, 'the stage image references the canonical atelier/stage.jpg');
  assert.match(stageImageCss, /var\(--atelier-veil-strong\)/, 'the stage image veil consumes an --atelier-* token');
  assert.doesNotMatch(stageImageCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the stage image rule has no literal color pin (token-only)');

  // Four corners = one corner_atelier.png rotated per corner, each translated by its calibration offset custom property.
  const cornerCss = cssRuleBlock(css, '.academy-atelier-corner');
  assert.match(cornerCss, /url\('\/canonical\/atelier\/corner_atelier\.png'\)/, 'the corner ornament references the canonical corner_atelier.png');
  assert.match(cssRuleBlock(css, '.academy-atelier-corner-tl'), /translate\(var\(--atelier-corner-tl-dx\), var\(--atelier-corner-tl-dy\)\) rotate\(0deg\)/, 'the TL corner consumes its offset custom properties + 0° rotation');
  assert.match(cssRuleBlock(css, '.academy-atelier-corner-tr'), /rotate\(90deg\)/, 'the TR corner is the same asset rotated 90°');
  assert.match(cssRuleBlock(css, '.academy-atelier-corner-br'), /rotate\(180deg\)/, 'the BR corner is the same asset rotated 180°');
  assert.match(cssRuleBlock(css, '.academy-atelier-corner-bl'), /rotate\(270deg\)/, 'the BL corner is the same asset rotated 270°');

  // Test-by-token: the slot card / talk accent / nameplate consume var(--atelier-*) with NO literal color pin.
  const slotCss = cssRuleBlock(css, '.academy-atelier-slot');
  assert.match(slotCss, /background:\s*var\(--atelier-card\);/, 'the slot card consumes an --atelier-* token');
  assert.doesNotMatch(slotCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the slot card rule has no literal color pin (token-only)');

  // The 3 枠 spend the whole board width: an auto-fit grid collapses the phantom tracks past the fixed slot count
  // (auto-fill left the 1–3 slots huddled in the left columns), and each slot is a vertical card (head → the
  // full-width 11-parameter grid → actions), NOT the old face|body flex split that squeezed the parameters.
  const slotsCss = cssRuleBlock(css, '.academy-atelier-slots');
  assert.match(slotsCss, /grid-template-columns:\s*repeat\(auto-fit,/, 'the slot row is an auto-fit grid so the fixed slot count spends the full width (no phantom auto-fill tracks)');
  assert.match(slotCss, /display:\s*grid;/, 'the slot card is a vertical grid (head → parameters → actions)');
  assert.doesNotMatch(css, /\.academy-atelier-slot-body\b/, 'the old face|body flex split is gone with no trace (the parameter grid now spans the full card width)');
  const talkCss = cssRuleBlock(css, '.academy-atelier-slot-talk');
  assert.match(talkCss, /background:\s*var\(--atelier-glow\);/, 'the 会いに行く accent consumes the afterglow token');
  assert.doesNotMatch(talkCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the 会いに行く accent rule has no literal color pin (token-only)');
  const nameplateCss = cssRuleBlock(css, '.academy-atelier-nameplate');
  assert.match(nameplateCss, /url\('\/canonical\/atelier\/nameplate\.png'\)/, 'the 銘板 references the canonical nameplate.png texture');
  assert.doesNotMatch(nameplateCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the 銘板 rule has no literal color pin (token-only)');
  const openCss = cssRuleBlock(css, '.academy-atelier-synthesize-open');
  assert.match(openCss, /background:\s*var\(--atelier-glow\);/, 'the 新たに錬成する accent consumes the afterglow token');
  assert.doesNotMatch(openCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the 新たに錬成する rule has no literal color pin (token-only)');

  // Birth 演出: a one-shot residual-glow keyframe with a prefers-reduced-motion static fallback.
  assert.match(css, /@keyframes atelier-birth \{/, 'the birth 演出 keyframe is defined');
  assert.match(css, /\.academy-atelier-slot--birthing \{\s*\n\s*animation:\s*atelier-birth/, 'the birthed slot runs the birth 演出 animation');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.academy-atelier-slot--birthing \{\s*\n\s*animation:\s*none;/, 'reduced motion drops the birth 演出 to a static ring');

  // The old fixed-cost styling is gone with no trace; the new material picker / parameter / result rules are token-only.
  assert.doesNotMatch(css, /\.academy-atelier-cost/, 'the old fixed-cost CSS is gone with no trace');
  const materialCss = cssRuleBlock(css, '.academy-atelier-material');
  assert.match(materialCss, /background:\s*var\(--atelier-card\);/, 'the material picker row consumes an --atelier-* token');
  assert.doesNotMatch(materialCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the material picker row rule has no literal color pin (token-only)');
  const stepCss = cssRuleBlock(css, '.academy-atelier-material-step');
  assert.match(stepCss, /color:\s*var\(--atelier-ink-strong\);/, 'the stepper button consumes an --atelier-* token');
  assert.doesNotMatch(stepCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the stepper button rule has no literal color pin (token-only)');
  const totalCompleteCss = cssRuleBlock(css, '.academy-atelier-materials-total--complete');
  assert.match(totalCompleteCss, /color:\s*var\(--atelier-glow-strong\);/, 'the complete-selection total consumes the bright afterglow token');
  const parameterCss = cssRuleBlock(css, '.academy-atelier-parameter');
  assert.match(parameterCss, /color:\s*var\(--atelier-ink\);/, 'the parameter row consumes an --atelier-* token');
  assert.doesNotMatch(parameterCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the parameter row rule has no literal color pin (token-only)');
  // The 11 keys fold into a compact auto-fit grid of stacked cells (label over bar+value), instead of 11 tall
  // 3-column rows that overflowed a narrow slot; the bar is an appearance-reset <meter> reading on the cold
  // --atelier-meter-* ramp (not the native green/amber/red meter).
  const parametersCss = cssRuleBlock(css, '.academy-atelier-parameters');
  assert.match(parametersCss, /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(/, 'the parameter grid is a compact auto-fit multi-column grid (not 11 full-width rows)');
  assert.match(parameterCss, /grid-template-areas:/, 'each parameter cell stacks the label over the bar+value row');
  const meterCss = cssRuleBlock(css, '.academy-atelier-parameter-meter');
  assert.match(meterCss, /appearance:\s*none/, 'the parameter bar resets the native meter appearance so it reads on the atelier palette');
  assert.match(meterCss, /background:\s*var\(--atelier-meter-track\);/, 'the parameter bar track consumes the --atelier-meter-* ramp token');
  assert.doesNotMatch(meterCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the parameter bar rule has no literal color pin (token-only)');
  const consumedCss = cssRuleBlock(css, '.academy-atelier-result-consumed-item');
  assert.match(consumedCss, /background:\s*var\(--atelier-chip\);/, 'the consumed-material chip consumes an --atelier-* token');
  assert.doesNotMatch(consumedCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'the consumed-material chip rule has no literal color pin (token-only)');
});
