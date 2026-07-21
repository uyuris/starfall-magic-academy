import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const toolPath = path.join(repoRoot, 'tools/asset_pipeline/recover_imagegen_from_rollout.py');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

test('recover_imagegen_from_rollout decodes the image_generation_end matching the call id', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-rollout-recover-'));
  t.after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const rolloutPath = path.join(tmpDir, 'rollout.jsonl');
  const outPath = path.join(tmpDir, 'target.png');
  const wrongBytes = Buffer.from('wrong-png');
  const targetBytes = Buffer.from('target-png');
  await fs.writeFile(
    rolloutPath,
    [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'image_generation_end',
          call_id: 'ig_wrong',
          result: wrongBytes.toString('base64'),
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'image_generation_end',
          call_id: 'ig_target',
          result: targetBytes.toString('base64'),
        },
      }),
      '',
    ].join('\n'),
  );

  const { stdout } = await run('python3', [
    toolPath,
    '--rollout',
    rolloutPath,
    '--call-id',
    'ig_target',
    '--out',
    outPath,
  ]);

  assert.match(stdout, /ig_target/);
  assert.deepEqual(await fs.readFile(outPath), targetBytes);
});
