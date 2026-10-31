import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sourceUrl = new URL('../index.js', import.meta.url);

test('server/index.js remains a compatibility composition root', async () => {
  const source = await readFile(sourceUrl, 'utf8');
  const lines = source.split('\n').length;

  assert.doesNotMatch(source, /app\.(?:get|post|put|patch|delete)\s*\(/);
  assert.doesNotMatch(source, /function\s+(?:produceTracks|_produceTracksInner|queueSnapshot|startPlaybackComponent|stopPlaybackComponent)\s*\(/);
  assert.doesNotMatch(source, /queueTools\.setController\s*\(/);
  assert.match(source, /new MusicSelectionService\s*\(/);
  assert.match(source, /createPlaybackRuntimeComposition\s*\(/);
  assert.doesNotMatch(source, /PlaybackOrchestrator|PlaybackReconciliationService/);
  assert.match(source, /registerDefaultRoutes\s*\(/);
  // 路由薄层依赖 requireService 兜底；组合根漏传服务时整个功能面会静默降级为 503。
  // TasteAdminService 从 root 读 user 四文件 + playlists.json：装配错位（指包根）会静默脏读。
  assert.match(source, /root:\s*resolveDataRoot\(\)/);
  assert.match(source, /lifeContextService:\s*lifeContext\.service/);
  assert.ok(lines < 750, `composition root grew to ${lines} lines; extract the new responsibility`);
});
