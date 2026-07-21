import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const toolPath = path.join(repoRoot, 'tools/asset_pipeline/materialize_character_visual_set.py');
const referenceManifestPath = path.join(repoRoot, 'assets/canonical/character_visual_sets/visual_set_001/manifest.json');

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

async function writeSyntheticSources(tmpDir) {
  const sourcePath = path.join(tmpDir, 'emotion-sheet.png');
  const standeePath = path.join(tmpDir, 'standee-full-scene.png');
  const script = `
from PIL import Image, ImageDraw
emotions = ${JSON.stringify([
    'neutral',
    'joy',
    'caring',
    'confident',
    'sadness',
    'anger',
    'worried',
    'surprised',
    'embarrassed',
    'shy',
    'serious',
    'determined',
    'smug',
    'tired',
    'panic',
    'sick',
  ])}
sheet = Image.new("RGBA", (2000, 2000), (247, 228, 196, 255))
draw = ImageDraw.Draw(sheet)
for index, emotion in enumerate(emotions):
    row = index // 4
    col = index % 4
    color = (10 + index * 11, 20 + index * 7, 30 + index * 5, 255)
    draw.rectangle((col * 500 + 80, row * 500 + 80, col * 500 + 420, row * 500 + 420), fill=color)
sheet.save(${JSON.stringify(sourcePath)})
standee = Image.new("RGB", (900, 700), (28, 43, 72))
draw = ImageDraw.Draw(standee)
draw.rectangle((0, 520, 900, 700), fill=(69, 82, 95))
draw.ellipse((330, 90, 570, 330), fill=(230, 184, 92))
draw.rectangle((380, 300, 520, 610), fill=(200, 80, 40))
standee.save(${JSON.stringify(standeePath)})
`;
  await run('python3', ['-c', script]);
  return { sourcePath, standeePath };
}

async function writeDriftedSources(tmpDir) {
  const sourcePath = path.join(tmpDir, 'drifted-emotion-sheet.png');
  const standeePath = path.join(tmpDir, 'full-scene-standee.png');
  const script = `
from PIL import Image, ImageDraw
emotions = ${JSON.stringify([
    'neutral',
    'joy',
    'caring',
    'confident',
    'sadness',
    'anger',
    'worried',
    'surprised',
    'embarrassed',
    'shy',
    'serious',
    'determined',
    'smug',
    'tired',
    'panic',
    'sick',
  ])}
cream = (247, 228, 196, 255)
sheet = Image.new("RGBA", (2000, 2000), cream)
draw = ImageDraw.Draw(sheet)
for index, emotion in enumerate(emotions):
    row = index // 4
    col = index % 4
    drift_x = -(col * 20 + row * 5)
    drift_y = -(row * 24 + col * 4)
    center_x = col * 500 + 250 + drift_x
    center_y = row * 500 + 250 + drift_y
    color = (10 + index * 11, 20 + index * 7, 30 + index * 5, 255)
    draw.ellipse((center_x - 120, center_y - 150, center_x + 120, center_y + 150), fill=color)
    draw.rectangle((center_x - 34, center_y + 110, center_x + 34, center_y + 190), fill=color)
sheet.save(${JSON.stringify(sourcePath)})
standee = Image.new("RGB", (900, 700), (28, 43, 72))
draw = ImageDraw.Draw(standee)
draw.rectangle((0, 520, 900, 700), fill=(69, 82, 95))
draw.ellipse((330, 90, 570, 330), fill=(230, 184, 92))
draw.rectangle((380, 300, 520, 610), fill=(180, 68, 92))
standee.save(${JSON.stringify(standeePath)})
`;
  await run('python3', ['-c', script]);
  return { sourcePath, standeePath };
}

async function writeGridBoundedSources(tmpDir) {
  const sourcePath = path.join(tmpDir, 'grid-bounded-emotion-sheet.png');
  const standeePath = path.join(tmpDir, 'grid-bounded-standee.png');
  const script = `
from PIL import Image, ImageDraw
emotions = ${JSON.stringify([
    'neutral',
    'joy',
    'caring',
    'confident',
    'sadness',
    'anger',
    'worried',
    'surprised',
    'embarrassed',
    'shy',
    'serious',
    'determined',
    'smug',
    'tired',
    'panic',
    'sick',
  ])}
cream = (247, 228, 196, 255)
sheet = Image.new("RGBA", (2000, 2000), cream)
draw = ImageDraw.Draw(sheet)
for value in (500, 1000, 1500):
    draw.line((value, 0, value, 2000), fill=(40, 36, 32, 255), width=3)
    draw.line((0, value, 2000, value), fill=(40, 36, 32, 255), width=3)
for index, emotion in enumerate(emotions):
    row = index // 4
    col = index % 4
    # Deliberately low/right in the cell: content-centering alone would cross
    # the visible separator and include the next cell.
    center_x = col * 500 + 320
    center_y = row * 500 + 320
    color = (20 + row * 50, 40 + col * 40, 120 + index * 4, 255)
    draw.ellipse((center_x - 80, center_y - 95, center_x + 80, center_y + 95), fill=color)
sheet.save(${JSON.stringify(sourcePath)})
standee = Image.new("RGB", (900, 700), (40, 60, 90))
ImageDraw.Draw(standee).rectangle((360, 120, 540, 620), fill=(180, 90, 120))
standee.save(${JSON.stringify(standeePath)})
`;
  await run('python3', ['-c', script]);
  return { sourcePath, standeePath };
}

async function imageInfo(imagePath) {
  const script = `
from PIL import Image
import json
source = Image.open(${JSON.stringify(imagePath)})
image = source.convert("RGBA")
center = image.getpixel((image.size[0] // 2, image.size[1] // 2))
corner = image.getpixel((0, 0))
alpha_nonzero = sum(1 for value in image.getchannel("A").getdata() if value > 0)
print(json.dumps({"mode": source.mode, "size": image.size, "center": center, "corner": corner, "alpha_nonzero": alpha_nonzero}))
`;
  const { stdout } = await run('python3', ['-c', script]);
  return JSON.parse(stdout);
}

async function nonBackgroundBox(imagePath) {
  const script = `
from PIL import Image
import json
image = Image.open(${JSON.stringify(imagePath)}).convert("RGBA")
bg = (247, 228, 196)
threshold = 35
xs = []
ys = []
for y in range(image.height):
    for x in range(image.width):
        red, green, blue, alpha = image.getpixel((x, y))
        if alpha > 0 and sum(abs(a - b) for a, b in zip((red, green, blue), bg)) > threshold:
            xs.append(x)
            ys.append(y)
box = {"left": min(xs), "top": min(ys), "right": max(xs) + 1, "bottom": max(ys) + 1}
box["center_x"] = (box["left"] + box["right"]) / 2
box["center_y"] = (box["top"] + box["bottom"]) / 2
print(json.dumps(box))
`;
  const { stdout } = await run('python3', ['-c', script]);
  return JSON.parse(stdout);
}

async function sha256(pathname) {
  const hash = createHash('sha256');
  hash.update(await fs.readFile(pathname));
  return hash.digest('hex');
}

function keysDeep(value) {
  if (Array.isArray(value)) return value.length > 0 ? [keysDeep(value[0])] : [];
  if (!value || typeof value !== 'object') return typeof value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, keysDeep(child)]));
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertRgbaApprox(actual, expected, tolerance = 8) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < actual.length; index += 1) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) <= tolerance,
      `channel ${index}: expected ${actual[index]} to be within ${tolerance} of ${expected[index]}`
    );
  }
}

test('materialize_character_visual_set slices faces, preserves a full-scene standee, and writes manifest shape matching canonical visual sets', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-asset-pipeline-'));
  t.after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  const { sourcePath, standeePath } = await writeSyntheticSources(tmpDir);
  const outputDir = path.join(tmpDir, 'visual_set_999');

  await run('python3', [
    toolPath,
    '--visual-set-id',
    'visual_set_999',
    '--output-dir',
    outputDir,
    '--emotion-sheet',
    sourcePath,
    '--standee-full-scene',
    standeePath,
    '--role',
    'pipeline validation student',
    '--identity-lock',
    'test skin, test hair, test eyes, test uniform',
    '--characteristic-prop',
    'test charm',
    '--standee-variation-basis',
    'synthetic full-scene standee with a painted background',
    '--source-prompt-summary',
    'synthetic 16-emotion source sheet',
    '--standee-prompt-summary',
    'synthetic full-scene standee source',
  ]);

  const manifest = JSON.parse(await fs.readFile(path.join(outputDir, 'manifest.json'), 'utf8'));
  const referenceManifest = JSON.parse(await fs.readFile(referenceManifestPath, 'utf8'));
  assert.deepEqual(Object.keys(manifest), Object.keys(referenceManifest));
  assert.deepEqual(keysDeep(manifest.source_sheet), keysDeep(referenceManifest.source_sheet));
  assert.deepEqual(keysDeep(manifest.face_emotion_variants), keysDeep(referenceManifest.face_emotion_variants));
  assert.deepEqual(keysDeep(manifest.generation_notes), keysDeep(referenceManifest.generation_notes));
  assert.deepEqual(keysDeep(manifest.scene_standee), keysDeep(referenceManifest.scene_standee));
  assert.equal(hasOwn(manifest.source_sheet, 'plain_background_validation'), false);
  assert.equal(hasOwn(referenceManifest.source_sheet, 'plain_background_validation'), false);
  assert.equal(hasOwn(manifest.base_face, 'sha256'), false);
  assert.equal(hasOwn(referenceManifest.base_face, 'sha256'), false);

  assert.equal(manifest.visual_set_id, 'visual_set_999');
  assert.equal(manifest.source_sheet.width, 2000);
  assert.equal(manifest.source_sheet.grid.cell_width, 500);
  assert.equal(manifest.source_sheet.emotion_cell_mapping.anger.row, 2);
  assert.equal(manifest.source_sheet.emotion_cell_mapping.anger.col, 2);
  assert.equal(manifest.face_emotion_variants.length, 16);

  const neutralPath = path.join(outputDir, 'face_emotions/neutral.jpg');
  const basePath = path.join(outputDir, 'face/base.jpg');
  const angerPath = path.join(outputDir, 'face_emotions/anger.jpg');
  const standeeOutPath = path.join(outputDir, manifest.scene_standee.path);
  assert.equal(await sha256(neutralPath), await sha256(basePath));
  assert.equal(manifest.face_emotion_variants[0].sha256, await sha256(neutralPath));
  assert.equal(manifest.scene_standee.id, 'scene_standee_character_01');
  assert.equal(manifest.scene_standee.path, 'scene_standee/scene_standee_character_01.jpg');
  assert.equal(manifest.scene_standee.sha256, await sha256(standeeOutPath));

  const neutral = await imageInfo(neutralPath);
  const anger = await imageInfo(angerPath);
  const standee = await imageInfo(standeeOutPath);
  assert.deepEqual(neutral.size, [500, 500]);
  assert.deepEqual(anger.size, [500, 500]);
  assertRgbaApprox(anger.center, [65, 55, 55, 255]);
  assert.deepEqual(standee.size, [1254, 1254]);
  assert.equal(standee.mode, 'RGB');
  assert.equal(standee.corner[3], 255);
  assert.equal(standee.alpha_nonzero, 1254 * 1254);
});

test('materialize_character_visual_set keeps fixed grid crops for drifted face cells and preserves full-scene standee backgrounds', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-asset-pipeline-'));
  t.after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  const { sourcePath, standeePath } = await writeDriftedSources(tmpDir);
  const outputDir = path.join(tmpDir, 'visual_set_998');

  await run('python3', [
    toolPath,
    '--visual-set-id',
    'visual_set_998',
    '--output-dir',
    outputDir,
    '--emotion-sheet',
    sourcePath,
    '--standee-full-scene',
    standeePath,
    '--role',
    'pipeline validation student',
    '--identity-lock',
    'test skin, test hair, test eyes, test uniform',
    '--characteristic-prop',
    'test charm',
    '--standee-variation-basis',
    'synthetic full-scene standee with a painted background',
    '--source-prompt-summary',
    'synthetic drifted 16-emotion source sheet',
    '--standee-prompt-summary',
    'synthetic full-scene standee source',
  ]);

  const manifest = JSON.parse(await fs.readFile(path.join(outputDir, 'manifest.json'), 'utf8'));
  const sickMapping = manifest.source_sheet.emotion_cell_mapping.sick;
  assert.equal(sickMapping.x, 1500);
  assert.equal(sickMapping.y, 1500);
  assert.equal(sickMapping.w, 500);
  assert.equal(sickMapping.h, 500);

  const sickPath = path.join(outputDir, 'face_emotions/sick.jpg');
  const sickBox = await nonBackgroundBox(sickPath);
  assert.ok(Math.abs(sickBox.center_x - 175.5) <= 1);
  assert.ok(Math.abs(sickBox.center_y - 186.5) <= 1);

  const standeeOutPath = path.join(outputDir, manifest.scene_standee.path);
  const standee = await imageInfo(standeeOutPath);
  assert.equal(standee.mode, 'RGB');
  assert.deepEqual(standee.size, [1254, 1254]);
  assert.equal(standee.corner[3], 255);
  assert.equal(standee.alpha_nonzero, 1254 * 1254);
});

test('materialize_character_visual_set slices visible grid sheets by fixed offsets without separator cleanup', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-asset-pipeline-'));
  t.after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  const { sourcePath, standeePath } = await writeGridBoundedSources(tmpDir);
  const outputDir = path.join(tmpDir, 'visual_set_997');

  await run('python3', [
    toolPath,
    '--visual-set-id',
    'visual_set_997',
    '--output-dir',
    outputDir,
    '--emotion-sheet',
    sourcePath,
    '--standee-full-scene',
    standeePath,
    '--role',
    'pipeline validation student',
    '--identity-lock',
    'test skin, test hair, test eyes, test uniform',
    '--characteristic-prop',
    'test charm',
    '--standee-variation-basis',
    'synthetic full-scene standee with a painted background',
    '--source-prompt-summary',
    'synthetic visible-grid 16-emotion source sheet',
    '--standee-prompt-summary',
    'synthetic full-scene standee source',
  ]);

  const manifest = JSON.parse(await fs.readFile(path.join(outputDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.source_sheet.emotion_cell_mapping.neutral.x, 0);
  assert.equal(manifest.source_sheet.emotion_cell_mapping.neutral.y, 0);
  assert.equal(manifest.source_sheet.emotion_cell_mapping.sick.x, 1500);
  assert.equal(manifest.source_sheet.emotion_cell_mapping.sick.y, 1500);

  const neutral = await imageInfo(path.join(outputDir, 'face_emotions/neutral.jpg'));
  const sick = await imageInfo(path.join(outputDir, 'face_emotions/sick.jpg'));
  assert.deepEqual(neutral.size, [500, 500]);
  assertRgbaApprox(neutral.corner, [247, 228, 196, 255]);
  assertRgbaApprox(sick.corner, [40, 36, 32, 255]);
});
