import { createStorageApi } from './storage.mjs';
import { loadWorldSettings, updatePlayerParameters } from './worldSettings.mjs';
import { abilityParameterDefinitions, magicParameterDefinitions, normalizeParameters } from './parameters.mjs';
import {
  ROUTING_CONTENT_RESULT_STATE_KEY,
  ROUTING_TRAINING_WEEK_ACCUMULATOR_STATE_KEY,
  buildTrainingContentResult,
  foldTrainingDayIntoAccumulator,
  requireRoutingContentWeek
} from './routingContentResult.mjs';

export const TRAINING_ACTION_LIMIT = 6;

export const trainingWeekdays = [
  { index: 0, id: 'light_day', name: '光曜', element: 'light', element_label: '光' },
  { index: 1, id: 'dark_day', name: '闇曜', element: 'dark', element_label: '闇' },
  { index: 2, id: 'fire_day', name: '火曜', element: 'fire', element_label: '火' },
  { index: 3, id: 'water_day', name: '水曜', element: 'water', element_label: '水' },
  { index: 4, id: 'earth_day', name: '土曜', element: 'earth', element_label: '土' },
  { index: 5, id: 'wind_day', name: '風曜', element: 'wind', element_label: '風' }
];

export const trainingDefinitions = [
  { id: 'physical_drills', name: '体術トレーニング', element: 'earth', description: '学院の演習場で走り込みと基礎体術を行う。筋力と瞬発力がそれぞれ50%で1上がる。50%で魔力が1下がる。土曜は対応属性効果が倍になる。', increases: [{ group: 'abilities', key: 'strength', min: 4, max: 8 }, { group: 'abilities', key: 'agility', min: 3, max: 7 }], decrease: { group: 'abilities', key: 'magical_power', chance: 0.5, amount: 1 } },
  { id: 'library_study', name: '図書塔で座学', element: 'light', description: '古書と講義ノートを読み込む。学力と光魔法がそれぞれ50%で1上がる。50%で筋力が1下がる。光曜は光魔法の効果が倍になる。', increases: [{ group: 'abilities', key: 'academics', min: 4, max: 8 }, { group: 'magic', key: 'light', min: 2, max: 5 }], decrease: { group: 'abilities', key: 'strength', chance: 0.5, amount: 1 } },
  { id: 'mana_control', name: '魔力制御練習', element: 'water', description: '星灯石を使って魔力の出力を安定させる。魔力と水・風がそれぞれ50%で1上がる。50%で筋力が1下がる。水曜は水魔法の効果が倍になる。', increases: [{ group: 'abilities', key: 'magical_power', min: 4, max: 8 }, { group: 'magic', key: 'water', min: 2, max: 5 }, { group: 'magic', key: 'wind', min: 2, max: 5 }], decrease: { group: 'abilities', key: 'strength', chance: 0.5, amount: 1 } },
  { id: 'elemental_sparring', name: '属性模擬戦', element: 'fire', description: '火・土・闇の術式を実戦形式で回す。火・土・闇がそれぞれ50%で1上がる。50%でカリスマが1下がる。火曜は火魔法の効果が倍になる。', increases: [{ group: 'magic', key: 'fire', min: 3, max: 7 }, { group: 'magic', key: 'earth', min: 3, max: 7 }, { group: 'magic', key: 'dark', min: 2, max: 5 }], decrease: { group: 'abilities', key: 'charisma', chance: 0.5, amount: 1 } },
  { id: 'salon_practice', name: '交流サロン実践', element: 'wind', description: '先輩や同級生と交渉・発表練習を行う。カリスマと学力がそれぞれ50%で1上がる。50%で闇魔法が1下がる。風曜は対応属性効果が倍になる。', increases: [{ group: 'abilities', key: 'charisma', min: 4, max: 8 }, { group: 'abilities', key: 'academics', min: 2, max: 5 }], decrease: { group: 'magic', key: 'dark', chance: 0.5, amount: 1 } },
  { id: 'healing_practice', name: '治癒魔法実習', element: 'light', description: '光の治癒術式を反復し、細かな魔力出力を整える。光魔法と魔力がそれぞれ50%で1上がる。50%で闇魔法が1下がる。光曜は光魔法の効果が倍になる。', increases: [{ group: 'magic', key: 'light', min: 3, max: 7 }, { group: 'abilities', key: 'magical_power', min: 2, max: 5 }], decrease: { group: 'magic', key: 'dark', chance: 0.5, amount: 1 } },
  { id: 'shadow_control', name: '影制御訓練', element: 'dark', description: '影を薄く伸ばして形を保つ訓練。闇魔法と魔力がそれぞれ50%で1上がる。50%で光魔法が1下がる。闇曜は闇魔法の効果が倍になる。', increases: [{ group: 'magic', key: 'dark', min: 3, max: 7 }, { group: 'abilities', key: 'magical_power', min: 2, max: 5 }], decrease: { group: 'magic', key: 'light', chance: 0.5, amount: 1 } },
  { id: 'flame_focus', name: '火球集中練習', element: 'fire', description: '小さな火球を安定して維持する。火魔法と瞬発力がそれぞれ50%で1上がる。50%で水魔法が1下がる。火曜は火魔法の効果が倍になる。', increases: [{ group: 'magic', key: 'fire', min: 3, max: 7 }, { group: 'abilities', key: 'agility', min: 2, max: 5 }], decrease: { group: 'magic', key: 'water', chance: 0.5, amount: 1 } },
  { id: 'water_meditation', name: '水鏡瞑想', element: 'water', description: '水面に魔力を映して呼吸を整える。水魔法と学力がそれぞれ50%で1上がる。50%で火魔法が1下がる。水曜は水魔法の効果が倍になる。', increases: [{ group: 'magic', key: 'water', min: 3, max: 7 }, { group: 'abilities', key: 'academics', min: 2, max: 5 }], decrease: { group: 'magic', key: 'fire', chance: 0.5, amount: 1 } },
  { id: 'earth_barrier', name: '土壁構築演習', element: 'earth', description: '土壁を素早く立てて保持する。土魔法と筋力がそれぞれ50%で1上がる。50%で風魔法が1下がる。土曜は土魔法の効果が倍になる。', increases: [{ group: 'magic', key: 'earth', min: 3, max: 7 }, { group: 'abilities', key: 'strength', min: 2, max: 5 }], decrease: { group: 'magic', key: 'wind', chance: 0.5, amount: 1 } },
  { id: 'wind_step', name: '風歩法トレーニング', element: 'wind', description: '風を足場にして短距離の踏み込みを反復する。風魔法と瞬発力がそれぞれ50%で1上がる。50%で土魔法が1下がる。風曜は風魔法の効果が倍になる。', increases: [{ group: 'magic', key: 'wind', min: 3, max: 7 }, { group: 'abilities', key: 'agility', min: 3, max: 6 }], decrease: { group: 'magic', key: 'earth', chance: 0.5, amount: 1 } },
  { id: 'ritual_research', name: '儀式魔法研究', element: 'dark', description: '複数属性の術式構造を研究する。学力は50%、光・闇は10%で1上がる。50%で瞬発力が1下がる。闇曜は闇魔法の効果が倍になる。', increases: [{ group: 'abilities', key: 'academics', min: 3, max: 7 }, { group: 'magic', key: 'light', min: 2, max: 4 }, { group: 'magic', key: 'dark', min: 2, max: 4 }], decrease: { group: 'abilities', key: 'agility', chance: 0.5, amount: 1 } },
  { id: 'artifact_appraisal', name: '魔導具鑑定演習', element: 'light', description: '古い魔導具の紋様と魔力残響を読み解く。学力と光魔法がそれぞれ50%で1上がる。50%でカリスマが1下がる。光曜は光魔法の効果が倍になる。', increases: [{ group: 'abilities', key: 'academics', min: 4, max: 8 }, { group: 'magic', key: 'light', min: 3, max: 6 }], decrease: { group: 'abilities', key: 'charisma', chance: 0.5, amount: 1 } },
  { id: 'barrier_weaving', name: '結界編み込み実習', element: 'earth', description: '透明な結界糸を重ねて衝撃を受け止める。土魔法と魔力がそれぞれ50%で1上がる。50%で火魔法が1下がる。土曜は土魔法の効果が倍になる。', increases: [{ group: 'magic', key: 'earth', min: 3, max: 7 }, { group: 'abilities', key: 'magical_power', min: 3, max: 6 }], decrease: { group: 'magic', key: 'fire', chance: 0.5, amount: 1 } },
  { id: 'broom_flight', name: '箒飛行訓練', element: 'wind', description: '風を読んで低空旋回と急停止を反復する。風魔法と瞬発力がそれぞれ50%で1上がる。50%で筋力が1下がる。風曜は風魔法の効果が倍になる。', increases: [{ group: 'magic', key: 'wind', min: 3, max: 7 }, { group: 'abilities', key: 'agility', min: 4, max: 8 }], decrease: { group: 'abilities', key: 'strength', chance: 0.5, amount: 1 } },
  { id: 'familiar_bonding', name: '使い魔絆結び', element: 'wind', description: '小さな使い魔と呼吸を合わせて合図を交わす。カリスマと風魔法がそれぞれ50%で1上がる。50%で学力が1下がる。風曜は風魔法の効果が倍になる。', increases: [{ group: 'abilities', key: 'charisma', min: 4, max: 8 }, { group: 'magic', key: 'wind', min: 2, max: 5 }], decrease: { group: 'abilities', key: 'academics', chance: 0.5, amount: 1 } },
  { id: 'potion_brewing', name: '霊薬調合実習', element: 'water', description: '薬草と魔力水を温度管理しながら調合する。水魔法と学力がそれぞれ50%で1上がる。50%で瞬発力が1下がる。水曜は水魔法の効果が倍になる。', increases: [{ group: 'magic', key: 'water', min: 3, max: 7 }, { group: 'abilities', key: 'academics', min: 3, max: 6 }], decrease: { group: 'abilities', key: 'agility', chance: 0.5, amount: 1 } },
  { id: 'rune_calligraphy', name: 'ルーン筆写鍛錬', element: 'light', description: '発光インクで古代ルーンを正確に筆写する。光魔法と学力がそれぞれ50%で1上がる。50%で闇魔法が1下がる。光曜は光魔法の効果が倍になる。', increases: [{ group: 'magic', key: 'light', min: 3, max: 7 }, { group: 'abilities', key: 'academics', min: 3, max: 6 }], decrease: { group: 'magic', key: 'dark', chance: 0.5, amount: 1 } },
  { id: 'spirit_listening', name: '精霊傾聴訓練', element: 'dark', description: '薄暗い静室で精霊の気配と言葉の端を聴き分ける。闇魔法とカリスマがそれぞれ50%で1上がる。50%で筋力が1下がる。闇曜は闇魔法の効果が倍になる。', increases: [{ group: 'magic', key: 'dark', min: 3, max: 7 }, { group: 'abilities', key: 'charisma', min: 3, max: 6 }], decrease: { group: 'abilities', key: 'strength', chance: 0.5, amount: 1 } },
  { id: 'star_observation', name: '星詠み観測', element: 'light', description: '天文塔で星図と魔力潮汐を照合する。学力と光魔法がそれぞれ50%で1上がる。50%で水魔法が1下がる。光曜は光魔法の効果が倍になる。', increases: [{ group: 'abilities', key: 'academics', min: 4, max: 8 }, { group: 'magic', key: 'light', min: 2, max: 5 }], decrease: { group: 'magic', key: 'water', chance: 0.5, amount: 1 } }
];

const labels = {
  magic: Object.fromEntries(magicParameterDefinitions.map((definition) => [definition.key, definition.label])),
  abilities: Object.fromEntries(abilityParameterDefinitions.map((definition) => [definition.key, definition.label]))
};

function seededRandom(seed) {
  let state = Math.max(1, Math.floor(Number(seed) || 1)) % 2147483647;
  return () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
}

function oldAmountFor(effect, random) {
  return effect.min + Math.floor(random() * (effect.max - effect.min + 1));
}

function chanceForEffect(effect) {
  return Number(effect.max ?? 0) >= 5 ? 0.5 : 0.1;
}

function probabilisticUnitGain(effect, random) {
  const oldAmount = oldAmountFor(effect, random);
  const chance = chanceForEffect(effect);
  return { oldAmount, chance, amount: random() < chance ? 1 : 0 };
}

function valueOf(stat) {
  return Number(stat?.value ?? stat ?? 0);
}

function storageApiFor(rootOrStorage) {
  if (rootOrStorage && typeof rootOrStorage.readJson === 'function' && typeof rootOrStorage.writeJson === 'function') {
    return rootOrStorage;
  }
  return createStorageApi({ root: rootOrStorage });
}

function setValue(parameters, group, key, value) {
  parameters[group][key] = value;
}

async function loadRuntimeState(rootOrStorage) {
  return await storageApiFor(rootOrStorage).readJson('game_data/runtime_state.json');
}

async function saveRuntimeState(rootOrStorage, state) {
  await storageApiFor(rootOrStorage).writeJson('game_data/runtime_state.json', state);
}

function isTrainingScreen(screen) {
  return screen === 'training' || screen === 'academy-training';
}

function currentTrainingDayForState(state) {
  const previousUsed = isTrainingScreen(state.current_screen)
    ? Number(state.training_actions_used ?? 0)
    : 0;
  const index = Math.max(0, Math.min(TRAINING_ACTION_LIMIT - 1, previousUsed));
  return trainingWeekdays[index];
}

function nextTrainingProgress(state) {
  const previousUsed = isTrainingScreen(state.current_screen)
    ? Number(state.training_actions_used ?? 0)
    : 0;
  const actionsUsed = Math.min(TRAINING_ACTION_LIMIT, previousUsed + 1);
  const completed = actionsUsed >= TRAINING_ACTION_LIMIT;
  const nextDay = completed ? null : trainingWeekdays[actionsUsed];
  return {
    actions_used: actionsUsed,
    actions_limit: TRAINING_ACTION_LIMIT,
    remaining_actions: Math.max(0, TRAINING_ACTION_LIMIT - actionsUsed),
    completed,
    next_day: nextDay
  };
}

function skippedTrainingProgress() {
  return {
    actions_used: TRAINING_ACTION_LIMIT,
    actions_limit: TRAINING_ACTION_LIMIT,
    remaining_actions: 0,
    completed: true,
    next_day: null
  };
}

function appliesWeekdayBonus(training, trainingDay) {
  return Boolean(training?.element && training.element === trainingDay?.element);
}

function applyDecrease(parameters, decrease, random) {
  if (!decrease) return null;
  const chance = Number(decrease.chance ?? 0.5);
  const before = valueOf(parameters[decrease.group][decrease.key]);
  const succeeded = random() < chance;
  const amount = succeeded ? -Math.abs(Number(decrease.amount ?? 1)) : 0;
  const after = Math.max(0, before + amount);
  if (amount < 0) setValue(parameters, decrease.group, decrease.key, after);
  return {
    ...decrease,
    label: labels[decrease.group][decrease.key],
    direction: 'decrease',
    amount,
    before,
    after: normalizeParameters(parameters)[decrease.group][decrease.key].value,
    chance
  };
}

function assertPostTrainingScreen(screen) {
  if (typeof screen !== 'string' || !screen) throw new Error('postTrainingScreen is required');
  return screen;
}

// Days already trained in the current routing week, from the pre-write state. A
// routing training week only advances through runTraining, so any day past the
// first must have persisted the accumulator on its prior action.
function priorTrainingDaysDone(state) {
  return isTrainingScreen(state.current_screen) ? Number(state.training_actions_used ?? 0) : 0;
}

// Fail-fast accessor for the mid-week accumulator: on day 2+ (or a mid-week skip)
// the accumulator MUST be present. A missing key is corrupt runtime state, and
// silently reseeding would truncate the week summary, so this throws instead.
function requireInProgressTrainingAccumulator(state) {
  const accumulator = state[ROUTING_TRAINING_WEEK_ACCUMULATOR_STATE_KEY];
  if (accumulator === null || accumulator === undefined) {
    throw new Error('routing training week accumulator is missing on a mid-week training write (corrupt runtime state)');
  }
  return accumulator;
}

// Routing only: bind the "last dispatched content result" record (and, mid-week,
// the in-progress accumulator) into the same nextState the training write persists,
// so current_screen and the record land in one runtime-state write. Loop mode never
// calls this, keeping loop runtime_state byte-identical.
function applyRoutingTrainingResult({ state, nextState, trainingProgress, trainingDay, training, effects, now }) {
  const week = requireRoutingContentWeek(state);
  // The first action of a new week (actions_used === 1) seeds a fresh accumulator;
  // a later action MUST find the accumulator its prior day persisted — a missing one
  // is corrupt state and fails fast rather than silently reseeding a truncated week.
  const priorAccumulator = trainingProgress.actions_used === 1
    ? null
    : requireInProgressTrainingAccumulator(state);
  const accumulator = foldTrainingDayIntoAccumulator(priorAccumulator, {
    week,
    dayIndex: trainingDay.index,
    dayName: trainingDay.name,
    trainingId: training.id,
    trainingName: training.name,
    effects
  });
  if (trainingProgress.completed) {
    nextState[ROUTING_CONTENT_RESULT_STATE_KEY] = buildTrainingContentResult({
      week,
      now,
      outcome: 'completed',
      accumulator
    });
    delete nextState[ROUTING_TRAINING_WEEK_ACCUMULATOR_STATE_KEY];
  } else {
    nextState[ROUTING_TRAINING_WEEK_ACCUMULATOR_STATE_KEY] = accumulator;
  }
}

export async function skipTraining({ root, postTrainingScreen, routing = false, now = new Date().toISOString() } = {}) {
  if (!root) throw new Error('root is required');
  const resolvedPostTrainingScreen = assertPostTrainingScreen(postTrainingScreen);
  const [currentWorld, state] = await Promise.all([loadWorldSettings({ root }), loadRuntimeState(root)]);
  const trainingDay = currentTrainingDayForState(state);
  const trainingProgress = skippedTrainingProgress();
  const nextState = {
    ...state,
    current_screen: resolvedPostTrainingScreen,
    training_actions_used: 0,
    training_actions_limit: trainingProgress.actions_limit
  };
  if (routing) {
    // Skip ends the week without new effects; the record folds in whatever days
    // were trained before skipping. If days were already trained this week, the
    // accumulator MUST be present (fail-fast on a missing one); a skip at the start
    // of the week has no accumulator and yields an empty skipped-week record.
    const week = requireRoutingContentWeek(state);
    const priorAccumulator = priorTrainingDaysDone(state) > 0
      ? requireInProgressTrainingAccumulator(state)
      : null;
    nextState[ROUTING_CONTENT_RESULT_STATE_KEY] = buildTrainingContentResult({
      week,
      now,
      outcome: 'skipped',
      accumulator: priorAccumulator
    });
    delete nextState[ROUTING_TRAINING_WEEK_ACCUMULATOR_STATE_KEY];
  }
  // Loop-mode skip is a pure spread of the prior state (byte-identical to
  // pre-feature): it never adds OR removes routing-only fields.
  const world = await updatePlayerParameters({
    root,
    playerParameters: currentWorld.player_parameters
  });
  await saveRuntimeState(root, nextState);
  return {
    training: { id: 'skip_training', name: '鍛錬をサボる', description: '今週の鍛錬を行わず、そのまま終了する。', element: null },
    training_day: trainingDay,
    effects: [],
    training_progress: trainingProgress,
    state: nextState,
    world
  };
}

export async function runTraining({ root, trainingId, randomSeed, postTrainingScreen, routing = false, now = new Date().toISOString() } = {}) {
  if (!root) throw new Error('root is required');
  const resolvedPostTrainingScreen = assertPostTrainingScreen(postTrainingScreen);
  const training = trainingDefinitions.find((item) => item.id === trainingId);
  if (!training) throw new Error(`unknown training: ${trainingId}`);
  const random = randomSeed === undefined ? Math.random : seededRandom(randomSeed);
  const [current, state] = await Promise.all([loadWorldSettings({ root }), loadRuntimeState(root)]);
  const nextParameters = normalizeParameters(current.player_parameters);
  const effects = [];

  const trainingDay = currentTrainingDayForState(state);
  for (const effect of training.increases) {
    const roll = probabilisticUnitGain(effect, random);
    const weekdayBonus = appliesWeekdayBonus(training, trainingDay);
    const bonusMultiplier = weekdayBonus ? 2 : 1;
    const amount = roll.amount * bonusMultiplier;
    const before = valueOf(nextParameters[effect.group][effect.key]);
    const after = before + amount;
    if (amount > 0) setValue(nextParameters, effect.group, effect.key, after);
    effects.push({ ...effect, label: labels[effect.group][effect.key], direction: 'increase', amount, before, after: normalizeParameters(nextParameters)[effect.group][effect.key].value, chance: roll.chance, old_amount: roll.oldAmount, weekday_bonus: weekdayBonus, bonus_multiplier: bonusMultiplier });
  }

  const decreaseEffect = applyDecrease(nextParameters, training.decrease, random);
  if (decreaseEffect) effects.push(decreaseEffect);

  const trainingProgress = nextTrainingProgress(state);
  const nextTrainingScreen = isTrainingScreen(state.current_screen) ? state.current_screen : 'training';
  const nextState = {
    ...state,
    current_screen: trainingProgress.completed ? resolvedPostTrainingScreen : nextTrainingScreen,
    training_actions_used: trainingProgress.completed ? 0 : trainingProgress.actions_used,
    training_actions_limit: trainingProgress.actions_limit
  };
  if (routing) {
    applyRoutingTrainingResult({ state, nextState, trainingProgress, trainingDay, training, effects, now });
  }
  // Loop mode performs no record/accumulator work: nextState is a pure spread of the
  // prior state (plus the training screen/counters), byte-identical to pre-feature
  // behavior. It never adds OR removes routing-only fields.
  const world = await updatePlayerParameters({
    root,
    playerParameters: nextParameters
  });
  await saveRuntimeState(root, nextState);
  return {
    training: { id: training.id, name: training.name, description: training.description, element: training.element },
    training_day: trainingDay,
    effects,
    training_progress: trainingProgress,
    state: nextState,
    world
  };
}
