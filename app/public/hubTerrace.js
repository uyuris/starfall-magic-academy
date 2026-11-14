// 露台のハブ（#routing-hub-screen）の描き方の片割れ。見た目は hubTerrace.css が持ち、ここは次を持つ:
// - アイコンと空の絵: 左の列から開く画面のアイコン（能力の名前は hubTerraceSigils.svg の symbol・戻る・処分の確かめ・星の揺り籠の操作・
//   入力の欄に添える虫眼鏡はここの SVG）と、空を知らせる絵（星の揺り籠の鉢・巣・籠と、ハブの外が使う点線の絵）。名前は読み上げの側（aria-label）にだけ
//   持たせ、title は置かない。
// - 行き先の名: 案内人の言葉に出た行き先の名に淡い光を差し、指を乗せるとその行き先の絵を名のそばの場所の窓に見せる。
// - 場所の窓: 行き先の絵を横 4 対 縦 3 の額に切り取って、触れた名のそばに見せる一つの部品。開いているのは一度に一つ。絵のどこを
//   残すかは行き先ごとの中心の表（DESTINATION_ART_FOCUS）が決める。
// - 送り出しの幕: 絵を持たない夜。行き先が決まった応答（routing_draining）で露台の言葉の側を一段沈め、見送り読みポーズの終わり
//   （app.js が nightFallsBy に渡す時刻）にちょうど満ちきるように幕の夜で画面を満たしていく（ハブは暗くなる向きにしか動かない。
//   動きを減らす設定ではその時刻にその場で夜になる）。ハブを離れたら（または幕の上に行き先へ入る待ちが置かれたら）その場で
//   満たしきり、行き先の画面（またはハブ）が出たところで幕を上げる。読み込みの箱へ行く道では露台を夜へ沈めてから箱を出し、
//   区切り（タイトルへ）の道では夜が満ちたところで区切りの読み込みの箱を出し、どちらも幕は箱の夜へ薄れて上がる。
// - 開いている間の左の列: 帯・装備の小窓が開いている間に別の印か天球儀を押すと、離れる側を製品の閉じるボタンで閉じてから押された
//   側を開き、いま開いている印を押すと閉じる。揺り籠が開いている間は、その下に隠れる左の列を inert にする。
// 製品への要求は足さない（読むのは app.js が既に受け取った応答だけ）。

// 行き先 → その行き先の画面がいま使っている一枚の絵。行き先の id と名はハブの開始の応答（routing_destinations）で届き、
// この表と id の集合に過不足があれば throw する（setDestinations）。
const DESTINATION_ART = Object.freeze({
  'academy-map': '/canonical/academy_map/overview.jpg',
  training: '/canonical/training/background.jpg',
  dungeon: '/canonical/dungeon/entrance.png',
  errand: '/canonical/errand/stage.jpg',
  alchemy: '/canonical/alchemy/stage.jpg',
  study_circle: '/canonical/study_circle/stage.jpg',
  workshop: '/canonical/workshop/stage.jpg',
  library: '/canonical/library/stage.jpg',
  arena: '/canonical/arena/stage.jpg',
  auction: '/canonical/auction/stage.jpg',
  lounge: '/canonical/lounge/stage.jpg',
  concert_hall: '/canonical/concert_hall/stage.jpg',
  overlook: '/canonical/academy_overlook/field_map.jpg',
  homunculus: '/canonical/atelier/stage.jpg',
  title: '/canonical/title/title_night.jpg'
});

// 行き先 → 場所の窓がその絵のどこを中心に切り取るか（絵の左上を 0・右下を 1 とした点）。その場所が何か分かる所
// （建物の顔・部屋の主な調度・入口）を指す。窓は絵を額いっぱいに敷いてはみ出しを切るので、はみ出す向きにだけ効き、
// 絵の端より外へは寄らない。絵の表と行き先の集合に過不足があれば throw する。
const DESTINATION_ART_FOCUS = Object.freeze({
  'academy-map': Object.freeze({ x: 0.5, y: 0.5 }),
  training: Object.freeze({ x: 0.6, y: 0.5 }),
  dungeon: Object.freeze({ x: 0.55, y: 0.45 }),
  errand: Object.freeze({ x: 0.5, y: 0.42 }),
  alchemy: Object.freeze({ x: 0.5, y: 0.55 }),
  study_circle: Object.freeze({ x: 0.5, y: 0.48 }),
  workshop: Object.freeze({ x: 0.5, y: 0.62 }),
  library: Object.freeze({ x: 0.5, y: 0.5 }),
  arena: Object.freeze({ x: 0.5, y: 0.5 }),
  auction: Object.freeze({ x: 0.5, y: 0.45 }),
  lounge: Object.freeze({ x: 0.5, y: 0.52 }),
  concert_hall: Object.freeze({ x: 0.5, y: 0.5 }),
  overlook: Object.freeze({ x: 0.5, y: 0.5 }),
  homunculus: Object.freeze({ x: 0.5, y: 0.45 }),
  title: Object.freeze({ x: 0.5, y: 0.4 })
});
{
  const unfocused = Object.keys(DESTINATION_ART).filter((id) => !Object.hasOwn(DESTINATION_ART_FOCUS, id));
  const artless = Object.keys(DESTINATION_ART_FOCUS).filter((id) => !Object.hasOwn(DESTINATION_ART, id));
  if (unfocused.length || artless.length) {
    throw new Error(`hub terrace: the art focus map is out of step with the destination art map (no focus: ${unfocused.join(',') || '-'} / no art: ${artless.join(',') || '-'})`);
  }
}

// ボタンのアイコン（defs を持たない平らな塗り・同じアイコンが一画面に何度も出るため）。
const SIGILS = Object.freeze({
  back: '<svg class="terrace-sigil terrace-sigil-back" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M4 16 L14 7 V12.5 C21 12.5 27 15.5 28 24 C25 19.5 21 18.5 14 18.5 V25 Z" fill="#2a3070" stroke="#dde3f6" stroke-width="1.3" stroke-linejoin="round" /><path d="M24.50 5.10 L25.17 6.83 L26.90 7.50 L25.17 8.17 L24.50 9.90 L23.83 8.17 L22.10 7.50 L23.83 6.83 Z" fill="#e8c877" /></svg>',
  keep: '<svg class="terrace-sigil terrace-sigil-keep" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M7 6 H22 A3 3 0 0 1 25 9 V26 H10 A3 3 0 0 1 7 23 Z" fill="#2a3070" stroke="#dde3f6" stroke-width="1.3" stroke-linejoin="round" /><path d="M10 26 A3 3 0 0 1 10 20 H25" fill="none" stroke="#dde3f6" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" /><path d="M16.00 10.00 L16.84 12.16 L19.00 13.00 L16.84 13.84 L16.00 16.00 L15.16 13.84 L13.00 13.00 L15.16 12.16 Z" fill="#e8c877" /></svg>',
  dispose: '<svg class="terrace-sigil terrace-sigil-dispose" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M16 3.5 C20 8.5 24.5 12 23.5 18.5 A7.5 7.5 0 0 1 8.5 18.5 C8 13.5 11.5 11.5 12 7.5 C13.8 9.8 14.7 11 15.5 12.3 C16.8 9.6 17 6.8 16 3.5 Z" fill="#2a3070" stroke="#dde3f6" stroke-width="1.3" stroke-linejoin="round" /><path d="M6 27 H26 M9.5 24 H22.5" fill="none" stroke="#dde3f6" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" /></svg>',
  plant: '<svg class="terrace-sigil terrace-sigil-plant" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M4.5 23 H27.5" fill="none" stroke="#dde3f6" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M16 23 V14" fill="#2a3070" stroke="#dde3f6" stroke-width="1.3" stroke-linejoin="round" /><path d="M16 16 C11 16 8.5 12.5 8.5 9 C13 9 16 12 16 16 Z" fill="#2a3070" stroke="#dde3f6" stroke-width="1.3" stroke-linejoin="round" /><path d="M16 14 C20 14 23 11 23 7 C19 7 16 10 16 14 Z" fill="#2a3070" stroke="#dde3f6" stroke-width="1.3" stroke-linejoin="round" /><ellipse cx="16" cy="26.5" rx="3" ry="1.6" fill="#e8c877" /></svg>',
  harvest: '<svg class="terrace-sigil terrace-sigil-harvest" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M6 17 H26 L23 27 H9 Z" fill="#2a3070" stroke="#dde3f6" stroke-width="1.3" stroke-linejoin="round" /><path d="M11 17 C11 12 13 9 16 9 C19 9 21 12 21 17" fill="#2a3070" stroke="#dde3f6" stroke-width="1.3" stroke-linejoin="round" /><path d="M16.00 2.90 L16.73 4.77 L18.60 5.50 L16.73 6.23 L16.00 8.10 L15.27 6.23 L13.40 5.50 L15.27 4.77 Z" fill="#e8c877" /><path d="M9.5 21.5 H22.5" fill="none" stroke="#dde3f6" stroke-width="1.0" stroke-linecap="round" stroke-linejoin="round" /></svg>',
  byproduct: '<svg class="terrace-sigil terrace-sigil-byproduct" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M8 12 C8 9 11 8 16 8 C21 8 24 9 24 12 L26 25 C26 27 22 28 16 28 C10 28 6 27 6 25 Z" fill="#2a3070" stroke="#dde3f6" stroke-width="1.3" stroke-linejoin="round" /><path d="M11 8 C12 5 20 5 21 8" fill="none" stroke="#dde3f6" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" /><path d="M16.00 14.00 L17.12 16.88 L20.00 18.00 L17.12 19.12 L16.00 22.00 L14.88 19.12 L12.00 18.00 L14.88 16.88 Z" fill="#e8c877" /></svg>',
  name: '<svg class="terrace-sigil terrace-sigil-name" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M26.5 4 C17.5 6 11.5 13 9 22 L10.5 23.5 C19.5 21 25.5 14 26.5 4 Z" fill="#2a3070" stroke="#dde3f6" stroke-width="1.2" stroke-linejoin="round" /><path d="M24.4 7 C18.6 11 13.6 16 10.2 22.6" fill="none" stroke="#dde3f6" stroke-width="0.8" stroke-linecap="round" stroke-linejoin="round" /><path d="M9 22 L5.2 27.6" fill="none" stroke="#dde3f6" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M24.50 23.80 L25.12 25.38 L26.70 26.00 L25.12 26.62 L24.50 28.20 L23.88 26.62 L22.30 26.00 L23.88 25.38 Z" fill="#e8c877" /></svg>',
  cage: '<svg class="terrace-sigil terrace-sigil-cage" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M7 27 V14 A9 9 0 0 1 25 14 V27 Z" fill="#2a3070" stroke="#dde3f6" stroke-width="1.3" stroke-linejoin="round" /><path d="M11.5 27 V10.5 M16 27 V5 M20.5 27 V10.5 M7 20 H25" fill="none" stroke="#dde3f6" stroke-width="1.0" stroke-linecap="round" stroke-linejoin="round" /><path d="M5 27 H27 M16 5 V2.5" fill="none" stroke="#dde3f6" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M16.00 14.10 L16.67 15.83 L18.40 16.50 L16.67 17.17 L16.00 18.90 L15.33 17.17 L13.60 16.50 L15.33 15.83 Z" fill="#e8c877" /></svg>',
  release: '<svg class="terrace-sigil terrace-sigil-release" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M3.5 20 C8 12 14 10 20 12 C16 13.5 13.5 16 12.5 19 C17 16.5 22 16.5 27.5 19 C21 21 15 24 9 24 Z" fill="#2a3070" stroke="#dde3f6" stroke-width="1.3" stroke-linejoin="round" /><path d="M23.00 4.80 L23.90 7.10 L26.20 8.00 L23.90 8.90 L23.00 11.20 L22.10 8.90 L19.80 8.00 L22.10 7.10 Z" fill="#e8c877" /><path d="M27.50 11.90 L27.95 13.05 L29.10 13.50 L27.95 13.95 L27.50 15.10 L27.05 13.95 L25.90 13.50 L27.05 13.05 Z" fill="#e8c877" /></svg>'
});

// 星の揺り籠の空きの絵: 芝の上の鉢（pot）・巣（nest）と石の台の籠（cage）は、揺り籠の地の絵（芝・石の鉢・天球儀・灯）の中に
// 置いて馴染む描き方にそろえる。光は左上（月と灯）から差し、縁の上と左の面に光を受け、右の面と足もとは沈む。輪郭は夜の墨で取り、
// 足もとに右下へ流れる柔らかい影を重ねて地に接させる（芝の座は手前に草の房を被せる）。植える場の空き数の横の小さな鉢
// （small-pot）と巣（small-nest）は、46px で見分けるための別の形: 鉢は縁の太い植木鉢を正面から、巣は横に広い藁の巣を、
// 色（夜の石の青と藁の色）と形の両方で分ける。どれも defs を持たない（同じ絵が画面に幾つも並ぶので、id を持たない）。
const INK = '#141a3c';
const STONE_DEEP = '#2c3463';
const STONE = '#4b5489';
const STONE_LIT = '#7279ab';
const STONE_GLINT = '#b9bfdf';
const GILT_DEEP = '#6e5a30';
const GILT = '#b89a56';
const GILT_LIT = '#ecd696';
const SOIL = '#221b25';
const SOIL_LIT = '#463840';
const TWIG_INK = '#1c1620';
const TWIG_DEEP = '#30282f';
const TWIG = '#56494b';
const TWIG_MID = '#7c6c64';
const TWIG_LIT = '#a8988b';
const STRAW = '#cdbb90';
const METAL_DEEP = '#232a5c';
const METAL = '#3c4789';
const SILVER = '#a9b2de';
const SILVER_LIT = '#e2e6fa';
const GRASS_DEEP = '#1d3532';
const GRASS = '#36573f';
const GRASS_LIT = '#7c9a68';
const n1 = (value) => Number(value.toFixed(1));
const cradleArt = (name, body, size = 100) => `<svg class="terrace-empty-art terrace-empty-${name}" viewBox="0 0 ${size} ${size}" aria-hidden="true" focusable="false">${body.join('')}</svg>`;

// 足もとの影: 右下へ流れる柔らかい楕円を、外ほど薄く重ねる。
const groundShadow = (cx, cy, rx, ry) => [[1.3, 0.16], [1.1, 0.24], [0.88, 0.34], [0.66, 0.42]]
  .map(([k, alpha]) => `<ellipse cx="${n1(cx + rx * (k - 0.66) * 0.18)}" cy="${n1(cy)}" rx="${n1(rx * k)}" ry="${n1(ry * k)}" fill="rgb(4 10 20 / ${alpha})"/>`).join('');

// 草の房: 足もと（x, y）から伸びる葉を数枚。奥の葉は沈め、手前の葉の先に光を受ける。
function grassTuft(x, y, s, lean) {
  const blade = (dx, h, bend, fill) => {
    const tipX = x + dx * s + bend * s;
    const tipY = y - h * s;
    return `<path d="M${n1(x + (dx - 1.1) * s)} ${n1(y)} Q${n1(x + (dx + bend * 0.3) * s)} ${n1(y - h * s * 0.55)} ${n1(tipX)} ${n1(tipY)} Q${n1(x + (dx + bend * 0.5 + 0.6) * s)} ${n1(y - h * s * 0.5)} ${n1(x + (dx + 1.1) * s)} ${n1(y)} Z" fill="${fill}"/>`;
  };
  return [
    blade(-2.4, 5.2, -2.2 + lean, GRASS_DEEP),
    blade(2.2, 5.6, 2 + lean, GRASS_DEEP),
    blade(-0.8, 7, -1 + lean, GRASS),
    blade(1, 6.2, 1.4 + lean, GRASS),
    blade(0, 4.6, 0.4 + lean, GRASS_LIT)
  ].join('');
}

// 四つの尖りの星（石の鉢の象嵌と同じ形）。
const inlayStar = (cx, cy, r) => `<path d="M${cx} ${n1(cy - r)} Q${n1(cx + r * 0.16)} ${n1(cy - r * 0.16)} ${n1(cx + r * 0.62)} ${cy} Q${n1(cx + r * 0.16)} ${n1(cy + r * 0.16)} ${cx} ${n1(cy + r)} Q${n1(cx - r * 0.16)} ${n1(cy + r * 0.16)} ${n1(cx - r * 0.62)} ${cy} Q${n1(cx - r * 0.16)} ${n1(cy - r * 0.16)} ${cx} ${n1(cy - r)} Z" fill="${GILT_DEEP}" stroke="${GILT}" stroke-width="0.8" stroke-linejoin="round"/>`;

// 鉢: 庭の奥の石の鉢と同じ夜の石の鉢。厚い縁の内に土が入っていて、胴に金の帯と三日月・星の象嵌。
const EMPTY_POT = cradleArt('pot', [
  groundShadow(52, 87.6, 26, 5.4),
  // 胴
  `<path d="M22.6 46 C23.4 62 26.2 75.6 29.4 84 A20.8 5.8 0 0 0 70.6 84 C73.8 75.6 76.6 62 77.4 46 Z" fill="${STONE}"/>`,
  `<path d="M61.6 47.4 L77.4 46 C76.6 62 73.8 75.6 70.6 84 A20.8 5.8 0 0 1 59.6 88.9 C63.6 76 64.4 62 61.6 47.4 Z" fill="${STONE_DEEP}"/>`,
  `<path d="M24 48.4 C24.8 62 27.4 75 30.6 84.4 Q33 86.2 35.6 87 C32.2 75.4 30.2 62 30.4 49 Z" fill="${STONE_LIT}" opacity="0.75"/>`,
  `<path d="M27.4 78.6 A22.6 6 0 0 0 72.6 78.6" fill="none" stroke="${INK}" stroke-width="0.9" opacity="0.55"/>`,
  `<path d="M23.2 54.4 A26.8 7.2 0 0 0 76.8 54.4" fill="none" stroke="${GILT}" stroke-width="1.6"/>`,
  `<path d="M23.6 58 A26.4 7 0 0 0 76.4 58" fill="none" stroke="${GILT_DEEP}" stroke-width="0.9"/>`,
  `<path d="M24 54.8 A26.6 7.2 0 0 0 42 61.4" fill="none" stroke="${GILT_LIT}" stroke-width="0.9"/>`,
  `<path d="M44.6 64.2 A6.6 6.6 0 1 0 50.8 75.6 A5.1 5.1 0 1 1 44.6 64.2 Z" fill="${GILT}" stroke="${GILT_DEEP}" stroke-width="0.7"/>`,
  inlayStar(59.4, 69.4, 5),
  inlayStar(33.6, 68.6, 3.8),
  `<path d="M22.6 46 C23.4 62 26.2 75.6 29.4 84 A20.8 5.8 0 0 0 70.6 84 C73.8 75.6 76.6 62 77.4 46" fill="none" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>`,
  // 縁の厚み
  `<path d="M19.6 40 L20.2 45.6 A29.8 8.8 0 0 0 79.8 45.6 L80.4 40 Z" fill="${STONE}" stroke="${INK}" stroke-width="1.4" stroke-linejoin="round"/>`,
  `<path d="M64 48.4 A29.8 8.8 0 0 0 79.8 45.6 L80.4 40 L66 44 Z" fill="${STONE_DEEP}"/>`,
  `<path d="M21 45.4 Q28 50.4 40 52.6" fill="none" stroke="${STONE_GLINT}" stroke-width="0.9" stroke-linecap="round" opacity="0.7"/>`,
  // 縁の上と口の中の土
  `<ellipse cx="50" cy="40" rx="30.4" ry="9.6" fill="${STONE_LIT}" stroke="${INK}" stroke-width="1.4"/>`,
  `<path d="M24.2 41.6 A26 7.6 0 0 0 75.8 41.6" fill="none" stroke="${GILT}" stroke-width="0.9" opacity="0.85"/>`,
  `<ellipse cx="50" cy="40.4" rx="24.2" ry="6.9" fill="#222a58" stroke="${INK}" stroke-width="1"/>`,
  `<path d="M60.4 34.4 A24.2 6.9 0 0 1 74.2 40.4 A22.6 5 0 0 0 62 35.8 Z" fill="${STONE}" opacity="0.8"/>`,
  `<ellipse cx="50" cy="42" rx="22.4" ry="5.2" fill="${SOIL}"/>`,
  `<path d="M30 42.6 Q40 39.4 52 40.2 Q62 40.6 69 43" fill="none" stroke="${SOIL_LIT}" stroke-width="1" stroke-linecap="round"/>`,
  `<circle cx="38" cy="43.6" r="0.8" fill="${SOIL_LIT}"/><circle cx="57" cy="44.2" r="0.7" fill="${SOIL_LIT}"/><circle cx="47" cy="45" r="0.6" fill="${SOIL_LIT}"/>`,
  `<path d="M21.6 37.6 Q29 31.6 46 30.6" fill="none" stroke="${STONE_GLINT}" stroke-width="1.4" stroke-linecap="round"/>`,
  `<path d="M24 37.8 Q30 34 38 33" fill="none" stroke="${SILVER_LIT}" stroke-width="0.8" stroke-linecap="round" opacity="0.8"/>`,
  // 手前の草
  grassTuft(30, 89.6, 1, -0.4),
  grassTuft(66, 90.6, 1.1, 0.6),
  grassTuft(48, 92, 0.8, 0.2)
]);

// 小枝: 楕円 (cx, cy, rx, ry) に沿う角度 t0〜t1 の弧を、少し外へ膨らませた一本の線にする。
function twigArc(cx, cy, rx, ry, t0, t1, swell, color, width) {
  const at = (t, k) => [cx + rx * k * Math.cos(t), cy + ry * k * Math.sin(t)];
  const [x0, y0] = at(t0, 1);
  const [x1, y1] = at(t1, 1);
  const [qx, qy] = at((t0 + t1) / 2, 1 + swell);
  return `<path d="M${n1(x0)} ${n1(y0)} Q${n1(qx)} ${n1(qy)} ${n1(x1)} ${n1(y1)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`;
}

// 小枝の色: 左上の光を受ける向き（t が左上に近いほど明るい）と、層の明るさ（0〜1）から選ぶ。
function twigTone(t, lift) {
  const facing = (Math.cos(t - Math.PI * 1.15) + 1) / 2;
  const tones = [TWIG_DEEP, TWIG, TWIG_MID, TWIG_LIT, STRAW];
  return tones[Math.min(tones.length - 1, Math.floor((facing * 0.65 + lift * 0.45) * tones.length))];
}

// 編み目の並び（決まった数列で、毎回同じ絵になる）。
function nestTwigs(cx, cy, rx, ry, count, step, span, swell, lift, width, front) {
  const twigs = [];
  for (let i = 0; i < count; i += 1) {
    const t0 = (i * step) % (Math.PI * 2);
    const t = t0 + span * (0.7 + ((i * 7) % 5) * 0.12);
    const middle = (t0 + t) / 2;
    if (front !== null && (Math.sin(middle) > 0) !== front) continue;
    const k = 1 + (((i * 5) % 7) - 3) * 0.018;
    twigs.push(twigArc(cx, cy, rx * k, ry * k, t0, t, swell, twigTone(middle, lift), width));
  }
  return twigs.join('');
}

// 縁から外へ跳ねる小枝の端: 縁の楕円の上の点から、外向きに少し傾けた短い線を、決まった数列で並べる。
function nestStrays(cx, cy, rx, ry, count, lift, width) {
  const strays = [];
  for (let i = 0; i < count; i += 1) {
    const t = (i * 2.39996) % (Math.PI * 2);
    const x0 = cx + rx * Math.cos(t);
    const y0 = cy + ry * Math.sin(t);
    const tilt = (((i * 3) % 5) - 2) * 0.22;
    const length = 3.4 + ((i * 7) % 4) * 1.2;
    const dx = Math.cos(t + tilt);
    const dy = Math.sin(t + tilt) * 0.62 - 0.12;
    strays.push(`<path d="M${n1(x0 - dx * 2)} ${n1(y0 - dy * 2)} L${n1(x0 + dx * length)} ${n1(y0 + dy * length)}" fill="none" stroke="${twigTone(t, lift)}" stroke-width="${width}" stroke-linecap="round"/>`);
  }
  return strays.join('');
}

// 巣: 小枝を幾重にも巻いて編んだ低い巣。口の内は柔らかな敷き藁で、羽が一枚落ちている。縁から小枝の端が外へ跳ねる。
const EMPTY_NEST = cradleArt('nest', [
  groundShadow(52, 84.4, 37, 6.4),
  `<path d="M11.4 60 C11.8 71 24 83.4 50 84.4 C76 83.4 88.2 71 88.6 60 Z" fill="${TWIG_DEEP}" stroke="${TWIG_INK}" stroke-width="1.4" stroke-linejoin="round"/>`,
  `<path d="M62 70 C74 70 86 66 88.6 60 C88.2 71 76 83.4 50 84.4 C62 80 64 75 62 70 Z" fill="${TWIG_INK}" opacity="0.55"/>`,
  nestTwigs(50, 66, 36, 13, 22, 1.37, 1.15, 0.05, 0.25, 1.5, true),
  nestTwigs(50, 72.6, 31, 10.6, 20, 1.61, 1.0, 0.06, 0.15, 1.4, true),
  nestTwigs(50, 78, 23, 6.6, 14, 1.93, 0.9, 0.07, 0.05, 1.3, true),
  `<path d="M16 64 Q20 74 32 80" fill="none" stroke="${TWIG_LIT}" stroke-width="1.1" stroke-linecap="round" opacity="0.7"/>`,
  `<path d="M18 66 L34 80.6 M26 68.6 L44 82.6 M40 70.6 L56 83.4 M54 71 L68 80.4 M66 70 L80 75.6 M30 79.4 L46 68.6 M48 83.2 L64 70.6 M64 81 L78 69.6" fill="none" stroke="${TWIG_MID}" stroke-width="1" stroke-linecap="round" opacity="0.75"/>`,
  // 縁の輪
  `<ellipse cx="50" cy="60" rx="39" ry="14.4" fill="${TWIG}" stroke="${TWIG_INK}" stroke-width="1.4"/>`,
  nestTwigs(50, 60, 37, 13.4, 34, 0.83, 1.05, 0.07, 0.35, 1.7, null),
  nestTwigs(50, 60.6, 33.6, 11.6, 26, 1.13, 0.95, 0.05, 0.5, 1.3, null),
  // 口と敷き藁
  `<ellipse cx="50" cy="59.4" rx="27" ry="8.6" fill="#2a2330"/>`,
  nestTwigs(50, 58.8, 26, 8, 14, 1.49, 0.9, -0.06, 0.1, 1.3, false),
  `<ellipse cx="50.6" cy="61.2" rx="21" ry="5.6" fill="#3a3140"/>`,
  '<ellipse cx="48" cy="61.6" rx="12" ry="2.8" fill="rgb(150 140 160 / 0.22)"/>',
  `<path d="M34 61.6 Q42 58.6 50 59.4 Q58 60 66 62.6 M38 63.6 Q48 61.6 60 63.8" fill="none" stroke="#5e5058" stroke-width="1" stroke-linecap="round"/>`,
  // 羽
  `<path d="M54.6 63.4 Q58 57.2 66.4 56 Q64.6 61.6 54.6 63.4 Z" fill="#d8dcee" stroke="#8a90b0" stroke-width="0.6" stroke-linejoin="round"/>`,
  `<path d="M53.4 64.2 Q59 60.4 65.4 56.6" fill="none" stroke="#8a90b0" stroke-width="0.7" stroke-linecap="round"/>`,
  // 縁の手前の巻きと、跳ねる小枝の端
  nestTwigs(50, 60.2, 38.4, 14, 18, 0.71, 1.2, 0.06, 0.55, 1.9, true),
  nestStrays(50, 60, 38.6, 14.2, 30, 0.4, 1.2),
  nestStrays(50, 70, 35, 13, 12, 0.2, 1.1),
  `<path d="M22.6 49.4 L18.6 43.2 M41 46 L39.6 39.6 M76.4 49 L81 43.4" fill="none" stroke="${TWIG_LIT}" stroke-width="1.2" stroke-linecap="round"/>`,
  `<path d="M14 55 Q22 47.4 40 45.6" fill="none" stroke="${STRAW}" stroke-width="1.1" stroke-linecap="round" opacity="0.85"/>`,
  grassTuft(24, 82, 1, -0.6),
  grassTuft(74, 82.6, 1.1, 0.5),
  grassTuft(50, 87.4, 0.85, 0)
]);

// 鳥籠の格子: 円筒（底 y0・肩 y1・半径 r）と円屋根の頂 (50, apex) を、角度 t の一本の格子にする。
function cageBar(t, y0, y1, r, ry, apex) {
  const x = 50 + r * Math.cos(t);
  const yb = y0 + ry * Math.sin(t);
  const yt = y1 + ry * Math.sin(t);
  const dome = `C${n1(x)} ${n1(yt - (y1 - apex) * 0.62)} ${n1(50 + (x - 50) * 0.5)} ${n1(apex)} 50 ${apex}`;
  return `M${n1(x)} ${n1(yb)} L${n1(x)} ${n1(yt)} ${dome}`;
}

// 籠: 灯と同じ夜の金属の鳥籠。楕円の台座に立つ円筒の格子と円屋根、中に止まり木、右手前の扉は外へ開いて中は空。
// 格子は奥を沈めて細く、手前を銀で太く描き、左の格子に光を受ける。足もとの影は石の台の上へ右下に流す。
const CAGE_BOTTOM = 81;
const CAGE_SHOULDER = 47;
const CAGE_R = 24;
const CAGE_RY = 6.4;
const CAGE_APEX = 21;
const CAGE_DOOR = [0.35, 1.05];
const cageAngles = Array.from({ length: 16 }, (_, i) => (i * Math.PI * 2) / 16 + Math.PI / 32);
const cageRing = (y, front, color, width) => `<path d="M${50 - CAGE_R} ${y} A${CAGE_R} ${CAGE_RY} 0 0 ${front ? 0 : 1} ${50 + CAGE_R} ${y}" fill="none" stroke="${color}" stroke-width="${width}"/>`;
const cageDoorAt = (t, y) => [50 + CAGE_R * Math.cos(t), y + CAGE_RY * Math.sin(t)];
const [hingeX, hingeBottom] = cageDoorAt(CAGE_DOOR[1], CAGE_BOTTOM);
const hingeTop = hingeBottom - 17;
const doorOpen = [hingeX + 15.6, hingeBottom + 3.4];
const EMPTY_CAGE = cradleArt('cage', [
  groundShadow(56, 89.6, 34, 7.2),
  // 台座
  `<path d="M20 83 L20.6 89 A29.4 7.6 0 0 0 79.4 89 L80 83 Z" fill="${METAL}" stroke="${INK}" stroke-width="1.3" stroke-linejoin="round"/>`,
  `<path d="M62 93 A29.4 7.6 0 0 0 79.4 89 L80 83 L64 87 Z" fill="${METAL_DEEP}"/>`,
  `<path d="M21 86.8 A29 7.4 0 0 0 79 86.8" fill="none" stroke="${GILT}" stroke-width="1.2"/>`,
  `<path d="M21 86.8 A29 7.4 0 0 0 46 94" fill="none" stroke="${GILT_LIT}" stroke-width="0.8"/>`,
  `<ellipse cx="50" cy="83" rx="30" ry="7.8" fill="${STONE_LIT}" stroke="${INK}" stroke-width="1.2"/>`,
  `<ellipse cx="50" cy="82.6" rx="25.4" ry="6.2" fill="${METAL_DEEP}" opacity="0.7"/>`,
  `<path d="M22 81.4 Q30 76.4 46 75.4" fill="none" stroke="${SILVER}" stroke-width="1" stroke-linecap="round" opacity="0.8"/>`,
  // 奥の格子と輪
  ...cageAngles.filter((t) => Math.sin(t) < 0).map((t) => `<path d="${cageBar(t, CAGE_BOTTOM, CAGE_SHOULDER, CAGE_R, CAGE_RY, CAGE_APEX)}" fill="none" stroke="#6c77ae" stroke-width="1" stroke-linecap="round"/>`),
  cageRing(CAGE_SHOULDER, false, '#6c77ae', 1.1),
  cageRing(64, false, '#6c77ae', 1),
  `<path d="M${50 - CAGE_R} ${CAGE_BOTTOM} V${CAGE_SHOULDER} C${50 - CAGE_R} ${n1(CAGE_SHOULDER - (CAGE_SHOULDER - CAGE_APEX) * 0.62)} ${50 - CAGE_R / 2} ${CAGE_APEX} 50 ${CAGE_APEX} C${50 + CAGE_R / 2} ${CAGE_APEX} ${50 + CAGE_R} ${n1(CAGE_SHOULDER - (CAGE_SHOULDER - CAGE_APEX) * 0.62)} ${50 + CAGE_R} ${CAGE_SHOULDER} V${CAGE_BOTTOM} A${CAGE_R} ${CAGE_RY} 0 0 1 ${50 - CAGE_R} ${CAGE_BOTTOM} Z" fill="rgb(16 21 52 / 0.4)"/>`,
  `<path d="M${50 + CAGE_R * 0.35} ${CAGE_BOTTOM + 5} V${CAGE_SHOULDER + 5} C${50 + CAGE_R * 0.35} 30 ${50 + CAGE_R * 0.6} 30 ${50 + CAGE_R} ${CAGE_SHOULDER} V${CAGE_BOTTOM} Z" fill="rgb(8 10 30 / 0.28)"/>`,
  // 止まり木
  `<path d="M36 70.4 H60" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>`,
  `<path d="M36 70 H60" stroke="${GILT}" stroke-width="1.8" stroke-linecap="round"/>`,
  `<path d="M38 70 V76.6 M58 70 V76.6" stroke="${GILT_DEEP}" stroke-width="1"/>`,
  `<path d="M37 69.4 H48" stroke="${GILT_LIT}" stroke-width="0.7" stroke-linecap="round"/>`,
  // 手前の格子（扉の口は空ける）と輪
  ...cageAngles.filter((t) => Math.sin(t) >= 0).map((t) => {
    const tone = Math.cos(t) < -0.45 ? SILVER_LIT : Math.cos(t) < 0.35 ? SILVER : '#6f7ab4';
    const inDoor = t > CAGE_DOOR[0] && t < CAGE_DOOR[1];
    const bar = inDoor
      ? `M${n1(50 + CAGE_R * Math.cos(t))} ${n1(64 + CAGE_RY * Math.sin(t))} ${cageBar(t, CAGE_BOTTOM, CAGE_SHOULDER, CAGE_R, CAGE_RY, CAGE_APEX).replace(/^M\S+ \S+ L/, 'L')}`
      : cageBar(t, CAGE_BOTTOM, CAGE_SHOULDER, CAGE_R, CAGE_RY, CAGE_APEX);
    return `<path d="${bar}" fill="none" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/><path d="${bar}" fill="none" stroke="${tone}" stroke-width="1.5" stroke-linecap="round"/>`;
  }),
  cageRing(CAGE_BOTTOM, true, INK, 3.2),
  cageRing(CAGE_BOTTOM, true, GILT, 1.8),
  cageRing(64, true, INK, 2.4),
  cageRing(64, true, SILVER, 1.3),
  cageRing(CAGE_SHOULDER, true, INK, 2.8),
  cageRing(CAGE_SHOULDER, true, GILT, 1.6),
  `<path d="M${50 - CAGE_R} ${CAGE_SHOULDER} A${CAGE_R} ${CAGE_RY} 0 0 0 40 ${n1(CAGE_SHOULDER + CAGE_RY * 0.98)}" fill="none" stroke="${GILT_LIT}" stroke-width="0.8"/>`,
  // 外へ開いた扉
  `<path d="M${n1(hingeX)} ${n1(hingeBottom)} L${n1(hingeX)} ${n1(hingeTop)} L${n1(doorOpen[0])} ${n1(hingeTop + 4.6)} L${n1(doorOpen[0])} ${n1(doorOpen[1])} Z" fill="rgb(35 42 92 / 0.35)" stroke="${INK}" stroke-width="2.6" stroke-linejoin="round"/>`,
  `<path d="M${n1(hingeX)} ${n1(hingeBottom)} L${n1(hingeX)} ${n1(hingeTop)} L${n1(doorOpen[0])} ${n1(hingeTop + 4.6)} L${n1(doorOpen[0])} ${n1(doorOpen[1])} Z" fill="none" stroke="${SILVER}" stroke-width="1.3" stroke-linejoin="round"/>`,
  `<path d="M${n1(hingeX + 5.2)} ${n1(hingeBottom + 1.1)} V${n1(hingeTop + 1.5)} M${n1(hingeX + 10.4)} ${n1(hingeBottom + 2.3)} V${n1(hingeTop + 3.1)}" stroke="${SILVER}" stroke-width="1.1"/>`,
  // 頂の飾りと吊りの環
  `<ellipse cx="50" cy="${CAGE_APEX + 0.6}" rx="4.6" ry="1.8" fill="${GILT}" stroke="${INK}" stroke-width="1"/>`,
  `<path d="M47.4 ${CAGE_APEX} Q50 ${CAGE_APEX - 6} 52.6 ${CAGE_APEX}" fill="${GILT}" stroke="${INK}" stroke-width="1"/>`,
  `<circle cx="50" cy="${CAGE_APEX - 9.6}" r="4.2" fill="none" stroke="${INK}" stroke-width="3"/>`,
  `<circle cx="50" cy="${CAGE_APEX - 9.6}" r="4.2" fill="none" stroke="${SILVER}" stroke-width="1.6"/>`,
  `<path d="M46.6 ${CAGE_APEX - 11.6} A4.2 4.2 0 0 1 50 ${CAGE_APEX - 13.8}" fill="none" stroke="${SILVER_LIT}" stroke-width="0.9" stroke-linecap="round"/>`,
  `<path d="M28.2 52 V78" stroke="${SILVER_LIT}" stroke-width="0.8" stroke-linecap="round" opacity="0.7"/>`
]);

// 植える場の小さな鉢（46px で読む形）: 縁の太い植木鉢を正面から。胴は裾へ強くすぼめ、口に盛った土を見せ、胴に金の帯、右の面を沈める。
const SMALL_POT = cradleArt('small-pot', [
  '<ellipse cx="25" cy="43.6" rx="12" ry="2.4" fill="rgb(4 10 20 / 0.5)"/>',
  `<path d="M11.6 19.6 L17.4 41.4 Q24 43.4 30.6 41.4 L36.4 19.6 Z" fill="${STONE}" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>`,
  `<path d="M27.6 19.6 L36.4 19.6 L30.6 41.4 Q29.2 41.9 27.4 42.2 Q29.8 30 27.6 19.6 Z" fill="${STONE_DEEP}"/>`,
  `<path d="M14.6 22 L19 39.4" stroke="${STONE_GLINT}" stroke-width="1.4" stroke-linecap="round"/>`,
  `<path d="M13.4 28 Q24 30.4 34.6 28" fill="none" stroke="${GILT}" stroke-width="1.6"/>`,
  `<path d="M7.6 12.4 H40.4 L39.4 20.6 Q24 22.8 8.6 20.6 Z" fill="${STONE_LIT}" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>`,
  `<path d="M30 13 H40.4 L39.4 20.6 Q34.6 21.3 30 21.6 Z" fill="${STONE}"/>`,
  `<path d="M10 15.4 H26" stroke="${SILVER_LIT}" stroke-width="1.2" stroke-linecap="round" opacity="0.85"/>`,
  `<ellipse cx="24" cy="12.4" rx="16.4" ry="3.6" fill="${STONE_LIT}" stroke="${INK}" stroke-width="1.4"/>`,
  `<path d="M10.4 12.6 Q12 6.8 24 6.4 Q36 6.8 37.6 12.6 Q24 15.4 10.4 12.6 Z" fill="#5a4334" stroke="${INK}" stroke-width="1.2" stroke-linejoin="round"/>`,
  '<path d="M14 10.6 Q19 7.8 26 7.8" fill="none" stroke="#8a6d55" stroke-width="1.2" stroke-linecap="round"/>',
  '<circle cx="29" cy="10" r="0.9" fill="#2e2219"/><circle cx="20" cy="11.4" r="0.8" fill="#2e2219"/><circle cx="33" cy="12" r="0.8" fill="#2e2219"/>'
], 48);

// 植える場の小さな巣（46px で読む形）: 横に広い藁の巣。胴に斜めに交わる藁の編み目、縁を太い藁の巻きで描き、縁から藁の端が
// 不揃いに交差して跳ねる。
const SMALL_NEST = cradleArt('small-nest', [
  '<ellipse cx="24.6" cy="40.8" rx="18" ry="2.6" fill="rgb(4 10 20 / 0.5)"/>',
  `<path d="M3.6 24 C4.4 32 12 39.6 24 39.8 C36 39.6 43.6 32 44.4 24 Z" fill="${TWIG}" stroke="${TWIG_INK}" stroke-width="1.6" stroke-linejoin="round"/>`,
  `<path d="M30 31 C36 30.6 42 28.4 44.4 24 C43.6 32 36 39.6 24 39.8 C29 36.4 31 34 30 31 Z" fill="${TWIG_DEEP}"/>`,
  `<path d="M6.4 27.4 L15.6 37 M11.6 28.4 L22.6 39.2 M18 29.2 L28.6 39 M25.4 29.4 L34.4 37.2 M32.4 28.8 L40 34" fill="none" stroke="${TWIG_LIT}" stroke-width="1.2" stroke-linecap="round"/>`,
  `<path d="M14.4 36.4 L22 28.8 M21.4 38.8 L30 29.4 M29.4 38.6 L37.6 29.4 M37 35.2 L42.6 28.4 M8.4 32 L13.6 28" fill="none" stroke="${TWIG_MID}" stroke-width="1.1" stroke-linecap="round"/>`,
  `<ellipse cx="24" cy="23" rx="20.6" ry="7" fill="${TWIG_MID}" stroke="${TWIG_INK}" stroke-width="1.6"/>`,
  `<ellipse cx="24" cy="22.8" rx="13.4" ry="3.6" fill="${TWIG_INK}"/>`,
  `<path d="M4.8 22.4 Q12 16.4 26 16.2 M22 16 Q36 15.8 43.2 22 M5.4 25.4 Q16 30.6 30 29.6 M26 29.8 Q38 28.6 42.8 24.8" fill="none" stroke="${STRAW}" stroke-width="1.5" stroke-linecap="round"/>`,
  `<path d="M8.6 19.6 Q20 14.6 34 16.4 M10 27.8 Q26 31.6 40 26.6" fill="none" stroke="${TWIG_LIT}" stroke-width="1" stroke-linecap="round"/>`,
  `<path d="M6 21 L0.8 18.6 M3 19.4 L6.4 24.6 M42.2 20.4 L47.2 21.8 M44 18.4 L41.6 24 M4.8 27.6 L1.4 30.4 M43.6 27 L46.8 30.2 M15 17 L10.6 14.6 M31.4 16.4 L35.2 13.2 M22.6 16 L25.2 12.4" fill="none" stroke="${STRAW}" stroke-width="1.2" stroke-linecap="round"/>`
], 48);

// 錬成室の空き枠の器（bell-jar）: 台に載せた釣鐘形の硝子の覆いを、点線でなく細い実線で描く。線は銘棚の字と同じ銀青、光は硝子の縁
// （覆いの輪郭と裾の口）にだけ薄く重ね、中は空のまま。錬成室の背景の硝子の器に並べて浮かず、それでいて三つの空いた座と読めるように、
// 覆いは台の上に据え、台の天板と脚を覆いより一段はっきり描く。
const JAR_LINE = 'rgb(199 211 230)';
const JAR_GLOW = 'rgb(199 211 230 / 0.22)';
const JAR_DOME = 'M22 58 V35 C22 23 29 15.6 38 15.6 C47 15.6 54 23 54 35 V58';
const BELL_JAR = cradleArt('bell-jar', [
  // 縁の薄い光（覆いの輪郭と裾の口に、太く淡い線を下に敷く）
  `<path d="${JAR_DOME}" fill="none" stroke="${JAR_GLOW}" stroke-width="5" stroke-linecap="round"/>`,
  `<ellipse cx="38" cy="58" rx="16" ry="2.2" fill="none" stroke="${JAR_GLOW}" stroke-width="5"/>`,
  // 台: 天板の楕円と、すぼまる胴と、広い足
  `<ellipse cx="38" cy="61" rx="21" ry="3.4" fill="none" stroke="${JAR_LINE}" stroke-width="1.2"/>`,
  `<path d="M17 61 V63.2 C21 66.2 55 66.2 59 63.2 V61" fill="none" stroke="${JAR_LINE}" stroke-width="1.2" stroke-linejoin="round"/>`,
  `<path d="M30 65.8 L28 70 H48 L46 65.8" fill="none" stroke="${JAR_LINE}" stroke-width="1.1" stroke-linejoin="round"/>`,
  // 覆い: 頂のつまみ・釣鐘の輪郭・裾の口
  `<circle cx="38" cy="11.6" r="2.4" fill="none" stroke="${JAR_LINE}" stroke-width="1.1"/>`,
  `<path d="M38 14 V15.6" stroke="${JAR_LINE}" stroke-width="1.1"/>`,
  `<path d="${JAR_DOME}" fill="none" stroke="${JAR_LINE}" stroke-width="1.1" stroke-linecap="round"/>`,
  `<ellipse cx="38" cy="58" rx="16" ry="2.2" fill="none" stroke="${JAR_LINE}" stroke-width="1"/>`,
  // 硝子の照り: 左の肩に短い弧を一本
  `<path d="M27 36 C27 28 30.6 22.6 35 20.6" fill="none" stroke="${JAR_LINE}" stroke-width="1" stroke-linecap="round" opacity="0.55"/>`
], 76);

// 空を知らせる絵。錬成室の空き枠の器（bell-jar）はハブの外が使う。鉢（pot）・巣（nest）・籠（cage）と植える場の小さな鉢
// （small-pot）・巣（small-nest）は上の星の揺り籠の絵。
const EMPTY_ART = Object.freeze({
  'bell-jar': BELL_JAR,
  pot: EMPTY_POT,
  nest: EMPTY_NEST,
  cage: EMPTY_CAGE,
  'small-pot': SMALL_POT,
  'small-nest': SMALL_NEST
});

function svgFrom(markup) {
  const template = document.createElement('template');
  template.innerHTML = markup;
  return template.content.firstElementChild;
}

function nameForReadingOnly(element, name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(`hub terrace: ${element.className || element.localName} has no name to read out`);
  }
  element.setAttribute('aria-label', name.trim());
}

// ボタンをアイコンのボタンにする（名前は aria-label・中身はアイコンだけ）。
export function dressSigilButton(button, sigil, name) {
  if (!Object.hasOwn(SIGILS, sigil)) throw new Error(`hub terrace: unknown sigil ${JSON.stringify(sigil)}`);
  nameForReadingOnly(button, name);
  button.classList.add('terrace-sigil-button');
  button.replaceChildren(svgFrom(SIGILS[sigil]));
  return button;
}

// 能力のアイコン: flagship が通した hubTerraceSigils.svg の symbol（id は sigil-<能力の key>）。製品の静的配信は .svg を
// text/html で返し、外の file を指す <use href> は描かれないので、起動時に読み込んで symbol をハブの置き場
// （#terrace-sigil-symbols）へ写し、文書の中の <use href="#sigil-<key>"> で引く。
const ABILITY_SIGILS_URL = '/hubTerraceSigils.svg';
const SVG_NS = 'http://www.w3.org/2000/svg';

export async function loadAbilitySigils() {
  const response = await fetch(ABILITY_SIGILS_URL);
  if (!response.ok) throw new Error(`hub terrace: ${ABILITY_SIGILS_URL} answered ${response.status}`);
  const sheet = new DOMParser().parseFromString(await response.text(), 'image/svg+xml');
  if (sheet.querySelector('parsererror')) throw new Error(`hub terrace: ${ABILITY_SIGILS_URL} is not an SVG`);
  const symbols = sheet.documentElement.querySelectorAll(':scope > symbol[id^="sigil-"]');
  if (symbols.length === 0) throw new Error(`hub terrace: ${ABILITY_SIGILS_URL} has no sigil symbols`);
  required('#terrace-sigil-symbols').replaceChildren(...Array.from(symbols, (symbol) => document.importNode(symbol, true)));
}

// 能力の名前: アイコンだけ（名前は role=img の aria-label）。
export function abilitySigilLabel(key, name) {
  const id = `sigil-${key}`;
  const symbol = document.getElementById(id);
  if (!(symbol instanceof SVGSymbolElement)) throw new Error(`hub terrace: no sigil symbol for the ability ${JSON.stringify(key)}`);
  const label = document.createElement('span');
  label.setAttribute('role', 'img');
  nameForReadingOnly(label, name);
  const sigil = document.createElementNS(SVG_NS, 'svg');
  sigil.setAttribute('class', `terrace-sigil terrace-sigil-ability terrace-sigil-${key}`);
  sigil.setAttribute('viewBox', symbol.getAttribute('viewBox'));
  sigil.setAttribute('aria-hidden', 'true');
  sigil.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${id}`);
  sigil.append(use);
  label.append(sigil);
  return label;
}

// 虫眼鏡の印（入力の欄に添える飾りで、ボタンではない）。
const SEARCH_MARK = '<svg class="terrace-sigil terrace-sigil-search" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><circle cx="13.5" cy="13.5" r="8.5" fill="#2a3070" stroke="#dde3f6" stroke-width="1.3" /><path d="M19.8 19.8 L27.5 27.5" fill="none" stroke="#dde3f6" stroke-width="2.4" stroke-linecap="round" /><path d="M11.50 8.60 L12.12 10.18 L13.70 10.80 L12.12 11.42 L11.50 13.00 L10.88 11.42 L9.30 10.80 L10.88 10.18 Z" fill="#e8c877" /></svg>';

// 一行の入力の欄に虫眼鏡の印を添える。名前は欄の aria-label にだけ持たせ、placeholder も title も置かない。
export function searchField(name) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'terrace-search-input';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.enterKeyHint = 'search';
  nameForReadingOnly(input, name);
  const field = document.createElement('label');
  field.className = 'terrace-search';
  field.append(svgFrom(SEARCH_MARK), input);
  return { field, input };
}

// 空を知らせる絵を element に置く（element は role=img・名前は製品の題と一文）。
export function fillWithEmptyArt(element, art, name) {
  if (!Object.hasOwn(EMPTY_ART, art)) throw new Error(`hub terrace: unknown empty picture ${JSON.stringify(art)}`);
  element.setAttribute('role', 'img');
  nameForReadingOnly(element, name);
  element.replaceChildren(svgFrom(EMPTY_ART[art]));
  return element;
}

// 名のそばの窓を縦にずらして画面の内に収めるときの、画面の上下の縁からの間（額の外の暈のぶん）。
const PLACE_WINDOW_KEEP_IN_PX = 24;
// 案内人の顔の帯: 画面の高さの上からこの割合まで。名のそばの窓の上端はこの帯に入れない（立ち姿は画面の高さいっぱいに立つ）。
const GUIDE_FACE_BAND = 0.31;

function required(selector, scope = document) {
  const node = scope.querySelector(selector);
  if (!node) throw new Error(`hub terrace: missing ${selector}`);
  return node;
}

// 行き先から戻った直後: いまの週（elapsed_weeks）に適用済みの週進行があれば、それが戻ってきた場所。週進行が無いのは、
// まだどこへも行っていない週（新しく始めた週）。あるのに配列でなければ壊れた状態なので throw する。
function returnedDestinationId(state) {
  if (!Object.hasOwn(state, 'routing_week_progressions')) return null;
  if (!Array.isArray(state.routing_week_progressions)) {
    throw new Error(`hub terrace: runtime_state.routing_week_progressions must be an array when present, got ${JSON.stringify(state.routing_week_progressions)}`);
  }
  const applied = state.routing_week_progressions.filter((record) => record.phase === 'applied');
  const latest = applied[applied.length - 1];
  if (!latest || latest.elapsed_weeks !== state.elapsed_weeks || latest.destination_id === 'title') return null;
  return latest.destination_id;
}

// 行き先の場所の絵。行き先の画面の地と、入るときの待ちの地は、この一枚を引く。
export function destinationArt(id) {
  if (!Object.hasOwn(DESTINATION_ART, id)) throw new Error(`hub terrace: no art entry for the destination ${JSON.stringify(id)}`);
  return DESTINATION_ART[id];
}

// 行き先から露台へ戻る道の待ちの地にする、今週行ってきた場所の絵。行き先から戻る道でしか呼ばないので、
// 今週の週進行が無ければ throw する。
export function returnedPlaceArt(state) {
  const destinationId = returnedDestinationId(state);
  if (destinationId === null) throw new Error(`hub terrace: no destination has been visited in week ${JSON.stringify(state.elapsed_weeks)} to return from`);
  if (!Object.hasOwn(DESTINATION_ART, destinationId)) throw new Error(`hub terrace: no art entry for the returned destination ${JSON.stringify(destinationId)}`);
  return DESTINATION_ART[destinationId];
}

export function createHubTerrace() {
  const hub = required('#routing-hub-screen');
  const stream = required('#routing-hub-message-stream', hub);
  const curtain = required('#terrace-opened');
  const infoPopup = required('#routing-hub-info-popup', hub);
  const equipmentPopup = required('#routing-hub-equipment-popup', hub);
  const cradle = required('#routing-hub-star-cradle', hub);
  const cradleGlobe = required('#routing-hub-cradle-globe', hub);

  // ── 行き先の一覧（ハブの開始の応答の routing_destinations）──────────────────
  // names: id → 名、byLabel: 名 → id、labelPattern: 言葉の中の名を長い順に探す式。ハブの開始が一度も済んでいない間は null。
  let places = null;

  function place(id) {
    if (places === null) throw new Error('hub terrace: the destinations have not arrived with a hub start yet');
    const label = places.names.get(id);
    if (label === undefined) throw new Error(`hub terrace: unknown destination ${JSON.stringify(id)}`);
    return { id, label, art: DESTINATION_ART[id] };
  }

  function setDestinations(destinations) {
    if (!Array.isArray(destinations) || destinations.length === 0) {
      throw new Error(`hub terrace: routing_destinations must be a non-empty array, got ${JSON.stringify(destinations)}`);
    }
    const names = new Map();
    for (const destination of destinations) {
      if (typeof destination?.id !== 'string' || typeof destination.label !== 'string' || destination.label === '') {
        throw new Error(`hub terrace: malformed routing destination ${JSON.stringify(destination)}`);
      }
      names.set(destination.id, destination.label);
    }
    const unmapped = [...names.keys()].filter((id) => !Object.hasOwn(DESTINATION_ART, id));
    const stale = Object.keys(DESTINATION_ART).filter((id) => !names.has(id));
    if (unmapped.length || stale.length) {
      throw new Error(`hub terrace: the destination art map is out of step with routing_destinations (unmapped: ${unmapped.join(',') || '-'} / stale: ${stale.join(',') || '-'})`);
    }
    const byLabel = new Map([...names].map(([id, label]) => [label, id]));
    const labelPattern = new RegExp(
      [...byLabel.keys()].sort((a, b) => b.length - a.length).map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
      'g'
    );
    places = { names, byLabel, labelPattern };
  }

  // ── 行き先の名に光を差す ────────────────────────────────────────────────────
  function markPlaceNames(paragraph) {
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    for (const node of textNodes) {
      const text = node.nodeValue;
      const matches = [...text.matchAll(places.labelPattern)];
      if (matches.length === 0) continue;
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      for (const match of matches) {
        if (match.index > cursor) fragment.append(text.slice(cursor, match.index));
        const named = place(places.byLabel.get(match[0]));
        const span = document.createElement('span');
        span.className = 'terrace-place';
        span.dataset.destinationId = named.id;
        span.textContent = match[0];
        fragment.append(span);
        cursor = match.index + match[0].length;
      }
      if (cursor < text.length) fragment.append(text.slice(cursor));
      node.replaceWith(fragment);
    }
  }

  // ── 場所の窓 ───────────────────────────────────────────────────────────────
  // 窓は一つの要素で、額（.terrace-place-window）と中の絵（img）だけを持つ（文字は置かない）。大きさ・額・動きは
  // hubTerrace.css が持ち、ここは何を見せるか・どの席に置くか・絵のどこを残すかを決める。
  // wanted: いま見せたい窓（{ id, name } = 触れた名の行き先とその名の要素）か null。
  // shown: いま開いている窓（wanted に置いた同じ object）か null。pumpWindow が shown を wanted に追いつかせる:
  // 開いている窓が wanted と違えば閉じきってから次を開くので、開いているのは一度に一つ。
  const placeWindow = document.createElement('div');
  placeWindow.className = 'terrace-place-window';
  placeWindow.hidden = true;
  placeWindow.setAttribute('aria-hidden', 'true');
  const placeWindowArt = document.createElement('img');
  placeWindowArt.className = 'terrace-place-window-art';
  placeWindowArt.alt = '';
  placeWindow.append(placeWindowArt);
  required('.routing-hub-frame', hub).append(placeWindow);

  let wanted = null;
  let shown = null;
  let pumping = false;

  // 窓の動き（hubTerrace.css の animation）が終わるのを待つ。動きを減らす設定では animation が無く、その場で済む。
  const windowMotionDone = () => Promise.allSettled(placeWindow.getAnimations().map((animation) => animation.finished));

  // 絵を額いっぱいに敷いたとき、行き先の中心の点が額の真ん中に来るように（絵の端より外へは寄らずに）置く。
  function focusWindowArt(destinationId) {
    const focus = DESTINATION_ART_FOCUS[destinationId];
    const frame = { x: placeWindowArt.clientWidth, y: placeWindowArt.clientHeight };
    const natural = { x: placeWindowArt.naturalWidth, y: placeWindowArt.naturalHeight };
    const scale = Math.max(frame.x / natural.x, frame.y / natural.y);
    const along = (axis) => {
      const spare = natural[axis] * scale - frame[axis];
      if (spare < 1) return 50;
      return Math.min(1, Math.max(0, (focus[axis] * natural[axis] * scale - frame[axis] / 2) / spare)) * 100;
    };
    placeWindowArt.style.objectPosition = `${along('x')}% ${along('y')}%`;
  }

  // 窓を名のそばに置く。横は言葉の欄の外側（hubTerrace.css）で、縦は触れた名の行の高さに合わせ、画面の内に収まり、案内人の顔に
  // かからないよう縦だけずらす。置いた窓が言葉の行と重なるなら、開かずに throw する。
  function seatWindow(request) {
    placeWindow.hidden = false;
    focusWindowArt(request.id);
    const hubBox = hub.getBoundingClientRect();
    const nameBox = request.name.getBoundingClientRect();
    const height = placeWindow.offsetHeight;
    const top = nameBox.top + nameBox.height / 2 - height / 2 - hubBox.top;
    const highest = Math.max(PLACE_WINDOW_KEEP_IN_PX, hubBox.height * GUIDE_FACE_BAND);
    placeWindow.style.top = `${Math.min(hubBox.height - height - PLACE_WINDOW_KEEP_IN_PX, Math.max(highest, top))}px`;
    const box = placeWindow.getBoundingClientRect();
    const covered = [...stream.querySelectorAll('.chat-message :is(.message-face, .message-bubble)')].filter((piece) => {
      const words = piece.getBoundingClientRect();
      return words.width > 0 && words.height > 0 && words.left < box.right && words.right > box.left && words.top < box.bottom && words.bottom > box.top;
    });
    if (covered.length > 0) {
      throw new Error(`hub terrace: the place window for ${request.id} would cover ${covered.length} piece(s) of the words (window ${JSON.stringify(box.toJSON())})`);
    }
  }

  async function pumpWindow() {
    if (pumping) return;
    pumping = true;
    try {
      while (shown !== wanted) {
        if (shown !== null) {
          placeWindow.dataset.window = 'closing';
          await windowMotionDone();
          placeWindow.hidden = true;
          delete placeWindow.dataset.window;
          shown = null;
          continue;
        }
        const next = wanted;
        const { art } = place(next.id);
        if (placeWindowArt.getAttribute('src') !== art) placeWindowArt.src = art;
        await placeWindowArt.decode();
        if (wanted !== next) continue;
        try {
          seatWindow(next);
        } catch (error) {
          placeWindow.hidden = true;
          wanted = null;
          throw error;
        }
        // 窓はふわりと現れる。
        placeWindow.dataset.window = 'opening';
        shown = next;
        await windowMotionDone();
      }
    } finally {
      pumping = false;
    }
  }

  function wantWindow(request) {
    wanted = request;
    return pumpWindow();
  }

  // 言葉の列の上のポインタの位置（行の描き直しで触れていた名の要素が入れ替わったとき、同じ所の名を引き直すのに使う）。
  let pointerAt = null;
  stream.addEventListener('pointermove', (event) => {
    pointerAt = { x: event.clientX, y: event.clientY };
  });
  stream.addEventListener('pointerover', (event) => {
    pointerAt = { x: event.clientX, y: event.clientY };
    const name = event.target.closest?.('.terrace-place');
    if (!name || (wanted !== null && wanted.name === name)) return;
    // 行の描き直しで入れ替わった同じ名: 窓は開いたまま、触れている名だけ持ち替える。
    if (wanted !== null && wanted.id === name.dataset.destinationId && !wanted.name.isConnected) {
      wanted.name = name;
      return;
    }
    wantWindow({ id: name.dataset.destinationId, name });
  });
  stream.addEventListener('pointerout', (event) => {
    const name = event.target.closest?.('.terrace-place');
    if (name && !name.contains(event.relatedTarget) && wanted !== null && wanted.name === name) wantWindow(null);
  });

  // 会話の行が描き直された後: 触れていた名の要素が消えていたら、ポインタの下に同じ行き先の名が描き直されていればその名に
  // 持ち替えて窓を開いたままにし、無ければ窓を閉じる。
  function keepTouchedName() {
    if (wanted === null || wanted.name.isConnected) return;
    const redrawn = document.elementFromPoint(pointerAt.x, pointerAt.y)?.closest('.terrace-place') ?? null;
    if (redrawn !== null && redrawn.dataset.destinationId === wanted.id) wanted.name = redrawn;
    else wantWindow(null);
  }

  // ── 送り出しの幕: 絵を持たず、ハブを夜へ沈める ─────────────────────────────────────────
  // sendoff: 送り出しの間だけ持つ（destinationId = 決まった行き先〔読み込みの箱へ沈める道は null〕・fillTimer = 満たし始めの予約・
  // nightFallen = 夜が満ちきった（または幕が上がった）ことを nightFallsBy の待ち手へ知らせる手・leftHub = ハブを離れたか・
  // toBox = 読み込みの箱へ沈める道か）。
  let sendoff = null;

  // 幕の満ちる長さ（hubTerrace.css の #terrace-opened の transition。動きを減らす設定では 0）。
  function curtainFillMs() {
    const duration = getComputedStyle(curtain).transitionDuration.split(',')[0].trim();
    const match = /^([\d.]+)(ms|s)$/.exec(duration);
    if (match === null) throw new Error(`hub terrace: cannot read the curtain's fill duration ${JSON.stringify(duration)}`);
    return Number(match[1]) * (match[2] === 's' ? 1000 : 1);
  }

  // 幕の動き（満ちる・薄れる）が済んだ（取り消された動きも済んだに数える）。
  function curtainStill() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      .then(() => Promise.allSettled(curtain.getAnimations().map((animation) => animation.finished)))
      .then(() => undefined);
  }

  function tellNightFallen() {
    if (sendoff === null || sendoff.nightFallen === null) return;
    const resolve = sendoff.nightFallen;
    sendoff.nightFallen = null;
    resolve();
  }

  function fillCurtain({ instant }) {
    if (instant) {
      clearTimeout(sendoff.fillTimer);
      curtain.classList.add('is-instant');
    }
    if (!curtain.hidden) return;
    curtain.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => curtain.classList.add('is-filled')));
  }

  // ハブを離れた（読み込みの画面が出た・または幕の上に行き先へ入る待ちが置かれた）: 幕をその場で満たしきる。
  function leaveHub() {
    if (sendoff.leftHub) return;
    sendoff.leftHub = true;
    fillCurtain({ instant: true });
    tellNightFallen();
  }

  function liftCurtain() {
    if (sendoff !== null) {
      clearTimeout(sendoff.fillTimer);
      tellNightFallen();
    }
    sendoff = null;
    hub.classList.remove('terrace-is-opening');
    curtain.hidden = true;
    curtain.classList.remove('is-filled', 'is-instant', 'is-clearing');
  }

  // 読み込みの箱（箱へ沈める道・区切りの道）が出た: 夜からその画面へ、幕を薄れさせて渡す（薄れきったら
  // 上げる）。薄れの途中で幕が上がった・次の送り出しが始まったときは、薄れは取り消されて（AbortError）上げる手はそちらが持つ。
  function clearCurtain() {
    clearTimeout(sendoff.fillTimer);
    tellNightFallen();
    sendoff = null;
    hub.classList.remove('terrace-is-opening');
    curtain.classList.add('is-clearing');
    Promise.all(curtain.getAnimations().map((animation) => animation.finished)).then(() => {
      if (sendoff === null && curtain.classList.contains('is-clearing')) liftCurtain();
    }, (error) => {
      if (error?.name !== 'AbortError') throw error;
    });
  }

  // ── 開いている間の左の列 ─────────────────────────────────────────────────────
  function closeWithProductButton(popup) {
    if (!popup.hidden) required('.routing-hub-info-popup-close', popup).click();
  }
  hub.addEventListener('click', (event) => {
    const railButton = event.target.closest('.routing-hub-category-button');
    const onGlobe = cradleGlobe.contains(event.target);
    if (!railButton && !onGlobe) return;
    closeWithProductButton(equipmentPopup);
    const sameInfo = railButton && !infoPopup.hidden && infoPopup.dataset.category === railButton.dataset.routingCategory;
    if (sameInfo) event.stopPropagation();
    if (sameInfo || !railButton) closeWithProductButton(infoPopup);
  }, { capture: true });
  // 揺り籠は画面いっぱいに左の列を覆うので、開いている間は列を inert にして Tab の focus も届かせない。
  const rail = required('.routing-hub-category-rail', hub);
  const syncRailWithCradle = () => {
    rail.inert = !cradle.hidden;
  };
  syncRailWithCradle();
  new MutationObserver(syncRailWithCradle).observe(cradle, { attributes: true, attributeFilter: ['hidden'] });

  return {
    // ハブの開始の応答の routing_destinations を受け取る（絵の表と id の集合に過不足があれば throw）。
    setDestinations,
    // 失敗の報せに出す行き先の名（届いた一覧から id で引く・引けなければ throw）。
    destinationLabel(id) {
      return place(id).label;
    },
    // 会話の行を描いた直後（stream に入る前）に呼ぶ: 行き先の名に光を差し、触れていた名が描き直しで入れ替わったなら持ち替える。
    markRows(rows) {
      for (const row of rows) {
        if (!row.classList.contains('character-message') && !row.classList.contains('narration-message')) continue;
        for (const paragraph of row.querySelectorAll('.message-bubble p')) markPlaceNames(paragraph);
      }
      if (wanted !== null) requestAnimationFrame(keepTouchedName);
      return rows;
    },
    // routing_draining: 行き先が決まった。言葉が灯るあいだは露台の言葉の側の夜を一段沈める。幕の夜を満たすのは nightFallsBy が
    // 決める。届いた一覧に無い行き先は throw。
    beginSendoff(destinationId) {
      if (sendoff !== null) throw new Error('hub terrace: a send-off is already under way');
      place(destinationId);
      sendoff = { destinationId, fillTimer: null, nightFallen: null, leftHub: false, toBox: false };
      wantWindow(null);
      hub.classList.add('terrace-is-opening');
    },
    // 見送り読みポーズの終わりの時刻（Date.now() の ms）を受け、その時刻にちょうど満ちきるように幕の夜を満たし始める（満ちる長さは
    // 幕の transition から読む・動きを減らす設定ではその時刻にその場で夜にする）。夜が満ちきったとき（それより先にハブを離れて
    // 満たしきった・幕が上がったときはそのとき）に解決する。送り出しの外・箱へ沈める道・二度目は throw。
    nightFallsBy(at) {
      if (sendoff === null || sendoff.toBox) throw new Error('hub terrace: no send-off to let the night fall on');
      if (sendoff.fillTimer !== null || sendoff.nightFallen !== null) throw new Error('hub terrace: the send-off night is already set to fall');
      if (!Number.isFinite(at)) throw new Error(`hub terrace: the night needs a time to be full by, got ${JSON.stringify(at)}`);
      const fillMs = curtainFillMs();
      return new Promise((resolve) => {
        sendoff.nightFallen = resolve;
        if (sendoff.leftHub) {
          tellNightFallen();
          return;
        }
        sendoff.fillTimer = setTimeout(() => {
          if (fillMs === 0) {
            fillCurtain({ instant: true });
            tellNightFallen();
            return;
          }
          fillCurtain({ instant: false });
          curtainStill().then(tellNightFallen);
        }, Math.max(0, at - Date.now() - fillMs));
      });
    },
    // 読み込みの箱へ行く道（後処理の止まりからやり直した送り出し・言葉の流れない送り出し）: 露台を夜へ沈め、満ちきったところで
    // 解決する。箱が出たら幕は箱の夜へ薄れて上がり、ハブへ戻ったら上がる。
    sinkForLoadingBox() {
      if (sendoff !== null) throw new Error('hub terrace: a send-off is already under way');
      sendoff = { destinationId: null, fillTimer: null, nightFallen: null, leftHub: false, toBox: true };
      wantWindow(null);
      hub.classList.add('terrace-is-opening');
      fillCurtain({ instant: false });
      return curtainStill();
    },
    // 送り出しが途切れた（turn の stream・送り出しの後の失敗）: 幕を上げて露台に戻す。
    abortSendoff() {
      if (sendoff === null) return;
      liftCurtain();
    },
    // showScreen のたびに呼ぶ。ハブを離れたら場所の窓を閉じる。送り出しの間は、ハブを離れたら満たしきり、行き先の画面か
    // ハブが出たら幕を上げる。箱へ沈める道と区切り（タイトルへ）の道では、読み込みの箱が出たら幕は薄れて上がる。
    screenShown(name) {
      if (name !== 'routing-hub') wantWindow(null);
      if (sendoff === null) return;
      if (name === 'routing-hub') {
        if (!sendoff.leftHub) return;
        // 行き先に着けずにハブへ戻った: 幕を上げる。
        liftCurtain();
        return;
      }
      leaveHub();
      if (name === 'academy-loading' && (sendoff.toBox || sendoff.destinationId === 'title')) clearCurtain();
      else if (name !== 'academy-loading') liftCurtain();
    },
    // 行き先へ入る待ちを幕の上に置く（app.js の raiseSendoffPlaceVeil）: 画面は露台のまま、幕を満たしきってハブを離れたことにする。
    // 待ちは満ちた夜から上がる。幕は行き先の画面（またはハブ）が出たところで上がる。
    holdCurtainForWait() {
      if (sendoff === null) throw new Error('hub terrace: no send-off curtain to wait over');
      leaveHub();
    },
    // 送り出しの幕の夜が画面を満たしきっているか（ハブを離れて満たしきった送り出しの間）。帰りの入り口が、夜から浮かぶか画面の上で
    // 浮かぶかを選ぶのに読む。
    sendoffNightFull() {
      return sendoff !== null && sendoff.leftHub;
    }
  };
}
