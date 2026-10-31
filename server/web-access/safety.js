import ipaddr from 'ipaddr.js';
import { lookup } from 'node:dns/promises';
import { fail } from './errors.js';

const sensitive = /(?:auth|cookie|key|token|secret|^sig$|signature|credential|password|passwd|session|x-amz-|x-goog-)/i;
const internal = /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|arpa|onion|test|invalid)$/i;
export function publicAddress(value) {
  try {
    let address = ipaddr.parse(value);
    if (address.kind() === 'ipv6' && address.isIPv4MappedAddress()) address = address.toIPv4Address();
    if (address.range() !== 'unicast') return false;
    // Only currently globally allocated IPv6 space, not unspecified/reserved space.
    return address.kind() === 'ipv4' || address.match(ipaddr.parse('2000::'), 3);
  } catch { return false; }
}
function hasSecret(text, secrets) {
  return secrets.some(secret => typeof secret === 'string' && secret.length >= 6 && text.includes(secret));
}
export function validateQuery(value, secrets = []) {
  if (typeof value !== 'string' || !value.trim() || [...value].length > 320 || Buffer.byteLength(value) > 1280
    || /[\x00-\x1f\x7f]|<\/?(?:system|peer_message)|\b(?:messages|personaDocument)\s*[":]/i.test(value)
    || /(?:authorization|cookie|api[_ -]?key|token|secret|password)\s*[:=]|\bBearer\s+|\bsk-[a-z0-9_-]{10,}/i.test(value)
    || hasSecret(value, secrets)) fail('WEB_INVALID_QUERY');
  return value; // Never silently rewrite an approved query.
}
export function normalizeWebUrl(value, secrets = []) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) fail('WEB_TARGET_BLOCKED');
  let url; try { url = new URL(value); } catch { fail('WEB_TARGET_BLOCKED'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.port) fail('WEB_TARGET_BLOCKED');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (internal.test(host) || (!host.includes('.') && !host.includes(':'))) fail('WEB_TARGET_BLOCKED');
  if (ipaddr.isValid(host) && !publicAddress(host)) fail('WEB_TARGET_BLOCKED');
  let decoded; try { decoded = decodeURIComponent(url.href); } catch { fail('WEB_TARGET_BLOCKED'); }
  if (hasSecret(decoded, secrets) || [...url.searchParams.keys()].some(key => sensitive.test(key))
    || /(?:authorization|cookie|api[_ -]?key|secret|password)\s*[:=]|\bBearer\s+/i.test(decoded)) fail('WEB_TARGET_BLOCKED');
  url.hash = '';
  return url;
}
export async function resolvePublicTarget(value, { resolve = lookup, signal, secrets = [] } = {}) {
  signal?.throwIfAborted();
  const url = normalizeWebUrl(typeof value === 'string' ? value : value.href, secrets);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = ipaddr.isValid(hostname)
    ? [{ address: hostname, family: ipaddr.parse(hostname).kind() === 'ipv4' ? 4 : 6 }]
    : await abortable(resolve(hostname, { all: true, verbatim: true }), signal);
  signal?.throwIfAborted();
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !publicAddress(item.address)
    || ![4,6].includes(item.family))) fail('WEB_TARGET_BLOCKED');
  return { url, address: addresses[0].address, family: addresses[0].family };
}
export async function abortable(promise, signal) {
  signal?.throwIfAborted();
  if (!signal) return promise;
  let listener;
  try { return await Promise.race([promise, new Promise((_,reject) => {
    listener = () => reject(signal.reason); signal.addEventListener('abort', listener, { once:true });
  })]); } finally { if (listener) signal.removeEventListener('abort', listener); }
}
