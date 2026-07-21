import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runtimePublicReferenceRoot } from './testPaths.mjs';

const appJsPath = path.join(runtimePublicReferenceRoot, 'app.js');

function extractRunAssistantSseStream(js) {
  const match = js.match(/(async function runAssistantSseStream\(\{[\s\S]*?\n}\n)\nasync function runOpeningConversationStream/);
  assert.ok(match, 'runAssistantSseStream source should be extractable for the reveal timing harness');
  return match[1];
}

function createFakeClock() {
  let now = 0;
  const timers = [];

  function sleep(ms) {
    assert.equal(Number.isFinite(ms), true, 'fake sleep requires a finite duration');
    return new Promise((resolve) => {
      timers.push({ at: now + ms, resolve });
      timers.sort((a, b) => a.at - b.at);
    });
  }

  async function flushMicrotasks() {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  }

  async function runUntilSettled(promise) {
    let settled = false;
    let result;
    let failure;
    promise.then(
      (value) => {
        settled = true;
        result = value;
      },
      (error) => {
        settled = true;
        failure = error;
      }
    );

    await flushMicrotasks();
    while (!settled) {
      assert.notEqual(timers.length, 0, 'fake clock has no pending timers while the stream is still running');
      const nextAt = timers[0].at;
      now = nextAt;
      const due = timers.splice(0, timers.findLastIndex((timer) => timer.at === nextAt) + 1);
      for (const timer of due) timer.resolve();
      await flushMicrotasks();
    }
    if (failure) throw failure;
    return result;
  }

  return {
    get now() {
      return now;
    },
    sleep,
    runUntilSettled
  };
}

function sseBlock(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function createReader({ clock, chunks, onResultDelivered }) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    async read() {
      const next = chunks[index];
      index += 1;
      if (!next) return { value: undefined, done: true };
      if (next.afterMs > 0) await clock.sleep(next.afterMs);
      if (next.event === 'result') onResultDelivered(clock.now);
      return {
        value: encoder.encode(sseBlock(next.event, next.data)),
        done: false
      };
    }
  };
}

function createHarness(runAssistantSseStreamSource, { chunks, cooldownMs = 500 }) {
  const clock = createFakeClock();
  const renderedSegments = [];
  let resultDeliveredAt = null;
  let committed = false;
  let history = [{ role: 'user', content: '話して' }];
  const reader = createReader({
    clock,
    chunks,
    onResultDelivered: (time) => {
      resultDeliveredAt = time;
    }
  });
  // runAssistantSseStream is now surface-parameterized: only the shared utilities are
  // injected as free variables; the academy-specific seams (history, identity, render
  // target, conversation mapping, commit, refresh) are supplied through `surface`.
  const runAssistantSseStream = new Function(
    'fetch',
    'TextDecoder',
    'createApiError',
    'parseJsonText',
    'displayMessages',
    'completedAssistantPrefix',
    'sleep',
    'conversationPopupCooldownMs',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'setStreamStatus',
    'notifyAcademyLoadingProgress',
    'createLoadingProgressDeltaThrottle',
    `${runAssistantSseStreamSource}; return runAssistantSseStream;`
  )(
    async () => ({
      ok: true,
      body: {
        getReader: () => reader
      }
    }),
    TextDecoder,
    () => new Error('unexpected api error'),
    JSON.parse,
    (messages) => messages.flatMap((message) => String(message.content ?? '')
      .split('|')
      .filter((content) => content.trim())
      .map((content) => ({ ...message, content }))),
    (content) => content,
    clock.sleep,
    () => cooldownMs,
    (callback) => {
      queueMicrotask(callback);
      return 1;
    },
    () => {},
    () => {},
    // notifyAcademyLoadingProgress / createLoadingProgressDeltaThrottle: the loading-constellation seam is inert
    // in this reveal-timing harness (no loading screen), so the throttle factory returns a no-op notifier.
    () => {},
    () => () => {}
  );

  const surface = {
    getHistory: () => history,
    setHistory: (messages) => { history = messages; },
    render: (messages) => {
      const assistantSegments = messages.filter((message) => message.role === 'assistant');
      renderedSegments.push({
        at: clock.now,
        content: assistantSegments.at(-1)?.content ?? null
      });
    },
    mapMessages: (conversation) => conversation.messages,
    assistantIdentity: () => ({ character_id: 'lina', character_name: 'リナ' }),
    commitState: () => {
      committed = true;
    },
    refresh: async () => {}
  };

  return {
    get renderedSegments() {
      return renderedSegments;
    },
    get resultDeliveredAt() {
      return resultDeliveredAt;
    },
    get committed() {
      return committed;
    },
    run: () => clock.runUntilSettled(runAssistantSseStream({
      surface,
      endpoint: '/api/conversation/stream',
      body: { character_id: 'lina', player_input: '話して' },
      refreshAfter: false
    }))
  };
}

function assertGapsAtLeast(renderedSegments, minGapMs) {
  for (let index = 1; index < renderedSegments.length; index += 1) {
    const gap = renderedSegments[index].at - renderedSegments[index - 1].at;
    assert.ok(
      gap >= minGapMs,
      `popup gap ${gap}ms before "${renderedSegments[index].content}" must be at least ${minGapMs}ms`
    );
  }
}

test('an early assistant_complete still keeps the full cooldown between every popup (no fast-forward drain)', async () => {
  const js = await readFile(appJsPath, 'utf8');
  const runAssistantSseStreamSource = extractRunAssistantSseStream(js);
  const harness = createHarness(runAssistantSseStreamSource, {
    chunks: [
      { afterMs: 0, event: 'assistant_delta', data: { delta: 'one|two|three' } },
      { afterMs: 10, event: 'assistant_complete', data: { content: 'one|two|three|tail', expression: 'neutral' } },
      {
        afterMs: 1200,
        event: 'result',
        data: {
          conversation: {
            messages: [
              { role: 'user', content: '話して' },
              { role: 'assistant', content: 'one|two|three|tail' }
            ]
          }
        }
      }
    ]
  });

  await harness.run();

  assert.deepEqual(
    harness.renderedSegments.map((segment) => [segment.content, segment.at]),
    [
      ['one', 0],
      ['two', 500],
      ['three', 1000],
      ['tail', 1500]
    ],
    'assistant_complete must not fast-forward: every segment still pops one default 500ms cooldown apart'
  );
  assertGapsAtLeast(harness.renderedSegments, 500);
  assert.equal(harness.committed, true, 'the final result should still reconcile canonical state after the paced reveal');
});

test('a late assistant_complete keeps the 500ms cooldown for the trailing segment too (no 100ms tail)', async () => {
  const js = await readFile(appJsPath, 'utf8');
  const runAssistantSseStreamSource = extractRunAssistantSseStream(js);
  const harness = createHarness(runAssistantSseStreamSource, {
    chunks: [
      { afterMs: 0, event: 'assistant_delta', data: { delta: 'one|two|three' } },
      { afterMs: 1100, event: 'assistant_complete', data: { content: 'one|two|three|tail', expression: 'neutral' } },
      {
        afterMs: 1200,
        event: 'result',
        data: {
          conversation: {
            messages: [
              { role: 'user', content: '話して' },
              { role: 'assistant', content: 'one|two|three|tail' }
            ]
          }
        }
      }
    ]
  });

  await harness.run();

  assert.deepEqual(
    harness.renderedSegments.map((segment) => [segment.content, segment.at]),
    [
      ['one', 0],
      ['two', 500],
      ['three', 1000],
      ['tail', 1500]
    ],
    'the tail segment that arrives with assistant_complete must wait a full 500ms after the previous popup, not 100ms'
  );
  assertGapsAtLeast(harness.renderedSegments, 500);
});

test('the configured cooldown preset changes the spacing between popups', async () => {
  const js = await readFile(appJsPath, 'utf8');
  const runAssistantSseStreamSource = extractRunAssistantSseStream(js);
  const harness = createHarness(runAssistantSseStreamSource, {
    cooldownMs: 200,
    chunks: [
      { afterMs: 0, event: 'assistant_delta', data: { delta: 'one|two|three' } },
      { afterMs: 10, event: 'assistant_complete', data: { content: 'one|two|three|tail', expression: 'neutral' } },
      {
        afterMs: 20,
        event: 'result',
        data: {
          conversation: {
            messages: [
              { role: 'user', content: '話して' },
              { role: 'assistant', content: 'one|two|three|tail' }
            ]
          }
        }
      }
    ]
  });

  await harness.run();

  assert.deepEqual(
    harness.renderedSegments.map((segment) => [segment.content, segment.at]),
    [
      ['one', 0],
      ['two', 200],
      ['three', 400],
      ['tail', 600]
    ],
    'a 200ms cooldown preset should pace every popup 200ms apart, including the assistant_complete tail'
  );
  assertGapsAtLeast(harness.renderedSegments, 200);
  assert.equal(harness.committed, true, 'the final result should still reconcile canonical state after the faster paced reveal');
});
