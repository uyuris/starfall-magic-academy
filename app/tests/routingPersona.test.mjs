import test from 'node:test';
import assert from 'node:assert/strict';

import { parameterBounds, renderParameterScaleForPrompt } from '../src/parameters.mjs';
import { MAX_FLOORS } from '../src/dungeon/dungeonEngine.mjs';
import {
  routingPersonaDisplayName,
  routingPersonaMemoryPeekDescription,
  buildRoutingPersona,
  routingPersonaVariants
} from '../src/routingPersona.mjs';
import { buildRoutingMetaContext, buildRoutingOpeningSmalltalkGuidance } from '../src/routingMetaContext.mjs';
import { TRAINING_ACTION_LIMIT, trainingDefinitions } from '../src/training.mjs';
import {
  buildRoutingDestinationNarration,
  parseRoutingDestinationAnswer,
  routingDestinations,
  validateRoutingDestinations
} from '../src/routingDestinations.mjs';
import { routingDestinationsForState } from '../src/routingDestinationSelection.mjs';

function baseRoutingHubContext(overrides = {}) {
  return {
    persona_variant: 'fallen_star',
    recent_conversation_context: {
      kind: 'no_new_conversation',
      conversation_id: null,
      character_id: null,
      character_name: null,
      memory_text: null
    },
    relationship_context: {
      buddy: null,
      enemies: []
    },
    alchemy_context: {
      recipe_count: 8
    },
    study_circle_context: {
      theme_count: trainingDefinitions.length,
      weekly_offer_count: 3
    },
    content_result_context: null,
    ...overrides
  };
}

function trainingContentResultContext() {
  return {
    record: {
      kind: 'training',
      destination_id: 'training',
      week: 4,
      recorded_at: '2026-05-05T06:10:00.000+09:00',
      trigger: 'training_completed',
      detail: {
        outcome: 'completed',
        trainings: [{
          day_index: 0,
          day_name: '光曜',
          training_id: 'healing_practice',
          training_name: '治癒魔法実習'
        }],
        parameter_deltas: {
          magic: { light: 2 },
          abilities: { strength: -1 }
        }
      }
    },
    companion: null
  };
}

const ROUTING_PERSONA_VARIANT_NAMES = {
  fallen_star: 'ルミ',
  bureau_apprentice: 'リステ・ドリームレッジ',
  dethroned_constellation: 'アステリア・スタークラウン',
  scale_arbiter: 'ユスティ・フェアウェイト',
  pool_cat: 'ネル・グロウパドル',
  far_side_sister: 'ノクテ・ヴェイルサイド',
  eclipse_shadow: 'ウンブラ・カッパーグロウ',
  hourglass_grain: 'サラ・アワーグラス',
  star_egg_keeper: 'ニンナ・スターネスト',
  stardust_sweeper: 'シュシュ・スターブルーム'
};

// Tone-stabilization contract (guide-persona-settings-embedding): each variant's speaking_basis ends with
// an appended sentence that pins the first-person word, names the tone texture, and forbids the opposite
// drift; each variant's prompt_description begins with a childlike-girl gender/appearance anchor. These two
// texts are asserted verbatim so a later edit cannot silently drop them and regress tone/gender stability.
const ROUTING_PERSONA_SPEAKING_BASIS_APPENDIX = {
  fallen_star: '話すときの一人称は「わたし」で一貫させ、少女らしい弾んだため口の口ぶりを終始崩さない。かしこまった敬語・硬い丁寧語・大人びた言い回しには切り替えない。',
  bureau_apprentice: '話すときの一人称は「わたし」で一貫させ、折り目正しく生真面目な丁寧語の口調を土台として保つ。砕けたため口や芝居がかった大仰な物言いには転ばない。',
  dethroned_constellation: '話すときの一人称は「わたくし」で一貫させ、高慢で芝居がかった高貴な少女の物言いを終始崩さない。相手にへりくだる腰の低い敬語や、砕けたため口には転ばない。',
  scale_arbiter: '話すときの一人称は「わたし」で一貫させ、生真面目に均衡を測る折り目正しい少女の口調を終始崩さない。特定の道へ肩入れする砕けた断定や、投げやりなため口には転ばない。',
  pool_cat: '話すときの一人称は「あたし」で一貫させ（もともと自称は多用しない）、気だるく短い少女のため口を終始崩さない。折り目正しい敬語・丁寧な言い回しには切り替えない。',
  far_side_sister: '話すときの一人称は「わたし」で一貫させ、控えめで途切れがちな小声の少女の口ぶりを終始崩さない。社交的で流暢な多弁や、芝居がかった大仰な物言いには転ばない。',
  eclipse_shadow: '話すときの一人称は「わたし」で一貫させ、はにかみながら弾む前向きな少女の口調を終始崩さない。陰気に沈んだ物言いや、よそよそしい硬い敬語には転ばない。',
  hourglass_grain: '話すときの一人称は「わたし」で一貫させ、焦らず間を取った穏やかでゆるやかな少女の口調を終始崩さない。早口で急かす物言いや、きびきびした断定口調には転ばない。',
  star_egg_keeper: '話すときの一人称は「わたし」で一貫させ、母性のこもった穏やかでゆったりした少女の口調を終始崩さない。冷たいそっけなさや、急かす物言いには転ばない。',
  stardust_sweeper: '話すときの一人称は「あたし」で一貫させ、快活でよく動く働き者の弾んだ少女の口調を終始崩さない。気だるいそっけなさや、かしこまった敬語には転ばない。'
};

const ROUTING_PERSONA_PROMPT_DESCRIPTION_PREFIX = {
  fallen_star: '見た目は幼く小柄な少女。',
  bureau_apprentice: '見た目は幼く小柄な少女。',
  dethroned_constellation: '見た目は幼く小柄な少女。',
  scale_arbiter: '見た目は幼く小柄な少女。',
  pool_cat: '見た目は幼く小柄な少女。',
  far_side_sister: '見た目は幼く小柄な少女。',
  eclipse_shadow: '見た目は幼く小柄な少女。',
  hourglass_grain: '見た目は幼く小柄な少女（10人の中でもいちばん小柄）。',
  star_egg_keeper: '見た目は幼く小柄な少女。',
  stardust_sweeper: '見た目は幼く小柄な少女。'
};

test('routing persona exposes ten variant-specific display names and persona blocks', () => {
  assert.deepEqual(Object.keys(routingPersonaVariants).sort(), [
    'bureau_apprentice',
    'dethroned_constellation',
    'eclipse_shadow',
    'fallen_star',
    'far_side_sister',
    'hourglass_grain',
    'pool_cat',
    'scale_arbiter',
    'star_egg_keeper',
    'stardust_sweeper'
  ]);

  for (const variant of Object.keys(routingPersonaVariants)) {
    const expectedName = ROUTING_PERSONA_VARIANT_NAMES[variant];
    const profile = buildRoutingPersona(variant);
    assert.equal(profile.character_id, 'lina');
    // The display name follows the variant — each block has its own name (fallen_star is「ルミ」).
    assert.equal(profile.display_name, expectedName);
    assert.equal(routingPersonaDisplayName(variant), expectedName);
    assert.equal(typeof profile.prompt_description, 'string');
    assert.equal(typeof profile.speaking_basis, 'string');
    // The persona is named to the LLM via display_name; the setting text is the brief canon verbatim,
    // followed by the memory-peek line named to this variant, and never carries a name placeholder.
    assert.match(profile.prompt_description, new RegExp(routingPersonaMemoryPeekDescription(expectedName)));
    assert.doesNotMatch(profile.prompt_description, /〈固定名〉/);
    // prompt_description stays plain narration (地の文) — no quoted dialogue / tone samples, including the
    // prepended gender/appearance anchor and the memory-peek line.
    assert.doesNotMatch(profile.prompt_description, /[「」『』]/);
    // speaking_basis may name the first-person word in 「」 (わたし／わたくし／あたし) as an approved tone
    // anchor, but carries no other quoted dialogue or tone sample: stripping the allowed first-person tokens
    // must leave no bracket behind.
    const speakingWithoutFirstPerson = profile.speaking_basis.replace(/「(わたし|わたくし|あたし)」/g, '');
    assert.doesNotMatch(speakingWithoutFirstPerson, /[「」『』]/);

    // Tone/gender-stability contract: the gender/appearance anchor prefixes prompt_description and the
    // tone-pinning sentence is appended to speaking_basis, with the original setting body preserved between.
    const descriptionPrefix = ROUTING_PERSONA_PROMPT_DESCRIPTION_PREFIX[variant];
    const speakingAppendix = ROUTING_PERSONA_SPEAKING_BASIS_APPENDIX[variant];
    assert.ok(profile.prompt_description.startsWith(descriptionPrefix),
      `prompt_description for ${variant} must start with the approved gender/appearance anchor`);
    assert.ok(profile.speaking_basis.endsWith(speakingAppendix),
      `speaking_basis for ${variant} must end with the approved tone-pinning sentence`);
    // The original setting body is still present between anchor and appendix (append/prepend only, no rewrite).
    assert.ok(profile.prompt_description.slice(descriptionPrefix.length).length > 0);
    assert.ok(profile.speaking_basis.slice(0, profile.speaking_basis.length - speakingAppendix.length).length > 0);
  }
  // A missing/unknown variant fails fast rather than defaulting to a name.
  assert.throws(() => routingPersonaDisplayName('banana'), /routing persona variant/);

  assert.match(buildRoutingPersona('fallen_star').prompt_description, /星降り祭の夜に地上へ落ち/);
  assert.match(buildRoutingPersona('bureau_apprentice').prompt_description, /夢の管理局から着任した史上最年少の見習い案内人/);
  assert.match(buildRoutingPersona('dethroned_constellation').prompt_description, /星の座を降ろされた/);
  assert.match(buildRoutingPersona('scale_arbiter').prompt_description, /旅人の行き先を天秤で量って定めていた裁定の精/);
  assert.match(buildRoutingPersona('pool_cat').prompt_description, /月光の溜まりで長い長い昼寝をしていた/);
  assert.match(buildRoutingPersona('far_side_sister').prompt_description, /裏側にいた妹が代わりに立っている/);
  assert.match(buildRoutingPersona('eclipse_shadow').prompt_description, /月を覆うあの影そのもの/);
  assert.match(buildRoutingPersona('hourglass_grain').prompt_description, /くびれに引っかかった一粒/);
  assert.match(buildRoutingPersona('star_egg_keeper').prompt_description, /まだ生まれていない星の卵を温める役目を負った精/);
  assert.match(buildRoutingPersona('stardust_sweeper').prompt_description, /何百年も掃き集めてきた箒の精/);
  assert.match(buildRoutingPersona('fallen_star').speaking_basis, /人懐こく弾んだ調子でよく喋り/);
  assert.match(buildRoutingPersona('hourglass_grain').speaking_basis, /間をたっぷり取った穏やかでゆるやかな話し方/);
  assert.throws(() => buildRoutingPersona('banana'), /routing persona variant/);
});

test('parameter bounds and prompt scale are public and fail fast when malformed', () => {
  assert.deepEqual(parameterBounds, { min: 0, max: 100 });
  assert.equal(Object.isFrozen(parameterBounds), true);
  assert.equal(renderParameterScaleForPrompt(), '0〜100');
  assert.throws(() => renderParameterScaleForPrompt({ min: 0 }), /parameterBounds.max is required/);
});

test('routing meta context renders game mode, week, destination, and all parameter meanings from public sources', () => {
  const context = buildRoutingMetaContext({
    state: { elapsed_weeks: 12 }
  });

  assert.match(context, /ルーティング会話メタ情報:/);
  assert.match(context, /loop\/routing/);
  assert.match(context, /現在は第13週/);
  assert.match(context, /50週で卒業/);
  assert.match(context, /数値範囲は0〜100/);
  assert.match(context, /全11項目/);

  // The rendered catalog is the default candidate set (homunculus gated out until unlocked).
  const destinations = routingDestinationsForState({ elapsed_weeks: 12 });
  assert.deepEqual(destinations.map((destination) => destination.id), [
    'academy-map', 'training', 'dungeon', 'errand', 'alchemy', 'study_circle', 'workshop', 'library', 'arena', 'auction', 'lounge', 'title'
  ]);
  for (const destination of destinations) {
    assert.match(context, new RegExp(`${destination.label}: ${destination.description}`));
  }
  assert.match(context, new RegExp(`${trainingDefinitions.length}種の鍛錬`));
  assert.match(context, new RegExp(`週${TRAINING_ACTION_LIMIT}回の行動`));
  assert.match(context, new RegExp(`最大${MAX_FLOORS}層`));

  for (const label of [
    '光魔法習熟度',
    '闇魔法習熟度',
    '火魔法習熟度',
    '水魔法習熟度',
    '土魔法習熟度',
    '風魔法習熟度',
    '筋力',
    '瞬発力',
    '学力',
    '魔力',
    'カリスマ'
  ]) {
    assert.match(context, new RegExp(`${label}:`));
  }

  assert.throws(() => buildRoutingMetaContext({ state: { elapsed_weeks: -1 } }), /elapsed_weeks/);
});

test('routing meta context renders alchemy mechanics from the captured hub snapshot', () => {
  const context = buildRoutingMetaContext({
    state: { elapsed_weeks: 0 },
    routingHubContext: baseRoutingHubContext({
      alchemy_context: {
        recipe_count: 5
      }
    })
  });

  assert.match(context, /調合: 常設の全5種のレシピブックから/);
  assert.doesNotMatch(context, /調合: 全\d+種のレシピから週\d+件のオファー/);
});

test('routing meta context renders study-circle mechanics from the captured hub snapshot', () => {
  const context = buildRoutingMetaContext({
    state: { elapsed_weeks: 0 },
    routingHubContext: baseRoutingHubContext({
      study_circle_context: {
        theme_count: 12,
        weekly_offer_count: 2
      }
    })
  });

  assert.match(context, /研究会: 全12種のテーマから週2件のオファー/);
  assert.doesNotMatch(context, new RegExp(`研究会: 全${trainingDefinitions.length}種のテーマから週3件のオファー`));
});

test('routing meta context carries the four standing world-law facts with the persona line resolved to the active variant', () => {
  const context = buildRoutingMetaContext({
    state: { elapsed_weeks: 4 },
    routingHubContext: baseRoutingHubContext({ persona_variant: 'fallen_star' })
  });

  assert.match(context, /- 今会話しているこの場所は、その週の行き先を決めるための月の文字盤の空間/);
  assert.match(context, /- ルミは主人公の一番新しい記憶だけを覗ける/);
  assert.match(context, /- 「ロード機能」は世界線を変える機能で、「セーブ機能」はない。常に情報は更新され、過去の特定のタイミングに戻ってやり直す手段はない。/);
  assert.match(context, /- 会話の途中で不正に終了するとデータ破損・起動不能になる可能性がある/);
  // No unresolved authored token survives into the rendered meta info.
  assert.doesNotMatch(context, /\{\{persona_name\}\}/);

  // The persona line follows the selected variant everywhere, not a fixed name.
  const eclipse = buildRoutingMetaContext({
    state: { elapsed_weeks: 4 },
    routingHubContext: baseRoutingHubContext({ persona_variant: 'eclipse_shadow' })
  });
  assert.match(eclipse, /- ウンブラ・カッパーグロウは主人公の一番新しい記憶だけを覗ける/);
  assert.doesNotMatch(eclipse, /- ルミは主人公の一番新しい記憶だけを覗ける/);
});

test('routing meta context renders captured recent memory, result, and relationship state', () => {
  const context = buildRoutingMetaContext({
    state: { elapsed_weeks: 4 },
    routingHubContext: {
      persona_variant: 'fallen_star',
      recent_conversation_context: {
        kind: 'conversation_memory',
        conversation_id: 'conv_recent_memory_001',
        character_id: 'character_001',
        character_name: 'セラ・アストルーペ',
        memory_text: '主人公は星図の読み方を少し覚えた。'
      },
      relationship_context: {
        buddy: { character_id: 'character_002', display_name: 'ミラ' },
        enemies: [{ character_id: 'character_003', display_name: 'ノクス' }]
      },
      alchemy_context: {
        recipe_count: 8
      },
      study_circle_context: {
        theme_count: trainingDefinitions.length,
        weekly_offer_count: 3
      },
      content_result_context: {
        record: {
          kind: 'training',
          destination_id: 'training',
          week: 4,
          recorded_at: '2026-05-05T06:10:00.000+09:00',
          trigger: 'training_completed',
          detail: {
            outcome: 'completed',
            trainings: [{
              day_index: 0,
              day_name: '光曜',
              training_id: 'healing_practice',
              training_name: '治癒魔法実習'
            }],
            parameter_deltas: {
              magic: { light: 2 },
              abilities: { strength: -1 }
            }
          }
        },
        companion: null
      }
    }
  });

  assert.match(context, /直近の行き先での会話: セラ・アストルーペ（character_001）との会話/);
  assert.match(context, /ルミが覗ける一番新しい記憶: 主人公は星図の読み方を少し覚えた。/);
  assert.match(context, /直近コンテンツ結果: 鍛錬（完了）/);
  assert.match(context, /光曜:治癒魔法実習/);
  assert.match(context, /光魔法習熟度 \+2/);
  assert.match(context, /筋力 -1/);
  assert.match(context, /現在の相棒: ミラ（character_002）/);
  assert.match(context, /現在のライバル: ノクス（character_003）/);
});

test('routing meta context renders fresh dungeon result details', () => {
  const context = buildRoutingMetaContext({
    state: { elapsed_weeks: 4 },
    routingHubContext: {
      persona_variant: 'fallen_star',
      recent_conversation_context: {
        kind: 'no_new_conversation',
        conversation_id: null,
        character_id: null,
        character_name: null,
        memory_text: null
      },
      relationship_context: {
        buddy: null,
        enemies: []
      },
      alchemy_context: {
        recipe_count: 8
      },
      study_circle_context: {
        theme_count: trainingDefinitions.length,
        weekly_offer_count: 3
      },
      content_result_context: {
        record: {
          kind: 'dungeon',
          destination_id: 'dungeon',
          week: 4,
          recorded_at: '2026-05-05T06:20:00.000+09:00',
          trigger: 'dungeon_run_committed',
          detail: {
            outcome: 'retreated',
            floor_reached: 3,
            max_floors: MAX_FLOORS,
            applied_gains: {
              magic: { fire: 1 },
              abilities: { agility: 2 }
            },
            total_applied: 3,
            companion_character_id: 'character_004'
          }
        },
        companion: { character_id: 'character_004', display_name: 'ルカ' }
      }
    }
  });

  assert.match(context, /直近コンテンツ結果: ダンジョン（撤退）/);
  assert.match(context, new RegExp(`到達階: 3/${MAX_FLOORS}`));
  assert.match(context, /火魔法習熟度 \+1/);
  assert.match(context, /瞬発力 \+2/);
  assert.match(context, /同行者: ルカ/);
});

test('routing meta context announces a fresh workshop weapon craft with its confirmed identity', () => {
  const context = buildRoutingMetaContext({
    state: { elapsed_weeks: 4 },
    routingHubContext: baseRoutingHubContext({
      content_result_context: {
        record: {
          kind: 'workshop',
          destination_id: 'workshop',
          week: 4,
          recorded_at: '2026-05-05T06:30:00.000+09:00',
          trigger: 'workshop_craft_completed',
          detail: {
            outcome: 'completed',
            recipe_id: 'weapon_sword_fire_t3',
            kind: 'weapon',
            weapon_type: 'sword',
            element: 'fire',
            tier: 3,
            quality: 'masterwork',
            name: '紅蓮ノ剣',
            flavor: '炉の残り火を宿した刃。'
          }
        },
        companion: null
      }
    })
  });

  assert.match(context, /直近コンテンツ結果: 工房（紅蓮ノ剣）。仕上がり: 武器（剣）・属性火・階級T3・出来栄え傑作。/);
  // The announcement names only the confirmed item identity; the LLM flavor line is not injected.
  assert.doesNotMatch(context, /炉の残り火/);
});

test('routing meta context announces a fresh workshop amulet craft (no weapon_type segment)', () => {
  const context = buildRoutingMetaContext({
    state: { elapsed_weeks: 4 },
    routingHubContext: baseRoutingHubContext({
      content_result_context: {
        record: {
          kind: 'workshop',
          destination_id: 'workshop',
          week: 4,
          recorded_at: '2026-05-05T06:35:00.000+09:00',
          trigger: 'workshop_craft_completed',
          detail: {
            outcome: 'completed',
            recipe_id: 'amulet_water_t1',
            kind: 'amulet',
            element: 'water',
            tier: 1,
            quality: 'fine',
            name: '水鏡の護り',
            flavor: '静かな水面のように心を映す。'
          }
        },
        companion: null
      }
    })
  });

  assert.match(context, /直近コンテンツ結果: 工房（水鏡の護り）。仕上がり: 護符・属性水・階級T1・出来栄え良。/);
  assert.doesNotMatch(context, /武器（/);
});

test('routing meta context rejects inconsistent recent conversation snapshots', () => {
  const baseContext = {
    persona_variant: 'fallen_star',
    recent_conversation_context: {
      kind: 'no_new_conversation',
      conversation_id: null,
      character_id: null,
      character_name: null,
      memory_text: null
    },
    relationship_context: {
      buddy: null,
      enemies: []
    },
    alchemy_context: {
      recipe_count: 8
    },
    study_circle_context: {
      theme_count: trainingDefinitions.length,
      weekly_offer_count: 3
    },
    content_result_context: null
  };

  assert.throws(() => buildRoutingMetaContext({
    state: { elapsed_weeks: 4 },
    routingHubContext: {
      ...baseContext,
      alchemy_context: undefined
    }
  }), /routingHubContext\.alchemy_context must be an object/);

  assert.throws(() => buildRoutingMetaContext({
    state: { elapsed_weeks: 4 },
    routingHubContext: {
      ...baseContext,
      study_circle_context: undefined
    }
  }), /routingHubContext\.study_circle_context must be an object/);

  assert.throws(() => buildRoutingMetaContext({
    state: { elapsed_weeks: 4 },
    routingHubContext: {
      ...baseContext,
      recent_conversation_context: {
        ...baseContext.recent_conversation_context,
        character_id: 'character_001'
      }
    }
  }), /routingHubContext\.recent_conversation_context\.character_id must be null/);

  assert.throws(() => buildRoutingMetaContext({
    state: { elapsed_weeks: 4 },
    routingHubContext: {
      ...baseContext,
      recent_conversation_context: {
        kind: 'conversation_without_memory',
        conversation_id: 'conv_recent_no_memory_001',
        character_id: 'character_001',
        character_name: 'セラ・アストルーペ',
        memory_text: '矛盾した記憶'
      }
    }
  }), /routingHubContext\.recent_conversation_context\.memory_text must be null/);
});

test('routing opening smalltalk guidance renders all deterministic branches from the snapshot', () => {
  const memoryGuidance = buildRoutingOpeningSmalltalkGuidance(baseRoutingHubContext({
    recent_conversation_context: {
      kind: 'conversation_memory',
      conversation_id: 'conv_recent_memory_001',
      character_id: 'character_001',
      character_name: 'セラ・アストルーペ',
      memory_text: '主人公は星図の読み方を少し覚えた。'
    }
  }));
  assert.match(memoryGuidance, /ルーティングハブopening誘導:/);
  assert.match(memoryGuidance, /主人公は星図の読み方を少し覚えた。/);
  assert.match(memoryGuidance, /行き先の確認・催促から入らない/);
  assert.match(memoryGuidance, /世間話から入る/);
  assert.match(memoryGuidance, /世間話がひと段落してから/);

  const noMemoryGuidance = buildRoutingOpeningSmalltalkGuidance(baseRoutingHubContext({
    recent_conversation_context: {
      kind: 'conversation_without_memory',
      conversation_id: 'conv_recent_no_memory_001',
      character_id: 'character_002',
      character_name: 'ミラ',
      memory_text: null
    }
  }));
  assert.match(noMemoryGuidance, /ミラ（character_002）との会話があった事実/);
  assert.match(noMemoryGuidance, /記憶を捏造しない/);
  assert.match(noMemoryGuidance, /行き先の確認・催促から入らない/);

  const contentResultGuidance = buildRoutingOpeningSmalltalkGuidance(baseRoutingHubContext({
    content_result_context: trainingContentResultContext()
  }));
  assert.match(contentResultGuidance, /直近コンテンツ結果: 鍛錬（完了）/);
  assert.match(contentResultGuidance, /光曜:治癒魔法実習/);
  assert.match(contentResultGuidance, /自然に世間話を切り出す/);
  assert.match(contentResultGuidance, /行き先の確認・催促から入らない/);

  const genericGuidance = buildRoutingOpeningSmalltalkGuidance(baseRoutingHubContext());
  assert.match(genericGuidance, /体調・気分・近況を伺う世間話/);
  assert.match(genericGuidance, /行き先の確認・催促から入らない/);
});

test('routing opening smalltalk guidance fails fast on an unknown recent conversation kind', () => {
  assert.throws(() => buildRoutingOpeningSmalltalkGuidance(baseRoutingHubContext({
    recent_conversation_context: {
      kind: 'banana',
      conversation_id: null,
      character_id: null,
      character_name: null,
      memory_text: null
    }
  })), /routingHubContext\.recent_conversation_context\.kind/);
});

test('routing destination catalog validation rejects duplicate public text fields', () => {
  const duplicateLabel = [
    { id: 'a', label: '重複', description: '説明A' },
    { id: 'b', label: '重複', description: '説明B' }
  ];
  const duplicateDescription = [
    { id: 'a', label: 'A', description: '同じ説明' },
    { id: 'b', label: 'B', description: '同じ説明' }
  ];

  assert.throws(() => validateRoutingDestinations(duplicateLabel), /routing destination\.label must be unique/);
  assert.throws(() => validateRoutingDestinations(duplicateDescription), /routing destination\.description must be unique/);
});

test('routing destination parser accepts only none or exact closed-catalog ids', () => {
  const training = parseRoutingDestinationAnswer('training');
  assert.equal(training.id, 'training');
  assert.equal(training.label, '鍛錬');
  assert.equal(parseRoutingDestinationAnswer('none'), null);
  assert.equal(parseRoutingDestinationAnswer(' NONE '), null);

  assert.throws(() => parseRoutingDestinationAnswer(''), /routing destination answer is required/);
  assert.throws(() => parseRoutingDestinationAnswer('学院マップ'), /unknown routing destination/);
  assert.throws(() => parseRoutingDestinationAnswer('training\ndungeon'), /unknown routing destination/);
});

test('routing destination narration explains the selected destination without dispatch data', () => {
  const dungeon = parseRoutingDestinationAnswer('dungeon');
  assert.equal(
    buildRoutingDestinationNarration(dungeon),
    `行き先は${dungeon.label}に決まった。${dungeon.description}`
  );
});
