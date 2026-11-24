import assert from 'node:assert/strict';
import test from 'node:test';

import { createTtsPreviewService, listResolvedVoiceOptions } from './ttsPreviewService.js';

test('listResolvedVoiceOptions projects resolved profile fields', () => {
  const options = listResolvedVoiceOptions({
    listResolvedVoiceProfiles: () => [{
      id: 'vp_1',
      displayName: '晓晓',
      description: '温暖女声',
      resolvedProviderId: 'free_edge',
      resolvedVoiceId: 'zh-CN-XiaoxiaoNeural',
      sourceLabel: 'Edge 免费声音',
      isFallback: false,
    }],
  });

  assert.deepEqual(options, [{
    id: 'vp_1',
    name: '晓晓',
    note: '温暖女声',
    providerId: 'free_edge',
    voiceId: 'zh-CN-XiaoxiaoNeural',
    sourceLabel: 'Edge 免费声音',
    isFallback: false,
  }]);
});

test('createTtsPreviewService handles unavailable voice, truncation, and synth errors', async () => {
  const calls = [];
  const unavailableService = createTtsPreviewService({
    resolvePersonVoice: () => ({ unavailable: true }),
    synth: async () => ({}),
  });
  assert.deepEqual(
    await unavailableService.preview({ voiceProfileId: 'missing' }),
    { error: '这把声音当前不可用，请换一个或检查声音服务配置。' },
  );

  const okService = createTtsPreviewService({
    resolvePersonVoice: () => ({ providerId: 'custom_1', voiceId: 'v1', params: { speed: 1 }, isFallback: true }),
    synth: async (text, opts) => {
      calls.push({ text, opts });
      return { url: '/tts/preview.mp3', providerId: 'custom_1' };
    },
  });
  const longText = '字'.repeat(600);
  const res = await okService.preview({ voiceProfileId: 'vp_1', text: longText });
  assert.equal(calls[0].text.length, 500);
  assert.deepEqual(res, { url: '/tts/preview.mp3', providerId: 'custom_1', isFallback: true });

  const failingService = createTtsPreviewService({
    resolvePersonVoice: () => ({ providerId: 'custom_1', voiceId: 'v1' }),
    synth: async () => { throw new Error('network boom'); },
  });
  assert.deepEqual(
    await failingService.preview({ voiceProfileId: 'vp_1', text: '' }),
    { error: '这把声音试听失败，请检查声音配置后重试。' },
  );
});
