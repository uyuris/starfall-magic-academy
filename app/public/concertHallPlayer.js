// 奏楽堂 (concert hall) score player — DOM-independent, headless-testable.
//
// Plays a validated score JSON (the C-15 contract: absolute-beat note events per track, tempo, meter) through
// Web Audio using the bundled per-note OGG samples under /canonical/concert_hall/<instrument>/<midi>.ogg
// (rendered once from the MIT FluidR3Mono SoundFont). The player
// owns ONE AudioContext of its own — it never touches the screen-music (BGM) controller, its context, its
// master gain or the BGM on/off + volume settings; the concert hall screen is a silent BGM screen and the
// performance is this player's sound alone. Nothing here is imported from app.js: fetch and the AudioContext
// constructor are injected, so the unit tests drive it with stubs and the Blink harness with the real ones.
//
// Timing: seconds = start_beat × 60 / tempo (the beat is the meter's denominator note value, so 4/4 and 6/8
// convert with the same formula). Every note is scheduled up front with exactly one source.start(when) —
// a piece is a few hundred notes, well within what one forward schedule handles (no lookahead timer).
//
// Fail-fast: an instrument outside the closed set, a note outside the sampled range, a non-2xx sample fetch or a
// decode failure throws and the performance never starts (no partial performance with silently skipped voices).

// The instrument closed set, mirroring CONCERT_HALL_INSTRUMENTS (app/src/concertHallCatalog.mjs); the unit test
// pins the two to be equal so a catalog addition without a rendered sample set fails there, not on stage.
export const CONCERT_HALL_INSTRUMENTS = Object.freeze(['piano', 'harp', 'celesta', 'vibraphone', 'strings', 'flute']);

// The sampled keys: every 3 semitones from C2 (36) to C7 (96) = 21 keys per instrument. Any note between two keys
// is pitch-shifted from the NEAREST sample (≤ 1 semitone away, so the formant drift stays inaudible).
export const CONCERT_HALL_SAMPLE_KEYS = Object.freeze(Array.from({ length: 21 }, (_unused, index) => 36 + index * 3));

export const CONCERT_HALL_PLAYER_STATES = Object.freeze(['idle', 'loading', 'ready', 'playing', 'stopped']);

// Bounded sample fetch concurrency (a score uses ≤ 3 instruments × ≤ 21 keys).
const SAMPLE_FETCH_CONCURRENCY = 6;
// Scheduling lead so the first note is never in the past when the schedule is built.
const START_LEAD_SECONDS = 0.1;
// Release: a sample that sustains past its note is faded out by gain over this tail after the note ends.
const RELEASE_SECONDS = 0.08;
// Progress clock tick (the clock reads ctx.currentTime; the interval only paces the callbacks).
const TICK_INTERVAL_MS = 100;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The nearest sampled key for a MIDI note. Notes outside the sampled span are refused (the sample set covers
// C2〜C7 which contains every role range of the score contract).
export function concertHallNearestSampleKey(midi) {
  if (!Number.isInteger(midi)) throw new Error(`concert hall player: midi must be an integer: ${midi}`);
  const lowest = CONCERT_HALL_SAMPLE_KEYS[0];
  const highest = CONCERT_HALL_SAMPLE_KEYS[CONCERT_HALL_SAMPLE_KEYS.length - 1];
  if (midi < lowest || midi > highest) throw new Error(`concert hall player: midi ${midi} is outside the sampled span ${lowest}〜${highest}`);
  let nearest = CONCERT_HALL_SAMPLE_KEYS[0];
  for (const key of CONCERT_HALL_SAMPLE_KEYS) if (Math.abs(key - midi) < Math.abs(nearest - midi)) nearest = key;
  return nearest;
}

// playbackRate for shifting a sample recorded at `sampleKey` to `midi`: 2^(Δ/12).
export function concertHallPlaybackRate(midi, sampleKey) {
  return 2 ** ((midi - sampleKey) / 12);
}

// The seconds offset of a beat at a tempo (beats per minute of the meter's denominator unit).
export function concertHallBeatSeconds(beat, tempo) {
  return beat * 60 / tempo;
}

// The unique (instrument, sampleKey) pairs a score needs, in track order.
export function concertHallRequiredSamples(score) {
  const seen = new Map();
  for (const track of score.tracks) {
    if (!CONCERT_HALL_INSTRUMENTS.includes(track.instrument)) throw new Error(`concert hall player: instrument is not in the closed set: ${track.instrument}`);
    for (const note of track.notes) {
      const key = concertHallNearestSampleKey(note.midi);
      const id = `${track.instrument}/${key}`;
      if (!seen.has(id)) seen.set(id, { instrument: track.instrument, key });
    }
  }
  return [...seen.values()];
}

// Section boundaries in absolute beats, for the progress clock (現在の節).
export function concertHallSectionSpans(score) {
  const beatsPerBar = Number(score.meter.split('/')[0]);
  let offset = 0;
  return score.sections.map((section, index) => {
    const span = { index, name: section.name, startBeat: offset, endBeat: offset + section.bars * beatsPerBar };
    offset = span.endBeat;
    return span;
  });
}

// Total length in beats (the sum of the sections), the same total the score validator enforces.
export function concertHallTotalBeats(score) {
  const spans = concertHallSectionSpans(score);
  return spans.length ? spans[spans.length - 1].endBeat : 0;
}

function assertScoreShape(score) {
  if (!isObject(score)) throw new Error('concert hall player: score must be an object');
  if (!Number.isInteger(score.tempo) || score.tempo <= 0) throw new Error(`concert hall player: score.tempo must be a positive integer: ${score.tempo}`);
  if (typeof score.meter !== 'string' || !/^\d+\/\d+$/.test(score.meter)) throw new Error(`concert hall player: score.meter must be n/d: ${score.meter}`);
  if (!Array.isArray(score.sections) || score.sections.length === 0) throw new Error('concert hall player: score.sections must be a non-empty array');
  if (!Array.isArray(score.tracks) || score.tracks.length === 0) throw new Error('concert hall player: score.tracks must be a non-empty array');
  for (const track of score.tracks) {
    if (!isObject(track) || !Array.isArray(track.notes)) throw new Error('concert hall player: every track must carry a notes array');
    for (const note of track.notes) {
      if (!isObject(note) || !Number.isInteger(note.midi) || !Number.isFinite(note.start_beat) || !Number.isFinite(note.duration_beats) || note.duration_beats <= 0 || !Number.isInteger(note.velocity)) {
        throw new Error('concert hall player: every note must carry integer midi / velocity and finite start_beat / positive duration_beats');
      }
    }
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => lane()));
  return results;
}

// createConcertHallPlayer({ fetchImpl, audioContextFactory, sampleBaseUrl }) → { load, play, stop, tick, state,
// liveSourceCount }. fetchImpl is the fetch used for the sample files; audioContextFactory() returns the ONE
// AudioContext the player owns (created lazily on the first play — inside the user's click, so autoplay policy
// is satisfied by this player alone); sampleBaseUrl is the served prefix ('/canonical/concert_hall/').
export function createConcertHallPlayer({ fetchImpl, audioContextFactory, sampleBaseUrl }) {
  if (typeof fetchImpl !== 'function') throw new Error('concert hall player: fetchImpl must be a function');
  if (typeof audioContextFactory !== 'function') throw new Error('concert hall player: audioContextFactory must be a function');
  if (typeof sampleBaseUrl !== 'string' || !sampleBaseUrl.endsWith('/')) throw new Error('concert hall player: sampleBaseUrl must be a string ending with /');

  let state = 'idle';
  let ctx = null;
  let loadedScore = null;
  // (instrument/key) → decoded AudioBuffer for the loaded score only (released on the next load).
  let buffers = new Map();
  // Every source started by the current performance that has not yet ended.
  const liveSources = new Set();
  let performance = null;

  function ensureContext() {
    if (ctx) return ctx;
    ctx = audioContextFactory();
    if (!ctx || typeof ctx.createBufferSource !== 'function') throw new Error('concert hall player: audioContextFactory must return an AudioContext');
    return ctx;
  }

  async function fetchSample({ instrument, key }) {
    const url = `${sampleBaseUrl}${instrument}/${key}.ogg`;
    const response = await fetchImpl(url);
    if (!response || !response.ok) throw new Error(`concert hall player: sample fetch failed (${response?.status ?? 'no response'}): ${url}`);
    const bytes = await response.arrayBuffer();
    const buffer = await ensureContext().decodeAudioData(bytes);
    if (!buffer) throw new Error(`concert hall player: sample decode returned nothing: ${url}`);
    return buffer;
  }

  // Fetch + decode every sample the score needs (all awaited BEFORE the state turns ready — a missing sample
  // is a throw here, never a silent gap on stage).
  async function load(score) {
    if (state === 'playing') throw new Error('concert hall player: load while playing (stop first)');
    assertScoreShape(score);
    const required = concertHallRequiredSamples(score);
    state = 'loading';
    loadedScore = null;
    buffers = new Map();
    try {
      const decoded = await mapWithConcurrency(required, SAMPLE_FETCH_CONCURRENCY, fetchSample);
      required.forEach((sample, index) => buffers.set(`${sample.instrument}/${sample.key}`, decoded[index]));
      loadedScore = score;
      state = 'ready';
    } catch (error) {
      buffers = new Map();
      state = 'idle';
      throw error;
    }
    return { samples: required.length };
  }

  function scheduleNote(track, note, t0, tempo) {
    const context = ensureContext();
    const key = concertHallNearestSampleKey(note.midi);
    const buffer = buffers.get(`${track.instrument}/${key}`);
    if (!buffer) throw new Error(`concert hall player: sample not loaded: ${track.instrument}/${key}`);
    const when = t0 + concertHallBeatSeconds(note.start_beat, tempo);
    const noteEnd = when + concertHallBeatSeconds(note.duration_beats, tempo);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = concertHallPlaybackRate(note.midi, key);
    const gain = context.createGain();
    const level = note.velocity / 127;
    gain.gain.setValueAtTime(level, when);
    gain.gain.setValueAtTime(level, noteEnd);
    gain.gain.linearRampToValueAtTime(0, noteEnd + RELEASE_SECONDS);
    source.connect(gain);
    gain.connect(performance.master);
    liveSources.add(source);
    source.onended = () => {
      liveSources.delete(source);
      source.disconnect();
      gain.disconnect();
    };
    source.start(when);
    source.stop(noteEnd + RELEASE_SECONDS);
    return noteEnd + RELEASE_SECONDS;
  }

  // The progress clock: reads the context clock, reports the beat / current section, and ends the performance
  // once the last note (plus its release) has passed. Public so a test can step it deterministically.
  function tick() {
    if (state !== 'playing' || !performance) return null;
    const context = ensureContext();
    const elapsed = context.currentTime - performance.t0;
    const beat = Math.max(0, elapsed * performance.tempo / 60);
    const span = performance.spans.find((candidate) => beat < candidate.endBeat) ?? performance.spans[performance.spans.length - 1];
    if (span.index !== performance.sectionIndex) {
      performance.sectionIndex = span.index;
      performance.onSection?.({ index: span.index, name: span.name });
    }
    const progress = { beat: Math.min(beat, performance.totalBeats), totalBeats: performance.totalBeats, seconds: Math.max(0, elapsed), sectionIndex: span.index };
    performance.onProgress?.(progress);
    if (context.currentTime >= performance.endsAt) {
      finish({ ended: true });
    }
    return progress;
  }

  function finish({ ended }) {
    if (!performance) return;
    const { onEnded, timer } = performance;
    if (timer !== null) clearInterval(timer);
    for (const source of liveSources) {
      source.stop();
      source.disconnect();
    }
    liveSources.clear();
    performance.master.disconnect();
    performance = null;
    state = 'stopped';
    ensureContext().suspend();
    if (ended) onEnded?.();
  }

  // Start the loaded score: resume the context (inside the click), then schedule every note once and run the
  // progress clock. onSection({index, name}) fires on each section entry, onProgress({beat, totalBeats, seconds,
  // sectionIndex}) on every tick, onEnded() once when the piece has run out (not on stop()).
  async function play({ onSection = null, onEnded = null, onProgress = null } = {}) {
    if (state !== 'ready' && state !== 'stopped') throw new Error(`concert hall player: play requires a loaded score (state ${state})`);
    if (!loadedScore) throw new Error('concert hall player: no score loaded');
    const context = ensureContext();
    if (context.state !== 'running') await context.resume();
    const master = context.createGain();
    master.gain.value = 1;
    master.connect(context.destination);
    const spans = concertHallSectionSpans(loadedScore);
    const t0 = context.currentTime + START_LEAD_SECONDS;
    performance = { t0, tempo: loadedScore.tempo, spans, totalBeats: concertHallTotalBeats(loadedScore), sectionIndex: -1, master, onSection, onEnded, onProgress, endsAt: t0, timer: null };
    state = 'playing';
    let endsAt = t0;
    for (const track of loadedScore.tracks) {
      for (const note of track.notes) endsAt = Math.max(endsAt, scheduleNote(track, note, t0, loadedScore.tempo));
    }
    performance.endsAt = endsAt;
    performance.timer = setInterval(tick, TICK_INTERVAL_MS);
    tick();
    return { notes: liveSources.size, endsAt };
  }

  // Stop the performance now: every live source is stopped and disconnected, the context is suspended.
  function stop() {
    if (state !== 'playing') return;
    finish({ ended: false });
  }

  return {
    load,
    play,
    stop,
    tick,
    get state() { return state; },
    get liveSourceCount() { return liveSources.size; }
  };
}
