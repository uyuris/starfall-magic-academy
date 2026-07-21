import test from 'node:test';
import assert from 'node:assert/strict';
import { clearLlmRequestLog, getRecentLlmRequests, recordLlmRequest } from '../src/llm/llmRequestLog.mjs';

test('recent LLM request log keeps the latest 30 requests with titles and details', () => {
  clearLlmRequestLog();
  for (let index = 1; index <= 35; index += 1) {
    recordLlmRequest({
      title: `request ${index}`,
      kind: index % 2 === 0 ? 'chat' : 'stage_flag',
      input: `input ${index}`,
      output: `output ${index}`,
      startedAt: `2026-05-07T00:${String(index).padStart(2, '0')}:00.000+09:00`,
      completedAt: `2026-05-07T00:${String(index).padStart(2, '0')}:01.000+09:00`
    });
  }

  const { requests } = getRecentLlmRequests();
  assert.equal(requests.length, 30);
  assert.equal(requests[0].title, 'request 6');
  assert.equal(requests.at(-1).title, 'request 35');
  assert.equal(requests.at(-1).kind, 'stage_flag');
  assert.equal(requests.at(-1).input, 'input 35');
  assert.equal(requests.at(-1).output, 'output 35');
});
