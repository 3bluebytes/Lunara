/**
 * Request-shape guards for the local HTTP boundary.
 *
 * Lunara is a single-user, loopback-bound application with no account model, so
 * these guards do not authenticate anyone. They constrain *request shapes*
 * instead, because the browser can reach loopback from every page the user
 * visits. Both guards are cheap, stateless and independent of client support.
 */

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOOPBACK_HOST_NAMES = ['127.0.0.1', 'localhost', '::1'];
// A wildcard bind means "every interface", so no single literal names it. It is
// deliberately not treated as an accepted Host: the guard then serves loopback
// names only, which keeps a no-account service reachable from this machine alone.
const WILDCARD_HOST_NAMES = new Set(['0.0.0.0', '::', '*']);

/** Lower-case a Host value and drop the port, unwrapping IPv6 literals. */
export function hostNameOf(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end === -1 ? raw : raw.slice(1, end);
  }
  const first = raw.indexOf(':');
  // A bare IPv6 literal carries several colons and no port; a name with exactly
  // one colon carries a port to strip.
  if (first === -1 || first !== raw.lastIndexOf(':')) return raw;
  return raw.slice(0, first);
}

/** Extract the port from a `host:port` value; empty string when none is present. */
export function portOf(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end === -1) return '';
    const rest = raw.slice(end + 1);
    return rest.startsWith(':') ? rest.slice(1) : '';
  }
  const first = raw.indexOf(':');
  if (first === -1 || first !== raw.lastIndexOf(':')) return '';
  return raw.slice(first + 1);
}

export function isStateChangingMethod(method) {
  return MUTATING_METHODS.has(String(method ?? '').toUpperCase());
}

export function allowedHostNames(bindHost) {
  const names = new Set(LOOPBACK_HOST_NAMES);
  const bound = hostNameOf(bindHost);
  if (bound && !WILDCARD_HOST_NAMES.has(bound)) names.add(bound);
  return names;
}

function contentTypeIsJson(value) {
  return String(value ?? '').split(';')[0].trim().toLowerCase() === 'application/json';
}

/**
 * Reject a state-changing request whose content type is not JSON.
 *
 * A cross-site form can only send `text/plain`, `application/x-www-form-urlencoded`
 * or `multipart/form-data` without a preflight request, and the server sends no
 * CORS headers, so nothing it sends can satisfy this check. A `fetch` that sets
 * `application/json` must preflight and is therefore blocked as well.
 */
export function requireJsonForStateChange() {
  return (req, res, next) => {
    if (!isStateChangingMethod(req.method)) return next();
    if (contentTypeIsJson(req.headers?.['content-type'])) return next();
    res.status(415).json({ ok: false, error: 'application/json required' });
  };
}

/**
 * Reject a request whose `Origin` is not the local service itself.
 *
 * A WebSocket upgrade does not pass through Express, so it must not rely on the
 * HTTP guards. A browser always sends `Host` and `Origin` for a handshake, so
 * requiring the two to name the same `host:port` rejects every foreign page
 * without needing to know which port the process later binds. A missing `Origin`
 * (a non-browser local client) is accepted once `Host` is local: any process on
 * this machine can already read the database directly, so allowing it adds no
 * exposure. `Origin: null` (a `file://` or sandboxed document) is rejected.
 */
export function originMatchesHost(origin, host) {
  const rawOrigin = String(origin ?? '').trim();
  if (!rawOrigin) return { ok: true, reason: null };
  if (rawOrigin.toLowerCase() === 'null') return { ok: false, reason: 'opaque-origin' };
  let url;
  try { url = new URL(rawOrigin); } catch { return { ok: false, reason: 'malformed-origin' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'unsupported-origin-scheme' };
  const originName = hostNameOf(url.host);
  const originPort = portOf(url.host) || (url.protocol === 'https:' ? '443' : '80');
  const hostName = hostNameOf(host);
  const hostPort = portOf(host) || originPort;
  if (originName !== hostName) return { ok: false, reason: 'origin-host-mismatch' };
  if (originPort !== hostPort) return { ok: false, reason: 'origin-port-mismatch' };
  return { ok: true, reason: null };
}

/**
 * The shared local-only rule for HTTP and WebSocket alike: `Host` must name the
 * local service, and a present `Origin` must agree with it.
 */
export function localRequestAllowed(headers, { bindHost = () => process.env.LUNARA_HOST || '127.0.0.1' } = {}) {
  const host = headers?.host;
  const allowed = allowedHostNames(typeof bindHost === 'function' ? bindHost() : bindHost);
  const name = hostNameOf(host);
  if (!name || !allowed.has(name)) return { ok: false, reason: 'forbidden-host' };
  return originMatchesHost(headers?.origin, host);
}

/**
 * Reject a request whose Host does not name the local service.
 *
 * This is the only guard that protects read-only responses: a domain rebound to
 * the loopback address reaches the API with a foreign Host header, not a
 * foreign content type. A missing Host header is rejected rather than trusted.
 */
export function requireLocalHost({ bindHost = () => process.env.LUNARA_HOST || '127.0.0.1' } = {}) {
  return (req, res, next) => {
    const name = hostNameOf(req.headers?.host);
    const allowed = allowedHostNames(typeof bindHost === 'function' ? bindHost() : bindHost);
    if (name && allowed.has(name)) return next();
    res.status(403).json({ ok: false, error: 'forbidden host' });
  };
}
