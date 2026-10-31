import test from 'node:test';
import assert from 'node:assert/strict';

const { renderSpeech } = await import('./render.js');
const { resolvePerformanceCapability, NO_PERFORMANCE_CAPABILITY } = await import('./capabilities.js');

const MINIMAX = resolvePerformanceCapability({ protocol: 'minimax', model: 'speech-2.8-hd' });
const MINIMAX_26 = resolvePerformanceCapability({ protocol: 'minimax', model: 'speech-2.6-hd' });
const BREEZE = resolvePerformanceCapability({ protocol: 'breeze', model: 'breeze-tts-2' });
const SPOKEN = '{叹气}已经很晚了。{停顿:0.6}我们听首安静的。';
const SAD_SLOW = { emotion: 'sad', pace: 'slow' };

// ---- MiniMax ----

test('MiniMax：语气词转 (tag)，停顿转 <#x#>，情绪与语速进 voice_setting', () => {
  const rendered = renderSpeech({ protocol: 'minimax', capability: MINIMAX }, SPOKEN, SAD_SLOW);
  assert.equal(rendered.text, '(sighs)已经很晚了。<#0.6#>我们听首安静的。');
  assert.deepEqual(rendered.native, { voice_setting: { emotion: 'sad', speed: 0.9 } });
});

test('MiniMax：强度映射到 voice_modify.intensity（正值更轻柔、负值更刚劲），fast 映射 1.08', () => {
  assert.deepEqual(renderSpeech({ protocol: 'minimax', capability: MINIMAX }, '好。', { intensity: 'soft', pace: 'fast' }).native,
    { voice_setting: { speed: 1.08 }, voice_modify: { intensity: 40 } });
  assert.deepEqual(renderSpeech({ protocol: 'minimax', capability: MINIMAX }, '好。', { intensity: 'strong' }).native,
    { voice_modify: { intensity: -30 } });
});

test('MiniMax：不满足约束的停顿被丢弃（开头、结尾、紧挨语气词、连续）', () => {
  const render = text => renderSpeech({ protocol: 'minimax', capability: MINIMAX }, text, null).text;
  assert.equal(render('{停顿:0.5}你好。'), '你好。');
  assert.equal(render('你好。{停顿:0.5}'), '你好。');
  assert.equal(render('你好。{停顿:0.5}{停顿:0.8}再见。'), '你好。再见。');
  assert.equal(render('你好。{停顿:0.5}{笑}再见。'), '你好。(laughs)再见。');
  assert.equal(render('你好，{停顿:1.25}再见。'), '你好，<#1.25#>再见。');
});

test('MiniMax：warm/serious 没有原生情绪就不传；direction 被丢弃', () => {
  const rendered = renderSpeech({ protocol: 'minimax', capability: MINIMAX }, '好。', { emotion: 'warm', direction: '轻一点' });
  assert.deepEqual(rendered.native, {});
});

test('MiniMax speech-2.6：语气词被丢弃，停顿保留', () => {
  const rendered = renderSpeech({ protocol: 'minimax', capability: MINIMAX_26 }, SPOKEN, null);
  assert.equal(rendered.text, '已经很晚了。<#0.6#>我们听首安静的。');
});

test('没有表演时文本原样、native 为空（请求体与现状一致）', () => {
  for (const capability of [MINIMAX, BREEZE, NO_PERFORMANCE_CAPABILITY]) {
    const rendered = renderSpeech({ capability }, '  今晚听一首陈绮贞。  ', null);
    assert.equal(rendered.text, '今晚听一首陈绮贞。');
    assert.deepEqual(rendered.native, {});
  }
});

test('超出上限的语气词与停顿在翻译时也被截断', () => {
  const rendered = renderSpeech({ capability: MINIMAX }, '{笑}一{笑}二{笑}三，四{停顿:0.3}五{停顿:0.3}六{停顿:0.3}七{停顿:0.3}八', null);
  assert.equal((rendered.text.match(/\(laughs\)/g) || []).length, 2);
  assert.equal((rendered.text.match(/<#/g) || []).length, 3);
});

// ---- Breeze ----

test('Breeze：语气词转 [x]，停顿丢弃，风格合成中文 instructions，guidance_scale=4，speed 按 pace', () => {
  const rendered = renderSpeech({ protocol: 'breeze', capability: BREEZE }, SPOKEN, { ...SAD_SLOW, direction: '像在耳边低声说话' });
  assert.equal(rendered.text, '[叹气]已经很晚了。我们听首安静的。');
  assert.match(rendered.native.instructions, /低落伤感/);
  assert.match(rendered.native.instructions, /语速放慢/);
  assert.match(rendered.native.instructions, /像在耳边低声说话/);
  assert.deepEqual(rendered.native.voice_settings, { guidance_scale: 4, speed: 0.9 });
});

test('Breeze：只有语气词没有风格时不带 instructions 与 voice_settings', () => {
  const rendered = renderSpeech({ capability: BREEZE }, '{笑}晚上好。{换气}来首歌。', null);
  assert.equal(rendered.text, '[笑]晚上好。来首歌。');
  assert.deepEqual(rendered.native, {});
});

// ---- NONE ----

test('NONE：只输出纯文本，不带任何参数', () => {
  const rendered = renderSpeech({ capability: NO_PERFORMANCE_CAPABILITY }, SPOKEN, { ...SAD_SLOW, direction: '轻声' });
  assert.equal(rendered.text, '已经很晚了。我们听首安静的。');
  assert.deepEqual(rendered.native, {});
  assert.deepEqual(renderSpeech({}, SPOKEN, SAD_SLOW), rendered, '缺能力时按 NONE 处理');
});

// ---- 属性测试：任何输入经任何翻译器都不残留中立标记 ----

test('属性：随机组合输入经三种翻译器后输出都不含中立标记', () => {
  const pieces = ['你好', '。', '，', ' ', 'Love', '{笑}', '{轻笑}', '{叹气}', '{换气}', '{清嗓子}', '{停顿:0.5}',
    '{停顿：1.2秒}', '{停顿:5}', '{停顿}', '{Love}', '{', '}', '歌'];
  const leak = /\{\s*(?:笑|轻笑|叹气|换气|清嗓子|停顿[^{}]*)\s*\}/;
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const emotions = [null, 'calm', 'warm', 'happy', 'playful', 'sad', 'surprised', 'serious'];
  for (let round = 0; round < 500; round += 1) {
    const length = 1 + Math.floor(random() * 12);
    const text = Array.from({ length }, () => pieces[Math.floor(random() * pieces.length)]).join('');
    const performance = { emotion: emotions[Math.floor(random() * emotions.length)], pace: 'slow', direction: '轻' };
    for (const capability of [MINIMAX, MINIMAX_26, BREEZE, NO_PERFORMANCE_CAPABILITY]) {
      const rendered = renderSpeech({ capability }, text, performance);
      assert.equal(leak.test(rendered.text), false, `leak for ${capability.id}: ${JSON.stringify(text)} → ${rendered.text}`);
      assert.equal(leak.test(JSON.stringify(rendered.native)), false);
    }
  }
});
