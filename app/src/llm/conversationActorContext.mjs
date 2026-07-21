import { magicParameterDefinitions, normalizeParameters } from '../parameters.mjs';
import { createStorageApi } from '../storage.mjs';
import {
  characterAffinityPath,
  normalizeCharacterAffinityFile
} from '../affinitySchema.mjs';
import {
  homunculusAffinityPath,
  normalizeHomunculusAffinityFile
} from '../homunculusAffinity.mjs';

export const AFFINITY_CONTEXT_SCALE = '0=強い忌避・25=同級生の標準的な距離感・50=気安い相手・70=親しい友人・90以上=特別な存在';

const ACADEMY_AFFINITY_CHARACTER_ID_PATTERN = /^character_\d{3}$/;

export const MAGIC_KNOWLEDGE_TEXTS = Object.freeze({
  light: Object.freeze({
    basic: '光魔法の基礎。光は生成・集束・定着の三段で扱い、初学者はまず魔力を安定した光源に変えることから学ぶ。光には照らす・浄める・癒すの三つの性質（三性）があり、浄化は穢れや弱い呪いを流し、治癒は生体の自然回復を後押しする補助が基本で、失われたものを作り出すことはできない。治癒は蘇生回復術の入り口にあたり、応用分野への登竜門とされる。強い光は目と魔力路を焼くため、集束が未熟なうちは長時間の行使を避けるのが常識。',
    advanced: '光魔法の応用。高位治癒では対象の魔力路そのものを整え、外傷だけでなく呪いや毒の進行を堰き止められる。光は結界術と親和性が高く、境界に光を編み込む手法は封印の維持や検分に使われる。封印や呪いの解析では、編まれた光の層を一枚ずつ読む「読層」が基本で、力ずくの浄化は術式ごと壊す危険がある。光の極致は「作らず、正す」——在るべき状態へ戻す力であり、死者の蘇生のような無からの創造には決して届かない。この限界の理解こそ応用者の証とされる。'
  }),
  dark: Object.freeze({
    basic: '闇魔法の基礎。闇は光の欠如ではなく、沈静・遮蔽・重みを司る独立した系統。初歩では影の操作、音や気配の遮断、昂ぶった魔力や感情を鎮める沈静術を学ぶ。封印の初歩も闇の領分で、動くものを留め置く「錨」の術理が基本になる。死霊術は闇の応用の一つだが、生死の境を侵すため禁域とされ、学院では理由の理解までを教え実践は禁じる。闇は使い手の心の揺れに敏感で、恐れや執着を抱えたまま行使すると術が濁る、と最初に教わる。',
    advanced: '闇魔法の応用。封印術式は錨・鎖・封の三層で編まれ、掛けるにも解くにも層の順を読む素養が要る。呪いは他者に掛けられた闇の術式として逆算・解体でき、光の浄化と対をなす技術とされる。古い封印や呪いの記述は古代語で残ることが多く、応用者には古代語文献を読む素養が求められる。闇の極致は「留める」こと——時間・記憶・魂の流れを一時的に堰き止める領域に踏み込むが、留めたものは必ず流れを取り戻す。この原則を破れば術者自身が代償を払うとされる。'
  }),
  fire: Object.freeze({
    basic: '火魔法の基礎。火は起こす・保つ・止めるの三段で扱い、初学者は小さな火種を一定の火勢で保ち続ける訓練から入る。火は六系統でもっとも応えが早い代わりに、術者の昂ぶりをそのまま映す——感情で火勢が跳ねるうちは一人前と見なされない。錬金術や調合では素材ごとに適した熱があり、強い火より「変わらない火」が価値を持つ。火は起こすより止める方が難しく、火止めを習得して初めて火を扱う資格を得る、と最初に教わる。',
    advanced: '火魔法の応用。魔導工学の炉心は、燃料でなく術式で燃え続ける「常火」を核とし、常火を安定させる設計こそ炉心理論の中心とされる。火の精霊との契約は支配ではなく貸借の作法で結ぶ——名を尋ね、対価を示し、返す期限を違えないこと。契約の火は術者の力量を超えた熱を貸すが、返し忘れた火は必ず貸し主のもとへ帰り、その道筋にあるものを選ばない。火の極致は「借りた火を借りたまま返す」節度にあり、火を我が物と思った者から灼かれる、とされる。'
  }),
  water: Object.freeze({
    basic: '水魔法の基礎。水は無から生めない——大気や土から「汲む」ことから始まり、汲んだ水を巡らせ、使い終えたら在るべき場所へ返す。この汲み・巡り・返しの循環が水術の骨格になる。氷は水の一態であり、止めた水は必ずいつか解けるという前提で使う。薬草の抽出や調合では、魔力を帯びた「調合水」の質が仕上がりを左右し、澄んだ水を保てることが調合系の応用へ進む条件とされる。水は器に従うのではなく道に従う——押さえ込むより導く方が強い、と教わる。',
    advanced: '水魔法の応用。治癒と併用する水術では、癒しの術を水に乗せて体内へ巡らせる「活水」が中核で、光の治癒が届きにくい深部や毒の洗い出しに用いられる。大規模な流れの操作は水術の到達点だが、原則はあくまで「導く」こと——堰き止めた流れは必ずどこかで溢れ、術者の見えない場所で代償を取る。活水は生命に近い水ゆえに濁りやすく、術者自身が乱れていれば癒すはずの水が障る。水の極致は力の大きさではなく、返し際の美しさで測られる、とされる。'
  }),
  earth: Object.freeze({
    basic: '土魔法の基礎。土は六系統でもっとも遅く、もっとも確かとされる。初歩では土石の成形と硬化、そして素材の性質を手で「聞く」ことを学ぶ——鉱物や魔道具の素材学は土の領分で、良い素材を見分ける目は術より先に仕込まれる。土は急がせると脆くなる。速く固めた壁は速く崩れ、時間をかけて成した物だけが術者の手を離れても保つ。派手さはないが、他系統の術も足場となる土が乱れれば崩れる——土を制する者は崩れない、と教わる。',
    advanced: '土魔法の応用。大地には魔力の流れ——地脈——が巡っており、応用者はまずこれを「読む」ことを学ぶ。地脈は水脈のように張り巡らされ、良い土地・障る土地の別は地脈の淀みで説明される。結界の基礎構築も土の領分で、境界を保つ結界は地に打つ「礎」の確かさで寿命が決まり、光や闇の編みは礎の上に載る飾りに過ぎない、と土の使い手は言う。地脈は読み、借りるもので、奪えば土地ごと枯れる。地脈から力を引き抜く術は、それゆえ厳しく戒められている。'
  }),
  wind: Object.freeze({
    basic: '風魔法の基礎。風は掴めない——押すのではなく、風の通り道「風筋」を作って通すのが風術の基本とされる。初歩では気流の操作、声を風に乗せて届ける伝声、そして空の色や風の匂いから天気を読む気象観察を学ぶ。風は六系統でもっとも軽く速いが、その分だけ留まらず、風で成したものは風のうちに消える。永続を求める術には向かない代わりに、届ける・逃がす・知らせることにおいて並ぶものがない。風を読める者は、人の噂の流れまで読めるようになる、と冗談交じりに教わる。',
    advanced: '風魔法の応用。高く昇るほど風は星の巡りと結びつき、高層の流れ「星風」を読むことは占星術への入り口とされる。使い魔の飛行制御も風の領分で、翼あるものに風筋を貸す術は、使い魔との信頼がなければ風ごと拒まれる。遠距離伝令は風術の華だが、遠くへ届けるほど言葉は薄れ、風は秘密を運びたがる——封をせずに乗せた言葉は、いつか知らない耳に届くという戒めがある。風の極致は「風に願いを通す」こと。命じた風は逆らい、願った風だけが遠くまで行く、とされる。'
  })
});

const MAGIC_KNOWLEDGE_LABELS = Object.freeze({
  light: '光',
  dark: '闇',
  fire: '火',
  water: '水',
  earth: '土',
  wind: '風'
});

const BASIC_THRESHOLD = 50;
const ADVANCED_THRESHOLD = 80;

function magicKnowledgeEntry(key, tier) {
  const label = MAGIC_KNOWLEDGE_LABELS[key];
  const body = MAGIC_KNOWLEDGE_TEXTS[key]?.[tier];
  if (!label || !body) throw new Error(`magic knowledge text is missing: ${key}.${tier}`);
  return {
    title: `${label}・${tier === 'basic' ? '基礎' : '応用'}`,
    body
  };
}

export function buildMagicKnowledgeActorContext(parameters) {
  const normalized = normalizeParameters(parameters);
  const entries = [];
  for (const definition of magicParameterDefinitions) {
    const value = normalized.magic[definition.key].value;
    if (value >= BASIC_THRESHOLD) entries.push(magicKnowledgeEntry(definition.key, 'basic'));
    if (value >= ADVANCED_THRESHOLD) entries.push(magicKnowledgeEntry(definition.key, 'advanced'));
  }
  if (entries.length === 0) return null;
  return { sections: [{ title: '系統知識', entries }] };
}

function affinityContextEntry(affinityFile) {
  return {
    title: '主人公への好感度',
    body: `主人公への好感度: ${affinityFile.affinity}/100（${AFFINITY_CONTEXT_SCALE}）`
  };
}

async function buildAffinityActorContext(root, actor) {
  if (actor.kind === 'creature') return null;
  if (actor.kind === 'homunculus') {
    // A homunculus carries affinity for its creator on the same 0..100 temperature-anchor scale as the
    // academy, injected the same way; only the stored path (its own actor directory) and the opening value
    // (50, not 25) differ.
    const storage = createStorageApi({ root });
    const affinityFile = normalizeHomunculusAffinityFile(
      await storage.readJsonIfExists(homunculusAffinityPath(actor.id)),
      actor.id
    );
    return {
      sections: [{
        title: '好感度',
        entries: [affinityContextEntry(affinityFile)]
      }]
    };
  }
  if (actor.kind !== 'character') throw new Error(`unsupported dialogue actor kind for actor context: ${actor.kind}`);
  if (actor.id !== 'lina' && !ACADEMY_AFFINITY_CHARACTER_ID_PATTERN.test(actor.id)) return null;
  const storage = createStorageApi({ root });
  const affinityFile = normalizeCharacterAffinityFile(
    await storage.readJsonIfExists(characterAffinityPath(actor.id)),
    actor.id
  );
  return {
    sections: [{
      title: '好感度',
      entries: [affinityContextEntry(affinityFile)]
    }]
  };
}

export async function buildConversationActorContextSnapshot({ root, actor, profile }) {
  if (!root) throw new Error('root is required');
  if (!actor || typeof actor !== 'object') throw new Error('dialogue actor is required');
  const sections = [];
  const magicKnowledgeContext = buildMagicKnowledgeActorContext(profile?.parameters);
  if (magicKnowledgeContext) sections.push(...magicKnowledgeContext.sections);
  const affinityContext = await buildAffinityActorContext(root, actor);
  if (affinityContext) sections.push(...affinityContext.sections);
  if (sections.length === 0) return null;
  return { sections };
}

function normalizeRequiredText(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const text = value.trim();
  if (!text) throw new Error(`${label} must not be empty`);
  return text;
}

export function normalizeConversationActorContext(context) {
  if (context == null) return null;
  if (typeof context !== 'object' || Array.isArray(context)) {
    throw new Error('conversationActorContext must be an object');
  }
  if (!Array.isArray(context.sections)) throw new Error('conversationActorContext.sections must be an array');
  if (context.sections.length === 0) throw new Error('conversationActorContext.sections must not be empty');
  const sections = context.sections.map((section, sectionIndex) => {
    if (typeof section !== 'object' || section === null || Array.isArray(section)) {
      throw new Error(`conversationActorContext.sections[${sectionIndex}] must be an object`);
    }
    if (!Array.isArray(section.entries)) {
      throw new Error(`conversationActorContext.sections[${sectionIndex}].entries must be an array`);
    }
    if (section.entries.length === 0) {
      throw new Error(`conversationActorContext.sections[${sectionIndex}].entries must not be empty`);
    }
    return {
      title: normalizeRequiredText(section.title, `conversationActorContext.sections[${sectionIndex}].title`),
      entries: section.entries.map((entry, entryIndex) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          throw new Error(`conversationActorContext.sections[${sectionIndex}].entries[${entryIndex}] must be an object`);
        }
        return {
          title: normalizeRequiredText(entry.title, `conversationActorContext.sections[${sectionIndex}].entries[${entryIndex}].title`),
          body: normalizeRequiredText(entry.body, `conversationActorContext.sections[${sectionIndex}].entries[${entryIndex}].body`)
        };
      })
    };
  });
  return { sections };
}

export function renderConversationActorContext(context) {
  const normalized = normalizeConversationActorContext(context);
  if (!normalized) return null;
  return [
    '会話相手コンテキスト:',
    ...normalized.sections.flatMap((section) => [
      `${section.title}:`,
      ...section.entries.flatMap((entry) => [`- ${entry.title}:`, entry.body])
    ])
  ].join('\n');
}
