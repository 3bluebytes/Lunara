import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { createRecipeSettings, describeRecipe, guessProtocolChoice, parseProtocolChoice, protocolChoiceOf } from './recipeSettings.js';
import { publicRecipePresets } from '../../../server/tts/providers/protocols/recipePresets.js';

// 直接用 index.html 里的真实片段（协议选择器、URL/Model 输入框、向导小节），保证 id 与可访问名称和页面一致。
const page = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const protocolSelect = page.match(/<select id="tts-custom-protocol"[\s\S]*?<\/select>/)?.[0];
const wizard = page.match(/<section class="tts-recipe"[\s\S]*?<\/section>/)?.[0];
const PRESETS = publicRecipePresets();
const RECIPE = {
  version: 1,
  synth: { method: 'POST', path: '/v1/speech', headers: { Authorization: 'Bearer {apiKey}' }, body: { text: '{text}', voice: '{voice}' } },
  audio: { kind: 'binary' },
};
const TEST_TEXT = '你好，这里是 Lunara 电台。';

/** linkedom 的 select.value 只读：按 selected 属性切换选项。 */
function choose(select, value) {
  for (const option of select.querySelectorAll('option')) {
    if (option.value === value) option.setAttribute('selected', ''); else option.removeAttribute('selected');
  }
  assert.equal(select.value, value);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture({ choice = 'recipe', testResults = [], draftResults = [], endpoint = null } = {}) {
  assert.ok(protocolSelect && wizard, 'index.html 里有协议选择器和配方向导');
  const { document } = parseHTML(`<html><body>${protocolSelect}
    <input id="tts-custom-url" type="url"><input id="tts-custom-key" type="password"><input id="tts-custom-model" type="text">
    ${wizard}</body></html>`);
  const $ = selector => document.querySelector(selector);
  choose($('#tts-custom-protocol'), choice);
  const calls = [];
  const saves = [];
  const suggested = [];
  const controller = {
    async loadRecipePresets() { return PRESETS; },
    async testRecipe(payload) { calls.push(['test', payload]); return typeof testResults[0]?.then === 'function' ? testResults.shift() : testResults.shift(); },
    async draftRecipe(payload) { calls.push(['draft', payload]); return draftResults.shift(); },
  };
  const settings = createRecipeSettings({
    controller,
    documentLike: document,
    getChoice: () => parseProtocolChoice($('#tts-custom-protocol').value),
    getConnection: () => ({ endpointId: '', baseUrl: $('#tts-custom-url').value, apiKey: $('#tts-custom-key').value, model: $('#tts-custom-model').value }),
    getEndpoint: () => endpoint,
    onSave: async payload => { saves.push(payload); return true; },
    onSuggestChoice: choice => { suggested.push(choice); },
    choiceLabel: value => [...$('#tts-custom-protocol').querySelectorAll('option')].find(option => option.value === value)?.textContent || value,
  });
  const fire = (selector, type) => $(selector).dispatchEvent(new document.defaultView.Event(type));
  const type = (selector, value) => { $(selector).value = value; fire(selector, 'input'); };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { settings, document, $, fire, type, settle, calls, saves, suggested, choose };
}

test('协议选择器的值、域名预选与已保存接口的回显', () => {
  assert.deepEqual(parseProtocolChoice('recipe:qwen-tts'), { protocol: 'recipe', presetId: 'qwen-tts' });
  assert.deepEqual(parseProtocolChoice('recipe'), { protocol: 'recipe', presetId: '' });
  assert.deepEqual(parseProtocolChoice('breeze'), { protocol: 'breeze', presetId: '' });
  assert.equal(protocolChoiceOf({ protocol: 'recipe', presetId: 'doubao-tts' }), 'recipe:doubao-tts');
  assert.equal(protocolChoiceOf({ protocol: 'recipe' }), 'recipe');
  assert.equal(protocolChoiceOf({ protocol: 'minimax' }), 'minimax');
  assert.equal(guessProtocolChoice('https://api.minimax.cn/v1/t2a_v2'), 'minimax');
  assert.equal(guessProtocolChoice('https://api.breeze.blue'), 'breeze');
  assert.equal(guessProtocolChoice('https://api.elevenlabs.io/v1'), 'breeze');
  assert.equal(guessProtocolChoice('https://dashscope.aliyuncs.com'), 'recipe:qwen-tts');
  assert.equal(guessProtocolChoice('https://openspeech.bytedance.com'), 'recipe:doubao-tts');
  assert.equal(guessProtocolChoice('https://notbreeze.blue.evil.example'), null);
  assert.equal(guessProtocolChoice('https://tts.example.com/v1'), null, '认不出的地址不动');
  assert.equal(guessProtocolChoice('不是地址'), null);
});

test('选择器按格式命名，每个随软件发布的预设都有对应选项', () => {
  const { document } = parseHTML(`<html><body>${protocolSelect}</body></html>`);
  const options = [...document.querySelectorAll('option')].map(option => [option.value, option.textContent]);
  assert.deepEqual(options.slice(0, 3), [['openai', 'OpenAI 兼容（通用，默认）'], ['breeze', 'ElevenLabs 兼容（Breeze 等）'], ['minimax', 'MiniMax']]);
  assert.deepEqual(options.at(-1), ['recipe', '其他（让助手接入）']);
  for (const preset of PRESETS) {
    assert.ok(options.some(([value, label]) => value === `recipe:${preset.id}` && label === preset.name), `${preset.id} 有选项`);
  }
});


const rowState = h => Object.fromEntries([...h.$('#tts-recipe-card').querySelectorAll('.tts-recipe-row')].map(row => [row.dataset.row, row.dataset.state]));
const passedTest = () => ({ passed: true, recipe: RECIPE, previewUrl: '/tts/recipe-preview.mp3', testText: TEST_TEXT });

test('接口格式卡片完全由配方推出：缺 Key / Model / 音色、没放 {text} 都标出来', () => {
  const withModel = { ...RECIPE, synth: { ...RECIPE.synth, body: { ...RECIPE.synth.body, model: '{model}' } } };
  const empty = describeRecipe(withModel, { baseUrl: 'https://tts.example.com/api' });
  assert.deepEqual(empty.missing, ['API Key', 'Model', '音色']);
  assert.equal(empty.rows.find(row => row.id === 'synth').value, 'POST https://tts.example.com/api/v1/speech');
  assert.match(empty.rows.find(row => row.id === 'auth').value, /Authorization: Bearer ‹你的 Key›/);
  assert.ok(!JSON.stringify(empty).includes('{apiKey}'));

  const filled = describeRecipe(withModel, { baseUrl: 'https://tts.example.com/api', hasKey: true, model: 'm1', voice: 'v1' });
  assert.deepEqual(filled.missing, []);

  const noText = describeRecipe({ ...RECIPE, synth: { ...RECIPE.synth, body: { voice: '{voice}' } } }, { baseUrl: 'https://x.example', hasKey: true, voice: 'v' });
  assert.deepEqual(noText.missing, ['要念的文字']);
  assert.deepEqual(describeRecipe({ version: 1 }, {}).missing, ['请求']);
  assert.deepEqual(describeRecipe(RECIPE, { hasKey: true, voice: 'v' }).missing, ['请求'], '没填地址');
  // 完整合成地址 + path "/"：不追加斜杠，和服务端拼法一致。
  const full = describeRecipe({ ...RECIPE, synth: { ...RECIPE.synth, path: '/' } }, { baseUrl: 'https://api.minimax.cn/v1/t2a_v2', hasKey: true, voice: 'v' });
  assert.equal(full.rows[0].value, 'POST https://api.minimax.cn/v1/t2a_v2');
  const noVoice = describeRecipe({ ...RECIPE, synth: { ...RECIPE.synth, body: { text: '{text}' } } }, { baseUrl: 'https://x.example', hasKey: true });
  assert.equal(noVoice.rows.find(row => row.id === 'voice').state, 'note', '配方不带音色就不算缺');
});

test('非配方协议隐藏向导；「其他」先只有读文档，没有配方就没有卡片和试合成', () => {
  const h = fixture({ choice: 'openai' });
  h.settings.render();
  assert.equal(h.$('#tts-recipe').hidden, true);
  choose(h.$('#tts-custom-protocol'), 'recipe');
  h.settings.reset();
  assert.equal(h.$('#tts-recipe').hidden, false);
  assert.equal(h.$('#tts-recipe-docs').hidden, false);
  assert.equal(h.$('#tts-recipe-run').textContent, '读文档');
  assert.equal(h.$('#tts-recipe-card').hidden, true);
  assert.equal(h.$('#tts-recipe-test').hidden, true);
  assert.equal(h.$('#tts-recipe-voice-field').hidden, true);
  assert.match(h.$('#tts-recipe-note').textContent, /不向厂商发请求/);
});

test('读文档只调模型：没填 Key 也能读，结果进卡片，焦点去第一个缺项', async () => {
  const pending = deferred();
  const h = fixture({ draftResults: [pending.promise] });
  h.settings.reset();
  h.type('#tts-custom-url', 'https://tts.example.com');
  h.type('#tts-recipe-doc-url', 'https://docs.example.com/tts');
  let focused = '';
  h.$('#tts-custom-key').focus = () => { focused = 'key'; };
  h.fire('#tts-recipe-run', 'click');
  await h.settle();
  assert.equal(h.$('#tts-recipe-run').disabled, true, '读文档中禁用');
  assert.match(h.$('#tts-recipe-status').textContent, /只调模型，不向厂商发请求/);
  pending.resolve({ ok: true, drafted: true, recipe: RECIPE, attempts: 1 });
  await h.settle(); await h.settle();
  assert.deepEqual(h.calls.map(([kind]) => kind), ['draft'], '没有试合成请求');
  assert.equal(h.calls[0][1].apiKey, '');
  assert.equal(h.calls[0][1].docUrl, 'https://docs.example.com/tts');
  assert.equal(h.$('#tts-recipe-card').hidden, false);
  assert.deepEqual(rowState(h), { synth: 'ok', auth: 'missing', voice: 'missing', params: 'note', audio: 'ok', error: 'note', voices: 'note' });
  assert.equal(h.$('#tts-recipe-test').disabled, true, '缺项时不能试合成');
  assert.match(h.$('#tts-recipe-missing').textContent, /还缺：API Key、音色/);
  assert.equal(h.$('#tts-recipe-run').textContent, '重新读文档');
  assert.equal(focused, 'key');

  h.type('#tts-custom-key', 'sk-local');
  h.type('#tts-recipe-voice', 'alloy');
  assert.equal(h.$('#tts-recipe-test').disabled, false, '补齐后可以试合成');
  assert.match(h.$('#tts-recipe-missing').textContent, /格式齐了/);
});

test('助手判断暂不支持：显示类别与原因，没有卡片', async () => {
  const h = fixture({ draftResults: [{ ok: true, drafted: false, unsupported: { category: 'websocket', label: '流式 WebSocket', reason: '只有 wss' }, attempts: 1 }] });
  h.settings.reset();
  h.type('#tts-custom-url', 'https://tts.example.com');
  h.type('#tts-recipe-doc-text', '文档');
  h.fire('#tts-recipe-run', 'click');
  await h.settle(); await h.settle();
  assert.equal(h.$('#tts-recipe-unsupported').hidden, false);
  assert.match(h.$('#tts-recipe-unsupported').textContent, /流式 WebSocket（只有 wss）/);
  assert.equal(h.$('#tts-recipe-card').hidden, true);
});

test('试合成是单独一次点击；失败后才出现「让助手修订」，修订带上一份配方和摘要', async () => {
  const fixed = { ...RECIPE, synth: { ...RECIPE.synth, path: '/v2/speech' } };
  const h = fixture({
    draftResults: [{ ok: true, drafted: true, recipe: RECIPE, attempts: 1 }, { ok: true, drafted: true, recipe: fixed, attempts: 1 }],
    testResults: [{ passed: false, error: '试合成失败', stage: 'request', summary: { status: 404, message: 'not found' } }],
  });
  h.settings.reset();
  h.type('#tts-custom-url', 'https://tts.example.com');
  h.type('#tts-custom-key', 'sk-local');
  h.type('#tts-recipe-doc-text', '文档');
  h.fire('#tts-recipe-run', 'click');
  await h.settle(); await h.settle();
  assert.equal(h.$('#tts-recipe-revise').hidden, true, '还没试合成，不出现修订');
  h.type('#tts-recipe-voice', 'alloy');
  h.fire('#tts-recipe-test', 'click');
  await h.settle(); await h.settle();
  assert.deepEqual(h.calls.map(([kind]) => kind), ['draft', 'test'], '失败不自动修订');
  assert.deepEqual(h.calls[1][1].recipe, RECIPE);
  assert.match(h.$('#tts-recipe-missing').textContent, /请求失败——HTTP 404：not found/, '失败原因紧挨在按钮下方');
  assert.equal(h.$('#tts-recipe-revise').hidden, false);
  assert.equal(h.$('#tts-recipe-result').hidden, true);

  h.fire('#tts-recipe-revise', 'click');
  await h.settle(); await h.settle();
  assert.deepEqual(h.calls.map(([kind]) => kind), ['draft', 'test', 'draft'], '修订只调模型');
  assert.deepEqual(h.calls[2][1].previous, { recipe: RECIPE, summary: { status: 404, message: 'not found' } });
  assert.equal(JSON.parse(h.$('#tts-recipe-json').value).synth.path, '/v2/speech');
  assert.equal(h.$('#tts-recipe-revise').hidden, true, '新配方还没试，修订按钮收起');
  assert.match(h.$('#tts-recipe-missing').textContent, /已修订/, '修订结果也显示在按钮下方');
});

test('通过后显示试听；改 JSON 即时刷新卡片并作废通过；保存门槛给出原因', async () => {
  const h = fixture({ testResults: [passedTest()], draftResults: [{ ok: true, drafted: true, recipe: RECIPE, attempts: 1 }] });
  h.settings.reset();
  h.type('#tts-custom-url', 'https://tts.example.com');
  h.type('#tts-custom-key', 'sk-local');
  h.type('#tts-recipe-doc-text', '文档');
  h.fire('#tts-recipe-run', 'click');
  await h.settle(); await h.settle();
  h.type('#tts-recipe-voice', 'alloy');
  assert.deepEqual(await h.settings.save(), { handled: true, saved: false, message: '先在下方「接口格式」里试合成并试听，通过后再保存接口。' });
  h.fire('#tts-recipe-test', 'click');
  await h.settle(); await h.settle();
  assert.equal(h.$('#tts-recipe-result').hidden, false);
  assert.equal(h.$('#tts-recipe-audio').getAttribute('src'), '/tts/recipe-preview.mp3');
  assert.match(h.$('#tts-recipe-check').textContent, new RegExp(TEST_TEXT));

  // 手改配方：卡片跟着变，通过作废。
  const edited = { ...RECIPE, synth: { ...RECIPE.synth, body: { text: '{text}', voice: '{voice}', model: '{model}' } } };
  h.type('#tts-recipe-json', JSON.stringify(edited));
  assert.equal(rowState(h).model, 'missing');
  assert.equal(h.$('#tts-recipe-result').hidden, true);
  assert.match(h.$('#tts-recipe-json-note').textContent, /重新试合成/);
  assert.equal((await h.settings.save()).saved, false);
  h.type('#tts-recipe-json', '{坏');
  assert.match(h.$('#tts-recipe-missing').textContent, /配方 JSON 格式有误/);
  assert.equal(h.$('#tts-recipe-card').hidden, true);

  // 改回通过时的配方 → 通过恢复，可以保存。
  h.type('#tts-recipe-json', JSON.stringify(RECIPE, null, 2));
  assert.equal(h.$('#tts-recipe-result').hidden, false);
  const result = await h.settings.save();
  assert.deepEqual(result, { handled: true, saved: true });
  assert.deepEqual(h.saves, [{ recipe: RECIPE, presetId: '', voice: 'alloy' }]);
});

test('试合成失败的配方不能保存；改音色也作废通过', async () => {
  const h = fixture({ testResults: [{ passed: false, error: '试合成失败', summary: { status: 401, message: 'bad key' } }, passedTest()] });
  h.settings.reset();
  h.type('#tts-custom-url', 'https://tts.example.com');
  h.type('#tts-custom-key', 'sk-local');
  h.type('#tts-recipe-json', JSON.stringify(RECIPE));
  h.type('#tts-recipe-voice', 'alloy');
  h.fire('#tts-recipe-test', 'click');
  await h.settle(); await h.settle();
  assert.equal((await h.settings.save()).message, '这份配方的试合成没有通过，不能保存。');
  h.fire('#tts-recipe-test', 'click');
  await h.settle(); await h.settle();
  assert.equal(h.$('#tts-recipe-result').hidden, false);
  h.type('#tts-recipe-voice', 'echo');
  assert.equal(h.$('#tts-recipe-result').hidden, true);
  assert.equal((await h.settings.save()).saved, false);
});

test('预设直接载入配方：不显示读文档和修订，填好默认地址/model/音色，没改 JSON 时按 presetId 试合成', async () => {
  const qwen = PRESETS.find(item => item.id === 'qwen-tts');
  const h = fixture({ choice: 'recipe:qwen-tts', testResults: [passedTest()] });
  await h.settings.loadPresets();
  h.settings.reset({ fillDefaults: true });
  assert.equal(h.$('#tts-recipe-docs').hidden, true);
  assert.equal(h.$('#tts-recipe-run').hidden, true);
  assert.equal(h.$('#tts-custom-url').value, qwen.defaults.baseUrl);
  assert.equal(h.$('#tts-custom-model').value, qwen.defaults.model);
  assert.equal(h.$('#tts-recipe-voice').value, qwen.defaults.voice);
  assert.deepEqual(JSON.parse(h.$('#tts-recipe-json').value), qwen.recipe);
  assert.match(h.$('#tts-recipe-note').textContent, new RegExp(qwen.verifiedAt));
  assert.deepEqual(rowState(h).auth, 'missing');
  h.type('#tts-custom-key', 'sk-local');
  h.fire('#tts-recipe-test', 'click');
  await h.settle(); await h.settle();
  assert.equal(h.calls[0][1].presetId, 'qwen-tts');
  assert.equal(h.calls[0][1].recipe, undefined);
  assert.equal(h.$('#tts-recipe-revise').hidden, true);
  assert.equal((await h.settings.save()).saved, true);
  assert.equal(h.saves[0].presetId, 'qwen-tts');
});

test('选了「其他」但地址认得出：提示改用内置协议或预设', () => {
  const h = fixture();
  h.settings.reset();
  h.type('#tts-custom-url', 'https://dashscope.aliyuncs.com');
  h.settings.render();
  assert.equal(h.$('#tts-recipe-suggest').hidden, false);
  const qwenLabel = PRESETS.find(item => item.id === 'qwen-tts').name;
  assert.match(h.$('#tts-recipe-suggest-text').textContent, new RegExp(qwenLabel));
  h.fire('#tts-recipe-suggest-use', 'click');
  assert.deepEqual(h.suggested, ['recipe:qwen-tts']);
  h.type('#tts-custom-url', 'https://tts.example.com');
  h.settings.render();
  assert.equal(h.$('#tts-recipe-suggest').hidden, true);
});

test('已保存的配方接口：回显配方，不算待保存；沿用同 origin 的已保存 Key', () => {
  const endpoint = { id: 'e1', protocol: 'recipe', baseUrl: 'https://tts.example.com', recipe: RECIPE, hasKey: true };
  const h = fixture({ endpoint });
  h.$('#tts-custom-url').value = endpoint.baseUrl;
  h.settings.reset();
  assert.deepEqual(JSON.parse(h.$('#tts-recipe-json').value), RECIPE);
  assert.equal(h.settings.pendingRecipe(), false);
  assert.equal(rowState(h).auth, 'ok', '同 origin 沿用已保存 Key');
  h.type('#tts-custom-url', 'https://other.example.com');
  h.settings.render();
  assert.equal(rowState(h).auth, 'missing', '换了 origin 不沿用');
  assert.equal(h.settings.pendingRecipe(), true);
});
