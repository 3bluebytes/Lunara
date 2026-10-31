import test from 'node:test';
import assert from 'node:assert/strict';
import { registerDefaultRoutes } from './registerDefaultRoutes.js';

/**
 * The registered HTTP surface, captured without express internals or service
 * stubs: the route registrars only ever call the verb methods below, so a
 * recording stand-in is enough to inventory them.
 */
function registeredRoutes() {
  const routes = [];
  const record = method => path => { routes.push({ method, path }); };
  const app = {
    get: record('GET'),
    post: record('POST'),
    put: record('PUT'),
    patch: record('PATCH'),
    delete: record('DELETE'),
  };
  registerDefaultRoutes(app, {});
  return routes;
}

/**
 * Path shapes that change state. A GET route matching one of these is reachable
 * from any page the user visits, with no interaction, so it must not exist.
 *
 * This list is deliberately a denylist of known offenders rather than a general
 * heuristic; the GET snapshot test below is what forces review of anything new.
 */
const STATE_CHANGING_GET_PATTERNS = [
  /\/api\/login\/(?:qq\/)?qr$/,   // creating a QR session ends the current session
  /\/api\/next$/,                  // advances playback
  /\/api\/test-play$/,             // committed a program outside the commit pipeline
  /\/api\/logout/,                 // ends a music-source session
  /\/activate$/,                   // switches the active person or radiohost
  /\/cancel$/,                     // cancels an in-flight turn
  /\/archive$/,                    // archives a person
  /\/consolidate$/,                // rewrites runtime-owned user data
  /\/backfill$/,                   // starts background work
  /\/import$/,                     // mutates the library
  /\/refresh$/,                    // triggers work
  /\/revoke$/,                     // revokes a memory claim
];

function stateChangingGetRoutes(routes) {
  return routes
    .filter(route => route.method === 'GET')
    .filter(route => STATE_CHANGING_GET_PATTERNS.some(pattern => pattern.test(route.path)))
    .map(route => route.path);
}

const EXPECTED_GET_ROUTES = Object.freeze([
  '/api/conversations',
  '/api/conversations/:sessionId/turns',
  '/api/radiohost/active',
  '/api/radiohost/list',
  // 环境快照：只读，载荷仅城市名与天气摘要，不含坐标。
  '/api/environment',
  // 自定义 TTS 配置视图：只读，key 以 hasKey 布尔呈现，绝不出现在载荷里。
  '/api/tts/custom',
  // 配方预设：只读，随软件发布的静态配方（只有 {apiKey} 占位符），不含任何凭据。
  '/api/tts/custom/recipe-presets',
  // 发声失败记录：只读，只有接口 id、原因码、阶段与耗时，不含文字、上游原文或 key。
  '/api/tts/failures',
  '/api/health',
  '/api/library/status',
  // 曲库中的跨源待确认建议与已确认来源；只读，不自动写等价关系。
  '/api/library/recordings',
  // 今日生活资料：本地只读（周作息 / 单日投影 / 条目 / 场景默认）。
  '/api/life/days/:date',
  '/api/life/entries',
  '/api/life/routine',
  '/api/life/scene-defaults',
  '/api/life/status',
  '/api/login/qq/qr/check',
  '/api/login/qr/check',
  '/api/me/library',
  '/api/memory/person/:personId',
  '/api/memory/shared',
  '/api/memory/status',
  '/api/now',
  '/api/plan/today',
  '/api/persona-presets',
  // 陪伴感在场状态：只读产品事实（档位/静默时段/今日次数），不含原因码与调度内部结构。
  '/api/presence/status',
  // 「一起听歌时伙伴会主动说话」开关的读取（写入走 POST）。
  '/api/presence/preferences',
  '/api/reflection/status',
  '/api/settings',
  // 联网策略只读，不触发出站；启用/停用使用 JSON PATCH。
  '/api/web-access/settings',
  '/api/llm/failover',
  '/api/llm/providers',
  '/api/llm/session-model',
  '/api/llm/usage',
  // 用量报告：只读聚合（逐日 token、按模型拆分、失败分类），不含正文与凭据。
  '/api/llm/usage/report',
  '/api/songtags/config',
  '/api/songtags/status',
  // 标签库浏览：只读分页列表（手动查看/修正标签的设置页后端）。
  '/api/songtags',
  '/api/station/memory',
  '/api/station/status',
  '/api/station/voices',
  '/api/taste',
  // 单曲喜欢状态：只读投影（本地意图 + 该源能否写远端），写入走 POST。
  '/api/track-like',
  '/api/tts/status',
  '/api/taste/log',
  '/api/taste/status',
  '/api/virtual-persons',
  '/api/virtual-persons/:id',
  // 删除前披露影响面：删除不可回退，必须能先读到真实影响。
  '/api/virtual-persons/:id/deletion-impact',
  '/api/warmpool/status',
]);

test('the registered GET surface is exactly the reviewed read-only set', () => {
  const getPaths = registeredRoutes()
    .filter(route => route.method === 'GET')
    .map(route => route.path)
    .sort();
  // Adding or removing a GET route fails here on purpose: the full surface is
  // small enough to review by hand, and every read endpoint is rebinding-exposed.
  assert.deepEqual(getPaths, [...EXPECTED_GET_ROUTES].sort());
});

test('no registered GET route matches a state-changing shape', () => {
  assert.deepEqual(stateChangingGetRoutes(registeredRoutes()), []);
});

test('the detector flags the GET routes this change removed', () => {
  // Teeth check against the pre-change table. Without this, a detector that
  // matches nothing would look identical to a clean surface.
  const previous = [
    { method: 'GET', path: '/api/login/qr' },
    { method: 'GET', path: '/api/login/qq/qr' },
    { method: 'GET', path: '/api/next' },
    { method: 'GET', path: '/api/test-play' },
    ...EXPECTED_GET_ROUTES.map(path => ({ method: 'GET', path })),
  ];
  assert.deepEqual(stateChangingGetRoutes(previous), [
    '/api/login/qr',
    '/api/login/qq/qr',
    '/api/next',
    '/api/test-play',
  ]);
});

test('operations that change state are registered under a mutating method', () => {
  const routes = registeredRoutes();
  const methodOf = path => routes.filter(route => route.path === path).map(route => route.method).sort();
  for (const path of ['/api/next', '/api/pb-event', '/api/play-outcome', '/api/chat', '/api/login/qr',
    '/api/login/qq/qr', '/api/logout', '/api/logout/qq', '/api/memory/summarize']) {
    assert.deepEqual(methodOf(path), ['POST'], `${path} must exist as POST only`);
  }
  assert.deepEqual(methodOf('/api/radiohost/:id'), ['DELETE']);
});

test('settings keeps a read GET beside its write POST', () => {
  // Paths that legitimately carry both verbs: GET reads the snapshot,
  // POST changes it. The write is protected by the JSON content-type rule.
  const routes = registeredRoutes();
  const methodOf = path => routes.filter(route => route.path === path).map(route => route.method).sort();
  assert.deepEqual(methodOf('/api/settings'), ['GET', 'POST']);
  // 陪伴开关同理：GET 只读，POST 改值，同样受 JSON content-type 规则保护。
  assert.deepEqual(methodOf('/api/presence/preferences'), ['GET', 'POST']);
});