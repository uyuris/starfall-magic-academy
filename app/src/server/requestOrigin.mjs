// The entrance rules every request to the runtime server passes before routing: only requests from the
// game's own screen get through. A refusal is a JSON `{ error, error_code }` naming the rule that refused it.
//
// The allowed (name, port) pairs come from where the server is actually listening (server.address()):
//   - names: `localhost` and any IP address literal (127.0.0.1, ::1, …);
//   - when listening on every interface (0.0.0.0 / ::) also this Mac's `.local` name
//     (`scutil --get LocalHostName` + `.local`, compared case-insensitively) — the name the serve list opens
//     the game on;
//   - port: the listening port.
import { execFileSync } from 'node:child_process';
import net from 'node:net';

const WILDCARD_ADDRESSES = new Set(['0.0.0.0', '::']);
const SAME_SITE_FETCH_VALUES = new Set(['same-origin', 'none']);

// One resolved policy per server and listening address; a resolution that failed is kept too, so a server
// that cannot name its listen address refuses every request without re-running scutil each time.
const resolvedPolicies = new WeakMap();

function readLocalHostName() {
  let name;
  try {
    name = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(`cannot read this Mac's .local name (scutil --get LocalHostName): ${stderr || error.message}`);
  }
  if (!name) throw new Error("this Mac's .local name is empty (scutil --get LocalHostName)");
  return `${name}.local`.toLowerCase();
}

function buildPolicy(server) {
  const address = server.address();
  if (!address || typeof address === 'string' || !Number.isInteger(address.port)) {
    throw new Error(`the request origin rules need a TCP listening address, got: ${JSON.stringify(address)}`);
  }
  const localHostName = WILDCARD_ADDRESSES.has(address.address) ? readLocalHostName() : null;
  return { listenAddress: address.address, port: address.port, localHostName };
}

// The allowed pairs for this server, resolved from its listening address. Throws when they cannot be
// decided: not listening on TCP, or listening on every interface without a readable .local name.
// startServer / listenInternalServer call this right after listen so such a start stops there.
export function requestOriginPolicy(server) {
  const address = server.address();
  const key = address && typeof address === 'object' ? `${address.address}|${address.port}` : String(address);
  const cached = resolvedPolicies.get(server);
  if (cached?.key === key) {
    if (cached.error) throw cached.error;
    return cached.policy;
  }
  try {
    const policy = buildPolicy(server);
    resolvedPolicies.set(server, { key, policy });
    return policy;
  } catch (cause) {
    const error = new Error(`the allowed address of this server cannot be decided: ${cause.message}`, { cause });
    error.statusCode = 500;
    error.errorCode = 'request_origin_unresolved';
    resolvedPolicies.set(server, { key, error });
    throw error;
  }
}

// `name:port` / `[v6]:port` / `name` → { name, port } (port 80 when absent), or null when malformed.
function parseHostPort(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;
  let name;
  let portText;
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    if (close === -1) return null;
    name = text.slice(1, close);
    const rest = text.slice(close + 1);
    if (rest && !rest.startsWith(':')) return null;
    portText = rest ? rest.slice(1) : '';
  } else {
    const colon = text.lastIndexOf(':');
    if (colon !== -1 && text.indexOf(':') !== colon) return null;
    name = colon === -1 ? text : text.slice(0, colon);
    portText = colon === -1 ? '' : text.slice(colon + 1);
  }
  if (!name) return null;
  if (portText === '') return { name, port: 80 };
  if (!/^\d+$/.test(portText)) return null;
  return { name, port: Number(portText) };
}

function isAllowedPair(policy, pair) {
  if (!pair || pair.port !== policy.port) return false;
  if (pair.name === 'localhost' || net.isIP(pair.name) !== 0) return true;
  return policy.localHostName !== null && pair.name === policy.localHostName;
}

function hasBody(headers) {
  if (headers['transfer-encoding'] !== undefined) return true;
  const length = headers['content-length'];
  return length !== undefined && Number(length) !== 0;
}

function isJsonContentType(value) {
  return String(value ?? '').split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

function refusal(status, errorCode, error) {
  return { status, body: { error, error_code: errorCode } };
}

// The Host rule alone: null when the Host header names an allowed (name, port) pair, otherwise the refusal.
export function refuseRequestHost(headers, policy) {
  if (isAllowedPair(policy, parseHostPort(headers.host))) return null;
  return refusal(403, 'request_host_forbidden', `Host ${JSON.stringify(headers.host ?? null)} is not this server's address`);
}

// The Origin and body rules, applied after the Host rule passed. `pathname` is the routed path.
export function refuseRequestOriginOrBody({ method, headers, pathname }, policy) {
  if (pathname.startsWith('/api/')) {
    const origin = headers.origin;
    if (origin !== undefined) {
      const match = /^http:\/\/([^/]+)$/.exec(origin);
      if (!match || !isAllowedPair(policy, parseHostPort(match[1]))) {
        return refusal(403, 'request_origin_forbidden', `Origin ${JSON.stringify(origin)} is not this server's screen`);
      }
    } else if (method !== 'GET' && method !== 'HEAD') {
      return refusal(403, 'request_origin_required', `${method} ${pathname} requires an Origin header`);
    } else {
      const fetchSite = headers['sec-fetch-site'];
      if (fetchSite !== undefined && !SAME_SITE_FETCH_VALUES.has(fetchSite)) {
        return refusal(403, 'request_cross_site', `${method} ${pathname} came from another site (Sec-Fetch-Site: ${fetchSite})`);
      }
    }
  }
  if (hasBody(headers) && !isJsonContentType(headers['content-type'])) {
    return refusal(415, 'request_content_type_unsupported', `a request body must be application/json, got: ${JSON.stringify(headers['content-type'] ?? null)}`);
  }
  return null;
}
