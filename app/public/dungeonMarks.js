// ダンジョンの印（FS-20260929-03）: 盤の下り階段・のぼり階段（各階の入口）・宝箱・主人公の紋と、入る前の持ち物の武器と護符・同行の印を、
// 黒曜と琥珀の描き方の SVG 文字列で返す純関数の集まり。DOM にも CSS にも触れず、置き場（升目・駒・柱の行・入る前の画面）の大きさに合わせて
// 伸び縮みする（viewBox だけを持ち、幅と高さは置く側の CSS が決める）。
//
// 盤の印は床と壁と同じ真上からの視点で描く。灯りの三つの濃さ（灯りの中・一度見た所・まだ見ていない所）への従い方は置く側の CSS が
// 升目の class で持ち、印ごとに見え方を分けない。defs（gradient・filter）を持たないのは、同じ印が同じ文書に何度も置かれ、見えない
// 升目（display:none）の中の定義を他の印が参照すると描けなくなるため。濃淡は色と不透明度を重ねて作る。

const round = (value) => Math.round(value * 100) / 100;
const at = (cx, cy, r, deg) => {
  const rad = (deg * Math.PI) / 180;
  return `${round(cx + r * Math.cos(rad))} ${round(cy + r * Math.sin(rad))}`;
};

// 五つの角を持つ星（中心・外の半径・内の半径）。
function starPath(cx, cy, outer, inner) {
  const points = [];
  for (let i = 0; i < 10; i += 1) points.push(at(cx, cy, i % 2 === 0 ? outer : inner, -90 + i * 36));
  return `M${points.join(' L')} Z`;
}

// 下り階段の、床に開いた口の縁（石の枠）。北の縁は口の中へ落ちる影を持ち、南と西の縁は灯りを受ける。
const OPENING_RIM = [
  '<rect x="8" y="5" width="84" height="90" rx="3" fill="#3a2d1f"/>',
  '<path d="M8 8 V92 M11 5 H89" stroke="rgb(255 232 196 / 0.22)" stroke-width="2" fill="none"/>',
  '<path d="M92 8 V92 M11 95 H89" stroke="rgb(0 0 0 / 0.45)" stroke-width="2" fill="none"/>',
  '<path d="M8 50 H14 M86 50 H92 M50 5 V11 M30 95 V89 M70 95 V89" stroke="rgb(0 0 0 / 0.4)" stroke-width="1.4"/>'
].join('');

// 下り階段: 床に開いた口から、段が一つずつ狭く暗くなりながら北の闇へ下る。いちばん手前の段の鼻だけが灯りを受けて琥珀に光る。
export function stairsDownSvg() {
  const steps = [];
  const tones = ['#5b4630', '#42331f', '#2c2114', '#1a140c', '#0e0b07'];
  const nose = [0.62, 0.4, 0.24, 0.12, 0.05];
  for (let i = 0; i < tones.length; i += 1) {
    const top = 87 - (i + 1) * 13;
    const bottom = 87 - i * 13;
    const inset = 15 + (i + 1) * 4.5;
    steps.push(`<rect x="${inset}" y="${top}" width="${100 - inset * 2}" height="${bottom - top}" fill="${tones[i]}"/>`);
    steps.push(`<path d="M${inset} ${bottom - 0.8} H${100 - inset}" stroke="rgb(240 178 74 / ${nose[i]})" stroke-width="1.6"/>`);
    steps.push(`<path d="M${inset} ${top + 0.6} H${100 - inset}" stroke="rgb(0 0 0 / 0.55)" stroke-width="1.2"/>`);
  }
  return [
    '<svg class="dm dm-stairs-down" viewBox="0 0 100 100" aria-hidden="true" focusable="false">',
    OPENING_RIM,
    // 口の中: 両脇の壁は段へ向かって落ち込み、北の奥は光の届かない闇。
    '<rect x="15" y="12" width="70" height="75" fill="#130f0b"/>',
    '<path d="M15 12 L37.5 22 V87 H15 Z" fill="#0b0907"/><path d="M85 12 L62.5 22 V87 H85 Z" fill="#0b0907"/>',
    ...steps,
    '<rect x="15" y="12" width="70" height="10" fill="#050407"/>',
    '<path d="M15 12 H85" stroke="rgb(0 0 0 / 0.8)" stroke-width="3"/>',
    '</svg>'
  ].join('');
}

// のぼり階段（各階の入口・撤退できる所）: 床に開いた口ではなく、床の上に立って北へ上る一続きの段。両脇の石の頬壁に挟まれた段は、
// 上るほど踏み面が明るくなり、段の先の口には上の階の光が満ちる。その光は段を下りながら縁の外の床へ扇に広がる。段は床より高いので、
// 影は段の縁の外の床へ落ち、高い段ほど長い（東の床に段々の影が伸びる）。下り階段の影は口の内側に落ちるので、影の向きで対になる。
export function stairsUpSvg() {
  const left = 12;
  const right = 66;
  const wall = 7;
  const bottom = 92;
  const top = 24;
  const count = 4;
  const pitch = (bottom - top) / count;
  const treads = ['#6a5236', '#806443', '#9a7b52', '#b89868'];
  const risers = ['#2e2317', '#3a2c1d', '#473624', '#56422c'];
  const steps = [];
  const shadow = [`M${right + wall} ${bottom + 3}`];
  for (let i = 0; i < count; i += 1) {
    const lower = bottom - i * pitch;
    const upper = lower - pitch;
    const riser = lower - 8;
    // 踏み面は上の段ほど明るい。手前（南）を向く蹴上げは光の陰で、その上の縁（段の鼻）が差す光を受ける。
    steps.push(`<rect x="${left + wall}" y="${round(upper)}" width="${right - left - wall}" height="${round(riser - upper)}" fill="${treads[i]}"/>`);
    steps.push(`<rect x="${left + wall}" y="${round(riser)}" width="${right - left - wall}" height="8" fill="${risers[i]}"/>`);
    steps.push(`<rect x="${left + wall}" y="${round(upper)}" width="${right - left - wall}" height="2.4" fill="rgb(0 0 0 / 0.35)"/>`);
    steps.push(`<path d="M${left + wall} ${round(riser)} H${right}" stroke="rgb(255 244 218 / ${round(0.2 + i * 0.08)})" stroke-width="1"/>`);
    // 床に落ちる影は、この段の高さの分だけ東へ伸びる。
    const reach = right + wall + 5 + i * 6;
    shadow.push(`H${reach} V${round(upper + 3)}`);
  }
  shadow.push(`H${right + wall} Z`);
  const cheek = (x) => [
    `<rect x="${x}" y="${top - 4}" width="${wall}" height="${bottom - top + 4}" fill="#4a4138"/>`,
    `<rect x="${x}" y="${bottom}" width="${wall}" height="4" fill="#231d17"/>`,
    `<path d="M${x + 0.7} ${top - 4} V${bottom}" stroke="rgb(255 244 218 / 0.5)" stroke-width="1.4"/>`,
    `<path d="M${x + wall - 0.6} ${top - 4} V${bottom}" stroke="rgb(0 0 0 / 0.45)" stroke-width="1.2"/>`
  ].join('');
  return [
    '<svg class="dm dm-stairs-up" viewBox="0 0 100 100" aria-hidden="true" focusable="false">',
    // 上の階の光が段の先から床へ広がる溜まり（縁の外の床まで届き、外ほど薄い）。
    ...[[48, 44], [40, 36], [31, 28]].map(([rx, ry]) => `<ellipse cx="${(left + right + wall) / 2}" cy="${top + 8}" rx="${rx}" ry="${ry}" fill="rgb(255 236 196 / 0.1)"/>`),
    // 口から段を下って床へ抜ける差し込み（段の縁の外へ扇に広がる）。
    `<path d="M${left} ${top - 6} H${right + wall} L${right + wall + 6} ${bottom + 8} H${left - 20} Z" fill="rgb(255 244 214 / 0.12)"/>`,
    // 床より高い段と頬壁が落とす影（段々に伸びる）。
    `<path d="${shadow.join(' ')}" fill="rgb(0 0 0 / 0.5)"/>`,
    `<rect x="${left + 2}" y="${bottom}" width="${right + wall - left}" height="6" fill="rgb(0 0 0 / 0.35)"/>`,
    ...steps,
    cheek(left),
    cheek(right),
    // 段の先の口: 上の階の光が満ちる。
    `<rect x="${left + wall}" y="${top - 16}" width="${right - left - wall}" height="16" fill="rgb(255 248 228)"/>`,
    `<rect x="${left}" y="${top - 18}" width="${right + wall - left}" height="3" fill="#4a4138"/>`,
    `<path d="M${left + wall} ${top} H${right}" stroke="rgb(255 252 240)" stroke-width="2"/>`,
    `<path d="M${left + wall + 6} ${top} H${right - 6} L${right - 2} ${bottom} H${left + wall + 2} Z" fill="rgb(255 244 214 / 0.14)"/>`,
    '</svg>'
  ].join('');
}

// 宝箱: 真上から見た蓋。板目の木に、真鍮の帯が二本と縁、手前（南）の辺に錠前。盤と柱の持ち物の行で同じ絵を大きさ違いで使う。
export function chestSvg() {
  return [
    '<svg class="dm dm-chest" viewBox="0 0 100 100" aria-hidden="true" focusable="false">',
    '<rect x="14" y="22" width="72" height="56" rx="5" fill="#6a4324"/>',
    '<path d="M18 36 H82 M18 50 H82 M18 64 H82" stroke="rgb(0 0 0 / 0.32)" stroke-width="1.6"/>',
    '<rect x="18" y="45" width="64" height="10" fill="rgb(255 222 170 / 0.12)"/>',
    '<rect x="29" y="22" width="8" height="56" fill="#b98232"/><rect x="63" y="22" width="8" height="56" fill="#b98232"/>',
    '<path d="M30 23 V77 M64 23 V77" stroke="rgb(255 226 160 / 0.5)" stroke-width="1.2"/>',
    '<rect x="14" y="22" width="72" height="56" rx="5" fill="none" stroke="#d9a24a" stroke-width="3"/>',
    '<path d="M17 25 H83" stroke="rgb(255 232 190 / 0.35)" stroke-width="1.2"/>',
    '<rect x="42" y="70" width="16" height="14" rx="2" fill="#f0b24a" stroke="#7a4f18" stroke-width="1.4"/>',
    '<circle cx="50" cy="76" r="2.2" fill="#2a1a08"/><path d="M50 77 V81" stroke="#2a1a08" stroke-width="1.6"/>',
    '</svg>'
  ].join('');
}

// 主人公の紋: 学院の名「星灯」（data/definitions/game_data/world/settings.json の academy_name「星灯魔法学院」）から起こす。真上から
// 見た手提げの灯の、琥珀の灯の輪の中心に星が一つ灯る。輪の外へ八つの光の穂が出るので、輪郭は丸ではなく光の形になる（同行者の、縁で
// 囲った丸い顔の駒と同じ種類の丸に見せない）。地は置く先に任せ（駒の丸い台を持たない）、紋の形の影を置く側が落とす。
export function heroCrestSvg() {
  const rays = [];
  for (let i = 0; i < 8; i += 1) {
    const deg = -90 + i * 45;
    const long = i % 2 === 0;
    rays.push(`<path d="M${at(50, 50, 36, deg - (long ? 9 : 7))} L${at(50, 50, long ? 49 : 45, deg)} L${at(50, 50, 36, deg + (long ? 9 : 7))} Z" fill="#f0b24a"/>`);
  }
  return [
    '<svg class="dm dm-crest" viewBox="0 0 100 100" aria-hidden="true" focusable="false">',
    ...rays,
    '<circle cx="50" cy="50" r="33" fill="#140e08"/>',
    '<circle cx="50" cy="50" r="31.5" fill="none" stroke="#f0b24a" stroke-width="6"/>',
    '<circle cx="50" cy="50" r="31.5" fill="none" stroke="rgb(255 232 180 / 0.55)" stroke-width="1.2"/>',
    '<circle cx="50" cy="50" r="24.5" fill="none" stroke="rgb(240 178 74 / 0.35)" stroke-width="1.2"/>',
    '<circle cx="50" cy="50" r="17" fill="rgb(255 196 104 / 0.22)"/>',
    `<path d="${starPath(50, 50, 18, 7.4)}" fill="#ffd98a" stroke="#fff1cf" stroke-width="0.8" stroke-linejoin="round"/>`,
    '</svg>'
  ].join('');
}

// 入る前の持ち物の武器と護符（剣・杖・短杖・護符）: 消耗品の小瓶と同じ描き方で、平らな形に琥珀の金具と黒曜の地、灯りを受ける縁
// だけを淡く光らせる。絵の出どころはこの file の SVG そのもので、どれも左下から右上へ斜めに置く。黒曜の地は
// 置き場の暗い台に沈まないよう、琥珀の細い縁で輪郭を取る。
const AMBER = '#f0b24a';
const AMBER_DEEP = '#b98232';
const OBSIDIAN = '#1c1a20';
const IVORY = '#fff1cf';
const diagonal = (body) => `<g transform="rotate(45 50 50)">${body}</g>`;
const gem = (cx, cy, w, h) => [
  `<path d="M${cx} ${cy - h / 2} L${cx + w / 2} ${cy} L${cx} ${cy + h / 2} L${cx - w / 2} ${cy} Z" fill="#ffd98a" stroke="${IVORY}" stroke-width="0.8"/>`,
  `<path d="M${cx} ${cy - h / 2} L${cx - w / 2} ${cy} L${cx} ${cy}" fill="rgb(255 250 235 / 0.6)"/>`
].join('');

// 剣: 黒曜の刃に琥珀の刃先、中ほどを走る淡い樋。十字の鍔と柄頭は琥珀で、鍔の中央に灯る石。柄は黒曜に琥珀の巻き。
export function swordSvg() {
  const wraps = [];
  for (let y = 71; y < 84; y += 3.2) wraps.push(`<path d="M46 ${y} L54 ${y + 1.6}" stroke="${AMBER_DEEP}" stroke-width="1.2"/>`);
  return [
    '<svg class="dm dm-sword" viewBox="0 0 100 100" aria-hidden="true" focusable="false">',
    diagonal([
      `<path d="M50 2 L56.5 11 V64 H43.5 V11 Z" fill="${OBSIDIAN}" stroke="${AMBER}" stroke-width="1.6" stroke-linejoin="round"/>`,
      `<path d="M50 9 V60" stroke="rgb(255 241 207 / 0.55)" stroke-width="1.4"/>`,
      `<path d="M33 64 L37 61 H63 L67 64 L63 70 H37 Z" fill="${AMBER}" stroke="${AMBER_DEEP}" stroke-width="1"/>`,
      `<path d="M37 62 H63" stroke="rgb(255 241 207 / 0.6)" stroke-width="0.9"/>`,
      gem(50, 65.5, 7, 9),
      `<rect x="46" y="70" width="8" height="15" rx="1.5" fill="${OBSIDIAN}" stroke="${AMBER}" stroke-width="1"/>`,
      ...wraps,
      `<path d="M50 84.5 L55 90 L50 96 L45 90 Z" fill="${AMBER}" stroke="${AMBER_DEEP}" stroke-width="1"/>`
    ].join('')),
    '</svg>'
  ].join('');
}

// 杖: 黒曜の長い柄の先に、琥珀の三日月が灯る石を抱く。石のまわりを細い輪が巡る。柄には琥珀の帯と、石突きの金具。
export function staffSvg() {
  return [
    '<svg class="dm dm-staff" viewBox="0 0 100 100" aria-hidden="true" focusable="false">',
    diagonal([
      `<rect x="46.5" y="30" width="7" height="58" rx="1.5" fill="${OBSIDIAN}" stroke="${AMBER}" stroke-width="1"/>`,
      `<path d="M48.6 32 V86" stroke="rgb(255 241 207 / 0.35)" stroke-width="0.9"/>`,
      `<rect x="45" y="44" width="10" height="5" rx="1" fill="${AMBER}" stroke="${AMBER_DEEP}" stroke-width="0.8"/>`,
      `<path d="M47 88 H53 L51.5 94 L50 98 L48.5 94 Z" fill="${AMBER}" stroke="${AMBER_DEEP}" stroke-width="0.8"/>`,
      // 三日月（角を上に向けて石を抱く）と、柄へ下りる受け。
      `<path d="M33 6 A18 18 0 0 0 67 6 A15 15 0 0 1 33 6 Z" transform="translate(0 10)" fill="${AMBER}" stroke="${AMBER_DEEP}" stroke-width="1" stroke-linejoin="round"/>`,
      `<path d="M44 29 L50 24 L56 29 L53 32 H47 Z" fill="${AMBER}" stroke="${AMBER_DEEP}" stroke-width="0.8"/>`,
      `<ellipse cx="50" cy="14" rx="13" ry="4.5" fill="none" stroke="rgb(255 241 207 / 0.55)" stroke-width="0.9"/>`,
      `<circle cx="50" cy="14" r="9" fill="rgb(255 210 122 / 0.25)"/>`,
      gem(50, 14, 10, 15),
      `<circle cx="37.5" cy="12.5" r="1.6" fill="${IVORY}"/>`
    ].join('')),
    '</svg>'
  ].join('');
}

// 短杖: 先へ細く尖る黒曜の杖に、琥珀の筋が螺旋に巻く。握りは琥珀の縁取りで、中ほどに灯る石、端に丸い柄頭。
export function wandSvg() {
  return [
    '<svg class="dm dm-wand" viewBox="0 0 100 100" aria-hidden="true" focusable="false">',
    diagonal([
      `<path d="M49 3 H51 L55 60 H45 Z" fill="${OBSIDIAN}" stroke="${AMBER}" stroke-width="1.4" stroke-linejoin="round"/>`,
      `<path d="M50.6 12 L48.4 24 M53 28 L47.2 42 M54 46 L46.4 58" stroke="${AMBER}" stroke-width="1.4" stroke-linecap="round"/>`,
      `<path d="M43.5 60 H56.5 L58 80 Q50 85 42 80 Z" fill="${OBSIDIAN}" stroke="${AMBER}" stroke-width="1.6" stroke-linejoin="round"/>`,
      gem(50, 70.5, 9, 13),
      `<rect x="44.5" y="83" width="11" height="3.4" rx="1" fill="${AMBER_DEEP}"/>`,
      `<circle cx="50" cy="90.5" r="5.4" fill="${AMBER}" stroke="${AMBER_DEEP}" stroke-width="1"/>`,
      `<circle cx="48.4" cy="88.8" r="1.6" fill="rgb(255 241 207 / 0.7)"/>`
    ].join('')),
    '</svg>'
  ].join('');
}

// 護符: 縦長の六角の琥珀の枠に黒曜の面、中央に灯る石と四方の星の筋。枠は上を右へ傾け、上の環から紐が右上へ回り、先に小さな三日月が
// 下がる。
export function charmSvg() {
  const cord = 'M52 30 C54 16 66 8 79 9 C91 10 93 22 84 29 C78 34 75 39 75 45';
  return [
    '<svg class="dm dm-charm" viewBox="0 0 100 100" aria-hidden="true" focusable="false">',
    `<path d="${cord}" fill="none" stroke="${AMBER_DEEP}" stroke-width="2.6" stroke-linecap="round"/>`,
    `<path d="${cord}" fill="none" stroke="rgb(255 241 207 / 0.35)" stroke-width="0.9" stroke-linecap="round"/>`,
    `<circle cx="87.4" cy="21" r="2.6" fill="${AMBER}" stroke="${AMBER_DEEP}" stroke-width="0.8"/>`,
    `<path d="M76 45 A8 8 0 1 1 68 54 A6.2 6.2 0 1 0 76 45 Z" fill="${AMBER}" stroke="${AMBER_DEEP}" stroke-width="0.8"/>`,
    '<g transform="rotate(30 40 62)">',
    `<circle cx="40" cy="31" r="3.4" fill="none" stroke="${AMBER}" stroke-width="2"/>`,
    `<path d="M40 34.4 L57 47 V77 L40 90 L23 77 V47 Z" fill="${AMBER}" stroke="${AMBER_DEEP}" stroke-width="1.2" stroke-linejoin="round"/>`,
    `<path d="M40 40 L52 49 V75 L40 84 L28 75 V49 Z" fill="${OBSIDIAN}"/>`,
    `<path d="M40 44 V80 M28 62 H52" stroke="rgb(240 178 74 / 0.4)" stroke-width="0.9"/>`,
    `<circle cx="40" cy="62" r="9" fill="rgb(255 210 122 / 0.22)"/>`,
    gem(40, 62, 11, 15),
    `<path d="M40 40 L52 49" stroke="rgb(255 241 207 / 0.6)" stroke-width="0.9"/>`,
    '</g>',
    '</svg>'
  ].join('');
}

// 同行の印: 結ばれた二つの琥珀の輪と、上に灯る星。相棒と潜るときは輪が重なって結ばれ、ひとりで潜るときは置く側の CSS が二つの輪を
// 左右へ離し（dm-tether-ring--left・--right を横へ送る）、星を薄くする。輪の形は一つだけで、結ぶ・ほどくの間は置く側が動かす。
export function companyTetherSvg() {
  return [
    '<svg class="dm dm-tether" viewBox="0 0 32 32" aria-hidden="true" focusable="false">',
    `<circle class="dm-tether-ring dm-tether-ring--left" cx="12.5" cy="17" r="6" fill="none" stroke="${AMBER}" stroke-width="1.6"/>`,
    `<circle class="dm-tether-ring dm-tether-ring--right" cx="19.5" cy="17" r="6" fill="none" stroke="${AMBER}" stroke-width="1.6"/>`,
    `<path class="dm-tether-star" d="M16 3.4 L16.6 5 L18.2 5.6 L16.6 6.2 L16 7.8 L15.4 6.2 L13.8 5.6 L15.4 5 Z" fill="${AMBER}"/>`,
    '</svg>'
  ].join('');
}
