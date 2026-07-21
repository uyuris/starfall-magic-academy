// Reusable conversation-stage component (shared 部品).
//
// A conversation stage is the routing-hub-style 会話画面: a themed backdrop + ambient, a standee /
// speaker caption, a clean chat surface (own history / stream / status / cooldown-paced reveal queue),
// a left category rail with an info drawer, and a week / moon topbar. The routing hub is the first
// consumer; the daytime 会話専用画面 will be the second. To keep those two from forking the mechanics,
// this module owns the INVARIANT machinery and is parameterized on two axes:
//
//   1. スコープ / テーマ軸 — the screen scope selectors, design-token-driven assets, and the ambient
//      strategy (starfield 等) are injected via config (selectors + a pluggable `ambient`).
//   2. 会話種別軸 — the displayed actor (persona visual / assistant identity), the info-drawer category
//      set + per-category renderers, and the week source are injected via config. The turn execution
//      (stream runner, conversation-id policy, in-turn dispatch/draining seams) stays in the consumer,
//      which drives it through this stage's chat-surface + reveal-queue primitives.
//
//   3. 不変の共通メカニクス (owned here, not swappable): the 完成吹き出し単位・等間隔・pop-in reveal
//      queue; the at-bottom gate (+ face-image load re-pin) and status-toggle re-pin; no in-progress
//      status text (error banner only); the info drawer open/close/switch/rail-select and its固定
//      カテゴリ集合 fail-fast; the week/moon fail-fast. Shared app helpers (displayMessages,
//      createMessageRows, messagesFromConversation, cooldown, sleep, setActorImageSource) are injected
//      as `deps` so this module stays decoupled from app.js.
//
// The DOM-independent pieces below (reveal queue, week/moon math, at-bottom geometry, category-title
// validation, star lattice) are exported separately so they are headless unit-testable, the same
// split as routingDispatchClient.js / dungeonCamera.js / mapHoverPlacement.js.

// ── DOM-independent, headless-testable helpers ───────────────────────────────

// The week number shown on the stage (1-based). A missing / non-finite / negative elapsed_weeks is
// broken runtime state, not a cue to fabricate week 1 or silently clamp — fail fast so it surfaces.
export function conversationStageWeek(elapsedWeeks) {
  const elapsed = Number(elapsedWeeks);
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    throw new Error(`conversation stage week requires a valid elapsed_weeks, got ${JSON.stringify(elapsedWeeks)}`);
  }
  return elapsed + 1;
}

// The canonical at-bottom gate threshold (px). A face-image row-height wobble within this band still
// counts as "at bottom". Named so the sole caller passes it explicitly (no default-value fallback).
export const CONVERSATION_STAGE_STICK_THRESHOLD_PX = 24;

// The moon-phase index (0-based) for a 1-based week over an N-phase cycle. phaseCount is required and
// validated: a missing / invalid cycle length is a broken consumer config, not a cue to silently assume 8
// (no default-value fallback — fail fast so the bad config surfaces).
export function conversationStageMoonPhase(week, phaseCount) {
  if (!Number.isInteger(phaseCount) || phaseCount <= 0) {
    throw new Error(`conversation stage moon phase requires a positive integer phaseCount, got ${JSON.stringify(phaseCount)}`);
  }
  return (week - 1) % phaseCount;
}

// The moon-phase image set shipped under assets/canonical/moon_phases/ (phase_0.jpg … phase_7.jpg), served at
// /canonical/moon_phases/. Every consuming stage's week→phase cycle length (moonPhaseCount) must equal this;
// a mismatch is a broken consumer config, never a cue to silently glyph-render or assume a set size.
export const MOON_PHASE_IMAGE_COUNT = 8;

// The delivered asset route for a 0-based phase index. Pure so it is unit-testable without the DOM. The phase
// must be a valid index into the image set — an out-of-range phase is a broken caller, not a cue to clamp or
// wrap (fail fast; the sole caller feeds a conversationStageMoonPhase result over the validated cycle length).
export function conversationStageMoonImageUrl(phase) {
  if (!Number.isInteger(phase) || phase < 0 || phase >= MOON_PHASE_IMAGE_COUNT) {
    throw new Error(`conversation stage moon image requires a phase in [0, ${MOON_PHASE_IMAGE_COUNT}), got ${JSON.stringify(phase)}`);
  }
  return `/canonical/moon_phases/phase_${phase}.jpg`;
}

// True when a scroll container is within `threshold` px of the bottom (the at-bottom gate). Pure geometry
// over the three scroll metrics so the stick decision is unit-testable without a live element. threshold is
// required (the caller passes CONVERSATION_STAGE_STICK_THRESHOLD_PX) — no default-value fallback.
export function conversationStageStreamIsAtBottom({ scrollHeight, scrollTop, clientHeight }, threshold) {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

// Resolve the drawer title for a category against the fixed category-title set. An unknown category is a
// contract break (broken data-* wiring), not a state to paper over with a generic title — fail fast.
export function resolveConversationStageInfoCategoryTitle(category, titles) {
  const title = titles[category];
  if (!title) {
    throw new Error(`unknown conversation stage info category: ${JSON.stringify(category)}`);
  }
  return title;
}

// One sequential reveal queue for a turn: every 完成した吹き出し単位 — the player's own utterance segments
// AND the assistant's 発話/地の文/見送り segments — is pushed here and revealed one at a time, なるべく
// 等間隔 (the injected cooldown) に、pop-in 付きで順に現れる。ストリーミング応答も途中の文字を随時流し込む
// のではなく、吹き出し完成単位でこのキューに乗せる (複数吹き出しが一度に届いてもまとめず等間隔で順に出す)。
// All side effects are injected: `cooldownMs()` picks the interval each time (so a settings change is
// honoured), `sleep(ms)` paces it, and `render(revealed)` paints the revealed segments (the consumer's
// closure decides base messages + pop index). The gate carries the remaining cooldown across pump
// restarts so no 吹き出し ever appears sooner than the cooldown after the prior one — even when segments
// arrive in separate bursts (delta then complete).
export function createConversationStageTurnReveal({ cooldownMs, sleep, render }) {
  const revealed = [];
  const pending = [];
  let running = false;
  let cancelled = false;
  let loopPromise = Promise.resolve();
  let cooldownGate = Promise.resolve();

  function pump() {
    if (running) return loopPromise;
    running = true;
    loopPromise = (async () => {
      try {
        while (pending.length > 0 && !cancelled) {
          await cooldownGate;
          if (cancelled) break;
          revealed.push(pending.shift());
          render(revealed);
          cooldownGate = sleep(cooldownMs());
        }
      } finally {
        running = false;
      }
    })();
    return loopPromise;
  }

  return {
    enqueue(segments) {
      if (cancelled) return;
      const usable = segments.filter((segment) => (segment.content ?? '').trim());
      if (!usable.length) return;
      pending.push(...usable);
      pump();
    },
    async drain() {
      while (!cancelled && (pending.length > 0 || running)) {
        await loopPromise;
      }
    },
    cancel() { cancelled = true; }
  };
}

// Deterministic-ish star spread without Math.random: a low-discrepancy lattice keeps the field even and
// avoids depending on RNG (unavailable / non-reproducible here). Pure so the lattice is unit-testable.
export function buildConversationStageStars(width, height, count) {
  const stars = [];
  for (let i = 0; i < count; i += 1) {
    const x = ((i * 97) % 1000) / 1000 * width;
    const y = ((i * 61) % 1000) / 1000 * height;
    const radius = 0.6 + ((i * 7) % 10) / 10 * 1.2;
    const phase = ((i * 13) % 100) / 100 * Math.PI * 2;
    const speed = 0.6 + ((i * 5) % 10) / 10 * 0.8;
    stars.push({ x, y, radius, phase, speed });
  }
  return stars;
}

// ── Ambient strategy: canvas starfield ───────────────────────────────────────
// A pluggable ambient (axis 1): the stage calls start()/stop(); a different consumer can pass a
// different ambient object with the same shape. The starfield drifts + twinkles behind the stage as the
// ambient 凪; prefers-reduced-motion draws a single static field and runs no rAF loop (the mode is
// surfaced on the canvas dataset so it is observable).
export function createStarfieldAmbient({ canvasSelector, starColorRgb, starCount }) {
  // starCount is required and validated (no default-value fallback): a missing count is a broken consumer
  // config, not a cue to silently assume a field size.
  if (!Number.isInteger(starCount) || starCount <= 0) {
    throw new Error(`conversation stage starfield ambient requires a positive integer starCount, got ${JSON.stringify(starCount)}`);
  }
  const reducedMotion = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false };
  let frame = null;
  let stars = null;

  function draw(ctx, width, height, t) {
    ctx.clearRect(0, 0, width, height);
    for (const star of stars) {
      const twinkle = reducedMotion.matches ? 0.7 : 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * 0.001 * star.speed + star.phase));
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${starColorRgb}, ${twinkle.toFixed(3)})`;
      ctx.fill();
    }
  }

  return {
    start() {
      const canvas = document.querySelector(canvasSelector);
      if (!canvas || typeof canvas.getContext !== 'function') return;
      const width = canvas.clientWidth || canvas.width || 800;
      const height = canvas.clientHeight || canvas.height || 450;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      stars = buildConversationStageStars(width, height, starCount);
      if (frame) cancelAnimationFrame(frame);
      if (reducedMotion.matches) {
        canvas.dataset.starfield = 'static';
        draw(ctx, width, height, 0);
        return;
      }
      canvas.dataset.starfield = 'animated';
      let startTime = null;
      const loop = (time) => {
        if (startTime === null) startTime = time;
        draw(ctx, width, height, time - startTime);
        frame = requestAnimationFrame(loop);
      };
      frame = requestAnimationFrame(loop);
    },
    stop() {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    }
  };
}

// ── DOM factory: the conversation stage controller ───────────────────────────
// Builds a stage controller over one screen scope. `config` carries axis 1 (scope selectors, assets,
// ambient) + axis 2 (persona visual, assistant identity, info categories, week source); `deps` carries
// the shared app helpers. The invariant mechanics live here. Construction touches no DOM (every method
// resolves its nodes lazily), so a consumer can build the stage at module-eval time.
export function createConversationStage(config, deps) {
  const el = (selector) => document.querySelector(selector);
  // Own the stage's chat history and ambient / flash timers (per-stage state).
  let history = [];
  let playerSpokeTimer = null;
  let dispatchClimaxTimer = null;

  const stage = {
    getHistory() { return history; },
    setHistory(messages) { history = messages; },

    streamIsAtBottom(stream) {
      return conversationStageStreamIsAtBottom({
        scrollHeight: stream.scrollHeight,
        scrollTop: stream.scrollTop,
        clientHeight: stream.clientHeight
      }, CONVERSATION_STAGE_STICK_THRESHOLD_PX);
    },

    // Render the message stream. Only sticks to the bottom when the reader was already there (preserves a
    // scrolled-up read position), and never offers an edit affordance (allowEdit=false) so the stage has
    // no edit path that could drop the conversation context. When sticking, re-pin after each face image
    // finishes loading: a face grows its row height AFTER the initial scroll, which would otherwise leave
    // the newest message pushed below the fold (the "new utterance added off-screen" defect).
    renderStream(messages = history, { popFromDisplayIndex = -1 } = {}) {
      history = messages;
      const stream = el(config.streamSelector);
      if (!stream) return;
      const stick = stage.streamIsAtBottom(stream);
      stream.replaceChildren(...deps.createMessageRows(deps.displayMessages(messages), popFromDisplayIndex, false));
      if (!stick) return;
      stream.scrollTop = stream.scrollHeight;
      for (const image of stream.querySelectorAll('.message-face img')) {
        if (image.complete) continue;
        image.addEventListener('load', () => { stream.scrollTop = stream.scrollHeight; }, { once: true });
      }
    },

    // Immediate status write to the stage's own live region (no rAF debounce). The stage surfaces no
    // in-progress progress text — the responding glow conveys that a turn is in flight — so this live
    // region carries the error banner only. The status line claims layout height when shown, so toggling
    // it shrinks the stream's clientHeight: sample the at-bottom state BEFORE the toggle and re-pin to the
    // bottom after it when — and only when — the reader was there, so toggling never breaks bottom-follow;
    // a scrolled-up reader is left in place.
    setStatus(text, { tone = '' } = {}) {
      const status = el(config.statusSelector);
      if (!status) return;
      const stream = el(config.streamSelector);
      const stick = stream ? stage.streamIsAtBottom(stream) : false;
      const message = String(text ?? '').trim();
      if (!message) {
        status.hidden = true;
        status.textContent = '';
        delete status.dataset.tone;
      } else {
        status.hidden = false;
        status.textContent = message;
        status.dataset.tone = tone;
      }
      if (stick && stream) stream.scrollTop = stream.scrollHeight;
    },

    setControlsDisabled(disabled) {
      for (const selector of config.controlSelectors) {
        const element = el(selector);
        if (element) element.disabled = disabled;
      }
    },

    // The chat surface the shared reveal / SSE helpers consume (getHistory/setHistory/render/mapMessages/
    // assistantIdentity/commitState/refresh over this stage's own history — never the shared academy chat).
    surface: {
      getHistory: () => history,
      setHistory: (messages) => { history = messages; },
      render: (messages, options) => stage.renderStream(messages, options),
      mapMessages: (conversation) => deps.messagesFromConversation(conversation),
      assistantIdentity: () => config.assistantIdentity(),
      commitState: (result) => { history = deps.messagesFromConversation(result.conversation); },
      refresh: () => config.refresh()
    },

    // A cooldown-paced reveal queue for one turn. The render closure paints [base, ...revealed] with only
    // the newest revealed segment popping in (popFromDisplayIndex = its display index); feeding
    // already-split display segments back through displayMessages is idempotent.
    createTurnReveal(baseMessages) {
      const baseDisplayCount = deps.displayMessages(baseMessages).length;
      return createConversationStageTurnReveal({
        cooldownMs: deps.conversationPopupCooldownMs,
        sleep: deps.sleep,
        render: (revealed) => stage.renderStream([...baseMessages, ...revealed], {
          popFromDisplayIndex: baseDisplayCount + revealed.length - 1
        })
      });
    },

    // ── Week / moon topbar ──
    // The moon is a real image asset (a circular-framed phase render), not a CSS glyph: the frame element holds
    // one <img> whose src is the phase's canonical asset and whose alt carries the phase's accessible label. The
    // consuming stage's cycle length must equal the shipped image set — a mismatch throws rather than silently
    // glyph-degrading or assuming a set size. A missing asset surfaces as an ordinary <img> load failure (no
    // placeholder fallback is fabricated).
    renderWeekAndMoon() {
      const week = config.currentWeek();
      const weekEl = el(config.weekSelector);
      if (weekEl) weekEl.textContent = config.weekLabel(week, config.weekTotal);
      const moonEl = el(config.moonSelector);
      if (moonEl) {
        if (config.moonPhaseCount !== MOON_PHASE_IMAGE_COUNT) {
          throw new Error(`conversation stage moon requires moonPhaseCount to equal the ${MOON_PHASE_IMAGE_COUNT}-image set, got ${JSON.stringify(config.moonPhaseCount)}`);
        }
        const phase = conversationStageMoonPhase(week, config.moonPhaseCount);
        const label = config.moonAriaLabel(phase, config.moonPhaseCount);
        let image = moonEl.querySelector('img');
        if (!image) {
          image = document.createElement('img');
          image.className = 'moon-phase-image';
          moonEl.replaceChildren(image);
        }
        image.src = conversationStageMoonImageUrl(phase);
        image.alt = label;
      }
    },

    // ── Ambient ──
    startAmbient() { config.ambient.start(); },
    stopAmbient() { config.ambient.stop(); },

    // ── Conversation-responsive flashes (screen-level classes the CSS animates) ──
    setResponding(on) {
      const screen = el(config.screenSelector);
      if (screen) screen.classList.toggle(config.respondingClass, Boolean(on));
    },
    flashPlayerSpoke() {
      const screen = el(config.screenSelector);
      if (!screen) return;
      screen.classList.remove(config.playerSpokeClass);
      // Force reflow so re-adding the class restarts the animation.
      void screen.offsetWidth;
      screen.classList.add(config.playerSpokeClass);
      if (playerSpokeTimer) clearTimeout(playerSpokeTimer);
      playerSpokeTimer = setTimeout(() => {
        screen.classList.remove(config.playerSpokeClass);
        playerSpokeTimer = null;
      }, config.playerSpokeMs);
    },
    flashDispatchClimax() {
      const screen = el(config.screenSelector);
      if (!screen) return;
      screen.classList.add(config.dispatchClimaxClass);
      if (dispatchClimaxTimer) clearTimeout(dispatchClimaxTimer);
      dispatchClimaxTimer = setTimeout(() => {
        screen.classList.remove(config.dispatchClimaxClass);
        dispatchClimaxTimer = null;
      }, config.dispatchClimaxMs);
    },

    // ── Info drawer (category rail → drawer) ──
    // Open is unconditional (no already-open guard): opening while already open re-renders the body,
    // re-sets the header/icon, and re-marks the selected rail button, so a category switch swaps content +
    // selection without closing. Fail-fast on an unknown category / missing popup nodes / missing header
    // icon node — broken data-* wiring or markup, never a generic-title / silent no-op degrade.
    openInfo(category) {
      const categoryTitle = resolveConversationStageInfoCategoryTitle(category, config.categoryTitles);
      const popup = el(config.infoPopupSelector);
      const title = el(config.infoTitleSelector);
      const bodyEl = el(config.infoBodySelector);
      if (!popup || !title || !bodyEl) {
        throw new Error('conversation stage info popup nodes are missing (broken markup wiring)');
      }
      const icon = el(config.infoIconSelector);
      if (!icon) {
        throw new Error('conversation stage info popup icon node is missing (broken markup wiring)');
      }
      title.textContent = categoryTitle;
      icon.src = config.categoryIconUrl(category);
      stage.renderInfoCategory(category, bodyEl);
      popup.hidden = false;
      popup.dataset.category = category;
      stage.setActiveCategory(category);
    },
    // Exactly one category button carries the selected state while its drawer is open; all are cleared on
    // close (category=null). Keyed off the same data-* category wiring.
    setActiveCategory(category) {
      for (const button of document.querySelectorAll(config.categoryButtonSelector)) {
        const isActive = button.dataset[config.categoryDataKey] === category;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      }
    },
    closeInfo() {
      const popup = el(config.infoPopupSelector);
      if (popup) popup.hidden = true;
      stage.setActiveCategory(null);
    },
    // Dispatch to the consumer's per-category renderer (axis 2). Clears the body, then renders; an unknown
    // category is a contract break, not an empty popup — fail fast (mirrors the openInfo title guard).
    renderInfoCategory(category, bodyEl) {
      bodyEl.replaceChildren();
      const renderer = config.categoryRenderers[category];
      if (!renderer) {
        throw new Error(`unknown conversation stage info category: ${JSON.stringify(category)}`);
      }
      renderer(bodyEl);
    },

    // ── Whole-screen render ──
    // Reset the info drawer closed (召喚-only: never persist an open drawer onto a re-rendered stage), set
    // the persona standee + speaker caption, render the week/moon + message stream, start the ambient.
    renderScreen() {
      stage.closeInfo();
      const persona = config.personaVisual();
      const standee = el(config.standeeSelector);
      if (standee && persona?.standee_url) {
        deps.setActorImageSource(standee, persona.standee_url);
        standee.alt = config.standeeAlt(persona);
      }
      const speaker = el(config.speakerSelector);
      if (speaker && persona?.display_name) speaker.textContent = persona.display_name;
      stage.renderWeekAndMoon();
      stage.renderStream(history);
      stage.startAmbient();
    }
  };

  return stage;
}
