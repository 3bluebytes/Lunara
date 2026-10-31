import assert from 'node:assert/strict';
import test from 'node:test';
import { PresentationService } from './PresentationService.js';

function envelope(overrides = {}) {
  return {
    displayText: '详细说明：这次没有找到匹配项，你可以换一个条件。',
    spokenText: '这次没有找到匹配项。',
    speak: true,
    virtualPersonId: 'lunara',
    voiceProfileId: 'warm',
    sourceTurnId: 'turn-1',
    correlationId: 'request-1',
    ...overrides,
  };
}

test('presentation keeps display and spoken wording separate and sends only approved spoken text to TTS', async () => {
  const calls = [];
  const service = new PresentationService({
    synthesize: async input => { calls.push(input); return { url: '/tts/safe.mp3' }; },
  });
  const delivered = await service.deliver(envelope());
  assert.equal(delivered.envelope.displayText, '详细说明：这次没有找到匹配项，你可以换一个条件。');
  assert.equal(calls[0].text, '这次没有找到匹配项。');
  assert.equal(calls[0].voiceProfileId, 'warm');
});

test('raw strings and non-spoken failures never reach TTS', async () => {
  let calls = 0;
  const service = new PresentationService({ synthesize: async () => { calls++; } });
  await assert.rejects(() => service.deliver('SDK error: secret'), /PresentationEnvelope/);
  const delivered = await service.deliver(envelope({ spokenText: '', speak: false }));
  assert.equal(delivered.audio, null);
  assert.equal(calls, 0);
});
