import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppState } from '../../core/appState.js';
import { createRadiohostController, normalizeVirtualPerson, normalizeVoiceProfiles } from './radiohostController.js';

test('voice profiles accept canonical API objects and legacy source wrappers', () => {
  assert.deepEqual(normalizeVoiceProfiles([
    { id: 'mini-1', displayName: '暖声', description: '温柔', styleTags: ['warm'] },
    { voice_id: 'fish-1', name: 'Fish', source: 'fish', tags: 'soft,gentle', sourceLabel: '自定义接口' },
    { id: '', displayName: 'broken' },
  ]), [
    { id: 'mini-1', displayName: '暖声', description: '温柔', styleTags: ['warm'], source: 'unknown', sourceLabel: '', isFallback: false, unavailable: false },
    { id: 'fish-1', displayName: 'Fish', description: '', styleTags: ['soft', 'gentle'], source: 'fish', sourceLabel: '自定义接口', isFallback: false, unavailable: false },
  ]);
});

test('回落状态随声音对象透传，供界面如实标注', () => {
  // 服务端已按当前可用性解析：缺凭据时原生声音会标 isFallback。
  const [voice] = normalizeVoiceProfiles([
    { id: 'vp_sweet_lady', displayName: '柔声女声', description: '温柔电台女声', styleTags: ['soft'], isFallback: true },
  ]);
  assert.equal(voice.isFallback, true);
  assert.equal(voice.unavailable, false);
  // 不是回落的必须保持 false，不能把"原生可用"也说成本地代播。
  const [native] = normalizeVoiceProfiles([{ id: 'vp_x', displayName: 'X' }]);
  assert.equal(native.isFallback, false);
});

test('virtual-person entities keep canonical fields and expose a temporary display alias', () => {
  assert.deepEqual(normalizeVirtualPerson({ id: 'lunara', displayName: 'Lunara', kind: 'root' }), {
    id: 'lunara', displayName: 'Lunara', name: 'Lunara', kind: 'root',
  });
});

test('load uses one session-scoped virtual-person bootstrap and defaults to root Lunara', async () => {
  const calls = [];
  const store = createAppState({ sessionId: 'conversation:test' });
  const controller = createRadiohostController({
    store,
    apiClient: {
      get: async path => {
        calls.push(path);
        return {
          ok: true,
          persons: [
            { id: 'lunara', displayName: 'Lunara', kind: 'root' },
            { id: 'radiohost-a', displayName: '阿宁', kind: 'radiohost' },
          ],
          session: { sessionId: 'conversation:test', activeVirtualPersonId: 'lunara' },
        };
      },
    },
  });

  const snapshot = await controller.load();
  assert.deepEqual(calls, ['/api/virtual-persons?sessionId=conversation%3Atest']);
  assert.equal(snapshot.persons.length, 2);
  assert.equal(snapshot.activeRadiohost.id, 'lunara');
  assert.equal(store.getState().sessionId, 'conversation:test');
});

test('switching virtual person carries the stable session and preserves playback state', async () => {
  const calls = [];
  const queue = [{ kind: 'track', song_id: 'one' }];
  const store = createAppState({
    activeRadiohost: { id: 'lunara', displayName: 'Lunara', name: 'Lunara', kind: 'root' },
    queue,
    cursor: 0,
    sessionId: 'conversation:test',
  });
  const controller = createRadiohostController({
    store,
    apiClient: {
      post: async (path, body) => {
        calls.push([path, body]);
        return { ok: true, entity: { id: 'radiohost-b', displayName: '夜航', kind: 'radiohost' } };
      },
    },
  });

  const result = await controller.activate('radiohost-b');
  assert.equal(result.switched, true);
  assert.deepEqual(calls, [[
    '/api/virtual-persons/radiohost-b/activate',
    { sessionId: 'conversation:test' },
  ]]);
  assert.equal(store.getState().activeRadiohost.id, 'radiohost-b');
  assert.deepEqual(store.getState().queue, queue);
  assert.equal(store.getState().cursor, 0);
});

test('a repeated activation is ignored while the first request is in flight', async () => {
  let release;
  let calls = 0;
  const store = createAppState({ activeRadiohost: { id: 'lunara', name: 'Lunara', kind: 'root' } });
  const controller = createRadiohostController({
    store,
    apiClient: {
      post: async () => {
        calls += 1;
        return new Promise(resolve => { release = resolve; });
      },
    },
  });
  const first = controller.activate('radiohost-a');
  const duplicate = await controller.activate('radiohost-a');
  assert.equal(duplicate.accepted, false);
  assert.equal(calls, 1);
  release({ ok: true, entity: { id: 'radiohost-a', displayName: '阿宁', kind: 'radiohost' } });
  await first;
});

test('creating a child does not activate it and archiving returns the session to server authority', async () => {
  const calls = [];
  const store = createAppState({ activeRadiohost: { id: 'lunara', name: 'Lunara', kind: 'root' } });
  const bootstrap = {
    ok: true,
    persons: [{ id: 'lunara', displayName: 'Lunara', kind: 'root' }],
    session: { activeVirtualPersonId: 'lunara' },
  };
  const controller = createRadiohostController({
    store,
    apiClient: {
      get: async () => bootstrap,
      post: async (path, body) => {
        calls.push([path, body]);
        if (path === '/api/virtual-persons') {
          return { ok: true, person: { id: 'radiohost-new', displayName: '星河', kind: 'radiohost' } };
        }
        return { ok: true, person: { id: 'radiohost-new', status: 'archived' } };
      },
    },
  });

  const created = await controller.createRadiohost({ displayName: '星河', voiceProfileId: 'voice-a' });
  assert.equal(created.person.id, 'radiohost-new');
  assert.equal(store.getState().activeRadiohost.id, 'lunara');
  await controller.archivePerson('radiohost-new');
  assert.deepEqual(calls, [
    ['/api/virtual-persons', { displayName: '星河', voiceProfileId: 'voice-a' }],
    ['/api/virtual-persons/radiohost-new/archive', {}],
  ]);
});

test('root Lunara cannot be archived from the browser controller', async () => {
  const controller = createRadiohostController({
    store: createAppState(),
    apiClient: { post: async () => ({ ok: true }) },
  });
  await assert.rejects(controller.archivePerson('lunara'), /不能归档/);
});

test('voice loading fails visibly on an empty server result', async () => {
  const controller = createRadiohostController({
    store: createAppState(),
    apiClient: { get: async () => ({ ok: true, voices: [] }) },
  });
  await assert.rejects(controller.loadVoices(), /设置 → 声音/);
});
