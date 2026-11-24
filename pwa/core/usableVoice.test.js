import test from 'node:test';
import assert from 'node:assert/strict';

import { countUsableVoices, isUsableVoice, parseConsentAt, recordedFreeEdgeConsent } from './usableVoice.js';

const xiaoxiao = {
  id: 'vp_cx_a0c168ef',
  displayName: '晓晓',
  sourceProvider: 'free-edge',
  unavailable: false,
};

test('可用声音要求 unavailable 为 false，free-edge 还要可解析的同意时间', () => {
  assert.equal(parseConsentAt('2026-11-03T00:00:00.000Z'), '2026-11-03T00:00:00.000Z');
  assert.equal(parseConsentAt('not-a-date'), null);
  assert.equal(recordedFreeEdgeConsent({ freeVoicesEnabled: true, consentAt: '2026-11-03T00:00:00.000Z' }), true);
  assert.equal(recordedFreeEdgeConsent({ freeVoicesEnabled: true, consentAt: null }), false);
  assert.equal(recordedFreeEdgeConsent({ freeVoicesEnabled: false, consentAt: '2026-11-03T00:00:00.000Z' }), false);

  assert.equal(isUsableVoice({ id: 'vp_custom', unavailable: false }, null), true);
  assert.equal(isUsableVoice({ id: 'vp_custom', unavailable: true }, null), false);
  assert.equal(isUsableVoice({ id: 'vp_custom' }, null), false);
  assert.equal(isUsableVoice(xiaoxiao, { freeVoicesEnabled: false, consentAt: null }), false);
  assert.equal(isUsableVoice(xiaoxiao, { freeVoicesEnabled: true, consentAt: null }), false);
  assert.equal(isUsableVoice(
    { ...xiaoxiao, unavailable: true },
    { freeVoicesEnabled: true, consentAt: '2026-11-03T00:00:00.000Z' },
  ), false);
  assert.equal(isUsableVoice(xiaoxiao, {
    fallback: { freeVoicesEnabled: true, consentAt: '2026-11-03T00:00:00.000Z' },
  }), true);
  assert.equal(isUsableVoice(
    { ...xiaoxiao, sourceProvider: '', resolvedProviderId: 'free-edge' },
    { current: { fallback: { freeVoicesEnabled: true, consentAt: '2026-11-03T00:00:00.000Z' } } },
  ), true);
  assert.equal(countUsableVoices([
    { ...xiaoxiao, unavailable: true },
    { id: 'vp_custom', unavailable: false },
  ], null), 1);
});
