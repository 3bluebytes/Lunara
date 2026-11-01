import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionTraceStore, sanitizeTraceValue } from './sessionTraceStore.js';

const FIXED_NOW = Date.parse('2026-10-15T07:00:00.000Z');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function fixture(t, options = {}) {
  const temp = await mkdtemp(path.join(tmpdir(), 'lunara-session-trace-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'sessions');
  const sessions = new Map();
  const warnings = [];
  const session = (sessionId, overrides = {}) => {
    const value = {
      sessionId, title: '夜晚聊天', createdAt: '2026-10-14T20:00:00.000Z',
      owner: { kind: 'host', id: 'host-one', name: '月亮' }, ...overrides,
    };
    sessions.set(sessionId, value);
    return value;
  };
  const config = { root, resolveSession: id => sessions.get(id) ?? null, now: () => FIXED_NOW,
    logger: { warn: (...args) => warnings.push(args) }, ...options };
  const store = new SessionTraceStore(config);
  t.after(() => store.flush());
  return { temp, root, sessions, session, warnings, config, store };
}

async function segments(root) {
  const found = [];
  async function visit(dir, depth) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 2) await visit(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(file);
    }
  }
  await visit(root, 0);
  return found.sort();
}

async function rows(file) {
  return (await readFile(file, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
}

function assertChain(records) {
  const seen = new Set();
  records.forEach((record, index) => {
    assert.match(record.id, UUID);
    assert.equal(seen.has(record.id), false);
    seen.add(record.id);
    assert.equal(record.sequence, index);
    assert.equal(record.previousEventId, index ? records[index - 1].id : null);
    assert.equal(record.timestamp, new Date(FIXED_NOW).toISOString());
  });
}

test('construction and unowned records perform no data writes', async t => {
  const f = await fixture(t);
  assert.deepEqual(await readdir(f.temp), []);
  assert.equal(f.store.record({}, { type: 'unowned' }), undefined);
  f.store.record({ sessionId: 'absent' }, { type: 'missing' });
  await f.store.flush();
  assert.deepEqual(await readdir(f.temp), []);
  assert.deepEqual(f.store.status(), { pendingBytes: 0, droppedEvents: 0, writeFailures: 0 });
});

test('header and ordered records retain identity, causality and private diagnostic content', async t => {
  const f = await fixture(t);
  const metadata = f.session('session-one');
  const context = { sessionId: 'session-one', executionId: 'execution', roundId: 'round', requestId: 'request',
    virtualPersonId: 'person', spanId: 'span', parentSpanId: 'parent-span', toolCallId: 'tool', modelCallId: 'model' };
  f.store.record(context, { type: 'model_call', prompt: '本地私密上下文', reasoning: 'provider 返回的推理文字',
    id: 'spoof', sequence: 999, previousEventId: 'spoof', sessionId: 'spoof', timestamp: 'spoof' });
  f.store.record(context, { type: 'model_result', content: '你好' });
  assert.ok(f.store.status().pendingBytes > 0);
  await f.store.flush();
  const files = await segments(f.root);
  assert.equal(files.length, 1);
  assert.match(path.relative(f.root, files[0]), /^host-.+--[a-f0-9]+[/\\][^/\\]+--[a-f0-9]+[/\\][^/\\]+--[^/\\]+\.jsonl$/u);
  const records = await rows(files[0]);
  assertChain(records);
  assert.equal(records[0].type, 'session');
  assert.equal(records[0].version, 1);
  assert.deepEqual(records[0].owner, metadata.owner);
  assert.equal(records[0].title, metadata.title);
  assert.match(records[0].instanceId, UUID);
  for (const [key, value] of Object.entries(context)) assert.equal(records[1][key], value);
  assert.equal(records[1].prompt, '本地私密上下文');
  assert.equal(records[1].reasoning, 'provider 返回的推理文字');
  assert.equal(records[2].content, '你好');
  assert.equal(f.store.status().pendingBytes, 0);
});

test('interleaved sessions remain isolated and individually ordered', async t => {
  const f = await fixture(t);
  f.session('one');
  f.session('two', { owner: { kind: 'group', id: 'group-two', name: '一起听' } });
  await Promise.all(Array.from({ length: 20 }, async (_, index) => {
    f.store.record({ sessionId: index % 2 ? 'one' : 'two' }, { type: 'step', index });
  }));
  await f.store.flush();
  const files = await segments(f.root);
  assert.equal(files.length, 2);
  for (const file of files) {
    const records = await rows(file);
    assertChain(records);
    assert.equal(records.length, 11);
    assert.ok(records.every(record => record.sessionId === records[0].sessionId));
    assert.deepEqual(records.slice(1).map(record => record.index),
      Array.from({ length: 10 }, (_, i) => i * 2 + (records[0].sessionId === 'one' ? 1 : 0)));
  }
});

test('restart creates an exclusive segment without editing a previous crash tail', async t => {
  const f = await fixture(t);
  f.session('one');
  f.store.record({ sessionId: 'one' }, { type: 'before_restart' });
  await f.store.flush();
  const [oldFile] = await segments(f.root);
  await appendFile(oldFile, '{"type":"partial');
  const oldBytes = await readFile(oldFile);
  const next = new SessionTraceStore(f.config);
  next.record({ sessionId: 'one' }, { type: 'after_restart' });
  await next.flush();
  const files = await segments(f.root);
  assert.equal(files.length, 2);
  assert.deepEqual(await readFile(oldFile), oldBytes);
  const newFile = files.find(file => file !== oldFile);
  assert.equal(path.dirname(newFile), path.dirname(oldFile));
  assertChain(await rows(newFile));
});

test('title, owner and membership changes reuse the directory and emit metadata', async t => {
  const f = await fixture(t);
  const session = f.session('one');
  f.store.record({ sessionId: 'one' }, { type: 'before' });
  session.title = '新名称';
  session.owner = { kind: 'group', id: 'new-group', name: '新成员' };
  f.store.record({ sessionId: 'one' }, { type: 'after' });
  f.store.record({ sessionId: 'one' }, { type: 'unchanged' });
  await f.store.flush();
  const [file] = await segments(f.root);
  const records = await rows(file);
  assertChain(records);
  assert.equal(records[0].title, '夜晚聊天');
  assert.deepEqual(records.map(record => record.type), ['session', 'before', 'metadata', 'after', 'unchanged']);
  assert.equal(records[2].title, '新名称');
  assert.deepEqual(records[2].owner, session.owner);
  session.owner.name = '再次改名';
  session.createdAt = '2020-01-01T00:00:00Z';
  const next = new SessionTraceStore(f.config);
  next.record({ sessionId: 'one' }, { type: 'after_restart' });
  await next.flush();
  const files = await segments(f.root);
  assert.equal(files.length, 2);
  assert.ok(files.every(segment => path.dirname(segment) === path.dirname(file)));
  assert.equal((await rows(files.find(segment => segment !== file)))[0].owner.name, '再次改名');
});

test('path-like identities cannot escape root and all managed paths are private', async t => {
  const f = await fixture(t, { instanceId: '../../outside/evil' });
  const id = '../../outside/session\u0000?';
  f.session(id, { title: '../../title', createdAt: '../../bad-time',
    owner: { kind: 'host', id: '../../outside', name: '../ /\\\u0000恶意:名字' } });
  f.store.record({ sessionId: id }, { type: 'event' });
  await f.store.flush();
  const [file] = await segments(f.root);
  assert.ok(file);
  assert.equal((await rows(file))[0].sessionId, id);
  assert.deepEqual(await readdir(f.temp), ['sessions']);
  // POSIX 权限位：Windows/NTFS 不实现 0o700/0o600 语义（固定报 0o666），跳过权限位断言但保留路径逃逸防护验证。
  if (process.platform !== 'win32') {
    for (const dir of [f.root, path.dirname(path.dirname(file)), path.dirname(file)]) {
      assert.equal((await lstat(dir)).mode & 0o777, 0o700);
    }
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
  }
});

test('sanitization removes nested credentials, URLs, raw payloads and exception details, preserving token usage', async t => {
  const f = await fixture(t);
  f.session('one');
  const exception = Object.assign(new Error('private-exception-message'), { code: 'NETWORK_FAILURE', status: 503,
    token: 'exception-token-secret' });
  const event = { type: 'model_result',
    authorization: 'auth-secret', Cookie: 'cookie-secret', apiKey: 'key-secret', client_secret: 'client-secret-value',
    password: 'password-secret', credential: 'credential-secret', headers: { innocent: 'header-secret' },
    nested: [{ access_token: 'access-secret', refreshToken: 'refresh-secret', token: 'token-secret',
      media: 'binary-media-secret', audioUrl: 'relative-media-secret', URL: 'url-field-secret' }],
    arguments: JSON.stringify({ api_key: 'json-key-secret', body: { cookie: 'json-cookie-secret' }, maxTokens: 32 }),
    content: JSON.stringify({ nested: JSON.stringify({ password: 'double-json-secret' }), completion_tokens: 20 }),
    text: '公开文字 Bearer abcDEF123.secret-token 和 sk-proj-1234567890abcdef https://secret.example/audio?token=abc',
    maxTokens: 1000, usage: { completion_tokens: 900, reasoning_tokens: 850, prompt_tokens: 10, total_tokens: 910 },
    providerPayload: { unprojected: 'provider-raw-secret' }, raw: { content: 'raw-secret' },
    exception, nestedException: { name: 'Error', code: 'EIO', stack: 'nested-stack-secret' },
  };
  f.store.record({ sessionId: 'one' }, event);
  await f.store.flush();
  const [file] = await segments(f.root);
  const raw = await readFile(file, 'utf8');
  for (const secret of ['auth-secret', 'cookie-secret', 'key-secret', 'client-secret-value', 'password-secret',
    'credential-secret', 'header-secret', 'access-secret', 'refresh-secret', 'token-secret', 'binary-media-secret',
    'relative-media-secret', 'url-field-secret', 'json-key-secret', 'json-cookie-secret', 'double-json-secret',
    'abcDEF123.secret-token', 'sk-proj-1234567890abcdef', 'secret.example', 'private-exception-message',
    'exception-token-secret', 'nested-stack-secret', 'provider-raw-secret', 'raw-secret']) assert.ok(!raw.includes(secret), secret);
  const record = (await rows(file))[1];
  assert.equal(record.maxTokens, 1000);
  assert.deepEqual(record.usage, event.usage);
  assert.equal(JSON.parse(record.arguments).maxTokens, 32);
  assert.equal(JSON.parse(record.content).completion_tokens, 20);
  assert.deepEqual(record.exception, { name: 'Error', code: 'NETWORK_FAILURE', status: 503 });
  assert.ok(record.text.includes('公开文字'));
});

test('sanitizer bounds deep, circular and hostile values without invoking getters or toJSON', () => {
  const deep = { prompt: 'readable' };
  let cursor = deep;
  for (let i = 0; i < 2000; i++) { cursor.next = {}; cursor = cursor.next; }
  const cyclic = { name: 'safe' };
  cyclic.self = cyclic;
  let invoked = false;
  const hostile = { toJSON() { invoked = true; throw new Error('do not invoke'); } };
  Object.defineProperty(hostile, 'value', { enumerable: true, get() { invoked = true; throw new Error('do not invoke'); } });
  const sanitized = sanitizeTraceValue({ deep, cyclic, hostile });
  assert.equal(invoked, false);
  const json = JSON.stringify(sanitized);
  assert.ok(json.length < 10000);
  assert.match(json, /truncat/i);
  assert.ok(json.includes('readable'));
  assert.doesNotThrow(() => sanitizeTraceValue(new Proxy({}, { ownKeys() { throw new Error('private'); } })));
});

test('record snapshots caller-owned context, event and resolver metadata synchronously', async t => {
  const f = await fixture(t);
  const metadata = f.session('one');
  const context = { sessionId: 'one', requestId: 'original-request' };
  const event = { type: 'context', messages: [{ role: 'user', content: 'original-prompt' }] };
  assert.equal(f.store.record(context, event), undefined);
  context.sessionId = 'other';
  context.requestId = 'mutated-request';
  event.messages[0].content = 'mutated-prompt';
  metadata.title = 'mutated-title';
  metadata.owner.name = 'mutated-name';
  await f.store.flush();
  const records = await rows((await segments(f.root))[0]);
  assert.equal(records[0].title, '夜晚聊天');
  assert.equal(records[0].owner.name, '月亮');
  assert.equal(records[1].sessionId, 'one');
  assert.equal(records[1].requestId, 'original-request');
  assert.equal(records[1].messages[0].content, 'original-prompt');
});

test('oversized events retain a redacted prefix and explicit original byte size and limit', async t => {
  const f = await fixture(t, { maxEventBytes: 1024 });
  f.session('one');
  f.store.record({ sessionId: 'one' }, { type: 'context', prompt: '可读上下文 '.repeat(2000),
    tail: 'Bearer abcdef123456789 sk-secret-end-of-oversized-input' });
  await f.store.flush();
  const [file] = await segments(f.root);
  const raw = await readFile(file, 'utf8');
  for (const line of raw.trimEnd().split('\n')) assert.ok(Buffer.byteLength(line + '\n') <= 1024);
  const record = (await rows(file))[1];
  assert.equal(record.truncated, true);
  assert.equal(record.truncation.limitBytes, 1024);
  assert.ok(record.truncation.originalBytes > 1024);
  assert.ok(record.redactedPrefix.includes('可读上下文'));
  assert.ok(!raw.includes('abcdef123456789'));
  assert.ok(!raw.includes('sk-secret-end'));
});

test('queue pressure is bounded, counted, and followed by a chained trace_gap', async t => {
  const f = await fixture(t, { maxPendingBytes: 2800, maxEventBytes: 1024 });
  f.session('one');
  for (let index = 0; index < 20; index++) {
    f.store.record({ sessionId: 'one' }, { type: 'context', prompt: 'p'.repeat(2000), index });
    assert.ok(f.store.status().pendingBytes <= 2800);
  }
  const dropped = f.store.status().droppedEvents;
  assert.ok(dropped > 0);
  await f.store.flush();
  f.store.record({ sessionId: 'one' }, { type: 'recovered' });
  await f.store.flush();
  const records = await rows((await segments(f.root))[0]);
  assertChain(records);
  const gaps = records.filter(record => record.type === 'trace_gap');
  assert.ok(gaps.length >= 1);
  assert.equal(gaps.reduce((sum, gap) => sum + gap.droppedEvents, 0), dropped);
  assert.equal(records.at(-1).type, 'recovered');
  assert.deepEqual(f.store.status(), { pendingBytes: 0, droppedEvents: dropped, writeFailures: 0 });
});

test('resolver and filesystem failures cannot throw into business calls or expose payloads', async t => {
  const f = await fixture(t);
  const failure = new SessionTraceStore({ ...f.config, resolveSession() { throw new Error('secret resolver payload'); } });
  assert.doesNotThrow(() => failure.record({ sessionId: 'one' }, { type: 'event' }));
  await failure.flush();
  assert.ok(failure.status().writeFailures > 0);
  f.session('one');
  await writeFile(f.root, 'not-a-directory');
  assert.doesNotThrow(() => f.store.record({ sessionId: 'one' }, { type: 'event', content: 'secret event payload' }));
  await f.store.flush();
  assert.ok(f.store.status().writeFailures > 0);
  assert.equal(f.store.status().pendingBytes, 0);
  assert.ok(f.warnings.length >= 2);
  assert.ok(f.warnings.every(args => args.length === 1 && typeof args[0] === 'string'));
  assert.equal(new Set(f.warnings.map(args => args[0])).size, 1);
  assert.ok(!JSON.stringify(f.warnings).includes('secret'));
  const badLogger = new SessionTraceStore({ ...f.config, resolveSession() { throw new Error('private'); },
    logger: { warn() { throw new Error('logger failure'); } } });
  assert.doesNotThrow(() => badLogger.record({ sessionId: 'one' }, { type: 'event' }));
  await badLogger.flush();
});

test('a fixed instance/file collision never truncates or appends an earlier segment', async t => {
  const f = await fixture(t, { instanceId: randomUUID() });
  f.session('one');
  f.store.record({ sessionId: 'one' }, { type: 'original' });
  await f.store.flush();
  const [file] = await segments(f.root);
  const original = await readFile(file);
  const collision = new SessionTraceStore(f.config);
  collision.record({ sessionId: 'one' }, { type: 'collision' });
  await collision.flush();
  assert.deepEqual(await readFile(file), original);
  assert.ok(collision.status().writeFailures > 0);
});

test('a root symlink is rejected but symlink ancestors of the chosen user root are resolved', async t => {
  const f = await fixture(t);
  f.session('one');
  const external = path.join(f.temp, 'external');
  await mkdir(external);
  await symlink(external, f.root, 'dir');
  f.store.record({ sessionId: 'one' }, { type: 'blocked' });
  await f.store.flush();
  assert.deepEqual(await readdir(external), []);
  assert.ok(f.store.status().writeFailures > 0);
  const ancestor = path.join(f.temp, 'ancestor');
  await symlink(external, ancestor, 'dir');
  const allowed = new SessionTraceStore({ ...f.config, root: path.join(ancestor, 'sessions') });
  allowed.record({ sessionId: 'one' }, { type: 'allowed' });
  await allowed.flush();
  assert.equal((await segments(path.join(external, 'sessions'))).length, 1);
  assert.equal(allowed.status().writeFailures, 0);
});

test('replaced managed directories and segment symlinks are never followed', async t => {
  const f = await fixture(t);
  f.session('one');
  f.store.record({ sessionId: 'one' }, { type: 'before' });
  await f.store.flush();
  const [file] = await segments(f.root);
  const outsideFile = path.join(f.temp, 'outside.jsonl');
  await writeFile(outsideFile, 'untouched');
  await rm(file);
  await symlink(outsideFile, file);
  f.store.record({ sessionId: 'one' }, { type: 'after' });
  await f.store.flush();
  assert.equal(await readFile(outsideFile, 'utf8'), 'untouched');
  const ownerDir = path.dirname(path.dirname(file));
  const outsideDir = path.join(f.temp, 'outside-dir');
  await rename(ownerDir, outsideDir);
  await symlink(outsideDir, ownerDir, 'dir');
  const next = new SessionTraceStore(f.config);
  next.record({ sessionId: 'one' }, { type: 'new_instance' });
  await next.flush();
  assert.ok(next.status().writeFailures > 0);
  assert.equal(await readFile(outsideFile, 'utf8'), 'untouched');
});

test('delete blocks immediately, drains accepted records, and only removes identity-validated segments', async t => {
  const f = await fixture(t);
  f.session('one');
  f.session('two');
  f.store.record({ sessionId: 'one' }, { type: 'before' });
  f.store.record({ sessionId: 'two' }, { type: 'unrelated' });
  await f.store.flush();
  const files = await segments(f.root);
  const byId = new Map(await Promise.all(files.map(async file => [(await rows(file))[0].sessionId, file])));
  const target = byId.get('one');
  const directory = path.dirname(target);
  const userFile = path.join(directory, 'notes.jsonl');
  const malformedFile = path.join(directory, `2026-10-15T07-00-00-000Z--${randomUUID()}.jsonl`);
  const foreignFile = path.join(directory, path.basename(byId.get('two')).replace('.jsonl', '-foreign.jsonl'));
  const linkFile = path.join(directory, `2026-10-15T07-00-00-000Z--${randomUUID()}.jsonl`);
  await writeFile(userFile, 'user-owned');
  await writeFile(malformedFile, '{"sessionId":"one"}\n');
  await writeFile(foreignFile, await readFile(byId.get('two')));
  await symlink(byId.get('two'), linkFile);
  const unrelated = await readFile(byId.get('two'));
  f.store.record({ sessionId: 'one' }, { type: 'queued_before_delete' });
  const deletion = f.store.deleteSession('one');
  f.store.record({ sessionId: 'one' }, { type: 'late_during_delete' });
  await deletion;
  f.store.record({ sessionId: 'one' }, { type: 'late_after_delete' });
  await f.store.flush();
  await assert.rejects(lstat(target), { code: 'ENOENT' });
  assert.equal(await readFile(userFile, 'utf8'), 'user-owned');
  assert.equal(await readFile(malformedFile, 'utf8'), '{"sessionId":"one"}\n');
  assert.deepEqual(await readFile(foreignFile), unrelated);
  assert.equal((await lstat(linkFile)).isSymbolicLink(), true);
  assert.deepEqual(await readFile(byId.get('two')), unrelated);
  assert.equal(f.store.status().pendingBytes, 0);
});

test('delete before the first queued write finishes cannot recreate a segment', async t => {
  const f = await fixture(t);
  f.session('one');
  f.store.record({ sessionId: 'one' }, { type: 'pending' });
  const deletion = f.store.deleteSession('one');
  f.store.record({ sessionId: 'one' }, { type: 'too_late' });
  await deletion;
  await f.store.flush();
  assert.deepEqual(await segments(f.root), []);
});

test('delete works in a fresh instance without resolver metadata and preserves old unrelated files', async t => {
  const f = await fixture(t);
  f.session('one');
  f.store.record({ sessionId: 'one' }, { type: 'event' });
  await f.store.flush();
  const [file] = await segments(f.root);
  const next = new SessionTraceStore({ ...f.config, resolveSession: () => null });
  await next.deleteSession('one');
  await assert.rejects(lstat(file), { code: 'ENOENT' });
});

test('cleanup failures are reported safely and the deletion tombstone remains effective', { skip: process.platform === 'win32' ? '依赖 POSIX「rename 打开中的目录」语义，Windows 上目录被句柄锁定会 EPERM' : false }, async t => {
  const f = await fixture(t);
  f.session('one');
  f.store.record({ sessionId: 'one' }, { type: 'event' });
  await f.store.flush();
  const [file] = await segments(f.root);
  const ownerDir = path.dirname(path.dirname(file));
  const displaced = path.join(f.temp, 'displaced');
  await rename(ownerDir, displaced);
  await symlink(displaced, ownerDir, 'dir');
  await assert.rejects(f.store.deleteSession('one'), error => {
    assert.equal(error.code, 'SESSION_TRACE_CLEANUP_FAILED');
    assert.ok(!error.message.includes(f.temp));
    return true;
  });
  await rm(ownerDir);
  await rename(displaced, ownerDir);
  const before = await readFile(file);
  f.store.record({ sessionId: 'one' }, { type: 'must_stay_blocked' });
  await f.store.flush();
  assert.deepEqual(await readFile(file), before);
  assert.ok(f.store.status().writeFailures > 0);
});

test('recordTask writes task header and ordered records to tasks/ directory without fabricating sessionId', async t => {
  const f = await fixture(t);
  const taskRoot = f.store.taskRoot;
  assert.equal(f.store.recordTask({}, { type: 'noop' }), undefined);
  assert.equal(f.store.recordTask({ taskType: 'capability_probe' }, { type: 'noop' }), undefined);
  assert.equal(f.store.recordTask({ taskId: '123' }, { type: 'noop' }), undefined);
  await f.store.flush();
  assert.deepEqual(await readdir(f.temp).catch(() => []), []);

  const taskContext = {
    taskType: 'capability_probe',
    taskId: 'prog-2026-10-15',
    title: '模型能力探测',
    targetDate: '2026-10-15',
    hostPersonId: 'lunara',
    requestId: 'req-draft-1',
  };
  f.store.recordTask(taskContext, { type: 'draft_started', prompt: '探测提示', tokenCount: 42 });
  f.store.recordTask(taskContext, { type: 'draft_finished', result: 'ok', secretKey: 'sk-123456789' });
  await f.store.flush();

  const files = await segments(taskRoot);
  assert.equal(files.length, 1);
  const rel = path.relative(taskRoot, files[0]);
  assert.match(rel, /^capability_probe[/\\]2026-10-15--[a-f0-9]+[/\\][^/\\]+\.jsonl$/u);

  const records = await rows(files[0]);
  assert.equal(records.length, 3);
  assert.equal(records[0].type, 'task');
  assert.equal(records[0].version, 1);
  assert.equal(records[0].taskType, 'capability_probe');
  assert.equal(records[0].taskId, 'prog-2026-10-15');
  assert.equal(records[0].title, '模型能力探测');
  assert.equal(records[0].targetDate, '2026-10-15');
  assert.equal(records[0].hostPersonId, 'lunara');
  assert.equal(records[0].sessionId, undefined, '绝不伪造 sessionId');
  assert.match(records[0].instanceId, UUID);

  assert.equal(records[1].sequence, 1);
  assert.equal(records[1].taskType, 'capability_probe');
  assert.equal(records[1].taskId, 'prog-2026-10-15');
  assert.equal(records[1].type, 'draft_started');
  assert.equal(records[1].prompt, '探测提示');
  assert.equal(records[1].tokenCount, 42);

  assert.equal(records[2].sequence, 2);
  assert.equal(records[2].previousEventId, records[1].id);
  assert.equal(records[2].type, 'draft_finished');
  assert.equal(records[2].secretKey, '[redacted]', '敏感凭据已脱敏');

  // 第二个实例写入同一任务：独占新建片段，不改写旧文件：
  const store2 = new SessionTraceStore({ root: f.root, taskRoot, now: () => FIXED_NOW + 1000 });
  store2.recordTask(taskContext, { type: 'rerun' });
  await store2.flush();

  const filesAfter = await segments(taskRoot);
  assert.equal(filesAfter.length, 2, '同任务重启创建新片段');
  assert.equal(path.dirname(filesAfter[0]), path.dirname(filesAfter[1]), '复用同一任务目录');
});
