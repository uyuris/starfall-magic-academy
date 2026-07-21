#!/usr/bin/env node
// Convert the adopted BGM takes from their preserved source WAVs into bundled Ogg Opus tracks.
//
// The authored TRACK_SOURCES table below is the single source of truth for take selection
// (track id -> repo-relative source WAV). Swapping a take means editing this table and
// re-running the script for that track; the output name and served URL never change.
//
// Sources live under the gitignored 原本庫 assets/original/; outputs are the git-tracked
// bundled assets under assets/canonical/bgm/<track_id>.ogg served via /canonical/bgm/*.ogg.
//
// Fail-fast: a missing source WAV, an ffmpeg failure, or a zero-byte output aborts the whole
// run with a nonzero exit. There is no partial-success exit and no fallback encoder.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Default takes are all seed20260719 per the screen-music brief's take discipline.
const TRACK_SOURCES = {
  base: 'assets/original/bgm_sa3_batch1/batch1/starfall_base_120s_seed20260719.wav',
  'v1-moonlit': 'assets/original/bgm_sa3_batch1/batch1/starfall_v1-moonlit_120s_seed20260719.wav',
  'v2-daytime': 'assets/original/bgm_sa3_batch1/batch1/starfall_v2-daytime_120s_seed20260719.wav',
  'v3-tense': 'assets/original/bgm_sa3_batch1/batch1/starfall_v3-tense_120s_seed20260719.wav',
  'v4-title': 'assets/original/bgm_sa3_batch2/starfall_v4-title_120s_seed20260719.wav',
  'v5-loading': 'assets/original/bgm_sa3_batch2/starfall_v5-loading_120s_seed20260719.wav',
  'v6-cradle': 'assets/original/bgm_sa3_batch2/starfall_v6-cradle_120s_seed20260719.wav',
  'v7-shop': 'assets/original/bgm_sa3_batch2/starfall_v7-shop_120s_seed20260719.wav',
  'v8-gathering': 'assets/original/bgm_sa3_batch2/starfall_v8-gathering_120s_seed20260719.wav',
  'v9-training': 'assets/original/bgm_sa3_batch2/starfall_v9-training_120s_seed20260719.wav',
  'v10-arena': 'assets/original/bgm_sa3_batch2/starfall_v10-arena_120s_seed20260719.wav',
  'v11-alchemy': 'assets/original/bgm_sa3_batch2/starfall_v11-alchemy_120s_seed20260719.wav',
  'v12-workshop': 'assets/original/bgm_sa3_batch2/starfall_v12-workshop_120s_seed20260719.wav',
  'v13-study': 'assets/original/bgm_sa3_batch2/starfall_v13-study_120s_seed20260719.wav',
  'v14-library': 'assets/original/bgm_sa3_batch2/starfall_v14-library_120s_seed20260719.wav',
  'v15-atelier': 'assets/original/bgm_sa3_batch2/starfall_v15-atelier_120s_seed20260719.wav',
  'v16-auction': 'assets/original/bgm_sa3_batch2/starfall_v16-auction_120s_seed20260719.wav',
  'v17-lounge': 'assets/original/bgm_sa3_batch2/starfall_v17-lounge_120s_seed20260719.wav'
};

const OUTPUT_DIR = 'assets/canonical/bgm';
const OPUS_BITRATE = '160k';

if (!ffmpegPath || !existsSync(ffmpegPath)) {
  throw new Error(`ffmpeg-static binary is not available at ${ffmpegPath}`);
}

const outputDirAbs = path.join(repoRoot, OUTPUT_DIR);
mkdirSync(outputDirAbs, { recursive: true });

const converted = [];
for (const [trackId, sourceRelative] of Object.entries(TRACK_SOURCES)) {
  const sourceAbs = path.join(repoRoot, sourceRelative);
  if (!existsSync(sourceAbs)) {
    throw new Error(`source WAV missing for track ${trackId}: ${sourceRelative}`);
  }
  const outputAbs = path.join(outputDirAbs, `${trackId}.ogg`);
  // libopus internally resamples to 48kHz; the .ogg container muxes it as Ogg Opus.
  execFileSync(ffmpegPath, [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i', sourceAbs,
    '-map', '0:a',
    '-c:a', 'libopus',
    '-b:a', OPUS_BITRATE,
    '-vbr', 'on',
    outputAbs
  ], { stdio: ['ignore', 'ignore', 'inherit'] });

  if (!existsSync(outputAbs)) {
    throw new Error(`ffmpeg reported success but produced no output for track ${trackId}: ${outputAbs}`);
  }
  const { size } = statSync(outputAbs);
  if (size === 0) {
    throw new Error(`zero-byte output for track ${trackId}: ${outputAbs}`);
  }
  converted.push({ trackId, output: path.join(OUTPUT_DIR, `${trackId}.ogg`), bytes: size });
}

console.log(`converted ${converted.length} BGM tracks to ${OUTPUT_DIR}`);
for (const { trackId, output, bytes } of converted) {
  console.log(`  ${trackId} -> ${output} (${bytes} bytes)`);
}
