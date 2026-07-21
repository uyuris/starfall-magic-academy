// Render-backed arena-bracket layout check (Electron / real Blink layout).
//
// `node --test` cannot lay out a DOM, so the bracket connector geometry (equal-height slots + elbow lines
// aligning each round-N+1 match on its two round-N feeders) is eyeballed here against real layout. This file is
// NOT named *.test.mjs and lives under app/tests/manual/, so `npm test` skips it; run it by hand:
//
//   ./node_modules/.bin/electron app/tests/manual/arenaBracketRender.mjs
//
// It boots the real page (for style.css + /canonical art), injects a fully-populated 16-unit bracket view into
// the real #arena-bracket-grid via the same class grammar renderArenaBracketGrid emits, shows the arena screen,
// and writes a PNG of the bracket to /tmp so the reviewer can confirm who-plays-whom / who-advanced reads.
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WIN_W = Number(process.env.AR_WIN_W ?? 1000);
const WIN_H = Number(process.env.AR_WIN_H ?? 760);
const OUT = process.env.AR_OUT ?? path.join(os.tmpdir(), 'arena-bracket.png');

const { createServer } = await import(path.join(PROJECT_ROOT, 'app/src/server.mjs'));

async function writeJson(root, rel, value) {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function minimalRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-render-'));
  await writeJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院', player_name: '主人公', world_description: '学院。', world_condition_texts: []
  });
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1, current_location_id: 'familiar_stables', current_screen: 'academy-map', global_flags: {}, characters: {}
  });
  return root;
}

// A realistic non-spectate (1v1) view: round 0 fully resolved, round 1 half resolved, later rounds still empty —
// the mix that exercises watch buttons, the player highlight/path, winner marks, and empty '—' placeholders.
function mockView() {
  const names = ['アリア', 'ルミ', 'カイ', 'セラ', 'ノア', 'ミオ', 'レン', 'ユナ', 'ソラ', 'ヒロ', 'エマ', 'タオ', 'リコ', 'ケン', 'ナギ', 'アオ'];
  const units = names.map((name, i) => ({ unit_id: `u${i}`, is_player_unit: i === 0, actors: [{ actor_id: i === 0 ? 'protagonist' : `character_${i}`, name, kind: i === 0 ? 'protagonist' : 'character', controller: i === 0 ? 'player' : 'ai' }] }));
  const playerUnit = 'u0';
  const rounds = [];
  // round 0: 8 matches, all resolved (team_a wins the first of each pair for simplicity, player wins theirs).
  const r0 = [];
  for (let m = 0; m < 8; m += 1) {
    const a = `u${m * 2}`;
    const b = `u${m * 2 + 1}`;
    const winner = a; // upper feeder advances
    const isPlayer = a === playerUnit || b === playerUnit;
    r0.push({ match_id: `r0_m${m}`, round: 0, index: m, team_a_unit_id: a, team_b_unit_id: b, winner_unit_id: winner, is_player_match: isPlayer, is_auto: !isPlayer, resolved: true });
  }
  rounds.push(r0);
  // round 1: 4 matches, fed by r0 winners (u0,u2,u4,...); only the top match resolved.
  const r1 = [];
  const r0Winners = r0.map((mt) => mt.winner_unit_id);
  for (let m = 0; m < 4; m += 1) {
    const a = r0Winners[m * 2];
    const b = r0Winners[m * 2 + 1];
    const resolved = m === 0;
    const isPlayer = a === playerUnit || b === playerUnit;
    r1.push({ match_id: `r1_m${m}`, round: 1, index: m, team_a_unit_id: a, team_b_unit_id: b, winner_unit_id: resolved ? a : null, is_player_match: isPlayer, is_auto: resolved && !isPlayer, resolved });
  }
  rounds.push(r1);
  // round 2 + 3: empty participants until winners resolve.
  const r2 = [];
  for (let m = 0; m < 2; m += 1) r2.push({ match_id: `r2_m${m}`, round: 2, index: m, team_a_unit_id: null, team_b_unit_id: null, winner_unit_id: null, is_player_match: false, is_auto: false, resolved: false });
  rounds.push(r2);
  rounds.push([{ match_id: 'r3_m0', round: 3, index: 0, team_a_unit_id: null, team_b_unit_id: null, winner_unit_id: null, is_player_match: false, is_auto: false, resolved: false }]);
  return { week: 3, mode: 'solo', status: 'active', player_unit_id: playerUnit, wins: 1, terminal: false, outcome: null, units, bracket: { rounds }, current_match_id: null, content_result: null };
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let server;
let exitCode = 0;
async function main() {
  const root = await minimalRoot();
  const publicRoot = path.join(PROJECT_ROOT, 'app/public');
  server = createServer({ root, activeRoot: root, publicRoot, lmStudioConfigPath: path.join(root, 'no-such-config.json') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  await app.whenReady();
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(`${base}/`);
  await new Promise((r) => setTimeout(r, 1000));

  // Show the arena screen and build the bracket DOM with the exact class grammar the renderer emits.
  const built = await win.webContents.executeJavaScript(`(() => {
    const view = ${JSON.stringify(mockView())};
    for (const s of document.querySelectorAll('.screen')) s.classList.remove('active');
    const screen = document.querySelector('#academy-arena-screen');
    screen.classList.add('active');
    document.querySelector('#arena-selection').hidden = true;
    document.querySelector('#arena-match').hidden = true;
    const bracket = document.querySelector('#arena-bracket');
    bracket.hidden = false;
    const ROUND_LABELS = ['1回戦', '準々決勝', '準決勝', '決勝'];
    const labels = new Map(view.units.map((u) => [u.unit_id, u.actors.map((a) => a.name).join('・')]));
    const grid = document.querySelector('#arena-bracket-grid');
    grid.replaceChildren();
    // Mirror renderArenaBracketGrid: one shared grid, columns = rounds, rows = header + one equal track per
    // round-0 match, each match spanning 2^round rows (explicit row-span doubling).
    const nRounds = view.bracket.rounds.length;
    const baseRows = view.bracket.rounds[0].length;
    grid.style.gridTemplateColumns = 'repeat(' + nRounds + ', minmax(var(--arena-bracket-round-min), 1fr))';
    grid.style.gridTemplateRows = 'auto repeat(' + baseRows + ', minmax(var(--arena-bracket-card-min), 1fr))';
    const lastRound = nRounds - 1;
    const cardEls = [];
    view.bracket.rounds.forEach((round, roundIndex) => {
      const span = 2 ** roundIndex;
      const head = document.createElement('p'); head.className = 'arena-bracket-round-label'; head.textContent = ROUND_LABELS[roundIndex];
      head.style.gridColumn = String(roundIndex + 1); head.style.gridRow = '1'; grid.append(head);
      for (const match of round) {
        const slot = document.createElement('div'); slot.className = 'arena-bracket-match';
        slot.classList.add(match.index % 2 === 0 ? 'arena-bracket-match--upper' : 'arena-bracket-match--lower');
        if (roundIndex < lastRound) slot.classList.add('arena-bracket-match--source');
        if (roundIndex > 0) slot.classList.add('arena-bracket-match--sink');
        slot.style.gridColumn = String(roundIndex + 1);
        slot.style.gridRow = (2 + match.index * span) + ' / span ' + span;
        const card = document.createElement('div'); card.className = 'arena-match-card';
        if (match.is_player_match) card.classList.add('arena-match-card--player');
        const unitsById = new Map(view.units.map((u) => [u.unit_id, u]));
        const buildRow = (unitId) => {
          const row = document.createElement('div'); row.className = 'arena-match-card-row';
          if (unitId && unitId === view.player_unit_id) row.classList.add('arena-match-card-row--player');
          const won = Boolean(match.winner_unit_id) && unitId === match.winner_unit_id;
          if (won) row.classList.add('arena-match-card-row--won');
          const name = document.createElement('span'); name.className = 'arena-match-card-name';
          const unit = unitId ? unitsById.get(unitId) : null;
          if (!unit) { name.textContent = '—'; }
          else {
            unit.actors.forEach((actor, i) => {
              if (i > 0) name.append(document.createTextNode('・'));
              if (actor.kind === 'protagonist') name.append(document.createTextNode(actor.name));
              else { const b = document.createElement('button'); b.type = 'button'; b.className = 'arena-name-button interaction-name-button'; b.textContent = actor.name; name.append(b); }
            });
          }
          row.append(name);
          if (won) { const mk = document.createElement('span'); mk.className = 'arena-match-card-mark'; mk.textContent = '✔'; row.append(mk); }
          return row;
        };
        card.append(buildRow(match.team_a_unit_id));
        const vs = document.createElement('span'); vs.className = 'arena-match-card-vs'; vs.textContent = '対'; vs.setAttribute('aria-hidden', 'true'); card.append(vs);
        card.append(buildRow(match.team_b_unit_id));
        if (match.resolved && match.is_auto) { card.classList.add('arena-match-card--watchable'); const w = document.createElement('button'); w.type = 'button'; w.className = 'arena-match-card-watch'; w.textContent = '観戦'; card.append(w); }
        slot.append(card); grid.append(slot);
        cardEls.push({ round: roundIndex, index: match.index, el: card });
      }
    });
    // Alignment measurement: a round-N+1 card must center on the midpoint of its two round-N feeders (2m / 2m+1).
    // Report the worst |cardCenter - feederMidpoint| across the whole bracket — the "seam drift" in device px.
    const centerOf = (round, index) => { const c = cardEls.find((x) => x.round === round && x.index === index); if (!c) return null; const r = c.el.getBoundingClientRect(); return (r.top + r.bottom) / 2; };
    let maxSeamDrift = 0; const drifts = [];
    for (let round = 1; round < nRounds; round += 1) {
      for (let m = 0; m < view.bracket.rounds[round].length; m += 1) {
        const here = centerOf(round, m); const up = centerOf(round - 1, m * 2); const lo = centerOf(round - 1, m * 2 + 1);
        if (here == null || up == null || lo == null) continue;
        const drift = Math.abs(here - (up + lo) / 2); maxSeamDrift = Math.max(maxSeamDrift, drift);
        drifts.push({ round, m, drift: Math.round(drift * 100) / 100 });
      }
    }
    // Tallest card vs the equal row band: proves no card overflows its 1-row band (round-0, the tightest case).
    const bandH = Math.round(grid.querySelector('.arena-bracket-match[style*="span 1"], .arena-bracket-match')?.getBoundingClientRect().height ?? 0);
    let maxCardH = 0; for (const c of cardEls) maxCardH = Math.max(maxCardH, c.el.getBoundingClientRect().height);
    const gr = grid.getBoundingClientRect();
    // Direct-background (いきなり背景) standard: the layout is edge-to-edge (padding:0) and the arena obsidian screen
    // drops the floating-frame chrome (radius / box-shadow), so no navy gradient is revealed as a border — not even at
    // rounded corners.
    const layoutEl = document.querySelector('.layout');
    const arenaEl = document.querySelector('#academy-arena-screen.active');
    const arenaCs = arenaEl ? getComputedStyle(arenaEl) : null;
    return { rounds: view.bracket.rounds.map((r) => r.length), gridHeight: Math.round(gr.height), gridScrollH: grid.scrollHeight, gridClientH: grid.clientHeight, maxSeamDrift: Math.round(maxSeamDrift * 100) / 100, maxCardH: Math.round(maxCardH), round0BandH: bandH, drifts,
      layoutPadding: layoutEl ? getComputedStyle(layoutEl).padding : '', arenaRadius: arenaCs ? arenaCs.borderTopLeftRadius : '', arenaShadow: arenaCs ? arenaCs.boxShadow : '' };
  })()`);
  console.log('built', JSON.stringify(built));
  {
    const edgeToEdge = built.layoutPadding === '0px' && built.arenaRadius === '0px' && built.arenaShadow === 'none';
    console.log(`edge-to-edge ${edgeToEdge ? 'PASS' : 'FAIL'}: the arena layout is edge-to-edge (layout padding:0) and the obsidian screen has no frame radius / drop-shadow (no navy-gradient border) ${JSON.stringify({ layoutPadding: built.layoutPadding, arenaRadius: built.arenaRadius, arenaShadow: built.arenaShadow })}`);
    if (!edgeToEdge) exitCode = 4;
  }
  if (process.env.AR_SCROLL === 'bottom') {
    await win.webContents.executeJavaScript(`(() => { const g = document.querySelector('#arena-bracket-grid'); g.scrollTop = g.scrollHeight; true; })()`);
  }
  await new Promise((r) => setTimeout(r, 400));

  const image = await win.capturePage();
  await fs.writeFile(OUT, image.toPNG());
  console.log('screenshot', OUT);
  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', () => { try { server?.close(); } catch {} process.exit(exitCode); });
