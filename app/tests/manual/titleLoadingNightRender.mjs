// Render-backed title + loading metaphysical-moonlight check (Electron / real Blink computed style + ambient).
//
// `node --test` cannot resolve computed backgrounds, a canvas ambient's rAF draw, or the reduced-motion media
// query against real layout, so the title screen and the academy loading screen are verified here against the
// REAL client in Electron. This file is intentionally NOT named *.test.mjs and lives under app/tests/manual/,
// so `npm test` (node --test app/tests/*.test.mjs) skips it; run it by hand:
//
//   ./node_modules/.bin/electron app/tests/manual/titleLoadingNightRender.mjs
//
// Section A — TITLE (real showScreen('title') via the default startup at /): the title screen is driven by the
// real init override, so its starfield ambient starts through the real showScreen wiring. It measures:
//   - the .title-hero-screen computed background resolves the NIGHT art (/canonical/title/title_night.jpg),
//     never the removed daytime title.jpg;
//   - the #title-starfield canvas is laid out (width/height > 0) and the shared ambient drew an ANIMATED field
//     (canvas.dataset.starfield === 'animated');
//   - the drifting decor + corner ornament <img>s decoded.
//
// Section B — LOADING (real showScreen('academy-loading') via the routing entry): entering the routing hub
// from the title shows the academy loading screen WHILE POST /api/routing/hub/start is in flight, so the real
// showScreen('academy-loading') runs and starts the loading starfield. The hub start needs LM, which the
// harness cannot drive, so section B doubles ONLY that one endpoint with a delayed canned response so the
// in-flight loading screen is samplable. It measures, during the in-flight window:
//   - #academy-loading-screen is active and the .academy-loading-background computed background resolves the
//     NIGHT art (/canonical/load/loading_night.jpg), never a removed rotating ig_* image;
//   - the #academy-loading-starfield canvas is laid out and drew an ANIMATED field.
//
// Section C — TITLE under REDUCED MOTION (CDP Emulation.setEmulatedMedia): with prefers-reduced-motion:reduce
// emulated, the shared ambient must draw a single STATIC field and run no rAF loop (canvas.dataset.starfield
// === 'static'). Measured on the title starfield.
//
// Section D — LOADING under REDUCED MOTION: the emulation is still active, so re-driving the routing entry
// shows the academy loading screen under prefers-reduced-motion; the #academy-loading-starfield must likewise
// draw a single STATIC field. This gives both meta screens a direct reduced-motion render probe (not inference).
// It also measures the constellation's POSITIVE boundary progression: reduced motion draws each observed event
// synchronously (no rAF timing race), so once the doubled hub-start resolves and the real enterRoutingHub fires
// its POST + refresh boundary notifies, the traced-segment count advances past zero — the report's routing-entry
// 0-edge negative reproduction flipped positive by the call-site wiring.
//
// Two screenshots (the night title; the night loading screen) are saved for うゆりす's visual confirmation.
// Per ref-camera, the harness is fire-and-forget (no top-level await main(); whenReady would deadlock).
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

const { createServer } = await import(path.join(PROJECT_ROOT, 'app/src/server.mjs'));
const { fixtureRoot } = await import(path.join(PROJECT_ROOT, 'app/tests/helpers.mjs'));
const { runtimePathsManifestFilename } = await import(path.join(PROJECT_ROOT, 'app/src/runtimePaths.mjs'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);
const results = [];
function check(name, pass, detail = {}) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
}

async function routingFixture() {
  const root = await fixtureRoot('title-loading-night-render-');
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
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'title-loading-night-render-settings-'));
  const settingsPath = path.join(settingsDir, 'play-mode.json');
  // Routing mode so the real new-game entry resolves to the routing branch (its loading screen is section B).
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');
  const convPopupSettingsPath = path.join(settingsDir, 'conversation-popup.json');
  return { root, settingsDir, settingsPath, convPopupSettingsPath };
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let server;
let cleanupPaths = [];
let exitCode = 0;

async function waitFor(win, predicate, { tries = 200, intervalMs = 100 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const ok = await win.webContents.executeJavaScript(`(() => { try { return !!(${predicate}); } catch (e) { return false; } })()`);
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}

const js = (win, expr) => win.webContents.executeJavaScript(expr);

// Double ONLY /api/routing/hub/start on the current page: after a 1.2s delay so the in-flight loading screen is
// samplable, return a canned valid hub. Everything else (new-game slot creation, the real screen transitions
// and renders) hits the real server / real app.
async function installHubStartDouble(win) {
  await js(win, `(() => {
    const realFetch = window.fetch.bind(window);
    const canned = {
      conversation: {
        id: 'harness_hub_conv',
        routing_hub: true,
        character_id: 'lina',
        character_name: 'ルミ',
        messages: [{ role: 'assistant', content: 'こんばんは。今週はどこへ向かう？' }]
      },
      routing_persona_visual: {
        character_id: 'lina',
        display_name: 'ルミ',
        visual_set_id: 'routing_lumi_fallen_star',
        face_url: '/canonical/character_visual_sets/routing_lumi_fallen_star/face_emotions/neutral.jpg',
        selection_icon_url: '/canonical/character_visual_sets/routing_lumi_fallen_star/face_emotions/neutral.jpg',
        standee_url: '/canonical/character_visual_sets/routing_lumi_fallen_star/scene_standee/scene_standee_character_01.jpg'
      },
      state: { elapsed_weeks: 0 }
    };
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('/api/routing/hub/start')) {
        return new Promise((resolve) => setTimeout(() => resolve(
          new Response(JSON.stringify(canned), { status: 200, headers: { 'content-type': 'application/json' } })
        ), 1200));
      }
      return realFetch(input, init);
    };
    return true;
  })()`);
}

async function freshTitleScreen(win, base) {
  await win.loadURL(`${base}/`);
  await waitFor(win, `document.querySelector('#title-screen').classList.contains('active') && !!document.querySelector('#start-new-game')`, { tries: 100, intervalMs: 50 });
}

// Read the current title-screen render probe (background art + starfield ambient dataset + decor decode).
async function probeTitle(win) {
  // Give the ambient a couple of animation frames to set its dataset + draw.
  await sleep(400);
  return js(win, `(() => {
    const hero = document.querySelector('#title-screen');
    const star = document.querySelector('#title-starfield');
    const decor = document.querySelector('.title-decor-1');
    const corner = document.querySelector('.title-corner-tl');
    return {
      titleActive: hero.classList.contains('active'),
      heroBg: getComputedStyle(hero).backgroundImage,
      starfield: star ? star.dataset.starfield : null,
      starW: star ? star.width : 0,
      starH: star ? star.height : 0,
      decorDecoded: !!decor && decor.complete && decor.naturalWidth > 0,
      cornerDecoded: !!corner && corner.complete && corner.naturalWidth > 0
    };
  })()`);
}

async function main() {
  const { root, settingsDir, settingsPath, convPopupSettingsPath } = await routingFixture();
  cleanupPaths = [root, settingsDir];

  server = createServer({
    root,
    publicRoot: PUBLIC_ROOT,
    canonicalAssetsRoot: REPO_CANONICAL,
    playModeSettingsPath: settingsPath,
    conversationPopupSettingsPath: convPopupSettingsPath,
    lmStudioConfig: { base_url: 'http://127.0.0.1:0/v1', chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  log('server', { base, playMode: 'routing' });

  await app.whenReady();
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) console.log(`renderer-error: ${message}`); });

  const shotDir = path.join(os.tmpdir(), 'title-loading-night-render');
  await fs.mkdir(shotDir, { recursive: true });

  // ---- Section A: TITLE (real showScreen('title')) ----
  await freshTitleScreen(win, base);
  await waitFor(win, `(() => { const s = document.querySelector('#title-starfield'); return !!s && s.dataset.starfield === 'animated'; })()`, { tries: 120, intervalMs: 40 });
  const title = await probeTitle(win);
  log('title_probe', title);
  check('TITLE: the .title-hero-screen computed background resolves the night art (/canonical/title/title_night.jpg) and never the removed daytime title.jpg',
    title.titleActive === true && title.heroBg.includes('title_night.jpg') && !title.heroBg.includes('/title.jpg'),
    { heroBg: title.heroBg });
  check('TITLE: the #title-starfield canvas is laid out and the shared ambient drew an ANIMATED field (dataset.starfield === animated)',
    title.starfield === 'animated' && title.starW > 0 && title.starH > 0,
    { starfield: title.starfield, starW: title.starW, starH: title.starH });
  check('TITLE: the drifting decor and corner ornament images decoded', title.decorDecoded && title.cornerDecoded,
    { decorDecoded: title.decorDecoded, cornerDecoded: title.cornerDecoded });
  await waitFor(win, `(() => { const i = document.querySelector('.title-corner-tl'); return !!i && i.complete && i.naturalWidth > 0; })()`, { tries: 120, intervalMs: 40 });
  await sleep(300);
  const titleShot = path.join(shotDir, 'title-night.png');
  try { await fs.writeFile(titleShot, (await win.webContents.capturePage()).toPNG()); console.log(`screenshot: ${titleShot}`); }
  catch (e) { console.log(`screenshot: FAILED ${e?.message ?? e}`); }

  // ---- Section B: LOADING (real showScreen('academy-loading') via the routing entry) ----
  await installHubStartDouble(win);
  await js(win, `document.querySelector('#start-new-game').click(); true`);
  const sawLoading = await waitFor(win, `document.querySelector('#academy-loading-screen').classList.contains('active')`, { tries: 160, intervalMs: 20 });
  // Let the loading ambient set its dataset + draw while the hub start is still in flight.
  await sleep(400);
  const loading = await js(win, `(() => {
    const screen = document.querySelector('#academy-loading-screen');
    const bg = document.querySelector('.academy-loading-background');
    const star = document.querySelector('#academy-loading-starfield');
    const shell = document.querySelector('.academy-loading-shell');
    const con = document.querySelector('#academy-loading-constellation');
    return {
      loadingActive: screen.classList.contains('active'),
      bgImage: bg ? getComputedStyle(bg).backgroundImage : null,
      starfield: star ? star.dataset.starfield : null,
      starW: star ? star.width : 0,
      starH: star ? star.height : 0,
      hasOldImage: !!document.querySelector('#academy-loading-image'),
      // Flat full-screen-direct: the shell spans (near) the full viewport width with no floating-window border.
      shellWidth: shell ? Math.round(shell.getBoundingClientRect().width) : 0,
      shellBorder: shell ? getComputedStyle(shell).borderTopWidth : null,
      constellation: con ? { mode: con.dataset.constellation, revealed: con.dataset.constellationRevealed, w: con.width, h: con.height } : null
    };
  })()`);
  log('loading_probe', loading);
  check('LOADING: while the routing hub start is in flight, #academy-loading-screen is active with the .academy-loading-background night art (/canonical/load/loading_night.jpg) and no removed image element',
    sawLoading && loading.loadingActive === true && !!loading.bgImage && loading.bgImage.includes('loading_night.jpg') && loading.hasOldImage === false,
    { bgImage: loading.bgImage, hasOldImage: loading.hasOldImage });
  check('LOADING: the #academy-loading-starfield canvas is laid out and the shared ambient drew an ANIMATED field (dataset.starfield === animated)',
    loading.starfield === 'animated' && loading.starW > 0 && loading.starH > 0,
    { starfield: loading.starfield, starW: loading.starW, starH: loading.starH });
  check('LOADING: the loading shell is a flat full-screen-direct surface (spans the viewport width, no floating-window border)',
    loading.shellWidth >= WIN_W - 4 && (loading.shellBorder === '0px' || loading.shellBorder === null || loading.shellBorder === ''),
    { shellWidth: loading.shellWidth, winW: WIN_W, shellBorder: loading.shellBorder });
  // Armed-at-entry: sampled ~400ms in, while the doubled hub-start POST is still pending, no observed boundary has
  // fired yet so the figure sits at zero traced segments. The routing entry is no longer stuck at zero forever —
  // the POST + refresh boundaries advance it once the start resolves; that positive progression is measured
  // deterministically under reduced motion in section D (synchronous per-event draw, no rAF timing race).
  check('LOADING: the #academy-loading-constellation overlay is laid out over the starfield and armed in ANIMATED mode, reset to zero traced segments (dataset.constellation === animated, revealed === 0)',
    !!loading.constellation && loading.constellation.mode === 'animated' && Number(loading.constellation.revealed) === 0 && loading.constellation.w > 0 && loading.constellation.h > 0,
    loading.constellation);
  // Sky-band placement probe: compute the deterministic figure for the REAL laid-out overlay canvas dimensions and
  // confirm every node falls inside the upper sky band, so the traced silver lines cannot reach the bridge/foreground.
  const skyBand = await js(win, `(async () => {
    const mod = await import('/loadingConstellation.js');
    const con = document.querySelector('#academy-loading-constellation');
    const w = con.width, h = con.height;
    const nodes = mod.buildLoadingConstellationNodes(w, h, 14);
    const ys = nodes.map((n) => n.y);
    const maxY = Math.max(...ys), minY = Math.min(...ys);
    return { w, h, band: mod.LOADING_CONSTELLATION_SKY_BAND, minY, maxY, minYFrac: minY / h, maxYFrac: maxY / h };
  })()`);
  log('constellation_sky_band_probe', skyBand);
  check('LOADING: every constellation node computed for the real laid-out overlay canvas sits within the upper sky band (top <= y fraction <= bottom)',
    !!skyBand && skyBand.maxYFrac <= skyBand.band.bottom + 1e-9 && skyBand.minYFrac >= skyBand.band.top - 1e-9,
    skyBand);
  // Render evidence: the live app advances the figure only on real progress events, which this harness does not
  // emit, so drive a fresh instance bound to the same overlay canvas to the full figure. This is screenshot-only
  // (it does not touch app state) so the saved night-loading shot shows the traced lines confined to the sky.
  await js(win, `(async () => {
    const mod = await import('/loadingConstellation.js');
    const c = mod.createLoadingConstellation({ canvasSelector: '#academy-loading-constellation', lineColorRgb: '198, 212, 255', nodeColorRgb: '224, 232, 255', nodeCount: 14 });
    c.start();
    for (let i = 0; i < 13; i += 1) c.notifyProgress();
    return true;
  })()`);
  await sleep(650); // let the newest segment's grow animation complete before capturing
  const loadingShot = path.join(shotDir, 'loading-night.png');
  try { await fs.writeFile(loadingShot, (await win.webContents.capturePage()).toPNG()); console.log(`screenshot: ${loadingShot}`); }
  catch (e) { console.log(`screenshot: FAILED ${e?.message ?? e}`); }
  // Let the hub entry settle (the doubled start resolves ~1.2s after the click) so the run ends cleanly.
  await waitFor(win, `document.querySelector('#routing-hub-screen').classList.contains('active')`, { tries: 200, intervalMs: 50 });
  await sleep(500);

  // ---- Section C: REDUCED MOTION (CDP Emulation.setEmulatedMedia) ----
  // Emulate prefers-reduced-motion:reduce and reload the title: the shared ambient must draw a single STATIC
  // field (dataset.starfield === 'static'), the same reduced-motion contract the loading starfield shares.
  let reducedMotionApplied = true;
  try {
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    });
  } catch (e) {
    reducedMotionApplied = false;
    console.log(`reduced-motion emulation: FAILED ${e?.message ?? e}`);
  }
  await freshTitleScreen(win, base);
  const staticSeen = await waitFor(win, `(() => { const s = document.querySelector('#title-starfield'); return !!s && s.dataset.starfield === 'static'; })()`, { tries: 120, intervalMs: 40 });
  const reduced = await js(win, `(() => { const s = document.querySelector('#title-starfield'); return { starfield: s ? s.dataset.starfield : null, w: s ? s.width : 0 }; })()`);
  log('reduced_motion_probe', reduced);
  check('REDUCED MOTION (title): with prefers-reduced-motion:reduce emulated, the #title-starfield ambient draws a single STATIC field (dataset.starfield === static)',
    reducedMotionApplied && staticSeen && reduced.starfield === 'static' && reduced.w > 0,
    { reducedMotionApplied, starfield: reduced.starfield });

  // ---- Section D: LOADING under REDUCED MOTION (routing entry, emulation still active) ----
  // Re-drive the routing entry (the section C reload wiped the double) and measure the in-flight loading screen:
  // the #academy-loading-starfield must also draw a single STATIC field under prefers-reduced-motion.
  await installHubStartDouble(win);
  await js(win, `document.querySelector('#start-new-game').click(); true`);
  const sawLoadingReduced = await waitFor(win, `document.querySelector('#academy-loading-screen').classList.contains('active')`, { tries: 160, intervalMs: 20 });
  await sleep(400);
  const loadingReduced = await js(win, `(() => {
    const star = document.querySelector('#academy-loading-starfield');
    const con = document.querySelector('#academy-loading-constellation');
    return {
      loadingActive: document.querySelector('#academy-loading-screen').classList.contains('active'),
      starfield: star ? star.dataset.starfield : null,
      w: star ? star.width : 0,
      constellationMode: con ? con.dataset.constellation : null,
      constellationW: con ? con.width : 0
    };
  })()`);
  log('loading_reduced_motion_probe', loadingReduced);
  check('REDUCED MOTION (loading): with prefers-reduced-motion:reduce emulated, the #academy-loading-starfield ambient draws a single STATIC field (dataset.starfield === static)',
    reducedMotionApplied && sawLoadingReduced && loadingReduced.loadingActive === true && loadingReduced.starfield === 'static' && loadingReduced.w > 0,
    loadingReduced);
  check('REDUCED MOTION (loading): the #academy-loading-constellation overlay is armed in STATIC mode so revealed segments draw without animation (dataset.constellation === static)',
    reducedMotionApplied && loadingReduced.constellationMode === 'static' && loadingReduced.constellationW > 0,
    { constellationMode: loadingReduced.constellationMode, constellationW: loadingReduced.constellationW });
  // Positive boundary progression (the report's routing-entry 0-edge negative reproduction flipped positive): the
  // doubled hub-start POST resolves after its delay, and the REAL enterRoutingHub advances the constellation at the
  // POST boundary and again after the refresh, before it hands off to the routing hub. Under reduced motion each
  // observed event draws synchronously (redraw(1) with no rAF), so the segment count is set the instant each
  // boundary notify fires; the handoff's stop() leaves that count on the canvas dataset. Wait for the entry to
  // complete, then assert the figure advanced past the armed zero — proof the wired POST/refresh boundaries fire
  // while the loader is up on a routing entry (previously it stayed at zero traced segments the whole entry).
  await waitFor(win, `document.querySelector('#routing-hub-screen').classList.contains('active')`, { tries: 200, intervalMs: 50 });
  await sleep(300);
  const boundaryRevealed = await js(win, `document.querySelector('#academy-loading-constellation').dataset.constellationRevealed`);
  log('constellation_boundary_probe', { boundaryRevealed });
  check('LOADING (boundary wiring): after the routing entry completes, the hub-start POST + refresh boundary notifies advanced the constellation past the armed zero (revealed >= 1) — the routing-entry 0-edge is flipped positive',
    Number(boundaryRevealed) >= 1,
    { boundaryRevealed });

  const failed = results.filter((r) => !r.pass);
  console.log(`SUMMARY: ${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}`);
  if (failed.length) exitCode = 1;
  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', async () => {
  try { server?.close(); } catch { /* ignore */ }
  for (const p of cleanupPaths) { try { await fs.rm(p, { recursive: true, force: true }); } catch { /* ignore */ } }
  process.exit(exitCode);
});
