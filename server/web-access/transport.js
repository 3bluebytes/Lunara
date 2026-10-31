// Direct Node http(s), independent of fetch/global agents/env proxies. Each socket
// gets exactly one prevalidated DNS address; redirects repeat validation before I/O.
import http from 'node:http';
import https from 'node:https';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { resolvePublicTarget } from './safety.js';
import { WebAccessError, fail } from './errors.js';
import { LIMITS } from './policy.js';

function counter(maxBytes) {
  let bytes = 0;
  return new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > maxBytes ? new WebAccessError('WEB_CONTENT_TOO_LARGE') : null, bytes > maxBytes ? undefined : chunk);
  } });
}
function readResponse(response, maxBytes, signal) {
  const encoding = String(response.headers['content-encoding'] || 'identity').toLowerCase();
  const decoder = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress }[encoding];
  if (encoding !== 'identity' && !decoder) { response.destroy(); fail('WEB_CONTENT_UNSUPPORTED'); }
  if (Number(response.headers['content-length']) > maxBytes) { response.destroy(); fail('WEB_CONTENT_TOO_LARGE'); }
  const chunks = [];
  const sink = new Transform({ transform(chunk,_encoding,callback) { chunks.push(chunk); callback(); } });
  const streams = [response, counter(maxBytes), ...(decoder ? [decoder()] : []), counter(maxBytes), sink];
  return pipeline(...streams, { signal }).then(() => Buffer.concat(chunks).toString('utf8'));
}
export function createPublicTransport({ resolve, request } = {}) {
  return async function publicRequest(input, { body, provider = false, maxBytes = LIMITS.pageBytes, signal, secrets = [] } = {}) {
    const ownSignal = signal || AbortSignal.timeout(LIMITS.fetchMs);
    let current = input; const original = new URL(input);
    for (let redirects = 0; ; redirects++) {
      ownSignal.throwIfAborted();
      const target = await resolvePublicTarget(current, { resolve, signal:ownSignal, secrets });
      if (provider && (target.url.origin !== original.origin || target.url.pathname !== original.pathname
        || target.url.search !== original.search)) fail('WEB_TARGET_BLOCKED');
      const response = await new Promise((resolveResponse, reject) => {
        const send = request || (target.url.protocol === 'https:' ? https.request : http.request);
        const req = send(target.url, {
          method: body === undefined ? 'GET' : 'POST', agent: false, signal:ownSignal,
          // Node's automatic family selection may ask for all; never resolve again.
          lookup: (_host, options, callback) => options?.all
            ? callback(null, [{ address:target.address, family:target.family }])
            : callback(null, target.address, target.family),
          headers: { Accept: provider ? 'application/json, text/event-stream' : 'text/html, text/plain',
            'Accept-Encoding':'gzip, deflate, br', 'User-Agent':'Lunara/0.1 (public document reader)',
            ...(body === undefined ? {} : {'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}) },
        }, resolveResponse);
        req.once('error', reject); req.end(body);
      });
      if ([301,302,303,307,308].includes(response.statusCode)) {
        const location = response.headers.location; response.destroy();
        if (!location || redirects >= LIMITS.redirects) fail('WEB_TARGET_BLOCKED');
        let next; try { next = new URL(location, target.url); } catch { fail('WEB_TARGET_BLOCKED'); }
        if (target.url.protocol === 'https:' && next.protocol !== 'https:') fail('WEB_TARGET_BLOCKED');
        current = next.href; continue;
      }
      // Read error pages with the same bounds but never expose their content in errors.
      return { status:response.statusCode, headers:response.headers, url:target.url.href,
        redirected:redirects > 0, text:await readResponse(response,maxBytes,ownSignal) };
    }
  };
}
