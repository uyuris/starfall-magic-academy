// The product 大書庫 (#academy-library-screen), walked from the ordinary play entry and captured: the ten scenes as an
// animated WebP and the real screenshot of the same key instant (1440×900), and 07-turn / 08-related as animated WebP
// at 1920×1080 too; every scene's key instant and every state of the screen as stills at 1440×900 and at 1920×1080
// (a long-titled book open among them); the shelf and the reading book under reduced motion at both sizes; the
// first-stage prototype's capture (capture4) beside this one for 本が並ぶ・指を乗せる・読んでいる; the renderer's
// console errors, every one with its text; and probes measured on the real render — a finger resting on the top edge
// of a spine, the reduced-motion branch, and the page's ink laid on the painted paper (the letter heights from the far
// line to the near one, every letter inside the painted paper, text selection, and the footnote titles' hit points),
// and the turning leaf held at its take-off and at its landing: every letter of the leaf's face against the same letter
// of the resting page it leaves or lands on (07-turn-landing: the landing's last instant beside the first one after).
// Also: a book with no wait opened (no brush, the text straight away), the move to a related book from the press to
// the text, the first and the last spread of a two-spread book, and the closed cover with its ex libris pressed for
// every cover kind, every core book and the long titles the real LM gave.
//
// Run by hand (not *.test.mjs, so `npm test` skips it; it takes several minutes). Two modes:
//
//   ./node_modules/.bin/electron app/tests/manual/libraryScreenCapture.mjs capture \
//     --repo-root <absolute repo root> --out-dir <absolute, empty or absent publication directory> \
//     --prototype-dir <absolute directory of the prototype's capture4 (read only)>
//
//   ./node_modules/.bin/electron app/tests/manual/libraryScreenCapture.mjs waits \
//     --after-root <absolute repo root> --before-root <absolute repo root> \
//     --lm-config <absolute lmstudio.json of the real LM (read only)> --runs <pairs>
//
// Every argument of a mode is required, and absolute where it is a path; none has a default. The repos must be clean
// (the figures record the commit they were taken from). The prototype directory must hold 04-shelf.png, 05-hover.png
// and 07-turn.png at 1440×900; nothing in it is written.
//
// waits: how long a reader waits, on the real LM, from pressing a book on the shelf and from pressing a related book's
// title until the page can be read (the book's data-ink turns ready, the page carrying that book's title), for a book
// the LM writes (the first 補充 book, and the first related book that is not a core book) and for a book with no wait
// (the first core book on the shelf, and the first readable core book among its related books). Runs alternate before
// → after, `--runs` pairs, each run on its own stage, page and new game; every run prints the host's load average and
// the LM's own time for each body it wrote. Only the hub's talk is the fixed-answer LM; every library prompt goes to
// the real LM as the product sent it. Nothing is written (the results are printed).
//
// WHAT IS REAL AND WHAT IS A FIXTURE
// - Entry: the ordinary play entry every time — the title screen, 新しいプレイ, the routing hub's welcome talk, one
//   typed line asking for the 大書庫, and the hub's own send-off and loading cover into the library. No
//   ?initialScreen, no development tab row (checked on arrival: body.play-mode, the top bar not displayed).
// - Server: the product createServer in this process over an OS-temp root. The definitions and seeds are copied
//   there (the repo's data/ is never opened for writing); one entry of the copied 中核関連宣言 is replaced
//   (core_starfall_principle → no references) because the shipped table declares none empty, and the 0件 footnote
//   state exists only for such a book. The covers walk raises the new game's saved magic (its slot's
//   player_parameters.json under the OS-temp root) to its maximum: every core book readable. The waits mode keeps the
//   references table as shipped and the hero as the new game made them.
// - LM: a fixed-answer server speaking the LM Studio wire protocol. It answers the hub's talk (destination =
//   library) and the six library prompts (selection・titles・skeleton・style・footnotes・fragment) with the prototype
//   launcher's fixture titles and body, and refuses a titles prompt that lacks the product's 8-character line. The
//   covers walk has it choose the catalog books by id and name a long 生成題 the real LM gave as a related book. In
//   the waits mode it answers the hub's talk only and sends every library prompt on to the real LM. Search failures are made there: an HTTP 500 from the model, a selection that is not JSON, too few titles. The
//   本文 wait is the fragment answer held READ_DELAY_MS. LM 不通 is this server stopped under the running product
//   (the product keeps the config it loaded first, so 未設定 cannot be made after the hub's talk has used the LM;
//   未設定・不通・無応答 route to the same settings screen).
// - Front: a relay in front of the server holds every POST /api/library/search for SEARCH_DELAY_MS (the median
//   search wait measured on the real LM in library-product-replace) and can answer ONE armed request with a real
//   HTTP error or hold ONE armed request (本文の失敗・脚注の待ち/失敗・関連する本の失敗・到着の失敗). The covers
//   walk holds a search COVERS_SEARCH_DELAY_MS, the waits mode not at all. The page's content is not touched; the
//   covers walk pauses the page's animations for the instant of each cover still, and the moves are timed by a
//   listener, a fetch wrapper and observers that only record (TIMELINE_INSTALL).
// - Rendering: a hidden Electron window driven over CDP, the viewport pinned with Emulation.setDeviceMetricsOverride
//   at DPR 1 (every PNG and WebP frame is the viewport in pixels, like capture4). Motion is Page.startScreencast
//   (PNG frames, compositor timestamps); stills are Page.captureScreenshot (PNG).
// - Input: every click, hover, key, drag and typed character is a CDP Input event.
// - Encoding: python3 + Pillow. Animated WebP is lossy RGB (quality 90); each frame keeps its measured duration.
//
// The harness is fire-and-forget (no top-level await main(); whenReady would deadlock).
import { app, BrowserWindow } from 'electron';
import { createServer as createHttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MODES = {
  capture: { paths: ['--repo-root', '--out-dir', '--prototype-dir'], counts: [] },
  waits: { paths: ['--after-root', '--before-root', '--lm-config'], counts: ['--runs'] }
};

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const spec = MODES[mode];
  if (!spec) throw new Error(`the first argument is the mode: ${Object.keys(MODES).join(' | ')} (got ${mode})`);
  const known = [...spec.paths, ...spec.counts];
  const parsed = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!known.includes(token)) throw new Error(`unexpected argument for ${mode}: ${token} (expected ${known.join(', ')} only)`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${token}`);
    if (parsed[token] !== undefined) throw new Error(`duplicate argument: ${token}`);
    parsed[token] = value;
    i += 1;
  }
  for (const token of known) {
    const value = parsed[token];
    if (value === undefined) throw new Error(`${token} is required (no default, no fallback)`);
    if (spec.paths.includes(token) && !path.isAbsolute(value)) throw new Error(`${token} must be an absolute path: ${value}`);
    if (spec.counts.includes(token) && !/^[1-9]\d*$/.test(value)) throw new Error(`${token} must be a positive integer: ${value}`);
  }
  const key = (token) => token.slice(2).replace(/-(\w)/g, (_m, c) => c.toUpperCase());
  return { mode, ...Object.fromEntries(known.map((token) => [key(token), spec.counts.includes(token) ? Number(parsed[token]) : parsed[token]])) };
}

// The median of the three searches measured on the real LM in library-product-replace (7.96 / 7.48 / 7.68 s).
const SEARCH_DELAY_MS = 7680;
// The prototype capture's 本文 wait (capture4), so the reading scenes stand beside it on the same timing.
const READ_DELAY_MS = 5900;
const HUB_INPUT = '大書庫で本を探したい';
const THEME = '夜の星と古い記録';
// The book every walk hovers and opens: the fixture's first 生成題 (as in capture4).
const OPEN_TITLE = '観測者の夜録';
// A 生成題 that is a 禁書's catalog title (同題解決 → 403 at the hero's parameters), and one that is a readable
// catalog title (同題解決 → the authored book; its 関連宣言 is the replaced empty one → 0件).
const GATED_TITLE = '外法考 — 奪う術の系譜';
const SAME_TITLE = '星降りの理';
const SAME_TITLE_ID = 'core_starfall_principle';
// A 生成題 that is a readable catalog title too long for one line of the page's title (同題解決 → that book opens).
const LONG_TITLE = '星降りの地理 — 光の落ち方と土地柄';
const MAIN_VIEWPORT = { width: 1440, height: 900 };
const LARGE_VIEWPORT = { width: 1920, height: 1080 };
const SCENES_ALL = ['01-arrival', '02-handing', '03-waiting', '04-shelf', '05-hover', '06-open', '07-turn', '08-related', '09-close', '10-exit'];
// Which scenes each size records as animated WebP: all ten at 1440×900 (the recorder runs through the whole walk);
// the page turn and the move to a related book at 1920×1080 (the recorder runs from the turn to the related book).
// The smallest letter the page may carry, at its farthest line (Lead: 12px at 1440×900, 14px at 1920×1080), and the
// farthest body line's letters against the nearest one's.
const SIZES = [
  { label: '1440x900', viewport: MAIN_VIEWPORT, suffix: '', clips: SCENES_ALL, minLetterPx: 12 },
  { label: '1920x1080', viewport: LARGE_VIEWPORT, suffix: '@1920x1080', clips: ['07-turn', '08-related'], minLetterPx: 14 }
];
const MIN_FAR_TO_NEAR = 0.7;
const MIN_FRAME_SPACING_MS = 40;
const WEBP_QUALITY = 90;
const COMPARE_GAP = 16;
// The top-edge probe: how long the finger rests, how often the drawn state is read, how far inside the edge.
const EDGE_REST_MS = 3000;
const EDGE_SAMPLE_MS = 20;
const EDGE_INSETS_PX = [1, 3, 6];
// How long the relay holds the footnotes of the book scene 6 opens: long enough to reach its last spread first.
const FOOTNOTE_HOLD_MS = 14000;

const SCENES = [
  { id: '01-arrival', name: '到着' },
  { id: '02-handing', name: '問いを渡す' },
  { id: '03-waiting', name: '待つ' },
  { id: '04-shelf', name: '本が並ぶ' },
  { id: '05-hover', name: '指を乗せる' },
  { id: '06-open', name: '本を手に取って開く' },
  { id: '07-turn', name: '頁をめくる' },
  { id: '08-related', name: '関連する本へ移る' },
  { id: '09-close', name: '閉じる' },
  { id: '10-exit', name: '退出' }
];
const CLIP_RANGES = {
  '01-arrival': ['arrived', 'arrival-end'],
  '02-handing': ['handing-start', 'handing-end'],
  '03-waiting': ['handed', 'answer'],
  '04-shelf': ['answer', 'shelf-end'],
  '05-hover': ['hover-start', 'hover-end'],
  '06-open': ['open-start', 'open-end'],
  '07-turn': ['turn-start', 'turn-end'],
  '08-related': ['related-start', 'related-end'],
  '09-close': ['close-start', 'close-end'],
  '10-exit': ['exit-start', 'exit-end']
};
// The states the design brief counts (section 4) and the files that show them. A state that IS a scene's key
// instant points at that scene's still.
const STATES = [
  { id: 's-arrival-failed', name: '到着の失敗（票の上の一文・票は渡せない）' },
  { id: 's-empty-slip', name: '空の票を渡す（request なし・票も机の灯りも動かない）' },
  { id: '03-waiting', name: '検索の待ち（通路の灯りが奥を行き来する）' },
  { id: 's-search-failed-503', name: '検索の失敗（生成の不正出力 503）' },
  { id: 's-search-failed-500-lm', name: '検索の失敗（LM の HTTP 500）' },
  { id: 's-search-failed-500-json', name: '検索の失敗（JSON が壊れた 500）' },
  { id: 's-lm-unreachable', name: 'LM 不通（設定画面への誘導。未設定・無応答も同じ誘導先）' },
  { id: 's-open-wait', name: '本文の待ち（白い見開きの上を筆が左から右へ走り、墨の線を書く）' },
  { id: 's-reading', name: '読んでいる（本文が届いた最初の見開き・字は紙の遠近と反りに沿う）' },
  { id: 'more-first', name: '続きの手掛かり（見開き 2 つの本の 1 つ目: 小口の頁の重なりと右下の角の反り）' },
  { id: 'more-last', name: '続きの手掛かり（同じ本の最後の見開き: 手掛かりは出ない）' },
  { id: 's-long-title', name: '長い題の本を開いた（題が二行に折れても紙の上）' },
  { id: 's-read-failed', name: '本文の失敗（本は開いたまま、頁の上に一文）' },
  { id: 's-gated-sealing', name: '禁書の封の気配（表紙が重く閉じる途中）' },
  { id: 's-gated', name: '禁書（棚へ戻り、請求票の上に「題」今は開けない）' },
  { id: 's-same-title', name: '同題解決（生成の題が目録の本として開く）' },
  { id: 's-footnotes-pending', name: '脚注の待ち（本文の終わりの下にインクの一文）' },
  { id: 's-footnotes-ready', name: '脚注の確定（線・見出し・インクの題・禁書は淡い題と「今は開けない」）' },
  { id: 's-footnotes-zero', name: '脚注 0 件（脚注なし）' },
  { id: 's-footnotes-failed', name: '脚注の失敗（見出しと頁の一文＋再試行）' },
  { id: 's-footnotes-retried', name: '脚注の再試行（待ちへ戻る）' },
  { id: '08-related', name: '関連する本へ移る（閉じた表紙の題が、いまの本の題から次の本の題へ移り変わる）' },
  { id: 's-related-brush', name: '関連する本へ移った本の待ち（開いた次の本の上を筆が走る）' },
  { id: 's-related-failed', name: '関連する本へ移れない（次の本が開き、頁に一文）' },
  { id: '09-close', name: '閉じる（蔵書票と琥珀の光）' },
  { id: '10-exit', name: '退出（灯りが手前から奥へ落ちる）' },
  { id: 's-exit-after', name: '退出の後（ロードの被覆を経たハブ）' }
];
const COMPARISONS = [
  { id: '04-shelf', prototype: '04-shelf.png', name: '本が並ぶ' },
  { id: '05-hover', prototype: '05-hover.png', name: '指を乗せる' },
  { id: '07-turn', prototype: '07-turn.png', name: '読んでいる（頁をめくる）' }
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (label, value) => console.log(`${label}: ${JSON.stringify(value)}`);
function check(name, pass, detail = {}) {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
  if (!pass) throw new Error(`check failed: ${name} ${JSON.stringify(detail)}`);
}

const teardown = [];
async function runTeardown() {
  while (teardown.length) {
    const step = teardown.pop();
    try {
      await step();
    } catch (error) {
      console.error('teardown step failed:', error);
    }
  }
}

// ── Pillow side (encoding and composition only) ───────────────────────────────────────────────────────────────
const PYTHON_TOOL = [
  'import json, sys',
  'from PIL import Image, features',
  'job = json.loads(sys.argv[1])',
  'if job["op"] == "preflight":',
  '    print(json.dumps({"webp": features.check("webp"), "webp_anim": features.check("webp_anim")}))',
  'elif job["op"] == "webp":',
  '    frames = [Image.open(f["file"]).convert("RGB") for f in job["frames"]]',
  '    for f, im in zip(job["frames"], frames):',
  '        if im.size != (job["width"], job["height"]):',
  '            raise SystemExit("frame %s is %s, expected %sx%s" % (f["file"], im.size, job["width"], job["height"]))',
  '    frames[0].save(job["out"], format="WEBP", save_all=True, append_images=frames[1:], duration=[f["duration"] for f in job["frames"]], loop=0, quality=job["quality"], method=4, lossless=False)',
  '    check = Image.open(job["out"])',
  '    total = 0',
  '    for i in range(check.n_frames):',
  '        check.seek(i)',
  '        check.load()',
  '        total += check.info["duration"]',
  '    print(json.dumps({"size": list(check.size), "mode": check.mode, "n_frames": check.n_frames, "animated": check.is_animated, "duration_ms": total}))',
  'elif job["op"] == "side":',
  '    left = Image.open(job["left"]).convert("RGB")',
  '    right = Image.open(job["right"]).convert("RGB")',
  '    if left.size != right.size:',
  '        raise SystemExit("side-by-side sizes differ: %s %s" % (left.size, right.size))',
  '    gap = job["gap"]',
  '    canvas = Image.new("RGB", (left.width * 2 + gap, left.height), (0, 0, 0))',
  '    canvas.paste(left, (0, 0))',
  '    canvas.paste(right, (left.width + gap, 0))',
  '    canvas.save(job["out"], format="PNG")',
  '    print(json.dumps({"size": list(canvas.size), "mode": canvas.mode}))',
  'elif job["op"] == "strip":',
  '    crops = [Image.open(c["file"]).convert("RGB").crop(tuple(c["box"])) for c in job["crops"]]',
  '    gap = job["gap"]',
  '    canvas = Image.new("RGB", (sum(c.width for c in crops) + gap * (len(crops) - 1), max(c.height for c in crops)), (0, 0, 0))',
  '    x = 0',
  '    for c in crops:',
  '        canvas.paste(c, (x, 0))',
  '        x += c.width + gap',
  '    canvas.save(job["out"], format="PNG")',
  '    print(json.dumps({"size": list(canvas.size), "mode": canvas.mode}))',
  'elif job["op"] == "size":',
  '    im = Image.open(job["src"])',
  '    print(json.dumps({"size": list(im.size), "mode": im.mode}))',
  'else:',
  '    raise SystemExit("unknown op " + job["op"])'
].join('\n');

async function python(job) {
  try {
    const { stdout } = await execFileAsync('python3', ['-c', PYTHON_TOOL, JSON.stringify(job)], { maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout.trim().split('\n').pop());
  } catch (error) {
    throw new Error(`python3 (${job.op}) failed: ${String(error.stderr ?? error.message).trim()}`);
  }
}

function pngSize(bytes) {
  if (bytes.readUInt32BE(12) !== 0x49484452) throw new Error('not a PNG (no IHDR)');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// ── The fixed-answer LM ─────────────────────────────────────────────────────────────────────────────────────
// The prototype launcher's fixture (capture4 was taken on it): titles within the 8-character line, and one body.
const FIXTURE_FILL_TITLES = ['観測者の夜録', '灯り番の手控え', '夜更けの暦', '塔の影の測り方', '鐘楼守りの記録', '霧の朝の星図'];
const FIXTURE_FREE_TITLES = ['題の無い写本', '砂時計職人の弟子', '星の余白', '三つの月の旅日記', '羊皮紙の匂い', '銀の栞の行方'];
// The states walk's 自由 row carries the 禁書 title, the readable catalog title and the long readable catalog title in
// place of three fixture titles.
const STATES_FREE_TITLES = ['題の無い写本', GATED_TITLE, '星の余白', SAME_TITLE, LONG_TITLE, '銀の栞の行方'];
const FIXTURE_FOOTNOTE_TITLE = '星明かりの下で綴られた往復書簡';
// The four longest titles the real LM (google/gemma-4-31b-qat) gave in library-fs09-capture's twelve waits runs: the
// related books' 生成題 (the shelf's 生成題 were 10 letters at most).
const LM_LONG_TITLES = ['喪失の記憶と時間の断絶について', '天文塔の独白と観測者の情動', '星読者の精神調律と静寂の理', '欠落した星図の補完について'];
const FIXTURE_SKELETON = '夜の観測と古い記録のあいだを行き来する、静かな覚え書き。読む者を急がせない。';
const FIXTURE_STYLE_ID = 'dry';
const FIXTURE_FRAGMENT = [
  '書架の最上段にあったその束は、表紙に何の題も記されていなかった。紐をほどくと、紙は思いのほか柔らかく、夜ごとに少しずつ書き足された跡が残っていた。',
  '最初の頁には、星の位置が小さな点で記されている。点の横には時刻と、その晩の風の向きが添えられ、ところどころに「雲」「霧」とだけ書かれた日もある。書き手は、見えなかった夜も同じように一行を残していた。',
  '十日を過ぎたあたりから、記録は星の位置だけではなくなる。書庫の灯りが消える刻限、階段の軋む音、窓の外を渡っていった鳥の数。書き手は、星を見ているあいだに耳へ届いたものを、何ひとつ取りこぼすまいとしていたように見える。',
  '二十夜目には、はじめて人の名が現れる。「今夜は灯り番が早く来た」とだけあって、その名は墨でていねいに塗り消されている。消された名の上に、書き手はもう一度、同じ星の点を打っていた。',
  '三十夜を越えると、字は次第に小さくなり、余白が増えていく。書くべきことが減ったのではなく、書かずにおくことを覚えたのだろう。空白の多い頁ほど、紙は何度も指でなぞられて薄くなっていた。',
  '四十夜目の頁には、一行だけが記されている。「今夜の星は、昨夜と同じ場所にあった」。その下に、日付の無い押し跡がひとつ残っている。',
  '最後の頁は、四十九夜目である。星の点は打たれていない。代わりに、書庫の奥の通路の見取り図が、細い線で描かれていた。通路の突き当たりには小さな印があり、その横に「ここで灯りが消える」とだけ書かれている。',
  '束を閉じると、紐の結び目がほどけかけていた。結び直そうとして、紐の端に小さな結び目がもうひとつあるのに気づく。数えると四十九あった。'
].join('\n\n');
const TITLE_LENGTH_LINE = '- どの題も8字以内にする（本の背に一行で収まる短い題。仮名や記号も1字と数える）。';
const HUB_OPENING = '新しい週をここから始めましょう。';
const HUB_SENDOFF = 'では、大書庫へ。灯りの落ちた通路の奥まで、ゆっくり見ていらっしゃい。';

// The library's own prompts (the ones a real LM answers in the waits mode), by a phrase each one carries.
const LIBRARY_PROMPTS = [
  ['selection', 'テーマに合う本を選ぶ司書'],
  ['titles', '蔵書目録を作っている'],
  ['skeleton', '書誌カタログを整えている'],
  ['style', 'これから本文を書き起こす一冊について'],
  ['footnotes', '巻末に添える「関連する本」'],
  ['fragment', '大書庫に収められた一冊の本の書き手']
];

// The real LM behind the fixed-answer one: the request goes as the product sent it (streamed or not) and the answer
// comes back as the LM sent it; the LM's own time and the length of what it wrote are recorded.
async function forwardToLm(forward, req, bodyBytes, res, entry) {
  const upstream = await fetch(`${forward.baseUrl}${req.url.replace(/^\/v1/, '')}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bodyBytes });
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
  const received = [];
  for await (const chunk of upstream.body) {
    if (entry.firstByteAt === undefined) entry.firstByteAt = Date.now();
    received.push(Buffer.from(chunk));
    res.write(chunk);
  }
  res.end();
  entry.endedAt = Date.now();
  entry.status = upstream.status;
  const text = Buffer.concat(received).toString('utf8');
  entry.chars = text.startsWith('data:') || text.includes('\ndata:')
    ? [...text.split('\n').filter((line) => line.startsWith('data:') && !line.includes('[DONE]'))].reduce((sum, line) => sum + [...(JSON.parse(line.slice(5)).choices?.[0]?.delta?.content ?? '')].length, 0)
    : [...(JSON.parse(text).choices?.[0]?.message?.content ?? '')].length;
}

// mode.selection: 'normal' | 'http500' | 'broken-json' | 'ids' (mode.selectionIds, in that order);
// mode.titles: 'main' | 'states' | 'short'; mode.readDelayMs: how long the 本文 is held; mode.footnoteTitle: the 生成題
// the footnotes name. forward: { baseUrl } sends every library prompt to that real LM (the hub's talk stays fixed).
function startFixtureLm({ gatedIds, forward = null }) {
  const mode = { selection: 'normal', titles: 'main', selectionIds: [], readDelayMs: READ_DELAY_MS, footnoteTitle: FIXTURE_FOOTNOTE_TITLE };
  const kinds = [];
  const forwarded = [];
  let titleCall = 0;
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyBytes = Buffer.concat(chunks);
    const body = JSON.parse(bodyBytes.toString('utf8'));
    const prompt = body.messages.map((message) => message.content).join('\n');
    const schema = body.response_format?.json_schema?.name ?? '';
    const library = LIBRARY_PROMPTS.find(([, phrase]) => prompt.includes(phrase))?.[0] ?? null;
    if (forward && library) {
      const entry = { kind: library, startedAt: Date.now() };
      forwarded.push(entry);
      kinds.push(`real:${library}`);
      try {
        await forwardToLm(forward, req, bodyBytes, res, entry);
      } catch (error) {
        entry.error = String(error.message);
        kinds.push(`error:real ${library}: ${error.message}`);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error.message) }));
      }
      return;
    }
    let kind;
    let content;
    try {
      if (prompt.includes('テーマに合う本を選ぶ司書')) {
        kind = `selection:${mode.selection}`;
        titleCall = 0;
        if (mode.selection === 'ids') {
          const candidateIds = new Set([...prompt.matchAll(/^- (\S+) ／/gm)].map((match) => match[1]));
          const missing = mode.selectionIds.filter((id) => !candidateIds.has(id));
          if (missing.length) throw new Error(`fixture lm: the selection candidates lack ${missing.join(', ')}`);
          content = JSON.stringify({ book_ids: mode.selectionIds });
        } else if (mode.selection === 'http500') {
          kinds.push(kind);
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'fixture lm: model failed (HTTP 500)' }));
          return;
        } else if (mode.selection === 'broken-json') {
          content = '{"book_ids": ["';
        } else {
          // Never a catalog book whose title a fixture row names: the shelf keeps each title once (the catalog book
          // wins), and the states walk needs its 生成題 that name catalog books on the shelf as 生成題.
          const rowTitles = new Set([...FIXTURE_FILL_TITLES, ...FIXTURE_FREE_TITLES, ...STATES_FREE_TITLES]);
          const candidates = [...prompt.matchAll(/^- (\S+) ／ (.+?) ／/gm)].filter((match) => !rowTitles.has(match[2])).map((match) => match[1]);
          const pick = (prefix, count) => candidates.filter((id) => id.startsWith(prefix)).slice(0, count);
          content = JSON.stringify({ book_ids: [...pick('core_', 1), ...pick('periphery_', 2)] });
        }
      } else if (prompt.includes('蔵書目録を作っている')) {
        kind = `titles:${mode.titles}`;
        if (!prompt.includes(TITLE_LENGTH_LINE)) throw new Error('fixture lm: the titles prompt lacks the 8-character line');
        const match = /タイトルを(\d+)つ/.exec(prompt);
        if (!match) throw new Error('fixture lm: title prompt without a count');
        const count = Number(match[1]);
        titleCall += 1;
        // One search asks for titles twice: the 補充 row first, then the 自由 row.
        const pool = titleCall === 1 ? FIXTURE_FILL_TITLES : (mode.titles === 'states' ? STATES_FREE_TITLES : FIXTURE_FREE_TITLES);
        if (count > pool.length) throw new Error(`fixture lm: asked for ${count} titles, the pool has ${pool.length}`);
        content = pool.slice(0, mode.titles === 'short' ? 1 : count).join('\n');
      } else if (prompt.includes('書誌カタログを整えている')) {
        kind = 'skeleton';
        content = FIXTURE_SKELETON;
      } else if (prompt.includes('これから本文を書き起こす一冊について')) {
        kind = 'style';
        content = JSON.stringify({ style_id: FIXTURE_STYLE_ID });
      } else if (prompt.includes('巻末に添える「関連する本」')) {
        kind = 'footnotes';
        const selfTitle = /書名『(.+?)』/.exec(prompt)?.[1];
        if (!selfTitle) throw new Error('fixture lm: footnote prompt without a subject title');
        const candidates = [...prompt.matchAll(/^- (\S+) ／ (.+?) ／ (.+?) ／ (\S+)$/gm)].map((match) => ({ id: match[1], title: match[2] }));
        const usable = candidates.filter((candidate) => candidate.title !== selfTitle && candidate.title !== FIXTURE_FOOTNOTE_TITLE);
        const readableRef = usable.find((candidate) => !gatedIds.has(candidate.id));
        const gatedRef = usable.find((candidate) => gatedIds.has(candidate.id));
        if (!readableRef || !gatedRef) throw new Error('fixture lm: the footnote candidates lack a readable or a gated catalog book');
        const references = selfTitle === mode.footnoteTitle ? [] : [{ generated_title: mode.footnoteTitle }];
        references.push({ book_id: readableRef.id }, { book_id: gatedRef.id });
        content = JSON.stringify({ references });
      } else if (prompt.includes('大書庫に収められた一冊の本の書き手')) {
        kind = 'fragment';
        await sleep(mode.readDelayMs);
        content = FIXTURE_FRAGMENT;
      } else if (schema === 'character_emotion_choice') {
        kind = 'hub:emotion';
        content = JSON.stringify({ expression: 'joy' });
      } else if (schema === 'work_record_recall_choice') {
        kind = 'hub:recall';
        content = JSON.stringify({ work_record_ids: [] });
      } else if (prompt.includes('好感度の変化量を判定する')) {
        kind = 'hub:affinity';
        content = '0';
      } else if (prompt.includes('MP温存ライン')) {
        kind = 'hub:mp';
        content = '30';
      } else if (prompt.includes('所持金判定')) {
        kind = 'hub:money';
        content = '0';
      } else if (prompt.includes('この発言を行ったプレイヤーとの会話を継続したいと思うか')) {
        kind = 'hub:continue';
        content = 'true';
      } else if (prompt.includes('ルーティングハブ会話内容') && prompt.includes('destination_id')) {
        kind = 'hub:destination';
        content = 'library';
      } else if (prompt.includes('行き先が確定したプレイヤーを送り出す')) {
        kind = 'hub:sendoff';
        content = HUB_SENDOFF;
      } else if (prompt.includes('次の会話セッションだけを根拠に')) {
        kind = 'hub:record';
        content = '大書庫へ本を探しに行った。';
      } else if (prompt.includes('ルーティングハブに所属する')) {
        kind = 'hub:utterance';
        content = HUB_OPENING;
      } else {
        throw new Error(`fixture lm: unknown prompt kind: ${prompt.slice(0, 80)}`);
      }
    } catch (error) {
      kinds.push(`error:${error.message}`);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error.message) }));
      return;
    }
    kinds.push(kind);
    if (body.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  return new Promise((resolve) => {
    let stopped = null;
    const stop = () => {
      if (!stopped) {
        stopped = new Promise((done) => server.close(done));
        server.closeAllConnections();
      }
      return stopped;
    };
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, mode, kinds, forwarded, stop }));
  });
}

// ── The front relay (search delay, one armed fault, one armed hold) ─────────────────────────────────────────
// The answers of the search and the footnotes are kept (parsed) on their entries: the waits mode picks its books there.
const KEPT_ANSWERS = new Set(['/api/library/search', '/api/library/footnotes']);
function startFront(productBase, { searchDelayMs }) {
  let fault = null;
  let hold = null;
  const seen = [];
  const relay = { searchDelayMs };
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const entry = { method: req.method, pathname: url.pathname, startedAt: Date.now() };
    seen.push(entry);
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (req.method === 'POST' && url.pathname === '/api/library/search') await sleep(relay.searchDelayMs);
      if (hold && hold.method === req.method && hold.pathname === url.pathname) {
        const held = hold;
        hold = null;
        entry.heldMs = held.ms;
        await sleep(held.ms);
      }
      if (fault && fault.method === req.method && fault.pathname === url.pathname) {
        const armed = fault;
        fault = null;
        entry.status = armed.status;
        entry.fault = true;
        entry.endedAt = Date.now();
        res.writeHead(armed.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'capture relay: this one request was failed on purpose', error_code: armed.errorCode }));
        return;
      }
      const headers = { ...req.headers };
      delete headers.host;
      delete headers['content-length'];
      const upstream = await fetch(`${productBase}${req.url}`, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks)
      });
      const buffer = Buffer.from(await upstream.arrayBuffer());
      const outHeaders = {};
      for (const [key, value] of upstream.headers) {
        if (key === 'content-encoding' || key === 'content-length' || key === 'transfer-encoding') continue;
        outHeaders[key] = value;
      }
      entry.status = upstream.status;
      if (upstream.status === 200 && KEPT_ANSWERS.has(url.pathname)) entry.json = JSON.parse(buffer.toString('utf8'));
      if (upstream.status >= 400) entry.errorCode = (() => { try { return JSON.parse(buffer.toString('utf8')).error_code ?? null; } catch { return null; } })();
      entry.endedAt = Date.now();
      res.writeHead(upstream.status, outHeaders);
      res.end(buffer);
    } catch (error) {
      console.error(error);
      entry.status = 502;
      entry.endedAt = Date.now();
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error.message) }));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      base: `http://127.0.0.1:${server.address().port}`,
      seen,
      relay,
      armFault(method, pathname, status, errorCode) { fault = { method, pathname, status, errorCode }; },
      armHold(method, pathname, ms) { hold = { method, pathname, ms }; },
      last(method, pathname) { return [...seen].reverse().find((entry) => entry.method === method && entry.pathname === pathname) ?? null; },
      count(method, pathname) { return seen.filter((entry) => entry.method === method && entry.pathname === pathname).length; }
    }));
  });
}

// ── One stage: an OS-temp root, the product server, the LM and the front ─────────────────────────────────────
// realLm: the real LM's lmstudio.json (parsed); the product is given the same config with the fixed-answer LM as its
// base_url, which sends the library prompts on to the real one.
async function startStage(repoRoot, { createServer, runtimePathsManifestFilename, gatedIds, realLm = null, searchDelayMs = SEARCH_DELAY_MS }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'library-screen-capture-'));
  const definitionsRoot = path.join(root, 'data/definitions/game_data');
  const seedsRoot = path.join(root, 'data/seeds/game_data');
  const configRoot = path.join(root, 'config');
  await fs.cp(path.join(repoRoot, 'data/definitions/game_data'), definitionsRoot, { recursive: true });
  await fs.cp(path.join(repoRoot, 'data/seeds/game_data'), seedsRoot, { recursive: true });
  // The fixed-answer walks empty one core book's 関連宣言 (the 0件 state); the real LM's walks keep the table as shipped.
  if (!realLm) {
    const referencesPath = path.join(definitionsRoot, 'library_core_references.json');
    const referencesFile = JSON.parse(await fs.readFile(referencesPath, 'utf8'));
    if (!Object.prototype.hasOwnProperty.call(referencesFile.references, SAME_TITLE_ID)) throw new Error(`the core reference table does not declare ${SAME_TITLE_ID}`);
    referencesFile.references[SAME_TITLE_ID] = [];
    await writeJson(referencesPath, referencesFile);
  }
  await writeJson(path.join(root, runtimePathsManifestFilename), {
    configRoot,
    definitionsRoot,
    seedsRoot,
    mutableRoot: path.join(root, 'data/mutable/game_data'),
    characterContentRoot: path.join(repoRoot, 'content/characters'),
    creatureContentRoot: path.join(repoRoot, 'content/creatures'),
    canonicalAssetsRoot: path.join(repoRoot, 'assets/canonical'),
    publicRoot: path.join(repoRoot, 'app/public'),
    resourceRoot: root
  });
  const lm = await startFixtureLm({ gatedIds, forward: realLm ? { baseUrl: realLm.base_url } : null });
  const lmConfigPath = path.join(configRoot, 'lmstudio.json');
  await writeJson(lmConfigPath, realLm ? { ...realLm, base_url: lm.baseUrl } : {
    provider: 'lmstudio',
    base_url: lm.baseUrl,
    chat_model: 'capture-fixture',
    reflection_model: 'capture-fixture',
    timeout_ms: 120000,
    stream: false,
    thinking_effort: null,
    mock_provider_enabled: false
  });
  const playModeSettingsPath = path.join(configRoot, 'play-mode.json');
  await writeJson(playModeSettingsPath, { mode: 'routing', routing_persona_variant: 'fallen_star' });
  const product = createServer({
    root,
    publicRoot: path.join(repoRoot, 'app/public'),
    canonicalAssetsRoot: path.join(repoRoot, 'assets/canonical'),
    playModeSettingsPath,
    conversationPopupSettingsPath: path.join(configRoot, 'conversation-popup.json'),
    audioSettingsPath: path.join(configRoot, 'audio.json'),
    lmStudioConfigPath: lmConfigPath
  });
  await new Promise((resolve) => product.listen(0, '127.0.0.1', resolve));
  const front = await startFront(`http://127.0.0.1:${product.address().port}`, { searchDelayMs });
  return {
    base: front.base,
    front,
    lm,
    // The new game's own saved parameters (the slot's, under the OS-temp root) with every magic at its maximum, so
    // that no catalog book is a 禁書 for this hero (the covers walk opens every core book).
    async raiseMagic() {
      const listed = (await fs.readdir(root, { recursive: true }))
        .filter((file) => file.endsWith(path.join('runtime', 'player_parameters.json')) && !file.startsWith(path.join('data', 'seeds')) && !file.startsWith(path.join('data', 'definitions')));
      const found = [...new Set(await Promise.all(listed.map((file) => fs.realpath(path.join(root, file)))))];
      if (found.length !== 1) throw new Error(`expected the one new game's player_parameters.json under the stage root, found ${JSON.stringify(listed)}`);
      const file = found[0];
      const parameters = JSON.parse(await fs.readFile(file, 'utf8'));
      for (const magic of Object.values(parameters.magic)) magic.value = magic.max;
      await writeJson(file, parameters);
      return path.relative(await fs.realpath(root), file);
    },
    async stop() {
      await new Promise((resolve) => front.server.close(resolve));
      await new Promise((resolve) => product.close(resolve));
      await lm.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  };
}

// ── The page under CDP ────────────────────────────────────────────────────────────────────────────────────────
async function openPage(viewport, { reduced }) {
  const win = new BrowserWindow({
    width: viewport.width,
    height: viewport.height,
    useContentSize: true,
    show: false,
    webPreferences: { backgroundThrottling: false }
  });
  // Every renderer console error with its text, where it came from, and the last still taken before it.
  const rendererErrors = [];
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 3) rendererErrors.push({ message, source: `${sourceId}:${line}`, afterStill: page.lastStill, at: Date.now() });
  });
  // CDP is only answered once a real page has loaded in the hidden window.
  await win.loadURL('about:blank');
  const cdp = win.webContents.debugger;
  cdp.attach('1.3');
  const send = (method, params = {}) => cdp.sendCommand(method, params);
  await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] });
  const js = (expr) => win.webContents.executeJavaScript(expr);
  const page = {
    win,
    viewport,
    send,
    js,
    rendererErrors,
    lastStill: null,
    async load(url) {
      await win.loadURL(url);
      const measured = await js('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, reduced: matchMedia("(prefers-reduced-motion: reduce)").matches })');
      check(`viewport ${viewport.width}x${viewport.height} dpr1 reduced=${reduced}`, measured.w === viewport.width && measured.h === viewport.height && measured.dpr === 1 && measured.reduced === reduced, measured);
    },
    async waitFor(predicate, label, { timeoutMs = 30000, intervalMs = 50 } = {}) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const ok = await js(`(() => { try { return !!(${predicate}); } catch (error) { return false; } })()`);
        if (ok) return Date.now();
        await sleep(intervalMs);
      }
      const screens = await js(`[...document.querySelectorAll('.screen.active')].map((s) => s.id).join(',')`);
      throw new Error(`timed out waiting for ${label} (active: ${screens}; renderer errors: ${JSON.stringify(rendererErrors.slice(-3))})`);
    },
    // The centre of the n-th match (or the one reading `text`); dies if something else covers that point.
    async pointOf(selector, { index = 0, text = null } = {}) {
      return js(`(() => {
        const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
        const node = ${text === null ? `nodes[${index}]` : `nodes.find((n) => (n.getAttribute('aria-label') ?? n.textContent).trim() === ${JSON.stringify(text)})`};
        if (!node) throw new Error('no node: ' + ${JSON.stringify(`${selector} ${text ?? index}`)});
        const box = node.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) throw new Error('node has no box: ' + ${JSON.stringify(selector)});
        const x = Math.round(box.x + box.width / 2);
        const y = Math.round(box.y + box.height / 2);
        const hit = document.elementFromPoint(x, y);
        if (!hit || !(hit === node || node.contains(hit) || hit.contains(node))) throw new Error('point is covered at ' + ${JSON.stringify(selector)} + ': ' + (hit ? hit.className : 'nothing'));
        return { x, y };
      })()`);
    },
    mouse: { x: 4, y: 4 },
    async moveTo(target, { steps = 1, stepMs = 0 } = {}) {
      const from = { ...page.mouse };
      for (let i = 1; i <= steps; i += 1) {
        const x = Math.round(from.x + ((target.x - from.x) * i) / steps);
        const y = Math.round(from.y + ((target.y - from.y) * i) / steps);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        if (stepMs) await sleep(stepMs);
      }
      page.mouse = { x: target.x, y: target.y };
    },
    async hover(selector, options = {}, motion = {}) {
      const point = await page.pointOf(selector, options);
      await page.moveTo(point, motion);
      return point;
    },
    async press(point) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    },
    // Press at one point, move with the button held, release at the other (a text selection by hand).
    async drag(from, to, { steps = 12, stepMs = 20 } = {}) {
      await page.moveTo(from, { steps: 6, stepMs: 20 });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
      for (let i = 1; i <= steps; i += 1) {
        const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
        const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
        if (stepMs) await sleep(stepMs);
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
      page.mouse = { x: to.x, y: to.y };
    },
    async click(selector, options = {}, motion = {}) {
      const point = await page.hover(selector, options, motion);
      await page.press(point);
      return point;
    },
    async type(text, charMs) {
      for (const character of [...text]) {
        await send('Input.insertText', { text: character });
        if (charMs) await sleep(charMs);
      }
    },
    async key(key, code, keyCode) {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    },
    async still(file) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      const bytes = Buffer.from(data, 'base64');
      const size = pngSize(bytes);
      check(`still ${path.basename(file)} is ${viewport.width}x${viewport.height}`, size.width === viewport.width && size.height === viewport.height, size);
      await fs.writeFile(file, bytes);
      page.lastStill = path.basename(file);
    },
    async close() {
      if (cdp.isAttached()) cdp.detach();
      if (!win.isDestroyed()) win.destroy();
    }
  };
  return page;
}

// Screencast frames (PNG, compositor timestamps in epoch seconds) written as they arrive; clips are cut afterwards
// from marks taken on the same epoch clock.
async function startRecorder(page, framesDir) {
  const frames = [];
  const writes = [];
  let seq = 0;
  const onMessage = (_event, method, params) => {
    if (method !== 'Page.screencastFrame') return;
    const file = path.join(framesDir, `f${String(seq).padStart(6, '0')}.png`);
    seq += 1;
    frames.push({ file, t: params.metadata.timestamp * 1000 });
    writes.push(fs.writeFile(file, Buffer.from(params.data, 'base64')));
    page.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
  };
  page.win.webContents.debugger.on('message', onMessage);
  await page.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: page.viewport.width, maxHeight: page.viewport.height });
  return {
    frames,
    async stop() {
      await page.send('Page.stopScreencast');
      page.win.webContents.debugger.removeListener('message', onMessage);
      await Promise.all(writes);
    }
  };
}

// The frame on screen at `start` opens the clip; later frames are kept at no more than one per MIN_FRAME_SPACING_MS;
// each frame lasts until the next kept one, the last until `end`, so the clip is exactly end − start long.
function cutClip(frames, start, end) {
  const sorted = frames.filter((frame) => frame.t < end).sort((a, b) => a.t - b.t);
  const opening = [...sorted].reverse().find((frame) => frame.t <= start);
  if (!opening) throw new Error(`no frame on screen at clip start ${start}`);
  const kept = [{ file: opening.file, t: start }];
  for (const frame of sorted) {
    if (frame.t <= start) continue;
    if (frame.t - kept[kept.length - 1].t < MIN_FRAME_SPACING_MS) continue;
    kept.push(frame);
  }
  return kept.map((frame, index) => ({
    file: frame.file,
    duration: Math.max(1, Math.round((index + 1 < kept.length ? kept[index + 1].t : end) - frame.t))
  }));
}

// ── Reading the screen (nothing is written) ─────────────────────────────────────────────────────────────────
const ROOT = `document.querySelector('#academy-library-screen')`;
const SCENE = `${ROOT}.dataset.scene`;
const BOOK = `${ROOT}.querySelector('.academy-library-book')`;
const ACTIVE_SCREENS = `[...document.querySelectorAll('.screen.active')].map((s) => s.id)`;
const SHELF_BOOK = '.academy-library-shelf > button.academy-library-book-item';
const ANIMATION_TIME = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector)})].flatMap((n) => n.getAnimations().map((a) => Math.round(a.currentTime)))`;
const ANIMATION_AT = (selector, atMs) => `[...document.querySelectorAll(${JSON.stringify(selector)})].some((n) => n.getAnimations().some((a) => a.playState === 'running' && a.currentTime >= ${atMs}))`;
// Two or more Latin letters in a row anywhere on the library screen (an internal English line leaking out).
const LATIN_ON_SCREEN = `(${ROOT}.innerText.match(/[A-Za-z]{2,}/) ?? [null])[0]`;
// The script-driven motion of one element: the animated properties of its running Web Animations.
const MOTION_OF = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector)})].flatMap((n) => n.getAnimations().filter((a) => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition)).map((a) => [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k).filter((key) => !['offset', 'easing', 'composite', 'computedOffset'].includes(key))))].sort().join('+')))`;

// The brush over the white spread: the book's ink and writing state, the brush's opacity, the ink lines laid.
const BRUSH_STATE = `({ ink: ${BOOK}.dataset.ink, writing: ${BOOK}.dataset.writing ?? null, brush: +getComputedStyle(${ROOT}.querySelector('.academy-library-brush')).opacity, strokes: ${ROOT}.querySelectorAll('.academy-library-sketch path').length })`;
// 続きの手掛かり: the spread shown, the book's data-more, the edges' opacity and any words in them.
const MORE_STATE = `({ spreads: +${BOOK}.dataset.spreads, spread: ${BOOK}.dataset.spread, more: ${BOOK}.dataset.more ?? null, opacity: +getComputedStyle(${ROOT}.querySelector('.academy-library-more')).opacity, words: ${ROOT}.querySelector('.academy-library-more').textContent.trim() })`;
// The page's own record of one move, on its Date.now() clock: every press (capture phase, with what was pressed),
// every /api/library/read request, and every change of the book's data-ink / data-writing / data-open and of the
// screen's data-scene. Installing it again starts a new record.
const TIMELINE_INSTALL = `(() => {
  const root = document.querySelector('#academy-library-screen');
  const book = root.querySelector('.academy-library-book');
  if (!window.__captureTimeline) {
    window.__captureTimeline = { events: [] };
    const push = (event) => window.__captureTimeline.events.push({ t: Date.now(), ...event });
    document.addEventListener('click', (event) => {
      const pressed = event.target.closest('button') ?? event.target;
      push({ kind: 'click', value: (pressed.getAttribute('aria-label') ?? pressed.textContent).trim().slice(0, 80) });
    }, true);
    const fetchImpl = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/library/read')) push({ kind: 'read', value: init && typeof init.body === 'string' ? init.body : null });
      return fetchImpl.apply(this, arguments);
    };
    new MutationObserver((records) => { for (const r of records) push({ kind: r.attributeName, value: r.target.getAttribute(r.attributeName) }); })
      .observe(book, { attributes: true, attributeFilter: ['data-ink', 'data-writing', 'data-open'] });
    new MutationObserver(() => push({ kind: 'data-scene', value: root.dataset.scene })).observe(root, { attributes: true, attributeFilter: ['data-scene'] });
  }
  window.__captureTimeline.events = [];
  return true;
})()`;
const TIMELINE_READ = `window.__captureTimeline.events`;

// One move read off the timeline, in ms from the press: the body asked for, the ink drawn back, the cover closing,
// the cover open, the brush writing (null: no brush), the page readable (data-ink ready).
function waitSteps(events) {
  const click = events.find((event) => event.kind === 'click');
  if (!click) throw new Error('timeline: no press was recorded');
  const after = (kind, value, from = click.t) => events.find((event) => event.kind === kind && (value === null || event.value === value) && event.t >= from) ?? null;
  const ms = (event) => (event ? event.t - click.t : null);
  const closed = after('data-open', 'false');
  return {
    pressedAt: click.t,
    pressed: click.value,
    readAskedMs: ms(after('read', null)),
    inkWaitingMs: ms(after('data-ink', 'waiting')),
    closedMs: ms(closed),
    openedMs: ms(after('data-open', 'true', closed ? closed.t : click.t)),
    brushMs: ms(after('data-writing', 'moving')),
    readyMs: ms(after('data-ink', 'ready'))
  };
}

// ── The ordinary play entry: title → 新しいプレイ → the hub's talk → the send-off → the library ──────────────
async function enterLibrary(page, stage, { expectArrival = true } = {}) {
  await page.load(`${stage.base}/`);
  await page.waitFor(`document.querySelector('#title-screen')?.classList.contains('active') && document.querySelector('#start-new-game')`, 'title screen');
  await page.click('#start-new-game');
  await page.waitFor(`document.querySelector('#routing-hub-screen')?.classList.contains('active') && !document.querySelector('#routing-hub-send').disabled && document.querySelector('#routing-hub-message-stream').textContent.trim().length > 0`, 'routing hub welcome', { timeoutMs: 60000 });
  await talkToLibrary(page);
  if (expectArrival) {
    await page.waitFor(`${ACTIVE_SCREENS}.join() === 'academy-library-screen' && ${ROOT}.dataset.arrived === 'true'`, 'library arrival', { timeoutMs: 60000, intervalMs: 20 });
  } else {
    await page.waitFor(`${ACTIVE_SCREENS}.join() === 'academy-library-screen'`, 'library screen', { timeoutMs: 60000, intervalMs: 20 });
  }
  const look = await page.js(`(() => {
    const topbar = document.querySelector('.topbar');
    const box = ${ROOT}.getBoundingClientRect();
    return { playMode: document.body.classList.contains('play-mode'), topbar: topbar ? getComputedStyle(topbar).display : null, screen: [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)], url: location.pathname + location.search };
  })()`);
  check('entered through play (no ?initialScreen, play-mode, the development top bar not displayed, the screen fills the window)',
    look.playMode && look.topbar === 'none' && look.url === '/' && look.screen.join() === `0,0,${page.viewport.width},${page.viewport.height}`, look);
}

// Type the line into the hub and send it. The send is a no-op while the welcome is still being revealed, so the
// press is repeated until the send actually starts (the product clears the input when it does).
async function talkToLibrary(page) {
  await page.click('#routing-hub-input');
  await page.type(HUB_INPUT, 0);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await page.click('#routing-hub-send');
    await sleep(250);
    if (await page.js(`document.querySelector('#routing-hub-input').value === ''`)) return;
    await sleep(500);
  }
  throw new Error('the hub never took the typed line');
}

async function handOver(page, theme) {
  if (theme !== null) {
    await page.click('.academy-library-slip-input', {}, { steps: 12, stepMs: 25 });
    await page.type(theme, 110);
    await sleep(300);
  }
  await page.click('.academy-library-slip-hand', {}, { steps: 8, stepMs: 25 });
  return Date.now();
}

async function bookIndex(page, title) {
  const titles = await page.js(`[...document.querySelectorAll(${JSON.stringify(SHELF_BOOK)})].map((n) => n.getAttribute('aria-label'))`);
  const index = titles.indexOf(title);
  if (index < 0) throw new Error(`no book 「${title}」 on the shelf: ${JSON.stringify(titles)}`);
  return index;
}

async function toLastSpread(page) {
  while (await page.js(`+${BOOK}.dataset.spread < +${BOOK}.dataset.spreads - 1`)) {
    await page.key('ArrowRight', 'ArrowRight', 39);
    await page.waitFor(`${SCENE} === 'reading'`, 'turned', { intervalMs: 20 });
    await sleep(750);
  }
}

async function closeBook(page) {
  await page.click('.academy-library-close', {}, { steps: 8, stepMs: 20 });
  await page.waitFor(`${SCENE} === 'shelf' && ${ROOT}.querySelector('.academy-library-reading').hidden`, 'book closed', { timeoutMs: 15000 });
  await sleep(400);
}

// ── Probes: the page's ink on the painted paper ─────────────────────────────────────────────────────────────
// The paper of each painted page in book_spread.jpg (2000×1250), read off the picture by hand for this probe: the
// top edge rising toward the gutter and dropping into it, the gutter, the near edge, the outer edge (picture px).
const PAPER_OUTLINES = {
  left: [[270, 126], [400, 115], [600, 99], [750, 80], [850, 82], [950, 99], [1010, 130], [1017, 1145], [950, 1115], [850, 1107], [700, 1110], [500, 1116], [175, 1122]],
  right: [[1015, 130], [1100, 87], [1200, 80], [1300, 84], [1400, 92], [1500, 105], [1600, 117], [1700, 125], [1757, 127], [1855, 1125], [1700, 1125], [1500, 1120], [1300, 1112], [1100, 1110], [1017, 1145]]
};
// In-page helpers: the painted picture's place on the element that paints it (its background size and position are
// percentages), a point-in-polygon test, and the letter boxes of one page.
const PAGE_PROBE_HELPERS = `
  const PAPER = ${JSON.stringify(PAPER_OUTLINES)};
  const frameOf = (painter) => {
    const cs = getComputedStyle(painter);
    const [sx, sy] = cs.backgroundSize.split(' ').map((v) => parseFloat(v) / 100);
    const [px, py] = cs.backgroundPosition.split(' ').map((v) => parseFloat(v) / 100);
    const w = painter.offsetWidth * sx;
    const h = painter.offsetHeight * sy;
    return { left: (painter.offsetWidth - w) * px, top: (painter.offsetHeight - h) * py, scaleX: w / 2000, scaleY: h / 1250 };
  };
  const inside = (poly, [x, y]) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  const glyphsOf = (pageEl) => [...pageEl.querySelectorAll('.academy-library-glyph')].filter((g) => g.textContent.trim() !== '');
`;

// The two static pages at rest: every letter's box on screen (getBoundingClientRect) taken back into the picture's
// px through the spread's own picture placement, tested against the painted paper; the letter heights on screen
// (the em box: the box height over its unprojected height, times the font size) per line, far to near.
// body: false is a spread that carries only a note line (the read failed): no running text to measure the far and
// near lines by, only that its letters lie inside the paper and are big enough.
async function probePageInk(page, { minLetterPx, label, body = true }) {
  const result = await page.js(`(() => {
    ${PAGE_PROBE_HELPERS}
    const root = document.querySelector('#academy-library-screen');
    const spread = root.querySelector('.academy-library-spread');
    const frame = frameOf(spread);
    const box = spread.getBoundingClientRect();
    const toPicture = (x, y) => [(x - box.left - frame.left) / frame.scaleX, (y - box.top - frame.top) / frame.scaleY];
    const pages = {};
    for (const side of ['left', 'right']) {
      const pageEl = root.querySelector('.academy-library-page-' + side);
      const lines = new Map();
      let outside = 0;
      let letters = 0;
      let minEm = Infinity;
      for (const glyph of glyphsOf(pageEl)) {
        const r = glyph.getBoundingClientRect();
        const em = (r.height / glyph.offsetHeight) * parseFloat(getComputedStyle(glyph).fontSize);
        letters += 1;
        minEm = Math.min(minEm, em);
        for (const [x, y] of [[r.left, r.top], [r.right, r.top], [r.right, r.bottom], [r.left, r.bottom]]) {
          if (!inside(PAPER[side], toPicture(x, y))) { outside += 1; break; }
        }
        // Body letters only (the running text: not the title block, the footnotes or a note line), one line per
        // unlifted layout row.
        if (glyph.parentElement.classList.contains('academy-library-page-ink')) {
          const row = Math.round(glyph.offsetTop - parseFloat(glyph.style.top || '0'));
          if (!lines.has(row)) lines.set(row, []);
          lines.get(row).push(em);
        }
      }
      const median = (list) => { const s = [...list].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
      const rows = [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, ems]) => median(ems));
      pages[side] = { letters, outside, minEm: letters ? +minEm.toFixed(2) : null, farBodyEm: rows.length ? +rows[0].toFixed(2) : null, nearBodyEm: rows.length ? +rows[rows.length - 1].toFixed(2) : null, bodyLines: rows.length };
    }
    const bodyEms = (key) => Object.values(pages).map((p) => p[key]).filter((v) => v !== null);
    const far = bodyEms('farBodyEm').length ? Math.min(...bodyEms('farBodyEm')) : null;
    const near = bodyEms('nearBodyEm').length ? Math.max(...bodyEms('nearBodyEm')) : null;
    const ink = getComputedStyle(root.querySelector('.academy-library-page-left .academy-library-page-ink')).transform;
    return { pages, farBodyEm: far === null ? null : +far.toFixed(2), nearBodyEm: near === null ? null : +near.toFixed(2), farToNear: far === null ? null : +(far / near).toFixed(3), minEm: Math.min(...Object.values(pages).map((p) => p.minEm).filter((v) => v !== null)), inkTransform: ink.slice(0, 9) };
  })()`);
  log(`probe page ink on the paper (${label})`, result);
  const inked = body ? result.pages.left.letters > 0 && result.pages.right.letters > 0 : result.pages.left.letters + result.pages.right.letters > 0;
  check(`page ink (${label}): every letter inside the painted paper`, inked && result.pages.left.outside === 0 && result.pages.right.outside === 0, result.pages);
  check(`page ink (${label}): laid by a projection (matrix3d)`, result.inkTransform === 'matrix3d(', { inkTransform: result.inkTransform });
  if (body) {
    check(`page ink (${label}): the farthest body line's letters ≥ ${minLetterPx}px and ≥ ${MIN_FAR_TO_NEAR} of the nearest line's, the smallest letter on the page ≥ ${minLetterPx}px`,
      result.farBodyEm >= minLetterPx && result.farToNear >= MIN_FAR_TO_NEAR && result.minEm >= minLetterPx, { farBodyEm: result.farBodyEm, nearBodyEm: result.nearBodyEm, farToNear: result.farToNear, minEm: result.minEm });
  } else {
    check(`page ink (${label}): the smallest letter on the page ≥ ${minLetterPx}px`, result.minEm >= minLetterPx, { minEm: result.minEm });
  }
  return result;
}

// The turning leaf: every letter on its two faces, taken from its unprojected place through the page's own
// transform (the computed matrix3d) and its lift into the picture px of the face's paper, tested against the painted
// paper that face shows (front: the right page's paper, back: the left page's).
async function probeTurnFaces(page, label) {
  const result = await page.js(`(() => {
    ${PAGE_PROBE_HELPERS}
    const faces = [...document.querySelectorAll('#academy-library-screen .academy-library-turn-face')];
    return faces.map((face) => {
      const side = face.classList.contains('academy-library-turn-front') ? 'right' : 'left';
      const pageEl = face.querySelector('.academy-library-page');
      const ink = pageEl.querySelector('.academy-library-page-ink');
      const frame = frameOf(pageEl.offsetParent);
      const matrix = new DOMMatrix(getComputedStyle(ink).transform);
      let outside = 0;
      const glyphs = glyphsOf(pageEl);
      for (const glyph of glyphs) {
        const x0 = glyph.offsetLeft;
        const y0 = glyph.offsetTop;
        for (const [x, y] of [[x0, y0], [x0 + glyph.offsetWidth, y0], [x0 + glyph.offsetWidth, y0 + glyph.offsetHeight], [x0, y0 + glyph.offsetHeight]]) {
          const p = matrix.transformPoint(new DOMPoint(x, y));
          const local = [p.x / p.w + pageEl.offsetLeft, p.y / p.w + pageEl.offsetTop];
          if (!inside(PAPER[side], [(local[0] - frame.left) / frame.scaleX, (local[1] - frame.top) / frame.scaleY])) { outside += 1; break; }
        }
      }
      return { face: side === 'right' ? 'front' : 'back', letters: glyphs.length, outside };
    });
  })()`);
  log(`probe the turning leaf's ink on its paper (${label})`, result);
  check(`turning leaf (${label}): both faces carry laid ink, every letter inside the painted paper`, result.length === 2 && result.some((f) => f.letters > 0) && result.every((f) => f.outside === 0), { faces: result });
  return result;
}

// Every visible letter of one page, in order, with its box on screen.
const LETTERS_OF = (pageExpr) => `[...(${pageExpr}).querySelectorAll('.academy-library-glyph')].filter((g) => g.textContent.trim() !== '').map((g) => { const r = g.getBoundingClientRect(); return [g.textContent, r.left, r.top, r.right, r.bottom]; })`;
const RESTING_PAGE = (side) => `${ROOT}.querySelector('.academy-library-spread > .academy-library-page-${side}')`;
const LEAF_PAGE = (face) => `${ROOT}.querySelector('.academy-library-turn-${face} .academy-library-page')`;
const LEAF_ANIMATION = `${ROOT}.querySelector('.academy-library-turn').getAnimations()[0]`;
const MAX_LETTER_SHIFT_PX = 1;

// The same letters in the same order, and the largest move of any letter's box edge between the two (px).
function letterShift(from, to) {
  const sameText = from.length === to.length && from.every((letter, i) => letter[0] === to[i][0]);
  let maxPx = 0;
  if (sameText) from.forEach((letter, i) => { for (let k = 1; k <= 4; k += 1) maxPx = Math.max(maxPx, Math.abs(letter[k] - to[i][k])); });
  return { letters: from.length, sameText, maxPx: +maxPx.toFixed(3) };
}

// One page turn held at its two ends: the leaf's animation is paused at its first instant (the face it takes off
// with, against the resting page it covers) and 1 ms before its end (the face it lands with), then played out; the
// resting page it lands on is read after the leaf is gone. Forward: takes off from the right page with the front face
// and lands on the left page with the back face; backward the other way round. landingStill('before' | 'after') takes
// the landing's last instant and the first one after it.
async function probeTurnInPlace(page, { direction, label, landingStill = null }) {
  const forward = direction === 'forward';
  const [offSide, offFace, onSide, onFace] = forward ? ['right', 'front', 'left', 'back'] : ['left', 'back', 'right', 'front'];
  const spreadFrom = await page.js(`${BOOK}.dataset.spread`);
  const resting = await page.js(LETTERS_OF(RESTING_PAGE(offSide)));
  if (forward) await page.key('ArrowRight', 'ArrowRight', 39);
  else await page.key('ArrowLeft', 'ArrowLeft', 37);
  await page.waitFor(`${ROOT}.querySelector('.academy-library-turn')?.getAnimations().length === 1`, 'leaf turning', { intervalMs: 5 });
  const takingOff = await page.js(`(() => { const a = ${LEAF_ANIMATION}; a.pause(); a.currentTime = 0; return ${LETTERS_OF(LEAF_PAGE(offFace))}; })()`);
  const endMs = await page.js(`(() => { const a = ${LEAF_ANIMATION}; const end = a.effect.getComputedTiming().endTime; a.currentTime = end - 1; return end; })()`);
  await sleep(250);
  if (landingStill) await landingStill('before');
  const landing = await page.js(LETTERS_OF(LEAF_PAGE(onFace)));
  await page.js(`${LEAF_ANIMATION}.play()`);
  await page.waitFor(`${SCENE} === 'reading' && !${ROOT}.querySelector('.academy-library-turn')`, 'leaf landed', { intervalMs: 10 });
  await sleep(250);
  if (landingStill) await landingStill('after');
  const landed = await page.js(LETTERS_OF(RESTING_PAGE(onSide)));
  const result = {
    direction,
    spreads: [spreadFrom, await page.js(`${BOOK}.dataset.spread`)],
    leafMs: endMs,
    takeoff: { page: offSide, face: offFace, ...letterShift(resting, takingOff) },
    landing: { page: onSide, face: onFace, ...letterShift(landing, landed) }
  };
  log(`probe the leaf at take-off and landing (${direction} ${label})`, result);
  check(`turning leaf ${direction} (${label}): at take-off and at landing the leaf's face carries the resting page's letters in the same places (same letters, every box edge within ${MAX_LETTER_SHIFT_PX}px)`,
    [result.takeoff, result.landing].every((end) => end.letters > 0 && end.sameText && end.maxPx <= MAX_LETTER_SHIFT_PX), result);
  return result;
}

// The centre of what is seen of a title: the union of its letter boxes (the letters are lifted off the title's own
// box by the paper's curve). Dies unless the point hits a letter of that title.
async function titlePoint(page, selector, index = 0) {
  return page.js(`(() => {
    const node = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
    if (!node) throw new Error('no title: ' + ${JSON.stringify(selector)});
    const rects = [...node.querySelectorAll('.academy-library-glyph')].map((g) => g.getBoundingClientRect());
    const left = Math.min(...rects.map((r) => r.left));
    const right = Math.max(...rects.map((r) => r.right));
    const middle = rects[Math.floor(rects.length / 2)];
    const x = Math.round((left + right) / 2);
    const y = Math.round(middle.top + middle.height / 2);
    const hit = document.elementFromPoint(x, y);
    if (!hit || !node.contains(hit)) throw new Error('title point is not on the title: ' + (hit ? hit.className : 'nothing'));
    return { x, y };
  })()`);
}

// Where the footnote titles can be pressed: every letter's centre and each title's centre are tested with
// elementFromPoint — a readable title's point lands on its own button, a 禁書 title's on no button at all.
async function probeFootnoteHits(page, label) {
  const result = await page.js(`[...document.querySelectorAll('#academy-library-screen .academy-library-book .academy-library-footnotes-item')].map((item) => {
    const button = item.querySelector('button');
    const glyphs = [...item.querySelectorAll('.academy-library-glyph')];
    let onTitle = 0;
    for (const glyph of glyphs) {
      const r = glyph.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (button ? hit?.closest('button') === button : (item.contains(hit) && !hit.closest('button'))) onTitle += 1;
    }
    const titleGlyphs = [...(button ?? item.querySelector('.academy-library-footnote-sealed')).querySelectorAll('.academy-library-glyph')].map((g) => g.getBoundingClientRect());
    const x = (Math.min(...titleGlyphs.map((r) => r.left)) + Math.max(...titleGlyphs.map((r) => r.right))) / 2;
    const mid = titleGlyphs[Math.floor(titleGlyphs.length / 2)];
    const y = mid.top + mid.height / 2;
    const centreHit = document.elementFromPoint(x, y);
    const box = (button ?? item).getBoundingClientRect();
    return {
      title: (button ?? item.querySelector('.academy-library-footnote-sealed')).textContent,
      readable: Boolean(button),
      letters: glyphs.length,
      lettersHittingTheirTitle: onTitle,
      centre: [Math.round(x), Math.round(y)],
      centreHitsTitle: button ? centreHit?.closest('button') === button : (item.contains(centreHit) && !centreHit.closest('button')),
      liftedOffBoxPx: Math.round(box.top + box.height / 2 - y)
    };
  })`);
  log(`probe footnote hit points (${label})`, result);
  check(`footnote titles (${label}): every letter and every title centre hits its own title (a 禁書 title hits no button)`, result.length > 0 && result.every((r) => r.centreHitsTitle && r.lettersHittingTheirTitle === r.letters), { result });
  return result;
}

// Text selection by hand: a drag across the first letters of the right page's body. The selection holds those
// letters and the page does not turn. The drag runs from a quarter into the first letter to three quarters into the
// last: the outer 1–2px of a lifted letter (a relatively offset inline) resolve the caret to the row's start.
async function probeSelection(page, label) {
  const target = await page.js(`(() => {
    const glyphs = [...document.querySelectorAll('#academy-library-screen .academy-library-page-right .academy-library-page-ink > .academy-library-glyph')];
    const a = glyphs[0].getBoundingClientRect();
    const b = glyphs[7].getBoundingClientRect();
    return { from: { x: Math.round(a.left + a.width / 4), y: Math.round(a.top + a.height / 2) }, to: { x: Math.round(b.right - b.width / 4), y: Math.round(b.top + b.height / 2) }, text: glyphs.slice(0, 8).map((g) => g.textContent).join(''), spread: document.querySelector('#academy-library-screen .academy-library-book').dataset.spread };
  })()`);
  await page.drag(target.from, target.to);
  await sleep(900);
  const after = await page.js(`({ selected: getSelection().toString(), spread: ${BOOK}.dataset.spread, scene: ${SCENE} })`);
  const result = { ...target, ...after };
  log(`probe text selection by drag (${label})`, result);
  check(`page ink (${label}): letters are selected by a drag and the page does not turn`, after.selected.replace(/\s/g, '') === target.text.replace(/\s/g, '') && after.spread === target.spread && after.scene === 'reading', result);
  // A press beside the book (on the reading overlay) lets the selection go.
  await page.moveTo({ x: page.viewport.width - 6, y: Math.round(page.viewport.height / 2) }, { steps: 6, stepMs: 20 });
  await page.press(page.mouse);
  await sleep(200);
  check(`page ink (${label}): a press beside the book lets the selection go`, await page.js(`getSelection().isCollapsed && ${BOOK}.dataset.spread === ${JSON.stringify(target.spread)}`), {});
  return result;
}

// ── Walk: the ten scenes (and the states that fall on the way) ──────────────────────────────────────────────
// recording.beforeTurn / recording.afterRelated run just before the turn scene and just after the related one (the
// 1920×1080 walk records only that stretch).
async function walkScenes(page, stage, { still, marks, probes, size, recording }) {
  const mark = (name) => { marks[name] = Date.now(); };
  const record = {};
  mark('entry');
  await enterLibrary(page, stage);
  mark('arrived');
  // 1 到着: the lamps and the dust come up over 2.6 s; the key instant is the room at rest after that.
  await sleep(2800);
  await still('01-arrival');
  record.arrival = await page.js(`({ scene: ${SCENE}, lamps: ${ROOT}.querySelectorAll('.academy-library-lamp').length, art: getComputedStyle(${ROOT}.querySelector('.academy-library-art')).transform, dust: ${ROOT}.querySelector('.academy-library-dust').dataset.running, text: ${ROOT}.innerText.replace(/\\s+/g, ' ').trim(), latin: ${LATIN_ON_SCREEN} })`);
  check('scene 1 到着: the art does not move, lamps and dust, no week and no lead prose', record.arrival.scene === 'arrival' && record.arrival.lamps > 0 && record.arrival.art === 'none' && record.arrival.dust === 'true' && !/第\d+週/.test(record.arrival.text) && record.arrival.latin === null, record.arrival);
  await sleep(1200);
  mark('arrival-end');

  // 2 問いを渡す: the slip stays; the desk light leaves it for the far end (1.8 s) while the dark rises over it.
  await page.click('.academy-library-slip-input', {}, { steps: 12, stepMs: 25 });
  mark('handing-start');
  await page.type(THEME, 110);
  await sleep(300);
  await page.click('.academy-library-slip-hand', {}, { steps: 8, stepMs: 25 });
  mark('handed');
  probes.handing = await page.js(`({ deskLight: ${MOTION_OF('.academy-library-desk-light')}, shade: ${MOTION_OF('.academy-library-slip-shade')} })`);
  await page.waitFor(ANIMATION_AT('.academy-library-desk-light', 700), 'desk light leaving', { intervalMs: 10 });
  await still('02-handing');
  await page.waitFor(`${SCENE} === 'waiting'`, 'waiting', { intervalMs: 20 });
  mark('handing-end');

  // 3 待つ: a hand-candle light roams the far aisle until the answer (14 s cycle); the key instant is that light lit.
  await page.waitFor(`+getComputedStyle(${ROOT}.querySelector('.academy-library-seeker')).opacity >= 0.9`, 'seeker lit', { intervalMs: 10, timeoutMs: SEARCH_DELAY_MS });
  await still('03-waiting');
  record.waiting = await page.js(`({ scene: ${SCENE}, seeker: getComputedStyle(${ROOT}.querySelector('.academy-library-seeker')).animationName })`);
  await page.waitFor(`${SCENE} !== 'waiting'`, 'search answer', { timeoutMs: 60000, intervalMs: 10 });
  mark('answer');
  const search = stage.front.last('POST', '/api/library/search');
  record.wait = { handToAnswerMs: marks.answer - marks.handed, requestMs: search.endedAt - search.startedAt, status: search.status, relayDelayMs: SEARCH_DELAY_MS };
  check('scene 3 待つ: the search is out for the 7.68 s relay delay, the seeker roams until the answer', record.wait.status === 200 && record.wait.handToAnswerMs >= SEARCH_DELAY_MS && record.waiting.scene === 'waiting', { ...record.wait, ...record.waiting });
  probes.shelfIn = await page.js(`${MOTION_OF(SHELF_BOOK)}.slice(0, 3)`);

  // 4 本が並ぶ
  await page.waitFor(`${SCENE} === 'shelf'`, 'shelf', { intervalMs: 20 });
  await sleep(300);
  await still('04-shelf');
  record.shelf = await page.js(`({ count: document.querySelectorAll(${JSON.stringify(SHELF_BOOK)}).length, titles: [...document.querySelectorAll(${JSON.stringify(SHELF_BOOK)})].map((n) => n.getAttribute('aria-label')), slip: ${ROOT}.querySelector('.academy-library-slip-input').value, latin: ${LATIN_ON_SCREEN} })`);
  check('scene 4 本が並ぶ: 15 books on the painted shelves, the slip blank', record.shelf.count === 15 && record.shelf.titles.includes(OPEN_TITLE) && record.shelf.slip === '' && record.shelf.latin === null, record.shelf);
  await sleep(700);
  mark('shelf-end');

  // 5 指を乗せる: drawn toward the aisle, the cover face out with the gold title.
  mark('hover-start');
  const openIndex = await bookIndex(page, OPEN_TITLE);
  await page.hover(SHELF_BOOK, { index: openIndex }, { steps: 14, stepMs: 30 });
  await sleep(1100);
  await still('05-hover');
  record.hover = await page.js(`(() => { const n = document.querySelectorAll(${JSON.stringify(SHELF_BOOK)})[${openIndex}]; return { drawn: n.dataset.drawn, reveal: Math.round(n.querySelector('.academy-library-book-reveal').getBoundingClientRect().width), coverTitle: n.querySelector('.academy-library-book-cover').textContent.replace(/\\s+/g, '') }; })()`);
  check('scene 5 指を乗せる: drawn out, the cover face shows with its title', record.hover.drawn === 'true' && record.hover.reveal > 0 && record.hover.coverTitle.includes(OPEN_TITLE.replace(/\s+/g, '')), record.hover);
  await sleep(300);
  mark('hover-end');

  // 6 本を手に取って開く: the book comes to the hand (0.6 s), the cover swings open (0.7 s), and the brush writes ink
  // lines over the white spread until the body arrives; then the lines unravel into the letters. Key instant: the cover
  // lifting.
  mark('open-start');
  // The footnotes are held by the relay so that they arrive while the last spread is open (scene 8 opens on the wait).
  stage.front.armHold('POST', '/api/library/footnotes', FOOTNOTE_HOLD_MS);
  await page.js(TIMELINE_INSTALL);
  await page.click(SHELF_BOOK, { index: openIndex });
  probes.open = { cover: [], spread: [] };
  await page.waitFor(ANIMATION_AT('.academy-library-cover-leaf', 40), 'cover opening', { intervalMs: 10 });
  probes.open.cover = await page.js(MOTION_OF('.academy-library-cover-leaf'));
  await still('06-open');
  await page.waitFor(`${SCENE} === 'reading' && ${BOOK}.dataset.open === 'true' && ${BOOK}.dataset.writing === 'moving'`, 'brush on the white spread', { intervalMs: 20 });
  await sleep(1200);
  await still('s-open-wait');
  record.openWait = await page.js(BRUSH_STATE);
  check('state 本文の待ち: the cover is open on a white spread and the brush writes ink lines on it', record.openWait.ink === 'waiting' && record.openWait.writing === 'moving' && record.openWait.brush === 1 && record.openWait.strokes > 0, record.openWait);
  await page.waitFor(`${BOOK}.dataset.ink === 'ready'`, 'ink', { timeoutMs: 60000, intervalMs: 20 });
  await sleep(1400);
  await still('s-reading');
  record.reading = await page.js(`({ title: ${ROOT}.querySelector('.academy-library-page-title')?.textContent, category: ${ROOT}.querySelector('.academy-library-page-category')?.textContent, spreads: +${BOOK}.dataset.spreads, latin: ${LATIN_ON_SCREEN} })`);
  check('state 読んでいる: the first page carries the title and the layer name, more than one spread', record.reading.title === OPEN_TITLE && Boolean(record.reading.category) && record.reading.spreads >= 2 && record.reading.latin === null, record.reading);
  mark('open-end');
  record.openSteps = waitSteps(await page.js(TIMELINE_READ));
  // 続きの手掛かり: the first spread of a two-spread book, the pointer off the book.
  await page.moveTo({ x: 4, y: 4 }, { steps: 6, stepMs: 20 });
  await sleep(900);
  await still('more-first');
  record.moreFirst = await page.js(MORE_STATE);
  check('続きの手掛かり: a two-spread book shows the page edges and the lifted corner on its first spread, with no words', record.moreFirst.spreads === 2 && record.moreFirst.spread === '0' && record.moreFirst.more === 'true' && record.moreFirst.opacity === 1 && record.moreFirst.words === '', record.moreFirst);
  probes.pageInk = await probePageInk(page, { minLetterPx: size.minLetterPx, label: `${OPEN_TITLE} first spread ${size.label}` });
  probes.selection = await probeSelection(page, size.label);

  // 7 頁をめくる: the leaf turns on the spine (0.7 s); the key instant is the leaf standing up.
  await recording.beforeTurn();
  mark('turn-start');
  await sleep(400);
  await page.key('ArrowRight', 'ArrowRight', 39);
  await page.waitFor(ANIMATION_AT('.academy-library-turn', 150), 'leaf turning', { intervalMs: 10 });
  await still('07-turn');
  probes.turnFaces = await probeTurnFaces(page, size.label);
  const turning = await page.js(SCENE);
  await page.waitFor(`${SCENE} === 'reading' && ${BOOK}.dataset.spread === '1'`, 'turned');
  await sleep(700);
  mark('turn-end');
  check('scene 7 頁をめくる', turning === 'turning', { sceneAtKeyInstant: turning });
  await toLastSpread(page);

  // 8 関連する本へ移る: on the last spread the footnotes are still on their way (one ink line under the end of the
  // body); they arrive as a rule, 関連する本 and the titles in the page's ink — a readable catalog book, the 生成題 and a
  // 禁書 in pale ink with 今は開けない. The 禁書 is pressed and does not open; the 生成題 is pressed — its body is asked
  // for at once, the ink draws back, the book closes, the cover's title unravels and the next one is written, the book
  // opens and the brush writes until that body arrives. Key instant: the cover's title changing.
  await page.waitFor(`${BOOK}.dataset.footnotes === 'pending' && ${ROOT}.querySelector('.academy-library-footnotes[data-state="pending"]')`, 'footnotes still on their way on the last spread', { timeoutMs: 5000 });
  await page.waitFor(`${BOOK}.dataset.footnotes === 'ready'`, 'footnotes arrived', { timeoutMs: 60000 });
  await sleep(700);
  await still('s-footnotes-ready');
  await still('more-last');
  record.moreLast = await page.js(MORE_STATE);
  check('続きの手掛かり: not on the last spread', +record.moreLast.spread === record.moreLast.spreads - 1 && record.moreLast.more === 'false' && record.moreLast.opacity === 0, record.moreLast);
  record.footnotes = await page.js(`({
    items: [...${ROOT}.querySelectorAll('.academy-library-footnotes-item')].map((item) => ({ readable: item.dataset.readable === 'true', kind: item.querySelector('button')?.dataset.kind ?? null, text: item.textContent })),
    heading: ${ROOT}.querySelector('.academy-library-footnotes-heading')?.textContent ?? null,
    rule: Boolean(${ROOT}.querySelector('.academy-library-footnotes > .academy-library-page-rule path')),
    ribbons: ${ROOT}.querySelectorAll('[class*="ribbon"]').length,
    sealedFrame: (() => { const n = ${ROOT}.querySelector('.academy-library-footnote-sealed-note'); const cs = n && getComputedStyle(n); return cs ? [cs.borderTopWidth, cs.backgroundColor, cs.borderRadius] : null; })()
  })`);
  check('state 脚注の確定: under a rule and 関連する本, the readable titles are buttons in ink and the 禁書 is its title with 今は開けない (no button, no frame); no 栞',
    record.footnotes.heading === '関連する本' && record.footnotes.rule && record.footnotes.ribbons === 0
    && record.footnotes.items.some((i) => i.kind === 'generated') && record.footnotes.items.some((i) => i.kind === 'catalog')
    && record.footnotes.items.some((i) => !i.readable && i.kind === null && i.text.endsWith('今は開けない'))
    && record.footnotes.sealedFrame?.[0] === '0px' && record.footnotes.sealedFrame?.[1] === 'rgba(0, 0, 0, 0)', record.footnotes);
  probes.footnoteHits = await probeFootnoteHits(page, size.label);
  const readsBefore = stage.front.count('POST', '/api/library/read');
  const sealedPoint = await titlePoint(page, '.academy-library-footnote-sealed');
  await page.moveTo(sealedPoint, { steps: 12, stepMs: 30 });
  await sleep(500);
  await page.press(sealedPoint);
  await sleep(1500);
  record.sealedPress = { point: sealedPoint, reads: stage.front.count('POST', '/api/library/read') - readsBefore, ...await page.js(`({ scene: ${SCENE}, spread: ${BOOK}.dataset.spread, spreads: ${BOOK}.dataset.spreads, ink: ${BOOK}.dataset.ink, note: ${ROOT}.querySelector('.academy-library-page-note')?.textContent ?? null })`) };
  check('脚注の禁書を押しても開かない (no read request, the book stays on its last spread)', record.sealedPress.reads === 0 && record.sealedPress.scene === 'reading' && record.sealedPress.ink === 'ready' && +record.sealedPress.spread === +record.sealedPress.spreads - 1 && record.sealedPress.note === null, record.sealedPress);
  const generatedPoint = await titlePoint(page, '.academy-library-footnote-link[data-kind="generated"]');
  await page.moveTo(generatedPoint, { steps: 12, stepMs: 30 });
  await sleep(400);
  await page.js(TIMELINE_INSTALL);
  mark('related-start');
  await page.press(generatedPoint);
  // The next title half written over the next cover (its face is the second one on the leaf while the title changes).
  await page.waitFor(`(() => { const faces = ${ROOT}.querySelectorAll('.academy-library-cover-leaf > .academy-library-cover-face'); if (faces.length !== 2) return false; const glyphs = [...faces[1].querySelectorAll('.academy-library-cover-glyph')]; return glyphs.filter((g) => +getComputedStyle(g).opacity >= 0.9).length >= Math.ceil(glyphs.length / 2); })()`, 'cover title changing', { intervalMs: 5 });
  record.relatedMorph = await page.js(`({ scene: ${SCENE}, open: ${BOOK}.dataset.open })`);
  await still('08-related');
  await page.waitFor(`${SCENE} === 'reading' && ${BOOK}.dataset.writing === 'moving'`, 'brush on the related book', { timeoutMs: 20000, intervalMs: 20 });
  await sleep(1200);
  await still('s-related-brush');
  record.relatedBrush = await page.js(BRUSH_STATE);
  await page.waitFor(`${SCENE} === 'reading' && ${BOOK}.dataset.ink === 'ready' && ${ROOT}.querySelector('.academy-library-page-title')?.textContent === ${JSON.stringify(FIXTURE_FOOTNOTE_TITLE)}`, 'related book open', { timeoutMs: 60000 });
  await sleep(1200);
  record.relatedTimeline = await page.js(TIMELINE_READ);
  const steps = waitSteps(record.relatedTimeline);
  record.relatedSteps = steps;
  check('scene 8 関連する本へ移る: pressed → ink drawn back → closed → the cover\'s title changed → opened → the brush → the text, and the body asked for at the press',
    record.relatedMorph.scene === 'relating' && record.relatedMorph.open === 'false' && record.relatedBrush.writing === 'moving' && record.relatedBrush.brush === 1
    && steps.readAskedMs !== null && steps.readAskedMs < 50 && steps.inkWaitingMs <= steps.closedMs && steps.closedMs < steps.openedMs && steps.openedMs <= steps.brushMs && steps.brushMs < steps.readyMs
    && stage.front.last('POST', '/api/library/read').status === 200, { morph: record.relatedMorph, brush: record.relatedBrush, steps });
  mark('related-end');
  await recording.afterRelated();

  // 9 閉じる: the cover closes, the ex libris is pressed with an amber glow, the book goes back.
  mark('close-start');
  await page.click('.academy-library-close', {}, { steps: 10, stepMs: 25 });
  await page.waitFor(ANIMATION_AT('.academy-library-ex-libris', 200), 'ex libris pressing', { intervalMs: 5 });
  await still('09-close');
  await page.waitFor(`${SCENE} === 'shelf'`, 'closed', { timeoutMs: 15000 });
  await sleep(800);
  check('scene 9 閉じる', await page.js(`${ROOT}.querySelector('.academy-library-reading').hidden`), {});
  mark('close-end');

  // 10 退出: the lamps go out from the front to the far end (about 1.2 s), then the loading cover and the hub.
  await sleep(300);
  mark('exit-start');
  await page.click('.academy-library-exit', {}, { steps: 10, stepMs: 25 });
  await page.waitFor(`${ROOT}.querySelectorAll('.academy-library-lamp[data-out="true"]').length >= 3`, 'lamps going out', { intervalMs: 10 });
  await still('10-exit');
  await page.waitFor(`document.querySelector('#routing-hub-screen')?.classList.contains('active')`, 'back on the hub', { timeoutMs: 60000, intervalMs: 20 });
  await sleep(1500);
  mark('exit-end');
  await page.waitFor(`!document.querySelector('#routing-hub-send').disabled && document.querySelector('#routing-hub-message-stream').textContent.trim().length > 0`, 'hub settled', { timeoutMs: 60000 });
  await sleep(600);
  await still('s-exit-after');
  record.exitAfter = await page.js(`({ active: ${ACTIVE_SCREENS} })`);
  check('scene 10 退出: the loading cover, then the hub', record.exitAfter.active.includes('routing-hub-screen'), record.exitAfter);
  return record;
}

// ── Walk: the states (search failures, 本文の失敗, 禁書, 同題解決, 脚注, 関連する本の失敗, LM 未設定) ────────────
async function walkStates(page, stage, { still, landingStill, edgeProbe, catalogBooks, size }) {
  const record = {};
  const { front, lm } = stage;
  await enterLibrary(page, stage);
  await sleep(2800);

  // 空の票を渡す: nothing is requested; the slip and the desk light stay.
  const searchesBefore = front.count('POST', '/api/library/search');
  await handOver(page, null);
  await sleep(1200);
  await still('s-empty-slip');
  record.emptySlip = await page.js(`({ scene: ${SCENE}, desk: getComputedStyle(${ROOT}.querySelector('.academy-library-desk-light')).opacity, motion: ${MOTION_OF('.academy-library-desk-light')} })`);
  check('state 空の票: no request, the scene stays, the desk light does not move', front.count('POST', '/api/library/search') === searchesBefore && record.emptySlip.scene === 'arrival' && record.emptySlip.motion.length === 0, record.emptySlip);

  // The three search failures, made by the model's answers; each ends with the slip back and one ink line on it.
  const failSearch = async (label, selection, titles, file, theme) => {
    lm.mode.selection = selection;
    lm.mode.titles = titles;
    await handOver(page, theme);
    await page.waitFor(`${SCENE} === 'arrival' && !${ROOT}.querySelector('.academy-library-slip-note').hidden`, `search failed (${label})`, { timeoutMs: 60000 });
    await sleep(600);
    await still(file);
    const response = front.last('POST', '/api/library/search');
    const state = await page.js(`({ note: ${ROOT}.querySelector('.academy-library-slip-note').textContent, books: document.querySelectorAll(${JSON.stringify(SHELF_BOOK)}).length, slip: ${ROOT}.querySelector('.academy-library-slip-input').value, latin: ${LATIN_ON_SCREEN} })`);
    record[file] = { status: response.status, errorCode: response.errorCode ?? null, ...state };
    return record[file];
  };
  let failed = await failSearch('LM HTTP 500', 'http500', 'main', 's-search-failed-500-lm', THEME);
  check('state 検索の失敗 (LM の HTTP 500): 500, shelf empty, the question kept, one ink line on the slip', failed.status === 500 && failed.books === 0 && failed.slip === THEME && failed.note === '書庫は答えを連れてこられませんでした' && failed.latin === null, failed);
  failed = await failSearch('broken JSON', 'broken-json', 'main', 's-search-failed-500-json', null);
  check('state 検索の失敗 (JSON が壊れた 500): 500, shelf empty, the question kept, one ink line', failed.status === 500 && failed.books === 0 && failed.slip === THEME && failed.latin === null, failed);
  failed = await failSearch('generation 503', 'normal', 'short', 's-search-failed-503', null);
  check('state 検索の失敗 (生成の不正出力 503): 503, shelf empty, the question kept, one ink line', failed.status === 503 && failed.books === 0 && failed.slip === THEME && failed.latin === null, failed);

  // Handing the same slip again is the retry; this shelf carries the 禁書 title and the readable catalog title.
  lm.mode.selection = 'normal';
  lm.mode.titles = 'states';
  await handOver(page, null);
  await page.waitFor(`${SCENE} === 'shelf'`, 'states shelf', { timeoutMs: 60000 });
  await sleep(600);
  record.shelf = await page.js(`[...document.querySelectorAll(${JSON.stringify(SHELF_BOOK)})].map((n) => n.getAttribute('aria-label'))`);
  check('retry: handing the slip again fills the shelf', record.shelf.length === 15 && record.shelf.includes(GATED_TITLE) && record.shelf.includes(SAME_TITLE) && record.shelf.includes(LONG_TITLE), { titles: record.shelf });

  if (edgeProbe) {
    record.edge = await probeSpineTopEdge(page);
    record.titleFit = await probeCatalogTitleFit(page, catalogBooks);
  }

  // 本文の失敗: one read answered 500 by the relay; the book stays open on its white spread and one ink line is
  // written on the page. 本を閉じる takes it back to the shelf with no 蔵書票 (nothing was collected).
  front.armFault('POST', '/api/library/read', 500, 'CAPTURE_RELAY_FAULT');
  await page.click(SHELF_BOOK, { index: await bookIndex(page, OPEN_TITLE) });
  await page.waitFor(`${SCENE} === 'reading' && ${BOOK}.dataset.ink === 'ready' && ${ROOT}.querySelector('.academy-library-page-note')`, 'read failed line on the page', { timeoutMs: 20000 });
  await page.moveTo({ x: 4, y: 4 }, { steps: 6, stepMs: 20 });
  await sleep(1200);
  await still('s-read-failed');
  record.readFailed = await page.js(`({ note: ${ROOT}.querySelector('.academy-library-page-note').textContent, onPage: Boolean(${ROOT}.querySelector('.academy-library-page-left .academy-library-page-ink .academy-library-page-note')), reading: ${ROOT}.querySelector('.academy-library-reading').hidden, open: ${BOOK}.dataset.open, slipNote: ${ROOT}.querySelector('.academy-library-slip-note').hidden, latin: ${LATIN_ON_SCREEN} })`);
  check('state 本文の失敗: the book stays open, one ink line on the page (nothing beside the shelf, nothing on the slip)', record.readFailed.note === '今は写しを綴じられませんでした' && record.readFailed.onPage && record.readFailed.reading === false && record.readFailed.open === 'true' && record.readFailed.slipNote === true && record.readFailed.latin === null, record.readFailed);
  record.readFailedInk = await probePageInk(page, { minLetterPx: size.minLetterPx, label: `read failed ${size.label}`, body: false });
  await page.click('.academy-library-close', {}, { steps: 8, stepMs: 20 });
  await page.waitFor(`${SCENE} === 'shelf' && ${ROOT}.querySelector('.academy-library-reading').hidden`, 'failed book back on the shelf', { timeoutMs: 15000 });
  await sleep(400);

  // 脚注の待ち: the footnotes held 12 s by the relay while the book is read to its last spread.
  front.armHold('POST', '/api/library/footnotes', 12000);
  await page.click(SHELF_BOOK, { index: await bookIndex(page, OPEN_TITLE) });
  await page.waitFor(`${SCENE} === 'reading' && ${BOOK}.dataset.ink === 'ready'`, 'ink', { timeoutMs: 60000 });
  await sleep(900);
  await toLastSpread(page);
  await page.waitFor(`${BOOK}.dataset.footnotes === 'pending' && ${ROOT}.querySelector('.academy-library-footnotes[data-state="pending"] .academy-library-page-note')`, 'footnotes pending', { timeoutMs: 5000 });
  await sleep(500);
  await still('s-footnotes-pending');
  record.footnotesPending = await page.js(`({ text: ${ROOT}.querySelector('.academy-library-footnotes').textContent, ribbons: ${ROOT}.querySelectorAll('[class*="ribbon"]').length })`);
  check('state 脚注の待ち: one ink line in the footnotes\' place (no band)', record.footnotesPending.text === '関連する本を探しています…' && record.footnotesPending.ribbons === 0, record.footnotesPending);
  await page.waitFor(`${BOOK}.dataset.footnotes === 'ready'`, 'footnotes ready', { timeoutMs: 60000 });
  await sleep(500);

  // めくる一枚の着地: back to the first spread and forward to the last one again (the footnotes settled), each turn
  // held at its take-off and its landing; the forward landing is the one taken beside itself (07-turn-landing).
  record.turnInPlace = {
    backward: await probeTurnInPlace(page, { direction: 'backward', label: size.label }),
    forward: await probeTurnInPlace(page, { direction: 'forward', label: size.label, landingStill })
  };
  await sleep(500);

  // 関連する本へ移れない: the catalog footnote's read answered 500; the book stays open, one line on the page.
  front.armFault('POST', '/api/library/read', 500, 'CAPTURE_RELAY_FAULT');
  const catalogPoint = await titlePoint(page, '.academy-library-footnote-link[data-kind="catalog"]');
  await page.moveTo(catalogPoint, { steps: 10, stepMs: 25 });
  await page.press(catalogPoint);
  await page.waitFor(`${SCENE} === 'reading' && ${ROOT}.querySelector('.academy-library-page-note')`, 'related failed line', { timeoutMs: 20000 });
  await sleep(900);
  await still('s-related-failed');
  record.relatedFailed = await page.js(`({ title: ${ROOT}.querySelector('.academy-library-page-title')?.textContent ?? null, note: ${ROOT}.querySelector('.academy-library-page-note').textContent, open: ${BOOK}.dataset.open, latin: ${LATIN_ON_SCREEN} })`);
  check('state 関連する本へ移れない: the book stays open, one ink line on the page', record.relatedFailed.note.includes('今は写しを綴じられませんでした') && record.relatedFailed.open === 'true' && record.relatedFailed.latin === null, record.relatedFailed);
  await closeBook(page);

  // 脚注の失敗 → 再試行: the footnotes answered 503 by the relay, then 再試行 held 6 s.
  front.armFault('POST', '/api/library/footnotes', 503, 'CAPTURE_RELAY_FAULT');
  await page.click(SHELF_BOOK, { index: await bookIndex(page, OPEN_TITLE) });
  await page.waitFor(`${SCENE} === 'reading' && ${BOOK}.dataset.ink === 'ready'`, 'ink', { timeoutMs: 60000 });
  await sleep(900);
  await toLastSpread(page);
  await page.waitFor(`${BOOK}.dataset.footnotes === 'failed' && ${ROOT}.querySelector('.academy-library-footnotes[data-state="failed"]')`, 'footnotes failed', { timeoutMs: 20000 });
  await sleep(500);
  await still('s-footnotes-failed');
  record.footnotesFailed = await page.js(`({ heading: ${ROOT}.querySelector('.academy-library-footnotes-heading')?.textContent ?? null, text: ${ROOT}.querySelector('.academy-library-footnotes .academy-library-page-note').textContent, retry: ${ROOT}.querySelector('.academy-library-page-retry')?.textContent, latin: ${LATIN_ON_SCREEN} })`);
  check('state 脚注の失敗: 関連する本, one ink line and 再試行 on the page', record.footnotesFailed.heading === '関連する本' && record.footnotesFailed.text.includes('関連する本を読み込めませんでした。') && record.footnotesFailed.retry === '再試行' && record.footnotesFailed.latin === null, record.footnotesFailed);
  front.armHold('POST', '/api/library/footnotes', 6000);
  const retryPoint = await titlePoint(page, '.academy-library-page-retry');
  await page.moveTo(retryPoint, { steps: 8, stepMs: 25 });
  await page.press(retryPoint);
  await page.waitFor(`${BOOK}.dataset.footnotes === 'pending' && ${ROOT}.querySelector('.academy-library-footnotes[data-state="pending"]')`, 'footnotes pending again', { timeoutMs: 5000 });
  await sleep(500);
  await still('s-footnotes-retried');
  await page.waitFor(`${BOOK}.dataset.footnotes === 'ready'`, 'footnotes ready after retry', { timeoutMs: 60000 });
  await closeBook(page);

  // 禁書: the 生成題 that names a 禁書 is read as that book (同題解決) and refused 403; the seal shows in light and
  // motion only — the lamp over the pages draws back, the cover closes heavily, the book goes slowly back — and the
  // title with 今は開けない is written on the 請求票, where a search failure is written.
  await page.click(SHELF_BOOK, { index: await bookIndex(page, GATED_TITLE) });
  await page.waitFor(`${BOOK}.dataset.sealed === 'true' && ${ANIMATION_AT('.academy-library-cover-leaf', 1000)}`, 'sealing', { timeoutMs: 20000, intervalMs: 10 });
  await still('s-gated-sealing');
  const gatedRead = front.last('POST', '/api/library/read');
  await page.waitFor(`${SCENE} === 'shelf' && !${ROOT}.querySelector('.academy-library-slip-note').hidden`, 'gated line on the slip', { timeoutMs: 20000 });
  await page.moveTo({ x: 4, y: 4 }, { steps: 6, stepMs: 20 });
  await sleep(900);
  await still('s-gated');
  record.gated = { status: gatedRead.status, errorCode: gatedRead.errorCode ?? null, ...await page.js(`(() => {
    const note = ${ROOT}.querySelector('.academy-library-slip-note');
    const slip = ${ROOT}.querySelector('.academy-library-slip').getBoundingClientRect();
    const box = note.getBoundingClientRect();
    return { note: note.textContent, inSlip: box.left >= slip.left && box.right <= slip.right && box.top >= slip.top && box.bottom <= slip.bottom, transform: getComputedStyle(note).transform, beside: ${ROOT}.querySelectorAll('.academy-library-shelf .academy-library-note, .academy-library-shelf p').length, latin: ${LATIN_ON_SCREEN} };
  })()`) };
  check('state 禁書: the read is refused 403 LIBRARY_BOOK_GATED, back on the shelf; 「題」今は開けない in ink on the slip, inside it, without perspective', record.gated.status === 403 && record.gated.errorCode === 'LIBRARY_BOOK_GATED' && record.gated.note === `「${GATED_TITLE}」今は開けない` && record.gated.inSlip && record.gated.transform === 'none' && record.gated.beside === 0 && record.gated.latin === null, record.gated);
  // The line stays until the next thing done: taking a book off the shelf lets it go.
  await page.click(SHELF_BOOK, { index: await bookIndex(page, LONG_TITLE) });
  await page.waitFor(`${ROOT}.querySelector('.academy-library-slip-note').hidden`, 'gated line gone when a book is taken', { timeoutMs: 5000 });

  // 長い題の本: the 生成題 that names a readable catalog title too long for one line opens as that book; its title
  // breaks over two lines at the top of the first page, on the paper like the rest.
  await page.waitFor(`${SCENE} === 'reading' && ${BOOK}.dataset.ink === 'ready'`, 'long-titled book open', { timeoutMs: 60000 });
  await page.moveTo({ x: 4, y: 4 }, { steps: 6, stepMs: 20 });
  await sleep(1400);
  await still('s-long-title');
  record.longTitle = await page.js(`(() => {
    const title = ${ROOT}.querySelector('.academy-library-page-title');
    const rows = new Set([...title.querySelectorAll('.academy-library-glyph')].map((g) => Math.round(g.offsetTop - parseFloat(g.style.top || '0'))));
    return { title: title.textContent, lines: rows.size, category: ${ROOT}.querySelector('.academy-library-page-category')?.textContent };
  })()`);
  check('state 長い題: the whole title on the first page, broken over two lines', record.longTitle.title === LONG_TITLE && record.longTitle.lines >= 2, record.longTitle);
  record.longTitleInk = await probePageInk(page, { minLetterPx: size.minLetterPx, label: `long title ${size.label}` });
  await closeBook(page);

  // 同題解決: the 生成題 that names a readable catalog book opens as that book (its body and category), in the
  // shelf book's look; its 関連宣言 is the replaced empty one, so the last spread carries no 栞.
  await page.click(SHELF_BOOK, { index: await bookIndex(page, SAME_TITLE) });
  await page.waitFor(`${SCENE} === 'reading' && ${BOOK}.dataset.ink === 'ready'`, 'same-title book open', { timeoutMs: 60000 });
  await sleep(1400);
  await still('s-same-title');
  const sameRead = front.last('POST', '/api/library/read');
  record.sameTitle = { status: sameRead.status, ...await page.js(`({ title: ${ROOT}.querySelector('.academy-library-page-title')?.textContent, category: ${ROOT}.querySelector('.academy-library-page-category')?.textContent })`) };
  check('state 同題解決: the 生成題 opens as the catalog book (its category, not 生成写本)', record.sameTitle.status === 200 && record.sameTitle.title === SAME_TITLE && record.sameTitle.category !== '生成写本', record.sameTitle);
  await toLastSpread(page);
  await page.waitFor(`${BOOK}.dataset.footnotes === 'ready'`, 'footnotes settled', { timeoutMs: 30000 });
  await sleep(500);
  await still('s-footnotes-zero');
  record.footnotesZero = await page.js(`({ footnotes: ${ROOT}.querySelectorAll('.academy-library-footnotes').length, ribbons: ${ROOT}.querySelectorAll('[class*="ribbon"]').length })`);
  check('state 脚注 0 件: no footnotes at all', record.footnotesZero.footnotes === 0 && record.footnotesZero.ribbons === 0, record.footnotesZero);
  await closeBook(page);

  // LM 不通: the LM is stopped under the running server; the search routes to the settings screen.
  await lm.stop();
  await handOver(page, THEME);
  await page.waitFor(`document.querySelector('#settings-screen')?.classList.contains('active')`, 'settings screen', { timeoutMs: 60000 });
  await sleep(1200);
  await still('s-lm-unreachable');
  const unreachable = front.last('POST', '/api/library/search');
  record.lmUnreachable = { status: unreachable.status, errorCode: unreachable.errorCode ?? null, active: await page.js(ACTIVE_SCREENS) };
  check('state LM 不通: the search answers LMSTUDIO_CONNECTION_UNAVAILABLE and the settings screen is shown', record.lmUnreachable.errorCode === 'LMSTUDIO_CONNECTION_UNAVAILABLE' && record.lmUnreachable.active.includes('settings-screen'), record.lmUnreachable);
  return record;
}

// ── Walk: 到着の失敗 (the arrival GET answered 500 by the relay) ─────────────────────────────────────────────
async function walkArrivalFailed(page, stage, { still }) {
  stage.front.armFault('GET', '/api/library', 500, 'CAPTURE_RELAY_FAULT');
  await enterLibrary(page, stage, { expectArrival: false });
  await page.waitFor(`!${ROOT}.querySelector('.academy-library-slip-note').hidden`, 'arrival failed line', { timeoutMs: 20000 });
  await sleep(2800);
  await still('s-arrival-failed');
  const state = await page.js(`({ note: ${ROOT}.querySelector('.academy-library-slip-note').textContent, inert: ${ROOT}.querySelector('.academy-library-slip').inert, arrived: ${ROOT}.dataset.arrived ?? null, latin: ${LATIN_ON_SCREEN} })`);
  check('state 到着の失敗: one ink line on the slip, the slip cannot be handed', state.note === '今は書庫に入れませんでした' && state.inert === true && state.arrived === null && state.latin === null, state);
  return state;
}

// ── Walk: the covers (the closed book in the hand with its ex libris pressed) and a book with no wait ─────────
// Every core book (the new game's saved magic is raised so that none is a 禁書), one periphery book, the first
// 生成題 of each binding (leather: the core picture, cloth: the periphery picture), and the long titles the real LM
// gave (LM_LONG_TITLES) reached as related books, as the product brings a 生成題 that long to the desk. Each is
// opened, read and closed; the moment the ex libris has been pressed and the book is about to go back, every
// animation on the page is paused (a MutationObserver on the screen's data-reading, which turns 'closing' just then),
// the still is taken, and the animations play on. At 1440×900 the first core book's opening is recorded too: a book
// whose text is there when the cover has opened is read without the brush.
const COVERS_BATCH = 8;
const COVERS_SEARCH_DELAY_MS = 800;
const COVERS_READ_DELAY_MS = 1500;
const COVER_KIND = (el) => `(() => { const s = (${el}).style; const image = s.getPropertyValue('--cover').includes('cover_core') ? 'core' : 'periphery'; return s.getPropertyValue('--paper').trim() === '#ffffff' ? image : 'generated-' + (image === 'core' ? 'leather' : 'cloth'); })()`;
const HAND_FACE = `${ROOT}.querySelector('.academy-library-cover-leaf > .academy-library-cover-face')`;
const HOLD_AT_RETURN = `(() => {
  const root = document.querySelector('#academy-library-screen');
  window.__captureHeld = false;
  const observer = new MutationObserver(() => {
    if (root.dataset.reading !== 'closing') return;
    observer.disconnect();
    for (const animation of document.getAnimations()) animation.pause();
    window.__captureHeld = true;
  });
  observer.observe(root, { attributes: true, attributeFilter: ['data-reading'] });
  return true;
})()`;
const PLAY_ON = `(() => { for (const animation of document.getAnimations()) if (animation.playState === 'paused') animation.play(); return true; })()`;
// The closed cover on the desk: its kind, its title as set, the cover's box on screen, the ex libris's place and its
// opacity, and whether the drawn part of the ex libris (the ink inside ex_libris.png) meets any letter of the title.
const COVER_STATE = `(() => {
  const leaf = ${ROOT}.querySelector('.academy-library-cover-leaf');
  const face = ${HAND_FACE};
  const title = face.querySelector('.academy-library-cover-title');
  const range = document.createRange();
  range.selectNodeContents(title);
  const letters = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  const stamp = ${ROOT}.querySelector('.academy-library-ex-libris');
  const s = stamp.getBoundingClientRect();
  const ink = { left: s.left + s.width * 49 / 512, top: s.top + s.height * 32 / 512, right: s.left + s.width * 462 / 512, bottom: s.top + s.height * 478 / 512 };
  const meets = letters.some((r) => r.left < ink.right && r.right > ink.left && r.top < ink.bottom && r.bottom > ink.top);
  const box = leaf.getBoundingClientRect();
  return {
    kind: ${COVER_KIND(HAND_FACE)},
    title: title.textContent,
    scale: title.style.getPropertyValue('--cover-title-scale'),
    cover: [Math.round(box.left), Math.round(box.top), Math.round(box.right), Math.round(box.bottom)],
    exLibris: { left: stamp.style.left, top: stamp.style.top, opacity: +getComputedStyle(stamp).opacity },
    stampMeetsTitle: meets
  };
})()`;

async function walkCovers(page, stage, { still, catalog, size, recordNoWait }) {
  const { lm } = stage;
  const shots = [];
  const record = {};
  lm.mode.readDelayMs = COVERS_READ_DELAY_MS;
  await enterLibrary(page, stage);
  record.raisedMagic = await stage.raiseMagic();
  await sleep(2800);
  await page.js(TIMELINE_INSTALL);
  const shelfTitles = () => page.js(`[...document.querySelectorAll(${JSON.stringify(SHELF_BOOK)})].map((n) => n.getAttribute('aria-label'))`);
  const search = async (ids) => {
    lm.mode.selection = 'ids';
    lm.mode.selectionIds = ids;
    await handOver(page, THEME);
    await page.waitFor(`${SCENE} === 'shelf'`, 'covers shelf', { timeoutMs: 60000 });
    await sleep(500);
  };
  const openFromShelf = async (title) => {
    await page.js(TIMELINE_INSTALL);
    await page.click(SHELF_BOOK, { index: await bookIndex(page, title) });
    await page.waitFor(`${SCENE} === 'reading' && ${BOOK}.dataset.ink === 'ready'`, `「${title}」 open`, { timeoutMs: 30000, intervalMs: 20 });
    return waitSteps(await page.js(TIMELINE_READ));
  };
  // Close the open book and take its cover at the held instant.
  const shootCover = async (file, expect) => {
    await page.moveTo({ x: 4, y: 4 }, { steps: 4, stepMs: 20 });
    await page.js(HOLD_AT_RETURN);
    await page.click('.academy-library-close', {}, { steps: 6, stepMs: 20 });
    await page.waitFor('window.__captureHeld === true', 'the ex libris pressed', { timeoutMs: 15000, intervalMs: 5 });
    await page.moveTo({ x: 4, y: 4 }, { steps: 4, stepMs: 20 });
    await sleep(250);
    await still(file);
    const cover = await page.js(COVER_STATE);
    await page.js(PLAY_ON);
    await page.waitFor(`${SCENE} === 'shelf' && ${ROOT}.querySelector('.academy-library-reading').hidden`, 'book back', { timeoutMs: 15000 });
    await sleep(300);
    check(`cover ${file}${size.suffix}: 「${expect.title}」 (${expect.kind ?? cover.kind}) closed with the ex libris pressed, the stamp's ink off every letter of the title`,
      cover.title.replace(/\s+/g, '') === expect.title.replace(/\s+/g, '') && (expect.kind === undefined || cover.kind === expect.kind) && cover.exLibris.opacity === 1 && !cover.stampMeetsTitle, cover);
    shots.push({ file: `${file}${size.suffix}.png`, ...cover });
    return cover;
  };

  // Every core book, in the catalog's order, and one periphery book with the last of them.
  const core = catalog.filter((book) => book.layer === 'core');
  const periphery = catalog.find((book) => book.layer === 'periphery');
  const batches = [];
  for (let i = 0; i < core.length; i += COVERS_BATCH) batches.push(core.slice(i, i + COVERS_BATCH));
  batches[batches.length - 1] = [...batches[batches.length - 1], periphery];
  let coreIndex = 0;
  for (const [batchIndex, batch] of batches.entries()) {
    await search(batch.map((book) => book.id));
    for (const book of batch) {
      if (batchIndex === 0 && book === batch[0] && recordNoWait) {
        const steps = await recordNoWait(async () => {
          const measured = await openFromShelf(book.title);
          await sleep(1500);
          return measured;
        });
        record.noWait = { title: book.title, steps };
        check('a book with no wait (a core book: its text is there when the cover has opened) opens straight to its text, no brush', steps.brushMs === null && steps.readyMs !== null && steps.openedMs <= steps.readyMs, record.noWait);
        await still('06-open-nowait');
      } else {
        await openFromShelf(book.title);
      }
      if (book.layer === 'core') {
        coreIndex += 1;
        await shootCover(`cover-core-${String(coreIndex).padStart(2, '0')}`, { title: book.title, kind: 'core' });
      } else {
        await shootCover('cover-periphery', { title: book.title, kind: 'periphery' });
      }
    }
  }
  check(`covers: all ${core.length} core books`, coreIndex === core.length, { coreIndex });

  // The 生成題 on the last shelf: the first of each binding.
  const onShelf = new Set(batches[batches.length - 1].map((book) => book.title));
  const generated = (await shelfTitles()).filter((title) => !onShelf.has(title));
  const kindsSeen = new Set();
  for (const title of generated) {
    const kind = await page.js(COVER_KIND(`document.querySelectorAll(${JSON.stringify(SHELF_BOOK)})[${await bookIndex(page, title)}]`));
    if (kindsSeen.has(kind)) continue;
    kindsSeen.add(kind);
    await openFromShelf(title);
    await shootCover(`cover-${kind}`, { title, kind });
    if (kindsSeen.size === 2) break;
  }
  check('covers: a 生成題 of each binding', kindsSeen.has('generated-leather') && kindsSeen.has('generated-cloth'), { kinds: [...kindsSeen] });

  // The long titles the real LM gave, each reached as a related book from a 生成題 on the shelf.
  const from = generated[0];
  for (const [index, title] of LM_LONG_TITLES.entries()) {
    lm.mode.footnoteTitle = title;
    await openFromShelf(from);
    await toLastSpread(page);
    await page.waitFor(`${BOOK}.dataset.footnotes === 'ready'`, 'footnotes', { timeoutMs: 30000 });
    await sleep(400);
    const point = await titlePoint(page, '.academy-library-footnote-link[data-kind="generated"]');
    await page.moveTo(point, { steps: 8, stepMs: 20 });
    await page.press(point);
    await page.waitFor(`${SCENE} === 'reading' && ${BOOK}.dataset.ink === 'ready' && ${ROOT}.querySelector('.academy-library-page-title')?.textContent === ${JSON.stringify(title)}`, `「${title}」 open`, { timeoutMs: 30000 });
    await sleep(300);
    await shootCover(`cover-lm-long-${index + 1}`, { title });
  }
  record.shots = shots;
  return record;
}

// ── Walk: reduced motion (the shelf and the reading book, and the branch measured) ──────────────────────────
async function walkReduced(page, stage, { still }) {
  const probe = {};
  await enterLibrary(page, stage);
  await sleep(600);
  probe.arrival = await page.js(`({ motion: ${ROOT}.dataset.motion, dust: ${ROOT}.querySelector('.academy-library-dust').dataset.running, lamps: ${MOTION_OF('.academy-library-lamps')} })`);
  await handOver(page, THEME);
  probe.handing = await page.js(`({ deskLight: ${MOTION_OF('.academy-library-desk-light')}, shade: ${MOTION_OF('.academy-library-slip-shade')} })`);
  await page.waitFor(`${SCENE} === 'returning'`, 'answer', { timeoutMs: 60000, intervalMs: 10 });
  probe.shelfIn = await page.js(`${MOTION_OF(SHELF_BOOK)}.slice(0, 3)`);
  await page.waitFor(`${SCENE} === 'shelf'`, 'shelf', { timeoutMs: 20000 });
  await sleep(600);
  await still('reduced-shelf');
  const index = await bookIndex(page, OPEN_TITLE);
  await page.hover(SHELF_BOOK, { index }, { steps: 10, stepMs: 30 });
  await sleep(200);
  probe.hover = await page.js(`(() => { const n = document.querySelectorAll(${JSON.stringify(SHELF_BOOK)})[${index}]; const s = getComputedStyle(n); return { drawn: n.dataset.drawn, transitionDuration: s.transitionDuration }; })()`);
  await page.click(SHELF_BOOK, { index });
  await page.waitFor(`${SCENE} === 'reading' || ${SCENE} === 'opening'`, 'opening', { intervalMs: 5 });
  probe.open = { book: await page.js(MOTION_OF('.academy-library-book')), cover: await page.js(MOTION_OF('.academy-library-cover-leaf')), spread: await page.js(MOTION_OF('.academy-library-spread')) };
  await page.waitFor(`${BOOK}.dataset.ink === 'ready'`, 'ink', { timeoutMs: 60000 });
  await sleep(1400);
  await page.moveTo({ x: 4, y: 4 }, { steps: 4, stepMs: 20 });
  await sleep(300);
  await still('reduced-reading');
  await page.key('ArrowRight', 'ArrowRight', 39);
  await sleep(30);
  probe.turn = { leaf: await page.js(`document.querySelectorAll('.academy-library-turn').length`), pages: await page.js(MOTION_OF('.academy-library-page-left')) };
  return probe;
}

// ── Probe: a finger resting on the top edge of a spine ──────────────────────────────────────────────────────
// The pointer is moved onto the spine's own top edge (the clipped quad, read off the page), a few px inside, and
// held there; the book's drawn state is read every EDGE_SAMPLE_MS. A book that draws out and back again under a
// still finger shows as more than one change.
async function probeSpineTopEdge(page) {
  const index = await bookIndex(page, OPEN_TITLE);
  const edge = await page.js(`(() => {
    const node = document.querySelectorAll(${JSON.stringify(SHELF_BOOK)})[${index}];
    const spine = node.querySelector('.academy-library-book-spine');
    const box = spine.getBoundingClientRect();
    const corners = spine.style.clipPath.replace(/^polygon\\(|\\)$/g, '').split(',').map((p) => p.trim().split(/\\s+/).map(parseFloat)).map(([px, py]) => [box.left + (px / 100) * box.width, box.top + (py / 100) * box.height]);
    return { corners, nodeBox: node.getBoundingClientRect().toJSON() };
  })()`);
  const [tl, tr] = edge.corners;
  const results = [];
  for (const inset of EDGE_INSETS_PX) {
    await page.moveTo({ x: 4, y: 4 }, { steps: 6, stepMs: 20 });
    await page.waitFor(`document.querySelectorAll(${JSON.stringify(SHELF_BOOK)})[${index}].dataset.drawn === undefined`, 'book back in', { timeoutMs: 5000 });
    await sleep(900);
    const point = { x: Math.round((tl[0] + tr[0]) / 2), y: Math.round((tl[1] + tr[1]) / 2 + inset) };
    const hit = await page.js(`(() => { const n = document.querySelectorAll(${JSON.stringify(SHELF_BOOK)})[${index}]; const h = document.elementFromPoint(${point.x}, ${point.y}); return Boolean(h) && (h === n || n.contains(h)); })()`);
    await page.moveTo({ x: point.x, y: point.y - 30 }, { steps: 4, stepMs: 20 });
    await page.moveTo(point, { steps: 6, stepMs: 20 });
    const samples = [];
    const end = Date.now() + EDGE_REST_MS;
    while (Date.now() < end) {
      samples.push(await page.js(`document.querySelectorAll(${JSON.stringify(SHELF_BOOK)})[${index}].dataset.drawn === 'true'`));
      await sleep(EDGE_SAMPLE_MS);
    }
    let changes = 0;
    for (let i = 1; i < samples.length; i += 1) if (samples[i] !== samples[i - 1]) changes += 1;
    results.push({ insetPx: inset, point, hitsBookBeforeDrawing: hit, samples: samples.length, drawnSamples: samples.filter(Boolean).length, changes, endsDrawn: samples[samples.length - 1] });
  }
  await page.moveTo({ x: 4, y: 4 }, { steps: 6, stepMs: 20 });
  await sleep(900);
  const result = { title: OPEN_TITLE, topEdge: [tl.map(Math.round), tr.map(Math.round)], restMs: EDGE_REST_MS, sampleMs: EDGE_SAMPLE_MS, results };
  log('probe spine top edge (changes of the drawn state under a still finger)', result);
  return result;
}

// ── Probe: every catalog title on the lowest spine, at the smallest letters allowed ─────────────────────────
// The bays, the spine padding, the smallest title scale and the layers' spine-height ranges are read off the
// served libraryScreen.js (the module exports none of them); each title's one-line length is measured in the live
// shelf with the screen's own measuring class, built the way the screen builds a spine title (a subtitle after
// 「 — 」 in its own span). A book's own spine height (heightF) comes from a private hash of its id, so each title
// is counted at both ends of its layer's range: fits on every look (at the lowest heightF) and fits on no look.
async function probeCatalogTitleFit(page, catalogBooks) {
  const source = await page.js(`(async () => (await fetch('/libraryScreen.js')).text())()`);
  const baysLiteral = /const SHELF_BAYS = (\[[\s\S]*?\n\]);/.exec(source)?.[1];
  const padY = Number(/const SPINE_PAD_Y = ([\d.]+);/.exec(source)?.[1]);
  const minScale = Number(/const TITLE_MIN_SCALE = ([\d.]+);/.exec(source)?.[1]);
  const subtitleSeparator = /const SUBTITLE_SEPARATOR = '(.+?)';/.exec(source)?.[1];
  const heightMatch = /const heightF = cover === 'core' \? between\(([\d.]+), ([\d.]+)\) : between\(([\d.]+), ([\d.]+)\);/.exec(source);
  if (!baysLiteral || !(padY > 0) || !(minScale > 0) || !subtitleSeparator || !heightMatch) {
    throw new Error('title fit: libraryScreen.js no longer declares SHELF_BAYS / SPINE_PAD_Y / TITLE_MIN_SCALE / SUBTITLE_SEPARATOR / heightF in the form read here');
  }
  const bays = Function(`return ${baysLiteral}`)();
  const heightF = { core: [Number(heightMatch[1]), Number(heightMatch[2])], other: [Number(heightMatch[3]), Number(heightMatch[4])] };
  const heights = bays.map((bay, index) => ({ index, height: Math.min(bay.bottom[0] - bay.top[0], bay.bottom[1] - bay.top[1]) }));
  const lowest = heights.reduce((a, b) => (b.height < a.height ? b : a));
  const highest = heights.reduce((a, b) => (b.height > a.height ? b : a));
  const lengths = await page.js(`(() => {
    const shelf = ${ROOT}.querySelector('.academy-library-shelf');
    const artPx = ${ROOT}.querySelector('.academy-library-art').getBoundingClientRect().width;
    const measure = document.createElement('span');
    measure.className = 'academy-library-book-title-text academy-library-book-title-measure';
    shelf.append(measure);
    try {
      return ${JSON.stringify(catalogBooks.map((book) => book.title))}.map((title) => {
        const at = title.indexOf(${JSON.stringify(subtitleSeparator)});
        if (at < 0) measure.replaceChildren(document.createTextNode(title));
        else {
          const subtitle = document.createElement('span');
          subtitle.className = 'academy-library-book-subtitle';
          subtitle.textContent = '— ' + title.slice(at + ${subtitleSeparator.length});
          measure.replaceChildren(document.createTextNode(title.slice(0, at)), subtitle);
        }
        return (measure.getBoundingClientRect().height / artPx) * 100;
      });
    } finally {
      measure.remove();
    }
  })()`);
  const scaleOn = (bay, f, length) => Math.min(1, (bay.height * f - 2 * padY) / length);
  const count = (bay) => {
    const notEvery = [];
    const noLook = [];
    catalogBooks.forEach((book, i) => {
      const [low, high] = book.layer === 'core' ? heightF.core : heightF.other;
      const atLow = scaleOn(bay, low, lengths[i]);
      if (atLow < minScale) notEvery.push({ title: book.title, layer: book.layer, chars: [...book.title].length, scaleAtLowestLook: +atLow.toFixed(3), scaleAtHighestLook: +scaleOn(bay, high, lengths[i]).toFixed(3) });
      if (scaleOn(bay, high, lengths[i]) < minScale) noLook.push(book.title);
    });
    notEvery.sort((a, b) => a.scaleAtLowestLook - b.scaleAtLowestLook);
    return { bay: bay.index, height: +bay.height.toFixed(2), notOnEveryLook: notEvery.length, notOnAnyLook: noLook.length, worst: notEvery.slice(0, 8), noLookTitles: noLook };
  };
  const longest = lengths.reduce((best, length, i) => (length > best.length ? { length, title: catalogBooks[i].title } : best), { length: 0, title: null });
  const result = { books: catalogBooks.length, minScale, padY, heightF, longest: { title: longest.title, length: +longest.length.toFixed(2) }, lowestBay: count(lowest), highestBay: count(highest) };
  log('probe catalog titles on the lowest / highest bay at the smallest title scale', result);
  return result;
}

// ── Waits: press → readable on the real LM, before and after ─────────────────────────────────────────────────
// The same question every run; it names what the core books are about, so the shelf usually carries one.
const WAITS_THEME = '星降りと学院の成り立ち';
const REAL_LM_TIMEOUT_MS = 240000;
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// The one line written on the page when the book could not be read (not the footnotes' own lines).
const PAGE_LINE = `([...${ROOT}.querySelectorAll('.academy-library-page-note')].find((n) => !n.closest('.academy-library-footnotes'))?.textContent ?? null)`;

// One press measured: the timeline's steps, what the page then shows, the read's own time at the relay, how long after
// the answer reached the page the page was readable, and the real LM's calls between the press and that moment.
async function measurePress(page, stage, press, title) {
  const { front, lm } = stage;
  await page.js(TIMELINE_INSTALL);
  await press();
  await page.waitFor(`${SCENE} === 'reading' && ${BOOK}.dataset.ink === 'ready' && (${ROOT}.querySelector('.academy-library-page-title')?.textContent === ${JSON.stringify(title)} || ${PAGE_LINE} !== null)`, `「${title}」 readable`, { timeoutMs: REAL_LM_TIMEOUT_MS, intervalMs: 20 });
  const steps = waitSteps(await page.js(TIMELINE_READ));
  const readyAt = steps.pressedAt + steps.readyMs;
  const read = front.last('POST', '/api/library/read');
  const note = await page.js(PAGE_LINE);
  return {
    title,
    note,
    readStatus: read.status,
    ...steps,
    readMs: read.endedAt - read.startedAt,
    afterAnswerMs: readyAt - read.endedAt,
    lm: lm.forwarded.filter((call) => call.startedAt >= steps.pressedAt && call.startedAt <= readyAt)
      .map((call) => ({ kind: call.kind, ms: call.endedAt - call.startedAt, chars: call.chars ?? null, charsPerS: call.chars ? +(call.chars / ((call.endedAt - call.startedAt) / 1000)).toFixed(1) : null }))
  };
}

async function openAndMeasure(page, stage, title) {
  return measurePress(page, stage, () => page.click(SHELF_BOOK, { text: title }), title);
}

// From the open book's last spread: the first readable related book the pick accepts, pressed and measured.
async function relatedAndMeasure(page, stage, catalogById, accepts) {
  await toLastSpread(page);
  await page.waitFor(`${BOOK}.dataset.footnotes === 'ready' || ${BOOK}.dataset.footnotes === 'failed'`, 'footnotes (real LM)', { timeoutMs: REAL_LM_TIMEOUT_MS });
  const answer = stage.front.last('POST', '/api/library/footnotes');
  if (!answer?.json) return { missing: 'the footnotes failed' };
  const references = answer.json.references.map((reference) => ({ title: reference.title, readable: reference.readable, layer: reference.book_id === null ? 'generated' : catalogById.get(reference.book_id).layer }));
  const target = references.find((reference) => reference.readable && accepts(reference.layer));
  if (!target) return { missing: 'no such related book', references };
  await sleep(400);
  const index = await page.js(`[...document.querySelectorAll('#academy-library-screen .academy-library-footnote-link')].findIndex((n) => n.textContent === ${JSON.stringify(target.title)})`);
  if (index < 0) throw new Error(`the related book 「${target.title}」 is not a link on the page`);
  const point = await titlePoint(page, '.academy-library-footnote-link', index);
  await page.moveTo(point, { steps: 8, stepMs: 20 });
  const measured = await measurePress(page, stage, () => page.press(point), target.title);
  return { layer: target.layer, references, ...measured };
}

async function measureRun(page, stage, catalogById) {
  const run = { loadAvg: { start: os.loadavg().map((v) => +v.toFixed(2)) }, startedAt: new Date().toISOString() };
  const entered = Date.now();
  await enterLibrary(page, stage);
  run.arrivedAfterMs = Date.now() - entered;
  run.arrivedAt = Date.now();
  await sleep(2800);
  await handOver(page, WAITS_THEME);
  await page.waitFor(`${SCENE} === 'shelf' || !${ROOT}.querySelector('.academy-library-slip-note').hidden`, 'shelf (real LM)', { timeoutMs: REAL_LM_TIMEOUT_MS, intervalMs: 100 });
  const answer = stage.front.last('POST', '/api/library/search');
  run.searchMs = answer.endedAt - answer.startedAt;
  if (!answer.json) {
    run.missing = `the search failed (${answer.status} ${answer.errorCode ?? ''})`;
    return run;
  }
  const shelf = answer.json;
  run.shelf = { catalog: shelf.catalog_books.map((book) => `${book.layer}:${book.title}`), generated: shelf.generated_books.map((book) => book.title), free: shelf.free_books.map((book) => book.title) };
  await sleep(800);
  // The LM's book: the first 生成題 on the shelf. The book with no wait: the first core book on the shelf.
  const lmTitle = [...shelf.generated_books, ...shelf.free_books][0].title;
  run.lmOpen = await openAndMeasure(page, stage, lmTitle);
  run.lmRelated = await relatedAndMeasure(page, stage, catalogById, (layer) => layer !== 'core');
  await closeBook(page);
  const core = shelf.catalog_books.find((book) => book.layer === 'core');
  if (core) {
    run.nowaitOpen = await openAndMeasure(page, stage, core.title);
    run.nowaitRelated = await relatedAndMeasure(page, stage, catalogById, (layer) => layer === 'core');
    await closeBook(page);
  } else {
    run.nowaitOpen = { missing: 'no core book on the shelf' };
    run.nowaitRelated = { missing: 'no core book on the shelf' };
  }
  run.loadAvg.end = os.loadavg().map((v) => +v.toFixed(2));
  run.lmCalls = stage.lm.forwarded.map((call) => ({ kind: call.kind, ms: call.endedAt - call.startedAt, chars: call.chars ?? null, status: call.status ?? null, error: call.error ?? null }));
  return run;
}

async function measureWaits({ afterRoot, beforeRoot, lmConfig, runs }) {
  const globalTimer = setTimeout(() => { console.error(`FAILED global timeout (${runs * 12} min)`); runTeardown().finally(() => app.exit(2)); }, runs * 12 * 60 * 1000);
  teardown.push(async () => clearTimeout(globalTimer));
  await app.whenReady();
  app.on('window-all-closed', () => {});
  const realLm = JSON.parse(await fs.readFile(lmConfig, 'utf8'));
  check('the real LM config names a base_url and a chat model', typeof realLm.base_url === 'string' && realLm.base_url.length > 0 && typeof realLm.chat_model === 'string' && realLm.chat_model.length > 0, { base_url: realLm.base_url, chat_model: realLm.chat_model, stream: realLm.stream });
  const probe = await fetch(`${realLm.base_url}/models`).then((response) => response.status).catch((error) => String(error.message));
  check('the real LM answers', probe === 200, { probe });
  const sides = {};
  for (const [label, root] of [['before', beforeRoot], ['after', afterRoot]]) {
    const head = (await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
    const dirty = (await execFileAsync('git', ['-C', root, 'status', '--porcelain'])).stdout.trim();
    check(`${label} repo is clean`, dirty === '', { head, dirty });
    const { createServer } = await import(path.join(root, 'app/src/server.mjs'));
    const { runtimePathsManifestFilename } = await import(path.join(root, 'app/src/runtimePaths.mjs'));
    const catalog = JSON.parse(await fs.readFile(path.join(root, 'data/definitions/game_data/library_catalog.json'), 'utf8')).books;
    sides[label] = { root, head, createServer, runtimePathsManifestFilename, catalogById: new Map(catalog.map((book) => [book.id, book])) };
  }
  log('waits', { theme: WAITS_THEME, model: realLm.chat_model, stream: realLm.stream, before: sides.before.head, after: sides.after.head, runs });
  const results = [];
  for (let pair = 1; pair <= runs; pair += 1) {
    for (const label of ['before', 'after']) {
      const side = sides[label];
      const stage = await startStage(side.root, { createServer: side.createServer, runtimePathsManifestFilename: side.runtimePathsManifestFilename, gatedIds: new Set(), realLm, searchDelayMs: 0 });
      teardown.push(stage.stop);
      const page = await openPage(MAIN_VIEWPORT, { reduced: false });
      let run;
      try {
        run = await measureRun(page, stage, side.catalogById);
      } finally {
        await page.close();
        teardown.splice(teardown.indexOf(stage.stop), 1);
        await stage.stop();
      }
      run.pair = pair;
      run.side = label;
      run.head = side.head;
      run.rendererErrors = page.rendererErrors.map((error) => ({ message: error.message.slice(0, 160), source: error.source, beforeArrival: error.at < run.arrivedAt }));
      results.push(run);
      console.log(`WAITRUN ${JSON.stringify(run)}`);
    }
  }
  const measures = ['lmOpen', 'lmRelated', 'nowaitOpen', 'nowaitRelated'];
  const summary = {};
  for (const label of ['before', 'after']) {
    summary[label] = {};
    for (const measure of measures) {
      const taken = results.filter((run) => run.side === label && typeof run[measure]?.readyMs === 'number' && run[measure].readStatus === 200).map((run) => run[measure].readyMs);
      summary[label][measure] = { n: taken.length, medianMs: taken.length ? median(taken) : null, ms: taken };
    }
  }
  console.log(`WAITS-SUMMARY ${JSON.stringify(summary)}`);
  console.log(`DONE waits runs=${results.length}`);
}

// ── The capture ──────────────────────────────────────────────────────────────────────────────────────────────
const dims = (viewport) => `${viewport.width}×${viewport.height}`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'waits') return measureWaits(args);
  return capture(args);
}

async function capture({ repoRoot, outDir, prototypeDir }) {
  const globalTimer = setTimeout(() => { console.error('FAILED global timeout (40 min)'); runTeardown().finally(() => app.exit(2)); }, 40 * 60 * 1000);
  teardown.push(async () => clearTimeout(globalTimer));
  await app.whenReady();
  app.on('window-all-closed', () => {});

  const pillow = await python({ op: 'preflight' });
  check('python3 + Pillow can write animated WebP', pillow.webp === true && pillow.webp_anim === true, pillow);
  const head = (await execFileAsync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'])).stdout.trim();
  const dirty = (await execFileAsync('git', ['-C', repoRoot, 'status', '--porcelain'])).stdout.trim();
  check('repo is clean (the figures are stamped with HEAD)', dirty === '', { head, dirty });
  for (const comparison of COMPARISONS) {
    const size = await python({ op: 'size', src: path.join(prototypeDir, comparison.prototype) });
    check(`prototype ${comparison.prototype} is 1440x900`, size.size[0] === MAIN_VIEWPORT.width && size.size[1] === MAIN_VIEWPORT.height, size);
  }
  const existing = await fs.readdir(outDir).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
  check('out dir is empty or absent', existing.length === 0, { existing: existing.slice(0, 5) });
  await fs.mkdir(outDir, { recursive: true });

  const { createServer } = await import(path.join(repoRoot, 'app/src/server.mjs'));
  const { runtimePathsManifestFilename } = await import(path.join(repoRoot, 'app/src/runtimePaths.mjs'));
  // Which catalog books the hero cannot open at the new game's parameters (the seeds): the footnote answer names
  // one readable and one gated book from the product's own candidate list.
  const catalog = JSON.parse(await fs.readFile(path.join(repoRoot, 'data/definitions/game_data/library_catalog.json'), 'utf8')).books;
  const seedMagic = JSON.parse(await fs.readFile(path.join(repoRoot, 'data/seeds/game_data/runtime/player_parameters.json'), 'utf8')).magic;
  const gatedIds = new Set(catalog.filter((book) => book.gate && !(book.gate.kind === 'magic' && seedMagic[book.gate.key].value >= book.gate.min)).map((book) => book.id));
  const longTitleBook = catalog.find((book) => book.title === LONG_TITLE);
  check('the fixture titles name the 禁書, the readable catalog book and the long readable catalog book as the test expects',
    gatedIds.has(catalog.find((book) => book.title === GATED_TITLE)?.id) && catalog.find((book) => book.title === SAME_TITLE)?.id === SAME_TITLE_ID && !gatedIds.has(SAME_TITLE_ID)
    && Boolean(longTitleBook) && !gatedIds.has(longTitleBook.id), { gated: gatedIds.size, longTitle: longTitleBook?.id ?? null });

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'library-screen-capture-work-'));
  teardown.push(() => fs.rm(work, { recursive: true, force: true }));
  const out = (name) => path.join(outDir, name);
  const artifacts = [];
  const add = (file, scene, kind, size) => artifacts.push({ file: path.basename(file), scene, kind, size });

  const records = {};
  const probes = {};
  const rendererErrors = {};
  const walk = async (label, viewport, { reduced = false, stageOptions = {} }, body) => {
    console.log(`── walk: ${label}`);
    const stage = await startStage(repoRoot, { createServer, runtimePathsManifestFilename, gatedIds, ...stageOptions });
    teardown.push(stage.stop);
    const page = await openPage(viewport, { reduced });
    try {
      return await body(page, stage);
    } finally {
      await page.close();
      teardown.splice(teardown.indexOf(stage.stop), 1);
      await stage.stop();
      rendererErrors[label] = page.rendererErrors;
      log(`walk done (${label})`, { lmCalls: stage.lm.kinds.length, lmErrors: stage.lm.kinds.filter((kind) => kind.startsWith('error:')), rendererErrors: page.rendererErrors.length });
      for (const error of page.rendererErrors) log(`renderer console error (${label})`, error);
    }
  };

  for (const size of SIZES) {
    const still = (page) => async (name) => {
      const file = out(`${name}${size.suffix}.png`);
      await page.still(file);
    };
    // The ten scenes. All ten are recorded at 1440×900 (the recorder runs through the whole walk); at 1920×1080 the
    // recorder runs from just before the page turn to just after the related book is open.
    const whole = size.clips.length === SCENES.length;
    const marks = {};
    const sceneProbes = {};
    const framesDir = path.join(work, `frames${size.suffix}`);
    await fs.mkdir(framesDir);
    const { frames, record } = await walk(`scenes ${size.label}`, size.viewport, {}, async (page, stage) => {
      let recorder = whole ? await startRecorder(page, framesDir) : null;
      const recording = {
        async beforeTurn() {
          if (whole) return;
          recorder = await startRecorder(page, framesDir);
          await sleep(300);
        },
        async afterRelated() {
          if (whole) return;
          await recorder.stop();
        }
      };
      const walked = await walkScenes(page, stage, { still: still(page), marks, probes: sceneProbes, size, recording });
      if (whole) await recorder.stop();
      return { frames: recorder.frames, record: walked };
    });
    records[`scenes${size.suffix}`] = record;
    probes[`scenes${size.suffix}`] = sceneProbes;
    for (const scene of SCENES) add(out(`${scene.id}${size.suffix}.png`), scene.name, size.clips.includes(scene.id) ? 'screenshot（要の一瞬・webp と対）' : 'screenshot（要の一瞬）', dims(size.viewport));
    const clips = {};
    for (const scene of SCENES.filter((entry) => size.clips.includes(entry.id))) {
      const [from, to] = CLIP_RANGES[scene.id];
      const start = marks[from];
      const end = marks[to];
      if (!(start < end)) throw new Error(`clip ${scene.id}${size.suffix}: bad range ${from}=${start} ${to}=${end}`);
      const clip = cutClip(frames, start, end);
      const file = out(`${scene.id}${size.suffix}.webp`);
      const result = await python({ op: 'webp', frames: clip, out: file, width: size.viewport.width, height: size.viewport.height, quality: WEBP_QUALITY });
      check(`${path.basename(file)} ${scene.name}`, result.animated && result.size[0] === size.viewport.width && result.size[1] === size.viewport.height && result.mode !== 'P' && Math.abs(result.duration_ms - (end - start)) <= clip.length, { ...result, clipMs: Math.round(end - start) });
      clips[scene.id] = { from, to, clipMs: Math.round(end - start), frames: result.n_frames };
      add(file, scene.name, `animated WebP（${dims(size.viewport)}・動き）`, dims(size.viewport));
    }
    records[`clips${size.suffix}`] = clips;
    for (const name of ['s-open-wait', 's-reading', 'more-first', 's-footnotes-ready', 'more-last', 's-related-brush', 's-exit-after']) add(out(`${name}${size.suffix}.png`), STATES.find((state) => state.id === name).name, 'screenshot（状態）', dims(size.viewport));

    const landingFrames = { before: path.join(work, `landing-before${size.suffix}.png`), after: path.join(work, `landing-after${size.suffix}.png`) };
    records[`states${size.suffix}`] = await walk(`states ${size.label}`, size.viewport, {}, (page, stage) => walkStates(page, stage, { still: still(page), landingStill: (moment) => page.still(landingFrames[moment]), edgeProbe: whole, catalogBooks: catalog, size }));
    // The landing's last instant (left) beside the first one after it (right).
    const landingFile = out(`07-turn-landing${size.suffix}.png`);
    const landingSide = await python({ op: 'side', left: landingFrames.before, right: landingFrames.after, out: landingFile, gap: COMPARE_GAP });
    check(`${path.basename(landingFile)} side by side`, landingSide.size[0] === size.viewport.width * 2 + COMPARE_GAP && landingSide.size[1] === size.viewport.height, landingSide);
    add(landingFile, '頁をめくる（着地: 左 めくる一枚が着地する直前・右 着地の直後）', '横並び', `${landingSide.size[0]}×${landingSide.size[1]}`);
    for (const name of ['s-empty-slip', 's-search-failed-500-lm', 's-search-failed-500-json', 's-search-failed-503', 's-read-failed', 's-footnotes-pending', 's-related-failed', 's-footnotes-failed', 's-footnotes-retried', 's-gated-sealing', 's-gated', 's-long-title', 's-same-title', 's-footnotes-zero', 's-lm-unreachable']) {
      add(out(`${name}${size.suffix}.png`), STATES.find((state) => state.id === name).name, 'screenshot（状態）', dims(size.viewport));
    }
    records[`arrivalFailed${size.suffix}`] = await walk(`arrival failed ${size.label}`, size.viewport, {}, (page, stage) => walkArrivalFailed(page, stage, { still: still(page) }));
    add(out(`s-arrival-failed${size.suffix}.png`), STATES.find((state) => state.id === 's-arrival-failed').name, 'screenshot（状態）', dims(size.viewport));

    // Reduced motion: the shelf and the reading book, and the branch measured against the full-motion walk.
    const reducedProbe = await walk(`reduced ${size.label}`, size.viewport, { reduced: true }, (page, stage) => walkReduced(page, stage, { still: still(page) }));
    probes[`reduced${size.suffix}`] = reducedProbe;
    add(out(`reduced-shelf${size.suffix}.png`), '本が並んだところ（動きを減らす設定）', 'screenshot', dims(size.viewport));

    add(out(`reduced-reading${size.suffix}.png`), '読んでいるところ（動きを減らす設定）', 'screenshot', dims(size.viewport));
    const noTransform = (list) => list.every((entry) => !entry.includes('transform'));
    check(`reduced motion ${size.label}: the branch is taken on the real render (dataset, dust still, no moving light or book, fades only)`,
      reducedProbe.arrival.motion === 'reduced' && reducedProbe.arrival.dust === 'false' && reducedProbe.arrival.lamps.length === 0
      && reducedProbe.handing.deskLight.length > 0 && noTransform(reducedProbe.handing.deskLight)
      && reducedProbe.shelfIn.length > 0 && noTransform(reducedProbe.shelfIn)
      && reducedProbe.open.book.length === 0 && noTransform(reducedProbe.open.cover) && reducedProbe.turn.leaf === 0,
      { reduced: reducedProbe });

    // The covers, and (1440×900, recorded) a book with no wait opened.
    const coverFramesDir = path.join(work, `covers${size.suffix}`);
    await fs.mkdir(coverFramesDir);
    let noWaitClip = null;
    const covers = await walk(`covers ${size.label}`, size.viewport, { stageOptions: { searchDelayMs: COVERS_SEARCH_DELAY_MS } }, (page, stage) => walkCovers(page, stage, {
      still: still(page),
      catalog,
      size,
      recordNoWait: whole ? async (act) => {
        const recorder = await startRecorder(page, coverFramesDir);
        await sleep(500);
        const start = Date.now();
        const measured = await act();
        const end = Date.now();
        await recorder.stop();
        noWaitClip = { frames: recorder.frames, start, end };
        return measured;
      } : null
    }));
    records[`covers${size.suffix}`] = covers;
    for (const shot of covers.shots) add(out(shot.file), `閉じた表紙（${shot.kind}・「${shot.title}」・蔵書票を押した姿）`, 'screenshot（表紙）', dims(size.viewport));
    // The cover kinds side by side: each cut from its still, the cover and a margin around it.
    const kindOrder = ['core', 'periphery', 'generated-leather', 'generated-cloth'];
    const kindShots = kindOrder.map((kind) => covers.shots.find((shot) => shot.kind === kind));
    const margin = Math.round(size.viewport.height * 0.02);
    const kindsFile = out(`cover-kinds${size.suffix}.png`);
    const strip = await python({ op: 'strip', gap: COMPARE_GAP, out: kindsFile, crops: kindShots.map((shot) => ({ file: out(shot.file), box: [Math.max(0, shot.cover[0] - margin), Math.max(0, shot.cover[1] - margin), Math.min(size.viewport.width, shot.cover[2] + margin), Math.min(size.viewport.height, shot.cover[3] + margin)] })) });
    records[`coverKinds${size.suffix}`] = { file: path.basename(kindsFile), order: kindShots.map((shot) => ({ kind: shot.kind, title: shot.title, from: shot.file })), size: strip.size };
    add(kindsFile, `表紙の種類の一覧（左から ${kindShots.map((shot) => `${shot.kind}「${shot.title}」`).join('・')}）`, '横並び（切り出し）', `${strip.size[0]}×${strip.size[1]}`);
    if (whole) {
      add(out('06-open-nowait.png'), '待ちの無い本を開く（筆を出さずに本文）', 'screenshot（要の一瞬・webp と対）', dims(size.viewport));
      const clip = cutClip(noWaitClip.frames, noWaitClip.start, noWaitClip.end);
      const file = out('06-open-nowait.webp');
      const result = await python({ op: 'webp', frames: clip, out: file, width: size.viewport.width, height: size.viewport.height, quality: WEBP_QUALITY });
      check('06-open-nowait.webp 待ちの無い本を開く', result.animated && result.size[0] === size.viewport.width && result.size[1] === size.viewport.height && Math.abs(result.duration_ms - (noWaitClip.end - noWaitClip.start)) <= clip.length, { ...result, clipMs: noWaitClip.end - noWaitClip.start });
      records.clips['06-open-nowait'] = { clipMs: noWaitClip.end - noWaitClip.start, frames: result.n_frames };
      add(file, '待ちの無い本を開く（筆を出さずに本文）', `animated WebP（${dims(size.viewport)}・動き）`, dims(size.viewport));
    }
  }

  // Beside capture4: the prototype (left) and the product (right), the whole 1440×900 frame each.
  const comparisons = [];
  for (const comparison of COMPARISONS) {
    const file = out(`compare-${comparison.id}.png`);
    const side = await python({ op: 'side', left: path.join(prototypeDir, comparison.prototype), right: out(`${comparison.id}.png`), out: file, gap: COMPARE_GAP });
    check(`compare-${comparison.id}.png side by side`, side.size[0] === MAIN_VIEWPORT.width * 2 + COMPARE_GAP && side.size[1] === MAIN_VIEWPORT.height, side);
    comparisons.push({ file: path.basename(file), left: `capture4/${comparison.prototype}`, right: `${comparison.id}.png`, scene: comparison.name });
    add(file, `${comparison.name}（左 一段目の試作 capture4・右 製品）`, '横並び', `${side.size[0]}×${side.size[1]}`);
  }

  const listing = [];
  for (const artifact of artifacts) {
    const bytes = await fs.readFile(out(artifact.file));
    listing.push({ ...artifact, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const written = (await fs.readdir(outDir)).sort();
  const listed = listing.map((entry) => entry.file).sort();
  check('out dir holds exactly the listed artifacts', JSON.stringify(written) === JSON.stringify(listed), { written: written.length, listed: listed.length, extra: written.filter((name) => !listed.includes(name)), missing: listed.filter((name) => !written.includes(name)) });
  const stateTable = STATES.map((state) => ({ state: state.name, files: SIZES.map((size) => `${state.id}${size.suffix}.png`) }));
  const errorCount = Object.values(rendererErrors).reduce((sum, list) => sum + list.length, 0);
  await writeJson(out('manifest.json'), {
    head,
    prototypeDir,
    entry: 'title → 新しいプレイ → routing hub welcome → typed line → send-off → loading cover → #academy-library-screen',
    searchDelayMs: SEARCH_DELAY_MS,
    readDelayMs: READ_DELAY_MS,
    theme: THEME,
    openTitle: OPEN_TITLE,
    waiting: records.scenes.wait,
    clips: { '1440x900': records.clips, '1920x1080': records['clips@1920x1080'] },
    states: stateTable,
    comparisons,
    // The moves timed on the page's clock (ms from the press): the book opened from the shelf with the brush, the move
    // to a related book, and (1440×900) a book with no wait.
    moves: Object.fromEntries(SIZES.map((size) => [size.label, {
      open: records[`scenes${size.suffix}`].openSteps,
      related: records[`scenes${size.suffix}`].relatedSteps,
      noWait: records[`covers${size.suffix}`].noWait ?? null
    }])),
    more: Object.fromEntries(SIZES.map((size) => [size.label, { first: records[`scenes${size.suffix}`].moreFirst, last: records[`scenes${size.suffix}`].moreLast }])),
    covers: Object.fromEntries(SIZES.map((size) => [size.label, { kinds: records[`coverKinds${size.suffix}`], shots: records[`covers${size.suffix}`].shots }])),
    lmLongTitles: LM_LONG_TITLES,
    probes: {
      spineTopEdge: records.states.edge,
      catalogTitleFit: records.states.titleFit,
      pageInk: Object.fromEntries(SIZES.map((size) => [size.label, {
        firstSpread: probes[`scenes${size.suffix}`].pageInk,
        longTitle: records[`states${size.suffix}`].longTitleInk,
        readFailed: records[`states${size.suffix}`].readFailedInk,
        turningLeaf: probes[`scenes${size.suffix}`].turnFaces,
        turnInPlace: records[`states${size.suffix}`].turnInPlace,
        selection: probes[`scenes${size.suffix}`].selection,
        footnoteHits: probes[`scenes${size.suffix}`].footnoteHits,
        sealedFootnotePress: records[`scenes${size.suffix}`].sealedPress
      }])),
      reducedMotion: { '1440x900': probes.reduced, '1920x1080': probes['reduced@1920x1080'] },
      fullMotion: { handing: probes.scenes.handing, shelfIn: probes.scenes.shelfIn, open: probes.scenes.open }
    },
    // Every console error the renderer logged, per walk: its text, where it came from, and the last still before it.
    rendererErrors,
    records,
    artifacts: listing
  });
  for (const entry of listing) console.log(`artifact\t${entry.file}\t${entry.size}\t${entry.scene}\t${entry.kind}\t${entry.bytes}`);
  console.log(`DONE head=${head} artifacts=${listing.length} wait=${records.scenes.wait.handToAnswerMs}ms clip03=${records.clips['03-waiting'].clipMs}ms rendererErrors=${errorCount}`);
}

main()
  .then(async () => { await runTeardown(); app.exit(0); })
  .catch(async (error) => { console.error('FAILED', error); await runTeardown(); app.exit(1); });
