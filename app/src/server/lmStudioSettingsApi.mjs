import { promises as fs } from 'node:fs';
import path from 'node:path';

import { attachLmStudioTransportDiagnostics, normalizeLmStudioConfig, normalizeLmStudioThinkingEffort } from '../llm/lmStudioClient.mjs';

function statusError(message, statusCode, { errorCode = null } = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (errorCode) error.errorCode = errorCode;
  return error;
}

// Error JSON shape shared by the settings routes and the outer createServer catch: `error` always,
// `error_code` when classified, and for an LM Studio transport failure (`LMSTUDIO_MODEL_LIST_UNAVAILABLE`
// here, `LMSTUDIO_CONNECTION_UNAVAILABLE` from the client) `target` plus exactly one of `cause_code` /
// `cause_message`.
export function errorResponsePayload(error) {
  const payload = { error: error.message };
  if (error?.errorCode) payload.error_code = error.errorCode;
  if (error?.target) payload.target = error.target;
  if (error?.causeCode) payload.cause_code = error.causeCode;
  else if (error?.causeMessage) payload.cause_message = error.causeMessage;
  return payload;
}

export function lmStudioConfigRequiredError(message = 'LM Studioの設定が必要です。設定画面で接続先とモデルを保存してください。') {
  return statusError(message, 503, { errorCode: 'LMSTUDIO_CONFIG_REQUIRED' });
}

// The model-list transport failure names its target and cause so the caller can tell a refused port, an
// unreachable host, and a denied local-network permission apart.
function lmStudioModelListUnavailableError({ target, cause }) {
  const error = statusError(`LM Studio model list request failed: ${cause.message}`, 502, { errorCode: 'LMSTUDIO_MODEL_LIST_UNAVAILABLE' });
  return attachLmStudioTransportDiagnostics(error, { target, cause });
}

function normalizeLmStudioSettingsShape(config = {}) {
  const baseUrl = String(config.base_url ?? '').trim();
  let parsedUrl = null;
  try {
    parsedUrl = baseUrl ? new URL(baseUrl) : null;
  } catch {
    parsedUrl = null;
  }
  const host = parsedUrl?.hostname ? decodeURIComponent(parsedUrl.hostname) : '127.0.0.1';
  const port = parsedUrl?.port ? Number(parsedUrl.port) : 1234;
  const model = String(config.chat_model ?? config.reflection_model ?? '').trim();
  return {
    host,
    port,
    base_url: baseUrl,
    model,
    chat_model: config.chat_model ?? '',
    reflection_model: config.reflection_model ?? '',
    timeout_ms: config.timeout_ms ?? null,
    stream: config.stream ?? false,
    thinking_effort: normalizeLmStudioThinkingEffort(config.thinking_effort),
    provider: config.provider ?? 'lmstudio',
    mock_provider_enabled: config.mock_provider_enabled ?? false
  };
}

function hasOwnProperty(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function validateLmStudioThinkingEffortUpdate(body = {}) {
  if (!hasOwnProperty(body, 'thinking_effort')) return undefined;
  if (body.thinking_effort === null) return null;
  if (body.thinking_effort === 'low' || body.thinking_effort === 'medium' || body.thinking_effort === 'high') {
    return body.thinking_effort;
  }
  throw statusError('thinking_effort must be null, low, medium, or high', 400);
}

// The endpoint is exactly the host and port the caller typed: base_url is built from them alone.
function validateLmStudioEndpoint(body = {}) {
  const port = Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw statusError('port must be an integer between 1 and 65535', 400);
  const host = String(body.host ?? '').trim();
  if (!host) throw statusError('host is required', 400);
  return {
    host,
    port,
    baseUrl: `http://${host}:${port}/v1`
  };
}

function validateLmStudioSettingsUpdate(body = {}) {
  const endpoint = validateLmStudioEndpoint(body);
  const model = String(body.model ?? '').trim();
  if (!model) throw statusError('model is required', 400);
  const thinkingEffort = validateLmStudioThinkingEffortUpdate(body);
  return {
    ...endpoint,
    model,
    thinkingEffort
  };
}

async function fetchLmStudioModelCatalog(body = {}) {
  const connection = validateLmStudioEndpoint(body);
  let response;
  try {
    response = await fetch(`${connection.baseUrl}/models`);
  } catch (error) {
    throw lmStudioModelListUnavailableError({ target: connection.baseUrl, cause: error });
  }
  const text = await response.text();
  if (!response.ok) {
    throw statusError(`LM Studio model list request failed: ${response.status} ${text}`.trim(), 502);
  }
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw statusError('LM Studio model list response was not valid JSON', 502);
  }
  const models = Array.isArray(payload?.data)
    ? payload.data
      .map((entry) => {
        const id = String(entry?.id ?? '').trim();
        if (!id) return null;
        return { id, label: id };
      })
      .filter(Boolean)
    : [];
  return {
    host: connection.host,
    port: connection.port,
    base_url: connection.baseUrl,
    models
  };
}

export async function ensureLmStudioConfigLoaded(context, { allowMissing = false } = {}) {
  if (context.lmStudioConfig && typeof context.lmStudioConfig === 'object') {
    const normalizedConfig = normalizeLmStudioConfig(context.lmStudioConfig);
    for (const key of Object.keys(context.lmStudioConfig)) delete context.lmStudioConfig[key];
    Object.assign(context.lmStudioConfig, normalizedConfig);
    return context.lmStudioConfig;
  }
  if (!context.lmStudioConfigPath) {
    if (allowMissing) return null;
    throw lmStudioConfigRequiredError();
  }
  let loadedConfig;
  try {
    loadedConfig = JSON.parse(await fs.readFile(context.lmStudioConfigPath, 'utf8'));
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    if (error?.code === 'ENOENT') throw lmStudioConfigRequiredError();
    if (error instanceof SyntaxError) throw lmStudioConfigRequiredError('LM Studioの設定ファイルが壊れています。設定画面で接続先とモデルを保存し直してください。');
    throw error;
  }
  context.lmStudioConfig = normalizeLmStudioConfig(loadedConfig);
  return context.lmStudioConfig;
}

export async function ensureLmStudioConversationConfig(context) {
  const config = await ensureLmStudioConfigLoaded(context);
  const baseUrl = String(config?.base_url ?? '').trim();
  const chatModel = String(config?.chat_model ?? '').trim();
  if (!baseUrl || !chatModel) {
    throw lmStudioConfigRequiredError();
  }
  return config;
}

async function persistLmStudioConfig(context, nextConfig) {
  const existingConfig = context.lmStudioConfig;
  if (existingConfig && typeof existingConfig === 'object') {
    for (const key of Object.keys(existingConfig)) delete existingConfig[key];
    Object.assign(existingConfig, nextConfig);
    context.lmStudioConfig = existingConfig;
  } else {
    context.lmStudioConfig = { ...nextConfig };
  }
  if (!context.lmStudioConfigPath) throw new Error('LM Studio config path is not configured');
  await fs.mkdir(path.dirname(context.lmStudioConfigPath), { recursive: true });
  await fs.writeFile(context.lmStudioConfigPath, `${JSON.stringify(context.lmStudioConfig, null, 2)}\n`, 'utf8');
  return context.lmStudioConfig;
}

export function canHandleLmStudioSettingsRoute(method, pathname) {
  if (method === 'GET' && pathname === '/api/settings/lmstudio') return true;
  if (method === 'PATCH' && pathname === '/api/settings/lmstudio') return true;
  if (method === 'POST' && pathname === '/api/settings/lmstudio/models') return true;
  return false;
}

export async function handleLmStudioSettingsApi({ req, res, url, context, sendJson, readBody }) {
  if (!canHandleLmStudioSettingsRoute(req.method, url.pathname)) return false;

  if (req.method === 'GET' && url.pathname === '/api/settings/lmstudio') {
    const config = await ensureLmStudioConfigLoaded(context, { allowMissing: true });
    sendJson(res, normalizeLmStudioSettingsShape(config ?? {}));
    return true;
  }
  if (req.method === 'PATCH' && url.pathname === '/api/settings/lmstudio') {
    const currentConfig = (await ensureLmStudioConfigLoaded(context, { allowMissing: true })) ?? {};
    const body = await readBody(req);
    try {
      const update = validateLmStudioSettingsUpdate(body);
      const nextConfig = {
        ...currentConfig,
        provider: currentConfig.provider ?? 'lmstudio',
        base_url: update.baseUrl,
        chat_model: update.model,
        reflection_model: update.model,
        thinking_effort: update.thinkingEffort === undefined
          ? normalizeLmStudioThinkingEffort(currentConfig.thinking_effort)
          : update.thinkingEffort
      };
      await persistLmStudioConfig(context, nextConfig);
      sendJson(res, normalizeLmStudioSettingsShape(context.lmStudioConfig));
    } catch (error) {
      // Validation rejects carry an explicit 400; an fs-origin persist failure (EACCES etc.) has no
      // statusCode and surfaces as a 500 server failure, consistent with the outer createServer catch —
      // never mislabeled as client input 400.
      sendJson(res, { error: error.message }, error.statusCode ?? 500);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/settings/lmstudio/models') {
    const body = await readBody(req);
    try {
      sendJson(res, await fetchLmStudioModelCatalog(body));
    } catch (error) {
      // Validation rejects carry an explicit 400 and an LM Studio reachability failure carries 502 with its
      // error_code / target / cause; an unclassified failure without a statusCode surfaces as a 500 server
      // failure, consistent with the outer createServer catch.
      sendJson(res, errorResponsePayload(error), error.statusCode ?? 500);
    }
    return true;
  }
  return false;
}
