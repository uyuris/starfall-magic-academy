import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runtimePublicReferenceRoot } from './testPaths.mjs';
import { readUiSource } from './fixtures/uiSource.mjs';

// 画面別 BGM (screen music) frontend contract tests (test-by-token against the shipped app.js). The controller is
// the single audio owner: pure config (track catalog + screen map), one AudioContext, and one state-sync function
// called from showScreen + the 星の揺り籠 overlay. These assertions pin the closed screen→track map (brief), the
// showScreen entry fail-fast, the same-track no-op guard, the crossfade + 2-voice teardown, the decode-failure
// silence, the overlay override, and the autoplay unlock listener.

const root = runtimePublicReferenceRoot;
const readFile = readUiSource;
const appJsPath = path.join(root, 'app.js');

// The brief's confirmed screen→track closed map (.agents/docs/design/bgm-screen-music-brief.md, 28 real screen
// ids). 22 screens carry a track; the remaining 6 (debug / legacy) are silent and MUST NOT appear in the map.
const EXPECTED_SCREEN_TRACKS = {
  title: 'v4-title',
  'slot-load': 'v4-title',
  settings: 'v4-title',
  'academy-loading': 'v5-loading',
  'routing-hub': 'v1-moonlit',
  'academy-map': 'base',
  'academy-room': 'base',
  'conversation-day': 'v2-daytime',
  'academy-conversation-session': 'v2-daytime',
  'academy-errand': 'v2-daytime',
  'academy-training': 'v9-training',
  'academy-dungeon': 'v3-tense',
  'academy-alchemy': 'v11-alchemy',
  'academy-study-circle': 'v13-study',
  'academy-workshop': 'v12-workshop',
  'academy-library': 'v14-library',
  'academy-atelier': 'v15-atelier',
  'academy-arena': 'v10-arena',
  'academy-auction': 'v16-auction',
  'academy-lounge': 'v17-lounge',
  shop: 'v7-shop',
  gathering: 'v8-gathering'
};

const SILENT_SCREENS = ['world', 'field', 'training', 'event', 'inventory', 'debug'];

// All 18 bundled track ids (matches scripts/convert-bgm.mjs / assets/canonical/bgm/*.ogg).
const EXPECTED_TRACK_IDS = [
  'base', 'v1-moonlit', 'v2-daytime', 'v3-tense', 'v4-title', 'v5-loading', 'v6-cradle', 'v7-shop',
  'v8-gathering', 'v9-training', 'v10-arena', 'v11-alchemy', 'v12-workshop', 'v13-study', 'v14-library',
  'v15-atelier', 'v16-auction', 'v17-lounge'
];

function objectLiteralBlock(js, declaration) {
  // Grab the `const <name> = Object.freeze({ ... });` body for scoped assertions.
  const escaped = declaration.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return js.match(new RegExp(`${escaped}\\s*=\\s*Object\\.freeze\\(\\{([\\s\\S]*?)\\n\\}\\);`))?.[1] ?? '';
}

test('bgm: track catalog maps every bundled track id to its /canonical/bgm URL', async () => {
  const js = await readFile(appJsPath, 'utf8');
  const catalog = objectLiteralBlock(js, 'const BGM_TRACK_CATALOG');
  assert.notEqual(catalog, '', 'the BGM_TRACK_CATALOG config block is present');
  for (const trackId of EXPECTED_TRACK_IDS) {
    const key = /^[a-z]+$/.test(trackId) ? trackId : `'${trackId}'`;
    const pattern = new RegExp(`(?:^|\\n)\\s*${key}:\\s*'/canonical/bgm/${trackId}\\.ogg'`);
    assert.match(catalog, pattern, `catalog maps ${trackId} -> /canonical/bgm/${trackId}.ogg`);
  }
});

test('bgm: screen map is the brief closed写像 — 22 tracked screens, 6 silent screens absent', async () => {
  const js = await readFile(appJsPath, 'utf8');
  const map = objectLiteralBlock(js, 'const BGM_SCREEN_TRACKS');
  assert.notEqual(map, '', 'the BGM_SCREEN_TRACKS config block is present');

  // Every music screen resolves to exactly the brief's track.
  for (const [screenId, trackId] of Object.entries(EXPECTED_SCREEN_TRACKS)) {
    const key = /^[a-z]+$/.test(screenId) ? screenId : `'${screenId}'`;
    const pattern = new RegExp(`(?:^|\\n)\\s*${key}:\\s*'${trackId}'`);
    assert.match(map, pattern, `screen ${screenId} -> ${trackId}`);
  }

  // Silent screens (debug / legacy) never appear in the map — leaving them out is what makes them silent, and it
  // is deliberately distinct from an unknown screen id (which throws in showScreen).
  for (const screenId of SILENT_SCREENS) {
    const key = /^[a-z]+$/.test(screenId) ? screenId : `'${screenId}'`;
    const pattern = new RegExp(`(?:^|\\n)\\s*${key}:`);
    assert.doesNotMatch(map, pattern, `silent screen ${screenId} is absent from the map (→ 無音)`);
  }

  // The overlay override track is a named constant, not a screen-map entry (the garden is not a screen).
  assert.match(js, /const BGM_STAR_CRADLE_TRACK = 'v6-cradle';/, '星の揺り籠 override track is v6-cradle');
  assert.doesNotMatch(map, /cradle/, 'v6-cradle is an overlay override, not a screen-map entry');
});

test('bgm: showScreen fail-fasts on an unknown screen id and syncs BGM at the end', async () => {
  const js = await readFile(appJsPath, 'utf8');

  // Unknown screen id → throw at the showScreen entry (the 28 `screens` keys are the closed set).
  assert.match(
    js,
    /function showScreen\(name,[\s\S]*?if \(!Object\.hasOwn\(screens, name\)\) throw new Error\(`showScreen: unknown screen id \$\{name\}`\);/,
    'showScreen entry throws on an unknown screen id'
  );

  // The state sync is called once, at the very end of showScreen (after the active-class update and the guards).
  const showScreenBody = js.match(/function showScreen\(name,[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(showScreenBody, '', 'the showScreen body is present');
  assert.match(showScreenBody, /\n {2}syncBgmForUiState\(\);\n\}/, 'showScreen calls syncBgmForUiState() as its final step');
  assert.equal(
    (showScreenBody.match(/syncBgmForUiState\(\)/g) ?? []).length,
    1,
    'showScreen calls the sync exactly once'
  );
});

test('bgm: syncBgmForUiState computes desired from active screen + overlay override', async () => {
  const js = await readFile(appJsPath, 'utf8');
  const sync = js.match(/function syncBgmForUiState\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(sync, '', 'syncBgmForUiState is present');
  // Overlay override wins over the screen's own track.
  assert.match(sync, /if \(isRoutingHubStarCradleOpen\(\)\) \{\s*\n\s*target = BGM_STAR_CRADLE_TRACK;/, 'an open 星の揺り籠 overrides to v6-cradle');
  // A known screen with no mapped track resolves to null → silence (Object.hasOwn gate, no default fallback).
  assert.match(sync, /if \(screenName !== null && Object\.hasOwn\(BGM_SCREEN_TRACKS, screenName\)\) \{\s*\n\s*target = BGM_SCREEN_TRACKS\[screenName\];/, 'a mapped screen resolves to its track; an unmapped one stays null (silence)');
  assert.match(sync, /bgmController\.setDesiredTrack\(target\);/, 'the resolved target is handed to the controller');

  // currentActiveScreenName reads the single active screen from the `screens` map showScreen just set.
  assert.match(js, /function currentActiveScreenName\(\) \{[\s\S]*?element\.classList\.contains\('active'\)[\s\S]*?return screenName;/, 'the active screen is read from the class showScreen set');
});

test('bgm: the star cradle overlay open/close both drive the BGM sync', async () => {
  const js = await readFile(appJsPath, 'utf8');
  assert.match(js, /function openRoutingHubStarCradle\(\) \{[\s\S]*?overlay\.hidden = false;\s*\n\s*syncBgmForUiState\(\);/, 'opening the overlay syncs BGM (→ v6-cradle)');
  assert.match(js, /function closeRoutingHubStarCradle\(\) \{[\s\S]*?overlay\.hidden = true;\s*\n\s*syncBgmForUiState\(\);/, 'closing the overlay syncs BGM (→ current screen track)');
});

test('bgm: controller is a single-AudioContext owner with the no-op / generation / crossfade contract', async () => {
  const js = await readFile(appJsPath, 'utf8');
  const controller = js.match(/const bgmController = \(\(\) => \{[\s\S]*?\n\}\)\(\);/)?.[0] ?? '';
  assert.notEqual(controller, '', 'the bgmController IIFE is present');

  // Exactly one AudioContext for the whole document, created lazily (may start suspended in a browser).
  assert.match(controller, /function ensureAudioContext\(\) \{\s*\n\s*if \(audioContext\) return audioContext;/, 'the AudioContext is created once and reused');
  assert.match(controller, /const AudioContextCtor = window\.AudioContext \|\| window\.webkitAudioContext;/, 'the context uses the standard constructor');
  assert.match(controller, /if \(!AudioContextCtor\) throw new Error/, 'a runtime without Web Audio fail-fasts (no silent fallback)');
  assert.equal((controller.match(/new AudioContextCtor\(\)/g) ?? []).length, 1, 'only one AudioContext is ever constructed');

  // Same-desired no-op guard: never restart the current track.
  assert.match(controller, /function setDesiredTrack\(trackId\) \{[\s\S]*?if \(trackId === desiredTrackId\) return;/, 'setDesiredTrack no-ops when the desired track is unchanged');
  // Unknown track id in the catalog fail-fasts (config bug), null is the valid silence value.
  assert.match(controller, /if \(trackId !== null && !Object\.hasOwn\(BGM_TRACK_CATALOG, trackId\)\) \{\s*\n\s*throw new Error/, 'an unknown track id fail-fasts');

  // Generation token guards every async decode against reordering.
  assert.match(controller, /const generation = \(decodeGeneration \+= 1\);/, 'each reconcile takes a fresh generation');
  assert.match(controller, /if \(generation !== decodeGeneration\) return;/, 'a stale decode result is discarded');

  // Crossfade: new source starts at gain 0 ramping up while the old ramps down over BGM_CROSSFADE_SECONDS.
  assert.match(controller, /sourceNode\.loop = true;/, 'a track source loops');
  assert.match(controller, /gainNode\.gain\.linearRampToValueAtTime\(1, now \+ BGM_CROSSFADE_SECONDS\);/, 'the incoming voice fades in over the crossfade window');
  assert.match(controller, /function beginCrossfade\([\s\S]*?if \(currentVoice\) rampVoiceGain\(currentVoice, 0\);/, 'the outgoing voice fades out during the crossfade');

  // At most 2 voices (current + incoming); the old source/gain are stopped + disconnected after the crossfade.
  assert.match(controller, /function hardStopVoice\(voice\) \{[\s\S]*?voice\.sourceNode\.stop\(\);[\s\S]*?voice\.sourceNode\.disconnect\(\);\s*\n\s*voice\.gainNode\.disconnect\(\);/, 'a retired voice is stopped and disconnected (no cache 常駐)');
  assert.match(controller, /function beginCrossfade[\s\S]*?if \(incomingVoice\) \{\s*\n\s*hardStopVoice\(currentVoice\);/, 'a superseding crossfade collapses to keep at most 2 voices');

  // Decode/fetch failure → silence + console.error, never dragging the old track (no silent fallback).
  assert.match(controller, /console\.error\(`BGM: failed to load track \$\{target\} \(\$\{url\}\)`, error\);\s*\n\s*fadeToSilence\(generation\);/, 'a load failure drops to silence and surfaces the error');
});

test('bgm: a single master GainNode carries on/off + volume between the per-track voices and the destination', async () => {
  const js = await readFile(appJsPath, 'utf8');
  const controller = js.match(/const bgmController = \(\(\) => \{[\s\S]*?\n\}\)\(\);/)?.[0] ?? '';
  assert.notEqual(controller, '', 'the bgmController IIFE is present');

  // One master gain, created with the AudioContext, sitting between every per-track voice and the destination.
  assert.match(controller, /let masterGain = null;\s*\n\s*let masterGainValue = 1;/, 'the controller holds the single master gain node + its value (default 1 = the audio first-run contract)');
  assert.match(controller, /function ensureAudioContext\(\) \{[\s\S]*masterGain = audioContext\.createGain\(\);[\s\S]*masterGain\.gain\.setValueAtTime\(masterGainValue, audioContext\.currentTime\);[\s\S]*masterGain\.connect\(audioContext\.destination\);/, 'the master gain is created with the context and connected to the destination');
  // Per-track voices route through the master gain, not straight to the destination.
  assert.match(controller, /gainNode\.connect\(masterGain\);/, 'each per-track voice connects to the master gain');
  assert.doesNotMatch(controller, /gainNode\.connect\(audioContext\.destination\)/, 'per-track voices no longer connect straight to the destination (they go through the master gain)');

  // applyAudioSettings is the only volume/on-off seam: strict shape, master gain = enabled ? volume : 0, and it
  // never restarts the playing source (it only touches the master gain value).
  assert.match(controller, /function applyAudioSettings\(\{ bgm_enabled, bgm_volume \} = \{\}\) \{[\s\S]*if \(typeof bgm_enabled !== 'boolean'\)[\s\S]*throw new Error/, 'applyAudioSettings fail-fasts on a non-boolean bgm_enabled');
  assert.match(controller, /function applyAudioSettings\([\s\S]*if \(typeof bgm_volume !== 'number' \|\| !Number\.isFinite\(bgm_volume\) \|\| bgm_volume < 0 \|\| bgm_volume > 1\)[\s\S]*throw new Error/, 'applyAudioSettings fail-fasts on an out-of-range bgm_volume (no clamp)');
  assert.match(controller, /masterGainValue = bgm_enabled \? bgm_volume : 0;/, 'master gain value = bgm_enabled ? bgm_volume : 0');
  assert.match(controller, /function applyAudioSettings\([\s\S]*masterGain\.gain\.cancelScheduledValues\(now\);\s*\n\s*masterGain\.gain\.setValueAtTime\(masterGainValue, now\);/, 'applyAudioSettings changes only the master gain value (never restarts the source)');
  assert.doesNotMatch(js.match(/function applyAudioSettings\([\s\S]*?\n  \}/)?.[0] ?? '', /startVoice|beginCrossfade|setDesiredTrack|decodeGeneration/, 'applyAudioSettings must not touch the track / crossfade / generation machinery');

  // applyAudioSettings is on the controller's public API.
  assert.match(controller, /return \{ setDesiredTrack, applyAudioSettings \};/, 'the controller exposes applyAudioSettings alongside setDesiredTrack');
});

test('bgm: boot reads /api/settings/audio once and applies it; a failed read drops to silence + surfaces the error', async () => {
  const js = await readFile(appJsPath, 'utf8');

  const init = js.match(/async function initAudioSettings\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(init, '', 'initAudioSettings is present');
  assert.match(init, /bgmController\.applyAudioSettings\(await getJson\('\/api\/settings\/audio'\)\);/, 'boot GETs the persisted audio settings and applies them to the controller');
  // Failure posture: drop to silence (bgm_enabled:false), console.error, and surface via reportError — no default sound.
  assert.match(init, /bgmController\.applyAudioSettings\(\{ bgm_enabled: false, bgm_volume: 0 \}\);\s*\n\s*console\.error\([^\n]*audio settings[\s\S]*reportError\(error\);/, 'a failed boot read drops the master gain to silence and surfaces the error (no silent default)');

  // Called once at boot, on its own chain (not inside the initial-screen Promise.all).
  assert.equal((js.match(/initAudioSettings\(\)/g) ?? []).length, 2, 'initAudioSettings is defined once and invoked once at boot');
  assert.match(js, /\ninitAudioSettings\(\);\n/, 'boot invokes initAudioSettings on its own statement');
});

test('bgm: autoplay unlock resumes the context on the first user gesture', async () => {
  const js = await readFile(appJsPath, 'utf8');
  const controller = js.match(/const bgmController = \(\(\) => \{[\s\S]*?\n\}\)\(\);/)?.[0] ?? '';

  assert.match(controller, /function installAutoplayUnlock\(\) \{[\s\S]*?ensureAudioContext\(\)\.resume\(\)[\s\S]*?\.then\(reconcile\)/, 'the unlock resumes the context then plays the latest desired track');
  assert.match(controller, /document\.addEventListener\('click', unlock, \{ once: true \}\);/, 'a once click listener unlocks autoplay');
  assert.match(controller, /document\.addEventListener\('pointerdown', unlock, \{ once: true \}\);/, 'a once pointerdown listener unlocks autoplay');
  assert.match(controller, /\n\s*installAutoplayUnlock\(\);\n/, 'the unlock listener is installed at controller init');
});
