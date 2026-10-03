#!/usr/bin/env node
// 星見の窓 (overlook) evaluation run: drives one entry session of the server-side field headless for the whole
// academy day (9:00–15:00 = 30 wall-clock minutes) with an autopilot reader, and records six 5-minute windows.
//
//   node scripts/overlook-eval-run.mjs --seed <n> [--write <place id>:<line>] [--swap <window>:<count>]...
//                                      [--stub-lm [--speed <k>]]
//
// - `--seed <n>`: the entry week (runtime_state.elapsed_weeks); the field seed is overlookSeedForWeek(n), so the
//   roster, the start positions and the walks follow from it.
// - `--write <place id>:<line>`: writes the line at the place right after the clock starts.
// - `--swap <window>:<count>`: at the head of window 1–6, sends `count` children off one after another (the first
//   swappable rows in roster order; while the watched talk is on screen the send-off waits for the return).
// - The LM is the one the product uses: app/config/lmstudio.json. `--stub-lm` swaps in the stub below (varied,
//   gate-clean answers after EVAL_STUB_CALL_MS of clock time per call); only then may `--speed <k>` run the clock
//   k times faster than the wall. Every record is the same shape either way.
//
// The autopilot reader clicks the next line 15 s (clock time) after it is generated, and returns to the field
// 15 s after the closing line is shown; the academy then picks its next focus.
//
// A window boundary counts as a return to the field: a window's traces are those of the unwatched encounters that
// closed inside it (one per place), whatever the product's screen shows at that tick (`traces_view_end`).
// A window's focused talk is the first watched talk that opened inside it.
//
// The game runs in a fresh routing slot under the run directory (never the player's saves). Records, in the
// gitignored data/mutable/overlook-eval/<run id>/:
//   run.json            the run: arguments, roster, entry calls, writing, swaps, content result, completion
//   windows.jsonl       one line per window (see windowRecord)
//   encounters.jsonl    one line per encounter (focused talks and unwatched encounters kept apart by `handling`)
//   closures.jsonl      one line per closed talk (watched or not): per child, the feeling toward the partner and
//                       the concerns about the partner, before and after
//   offscreen.jsonl     one line per closed unwatched encounter: its seed, the partner's reply, outcome, trace and
//                       the two wish lines
//   decisions.jsonl     one line per wish decision that returned: the child, what triggered it (after a talk: the
//                       partner, the child who started it and the outcome), the wish the child held and the one it
//                       decided
//   conversations/      every watched talk in full (<conversation id>.json), with the wait for each line and how
//                       many stagnation judgments said true
//   failed_calls.jsonl  one line per generator call that threw: the generator, the tick, the error (message, code,
//                       stage, violations) and every LM request it made (the prompt and the LM's output, per attempt)
//   game/               the isolated game root the session ran in

import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { defaultRuntimePaths, projectRoot } from '../app/src/runtimePaths.mjs';
import { writeRuntimePathsManifest } from '../app/src/runtimeSlotBootstrap.mjs';
import { initializeNewPlayArea } from '../app/src/playSession.mjs';
import { createStorageApi } from '../app/src/storage.mjs';
import { createOverlookGenerators, overlookJudgeableOutcomes, overlookOffscreenOutcomes } from '../app/src/llm/overlookGeneration.mjs';
import { resolveCharacterSpeechConstraints } from '../app/src/llm/characterSpeechConstraints.mjs';
import { ensureLmStudioConversationConfig } from '../app/src/server/lmStudioSettingsApi.mjs';
import { OVERLOOK_FEELING_LABELS, OVERLOOK_MOODS, OVERLOOK_WISH_ACTIONS } from '../app/src/overlookState.mjs';
import {
  OVERLOOK_END_TICK,
  OVERLOOK_TICK_MS,
  formatOverlookMinute,
  listOverlookApproachingPairs,
  loadOverlookFieldGraph,
  overlookChildGatePhase,
  overlookMinuteAtTick
} from '../app/src/overlookField.mjs';
import {
  OVERLOOK_CALL_CATEGORIES,
  advanceOverlookSession,
  enterOverlook,
  exitOverlook,
  overlookFieldView,
  overlookSeedForWeek,
  returnFromOverlookConversation,
  sendOffOverlookChild,
  showNextOverlookLine,
  writeOverlookLine
} from '../app/src/routingOverlook.mjs';

const EVAL_WINDOW_COUNT = 6;
const EVAL_WINDOW_TICKS = OVERLOOK_END_TICK / EVAL_WINDOW_COUNT;
const EVAL_WINDOW_MS = EVAL_WINDOW_TICKS * OVERLOOK_TICK_MS;
const EVAL_READ_MS = 15_000;
const EVAL_STUB_CALL_MS = 3_000;
// A window whose LM busy time covers this share of it counts as saturated.
const EVAL_OCCUPANCY_HIGH = 0.95;
const EVAL_OUTCOMES = Object.freeze(['果たされた', '断られた', '別の決着']);
const EVAL_GENERATORS = Object.freeze(['decideWish', 'generateSeed', 'generateUtterance', 'judgeOutcome', 'judgeStagnation', 'rewriteState', 'resolveOffscreen']);
// At most one clock second of ticks is stepped before the LM jobs get a turn.
const TICKS_PER_BATCH = 1000 / OVERLOOK_TICK_MS;
const EVAL_ROOT = path.join(projectRoot, 'data/mutable/overlook-eval');
const LM_CONFIG_PATH = path.join(defaultRuntimePaths.configRoot, 'lmstudio.json');
const USAGE = 'usage: overlook-eval-run.mjs --seed <n> [--write <place id>:<line>] [--swap <window>:<count>]... [--stub-lm [--speed <k>]]';

function usageError(message) {
  return new Error(`${message}\n${USAGE}`);
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw usageError(`${flag} needs a value`);
  return value;
}

function parseCount(text, label) {
  if (!/^\d+$/.test(text)) throw usageError(`${label} must be a non-negative integer: ${text}`);
  return Number(text);
}

function parseRunArgs(argv) {
  const args = { seed: null, write: null, swaps: [], stubLm: false, speed: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--seed') {
      if (args.seed !== null) throw usageError('--seed is given twice');
      args.seed = parseCount(takeValue(argv, index, flag), '--seed');
      index += 1;
    } else if (flag === '--write') {
      if (args.write !== null) throw usageError('--write is given twice');
      const value = takeValue(argv, index, flag);
      const colon = value.indexOf(':');
      if (colon <= 0 || colon === value.length - 1) throw usageError(`--write must be <place id>:<line>: ${value}`);
      args.write = { placeId: value.slice(0, colon), text: value.slice(colon + 1) };
      index += 1;
    } else if (flag === '--swap') {
      const value = takeValue(argv, index, flag);
      const match = /^(\d+):(\d+)$/.exec(value);
      if (!match) throw usageError(`--swap must be <window>:<count>: ${value}`);
      const window = Number(match[1]);
      const count = Number(match[2]);
      if (window < 1 || window > EVAL_WINDOW_COUNT) throw usageError(`--swap window must be 1〜${EVAL_WINDOW_COUNT}: ${value}`);
      if (count < 1) throw usageError(`--swap count must be at least 1: ${value}`);
      if (args.swaps.some((swap) => swap.window === window)) throw usageError(`--swap names window ${window} twice`);
      args.swaps.push({ window, count });
      index += 1;
    } else if (flag === '--stub-lm') {
      args.stubLm = true;
    } else if (flag === '--speed') {
      const value = takeValue(argv, index, flag);
      const speed = Number(value);
      if (!Number.isFinite(speed) || speed <= 0) throw usageError(`--speed must be a positive number: ${value}`);
      args.speed = speed;
      index += 1;
    } else {
      throw usageError(`unknown argument: ${flag}`);
    }
  }
  if (args.seed === null) throw usageError('--seed is required');
  if (args.speed !== null && !args.stubLm) throw usageError('--speed runs only with --stub-lm (a real LM run keeps the wall clock)');
  args.swaps.sort((a, b) => a.window - b.window);
  return args;
}

function runIdFor(args, startedAt) {
  const stamp = startedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const parts = [stamp, `seed${args.seed}`];
  if (args.write) parts.push('write');
  for (const swap of args.swaps) parts.push(`swap${swap.window}x${swap.count}`);
  if (args.stubLm) parts.push('stub');
  return parts.join('-');
}

// A fresh routing game whose definitions, content and config are the project's and whose mutable data lives
// under the run directory.
async function isolatedRoutingSlot({ gameRoot, seed, now }) {
  await writeRuntimePathsManifest({ root: gameRoot, sourceRoot: projectRoot, mutableRoot: path.join(gameRoot, 'data/mutable/game_data') });
  const play = await initializeNewPlayArea({ root: gameRoot, slotId: 'slot_001', playMode: 'routing', routingPersonaVariant: 'fallen_star', now });
  const storage = createStorageApi({ root: play.root });
  const state = { ...(await storage.readJson('game_data/runtime_state.json')), elapsed_weeks: seed };
  await storage.writeJson('game_data/runtime_state.json', state);
  return { root: play.root, storage, state };
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// The stub LM for trying the tool without LM Studio: each call answers after EVAL_STUB_CALL_MS of clock time
// (an utterance, two requests, after twice that) with a gate-clean answer that varies from call to call — wishes
// spread over the roster and the places, feelings over the five labels, talks close after 2〜5 lines on any of
// the three outcomes — so encounters, ぶつかる pairs, chains and backlogs all occur.
function stubGenerators({ speed }) {
  let counter = 0;
  const draw = (key) => {
    counter += 1;
    return stableHash(`${key}:${counter}`);
  };
  const answer = (value, calls = 1) => sleep((EVAL_STUB_CALL_MS * calls) / speed).then(() => value);
  const stateFor = (state, partnerName, hash) => ({
    feeling_label: OVERLOOK_FEELING_LABELS[hash % OVERLOOK_FEELING_LABELS.length],
    feeling_text: `${partnerName}のことを考えている`,
    concerns: state.concerns.map((concern) => concern.text),
    mood: OVERLOOK_MOODS[(hash >>> 3) % OVERLOOK_MOODS.length]
  });
  return {
    decideWish: ({ child, roster, places }) => {
      const hash = draw(child.id);
      const action = OVERLOOK_WISH_ACTIONS[hash % OVERLOOK_WISH_ACTIONS.length];
      if (action === '籠もる' || (action === '確かめる' && hash % 2 === 0)) {
        const place = places[(hash >>> 4) % places.length];
        return answer({ action, target: { kind: 'place', id: place.id }, line: `${place.name}へ行きたい` });
      }
      const others = roster.filter((entry) => entry.id !== child.id);
      const other = others[(hash >>> 4) % others.length];
      return answer({ action, target: { kind: 'child', id: other.id }, line: `${other.name}が気になる` });
    },
    generateSeed: ({ initiator, partner }) => answer({ line: `${initiator.name}が${partner.name}に気づいて足を止めた。` }),
    generateUtterance: ({ speaker, partner, history, onDelta }) => {
      const content = `${partner.name}、少し話せる？（${speaker.name}の${history.length + 1}言目）`;
      return answer({ content, emotion: { expression: 'neutral', face_emotion_variant_id: 'face_neutral' } }, 2).then((value) => {
        onDelta?.(content);
        return value;
      });
    },
    judgeOutcome: ({ history, initiator, partner, initiatorWish, partnerReply }) => {
      const hash = stableHash(`${initiator.id}:${history[0].content}`);
      const closeAt = 2 + (hash % 4);
      const closing = overlookJudgeableOutcomes({ initiatorWish, partnerId: partner.id, partnerReplied: partnerReply !== null }).filter((outcome) => outcome !== '続く');
      return answer(history.length >= closeAt ? closing[(hash >>> 2) % closing.length] : '続く');
    },
    judgeStagnation: () => answer(false),
    rewriteState: ({ state, partner }) => answer(stateFor(state, partner.name, draw(partner.id))),
    resolveOffscreen: ({ initiator, partner, states }) => {
      const hash = draw(`${initiator.id}|${partner.id}`);
      const outcomes = overlookOffscreenOutcomes(states[initiator.id].wish, partner.id);
      const outcome = outcomes[hash % outcomes.length];
      return answer({
        seed: `${initiator.name}が${partner.name}に気づいて足を止めた。`,
        partner_reply: { 果たされた: 'いいよ、付き合う', 断られた: 'ごめん、いまは無理', 別の決着: 'それより聞いてほしいことがある' }[outcome],
        outcome,
        trace: `${initiator.name}が、${partner.name}と話し込んだ`,
        initiator: stateFor(states[initiator.id], partner.name, hash >>> 1),
        partner: stateFor(states[partner.id], initiator.name, hash >>> 5)
      });
    }
  };
}

// The LM requests of the generator call in progress, so a call that throws can leave what it asked and got.
const lmRequests = new AsyncLocalStorage();

function lmOutputOf(text) {
  try {
    return JSON.parse(text).choices?.[0]?.message?.content ?? text;
  } catch {
    return text;
  }
}

async function recordingFetch(url, init) {
  const response = await fetch(url, init);
  const requests = lmRequests.getStore();
  if (requests) {
    const body = JSON.parse(init.body);
    requests.push({ prompt: body.messages.map((message) => message.content).join('\n'), output: lmOutputOf(await response.clone().text()) });
  }
  return response;
}

async function productGenerators({ stubLm, speed, slotRoot }) {
  if (stubLm) return stubGenerators({ speed });
  const config = await ensureLmStudioConversationConfig({ lmStudioConfigPath: LM_CONFIG_PATH });
  const characterSpeechConstraints = await resolveCharacterSpeechConstraints({ root: slotRoot, chatModel: config.chat_model });
  return createOverlookGenerators({ config, characterSpeechConstraints, fetchImpl: recordingFetch });
}

function windowOfTick(tick) {
  return Math.ceil(tick / EVAL_WINDOW_TICKS);
}

function emptyOutcomes() {
  return Object.fromEntries(EVAL_OUTCOMES.map((outcome) => [outcome, 0]));
}

function emptyLabels() {
  return Object.fromEntries(OVERLOOK_FEELING_LABELS.map((label) => [label, 0]));
}

// A concern is about a child when it names the child: the full name, or the given name (before 「・」).
function namesChild(text, name) {
  const given = name.split('・')[0];
  return text.includes(name) || (given.length >= 2 && text.includes(given));
}

// One child's side of a closed talk: the feeling toward the partner and the concerns about the partner, before
// the rewrite and after it. The mood is not counted.
function feelingChange({ self, partner, partnerName, before, after }) {
  const about = (texts) => texts.filter((text) => namesChild(text, partnerName)).length;
  const labelBefore = before.feelings[partner]?.label ?? null;
  const concernsBefore = about(before.concerns.map((concern) => concern.text));
  const concernsAfter = about(after.concerns);
  return {
    child: self,
    partner,
    label_before: labelBefore,
    label_after: after.feeling_label,
    label_changed: labelBefore !== after.feeling_label,
    partner_concerns_before: concernsBefore,
    partner_concerns_after: concernsAfter,
    partner_concerns_increased: concernsAfter > concernsBefore
  };
}

function wishSummary(childId, wish) {
  return { child: childId, action: wish?.action ?? null, target: wish?.target ?? null, line: wish?.line ?? null };
}

function heldWish(wish) {
  return wish === null ? null : { action: wish.action, target: wish.target, line: wish.line };
}

// One returned wish decision. After a talk, the wish the child held is the one the trigger carries (the wish in
// the state is still that one, and the decision prompt shows it as held); otherwise it is the wish in the state.
function decisionRecord({ tick, input, decided }) {
  const { trigger } = input;
  const afterTalk = trigger.kind === 'conversation';
  return {
    tick,
    child: input.child.id,
    trigger: trigger.kind,
    partner_id: afterTalk ? trigger.partner_id : null,
    initiator_id: afterTalk ? trigger.initiator_id : null,
    outcome: afterTalk ? trigger.outcome : null,
    wish_before: afterTalk ? trigger.wish : heldWish(input.state.wish),
    decided: { action: decided.action, target: decided.target, line: decided.line }
  };
}

// 目当て: one of the two wishes is aimed at the other child; otherwise 偶然.
function encounterIntent(wishes) {
  const [a, b] = wishes;
  const aims = (wish, other) => wish.target?.kind === 'child' && wish.target.id === other;
  return aims(a, b.child) || aims(b, a.child) ? '目当て' : '偶然';
}

// The wait for each line of a watched talk: from the moment its generation could start (the talk opened, or the
// line before it was shown) until the line was ready.
function lineWaits(times) {
  return times.generated_ms.map((generated, index) => Math.round(generated - (index === 0 ? times.opened_ms : times.shown_ms[index - 1])));
}

function statsSnapshot(session) {
  return JSON.parse(JSON.stringify(session.stats));
}

function callsBetween(before, after) {
  const byCategory = {};
  const byGenerator = Object.fromEntries(EVAL_GENERATORS.map((name) => [name, 0]));
  let requests = 0;
  for (const category of OVERLOOK_CALL_CATEGORIES) {
    let calls = 0;
    for (const name of EVAL_GENERATORS) {
      const delta = (after[category].calls[name] ?? 0) - (before[category].calls[name] ?? 0);
      calls += delta;
      byGenerator[name] += delta;
    }
    byCategory[category] = calls;
    requests += after[category].lm_requests - before[category].lm_requests;
  }
  return { total: Object.values(byCategory).reduce((sum, value) => sum + value, 0), lm_requests: requests, by_category: byCategory, by_generator: byGenerator };
}

// Union length of the LM busy intervals inside [from, to).
function busyWithin(intervals, from, to) {
  const clipped = intervals
    .map(([start, end]) => [Math.max(start, from), Math.min(end ?? to, to)])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cursor = from;
  for (const [start, end] of clipped) {
    if (end <= cursor) continue;
    total += end - Math.max(start, cursor);
    cursor = end;
  }
  return total;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function yieldTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function writeJsonFile(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeJsonl(filePath, rows) {
  await fs.writeFile(filePath, rows.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8');
}

async function runOverlookEval(args) {
  // A place id that is not on the road network fails before anything is created.
  if (args.write) {
    const graph = await loadOverlookFieldGraph({ root: projectRoot });
    if (!graph.placeById.has(args.write.placeId)) throw usageError(`--write names a place that is not on the overlook field: ${args.write.placeId}`);
  }
  const startedAt = new Date();
  const runId = runIdFor(args, startedAt);
  const runDir = path.join(EVAL_ROOT, runId);
  await fs.mkdir(EVAL_ROOT, { recursive: true });
  await fs.mkdir(runDir);
  await fs.mkdir(path.join(runDir, 'conversations'));
  const slot = await isolatedRoutingSlot({ gameRoot: path.join(runDir, 'game'), seed: args.seed, now: startedAt.toISOString() });

  // The clock: the wall clock (k times faster with --speed), held at the tick the recorder lets the field reach,
  // so the field moves one tick at a time and every tick — and every window boundary — is observed.
  const speed = args.speed ?? 1;
  const wallStart = Date.now();
  const evalNow = () => wallStart + (Date.now() - wallStart) * speed;
  let session = null;
  let allowedTick = 0;
  const clock = {
    now: () => {
      const now = evalNow();
      if (!session || session.startedAtMs === null) return now;
      return Math.min(now, session.startedAtMs + allowedTick * OVERLOOK_TICK_MS);
    }
  };

  // Every generator call is timed (LM occupancy) and the unwatched outcome and the lineage of each encounter are
  // read off the calls' inputs and results.
  const busy = [];
  const decisions = [];
  const encounterInfo = new Map();
  const offscreenResults = new Map();
  const focusRewrites = new Map();
  const talkTimes = new Map();
  const failedCalls = [];
  const infoOf = (id) => {
    if (!encounterInfo.has(id)) encounterInfo.set(id, { parents: null, wishes: null, focused: false, focused_ms: null, handling: null, outcome: null, closed_tick: null, final_status: null });
    return encounterInfo.get(id);
  };
  // The watched talk a rewrite belongs to: the latest closed one of the pair.
  const closedTalkOf = (a, b) => {
    const found = [...session.conversations.values()].filter(({ record }) => record.outcome !== null
      && ((record.initiator.id === a && record.partner.id === b) || (record.initiator.id === b && record.partner.id === a)));
    if (!found.length) throw new Error(`overlook eval found no closed talk for the rewrite of ${a} / ${b}`);
    return found.at(-1).record;
  };
  const liveEncounterOf = (a, b) => {
    const found = [...session.encounters.values()].filter((encounter) => (encounter.status === 'pending' || encounter.status === 'focused')
      && ((encounter.initiator === a && encounter.partner === b) || (encounter.initiator === b && encounter.partner === a)));
    if (found.length !== 1) throw new Error(`overlook eval found ${found.length} live encounters for ${a} / ${b}`);
    return found[0];
  };
  const sourceEncounterId = (source) => {
    if (source.kind !== 'conversation') return null;
    if (source.id.startsWith('ove_')) return source.id;
    const conversation = session.conversations.get(source.id);
    if (!conversation) throw new Error(`overlook eval cannot resolve the talk a wish came from: ${source.id}`);
    return conversation.record.encounter_id;
  };
  const captureParents = (encounter, states) => {
    const info = infoOf(encounter.id);
    if (info.parents !== null) return;
    info.parents = [encounter.initiator, encounter.partner].flatMap((childId) => {
      const wish = states[childId]?.wish ?? null;
      if (!wish) return [];
      return [{ child: childId, source_kind: wish.source.kind, source_id: wish.source.id, parent_encounter_id: sourceEncounterId(wish.source), generation: wish.generation }];
    });
  };
  const product = await productGenerators({ stubLm: args.stubLm, speed, slotRoot: slot.root });
  const generators = Object.fromEntries(EVAL_GENERATORS.map((name) => [name, async (input) => {
    const encounter = name === 'generateSeed' || name === 'resolveOffscreen' ? liveEncounterOf(input.initiator.id, input.partner.id) : null;
    if (encounter) captureParents(encounter, input.states);
    const interval = [evalNow(), null];
    busy.push(interval);
    const requests = [];
    try {
      const result = await lmRequests.run(requests, () => product[name](input));
      if (name === 'decideWish') decisions.push(decisionRecord({ tick: session?.field.tick ?? 0, input, decided: result }));
      if (name === 'resolveOffscreen') offscreenResults.set(encounter.id, { states: input.states, result });
      if (name === 'rewriteState') {
        const talk = closedTalkOf(input.self.id, input.partner.id);
        if (!focusRewrites.has(talk.encounter_id)) focusRewrites.set(talk.encounter_id, new Map());
        focusRewrites.get(talk.encounter_id).set(input.self.id, feelingChange({
          self: input.self.id, partner: input.partner.id, partnerName: input.partner.name, before: input.state, after: result
        }));
      }
      return result;
    } catch (error) {
      failedCalls.push({
        generator: name,
        tick: session?.field.tick ?? 0,
        error: { message: error.message, error_code: error.errorCode ?? null, stage: error.stage ?? null, violations: error.violations ?? null },
        requests
      });
      throw error;
    } finally {
      interval[1] = evalNow();
    }
  }]));

  const run = {
    run_id: runId,
    seed: args.seed,
    field_seed: overlookSeedForWeek(args.seed),
    lm: args.stubLm ? 'stub' : 'lmstudio',
    speed,
    write: args.write ? { place_id: args.write.placeId, text: args.write.text } : null,
    swaps_requested: args.swaps.map((swap) => ({ window: swap.window, count: swap.count })),
    started_at: startedAt.toISOString(),
    roster: null,
    entry: null,
    writing: null,
    swaps: [],
    content_result: null,
    completed: false,
    failure: null
  };
  const windows = [];
  const stateOf = (id) => {
    const state = session.surface.children.children[id];
    if (!state) throw new Error(`overlook eval has no state for ${id}`);
    return state;
  };

  try {
    const entryStart = evalNow();
    session = await enterOverlook({ root: slot.root, authoringRoot: path.join(runDir, 'game'), storage: slot.storage, state: slot.state, generators, clock });
    run.roster = session.surface.roster.members.map((id) => ({ character_id: id, character_name: session.names.get(id) }));
    run.entry = { calls: EVAL_GENERATORS.reduce((sum, name) => sum + (session.stats.spring.calls[name] ?? 0), 0), clock_ms: session.startedAtMs - entryStart };

    const active = new Map();
    let seenEncounters = 0;
    const conversationEncounter = new Map();
    const pendingSwaps = args.swaps.map((swap) => ({ ...swap, sent: 0 }));
    let window = { index: 1, statsBefore: statsSnapshot(session), peak: 0, closed: [], swaps: [] };
    let readyAt = null;
    let pilotFailure = null;
    let readyKey = null;

    if (args.write) {
      const writing = writeOverlookLine(session, { placeId: args.write.placeId, text: args.write.text });
      run.writing = { writing_id: writing.id, place_id: writing.place_id, text: writing.text, tick: session.field.tick };
    }

    const observe = () => {
      const tick = session.field.tick;
      const now = evalNow();
      for (let index = seenEncounters + 1; index <= session.encounterCounter; index += 1) {
        const id = `ove_${String(index).padStart(4, '0')}`;
        const encounter = session.encounters.get(id);
        active.set(id, encounter);
        infoOf(id).wishes = [encounter.initiator, encounter.partner].map((childId) => wishSummary(childId, stateOf(childId).wish));
      }
      seenEncounters = session.encounterCounter;
      if (session.focus) {
        const info = infoOf(session.focus.encounter_id);
        info.focused = true;
        info.focused_ms ??= now;
        const conversationId = session.focus.conversation_id;
        if (conversationId) {
          conversationEncounter.set(conversationId, session.focus.encounter_id);
          if (!talkTimes.has(conversationId)) {
            talkTimes.set(conversationId, { tick, focused_ms: info.focused_ms, opened_ms: now, generated_ms: [], shown_ms: [] });
          }
          const times = talkTimes.get(conversationId);
          const conversation = session.conversations.get(conversationId);
          while (times.generated_ms.length < conversation.record.messages.length) times.generated_ms.push(now);
          while (times.shown_ms.length < conversation.shown) times.shown_ms.push(now);
        }
      }
      for (const [id, encounter] of active) {
        if (encounter.status === 'pending' || encounter.status === 'focused') continue;
        active.delete(id);
        const info = infoOf(id);
        info.final_status = encounter.status;
        if (encounter.status !== 'resolved') continue;
        const conversation = [...session.conversations.values()].find((entry) => entry.record.encounter_id === id);
        info.handling = conversation ? 'focus' : 'offscreen';
        info.outcome = conversation ? conversation.record.outcome : offscreenResults.get(id)?.result.outcome;
        if (!EVAL_OUTCOMES.includes(info.outcome)) throw new Error(`overlook eval has no outcome for resolved encounter ${id}`);
        info.closed_tick = tick;
        window.closed.push(id);
      }
      window.peak = Math.max(window.peak, active.size);
    };

    const closeWindow = () => {
      const view = overlookFieldView(session);
      const inProgress = [...session.encounters.values()].filter((encounter) => encounter.status === 'pending' || encounter.status === 'focused');
      const approaching = listOverlookApproachingPairs(session.field, { stateOf });
      const statsAfter = statsSnapshot(session);
      const members = session.surface.roster.members;
      const labels = emptyLabels();
      for (const id of members) {
        for (const feeling of Object.values(stateOf(id).feelings)) labels[feeling.label] += 1;
      }
      const offscreenPlaces = new Set(window.closed
        .filter((id) => infoOf(id).handling === 'offscreen')
        .map((id) => session.encounters.get(id).place_id));
      windows.push({
        window: window.index,
        statsBefore: window.statsBefore,
        statsAfter,
        peak: window.peak,
        closed: window.closed,
        swaps: window.swaps,
        traces_end: offscreenPlaces.size,
        traces_view_end: view.traces.length,
        encounter_waiting_children_end: 2 * inProgress.filter((encounter) => encounter.status === 'pending').length,
        deciding_children_end: members.filter((id) => session.field.children.get(id).hold === 'deciding').length,
        feeling_labels_end: labels,
        in_progress_end: inProgress.length,
        approaching_end: approaching.length,
        friction_in_progress_end: inProgress.filter((encounter) => encounter.friction).length,
        friction_approaching_end: approaching.filter((pair) => pair.friction).length
      });
      window = { index: window.index + 1, statsBefore: statsAfter, peak: active.size, closed: [], swaps: [] };
    };

    // The send-offs due, then the reader's next click. A send-off refused because the watched talk is on screen
    // waits until the reader has returned to the field.
    const sendOffsDue = () => {
      for (const swap of pendingSwaps) {
        if (swap.sent >= swap.count || session.field.tick < (swap.window - 1) * EVAL_WINDOW_TICKS) continue;
        while (swap.sent < swap.count) {
          const candidate = session.surface.roster.members.find((id) => overlookChildGatePhase(session.field, id) === null);
          if (!candidate) throw new Error('overlook eval found no swappable child');
          for (const encounter of active.values()) captureParents(encounter, session.surface.children.children);
          let result;
          try {
            result = sendOffOverlookChild(session, { characterId: candidate });
          } catch (error) {
            if (error.errorCode === 'OVERLOOK_ROSTER_BUSY') return;
            throw error;
          }
          swap.sent += 1;
          const record = { window: swap.window, tick: session.field.tick, leaving: result.leaving, arriving: result.arriving };
          run.swaps.push(record);
          window.swaps.push(record);
          observe();
        }
      }
    };

    const autopilot = () => {
      if (session.field.tick >= OVERLOOK_END_TICK) return;
      sendOffsDue();
      const now = clock.now();
      const conversationId = session.focus?.conversation_id;
      if (!conversationId) return;
      const conversation = session.conversations.get(conversationId);
      const { record } = conversation;
      const closedShown = record.outcome !== null && conversation.shown === record.messages.length;
      const actionable = closedShown || record.messages.length > conversation.shown;
      const key = `${conversationId}:${conversation.shown}`;
      if (!actionable) return;
      if (readyKey !== key) {
        readyKey = key;
        readyAt = now;
      }
      if (now < readyAt + EVAL_READ_MS) return;
      readyKey = null;
      if (closedShown) {
        returnFromOverlookConversation(session, { conversationId });
      } else {
        // The line is already generated, so it is shown at once; a failure surfaces on the next loop turn.
        showNextOverlookLine(session, { conversationId }).catch((error) => { pilotFailure ??= error; });
      }
      observe();
    };

    observe();
    autopilot();
    // Steps the ticks that are due, a batch at a time: between batches the LM jobs run and apply (a job applying
    // mid-batch cannot step the field past the tick already observed).
    while (session.field.tick < OVERLOOK_END_TICK) {
      if (pilotFailure) throw pilotFailure;
      const due = Math.min(OVERLOOK_END_TICK, Math.floor((evalNow() - session.startedAtMs) / OVERLOOK_TICK_MS), allowedTick + TICKS_PER_BATCH);
      while (allowedTick < due) {
        allowedTick += 1;
        advanceOverlookSession(session);
        observe();
        if (session.field.tick === window.index * EVAL_WINDOW_TICKS) closeWindow();
        autopilot();
      }
      const wait = (session.startedAtMs + (allowedTick + 1) * OVERLOOK_TICK_MS - evalNow()) / speed;
      if (wait > 0) await sleep(Math.ceil(wait));
      else await yieldTurn();
    }
    if (pilotFailure) throw pilotFailure;
    const unsent = pendingSwaps.filter((swap) => swap.sent < swap.count);
    if (unsent.length) throw new Error(`overlook eval could not send off everyone asked before 15:00: ${unsent.map((swap) => `${swap.window}:${swap.sent}/${swap.count}`).join(', ')}`);

    for (const encounter of active.values()) captureParents(encounter, session.surface.children.children);
    run.content_result = await exitOverlook(session, { now: new Date().toISOString() });
    for (const [id, info] of encounterInfo) {
      if (info.final_status === null) info.final_status = session.encounters.get(id).status;
    }
    await writeRecords({ runDir, run, windows, session, encounterInfo, busy, decisions, conversationEncounter, offscreenResults, focusRewrites, talkTimes });
    run.completed = true;
  } catch (error) {
    run.failure = { message: error.message, error_code: error.errorCode ?? null };
    throw error;
  } finally {
    run.ended_at = new Date().toISOString();
    await writeJsonFile(path.join(runDir, 'run.json'), run);
    await writeJsonl(path.join(runDir, 'failed_calls.jsonl'), failedCalls);
  }
  return { runDir, run };
}

// Lineage over the whole run: a closed talk's handoffs are its wishes that went on to an encounter; the writing
// depth is how many generations a writing-seeded chain has reached at an encounter (0 when it is not one).
function lineage(session, encounterInfo) {
  const ids = [...session.encounters.keys()];
  const children = new Map(ids.map((id) => [id, new Set()]));
  const depth = new Map();
  for (const id of ids) {
    const parents = encounterInfo.get(id).parents ?? [];
    let writingDepth = 0;
    for (const parent of parents) {
      if (parent.source_kind === 'writing') writingDepth = Math.max(writingDepth, 1);
      if (parent.parent_encounter_id) {
        children.get(parent.parent_encounter_id).add(parent.child);
        const parentDepth = depth.get(parent.parent_encounter_id);
        if (parentDepth > 0) writingDepth = Math.max(writingDepth, parentDepth + 1);
      }
    }
    depth.set(id, writingDepth);
  }
  return { handoffs: new Map([...children].map(([id, set]) => [id, set.size])), writingDepth: depth };
}

async function writeRecords({ runDir, run, windows, session, encounterInfo, busy, decisions, conversationEncounter, offscreenResults, focusRewrites, talkTimes }) {
  const { handoffs, writingDepth } = lineage(session, encounterInfo);
  const encounters = [...session.encounters.values()].map((encounter) => {
    const info = encounterInfo.get(encounter.id);
    const conversationId = [...conversationEncounter].find(([, encounterId]) => encounterId === encounter.id)?.[0] ?? null;
    const closed = info.final_status === 'resolved' && info.closed_tick !== null;
    return {
      encounter_id: encounter.id,
      window: windowOfTick(encounter.tick),
      tick: encounter.tick,
      academy_time: formatOverlookMinute(overlookMinuteAtTick(encounter.tick)),
      initiator: encounter.initiator,
      partner: encounter.partner,
      place_id: encounter.place_id,
      friction: encounter.friction,
      generation: encounter.generation,
      from_writing: encounter.from_writing,
      spring: encounter.generation === 1 && !encounter.from_writing,
      writing_depth: writingDepth.get(encounter.id),
      focused: info.focused,
      intent: encounterIntent(info.wishes),
      wishes: info.wishes,
      conversation_id: conversationId,
      status: closed ? 'closed' : info.final_status,
      handling: closed ? info.handling : null,
      outcome: closed ? info.outcome : null,
      closed_window: closed ? windowOfTick(info.closed_tick) : null,
      handoffs: closed ? handoffs.get(encounter.id) : null,
      seed_line: encounter.seed_line,
      trace: closed && info.handling === 'offscreen' ? offscreenResults.get(encounter.id).result.trace : null,
      parents: info.parents ?? []
    };
  });
  const byId = new Map(encounters.map((encounter) => [encounter.encounter_id, encounter]));
  const closedEncounters = encounters.filter((encounter) => encounter.status === 'closed');
  const closures = closedEncounters.map((encounter) => {
    let children;
    if (encounter.handling === 'offscreen') {
      const { states, result } = offscreenResults.get(encounter.encounter_id);
      children = [[encounter.initiator, encounter.partner, result.initiator], [encounter.partner, encounter.initiator, result.partner]]
        .map(([self, partner, after]) => feelingChange({ self, partner, partnerName: session.names.get(partner), before: states[self], after }));
    } else {
      // A rewrite still running at 15:00 never returns: that child's side is null.
      const rewrites = focusRewrites.get(encounter.encounter_id) ?? new Map();
      children = [rewrites.get(encounter.initiator) ?? null, rewrites.get(encounter.partner) ?? null];
    }
    return { encounter_id: encounter.encounter_id, handling: encounter.handling, outcome: encounter.outcome, closed_window: encounter.closed_window, children };
  });
  const offscreen = closedEncounters.filter((encounter) => encounter.handling === 'offscreen').map((encounter) => ({
    encounter_id: encounter.encounter_id,
    closed_window: encounter.closed_window,
    place_id: encounter.place_id,
    intent: encounter.intent,
    seed_line: encounter.seed_line,
    partner_reply: offscreenResults.get(encounter.encounter_id).result.partner_reply,
    outcome: encounter.outcome,
    trace: encounter.trace,
    wish_lines: encounter.wishes.map((wish) => ({ child: wish.child, action: wish.action, line: wish.line }))
  }));
  // A window's focused talk: the first watched talk that opened inside it.
  const focusTalkOf = (windowIndex) => {
    const entry = [...talkTimes].find(([, times]) => windowOfTick(times.tick) === windowIndex);
    if (!entry) return null;
    const [conversationId] = entry;
    const { record } = session.conversations.get(conversationId);
    return {
      conversation_id: conversationId,
      encounter_id: record.encounter_id,
      pair: [record.initiator.id, record.partner.id].sort(),
      outcome: record.outcome,
      seed_line: record.seed_line
    };
  };
  const windowRows = windows.map((entry) => {
    const started = encounters.filter((encounter) => encounter.window === entry.window);
    const closed = entry.closed.map((id) => byId.get(id));
    const outcomesOf = (list) => ({ total: list.length, outcomes: list.reduce((acc, encounter) => ({ ...acc, [encounter.outcome]: acc[encounter.outcome] + 1 }), emptyOutcomes()) });
    const from = session.startedAtMs + (entry.window - 1) * EVAL_WINDOW_MS;
    const busyMs = busyWithin(busy, from, from + EVAL_WINDOW_MS);
    return {
      run_id: run.run_id,
      seed: run.seed,
      window: entry.window,
      academy_from: formatOverlookMinute(overlookMinuteAtTick((entry.window - 1) * EVAL_WINDOW_TICKS)),
      academy_to: formatOverlookMinute(overlookMinuteAtTick(entry.window * EVAL_WINDOW_TICKS)),
      conversations_started: started.length,
      conversations_closed: {
        ...outcomesOf(closed),
        focus: outcomesOf(closed.filter((encounter) => encounter.handling === 'focus')),
        offscreen: outcomesOf(closed.filter((encounter) => encounter.handling === 'offscreen'))
      },
      handoffs: closed.map((encounter) => ({ encounter_id: encounter.encounter_id, handling: encounter.handling, handoffs: encounter.handoffs })),
      spring_encounters_started: started.filter((encounter) => encounter.spring).length,
      concurrent_encounters_peak: entry.peak,
      chain_lengths: started.map((encounter) => encounter.generation),
      focused_encounters_started: started.filter((encounter) => encounter.focused).length,
      friction_encounters_started: started.filter((encounter) => encounter.friction).length,
      traces_end: entry.traces_end,
      traces_view_end: entry.traces_view_end,
      encounter_waiting_children_end: entry.encounter_waiting_children_end,
      deciding_children_end: entry.deciding_children_end,
      feeling_labels_end: entry.feeling_labels_end,
      focus_talk: focusTalkOf(entry.window),
      in_progress_end: entry.in_progress_end,
      approaching_end: entry.approaching_end,
      friction_in_progress_end: entry.friction_in_progress_end,
      friction_approaching_end: entry.friction_approaching_end,
      lm_calls: callsBetween(entry.statsBefore, entry.statsAfter),
      lm_busy_ms: Math.round(busyMs),
      lm_occupancy: Number((busyMs / EVAL_WINDOW_MS).toFixed(3)),
      lm_occupancy_high: busyMs / EVAL_WINDOW_MS >= EVAL_OCCUPANCY_HIGH,
      swaps: entry.swaps.map((swap) => ({ tick: swap.tick, leaving: swap.leaving.character_id, arriving: swap.arriving.character_id }))
    };
  });
  if (run.writing) {
    const writing = session.writings.find((entry) => entry.id === run.writing.writing_id);
    const seeded = encounters.filter((encounter) => encounter.writing_depth > 0);
    run.writing = {
      ...run.writing,
      readers: [...writing.readers].sort(),
      children_seeded: [...new Set(session.movers.filter((mover) => mover.writing_text === writing.text).map((mover) => mover.character_id))].sort(),
      seeded_encounters: seeded.length,
      chain_max_depth: Math.max(0, ...seeded.map((encounter) => encounter.writing_depth))
    };
  }
  for (const conversation of session.conversations.values()) {
    const { record } = conversation;
    const times = talkTimes.get(record.id);
    await writeJsonFile(path.join(runDir, 'conversations', `${record.id}.json`), {
      conversation_id: record.id,
      encounter_id: record.encounter_id,
      location_name: record.location_name,
      seed_line: record.seed_line,
      initiator: record.initiator,
      partner: record.partner,
      generation: record.generation,
      from_writing: record.from_writing,
      shown: conversation.shown,
      outcome: record.outcome,
      messages: record.messages.map((message) => ({ speaker_id: message.speaker_id, speaker_name: message.speaker_name, content: message.content, outcome: message.outcome })),
      judgments: record.judgments,
      stagnation_true: record.judgments.filter((judgment) => judgment.kind === 'stagnation' && judgment.value === true).length,
      utterances: record.messages.length,
      // A talk that opened after the last observed tick has no timings.
      focus_to_open_ms: times ? Math.round(times.opened_ms - times.focused_ms) : null,
      line_waits_ms: times ? lineWaits(times) : null
    });
  }
  await writeJsonl(path.join(runDir, 'windows.jsonl'), windowRows);
  await writeJsonl(path.join(runDir, 'encounters.jsonl'), encounters);
  await writeJsonl(path.join(runDir, 'closures.jsonl'), closures);
  await writeJsonl(path.join(runDir, 'offscreen.jsonl'), offscreen);
  await writeJsonl(path.join(runDir, 'decisions.jsonl'), decisions);
}

const { runDir, run } = await runOverlookEval(parseRunArgs(process.argv.slice(2)));
process.stdout.write(`${JSON.stringify({ run_dir: path.relative(projectRoot, runDir), run_id: run.run_id, completed: run.completed })}\n`);
