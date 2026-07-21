export const magicParameterDefinitions = [
  { key: 'light', label: '光魔法習熟度', prompt_meaning: '光魔法の扱いへの慣れを表す。' },
  { key: 'dark', label: '闇魔法習熟度', prompt_meaning: '闇魔法の扱いへの慣れを表す。' },
  { key: 'fire', label: '火魔法習熟度', prompt_meaning: '火魔法の扱いへの慣れを表す。' },
  { key: 'water', label: '水魔法習熟度', prompt_meaning: '水魔法の扱いへの慣れを表す。' },
  { key: 'earth', label: '土魔法習熟度', prompt_meaning: '土魔法の扱いへの慣れを表す。' },
  { key: 'wind', label: '風魔法習熟度', prompt_meaning: '風魔法の扱いへの慣れを表す。' }
];

export const abilityParameterDefinitions = [
  { key: 'strength', label: '筋力', prompt_meaning: '身体の頑強さと力強い行動の得意さを表す。' },
  { key: 'agility', label: '瞬発力', prompt_meaning: '素早い反応や身のこなしの得意さを表す。' },
  { key: 'academics', label: '学力', prompt_meaning: '知識や学習内容を理解して扱う力を表す。' },
  { key: 'magical_power', label: '魔力', prompt_meaning: '魔法を支える総合的な力の大きさを表す。' },
  { key: 'charisma', label: 'カリスマ', prompt_meaning: '人を惹きつけたり場を動かしたりする力を表す。' }
];

export const parameterBounds = Object.freeze({ min: 0, max: 100 });

function assertParameterBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') throw new Error('parameterBounds must be an object');
  if (!Number.isFinite(bounds.min)) throw new Error('parameterBounds.min is required');
  if (!Number.isFinite(bounds.max)) throw new Error('parameterBounds.max is required');
  if (bounds.min > bounds.max) throw new Error('parameterBounds.min must be less than or equal to parameterBounds.max');
}

export function renderParameterScaleForPrompt(bounds = parameterBounds) {
  assertParameterBounds(bounds);
  return `${bounds.min}〜${bounds.max}`;
}

function clamp(value) {
  assertParameterBounds(parameterBounds);
  const number = Number(value);
  if (!Number.isFinite(number)) return parameterBounds.min;
  return Math.max(parameterBounds.min, Math.min(parameterBounds.max, Math.round(number)));
}

function normalizeGroup(definitions, values = {}, fallbackValue = 0) {
  return Object.fromEntries(definitions.map((definition) => {
    const raw = values?.[definition.key];
    const value = typeof raw === 'object' && raw !== null && 'value' in raw ? raw.value : raw;
    return [definition.key, { ...parameterBounds, label: definition.label, value: clamp(value ?? fallbackValue) }];
  }));
}

export function normalizeParameters(parameters = {}, { fallbackValue = 0 } = {}) {
  return {
    magic: normalizeGroup(magicParameterDefinitions, parameters.magic, fallbackValue),
    abilities: normalizeGroup(abilityParameterDefinitions, parameters.abilities, fallbackValue)
  };
}

export function defaultPlayerParameters() {
  return normalizeParameters({}, { fallbackValue: 0 });
}

export function defaultCharacterParameters(index = 1) {
  const magic = Object.fromEntries(magicParameterDefinitions.map((definition, offset) => [
    definition.key,
    18 + ((index * 17 + offset * 13) % 73)
  ]));
  const abilities = Object.fromEntries(abilityParameterDefinitions.map((definition, offset) => [
    definition.key,
    20 + ((index * 19 + offset * 11) % 71)
  ]));
  return normalizeParameters({ magic, abilities });
}

function renderGroup(definitions, values) {
  return definitions.map((definition) => {
    const stat = values?.[definition.key] ?? { value: 0 };
    return `${definition.label}: ${clamp(stat.value)}/${parameterBounds.max}`;
  }).join('、');
}

export function renderParametersForPrompt(parameters) {
  const normalized = normalizeParameters(parameters);
  return [
    renderGroup(magicParameterDefinitions, normalized.magic),
    renderGroup(abilityParameterDefinitions, normalized.abilities)
  ].filter(Boolean).join('\n');
}
