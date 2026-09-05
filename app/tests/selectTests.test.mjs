import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const selector = path.join(projectRoot, 'scripts/select-tests.mjs');
const scopeFile = path.join(projectRoot, 'app/tests/test-scope.tsv');
const scopeRelative = 'app/tests/test-scope.tsv';

// --- 宣言 file を test 側で素朴に読み直す（selector とは別の実装で期待値を作る） -----

function readDeclarations() {
  const rows = [];
  const text = readFileSync(scopeFile, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '' || line.startsWith('#')) continue;
    const fields = line.split('\t');
    assert.equal(fields.length, 3, `${scopeRelative}:${i + 1} must have 3 tab-separated fields`);
    rows.push({ kind: fields[0], key: fields[1], value: fields[2], line: i + 1 });
  }
  return rows;
}

const rows = readDeclarations();
const targets = rows.filter((row) => row.kind === 'target');
const outOfScope = rows.filter((row) => row.kind === 'out-of-scope');
const unguarded = rows.filter((row) => row.kind === 'unguarded');
const covers = rows.filter((row) => row.kind === 'covers');
const matches = (pattern, candidate) => (pattern.endsWith('/') ? candidate.startsWith(pattern) : candidate === pattern);

// git が見ている path 集合（tracked ＋ ignore されていない untracked）。作業中の新規 file も
// 宣言の対象なので、selector が読む porcelain と同じ範囲をここでも見る。
function repoFiles() {
  const listed = execFileSync('git', ['-C', projectRoot, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' });
  return listed.trim().split('\n').filter((line) => line !== '');
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [selector, ...args], { encoding: 'utf8', cwd: options.cwd ?? projectRoot });
}

function runWithPaths(paths, options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'select-tests-'));
  try {
    const pathsFile = path.join(dir, 'changed.txt');
    writeFileSync(pathsFile, `${paths.join('\n')}\n`, 'utf8');
    return run([
      '--scope', options.scope ?? scopeFile,
      '--repo', options.repo ?? projectRoot,
      '--paths-file', pathsFile
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const selectedLines = (result) => result.stdout.split('\n').filter((line) => line !== '');

// --- 1. 宣言 file の閉じ方 -------------------------------------------------------

test('宣言は kind ごとに理由か test を必ず持ち、pattern の形は2つに閉じている', () => {
  for (const row of rows) {
    assert.notEqual(row.value.trim(), '', `${scopeRelative}:${row.line} の理由/test 列が空`);
    assert.ok(!row.key.startsWith('/'), `${scopeRelative}:${row.line} の pattern が絶対パス`);
    assert.ok(!/[*?[\]]/.test(row.key), `${scopeRelative}:${row.line} の pattern が glob`);
  }
  assert.ok(targets.length > 0);
  assert.ok(unguarded.length > 0);
});

test('リポジトリの全 tracked path が target か out-of-scope のどちらか一方に当たる', () => {
  const tracked = repoFiles();
  const unclassified = [];
  const both = [];
  for (const file of tracked) {
    const inTarget = targets.some((row) => matches(row.key, file));
    const outside = outOfScope.some((row) => matches(row.key, file));
    if (!inTarget && !outside) unclassified.push(file);
    if (inTarget && outside) both.push(file);
  }
  assert.deepEqual(unclassified, [], '適用対象の内外どちらとも宣言されていない path がある');
  assert.deepEqual(both, [], 'target と out-of-scope の両方に当たる path がある');
});

test('適用対象の全 tracked file が covers か unguarded のどちらかに当たる', () => {
  const tracked = repoFiles();
  const coverPatterns = new Set();
  for (const row of covers) {
    coverPatterns.add(row.key);
    for (const pattern of row.value.split(' ')) coverPatterns.add(pattern);
  }
  const undeclared = tracked.filter((file) => {
    if (!targets.some((row) => matches(row.key, file))) return false;
    if ([...coverPatterns].some((pattern) => matches(pattern, file))) return false;
    return !unguarded.some((row) => matches(row.key, file));
  });
  assert.deepEqual(undeclared, [], '宣言の穴（covers にも unguarded にも当たらない適用対象 file）がある');
});

test('covers の key 集合は app/tests/*.test.mjs の実体と一致する', () => {
  const tracked = repoFiles();
  const testFiles = tracked.filter((file) => /^app\/tests\/[^/]+\.test\.mjs$/.test(file)).sort();
  assert.deepEqual(covers.map((row) => row.key).sort(), testFiles);
});

// --- 2. 固定点2: test 基盤そのものの4 path が宣言に載っている ----------------------

test('selector・宣言 file・package.json・mk/project.mk が宣言に明示されている', () => {
  const selfPaths = ['scripts/select-tests.mjs', 'app/tests/test-scope.tsv', 'package.json', 'mk/project.mk'];
  for (const file of selfPaths) {
    const guarded = covers.filter((row) => row.value.split(' ').some((pattern) => matches(pattern, file)));
    const excused = unguarded.filter((row) => matches(row.key, file));
    assert.equal(guarded.length > 0 || excused.length > 0, true, `${file} が宣言に無い`);
    assert.equal(guarded.length > 0 && excused.length > 0, false, `${file} が covers と unguarded の両方に当たる`);
    if (excused.length > 0) assert.notEqual(excused[0].value.trim(), '');
  }
  const selectorGuards = covers
    .filter((row) => row.value.split(' ').includes('scripts/select-tests.mjs'))
    .map((row) => row.key);
  assert.deepEqual(selectorGuards, ['app/tests/selectTests.test.mjs']);
});

// --- 3. 宣言外 fail-fast ---------------------------------------------------------

test('適用対象に入るが宣言に当たらない path は非ゼロで die し、path 名と足りない宣言を名指す', () => {
  const result = runWithPaths(['app/src/undeclaredModule.mjs']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /app\/src\/undeclaredModule\.mjs/);
  assert.match(result.stderr, /app\/tests\/test-scope\.tsv/);
  assert.match(result.stderr, /unguarded row/);
  assert.match(result.stderr, /no fallback to the full suite/);
});

// --- 4. 適用対象外の明示出力 -----------------------------------------------------

test('適用対象を1つも含まない変更は exit 0 で「適用対象外につき選択しない」と言う', () => {
  const result = runWithPaths(['.agents/docs/PROJECT.md', 'README.md']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /適用対象外につき選択しない/);
});

test('適用対象だが unguarded 宣言だけに当たる変更は exit 0 で「選択なし」と理由を言う', () => {
  const result = runWithPaths(['scripts/smoke.mjs']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /選択なし/);
  assert.match(result.stderr, /unguarded scripts\/smoke\.mjs/);
});

// --- 5. 選択の正しさ -------------------------------------------------------------

function declaredTestsFor(file) {
  const expected = new Set();
  for (const row of covers) {
    if (matches(row.key, file)) expected.add(row.key);
    for (const pattern of row.value.split(' ')) {
      if (matches(pattern, file)) expected.add(row.key);
    }
  }
  return [...expected].sort();
}

test('product の1 file の変更は宣言どおりの test 集合を選ぶ', () => {
  const file = 'app/src/dungeon/dungeonEngine.mjs';
  const expected = declaredTestsFor(file);
  assert.ok(expected.length > 0);
  const result = runWithPaths([file]);
  assert.equal(result.status, 0);
  assert.deepEqual(selectedLines(result), expected);
});

test('複数 file の変更は各 file の宣言の和集合を選ぶ', () => {
  const files = ['app/src/dungeon/dungeonEngine.mjs', 'app/src/arena/arenaEngine.mjs'];
  const expected = [...new Set(files.flatMap((file) => declaredTestsFor(file)))].sort();
  const result = runWithPaths(files);
  assert.equal(result.status, 0);
  assert.deepEqual(selectedLines(result), expected);
});

test('ディレクトリ接頭辞で複数 test に写像される path も宣言どおりに選ぶ', () => {
  const file = 'app/public/app.js';
  const expected = declaredTestsFor(file);
  assert.ok(expected.length > 1, 'app/public/app.js は複数 test に写像される前提');
  const result = runWithPaths([file]);
  assert.equal(result.status, 0);
  assert.deepEqual(selectedLines(result), expected);
});

test('test file 自身の変更はその test を選ぶ（covers の key は自分自身も守る）', () => {
  const file = 'app/tests/dungeon.test.mjs';
  const result = runWithPaths([file]);
  assert.equal(result.status, 0);
  assert.ok(selectedLines(result).includes(file));
  assert.deepEqual(selectedLines(result), declaredTestsFor(file));
});

test('適用対象と適用対象外が混ざった変更は適用対象の分だけを選ぶ', () => {
  const result = runWithPaths(['app/src/dungeon/dungeonEngine.mjs', '.agents/docs/PROJECT.md']);
  assert.equal(result.status, 0);
  assert.deepEqual(selectedLines(result), declaredTestsFor('app/src/dungeon/dungeonEngine.mjs'));
});

// --- 6. 並列上限4の宣言が1箇所 ---------------------------------------------------

test('--test-concurrency=4 は package.json に1箇所だけあり、node --test の起動口もそこ1本', () => {
  const packageJsonText = readFileSync(path.join(projectRoot, 'package.json'), 'utf8');
  const concurrency = packageJsonText.match(/--test-concurrency=\d+/g) ?? [];
  assert.deepEqual(concurrency, ['--test-concurrency=4']);

  const scripts = JSON.parse(packageJsonText).scripts;
  const launchers = Object.entries(scripts).filter(([, body]) => /(^|\s)node\s+--test(\s|$)/.test(body));
  assert.deepEqual(launchers.map(([name]) => name), ['test:run']);
  assert.equal(scripts['test:run'], 'node --test --test-concurrency=4');
  for (const [name, body] of Object.entries(scripts)) {
    if (name === 'test:run') continue;
    if (!/--test\b|node:test/.test(body) && !/\btest\b/.test(name)) continue;
    if (!/npm run test:run/.test(body)) continue;
    assert.match(body, /^npm run test:run -- /);
  }
});

// --- 7. 引数の契約 ---------------------------------------------------------------

test('引数の契約違反はすべて exit 2 で落ちる（既定値へ倒れない）', () => {
  const cases = [
    [[], /--scope is required/],
    [['--scope', scopeFile], /--repo is required/],
    [['--scope', scopeFile, '--repo', projectRoot], /one of --git or --paths-file is required/],
    [['--scope', scopeFile, '--repo', projectRoot, '--git', '--paths-file', '/dev/null'], /cannot be combined/],
    [['--scope', scopeFile, '--repo', projectRoot, '--git', '--wat'], /unknown argument: --wat/],
    [['--scope', scopeFile, '--scope', scopeFile, '--repo', projectRoot, '--git'], /--scope given more than once/],
    [['--scope', scopeFile, '--repo', projectRoot, '--paths-file'], /--paths-file needs a value/]
  ];
  for (const [args, pattern] of cases) {
    const result = run(args);
    assert.equal(result.status, 2, `${args.join(' ')} should exit 2`);
    assert.match(result.stderr, pattern);
  }
});

test('読めない宣言 file・空の変更集合は全量へ倒さずに die する', () => {
  const missing = run(['--scope', path.join(projectRoot, 'app/tests/no-such-scope.tsv'), '--repo', projectRoot, '--git']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /cannot read the scope declaration/);

  const empty = runWithPaths([]);
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /changed-path set is empty/);
});

// --- 8. 壊れた宣言は宣言のまま die する -------------------------------------------

test('壊れた宣言は既定値や全量へ倒れず、行を名指して die する', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'select-tests-scope-'));
  try {
    mkdirSync(path.join(dir, 'app/tests'), { recursive: true });
    mkdirSync(path.join(dir, 'docs'), { recursive: true });
    writeFileSync(path.join(dir, 'app/tests/a.test.mjs'), '', 'utf8');
    writeFileSync(path.join(dir, 'app/mod.mjs'), '', 'utf8');
    writeFileSync(path.join(dir, 'docs/note.md'), '', 'utf8');
    const changed = path.join(dir, 'changed.txt');
    writeFileSync(changed, 'app/mod.mjs\n', 'utf8');

    const valid = [
      'target\tapp/\truntime。',
      'out-of-scope\tdocs/\t文書。',
      'covers\tapp/tests/a.test.mjs\tapp/mod.mjs'
    ];
    const cases = [
      [[...valid, 'unguarded\tapp/mod.mjs\t'], /third column is empty/],
      [[...valid, 'wat\tapp/mod.mjs\t理由。'], /unknown kind/],
      [[...valid.slice(0, 2), 'covers\tapp/tests/a.test.mjs\tapp/*.mjs'], /glob is not a pattern/],
      [[...valid, 'target\tapp/mod.mjs'], /expected 3 tab-separated fields/],
      [[...valid, 'unguarded\tapp/gone.mjs\t理由。'], /declared path does not exist/],
      [[...valid, 'out-of-scope\tapp/mod.mjs\t文書。'], /overlap/],
      [[...valid, 'unguarded\tapp/mod.mjs\t理由。'], /overlaps covers/],
      [[...valid, 'covers\tapp/tests/a.test.mjs\tapp/mod.mjs'], /duplicate covers declaration/],
      [['out-of-scope\tdocs/\t文書。', 'covers\tapp/tests/a.test.mjs\tapp/mod.mjs'], /no target declaration/]
    ];
    for (const [lines, pattern] of cases) {
      const scope = path.join(dir, 'scope.tsv');
      writeFileSync(scope, `${lines.join('\n')}\n`, 'utf8');
      const result = run(['--scope', scope, '--repo', dir, '--paths-file', changed]);
      assert.equal(result.status, 2, `${lines.join(' | ')} should exit 2`);
      assert.match(result.stderr, pattern);
    }

    const scope = path.join(dir, 'scope.tsv');
    writeFileSync(scope, `${valid.join('\n')}\n`, 'utf8');
    const ok = run(['--scope', scope, '--repo', dir, '--paths-file', changed]);
    assert.equal(ok.status, 0);
    assert.deepEqual(selectedLines(ok), ['app/tests/a.test.mjs']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 9. --git の変更 path 規律（dirty は porcelain 全部、clean は HEAD^..HEAD） -----

test('--git は dirty tree では porcelain 全部、clean tree では HEAD^..HEAD を読む', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'select-tests-git-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'selector@example.invalid');
    git('config', 'user.name', 'selector');
    mkdirSync(path.join(dir, 'app/tests'), { recursive: true });
    mkdirSync(path.join(dir, 'docs'), { recursive: true });
    writeFileSync(path.join(dir, 'app/tests/a.test.mjs'), '', 'utf8');
    writeFileSync(path.join(dir, 'app/tests/b.test.mjs'), '', 'utf8');
    writeFileSync(path.join(dir, 'app/mod.mjs'), 'v1\n', 'utf8');
    writeFileSync(path.join(dir, 'docs/note.md'), 'v1\n', 'utf8');
    const scope = path.join(dir, 'scope.tsv');
    writeFileSync(scope, [
      'target\tapp/\truntime。',
      'out-of-scope\tdocs/\t文書。',
      'out-of-scope\tscope.tsv\t宣言 file 自身（この fixture では適用対象外）。',
      'covers\tapp/tests/a.test.mjs\tapp/mod.mjs',
      'covers\tapp/tests/b.test.mjs\tapp/tests/a.test.mjs'
    ].join('\n') + '\n', 'utf8');
    git('add', '-A');
    git('commit', '-qm', 'base');

    // clean tree: 直前のコミットの delta を読む
    writeFileSync(path.join(dir, 'app/mod.mjs'), 'v2\n', 'utf8');
    git('add', '-A');
    git('commit', '-qm', 'change mod');
    const clean = run(['--scope', scope, '--repo', dir, '--git']);
    assert.equal(clean.status, 0);
    assert.deepEqual(selectedLines(clean), ['app/tests/a.test.mjs']);

    // dirty tree: staged / unstaged / untracked をすべて読む
    writeFileSync(path.join(dir, 'app/tests/a.test.mjs'), 'touched\n', 'utf8');
    writeFileSync(path.join(dir, 'docs/note.md'), 'v2\n', 'utf8');
    const dirty = run(['--scope', scope, '--repo', dir, '--git']);
    assert.equal(dirty.status, 0);
    assert.deepEqual(selectedLines(dirty), ['app/tests/a.test.mjs', 'app/tests/b.test.mjs']);

    // dirty tree の untracked な宣言外 path は全量へ倒さず die する
    writeFileSync(path.join(dir, 'app/new.mjs'), '', 'utf8');
    const undeclared = run(['--scope', scope, '--repo', dir, '--git']);
    assert.equal(undeclared.status, 2);
    assert.match(undeclared.stderr, /app\/new\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
