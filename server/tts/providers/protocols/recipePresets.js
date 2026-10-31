// protocols/recipePresets.js — 随软件发布的预设配方（design D7）。
//
// 预设就是配方 JSON 加默认接口地址、model 和音色提示。选中预设只需填 Key（和音色），
// 仍要试合成通过、用户试听确认才保存；不调用起草助手。
// 每个字段都按 verifiedAt 当天的官方文档逐项核对过；文档变了要重新核对，核对不上就下架。

export const RECIPE_PRESETS = Object.freeze([
  Object.freeze({
    id: 'qwen-tts',
    name: '千问 TTS（阿里百炼）',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/qwen-tts-api',
    verifiedAt: '2026-10-27',
    defaults: Object.freeze({ baseUrl: 'https://dashscope.aliyuncs.com', model: 'qwen3-tts-flash', voice: 'Cherry' }),
    note: '用北京地域的百炼 API Key（新加坡地域的 Key 不通用）；单次最多 600 字。返回的是 24 小时有效的音频链接，Lunara 会立刻下载。',
    recipe: Object.freeze({
      version: 1,
      synth: {
        method: 'POST',
        path: '/api/v1/services/aigc/multimodal-generation/generation',
        headers: { Authorization: 'Bearer {apiKey}' },
        body: { model: '{model}', input: { text: '{text}', voice: '{voice}' } },
      },
      audio: { kind: 'url', audioPath: 'output.audio.url' },
      error: { messagePath: 'message' },
    }),
  }),
  Object.freeze({
    id: 'doubao-tts',
    name: '豆包语音（火山引擎）',
    docsUrl: 'https://www.volcengine.com/docs/doubao-voice/audio-generation-http',
    verifiedAt: '2026-10-27',
    defaults: Object.freeze({ baseUrl: 'https://openspeech.bytedance.com', model: 'seed-audio-1.0', voice: 'zh_female_vv_uranus_bigtts' }),
    note: '用新版控制台的 API Key（X-Api-Key 单头鉴权，旧版控制台的双头鉴权不支持）；音色填「豆包语音合成模型 2.0」的音色 ID。',
    recipe: Object.freeze({
      version: 1,
      synth: {
        method: 'POST',
        path: '/api/v3/tts/create',
        headers: { 'X-Api-Key': '{apiKey}' },
        body: {
          model: '{model}',
          text_prompt: '{text}',
          speaker: '{voice}',
          audio_config: { format: 'mp3', sample_rate: 24000 },
        },
      },
      audio: { kind: 'json', audioPath: 'audio', encoding: 'base64' },
      error: { messagePath: 'message' },
    }),
  }),
]);

export function recipePreset(id) {
  return RECIPE_PRESETS.find(preset => preset.id === id) || null;
}

/** 给前端的预设视图（配方原样给出，便于展开查看）。 */
export function publicRecipePresets() {
  return RECIPE_PRESETS.map(({ id, name, docsUrl, verifiedAt, defaults, note, recipe }) => ({
    id, name, docsUrl, verifiedAt, defaults: { ...defaults }, note, recipe: JSON.parse(JSON.stringify(recipe)),
  }));
}
