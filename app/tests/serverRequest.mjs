// The one way Node-side tests, manual tools and scripts talk to the game server: the server's entrance
// refuses a request whose Origin is not its own screen, a non-GET without an Origin, and a body that is not
// application/json (app/src/server/requestOrigin.mjs).

// fetch() to the game server as its own screen would: Origin is the target's origin, and a request with a
// body is sent as application/json.
export function serverFetch(url, init = {}) {
  const target = new URL(url);
  const headers = { ...(init.headers ?? {}), origin: target.origin };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(target, { ...init, headers });
}

// The headers a relay forwards to the game server at `serverUrl`: the browser's headers with Host (and
// Origin, when the browser sent one) changed to the game server's own pair.
export function relayHeadersToServer(headers, serverUrl) {
  const target = new URL(serverUrl);
  const relayed = { ...headers, host: target.host };
  if (relayed.origin !== undefined) relayed.origin = target.origin;
  return relayed;
}
