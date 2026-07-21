// Render-backed settings master-detail + on-change apply check (Electron / real Blink layout).
//
// `node --test` cannot lay out a DOM and cannot run app.js, so the two load-bearing questions here
// are verified against the real client, not in the headless suite:
//   (a) opening the settings screen shows ONLY the default (LM Studio) category panel, and clicking a
//       different category tab switches to ONLY that category's panel (the others go display:none via
//       the #settings-screen [hidden] id-scoped guard, which beats .settings-card{display:grid});
//   (b) an LM Studio setting change applies with NO save button — committing a port edit and picking a
//       thinking-effort each persist to disk on change, symmetric with the conversation-popup cooldown preset.
//
// This file is intentionally NOT named *.test.mjs and lives under app/tests/manual/, so `npm test`
// skips it. Run it by hand:
//
//   ./node_modules/.bin/electron app/tests/manual/settingsCategoryNavAndApplyRender.mjs
//
// It boots an isolated server (no LLM) whose LM Studio store is seeded with a known model so the
// model-required apply gate is satisfied, then drives the real client.
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WIN_W = Number(process.env.SC_WIN_W ?? 1200);
const WIN_H = Number(process.env.SC_WIN_H ?? 820);

const { createServer } = await import(path.join(PROJECT_ROOT, 'app/src/server.mjs'));

function baselineParameters() {
  return {
    magic: { light: { value: 12 }, dark: { value: 10 }, fire: { value: 14 }, water: { value: 8 }, earth: { value: 11 }, wind: { value: 9 } },
    abilities: { strength: { value: 28 }, agility: { value: 30 }, academics: { value: 26 }, magical_power: { value: 24 }, charisma: { value: 22 } }
  };
}

async function writeJson(root, rel, value) {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function splitRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-category-render-'));
  await writeJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院', player_name: '主人公', world_description: '学院。', world_condition_texts: []
  });
  await writeJson(root, 'data/seeds/game_data/runtime/player_parameters.json', baselineParameters());
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1, current_location_id: 'familiar_stables', current_screen: 'academy-map', global_flags: {}, characters: {}
  });
  // A seeded LM Studio config with a model: the apply action requires a model, so seeding one lets the
  // on-change PATCH succeed and prove persistence without a real LM Studio.
  const lmStudioConfigPath = path.join(root, 'lmstudio.json');
  await fs.writeFile(lmStudioConfigPath, `${JSON.stringify({
    provider: 'lmstudio',
    base_url: 'http://127.0.0.1:1234/v1',
    chat_model: 'seed-model-a',
    reflection_model: 'seed-model-a',
    thinking_effort: null
  }, null, 2)}\n`, 'utf8');
  return { root, lmStudioConfigPath };
}

const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let server;
let exitCode = 0;

async function main() {
  const { root, lmStudioConfigPath } = await splitRoot();
  const publicRoot = path.join(PROJECT_ROOT, 'app/public');
  server = createServer({ root, activeRoot: root, publicRoot, lmStudioConfigPath });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const seeded = await (await fetch(`${base}/api/settings/lmstudio`)).json();
  log('GET /api/settings/lmstudio (seed)', seeded);

  await app.whenReady();
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(`${base}/`);
  await new Promise((r) => setTimeout(r, 1200)); // let app.js boot (refresh(), listeners attached)

  // Per-category visibility: a hidden panel resolves to display:none (offsetParent null) via the
  // id-scoped [hidden] guard; the selected panel is display:grid and laid out.
  const measurePanels = () => win.webContents.executeJavaScript(`(() => {
    const cats = ['lmstudio', 'conversation-popup', 'conversation-finalize'];
    const out = { activeScreen: document.querySelector('.screen.active')?.id ?? null, hasSaveButton: !!document.querySelector('#save-lmstudio-settings'), panels: {}, activeTab: null };
    for (const c of cats) {
      const panel = document.querySelector('#settings-panel-' + c);
      out.panels[c] = panel ? { hidden: panel.hidden, display: getComputedStyle(panel).display, laidOut: panel.offsetParent !== null } : null;
    }
    const activeTab = document.querySelector('.settings-category-tab.is-active');
    out.activeTab = activeTab ? activeTab.dataset.settingsCategory : null;
    return out;
  })()`);

  const clickTab = (category) => win.webContents.executeJavaScript(
    `document.querySelector('.settings-category-tab[data-settings-category="' + ${JSON.stringify(category)} + '"]').click(); true`
  );

  // Exactly one category panel is shown (laid out) and it matches the expected category; the active
  // tab tracks it.
  const onlyShows = (m, category) => {
    if (m.activeTab !== category) return false;
    for (const [c, p] of Object.entries(m.panels)) {
      if (!p) return false;
      const shouldShow = c === category;
      if (shouldShow && (p.hidden || p.display === 'none' || !p.laidOut)) return false;
      if (!shouldShow && !(p.hidden && p.display === 'none')) return false;
    }
    return true;
  };

  // Enter the settings screen via the top-bar tab (routes through openSettingsScreen()).
  await win.webContents.executeJavaScript(`document.querySelector('[data-screen="settings"]').click(); true`);
  await new Promise((r) => setTimeout(r, 400));

  const opened = await measurePanels();
  log('opened_default', opened);
  const defaultOk = opened.activeScreen === 'settings-screen' && !opened.hasSaveButton && onlyShows(opened, 'lmstudio');
  console.log(`OPEN shows only the default LM Studio panel, no save button: ${defaultOk ? 'PASS' : 'FAIL'}`);
  if (!defaultOk) exitCode = 1;

  // Switch to each other category: only that panel shows.
  for (const category of ['conversation-popup', 'conversation-finalize', 'lmstudio']) {
    await clickTab(category);
    await new Promise((r) => setTimeout(r, 200));
    const m = await measurePanels();
    log(`switch_${category}`, m);
    const ok = onlyShows(m, category);
    console.log(`CATEGORY "${category}" click shows only its panel: ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) exitCode = 1;
  }

  // (b) On-change apply, no save button. Commit a port edit and pick a thinking-effort; each must
  // persist to disk on change. Start from the LM Studio category.
  await clickTab('lmstudio');
  await new Promise((r) => setTimeout(r, 200));

  const readDiskConfig = async () => JSON.parse(await fs.readFile(lmStudioConfigPath, 'utf8'));
  const before = await readDiskConfig();
  log('disk_before', before);

  // Commit a port change (blur/Enter path): set the value and dispatch the change event.
  await win.webContents.executeJavaScript(`(() => {
    const port = document.querySelector('#lmstudio-port');
    port.value = '4321';
    port.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const portPersisted = await (async () => {
    for (let i = 0; i < 40; i += 1) {
      const cfg = await readDiskConfig();
      if (String(cfg.base_url ?? '').includes(':4321/')) return cfg;
      await new Promise((r) => setTimeout(r, 100));
    }
    return await readDiskConfig();
  })();
  log('disk_after_port', portPersisted);
  const portOk = String(portPersisted.base_url ?? '').includes(':4321/');
  console.log(`PORT edit persists on change (no save button): ${portOk ? 'PASS' : 'FAIL'}`);
  if (!portOk) exitCode = 1;

  // Pick a thinking-effort: a pure select change must persist.
  await win.webContents.executeJavaScript(`(() => {
    const sel = document.querySelector('#lmstudio-thinking-effort');
    sel.value = 'high';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const effortPersisted = await (async () => {
    for (let i = 0; i < 40; i += 1) {
      const cfg = await readDiskConfig();
      if (cfg.thinking_effort === 'high') return cfg;
      await new Promise((r) => setTimeout(r, 100));
    }
    return await readDiskConfig();
  })();
  log('disk_after_effort', effortPersisted);
  const effortOk = effortPersisted.thinking_effort === 'high';
  console.log(`THINKING-EFFORT selection persists on change (no save button): ${effortOk ? 'PASS' : 'FAIL'}`);
  if (!effortOk) exitCode = 1;

  console.log(`ALL CHECKS: ${exitCode === 0 ? 'PASS' : 'FAIL'}`);
  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', () => { try { server?.close(); } catch {} process.exit(exitCode); });
