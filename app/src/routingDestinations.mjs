export const routingDestinations = Object.freeze([
  Object.freeze({
    id: 'academy-map',
    label: '学院マップ',
    description: '学院内の場所を選び、従来どおり特定キャラクターとの会話やフィールド探索へ入る。特定キャラクターとの会話はルーティングから直接ではなく学院マップ経由で入る。'
  }),
  Object.freeze({
    id: 'training',
    label: '鍛錬',
    description: '六つの行動で一週間の鍛錬を進め、魔法習熟度と基礎能力のパラメーターを増減させる。'
  }),
  Object.freeze({
    id: 'dungeon',
    label: 'ダンジョン',
    description: '自動生成ダンジョンで探索と戦闘を行い、実践を通じてパラメーターを鍛え、持ち帰り報酬を得る。'
  }),
  Object.freeze({
    id: 'errand',
    label: '依頼',
    description: '学外・学内の小さな依頼を1件引き受けて一週間を使い、依頼主との会話を経て所持金の報酬を得る。'
  }),
  Object.freeze({
    id: 'alchemy',
    label: '調合',
    description: '錬金術実習室で週替わりの小調合を1件行い、素材と所持金を使ってパラメーター上昇・霊薬・売却用調合品のいずれかを得る。'
  }),
  Object.freeze({
    id: 'study_circle',
    label: '研究会',
    description: '週替わりの研究テーマを1件選び、主催キャラクターとの会話を経て、対応する鍛錬単位のパラメーター上昇を得る。'
  }),
  Object.freeze({
    id: 'workshop',
    label: '工房',
    description: '学院の工房で、ダンジョンで集めた属性素材と所持金を使って武器や護符をクラフトする。腕前と素材の階級に応じた出来栄えの装備が仕上がり、実践の戦闘値に反映される。'
  }),
  Object.freeze({
    id: 'library',
    label: '大書庫',
    description: '学院の大書庫にこもり、読みたいテーマの本を探して読む。世界のロアに触れて断片を収蔵庫に残すだけの一週間で、パラメーターや習熟度は動かない。'
  }),
  Object.freeze({
    id: 'arena',
    label: '闘技会',
    description: '学院公認の武闘催事に出場する。週替わりの16枠トーナメントに一人・二人・バディー観戦のいずれかで臨み、実戦の戦闘で勝ち抜いて賞金と素材を得る。'
  }),
  Object.freeze({
    id: 'auction',
    label: '競売場',
    description: '宵に開かれる競売の夜会に足を運ぶ。週替わりの三つの品を、オークションマスターの司会のもとで居合わせた客と競り合い、上乗せ額を積んで武器・護符・貴重品・愛玩の品やうちの子候補を落札する。'
  }),
  Object.freeze({
    id: 'lounge',
    label: '談話室',
    description: '寮の談話室に立ち寄り、居合わせた学友三人と車座になって他愛のない語らいに加わる。相手一人と向き合う会話ではなく、複数人での掛け合いを楽しむ一週間。'
  }),
  Object.freeze({
    id: 'homunculus',
    label: '錬成室',
    description: '学院の建前の外にある錬成室にこもり、重い素材と大金を注いで自分だけのホムンクルスを錬成する。生まれた子は錬成室に住み、会いに行って言葉を交わせる。'
  }),
  Object.freeze({
    id: 'title',
    label: '区切りをつける',
    description: '今日はここまでにして一区切りをつけ、タイトル画面へ戻る。プレイヤーが「区切りをつけたい」「今日はここまで」と切り上げる意図を見せたときに選ぶ。この行き先だけは一週間を進めない中立な退出で、次の再開は同じ週から続く。'
  })
]);

// Gated destinations: catalog members that never appear in the candidate set by default (fail-closed). They
// are added back only when an explicit unlock signal (derived from player parameters at hub-context build
// time) lists them. `homunculus`（錬成室）is unlocked once any magic proficiency reaches its threshold — the
// same fail-closed 高位閾値 shape as the禁書 gate: the existence is not even offered until earned.
export const GATED_ROUTING_DESTINATION_IDS = Object.freeze(new Set(['homunculus']));

export function isGatedRoutingDestination(destinationId) {
  return GATED_ROUTING_DESTINATION_IDS.has(destinationId);
}

export function validateRoutingDestinations(destinations) {
  if (!Array.isArray(destinations)) throw new Error('routing destinations must be an array');
  if (destinations.length === 0) throw new Error('routing destinations must not be empty');
  const seenIds = new Set();
  const seenLabels = new Set();
  const seenDescriptions = new Set();
  return destinations.map((destination) => {
    if (!destination || typeof destination !== 'object') throw new Error('routing destination must be an object');
    const id = String(destination.id ?? '').trim();
    const label = String(destination.label ?? '').trim();
    const description = String(destination.description ?? '').trim();
    if (!id) throw new Error('routing destination.id is required');
    if (!label) throw new Error(`routing destination.label is required: ${id}`);
    if (!description) throw new Error(`routing destination.description is required: ${id}`);
    if (seenIds.has(id)) throw new Error(`routing destination.id must be unique: ${id}`);
    if (seenLabels.has(label)) throw new Error(`routing destination.label must be unique: ${label}`);
    if (seenDescriptions.has(description)) throw new Error(`routing destination.description must be unique: ${id}`);
    seenIds.add(id);
    seenLabels.add(label);
    seenDescriptions.add(description);
    return { id, label, description };
  });
}

export function parseRoutingDestinationAnswer(answer, destinations = routingDestinations) {
  const raw = String(answer ?? '').trim();
  if (!raw) throw new Error('routing destination answer is required');
  if (raw.toLowerCase() === 'none') return null;
  const destinationMap = new Map(validateRoutingDestinations(destinations).map((destination) => [destination.id, destination]));
  const destination = destinationMap.get(raw);
  if (!destination) throw new Error(`unknown routing destination: ${raw}`);
  return destination;
}

export function buildRoutingDestinationNarration(destination) {
  const [normalizedDestination] = validateRoutingDestinations([destination]);
  return `行き先は${normalizedDestination.label}に決まった。${normalizedDestination.description}`;
}
