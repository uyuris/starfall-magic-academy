// The homunculus face pool: the 50 pre-authored faces (hp_001..hp_050) the atelier binds to a newly
// synthesized child. This module is the RUNTIME source of the pool ledger — the per-lane appearance tags
// used to present the closed-set selection candidates to the model. The design ledger lives at
// .agents/docs/design/homunculus-pool-ledger-draft.md; this transcribes its per-lane tags (no persona /
// name / history — a lane is appearance only). The faces are authored visual sets under
// assets/canonical/character_visual_sets/hp_*, a区画 separate from the roster (characterCount 契約 に触れない).
//
// A face_id doubles as the actor's visual_set_id. Selection is a strict closed set over the pool MINUS the
// faces already used by this save's active ∪ nameplate homunculi, so a face never repeats within a save.

import { HOMUNCULUS_FACE_POOL_SIZE, isAuctionFaceId } from './homunculusSurface.mjs';

// Each lane: appearance tags only. gender/age/atmosphere are the visual-impression axes; hair carries the
// color family + concrete style; eye is the iris color. These are what the selection prompt shows the model.
export const HOMUNCULUS_FACE_POOL = Object.freeze([
  { id: 'hp_001', gender: '女性的', age: '幼め', hair_color: '白銀', hair: '白銀の短めボブ・毛先ゆるく内巻き', eye: '空色', atmosphere: 'あどけない' },
  { id: 'hp_002', gender: '男性的', age: '年上め', hair_color: '茶', hair: '砂色ブラウンの刈り上げ・トップ長め片流し', eye: 'スレートグレー', atmosphere: 'クール' },
  { id: 'hp_003', gender: '中性的', age: '年上め', hair_color: '青銀寒色', hair: '青銀のロングをまっすぐ背に垂らす', eye: 'ラベンダー菫', atmosphere: 'ミステリアス' },
  { id: 'hp_004', gender: '女性的', age: '同年代', hair_color: '金黄', hair: '蜂蜜金のゆる巻きハーフアップ', eye: '蜂蜜', atmosphere: '柔和' },
  { id: 'hp_005', gender: '男性的', age: '年上め', hair_color: '紫', hair: '濃紫を後ろで低く束ね・片房を垂らす', eye: 'ガーネット赤', atmosphere: '妖しい' },
  { id: 'hp_006', gender: '中性的', age: '幼め', hair_color: '緑', hair: '苔緑の短髪・うなじで小さくまとめ', eye: 'トパーズ黄', atmosphere: '物静か' },
  { id: 'hp_007', gender: '女性的', age: '同年代', hair_color: '赤橙暖色', hair: '赤銅のロングウェーブ・片側編み込み', eye: 'ルビー赤', atmosphere: '妖しい' },
  { id: 'hp_008', gender: '男性的', age: '同年代', hair_color: '黒暗色', hair: '黒髪の短髪・前髪を上げた額出し', eye: '深紅', atmosphere: '凛々しい' },
  { id: 'hp_009', gender: '中性的', age: '年上め', hair_color: '緑', hair: 'セージ緑のミディアム・片側で編み下ろし', eye: '琥珀茶', atmosphere: '柔和' },
  { id: 'hp_010', gender: '女性的', age: '同年代', hair_color: '黒暗色', hair: '藍を帯びた黒のロング・まっすぐ背に', eye: '深い藍紫', atmosphere: 'ミステリアス' },
  { id: 'hp_011', gender: '女性的', age: '同年代', hair_color: '白銀', hair: '白銀のストレートロング・センター分けで背に流す', eye: 'スレートブルー', atmosphere: '凛々しい' },
  { id: 'hp_012', gender: '男性的', age: '同年代', hair_color: '金黄', hair: '砂金ブロンドの短髪・前髪上げ', eye: '琥珀', atmosphere: '凛々しい' },
  { id: 'hp_013', gender: '中性的', age: '幼め', hair_color: '黒暗色', hair: '墨黒の短髪・寝癖でひと房跳ね', eye: '暗い菫', atmosphere: 'ミステリアス' },
  { id: 'hp_014', gender: '女性的', age: '幼め', hair_color: '赤橙暖色', hair: '明るい橙のショート・外はね', eye: 'タンジェリン橙', atmosphere: '活発' },
  { id: 'hp_015', gender: '男性的', age: '年上め', hair_color: '青銀寒色', hair: '青銀を後ろで小さく束ねた武人風', eye: 'トパーズ黄', atmosphere: '凛々しい' },
  { id: 'hp_016', gender: '中性的', age: '同年代', hair_color: '紫', hair: '藤鼠のミディアム・片側で緩く編む', eye: 'ペリウィンクル菫青', atmosphere: '柔和' },
  { id: 'hp_017', gender: '女性的', age: '年上め', hair_color: '金黄', hair: '濃い金のロングウェーブを片側へ流す', eye: '燠火橙', atmosphere: '妖しい' },
  { id: 'hp_018', gender: '男性的', age: '幼め', hair_color: '緑', hair: '若竹緑の短髪・あちこち跳ね', eye: 'アクア', atmosphere: '活発' },
  { id: 'hp_019', gender: '中性的', age: '同年代', hair_color: '赤橙暖色', hair: '珊瑚朱のショートボブ', eye: '薔薇色', atmosphere: 'あどけない' },
  { id: 'hp_020', gender: '女性的', age: '幼め', hair_color: '茶', hair: 'ミルクティー茶のゆる巻き・片側で緩く編む', eye: '琥珀', atmosphere: '柔和' },
  { id: 'hp_021', gender: '女性的', age: '年上め', hair_color: '白銀', hair: 'プラチナ白銀・片側へ流す緩ウェーブのロング', eye: '淡い銀灰', atmosphere: 'ミステリアス' },
  { id: 'hp_022', gender: '男性的', age: '年上め', hair_color: '白銀', hair: '白銀の短髪を後ろへ撫でつけ', eye: '鋼灰', atmosphere: 'クール' },
  { id: 'hp_023', gender: '中性的', age: '幼め', hair_color: '金黄', hair: '明るい金のくせ毛短め・あちこち跳ね', eye: 'レモン黄', atmosphere: 'あどけない' },
  { id: 'hp_024', gender: '女性的', age: '幼め', hair_color: '紫', hair: 'マゼンタ寄り紫のツインテール・遊ばせ', eye: '薔薇色', atmosphere: '妖しい' },
  { id: 'hp_025', gender: '男性的', age: '同年代', hair_color: '青銀寒色', hair: '青銀の短髪・軽い外はね', eye: '翡翠', atmosphere: 'クール' },
  { id: 'hp_026', gender: '中性的', age: '年上め', hair_color: '茶', hair: 'ウォルナット茶を首の後ろで低くひとつ', eye: '蜂蜜', atmosphere: '柔和' },
  { id: 'hp_027', gender: '女性的', age: '同年代', hair_color: '緑', hair: 'ライム緑のショート・毛先跳ね', eye: '琥珀に緑のにじみ', atmosphere: '活発' },
  { id: 'hp_028', gender: '男性的', age: '年上め', hair_color: '赤橙暖色', hair: '赤錆に沈むミディアム・後ろで低く束ね', eye: '金', atmosphere: '妖しい' },
  { id: 'hp_029', gender: '中性的', age: '幼め', hair_color: '紫', hair: 'ラベンダーの短めボブ・毛先ふわり', eye: '藤', atmosphere: 'あどけない' },
  { id: 'hp_030', gender: '女性的', age: '同年代', hair_color: '青銀寒色', hair: '青みがかった銀のロング・高い位置でポニーテール', eye: '水縹', atmosphere: 'クール' },
  { id: 'hp_031', gender: '女性的', age: '幼め', hair_color: '青銀寒色', hair: '青銀の短めふわボブ', eye: 'シアン晴天青', atmosphere: '柔和' },
  { id: 'hp_032', gender: '男性的', age: '同年代', hair_color: '茶', hair: '黒みの濃い茶の短髪・きっちり分け', eye: '静かな灰', atmosphere: '物静か' },
  { id: 'hp_033', gender: '中性的', age: '同年代', hair_color: '白銀', hair: '白銀のアシメ・片側刈り上げトップ長め片流し', eye: 'アイスグレー', atmosphere: 'クール' },
  { id: 'hp_034', gender: '女性的', age: '幼め', hair_color: '金黄', hair: '山吹金のツインテール', eye: '空色', atmosphere: '活発' },
  { id: 'hp_035', gender: '男性的', age: '幼め', hair_color: '紫', hair: '薄藤の短髪・さらり', eye: 'サファイア', atmosphere: '物静か' },
  { id: 'hp_036', gender: '中性的', age: '幼め', hair_color: '茶', hair: '栗色の短い巻き毛', eye: '焦げ茶', atmosphere: 'あどけない' },
  { id: 'hp_037', gender: '女性的', age: '年上め', hair_color: '黒暗色', hair: '濃紺黒のロングウェーブ・片側へ', eye: 'ワインレッド', atmosphere: '妖しい' },
  { id: 'hp_038', gender: '男性的', age: '同年代', hair_color: '赤橙暖色', hair: '深紅の逆立て短髪・片側刈り上げ', eye: '鮮緑', atmosphere: '凛々しい' },
  { id: 'hp_039', gender: '中性的', age: '同年代', hair_color: '金黄', hair: '亜麻金の襟足はね短髪', eye: 'オリーブ緑', atmosphere: '活発' },
  { id: 'hp_040', gender: '男性的', age: '年上め', hair_color: '黒暗色', hair: '黒に片房白のミディアム・後ろで結ぶ', eye: '淡い灰青', atmosphere: 'ミステリアス' },
  { id: 'hp_041', gender: '女性的', age: '年上め', hair_color: '茶', hair: '濃い栗色のストレートロング・低い位置でまとめ', eye: 'ヘーゼル', atmosphere: '物静か' },
  { id: 'hp_042', gender: '男性的', age: '幼め', hair_color: '茶', hair: 'シナモン茶のくしゃっと短髪', eye: 'マーマレード橙', atmosphere: 'あどけない' },
  { id: 'hp_043', gender: '中性的', age: '年上め', hair_color: '白銀', hair: '白銀をうなじで低くひとつ結い', eye: '淡青', atmosphere: '物静か' },
  { id: 'hp_044', gender: '女性的', age: '幼め', hair_color: '緑', hair: 'ミントグリーンの短めふわ髪', eye: '若草', atmosphere: '柔和' },
  { id: 'hp_045', gender: '男性的', age: '同年代', hair_color: '白銀', hair: '白銀の襟足短め・前髪上げの額出し', eye: '琥珀金', atmosphere: '凛々しい' },
  { id: 'hp_046', gender: '中性的', age: '同年代', hair_color: '青銀寒色', hair: '青銀のミディアム・片側で細い三つ編み', eye: '藤', atmosphere: '物静か' },
  { id: 'hp_047', gender: '女性的', age: '年上め', hair_color: '紫', hair: '深い菫紫のロング・まっすぐ背に', eye: 'アメジスト', atmosphere: 'ミステリアス' },
  { id: 'hp_048', gender: '男性的', age: '年上め', hair_color: '緑', hair: '深い松葉緑を後ろで低く束ね', eye: '石榴', atmosphere: 'ミステリアス' },
  { id: 'hp_049', gender: '中性的', age: '幼め', hair_color: '赤橙暖色', hair: '朱橙の不揃い短髪・片側だけ高く跳ね', eye: '杏橙', atmosphere: '活発' },
  { id: 'hp_050', gender: '中性的', age: '同年代', hair_color: '黒暗色', hair: '黒の前下がりボブ・片頬に影', eye: '鋼灰', atmosphere: 'クール' }
].map((lane) => Object.freeze(lane)));

// Load-time integrity: exactly HOMUNCULUS_FACE_POOL_SIZE lanes, ids are the dense hp_001..hp_NNN sequence,
// and every lane carries every tag. A gap, a duplicate, or a missing tag is an authoring error, caught here.
(function assertPoolIntegrity() {
  if (HOMUNCULUS_FACE_POOL.length !== HOMUNCULUS_FACE_POOL_SIZE) {
    throw new Error(`homunculus face pool must hold exactly ${HOMUNCULUS_FACE_POOL_SIZE} lanes: got ${HOMUNCULUS_FACE_POOL.length}`);
  }
  const seen = new Set();
  HOMUNCULUS_FACE_POOL.forEach((lane, index) => {
    const expectedId = `hp_${String(index + 1).padStart(3, '0')}`;
    if (lane.id !== expectedId) throw new Error(`homunculus face pool lane ${index} must have id ${expectedId}: got ${lane.id}`);
    if (seen.has(lane.id)) throw new Error(`homunculus face pool has a duplicate id: ${lane.id}`);
    seen.add(lane.id);
    for (const key of ['gender', 'age', 'hair_color', 'hair', 'eye', 'atmosphere']) {
      if (typeof lane[key] !== 'string' || !lane[key]) throw new Error(`homunculus face pool lane ${lane.id} is missing tag ${key}`);
    }
  });
})();

const FACE_POOL_BY_ID = new Map(HOMUNCULUS_FACE_POOL.map((lane) => [lane.id, lane]));

export function isHomunculusFaceId(faceId) {
  return FACE_POOL_BY_ID.has(faceId);
}

export function homunculusFaceLane(faceId) {
  const lane = FACE_POOL_BY_ID.get(faceId);
  if (!lane) throw new Error(`unknown homunculus face id: ${faceId}`);
  return lane;
}

// The closed-set candidates for a new synthesis: the whole pool MINUS the faces already taken by this
// save's active homunculi and its nameplates (a farewelled face stays excluded — ids/faces never reuse).
// Fails fast on a used face outside the pool (corrupt surface). Returns lanes in pool order.
export function availableFaceLanes(surface) {
  if (!surface || typeof surface !== 'object' || Array.isArray(surface)) {
    throw new Error('homunculus surface is required to resolve available faces');
  }
  const used = new Set();
  for (const entry of [...(surface.active ?? []), ...(surface.nameplates ?? [])]) {
    const faceId = entry?.face_id;
    // An auction being's `ab_*` face never occupies an hp lane, so it is skipped rather than counted or
    // treated as corrupt — the atelier pool is unaffected by auction adoptions sharing the surface.
    if (isAuctionFaceId(faceId)) continue;
    if (!FACE_POOL_BY_ID.has(faceId)) throw new Error(`homunculus surface uses a face outside the pool: ${faceId}`);
    used.add(faceId);
  }
  return HOMUNCULUS_FACE_POOL.filter((lane) => !used.has(lane.id));
}
