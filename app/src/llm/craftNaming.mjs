// Craft naming: the LLM-supplied name/flavor for a finished craft, and the only
// place crafting talks to the language model at all.
//
// The domain (equipmentCraft.mjs) freezes the roll and treats name/flavor as
// caller-supplied. This module is that caller. It runs the naming as a 2-stage
// gate on top of the deterministic craft:
//   1. previewCraft gives the confirmed roll (kind/element/tier/quality/bonus),
//      which is deterministic and byte-identical to what completeCraft will build.
//   2. buildCraftNamingPrompt turns that roll into a naming prompt; the LLM returns
//      a { name, flavor } candidate through the lmStudioClient conventions.
//   3. validateCraftNaming is the gate: exact { name, flavor } schema, non-empty,
//      within the length caps, no quotation/bracket symbols.
//   4. only once the candidate passes does completeCraft spend materials and append
//      the instance atomically.
//
// The prompt renders tier and quality as two independent axes — tier is the item's
// standing (格), quality is only the finish precision (作りの精巧さ) — so a high-tier
// rough craft and a low-tier exquisite craft each read true, instead of quality alone
// dominating the label. Two naming-only inputs steer the wording away from monotony:
// a deterministic per-craft flavor constraint (佇まい) and the workshop's already-named
// pieces handed off to avoid repeats. These are naming decoration, selected in the
// orchestration layer (not part of the deterministic roll), and are the only place a
// non-roll input enters naming; the roll itself is never touched here (no Math.random,
// no clock). Any failure before completeCraft — LM unconfigured or unreachable,
// malformed response, or a gate violation — throws with nothing consumed, so a naming
// retry is always possible. There is no automatic-naming fallback and no silent retry:
// the error is surfaced to the caller verbatim.

import { createStorageApi } from '../storage.mjs';
import { magicParameterDefinitions } from '../parameters.mjs';
import { WEAPON_TYPES, EQUIPMENT_QUALITIES, EQUIPMENT_EFFECT_KEYS, loadEquipmentSurface } from '../equipment.mjs';
import { previewCraft, completeCraft } from '../equipmentCraft.mjs';
import { callLmStudioStructuredJson } from './lmStudioClient.mjs';

// ----- tunable naming gate constants (not env-configurable) -----
// Character caps counted in Unicode code points. A name is a short proper noun; a
// flavor is a one-breath descriptive line. The flavor prompt asks for ~60 as a soft
// target and 80 as the hard cap this gate enforces.
export const CRAFT_NAME_MAX_LENGTH = 24;
export const CRAFT_FLAVOR_MAX_LENGTH = 80;
export const CRAFT_FLAVOR_SOFT_TARGET_LENGTH = 60;

// The number of already-named pieces handed to the prompt as a repeat-avoidance list.
export const CRAFT_PRIOR_NAMES_MAX = 12;

// Quotation, bracket, and line-structure characters are rejected: injected quotes
// make the model emit dialogue-like names, and brackets/newlines break a name or
// flavor into structured fragments. Everything else (ordinary Japanese prose and
// punctuation) is allowed.
const FORBIDDEN_NAMING_CHARACTERS = /["'`«»“”‘’「」『』【】〈〉《》〔〕（）()[\]{}<>\r\n\t]/u;

// ----- closed-vocabulary display labels -----
// The keys are the canonical closed vocabularies imported above; these are the
// Japanese labels the naming prompt renders. assertLabelsCover pins each map to its
// canonical key set at load, so a future vocabulary addition fails fast here instead
// of rendering a silently mislabeled or missing prompt line.
const ELEMENT_KEYS = magicParameterDefinitions.map((definition) => definition.key);

const ELEMENT_LABELS = { light: '光', dark: '闇', fire: '火', water: '水', earth: '土', wind: '風' };
const WEAPON_TYPE_LABELS = { sword: '剣', staff: '杖', short_rod: '短杖' };
const QUALITY_LABELS = { common: '並', fine: '良', excellent: '優', masterwork: '傑作' };
const EFFECT_LABELS = {
  attack: '攻撃',
  defense: '防御',
  max_hp: '最大HP',
  max_mp: '最大MP',
  spell_mp_discount: 'スペルMP軽減',
  self_heal_bonus: '自己回復量',
  element_spell_power: '同属性スペル威力'
};

function assertLabelsCover(labels, keys, what) {
  const labelKeys = Object.keys(labels).sort();
  const canonical = [...keys].sort();
  const matches = labelKeys.length === canonical.length && labelKeys.every((key, index) => key === canonical[index]);
  if (!matches) throw new Error(`craft naming ${what} labels must cover exactly {${canonical.join(', ')}}: got {${labelKeys.join(', ')}}`);
}

assertLabelsCover(ELEMENT_LABELS, ELEMENT_KEYS, 'element');
assertLabelsCover(WEAPON_TYPE_LABELS, WEAPON_TYPES, 'weapon_type');
assertLabelsCover(QUALITY_LABELS, EQUIPMENT_QUALITIES, 'quality');
assertLabelsCover(EFFECT_LABELS, EQUIPMENT_EFFECT_KEYS, 'effect');

// ----- closed flavor-constraint vocabulary -----
// A random one-line 佇まい constraint bends the naming direction so repeated crafts do
// not collapse onto one template. The set is closed and code-owned: each value is
// injected verbatim into the prompt behind a world-consistency guard. The category set
// is pinned at load (assertFlavorConstraintCategories) so an accidental rename or an
// empty/duplicate/symbol-bearing value fails fast here rather than rendering a broken
// or drifting constraint line.
const CRAFT_FLAVOR_CONSTRAINT_CATEGORIES = ['量感', '質感', '様式', '気配', '意匠'];

export const CRAFT_FLAVOR_CONSTRAINTS = Object.freeze({
  量感: Object.freeze(['巨大で威圧するような', '岩のように重く無骨な', '蝶のように軽く繊細な', '細身で無駄のない']),
  質感: Object.freeze(['ざらついた鉱石じみた', '磨き抜かれ滑らかな', '古びて苔むしたような', '透き通るような硝子質の']),
  様式: Object.freeze(['辺境の素朴な民具めいた', '古雅な東方風の', '荘厳な神殿様式の', '遊牧の民の実用的な']),
  気配: Object.freeze(['静謐で祈りに似た', '猛々しく獣めいた', '陰鬱で寡黙な', '朗らかで軽やかな']),
  意匠: Object.freeze(['蔦や花を絡めた', '幾何学的な紋様を刻んだ', '装飾を削ぎ落とした', '星々をかたどった'])
});

function assertFlavorConstraintsShape() {
  assertLabelsCover(CRAFT_FLAVOR_CONSTRAINTS, CRAFT_FLAVOR_CONSTRAINT_CATEGORIES, 'flavor_constraint category');
  const seen = new Set();
  for (const category of CRAFT_FLAVOR_CONSTRAINT_CATEGORIES) {
    const values = CRAFT_FLAVOR_CONSTRAINTS[category];
    if (!Array.isArray(values) || values.length === 0) throw new Error(`craft naming flavor_constraint category ${category} must be a non-empty array`);
    for (const value of values) {
      if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`craft naming flavor_constraint value in ${category} must be a non-empty string`);
      if (FORBIDDEN_NAMING_CHARACTERS.test(value)) throw new Error(`craft naming flavor_constraint value must not contain quotation or bracket symbols: ${value}`);
      if (seen.has(value)) throw new Error(`craft naming flavor_constraint value is duplicated: ${value}`);
      seen.add(value);
    }
  }
}

assertFlavorConstraintsShape();

// The flat, fixed-order list every constraint is picked from, so a deterministic index
// maps to a stable { category, value }.
const FLAT_FLAVOR_CONSTRAINTS = CRAFT_FLAVOR_CONSTRAINT_CATEGORIES.flatMap(
  (category) => CRAFT_FLAVOR_CONSTRAINTS[category].map((value) => ({ category, value }))
);

// FNV-1a over a string, matching equipmentCraft's seed hashing style, used only to pick
// a flavor constraint deterministically from a seed key (never for the roll).
function flavorConstraintSeed(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// Deterministically selects one { category, value } constraint from a seed key. The
// same key always yields the same constraint (so a naming retry keeps its constraint);
// a different key (e.g. a different existing-instance count) yields a possibly different
// one (so consecutive crafts vary). Never touches the roll derivation.
export function selectCraftFlavorConstraint(seedKey) {
  if (typeof seedKey !== 'string' || seedKey.length === 0) throw new Error('craft naming flavor constraint seedKey must be a non-empty string');
  return FLAT_FLAVOR_CONSTRAINTS[flavorConstraintSeed(seedKey) % FLAT_FLAVOR_CONSTRAINTS.length];
}

function assertKnownFlavorConstraint(constraint) {
  if (constraint === null || typeof constraint !== 'object' || Array.isArray(constraint)) throw new Error('craft naming flavor_constraint must be an object');
  const keys = Object.keys(constraint);
  const exact = keys.length === 2 && keys.includes('category') && keys.includes('value');
  if (!exact) throw new Error(`craft naming flavor_constraint keys must be exactly {category, value}: got {${keys.sort().join(', ')}}`);
  const values = CRAFT_FLAVOR_CONSTRAINTS[constraint.category];
  if (!values) throw new Error(`craft naming flavor_constraint category is not a known value: ${constraint.category}`);
  if (!values.includes(constraint.value)) throw new Error(`craft naming flavor_constraint value is not in category ${constraint.category}: ${constraint.value}`);
  return constraint;
}

function assertPriorNames(priorNames) {
  if (!Array.isArray(priorNames)) throw new Error('craft naming prior_names must be an array of strings');
  for (const name of priorNames) {
    if (typeof name !== 'string' || name.trim().length === 0) throw new Error('craft naming prior_names must contain only non-empty strings');
  }
  return priorNames;
}

// The response_format hint asks the model for a { name, flavor } object. It is only a
// hint: validateCraftNaming is the authoritative gate that enforces the exact shape.
const CRAFT_NAMING_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'craft_naming_record',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        flavor: { type: 'string' }
      },
      required: ['name', 'flavor']
    }
  }
};

// ----- prompt (pure) -----

function labelFor(labels, key, what) {
  if (!Object.prototype.hasOwnProperty.call(labels, key)) throw new Error(`craft naming ${what} is not a known value: ${key}`);
  return labels[key];
}

function effectSummary(effects) {
  if (effects === null || typeof effects !== 'object' || Array.isArray(effects)) throw new Error('craft naming effects must be an object');
  const parts = Object.entries(effects).map(([key, value]) => `${labelFor(EFFECT_LABELS, key, 'effect')}+${value}`);
  return parts.length === 0 ? 'なし' : parts.join('、');
}

// Builds the naming prompt from a confirmed roll (a previewCraft result) plus the
// naming-only inputs. Pure and deterministic: the same roll and inputs always render
// the same prompt. The prompt frames tier (格) and quality (作りの精巧さ) as two
// independent axes, forbids echoing the raw rank labels, and — when supplied — injects
// a 佇まい constraint and hands off already-named pieces to keep naming from repeating.
//
// namingInputs is optional decoration, not roll data: `flavor_constraint` ({category,
// value}, validated against the closed set) adds the 佇まい line; a non-empty
// `prior_names` (array of strings) adds the repeat-avoidance handoff. Either absent
// simply omits its line (an auction reuse names a lot with neither). Any supplied value
// is validated fail-fast.
export function buildCraftNamingPrompt(rollSummary, namingInputs = {}) {
  if (rollSummary === null || typeof rollSummary !== 'object' || Array.isArray(rollSummary)) throw new Error('craft naming rollSummary must be an object');
  if (namingInputs === null || typeof namingInputs !== 'object' || Array.isArray(namingInputs)) throw new Error('craft naming namingInputs must be an object');
  const { kind, weapon_type, element, tier, quality, base_effects, bonus_effects } = rollSummary;
  const kindLine = kind === 'amulet'
    ? '種別: 護符'
    : kind === 'weapon'
      ? `種別: 武器（${labelFor(WEAPON_TYPE_LABELS, weapon_type, 'weapon_type')}）`
      : (() => { throw new Error(`craft naming kind must be weapon or amulet: ${kind}`); })();
  if (!Number.isInteger(tier) || tier < 1 || tier > 4) throw new Error(`craft naming tier must be an integer 1..4: ${tier}`);

  const flavorConstraint = namingInputs.flavor_constraint === undefined ? null : assertKnownFlavorConstraint(namingInputs.flavor_constraint);
  const priorNames = namingInputs.prior_names === undefined ? [] : assertPriorNames(namingInputs.prior_names);

  const lines = [
    '星灯魔法学院の工房で、確定した装備が一つ仕上がった。あなたはこの工房で銘を刻む者として、この装備そのものに固有の名前とフレーバー文を与える。',
    '以下の確定した装備情報だけを根拠にする。',
    '',
    kindLine,
    `属性: ${labelFor(ELEMENT_LABELS, element, 'element')}`,
    `階級（格）: T${tier}（格＝この装備そのものの位。素材の階位と系譜の高さで決まり、装備としての風格・重み・凄みを左右する。数字が大きいほど格が高い）`,
    `出来栄え（作りの精巧さ）: ${labelFor(QUALITY_LABELS, quality, 'quality')}（作りの精巧さ＝仕上げの丁寧さ・造りの精度だけを表す。装備の格とは別の軸）`,
    `基礎性能: ${effectSummary(base_effects)}`,
    `付加性能: ${effectSummary(bonus_effects)}`,
    '',
    '格（階級）と出来栄え（作りの精巧さ）は独立した2つの軸であり、取り違えずに両方を描く。',
    '・格は装備の位。高い格は風格・重み・凄みを、低い格は素朴・簡素さを銘とフレーバーに宿す。',
    '・出来栄えは仕上げの精度だけ。高ければ造りの緻密さ・端正さ、低ければ粗さ・無骨さで表し、装備の位そのものは動かさない。',
    '・格が高く出来栄えが低い装備は「位は高いが仕上げは粗い」、格が低く出来栄えが高い装備は「素朴だが仕上げは見事」——どちらの軸も実態どおりに現す。',
    '',
    '「並・良・優・傑作」「T1〜T4」などのラベル語そのものを銘やフレーバーに書き写さない。意味を汲んで情景・質感として表す。',
    ''
  ];
  if (flavorConstraint) {
    lines.push(`この一振りの佇まいには「${flavorConstraint.value}」趣がある。名前とフレーバーの方向づけに活かし、世界観（星灯魔法学院・魔法と属性の世界）から外れる語や現代語・実在の地名人名は使わない。`);
    lines.push('');
  }
  lines.push('陳腐な決まり文句や毎回同じ言い回し（同じ属性語の接頭・「輝きを宿す」「導き」等の反復）を避け、方向づけを毎回変えて名付ける。');
  if (priorNames.length > 0) {
    lines.push(`この工房で既に付けた名前（重複・酷似を避ける）: ${priorNames.join('、')}`);
  }
  lines.push('');
  lines.push('出力は name と flavor だけを持つ JSON オブジェクトを1つだけ返す。');
  lines.push(`name はこの装備の固有名。最大${CRAFT_NAME_MAX_LENGTH}文字。`);
  lines.push(`flavor はこの装備を描写する短い説明文。${CRAFT_FLAVOR_SOFT_TARGET_LENGTH}文字程度、最大${CRAFT_FLAVOR_MAX_LENGTH}文字。`);
  lines.push('引用符・鉤括弧・各種括弧・改行などの記号は使わず、地の文で書く。');
  lines.push('name と flavor 以外のキーは出力しない。');
  return lines.join('\n');
}

// ----- gate (pure) -----

function assertNamingField(value, label) {
  if (typeof value !== 'string') throw new Error(`craft naming ${label} must be a string`);
  if (value.trim().length === 0) throw new Error(`craft naming ${label} must not be empty`);
  const max = label === 'name' ? CRAFT_NAME_MAX_LENGTH : CRAFT_FLAVOR_MAX_LENGTH;
  if ([...value].length > max) throw new Error(`craft naming ${label} must be at most ${max} characters`);
  const forbidden = value.match(FORBIDDEN_NAMING_CHARACTERS);
  if (forbidden) throw new Error(`craft naming ${label} must not contain quotation or bracket symbols: ${forbidden[0]}`);
  return value;
}

// The 2-stage gate: validates a candidate against the exact { name, flavor } schema,
// non-empty, length caps, and the forbidden-symbol rule. Throws with a reason on any
// violation; returns the validated { name, flavor } on success (no transformation).
export function validateCraftNaming(candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('craft naming candidate must be an object');
  const keys = Object.keys(candidate);
  const exact = keys.length === 2 && keys.includes('name') && keys.includes('flavor');
  if (!exact) throw new Error(`craft naming candidate keys must be exactly {name, flavor}: got {${keys.sort().join(', ')}}`);
  const name = assertNamingField(candidate.name, 'name');
  const flavor = assertNamingField(candidate.flavor, 'flavor');
  return { name, flavor };
}

// ----- orchestration -----

// The naming-only inputs for one craft, selected outside the deterministic roll:
//   - flavor_constraint: deterministic per (this exact craft, this slot's current
//     instance count) — a retry (nothing added) keeps its constraint; the next craft
//     (one more instance) varies. Derived only from the confirmed roll's instance_id
//     and the surface size, never from the roll itself.
//   - prior_names: the slot's existing instance names, newest first, capped, so the
//     prompt can avoid repeating them. No new storage surface is introduced.
function craftNamingInputs({ preview, surface }) {
  const priorNames = surface.instances.slice().reverse().map((instance) => instance.name).slice(0, CRAFT_PRIOR_NAMES_MAX);
  const flavorConstraint = selectCraftFlavorConstraint(`${preview.instance_id}|${surface.instances.length}`);
  return { flavor_constraint: flavorConstraint, prior_names: priorNames };
}

// Runs the full naming pipeline for a craft: preview the confirmed roll, name it via
// the LLM, gate the candidate, then complete the craft atomically with the validated
// name/flavor. Returns completeCraft's result (recipe_id, week, quality, instance,
// consumed_costs, inventory). The LLM transport (fetchImpl) is injectable per the
// lmStudioClient convention. Any failure before completeCraft leaves materials
// unconsumed; there is no automatic-naming fallback and no silent retry.
export async function craftWithLlmNaming({ root, storage, recipe_id, config, fetchImpl } = {}) {
  if (!config) throw new Error('lmStudioConfig is required for craft naming');
  const api = storage ?? createStorageApi({ root });
  const preview = await previewCraft({ storage: api, recipe_id });
  const surface = await loadEquipmentSurface({ storage: api });
  const prompt = buildCraftNamingPrompt(preview, craftNamingInputs({ preview, surface }));
  const candidate = await callLmStudioStructuredJson({
    config,
    prompt,
    fetchImpl,
    responseFormat: CRAFT_NAMING_RESPONSE_FORMAT,
    title: 'クラフト命名生成'
  });
  const { name, flavor } = validateCraftNaming(candidate);
  return completeCraft({ storage: api, recipe_id, name, flavor });
}
