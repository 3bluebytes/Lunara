import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { readFileSync } from 'node:fs';
import { createLlmFailoverSettings } from './llmFailoverSettings.js';

const SEP = '\u0001';
const PROVIDERS = [
  { id: 'alpha', name: 'Alpha', enabled: true, models: ['a-1', 'a-2'], disabledModels: ['a-2'] },
  { id: 'beta', name: 'Beta', enabled: true, models: ['b-1'], disabledModels: [] },
  { id: 'gamma', name: 'Gamma', enabled: false, models: ['g-1'], disabledModels: [] },
];
const ACTIVE = { providerId: 'alpha', model: 'a-1' };
const DEFAULT_POLICY = { enabled: false, allowCrossProvider: false, targets: [] };
const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function setup({ policy = DEFAULT_POLICY, get, put } = {}) {
  const { document } = parseHTML('<html><body><div id="llm-failover-settings"></div></body></html>');
  const calls = [];
  const api = {
    get: async (path) => {
      calls.push({ method: 'GET', path });
      if (get) return get();
      return { ok: true, policy };
    },
    put: async (path, body) => {
      calls.push({ method: 'PUT', path, body });
      if (put) return put(body);
      return { ok: true, policy: body };
    },
  };
  const view = createLlmFailoverSettings({ apiClient: api, documentLike: document });
  const $ = (id) => document.getElementById(id);
  const host = document.querySelector('#llm-failover-settings');
  const options = (id) => [...document.getElementById(id).querySelectorAll('option')];
  const optionLabels = (id) => options(id).map((option) => option.textContent);
  const choose = (id, providerId, model) => {
    const value = providerId + SEP + model;
    const list = options(id);
    const target = list.find((option) => option.getAttribute('value') === value);
    assert.ok(target, 'missing option ' + value);
    for (const option of list) option.selected = false;
    target.selected = true;
  };
  const clickSave = () => {
    const button = $('llm-failover-save');
    assert.ok(button, 'save button missing');
    button.click();
  };
  const puts = () => calls.filter((call) => call.method === 'PUT');
  return { document, view, calls, $, host, optionLabels, options, choose, clickSave, puts };
}

test('settings help describes authentication failover without promising unlimited retries', () => {
  const { document } = parseHTML(readFileSync(new URL('../../index.html', import.meta.url), 'utf8'));
  const card = document.querySelector('section[aria-label="模型故障切换"]');
  assert.match(card.textContent, /认证\/权限失败/);
  assert.match(card.textContent, /总等待上限不增加/);
  assert.match(card.textContent, /跨供应商须单独授权/);
  assert.doesNotMatch(card.textContent, /临时网络故障才|只对临时网络故障/);
  assert.match(card.querySelector('[data-tip]').getAttribute('data-tip'), /认证\/权限失败/);
});

test('default state: failover and cross-provider off, empty targets, policy read once', async () => {
  const f = setup();
  await f.view.refresh({ providers: PROVIDERS, activeModel: ACTIVE });
  assert.equal(f.calls[0].method, 'GET');
  assert.equal(f.calls[0].path, '/api/llm/failover');
  assert.equal(f.$('llm-failover-enabled').checked, false);
  assert.equal(f.$('llm-failover-allow-cross').checked, false);
  assert.equal(f.$('llm-failover-target-0').value, '');
  assert.equal(f.$('llm-failover-target-1').value, '');
  assert.equal(f.$('llm-failover-status').getAttribute('role'), 'status');
  assert.match(f.$('llm-failover-status').textContent, /关闭/);
});

test('candidates only list enabled providers and enabled models', async () => {
  const f = setup();
  await f.view.refresh({ providers: PROVIDERS, activeModel: ACTIVE });
  assert.deepEqual(f.optionLabels('llm-failover-target-0'), ['不选择', 'Alpha · a-1', 'Beta · b-1']);
  assert.deepEqual(f.optionLabels('llm-failover-target-1'), ['不选择', 'Alpha · a-1', 'Beta · b-1']);
});

test('saved target that is no longer selectable stays visible as disabled and marked ineffective', async () => {
  const f = setup({
    policy: { enabled: true, allowCrossProvider: true, targets: [{ providerId: 'retired', model: 'old' }] },
  });
  await f.view.refresh({ providers: PROVIDERS, activeModel: ACTIVE });
  const select = f.$('llm-failover-target-0');
  const stale = f
    .options('llm-failover-target-0')
    .find((option) => option.getAttribute('value') === 'retired' + SEP + 'old');
  assert.ok(stale);
  assert.equal(stale.disabled, true);
  assert.match(stale.textContent, /未生效/);
  assert.equal(select.value, 'retired' + SEP + 'old');
  assert.equal(f.$('llm-failover-target-1').value, '');
});

test('enabling without a target and duplicate targets are rejected without a write', async () => {
  const f = setup();
  await f.view.refresh({ providers: PROVIDERS, activeModel: ACTIVE });
  f.$('llm-failover-enabled').checked = true;
  f.clickSave();
  await flush();
  assert.equal(f.puts().length, 0);
  assert.match(f.$('llm-failover-status').textContent, /至少选择一个备用模型/);

  f.choose('llm-failover-target-0', 'alpha', 'a-1');
  f.choose('llm-failover-target-1', 'alpha', 'a-1');
  f.clickSave();
  await flush();
  assert.equal(f.puts().length, 0);
  assert.match(f.$('llm-failover-status').textContent, /不能是同一个模型/);
});

test('cross-provider target requires explicit consent, then saves the whole policy once', async () => {
  const f = setup();
  await f.view.refresh({ providers: PROVIDERS, activeModel: ACTIVE });
  f.$('llm-failover-enabled').checked = true;
  f.choose('llm-failover-target-0', 'beta', 'b-1');
  f.clickSave();
  await flush();
  assert.equal(f.puts().length, 0);
  assert.match(f.$('llm-failover-status').textContent, /跨供应商/);
  assert.match(f.$('llm-failover-status').textContent, /跳过/);

  f.$('llm-failover-allow-cross').checked = true;
  f.clickSave();
  await flush();
  assert.equal(f.puts().length, 1);
  assert.equal(f.puts()[0].path, '/api/llm/failover');
  assert.deepEqual(f.puts()[0].body, {
    enabled: true,
    allowCrossProvider: true,
    targets: [{ providerId: 'beta', model: 'b-1' }],
  });
  assert.match(f.$('llm-failover-status').textContent, /已保存/);
});

test('failed save keeps the draft, hides the raw error and allows retry', async () => {
  let fail = true;
  const f = setup({
    put: (body) => {
      if (fail) throw new Error('boom secret /api/llm/failover key=sk-live');
      return { ok: true, policy: body };
    },
  });
  await f.view.refresh({ providers: PROVIDERS, activeModel: ACTIVE });
  f.$('llm-failover-enabled').checked = true;
  f.choose('llm-failover-target-0', 'alpha', 'a-1');
  f.clickSave();
  await flush();
  assert.equal(f.puts().length, 1);
  assert.equal(f.$('llm-failover-enabled').checked, true);
  assert.equal(f.$('llm-failover-target-0').value, 'alpha' + SEP + 'a-1');
  assert.match(f.$('llm-failover-status').textContent, /未保存/);
  assert.ok(!f.$('llm-failover-status').textContent.includes('secret'));
  assert.ok(!f.$('llm-failover-status').textContent.includes('sk-live'));

  fail = false;
  f.clickSave();
  await flush();
  assert.equal(f.puts().length, 2);
  assert.equal(f.$('llm-failover-target-0').value, 'alpha' + SEP + 'a-1');
  assert.equal(f.$('llm-failover-save').getAttribute('aria-busy'), 'false');
  assert.match(f.$('llm-failover-status').textContent, /已保存/);
});

test('a pending save marks aria-busy, keeps controls enabled and never posts twice', async () => {
  let release;
  const f = setup({
    put: (body) =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, policy: body });
      }),
  });
  await f.view.refresh({ providers: PROVIDERS, activeModel: ACTIVE });
  f.$('llm-failover-enabled').checked = true;
  f.choose('llm-failover-target-0', 'alpha', 'a-1');
  f.clickSave();
  f.clickSave();
  f.clickSave();
  await flush();
  assert.equal(f.puts().length, 1);
  const button = f.$('llm-failover-save');
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(button.disabled, false);
  assert.equal(f.$('llm-failover-target-0').disabled, false);
  release();
  await flush();
  assert.equal(f.puts().length, 1);
  assert.equal(f.$('llm-failover-save').getAttribute('aria-busy'), 'false');
  assert.match(f.$('llm-failover-status').textContent, /已保存/);
});

test('malicious provider and model names are rendered as text, never as HTML', async () => {
  const evilName = '<img src=x onerror="globalThis.__pwned=1">';
  const evilModel = '<script>globalThis.__pwned=1</script>';
  const f = setup();
  await f.view.refresh({
    providers: [{ id: 'evil', name: evilName, enabled: true, models: [evilModel], disabledModels: [] }],
    activeModel: { providerId: 'evil', model: evilModel },
  });
  assert.equal(f.host.querySelectorAll('img').length, 0);
  assert.equal(f.host.querySelectorAll('script').length, 0);
  assert.ok(f.host.textContent.includes(evilName));
  assert.ok(f.$('llm-failover-target-0').textContent.includes(evilModel));
  assert.equal(globalThis.__pwned, undefined);
});

test('load failure shows a fixed message plus retry, and retry redraws the form', async () => {
  let fail = true;
  const f = setup({
    get: () => {
      if (fail) throw new Error('GET /api/llm/failover failed key=sk-live');
      return { ok: true, policy: DEFAULT_POLICY };
    },
  });
  await f.view.refresh({ providers: PROVIDERS, activeModel: ACTIVE });
  assert.equal(f.$('llm-failover-enabled'), null);
  const statusNode = f.$('llm-failover-status');
  assert.equal(statusNode.getAttribute('role'), 'status');
  assert.ok(!statusNode.textContent.includes('sk-live'));
  assert.ok(!statusNode.textContent.includes('/api/llm/failover'));
  assert.ok(f.$('llm-failover-retry'));

  fail = false;
  f.$('llm-failover-retry').click();
  await flush();
  assert.ok(f.$('llm-failover-enabled'));
  assert.equal(f.$('llm-failover-enabled').checked, false);
});
