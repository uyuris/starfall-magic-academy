#!/usr/bin/env node
//
// select-tests.mjs — 変更 path から走らせる test file を宣言で逆引きする。
//
// 宣言の正本は app/tests/test-scope.tsv（形式と規則はその file の冒頭に書いてある）。
// ここはその宣言を読んで選択を導出するだけで、宣言の外側の知識を持たない。
//
// 使い方:
//   node scripts/select-tests.mjs --scope <tsv> --repo <dir> --git
//   node scripts/select-tests.mjs --scope <tsv> --repo <dir> --paths-file <file>
//
// stdout は選ばれた test file path だけを1行1件（ソート済み・重複なし）で出す。
// 人間向けの説明は stderr に出す。終了コードは2つだけ:
//   0  選択が確定した（0件のこともある。0件のときは必ず理由を stderr に明示する）
//   2  契約違反または宣言の穴（全量へ倒さず die する）
//
// 「全量へ倒す」出口は無い。宣言に当たらない適用対象 path、読めない宣言、git の失敗、
// 空の変更集合は、いずれも exit 2 で名指しして落ちる。

import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const USAGE = 'usage: node scripts/select-tests.mjs --scope <tsv> --repo <dir> (--git | --paths-file <file>)';

function die(message) {
  process.stderr.write(`select-tests: ${message}\n`);
  process.exit(2);
}

// --- 引数（既定値を持たない。足りない・重なる・知らない綴りは全部 die） ----------

function parseArgs(argv) {
  const options = { scope: null, repo: null, git: false, pathsFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = (name, current) => {
      if (current !== null) die(`${name} given more than once`);
      i += 1;
      if (i >= argv.length) die(`${name} needs a value\n${USAGE}`);
      const value = argv[i];
      if (value === '') die(`${name} was given an empty value`);
      return value;
    };
    if (arg === '--scope') options.scope = takeValue('--scope', options.scope);
    else if (arg === '--repo') options.repo = takeValue('--repo', options.repo);
    else if (arg === '--paths-file') options.pathsFile = takeValue('--paths-file', options.pathsFile);
    else if (arg === '--git') {
      if (options.git) die('--git given more than once');
      options.git = true;
    } else die(`unknown argument: ${arg}\n${USAGE}`);
  }
  if (options.scope === null) die(`--scope is required\n${USAGE}`);
  if (options.repo === null) die(`--repo is required\n${USAGE}`);
  if (options.git && options.pathsFile !== null) {
    die('--git and --paths-file cannot be combined; the changed-path set has one source');
  }
  if (!options.git && options.pathsFile === null) {
    die(`one of --git or --paths-file is required\n${USAGE}`);
  }
  return options;
}

// --- pattern の形（受け付けるのは2つだけ） ---------------------------------------

function checkPattern(pattern, where) {
  if (pattern === '') die(`${where}: empty pattern`);
  if (pattern.startsWith('/')) die(`${where}: absolute path is not a pattern: ${pattern}`);
  if (/[*?[\]]/.test(pattern)) die(`${where}: glob is not a pattern (use a trailing-slash directory prefix or a literal path): ${pattern}`);
  if (pattern.includes('//')) die(`${where}: empty path segment: ${pattern}`);
  const segments = pattern.split('/');
  for (const segment of segments) {
    if (segment === '.' || segment === '..') die(`${where}: relative segment is not allowed: ${pattern}`);
  }
  return pattern;
}

const isPrefix = (pattern) => pattern.endsWith('/');
const matches = (pattern, target) => (isPrefix(pattern) ? target.startsWith(pattern) : target === pattern);
// 片方がもう片方を覆う関係（宣言どうしの衝突検査に使う）。
const overlaps = (a, b) => matches(a, b) || matches(b, a)
  || (isPrefix(a) && isPrefix(b) && (a.startsWith(b) || b.startsWith(a)));

// --- 宣言 file を1回だけ読み、その1パスで索引を組む -------------------------------

function loadScope(scopeFile, repoRoot) {
  let text;
  try {
    text = readFileSync(scopeFile, 'utf8');
  } catch (error) {
    die(`cannot read the scope declaration ${scopeFile}: ${error.message}`);
  }

  const target = new Map();
  const outOfScope = new Map();
  const unguarded = new Map();
  const coversByTest = new Map();
  const exactCovers = new Map();
  const prefixCovers = new Map();
  const declaredPatterns = new Set();

  const addCover = (index, pattern, test) => {
    const bucket = index.get(pattern);
    if (bucket) bucket.add(test);
    else index.set(pattern, new Set([test]));
  };

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '' || line.startsWith('#')) continue;
    const where = `${scopeFile}:${i + 1}`;
    const fields = line.split('\t');
    if (fields.length !== 3) die(`${where}: expected 3 tab-separated fields, got ${fields.length}`);
    const [kind, key, value] = fields;
    if (value.trim() === '') die(`${where}: the third column is empty; every declaration states its tests or its reason`);

    if (kind === 'target' || kind === 'out-of-scope' || kind === 'unguarded') {
      checkPattern(key, where);
      const store = kind === 'target' ? target : kind === 'out-of-scope' ? outOfScope : unguarded;
      if (store.has(key)) die(`${where}: duplicate ${kind} declaration for ${key}`);
      store.set(key, value);
      if (kind !== 'out-of-scope') declaredPatterns.add(key);
      continue;
    }

    if (kind === 'covers') {
      checkPattern(key, where);
      if (isPrefix(key)) die(`${where}: a covers key is a test file, not a directory prefix: ${key}`);
      if (coversByTest.has(key)) die(`${where}: duplicate covers declaration for ${key}`);
      const patterns = value.split(' ').filter((entry) => entry !== '');
      if (patterns.length === 0) die(`${where}: covers ${key} declares no path`);
      const seen = new Set();
      for (const pattern of patterns) {
        checkPattern(pattern, where);
        if (seen.has(pattern)) die(`${where}: covers ${key} repeats ${pattern}`);
        seen.add(pattern);
        declaredPatterns.add(pattern);
        addCover(isPrefix(pattern) ? prefixCovers : exactCovers, pattern, key);
      }
      coversByTest.set(key, patterns);
      // covers 行の key は、その test 自身が守る path でもある（宣言済みの規則）。
      declaredPatterns.add(key);
      addCover(exactCovers, key, key);
      continue;
    }

    die(`${where}: unknown kind ${JSON.stringify(kind)} (target / out-of-scope / unguarded / covers)`);
  }

  if (target.size === 0) die(`${scopeFile}: no target declaration; the gate has no applicability set`);
  if (coversByTest.size === 0) die(`${scopeFile}: no covers declaration; nothing could ever be selected`);

  // 宣言が指す path は実在しなければならない（消えた path を黙って残さない）。
  for (const pattern of declaredPatterns) {
    const full = path.join(repoRoot, pattern);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      die(`${scopeFile}: declared path does not exist: ${pattern}`);
    }
    if (isPrefix(pattern) && !stats.isDirectory()) die(`${scopeFile}: ${pattern} is declared as a directory prefix but is not a directory`);
    if (!isPrefix(pattern) && !stats.isFile()) die(`${scopeFile}: ${pattern} is declared as a file but is not a file`);
  }

  // target と out-of-scope は重ならない（重なると path の所属が二通りに読める）。
  for (const targetPattern of target.keys()) {
    for (const outPattern of outOfScope.keys()) {
      if (overlaps(targetPattern, outPattern)) {
        die(`${scopeFile}: target ${targetPattern} and out-of-scope ${outPattern} overlap; a path must belong to exactly one of them`);
      }
    }
  }

  const inTarget = (candidate) => {
    for (const pattern of target.keys()) {
      if (matches(pattern, candidate)) return true;
      // porcelain は丸ごと untracked なディレクトリを 1 entry に畳む。畳まれた entry が
      // 適用対象を含みうるなら、適用対象として扱って宣言を要求する。
      if (candidate.endsWith('/') && pattern.startsWith(candidate)) return true;
    }
    return false;
  };

  // unguarded は適用対象の内側でしか意味を持たず、covers と重なってもいけない。
  for (const pattern of unguarded.keys()) {
    if (!inTarget(pattern)) die(`${scopeFile}: unguarded ${pattern} is outside the target set; it declares nothing`);
    for (const covered of declaredPatterns) {
      if (!exactCovers.has(covered) && !prefixCovers.has(covered)) continue;
      if (overlaps(pattern, covered)) {
        die(`${scopeFile}: unguarded ${pattern} overlaps covers ${covered}; a path is either guarded or declared unguarded, not both`);
      }
    }
  }

  return { target, outOfScope, unguarded, coversByTest, exactCovers, prefixCovers, inTarget };
}

// --- 変更 path 集合（team_post_change_scope.sh と同じ規律） -----------------------

function gitLines(repoRoot, args) {
  try {
    return execFileSync('git', ['-C', repoRoot, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8' });
  } catch (error) {
    die(`git ${args.join(' ')} failed: ${error.message}`);
  }
}

function changedFromGit(repoRoot) {
  const status = gitLines(repoRoot, ['status', '--porcelain']);
  const paths = [];
  if (status.trim() !== '') {
    for (const line of status.split('\n')) {
      if (line === '') continue;
      if (line[2] !== ' ') die(`unexpected git status --porcelain line: ${JSON.stringify(line)}`);
      const entry = line.slice(3);
      if (entry.includes(' -> ')) {
        paths.push(entry.slice(0, entry.indexOf(' -> ')));
        paths.push(entry.slice(entry.indexOf(' -> ') + 4));
      } else paths.push(entry);
    }
  } else {
    const diff = gitLines(repoRoot, ['diff', '--name-only', 'HEAD^..HEAD']);
    for (const line of diff.split('\n')) {
      if (line !== '') paths.push(line);
    }
  }
  if (paths.length === 0) die('the changed-path set is empty; there is nothing to derive a selection from');
  return paths;
}

function changedFromFile(pathsFile) {
  let text;
  try {
    text = readFileSync(pathsFile, 'utf8');
  } catch (error) {
    die(`cannot read the changed-path file ${pathsFile}: ${error.message}`);
  }
  const paths = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const entry = lines[i];
    if (entry === '') continue;
    if (entry.startsWith('/')) die(`${pathsFile}:${i + 1}: absolute path is not a repo-relative changed path: ${entry}`);
    if (entry.split('/').some((segment) => segment === '.' || segment === '..')) {
      die(`${pathsFile}:${i + 1}: relative segment is not allowed: ${entry}`);
    }
    paths.push(entry);
  }
  if (paths.length === 0) die(`${pathsFile}: the changed-path set is empty; there is nothing to derive a selection from`);
  return paths;
}

// --- 選択 ---------------------------------------------------------------------

function lookupCovers(scope, candidate) {
  const found = new Set();
  const exact = scope.exactCovers.get(candidate);
  if (exact) for (const test of exact) found.add(test);
  for (let slash = candidate.indexOf('/'); slash !== -1; slash = candidate.indexOf('/', slash + 1)) {
    const bucket = scope.prefixCovers.get(candidate.slice(0, slash + 1));
    if (bucket) for (const test of bucket) found.add(test);
  }
  return found;
}

function lookupUnguarded(scope, candidate) {
  for (const pattern of scope.unguarded.keys()) {
    if (matches(pattern, candidate)) return pattern;
  }
  return null;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(options.repo);
  const scope = loadScope(options.scope, repoRoot);
  const changed = options.git ? changedFromGit(repoRoot) : changedFromFile(options.pathsFile);

  const gateTargets = [];
  const seen = new Set();
  for (const candidate of changed) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (scope.inTarget(candidate)) gateTargets.push(candidate);
  }

  if (gateTargets.length === 0) {
    process.stderr.write(`select-tests: 適用対象外につき選択しない: 変更 ${seen.size} path はいずれも ${options.scope} の target 宣言に当たらない\n`);
    return;
  }

  const selected = new Set();
  const undeclared = [];
  const unguardedHits = [];
  for (const candidate of gateTargets) {
    const tests = lookupCovers(scope, candidate);
    if (tests.size > 0) {
      for (const test of tests) selected.add(test);
      continue;
    }
    const unguardedPattern = lookupUnguarded(scope, candidate);
    if (unguardedPattern !== null) {
      unguardedHits.push(`${candidate} (unguarded ${unguardedPattern}: ${scope.unguarded.get(unguardedPattern)})`);
      continue;
    }
    undeclared.push(candidate);
  }

  if (undeclared.length > 0) {
    const lines = [
      `${undeclared.length} changed path(s) are inside the gate target set but no declaration covers them:`,
      ...undeclared.map((entry) => `  ${entry}`),
      `fix ${options.scope} in this same change: add the path to the covers row of the test that guards it,`,
      'or add an unguarded row stating why no test guards it. There is no fallback to the full suite.'
    ];
    die(lines.join('\n'));
  }

  if (selected.size === 0) {
    process.stderr.write(`select-tests: 選択なし: 適用対象の変更 ${gateTargets.length} path はすべて unguarded 宣言に当たる\n`);
    for (const hit of unguardedHits) process.stderr.write(`select-tests:   ${hit}\n`);
    return;
  }

  const output = [...selected].sort();
  process.stdout.write(`${output.join('\n')}\n`);
  process.stderr.write(`select-tests: selected ${output.length} test file(s) from ${gateTargets.length} gate-target path(s) of ${seen.size} changed path(s)\n`);
  for (const hit of unguardedHits) process.stderr.write(`select-tests:   ${hit}\n`);
}

main();
