// 卒業の終わり（星の道）の撮影と実測。npm test の対象外で、手で回す:
//
//   ./node_modules/.bin/electron app/tests/manual/graduationRoadRender.mjs --save=<保存の game_data の親> --shots=<撮影の置き場> \
//     --flow=person|lina --line=<一言の JSON {content, expression}> [--partner=character_NNN] [--press=1] [--label=<名>]
//
// 本物のゲーム（この worktree のサーバ＋Electron・1440×900）を、保存の写し（一時の root の slot_001）で動かす。LM は決まった答えを
// 返すローカルの stub で、受けた要求を時刻つきですべて残す。卒業の会話で最後の一言（--line）を言わせ、一言が出たらすぐ会話を
// 終える釦を押す。そこから一言が残る → 暮れ（露台は沈み）→ 星の道 → 道の終わり → タイトルを、
// 場面ごとに撮り、画面に見えている字を集める。
//   --flow=person : 案内人に学院の人（--partner）を選ばせ、昼の会話（正門）で卒業する。
//   --flow=lina   : 案内人を選び、露台で卒業する。
//   --press=1     : 一言が出たあと 0.4 秒おきに画面を押し続け、押して早めたときの秒数を測る（撮影は道の終わりとタイトルだけ）。
// 出力（--shots の下）: <label>-NN-<場面>.png、<label>-report.json（区間の時刻・星の数・LM の要求・音の鳴った時刻・場面ごとの字・
// 一言のはみ出しの寸法）。保存にも repository にも書かない。一時の root は終わりに消す。
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = Object.fromEntries(process.argv.filter((a) => a.startsWith('--') && a.includes('=')).map((a) => {
  const index = a.indexOf('=');
  return [a.slice(2, index), a.slice(index + 1)];
}));
for (const key of ['save', 'shots', 'flow', 'line']) {
  if (!args[key]) throw new Error(`--${key}= is required`);
}
if (!['person', 'lina'].includes(args.flow)) throw new Error(`--flow must be person|lina: ${args.flow}`);
if (args.flow === 'person' && !/^character_\d{3}$/.test(args.partner ?? '')) throw new Error('--partner=character_NNN is required for --flow=person');
const SAVE = path.resolve(args.save);
const SHOTS = path.resolve(args.shots);
const PRESS = args.press === '1';
const LABEL = args.label ?? `${args.flow}${PRESS ? '-press' : ''}`;
const LINE = JSON.parse(await fs.readFile(path.resolve(args.line), 'utf8'));
if (typeof LINE.content !== 'string' || typeof LINE.expression !== 'string') throw new Error('--line must hold {content, expression}');
const PARTNER = args.flow === 'person' ? args.partner : 'lina';
const SELECT_INPUT = 'この一年を、あなたと締めくくりたい';
const FAREWELL_INPUT = '一年間、ありがとう';
const OPENING_TEXT = '（stub）ようこそ、文字盤へ。';

const { createServer } = await import(path.join(REPO, 'app/src/server.mjs'));
const { runtimePathsManifestFilename } = await import(path.join(REPO, 'app/src/runtimePaths.mjs'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const results = [];
function check(name, pass, detail = {}) {
  results.push({ name, pass: Boolean(pass) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`);
}

// LM の stub: 受けた要求を時刻と種類つきで残す。
function startStubLm() {
  const requests = [];
  let farewellAnswered = false;
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* model probe */ }
    const prompt = body.messages?.[0]?.content ?? '';
    const whole = (body.messages ?? []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    const schemaName = body.response_format?.json_schema?.name ?? '';
    let kind;
    let content;
    if (schemaName === 'character_emotion_choice') { kind = 'emotion'; content = JSON.stringify({ expression: LINE.expression }); }
    else if (schemaName === 'work_record_recall_choice') { kind = 'work_record_recall'; content = JSON.stringify({ work_record_ids: [] }); }
    else if (prompt.includes('この発言を行ったプレイヤーとの会話を継続したいと思うか')) { kind = 'continuation'; content = 'true'; }
    else if (prompt.includes('好感度の変化量を判定する')) { kind = 'affinity'; content = '0'; }
    else if (prompt.includes('MP温存ライン')) { kind = 'mp_reserve'; content = '30'; }
    else if (prompt.includes('所持金判定')) { kind = 'money'; content = '0'; }
    else if (prompt.includes('場所移動の合意')) { kind = 'stage_move'; content = 'false'; }
    else if (prompt.includes('location_idを1つだけ返す')) { kind = 'location'; content = 'none'; }
    else if (prompt.includes('締めくくりを誰と過ごすと選んだか')) { kind = 'graduation_partner'; content = PARTNER; }
    else if (prompt.includes('ルーティングハブ会話内容') && prompt.includes('destination_id')) { kind = 'routing_destination'; content = 'none'; }
    else if (whole.includes(`プレイヤーの発言: ${FAREWELL_INPUT}`) && !farewellAnswered) { kind = 'reply(last line)'; content = LINE.content; farewellAnswered = true; }
    else { kind = `other:${prompt.replace(/\s+/g, ' ').slice(0, 40)}`; content = OPENING_TEXT; }
    requests.push({ at: Date.now(), kind, schema: schemaName });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1`
  })));
}

async function isolatedRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'graduation-road-build-'));
  const manifestFor = (mutableRoot) => ({
    configRoot: path.join(root, 'app/config'),
    definitionsRoot: path.join(REPO, 'data/definitions/game_data'),
    seedsRoot: path.join(REPO, 'data/seeds/game_data'),
    mutableRoot,
    characterContentRoot: path.join(REPO, 'content/characters'),
    creatureContentRoot: path.join(REPO, 'content/creatures'),
    canonicalAssetsRoot: path.join(REPO, 'assets/canonical'),
    publicRoot: path.join(REPO, 'app/public'),
    resourceRoot: REPO
  });
  await fs.mkdir(path.join(root, 'app/config'), { recursive: true });
  await fs.writeFile(path.join(root, runtimePathsManifestFilename), `${JSON.stringify(manifestFor(path.join(root, 'data/mutable/game_data')), null, 2)}\n`);
  const slotRoot = path.join(root, 'data/mutable/game_data/play/slots/slot_001');
  await fs.cp(SAVE, slotRoot, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  await fs.writeFile(path.join(slotRoot, runtimePathsManifestFilename), `${JSON.stringify(manifestFor(path.join(slotRoot, 'game_data')), null, 2)}\n`);
  await fs.writeFile(path.join(root, 'data/mutable/game_data/play/active_slot.json'), `${JSON.stringify({ slot_id: 'slot_001', activated_at: new Date().toISOString(), label: 'slot 001' }, null, 2)}\n`);
  const meta = JSON.parse(await fs.readFile(path.join(SAVE, 'meta.json'), 'utf8'));
  const settingsPath = path.join(root, 'app/config/play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: meta.routing_persona_variant }, null, 2)}\n`);
  return { root, settingsPath };
}

const js = (win, expr) => win.webContents.executeJavaScript(expr);
// 頁の中の失敗（console.error）は待ちを止めて落とす（失敗のあとを待ち続けない）。
const rendererErrors = [];
async function waitFor(win, predicate, { tries = 300, intervalMs = 100 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    if (rendererErrors.length) throw new Error(`renderer error: ${rendererErrors[0]}`);
    const ok = await js(win, `(() => { try { return !!(${predicate}); } catch (e) { return false; } })()`);
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}

let shotIndex = 0;
const scenes = [];
async function shoot(win, scene) {
  shotIndex += 1;
  const name = `${LABEL}-${String(shotIndex).padStart(2, '0')}-${scene}.png`;
  win.webContents.invalidate();
  await sleep(120);
  const captured = await win.webContents.capturePage();
  const image = captured.getSize().width === 1440 ? captured : captured.resize({ width: 1440, height: 900, quality: 'best' });
  const size = image.getSize();
  if (size.width !== 1440 || size.height !== 900) throw new Error(`shot ${name} is ${size.width}x${size.height}`);
  await fs.writeFile(path.join(SHOTS, name), image.toPNG());
  const texts = await visibleText(win);
  scenes.push({ shot: name, at: Date.now(), texts });
  console.log(`screenshot: ${name} texts=${JSON.stringify(texts)}`);
}

// 画面に見えている字: 画面内にあり、不透明度 0・非表示の祖先を持たない text node。星の道の層（#journey）が満ちている（不透明度
// 0.99 以上で場面が卒業）あいだは、層の下の製品の画面は覆われて見えないので層の中だけを数える。
function visibleText(win) {
  return js(win, `(() => {
    const layer = document.querySelector('#journey');
    const layerOpacity = Number(getComputedStyle(layer).opacity);
    const covered = layer.dataset.scene === 'graduation' && layerOpacity >= 0.99;
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.textContent.replace(/\\s+/g, ' ').trim();
      if (!text) continue;
      const el = node.parentElement;
      if (!el || el.closest('script,style,template,noscript,svg')) continue;
      if (covered && !layer.contains(el)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight);
      if (!rects.length) continue;
      let visible = true;
      for (let e = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.02) { visible = false; break; }
      }
      if (visible) out.push(text);
    }
    return out;
  })()`);
}

// 一言の箱が画面の内に収まり、行が箱からはみ出さないか（一言が残る場面と道の終わり）。
function lineFit(win, { boxSel, rowSel }) {
  return js(win, `(() => {
    const box = document.querySelector(${JSON.stringify(boxSel)});
    if (!box) return { missing: ${JSON.stringify(boxSel)} };
    const r = box.getBoundingClientRect();
    const b = [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)];
    const rows = [...document.querySelectorAll(${JSON.stringify(rowSel)})].filter((el) => getComputedStyle(el).display !== 'none').flatMap((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return [...range.getClientRects()].filter((x) => x.width > 0 && x.height > 0);
    }).map((x) => [Math.round(x.left), Math.round(x.top), Math.round(x.right), Math.round(x.bottom)]);
    const inside = (q) => q[0] >= 0 && q[1] >= 0 && q[2] <= innerWidth && q[3] <= innerHeight;
    return { viewport: [innerWidth, innerHeight], box: b, rowCount: new Set(rows.map((q) => q[1])).size,
      rowsTop: Math.min(...rows.map((q) => q[1])), rowsBottom: Math.max(...rows.map((q) => q[3])),
      allInsideScreen: inside(b) && rows.every(inside), rowsInsideBox: rows.every((q) => q[0] >= b[0] - 1 && q[1] >= b[1] - 1 && q[2] <= b[2] + 1 && q[3] <= b[3] + 1) };
  })()`);
}

// 音の計り: 製品の AudioBufferSourceNode の start と、どの音源（URL）を鳴らしたかを、時刻つきで残す。
const INSTRUMENT_AUDIO = `(() => {
  if (window.__graduationAudio) return true;
  const log = [];
  window.__graduationAudio = log;
  const urlOfArrayBuffer = new WeakMap();
  const urlOfAudioBuffer = new WeakMap();
  const originalFetch = window.fetch;
  window.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    const url = typeof input === 'string' ? input : input.url;
    if (!/\\.ogg$/.test(url)) return response;
    const originalArrayBuffer = response.arrayBuffer.bind(response);
    response.arrayBuffer = async () => { const ab = await originalArrayBuffer(); urlOfArrayBuffer.set(ab, url); return ab; };
    return response;
  };
  const decode = AudioContext.prototype.decodeAudioData;
  AudioContext.prototype.decodeAudioData = function (ab, ...rest) {
    const url = urlOfArrayBuffer.get(ab);
    return decode.call(this, ab, ...rest).then((buffer) => { if (url) urlOfAudioBuffer.set(buffer, url); return buffer; });
  };
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...rest) {
    log.push({ at: Date.now(), url: urlOfAudioBuffer.get(this.buffer) ?? null, loop: this.loop, rate: Number(this.playbackRate.value.toFixed(4)) });
    return start.apply(this, rest);
  };
  // 星が灯った時刻（星の道の場面の data-lit-count が増えるたび）と、場面の印の時刻。
  const marks = [];
  window.__graduationMarks = marks;
  const panel = document.querySelector('.journey-graduation');
  new MutationObserver(() => marks.push({ at: Date.now(), mark: 'lit', count: Number(panel.dataset.litCount ?? 0), roadEnd: panel.dataset.roadEnd === 'true' }))
    .observe(panel, { attributes: true, attributeFilter: ['data-lit-count', 'data-road-end'] });
  new MutationObserver(() => { if (panel.dataset.ending === 'running') marks.push({ at: Date.now(), mark: 'finalization-start' }); })
    .observe(panel, { attributes: true, attributeFilter: ['data-ending'] });
  for (const sel of ['#conversation-day-screen', '#routing-hub-screen']) {
    const el = document.querySelector(sel);
    new MutationObserver(() => marks.push({ at: Date.now(), mark: 'phase', screen: sel, phase: el.dataset.graduationRoad ?? null }))
      .observe(el, { attributes: true, attributeFilter: ['data-graduation-road'] });
  }
  new MutationObserver(() => { if (document.querySelector('#title-screen').classList.contains('active')) marks.push({ at: Date.now(), mark: 'title' }); })
    .observe(document.querySelector('#title-screen'), { attributes: true, attributeFilter: ['class'] });
  return true;
})()`;

async function send(win, inputSel, sendSel, text, lm) {
  await waitFor(win, `document.querySelector(${JSON.stringify(sendSel)}) && !document.querySelector(${JSON.stringify(sendSel)}).disabled`, { tries: 300 });
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const before = lm.requests.length;
    const fired = await js(win, `(() => {
      const el = document.querySelector(${JSON.stringify(inputSel)});
      const send = document.querySelector(${JSON.stringify(sendSel)});
      if (!el || !send || send.disabled) return false;
      el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      send.click();
      return true;
    })()`);
    for (let i = 0; i < 50 && fired; i += 1) {
      if (lm.requests.length > before) return;
      await sleep(100);
    }
    await sleep(1500);
  }
  throw new Error(`could not send on ${sendSel}`);
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
let server;
let lm;
let fixture;
let exitCode = 0;

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  lm = await startStubLm();
  fixture = await isolatedRoot();
  server = createServer({
    root: fixture.root,
    publicRoot: path.join(REPO, 'app/public'),
    canonicalAssetsRoot: path.join(REPO, 'assets/canonical'),
    playModeSettingsPath: fixture.settingsPath,
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 30000, stream: false }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  await app.whenReady();
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level < 3) return;
    console.log(`renderer-error: ${message}`);
    rendererErrors.push(message);
  });

  await win.loadURL(`${base}/`);
  check('TITLE', await waitFor(win, `document.querySelector('#title-screen')?.classList.contains('active')`, { tries: 200 }));
  await sleep(1500);
  await js(win, `document.querySelector('.screen-tabs button[data-screen="slot-load"]')?.click(); true`);
  await waitFor(win, `document.querySelector('#slot-load-list .slot-load-item .academy-map-action-button.primary:not([disabled])')`);
  await js(win, `document.querySelector('#slot-load-list .slot-load-item .academy-map-action-button.primary:not([disabled])')?.click(); true`);
  const onHub = await waitFor(win, `document.querySelector('#routing-hub-screen')?.classList.contains('active') && !document.querySelector('#routing-hub-send')?.disabled
    && (document.querySelector('#routing-hub-message-stream')?.textContent || '').trim().length > 0`, { tries: 400, intervalMs: 120 });
  check('HUB at 第50週', onHub && await waitFor(win, `(document.querySelector('#routing-hub-week')?.textContent || '').includes('第50週')`, { tries: 20 }));
  await sleep(800);
  await js(win, INSTRUMENT_AUDIO);

  await send(win, '#routing-hub-input', '#routing-hub-send', SELECT_INPUT, lm);
  let inputSel;
  let sendSel;
  let streamSel;
  if (args.flow === 'person') {
    check('PERSON graduation conversation on the daytime screen', await waitFor(win, `document.querySelector('#conversation-day-screen')?.classList.contains('active')
      && (document.querySelector('#conversation-day-message-stream')?.textContent || '').trim().length > 0`, { tries: 600 }));
    [inputSel, sendSel, streamSel] = ['#conversation-day-input', '#conversation-day-send', '#conversation-day-message-stream'];
  } else {
    await waitFor(win, `document.querySelector('#routing-hub-screen')?.hasAttribute('data-graduation') && !document.querySelector('#routing-hub-send')?.disabled`, { tries: 300 });
    [inputSel, sendSel, streamSel] = ['#routing-hub-input', '#routing-hub-send', '#routing-hub-message-stream'];
  }
  await sleep(1200);
  // 最後の一言: 製品が一言を出しきった時刻を「一言が出た」時刻にする。
  const probe = LINE.content.replace(/（[^（）]+）|\([^()]+\)/g, '').replace(/\s+/g, '').slice(0, 12);
  await send(win, inputSel, sendSel, FAREWELL_INPUT, lm);
  const shown = await waitFor(win, `(document.querySelector(${JSON.stringify(streamSel)})?.textContent || '').replace(/\\s+/g, '').includes(${JSON.stringify(probe)})`, { tries: 600, intervalMs: 50 });
  const lineShownAt = Date.now();
  check('the last line is shown as the partner reply', shown, { probe, chars: LINE.content.length });

  const endSel = args.flow === 'person' ? '#conversation-day-end' : '#routing-hub-end';
  await waitFor(win, `!document.querySelector(${JSON.stringify(endSel)})?.disabled`, { tries: 200, intervalMs: 50 });
  await js(win, `document.querySelector(${JSON.stringify(endSel)}).click(); true`);
  const pressTimer = PRESS ? setInterval(() => { js(win, `document.elementFromPoint(720, 450)?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); true`).catch(() => {}); }, 400) : null;
  const screenSel = args.flow === 'person' ? '#conversation-day-screen' : '#routing-hub-screen';
  check('the last-line scene begins on the end press', await waitFor(win, `document.querySelector(${JSON.stringify(screenSel)})?.dataset.graduationRoad === 'last-line'`, { tries: 300 }));
  const fits = {};
  if (!PRESS) {
    await sleep(1500);
    fits.lastLine = await lineFit(win, {
      boxSel: `${streamSel}`,
      rowSel: `${streamSel} > .player-message:not(:has(~ .player-message)) ~ .character-message .message-bubble, ${streamSel} > .player-message:not(:has(~ .player-message)) ~ .character-message .message-content`
    });
    await shoot(win, 'last-line');
    await waitFor(win, `document.querySelector(${JSON.stringify(screenSel)})?.dataset.graduationRoad === 'dusk'`, { tries: 400, intervalMs: 20 });
    // 暮れの始まりからの時刻で撮る（暮れ 8 秒の 1/4・1/2・3/4・満ちる途中、沈み 6.5 秒の半ば・満ちる途中）。撮る口は呼んでから
    // 1 秒ほど遅れて写すので、その分を前へ寄せる。
    const duskStartedAt = Date.now();
    const duskSteps = args.flow === 'person' ? [[1000, 'dusk-1'], [3000, 'dusk-2'], [5000, 'dusk-3'], [6000, 'dusk-4']] : [[2200, 'sink-1'], [3900, 'sink-2']];
    for (const [offset, scene] of duskSteps) {
      await sleep(Math.max(0, duskStartedAt + offset - Date.now()));
      await shoot(win, scene);
    }
    for (let count = 1; count <= 10; count += 1) {
      const lit = await waitFor(win, `Number(document.querySelector('.journey-graduation')?.dataset.litCount ?? 0) >= ${count} || document.querySelector('.journey-graduation')?.dataset.roadEnd === 'true'`, { tries: 300 });
      if (!lit || await js(win, `document.querySelector('.journey-graduation')?.dataset.roadEnd === 'true'`)) break;
      await sleep(1600);
      await shoot(win, `star-${count}`);
    }
  }
  check('the road end is reached', await waitFor(win, `document.querySelector('.journey-graduation')?.dataset.roadEnd === 'true'`, { tries: 1200 }));
  if (!PRESS) {
    await sleep(3000);
    fits.roadEnd = await lineFit(win, { boxSel: '.journey-graduation-partner-line', rowSel: '.journey-graduation-partner-line p' });
  }
  await shoot(win, 'road-end');
  check('back at the title', await waitFor(win, `document.querySelector('#title-screen')?.classList.contains('active')`, { tries: 1200 }));
  const titleAt = Date.now();
  if (pressTimer) clearInterval(pressTimer);
  await sleep(1800);
  await shoot(win, 'title');
  const state = await js(win, `fetch('/api/state').then((r) => r.json()).then((s) => ({ ending_completed: s.ending_completed ?? null, elapsed_weeks: s.elapsed_weeks }))`);
  check('the graduation is completed', state.ending_completed === true, state);

  const audio = await js(win, 'window.__graduationAudio');
  const marks = await js(win, 'window.__graduationMarks');
  const road = await js(win, `document.querySelectorAll('.journey-graduation-star').length`);
  const finalizationStartedAt = marks.find((m) => m.mark === 'finalization-start')?.at;
  if (!finalizationStartedAt) throw new Error('the finalization start was not observed');
  const report = {
    label: LABEL,
    flow: args.flow,
    save: path.basename(SAVE),
    partner: PARTNER,
    line_chars: LINE.content.length,
    line_shown_at: lineShownAt,
    title_at: titleAt,
    seconds_line_to_title: Number(((titleAt - lineShownAt) / 1000).toFixed(1)),
    stars_left_after_clear: road,
    lit_count: Math.max(0, ...marks.filter((m) => m.mark === 'lit').map((m) => m.count)),
    marks: marks.map((m) => ({ ...m, t: Number(((m.at - lineShownAt) / 1000).toFixed(2)) })),
    audio: audio.map((a) => ({ ...a, t: Number(((a.at - lineShownAt) / 1000).toFixed(2)) })),
    // 一言が出てからタイトルまでの LM の要求を、道のあいだ（一言 → 締めの始まり）と締め（締めの始まり → タイトル）に分ける。
    finalization_started_at: finalizationStartedAt,
    lm_road: lm.requests.filter((r) => r.at >= lineShownAt && r.at < finalizationStartedAt).map((r) => ({ t: Number(((r.at - lineShownAt) / 1000).toFixed(2)), kind: r.kind })),
    lm_finalization: lm.requests.filter((r) => r.at >= finalizationStartedAt && r.at <= titleAt).map((r) => ({ t: Number(((r.at - lineShownAt) / 1000).toFixed(2)), kind: r.kind })),
    lm_total: lm.requests.length,
    fits,
    scenes: scenes.map((s) => ({ ...s, t: Number(((s.at - lineShownAt) / 1000).toFixed(2)) }))
  };
  await fs.writeFile(path.join(SHOTS, `${LABEL}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report: ${LABEL}-report.json seconds_line_to_title=${report.seconds_line_to_title} lit=${report.lit_count} lm_road=${report.lm_road.length} lm_finalization=${report.lm_finalization.length}`);
}

app.on('window-all-closed', () => {});
main().catch((error) => {
  console.log(`ERROR ${error?.stack ?? error}`);
  exitCode = 1;
}).finally(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (lm) await new Promise((r) => lm.server.close(r));
  if (fixture) await fs.rm(fixture.root, { recursive: true, force: true });
  const failed = results.filter((r) => !r.pass).length;
  console.log(`RESULT ${results.length - failed}/${results.length} pass, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  app.exit(failed || exitCode ? 1 : 0);
});
