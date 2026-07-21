// Preload for bgmPlaybackRender.mjs. Runs before app.js (type=module) so it can wrap fetch / AudioContext /
// AudioBufferSourceNode before the boot showScreen fires its first BGM fetch. contextIsolation:false shares this
// `window` with the page. Records every /canonical/bgm/*.ogg fetch, counts source start()/stop(), captures the
// single AudioContext, and records uncaught window errors — all read back over CDP by the harness.
(() => {
  const RealAC = window.AudioContext || window.webkitAudioContext;
  const state = { fetches: [], starts: 0, stops: 0, ctx: null, errors: [] };
  window.__bgm = state;
  window.addEventListener('error', (e) => {
    state.errors.push(String((e && (e.message || (e.error && e.error.message))) || e));
  });
  class InstrumentedAudioContext extends RealAC {
    constructor(...args) { super(...args); state.ctx = this; }
  }
  window.AudioContext = InstrumentedAudioContext;
  window.webkitAudioContext = InstrumentedAudioContext;
  const realStart = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function start(...a) { state.starts += 1; return realStart.apply(this, a); };
  const realStop = AudioBufferSourceNode.prototype.stop;
  AudioBufferSourceNode.prototype.stop = function stop(...a) { state.stops += 1; return realStop.apply(this, a); };
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : ((input && input.url) || '');
    if (url.includes('/canonical/bgm/')) state.fetches.push(url.replace(/^https?:\/\/[^/]+/, ''));
    return realFetch(input, init);
  };
})();
