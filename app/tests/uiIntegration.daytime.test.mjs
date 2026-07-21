import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runtimePublicReferenceRoot, runtimeSourceReferenceRoot, projectRoot } from './testPaths.mjs';
import { readUiSource, cssRuleBlock, assertBigframeShell, assertNoCoolOrSoftBorderToken } from './fixtures/uiSource.mjs';

const root = runtimePublicReferenceRoot;
const sourceRoot = runtimeSourceReferenceRoot;
const readFile = readUiSource;

test('daytime conversation screen is a dedicated screen with its own daytime shell, category rail, and info popup (index.html)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const block = html.match(/<section id="conversation-day-screen"[\s\S]*?<\/section>\s*\n\s*<\/main>/)?.[0] ?? '';
  assert.notEqual(block, '', 'a dedicated #conversation-day-screen section should exist as the last screen before </main>');

  // Daytime backdrop: static background image, a light-motes canvas, floating decor PNGs.
  assert.match(block, /class="conversation-day-background"/, 'the daytime screen carries its own daytime background layer');
  assert.match(block, /<canvas id="conversation-day-motes"/, 'the daytime screen carries a light-motes ambient canvas');
  assert.match(block, /src="\/canonical\/conversation_day\/decor\/decor_01\.png"[\s\S]*decor_02\.png[\s\S]*decor_03\.png/, 'the daytime screen places the three generated floating decor PNGs');

  // Subtle top week + moon phase.
  assert.match(block, /id="conversation-day-moon-phase"[\s\S]*id="conversation-day-week"/, 'the topbar carries the moon-phase glyph and the week counter');

  // Left category rail: the six confirmed categories (self/buddy/enemy/inventory/money + diary), each with its
  // generated daytime icon.
  for (const category of ['self', 'buddy', 'enemy', 'inventory', 'money', 'diary']) {
    assert.match(block, new RegExp(`data-day-category="${category}"[\\s\\S]*?src="/canonical/conversation_day/icons/${category}\\.png"`), `the ${category} category button carries its generated daytime icon`);
  }

  // The standee frame's sole content is the current conversation's STAGE image button (no persona standee, no
  // speaker caption): a clickable image (→ stage-detail popup) inside the same .conversation-day-standee-frame.
  assert.match(block, /<div class="conversation-day-standee-frame">\s*\n\s*<button type="button" id="conversation-day-stage-image" class="conversation-day-stage-image" aria-label="舞台の詳細を見る"><\/button>\s*\n\s*<\/div>/, 'the standee frame holds the clickable stage image (no persona standee element inside)');
  assert.doesNotMatch(block, /id="conversation-day-standee"|id="conversation-day-speaker-name"/, 'the persona standee image and the speaker caption are gone (the frame shows the stage image, no text label)');

  // Stage-detail popup: a hidden-toggled daytime modal with a title, a stage image, a description, and a
  // close affordance + backdrop (the same modal流儀 as the info drawer).
  assert.match(block, /<div id="conversation-day-stage-popup" class="conversation-day-stage-popup" hidden>/, 'the stage-detail popup starts hidden (toggled via the hidden attribute)');
  assert.match(block, /class="conversation-day-stage-popup-backdrop" data-day-popup-close="true"/, 'the stage popup has a backdrop-click close affordance');
  assert.match(block, /<button type="button" class="conversation-day-info-popup-close" data-day-popup-close="true" aria-label="閉じる">×<\/button>[\s\S]*id="conversation-day-stage-popup-image"/, 'the stage popup has a close button and a stage image region');
  assert.match(block, /<h3 id="conversation-day-stage-popup-title"[\s\S]*id="conversation-day-stage-popup-image"[\s\S]*id="conversation-day-stage-popup-text"/, 'the stage popup carries a 舞台名 title, a 舞台画像, and a visible_situation text (the legacy stage-detail information items)');

  assert.match(block, /id="conversation-day-message-stream"[^>]*aria-live="polite"/, 'the daytime chat has its own live message stream');
  assert.match(block, /<p id="conversation-day-status"[^>]*aria-live="polite" hidden>/, 'the daytime chat has its own status live region, hidden by default');
  assert.match(block, /<textarea id="conversation-day-input"/, 'the daytime chat has its own composer input');
  assert.match(block, /id="conversation-day-send"[\s\S]*?id="conversation-day-end"/, 'the daytime chat has its own send + end controls (the end button lets the player end the daytime conversation)');
  // The daytime end button wears the same-class secondary bearing as the hub's "今日はここまで" and carries the
  // conversation-end label (a loop-mode character conversation ends back to 自室, so "会話を終える").
  assert.match(block, /<button id="conversation-day-end" type="button" class="conversation-day-action-button conversation-day-action-secondary">会話を終える<\/button>/, 'the daytime end button is a same-class secondary sibling of the send button and reads 会話を終える');

  // Info popup toggled via the hidden attribute (guarded), with a close affordance.
  assert.match(block, /<div id="conversation-day-info-popup" class="conversation-day-info-popup" hidden>/, 'the info popup starts hidden (toggled via the hidden attribute)');
  assert.match(block, /data-day-popup-close="true"/, 'the info popup has a close affordance');
});

test('diary is the sixth info-drawer category — hub roster-pick, daytime partner-only, shared fail-fast fetch (app.js + diaryViewClient.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  // The read + parse contract lives in the headless-tested client module (fail-fast paths unit-tested without a
  // browser); app.js imports it and never re-implements the request path / response validation.
  assert.match(js, /import \{ diaryRequestPath, parseDiaryEntries \} from '\.\/diaryViewClient\.js'/, 'app.js imports the diary request-path + response-parse helpers from the headless client module');

  // The one shared async fetch: request path from the client, non-OK surfaced (never a silent empty diary),
  // entries parsed (in received order — no client re-sort).
  const fetchFn = js.match(/async function fetchCharacterDiary\(characterId\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(fetchFn, '', 'fetchCharacterDiary should exist');
  assert.match(fetchFn, /fetch\(diaryRequestPath\(characterId\)\)/, 'the diary fetch builds its URL through the client request-path helper');
  assert.match(fetchFn, /if \(!response\.ok\) \{[\s\S]*?throw new Error/, 'a non-OK diary response fails fast (no silent empty diary)');
  assert.match(fetchFn, /return parseDiaryEntries\(await response\.json\(\)\)/, 'the response is validated through the client parser (entries in received order)');

  // Both consumers carry diary in their fixed title set + a diary renderer wired into the stage.
  assert.match(js, /const ROUTING_HUB_CATEGORY_TITLES = Object\.freeze\(\{[\s\S]*?diary: '日記'/, 'the routing title set carries the diary category');
  assert.match(js, /const CONVERSATION_DAY_CATEGORY_TITLES = Object\.freeze\(\{[\s\S]*?diary: '日記'/, 'the daytime title set carries the diary category');
  assert.match(js, /diary: \(bodyEl\) => renderRoutingHubDiaryInto\(bodyEl\)/, 'the routing stage wires the diary renderer');
  assert.match(js, /diary: \(bodyEl\) => renderConversationDayDiaryInto\(bodyEl\)/, 'the daytime stage wires the diary renderer');

  // Routing hub: diary opens on a picker that ALSO lists ルミ (the routing persona on the `lina` slot) so her
  // exam / midterm records are readable; a picked cell loads that character's journal, routing a fetch failure to
  // reportError. The daytime (partner-only) diary is a separate renderer and stays unchanged.
  const hubDiaryFn = js.match(/function renderRoutingHubDiaryInto\(bodyEl\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(hubDiaryFn, '', 'renderRoutingHubDiaryInto should exist');
  assert.match(hubDiaryFn, /for \(const character of routingHubDiaryPickerEntries\(\)\)/, 'the hub diary lists the picker entries (ルミ + the selectable roster)');
  assert.match(hubDiaryFn, /routingHubDiaryRosterButton\(bodyEl, character\)/, 'each hub picker cell is a diary picker button');
  // ルミ (lina) is prepended to the picker from the registered routing persona visual (fail-fast if unregistered),
  // so her diary (GET /api/diary accepts 'lina') is reachable from the hub picker.
  const hubPickerEntriesFn = js.match(/function routingHubDiaryPickerEntries\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(hubPickerEntriesFn, '', 'routingHubDiaryPickerEntries should exist');
  assert.match(hubPickerEntriesFn, /\.\.\.routingPersonaActor\(\)[\s\S]*?\.\.\.selectableCharacters/, 'the hub picker prepends the ルミ persona (lina) before the selectable roster');
  assert.match(js, /button\.addEventListener\('click', \(\) => loadRoutingHubDiaryForCharacter\(bodyEl, character\)\.catch\(reportError\)\)/, 'picking a hub roster cell loads that character diary, routing a fetch failure to reportError');

  // Daytime: diary is the CURRENT PARTNER ONLY — no roster picker. The partner is resolved fail-fast from the
  // selectable roster (never the silent activeCharacter() fallback object).
  const dayDiaryFn = js.match(/function renderConversationDayDiaryInto\(bodyEl\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(dayDiaryFn, '', 'renderConversationDayDiaryInto should exist');
  assert.match(dayDiaryFn, /const partner = conversationDayDiaryPartner\(\);/, 'the daytime diary targets the current conversation partner');
  assert.doesNotMatch(dayDiaryFn, /selectableCharacters/, 'the daytime diary never lists the roster (partner-only)');
  const partnerFn = js.match(/function conversationDayDiaryPartner\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(partnerFn, /selectableCharacters\.find\(\(character\) => character\.character_id === activeCharacterId\)/, 'the partner is the active roster character');
  assert.match(partnerFn, /if \(!partner\) \{[\s\S]*?throw new Error/, 'a partner missing from the roster fails fast (no silent activeCharacter fallback)');

  // Chronology: entries are rendered in the received order (backend owns chronology). Neither loader re-sorts.
  const hubLoad = js.match(/async function loadRoutingHubDiaryForCharacter\(bodyEl, character\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  const dayLoad = js.match(/async function loadConversationDayDiaryEntries\(bodyEl, partner\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(hubLoad, /for \(const entry of entries\) \{[\s\S]*?journal\.append\(routingHubDiaryEntry\(entry\)\)/, 'the hub diary renders entries in the received order');
  assert.match(dayLoad, /for \(const entry of entries\) \{[\s\S]*?journal\.append\(conversationDayDiaryEntry\(entry\)\)/, 'the daytime diary renders entries in the received order');
  assert.doesNotMatch(hubLoad, /\.sort\(/, 'the hub diary does not re-sort entries (backend chronology is authoritative)');
  assert.doesNotMatch(dayLoad, /\.sort\(/, 'the daytime diary does not re-sort entries (backend chronology is authoritative)');

  // Zero memories is a legitimate empty state (not an error) on both surfaces.
  assert.match(hubLoad, /if \(entries\.length === 0\) \{[\s\S]*?routingHubInfoEmptyCard\('まだ日記がありません'/, 'the hub diary shows an empty state (not an error) for zero memories');
  assert.match(dayLoad, /if \(entries\.length === 0\) \{[\s\S]*?conversationDayInfoEmptyCard\('まだ日記がありません'/, 'the daytime diary shows an empty state (not an error) for zero memories');

  // Only entry.text is surfaced; raw type / tags metadata never is.
  assert.match(js, /function routingHubDiaryEntry\(entry\) \{[\s\S]*?text\.textContent = entry\.text;[\s\S]*?\n\}/, 'the hub diary entry renders only entry.text');
  assert.match(js, /function conversationDayDiaryEntry\(entry\) \{[\s\S]*?text\.textContent = entry\.text;[\s\S]*?\n\}/, 'the daytime diary entry renders only entry.text');
  assert.doesNotMatch(hubDiaryFn + hubLoad, /entry\.type|entry\.tags/, 'the hub diary never surfaces raw type / tags metadata');
  assert.doesNotMatch(dayDiaryFn + dayLoad, /entry\.type|entry\.tags/, 'the daytime diary never surfaces raw type / tags metadata');
});

test('daytime conversation screen is the second consumer of the shared conversation stage, with a clean chat separate from the shared academy + routing chats (app.js + conversationStage.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  // Registered screen + render hook through the stage (the same wiring the routing hub uses).
  assert.match(js, /'conversation-day': document\.querySelector\('#conversation-day-screen'\)/, 'the daytime screen is a registered screen');
  assert.match(js, /if \(name === 'conversation-day'\) conversationDayStage\.renderScreen\(\);/, 'showScreen renders the daytime screen through the shared stage');
  assert.match(js, /if \(name !== 'conversation-day'\) \{[\s\S]*?conversationDayStage\.stopAmbient\(\);[\s\S]*?conversationDayStage\.closeInfo\(\);/, 'leaving the daytime screen stops its ambient and closes the info drawer');

  // Dedicated stage instance over the #conversation-day-* scope with its own history / surface.
  assert.match(js, /const conversationDayStage = createConversationStage\(\{[\s\S]*?screenSelector: '#conversation-day-screen'/, 'the daytime screen is a consumer of the shared conversation stage (its own #conversation-day-* scoped instance)');
  assert.match(js, /const conversationDayStage = createConversationStage\(\{[\s\S]*?categoryDataKey: 'dayCategory'/, 'the daytime stage is keyed off the data-day-category rail wiring');

  // The end button joins the stage's controlSelectors (disabled during an in-flight turn, exactly as the hub's
  // '#routing-hub-end' does). It ends through the shared daytime end path (endConversationDay), the same path the
  // character-decided cutoff auto-end takes so button end and auto-end behave identically. endConversationDay
  // branches on whether an errand is active: an active errand ends through the routing drain-on-exit path
  // (endRoutingConversation), a non-errand daytime conversation through endConversation — no bespoke errand end
  // wiring, and the branch is defined once (not duplicated in the click handler).
  assert.match(js, /const conversationDayStage = createConversationStage\(\{[\s\S]*?controlSelectors: \['#conversation-day-send', '#conversation-day-end', '#conversation-day-input'\]/, 'the daytime end button is a stage control so it is disabled during an in-flight turn (same as the hub end button)');
  assert.match(js, /document\.querySelector\('#conversation-day-end'\)\.addEventListener\('click', \(\) => \{[\s\S]*?endConversationDay\(\)\.catch\(reportError\);/, 'the daytime end button ends through the shared daytime end path endConversationDay');
  assert.match(js, /function endConversationDay\(options = \{\}\) \{[\s\S]*?if \(isActiveErrandConversation\(\)\) \{[\s\S]*?return endRoutingConversation\(\);[\s\S]*?\}[\s\S]*?return endConversation\(options\);/, 'the shared daytime end path ends an active errand through the routing drain-on-exit (endRoutingConversation) and a non-errand daytime conversation through endConversation, with no duplicated branch logic');

  // 統一出現規律 through the stage's createTurnReveal: player utterance + partner reply revealed as 完成吹き出し
  // 単位, streamed deltas folded into completed 吹き出し (never char by char). The reveal queue / at-bottom /
  // status mechanics are the stage's — not reimplemented in the daytime consumer.
  const turnStreamFn = js.match(/async function runConversationDayTurnStream\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(turnStreamFn, '', 'runConversationDayTurnStream should exist');
  assert.match(turnStreamFn, /const reveal = conversationDayStage\.createTurnReveal\(baseMessages\)/, 'the daytime turn drives the stage reveal queue (mechanic owned by the stage, not reimplemented)');
  assert.match(turnStreamFn, /reveal\.enqueue\(displayMessages\(\[\{ role: 'user', content: playerInput \}\]\)\)/, 'the player utterance is revealed through the same queue as the partner reply');
  assert.match(turnStreamFn, /if \(event === 'assistant_delta'\) \{[\s\S]*?enqueueAssistantSegments\(completedAssistantPrefix\(assistantText\)\)/, 'streamed deltas are folded into 完成した吹き出し単位, never streamed char by char');

  // Character conversation via the shared routing turn body: the /api/conversation/stream body is built through
  // routingTurnRequestBody so its hub/errand mutual exclusion reaches the daytime turn — an ACTIVE ERRAND carries
  // the errand conversation id in body.id (the daytime screen never runs a hub, so the hub id is never set; a
  // non-errand daytime turn stays the ordinary character body byte-for-byte). The daytime turn carries NO routing
  // DESTINATION dispatch (③ climax / performRoutingTurnDispatch / a routing destination / the hub's drain loading
  // screen) — those stay hub-only. The drain-reading-pause it DOES carry is the achievement auto-end, pinned in
  // its own test below (shared DRAIN_READING_PAUSE_MS, achievement_draining, showAchievementDrainLoadingScreen).
  assert.match(turnStreamFn, /const body = routingTurnRequestBody\(\{ player_input: playerInput, provider \}\);/, 'the daytime turn body is built through routingTurnRequestBody so an active errand carries the errand conversation id (a non-errand daytime turn stays the ordinary body)');
  assert.match(turnStreamFn, /routingTurnRequestBody/, 'the daytime turn uses the shared routing turn body helper (hub/errand mutual exclusion — the daytime screen never runs a hub, so only an active errand sets body.id)');
  assert.doesNotMatch(turnStreamFn, /routing_dispatch|performRoutingTurnDispatch|isRoutingTurnDispatch|flashDispatchClimax|showRoutingDrainLoadingScreen/, 'the daytime turn carries none of the hub-specific DESTINATION dispatch mechanics (③ climax / routing dispatch / the hub drain loading screen)');

  // Byte-equivalence guard: the daytime chat does not touch the shared academy chat state (messageHistory /
  // academyChatSurface), so loop / academy conversations stay unchanged.
  const sendFn = js.match(/async function runConversationDayConversation\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(sendFn, '', 'runConversationDayConversation should exist');
  assert.match(sendFn, /const historySnapshot = \[\.\.\.conversationDayStage\.surface\.getHistory\(\)\];[\s\S]*?const inputSnapshot = /, 'the daytime send snapshots history + input before the turn');
  assert.match(sendFn, /catch \(error\) \{[\s\S]*?conversationDayStage\.surface\.setHistory\(historySnapshot\);[\s\S]*?conversationDayStage\.renderStream\(historySnapshot\);[\s\S]*?input\.value = inputSnapshot;/, 'a failed daytime send restores the pre-send history and input over the stage surface');
  assert.doesNotMatch(sendFn, /\bmessageHistory\b/, 'the daytime send must not read or write the shared messageHistory (its own stage surface only)');

  // Character-decided cutoff (continue_conversation === false): the daytime send captures the turn result and,
  // with the same contract as the shared conversation screen (conversationShouldAutoEnd detection + the
  // FINAL_REPLY_AUTO_END_DELAY_MS read wait), auto-ends through the SHARED daytime end path (endConversationDay)
  // — the same errand/loop branch as the end button, so button end and auto-end behave identically. A 継続 true
  // turn is unchanged: it falls through to the normal refresh + stage repaint. The end runs during its own
  // still-in-flight turn, so it opts into allowDuringInFlight, mirroring autoEndConversationAfterFinalReply.
  assert.match(sendFn, /const result = await runConversationDayTurnStream\(\{ playerInput, provider \}\);[\s\S]*?if \(await autoEndConversationDayAfterFinalReply\(result\)\) return;[\s\S]*?await refresh\(\)/, 'the daytime send captures the turn result and auto-finalizes after a false continuation before the normal refresh/repaint (a 継続 true turn is unaffected)');
  assert.match(js, /async function autoEndConversationDayAfterFinalReply\(result\)[\s\S]*?if \(!conversationShouldAutoEnd\(result\)\) return false;[\s\S]*?await sleep\(FINAL_REPLY_AUTO_END_DELAY_MS\)[\s\S]*?await endConversationDay\(\{ allowDuringInFlight: true \}\)/, 'the daytime cutoff auto-end reuses the shared false-continuation detection + readable-reply delay, then ends through the shared daytime end path allowing the still-in-flight turn to close itself');

  // Errand auto-end (the achievement condition was met this turn): the server finalized the errand INSIDE the
  // turn (drain-on-exit), so the turn response already carries the completion (errand_result — reward /
  // record / active-errand clear / post_content_screen). The daytime send consumes that completion BEFORE the
  // cutoff auto-end and before the normal refresh: the achieved errand takes the errand post-content
  // transition, not the loop cutoff path. The completion helper fails fast on a half-signalled response
  // (achievement without completion, or the reverse) and on a missing post-finalization state, then — WITHOUT a
  // second serial read wait (the wrap-up was already held readable by the turn's 達成読みポーズ, pinned below) —
  // returns to the hub through the shared loading-covered hub return (returnToRoutingHubThroughLoadingScreen) —
  // errand is routing-only so post_content_screen is always 'interaction' (fail-fast otherwise) — keeping the
  // allowDuringInFlight opt-in and adding NO second /api/conversation/end round-trip (the server already ran it).
  assert.match(sendFn, /const result = await runConversationDayTurnStream\(\{ playerInput, provider \}\);[\s\S]*?if \(await completeErrandFromTurnResult\(result\)\) return;[\s\S]*?if \(await completeStudyCircleFromTurnResult\(result\)\) return;[\s\S]*?if \(await autoEndConversationDayAfterFinalReply\(result\)\) return;/, 'the daytime send consumes an achieved errand, then study circle, completion before the cutoff auto-end and the normal refresh');
  const errandCompleteFn = js.match(/async function completeErrandFromTurnResult\(result\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(errandCompleteFn, '', 'completeErrandFromTurnResult should exist');
  assert.match(errandCompleteFn, /const hasAchievement = Boolean\(result\?\.errand_achievement\);[\s\S]*?const hasCompletion = Boolean\(result\?\.errand_result\);[\s\S]*?if \(hasAchievement !== hasCompletion\) \{[\s\S]*?throw new Error[\s\S]*?\}[\s\S]*?if \(!hasCompletion\) return false;[\s\S]*?assertDrainedRoutingFinalization\(result\.finalization_status\);[\s\S]*?if \(!result\.state \|\| typeof result\.state !== 'object'\) \{[\s\S]*?throw new Error[\s\S]*?\}[\s\S]*?currentRuntimeState = result\.state;[\s\S]*?clearVisibleConversation\(\);[\s\S]*?if \(result\.post_content_screen !== 'interaction'\) \{[\s\S]*?throw new Error[\s\S]*?\}[\s\S]*?await returnToRoutingHubThroughLoadingScreen\(\{ allowDuringInFlight: true \}\);/, 'the errand completion helper fails fast on a half-signalled response and on a missing post-finalization state, then returns to the hub through the shared loading-covered hub return (allowDuringInFlight, no second end round-trip)');
  // Double-wait removed: the achieved errand path no longer holds a SECOND serial FINAL_REPLY_AUTO_END_DELAY_MS
  // after the result — the 達成読みポーズ inside the turn stream is the single readable wait.
  assert.doesNotMatch(errandCompleteFn, /FINAL_REPLY_AUTO_END_DELAY_MS/, 'the errand completion helper carries no serial FINAL_REPLY_AUTO_END_DELAY_MS wait (the 達成読みポーズ in the turn stream is the only readable wait — the二重待ち is removed)');

  // Opening streams through the shared SSE reveal helper bound to the stage surface (the same path the academy
  // session opening uses) so the loading screen can release at the first assistant event; a non-streaming
  // provider signals stream start immediately and falls back to the ordinary opening endpoint + shared
  // revealResultSequentially over the stage surface.
  assert.match(js, /async function runConversationDayOpeningStream\(\{ characterId = activeCharacterId, provider, onAssistantStreamStart = null \}\)[\s\S]*?runAssistantSseStream\(\{[\s\S]*?surface: conversationDayStage\.surface[\s\S]*?endpoint: '\/api\/conversation\/opening\/stream'[\s\S]*?finalAssistantMode: 'first'[\s\S]*?onAssistantStreamStart[\s\S]*?\}\)/, 'the daytime opening stream reuses the shared SSE reveal helper over the stage surface against the streaming opening endpoint');
  assert.match(js, /async function ensureConversationDayOpening\(\{ onAssistantStreamStart = null \} = \{\}\)[\s\S]*?if \(provider === 'lmstudio'\)[\s\S]*?runConversationDayOpeningStream\(\{ provider, onAssistantStreamStart \}\)[\s\S]*?else[\s\S]*?onAssistantStreamStart\?\.\(\)[\s\S]*?postJson\('\/api\/conversation\/opening', \{ character_id: activeCharacterId, provider \}\)[\s\S]*?revealResultSequentially\(conversationDayStage\.surface, result\)/, 'the daytime opening streams for LM Studio and observes the first assistant event, or (non-streaming provider) signals stream start immediately and reveals the ordinary opening on the stage surface');

  // The daytime landing (academy-map character/creature conversation, day preference — the default) enters the
  // academy-loading interstitial and releases into the daytime screen at the opening's stream start, exactly like
  // the academy session landing. It never flips straight to conversation-day, and it does not wait for the full
  // first reply before switching screens. Both the academy-map path and the山林クリーチャー path reach this same
  // startConversationDay (no per-map implementation), so pinning it here covers both.
  const dayStartFn = js.match(/async function startConversationDay\(characterId\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(dayStartFn, '', 'startConversationDay should exist');
  assert.match(dayStartFn, /postJson\('\/api\/interaction\/start', \{ character_id: characterId, source_type: 'field' \}\)/, 'the daytime landing still starts a field-sourced interaction with the chosen character');
  assert.match(dayStartFn, /const openingStreamStarted = new Promise\(\(resolve\) => \{[\s\S]*?openingStreamStartedResolve = resolve[\s\S]*?\}\)/, 'the daytime landing creates a readiness gate for the opening stream start');
  assert.match(dayStartFn, /ensureConversationDayOpening\(\{ onAssistantStreamStart: markOpeningStreamStarted \}\)/, 'the daytime landing starts the opening while loading and observes the first assistant stream event');
  assert.match(dayStartFn, /Promise\.race\(\[openingStreamStarted, openingPromise\]\)/, 'loading waits for the opening stream to start, or surfaces an opening failure, rather than waiting for the full first reply');
  assert.match(dayStartFn, /showAcademyLoadingScreenUntilReady\(\{[\s\S]*?readiness[\s\S]*?nextScreen: 'conversation-day'[\s\S]*?refreshBeforeNextScreen: false[\s\S]*?\}\)[\s\S]*?await openingPromise/, 'the daytime landing holds the loading screen until stream start, enters conversation-day, and keeps controls disabled until the opening reply finishes');
  assert.doesNotMatch(dayStartFn, /await ensureConversationDayOpening\(\)/, 'the daytime landing must not wait for the full opening response before switching screens');
  // The happy path owns the transition through the loading helper (nextScreen), never a direct bypass showScreen.
  // The ONLY direct showScreen('conversation-day') is the loading-residual error un-strand in the catch, so assert
  // the pre-catch body has none.
  const dayStartBeforeCatch = dayStartFn.split('} catch (error) {')[0];
  assert.doesNotMatch(dayStartBeforeCatch, /showScreen\('conversation-day'\)/, 'the daytime landing happy path must not bypass the loading screen with a direct showScreen to conversation-day (the loading helper owns the transition via nextScreen; the only direct showScreen is the error un-strand)');
  // Fail-fast on a failure (no infinite load, no silent transition): a pre-stream-start failure rejects readiness, and
  // showAcademyLoadingScreenUntilReady's error path (reportLoadingError → settings redirect for LM errors) fires
  // BEFORE showScreen(nextScreen). The daytime landing's catch is a loading-residual un-strand that RE-RAISES (throw
  // error) — it never swallows the failure into a silent transition: for a non-settings failure still on the loader it
  // un-strands to conversation-day with the cause on the status line, then re-raises.
  assert.match(dayStartFn, /\} catch \(error\) \{[\s\S]*?if \(isAcademyLoadingScreenActive\(\) && settingsRedirectErrorMessage\(error\) == null\) \{[\s\S]*?showScreen\('conversation-day'\);[\s\S]*?conversationDayStage\.setStatus\(errorDisplayMessage\(error\), \{ tone: 'error' \}\);[\s\S]*?\}[\s\S]*?throw error;[\s\S]*?\} finally \{/, 'the daytime landing catch un-strands a non-settings failure to conversation-day and RE-RAISES (throw error) — never swallowing it into a silent transition');
  assert.match(dayStartFn, /\} finally \{[\s\S]*?conversationRequestInFlight = false;[\s\S]*?setControlsDisabled\(false\)/, 'the daytime landing releases the request lock and re-enables controls in finally, letting an opening failure propagate to the caller after the un-strand');

  // The standee frame no longer shows a persona standee: it shows the current conversation's STAGE image
  // (driven by renderConversationDayStage), so the stage carries no persona visual and no standee/speaker
  // selectors — renderScreen's standee/speaker blocks become guarded no-ops. The partner face/name still come
  // from assistantIdentity (chat bubbles), unchanged.
  assert.match(js, /const conversationDayStage = createConversationStage\(\{[\s\S]*?personaVisual: \(\) => null,/, 'the daytime stage carries no persona visual (the frame shows the stage image, not a standee)');
  assert.doesNotMatch(js, /const conversationDayStage = createConversationStage\(\{[\s\S]*?standeeSelector:[\s\S]*?\}, \{/, 'the daytime stage config no longer passes a standeeSelector (no persona standee)');
  assert.doesNotMatch(js, /const conversationDayStage = createConversationStage\(\{[\s\S]*?speakerSelector:[\s\S]*?\}, \{/, 'the daytime stage config no longer passes a speakerSelector (no speaker caption)');

  // Stage source + validation: resolved live from currentField (single source of truth, no client stage store),
  // with a SHARED fail-fast (no placeholder) on a missing stage, a missing 舞台名 (display_name), or missing
  // background art — never substituted with a generic label / id / blank (no default-value fallback).
  const stageResolveFn = js.match(/function conversationDayStageLocation\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(stageResolveFn, /currentField\?\.current_location\s*\n?\s*\?\?\s*currentField\?\.locations\?\.find\(\(item\) => item\.id === currentField\?\.state\?\.current_location_id\)/, 'the daytime stage resolves the current conversation stage live from the server-evaluated field (no client stage store)');
  const stageValidateFn = js.match(/function conversationDayResolvedStage\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(stageValidateFn, '', 'conversationDayResolvedStage should exist (shared resolve + validate)');
  assert.match(stageValidateFn, /if \(!location\) \{[\s\S]*?throw new Error/, 'the shared stage validator fails fast on a missing stage (no placeholder)');
  assert.match(stageValidateFn, /if \(typeof location\.display_name !== 'string' \|\| location\.display_name\.trim\(\) === ''\) \{[\s\S]*?throw new Error/, 'the shared stage validator fails fast on a missing 舞台名 (no display_name → id → placeholder fallback)');
  assert.match(stageValidateFn, /if \(!location\.background_url\) \{[\s\S]*?throw new Error/, 'the shared stage validator fails fast on a stage with no background art (no placeholder)');
  const stageRenderFn = js.match(/function renderConversationDayStage\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(stageRenderFn, '', 'renderConversationDayStage should exist');
  assert.match(stageRenderFn, /const location = conversationDayResolvedStage\(\);/, 'the stage render goes through the shared resolve + validate (fail-fast, no placeholder)');
  // The near-square stage frame shows the SQUARE crop, derived mechanically from the wide background_url: keep the
  // exact basename, swap only the directory to /canonical/backgrounds/square/. No per-location map, no existence
  // check, no wide fallback — a missing square crop surfaces as a normal image-load failure.
  const squareStageUrlFn = js.match(/function conversationDaySquareStageUrl\(backgroundUrl\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(squareStageUrlFn, '', 'conversationDaySquareStageUrl should exist (mechanical wide→square URL derivation)');
  assert.match(squareStageUrlFn, /return `\/canonical\/backgrounds\/square\/\$\{backgroundUrl\.slice\(backgroundUrl\.lastIndexOf\('\/'\) \+ 1\)\}`;/, 'the square URL keeps the exact basename and swaps only the directory to /canonical/backgrounds/square/ (closed same-basename derivation)');
  assert.doesNotMatch(squareStageUrlFn, /\bif\s*\(|\?\?|\|\||existsSync/, 'the square derivation carries no conditional branch, per-location map, or wide fallback (a missing square crop is a normal load failure, not a rescued wide image)');
  assert.match(stageRenderFn, /image\.style\.backgroundImage = `url\('\$\{conversationDaySquareStageUrl\(location\.background_url\)\}'\)`;/, 'the stage frame is painted with the SQUARE crop derived from the stage background_url');
  assert.match(stageRenderFn, /image\.setAttribute\('aria-label', `\$\{location\.display_name\}の詳細を見る`\);/, 'the stage image aria-label uses the validated 舞台名 directly (no id / placeholder fallback)');
  // The stage image is repainted after every turn (so a 舞台移動 updates the shown stage) and on landing.
  assert.match(sendFn, /await refresh\(\);\s*\n\s*\/\/[\s\S]*?renderConversationDayStage\(\);/, 'a daytime turn repaints the stage image after refresh (so a stage move updates the shown stage)');
  assert.match(js, /showAcademyLoadingScreenUntilReady\(\{[\s\S]*?nextScreen: 'conversation-day'[\s\S]*?renderConversationDayStage\(\);/, 'the daytime landing paints the stage image after the loading screen switches to conversation-day (the loading helper owns the screen switch via nextScreen)');

  // Stage-detail popup: opens with the legacy stage-detail information items (舞台名 / 舞台画像 / visible_situation)
  // over the same validated stage source, fail-fast (no placeholder) on a missing description, and is dismissed
  // by its close button + backdrop (the same modal流儀 as the info drawer).
  const stagePopupFn = js.match(/function openConversationDayStagePopup\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(stagePopupFn, '', 'openConversationDayStagePopup should exist');
  assert.match(stagePopupFn, /const location = conversationDayResolvedStage\(\);/, 'the stage popup goes through the shared resolve + validate (stage / 舞台名 / background art fail-fast)');
  assert.match(stagePopupFn, /if \(typeof location\.visible_situation !== 'string' \|\| location\.visible_situation\.trim\(\) === ''\) \{[\s\S]*?throw new Error/, 'the stage popup fails fast on a missing/empty visible_situation (no placeholder)');
  assert.match(stagePopupFn, /title\.textContent = location\.display_name;[\s\S]*?text\.textContent = location\.visible_situation;/, 'the stage popup shows the validated 舞台名 title (no id / placeholder fallback) and the visible_situation text (the legacy stage-detail information items)');
  // The stage-detail popup (a 16:9 image region) keeps the WIDE background_url unchanged — only the near-square
  // frame switches to the square crop, so this other background consumer's URL derivation stays byte-identical.
  assert.match(stagePopupFn, /image\.style\.backgroundImage = `url\('\$\{location\.background_url\}'\)`;/, 'the stage-detail popup keeps the WIDE background_url (the square crop is scoped to the near-square stage frame only)');
  assert.match(stagePopupFn, /popup\.hidden = false;/, 'the stage popup is shown by clearing its hidden attribute (the same guarded toggle as the info drawer)');
  assert.match(js, /document\.querySelector\('#conversation-day-stage-image'\)\.addEventListener\('click', \(\) => openConversationDayStagePopup\(\)\);/, 'the stage image click opens the stage-detail popup');
  assert.match(js, /for \(const closer of document\.querySelectorAll\('#conversation-day-stage-popup \[data-day-popup-close\]'\)\) \{[\s\S]*?closeConversationDayStagePopup\(\)/, 'every stage-popup close hook (backdrop + button) dismisses it');
  // The close path fails fast on a missing popup node (broken wiring) rather than silently no-oping — the same
  // explicit node contract as open (no ambiguous continuation).
  const stagePopupCloseFn = js.match(/function closeConversationDayStagePopup\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(stagePopupCloseFn, '', 'closeConversationDayStagePopup should exist');
  assert.match(stagePopupCloseFn, /if \(!popup\) \{[\s\S]*?throw new Error/, 'the stage popup close fails fast on a missing popup node (no silent no-op)');
  assert.doesNotMatch(stagePopupCloseFn, /if \(popup\) popup\.hidden = true;/, 'the stage popup close no longer silently no-ops on a missing popup node');
});

test('daytime achievement auto-end (errand / study circle) holds the shared reading pause concurrently with the backend drain, covers a long drain with the achievement loading screen, and fails fast on a half-signalled stream (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const turnStreamFn = js.match(/async function runConversationDayTurnStream\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(turnStreamFn, '', 'runConversationDayTurnStream should exist');

  // The ~5s read is a SINGLE constant shared with the hub send-off (no 5000 literal double-declaration): the
  // daytime 達成読みポーズ and the hub 見送り読みポーズ consume the same DRAIN_READING_PAUSE_MS.
  assert.match(js, /const DRAIN_READING_PAUSE_MS = 5000;/, 'the reading pause is one 5s constant shared by the hub send-off and the daytime achievement auto-end');
  assert.doesNotMatch(js, /ROUTING_SENDOFF_READING_PAUSE_MS/, 'the old routing-specific reading-pause name is gone (single neutral shared constant)');

  // achievement_draining starts the 達成読みポーズ MID-STREAM (concurrent with the backend completion drain), the
  // exact mirror of the hub's routing_draining → beginSendoffReadingPause. Starting it after the read loop would
  // serialize the read after the result — the 直列 二重待ち this task removes.
  assert.match(turnStreamFn, /if \(event === 'achievement_draining'\) \{\s*\n\s*beginAchievementReadingPause\(data\.kind\);/, 'achievement_draining starts the 達成読みポーズ mid-stream (the kind rides through from the SSE payload) so it overlaps the backend drain');

  // The pause pipeline: drain the wrap-up 吹き出し, drop the responding glow, hold the shared ~5s read, then — only
  // if the drain has not yet delivered the result (and the stream did not fail) — raise the achievement drain
  // loading screen (kind-selected copy). streamFailed suppresses that after an error, mirroring the hub pause.
  const pauseFn = turnStreamFn.match(/function beginAchievementReadingPause\(kind\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.notEqual(pauseFn, '', 'beginAchievementReadingPause should exist inside runConversationDayTurnStream');
  assert.match(pauseFn, /if \(achievementReadingPause\) return;/, 'the 達成読みポーズ starts at most once per turn');
  assert.match(pauseFn, /await reveal\.drain\(\);[\s\S]*?conversationDayStage\.setResponding\(false\);[\s\S]*?await sleep\(DRAIN_READING_PAUSE_MS\);[\s\S]*?if \(!finalResult && !streamFailed\) \{\s*\n\s*showAchievementDrainLoadingScreen\(kind\);\s*\n\s*achievementLoadingShown = true;/, 'the pause drains the wrap-up, holds the shared ~5s read, then raises the achievement drain loading screen ONLY if the result has not yet arrived (result 先着なら会話画面表示のまま)');

  // A failed stream marks streamFailed before cancelling the reveal, so a concurrent 達成読みポーズ does not raise a
  // late loading screen over the restored daytime screen (same defense as the hub send-off pause).
  assert.match(turnStreamFn, /catch \(error\) \{[\s\S]*?streamFailed = true;[\s\S]*?reveal\.cancel\(\);[\s\S]*?throw error;/, 'a failed daytime stream marks streamFailed before cancelling the reveal (suppresses a late drain loading screen)');

  // Contract pairing (BOTH directions): the 達成読みポーズ is started iff the result carries an achievement
  // completion (errand_result / study_circle_result). A half-signalled stream — a completion with no drain signal,
  // or a drain signal with no completion — fails fast rather than transitioning on a silent degrade.
  assert.match(turnStreamFn, /const achieved = Boolean\(finalResult\.errand_result \|\| finalResult\.study_circle_result\);[\s\S]*?if \(achieved !== Boolean\(achievementReadingPause\)\) \{[\s\S]*?throw new Error/, 'the daytime turn fails fast on an achievement_draining / completion mismatch (no silent tolerance, both directions)');

  // The achievement branch awaits the concurrent pause before handing the result to the caller's completion helper
  // (result-first: the daytime screen stayed visible the whole read; pause-first: the drain loading screen is
  // already up and the drain just delivered the result), adopts the authoritative conversation, and returns.
  assert.match(turnStreamFn, /if \(achievementReadingPause\) \{[\s\S]*?await achievementReadingPause;[\s\S]*?conversationDayStage\.surface\.commitState\(finalResult\);[\s\S]*?conversationDayStage\.renderStream\(conversationDayStage\.surface\.getHistory\(\)\);[\s\S]*?return finalResult;/, 'the achievement branch awaits the concurrent 達成読みポーズ, adopts the authoritative conversation, then returns the result to the completion helper');

  // The achievement drain loading screen: kind-selected copy (依頼 / 研究会 post-processing 短文), raised via the
  // shared setAcademyLoadingDestinationCopy + showScreen('academy-loading') — the same 流儀 as the hub's
  // showRoutingDrainLoadingScreen. An unknown kind is a broken backend contract and fails fast (no default copy).
  const copyFn = js.match(/function achievementDrainLoadingCopy\(kind\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(copyFn, '', 'achievementDrainLoadingCopy should exist');
  assert.match(copyFn, /if \(kind === 'errand'\) return ERRAND_ACHIEVEMENT_DRAIN_LOADING_COPY;[\s\S]*?if \(kind === 'study_circle'\) return STUDY_CIRCLE_ACHIEVEMENT_DRAIN_LOADING_COPY;[\s\S]*?throw new Error/, 'the loading copy is selected by kind and an unknown kind fails fast (no default-value fallback)');
  assert.match(js, /const ERRAND_ACHIEVEMENT_DRAIN_LOADING_COPY = Object\.freeze\(\{\s*\n\s*title: '依頼の後処理をしています',/, 'the errand achievement drain loading copy is the 依頼 post-processing 短文');
  assert.match(js, /const STUDY_CIRCLE_ACHIEVEMENT_DRAIN_LOADING_COPY = Object\.freeze\(\{\s*\n\s*title: '研究会の後処理をしています',/, 'the study circle achievement drain loading copy is the 研究会 post-processing 短文');
  const showLoadingFn = js.match(/function showAchievementDrainLoadingScreen\(kind\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(showLoadingFn, /setAcademyLoadingDestinationCopy\(null, \{ loadingCopy: achievementDrainLoadingCopy\(kind\) \}\);[\s\S]*?showScreen\('academy-loading'\);/, 'the achievement drain loading screen sets the kind copy and shows academy-loading (same 流儀 as the hub drain loading screen)');

  // Study circle achievement completion mirrors the errand completion exactly (same fail-fast pairing + state
  // check, NO serial FINAL_REPLY_AUTO_END_DELAY_MS wait, same loading-covered hub return with post_content_screen
  // = 'interaction'), distinguished only by the study_circle_* fields.
  const studyCompleteFn = js.match(/async function completeStudyCircleFromTurnResult\(result\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(studyCompleteFn, '', 'completeStudyCircleFromTurnResult should exist');
  assert.match(studyCompleteFn, /const hasAchievement = Boolean\(result\?\.study_circle_achievement\);[\s\S]*?const hasCompletion = Boolean\(result\?\.study_circle_result\);[\s\S]*?if \(hasAchievement !== hasCompletion\) \{[\s\S]*?throw new Error[\s\S]*?\}[\s\S]*?if \(!hasCompletion\) return false;[\s\S]*?assertDrainedRoutingFinalization\(result\.finalization_status\);[\s\S]*?if \(!result\.state \|\| typeof result\.state !== 'object'\) \{[\s\S]*?throw new Error[\s\S]*?\}[\s\S]*?currentRuntimeState = result\.state;[\s\S]*?clearVisibleConversation\(\);[\s\S]*?if \(result\.post_content_screen !== 'interaction'\) \{[\s\S]*?throw new Error[\s\S]*?\}[\s\S]*?await returnToRoutingHubThroughLoadingScreen\(\{ allowDuringInFlight: true \}\);/, 'the study circle completion helper mirrors the errand one (fail-fast pairing + state, loading-covered hub return)');
  assert.doesNotMatch(studyCompleteFn, /FINAL_REPLY_AUTO_END_DELAY_MS/, 'the study circle completion helper carries no serial FINAL_REPLY_AUTO_END_DELAY_MS wait (二重待ち removed, mirror of the errand path)');
});

test('daytime stage-move turn reveals the held-back new-stage opening line through the same reveal queue (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const turnStreamFn = js.match(/async function runConversationDayTurnStream\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(turnStreamFn, '', 'runConversationDayTurnStream should exist');

  // 統一出現規律 across a 舞台移動を挟んだターン: only the reply + movement cutoff stream as assistant_complete 吹き出し;
  // the backend holds the post-move opening line back and delivers it solely as the last displayable message of
  // finalResult.conversation. The daytime turn enqueues that held-back opening onto the SAME createTurnReveal
  // queue so 移動後の発話・地の文 pops in one 吹き出し単位 at a time on the shared cadence — never dumped all at once.
  assert.match(turnStreamFn, /if \(finalResult\.stage_move\) \{\s*\n\s*const finalMessages = conversationDayStage\.surface\.mapMessages\(finalResult\.conversation\);\s*\n\s*reveal\.enqueue\(displayMessages\(\[finalMessages\.at\(-1\)\]\)\);\s*\n\s*\}/, 'a daytime stage-move turn enqueues the held-back new-stage opening (the last displayable message of the final conversation) onto the reveal queue');

  // Ordering: the held-back opening is enqueued BEFORE the drain, and the drain finishes BEFORE the canonical
  // commit — so the opening is revealed through the cooldown-paced queue, not painted all at once by commitState.
  // Measure the drain / commit positions relative to the stage-move enqueue (the achievement branch has its own
  // earlier reveal.drain() / commitState() — those belong to a different, achievement-only path, so scope the
  // NORMAL-tail ordering to the occurrences at or after the stage-move enqueue).
  const enqueueAt = turnStreamFn.indexOf('if (finalResult.stage_move)');
  const drainAt = turnStreamFn.indexOf('await reveal.drain()', enqueueAt);
  const commitAt = turnStreamFn.indexOf('conversationDayStage.surface.commitState(finalResult)', drainAt);
  assert.ok(enqueueAt >= 0 && drainAt >= 0 && commitAt >= 0, 'the stage-move enqueue, the reveal drain, and the commit are all present in the normal tail');
  assert.ok(enqueueAt < drainAt, 'the held-back opening is enqueued before the reveal drain (so the queue reveals it)');
  assert.ok(drainAt < commitAt, 'the reveal drains before the canonical state is committed (opening revealed through the queue, not by the commit)');

  // The opening reveal stays on the stage reveal queue — no bespoke sequential-reveal helper or move-only loading
  // transition is bolted onto the daytime turn (scope stays the reveal cadence; routing/loop/academy untouched).
  assert.doesNotMatch(turnStreamFn, /renderConversationResultSequentially|revealResultSequentially|showAcademyLoadingScreenUntilReady|performStageMoveTransition/, 'the daytime move opening is revealed through the stage reveal queue, not a separate sequential-reveal helper or a loading-screen transition');
});

test('daytime conversation chat shows no in-progress status text — only the error banner remains (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const turnStreamFn = js.match(/async function runConversationDayTurnStream\([\s\S]*?\n\}/)?.[0] ?? '';
  const sendFn = js.match(/async function runConversationDayConversation\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(turnStreamFn, '', 'runConversationDayTurnStream should exist');
  assert.notEqual(sendFn, '', 'runConversationDayConversation should exist');

  // The SSE status event is not surfaced; assistant_delta keeps the responding glow but sets no status text.
  assert.doesNotMatch(turnStreamFn, /event === 'status'/, 'the SSE status event does not surface an in-progress status line');
  assert.match(turnStreamFn, /if \(event === 'assistant_delta'\) \{\s*\n\s*conversationDayStage\.setResponding\(true\);/, 'assistant_delta keeps the responding glow');
  // The only stage-status calls in the normal turn flow clear the line (setStatus('')): non-empty text would
  // be the error banner exclusively. A revert that re-adds progress text fails here.
  assert.doesNotMatch(turnStreamFn, /conversationDayStage\.setStatus\((?!'')/, 'the turn stream sets no non-empty daytime status text (in-progress text removed)');
  assert.doesNotMatch(sendFn, /conversationDayStage\.setStatus\((?!'')/, 'the send path sets no non-empty daytime status text (error banner clear only)');
});

test('daytime category rail opens info popups through the stage; the daytime ambient + animations are reduced-motion aware; the daytime token layer is a separate scope (app.js + style.css)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  // Category rail → the stage's openInfo, and every close hook → the stage's closeInfo.
  assert.match(js, /for \(const button of document\.querySelectorAll\('\.conversation-day-category-button'\)\) \{[\s\S]*?conversationDayStage\.openInfo\(button\.dataset\.dayCategory\)/, 'each daytime category button opens the info drawer through the stage');
  assert.match(js, /for \(const closer of document\.querySelectorAll\('#conversation-day-info-popup \[data-day-popup-close\]'\)\) \{[\s\S]*?conversationDayStage\.closeInfo\(\)/, 'every daytime close hook (backdrop + button) closes the drawer through the stage');
  assert.match(js, /categoryTitles: CONVERSATION_DAY_CATEGORY_TITLES/, 'the daytime consumer passes its fixed five-category title set to the stage');
  assert.match(js, /categoryIconUrl: \(category\) => `\/canonical\/conversation_day\/icons\/\$\{category\}\.png`/, 'the daytime consumer maps a category to its rail asset');

  // Daytime ambient: a light-motes strategy (NOT the reused starfield), reduced-motion aware, fail-fast moteCount.
  assert.match(js, /ambient: createConversationDayAmbient\(\{ canvasSelector: '#conversation-day-motes'/, 'the daytime consumer injects its own light-motes ambient over its own canvas');
  const ambientFn = js.match(/function createConversationDayAmbient\([\s\S]*?\n\}\n/)?.[0] ?? '';
  assert.notEqual(ambientFn, '', 'createConversationDayAmbient should exist');
  assert.match(ambientFn, /if \(!Number\.isInteger\(moteCount\) \|\| moteCount <= 0\) \{[\s\S]*?throw new Error/, 'the daytime ambient fail-fasts on an invalid moteCount (no default-value fallback)');
  assert.match(ambientFn, /const reducedMotion = window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\);/, 'the daytime ambient reads reduced-motion from the live matchMedia result');
  assert.match(ambientFn, /if \(typeof window === 'undefined' \|\| typeof window\.matchMedia !== 'function'\) \{[\s\S]*?throw new Error/, 'the daytime ambient fails fast when matchMedia is unavailable (no reduced-motion default fallback)');
  assert.doesNotMatch(ambientFn, /\{ matches: false \}/, 'the daytime ambient does not fabricate a reduced-motion state (no { matches: false } default-value fallback)');
  assert.match(ambientFn, /if \(reducedMotion\.matches\) \{[\s\S]*?canvas\.dataset\.ambient = 'static';[\s\S]*?draw\(ctx, width, height, 0\);\s*\n\s*return;/, 'reduced motion draws a static field without the animation loop');
  assert.match(ambientFn, /buildConversationStageStars\(width, height, moteCount\)/, 'the daytime ambient reuses the shared deterministic lattice (no forked / RNG generator)');
  // Absolute-rules: the ambient fails fast on a missing canvas / unusable context / zero-size canvas rather
  // than silently no-oping or fabricating a canvas size (no default-value fallback).
  assert.match(ambientFn, /if \(!canvas \|\| typeof canvas\.getContext !== 'function'\) \{[\s\S]*?throw new Error/, 'the daytime ambient throws on a missing canvas node (no silent no-op)');
  assert.match(ambientFn, /if \(!Number\.isFinite\(width\) \|\| width <= 0 \|\| !Number\.isFinite\(height\) \|\| height <= 0\) \{[\s\S]*?throw new Error/, 'the daytime ambient throws on a zero/invalid canvas size (no fabricated dimensions)');
  assert.doesNotMatch(ambientFn, /canvas\.clientWidth \|\||canvas\.clientHeight \|\||\|\| 800|\|\| 450/, 'the daytime ambient does not fabricate canvas dimensions with a default-value fallback');
  assert.doesNotMatch(ambientFn, /const ctx = canvas\.getContext\('2d'\);\s*\n\s*if \(!ctx\) return;/, 'a missing 2D context throws rather than silently returning');

  // Dedicated 黒夜 token layer (黒曜の地 / 琥珀の灯) + the [hidden] guard + moon phases + reduced motion.
  const screenBlock = cssRuleBlock(css, '.conversation-day-screen');
  assert.match(screenBlock, /--cd-night-bg-0:[\s\S]*--cd-night-ink:[\s\S]*--cd-night-amber:/, 'the screen defines its own obsidian / ink / amber token layer');
  assert.doesNotMatch(screenBlock, /--routing-/, 'the 黒夜 token layer does not redefine or borrow the --routing-* layer');
  assert.match(css, /#conversation-day-screen \[hidden\] \{\s*\n\s*display: none;/, 'the daytime screen carries the id-scoped [hidden] guard for its popup');
  // The moon is a real image asset now (a circular-framed phase render): the frame clips its <img> to the
  // circle and shares the .moon-phase-image cover rule; the old per-phase CSS gradient rules are fully gone.
  assert.match(css, /\.conversation-day-moon-glyph \{[\s\S]*?overflow: hidden;[\s\S]*?\}/, 'the daytime moon frame clips its phase image to the circular frame');
  assert.doesNotMatch(css, /\.conversation-day-moon-glyph\[data-phase/, 'the CSS glyph per-phase rules are fully removed (no data-phase残骸)');
  assert.match(css, /\.moon-phase-image \{[\s\S]*?object-fit: cover;[\s\S]*?\}/, 'the shared moon-phase-image rule cover-fits the phase image into its frame');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.conversation-day-decor,[\s\S]*?\.is-day-responding[\s\S]*?animation: none;/, 'reduced motion disables the daytime decor drift and the ①② animations');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.conversation-day-message-stream \.chat-message\.pop-in[\s\S]*?animation: none;/, 'reduced motion disables the daytime 吹き出し pop-in (即時出現) — the interval discipline is kept by the reveal queue, daytime-scoped so the shared chat stays byte-equal');

  // Viewport-fit + internal-scroll invariants (the play-screen height constraint pattern).
  assert.match(css, /body:has\(#conversation-day-screen\.active\) \.layout \{[\s\S]*?height: calc\(100dvh - var\(--runtime-topbar-height, 0px\)\);[\s\S]*?overflow: hidden;/, 'the daytime layout uses the play-screen body:has(#…screen.active) .layout viewport-height constraint so its internal chat scroll resolves');
  const streamCss = cssRuleBlock(css, '.conversation-day-message-stream');
  assert.match(streamCss, /flex:\s*1 1 auto;[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/, 'the daytime message stream owns the internal scroll (fixed-height absorb)');

  // Fixed-size composer (うゆりす's 可変→固定 request): a fixed height + resize:none, absorbing overflow with an
  // internal scroll instead of stretching (or a user-dragged handle changing) the input box.
  const dayComposerTextareaCss = cssRuleBlock(css, '.conversation-day-composer textarea');
  assert.match(dayComposerTextareaCss, /height:\s*3\.2em;[\s\S]*?resize:\s*none;[\s\S]*?overflow-y:\s*auto;/, 'the daytime composer input is a fixed 3.2em height, not user-resizable, absorbing overflow with an internal scroll');
  assert.doesNotMatch(dayComposerTextareaCss, /min-height:|resize:\s*vertical/, 'the daytime composer input no longer uses the variable min-height / vertical drag-resize');
  // The send + end row is right-aligned (same grammar as the hub): with the send-before-end DOM order
  // (pinned above) 会話を終える seats in the far bottom-right corner and 送信 sits to its left.
  const dayButtonRowCss = cssRuleBlock(css, '.conversation-day-button-row');
  assert.match(dayButtonRowCss, /justify-content:\s*flex-end;/, 'the daytime send + end controls hug the bottom-right corner (会話を終える rightmost, 送信 to its left)');

  // The end button is the same-class secondary sibling of 送信, tinted with the --cd-night-* panel token (no literal).
  const daySecondaryCss = cssRuleBlock(css, '.conversation-day-action-secondary');
  assert.match(daySecondaryCss, /background:\s*var\(--cd-night-panel-strong\);/, 'the daytime end button consumes the --cd-night-* panel token as its flatter secondary fill (no literal color pin)');
  assert.doesNotMatch(daySecondaryCss, /#[0-9a-fA-F]{3,8}|rgba?\(/, 'the daytime end button carries no literal color pin (token-only, same-class bearing as the hub end button)');

  // 黒夜 amber tokens: the ember meter tier, the amber hairline, and the two player-bubble fills are all
  // real declarations on the 黒夜 layer (test-by-token: defined here, consumed via var() below).
  assert.match(screenBlock, /--cd-night-ember:\s*#e8733d;/, 'the 黒夜 layer defines the warm ember token (high meter tier)');
  assert.match(screenBlock, /--cd-night-line-warm:\s*rgb\(240 178 74 \/ 0\.5\);/, 'the 黒夜 layer defines the amber hairline token for the player bubbles');
  assert.match(screenBlock, /--cd-night-bubble-player:\s*rgb\(240 178 74 \/ 0\.16\);/, 'the 黒夜 layer defines the player-speech bubble fill token');
  assert.match(screenBlock, /--cd-night-bubble-player-narration:\s*rgb\(232 115 61 \/ 0\.24\);/, 'the 黒夜 layer defines the deeper warm player-narration bubble fill token');
  assert.match(screenBlock, /--cd-night-face-edge:\s*rgb\(95 127 166 \/ 0\.3\);/, 'the 黒夜 layer defines the cool-slate face-frame edge token (sunk hairline, not amber/gold)');

  // Player-side bubbles + the face icon shadow are re-skinned to the amber 黒夜 palette (token-only, daytime-
  // scoped so the shared navy player bubbles and the shared deep face shadow stay byte-equal for the other night
  // surfaces). The 3-class rule outweighs the shared .player-message / .message-face colors.
  assert.match(css, /\.conversation-day-message-stream \.player-message \.message-bubble \{\s*\n\s*background:\s*var\(--cd-night-bubble-player\);\s*\n\s*border-color:\s*var\(--cd-night-line-warm\);/, 'the player-speech bubble consumes the amber-tint fill + amber hairline tokens');
  assert.match(css, /\.conversation-day-message-stream \.player-narration-message \.message-bubble \{\s*\n\s*background:\s*var\(--cd-night-bubble-player-narration\);\s*\n\s*border-color:\s*var\(--cd-night-line-warm\);/, 'the player-narration bubble consumes the deeper ember-tint fill + amber hairline tokens');
  // The daytime chat face frame sinks into 黒曜: the shared warm gold-ring / cream-backing / deep-drop frame is
  // re-skinned to a faint cool-slate edge + deepest-obsidian backing + a tight contact shadow (token-only,
  // daytime-scoped so the shared warm .message-face frame stays byte-equal for the other night surfaces). The
  // 2-class rule outweighs the shared .message-face border/background/shadow.
  const dayFaceCss = cssRuleBlock(css, '.conversation-day-message-stream .message-face');
  assert.match(dayFaceCss, /border-color:\s*var\(--cd-night-face-edge\);/, 'the chat face frame edge consumes the cool-slate 黒夜 edge token (no warm/gold ring)');
  assert.match(dayFaceCss, /background:\s*var\(--cd-night-bg-0\);/, 'the chat face frame backing consumes the deepest obsidian token so the frame sinks into the chat');
  assert.match(dayFaceCss, /box-shadow:\s*0 3px 8px var\(--cd-night-shadow\);/, 'the chat face icon keeps its tight contact shadow using the 黒夜 shadow token');
  assert.doesNotMatch(dayFaceCss, /#[0-9a-fA-F]{3,8}|rgba?\(/, 'the chat face frame carries no literal color pin (token-only)');
});

test('daytime info drawer is a rail-linked left drawer, daytime-scoped so shared parameter meters and --routing-* stay byte-equal (app.js + style.css)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  // DRAWER FORM: left-hugging overlay, full-height card opened past the rail, fixed header over a scrolling body.
  const popupCss = cssRuleBlock(css, '.conversation-day-info-popup');
  assert.match(popupCss, /justify-content:\s*flex-start;/, 'the drawer overlay hugs the left rail side (not centered)');
  assert.match(popupCss, /align-items:\s*stretch;/, 'the drawer stretches to the full frame height');
  const cardCss = cssRuleBlock(css, '.conversation-day-info-popup-card');
  assert.match(cardCss, /width:\s*min\(380px, 34vw\);/, 'the drawer is min(380px, 34vw) wide');
  assert.match(cardCss, /height:\s*100%;/, 'the drawer spans the full frame height');
  assert.match(cardCss, /margin-left:\s*calc\(clamp\(56px, 6vw, 76px\) \+ clamp\(10px, 1\.6vw, 20px\)\);/, 'the drawer opens from the right edge of the left rail');
  const bodyCss = cssRuleBlock(css, '.conversation-day-info-popup-body');
  assert.match(bodyCss, /flex:\s*1 1 auto;/, 'the drawer body grows to fill the card');
  assert.match(bodyCss, /overflow-y:\s*auto;/, 'the drawer body owns the internal scroll for tall content');

  // TOKEN-ONLY: overlay backdrop + card consume --cd-night-* tokens with no literal color pin.
  const backdropCss = cssRuleBlock(css, '.conversation-day-info-popup-backdrop');
  assert.match(backdropCss, /background:\s*var\(--cd-night-scrim\);/, 'the drawer backdrop consumes the thin daytime scrim token');
  assert.match(cardCss, /box-shadow:\s*0 20px 50px var\(--cd-night-shadow\);/, 'the drawer shadow consumes the daytime shadow token (no literal color pin)');
  assert.doesNotMatch(backdropCss, /rgb\(/, 'the drawer backdrop has no literal color pin (token-only)');
  assert.doesNotMatch(cardCss, /rgb\(/, 'the drawer card has no literal color pin (token-only)');

  // Category renderers enriched to the same design level as the routing hub, with the same per-category
  // fail-fast, but painted in daytime-scoped classes.
  // The buddy category is async against the GET /api/relationships/buddy truth source; a null buddy renders the
  // titled empty-state card, a selectable buddy the portrait hero card with roster meta chips (現行同等), a
  // homunculus buddy the endpoint face / name + a 好感度 affinity chip.
  const buddyFn = js.match(/function renderConversationDayBuddyInto\(bodyEl\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(buddyFn, /loadConversationDayBuddyInto\(bodyEl\)\.catch\(reportError\)/, 'the buddy category delegates to the async endpoint loader (errors → reportError)');
  const buddyLoaderFn = js.match(/async function loadConversationDayBuddyInto\(bodyEl\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(buddyLoaderFn, /const view = await fetchBuddyView\(\)[\s\S]*popup\.dataset\.category !== 'buddy'[\s\S]*conversationDayInfoEmptyCard\('バディー記録なし'/, 'a null buddy renders the titled empty-state card (endpoint truth source, still-on-buddy guard)');
  const buddyHeroFn = js.match(/function conversationDayBuddyHeroCard\(subject\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(buddyHeroFn, /'conversation-day-info-buddy-card'[\s\S]*?'conversation-day-info-portrait'[\s\S]*?conversationDayInfoMetaChips\(buddy\)/, 'a selectable buddy renders a portrait hero card with roster meta chips (現行同等)');
  assert.match(buddyHeroFn, /buddyAffinityChip\(buddy\.affinity, 'conversation-day-info-chip'\)/, 'a homunculus buddy renders a 好感度 affinity chip');
  const enemyFn = js.match(/function renderConversationDayEnemiesInto\(bodyEl\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(enemyFn, /conversationDayInfoEmptyCard\('エネミー記録なし'/, 'zero enemies render a titled empty-state card');
  assert.match(enemyFn, /conversationDayInfoSummary\(`\$\{enemies\.length\}件`, 'エネミー'\)/, 'enemies render a count summary over compact roster cards');
  const inventoryFn = js.match(/function renderConversationDayInventoryInto\(bodyEl\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(inventoryFn, /conversationDayInfoEmptyCard\('持ち物なし'/, 'an empty inventory renders a titled empty-state card');
  assert.match(inventoryFn, /conversationDayInfoSummary\(`\$\{items\.length\}種類`, '持ち物'\)/, 'inventory renders a 種類 count summary');
  assert.match(inventoryFn, /name\.textContent = item\.name;/, 'the ledger reads the enriched item.name directly (not display_name)');
  assert.match(inventoryFn, /if \(typeof item\.name !== 'string' \|\| item\.name === ''\) \{[\s\S]*?throw new Error/, 'the ledger fails fast on a missing/empty item name (no item_id fallback)');
  assert.match(inventoryFn, /if \(typeof item\.quantity !== 'number' \|\| !Number\.isFinite\(item\.quantity\)\) \{[\s\S]*?throw new Error/, 'the ledger fails fast on a non-numeric quantity (no ?? 0 fallback)');
  assert.match(js, /money: \(bodyEl\) => \{[\s\S]*?renderConversationDayMoneyInto\(bodyEl, currentInventory\.money\)/, 'the money category renders through the numeric-tile builder');
  assert.match(js, /self: \(\) => \{[\s\S]*?const parameters = currentWorld\?\.player_parameters;[\s\S]*?throw new Error[\s\S]*?renderPlayerParametersInto\(parameters, '#conversation-day-info-popup-body'\)/, 'the self category reuses the shared player-parameter renderer over a validated source (fail-fast, drawer-scoped)');

  // SELF re-skin scoped to the drawer body so the shared academy / routing parameter meters stay byte-equal.
  // A 黒夜 cool→warm value ramp (low=cool → mid=amber → high=ember), every tier distinct from the --cd-night-bg-2
  // track so the low tier stays visible (a low tier equal to --cd-night-bg-2 would match the track and read empty).
  assert.match(css, /\.conversation-day-info-popup-body \.character-parameter-item meter::-webkit-meter-optimum-value \{\s*\n\s*background:\s*var\(--cd-night-ember\);/, 'the self high-tier meter is re-skinned to the 黒夜 ember, scoped to the drawer body');
  assert.match(css, /\.conversation-day-info-popup-body \.character-parameter-item meter::-webkit-meter-suboptimum-value \{\s*\n\s*background:\s*var\(--cd-night-amber\);/, 'the self mid-tier meter is the amber lamplight');
  assert.match(css, /\.conversation-day-info-popup-body \.character-parameter-item meter::-webkit-meter-even-less-good-value \{\s*\n\s*background:\s*var\(--cd-night-cool\);/, 'the self low-tier meter is the cool low tier, distinct from the --cd-night-bg-2 track so it stays visible');
  const sharedSectionH4 = cssRuleBlock(css, '.character-parameter-section h4');
  assert.match(sharedSectionH4, /color:\s*var\(--accent-gold\);/, 'the shared parameter heading keeps its academy gold tone (daytime scopes its own re-skin)');
});

test('daytime corner ornaments, baked calibration properties, the four daytime calibration entries, and the dev entry (index.html + style.css + app.js + frameDecorationCalibration.js)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const registry = await readFile(path.join(root, 'frameDecorationCalibration.js'), 'utf8');

  // Chat corners are both corner_01: the top-left upright (calibration translate only), the bottom-right its
  // 180° point reflection — the same corner_01 asset with scale(-1, -1) (上下左右反転), the calibration translate
  // composed in front of the flip (same ordering as the standee corners).
  assert.match(html, /class="conversation-day-corner conversation-day-corner-tl"[^>]*src="\/canonical\/conversation_day\/ui\/corner_01\.png"/, 'the chat top-left ornament img is corner_01');
  assert.match(html, /class="conversation-day-corner conversation-day-corner-br"[^>]*src="\/canonical\/conversation_day\/ui\/corner_01\.png"/, 'the chat bottom-right ornament img is corner_01 (same asset as the top-left)');
  assert.match(css, /\.conversation-day-corner-tl \{[^}]*transform:\s*translate\(var\(--cd-chat-corner-tl-dx\), var\(--cd-chat-corner-tl-dy\)\);[^}]*\}/, 'the chat top-left ornament carries only the calibration translate offset');
  assert.doesNotMatch(css, /\.conversation-day-corner-tl \{[^}]*(?:rotate|scale)[^}]*\}/, 'the chat top-left ornament stays upright (calibration translate only)');
  assert.match(css, /\.conversation-day-corner-br \{[^}]*bottom:\s*-6px[^}]*right:\s*-6px[^}]*transform:\s*translate\(var\(--cd-chat-corner-br-dx\), var\(--cd-chat-corner-br-dy\)\) scale\(-1, -1\);[^}]*\}/, 'the chat bottom-right ornament is the 180° point reflection of the top-left: the same calibration translate composed in front of a scale(-1, -1) flip, hugging the corner at -6px');

  // Standee frame corners are ::before (top-left, rotate(-90deg)) + ::after (bottom-right, rotate(90deg) =
  // 180° point reflection), both the single corner_02 mirror asset — each with its calibration translate.
  const standeeCornerRule = css.match(/\.conversation-day-standee-frame::before,\s*\n\s*\.conversation-day-standee-frame::after \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(standeeCornerRule, /background-image: url\('\/canonical\/conversation_day\/ui\/corner_02\.png'\);/, 'both standee corners use the single corner_02 mirror asset');
  assert.doesNotMatch(standeeCornerRule, /corner_01/, 'the standee corners are the corner_02 mirror system (not corner_01)');
  assert.match(css, /\.conversation-day-standee-frame::before \{\s*\n\s*top:\s*-6px;\s*\n\s*left:\s*-6px;\s*\n\s*transform:\s*translate\(var\(--cd-standee-corner-tl-dx\), var\(--cd-standee-corner-tl-dy\)\) rotate\(-90deg\);\s*\n\}/, 'the standee top-left ornament is corner_02 seated via rotate(-90deg) after the calibration translate');
  assert.match(css, /\.conversation-day-standee-frame::after \{\s*\n\s*bottom:\s*-6px;\s*\n\s*right:\s*-6px;\s*\n\s*transform:\s*translate\(var\(--cd-standee-corner-br-dx\), var\(--cd-standee-corner-br-dy\)\) rotate\(90deg\);\s*\n\}/, 'the standee bottom-right ornament is corner_02 rotate(90deg) = the top-left plus a 180° half-turn');

  // The eight corner-offset custom properties are real declarations on .conversation-day-screen (baked 0px,
  // consumed with no var() fallback — test-by-token).
  const screenCss = cssRuleBlock(css, '.conversation-day-screen');
  for (const varName of ['--cd-standee-corner-tl-dx', '--cd-standee-corner-tl-dy', '--cd-standee-corner-br-dx', '--cd-standee-corner-br-dy', '--cd-chat-corner-tl-dx', '--cd-chat-corner-tl-dy', '--cd-chat-corner-br-dx', '--cd-chat-corner-br-dy']) {
    assert.match(screenCss, new RegExp(`${varName}:\\s*0px;`), `${varName} is a real 0px declaration on .conversation-day-screen`);
  }

  // The four daytime calibration entries are registered on the conversation-day screen (the tool reads the
  // registry generically — no tool-code change).
  for (const id of ['conversation-day-standee-corner-tl', 'conversation-day-standee-corner-br', 'conversation-day-chat-corner-tl', 'conversation-day-chat-corner-br']) {
    assert.match(registry, new RegExp(`id: '${id}'[\\s\\S]*?screen: 'conversation-day'`), `the registry carries the ${id} entry on the conversation-day screen`);
  }

  // Dev entry: ?initialScreen=conversation-day displays the screen; a roster start uses the ordinary
  // interaction-start API. startConversationDay is also the production daytime landing (the academy-map
  // conversation with the toggle set to 'day'), pinned in the settings-toggle test.
  assert.match(js, /function requestedInitialConversationDay\(\)[\s\S]*?get\('initialScreen'\) === 'conversation-day'/, 'the dev entry reads ?initialScreen=conversation-day');
  assert.match(js, /if \(requestedInitialConversationDay\(\)\) \{ showConversationDayDevScreen\(\); return; \}/, 'the initial-screen override displays the daytime dev screen');
  assert.match(js, /async function startConversationDay\(characterId\)[\s\S]*?postJson\('\/api\/interaction\/start', \{ character_id: characterId, source_type: 'field' \}\)/, 'startConversationDay begins an ordinary interaction with a selectable roster character');

  // The dev calibration UI is still never in the shipped markup.
  assert.doesNotMatch(html, /frame-decoration-calibration/, 'the calibration overlay markup is not present in the shipped index.html (dev-only, injected on ?calibrate=)');
});

test('the dev calibration tool gains a second kind — academy-map pins — with a JS-object export and four map frame corners (frameDecorationCalibration.js + app.js + style.css)', async () => {
  const registry = await readFile(path.join(root, 'frameDecorationCalibration.js'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');
  const html = await readFile(`${root}/index.html`, 'utf8');

  // Pin registry: a declarative map-pins group entry naming the screen, the pin nodes, and the JS truth source
  // (it does NOT enumerate every locationId — per-pin handles are derived from the rendered nodes at build time).
  assert.match(registry, /export const MAP_PIN_CALIBRATION_KIND = 'map-pins'/, 'the pin kind is a named constant');
  assert.match(registry, /MAP_PIN_CALIBRATION_TARGETS = Object\.freeze\(\[[\s\S]*kind: MAP_PIN_CALIBRATION_KIND[\s\S]*id: 'academy-map-stage-pins'[\s\S]*screen: 'academy-map'[\s\S]*region: 'academy'[\s\S]*containerSelector: '#academy-map-stage-layer'[\s\S]*nodeSelector: '\.academy-map-node'[\s\S]*coordinatesName: 'academyMapStagePinCoordinates'[\s\S]*\]\)/, 'the pin registry declares the academy-map stage pin group against the truth-source constant');
  // The 山林 map shares the academy-map DOM screen but names its own region + truth source, so ?calibrate=academy-map&region=sanrin
  // calibrates the sanrin pins over the sanrin background and exports back into sanrinMapStagePinCoordinates.
  assert.match(registry, /id: 'sanrin-map-stage-pins'[\s\S]*screen: 'academy-map'[\s\S]*region: 'sanrin'[\s\S]*containerSelector: '#academy-map-stage-layer'[\s\S]*nodeSelector: '\.academy-map-node'[\s\S]*coordinatesName: 'sanrinMapStagePinCoordinates'/, 'the pin registry also declares the sanrin stage pin group (same map DOM, sanrin region + truth source)');
  assert.match(registry, /export function readCalibrationRegion\(search\)/, 'a pure ?region= reader is exposed so region selection is verifiable without the DOM');
  assert.match(registry, /export function validateMapPinCalibrationRegistry\(targets\)[\s\S]*duplicate map-pin calibration target id/, 'the pin registry has its own fail-fast validator (empty / duplicate id)');
  assert.match(registry, /export function formatMapPinCoordinatesJs\(\{ coordinatesName, baseCoordinates, overrides = \{\} \} = \{\}\)/, 'a pure JS-object export formatter is exposed for headless testing');

  // The four map frame corners (tl/tr/bl/br) are corner-kind entries on the academy-map screen.
  for (const corner of ['tl', 'tr', 'bl', 'br']) {
    assert.match(registry, new RegExp(`id: 'academy-map-corner-${corner}'[\\s\\S]*?screen: 'academy-map'[\\s\\S]*?varX: '--am-corner-${corner}-dx'`), `the registry carries the academy-map ${corner} corner entry driving --am-corner-${corner}-*`);
  }

  // app.js wiring: validates both registries and unions corners+pins for the screen, resolves pins against the
  // live rendered nodes (no data attribute stamped on shipped pin markup), and exports the JS object.
  assert.match(js, /validateCalibrationRegistry\(FRAME_DECORATION_CALIBRATION_TARGETS\);[\s\S]*validateMapPinCalibrationRegistry\(MAP_PIN_CALIBRATION_TARGETS\);[\s\S]*calibrationTargetsForScreen\(screen\)/, 'activation validates the corner AND pin registries and unions targets by screen');
  // The multi-region map screen: ?region= switches to the calibrated region (fail-fast on an unknown region id)
  // and only the pin groups whose region is active are built, so exactly one region's pins are calibrated at a time.
  assert.match(js, /function applyCalibrationMapRegion\(region\)[\s\S]*ACADEMY_MAP_REGIONS\.some\(\(definition\) => definition\.id === region\)[\s\S]*is not a known map region[\s\S]*setActiveMapRegion\(region\)/, 'an unknown ?region= id fails fast instead of silently falling back to the default region');
  assert.match(js, /const activePins = pins\.filter\(\(entry\) => entry\.region === activeMapRegion\)/, 'only the pin groups for the active map region are built');
  assert.match(js, /function resolveMapPinCalibrationPins\(entry\)[\s\S]*academyMapRegionRenderableNodes\(activeMapRegion, currentField\?\.locations \?\? \[\]\)[\s\S]*renderedNodes\.length !== renderedLocations\.length[\s\S]*has no finite \$\{entry\.coordinatesName\} coordinate/, 'pins are zipped with the same renderable-node list render used and fail-fast on desync / missing coordinate');
  // EVERY truth-source pin is draggable, not just the ones the active field renders: unrendered stages (event
  // stages) bind to a synthesized calibration marker rather than being export-only.
  assert.match(js, /function resolveMapPinCalibrationPins\(entry\)[\s\S]*const ids = Object\.keys\(coordinates\)[\s\S]*ids\.map\(\(pinId\)[\s\S]*if \(synthetic\) node = createCalibrationPinMarker\(container, base\)/, 'the resolver iterates every truth-source id and synthesizes a marker for pins the render did not draw');
  assert.match(js, /function createCalibrationPinMarker\(container, base\)[\s\S]*academy-map-node academy-map-node--calibration-synthetic[\s\S]*container\.append\(marker\)/, 'a calibration-only pin marker is a real .academy-map-node so it drags like a live pin');
  assert.match(css, /\.academy-map-node--calibration-synthetic\s*\{[\s\S]*outline:\s*2px dashed/, 'the synthesized calibration markers are visually distinguished from live pins');
  assert.doesNotMatch(js, /button\.dataset\.locationId|button\.setAttribute\('data-location-id'/, 'the pin nodes must not gain a data-location-id in normal play (calibration recovers ids from the render list, keeping normal play byte-equivalent)');
  assert.match(js, /function beginMapPinDrag\(event, pin\)[\s\S]*\/ containerRect\.width\) \* 100[\s\S]*\/ containerRect\.height\) \* 100/, 'pin drag converts the pointer px delta into a percentage of the map image');
  assert.match(js, /formatMapPinCoordinatesJs\(\{[\s\S]*coordinatesName: group\.coordinatesName[\s\S]*baseCoordinates: group\.baseCoordinates[\s\S]*overrides[\s\S]*\}\)/, 'the pin readout exports the full truth-source object with the dragged overrides');

  // The provisioned drag-edit affordance CSS is now driven by the tool; pin handle labels are hover-only so ~30
  // pins do not clutter the map.
  assert.match(css, /\.academy-map-node\.is-drag-editable\s*\{[\s\S]*cursor:\s*grab/, 'a draggable pin shows the grab cursor');
  assert.match(css, /\.frame-decoration-calibration-handle--pin \.frame-decoration-calibration-handle-label\s*\{[\s\S]*display:\s*none/, 'pin handle labels are hidden by default (hover/drag reveals them)');

  // Still dev-only: the calibration overlay markup never ships in index.html.
  assert.doesNotMatch(html, /frame-decoration-calibration/, 'the calibration overlay markup is not present in the shipped index.html (dev-only, injected on ?calibrate=)');
});

test('daytime standee frame shows the stage image edge-to-edge with the ornaments over it, and the stage-detail popup is a token-only daytime modal (style.css)', async () => {
  const css = await readFile(`${root}/style.css`, 'utf8');

  // The stage image is the frame's sole content, filling it edge-to-edge (inset:0 = no余白 gap), cover-cropped,
  // clipping itself with its own rounded corners (角丸の逃げ), and clickable (cursor:pointer + day-token hover
  // affordance, no literal color pin). The standee frame carries no inner padding gap and no overflow clip.
  const stageImageCss = cssRuleBlock(css, '.conversation-day-stage-image');
  assert.match(stageImageCss, /position:\s*absolute;[\s\S]*?inset:\s*0;/, 'the stage image fills the frame edge-to-edge (inset:0 — no余白 gap)');
  assert.match(stageImageCss, /z-index:\s*1;/, 'the stage image sits below the corner ornaments');
  assert.match(stageImageCss, /background-size:\s*cover;/, 'the stage image cover-fills the frame (映える crop, no distortion, no gap)');
  assert.match(stageImageCss, /border-radius:\s*17px;/, 'the stage image tucks inside the frame rounded border (角丸の逃げ)');
  assert.match(stageImageCss, /cursor:\s*pointer;/, 'the stage image reads as clickable');
  const stageImageHoverCss = cssRuleBlock(css, '.conversation-day-stage-image:hover');
  assert.match(stageImageHoverCss, /box-shadow:\s*inset 0 0 0 2px var\(--cd-night-amber\), 0 0 18px var\(--cd-night-glow\);/, 'the stage image hover affordance is an amber-lit inner ring + glow (token-only)');
  assert.doesNotMatch(stageImageHoverCss, /#[0-9a-fA-F]{3,8}|rgba?\(/, 'the stage image hover affordance carries no literal color pin (day tokens only)');
  const frameCss = cssRuleBlock(css, '.conversation-day-standee-frame');
  assert.doesNotMatch(frameCss, /padding:/, 'the standee frame has no inner padding gap (the image reaches the frame edge)');
  assert.doesNotMatch(frameCss, /overflow:\s*hidden/, 'the standee frame does not clip its ornaments (the image clips itself)');

  // The corner ornaments sit ABOVE the stage image (z-index 3 > 1) so they hug the corners over the image edge.
  const standeeCornerRule = css.match(/\.conversation-day-standee-frame::before,\s*\n\s*\.conversation-day-standee-frame::after \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(standeeCornerRule, /z-index:\s*3;/, 'the standee corner ornaments are raised above the stage image so they overlap its corners (画像に少しかかる)');

  // Stage-detail popup: a centered daytime modal (align/justify center). The WHOLE popup is token-only — every
  // rule consumes --cd-night-* tokens with no literal color pin (no rgb()/hex), per the task's `--cd-night-*` requirement.
  const stagePopupCss = cssRuleBlock(css, '.conversation-day-stage-popup');
  assert.match(stagePopupCss, /align-items:\s*center;[\s\S]*?justify-content:\s*center;/, 'the stage popup is a centered modal (not the left drawer)');
  const stagePopupBackdropCss = cssRuleBlock(css, '.conversation-day-stage-popup-backdrop');
  assert.match(stagePopupBackdropCss, /background:\s*var\(--cd-night-scrim\);/, 'the stage popup backdrop consumes the daytime scrim token');
  const stagePopupCardCss = cssRuleBlock(css, '.conversation-day-stage-popup-card');
  assert.match(stagePopupCardCss, /background:\s*var\(--cd-night-panel-strong\);/, 'the stage popup card consumes the daytime panel token');
  assert.match(stagePopupCardCss, /box-shadow:\s*0 24px 60px var\(--cd-night-shadow\);/, 'the stage popup card shadow consumes the daytime shadow token (no literal color pin)');
  const stagePopupImageCss = cssRuleBlock(css, '.conversation-day-stage-popup-image');
  assert.match(stagePopupImageCss, /background-size:\s*cover;/, 'the stage popup image is a cover-filled preview');
  // The normal (横長 background_url) academy-map conversation keeps the 16:9 base image (byte-equal). The content
  // scenes — data-scene="errand" (依頼の現場), data-scene="study-circle" (研究会の会場), and data-scene="atelier"
  // (錬成室) — share ONE grouped rule that scopes a 1:1 square capped to the viewport so the new 1:1 content stage
  // image fits without forcing the card's internal scroll (幅上限 = card width, 縦はみ出し防止 = viewport height).
  assert.match(stagePopupImageCss, /aspect-ratio:\s*16 \/ 9;/, 'the base stage popup image keeps its 16:9 box (the normal academy-map conversation is byte-equal)');
  const contentScenePopupImageCss = cssRuleBlock(css, '.conversation-day-stage-popup[data-scene="errand"] .conversation-day-stage-popup-image,\n.conversation-day-stage-popup[data-scene="study-circle"] .conversation-day-stage-popup-image,\n.conversation-day-stage-popup[data-scene="atelier"] .conversation-day-stage-popup-image');
  assert.notEqual(contentScenePopupImageCss, '', 'the content-scene (errand / study-circle / atelier) stage popup image rule should exist');
  assert.match(contentScenePopupImageCss, /aspect-ratio:\s*1 \/ 1;/, 'the content-scene stage popup image is a 1:1 square');
  assert.match(contentScenePopupImageCss, /width:\s*min\(100%, 60vh\);/, 'the content-scene stage popup image is capped by the card width and the viewport height');
  // Token-only across every popup rule: backdrop / card / title / eyebrow / image / text carry no literal rgb()/hex.
  for (const selector of ['.conversation-day-stage-popup-backdrop', '.conversation-day-stage-popup-card', '.conversation-day-stage-popup-eyebrow', '.conversation-day-stage-popup-title', '.conversation-day-stage-popup-image', '.conversation-day-stage-popup-text']) {
    const rule = cssRuleBlock(css, selector);
    assert.doesNotMatch(rule, /rgb\(|#[0-9a-fA-F]{3,8}/, `${selector} has no literal color pin (--cd-night-* token-only)`);
  }
});

// ── Errand arrival screen: the routing "errand" (依頼) destination's landing surface ─────────────────
// #academy-errand-screen is a no-tab content screen (like routing hub / conversation-day). A routing
// dispatch to the errand destination navigates here through the existing loading interstitial (the mirror
// ROUTING_DISPATCH_SCREENS already maps errand → academy-errand); showScreen fetches this week's offers and
// renders the three selectable cards. Selecting a card starts the client's conversation on the SHARED v1
// conversation session screen, and ending it returns to the hub through the EXISTING routing end path — no
// bespoke errand turn / end / transition path, and the errand_result on the end response does not break it.

test('daytime speaker name opens the partner 能力値+一枚絵 character popup (standee + ability meters) — daytime-scoped meter skin, token-only, fail-fast, other screens byte-equal (index.html + app.js + style.css)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');
  const block = html.match(/<section id="conversation-day-screen"[\s\S]*?<\/section>\s*\n\s*<\/main>/)?.[0] ?? '';
  assert.notEqual(block, '', 'the daytime conversation screen section should exist');

  // Markup: a hidden-toggled daytime character popup with a backdrop + close affordance, a name title, a standee
  // image, and an ability-meter section (能力値). The partner name renders at open (not hardcoded).
  assert.match(block, /<div id="conversation-day-character-popup" class="conversation-day-character-popup" hidden>/, 'the daytime character popup starts hidden (toggled via the hidden attribute)');
  assert.match(block, /class="conversation-day-character-popup-backdrop" data-day-popup-close="true"/, 'the daytime character popup has a backdrop-click close affordance');
  assert.match(block, /id="conversation-day-character-popup"[\s\S]*?class="conversation-day-info-popup-close" data-day-popup-close="true"[\s\S]*?id="conversation-day-character-popup-standee"/, 'the daytime character popup has a close button and a standee image');
  assert.match(block, /<section id="conversation-day-character-popup-parameters" class="interaction-character-parameters conversation-day-character-popup-parameters"/, 'the daytime character popup carries an ability-meter section (能力値)');

  // Open/close JS: resolves the roster partner by the active id (fail-fast on desync), fills the 能力値 via the shared
  // renderCharacterParametersInto + the 一枚絵 via the shared standee helper, then shows via the hidden attribute.
  assert.match(js, /function openConversationDayCharacterPopup\(\) \{[\s\S]*?selectableCharacters\.find\([\s\S]*?activeCharacterId[\s\S]*?throw new Error\(`conversation day partner not found[\s\S]*?characterSceneStandeeUrl\(character\)[\s\S]*?renderCharacterParametersInto\(character, '#conversation-day-character-popup-parameters'\)[\s\S]*?popup\.hidden = false;/, 'openConversationDayCharacterPopup resolves the roster partner (fail-fast) and fills the standee + ability meters');
  // The partner name is authoritative roster data: a missing display_name is a hard error (no ad-hoc
  // character_id default fallback — absolute-rules fail-fast).
  const dayOpenFn = js.match(/function openConversationDayCharacterPopup\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(dayOpenFn, /character\.display_name[\s\S]*?throw new Error\([\s\S]*?no id fallback/, 'openConversationDayCharacterPopup fail-fasts on a missing partner display_name');
  assert.doesNotMatch(dayOpenFn, /display_name \?\? /, 'openConversationDayCharacterPopup does not silently substitute the character_id for a missing display_name');
  assert.match(js, /function closeConversationDayCharacterPopup\(\) \{[\s\S]*?popup\.hidden = true;/, 'closeConversationDayCharacterPopup hides the popup');
  // The delegated stream click (character side only) branches: an active 錬成室 conversation opens the うちの子
  // popup, otherwise the roster character popup.
  assert.match(js, /#conversation-day-message-stream'\)\.addEventListener\('click'[\s\S]*?closest\('\.message-speaker'\)[\s\S]*?isActiveAtelierConversation\(\)\) openConversationDayHomunculusPopup\(\)[\s\S]*?else openConversationDayCharacterPopup\(\)/, 'the daytime speaker name opens the popup via delegated click on the stream, branching homunculus vs roster');
  assert.match(js, /#conversation-day-character-popup \[data-day-popup-close\]'\)[\s\S]*?closeConversationDayCharacterPopup\(\)/, 'the daytime character popup close button + backdrop dismiss it');

  // CSS: token-only (--cd-night-*); the ability meters are re-skinned to the daytime ramp scoped to the popup, so the
  // shared academy/routing meters stay byte-equal; the speaker name shows a clickable hover affordance.
  const cardCss = cssRuleBlock(css, '.conversation-day-character-popup-card');
  assert.match(cardCss, /background:\s*var\(--cd-night-panel-strong\);/, 'the daytime character popup card consumes the --cd-night-* panel token');
  assert.doesNotMatch(cardCss, /rgb\(|#[0-9a-fA-F]{3,8}/, 'the daytime character popup card has no literal color pin (token-only)');
  assert.match(css, /\.conversation-day-character-popup-parameters \.character-parameter-item meter::-webkit-meter-optimum-value \{\s*\n\s*background:\s*var\(--cd-night-ember\);/, 'the popup ability meters are re-skinned to the 黒夜 ember, scoped to the popup');
  const nameCss = cssRuleBlock(css, '.conversation-day-message-stream .message-speaker');
  assert.match(nameCss, /cursor:\s*pointer;/, 'the daytime speaker name shows a clickable affordance (cursor pointer)');
  const sharedItem = cssRuleBlock(css, '.character-parameter-item');
  assert.match(sharedItem, /background:\s*var\(--surface-character-parameter-item\);/, 'the shared parameter item keeps its academy surface (the daytime popup scopes its own skin)');

  // Standee size contract: the 一枚絵 rendered size is the body grid's first column (the image is width:100% +
  // aspect-ratio 1/1), enlarged to 従来220px の縦横1.5倍 = 330px. The card widens +110px so the 能力値 column is not
  // squeezed by the larger standee, and stays viewport-bounded (max-height 90% + overflow-y auto).
  const bodyCss = cssRuleBlock(css, '.conversation-day-character-popup-body');
  assert.match(bodyCss, /grid-template-columns:\s*minmax\(0,\s*330px\)\s*minmax\(0,\s*1fr\)/, 'the daytime character popup standee column is 330px (従来220pxの縦横1.5倍)');
  assert.match(cardCss, /width:\s*min\(730px,\s*92vw\)/, 'the daytime character popup card widens to hold the enlarged standee without squeezing the ability meters');
  const standeeCss = cssRuleBlock(css, '.conversation-day-character-popup-standee');
  assert.match(standeeCss, /width:\s*100%/, 'the standee image fills its column');
  assert.match(standeeCss, /aspect-ratio:\s*1\s*\/\s*1/, 'the standee keeps a 1:1 box so the 1.5x width also scales its height');
});

test('daytime speaker name opens the うちの子 (homunculus) parameter popup during a 錬成室 conversation — 11 params via the reused atelier grid, face from the atelier actor, read-only, fail-fast, atelier grid re-skinned token-only (index.html + app.js + style.css)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');
  const block = html.match(/<section id="conversation-day-screen"[\s\S]*?<\/section>\s*\n\s*<\/main>/)?.[0] ?? '';
  assert.notEqual(block, '', 'the daytime conversation screen section should exist');

  // Markup: a SECOND hidden-toggled daytime popup (shares the .conversation-day-character-popup* chrome classes) for
  // the うちの子, with a backdrop + close affordance, a name title, a face image, and a parameter section (the atelier
  // grid renders into it). display_name + parameters render at open (not hardcoded).
  assert.match(block, /<div id="conversation-day-homunculus-popup" class="conversation-day-character-popup conversation-day-homunculus-popup" hidden>/, 'the daytime homunculus popup starts hidden (toggled via the hidden attribute)');
  assert.match(block, /id="conversation-day-homunculus-popup"[\s\S]*?class="conversation-day-character-popup-backdrop" data-day-popup-close="true"/, 'the daytime homunculus popup has a backdrop-click close affordance');
  assert.match(block, /id="conversation-day-homunculus-popup"[\s\S]*?class="conversation-day-info-popup-close" data-day-popup-close="true"[\s\S]*?id="conversation-day-homunculus-popup-face"/, 'the daytime homunculus popup has a close button and a face image');
  assert.match(block, /<section id="conversation-day-homunculus-popup-parameters" class="conversation-day-homunculus-popup-parameters"/, 'the daytime homunculus popup carries a parameter section (能力値)');

  // Open/close JS: the homunculus is a non-selectable per-slot actor, so its parameters come from the 錬成室 arrival
  // active entry (atelierArrivalView) matched by the live atelier actor id, and its face from the registered atelier
  // actor visual; the 11 params reuse the atelier grid builder (renderAtelierParameterList). Read-only: it reads held
  // view state + toggles the hidden attr only. Fail-fast on missing actor / entry before mutating the DOM.
  const homOpenFn = js.match(/function openConversationDayHomunculusPopup\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(homOpenFn, '', 'openConversationDayHomunculusPopup should exist');
  assert.match(homOpenFn, /if \(!activeAtelierActor\)[\s\S]*?throw new Error\(/, 'openConversationDayHomunculusPopup fail-fasts when there is no active atelier actor');
  assert.match(homOpenFn, /atelierArrivalView\?\.active\?\.find\(\(item\) => item\.homunculus_id === homunculusId\)/, 'openConversationDayHomunculusPopup sources the entry from the atelier arrival active list by the live homunculus id');
  assert.match(homOpenFn, /if \(!entry\)[\s\S]*?throw new Error\([\s\S]*?no blank popup/, 'openConversationDayHomunculusPopup fail-fasts when the homunculus is not in the arrival view (no blank popup)');
  assert.match(homOpenFn, /renderAtelierParameterList\(entry\.parameters\)/, 'openConversationDayHomunculusPopup renders the 11 parameters via the reused atelier grid builder');
  assert.match(homOpenFn, /setActorImageSource\(face, activeAtelierActor\.face_url\)/, 'openConversationDayHomunculusPopup fills the face from the registered atelier actor visual');
  assert.match(homOpenFn, /popup\.hidden = false;/, 'openConversationDayHomunculusPopup shows via the hidden attribute');
  // Read-only: no conversation turn/end/record mutation from the popup open path.
  assert.doesNotMatch(homOpenFn, /postJson|fetch\(|setHistory|commitState|endConversation|renderStream|conversationDayStage\.surface/, 'openConversationDayHomunculusPopup is read-only (no conversation turn/end/record mutation)');
  assert.match(js, /function closeConversationDayHomunculusPopup\(\) \{[\s\S]*?popup\.hidden = true;/, 'closeConversationDayHomunculusPopup hides the popup');
  assert.match(js, /#conversation-day-homunculus-popup \[data-day-popup-close\]'\)[\s\S]*?closeConversationDayHomunculusPopup\(\)/, 'the daytime homunculus popup close button + backdrop dismiss it');

  // CSS: the reused atelier grid paints on out-of-scope --atelier-* tokens here, so its color surface is re-skinned to
  // the 黒夜 ramp scoped to this popup (token-only --cd-night-*); the 錬成室 screen's own mercury grid stays byte-equal.
  assert.match(css, /\.conversation-day-homunculus-popup-parameters \.academy-atelier-parameter-meter::-webkit-meter-optimum-value \{\s*\n\s*background:\s*var\(--cd-night-ember\);/, 'the homunculus popup parameter meters are re-skinned to the 黒夜 ember, scoped to the popup');
  const homParamCss = cssRuleBlock(css, '.conversation-day-homunculus-popup-parameters .academy-atelier-parameter');
  assert.match(homParamCss, /color:\s*var\(--cd-night-ink\);/, 'the homunculus popup parameter text consumes the --cd-night-* ink token');
  const homSkinBlock = css.match(/\.conversation-day-homunculus-popup-parameters \.academy-atelier-parameter[\s\S]*?even-less-good-value \{[\s\S]*?\}/)?.[0] ?? '';
  assert.doesNotMatch(homSkinBlock, /rgb\(|#[0-9a-fA-F]{3,8}/, 'the homunculus popup parameter re-skin has no literal color pin (token-only)');
  // The shared atelier grid rule keeps its 錬成室 mercury tokens (the daytime popup scopes its own skin only).
  const sharedAtelierParam = cssRuleBlock(css, '.academy-atelier-parameter');
  assert.match(sharedAtelierParam, /color:\s*var\(--atelier-ink\);/, 'the shared atelier parameter grid keeps its 錬成室 mercury ink (the daytime popup scopes its own skin)');
});
