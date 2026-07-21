// Render-backed incompatible-save-slot degraded-card check (Electron / real Blink layout + real client flow).
//
// Task incompatible-slot-degraded-ui-frontend. A packaged install can carry a save slot whose meta.json is
// missing play_mode (a pre-play_mode save). The backend now keeps GET /api/slots at 200 and reports such slots
// under incompatible_slots (with active_slot_incompatible when one is the active slot). This drives the REAL
// client through the frontend degraded contract:
//   title → 「ロード」 → the load screen OPENS with both a normal card and degraded cards → each degraded card
//   shows a fixed reason (no migration CLI text), NO 「このデータで始める」 load button, and NO memo editor, only a
//   削除 button → delete each degraded slot through the confirmation dialog → the degraded cards disappear one by
//   one while the normal card stays → (active-incompatible variant) the resume 「プレイに戻る」 button is disabled
//   and the load screen still opens.
//
// The slots are created by direct backend POST /api/new-game calls (Node side) and then corrupted by deleting
// play_mode from meta.json — the same construction the server-side degraded tests use — so no LM is needed for
// this presentation/deletion flow.
//
// Negative control (bug-would-FAIL): before the fix, refreshSaveSlots resolved the play-mode route unconditionally,
// so a degraded active slot threw in resolvePlayModeEntryRoute and the load screen never opened (the title stayed
// active with a migration-CLI error). The ACTIVE-incompatible scenario below asserts the load screen OPENS and the
// resume button is disabled — both fail on the pre-fix code path. It also asserts no card surfaces the CLI text.
//
// `node --test` cannot run app.js (no fetch/DOM), so this runs against the REAL client in Electron. Not named
// *.test.mjs and under app/tests/manual/, so `npm test` skips it; run by hand:
//
//   ./node_modules/.bin/electron app/tests/manual/slotLoadDegradedRender.mjs
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'app/public');
const REPO_CANONICAL = path.join(PROJECT_ROOT, 'assets/canonical');
const WIN_W = 1200;
const WIN_H = 820;
const MIGRATION_CLI_FRAGMENT = 'stamp-slot-play-mode';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);
const results = [];
function check(name, pass, detail = {}) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
}

const { createServer } = await import(path.join(PROJECT_ROOT, 'app/src/server.mjs'));
const { fixtureRoot } = await import(path.join(PROJECT_ROOT, 'app/tests/helpers.mjs'));
const { runtimePathsManifestFilename } = await import(path.join(PROJECT_ROOT, 'app/src/runtimePaths.mjs'));

async function makeFixture(slug) {
  const root = await fixtureRoot(`${slug}-`);
  await fs.writeFile(path.join(root, runtimePathsManifestFilename), `${JSON.stringify({
    configRoot: path.join(root, 'app/config'),
    definitionsRoot: path.join(root, 'game_data'),
    seedsRoot: path.join(root, 'game_data'),
    mutableRoot: path.join(root, 'game_data'),
    characterContentRoot: path.join(root, 'game_data/characters'),
    creatureContentRoot: path.join(root, 'game_data/creatures'),
    canonicalAssetsRoot: REPO_CANONICAL,
    publicRoot: PUBLIC_ROOT,
    resourceRoot: root
  }, null, 2)}\n`, 'utf8');
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), `${slug}-settings-`));
  const settingsPath = path.join(settingsDir, 'play-mode.json');
  // loop settings so POST /api/new-game creates slots without requiring an LM (routing new-game would too, but
  // loop keeps the sidecar simple; the slots' own play_mode is what the degraded shape removes below).
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'loop' }, null, 2)}\n`, 'utf8');
  return { root, settingsDir, settingsPath };
}

async function startGameServer({ root, settingsPath }) {
  const server = createServer({
    root,
    publicRoot: PUBLIC_ROOT,
    canonicalAssetsRoot: REPO_CANONICAL,
    playModeSettingsPath: settingsPath
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function jsonPost(base, route, body) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {})
  });
  if (!response.ok) throw new Error(`${route} -> ${response.status} ${await response.text()}`);
  return response.json();
}

async function degradeSlotMeta(root, slotId) {
  const metaPath = path.join(root, 'game_data/play/slots', slotId, 'meta.json');
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  delete meta.play_mode;
  delete meta.routing_persona_variant;
  await fs.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let win;
let exitCode = 0;
const cleanups = [];

async function waitFor(predicate, { tries = 200, intervalMs = 100 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const ok = await win.webContents.executeJavaScript(`(() => { try { return !!(${predicate}); } catch (e) { return false; } })()`);
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}
const js = (expr) => win.webContents.executeJavaScript(expr);

async function reloadToTitle(base) {
  await win.loadURL(`${base}/`);
  await waitFor(`document.querySelector('#title-screen')?.classList.contains('active')`, { tries: 200, intervalMs: 100 });
  // Boot runs Promise.all([refreshSaveSlots, refresh, loadConversationPopupSettings]).then(applyInitialScreenOverride),
  // and applyInitialScreenOverride() calls showScreen('title') with no ?initialScreen — a LATE boot resolution
  // can yank the screen back to title after we've already opened the load screen (a fixed 400ms sleep is not
  // enough because refresh() is heavy). Wait until the title-screen class stops mutating for a settle window, so
  // that trailing boot showScreen('title') has already fired and no further boot navigation is pending.
  await waitForBootSettled();
}

// Wait until the boot chain's trailing applyInitialScreenOverride() (showScreen('title')) has fired and the screen
// has been stably 'title' for a settle window, so a later boot-driven showScreen('title') cannot interrupt an
// interaction. Deterministic: it requires N consecutive stable polls with the title active and no transition.
async function waitForBootSettled() {
  await js(`(() => {
    window.__bootScreenChanges = 0;
    const title = document.querySelector('#title-screen');
    new MutationObserver(() => { window.__bootScreenChanges += 1; }).observe(title, { attributes: true, attributeFilter: ['class'] });
  })()`);
  let stable = 0;
  let last = -1;
  for (let i = 0; i < 200; i += 1) {
    const changes = await js(`window.__bootScreenChanges`);
    const active = await js(`document.querySelector('.screen.active')?.id ?? null`);
    if (active === 'title-screen' && changes === last) stable += 1;
    else stable = 0;
    last = changes;
    if (stable >= 8) return true; // ~800ms of no title-class mutation
    await sleep(100);
  }
  return false;
}

// Read the slot-load list DOM into a structured description of every card (normal + degraded).
function readSlotLoadDom() {
  return js(`(() => {
    const active = document.querySelector('.screen.active')?.id ?? null;
    const cards = Array.from(document.querySelectorAll('#slot-load-list .slot-load-item')).map((el) => ({
      degraded: el.classList.contains('slot-load-item-degraded'),
      hasLoadButton: !!el.querySelector('.academy-map-action-button.primary'),
      hasDeleteButton: Array.from(el.querySelectorAll('button')).some((b) => b.textContent.trim() === '削除'),
      hasNoteEditor: !!el.querySelector('.slot-load-note-editor'),
      text: (el.textContent || '').trim(),
      slotId: (el.querySelector('strong')?.textContent || '').trim()
    }));
    return {
      active,
      cards,
      listText: (document.querySelector('#slot-load-list')?.textContent || '').trim(),
      resumeDisabled: !!document.querySelector('#slot-load-resume-play')?.disabled
    };
  })()`);
}

// Open the load screen from the title's 「ロード」 button.
async function openLoadFromTitle() {
  await js(`document.querySelector('#open-load-screen').click(); true`);
  const opened = await waitFor(`document.querySelector('#slot-load-screen')?.classList.contains('active') && document.querySelectorAll('#slot-load-list .slot-load-item').length > 0`, { tries: 200, intervalMs: 100 });
  if (!opened) {
    const post = await js(`(() => ({ active: document.querySelector('.screen.active')?.id ?? null, titleStatus: (document.querySelector('#title-status')?.textContent || '').trim(), items: document.querySelectorAll('#slot-load-list .slot-load-item').length }))()`);
    log('open_failed_diag', post);
  }
  return opened;
}

// Delete the degraded card whose strong-title equals slotId, through the confirmation dialog.
async function deleteDegradedSlot(slotId) {
  const clicked = await js(`(() => {
    const card = Array.from(document.querySelectorAll('#slot-load-list .slot-load-item.slot-load-item-degraded'))
      .find((el) => (el.querySelector('strong')?.textContent || '').trim() === ${JSON.stringify(slotId)});
    if (!card) return false;
    const btn = Array.from(card.querySelectorAll('button')).find((b) => b.textContent.trim() === '削除');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  if (!clicked) return false;
  await waitFor(`document.querySelector('#slot-load-delete-confirm-dialog')?.open`, { tries: 80, intervalMs: 50 });
  const confirmed = await js(`(() => { const b = document.querySelector('#slot-load-delete-confirm-submit'); if (!b) return false; b.click(); return true; })()`);
  if (!confirmed) return false;
  // The card for this slot should disappear from the list.
  const gone = await waitFor(`!Array.from(document.querySelectorAll('#slot-load-list .slot-load-item.slot-load-item-degraded'))
    .some((el) => (el.querySelector('strong')?.textContent || '').trim() === ${JSON.stringify(slotId)})`, { tries: 120, intervalMs: 100 });
  const diag = await js(`(async () => {
    const listed = await fetch('/api/slots').then((r) => r.json());
    return { active: document.querySelector('.screen.active')?.id ?? null, backendSlots: (listed.slots ?? []).map((s) => s.slot_id), backendIncompatible: (listed.incompatible_slots ?? []).map((e) => e.slot_id), activeSlotIncompatible: listed.active_slot_incompatible };
  })()`);
  log('post_delete_diag', { slotId, gone, ...diag });
  return gone;
}

// Scenario A: a COMPATIBLE active slot + TWO degraded slots. Assert the load screen shows one normal + two
// degraded cards, delete both degraded slots, and observe the normal card survive.
async function scenarioNormalPlusTwoDegraded() {
  const fx = await makeFixture('slot-degraded-normal-plus-two');
  cleanups.push(fx.root, fx.settingsDir);
  const { server, base } = await startGameServer({ root: fx.root, settingsPath: fx.settingsPath });
  cleanups.push(() => server.close());
  log('scenario', { name: 'normal-plus-two-degraded', base });

  const ok = await jsonPost(base, '/api/new-game');
  const degradedA = await jsonPost(base, '/api/new-game');
  const degradedB = await jsonPost(base, '/api/new-game');
  // Make the compatible slot the active one, then corrupt the other two.
  await jsonPost(base, '/api/slots/load', { slot_id: ok.slot.slot_id });
  await degradeSlotMeta(fx.root, degradedA.slot.slot_id);
  await degradeSlotMeta(fx.root, degradedB.slot.slot_id);
  log('slots', { ok: ok.slot.slot_id, degradedA: degradedA.slot.slot_id, degradedB: degradedB.slot.slot_id });

  await reloadToTitle(base);
  const opened = await openLoadFromTitle();
  const dom = await readSlotLoadDom();
  log('opened_dom', { opened, active: dom.active, cardCount: dom.cards.length });
  check('OPEN: title→「ロード」 opens the load screen with a normal card + degraded cards coexisting',
    Boolean(opened && dom.active === 'slot-load-screen' && dom.cards.length === 3
      && dom.cards.filter((c) => !c.degraded).length === 1
      && dom.cards.filter((c) => c.degraded).length === 2),
    { active: dom.active, normal: dom.cards.filter((c) => !c.degraded).length, degraded: dom.cards.filter((c) => c.degraded).length });

  const degradedCards = dom.cards.filter((c) => c.degraded);
  check('DEGRADED CARD: each degraded card has a 削除 button but NO load button and NO note editor',
    degradedCards.length === 2 && degradedCards.every((c) => c.hasDeleteButton && !c.hasLoadButton && !c.hasNoteEditor),
    degradedCards.map((c) => ({ del: c.hasDeleteButton, load: c.hasLoadButton, note: c.hasNoteEditor })));
  check('DEGRADED CARD: the reason text does NOT contain the migration CLI command',
    !dom.listText.includes(MIGRATION_CLI_FRAGMENT) && dom.listText.includes('旧バージョンのセーブデータ'),
    { hasCli: dom.listText.includes(MIGRATION_CLI_FRAGMENT) });

  const normalCard = dom.cards.find((c) => !c.degraded);
  check('NORMAL CARD: the compatible slot keeps its load button and note editor',
    Boolean(normalCard && normalCard.hasLoadButton && normalCard.hasNoteEditor && normalCard.hasDeleteButton),
    { load: normalCard?.hasLoadButton, note: normalCard?.hasNoteEditor });

  // Delete both degraded slots in turn; the normal card must remain and the screen stays on slot-load.
  const deletedA = await deleteDegradedSlot(degradedA.slot.slot_id);
  const midDom = await readSlotLoadDom();
  check('DELETE 1/2: deleting the first incompatible slot leaves it removed while staying on the load screen',
    Boolean(deletedA && midDom.active === 'slot-load-screen' && midDom.cards.filter((c) => c.degraded).length === 1),
    { active: midDom.active, degradedLeft: midDom.cards.filter((c) => c.degraded).length });

  const deletedB = await deleteDegradedSlot(degradedB.slot.slot_id);
  const finalDom = await readSlotLoadDom();
  check('DELETE 2/2: deleting the second incompatible slot removes it too, leaving only the normal card on the load screen',
    Boolean(deletedB && finalDom.active === 'slot-load-screen'
      && finalDom.cards.filter((c) => c.degraded).length === 0
      && finalDom.cards.filter((c) => !c.degraded).length === 1),
    { active: finalDom.active, degradedLeft: finalDom.cards.filter((c) => c.degraded).length, normalLeft: finalDom.cards.filter((c) => !c.degraded).length });

  const shot = path.join(os.tmpdir(), `slot-load-degraded-normal-plus-two-${Date.now()}.png`);
  try {
    const image = await win.webContents.capturePage();
    await fs.writeFile(shot, image.toPNG());
    log('screenshot', { path: shot });
  } catch (e) {
    log('screenshot_error', { error: String(e) });
  }
}

// Scenario B: the ACTIVE slot is degraded. The load screen must still OPEN (200 contract), the resume button must
// be DISABLED (no resumable play session), and no card surfaces the CLI text. This is the pre-fix FAIL case:
// before the fix, opening the load screen threw in resolvePlayModeEntryRoute on the null active_play_mode.
async function scenarioActiveIncompatible() {
  const fx = await makeFixture('slot-degraded-active');
  cleanups.push(fx.root, fx.settingsDir);
  const { server, base } = await startGameServer({ root: fx.root, settingsPath: fx.settingsPath });
  cleanups.push(() => server.close());
  log('scenario', { name: 'active-incompatible', base });

  // One compatible slot + one degraded slot; leave the degraded one active (do not load the compatible one).
  const ok = await jsonPost(base, '/api/new-game');
  const degraded = await jsonPost(base, '/api/new-game'); // the second new-game leaves this slot active
  await degradeSlotMeta(fx.root, degraded.slot.slot_id);
  log('slots', { ok: ok.slot.slot_id, degradedActive: degraded.slot.slot_id });

  await reloadToTitle(base);
  const opened = await openLoadFromTitle();
  const dom = await readSlotLoadDom();
  log('active_incompat_dom', { opened, active: dom.active, resumeDisabled: dom.resumeDisabled, cardCount: dom.cards.length });
  check('ACTIVE-INCOMPATIBLE: the load screen still OPENS with a degraded active slot (200 contract; pre-fix this threw)',
    Boolean(opened && dom.active === 'slot-load-screen' && dom.cards.some((c) => c.degraded)),
    { opened, active: dom.active });
  check('ACTIVE-INCOMPATIBLE: the 「プレイに戻る」 resume導線 is disabled for a degraded active slot',
    dom.resumeDisabled === true, { resumeDisabled: dom.resumeDisabled });
  check('ACTIVE-INCOMPATIBLE: no card surfaces the migration CLI command',
    !dom.listText.includes(MIGRATION_CLI_FRAGMENT), { hasCli: dom.listText.includes(MIGRATION_CLI_FRAGMENT) });

  // The degraded active slot can still be deleted; after deletion the active slot is nulled and the normal card
  // survives (delete decoupled from strict re-list — the backend contract this frontend consumes).
  const deleted = await deleteDegradedSlot(degraded.slot.slot_id);
  const finalDom = await readSlotLoadDom();
  check('ACTIVE-INCOMPATIBLE: the degraded active slot deletes from the UI, leaving the normal card',
    Boolean(deleted && finalDom.active === 'slot-load-screen'
      && finalDom.cards.filter((c) => c.degraded).length === 0
      && finalDom.cards.filter((c) => !c.degraded).length === 1),
    { active: finalDom.active, normalLeft: finalDom.cards.filter((c) => !c.degraded).length });
}

async function main() {
  await app.whenReady();
  win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) console.log(`renderer-error: ${message}`); });

  await scenarioNormalPlusTwoDegraded();
  await scenarioActiveIncompatible();

  const failed = results.filter((r) => !r.pass);
  console.log(`SUMMARY: ${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}`);
  if (failed.length) exitCode = 1;
  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', async () => {
  for (const c of cleanups) {
    try {
      if (typeof c === 'function') c();
      else await fs.rm(c, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
  process.exit(exitCode);
});
