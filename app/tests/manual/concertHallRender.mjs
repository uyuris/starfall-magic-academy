// Render-backed 奏楽堂 (concert hall) screen QA: the board's nine states (作曲中 as its four visible stages, twelve
// captures) in real Blink, driven end-to-end through the REAL client and the REAL server — routing hub → 奏楽堂
// dispatch → 自由文 → the staged compose stream → the pre-performance narration → the performance through the
// screen's own Web Audio player → 収蔵 → replay from the shelf → an LM failure → もう一度.
//
// `node --test` cannot run app.js (no DOM / layout / Web Audio), so this harness runs it in Electron. It is NOT
// named *.test.mjs and lives under app/tests/manual/, so the change gate skips it; run it by hand:
//
//   ./node_modules/.bin/electron app/tests/manual/concertHallRender.mjs \
//     --repo-root <absolute worktree> --out-dir <absolute output directory> [--lm-config <absolute lmstudio.json>]
//
// Two LM modes, chosen by the presence of --lm-config:
//   stub mode (no --lm-config): an in-process LM Studio wire-protocol stub answers every model call
//     deterministically (the product's own gates run on its output); the LM failure is the stub's ONE fault seam
//     (armed from the harness: the S1 materials answer names an unknown material id, the product's retry budget
//     runs out and the stream closes with a real `error` event).
//   real mode (--lm-config): the isolated server's LM is the real LM Studio named by that config file (base_url /
//     models / stream as configured — the file is read once and never written). The routing hub and every compose
//     stage run on the real model; the LM failure is produced by pointing the isolated server's LM settings at an
//     unreachable base_url (127.0.0.1 on a port that was just bound and closed) through the product's own
//     PATCH /api/settings/lmstudio, so the compose hits the real transport-failure path (LMSTUDIO_CONNECTION_UNAVAILABLE,
//     the 503-class error carried as the stream's `error` event); the settings are patched back to the real LM before
//     もう一度. Real-LM observations (per-stage attempts, prompt bytes, timing) are read from the product's own request
//     log (GET /api/debug/llm-requests, a 30-entry ring) — no proxy sits between the server and LM Studio.
//
// Both path arguments are required and absolute (no default). The output directory receives one PNG per capture,
// named 01-arrival … 09-lm-error (03-composing-s1/s2/s4/s5 for 作曲中), and audit.json:
//   - `captures`: per PNG the launch kind (stub | real | real-unreachable), the visibility measurement taken right
//     before the capture (every element that must be visible in that state: its rect, inside the viewport and its
//     scroll clip, not covered by anything else — asserted, not just recorded), and the DOM composition snapshot;
//   - `composition`: per capture the board's expected structure (element counts, order, adjacency) next to the DOM
//     measurement and a match flag — a mismatch is recorded, never repaired here;
//   - `audio`: during the performance the number of AudioBufferSourceNode.start calls must equal the score's note
//     count, and after stop() no started source survives and the player's context is suspended (prototype
//     instrumentation installed in the page before the performance; the page's own code is not patched);
//   - `lm`: the LM call counts per leg (the replay must make none) and, in real mode, the per-stage attempt /
//     retry counts, the S1 prompt (bytes, candidate counts), per-call timing and the generated pieces.
//
// Real: the server, every /api/concert-hall* request and the SSE stream, the client's DOM / CSS / renderers, the
// sample fetches (/canonical/concert_hall/…), the Web Audio schedule. Fixture: an OS-temp slot (the real save is
// never opened; the LM settings file the server may write lives inside it) and, in stub mode, the LM stub.
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { execFileSync } from 'node:child_process';

// ── CLI (required, absolute, no defaults) ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const parsed = {};
  const required = ['--repo-root', '--out-dir'];
  const known = new Set([...required, '--lm-config']);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!known.has(token)) throw new Error(`unexpected argument: ${token} (expected --repo-root, --out-dir and optionally --lm-config)`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${token}`);
    if (parsed[token] !== undefined) throw new Error(`duplicate argument: ${token}`);
    parsed[token] = value;
    i += 1;
  }
  for (const token of required) {
    if (parsed[token] === undefined) throw new Error(`${token} is required (no default, no fallback)`);
  }
  for (const [token, value] of Object.entries(parsed)) {
    if (!path.isAbsolute(value)) throw new Error(`${token} must be an absolute path: ${value}`);
  }
  return { repoRoot: parsed['--repo-root'], outDir: parsed['--out-dir'], lmConfigPath: parsed['--lm-config'] ?? null };
}

const VIEWPORT = { width: 1440, height: 900 };
const PLAYER_INPUT = '今週は奏楽堂に行きたい。楽師に曲を作ってもらいたい';
const WISH_TEXT = '星の降る夜に、静かに眠りへ落ちていくような曲を';
const SECOND_WISH_TEXT = '祭りの朝の、跳ねるような曲を';
const SENDOFF_TEXT = 'では、奏楽堂へ。楽師が待っています。';
// Each stub stage answer is delayed so every 作曲中 busy card is capturable mid-stream.
const STAGE_DELAY_MS = 700;
const POLL_MS = 100;
// The board's element structure (§1) the composition audit checks against.
const STAGE_CARD_TITLES = ['拾った材料', '方向', 'この曲に効く指南', '骨子'];
const CONTROL_ORDER = ['academy-concert-hall-input', 'academy-concert-hall-compose', 'academy-concert-hall-exit'];
const SHELF_COLUMNS = ['academy-concert-hall-shelf-title', 'academy-concert-hall-shelf-direction', 'academy-concert-hall-shelf-week'];
const STAGE_CORNER_ORNAMENTS = 4;
const RETRY_LABEL = 'もう一度';
const BUSY_LABEL = '楽師が譜を書いている…';
// The product's LM request titles for the concert hall stages (concertHallGeneration.mjs).
const STAGE_TITLES = { materials: '奏楽堂 材料選び', direction: '奏楽堂 方向決め', skeleton: '奏楽堂 骨子' };
const SECTION_TITLE = /^奏楽堂 節 (\d+)$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (label, value) => console.log(`${label}: ${JSON.stringify(value)}`);

const checks = [];
function check(name, pass, detail = {}) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
  if (!pass) throw new Error(`check failed: ${name} ${JSON.stringify(detail)}`);
}

// ── LM-compatible stub (stub mode) ────────────────────────────────────────────────────────────────────────────
// The hub answers mirror app/tests/manual/routingHubSessionScreenRender.mjs (the destination here is concert_hall;
// the finalization / drain judgments answer neutrally so the decided turn's drain completes);
// the concert hall stage answers are keyed by the product's own response_format schema names and are gate-clean:
// no materials, one motif word, the first axis ids, a 2 × 4-bar C-major skeleton at tempo 60 (inside 静謐's
// 44〜72 band), one melody note per beat. With the fault armed, the materials answer names an unknown material id.
function skeletonAnswer() {
  return {
    title: '星降りの子守唄',
    key: 'C',
    mode: 'major',
    tempo: 60,
    meter: '4/4',
    sections: [
      { name: '宵', bars: 4, chords: ['Cmaj7', 'Am', 'Fmaj7', 'G'], character: '星が降り始める、ゆっくりとした導入。' },
      { name: '眠り', bars: 4, chords: ['Fmaj7', 'G', 'Cmaj7', 'Cmaj7'], character: '呼吸が深くなり、静かに閉じる。' }
    ]
  };
}

function sectionAnswer() {
  const pitches = ['E5', 'D5', 'C5', 'D5', 'E5', 'G5', 'E5', 'D5', 'C5', 'D5', 'E5', 'C5', 'D5', 'E5', 'D5', 'C5'];
  return { melody: pitches.map((pitch, beat) => ({ pitch, start_beat: beat, duration_beats: 1, velocity: 88 })), counter: [] };
}

async function startLmStub(state) {
  const requests = [];
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const prompt = body.messages?.[0]?.content ?? '';
    const schemaName = body.response_format?.json_schema?.name ?? '';
    requests.push({ at: Date.now(), schemaName, promptHead: prompt.slice(0, 40) });
    let content;
    if (schemaName === 'concert_hall_materials') {
      await sleep(STAGE_DELAY_MS);
      content = JSON.stringify(state.faultArmed
        ? { materials: ['item_does_not_exist'], motif_words: ['星降り'], remark: '（故障注入）' }
        : { materials: [], motif_words: ['星降り'], remark: '願いの言葉から、降る星と眠りの気配を拾った。' });
    } else if (schemaName === 'concert_hall_direction') {
      await sleep(STAGE_DELAY_MS);
      content = JSON.stringify({ direction_id: 'serene', subject_id: 'starry_sky', motif_category_id: 'lullaby', remark: '静謐の方向で、星空を題材に、子守唄の型で行こう。' });
    } else if (schemaName === 'concert_hall_skeleton') {
      await sleep(STAGE_DELAY_MS);
      content = JSON.stringify(skeletonAnswer());
    } else if (schemaName === 'concert_hall_section_notes') {
      await sleep(STAGE_DELAY_MS);
      content = JSON.stringify(sectionAnswer());
    } else if (schemaName === 'character_emotion_choice') {
      content = JSON.stringify({ expression: 'joy' });
    } else if (schemaName === 'work_record_recall_choice') {
      content = JSON.stringify({ work_record_ids: [] });
    } else if (prompt.includes('この発言を行ったプレイヤーとの会話を継続したいと思うか')) {
      content = 'true';
    } else if (prompt.includes('好感度の変化量を判定する')) {
      content = '0';
    } else if (prompt.includes('MP温存ライン')) {
      content = '30';
    } else if (prompt.includes('所持金判定')) {
      content = '0';
    } else if (prompt.includes('場所移動の合意')) {
      content = 'false';
    } else if (prompt.includes('location_idを1つだけ返す')) {
      content = 'none';
    } else if (prompt.includes('ルーティングハブ会話内容') && prompt.includes('destination_id')) {
      content = 'concert_hall';
    } else if (prompt.includes('行き先が確定したプレイヤーを送り出す')) {
      content = SENDOFF_TEXT;
    } else if (requests.length === 1) {
      content = '新しい週をここから始めましょう。';
    } else {
      content = '奏楽堂ですね。楽師に願いを伝えてみましょう。';
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

// A port that is closed right now: bound on the loopback, released, never reused by this process. The unreachable
// base_url of real mode's LM failure points at it.
async function closedLoopbackPort() {
  const probe = createTcpServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
// The performance must actually schedule audio with no user gesture in Electron: the player resumes its own
// context inside the click, and Electron's default policy allows it; make it explicit so the harness is stable.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let gameServer;
let lmStub;
let root;
let exitCode = 0;

async function waitFor(win, predicate, { tries, intervalMs = POLL_MS }) {
  for (let i = 0; i < tries; i += 1) {
    const ok = await win.webContents.executeJavaScript(`(() => { try { return !!(${predicate}); } catch (e) { return false; } })()`);
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}

const STATE = `(document.querySelector('#academy-concert-hall-screen')?.dataset.state ?? null)`;
const FACE = `(document.querySelector('.academy-concert-hall-board')?.dataset.face ?? null)`;
const CONCERT_HALL_ACTIVE = `document.querySelector('#academy-concert-hall-screen')?.classList.contains('active')`;

async function stateOf(win) {
  return win.webContents.executeJavaScript(`({ state: ${STATE}, face: ${FACE}, screen: document.querySelector('.screen.active')?.id ?? null, status: (document.querySelector('#academy-concert-hall-status')?.textContent ?? '').trim() })`);
}

async function waitForState(win, state, options) {
  const ok = await waitFor(win, `${STATE} === ${JSON.stringify(state)}`, options);
  const snapshot = await stateOf(win);
  check(`state ${state}`, ok && snapshot.state === state, snapshot);
  return snapshot;
}

async function shoot(win, outDir, name) {
  await sleep(250);
  const image = await win.webContents.capturePage();
  const file = path.join(outDir, `${name}.png`);
  await fs.writeFile(file, image.toPNG());
  const size = image.getSize();
  log('screenshot', { file, width: size.width, height: size.height });
  return file;
}

// ── visibility measurement (asserted before every capture) ───────────────────────────────────────────────────
// For each named element: scrollIntoView (block nearest — the board's face is an internal scroller and the player
// scrolls it) when asked, then the rect, whether it lies fully inside the viewport AND inside every overflow-clipping
// ancestor's box, and whether the topmost element at its centre is itself or a descendant (an overlay covering it
// would be reported instead).
async function measureVisible(win, entries) {
  const measured = await win.webContents.executeJavaScript(`((entries) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const round = (rect) => ({ x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) });
    const describe = (el) => el ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList.length ? '.' + [...el.classList].join('.') : '') : null;
    return entries.map(({ name, selector, index, scroll }) => {
      const el = document.querySelectorAll(selector)[index ?? 0];
      if (!el) return { name, selector, found: false };
      if (scroll) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = el.getBoundingClientRect();
      let clip = { left: 0, top: 0, right: vw, bottom: vh };
      for (let node = el.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.overflowY === 'visible' && style.overflowX === 'visible') continue;
        const box = node.getBoundingClientRect();
        clip = { left: Math.max(clip.left, box.left), top: Math.max(clip.top, box.top), right: Math.min(clip.right, box.right), bottom: Math.min(clip.bottom, box.bottom) };
      }
      const inside = rect.width > 0 && rect.height > 0
        && rect.left >= clip.left - 0.5 && rect.top >= clip.top - 0.5 && rect.right <= clip.right + 0.5 && rect.bottom <= clip.bottom + 0.5;
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const covered = !(hit && (hit === el || el.contains(hit)));
      return { name, selector, found: true, rect: round(rect), clip: { x: Math.round(clip.left), y: Math.round(clip.top), w: Math.round(clip.right - clip.left), h: Math.round(clip.bottom - clip.top) }, inside, covered, top_hit: describe(hit) };
    });
  })(${JSON.stringify(entries)})`);
  const bad = measured.filter((entry) => !entry.found || !entry.inside || entry.covered);
  check('visible before capture', bad.length === 0, { bad });
  return measured;
}

const COMMON_VISIBLE = [
  { name: 'stage frame', selector: '.academy-concert-hall-stage' },
  { name: 'stage week caption', selector: '#academy-concert-hall-week' },
  { name: 'controls: input', selector: '#academy-concert-hall-input' },
  { name: 'controls: compose', selector: '#academy-concert-hall-compose' },
  { name: 'controls: exit', selector: '#academy-concert-hall-exit' },
  { name: 'board', selector: '.academy-concert-hall-board' }
];
const SHELF_VISIBLE = (pieces) => [
  { name: 'shelf: greeting', selector: '#academy-concert-hall-greeting' },
  { name: 'shelf: heading', selector: '.academy-concert-hall-shelf-heading' },
  ...(pieces === 0
    ? [{ name: 'shelf: empty line', selector: '#academy-concert-hall-shelf-empty' }]
    : Array.from({ length: pieces }, (_unused, index) => ({ name: `shelf: row ${index}`, selector: '.academy-concert-hall-shelf-button', index })))
];
const BUSY_VISIBLE = [
  { name: 'busy card', selector: '.academy-concert-hall-card[data-busy="true"]', scroll: true },
  { name: 'busy label', selector: '.academy-concert-hall-card[data-busy="true"] .academy-concert-hall-busy-label' }
];
const PERFORMANCE_VISIBLE = [
  { name: 'head: title', selector: '#academy-concert-hall-head-title' },
  { name: 'head: meta', selector: '#academy-concert-hall-head-meta' },
  { name: 'head: progress bar', selector: '.academy-concert-hall-progress' },
  { name: 'head: section', selector: '#academy-concert-hall-head-section' },
  { name: 'head: stop', selector: '#academy-concert-hall-stop' },
  { name: 'current section card', selector: '#academy-concert-hall-performance-cards .academy-concert-hall-card-section[data-current="true"]', scroll: true }
];

// ── DOM composition snapshot (the audit's actual side) ───────────────────────────────────────────────────────
const SNAPSHOT = `(() => {
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const stage = q('.academy-concert-hall-stage');
  const corners = ['::before', '::after'].filter((pseudo) => {
    const style = getComputedStyle(stage, pseudo);
    return style.content !== 'none' && style.backgroundImage.includes('corner');
  }).length;
  const cardOf = (el) => ({
    title: el.querySelector('.academy-concert-hall-card-title').textContent,
    stage: el.dataset.stage,
    written: el.dataset.written === 'true',
    busy: el.dataset.busy === 'true',
    busy_label: el.querySelector('.academy-concert-hall-busy-label')?.textContent ?? null,
    error: el.dataset.error === 'true',
    error_line: el.querySelector('.academy-concert-hall-card-error')?.textContent ?? null,
    retry_label: el.querySelector('.academy-concert-hall-retry')?.textContent ?? null,
    current: el.dataset.current === 'true'
  });
  const faceCards = (faceId) => ({
    stage_cards: qa('#' + faceId + ' .academy-concert-hall-card-stage').map(cardOf),
    section_cards: qa('#' + faceId + ' .academy-concert-hall-card-section').map(cardOf)
  });
  const face = q('.academy-concert-hall-board').dataset.face;
  const input = q('#academy-concert-hall-input');
  const compose = q('#academy-concert-hall-compose');
  const exit = q('#academy-concert-hall-exit');
  const order = [input, compose, exit].map((el) => el.getBoundingClientRect());
  const stop = q('#academy-concert-hall-stop').getBoundingClientRect();
  const headText = q('.academy-concert-hall-head-text').getBoundingClientRect();
  return {
    state: q('#academy-concert-hall-screen').dataset.state,
    face,
    stage: { corner_ornaments: corners, caption: q('#academy-concert-hall-week').textContent },
    controls: {
      order: qa('.academy-concert-hall-controls > *').map((el) => el.id),
      left_to_right: order[0].right <= order[1].left && order[1].right <= order[2].left,
      input_text: input.value.length > 0,
      input_enabled: !input.disabled,
      compose_enabled: !compose.disabled,
      exit_enabled: !exit.disabled
    },
    shelf: {
      greeting: q('#academy-concert-hall-greeting').textContent.trim().length > 0,
      heading: q('.academy-concert-hall-shelf-heading').textContent,
      empty_line: !q('#academy-concert-hall-shelf-empty').hidden && q('#academy-concert-hall-shelf-empty').textContent.trim().length > 0,
      rows: qa('.academy-concert-hall-shelf-button').map((el) => ({
        entry_id: el.dataset.entryId,
        highlight: el.dataset.highlight === 'true',
        columns: [...el.children].map((col) => [...col.classList].find((cls) => cls !== 'academy-concert-hall-shelf-col')),
        title: el.querySelector('.academy-concert-hall-shelf-title').textContent,
        direction: el.querySelector('.academy-concert-hall-shelf-direction').textContent,
        week: el.querySelector('.academy-concert-hall-shelf-week').textContent
      }))
    },
    narration: { ...faceCards('academy-concert-hall-narration-cards'), cta_visible: !q('#academy-concert-hall-perform').hidden, cta_label: q('#academy-concert-hall-perform').textContent },
    performance: {
      head: {
        title: q('#academy-concert-hall-head-title').textContent,
        meta: q('#academy-concert-hall-head-meta').textContent,
        progress: q('.academy-concert-hall-progress').getAttribute('aria-valuenow'),
        section: q('#academy-concert-hall-head-section').textContent,
        stop_label: q('#academy-concert-hall-stop').textContent,
        stop_right_of_text: stop.left >= headText.right
      },
      ...faceCards('academy-concert-hall-performance-cards')
    }
  };
})()`;

// The board's expected composition for one capture, from its §1 / §2 rows and the run's facts (the piece's section
// count and the shelf's piece count are known once the piece exists; the section count of the S5 capture is judged
// against the committed piece afterwards). `null` = the board says nothing (recorded, not judged).
function expectedComposition(key, facts) {
  const busyStage = { 's1': 'materials', 's2': 'direction', 's4': 'skeleton', 's5': 'section' };
  const base = {
    face: null,
    stage: { corner_ornaments: STAGE_CORNER_ORNAMENTS, caption_has_week: true },
    controls: { order: CONTROL_ORDER, left_to_right: true, input_text: null, input_enabled: null, compose_enabled: null, exit_enabled: null },
    shelf: null,
    narration: null,
    performance: null
  };
  // With no row on the shelf there is no column to measure: the columns are recorded only (null), never assumed.
  const shelfFace = (rows, highlightTop) => ({ greeting: true, heading: true, empty_line: rows === 0, rows, columns: rows === 0 ? null : SHELF_COLUMNS, highlight_top: highlightTop });
  const narrationFace = ({ written, busy, busyIndex = null, sections, sectionsWritten, cta, error = null }) => ({
    stage_order: STAGE_CARD_TITLES, stage_written: written, busy_stage: busy, busy_index: busyIndex, busy_label: busy ? BUSY_LABEL : null,
    section_cards: sections, section_written: sectionsWritten, cta_visible: cta, error
  });
  const performanceFace = () => ({ head_title: facts.piece.title, progress_bar: true, head_section: facts.piece.sections[0], stop_label: '止める', stop_right_of_text: true, stage_order: STAGE_CARD_TITLES, stage_written: 4, section_cards: facts.piece.sections.length, current_index: 0 });
  switch (key) {
    case '01-arrival': return { ...base, face: 'shelf', controls: { ...base.controls, input_text: false, compose_enabled: false }, shelf: shelfFace(0, null) };
    case '02-typing': return { ...base, face: 'shelf', controls: { ...base.controls, input_text: true, compose_enabled: true }, shelf: shelfFace(0, null) };
    case '03-composing-s1': case '03-composing-s2': case '03-composing-s4': case '03-composing-s5': {
      const stage = busyStage[key.slice(-2)];
      const written = { materials: 0, direction: 1, skeleton: 3, section: 4 }[stage];
      return {
        ...base, face: 'narration', controls: { ...base.controls, input_enabled: false, compose_enabled: false, exit_enabled: true },
        narration: narrationFace({ written, busy: stage, busyIndex: stage === 'section' ? 0 : null, sections: stage === 'section' ? facts.piece.sections.length : 0, sectionsWritten: 0, cta: false })
      };
    }
    case '04-narration': return { ...base, face: 'narration', controls: { ...base.controls, input_enabled: true }, narration: narrationFace({ written: 4, busy: null, sections: facts.piece.sections.length, sectionsWritten: facts.piece.sections.length, cta: true }) };
    case '05-playing': return { ...base, face: 'performance', controls: { ...base.controls, input_enabled: false, compose_enabled: false }, performance: performanceFace() };
    case '06-after-play': return { ...base, face: 'shelf', controls: { ...base.controls, input_enabled: true }, shelf: shelfFace(1, true) };
    case '07-shelf': return { ...base, face: 'shelf', shelf: shelfFace(1, false) };
    case '08-replay': return { ...base, face: 'performance', controls: { ...base.controls, input_enabled: false, compose_enabled: false }, performance: performanceFace() };
    case '09-lm-error': return {
      ...base, face: 'narration', controls: { ...base.controls, input_enabled: true, exit_enabled: true },
      narration: narrationFace({ written: 0, busy: null, sections: 0, sectionsWritten: 0, cta: false, error: { stage: 'materials', red_line: true, retry_label: RETRY_LABEL } })
    };
    default: throw new Error(`no board expectation for capture ${key}`);
  }
}

// The actual side, folded to the expectation's shape from the DOM snapshot.
function actualComposition(snapshot) {
  const narrationActual = (face) => {
    const busy = face.stage_cards.find((card) => card.busy) ?? null;
    const busySection = face.section_cards.findIndex((card) => card.busy);
    const errorCard = [...face.stage_cards, ...face.section_cards].find((card) => card.error) ?? null;
    return {
      stage_order: face.stage_cards.map((card) => card.title),
      stage_written: face.stage_cards.filter((card) => card.written).length,
      busy_stage: busy ? busy.stage : (busySection >= 0 ? 'section' : null),
      busy_index: busySection >= 0 ? busySection : null,
      busy_label: busy?.busy_label ?? face.section_cards[busySection]?.busy_label ?? null,
      section_cards: face.section_cards.length,
      section_written: face.section_cards.filter((card) => card.written).length,
      cta_visible: face.cta_visible,
      error: errorCard ? { stage: errorCard.stage, red_line: (errorCard.error_line ?? '').length > 0, retry_label: errorCard.retry_label } : null
    };
  };
  const currentIndex = snapshot.performance.section_cards.findIndex((card) => card.current);
  return {
    face: snapshot.face,
    stage: { corner_ornaments: snapshot.stage.corner_ornaments, caption_has_week: /第\d+週/.test(snapshot.stage.caption) },
    controls: { order: snapshot.controls.order, left_to_right: snapshot.controls.left_to_right, input_text: snapshot.controls.input_text, input_enabled: snapshot.controls.input_enabled, compose_enabled: snapshot.controls.compose_enabled, exit_enabled: snapshot.controls.exit_enabled },
    shelf: {
      greeting: snapshot.shelf.greeting, heading: snapshot.shelf.heading.length > 0, empty_line: snapshot.shelf.empty_line, rows: snapshot.shelf.rows.length,
      columns: snapshot.shelf.rows.length ? snapshot.shelf.rows[0].columns : null, highlight_top: snapshot.shelf.rows.length ? snapshot.shelf.rows[0].highlight && snapshot.shelf.rows.slice(1).every((row) => !row.highlight) : null
    },
    narration: narrationActual(snapshot.narration),
    performance: {
      head_title: snapshot.performance.head.title, progress_bar: snapshot.performance.head.progress !== null, head_section: snapshot.performance.head.section,
      stop_label: snapshot.performance.head.stop_label, stop_right_of_text: snapshot.performance.head.stop_right_of_text,
      stage_order: snapshot.performance.stage_cards.map((card) => card.title), stage_written: snapshot.performance.stage_cards.filter((card) => card.written).length,
      section_cards: snapshot.performance.section_cards.length, current_index: currentIndex >= 0 ? currentIndex : null
    }
  };
}

// expected vs actual, leaf by leaf; a `null` expectation is recorded only. Returns { match, mismatches, rows }.
function compareComposition(expected, actual) {
  const rows = [];
  const walk = (exp, act, prefix) => {
    if (exp === null) return;
    if (Array.isArray(exp) || typeof exp !== 'object') {
      const ok = JSON.stringify(exp) === JSON.stringify(act);
      rows.push({ item: prefix, expected: exp, actual: act === undefined ? null : act, match: ok });
      return;
    }
    for (const [key, value] of Object.entries(exp)) walk(value, act?.[key], prefix ? `${prefix}.${key}` : key);
  };
  walk(expected, actual, '');
  const mismatches = rows.filter((row) => !row.match).map((row) => row.item);
  return { match: mismatches.length === 0, mismatches, rows };
}

// The Web Audio observation installed before the performance: counts start() calls, keeps the set of started
// sources until each fires `ended`, and counts suspend() calls per context.
const INSTALL_AUDIO_PROBE = `(() => {
  if (window.__chAudio) return true;
  const probe = { starts: 0, live: new Set(), suspends: 0, contexts: 0 };
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...args) {
    probe.starts += 1;
    probe.live.add(this);
    this.addEventListener('ended', () => probe.live.delete(this), { once: true });
    return start.apply(this, args);
  };
  // A source is released when it fires ended OR the player stops it now (stop() with no argument) and
  // disconnects it; a scheduled-only source that is stopped before its start time may never fire ended.
  const stop = AudioBufferSourceNode.prototype.stop;
  probe.stopsNow = 0;
  AudioBufferSourceNode.prototype.stop = function (...args) {
    if (args.length === 0) { probe.stopsNow += 1; probe.live.delete(this); }
    return stop.apply(this, args);
  };
  const suspend = AudioContext.prototype.suspend;
  AudioContext.prototype.suspend = function (...args) { probe.suspends += 1; return suspend.apply(this, args); };
  const resume = AudioContext.prototype.resume;
  probe.resumes = 0; probe.resumed = 0; probe.decodes = 0; probe.decoded = 0;
  AudioContext.prototype.resume = function (...args) { probe.resumes += 1; return resume.apply(this, args).then((v) => { probe.resumed += 1; return v; }); };
  const decode = AudioContext.prototype.decodeAudioData;
  AudioContext.prototype.decodeAudioData = function (...args) { probe.decodes += 1; return decode.apply(this, args).then((v) => { probe.decoded += 1; return v; }); };
  window.__chAudio = probe;
  return true;
})()`;

const READ_AUDIO_PROBE = `({ starts: window.__chAudio.starts, live: window.__chAudio.live.size, stopsNow: window.__chAudio.stopsNow, suspends: window.__chAudio.suspends, resumes: window.__chAudio.resumes, resumed: window.__chAudio.resumed, decodes: window.__chAudio.decodes, decoded: window.__chAudio.decoded })`;

async function setWish(win, text) {
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#academy-concert-hall-input');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}

async function click(win, selector) {
  const ok = await win.webContents.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.disabled) return false; el.click(); return true; })()`);
  check(`click ${selector}`, ok);
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} → ${response.status} ${await response.text()}`);
  return response.json();
}

// ── LM observation ───────────────────────────────────────────────────────────────────────────────────────────
// stub mode: the stub's own request list. real mode: the product's request log (a 30-entry ring; every leg is
// read right after it completes, records are deduplicated by id, and the ring's capacity is stated in the audit).
function createLmObserver({ real, base, stub }) {
  const records = new Map();
  const legs = [];
  let lastCount = 0;
  return {
    async leg(name) {
      if (real) {
        const { requests } = await fetchJson(`${base}/api/debug/llm-requests`);
        for (const record of requests) {
          if (records.has(record.id)) continue;
          records.set(record.id, {
            id: record.id, title: record.title, kind: record.kind, completed_at: record.completed_at,
            input_bytes: Buffer.byteLength(record.input, 'utf8'), output_bytes: Buffer.byteLength(record.output, 'utf8'),
            input: record.input, output: record.output
          });
        }
      }
      const count = real ? records.size : stub.requests.length;
      const entry = { leg: name, calls: count - lastCount, total: count };
      lastCount = count;
      legs.push(entry);
      log('lm leg', entry);
      return entry;
    },
    records: () => [...records.values()],
    legs
  };
}

// One compose's stage accounting from the request log records that belong to it (real mode): attempts per stage
// (the same title repeated = a gate retry), the S1 prompt, and per-call wall time from consecutive completions.
function composeAccounting(records, { startedAt, doneAt }) {
  const stages = {};
  const order = [];
  let previous = startedAt;
  for (const record of records) {
    const sectionMatch = record.title.match(SECTION_TITLE);
    const stage = sectionMatch ? `section-${sectionMatch[1]}` : Object.entries(STAGE_TITLES).find(([, title]) => title === record.title)?.[0];
    if (!stage) throw new Error(`unexpected LM request title inside a compose: ${record.title}`);
    if (!stages[stage]) { stages[stage] = { attempts: 0, calls: [] }; order.push(stage); }
    const completed = Date.parse(record.completed_at);
    stages[stage].attempts += 1;
    stages[stage].calls.push({ id: record.id, ms: completed - previous, input_bytes: record.input_bytes, output_bytes: record.output_bytes });
    previous = completed;
  }
  const s1 = records.find((record) => record.title === STAGE_TITLES.materials) ?? null;
  const candidateLines = s1 ? s1.input.split('\n').filter((line) => /^- \S+: \[/.test(line)) : [];
  const countKind = (kind) => candidateLines.filter((line) => line.includes(`[${kind}]`)).length;
  return {
    stages: order.map((stage) => ({ stage, attempts: stages[stage].attempts, retries: stages[stage].attempts - 1, calls: stages[stage].calls })),
    total_calls: records.length,
    total_retries: order.reduce((sum, stage) => sum + stages[stage].attempts - 1, 0),
    elapsed_ms: doneAt - startedAt,
    s1_prompt: s1 ? {
      bytes: s1.input_bytes,
      candidates: { total: candidateLines.length, events: countKind('直近の出来事'), items: countKind('所持品'), books: countKind('読んだ本'), buddy: countKind('同行者') },
      attempts: stages.materials?.attempts ?? 0,
      text: s1.input,
      answers: records.filter((record) => record.title === STAGE_TITLES.materials).map((record) => record.output)
    } : null,
    narration_answers: {
      direction: records.filter((record) => record.title === STAGE_TITLES.direction).map((record) => record.output),
      skeleton: records.filter((record) => record.title === STAGE_TITLES.skeleton).map((record) => record.output)
    }
  };
}

function gitHead(repoRoot) {
  return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

async function main() {
  const { repoRoot, outDir, lmConfigPath } = parseArgs(process.argv.slice(2));
  const real = lmConfigPath !== null;
  const { createServer } = await import(path.join(repoRoot, 'app/src/server.mjs'));
  const { fixtureRoot } = await import(path.join(repoRoot, 'app/tests/helpers.mjs'));
  const { runtimePathsManifestFilename } = await import(path.join(repoRoot, 'app/src/runtimePaths.mjs'));
  const { loadLmStudioConfig } = await import(path.join(repoRoot, 'app/src/llm/lmStudioClient.mjs'));
  await fs.mkdir(outDir, { recursive: true });
  // Real-LM waits are bounded by the product's own budget (timeout_ms × 3 attempts per stage); stub waits are short.
  const startedAt = Date.now();
  const head = gitHead(repoRoot);
  // The isolated slot: the shared test fixture (seeds / character authoring cloned under <root>/game_data) with a
  // runtime-paths manifest that points the server at that clone, at the repo's read-only definitions (the
  // concert hall's authored 3 files live there) and at the repo's canonical assets (the library harness form).
  root = await fixtureRoot('concert-hall-render-');
  await fs.writeFile(path.join(root, runtimePathsManifestFilename), `${JSON.stringify({
    configRoot: path.join(root, 'app/config'),
    definitionsRoot: path.join(repoRoot, 'data/definitions/game_data'),
    seedsRoot: path.join(root, 'game_data'),
    mutableRoot: path.join(root, 'game_data'),
    characterContentRoot: path.join(root, 'game_data/characters'),
    creatureContentRoot: path.join(root, 'game_data/creatures'),
    canonicalAssetsRoot: path.join(repoRoot, 'assets/canonical'),
    publicRoot: path.join(repoRoot, 'app/public'),
    resourceRoot: root
  }, null, 2)}\n`, 'utf8');
  const playModeSettingsPath = path.join(root, 'play-mode.json');
  await fs.writeFile(playModeSettingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');

  const stubState = { faultArmed: false };
  let lmStudioConfig;
  let realLm = null;
  if (real) {
    const loaded = await loadLmStudioConfig(lmConfigPath);
    lmStudioConfig = { ...loaded };
    const url = new URL(loaded.base_url);
    realLm = { config_path: lmConfigPath, base_url: loaded.base_url, host: url.hostname, port: Number(url.port), chat_model: loaded.chat_model, reflection_model: loaded.reflection_model, stream: loaded.stream, timeout_ms: loaded.timeout_ms };
  } else {
    lmStub = await startLmStub(stubState);
    lmStudioConfig = { base_url: lmStub.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 15000, stream: false };
  }
  const stageTries = real ? Math.ceil((lmStudioConfig.timeout_ms * 3 + 30000) / POLL_MS) : Math.ceil(30000 / POLL_MS);
  const LONG = { tries: stageTries };
  const SHORT = { tries: Math.ceil(10000 / POLL_MS) };
  gameServer = createServer({
    root,
    publicRoot: path.join(repoRoot, 'app/public'),
    canonicalAssetsRoot: path.join(repoRoot, 'assets/canonical'),
    playModeSettingsPath,
    lmStudioConfig,
    // The settings file the server persists (real mode's PATCH) stays inside the isolated slot.
    lmStudioConfigPath: path.join(root, 'app/config/lmstudio.json')
  });
  await new Promise((resolve) => gameServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gameServer.address().port}`;
  const launch = real ? 'real' : 'stub';
  log('server', { base, lm: real ? realLm : lmStub.baseUrl, launch, head });
  const lm = createLmObserver({ real, base, stub: lmStub });

  await app.whenReady();
  const win = new BrowserWindow({ width: VIEWPORT.width, height: VIEWPORT.height, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.log(`renderer-console[${level}]: ${message}`); });
  await win.loadURL(`${base}/`);
  await sleep(1200);

  const captures = {};
  const composition = {};
  const facts = { piece: null };
  // One capture: the visibility assertion, the DOM snapshot, the PNG, all under the launch kind of that moment.
  async function capture(key, visible, kind = launch) {
    const visibility = await measureVisible(win, [...COMMON_VISIBLE, ...visible]);
    const snapshot = await win.webContents.executeJavaScript(SNAPSHOT);
    const file = await shoot(win, outDir, key);
    captures[key] = { file: path.basename(file), launch: kind, state: snapshot.state, face: snapshot.face, visibility, snapshot };
    return snapshot;
  }

  // 1) New game in routing mode → the hub 迎え conversation; a turn the LM decides as concert_hall → dispatch.
  check('title start button', await waitFor(win, `document.querySelector('#start-new-game')`, LONG));
  await click(win, '#start-new-game');
  check('hub opening ready', await waitFor(win, `
    document.querySelector('#routing-hub-screen')?.classList.contains('active')
    && !document.querySelector('#routing-hub-send')?.disabled
    && (document.querySelector('#routing-hub-message-stream')?.textContent || '').trim().length > 0
  `, LONG));
  // The hub send is a silent no-op while the opening reveal's request is still in flight: retry until the real
  // send fires (it synchronously clears the input). The real model may keep the conversation going instead of
  // deciding the destination on the first turn, so the same wish is sent again (bounded) until the dispatch lands;
  // a dispatch to any other screen fails the run.
  const hubTurnLimit = real ? 3 : 1;
  let hubTurns = 0;
  let dispatched = false;
  while (!dispatched && hubTurns < hubTurnLimit) {
    let sent = false;
    for (let attempt = 0; attempt < 20 && !sent; attempt += 1) {
      await waitFor(win, `document.querySelector('#routing-hub-screen')?.classList.contains('active') && !document.querySelector('#routing-hub-send')?.disabled`, SHORT);
      const fired = await win.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('#routing-hub-input');
        const send = document.querySelector('#routing-hub-send');
        if (!input || !send || send.disabled) return false;
        input.value = ${JSON.stringify(PLAYER_INPUT)};
        send.click();
        return true;
      })()`);
      sent = fired && await waitFor(win, `document.querySelector('#routing-hub-input').value === ''`, { tries: 20 });
      if (!sent) await sleep(400);
    }
    check('hub turn sent', sent);
    hubTurns += 1;
    dispatched = await waitFor(win, `${CONCERT_HALL_ACTIVE} || (document.querySelector('.screen.active')?.id !== 'routing-hub-screen' && document.querySelector('.screen.active')?.id !== 'academy-loading-screen')`, LONG)
      && await win.webContents.executeJavaScript(CONCERT_HALL_ACTIVE);
    if (!dispatched) {
      const snapshot = await stateOf(win);
      if (snapshot.screen !== 'routing-hub-screen') check('dispatched to academy-concert-hall', false, { ...snapshot, hubTurns });
      log('hub turn did not dispatch', { hubTurns, snapshot });
    }
  }
  check('dispatched to academy-concert-hall', dispatched, { hubTurns });
  const hubLeg = await lm.leg('hub dispatch');

  // State 1 到着: the 棚面 with the 楽師's greeting and the empty shelf line, the input empty and 奏でてもらう dead.
  const arrived = await waitForState(win, 'arrived', SHORT);
  check('arrival face is the shelf', arrived.face === 'shelf', arrived);
  const arrivalDom = await win.webContents.executeJavaScript(`({
    greeting: document.querySelector('#academy-concert-hall-greeting').textContent.trim().length,
    emptyShelf: !document.querySelector('#academy-concert-hall-shelf-empty').hidden,
    composeDisabled: document.querySelector('#academy-concert-hall-compose').disabled,
    placeholder: document.querySelector('#academy-concert-hall-input').placeholder.length,
    controls: [...document.querySelectorAll('.academy-concert-hall-controls > *')].map((el) => el.id)
  })`);
  check('arrival dom', arrivalDom.greeting > 0 && arrivalDom.emptyShelf && arrivalDom.composeDisabled && arrivalDom.placeholder > 0, arrivalDom);
  check('controls order', JSON.stringify(arrivalDom.controls) === JSON.stringify(CONTROL_ORDER), arrivalDom);
  await capture('01-arrival', SHELF_VISIBLE(0));

  // State 2 入力中.
  await setWish(win, WISH_TEXT);
  await waitForState(win, 'typing', SHORT);
  check('compose armed by text', await win.webContents.executeJavaScript(`!document.querySelector('#academy-concert-hall-compose').disabled`));
  await capture('02-typing', SHELF_VISIBLE(0));

  // State 3 作曲中, four captures: S1 busy → S2 busy → S4 busy (S3 is machine-resolved and arrives with S2) → S5
  // busy on the first section card (the section cards appear with S4).
  const composeStartedAt = Date.now();
  await click(win, '#academy-concert-hall-compose');
  await waitForState(win, 'composing', SHORT);
  check('composing face is the narration', await win.webContents.executeJavaScript(`${FACE} === 'narration'`));
  const busyCard = (stage) => `document.querySelector('.academy-concert-hall-card[data-stage="${stage}"][data-busy="true"] .academy-concert-hall-busy-label')?.textContent === ${JSON.stringify(BUSY_LABEL)}`;
  check('S1 card busy first', await waitFor(win, busyCard('materials'), SHORT));
  const composingDom = await win.webContents.executeJavaScript(`({
    cardOrder: [...document.querySelectorAll('.academy-concert-hall-card-stage .academy-concert-hall-card-title')].map((el) => el.textContent),
    inputDisabled: document.querySelector('#academy-concert-hall-input').disabled,
    exitEnabled: !document.querySelector('#academy-concert-hall-exit').disabled
  })`);
  check('stage cards fixed order', JSON.stringify(composingDom.cardOrder) === JSON.stringify(STAGE_CARD_TITLES) && composingDom.inputDisabled && composingDom.exitEnabled, composingDom);
  await capture('03-composing-s1', BUSY_VISIBLE);
  check('S2 card busy after S1 written', await waitFor(win, `${busyCard('direction')} && document.querySelectorAll('.academy-concert-hall-card-stage[data-written="true"]').length === 1`, LONG));
  await capture('03-composing-s2', BUSY_VISIBLE);
  check('S4 card busy after S1〜S3 written', await waitFor(win, `${busyCard('skeleton')} && document.querySelectorAll('.academy-concert-hall-card-stage[data-written="true"]').length === 3`, LONG));
  await capture('03-composing-s4', BUSY_VISIBLE);
  check('S5: first section card busy after S4 written', await waitFor(win, `
    document.querySelector('.academy-concert-hall-card-section[data-section-index="0"][data-busy="true"] .academy-concert-hall-busy-label')?.textContent === ${JSON.stringify(BUSY_LABEL)}
    && document.querySelectorAll('.academy-concert-hall-card-stage[data-written="true"]').length === 4
  `, LONG));
  await capture('03-composing-s5', BUSY_VISIBLE);

  // State 4 演奏前の語り: every card written, the section cards marked, the CTA up, the input live again. The CTA sits
  // below the section cards inside the internal scroller, so the capture scrolls it into view (the player's scroll).
  await waitForState(win, 'narrated', LONG);
  const composeDoneAt = Date.now();
  const narratedDom = await win.webContents.executeJavaScript(`({
    writtenStages: document.querySelectorAll('.academy-concert-hall-card-stage[data-written="true"]').length,
    sectionCards: [...document.querySelectorAll('.academy-concert-hall-card-section')].map((el) => ({ title: el.querySelector('.academy-concert-hall-card-title').textContent, written: el.dataset.written === 'true' })),
    ctaVisible: !document.querySelector('#academy-concert-hall-perform').hidden,
    inputEnabled: !document.querySelector('#academy-concert-hall-input').disabled
  })`);
  check('narrated dom', narratedDom.writtenStages === 4 && narratedDom.sectionCards.length >= 2 && narratedDom.sectionCards.every((card) => card.written) && narratedDom.ctaVisible && narratedDom.inputEnabled, narratedDom);
  await capture('04-narration', [
    { name: 'stage card: 骨子', selector: '.academy-concert-hall-card-stage[data-stage="skeleton"]', scroll: true },
    { name: 'last section card', selector: '.academy-concert-hall-card-section', index: narratedDom.sectionCards.length - 1, scroll: true },
    { name: 'CTA 演奏を始める', selector: '#academy-concert-hall-perform', scroll: true }
  ]);
  const composeLeg = await lm.leg('compose #1');

  // The committed piece (real HTTP, the same server): its note count is the expected start() count.
  const arrival = await fetchJson(`${base}/api/concert-hall`);
  check('piece committed to the shelf', arrival.pieces.length === 1, { pieces: arrival.pieces });
  const entryId = arrival.pieces[0].entry_id;
  const piece = await fetchJson(`${base}/api/concert-hall/pieces/${encodeURIComponent(entryId)}`);
  const noteCount = piece.score.tracks.reduce((sum, track) => sum + track.notes.length, 0);
  facts.piece = { title: piece.title, sections: piece.score.sections.map((section) => section.name) };
  check('section cards = skeleton sections', narratedDom.sectionCards.length === piece.score.sections.length && narratedDom.sectionCards.every((card, index) => card.title === piece.score.sections[index].name), { cards: narratedDom.sectionCards, sections: facts.piece.sections });
  log('piece', { entryId, title: piece.title, direction: arrival.pieces[0].direction_label, tempo: piece.score.tempo, meter: piece.score.meter, key: piece.score.key, mode: piece.score.mode, sections: facts.piece.sections, tracks: piece.score.tracks.map((track) => [track.role, track.instrument, track.notes.length]), noteCount });

  // State 5 演奏中: the audio probe goes in first; the performance schedules every note.
  check('audio probe installed', await win.webContents.executeJavaScript(INSTALL_AUDIO_PROBE));
  await click(win, '#academy-concert-hall-perform');
  await waitForState(win, 'playing', LONG);
  await sleep(1500);
  const playingProbe = await win.webContents.executeJavaScript(READ_AUDIO_PROBE);
  const playingDom = await win.webContents.executeJavaScript(`({
    face: ${FACE},
    headTitle: document.querySelector('#academy-concert-hall-head-title').textContent,
    headMeta: document.querySelector('#academy-concert-hall-head-meta').textContent,
    headSection: document.querySelector('#academy-concert-hall-head-section').textContent,
    progress: document.querySelector('.academy-concert-hall-progress').getAttribute('aria-valuenow'),
    currentSection: document.querySelector('.academy-concert-hall-card-section[data-current="true"]')?.dataset.sectionIndex ?? null,
    inputDisabled: document.querySelector('#academy-concert-hall-input').disabled
  })`);
  check('playing: start calls = note count', playingProbe.starts === noteCount, { ...playingProbe, noteCount });
  check('playing dom', playingDom.face === 'performance' && playingDom.headTitle === piece.title && playingDom.headSection === piece.score.sections[0].name && playingDom.currentSection === '0' && playingDom.inputDisabled && Number(playingDom.progress) > 0, playingDom);
  await capture('05-playing', PERFORMANCE_VISIBLE);

  // State 6 演奏後 via 止める: no started source survives, the player's context is suspended, the new piece is on
  // top of the shelf with the highlight.
  await click(win, '#academy-concert-hall-stop');
  await waitForState(win, 'played', SHORT);
  check('stopped: no live source', await waitFor(win, `window.__chAudio.live.size === 0`, SHORT));
  const stoppedProbe = await win.webContents.executeJavaScript(READ_AUDIO_PROBE);
  check('stopped: context suspended', stoppedProbe.suspends >= 1, stoppedProbe);
  const playedDom = await win.webContents.executeJavaScript(`({
    face: ${FACE},
    rows: [...document.querySelectorAll('.academy-concert-hall-shelf-button')].map((el) => ({ id: el.dataset.entryId, highlight: el.dataset.highlight === 'true', title: el.querySelector('.academy-concert-hall-shelf-title').textContent })),
    inputEnabled: !document.querySelector('#academy-concert-hall-input').disabled
  })`);
  check('played dom', playedDom.face === 'shelf' && playedDom.rows.length === 1 && playedDom.rows[0].id === entryId && playedDom.rows[0].highlight && playedDom.inputEnabled, playedDom);
  await capture('06-after-play', SHELF_VISIBLE(1));

  // State 8 再演: the shelf row replays the saved piece (GET pieces/<id>, no LM call) with its saved narration.
  const startsBefore = (await win.webContents.executeJavaScript(READ_AUDIO_PROBE)).starts;
  await click(win, `.academy-concert-hall-shelf-button[data-entry-id="${entryId}"]`);
  await waitForState(win, 'replaying', LONG);
  await sleep(1200);
  const replayProbe = await win.webContents.executeJavaScript(READ_AUDIO_PROBE);
  const replayDom = await win.webContents.executeJavaScript(`({
    face: ${FACE},
    headTitle: document.querySelector('#academy-concert-hall-head-title').textContent,
    writtenStages: document.querySelectorAll('#academy-concert-hall-performance-cards .academy-concert-hall-card-stage[data-written="true"]').length,
    sectionCards: document.querySelectorAll('#academy-concert-hall-performance-cards .academy-concert-hall-card-section').length,
    currentSection: document.querySelector('#academy-concert-hall-performance-cards .academy-concert-hall-card-section[data-current="true"]')?.dataset.sectionIndex ?? null
  })`);
  const replayLeg = await lm.leg('replay');
  check('replay: start calls = note count again, no LM call', replayProbe.starts - startsBefore === noteCount && replayLeg.calls === 0, { ...replayProbe, startsBefore, noteCount, lmCalls: replayLeg.calls });
  check('replay dom', replayDom.face === 'performance' && replayDom.headTitle === piece.title && replayDom.writtenStages === 4 && replayDom.sectionCards === piece.score.sections.length && replayDom.currentSection === '0', replayDom);
  await capture('08-replay', PERFORMANCE_VISIBLE);

  // State 7 棚: the replay stopped, the shelf face without the highlight.
  await click(win, '#academy-concert-hall-stop');
  await waitForState(win, 'shelf', SHORT);
  check('replay stopped: no live source', await waitFor(win, `window.__chAudio.live.size === 0`, SHORT));
  const shelfDom = await win.webContents.executeJavaScript(`({
    face: ${FACE},
    highlighted: document.querySelectorAll('.academy-concert-hall-shelf-button[data-highlight="true"]').length,
    rows: document.querySelectorAll('.academy-concert-hall-shelf-button').length
  })`);
  check('shelf dom', shelfDom.face === 'shelf' && shelfDom.highlighted === 0 && shelfDom.rows === 1, shelfDom);
  await capture('07-shelf', SHELF_VISIBLE(1));

  // State 9 LM エラー. stub mode: the armed stub answers S1 with an unknown material id three times → the product's
  // gate closes the stream with a real `error` event on the materials stage. real mode: the isolated server's LM
  // settings are pointed (through the product's own settings API) at a loopback port that is closed → the S1 call
  // fails on transport → LMSTUDIO_CONNECTION_UNAVAILABLE (503) carried as the stream's `error` event, landing on the
  // running (materials) card.
  let unreachable = null;
  if (real) {
    const port = await closedLoopbackPort();
    const patched = await fetchJson(`${base}/api/settings/lmstudio`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: '127.0.0.1', port, model: realLm.chat_model }) });
    unreachable = { base_url: `http://127.0.0.1:${port}/v1`, settings: patched };
    log('lm settings → unreachable', unreachable);
  } else {
    stubState.faultArmed = true;
  }
  await setWish(win, SECOND_WISH_TEXT);
  await waitForState(win, 'typing', SHORT);
  await click(win, '#academy-concert-hall-compose');
  await waitForState(win, 'error', LONG);
  const errorDom = await win.webContents.executeJavaScript(`({
    face: ${FACE},
    errorCard: document.querySelector('.academy-concert-hall-card[data-error="true"]')?.dataset.stage ?? null,
    message: document.querySelector('.academy-concert-hall-card-error')?.textContent ?? '',
    retry: document.querySelector('.academy-concert-hall-retry')?.textContent ?? '',
    inputEnabled: !document.querySelector('#academy-concert-hall-input').disabled,
    exitEnabled: !document.querySelector('#academy-concert-hall-exit').disabled
  })`);
  check('error dom', errorDom.face === 'narration' && errorDom.errorCard === 'materials' && errorDom.message.length > 0 && errorDom.retry === RETRY_LABEL && errorDom.inputEnabled && errorDom.exitEnabled, errorDom);
  const errorLeg = await lm.leg('compose #2 (LM failure)');
  if (real) check('unreachable LM: no request recorded, transport failure surfaced', errorLeg.calls === 0 && /LM Studio|LMSTUDIO|接続|connection/i.test(errorDom.message), { ...errorLeg, message: errorDom.message });
  await capture('09-lm-error', [
    { name: 'error card', selector: '.academy-concert-hall-card[data-error="true"]', scroll: true },
    { name: 'error red line', selector: '.academy-concert-hall-card-error' },
    { name: 'retry もう一度', selector: '.academy-concert-hall-retry' }
  ], real ? 'real-unreachable' : 'stub');

  // もう一度 with the LM restored: エラー → 作曲中 → 演奏前 (the recovery edge of the closed set).
  if (real) {
    const restored = await fetchJson(`${base}/api/settings/lmstudio`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: realLm.host, port: realLm.port, model: realLm.chat_model }) });
    check('lm settings restored to the real LM', restored.base_url === realLm.base_url, { restored, expected: realLm.base_url });
  } else {
    stubState.faultArmed = false;
  }
  const retryStartedAt = Date.now();
  await click(win, '.academy-concert-hall-retry');
  await waitForState(win, 'composing', SHORT);
  await waitForState(win, 'narrated', LONG);
  const retryDoneAt = Date.now();
  const retryLeg = await lm.leg('compose #3 (もう一度)');
  const shelfAfterRetry = await fetchJson(`${base}/api/concert-hall`);
  check('retry composed a second piece', shelfAfterRetry.pieces.length === 2, { pieces: shelfAfterRetry.pieces.map((entry) => entry.title) });

  // Exit: 奏楽堂を出る returns to the hub through the loading cover (the player is already silent).
  await click(win, '#academy-concert-hall-exit');
  check('left the concert hall', await waitFor(win, `!${CONCERT_HALL_ACTIVE}`, LONG));
  const finalProbe = await win.webContents.executeJavaScript(READ_AUDIO_PROBE);

  // The composition audit: every capture against the board, judged now that the piece's facts are known.
  for (const [key, entry] of Object.entries(captures)) {
    const expected = expectedComposition(key, facts);
    const actual = actualComposition(entry.snapshot);
    composition[key] = { launch: entry.launch, ...compareComposition(expected, actual) };
    console.log(`AUDIT ${key}: ${composition[key].match ? 'match' : `MISMATCH ${JSON.stringify(composition[key].mismatches)}`}`);
  }

  const records = lm.records();
  const between = (from, to) => records.filter((record) => { const t = Date.parse(record.completed_at); return t >= from && t <= to; });
  const summary = {
    generated_at: new Date().toISOString(),
    head,
    launch,
    viewport: VIEWPORT,
    lm: {
      mode: launch,
      real: realLm,
      unreachable,
      observation: real ? 'GET /api/debug/llm-requests (product request log, 30-entry ring, read after each leg)' : 'stub request list',
      legs: lm.legs,
      hub: { turns: hubTurns, calls: hubLeg.calls },
      compose_1: real ? composeAccounting(between(composeStartedAt, composeDoneAt + 1000), { startedAt: composeStartedAt, doneAt: composeDoneAt }) : { total_calls: composeLeg.calls, elapsed_ms: composeDoneAt - composeStartedAt },
      compose_2_failure: { calls: errorLeg.calls, error_line: errorDom.message },
      compose_3_retry: real ? composeAccounting(between(retryStartedAt, retryDoneAt + 1000), { startedAt: retryStartedAt, doneAt: retryDoneAt }) : { total_calls: retryLeg.calls, elapsed_ms: retryDoneAt - retryStartedAt },
      replay_calls: replayLeg.calls
    },
    pieces: shelfAfterRetry.pieces.map((entry) => ({ entry_id: entry.entry_id, title: entry.title, direction: entry.direction_label, composed_week: entry.composed_week })),
    piece: { entry_id: entryId, title: piece.title, direction: arrival.pieces[0].direction_label, key: piece.score.key, mode: piece.score.mode, tempo: piece.score.tempo, meter: piece.score.meter, sections: piece.score.sections.map((section) => ({ name: section.name, bars: section.bars, chords: section.chords })), tracks: piece.score.tracks.map((track) => ({ role: track.role, instrument: track.instrument, notes: track.notes.length })), note_count: noteCount },
    audio: { playing: playingProbe, after_stop: stoppedProbe, replay: replayProbe, final: finalProbe },
    captures,
    composition,
    checks,
    elapsed_ms: Date.now() - startedAt
  };
  await fs.writeFile(path.join(outDir, 'audit.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  const mismatched = Object.entries(composition).filter(([, entry]) => !entry.match).map(([key]) => key);
  log('summary', { outDir, launch, captures: Object.keys(captures).length, checks: checks.length, failed: checks.filter((entry) => !entry.pass).length, composition_mismatch: mismatched, elapsed_ms: summary.elapsed_ms });
  console.log(`CONCERT HALL RENDER: ${checks.every((entry) => entry.pass) ? 'PASS' : 'FAIL'} (${checks.length} checks, ${Object.keys(captures).length} captures, composition ${mismatched.length ? `mismatch in ${mismatched.length}` : 'all match'})`);
  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((error) => {
  console.error('HARNESS_ERROR', error?.stack ?? error);
  if (lmStub) log('lm_requests_at_failure', lmStub.requests);
  exitCode = 3;
  app.quit();
});
app.on('quit', () => {
  try { gameServer?.close(); } catch { /* ignore */ }
  try { lmStub?.server?.close(); } catch { /* ignore */ }
  if (root) fs.rm(root, { recursive: true, force: true }).catch(() => {});
  process.exit(exitCode);
});
