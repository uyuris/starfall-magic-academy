// Render-backed academy-map stage-description refresh check (Electron / real Blink + real client flow).
//
// `node --test` cannot run the browser app (no DOM/layout, module functions never attach), so the
// "does the stage description reflect the persisted current situation, and does it follow changes
// instead of freezing" question is verified here against the REAL client in real Blink. This file is
// intentionally NOT named *.test.mjs and lives under app/tests/manual/, so `npm test`
// (node --test app/tests/*.test.mjs) skips it; run it by hand with the Electron binary:
//
//   ./node_modules/.bin/electron app/tests/manual/academyStageDescriptionRefreshRender.mjs
//
// It boots an isolated server (loop baseline, no LM Studio), then measures the DOM the real client
// actually renders for the current stage (薬草温室 / herbology_garden). The server is the single truth
// source for the current stage's situation (current_location_visible_situation), selected/persisted on
// move / event start / conversation stage-move; each of those routes is just "the truth changed", which
// is exactly what this harness drives with the field-move API and then reads back from the rendered DOM.
//
// What this proves: the fixed client's runtime WIRING — server state -> refresh() -> currentRuntimeState
// -> selectedAcademyStageSituation -> the stage-description DOM — actually reflects the persisted current
// situation and follows a change, in real Blink (a source-regex test cannot execute this path). The
// pre-fix bug was that the map read a session-start client random (academyMapStageSituationAssignments)
// with top precedence, shadowing the truth and freezing across normal re-renders.
//
// SCOPE NOTE (why this is a positive check, not a standalone pre-fix discriminator): the shadow store was
// only populated by the character-placement reroll, which no-ops when the selectable roster is empty. The
// isolated fixture materializes no selectable roster (characterCount = 0), so the pre-fix client also
// showed the truth here — reproducing the shadow in-harness would need the full character pipeline. The
// deterministic pre-fix/post-fix discrimination lives in app/tests/uiIntegration.academyMap.test.mjs (the
// selectedAcademyStageSituation precedence assertion + the academyMapStageSituationAssignments/
// randomStageSituation doesNotMatch guards fail on the pre-fix source and pass on the fix).
//
// Checks (all via real client flows + DOM reads, no module poking):
//   1. TRUTH REFLECTED  — with the server truth set to a specific non-default variant V1, the map's
//      stage preview text equals V1 (not the authored default, not a random assignment).
//   2. SUB-SCREEN REFLECTS — the companion screen reached via the real Go button shows V1.
//   3. RETURN NOT FROZEN — companion -> map (rerollAcademyMap:false), reopened preview still equals V1
//      (the pre-fix shadow would have shown its frozen session-start pick).
//   3b. SHOP RETURN NOT FROZEN — 購買 -> shop -> #shop-back-to-map -> map, reopened preview still equals V1.
//   3d. GATHERING RETURN NOT FROZEN — 採取 -> #gathering-back-to-map -> map, reopened preview still equals V1.
//   3e. DUNGEON RETURN NOT FROZEN — 実践/dungeon -> #dungeon-back-to-map -> map, reopened preview still equals V1.
//   3c. WEEK PROGRESSION KEEPS TRUTH — POST /api/academy/week/start (no LM) does not touch the academy stage
//      situation, so after refresh the map still shows the state-driven V1 (no freeze, no re-roll).
//   4. FOLLOWS CHANGE — after the server truth changes to V2 and the client refreshes (reload), the map
//      preview equals V2, not the stale V1. Move / event start / conversation stage-move all just persist a
//      new current_location_visible_situation, which this render-follow demonstrates.
//
// CONVERSATION-END NOTE: conversation end is NOT driven here. The real client hardcodes
// conversationProvider() === 'lmstudio' (app.js), so a UI-driven conversation end cannot run LM-free, and
// the isolated fixture has no selectable roster (characterCount = 0) to start a conversation from in the
// first place. Its situation-follow is instead covered by executed contract tests: the server persists
// current_location_visible_situation on end (conversationPipeline.test.mjs) and the client re-renders the
// map from the refreshed field on end (uiIntegration.academyMap.test.mjs); check 4 above exercises the identical
// "persisted truth changed -> render follows on refresh" mechanism that conversation end relies on.
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fixtureRoot, baselineRuntimeState } from '../helpers.mjs';
import { createServer } from '../../src/server.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WIN_W = Number(process.env.STAGE_WIN_W ?? 1200);
const WIN_H = Number(process.env.STAGE_WIN_H ?? 820);
const LOCATION_ID = 'herbology_garden';
const LOCATION_NAME = '薬草温室';
const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let server;
let exitCode = 0;

async function setServerTruth(base, situation) {
  const resp = await fetch(`${base}/api/field/move`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ location_id: LOCATION_ID, selected_visible_situation: situation })
  });
  const json = await resp.json();
  return json.state?.current_location_visible_situation ?? null;
}

async function waitFor(win, expr, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    if (await win.webContents.executeJavaScript(`(() => { try { return !!(${expr}); } catch { return false; } })()`)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const textOf = (win, selector) =>
  win.webContents.executeJavaScript(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? null)`);
const activeScreen = (win) => win.webContents.executeJavaScript(`document.querySelector('.screen.active')?.id ?? null`);

// Navigate to the academy map via the real topbar tab, wait for nodes, then click the named node,
// which opens the shared stage dialog (openAcademyMapLocationDialog -> renderAcademyMapLocationPreview).
async function openMapNodeDialog(win, nodeName) {
  await win.webContents.executeJavaScript(`document.querySelector('[data-screen="academy-map"]').click(); true`);
  if (!(await waitFor(win, `document.querySelectorAll('.academy-map-node').length > 0`))) return { ok: false, reason: 'no map nodes rendered' };
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const node = [...document.querySelectorAll('.academy-map-node')].find((b) => (b.getAttribute('aria-label') || '').startsWith(${JSON.stringify(nodeName)}));
    if (!node) return false;
    node.click();
    return true;
  })()`);
  if (!clicked) return { ok: false, reason: `map node not found: ${nodeName}` };
  if (!(await waitFor(win, `(document.querySelector('#academy-map-location-title')?.textContent || '') === ${JSON.stringify(nodeName)}`))) {
    return { ok: false, reason: `stage dialog did not open for: ${nodeName}` };
  }
  return { ok: true, text: (await textOf(win, '#academy-map-location-text'))?.trim() ?? null };
}
const openStageDialog = (win) => openMapNodeDialog(win, LOCATION_NAME);

// Drive a sub-screen round-trip via the real topbar tab and the sub-screen's own back-to-map button,
// then reopen the current stage and return its rendered description. Each back button runs
// showScreen('academy-map'[, {rerollAcademyMap:false}]) -> renderAcademyMap(currentField), the exact
// return-render the acceptance targets; the sub-screen never changes the current stage's situation, so
// the description must survive the round-trip unchanged (== truth).
async function subScreenReturnText(win, { tab, screenId, backButton }) {
  await win.webContents.executeJavaScript(`document.querySelector('[data-screen="${tab}"]').click(); true`);
  if (!(await waitFor(win, `document.querySelector('.screen.active')?.id === '${screenId}'`))) {
    return { ok: false, reason: `did not reach ${screenId}` };
  }
  await win.webContents.executeJavaScript(`document.querySelector('${backButton}').click(); true`);
  if (!(await waitFor(win, `document.querySelector('.screen.active')?.id === 'academy-map-screen'`))) {
    return { ok: false, reason: 'did not return to academy map' };
  }
  return openStageDialog(win);
}

async function main() {
  const locations = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'data/definitions/game_data/locations.json'), 'utf8'));
  const loc = locations.find((l) => l.id === LOCATION_ID);
  const variants = loc.visible_situation_variants ?? [];
  const V_DEFAULT = loc.visible_situation;
  const V1 = variants[3];
  const V2 = variants[5];
  if (!V1 || !V2 || V1 === V2 || V1 === V_DEFAULT || V2 === V_DEFAULT) {
    log('BAD_FIXTURE', { V_DEFAULT, V1, V2 }); exitCode = 2; app.quit(); return;
  }
  log('chosen_variants', { default: V_DEFAULT, V1, V2 });

  // Landing back on the academy map after a move renders the day week glyph, which fail-fasts on a missing
  // elapsed_weeks. Seed valid runtime state (the production runtime always carries it) so this harness
  // exercises the real move → map → conversation-partner popup flow instead of tripping the week fail-fast.
  const root = await fixtureRoot('academy-stage-desc-render-', { runtimeState: { ...baselineRuntimeState, elapsed_weeks: 0 } });
  const publicRoot = path.join(PROJECT_ROOT, 'app/public');
  server = createServer({
    root, activeRoot: root, publicRoot,
    lmStudioConfigPath: path.join(root, 'no-such-lmstudio.json'),
    playModeSettingsPath: path.join(root, 'no-such-play-mode.json')
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Persist V1 as the current stage's situation (the server truth), the way a move/event/conversation would.
  const persistedV1 = await setServerTruth(base, V1);
  log('server_truth_persisted', { requested: V1, persisted: persistedV1, match: persistedV1 === V1 });
  if (persistedV1 !== V1) { exitCode = 2; app.quit(); return; }

  await app.whenReady();
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(`${base}/`);
  await new Promise((r) => setTimeout(r, 1500)); // let app.js boot (refresh() pulls V1 into currentRuntimeState)

  // 1) TRUTH REFLECTED: the map preview shows V1, not the authored default and not a client random.
  const open1 = await openStageDialog(win);
  log('map_preview_after_truth_V1', open1);
  const truthReflected = open1.ok && open1.text === V1;
  console.log(`TRUTH REFLECTED (map shows persisted current situation V1, not default/random): ${truthReflected ? 'PASS' : 'FAIL'}`);
  if (!truthReflected) exitCode = 1;

  // 2) POPUP OPENS ON THE MAP: the real Go button confirms the stage, moves, and opens the day-styled
  //    conversation-partner popup over the map (no separate companion screen; the map stays active).
  await win.webContents.executeJavaScript(`document.querySelector('#academy-map-go-button').click(); true`);
  await waitFor(win, `document.querySelector('.screen.active')?.id === 'academy-map-screen'`);
  const popupVisible = await waitFor(win, `document.querySelector('#academy-map-companion-popup') && !document.querySelector('#academy-map-companion-popup').hidden`);
  const popupStage = (await textOf(win, '#academy-map-companion-popup-stage'))?.trim() ?? null;
  log('companion_popup', { screen: await activeScreen(win), visible: popupVisible, stage: popupStage });
  // The popup must actually open and name the confirmed stage (not the '舞台' HTML placeholder), which only
  // happens when renderAcademyMapCompanionPopup runs and academyMapLocationById resolves the moved-to stage.
  const popupOpened = popupVisible && popupStage !== null && popupStage.length > 0 && popupStage !== '舞台';
  console.log(`POPUP OPENS ON MAP (conversation-partner popup opens over the map naming the confirmed stage): ${popupOpened ? 'PASS' : 'FAIL'}`);
  if (!popupOpened) exitCode = 1;

  // 3) RETURN NOT FROZEN: close the popup (stay on map, move already committed), reopen the stage; still V1.
  await win.webContents.executeJavaScript(`document.querySelector('#academy-map-companion-popup .academy-map-info-popup-close').click(); true`);
  await waitFor(win, `document.querySelector('#academy-map-companion-popup')?.hidden === true`);
  const open2 = await openStageDialog(win);
  log('map_preview_after_return', open2);
  const returnNotFrozen = open2.ok && open2.text === V1;
  console.log(`RETURN NOT FROZEN (reopened map preview after the popup round-trip still shows V1): ${returnNotFrozen ? 'PASS' : 'FAIL'}`);
  if (!returnNotFrozen) exitCode = 1;

  // 3b) SHOP RETURN NOT FROZEN: 購買 node -> Go (showScreen('shop')) -> #shop-back-to-map
  // (showScreen('academy-map', {rerollAcademyMap:false})) -> reopen 薬草温室; still V1.
  const shopOpen = await openMapNodeDialog(win, '購買');
  log('shop_dialog', shopOpen);
  await win.webContents.executeJavaScript(`document.querySelector('#academy-map-go-button').click(); true`);
  await waitFor(win, `document.querySelector('.screen.active')?.id === 'shop-screen'`);
  await win.webContents.executeJavaScript(`document.querySelector('#shop-back-to-map').click(); true`);
  await waitFor(win, `document.querySelector('.screen.active')?.id === 'academy-map-screen'`);
  const open2b = await openStageDialog(win);
  log('map_preview_after_shop_return', open2b);
  const shopReturnNotFrozen = open2b.ok && open2b.text === V1;
  console.log(`SHOP RETURN NOT FROZEN (reopened map preview after shop round-trip still shows V1): ${shopReturnNotFrozen ? 'PASS' : 'FAIL'}`);
  if (!shopReturnNotFrozen) exitCode = 1;

  // 3d) GATHERING RETURN NOT FROZEN: 採取 sub-screen -> #gathering-back-to-map
  // (showScreen('academy-map', {rerollAcademyMap:false})) -> reopen 薬草温室; still V1.
  const open2d = await subScreenReturnText(win, { tab: 'gathering', screenId: 'gathering-screen', backButton: '#gathering-back-to-map' });
  log('map_preview_after_gathering_return', open2d);
  const gatheringReturnNotFrozen = open2d.ok && open2d.text === V1;
  console.log(`GATHERING RETURN NOT FROZEN (reopened map preview after gathering round-trip still shows V1): ${gatheringReturnNotFrozen ? 'PASS' : 'FAIL'}`);
  if (!gatheringReturnNotFrozen) exitCode = 1;

  // 3e) DUNGEON RETURN NOT FROZEN: 実践/dungeon sub-screen -> #dungeon-back-to-map
  // (showScreen('academy-map')) -> reopen 薬草温室; still V1.
  const open2e = await subScreenReturnText(win, { tab: 'academy-dungeon', screenId: 'academy-dungeon-screen', backButton: '#dungeon-back-to-map' });
  log('map_preview_after_dungeon_return', open2e);
  const dungeonReturnNotFrozen = open2e.ok && open2e.text === V1;
  console.log(`DUNGEON RETURN NOT FROZEN (reopened map preview after dungeon round-trip still shows V1): ${dungeonReturnNotFrozen ? 'PASS' : 'FAIL'}`);
  if (!dungeonReturnNotFrozen) exitCode = 1;

  // 3c) WEEK PROGRESSION KEEPS TRUTH: a new week (POST /api/academy/week/start, no LM) does not touch the
  // academy stage situation, so after a client refresh (reload) the map still shows the state-driven V1 —
  // not frozen at a stale client random and not re-randomized on the week boundary.
  const week = await (await fetch(`${base}/api/academy/week/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  log('week_started', { elapsed_weeks: week?.state?.elapsed_weeks ?? null, situation_after_week: week?.state?.current_location_visible_situation ?? null });
  await win.loadURL(`${base}/`);
  await new Promise((r) => setTimeout(r, 1500)); // fresh boot -> refresh() re-reads state after the week
  const open2c = await openStageDialog(win);
  log('map_preview_after_week', open2c);
  const weekKeepsTruth = open2c.ok && open2c.text === V1;
  console.log(`WEEK PROGRESSION KEEPS TRUTH (situation stays state-driven V1 across a new week, no freeze/re-roll): ${weekKeepsTruth ? 'PASS' : 'FAIL'}`);
  if (!weekKeepsTruth) exitCode = 1;

  // 4) FOLLOWS CHANGE: change the server truth to V2, refresh the client (reload), reopen; shows V2 not V1.
  const persistedV2 = await setServerTruth(base, V2);
  log('server_truth_changed', { requested: V2, persisted: persistedV2, match: persistedV2 === V2 });
  await win.loadURL(`${base}/`);
  await new Promise((r) => setTimeout(r, 1500)); // fresh boot -> refresh() pulls V2
  const open3 = await openStageDialog(win);
  log('map_preview_after_truth_V2', open3);
  const followsChange = open3.ok && open3.text === V2 && open3.text !== V1;
  console.log(`FOLLOWS CHANGE (map preview follows the new persisted situation V2, not frozen at V1): ${followsChange ? 'PASS' : 'FAIL'}`);
  if (!followsChange) exitCode = 1;

  console.log(`OVERALL: ${exitCode === 0 ? 'PASS' : 'FAIL'}`);
  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', () => { try { server?.close(); } catch {} process.exit(exitCode); });
