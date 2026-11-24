// settingsNavigation.contract.test.js — 设置分组只挪 DOM，不改 id / data-tip / 页 key。
// Run: node --test pwa/features/settings/settingsNavigation.contract.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { parseHTML } from 'linkedom';

const PWA_ROOT = resolve(import.meta.dirname, '../..');

const SETTINGS_IDS = [
  'settings-title', 'boot-close', 'settings-nav', 'settings-content',
  'boot-location-input', 'boot-location-save', 'boot-location-auto', 'boot-location-clear', 'boot-location-note',
  'routine-settings', 'settings-source-accounts', 'settings-source-account-status',
  'single-source-settings', 'boot-primary', 'multi-source-settings', 'recommendation-weights', 'source-mode-note',
  'presence-ambient-toggle', 'presence-ambient-note', 'presence-greeting-toggle', 'presence-greeting-note',
  'web-access-disclosure', 'web-access-toggle', 'web-access-fallback', 'web-access-cost', 'web-access-status',
  'tray-text-card', 'tray-text-options', 'boot-warn', 'boot-go',
  'theme-choices', 'modernist-base-setting', 'modernist-base-label', 'nocturne-material-setting', 'nocturne-material-label',
  'artwork-theme-controls', 'artwork-theme-toggle',
  'memory-settings-title', 'mem-stats', 'mem-status', 'mem-retry', 'mem-input', 'mem-tags', 'mem-add', 'mem-search', 'mem-consolidate', 'mem-list',
  'llm-active-model-settings', 'llm-providers-settings', 'llm-failover-settings',
  'song-tag-auto', 'song-tag-coverage', 'song-tag-backfill', 'song-tag-save', 'song-tag-status',
  'usage-settings', 'song-tag-inspector', 'boot-tts-providers',
  'tts-custom-endpoint-list', 'tts-custom-endpoint-add', 'tts-custom-editor', 'tts-custom-editor-title', 'tts-custom-editor-state',
  'tts-custom-name', 'tts-custom-protocol', 'tts-custom-url', 'tts-custom-key', 'tts-custom-model', 'tts-custom-models-btn',
  'tts-custom-note', 'tts-custom-models-list', 'tts-recipe', 'tts-recipe-title', 'tts-recipe-note', 'tts-recipe-suggest',
  'tts-recipe-suggest-text', 'tts-recipe-suggest-use', 'tts-recipe-docs', 'tts-recipe-doc-url', 'tts-recipe-doc-text',
  'tts-recipe-run', 'tts-recipe-status', 'tts-recipe-unsupported', 'tts-recipe-card', 'tts-recipe-voice-field', 'tts-recipe-voice',
  'tts-recipe-test', 'tts-recipe-revise', 'tts-recipe-missing', 'tts-recipe-result', 'tts-recipe-audio', 'tts-recipe-check',
  'tts-recipe-details', 'tts-recipe-json', 'tts-recipe-json-note', 'tts-custom-remove-confirm', 'tts-custom-remove-text',
  'tts-custom-remove-yes', 'tts-custom-remove-no', 'tts-custom-endpoint-remove', 'tts-custom-design-toggle',
  'tts-custom-save-endpoint', 'tts-custom-status', 'tts-endpoint-failures', 'tts-endpoint-failures-title',
  'tts-endpoint-failures-refresh', 'tts-endpoint-failures-summary', 'tts-endpoint-failures-list', 'tts-custom-design',
  'tts-custom-design-title', 'tts-custom-design-close', 'tts-custom-design-person', 'tts-custom-design-draft',
  'tts-custom-design-chars', 'tts-custom-design-description', 'tts-custom-design-preview', 'tts-custom-design-name',
  'tts-custom-design-count', 'tts-custom-design-cost', 'tts-custom-design-run', 'tts-pool-add-title', 'tts-pool-source',
  'tts-custom-voices-btn', 'tts-custom-manual', 'tts-custom-manual-add', 'tts-free-block', 'tts-free-title', 'tts-free-toggle',
  'tts-free-consent', 'tts-free-disclosure', 'tts-free-agree', 'tts-free-cancel', 'tts-free-status', 'tts-custom-candidates',
  'tts-custom-candidate-title', 'tts-custom-candidate-close', 'tts-custom-candidate-filter', 'tts-custom-candidate-select-all',
  'tts-custom-candidate-add', 'tts-custom-candidate-count', 'tts-custom-candidate-list', 'tts-custom-voice-toolbar',
  'tts-custom-voice-filter', 'tts-custom-select-all', 'tts-custom-remove-selected', 'tts-custom-voice-count',
  'tts-custom-voice-editor', 'tts-custom-save', 'tts-custom-dirty', 'tts-pool-status', 'tts-fallback-toggle',
  'tts-fallback-target', 'tts-fallback-note', 'tts-fallback-status',
];

const SETTINGS_TIPS = [
  '手动填写的城市会固定下来，IP 自动定位不会覆盖它。坐标只用于查天气，保留到城区级。',
  '按当前网络出口定位到城市；失败时保持原来的城市不变。',
  '保存后用于之后的选歌；不打断当前歌曲，也不清空已有队列。',
  '只用选定来源；它不可用时不会自动换源，也不会静默换歌。',
  '按推荐比例在多个来源里选歌；具体比例在下方调整。',
  '只列可播放的来源；目录型来源（仅跳转）不参与播放。',
  '相对比例：调到 70% 时其余来源自动分掉 30%。只影响候选，不保证实际播放比例。',
  '只影响主动开口，不影响普通聊天与换歌串词。',
  '一起听歌时伙伴偶尔接一两句；关掉后只在你说话和换歌串词时开口。',
  '离开一阵再打开 app 时最多说一句；你先开口或开始打字就不说。',
  '只在你提问时联网，不逐次确认；后台反思、续播和主动开口不联网。',
  '开启后伙伴遇到公开问题会直接搜索，不逐次确认。',
  '只在 Exa 不可用时启用；同样使用匿名免费入口，不转收费服务。',
  '保存播放来源与模型配置；不打断当前歌曲，也不清空已有队列。',
  '只在素色主题下出现；换底色不改播放与布局。',
  '只改面板材质；实底更省电，玻璃更透。',
  '按当前歌曲封面提取底色，界面跟着封面变；关闭后固定用主题配色。',
  '对话、串词与打标都走它；各聊天可以单独覆盖。',
  '网络超时、限流、服务异常或认证/权限失败时，按顺序尝试已授权备用；总等待上限不增加，已展示正文不重放。',
  '只给候选池的歌补标签，供推荐与播客背景过滤；不会偷偷扫全库。',
  '只有播放到的新歌才会入队；不主动扫描整库。',
  '一次最多入队 100 首，后台串行打标，不阻塞播放。',
  '只保存自动补标开关；已经生成的标签不会被覆盖。',
  '这里只说明合成器是否就绪；实际声线在创建伙伴时按伙伴挑选。',
  '可以接入多个语音接口；保存后在下方「声音池」获取它们的声音，创建伙伴时从声音池挑。',
  '只用于在声音列表里区分来源，例如 MiniMax、Breeze。',
  '不同厂商的请求和返回格式不同；不确定就选 OpenAI 兼容，接不上再试「其他」。',
  'OpenAI 兼容填 https://tts.example.com/v1；MiniMax、Breeze 填主域名或完整接口地址均可。',
  '只保存在本机配置里；留空表示沿用已保存的 key。',
  '向这个接口查询可用的 model（会先保存连接信息）。',
  '把上一次试合成的失败原因交给助手改配方；只调模型，不向厂商发请求。',
  '按一段描述让厂商生成新音色；只有支持的接口（Breeze、MiniMax）显示。',
  '只保存这个接口的连接信息；声音池在下方单独保存。',
  '伙伴用这个接口发声失败时记在本机（最新 200 条）：原因、卡在哪一步、各花了多久。不记要念的文字。',
  '用你配置的模型读这个伙伴的人设，起草一段音色描述；人设原文不会发给 TTS 厂商。',
  '所有接口保留下来的声音；创建伙伴时从这里挑。',
  '不需要账号和 Key 的声音；默认关闭，开启前会说明它会把文字发给谁。',
  '只保存声音池；不会改动伙伴已经绑定的声音。',
  '伙伴自己的声音出技术故障时，换一把声音把这段念完；顶部提醒会说明由谁代读。',
];

async function loadIndex() {
  const html = await readFile(resolve(PWA_ROOT, 'index.html'), 'utf8');
  return parseHTML(html);
}

function settingsPage(document, pageId) {
  return document.querySelector(`section.settings-page[data-settings-page="${pageId}"]`);
}

test('music accounts move onto connection and source mode stays on general', async () => {
  const { document } = await loadIndex();
  const connection = settingsPage(document, 'connection');
  const general = settingsPage(document, 'general');
  assert.ok(connection.querySelector('#settings-source-accounts'), '账号列表在模型与连接');
  assert.ok(connection.querySelector('#settings-source-account-status'), '账号状态在模型与连接');
  assert.equal(general.querySelector('#settings-source-accounts'), null);
  assert.ok(general.querySelector('#single-source-settings'));
  assert.ok(general.querySelector('#multi-source-settings'));
  assert.ok(general.querySelector('input[name="playback-source-mode"][value="single"]'));
  assert.ok(general.querySelector('input[name="playback-source-mode"][value="multi"]'));
  assert.ok(connection.querySelector('#song-tag-auto'), '歌曲打标仍留在模型与连接');
});

test('advanced group lists tags, usage, then failover as their own pages', async () => {
  const { document } = await loadIndex();
  const group = document.querySelector('#settings-nav .settings-nav-group');
  assert.ok(group, '导航要有高级组');
  assert.equal(group.getAttribute('aria-label'), '高级');
  assert.equal(group.getAttribute('data-settings-page'), null, '组本身不是一页');
  const items = [...group.querySelectorAll('.settings-nav-item')];
  assert.deepEqual(items.map(item => item.getAttribute('data-settings-page')), ['tags', 'usage', 'failover']);
  assert.deepEqual(items.map(item => item.querySelector('span')?.textContent), ['歌曲标签', '使用统计', '故障切换']);
  const failover = settingsPage(document, 'failover');
  assert.ok(failover?.querySelector('#llm-failover-settings'));
  assert.ok(failover.querySelector('section[aria-label="模型故障切换"]'));
  assert.equal(settingsPage(document, 'connection').querySelector('#llm-failover-settings'), null);
  assert.match(failover.querySelector('[data-tip]')?.getAttribute('data-tip') || '', /认证\/权限失败/);
  assert.equal(document.querySelector('#settings-nav [data-settings-page="connection"]')?.tagName, 'BUTTON');
  assert.equal(document.querySelector('#settings-nav [data-settings-page="voice"]')?.tagName, 'BUTTON');
});

test('regrouping keeps every settings id and data-tip', async () => {
  const { document } = await loadIndex();
  const panel = document.querySelector('#settings-panel');
  const ids = [...panel.querySelectorAll('[id]')].map(element => element.id);
  assert.deepEqual([...ids].sort(), [...SETTINGS_IDS].sort());
  assert.equal(new Set(ids).size, ids.length, '每个 id 仍然只出现一次');
  const tips = [...panel.querySelectorAll('[data-tip]')].map(element => element.getAttribute('data-tip'));
  assert.deepEqual([...tips].sort(), [...SETTINGS_TIPS].sort());
});

test('usage jump still targets the usage page inside the advanced group', async () => {
  const { document } = await loadIndex();
  const providers = await readFile(resolve(PWA_ROOT, 'features/settings/llmProvidersSettings.js'), 'utf8');
  assert.match(providers, /data-settings-page-link="usage"/);
  const usage = document.querySelector('#settings-nav .settings-nav-group [data-settings-page="usage"]');
  assert.ok(usage, '使用统计入口必须指向高级组里的 usage 页');
  assert.equal(usage.getAttribute('data-settings-page'), 'usage');
});

test('music source failure opens connection and usage loads only on its page', async () => {
  const app = await readFile(resolve(PWA_ROOT, 'app.js'), 'utf8');
  const start = app.indexOf('const sourceFailureWarning = createSourceFailureWarning');
  const block = app.slice(start, app.indexOf('const moonlightSidebar', start));
  assert.match(block, /kind === 'voice'[\s\S]*setPage\('voice'\)/);
  assert.match(block, /setPage\('connection'\)/);
  assert.doesNotMatch(block, /setPage\('general'\)/);
  assert.match(app, /usageSettings\.setActive\(page === 'usage'\)/);
  const styles = await readFile(resolve(PWA_ROOT, 'styles.css'), 'utf8');
  assert.match(styles, /\.settings-nav-group\s*\{[^}]*display:\s*flex/);
  assert.match(styles, /@media \(max-width: 640px\) \{[\s\S]*?\.settings-nav-group\s*\{[^}]*flex-direction:\s*row/);
});
