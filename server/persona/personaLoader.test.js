// personaLoader.test.js — coverage for v2 persona-from-markdown loader.
//
// Run: node server/persona/personaLoader.test.js

import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { loadPersonaMarkdown, clearPersonaCache } from './personaLoader.js';

const ROOT = mkdtempSync(resolve(tmpdir(), 'lunara-persona-loader-test-'));
process.chdir(ROOT);
process.env.LUNARA_RADIOHOST_DIR = resolve(ROOT, 'user/radiohost');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

function writePersona(slug, content) {
  const dir = resolve(ROOT, `user/radiohost/${slug}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'persona.md'), content, 'utf8');
}

function testMissingFileReturnsNull() {
  console.log('\n--- missing persona file returns null ---');
  clearPersonaCache();
  const out = loadPersonaMarkdown('nonexistent_radiohost');
  assert(out === null, 'returns null when file missing');
}

function testReadAndReturn() {
  console.log('\n--- reads markdown and returns content ---');
  clearPersonaCache();
  writePersona('test_a', '# 测试伙伴\n\n## 我是谁\n一个测试伙伴。');
  const out = loadPersonaMarkdown('test_a');
  assert(typeof out === 'string' && out.includes('测试伙伴'), 'content returned verbatim');
  assert(out.includes('我是谁'), 'all sections preserved');
}

function testCacheHit() {
  console.log('\n--- 5 min cache hit on subsequent reads ---');
  clearPersonaCache();
  writePersona('cache_test', '# 原始');
  const a = loadPersonaMarkdown('cache_test');
  // 第二次读，文件未变，应该走缓存（验证：内容相同，且没有抛错）
  const b = loadPersonaMarkdown('cache_test');
  assert(a === b, 'cache hit returns same content on subsequent reads');
  assert(a.includes('原始'), 'content is correct');
}

function testCacheInvalidationOnMtime() {
  console.log('\n--- cache invalidates when file mtime changes ---');
  clearPersonaCache();
  writePersona('mtime_test', '# 第一版');
  const a = loadPersonaMarkdown('mtime_test');
  // 触发 mtime 改变
  const future = new Date(Date.now() + 5000);
  writeFileSync(resolve(ROOT, 'user/radiohost/mtime_test/persona.md'), '# 第二版', 'utf8');
  utimesSync(resolve(ROOT, 'user/radiohost/mtime_test/persona.md'), future, future);
  const b = loadPersonaMarkdown('mtime_test');
  assert(a.includes('第一版'), 'first load got 第一版');
  assert(b.includes('第二版'), 'second load after mtime change got 第二版');
}

function testCacheClearAllowsReread() {
  console.log('\n--- clearPersonaCache forces re-read ---');
  writePersona('clear_test', '# A');
  const a = loadPersonaMarkdown('clear_test');
  writeFileSync(resolve(ROOT, 'user/radiohost/clear_test/persona.md'), '# B', 'utf8');
  clearPersonaCache();
  const b = loadPersonaMarkdown('clear_test');
  assert(a.includes('A'), 'first load got A');
  assert(b.includes('B'), 'after clearPersonaCache, re-read got B');
}

function testEmptyFileReturnsNull() {
  console.log('\n--- empty file returns null ---');
  clearPersonaCache();
  writePersona('empty_test', '');
  const out = loadPersonaMarkdown('empty_test');
  assert(out === null, 'empty file treated as null');
}

async function runTests() {
  console.log('\n🧪 PersonaLoader tests\n');
  try {
    testMissingFileReturnsNull();
    testReadAndReturn();
    testCacheHit();
    testCacheInvalidationOnMtime();
    testCacheClearAllowsReread();
    testEmptyFileReturnsNull();
  } catch (e) {
    console.error('Test runner error:', e);
    failed++;
  }
  console.log(`\n──────────────────────`);
  console.log(`${passed} passed · ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
