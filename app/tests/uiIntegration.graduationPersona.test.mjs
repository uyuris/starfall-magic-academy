import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runtimePublicReferenceRoot } from './testPaths.mjs';
import { readUiSource } from './fixtures/uiSource.mjs';

const root = runtimePublicReferenceRoot;
const readFile = readUiSource;

// task graduation-lumi-partner-frontend — the 案内人 (routing persona, ルミ / actor id `lina`) is a permanent
// 締めくくり相手 option in the routing graduation guide. Selecting her starts a phase-2 卒業 event conversation on
// the daytime (default) / legacy screen, OUTSIDE the routing hub, where the hub-scoped routingPersonaVisual
// registry no longer resolves her. This suite pins the dedicated phase-2 persona registry (the atelier
// precedent: explicit module state + scope predicate), the identity resolution wiring, the day-screen diary /
// popup branches, the registration points (selection-confirm + opening restore), and the leak-prevention clears.
// (Source-regex UI test: app.js/index.html/style.css are text-asserted here; the live flow is the Electron
// harness app/tests/manual/routingHubGraduationRender.mjs.)
test('案内人 (routing persona) graduation phase 2: dedicated non-roster registry, identity resolution, and leak-prevention clears (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const fn = (name) => {
    const match = js.match(new RegExp(`\\n(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`));
    if (!match) throw new Error(`function not found in app.js: ${name}`);
    return match[0];
  };

  // ── Dedicated phase-2 registry (module state + register/clear), independent of the hub registry ──────────
  assert.match(js, /let graduationPersonaVisual = null;/, 'the 案内人 phase-2 persona visual has its own module registry, independent of the hub-scoped routingPersonaVisual');
  // Registration is as strict as the hub's registerRoutingPersonaVisual: the routing actor id, a non-empty
  // display name, and every visual field — fail-fast, no blank / roster-head fallback.
  assert.match(fn('registerGraduationPersonaVisual'), /summary\.character_id !== ROUTING_PERSONA_CHARACTER_ID[\s\S]*?typeof summary\.display_name !== 'string'[\s\S]*?summary\.display_name === ''[\s\S]*?throw new Error[\s\S]*?!summary\.visual_set_id \|\| !summary\.face_url \|\| !summary\.selection_icon_url \|\| !summary\.standee_url[\s\S]*?throw new Error[\s\S]*?graduationPersonaVisual = summary;/, 'registerGraduationPersonaVisual fail-fasts on the wrong actor / missing display name / missing visual fields, then stores the summary (same strictness as the hub registry)');
  assert.match(fn('clearGraduationPersonaVisual'), /graduationPersonaVisual = null;/, 'clearGraduationPersonaVisual drops the phase-2 registry');

  // ── Scope predicate + resolvers (mirror routingActorById / atelierActorById) ─────────────────────────────
  // The scope requires the registry set AND the active actor `lina` AND the graduation ending event context, so
  // loop graduation (a selectable character_###) and an ordinary リナ conversation (no graduation context) never
  // match — the persona visual cannot leak outside phase 2.
  assert.match(fn('isGraduationPersonaConversationActive'), /graduationPersonaVisual != null\s*\n\s*&& activeCharacterId === ROUTING_PERSONA_CHARACTER_ID\s*\n\s*&& isRoutingGraduationEndingConversation\(\)/, 'the phase-2 scope requires the registry, the routing persona actor, and the graduation ending event context');
  assert.match(fn('graduationPersonaActorById'), /if \(!isGraduationPersonaConversationActive\(\)\) return null;[\s\S]*?if \(characterId !== ROUTING_PERSONA_CHARACTER_ID\) return null;[\s\S]*?return graduationPersonaVisual;/, 'graduationPersonaActorById resolves the persona only while phase 2 is live and only for the routing actor id');
  assert.match(fn('graduationPersonaActor'), /if \(!graduationPersonaVisual\) \{[\s\S]*?throw new Error/, 'graduationPersonaActor fail-fasts on a missing registration (no blank / roster-head fallback)');
  // The opening-response rebuild path (restore / セーブ再開): register when the backend attaches the visual, no-op
  // otherwise (a normal opening carries no summary), fail-fast on a malformed one via registerGraduationPersonaVisual.
  assert.match(fn('registerGraduationPersonaVisualFromOpening'), /if \(result\?\.routing_persona_visual\) registerGraduationPersonaVisual\(result\.routing_persona_visual\);/, 'the opening-response path registers the phase-2 persona only when the backend attaches routing_persona_visual');

  // ── Identity resolution: the persona resolves before the selectable roster on every actor surface ────────
  assert.match(fn('isNonSelectableActiveActorId'), /if \(graduationPersonaActorById\(characterId\)\) return true;/, 'refreshCharacters preserves the 案内人 phase-2 actor through the single non-selectable predicate (no roster-head reset)');
  assert.match(fn('activeCharacter'), /const graduationPersona = graduationPersonaActorById\(activeCharacterId\);\s*\n\s*if \(graduationPersona\) return graduationPersona;/, 'activeCharacter resolves the phase-2 persona (speaker name) before the selectable-roster fallback');
  assert.match(fn('sourceSheetImageUrl'), /const character = routingActorById\(characterId\)\s*\n\s*\?\? graduationPersonaActorById\(characterId\)\s*\n\s*\?\? atelierActorById\(characterId\)/, 'the message face/standee resolver consults the phase-2 persona registry before the selectable roster');

  // ── Registration at selection-confirm (both stream and non-stream selection call this one function) ──────
  const selectionFn = fn('startRoutingGraduationEndingFromSelection');
  assert.match(selectionFn, /if \(characterId === ROUTING_PERSONA_CHARACTER_ID\) \{\s*\n\s*registerGraduationPersonaVisual\(result\.routing_persona_visual\);\s*\n\s*\}\s*\n\s*await routeGraduationEndingSession\(/, 'selecting the 案内人 registers the phase-2 persona visual from the selection-confirm response BEFORE the handoff (so refresh() preserves the lina actor); a candidate selection skips it and is byte-equivalent');

  // ── Registration on the opening (restore) for both the daytime and legacy landings ──────────────────────
  assert.match(fn('ensureConversationDayOpening'), /const result = await runConversationDayOpeningStream\(\{ provider, onAssistantStreamStart \}\);[\s\S]*?registerGraduationPersonaVisualFromOpening\(result\);[\s\S]*?const result = await postJson\('\/api\/conversation\/opening'[\s\S]*?registerGraduationPersonaVisualFromOpening\(result\);/, 'the daytime opening (stream + non-stream) rebuilds the phase-2 persona registry from the opening response');
  assert.match(fn('ensureOpeningUtterance'), /const result = await runOpeningConversationStream\(\{ characterId, provider, onAssistantStreamStart \}\);[\s\S]*?registerGraduationPersonaVisualFromOpening\(result\);[\s\S]*?const result = await postJson\('\/api\/conversation\/opening'[\s\S]*?registerGraduationPersonaVisualFromOpening\(result\);/, 'the legacy opening (stream + non-stream) rebuilds the phase-2 persona registry from the opening response');

  // ── Leak-prevention clears: the phase-2 title terminal + every play entry ────────────────────────────────
  assert.match(fn('endConversation'), /if \(transition\.next_screen === 'title'\) \{\s*\n\s*document\.body\.classList\.remove\('play-mode'\);[\s\S]*?clearGraduationPersonaVisual\(\);/, 'the graduation title terminal drops the phase-2 persona registry (no stale persona leaks into a later run)');
  assert.match(fn('startNewGame'), /clearRoutingHubConversation\(\);\s*\n\s*clearGraduationPersonaVisual\(\);/, 'a new game clears the phase-2 persona registry alongside the hub state');
  assert.match(fn('loadSpecificSlot'), /clearRoutingHubConversation\(\);\s*\n\s*clearGraduationPersonaVisual\(\);/, 'loading a slot clears the phase-2 persona registry alongside the hub state');
  assert.match(fn('resumePlayFromSlotLoad'), /clearRoutingHubConversation\(\);\s*\n\s*clearGraduationPersonaVisual\(\);/, 'resuming play clears the phase-2 persona registry alongside the hub state');
});

test('案内人 graduation phase 2 day screen: diary shows ルミ日記 and the character popup is 一枚絵 + name only (app.js + index.html + style.css)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');
  const fn = (name) => {
    const match = js.match(new RegExp(`\\n(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`));
    if (!match) throw new Error(`function not found in app.js: ${name}`);
    return match[0];
  };

  // ── Diary: the daytime diary partner resolves the 案内人 from the phase-2 registry (never the roster), so the
  // shared fetchCharacterDiary(persona.character_id) reads ルミ's journal — the same source as the hub picker. ──
  assert.match(fn('conversationDayDiaryPartner'), /const graduationPersona = graduationPersonaActorById\(activeCharacterId\);\s*\n\s*if \(graduationPersona\) return graduationPersona;\s*\n\s*const partner = selectableCharacters\.find/, 'the daytime diary resolves the 案内人 partner from the phase-2 registry (never the selectable roster, which throws for lina)');

  // ── Character popup: standee + name only, no ability section — the daytime mirror of the routing hub popup ─
  assert.match(fn('openConversationDayGraduationPersonaPopup'), /const persona = graduationPersonaActor\(\);[\s\S]*?document\.querySelector\('#conversation-day-graduation-popup'\)[\s\S]*?title\.textContent = persona\.display_name;[\s\S]*?setActorImageSource\(standee, characterSceneStandeeUrl\(persona\)\)[\s\S]*?popup\.hidden = false;/, 'the daytime 案内人 popup shows the persona standee + name from the phase-2 registry (fail-fast via graduationPersonaActor)');
  assert.doesNotMatch(fn('openConversationDayGraduationPersonaPopup'), /renderCharacterParametersInto|parameters/, 'the daytime 案内人 popup renders no ability/parameter section (the persona has no parameters)');
  assert.match(fn('closeConversationDayGraduationPersonaPopup'), /#conversation-day-graduation-popup'\);\s*\n\s*if \(!popup\)/, 'the daytime 案内人 popup close fail-fasts on missing markup');

  // The speaker-name click branches to the 案内人 popup while phase 2 is live, before the roster popup fallback.
  assert.match(js, /#conversation-day-message-stream'\)\.addEventListener\('click'[\s\S]*?isActiveAtelierConversation\(\)\) openConversationDayHomunculusPopup\(\);\s*\n\s*else if \(graduationPersonaActorById\(activeCharacterId\)\) openConversationDayGraduationPersonaPopup\(\);\s*\n\s*else openConversationDayCharacterPopup\(\);/, 'the daytime speaker-name click opens the 案内人 popup while phase 2 is live, before the roster popup');
  assert.match(js, /#conversation-day-graduation-popup \[data-day-popup-close\]'\)[\s\S]*?closeConversationDayGraduationPersonaPopup\(\)/, 'the daytime 案内人 popup close button + backdrop dismiss it');

  // ── Markup: hidden-by-default popup, standee image, name heading, and NO parameters section ──────────────
  const gradPopupBlock = html.match(/<div id="conversation-day-graduation-popup"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/)?.[0] ?? '';
  assert.notEqual(gradPopupBlock, '', 'the daytime 案内人 popup markup exists');
  assert.match(gradPopupBlock, /class="conversation-day-character-popup conversation-day-graduation-popup" hidden/, 'the 案内人 popup reuses the daytime character popup shell (黒夜 palette) and starts hidden');
  assert.match(gradPopupBlock, /class="conversation-day-character-popup-backdrop" data-day-popup-close="true"/, 'the 案内人 popup has a backdrop-click close affordance');
  assert.match(gradPopupBlock, /id="conversation-day-graduation-popup-standee"/, 'the 案内人 popup carries a standee (一枚絵) image');
  assert.doesNotMatch(gradPopupBlock, /-parameters|能力値/, 'the 案内人 popup markup carries NO ability/parameter section');

  // ── CSS: the popup narrows to the standee width and drops the parameter column, tokens only (no literal color) ──
  assert.match(css, /\.conversation-day-graduation-popup \.conversation-day-character-popup-card \{\s*\n\s*width: min\(420px, 84vw\);\s*\n\s*\}/, 'the 案内人 popup card narrows to the standee width (mirror of the routing hub popup)');
  assert.match(css, /\.conversation-day-graduation-popup \.conversation-day-character-popup-body \{\s*\n\s*grid-template-columns: minmax\(0, 1fr\);\s*\n\s*\}/, 'the 案内人 popup body drops the parameter column (single standee column)');
});
