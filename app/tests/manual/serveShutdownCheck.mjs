// One-off check of the stop path: SIGTERM/SIGINT on the browser runtime, quitting the desktop app, and a
// SIGKILL in the middle of a JSON write. This file is intentionally NOT named *.test.mjs, so `npm test`
// skips it; run it by hand from the repo root:
//
//   SHUTDOWN_CHECK_SOURCE_SLOT=<absolute path to a save slot dir> node app/tests/manual/serveShutdownCheck.mjs [sigterm|browser|desktop|sigkill]
//
// No argument runs all four. The source slot is only read: every check copies it into a fresh temp root,
// repoints the copy's runtime-paths manifest inside that root, and finally proves the source play root's
// files (size + mtime) are unchanged. `browser` and `desktop` need `node_modules/.bin/electron`; `desktop`
// launches the real electron/main.mjs (a window and detached DevTools appear briefly) and needs the fixed
// desktop port 41731 to be free.
//
//   sigterm — 30 rounds of: boot the runtime server as its own process group, prove the save still reads
//             (listed + load 200), then SIGTERM the group while `/api/slots/load` is hammered, while a
//             `/api/save` is copying, or while a staged routing finalization runs; scan for 0-byte/broken
//             JSON, slot-copy remnants, finalize staging remnants and temp files.
//   browser — SIGTERM while a real Electron page is open on the server (keep-alive sockets counted).
//   desktop — quit the desktop app (SIGTERM to Electron's main process) mid-`/api/save`, then reopen it and
//             load the saved slot.
//   sigkill — SIGKILL a process looping storage.writeJson over one file; the file must hold the old or the
//             new bytes. The same loop with a plain fs.writeFile runs as the negative control.
import { fork, spawn, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { ensureElectronRuntimeWorkspace } from '../../src/electron/runtimeWorkspace.mjs';
import { resolveSlotProjectRoot } from '../../src/playSession.mjs';
import { writeRuntimePathsManifest } from '../../src/runtimeSlotBootstrap.mjs';
import { runAtomicFinalizationWithStaging } from '../../src/routingFinalizeQueue.mjs';
import { shutdownServerOnSignals, startServer } from '../../src/server.mjs';
import { createStorageApi } from '../../src/storage.mjs';

const toolPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(toolPath), '../../..');
const electronBin = path.join(repoRoot, 'node_modules/.bin/electron');
const DESKTOP_PORT = 41731;
const SIGTERM_TRIALS = 30;
const SIGKILL_TRIALS = 40;
const EXIT_TIMEOUT_MS = 60_000;
const FINALIZE_STEPS = 10;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min, max) => Math.round(min + Math.random() * (max - min));
const log = (line) => console.log(line);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function childEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TEAM_')));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function listFiles(root) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(full);
    }
  }
  await walk(root);
  return files;
}

async function snapshotTree(root) {
  const snapshot = new Map();
  for (const file of await listFiles(root)) {
    const stat = await fs.lstat(file);
    snapshot.set(path.relative(root, file), `${stat.size}:${stat.mtimeMs}`);
  }
  return snapshot;
}

function diffSnapshots(before, after) {
  const changed = [];
  for (const [file, stamp] of before) if (after.get(file) !== stamp) changed.push(file);
  for (const file of after.keys()) if (!before.has(file)) changed.push(file);
  return changed;
}

async function prepareWorkspace(userDataRoot, sourceSlot) {
  const workspace = await ensureElectronRuntimeWorkspace({ resourceRoot: repoRoot, userDataRoot });
  const slotId = path.basename(sourceSlot);
  const slotRoot = resolveSlotProjectRoot(workspace.projectRoot, slotId);
  await fs.cp(sourceSlot, slotRoot, { recursive: true, verbatimSymlinks: true });
  // The copied slot's manifest names the source tree's absolute roots; repoint it inside the temp root so
  // no write can reach the source.
  await writeRuntimePathsManifest({ root: slotRoot, sourceRoot: workspace.projectRoot, mutableRoot: path.join(slotRoot, 'game_data') });
  return { workspace, slotId, playRoot: path.join(workspace.mutableRoot, 'play') };
}

async function scanPlayRoot(playRoot) {
  const brokenJson = [];
  const tempFiles = [];
  for (const file of await listFiles(playRoot)) {
    if (file.endsWith('.tmp')) tempFiles.push(file);
    if (!file.endsWith('.json')) continue;
    const text = await fs.readFile(file, 'utf8');
    try {
      if (text.length === 0) throw new Error('empty');
      JSON.parse(text);
    } catch {
      brokenJson.push(`${path.relative(playRoot, file)} (len=${text.length})`);
    }
  }
  const slotRemnants = [];
  for (const slot of await fs.readdir(path.join(playRoot, 'slots'))) {
    const slotRoot = path.join(playRoot, 'slots', slot);
    for (const required of ['meta.json', 'game_data/runtime_state.json']) {
      if (!(await fs.access(path.join(slotRoot, required)).then(() => true, () => false))) slotRemnants.push(`${slot} missing ${required}`);
    }
  }
  const stagingRemnants = (await listFiles(path.join(playRoot, 'finalize_staging'))).map((file) => path.relative(playRoot, file));
  return { brokenJson, tempFiles, slotRemnants, stagingRemnants };
}

async function postJson(base, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.text() };
}

async function checkReadable(base, expectedSlots, newSlots, slotId) {
  const listed = await (await fetch(`${base}/api/save-slots`)).json();
  const listedIds = listed.slots.map((slot) => (typeof slot === 'string' ? slot : slot.slot_id));
  const missing = [...expectedSlots].filter((id) => !listedIds.includes(id));
  const loads = [];
  for (const id of [...newSlots, slotId]) {
    const loaded = await postJson(base, '/api/slots/load', { slot_id: id });
    loads.push(`${id}:${loaded.status}`);
  }
  newSlots.clear();
  const ok = missing.length === 0 && loads.every((entry) => entry.endsWith(':200'));
  return { ok, listedCount: listedIds.length, missing, loads };
}

function watchChild(child) {
  const lines = [];
  const messageWaiters = [];
  const collect = (chunk) => lines.push(...String(chunk).split('\n').filter(Boolean));
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('message', (message) => {
    for (const waiter of messageWaiters.splice(0)) waiter(message);
  });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal, at: performance.now() }));
  });
  return {
    lines,
    exited,
    nextMessage: () => new Promise((resolve) => messageWaiters.push(resolve))
  };
}

async function waitForExit(label, watched, pid) {
  const timeout = sleep(EXIT_TIMEOUT_MS).then(() => null);
  const exit = await Promise.race([watched.exited, timeout]);
  if (exit) return exit;
  process.kill(-pid, 'SIGKILL');
  throw new Error(`${label} did not exit within ${EXIT_TIMEOUT_MS}ms:\n${watched.lines.join('\n')}`);
}

async function startServerChild(userDataRoot) {
  const child = fork(toolPath, ['serve', userDataRoot], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: childEnv()
  });
  const watched = watchChild(child);
  const listening = await Promise.race([
    watched.nextMessage(),
    watched.exited.then(() => {
      throw new Error(`server child exited before listening:\n${watched.lines.join('\n')}`);
    })
  ]);
  return { child, pid: child.pid, base: `http://127.0.0.1:${listening.port}`, port: listening.port, ...watched };
}

function startAction(kind, server, trial) {
  if (kind === 'load') {
    let stop = false;
    const counts = { ok: 0, refused503: 0, other: 0, errors: 0 };
    const loops = Array.from({ length: 4 }, async () => {
      while (!stop) {
        try {
          const loaded = await postJson(server.base, '/api/slots/load', { slot_id: server.slotId });
          if (loaded.status === 200) counts.ok += 1;
          else if (loaded.status === 503) counts.refused503 += 1;
          else counts.other += 1;
        } catch {
          counts.errors += 1;
          await sleep(5);
        }
      }
    });
    return {
      sigtermAfterMs: randomBetween(100, 900),
      settle: async () => {
        stop = true;
        await Promise.all(loops);
        return `loads ok=${counts.ok} 503=${counts.refused503} other=${counts.other} conn_errors=${counts.errors}`;
      }
    };
  }
  if (kind === 'save') {
    const saveId = `slot_9${String(trial).padStart(2, '0')}`;
    const startedAt = performance.now();
    const saving = postJson(server.base, '/api/save', { slot_id: saveId }).then(
      (result) => ({ ...result, at: performance.now() }),
      (error) => ({ status: `error ${error.cause?.code ?? error.message}`, body: '', at: performance.now() })
    );
    return {
      saveId,
      sigtermAfterMs: randomBetween(100, 900),
      settle: async () => {
        const saved = await saving;
        return { saveId, status: saved.status, body: saved.body, seconds: (saved.at - startedAt) / 1000 };
      }
    };
  }
  const conversationId = `conv_shutdowncheck_${String(trial).padStart(2, '0')}`;
  server.child.send({ type: 'finalize', conversationId });
  return { conversationId, sigtermAfterMs: randomBetween(200, 3000), settle: async () => ({ conversationId }) };
}

async function readFinalizeMarker(playRoot, slotId) {
  const state = JSON.parse(await fs.readFile(path.join(playRoot, 'slots', slotId, 'game_data/runtime_state.json'), 'utf8'));
  return state.shutdown_check_finalize ?? null;
}

async function sigtermCheck(sourceSlot) {
  log('== sigterm: SIGTERM to the runtime server process group, 30 rounds');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'serve-shutdown-check-'));
  const userDataRoot = path.join(tmp, 'ud');
  const { playRoot, slotId } = await prepareWorkspace(userDataRoot, sourceSlot);
  const expectedSlots = new Set([slotId]);
  const newSlots = new Set();
  const exitSeconds = [];
  const totals = { brokenJson: 0, slotRemnants: 0, stagingRemnants: 0, tempFiles: 0, unreadable: 0, saveNot200: 0, finalizeNotPromoted: 0, exitNot0: 0 };
  try {
    for (let trial = 1; trial <= SIGTERM_TRIALS; trial += 1) {
      const kind = ['load', 'save', 'finalize'][(trial - 1) % 3];
      const server = await startServerChild(userDataRoot);
      server.slotId = slotId;
      const readable = await checkReadable(server.base, expectedSlots, newSlots, slotId);
      if (!readable.ok) totals.unreadable += 1;
      const action = startAction(kind, server, trial);
      await sleep(action.sigtermAfterMs);
      const sentAt = performance.now();
      process.kill(-server.pid, 'SIGTERM');
      const exit = await waitForExit('server', server, server.pid);
      const seconds = (exit.at - sentAt) / 1000;
      exitSeconds.push(seconds);
      if (exit.code !== 0) totals.exitNot0 += 1;
      const outcome = await action.settle();
      let detail;
      if (kind === 'save') {
        if (outcome.status === 200) {
          expectedSlots.add(outcome.saveId);
          newSlots.add(outcome.saveId);
        } else {
          totals.saveNot200 += 1;
        }
        detail = `save ${outcome.saveId} -> ${outcome.status} after ${outcome.seconds.toFixed(3)}s`;
      } else if (kind === 'finalize') {
        const marker = await readFinalizeMarker(playRoot, slotId);
        const promoted = marker?.conversation_id === outcome.conversationId && marker?.step === FINALIZE_STEPS;
        if (!promoted) totals.finalizeNotPromoted += 1;
        detail = `finalize ${outcome.conversationId} promoted=${promoted}`;
      } else {
        detail = outcome;
      }
      const scan = await scanPlayRoot(playRoot);
      totals.brokenJson += scan.brokenJson.length;
      totals.slotRemnants += scan.slotRemnants.length;
      totals.stagingRemnants += scan.stagingRemnants.length;
      totals.tempFiles += scan.tempFiles.length;
      const stoppedLine = server.lines.find((line) => line.includes('runtime stopped after')) ?? '(no stop line)';
      log(`trial ${String(trial).padStart(2)} ${kind.padEnd(8)} sigterm@+${action.sigtermAfterMs}ms exit=${exit.code ?? exit.signal} in ${seconds.toFixed(3)}s | ${detail} | pre-boot readable=${readable.ok} [${readable.loads.join(' ')}] | broken=${scan.brokenJson.length} slot_remnants=${scan.slotRemnants.length} staging=${scan.stagingRemnants.length} tmp=${scan.tempFiles.length} | ${stoppedLine}`);
      for (const item of [...scan.brokenJson, ...scan.slotRemnants, ...scan.stagingRemnants, ...scan.tempFiles]) log(`    ! ${item}`);
      if (!readable.ok) log(`    ! unreadable: missing=${JSON.stringify(readable.missing)} loads=${readable.loads.join(' ')}`);
    }
    const server = await startServerChild(userDataRoot);
    const finalReadable = await checkReadable(server.base, expectedSlots, newSlots, slotId);
    if (!finalReadable.ok) totals.unreadable += 1;
    process.kill(-server.pid, 'SIGTERM');
    await waitForExit('server', server, server.pid);
    log(`final boot: listed=${finalReadable.listedCount} expected=${expectedSlots.size} missing=${JSON.stringify(finalReadable.missing)} loads=[${finalReadable.loads.join(' ')}]`);
    log(`sigterm summary: trials=${SIGTERM_TRIALS} broken_json=${totals.brokenJson} slot_remnants=${totals.slotRemnants} staging_remnants=${totals.stagingRemnants} tmp_files=${totals.tempFiles} unreadable_boots=${totals.unreadable} save_not_200=${totals.saveNot200} finalize_not_promoted=${totals.finalizeNotPromoted} exit_not_0=${totals.exitNot0}`);
    log(`sigterm exit seconds: max=${Math.max(...exitSeconds).toFixed(3)} median=${median(exitSeconds).toFixed(3)} min=${Math.min(...exitSeconds).toFixed(3)}`);
    const clean = Object.values(totals).every((count) => count === 0);
    log(`sigterm result: ${clean ? 'PASS' : 'FAIL'}`);
    return clean;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

function establishedServerSockets(port, pid) {
  let output = '';
  try {
    output = execFileSync('lsof', ['-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:ESTABLISHED'], { encoding: 'utf8' });
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  return output.split('\n').filter((line) => line.includes('ESTABLISHED')).length;
}

function spawnElectron(args, extraOptions = {}) {
  const child = spawn(electronBin, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(), ...extraOptions });
  return { child, pid: child.pid, ...watchChild(child) };
}

async function waitForLine(watched, pattern, label) {
  for (let waited = 0; waited < EXIT_TIMEOUT_MS; waited += 100) {
    const line = watched.lines.find((candidate) => pattern.test(candidate));
    if (line) return line;
    await sleep(100);
  }
  throw new Error(`${label}: no line matching ${pattern}:\n${watched.lines.join('\n')}`);
}

async function browserCheck(sourceSlot) {
  log('== browser: SIGTERM while an Electron page is open on the server');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'serve-shutdown-check-'));
  const userDataRoot = path.join(tmp, 'ud');
  const { slotId } = await prepareWorkspace(userDataRoot, sourceSlot);
  let page = null;
  try {
    const server = await startServerChild(userDataRoot);
    const readable = await checkReadable(server.base, new Set([slotId]), new Set(), slotId);
    page = spawnElectron([toolPath, 'page', `${server.base}/`, `--user-data-dir=${path.join(tmp, 'page-ud')}`]);
    const loadedLine = await waitForLine(page, /^page-loaded/, 'page');
    await sleep(3000);
    const sockets = establishedServerSockets(server.port, server.pid);
    const sentAt = performance.now();
    process.kill(-server.pid, 'SIGTERM');
    const exit = await waitForExit('server', server, server.pid);
    const seconds = (exit.at - sentAt) / 1000;
    const pageAlive = page.child.exitCode === null && page.child.signalCode === null;
    log(`readable before: ${readable.ok} [${readable.loads.join(' ')}]`);
    log(`${loadedLine}`);
    log(`server-side ESTABLISHED sockets with the page open: ${sockets}`);
    log(`page process alive when SIGTERM was sent and after server exit: ${pageAlive}`);
    log(`server exit=${exit.code ?? exit.signal} in ${seconds.toFixed(3)}s | ${server.lines.filter((line) => /SIGTERM|stopped after/.test(line)).join(' | ')}`);
    const ok = exit.code === 0 && seconds < 10 && sockets > 0 && pageAlive;
    log(`browser result: ${ok ? 'PASS' : 'FAIL'}`);
    return ok;
  } finally {
    if (page && page.child.exitCode === null && page.child.signalCode === null) {
      process.kill(-page.pid, 'SIGTERM');
      await waitForExit('page', page, page.pid);
    }
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function assertPortFree(port) {
  const inUse = await new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
  if (inUse) throw new Error(`port ${port} is in use (a desktop app is probably running); close it before the desktop check`);
}

async function waitForHttp(base) {
  for (let waited = 0; waited < EXIT_TIMEOUT_MS; waited += 200) {
    try {
      if ((await fetch(`${base}/`)).status === 200) return;
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  throw new Error(`${base} did not answer within ${EXIT_TIMEOUT_MS}ms`);
}

async function desktopCheck(sourceSlot) {
  log('== desktop: quit the real electron/main.mjs during /api/save, then reopen it');
  await assertPortFree(DESKTOP_PORT);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'serve-shutdown-check-'));
  const userDataArg = path.join(tmp, 'eud');
  // An unpackaged launch appends `-dev` to userData (resolveElectronUserDataRoot).
  const { playRoot, slotId } = await prepareWorkspace(`${userDataArg}-dev`, sourceSlot);
  const base = `http://127.0.0.1:${DESKTOP_PORT}`;
  const saveId = 'slot_960';
  const launch = () => spawnElectron([repoRoot, `--user-data-dir=${userDataArg}`], { cwd: repoRoot });
  let running = null;
  try {
    running = launch();
    await waitForHttp(base);
    const readable = await checkReadable(base, new Set([slotId]), new Set(), slotId);
    const saveStartedAt = performance.now();
    const saving = postJson(base, '/api/save', { slot_id: saveId }).then(
      (result) => ({ ...result, at: performance.now() }),
      (error) => ({ status: `error ${error.cause?.code ?? error.message}`, body: '', at: performance.now() })
    );
    await sleep(300);
    const quitAt = performance.now();
    process.kill(running.pid, 'SIGTERM');
    const exit = await waitForExit('electron', running, running.pid);
    const saved = await saving;
    const quitLine = running.lines.find((line) => line.includes('quitting; finishing')) ?? '(no quit line)';
    log(`readable before: ${readable.ok} [${readable.loads.join(' ')}]`);
    log(`save ${saveId} requested at +0.000s, quit (SIGTERM to Electron main) at +${((quitAt - saveStartedAt) / 1000).toFixed(3)}s`);
    log(`save response ${saved.status} at +${((saved.at - saveStartedAt) / 1000).toFixed(3)}s; Electron exit=${exit.code ?? exit.signal} at +${((exit.at - saveStartedAt) / 1000).toFixed(3)}s`);
    log(`electron log: ${quitLine}`);
    const scan = await scanPlayRoot(playRoot);
    log(`after quit: broken=${scan.brokenJson.length} slot_remnants=${scan.slotRemnants.length} staging=${scan.stagingRemnants.length} tmp=${scan.tempFiles.length}`);
    const sourceFiles = (await listFiles(sourceSlot)).length;
    const savedFiles = (await listFiles(path.join(playRoot, 'slots', saveId))).length;
    log(`${saveId} files=${savedFiles} (source slot files=${sourceFiles})`);

    running = launch();
    await waitForHttp(base);
    const reopened = await checkReadable(base, new Set([slotId, saveId]), new Set([saveId]), slotId);
    log(`reopened: listed=${reopened.listedCount} missing=${JSON.stringify(reopened.missing)} loads=[${reopened.loads.join(' ')}]`);
    process.kill(running.pid, 'SIGTERM');
    const secondExit = await waitForExit('electron', running, running.pid);
    running = null;
    log(`reopened app quit exit=${secondExit.code ?? secondExit.signal}`);
    const ok = saved.status === 200 && saved.at <= exit.at && exit.code === 0 && quitLine !== '(no quit line)'
      && scan.brokenJson.length + scan.slotRemnants.length + scan.stagingRemnants.length + scan.tempFiles.length === 0
      && savedFiles === sourceFiles && reopened.ok && secondExit.code === 0;
    log(`desktop result: ${ok ? 'PASS' : 'FAIL'}`);
    return ok;
  } finally {
    if (running && running.child.exitCode === null && running.child.signalCode === null) {
      process.kill(-running.pid, 'SIGKILL');
      await running.exited;
    }
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

function jsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function killTargetStorage(root) {
  return createStorageApi({ root });
}

const KILL_TARGET = 'game_data/shutdown_check_target.json';

async function killGenerations(sourceSlot) {
  const oldValue = JSON.parse(await fs.readFile(path.join(sourceSlot, 'game_data/runtime_state.json'), 'utf8'));
  return { oldValue, newValue: { ...oldValue, shutdown_check_generation: 'new' } };
}

async function sigkillCheck(sourceSlot) {
  log('== sigkill: SIGKILL a process that is writing the same JSON file over and over');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'serve-shutdown-check-'));
  try {
    const { oldValue, newValue } = await killGenerations(sourceSlot);
    const oldBytes = jsonBytes(oldValue);
    const newBytes = jsonBytes(newValue);
    const results = {};
    for (const writer of ['storage.writeJson', 'fs.writeFile (control)']) {
      const root = path.join(tmp, writer.startsWith('storage') ? 'atomic' : 'direct');
      const target = killTargetStorage(root).resolveWritePath(KILL_TARGET);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const counts = { old: 0, new: 0, empty: 0, partial: 0 };
      for (let trial = 1; trial <= SIGKILL_TRIALS; trial += 1) {
        await fs.writeFile(target, oldBytes, 'utf8');
        const child = fork(toolPath, ['write-loop', root, writer.startsWith('storage') ? 'atomic' : 'direct', sourceSlot], {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          env: childEnv()
        });
        const watched = watchChild(child);
        await watched.nextMessage();
        await sleep(randomBetween(5, 60));
        process.kill(child.pid, 'SIGKILL');
        await waitForExit('writer', watched, child.pid);
        const bytes = await fs.readFile(target, 'utf8');
        if (bytes === oldBytes) counts.old += 1;
        else if (bytes === newBytes) counts.new += 1;
        else if (bytes.length === 0) counts.empty += 1;
        else counts.partial += 1;
      }
      const leftovers = (await listFiles(path.dirname(target))).filter((file) => file.endsWith('.tmp')).length;
      results[writer] = counts;
      log(`${writer.padEnd(24)} kills=${SIGKILL_TRIALS} old=${counts.old} new=${counts.new} empty=${counts.empty} partial=${counts.partial} leftover_tmp=${leftovers} (bytes old=${oldBytes.length} new=${newBytes.length})`);
    }
    const atomic = results['storage.writeJson'];
    const ok = atomic.empty === 0 && atomic.partial === 0;
    log(`sigkill result: ${ok ? 'PASS' : 'FAIL'} (control empty+partial=${results['fs.writeFile (control)'].empty + results['fs.writeFile (control)'].partial})`);
    return ok;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function runCheckFinalization(playRoot, conversationId) {
  try {
    await runAtomicFinalizationWithStaging({
      root: playRoot,
      conversationId,
      finalizer: async ({ root }) => {
        const storage = createStorageApi({ root });
        for (let step = 1; step <= FINALIZE_STEPS; step += 1) {
          const state = await storage.readJson('game_data/runtime_state.json');
          await storage.writeJson('game_data/runtime_state.json', { ...state, shutdown_check_finalize: { conversation_id: conversationId, step } });
          await sleep(100);
        }
        return {};
      }
    });
    console.log(`finalize completed ${conversationId}`);
  } catch (error) {
    console.log(`finalize failed ${conversationId}: ${error.message}`);
  }
}

async function serveMode(userDataRoot) {
  const workspace = await ensureElectronRuntimeWorkspace({ resourceRoot: repoRoot, userDataRoot });
  const started = await startServer({
    root: workspace.projectRoot,
    publicRoot: workspace.publicRoot,
    canonicalAssetsRoot: workspace.canonicalAssetsRoot,
    canonicalVisualSetsRoot: workspace.canonicalVisualSetsRoot,
    worldSettingsWriteTarget: 'config',
    characterAuthoringEnabled: false,
    lmStudioConfigPath: workspace.lmStudioConfigPath,
    host: '127.0.0.1',
    port: 0
  });
  shutdownServerOnSignals(started.server);
  process.on('message', (message) => {
    if (message.type === 'finalize') runCheckFinalization(path.join(workspace.mutableRoot, 'play'), message.conversationId);
  });
  process.send({ type: 'listening', port: started.port });
}

async function writeLoopMode(root, mode, sourceSlot) {
  const { oldValue, newValue } = await killGenerations(sourceSlot);
  const storage = killTargetStorage(root);
  const target = storage.resolveWritePath(KILL_TARGET);
  const write = mode === 'atomic'
    ? (value) => storage.writeJson(KILL_TARGET, value)
    : (value) => fs.writeFile(target, jsonBytes(value), 'utf8');
  process.send({ type: 'writing' });
  for (let round = 0; ; round += 1) await write(round % 2 === 0 ? newValue : oldValue);
}

async function pageMode(url) {
  const { app, BrowserWindow } = await import('electron');
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, width: 1280, height: 860 });
    await window.loadURL(url);
    console.log(`page-loaded title=${await window.webContents.executeJavaScript('document.title')} url=${url}`);
  }).catch((error) => {
    console.error(error);
    app.exit(1);
  });
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'serve') return serveMode(args[0]);
  if (mode === 'write-loop') return writeLoopMode(args[0], args[1], args[2]);
  if (mode === 'page') return pageMode(args[0]);
  const checks = { sigterm: sigtermCheck, browser: browserCheck, desktop: desktopCheck, sigkill: sigkillCheck };
  const selected = mode ? [mode] : Object.keys(checks);
  for (const name of selected) if (!checks[name]) throw new Error(`unknown check: ${name}`);
  const sourceSlot = path.resolve(requiredEnv('SHUTDOWN_CHECK_SOURCE_SLOT'));
  const sourcePlayRoot = path.dirname(path.dirname(sourceSlot));
  const before = await snapshotTree(sourcePlayRoot);
  const results = {};
  for (const name of selected) results[name] = await checks[name](sourceSlot);
  const changed = diffSnapshots(before, await snapshotTree(sourcePlayRoot));
  log(`source play root ${sourcePlayRoot}: files=${before.size} changed=${changed.length}${changed.length ? ` ${JSON.stringify(changed.slice(0, 10))}` : ''}`);
  log(`results: ${JSON.stringify(results)}`);
  if (changed.length || Object.values(results).some((ok) => !ok)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
