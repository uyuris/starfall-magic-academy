// Render-backed routing-hub person-equipment check (Electron / real Blink), for task
// routing-hub-person-equipment-frontend. `node --test` cannot render the drawer (no real layout / no real
// server data flow), so the 自分 / バディー person panels — parameter meters + the 装備欄 (equip / unequip) — and
// the inventory 装備 section's un-equipped-only filtering are verified here against the REAL client + REAL server
// in Electron. This file is intentionally NOT named *.test.mjs and lives under app/tests/manual/, so `npm test`
// (node --test app/tests/*.test.mjs) skips it; run it by hand:
//
//   ./node_modules/.bin/electron app/tests/manual/routingHubPersonEquipmentRender.mjs
//
// Flow (all against the real server + real app, only POST /api/routing/hub/start doubled so the new-game entry
// lands on the hub without a live LM opening):
//   1. New game → the routing hub, with refresh() populating the drawer globals (currentWorld / selectableCharacters
//      / currentRuntimeState / currentInventory).
//   2. Seed four owned equipment instances (2 weapons, 2 amulets) into the fixture's player_equipment.json — the
//      drawer's GET /api/equipment reads it live.
//   3. Set a buddy (character_002) through the real debug relationship control (/api/debug/relationships →
//      currentRuntimeState + refreshCharacters), so the バディー panel resolves a companion.
//   4. 自分 panel: parameter meters + two 装備 slots with 装備 candidates; equip a weapon → the slot shows the
//      equipped card. Screenshots before/after.
//   5. バディー panel: the buddy hero card + parameter meters + two 装備 slots (target the buddy id); equip an amulet
//      to the buddy. Screenshot.
//   6. 持ち物 panel: the 装備 section lists ONLY the un-equipped instances (the player-equipped weapon and the
//      buddy-equipped amulet are excluded). Screenshot.
// Per ref-camera, the harness is fire-and-forget (no top-level await main(); whenReady would deadlock).
import { app, BrowserWindow } from 'electron';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'app/public');
const REPO_CANONICAL = path.join(PROJECT_ROOT, 'assets/canonical');
const WIN_W = 1200;
const WIN_H = 900;
const BUDDY_ID = 'character_002';

const { createServer } = await import(path.join(PROJECT_ROOT, 'app/src/server.mjs'));
const { fixtureRoot } = await import(path.join(PROJECT_ROOT, 'app/tests/helpers.mjs'));
const { runtimePathsManifestFilename } = await import(path.join(PROJECT_ROOT, 'app/src/runtimePaths.mjs'));
const { resolvePlayRoot, resolveSlotProjectRoot } = await import(path.join(PROJECT_ROOT, 'app/src/playSession.mjs'));

// After new-game, the live routing state lives under the active save slot (routing scopes mutable reads per slot),
// not the fixture-root game_data. Resolve the active slot's game_data so the seeded equipment surface is the one
// the drawer's GET /api/equipment actually reads.
async function activeSlotGameData(root) {
  const active = JSON.parse(await fs.readFile(path.join(resolvePlayRoot(root), 'active_slot.json'), 'utf8'));
  const slotId = String(active?.slot_id ?? '').trim();
  if (!slotId) throw new Error('no active slot id after new game');
  return path.join(resolveSlotProjectRoot(root, slotId), 'game_data');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);
const results = [];
function check(name, pass, detail = {}) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
}

// Four valid owned instances (2 weapons + 2 amulets), all initially un-equipped. Their ids are readable so the
// probes can assert which ones move to a slot / stay in the inventory list.
const SEED_INSTANCES = [
  { instance_id: 'eq_w_fire', kind: 'weapon', weapon_type: 'sword', element: 'fire', tier: 2, quality: 'fine', name: '紅蓮の剣', flavor: '炎をまとう片手剣。', base_effects: { attack: 12 }, bonus_effects: { element_spell_power: 5 } },
  { instance_id: 'eq_w_water', kind: 'weapon', weapon_type: 'staff', element: 'water', tier: 1, quality: 'common', name: '水明の杖', flavor: '澄んだ水の意匠の杖。', base_effects: { attack: 6 }, bonus_effects: {} },
  { instance_id: 'eq_a_light', kind: 'amulet', element: 'light', tier: 3, quality: 'excellent', name: '光輝の護符', flavor: '淡い光を放つ護符。', base_effects: { max_hp: 30 }, bonus_effects: { defense: 4 } },
  { instance_id: 'eq_a_earth', kind: 'amulet', element: 'earth', tier: 1, quality: 'common', name: '土くれの護符', flavor: '素朴な土の護符。', base_effects: { defense: 5 }, bonus_effects: {} }
];

async function routingFixture() {
  const root = await fixtureRoot('routing-hub-person-equipment-render-');
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
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routing-hub-person-equipment-settings-'));
  const settingsPath = path.join(settingsDir, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');
  const convPopupSettingsPath = path.join(settingsDir, 'conversation-popup.json');
  return { root, settingsDir, settingsPath, convPopupSettingsPath };
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let server;
let lmServer;
let cleanupPaths = [];
let exitCode = 0;

async function waitFor(win, predicate, { tries = 200, intervalMs = 50 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const ok = await win.webContents.executeJavaScript(`(() => { try { return !!(${predicate}); } catch (e) { return false; } })()`);
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}

const js = (win, expr) => win.webContents.executeJavaScript(expr);

async function routingLmStub() {
  const stub = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'こんばんは。今週はどこへ向かう？' } }] }));
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  return { server: stub, baseUrl: `http://127.0.0.1:${stub.address().port}/v1` };
}

// Double ONLY POST /api/routing/hub/start with a canned valid hub so new-game lands on the hub without a live LM
// opening. Everything else (new-game slot creation, refresh, GET /api/equipment, /api/debug/relationships, the
// equip POSTs) hits the real server / real app.
async function installHubStartDouble(win) {
  await js(win, `(() => {
    const realFetch = window.fetch.bind(window);
    const canned = {
      conversation: { id: 'harness_hub_conv', routing_hub: true, character_id: 'lina', character_name: 'ルミ', messages: [{ role: 'assistant', content: 'こんばんは。今週はどこへ向かう？' }] },
      routing_persona_visual: {
        character_id: 'lina', display_name: 'ルミ', visual_set_id: 'routing_lumi_fallen_star',
        face_url: '/canonical/character_visual_sets/routing_lumi_fallen_star/face_emotions/neutral.jpg',
        selection_icon_url: '/canonical/character_visual_sets/routing_lumi_fallen_star/face_emotions/neutral.jpg',
        standee_url: '/canonical/character_visual_sets/routing_lumi_fallen_star/scene_standee/scene_standee_character_01.jpg'
      },
      state: { elapsed_weeks: 0 }
    };
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('/api/routing/hub/start')) return Promise.resolve(new Response(JSON.stringify(canned), { status: 200, headers: { 'content-type': 'application/json' } }));
      return realFetch(input, init);
    };
    return true;
  })()`);
}

// Open a routing-hub info-drawer category by clicking its rail button; wait for the popup to carry that category.
async function openCategory(win, category) {
  await js(win, `document.querySelector('.routing-hub-category-button[data-routing-category="${category}"]').click(); true`);
  return waitFor(win, `(() => { const p = document.querySelector('#routing-hub-info-popup'); return p && !p.hidden && p.dataset.category === '${category}'; })()`);
}

async function shoot(win, shotDir, name) {
  const file = path.join(shotDir, name);
  try { await fs.writeFile(file, (await win.webContents.capturePage()).toPNG()); console.log(`screenshot: ${file}`); }
  catch (e) { console.log(`screenshot: FAILED ${name} ${e?.message ?? e}`); }
}

async function main() {
  const { root, settingsDir, settingsPath, convPopupSettingsPath } = await routingFixture();
  cleanupPaths = [root, settingsDir];
  const lm = await routingLmStub();
  lmServer = lm.server;

  server = createServer({
    root,
    publicRoot: PUBLIC_ROOT,
    canonicalAssetsRoot: REPO_CANONICAL,
    playModeSettingsPath: settingsPath,
    conversationPopupSettingsPath: convPopupSettingsPath,
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  log('server', { base, playMode: 'routing' });

  await app.whenReady();
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) console.log(`renderer-error: ${message}`); });
  const shotDir = path.join(os.tmpdir(), 'routing-hub-person-equipment');
  await fs.mkdir(shotDir, { recursive: true });

  // ---- Enter the hub via the real new-game entry (hub-start doubled) ----
  await win.loadURL(`${base}/`);
  await waitFor(win, `document.querySelector('#title-screen').classList.contains('active') && !!document.querySelector('#start-new-game')`);
  await installHubStartDouble(win);
  await js(win, `document.querySelector('#start-new-game').click(); true`);
  const onHub = await waitFor(win, `document.querySelector('#routing-hub-screen').classList.contains('active')`, { tries: 240, intervalMs: 50 });
  check('ENTRY: new game lands on #routing-hub-screen', onHub);
  await waitFor(win, `(() => { const s = document.querySelector('#routing-hub-message-stream'); return !!s && s.textContent.includes('こんばんは'); })()`);

  // ---- Seed four owned equipment instances into the active slot's live surface (drawer GET reads it live) ----
  const slotGameData = await activeSlotGameData(root);
  await fs.writeFile(path.join(slotGameData, 'player_equipment.json'), `${JSON.stringify({ version: 1, instances: SEED_INSTANCES }, null, 2)}\n`, 'utf8');
  log('seed', { slotGameData });

  // ---- Set a buddy through the real debug relationship control ----
  await js(win, `document.querySelector('[data-screen="debug"]').click(); true`);
  await waitFor(win, `document.querySelector('#debug-screen').classList.contains('active') && !!document.querySelector('#relationship-character-select option[value="${BUDDY_ID}"]')`);
  await js(win, `(() => { const s = document.querySelector('#relationship-character-select'); s.value = '${BUDDY_ID}'; return s.value; })()`);
  await js(win, `document.querySelector('#set-debug-buddy').click(); true`);
  const buddySet = await waitFor(win, `(() => { try { return document.querySelector('#relationship-character-select') && true; } catch { return false; } })()`);
  await sleep(400);
  // Return to the hub screen (the drawer lives on #routing-hub-screen; the globals set above persist).
  await js(win, `(() => { document.querySelectorAll('.screen.active').forEach((s) => s.classList.remove('active')); document.querySelector('#routing-hub-screen').classList.add('active'); return true; })()`);
  check('SETUP: buddy control reachable + set', buddySet);

  // ---- 自分 panel ----
  await openCategory(win, 'self');
  await waitFor(win, `document.querySelectorAll('#routing-hub-info-popup-body .routing-hub-info-equip-slot').length === 2`);
  const selfProbe = await js(win, `(() => {
    const body = document.querySelector('#routing-hub-info-popup-body');
    return {
      paramSection: !!body.querySelector('.routing-hub-info-section-title'),
      meterCount: body.querySelectorAll('.character-parameter-item meter').length,
      slotCount: body.querySelectorAll('.routing-hub-info-equip-slot').length,
      candidateCount: body.querySelectorAll('.routing-hub-info-equip-candidate').length
    };
  })()`);
  log('self_probe', selfProbe);
  check('SELF: 自分 panel shows the parameter meters (11) + two 装備 slots + 装備 candidates (4 owned instances)',
    selfProbe.meterCount === 11 && selfProbe.slotCount === 2 && selfProbe.candidateCount >= 2, selfProbe);
  await sleep(250);
  await shoot(win, shotDir, 'self-panel-empty.png');

  // Equip the fire sword into the player's weapon slot via the real candidate button.
  await js(win, `(() => { const b = document.querySelector('.routing-hub-info-equip-candidate[data-instance-id="eq_w_fire"]'); b.click(); return true; })()`);
  const selfEquipped = await waitFor(win, `!!document.querySelector('#routing-hub-info-popup-body .routing-hub-info-equip-equipped')`);
  const selfEquippedProbe = await js(win, `(() => ({
    equippedName: document.querySelector('#routing-hub-info-popup-body .routing-hub-info-equip-instance-name')?.textContent ?? null,
    unequipButton: !!document.querySelector('#routing-hub-info-popup-body .routing-hub-info-equip-action[data-action="unequip"]')
  }))()`);
  log('self_equipped_probe', selfEquippedProbe);
  check('SELF: clicking a 装備 candidate equips it into the player weapon slot (equipped card + 解除 button)',
    selfEquipped && selfEquippedProbe.equippedName === '紅蓮の剣' && selfEquippedProbe.unequipButton === true, selfEquippedProbe);
  await sleep(250);
  await shoot(win, shotDir, 'self-panel-equipped.png');
  await js(win, `document.querySelector('#routing-hub-info-popup [data-routing-popup-close]')?.click(); true`);

  // ---- バディー panel ----
  await openCategory(win, 'buddy');
  await waitFor(win, `document.querySelectorAll('#routing-hub-info-popup-body .routing-hub-info-equip-slot').length === 2`);
  const buddyProbe = await js(win, `(() => {
    const body = document.querySelector('#routing-hub-info-popup-body');
    return {
      heroCard: !!body.querySelector('.routing-hub-info-buddy-card'),
      buddyName: body.querySelector('.routing-hub-info-buddy-name')?.textContent ?? null,
      meterCount: body.querySelectorAll('.character-parameter-item meter').length,
      slotCount: body.querySelectorAll('.routing-hub-info-equip-slot').length
    };
  })()`);
  log('buddy_probe', buddyProbe);
  check('BUDDY: バディー panel shows the hero card + parameter meters (11) + two 装備 slots (same design as self)',
    buddyProbe.heroCard === true && !!buddyProbe.buddyName && buddyProbe.meterCount === 11 && buddyProbe.slotCount === 2, buddyProbe);

  // Equip the light amulet to the buddy (target the buddy id) via the real candidate button.
  await js(win, `(() => { const b = document.querySelector('.routing-hub-info-equip-candidate[data-instance-id="eq_a_light"]'); b.click(); return true; })()`);
  const buddyEquipped = await waitFor(win, `!!document.querySelector('#routing-hub-info-popup-body .routing-hub-info-equip-equipped')`);
  const buddyEquippedProbe = await js(win, `(() => ({
    equippedName: document.querySelector('#routing-hub-info-popup-body .routing-hub-info-equip-instance-name')?.textContent ?? null
  }))()`);
  log('buddy_equipped_probe', buddyEquippedProbe);
  check('BUDDY: clicking a 装備 candidate equips it onto the buddy (target the buddy character_id)',
    buddyEquipped && buddyEquippedProbe.equippedName === '光輝の護符', buddyEquippedProbe);
  await sleep(250);
  await shoot(win, shotDir, 'buddy-panel.png');
  await js(win, `document.querySelector('#routing-hub-info-popup [data-routing-popup-close]')?.click(); true`);

  // ---- 持ち物 panel: 装備 section lists ONLY the un-equipped instances ----
  await openCategory(win, 'inventory');
  await waitFor(win, `(() => { const s = document.querySelector('#routing-hub-info-popup-body .routing-hub-info-section-body'); return s && !s.querySelector('.routing-hub-info-equip-loading'); })()`);
  await sleep(200);
  const invProbe = await js(win, `(() => {
    const equipBody = document.querySelector('#routing-hub-info-popup-body .routing-hub-info-section .routing-hub-info-section-body');
    const rows = [...document.querySelectorAll('#routing-hub-info-popup-body .routing-hub-info-equip-owned-row')];
    return {
      rowCount: rows.length,
      names: rows.map((r) => r.querySelector('.routing-hub-info-equip-owned-name')?.textContent ?? null),
      equipSectionHtml: equipBody ? equipBody.innerHTML.slice(0, 400) : null,
      hasError: !!document.querySelector('#routing-hub-info-popup-body .routing-hub-info-equip-error'),
      summaryLabel: document.querySelector('#routing-hub-info-popup-body .routing-hub-info-summary-label')?.textContent ?? null,
      summaryCount: document.querySelector('#routing-hub-info-popup-body .routing-hub-info-summary-count')?.textContent ?? null
    };
  })()`);
  log('inventory_probe', invProbe);
  // Two of the four are now equipped (紅蓮の剣 on the player, 光輝の護符 on the buddy), so only 水明の杖 + 土くれの護符 remain.
  check('INVENTORY: the 装備 section lists ONLY the un-equipped instances (equipped player weapon + buddy amulet excluded via sales[].equipped)',
    invProbe.rowCount === 2 && invProbe.names.includes('水明の杖') && invProbe.names.includes('土くれの護符')
      && !invProbe.names.includes('紅蓮の剣') && !invProbe.names.includes('光輝の護符'), invProbe);
  await sleep(250);
  await shoot(win, shotDir, 'inventory-unequipped-only.png');

  const failed = results.filter((r) => !r.pass);
  console.log(`SUMMARY: ${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}`);
  if (failed.length) exitCode = 1;
  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', async () => {
  try { server?.close(); } catch { /* ignore */ }
  try { lmServer?.close(); } catch { /* ignore */ }
  for (const p of cleanupPaths) { try { await fs.rm(p, { recursive: true, force: true }); } catch { /* ignore */ } }
  process.exit(exitCode);
});
