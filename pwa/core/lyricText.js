// Shared by the provider boundary and renderer (including persisted queue data).
// Never guess a charset for ciphertext: UTF-8 decoding must be lossless.
const LRC_TAG = /\[(?:\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?|(?:ar|ti|al|by|offset):[^\]]*)\]/i;
const BINARY_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/;

export function normalizeLyricText(value) {
  if (typeof value !== 'string' || !value) return '';
  const text = value.replace(/^\ufeff/, '');
  if (BINARY_TEXT.test(text)) return '';
  const compact = text.replace(/\s/g, '');
  // QQ crypt:1 is a long hexadecimal payload, not a textual lyric.
  if (compact.length >= 64 && /^[\da-f]+$/i.test(compact)) return '';
  if (LRC_TAG.test(text)) return text;
  if (!/[ \t]/.test(text) && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    try {
      const binary = atob(compact);
      // atob is permissive about padding; require a canonical round trip.
      if (btoa(binary).replace(/=+$/, '') === compact.replace(/=+$/, '')) {
        const decoded = new TextDecoder('utf-8', { fatal: true })
          .decode(Uint8Array.from(binary, ch => ch.charCodeAt(0)));
        if (!BINARY_TEXT.test(decoded) && LRC_TAG.test(decoded)) return decoded;
      }
    } catch { /* Invalid Base64 or UTF-8 is never repaired heuristically. */ }
    // Short ordinary words may resemble Base64; long transport payloads must not
    // reach the untimed-lyric fallback when decoding/structure validation failed.
    if (compact.length >= 64 || /^[+/]/.test(compact) || /=+$/.test(compact)) return '';
  }
  // Encoded '[' starts with Wz; do not show a malformed LRC envelope as prose.
  if (/^Wz[A-Za-z0-9+/]{14}/.test(text) && !/\s/.test(text)) return '';
  return text;
}
