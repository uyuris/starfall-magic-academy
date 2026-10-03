// 収蔵庫 v2 -> v3 の明示変換（library_collection.json）。
//
// v3 で 収蔵 entry に必須 field `style_id`（閉集合の文体 id か null）が加わり、runtime の reader は v2 を
// corrupt state として落とす（互換 reader も style_id の暗黙既定も置かない）。既存 save をその v3 reader が
// 読める形へ移す手段はこの module だけで、runtime からは一切呼ばれない — 呼び出し口は
// scripts/migrate-library-collection-v3.mjs の CLI 1本きりである（自動変換の導線を作らないのは、いつ何が
// 書き換わったかを人が知らないまま save が変わる経路を持たないため）。v2 の entry は文体選定段を経ずに
// 書かれた本文なので、変換は全 entry に `style_id: null` を書く（読み手には「選定なし」として見える）。
//
// 走査は root 配下 `data/mutable` の1回のディレクトリ walk で、拾うのは `library_collection.json` という
// 名前の通常 file だけ。readdir(withFileTypes) の Dirent は lstat 相当なので symlink は directory とも
// file とも判定されず、root の外へ辿らない。
//
// 2フェーズ: (1) 全 file を読んで検査し plan を作る、(2) apply のときだけ書く。1件でも不正なら (1) で
// throw して (2) に入らないので、他の file は1バイトも変わらない。ただし (2) は全 file 一括の transaction
// では「ない」 — 途中で失敗すると、それまでに rename の済んだ file は v3 のまま残る（各 file 単位では
// atomic rename なので、中途半端な中身の file は残らない）。
//
// v2 の検証はこの module の内側に隔離する（exact 8-key・favorite は boolean）。v3 は runtime の現行
// validator をそのまま通し、変換対象ではなく unchanged と明示する — したがって2回目の apply は変更0件になる。
// version 1 以下・未知の version は fail（v1 -> v2 の経路は無い）。

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { LIBRARY_COLLECTION_VERSION, validateLibraryCollection } from './libraryCollection.mjs';

export const LIBRARY_COLLECTION_FILENAME = 'library_collection.json';
export const LIBRARY_COLLECTION_SCAN_ROOT = 'data/mutable';
export const LIBRARY_COLLECTION_MIGRATION_MODES = Object.freeze(['check', 'apply']);

// 変換前後で1文字も変えてはならない field。この8つは v2 の exact key 集合そのものでもある。
export const PRESERVED_ENTRY_FIELDS = Object.freeze([
  'entry_id', 'book_id', 'title', 'category', 'layer', 'text', 'read_week', 'favorite'
]);

const V2_VERSION = 2;

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function serializeSurface(surface) {
  return `${JSON.stringify(surface, null, 2)}\n`;
}

// 保全の証拠。値そのものは出力に載せず（本文が stdout へ漏れない）、8 field を順序どおり畳んだ digest だけを
// 出す。before と after の digest が一致することが「8 field が1つも変わっていない」ことの主張になる。
export function preservedFieldsDigest(entries) {
  const projected = entries.map((entry) => PRESERVED_ENTRY_FIELDS.map((field) => entry[field]));
  return sha256(JSON.stringify(projected));
}

// v2 surface の検証。runtime の validator は v3 しか受けないので、v2 の形はここだけが知っている。
function validateV2Surface(surface, label) {
  if (surface === null || typeof surface !== 'object' || Array.isArray(surface)) {
    throw new Error(`${label}: v2 surface must be an object`);
  }
  const surfaceKeys = Object.keys(surface).sort();
  if (surfaceKeys.length !== 2 || surfaceKeys[0] !== 'entries' || surfaceKeys[1] !== 'version') {
    throw new Error(`${label}: v2 surface keys must be exactly {entries, version}: got {${surfaceKeys.join(', ')}}`);
  }
  if (!Array.isArray(surface.entries)) throw new Error(`${label}: v2 entries must be an array`);
  const seen = new Set();
  for (const entry of surface.entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${label}: v2 entry must be an object`);
    }
    const keys = Object.keys(entry).sort();
    const expected = [...PRESERVED_ENTRY_FIELDS].sort();
    const matches = keys.length === expected.length && keys.every((key, index) => key === expected[index]);
    if (!matches) {
      throw new Error(`${label}: v2 entry keys must be exactly {${expected.join(', ')}}: got {${keys.join(', ')}}`);
    }
    if (typeof entry.entry_id !== 'string' || entry.entry_id === '') {
      throw new Error(`${label}: v2 entry entry_id must be a non-empty string`);
    }
    if (typeof entry.favorite !== 'boolean') {
      throw new Error(`${label}: v2 entry favorite must be a boolean: ${JSON.stringify(entry.favorite)}`);
    }
    if (seen.has(entry.entry_id)) throw new Error(`${label}: duplicate v2 entry_id: ${entry.entry_id}`);
    seen.add(entry.entry_id);
  }
  return surface;
}

// v2 -> v3: version を上げ、style_id:null だけを足す。8 field は object spread でそのまま運ぶ。
function upgradeV2Surface(surface) {
  return {
    version: LIBRARY_COLLECTION_VERSION,
    entries: surface.entries.map((entry) => ({ ...entry, style_id: null }))
  };
}

// data/mutable の1回の walk。symlink（Dirent が directory でも file でもない）は辿らないので root の外へ出ない。
async function collectCollectionFiles(scanRoot) {
  const found = [];
  const pending = [scanRoot];
  while (pending.length > 0) {
    const dir = pending.pop();
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) pending.push(full);
      else if (dirent.isFile() && dirent.name === LIBRARY_COLLECTION_FILENAME) found.push(full);
    }
  }
  return found.sort();
}

async function pathExists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// フェーズ1: 全 file を読んで検査し、書くべき内容まで決めた plan を返す（完全 read-only）。
// 1件でも不正ならここで throw するので、呼び手はフェーズ2に入らない。
export async function inspectLibraryCollectionFiles({ root } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new Error(`migration root must be an absolute path: ${root}`);
  }
  const scanRoot = path.join(root, LIBRARY_COLLECTION_SCAN_ROOT);
  const scanRootPresent = await pathExists(scanRoot);
  const files = scanRootPresent ? await collectCollectionFiles(scanRoot) : [];

  const plans = [];
  for (const fullPath of files) {
    const relativePath = path.relative(root, fullPath);
    const beforeText = await fs.readFile(fullPath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(beforeText);
    } catch (error) {
      throw new Error(`${relativePath}: not valid JSON: ${error.message}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${relativePath}: surface must be an object`);
    }

    let afterSurface;
    let changed;
    if (parsed.version === V2_VERSION) {
      validateV2Surface(parsed, relativePath);
      afterSurface = upgradeV2Surface(parsed);
      changed = true;
    } else if (parsed.version === LIBRARY_COLLECTION_VERSION) {
      // 既に v3。現行 validator を通して健全であることを確かめたうえで、変換対象ではないと明示する。
      validateLibraryCollection(parsed);
      afterSurface = parsed;
      changed = false;
    } else {
      throw new Error(`${relativePath}: unknown library collection version: ${JSON.stringify(parsed.version)}`);
    }
    // 変換結果は必ず現行 runtime validator を通す（v2 経路も v3 経路も同じ関門を通る）。
    validateLibraryCollection(afterSurface);

    const afterText = changed ? serializeSurface(afterSurface) : beforeText;
    const digestBefore = preservedFieldsDigest(parsed.entries);
    const digestAfter = preservedFieldsDigest(afterSurface.entries);
    plans.push({
      full_path: fullPath,
      before_text: beforeText,
      after_text: afterText,
      changed,
      report: {
        path: relativePath,
        before: { version: parsed.version, entry_count: parsed.entries.length, sha256: sha256(beforeText) },
        after: { version: afterSurface.version, entry_count: afterSurface.entries.length, sha256: sha256(afterText) },
        preserved: {
          fields_sha256_before: digestBefore,
          fields_sha256_after: digestAfter,
          entries_matched: afterSurface.entries.length,
          ok: digestBefore === digestAfter && parsed.entries.length === afterSurface.entries.length
        },
        changed
      }
    });
  }
  return { root, scan_root: LIBRARY_COLLECTION_SCAN_ROOT, scan_root_present: scanRootPresent, plans };
}

// 1 file の書き込み: 検査時に読んだ bytes と現物が一致することを確かめてから、同じ directory の一時 file へ
// 書いて rename する（storage.writeJsonAtomic と同じ流儀）。一致しなければ stale input として止める —
// 変換の最中に save が書き換わったということなので、読み直した plan で判断し直すのが正しい。
async function writePlanFile(plan) {
  const currentText = await fs.readFile(plan.full_path, 'utf8');
  if (currentText !== plan.before_text) {
    throw new Error(`${plan.report.path}: stale input — the file changed after it was inspected; re-run --mode check`);
  }
  const dir = path.dirname(plan.full_path);
  const tempPath = path.join(dir, `.${path.basename(plan.full_path)}.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(tempPath, plan.after_text, 'utf8');
  await fs.rename(tempPath, plan.full_path);
}

// フェーズ2: 検査済みの plan を書く。check では1バイトも書かず、plan をそのまま結果に写すだけ。
// フェーズ1と分けてあるのは、検査と書き込みの間に save が動いた場合の stale 判定が、この境界に立つため。
export async function applyLibraryCollectionPlans({ inspected, mode } = {}) {
  if (!LIBRARY_COLLECTION_MIGRATION_MODES.includes(mode)) {
    throw new Error(`migration mode must be one of ${LIBRARY_COLLECTION_MIGRATION_MODES.join('|')}: ${JSON.stringify(mode)}`);
  }
  if (!inspected || !Array.isArray(inspected.plans)) throw new Error('applyLibraryCollectionPlans requires an inspection result');
  const files = [];
  let writtenCount = 0;
  for (const plan of inspected.plans) {
    let written = false;
    if (mode === 'apply' && plan.changed) {
      await writePlanFile(plan);
      written = true;
      writtenCount += 1;
    }
    files.push({ ...plan.report, written });
  }
  return {
    root: inspected.root,
    mode,
    scan_root: inspected.scan_root,
    scan_root_present: inspected.scan_root_present,
    file_count: files.length,
    changed_count: files.filter((file) => file.changed).length,
    written_count: writtenCount,
    files
  };
}

// check: 完全 read-only。apply: 同じ検査を全 file 終えたあとにだけ書く。
export async function migrateLibraryCollectionV3({ root, mode } = {}) {
  if (!LIBRARY_COLLECTION_MIGRATION_MODES.includes(mode)) {
    throw new Error(`migration mode must be one of ${LIBRARY_COLLECTION_MIGRATION_MODES.join('|')}: ${JSON.stringify(mode)}`);
  }
  return applyLibraryCollectionPlans({ inspected: await inspectLibraryCollectionFiles({ root }), mode });
}

const USAGE = 'usage: node scripts/migrate-library-collection-v3.mjs --root <absolute-project-root> --mode <check|apply>';

// 既定値を持たない: 足りない・重なる・知らない綴りは全部エラー。
export function parseMigrationArgs(argv) {
  let root = null;
  let mode = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root' || arg === '--mode') {
      const name = arg.slice(2);
      const current = name === 'root' ? root : mode;
      if (current !== null) throw new Error(`${arg} given more than once\n${USAGE}`);
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} needs a value\n${USAGE}`);
      const value = argv[index];
      if (value === '') throw new Error(`${arg} was given an empty value\n${USAGE}`);
      if (name === 'root') root = value; else mode = value;
    } else {
      throw new Error(`unknown argument: ${arg}\n${USAGE}`);
    }
  }
  if (root === null) throw new Error(`--root is required\n${USAGE}`);
  if (mode === null) throw new Error(`--mode is required\n${USAGE}`);
  if (!path.isAbsolute(root)) throw new Error(`--root must be an absolute path: ${root}\n${USAGE}`);
  if (!LIBRARY_COLLECTION_MIGRATION_MODES.includes(mode)) {
    throw new Error(`--mode must be one of ${LIBRARY_COLLECTION_MIGRATION_MODES.join('|')}: ${mode}\n${USAGE}`);
  }
  return { root, mode };
}
