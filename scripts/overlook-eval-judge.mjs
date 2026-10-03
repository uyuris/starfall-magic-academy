#!/usr/bin/env node
// 星見の窓 (overlook) evaluation judge: reads the records scripts/overlook-eval-run.mjs wrote and prints, for the
// given runs, the per-run / per-window table, one result line per criterion, the pass lines of the fix stage, and
// the distributions of handoffs (per closed talk) and chain lengths (per encounter) across the runs.
//
//   node scripts/overlook-eval-judge.mjs <run dir>...
//
// Criteria (one window is the unit; flagship's evaluation design):
//   途切れ   a window ends with 0 traces and 0 encounters in progress or approaching — in any run.
//   ざわつき more than a third of all windows end with 6+ traces or reach 5+ concurrent encounters.
//   山の欠け more than a third of all windows end with no ぶつかる encounter in progress or approaching.
//   決め打ち each seed runs twice; per seed, count the windows 3〜6 whose focused talks in the two runs have the
//            same pair and the same outcome (0〜4). The control is the same count between the first runs of every
//            two different seeds. Hit when the per-seed mean is 2 or more and at least 1 above the control mean.
//            Judged only when every seed has exactly two runs. A window without a focused talk counts as not
//            matching.
//   単調     a run whose focused talks (one per window) all end on the same outcome; hit in 2+ runs out of 5. A
//            window without a focused talk is left out and the rest are compared; a run with fewer than
//            MONOTONE_MIN_TALKS focused talks is left out of the judgment.
//   羅列     a run with no encounter of generation 2+ (one that started from a state a closed talk rewrote); hit
//            in 3+ runs out of 5. When the runs split on it, add seeds up to 10.
//   ほどよい none of 途切れ・ざわつき・山の欠け・決め打ち・単調・羅列.
//   書き込み (runs with --write) a writing-seeded chain reached generation 2+ in at least 3 runs out of 5.
// When the runs' own verdicts (途切れ・ざわつき・山の欠け) differ, the judge says the seeds split (add 5 seeds and
// judge the 10).
// Pass lines (flagship, fix stage; each printed beside its line):
//   同じ子への選び直し  of the children whose wish aimed at the partner was held in an encounter that closed on
//                      果たされた, the share whose next decision (the one after that talk) aimed at the same child
//                      again, whatever the action — 25% or less.
//   上位 5 組          the share of all encounters taken by the five most frequent pairs — 50% or less.
//   果たされた         the share of 果たされた among the closed encounters — 30% to 60%.
//   山の欠け / 途切れ・ざわつき   not hit.
// Any record out of shape throws.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const WINDOW_COUNT = 6;
const OUTCOMES = ['果たされた', '断られた', '別の決着'];
const FEELING_LABELS = ['好意', '関心', '気まずい', '負い目', '反発'];
// 決め打ち compares the focused talks of these windows.
const FIXED_WINDOWS = [3, 4, 5, 6];
// 単調 compares the focused talks of the windows that have one; a run with fewer is not judged.
const MONOTONE_MIN_TALKS = 4;
const DECISION_KEYS = ['tick', 'child', 'trigger', 'partner_id', 'initiator_id', 'outcome', 'wish_before', 'decided'];
const PASS_RESELECTION_MAX = 0.25;
const PASS_TOP_PAIRS = 5;
const PASS_TOP_PAIRS_MAX = 0.5;
const PASS_FULFILLED_MIN = 0.3;
const PASS_FULFILLED_MAX = 0.6;
const FOCUS_TALK_KEYS = ['conversation_id', 'encounter_id', 'pair', 'outcome', 'seed_line'];
const CATEGORIES = ['focus', 'background', 'spring', 'writing', 'roster'];
const GENERATORS = ['decideWish', 'generateSeed', 'generateUtterance', 'judgeOutcome', 'judgeStagnation', 'rewriteState', 'resolveOffscreen'];
const RUN_KEYS = ['run_id', 'seed', 'field_seed', 'lm', 'speed', 'write', 'swaps_requested', 'started_at', 'roster', 'entry', 'writing', 'swaps', 'content_result', 'completed', 'failure', 'ended_at'];
const WRITING_KEYS = ['writing_id', 'place_id', 'text', 'tick', 'readers', 'children_seeded', 'seeded_encounters', 'chain_max_depth'];
const WINDOW_KEYS = [
  'run_id', 'seed', 'window', 'academy_from', 'academy_to', 'conversations_started', 'conversations_closed', 'handoffs',
  'spring_encounters_started', 'concurrent_encounters_peak', 'chain_lengths', 'focused_encounters_started',
  'friction_encounters_started', 'traces_end', 'traces_view_end', 'encounter_waiting_children_end',
  'deciding_children_end', 'feeling_labels_end', 'focus_talk', 'in_progress_end', 'approaching_end',
  'friction_in_progress_end', 'friction_approaching_end', 'lm_calls', 'lm_busy_ms', 'lm_occupancy',
  'lm_occupancy_high', 'swaps'
];
const COUNT_KEYS = [
  'conversations_started', 'spring_encounters_started', 'concurrent_encounters_peak', 'focused_encounters_started',
  'friction_encounters_started', 'traces_end', 'traces_view_end', 'encounter_waiting_children_end',
  'deciding_children_end', 'in_progress_end', 'approaching_end', 'friction_in_progress_end',
  'friction_approaching_end', 'lm_busy_ms'
];

function shapeError(where, message) {
  return new Error(`overlook eval record out of shape (${where}): ${message}`);
}

function assertKeys(value, keys, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw shapeError(where, 'must be an object');
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.join(',') !== expected.join(',')) throw shapeError(where, `keys must be exactly [${expected.join(', ')}], got [${actual.join(', ')}]`);
}

function assertCount(value, where) {
  if (!Number.isInteger(value) || value < 0) throw shapeError(where, `must be a non-negative integer, got ${JSON.stringify(value)}`);
}

function assertOutcomeTally(tally, where, keys = ['total', 'outcomes']) {
  assertKeys(tally, keys, where);
  assertKeys(tally.outcomes, OUTCOMES, `${where}.outcomes`);
  for (const outcome of OUTCOMES) assertCount(tally.outcomes[outcome], `${where}.outcomes.${outcome}`);
  assertCount(tally.total, `${where}.total`);
  if (OUTCOMES.reduce((sum, outcome) => sum + tally.outcomes[outcome], 0) !== tally.total) throw shapeError(where, 'outcomes do not add up to total');
}

function validateWindow(row, index, run, where) {
  assertKeys(row, WINDOW_KEYS, where);
  if (row.run_id !== run.run_id || row.seed !== run.seed) throw shapeError(where, 'run_id / seed differ from run.json');
  if (row.window !== index + 1) throw shapeError(where, `window must be ${index + 1}, got ${row.window}`);
  for (const key of COUNT_KEYS) assertCount(row[key], `${where}.${key}`);
  assertOutcomeTally(row.conversations_closed, `${where}.conversations_closed`, ['total', 'outcomes', 'focus', 'offscreen']);
  assertOutcomeTally(row.conversations_closed.focus, `${where}.conversations_closed.focus`);
  assertOutcomeTally(row.conversations_closed.offscreen, `${where}.conversations_closed.offscreen`);
  if (!Array.isArray(row.handoffs) || row.handoffs.length !== row.conversations_closed.total) throw shapeError(where, 'handoffs must list every closed talk');
  row.handoffs.forEach((entry, i) => {
    assertKeys(entry, ['encounter_id', 'handling', 'handoffs'], `${where}.handoffs[${i}]`);
    if (!['focus', 'offscreen'].includes(entry.handling)) throw shapeError(`${where}.handoffs[${i}]`, `handling must be focus | offscreen, got ${entry.handling}`);
    if (![0, 1, 2].includes(entry.handoffs)) throw shapeError(`${where}.handoffs[${i}]`, `handoffs must be 0〜2, got ${entry.handoffs}`);
  });
  if (!Array.isArray(row.chain_lengths) || row.chain_lengths.length !== row.conversations_started) throw shapeError(where, 'chain_lengths must list every started encounter');
  row.chain_lengths.forEach((length, i) => {
    if (!Number.isInteger(length) || length < 1) throw shapeError(`${where}.chain_lengths[${i}]`, `must be a positive integer, got ${length}`);
  });
  assertKeys(row.lm_calls, ['total', 'lm_requests', 'by_category', 'by_generator'], `${where}.lm_calls`);
  assertCount(row.lm_calls.total, `${where}.lm_calls.total`);
  assertCount(row.lm_calls.lm_requests, `${where}.lm_calls.lm_requests`);
  assertKeys(row.lm_calls.by_category, CATEGORIES, `${where}.lm_calls.by_category`);
  assertKeys(row.lm_calls.by_generator, GENERATORS, `${where}.lm_calls.by_generator`);
  if (typeof row.lm_occupancy !== 'number' || row.lm_occupancy < 0) throw shapeError(where, 'lm_occupancy must be a non-negative number');
  if (typeof row.lm_occupancy_high !== 'boolean') throw shapeError(where, 'lm_occupancy_high must be a boolean');
  assertKeys(row.feeling_labels_end, FEELING_LABELS, `${where}.feeling_labels_end`);
  for (const label of FEELING_LABELS) assertCount(row.feeling_labels_end[label], `${where}.feeling_labels_end.${label}`);
  if (row.focus_talk !== null) {
    assertKeys(row.focus_talk, FOCUS_TALK_KEYS, `${where}.focus_talk`);
    if (!Array.isArray(row.focus_talk.pair) || row.focus_talk.pair.length !== 2) throw shapeError(`${where}.focus_talk`, 'pair must be two ids');
    if (row.focus_talk.outcome !== null && !OUTCOMES.includes(row.focus_talk.outcome)) throw shapeError(`${where}.focus_talk`, `outcome must be one of ${OUTCOMES.join(' | ')} or null`);
  }
  if (!Array.isArray(row.swaps)) throw shapeError(where, 'swaps must be an array');
}

async function readJsonl(filePath) {
  const text = await fs.readFile(filePath, 'utf8');
  if (!text.endsWith('\n')) throw shapeError(filePath, 'must end with a newline');
  return text.slice(0, -1).split('\n').map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw shapeError(`${filePath}:${index + 1}`, error.message);
    }
  });
}

async function loadRun(runDir) {
  const run = JSON.parse(await fs.readFile(path.join(runDir, 'run.json'), 'utf8'));
  assertKeys(run, RUN_KEYS, `${runDir}/run.json`);
  if (run.completed !== true) throw shapeError(`${runDir}/run.json`, `the run did not complete (failure: ${JSON.stringify(run.failure)})`);
  if (run.write !== null) assertKeys(run.writing, WRITING_KEYS, `${runDir}/run.json.writing`);
  else if (run.writing !== null) throw shapeError(`${runDir}/run.json`, 'writing without write');
  const windows = await readJsonl(path.join(runDir, 'windows.jsonl'));
  if (windows.length !== WINDOW_COUNT) throw shapeError(`${runDir}/windows.jsonl`, `must have ${WINDOW_COUNT} lines, got ${windows.length}`);
  windows.forEach((row, index) => validateWindow(row, index, run, `${runDir}/windows.jsonl:${index + 1}`));
  const encounters = await readJsonl(path.join(runDir, 'encounters.jsonl'));
  encounters.forEach((row, index) => {
    const where = `${runDir}/encounters.jsonl:${index + 1}`;
    if (typeof row.initiator !== 'string' || typeof row.partner !== 'string') throw shapeError(where, 'initiator / partner must be ids');
    if (row.status === 'closed' && !OUTCOMES.includes(row.outcome)) throw shapeError(where, `a closed encounter needs an outcome, got ${row.outcome}`);
  });
  const started = windows.reduce((sum, row) => sum + row.conversations_started, 0);
  if (encounters.length !== started) throw shapeError(`${runDir}/encounters.jsonl`, `must list the ${started} started encounters, got ${encounters.length}`);
  const decisions = await readJsonl(path.join(runDir, 'decisions.jsonl'));
  decisions.forEach((row, index) => {
    const where = `${runDir}/decisions.jsonl:${index + 1}`;
    assertKeys(row, DECISION_KEYS, where);
    assertKeys(row.decided, ['action', 'target', 'line'], `${where}.decided`);
    if (row.trigger === 'conversation' && !OUTCOMES.includes(row.outcome)) throw shapeError(where, `a decision after a talk needs its outcome, got ${row.outcome}`);
  });
  return { dir: runDir, run, windows, encounters, decisions };
}

// ---------- judgment ----------

function windowFlags(row) {
  return {
    cut: row.traces_end === 0 && row.in_progress_end + row.approaching_end === 0,
    buzz: row.traces_end >= 6 || row.concurrent_encounters_peak >= 5,
    lack: row.friction_in_progress_end + row.friction_approaching_end === 0
  };
}

function judgeWindows(windows) {
  const flags = windows.map(windowFlags);
  const count = (key) => flags.filter((flag) => flag[key]).length;
  const total = flags.length;
  return {
    cut: { hit: count('cut') > 0, count: count('cut'), total },
    buzz: { hit: count('buzz') * 3 > total, count: count('buzz'), total },
    lack: { hit: count('lack') * 3 > total, count: count('lack'), total }
  };
}

// A window's focused talk as a comparable key: the pair and the outcome (null when the window has none or it
// did not close).
function focusKey(row) {
  const talk = row.focus_talk;
  if (talk === null || talk.outcome === null) return null;
  return `${talk.pair.join('|')}:${talk.outcome}`;
}

function sameFocusWindows(a, b) {
  return FIXED_WINDOWS.filter((index) => {
    const keyA = focusKey(a.windows[index - 1]);
    return keyA !== null && keyA === focusKey(b.windows[index - 1]);
  }).length;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// 決め打ち: null when the runs are not two per seed.
function judgeFixed(runs) {
  const bySeed = new Map();
  for (const entry of [...runs].sort((a, b) => a.run.started_at.localeCompare(b.run.started_at))) {
    if (!bySeed.has(entry.run.seed)) bySeed.set(entry.run.seed, []);
    bySeed.get(entry.run.seed).push(entry);
  }
  const seeds = [...bySeed.keys()].sort((a, b) => a - b);
  if (seeds.length < 2 || seeds.some((seed) => bySeed.get(seed).length !== 2)) {
    return { judged: false, reason: `種ごとに 2 本・種 2 つ以上が要る（${seeds.map((seed) => `種 ${seed}: ${bySeed.get(seed).length} 本`).join(' / ')}）` };
  }
  const perSeed = seeds.map((seed) => ({ seed, count: sameFocusWindows(...bySeed.get(seed)) }));
  const control = [];
  for (let i = 0; i < seeds.length; i += 1) {
    for (let j = i + 1; j < seeds.length; j += 1) {
      control.push({ seeds: [seeds[i], seeds[j]], count: sameFocusWindows(bySeed.get(seeds[i])[0], bySeed.get(seeds[j])[0]) });
    }
  }
  const seedMean = mean(perSeed.map((entry) => entry.count));
  const controlMean = mean(control.map((entry) => entry.count));
  return { judged: true, hit: seedMean >= 2 && seedMean >= controlMean + 1, perSeed, control, seedMean, controlMean };
}

// 単調: the windows that have a focused talk are compared (a talk still open at 15:00 has no outcome and never
// matches). null when fewer than MONOTONE_MIN_TALKS windows have one: the run is not judged.
function monotoneRun(windows) {
  const talks = windows.filter((row) => row.focus_talk !== null);
  if (talks.length < MONOTONE_MIN_TALKS) return null;
  const outcomes = talks.map((row) => row.focus_talk.outcome);
  return outcomes.every((outcome) => outcome !== null && outcome === outcomes[0]);
}

// 羅列: no encounter of generation 2+ in the run.
function listingRun(windows) {
  return !windows.some((row) => row.chain_lengths.some((generation) => generation >= 2));
}

function share(count, total) {
  return total ? count / total : null;
}

function percent(value) {
  return value === null ? '-' : `${(value * 100).toFixed(1)}%`;
}

// 同じ子への選び直し: the decisions after a talk that closed on 果たされた, made by a child whose wish was aimed at
// the partner; the share that aimed at the same child again.
function reselection(decisions) {
  const eligible = decisions.filter((row) => row.trigger === 'conversation' && row.outcome === '果たされた'
    && row.wish_before?.target.kind === 'child' && row.wish_before.target.id === row.partner_id);
  const same = eligible.filter((row) => row.decided.target.kind === 'child' && row.decided.target.id === row.partner_id);
  return { same: same.length, total: eligible.length };
}

function topPairs(encounters) {
  const counts = new Map();
  for (const row of encounters) {
    const key = [row.initiator, row.partner].sort().join('|');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const top = [...counts.values()].sort((a, b) => b - a).slice(0, PASS_TOP_PAIRS).reduce((sum, value) => sum + value, 0);
  return { top, total: encounters.length };
}

function passLines(runs, all) {
  const decisions = runs.flatMap((entry) => entry.decisions);
  const encounters = runs.flatMap((entry) => entry.encounters);
  const closed = encounters.filter((row) => row.status === 'closed');
  const again = reselection(decisions);
  // Pairs are counted per run: the same two children in two runs are two different pairs of a day.
  const pairs = runs.map((entry) => topPairs(entry.encounters)).reduce((acc, value) => ({ top: acc.top + value.top, total: acc.total + value.total }), { top: 0, total: 0 });
  const fulfilled = closed.filter((row) => row.outcome === '果たされた').length;
  const againShare = share(again.same, again.total);
  const pairShare = share(pairs.top, pairs.total);
  const fulfilledShare = share(fulfilled, closed.length);
  const mark = (pass) => (pass ? '通る' : '通らない');
  return [
    `- 同じ子への選び直し: ${percent(againShare)}（${again.same} / ${again.total}）・線 ${PASS_RESELECTION_MAX * 100}% 以下 → ${mark(againShare !== null && againShare <= PASS_RESELECTION_MAX)}`,
    `- 上位 ${PASS_TOP_PAIRS} 組の出会い: ${percent(pairShare)}（${pairs.top} / ${pairs.total}）・線 ${PASS_TOP_PAIRS_MAX * 100}% 以下 → ${mark(pairShare !== null && pairShare <= PASS_TOP_PAIRS_MAX)}`,
    `- 閉じた会話の果たされた: ${percent(fulfilledShare)}（${fulfilled} / ${closed.length}）・線 ${PASS_FULFILLED_MIN * 100}% 以上 ${PASS_FULFILLED_MAX * 100}% 以下 → ${mark(fulfilledShare !== null && fulfilledShare >= PASS_FULFILLED_MIN && fulfilledShare <= PASS_FULFILLED_MAX)}`,
    `- 山の欠け: ${all.lack.hit ? '当たる' : '当たらない'}（${all.lack.count} / ${all.lack.total}）・線 当たらない → ${mark(!all.lack.hit)}`,
    `- 途切れ・ざわつき: 途切れ ${all.cut.hit ? '当たる' : '当たらない'}（${all.cut.count} / ${all.cut.total}）・ざわつき ${all.buzz.hit ? '当たる' : '当たらない'}（${all.buzz.count} / ${all.buzz.total}）・線 どちらも当たらない → ${mark(!all.cut.hit && !all.buzz.hit)}`
  ];
}

function verdictLabel(judged) {
  const hits = [['cut', '途切れ'], ['buzz', 'ざわつき'], ['lack', '山の欠け']].filter(([key]) => judged[key].hit).map(([, label]) => label);
  return hits.length ? hits.join('・') : 'ほどよい';
}

function histogram(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => a[0] - b[0]);
}

function pad(value, width) {
  const text = String(value);
  return text + ' '.repeat(Math.max(0, width - [...text].length));
}

function table(header, rows) {
  const widths = header.map((cell, index) => Math.max(...[cell, ...rows.map((row) => row[index])].map((value) => [...String(value)].length)));
  const line = (cells) => `| ${cells.map((cell, index) => pad(cell, widths[index])).join(' | ')} |`;
  return [line(header), `|${widths.map((width) => '-'.repeat(width + 2)).join('|')}|`, ...rows.map(line)].join('\n');
}

function judgeOverlookRuns(runs) {
  const out = [];
  out.push('## run ごと・窓ごと');
  out.push(table(
    ['run', '種', '窓', '学院', '始', '閉', '果/断/別', '閉 focus', '閉 軽い', '湧き', '同時peak', '連鎖max', '跡end', '進行end', '接近end', 'ぶつかる end', 'call', 'req', '占有', '送り出し', '判定'],
    runs.flatMap(({ run, windows }) => windows.map((row) => {
      const flags = windowFlags(row);
      const closed = row.conversations_closed;
      const marks = [flags.cut && '途切れ', flags.buzz && 'ざわつき', flags.lack && '山の欠け'].filter(Boolean);
      return [
        run.run_id, run.seed, row.window, `${row.academy_from}-${row.academy_to}`, row.conversations_started, closed.total,
        OUTCOMES.map((outcome) => closed.outcomes[outcome]).join('/'), closed.focus.total, closed.offscreen.total,
        row.spring_encounters_started, row.concurrent_encounters_peak, Math.max(0, ...row.chain_lengths), row.traces_end,
        row.in_progress_end, row.approaching_end, row.friction_in_progress_end + row.friction_approaching_end,
        row.lm_calls.total, row.lm_calls.lm_requests, row.lm_occupancy, row.swaps.length, marks.join('・') || '-'
      ];
    }))
  ));

  out.push('', '## 判定');
  const all = judgeWindows(runs.flatMap(({ windows }) => windows));
  out.push(`- 途切れ: ${all.cut.hit ? '当たる' : '当たらない'}（該当窓 ${all.cut.count} / ${all.cut.total}・1 窓でもあれば当たる）`);
  out.push(`- ざわつき: ${all.buzz.hit ? '当たる' : '当たらない'}（該当窓 ${all.buzz.count} / ${all.buzz.total}・3 分の 1 を超えれば当たる）`);
  out.push(`- 山の欠け: ${all.lack.hit ? '当たる' : '当たらない'}（該当窓 ${all.lack.count} / ${all.lack.total}・3 分の 1 を超えれば当たる）`);
  const fixed = judgeFixed(runs);
  const monotoneJudged = runs.filter(({ windows }) => monotoneRun(windows) !== null);
  const monotone = monotoneJudged.filter(({ windows }) => monotoneRun(windows)).length;
  const monotoneHit = monotoneJudged.length > 0 && monotone * 5 >= monotoneJudged.length * 2;
  const listing = runs.filter(({ windows }) => listingRun(windows)).length;
  const listingHit = listing * 5 >= runs.length * 3;
  const listingSplit = listing > 0 && listing < runs.length;
  if (fixed.judged) {
    out.push(`- 決め打ち: ${fixed.hit ? '当たる' : '当たらない'}（種ごとの数の平均 ${fixed.seedMean.toFixed(2)}・対照 ${fixed.control.length} 組の平均 ${fixed.controlMean.toFixed(2)}・平均 2 以上かつ対照より 1 以上多ければ当たる）`);
  } else {
    out.push(`- 決め打ち: 判定しない（${fixed.reason}）`);
  }
  if (monotoneJudged.length) {
    out.push(`- 単調: ${monotoneHit ? '当たる' : '当たらない'}（フォーカスされた会話の結末が全部同じ型の run ${monotone} / ${monotoneJudged.length}・5 本中 2 本以上の割合で当たる）`);
  } else {
    out.push(`- 単調: 判定しない（フォーカスされた会話が ${MONOTONE_MIN_TALKS} 本以上ある run が無い）`);
  }
  out.push(`- 単調の数え方: 代表の会話が無い窓は外し、残りの代表で比べる。代表が ${MONOTONE_MIN_TALKS} 本未満の run は判定から外す（外した run ${runs.length - monotoneJudged.length} / ${runs.length}${runs.filter(({ windows }) => monotoneRun(windows) === null).map(({ run, windows }) => `・${run.run_id}: 代表 ${windows.filter((row) => row.focus_talk !== null).length} 本`).join('')}）`);
  out.push(`- 決め打ちの数え方: 代表の会話が無い窓は「一致しない」と数える（窓 ${FIXED_WINDOWS[0]}〜${FIXED_WINDOWS.at(-1)} で代表の無い窓 ${runs.reduce((sum, { windows }) => sum + FIXED_WINDOWS.filter((index) => windows[index - 1].focus_talk === null).length, 0)}）`);
  out.push(`- 羅列: ${listingHit ? '当たる' : '当たらない'}（2 代目以上の出会いが 1 本も無い run ${listing} / ${runs.length}・5 本中 3 本以上の割合で当たる）${listingSplit ? '・割れた（種を 10 に増やす）' : ''}`);
  const others = !all.cut.hit && !all.buzz.hit && !all.lack.hit && !monotoneHit && !listingHit;
  if (fixed.judged) {
    out.push(`- ほどよい: ${others && !fixed.hit ? '当たる' : '当たらない'}`);
  } else {
    out.push(`- ほどよい: ${others ? '決め打ちを除いて当たる' : '当たらない'}（決め打ちは判定していない）`);
  }
  const writingRuns = runs.filter(({ run }) => run.write !== null);
  if (writingRuns.length) {
    const reached = writingRuns.filter(({ run }) => run.writing.chain_max_depth >= 2).length;
    out.push(`- 書き込み: ${reached * 5 >= writingRuns.length * 3 ? '満たす' : '満たさない'}（書き込みの連鎖が 2 代目以上の run ${reached} / ${writingRuns.length}・5 本中 3 本以上の割合で満たす）`);
  } else {
    out.push('- 書き込み: 対象の run なし');
  }
  const perRun = runs.map(({ run, windows }) => ({ run, label: verdictLabel(judgeWindows(windows)) }));
  const labels = new Set(perRun.map((entry) => entry.label));
  out.push(`- 種の間: ${labels.size > 1 ? '割れた（種を 5 つ足して 10 本で判定する）' : '揃った'}（${perRun.map(({ run, label }) => `種 ${run.seed}: ${label}`).join(' / ')}）`);
  for (const { run } of writingRuns) {
    const writing = run.writing;
    out.push(`  - 書き込み ${run.run_id}: 「${writing.text}」@${writing.place_id}・種にした子 ${writing.children_seeded.length}・種にした出会い ${writing.seeded_encounters}・連鎖の長さ ${writing.chain_max_depth}`);
  }

  out.push('', '## 通過の線（直しの段）');
  out.push(...passLines(runs, all));

  if (fixed.judged) {
    out.push('', '## 決め打ち（窓 3〜6 のフォーカスされた会話で、組と結末の型が一致した窓の数）');
    out.push(table(['種', '一致した窓'], fixed.perSeed.map((entry) => [entry.seed, entry.count])));
    out.push('', '対照（各種の 1 回目の run どうし）');
    out.push(table(['種の組', '一致した窓'], fixed.control.map((entry) => [entry.seeds.join(' と '), entry.count])));
  }

  out.push('', '## フォーカスされた会話（窓ごとに 1 本: その窓の中で最初に開いた会話）');
  out.push(table(
    ['run', '種', '窓', '組', '型', '会話の種'],
    runs.flatMap(({ run, windows }) => {
      const names = new Map([...run.roster, ...run.swaps.map((swap) => swap.arriving)].map((entry) => [entry.character_id, entry.character_name]));
      return windows.map((row) => {
        const talk = row.focus_talk;
        if (talk === null) return [run.run_id, run.seed, row.window, '-', 'なし', '-'];
        return [run.run_id, run.seed, row.window, talk.pair.map((id) => names.get(id) ?? id).join(' と '), talk.outcome ?? '閉じず', talk.seed_line];
      });
    })
  ));

  out.push('', '## 連鎖の代の分布（出会い 1 つあたり・全 run）');
  const generations = runs.flatMap(({ windows }) => windows.flatMap((row) => row.chain_lengths));
  out.push(table(['代', '出会い'], [['1 代目', generations.filter((value) => value === 1).length], ['2 代目以上', generations.filter((value) => value >= 2).length]]));

  out.push('', '## 引き継ぎ数の分布（閉じた会話 1 本あたり・全 run）');
  const handoffs = runs.flatMap(({ windows }) => windows.flatMap((row) => row.handoffs));
  const handoffRows = [0, 1, 2].map((value) => [
    value,
    handoffs.filter((entry) => entry.handoffs === value).length,
    handoffs.filter((entry) => entry.handoffs === value && entry.handling === 'focus').length,
    handoffs.filter((entry) => entry.handoffs === value && entry.handling === 'offscreen').length
  ]);
  out.push(table(['引き継ぎ', '会話', 'うち focus', 'うち 軽い'], handoffRows));

  out.push('', '## 連鎖の長さの分布（出会い 1 つあたり・全 run）');
  const chains = runs.flatMap(({ windows }) => windows.flatMap((row) => row.chain_lengths));
  out.push(table(['代', '出会い'], histogram(chains)));
  return out.join('\n');
}

const [, , ...runDirs] = process.argv;
if (runDirs.length === 0) throw new Error('usage: overlook-eval-judge.mjs <run dir>...');
const runs = [];
for (const runDir of runDirs) runs.push(await loadRun(path.resolve(runDir)));
process.stdout.write(`${judgeOverlookRuns(runs)}\n`);
