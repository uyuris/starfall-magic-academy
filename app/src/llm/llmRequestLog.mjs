const MAX_LLM_REQUESTS = 30;
const requests = [];
let nextRequestId = 1;

export function recordLlmRequest({ title, kind, input, output, startedAt = new Date().toISOString(), completedAt = new Date().toISOString() }) {
  const record = {
    id: `llm_request_${nextRequestId++}`,
    title: title || 'LLM request',
    kind: kind || 'unknown',
    started_at: startedAt,
    completed_at: completedAt,
    input: input ?? '',
    output: output ?? ''
  };
  requests.push(record);
  while (requests.length > MAX_LLM_REQUESTS) requests.shift();
  return record;
}

export function getRecentLlmRequests() {
  return { requests: requests.map((request) => ({ ...request })) };
}

export function clearLlmRequestLog() {
  requests.splice(0, requests.length);
  nextRequestId = 1;
}
