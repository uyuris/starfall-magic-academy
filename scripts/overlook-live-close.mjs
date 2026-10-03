#!/usr/bin/env node
// 星見の窓 (overlook): does a watched two-child talk close on real LM lines, and does the same start flow
// differently each time? One run of this script, against the LM Studio in `app/config/lmstudio.json`:
//
//   1. Five talks from five different starts (pair・place・wishes・feelings): each one its own seed line
//      (generateSeed), then lines one at a time (runOverlookConversationTurn) until the outcome judgment closes
//      it, then both rewrites and both next wishes (the same order routingOverlook runs after a watched talk).
//   2. Five pairs: per start, one seed line and two talks from that same start and seed.
//
// It prints the tables (per talk: start, lines, outcome, where the full text is, full-text hash; per pair: both
// hashes, outcome match, next-wish action / target match) and the totals, the wall clock and the LM usage line.
// Full texts go to the gitignored data/mutable/overlook-live-close/<run time>/. A talk that throws is kept in the
// table with its error and its line count. This is a one-off measurement, not a test.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { selectableCharacterPromptProfile } from '../app/src/characterCatalog.mjs';
import { resolveCharacterSpeechConstraints } from '../app/src/llm/characterSpeechConstraints.mjs';
import { buildConversationActorContextSnapshot } from '../app/src/llm/conversationActorContext.mjs';
import { loadLmStudioConfig } from '../app/src/llm/lmStudioClient.mjs';
import { createOverlookGenerators } from '../app/src/llm/overlookGeneration.mjs';
import { createOverlookConversation, overlookConversationClosed, runOverlookConversationTurn } from '../app/src/overlookConversation.mjs';
import { loadOverlookFieldGraph } from '../app/src/overlookField.mjs';
import { createStorageApi } from '../app/src/storage.mjs';
import { loadWorldSettings } from '../app/src/worldSettings.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LM_CONFIG_PATH = path.join(ROOT, 'app/config/lmstudio.json');
const OUT_BASE = path.join(ROOT, 'data/mutable/overlook-live-close');
// The talk has no length cap in the product. This run stops a talk that has not closed by this many lines and
// reports it as a throw in the table, so a talk that never closes shows up instead of holding the shared LM.
const RUN_LINE_CEILING = 60;
const SHORT_CLOSE_LINES = 2;

// The 12 children the prompts may name (the wish prompt lists them as possible targets).
const ROSTER_IDS = Array.from({ length: 12 }, (_, index) => `character_${String(index + 1).padStart(3, '0')}`);

function wish(action, kind, id, line) {
  return { action, target: { kind, id }, line, generation: 1, source: { kind: 'spring', id: null }, expires_at_minute: 600 };
}

// The wish a child held, as the decision after the talk reads it.
function heldWish(held) {
  return held === null ? null : { action: held.action, target: held.target, line: held.line };
}

function concern(text) {
  return { text, source: { kind: 'spring', id: null }, generation: 1 };
}

function childState({ feelings = {}, concerns = [], mood, wish: childWish }) {
  return { feelings, concerns: concerns.map(concern), mood, wish: childWish };
}

// Five starts. `why` is the one-line reason the report carries. Starts A and B are ぶつかる組み合わせ
// (a 反発・負い目・気まずい feeling, and B's partner wants to avoid the initiator).
const STARTS = [
  {
    key: 'A',
    why: 'ぶつかる: 杖を壊された側が問いただしに行く。反発と負い目の向かい合わせで、断られる・別の決着が起こりうる。',
    initiator: 'character_007',
    partner: 'character_004',
    placeId: 'training_ground_runes',
    states: {
      character_007: childState({
        feelings: { character_004: { label: '反発', text: '試合前に預けた杖を割られた' } },
        concerns: ['次の試合までに杖が間に合わない'],
        mood: '苛立ち',
        wish: wish('会う', 'child', 'character_004', '割れた杖のわけを問いただしたい')
      }),
      character_004: childState({
        feelings: { character_007: { label: '負い目', text: '調整を急いで杖を割ってしまった' } },
        concerns: ['割った杖の直し方がまだ見えない'],
        mood: '不安',
        wish: wish('籠もる', 'place', 'magic_tool_workshop', '工房で杖の継ぎ目をやり直したい')
      })
    }
  },
  {
    key: 'B',
    why: 'ぶつかる: 相手が避けたい子のところへ確かめに来る（避ける＋気まずい）。果たされない形が出やすい出発。',
    initiator: 'character_012',
    partner: 'character_001',
    placeId: 'forbidden_archive_door',
    states: {
      character_012: childState({
        feelings: { character_001: { label: '関心', text: '封印の札に触れた跡の主かもしれない' } },
        concerns: ['禁書庫の扉の札が一枚ずれていた'],
        mood: '落ち着き',
        wish: wish('確かめる', 'child', 'character_001', '扉の札に触れたのか確かめたい')
      }),
      character_001: childState({
        feelings: { character_012: { label: '気まずい', text: '扉の前にいたところを見られた気がする' } },
        concerns: ['扉の向こうの星図がどうしても見たい'],
        mood: '不安',
        wish: wish('避ける', 'child', 'character_012', 'タリス先輩とは今は顔を合わせたくない')
      })
    }
  },
  {
    key: 'C',
    why: '穏やか: 好意同士で礼を伝えに行く。すんなり果たされる対照として置く。',
    initiator: 'character_003',
    partner: 'character_006',
    placeId: 'herbology_garden',
    states: {
      character_003: childState({
        feelings: { character_006: { label: '好意', text: '弱った芽のために護符を貸してくれた' } },
        concerns: ['借りた護符をまだ返していない'],
        mood: '落ち着き',
        wish: wish('会う', 'child', 'character_006', '護符のお礼をちゃんと伝えたい')
      }),
      character_006: childState({
        feelings: { character_003: { label: '好意', text: '薬草園で無理をしすぎていないか気になる' } },
        concerns: [],
        mood: '落ち着き',
        wish: wish('確かめる', 'place', 'herbology_garden', '薬草園の芽が持ち直したか見たい')
      })
    }
  },
  {
    key: 'D',
    why: '中立: 片側だけが関心を持ち、相手は何も抱えていない。問いが空振りしうる探しの出発。',
    initiator: 'character_008',
    partner: 'character_010',
    placeId: 'astronomy_tower_observatory',
    states: {
      character_008: childState({
        feelings: { character_010: { label: '関心', text: '雨の夜だけ観測記録がずれる原因かもしれない' } },
        concerns: ['昨夜の記録が三秒ずれた'],
        mood: '苛立ち',
        wish: wish('探す', 'child', 'character_010', '雨で記録が狂ったわけを聞きたい')
      }),
      character_010: childState({
        feelings: {},
        concerns: ['この学院の空にまだ慣れない'],
        mood: '高揚',
        wish: wish('籠もる', 'place', 'rooftop_wind_bells', '屋上で雨の匂いを確かめたい')
      })
    }
  },
  {
    key: 'E',
    why: '利害: 書類の不備を正す側と、申請が通るか不安な側。好意も反発もなく、実務の決着に寄りうる出発。',
    initiator: 'character_009',
    partner: 'character_011',
    placeId: 'student_council_room',
    states: {
      character_009: childState({
        feelings: { character_011: { label: '関心', text: '演奏会の申請書に空欄が三つある' } },
        concerns: ['今週中に申請書の束を閉じたい'],
        mood: '落ち着き',
        wish: wish('会う', 'child', 'character_011', '申請書の不備をその場で正したい')
      }),
      character_011: childState({
        feelings: { character_009: { label: '関心', text: '書記に目をつけられたらしい' } },
        concerns: ['演奏会の申請が通るか不安'],
        mood: '不安',
        wish: wish('確かめる', 'place', 'student_council_room', '申請が受理されたか確かめたい')
      })
    }
  }
];

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function transcriptText(messages) {
  return messages.map((message) => `${message.speaker_name}: ${message.content}`).join('\n');
}

function runStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function cell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// Every LM request goes through this fetch, so the run can say how many it made.
function countingFetch(usage) {
  return (url, init) => {
    usage.requests += 1;
    return fetch(url, init);
  };
}

// The time spent inside the generator calls: every LM request, streamed bodies included, and nothing else.
function timedGenerators(generators, usage) {
  return Object.fromEntries(Object.entries(generators).map(([name, generate]) => [name, async (input) => {
    const started = Date.now();
    try {
      return await generate(input);
    } finally {
      usage.ms += Date.now() - started;
    }
  }]));
}

async function probeModels(baseUrl) {
  const started = Date.now();
  const response = await fetch(`${baseUrl}/models`);
  const body = await response.json();
  if (!response.ok) throw new Error(`LM Studio /models answered HTTP ${response.status}`);
  return `/v1/models HTTP ${response.status}・${body.data.length} models・${Date.now() - started}ms`;
}

async function loadContext() {
  const config = await loadLmStudioConfig(LM_CONFIG_PATH);
  const storage = createStorageApi({ root: ROOT });
  const locations = await storage.readJson('game_data/locations.json');
  const graph = await loadOverlookFieldGraph({ root: ROOT });
  const placeNames = new Map();
  const placeSituations = new Map();
  for (const place of graph.places) {
    const location = locations.find((entry) => entry.id === place.location_id);
    if (!location?.display_name) throw new Error(`overlook place has no display name in locations.json: ${place.location_id}`);
    placeNames.set(place.location_id, location.display_name);
    placeSituations.set(place.location_id, location.visible_situation);
  }
  const profiles = new Map();
  const names = new Map();
  for (const id of ROSTER_IDS) {
    const profile = await selectableCharacterPromptProfile({ root: ROOT, characterId: id });
    profiles.set(id, profile);
    names.set(id, profile.display_name);
  }
  const world = await loadWorldSettings({ root: ROOT });
  const characterSpeechConstraints = await resolveCharacterSpeechConstraints({ root: ROOT, chatModel: config.chat_model });
  return { config, graph, placeNames, placeSituations, profiles, names, world, characterSpeechConstraints };
}

function descriptor(context, id) {
  return { id, name: context.names.get(id), profile: context.profiles.get(id) };
}

function lookups(context) {
  return { nameOf: (id) => context.names.get(id), placeNameOf: (id) => context.placeNames.get(id) };
}

async function raiseSeed({ context, generators, start }) {
  const seed = await generators.generateSeed({
    initiator: descriptor(context, start.initiator),
    partner: descriptor(context, start.partner),
    states: start.states,
    placeId: start.placeId,
    ...lookups(context)
  });
  return seed.line;
}

function wishSummary(context, decided) {
  const target = decided.target.kind === 'child' ? context.names.get(decided.target.id) : context.placeNames.get(decided.target.id);
  return { action: decided.action, target_kind: decided.target.kind, target_id: decided.target.id, target_name: target, line: decided.line };
}

// One watched talk from `start` on `seedLine`, then (if it closed) both rewrites and both next wishes.
async function runTalk({ context, generators, start, seedLine, runId, outDir }) {
  const started = Date.now();
  const { nameOf, placeNameOf } = lookups(context);
  const actorContexts = new Map();
  let record = createOverlookConversation({
    id: runId,
    encounterId: `enc_${runId}`,
    placeId: start.placeId,
    locationName: context.placeNames.get(start.placeId),
    seedLine,
    initiator: { id: start.initiator, name: context.names.get(start.initiator) },
    partner: { id: start.partner, name: context.names.get(start.partner) },
    generation: 1,
    fromWriting: false
  });
  const inputs = async (speaker) => {
    if (!actorContexts.has(speaker.id)) {
      actorContexts.set(speaker.id, await buildConversationActorContextSnapshot({
        root: ROOT,
        actor: { kind: 'character', id: speaker.id },
        profile: context.profiles.get(speaker.id)
      }));
    }
    return {
      profile: context.profiles.get(speaker.id),
      scene: {
        academy_name: context.world.academy_name,
        world_description: context.world.world_description,
        player_name: context.world.player_name,
        player_parameters: context.world.player_parameters,
        location_name: record.location_name,
        visible_situation: context.placeSituations.get(record.place_id)
      },
      conversationActorContext: actorContexts.get(speaker.id),
      speakerState: start.states[speaker.id]
    };
  };
  const result = { run_id: runId, start: start.key, seed_line: seedLine, error: null, rewrites: {}, next_wishes: {} };
  try {
    while (!overlookConversationClosed(record)) {
      if (record.messages.length >= RUN_LINE_CEILING) throw new Error(`the talk did not close within ${RUN_LINE_CEILING} lines`);
      record = await runOverlookConversationTurn({
        record,
        generators,
        inputs,
        initiatorWish: start.states[start.initiator].wish,
        nameOf,
        placeNameOf
      });
      const last = record.messages[record.messages.length - 1];
      process.stderr.write(`[${runId}] ${record.messages.length}: ${last.speaker_name} → ${last.outcome}\n`);
    }
    const history = record.messages.map((message) => ({ speaker_name: message.speaker_name, content: message.content }));
    const roster = ROSTER_IDS.map((id) => ({ id, name: context.names.get(id) }));
    const places = context.graph.places.map((place) => ({ id: place.location_id, name: context.placeNames.get(place.location_id) }));
    for (const [selfId, partnerId] of [[start.initiator, start.partner], [start.partner, start.initiator]]) {
      result.rewrites[selfId] = await generators.rewriteState({
        self: descriptor(context, selfId),
        partner: descriptor(context, partnerId),
        state: start.states[selfId],
        locationName: record.location_name,
        history,
        outcome: record.outcome,
        nameOf,
        placeNameOf
      });
    }
    for (const [selfId, partnerId] of [[start.initiator, start.partner], [start.partner, start.initiator]]) {
      const rewrite = result.rewrites[selfId];
      const rewritten = {
        ...start.states[selfId],
        feelings: { ...start.states[selfId].feelings, [partnerId]: { label: rewrite.feeling_label, text: rewrite.feeling_text } },
        concerns: rewrite.concerns.map(concern),
        mood: rewrite.mood
      };
      const decided = await generators.decideWish({
        child: descriptor(context, selfId),
        state: rewritten,
        placeId: start.placeId,
        trigger: {
          kind: 'conversation',
          partner_id: partnerId,
          initiator_id: start.initiator,
          outcome: record.outcome,
          initiator_wish: heldWish(start.states[start.initiator].wish),
          wish: heldWish(start.states[selfId].wish),
          talk: { kind: 'focus', history }
        },
        roster,
        places,
        nameOf,
        placeNameOf
      });
      result.next_wishes[selfId] = wishSummary(context, decided);
    }
  } catch (error) {
    result.error = error.message;
  }
  const transcript = transcriptText(record.messages);
  Object.assign(result, {
    lines: record.messages.length,
    outcome: record.outcome,
    transcript_sha256: sha256(transcript),
    wall_ms: Date.now() - started,
    messages: record.messages,
    judgments: record.judgments
  });
  const file = path.join(outDir, `${runId}.json`);
  await fs.writeFile(file, `${JSON.stringify({ ...result, transcript }, null, 2)}\n`);
  result.file = path.relative(ROOT, file);
  return result;
}

function startLabel(context, start) {
  return `${start.key}: ${context.names.get(start.initiator)}→${context.names.get(start.partner)}・${context.placeNames.get(start.placeId)}・${start.states[start.initiator].wish.action}「${start.states[start.initiator].wish.line}」`;
}

function outcomeCell(result) {
  return result.error ? `throw: ${result.error}` : result.outcome;
}

function wishCell(wishValue) {
  return wishValue ? `${wishValue.action}→${wishValue.target_name}` : '—';
}

function nextWishMatch(context, start, first, second) {
  return [start.initiator, start.partner].map((id) => {
    const a = first.next_wishes[id];
    const b = second.next_wishes[id];
    if (!a || !b) return `${context.names.get(id)}: 比較不能`;
    const action = a.action === b.action ? '一致' : '不一致';
    const target = a.target_kind === b.target_kind && a.target_id === b.target_id ? '一致' : '不一致';
    return `${context.names.get(id)}: 種類 ${action}（${a.action}/${b.action}）・相手 ${target}（${a.target_name}/${b.target_name}）`;
  }).join('<br>');
}

async function main() {
  const wallStarted = Date.now();
  const context = await loadContext();
  const usage = { requests: 0, ms: 0 };
  const generators = timedGenerators(
    createOverlookGenerators({ config: context.config, characterSpeechConstraints: context.characterSpeechConstraints, fetchImpl: countingFetch(usage) }),
    usage
  );
  const modelsBefore = await probeModels(context.config.base_url);
  const outDir = path.join(OUT_BASE, runStamp(new Date(wallStarted)));
  await fs.mkdir(outDir, { recursive: true });

  const singles = [];
  for (const start of STARTS) {
    const runId = `single_${start.key}`;
    let seedLine = null;
    try {
      seedLine = await raiseSeed({ context, generators, start });
    } catch (error) {
      singles.push({ run_id: runId, start: start.key, error: `seed: ${error.message}`, lines: 0, outcome: null, transcript_sha256: '—', file: '—', next_wishes: {} });
      continue;
    }
    singles.push(await runTalk({ context, generators, start, seedLine, runId, outDir }));
  }

  const pairs = [];
  for (const start of STARTS) {
    let seedLine = null;
    try {
      seedLine = await raiseSeed({ context, generators, start });
    } catch (error) {
      pairs.push({ start, error: `seed: ${error.message}`, runs: [] });
      continue;
    }
    const runs = [];
    for (const index of [1, 2]) runs.push(await runTalk({ context, generators, start, seedLine, runId: `pair_${start.key}_${index}`, outDir }));
    pairs.push({ start, seed_line: seedLine, runs });
  }
  const modelsAfter = await probeModels(context.config.base_url);
  const wallMs = Date.now() - wallStarted;

  const allTalks = [...singles, ...pairs.flatMap((pair) => pair.runs)];
  const out = [];
  out.push(`# overlook-live-close run ${runStamp(new Date(wallStarted))}`);
  out.push('');
  out.push(`- LM: ${context.config.base_url}・chat ${context.config.chat_model}・reflection ${context.config.reflection_model}`);
  out.push(`- 全文の置き場: ${path.relative(ROOT, outDir)}/`);
  out.push('');
  out.push('## 出発状態');
  out.push('');
  for (const start of STARTS) out.push(`- ${startLabel(context, start)} — ${start.why}`);
  out.push('');
  out.push('## (1)(2) 出発状態の異なる 5 本');
  out.push('');
  out.push('| 本 | 出発状態 | 種 | 発言数 | 結末の型 | 全文の置き場 | 全文 hash (sha256 先頭16) | 所要 |');
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const result of singles) {
    const start = STARTS.find((entry) => entry.key === result.start);
    out.push(`| ${result.run_id} | ${cell(startLabel(context, start))} | ${cell(result.seed_line ?? '—')} | ${result.lines} | ${cell(outcomeCell(result))} | ${result.file} | ${result.transcript_sha256.slice(0, 16)} | ${result.wall_ms === undefined ? '—' : seconds(result.wall_ms)} |`);
  }
  out.push('');
  out.push('## (3) 同じ出発状態・同じ種の 2 回 × 5 組');
  out.push('');
  out.push('| 組 | 種 | 1 回目: 発言数・結末・hash | 2 回目: 発言数・結末・hash | hash | 結末の型 | 次のしたいこと（1回目 / 2回目） | 種類・相手の一致 |');
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  let differingPairs = 0;
  let outcomeMatches = 0;
  for (const pair of pairs) {
    if (pair.runs.length !== 2) {
      out.push(`| ${pair.start.key} | throw: ${cell(pair.error)} | — | — | — | — | — | — |`);
      continue;
    }
    const [first, second] = pair.runs;
    const differ = first.transcript_sha256 !== second.transcript_sha256;
    if (differ) differingPairs += 1;
    const sameOutcome = !first.error && !second.error && first.outcome === second.outcome;
    if (sameOutcome) outcomeMatches += 1;
    const runCell = (result) => `${result.lines}・${cell(outcomeCell(result))}・${result.transcript_sha256.slice(0, 16)}`;
    const wishes = [pair.start.initiator, pair.start.partner]
      .map((id) => `${context.names.get(id)}: ${wishCell(first.next_wishes[id])} / ${wishCell(second.next_wishes[id])}`)
      .join('<br>');
    out.push(`| ${pair.start.key} | ${cell(pair.seed_line)} | ${runCell(first)} | ${runCell(second)} | ${differ ? '異なる' : '同一'} | ${sameOutcome ? '一致' : '不一致'} | ${cell(wishes)} | ${nextWishMatch(context, pair.start, first, second)} |`);
  }
  out.push('');
  out.push('## 次のしたいこと（5 本）');
  out.push('');
  for (const result of singles) {
    const start = STARTS.find((entry) => entry.key === result.start);
    const wishes = [start.initiator, start.partner].map((id) => {
      const next = result.next_wishes[id];
      return next ? `${context.names.get(id)} ${next.action}→${next.target_name}「${next.line}」` : `${context.names.get(id)} —`;
    });
    out.push(`- ${result.run_id}: ${wishes.join(' / ')}`);
  }
  out.push('');
  const throws = allTalks.filter((result) => result.error);
  out.push('## 合計');
  out.push('');
  out.push(`- 会話の本数: ${allTalks.length}（5 本 + 2 回 × 5 組）`);
  out.push(`- throw の本数: ${throws.length}`);
  for (const result of throws) out.push(`  - ${result.run_id}: ${result.error}（発言数 ${result.lines}）`);
  out.push(`- 2 発言以内で閉じた本数: ${allTalks.filter((result) => !result.error && result.outcome && result.lines <= SHORT_CLOSE_LINES).length} / ${allTalks.length}`);
  out.push(`- hash が異なる組の数: ${differingPairs} / ${pairs.length}`);
  out.push(`- 結末の型が一致した組の数: ${outcomeMatches} / ${pairs.length}`);
  out.push(`- 結末の型の内訳: ${['果たされた', '断られた', '別の決着'].map((outcome) => `${outcome} ${allTalks.filter((result) => result.outcome === outcome).length}`).join('・')}`);
  out.push('');
  out.push('## 所要と LM の使用状況');
  out.push('');
  out.push(`- 所要（壁時計）: ${seconds(wallMs)}`);
  out.push(`- LM の使用状況: 開始時 ${modelsBefore} / 終了時 ${modelsAfter}・この run の LM request ${usage.requests} 件・generator 呼び出しの中の時間 ${seconds(usage.ms)}（壁時計の ${((usage.ms / wallMs) * 100).toFixed(0)}%）・1 request 平均 ${usage.requests ? seconds(usage.ms / usage.requests) : '—'}（直列）`);
  const summary = `${out.join('\n')}\n`;
  await fs.writeFile(path.join(outDir, 'summary.md'), summary);
  process.stdout.write(summary);
}

await main();
