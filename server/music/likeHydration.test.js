import assert from 'node:assert/strict';
import test from 'node:test';
import { createLikeHydration } from './likeHydration.js';

function fakeService() {
  const calls = [];
  return {
    calls,
    hydrate: async ({ tracks }) => { calls.push(tracks); return { ok: true }; },
  };
}

test('nothing happens before a service is attached', () => {
  const hydration = createLikeHydration();
  assert.equal(hydration.request({ programId: 'p1', tracks: [{ songId: 'a' }] }), false);
});

test('one program is hydrated once, even if it is committed twice', async () => {
  const service = fakeService();
  const hydration = createLikeHydration();
  hydration.attach(service);

  const program = { programId: 'p1', tracks: [{ source: 'ncm', songId: 'a' }] };
  assert.equal(hydration.request(program), true);
  assert.equal(hydration.request(program), false);
  await new Promise(done => setTimeout(done, 0));
  assert.equal(service.calls.length, 1);
});

test('a new program hydrates again, and empty programs are ignored', async () => {
  const service = fakeService();
  const hydration = createLikeHydration();
  hydration.attach(service);

  hydration.request({ programId: 'p1', tracks: [{ source: 'ncm', songId: 'a' }] });
  hydration.request({ programId: 'p2', tracks: [{ source: 'ncm', songId: 'b' }] });
  hydration.request({ programId: 'p3', tracks: [] });
  hydration.request({ programId: 'p4' });
  await new Promise(done => setTimeout(done, 0));

  assert.equal(service.calls.length, 2);
});

test('a failing hydration never rejects into the commit path', async () => {
  const hydration = createLikeHydration();
  hydration.attach({
    hydrate: async () => { throw new Error('remote down'); },
  });
  assert.equal(hydration.request({ programId: 'p1', tracks: [{ source: 'ncm', songId: 'a' }] }), true);
  await new Promise(done => setTimeout(done, 0));
});

test('the de-duplication window stays bounded', async () => {
  const service = fakeService();
  const hydration = createLikeHydration({ maxPrograms: 4 });
  hydration.attach(service);

  for (let i = 0; i < 10; i += 1) {
    hydration.request({ programId: `p${i}`, tracks: [{ source: 'ncm', songId: String(i) }] });
  }
  await new Promise(done => setTimeout(done, 0));
  assert.equal(service.calls.length, 10, '旧 id 被挤出窗口后不影响新节目');

  // 最近的一份仍然在窗口里，不会被重复水合。
  assert.equal(hydration.request({ programId: 'p9', tracks: [{ source: 'ncm', songId: '9' }] }), false);
});
