// taggingQueue.js — 进程内串行打标队列（防 LLM storm）
//
// resolveTrack 命中一首没打过标的歌时，会"异步入队"打标（不阻塞播放）。
// 若不限并发，热门时段几十首歌同时解析会瞬间打爆 deepseek。这里用一个
// 串行（默认 concurrency=1）队列把打标摊平，并做 in-flight 去重 + 失败统计，
// 给 /api/songtags/status 暴露可观测性。
//
// 设计要点：
//   - 纯内存、无持久化（重启即清空；持久化的是 song_tags 本身）。
//   - 入队即 in-flight 去重：同一 songId 排队/执行期间再入队直接忽略。
//   - generateSongTags 自带 TTL 判定、内容失败降级为占位、绝不抛内容异常；唯一例外是
//     日内预算拒绝（LLM_BUDGET_EXHAUSTED）：它不写占位也不冒充内容失败，如实抛给本层记录，
//     歌曲保持未打标以便额度恢复后重试。这里负责调度 + 统计（含该失败分类）。
//   - enqueueTagging 接受 deps 注入，方便 backfill 传 { force:true } 和测试 mock。

import { generateSongTags } from './songTagGenerator.js';
import { providerOf } from './songTagStore.js';

const MAX_CONCURRENCY = Math.max(1, Number(process.env.SONG_TAG_CONCURRENCY) || 1);
const MAX_RECENT_FAILURES = 20;

const queue = [];
const inflight = new Set(); // provider:songId 排队中或执行中（去重）
let running = 0;
let _generate = generateSongTags; // 可被测试替换
const settledObservers = new Set();

const stats = {
  enqueued: 0,
  done: 0,        // confidence>0 的成功打标
  placeholders: 0, // 写了行但 confidence=0（失败降级 / 低置信占位）
  failed: 0,       // 抛错（预算拒绝是预期路径；其余为兜底）
  recentFailures: [],
  recentPlaceholders: [], // 占位行的可诊断原因（source_text），有界滚动窗口
};

function _recordFailure(songId, reason) {
  stats.recentFailures.unshift({ songId, reason: String(reason).slice(0, 200), at: Date.now() });
  if (stats.recentFailures.length > MAX_RECENT_FAILURES) stats.recentFailures.length = MAX_RECENT_FAILURES;
}

// 占位不是抛错，但同样要能诊断「为什么这首歌没打上标」（finishReason=length / 空正文 / 非 JSON…）。
function _recordPlaceholder(songId, reason) {
  stats.recentPlaceholders.unshift({ songId, reason: String(reason || 'placeholder').slice(0, 200), at: Date.now() });
  if (stats.recentPlaceholders.length > MAX_RECENT_FAILURES) stats.recentPlaceholders.length = MAX_RECENT_FAILURES;
}

/**
 * 入队一首歌的打标任务（幂等去重，立即返回）。
 * @param {object} song - { songId, title, artist, source?, year? }
 * @param {object} [deps] - 透传给 generateSongTags（如 { force:true } / 测试 mock）
 * @returns {boolean} 是否真正入队（已在队列/执行中 → false）
 */
export function enqueueTagging(song, deps = {}) {
  const songId = song?.songId != null ? String(song.songId) : '';
  if (!songId) return false;
  const provider = providerOf(song?.provider ?? song?.source);
  const key = `${provider}:${songId}`;
  if (inflight.has(key)) return false;
  inflight.add(key);
  queue.push({ song: { ...song, provider }, deps, key });
  stats.enqueued += 1;
  _drain();
  return true;
}

function _drain() {
  while (running < MAX_CONCURRENCY && queue.length) {
    const job = queue.shift();
    running += 1;
    _run(job).finally(() => { running -= 1; _drain(); });
  }
}

async function _run({ song, deps, key }) {
  const songId = String(song.songId);
  let result = null;
  let error = null;
  try {
    result = await _generate(song, deps);
    if (result && Number(result.confidence) > 0) stats.done += 1;
    else {
      stats.placeholders += 1;
      _recordPlaceholder(songId, result?.source_text);
    }
  } catch (e) {
    error = e;
    stats.failed += 1;
    _recordFailure(songId, e?.message || e);
  } finally {
    inflight.delete(key);
    for (const observer of settledObservers) {
      try { Promise.resolve(observer({ song, result, error })).catch(() => {}); } catch {}
    }
  }
}

export function onTaggingSettled(observer) {
  if (typeof observer !== 'function') return () => {};
  settledObservers.add(observer);
  return () => settledObservers.delete(observer);
}

/** 队列 + 累计统计快照（/api/songtags/status 用）。 */
export function queueStats() {
  return {
    pending: queue.length,
    running,
    concurrency: MAX_CONCURRENCY,
    enqueued: stats.enqueued,
    done: stats.done,
    placeholders: stats.placeholders,
    failed: stats.failed,
    recentFailures: stats.recentFailures.slice(0, MAX_RECENT_FAILURES),
    recentPlaceholders: stats.recentPlaceholders.slice(0, MAX_RECENT_FAILURES),
  };
}

/** 队列是否已排空（无 pending、无 running）。测试 / 优雅关闭用。 */
export function idle() {
  return queue.length === 0 && running === 0;
}

/** 轮询等待队列排空（测试用）。 */
export async function waitIdle({ timeoutMs = 5000, intervalMs = 10 } = {}) {
  const start = Date.now();
  while (!idle()) {
    if (Date.now() - start > timeoutMs) throw new Error('taggingQueue.waitIdle timeout');
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

// ---- 测试钩子：替换底层 generator / 重置状态 ----
export function __setGeneratorForTest(fn) { _generate = fn || generateSongTags; }
export function __resetForTest() {
  queue.length = 0;
  inflight.clear();
  running = 0;
  _generate = generateSongTags;
  stats.enqueued = 0; stats.done = 0; stats.placeholders = 0; stats.failed = 0;
  stats.recentFailures.length = 0;
  stats.recentPlaceholders.length = 0;
}
