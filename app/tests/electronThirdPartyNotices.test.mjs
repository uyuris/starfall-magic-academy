import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, '../..');
const packageJsonPath = path.join(projectRoot, 'package.json');
const noticesRoot = path.join(projectRoot, 'build/legal/third-party-notices');

async function readPackageJson() {
  return JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
}

test('Electron packaging exposes third-party notices as extra resources outside app.asar', async () => {
  const packageJson = await readPackageJson();
  const extraResources = packageJson.build?.extraResources ?? [];

  assert.deepEqual(extraResources, [
    {
      from: 'build/legal/third-party-notices',
      to: 'third-party-notices',
      filter: ['**/*']
    }
  ]);
  assert.equal(packageJson.build?.extraFiles, undefined);
});

test('third-party notice bundle contains the Electron and Chromium license entry points', async () => {
  const expectedFiles = [
    'THIRD_PARTY_NOTICES.md',
    'LICENSE.electron.txt',
    'LICENSES.chromium.html'
  ];

  for (const fileName of expectedFiles) {
    const filePath = path.join(noticesRoot, fileName);
    const stats = await fs.stat(filePath);
    assert.ok(stats.size > 0, `${fileName} should be present and non-empty`);
  }

  const noticeIndex = await fs.readFile(path.join(noticesRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.match(noticeIndex, /Electron/i);
  assert.match(noticeIndex, /Chromium/i);
  assert.match(noticeIndex, /LICENSE\.electron\.txt/);
  assert.match(noticeIndex, /LICENSES\.chromium\.html/);
});
