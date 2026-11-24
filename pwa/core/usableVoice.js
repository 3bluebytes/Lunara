export function parseConsentAt(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

export function recordedFreeEdgeConsent(fallback) {
  if (!fallback || fallback.freeVoicesEnabled !== true) return false;
  return parseConsentAt(fallback.consentAt) !== null;
}

export function consentRecord(source) {
  if (!source || typeof source !== 'object') return null;
  if (source.fallback && typeof source.fallback === 'object') return source.fallback;
  if (source.current?.fallback && typeof source.current.fallback === 'object') return source.current.fallback;
  if ('freeVoicesEnabled' in source || 'consentAt' in source) return source;
  return null;
}

export function isFreeEdgeVoice(voice) {
  return voice?.sourceProvider === 'free-edge'
    || voice?.resolvedProviderId === 'free-edge'
    || voice?.endpointId === 'free-edge';
}

export function isUsableVoice(voice, consentSource) {
  if (!voice || voice.unavailable !== false) return false;
  if (isFreeEdgeVoice(voice) && !recordedFreeEdgeConsent(consentRecord(consentSource))) return false;
  return true;
}

export function countUsableVoices(voices, consentSource) {
  if (!Array.isArray(voices)) return 0;
  return voices.reduce((count, voice) => count + (isUsableVoice(voice, consentSource) ? 1 : 0), 0);
}
