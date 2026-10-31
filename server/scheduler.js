// Background memory and library maintenance. Listening continuation belongs to PlaybackRuntime.
import cron from 'node-cron';
import * as consolidator from './consolidator.js';
import { MemoryConsolidator } from './memory/MemoryConsolidator.js';
import { MemoryType } from './memory/types.js';
import { TasteSchemaService, stationMemoryTarget, stationPersonIds } from './memory/TasteSchemaService.js';
import { generateDailySummary, generateWeeklySummary } from './memory/summary.js';
import { trace } from './trace.js';
import * as ncm from './ncm.js';
import * as qq from './qq.js';
import { runBackfill } from './songtags/backfill.js';

let _station = null;  // v2: 需要拿到 station 来遍历伙伴
let _librarySyncService = null;
let _tasteSchemaService = null;
let _started = false;
const _scheduledTasks = [];

/** 注入运行时入口（由 index.js 提供） */
export function attach(station, services = {}) {
  if (station) _station = station;
  if (services.librarySyncService) _librarySyncService = services.librarySyncService;
}

export function detach() {
  _station = null;
  _librarySyncService = null;
  _tasteSchemaService = null;
}

function _schedule(expression, callback) {
  const task = cron.schedule(expression, callback);
  _scheduledTasks.push(task);
  return task;
}

/**
 * v2: 每 30 分钟扫 working memory，删过期 + evict 超量。
 * 无 env gate —— 这是 hygiene 不是 feature。
 */
async function _runWorkingSweep() {
  if (!_station) return;
  const radiohosts = _station.listRadioHosts?.() || [];
  for (const radiohost of radiohosts) {
    try {
      const mem = await _station.getRadioHostMemoryService?.(radiohost.id);
      if (!mem) continue;
      const store = mem.getStore();
      const expired = store.deleteExpired(mem.namespace);
      const evicted = store.evict(MemoryType.WORKING, 200, mem.namespace);
      if (expired + evicted > 0) {
        trace(`[memory-sweep] radiohost=${radiohost.id} expired=${expired} evicted=${evicted}`);
      }
    } catch (e) {
      console.warn(`[memory-sweep] radiohost=${radiohost.id} failed:`, e.message);
    }
  }
}

/**
 * v2: 每天 23:00 跑 daily summary（规则版，不烧 LLM）。
 * gate: MEMORY_SUMMARY_AUTO=1
 */
async function _runDailySummary() {
  if (!_station) return;
  if (process.env.MEMORY_SUMMARY_AUTO !== '1') {
    trace('[memory-summary] MEMORY_SUMMARY_AUTO=0, skipping');
    return;
  }
  const d = new Date();
  const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const radiohosts = _station.listRadioHosts?.() || [];
  for (const radiohost of radiohosts) {
    try {
      const mem = await _station.getRadioHostMemoryService?.(radiohost.id);
      if (!mem) continue;
      const r = await generateDailySummary({ memoryService: mem, date: dateStr });
      if (r) trace(`[memory-summary] radiohost=${radiohost.id} ${dateStr} written id=${r.id}`);
    } catch (e) {
      console.warn(`[memory-summary] radiohost=${radiohost.id} failed:`, e.message);
    }
  }
}

/** v2: 每周日 23:30 跑 weekly summary（聚合本周 daily summaries）。同 gate。 */
async function _runWeeklySummary() {
  if (!_station) return;
  if (process.env.MEMORY_SUMMARY_AUTO !== '1') return;
  const radiohosts = _station.listRadioHosts?.() || [];
  for (const radiohost of radiohosts) {
    try {
      const mem = await _station.getRadioHostMemoryService?.(radiohost.id);
      if (!mem) continue;
      const r = await generateWeeklySummary({ memoryService: mem });
      if (r) trace(`[memory-summary] radiohost=${radiohost.id} weekly written id=${r.id}`);
    } catch (e) {
      console.warn(`[memory-summary] weekly radiohost=${radiohost.id} failed:`, e.message);
    }
  }
}

/**
 * v2: 每 1 小时跑 dreaming consolidation。
 * gate: MEMORY_CONSOLIDATION_AUTO=1
 */
async function _runMemoryConsolidation() {
  if (!_station) return;
  if (process.env.MEMORY_CONSOLIDATION_AUTO !== '1') {
    trace('[memory-consolidate] MEMORY_CONSOLIDATION_AUTO=0, skipping');
    return;
  }
  const radiohosts = _station.listRadioHosts?.() || [];
  for (const radiohost of radiohosts) {
    try {
      const mem = await _station.getRadioHostMemoryService?.(radiohost.id);
      if (!mem) continue;
      const mc = new MemoryConsolidator(mem, mem.namespace);
      const report = mc.consolidateMemories();
      trace(`[memory-consolidate] radiohost=${radiohost.id} report=${JSON.stringify(report)}`);
    } catch (e) {
      console.warn(`[memory-consolidate] radiohost=${radiohost.id} failed:`, e.message);
    }
  }
}

// ===== 后台增量打标 cron（song-structured-tags）=====
//
// 不再"等播放才打标"：定期扫候选池，把新加进歌单 / 还没打过标的歌后台补上标。
// 复用 /api/songtags/backfill 的同一段逻辑（runBackfill），尊重 TTL（force=false）——
// 已打标且新鲜的会被 needsTagging 跳过，所以反复跑也不会重复烧 token。
// 入队后由 taggingQueue 串行（concurrency 默认 1）消化，天然防 LLM storm。
//
// 默认 OFF（house style：实验性 feature 不自动开），SONG_TAG_BACKFILL_CRON=1 开启。
// 间隔走"频繁 tick + 间隔闸"而非长 cron 表达式，方便用分钟数自由配置（默认 360=6h）。
const SONG_TAG_BACKFILL_INTERVAL_MS =
  Math.max(5, parseInt(process.env.SONG_TAG_BACKFILL_CRON_MIN || '360', 10)) * 60 * 1000;
let _lastSongTagBackfillAt = 0;

async function _runSongTagBackfillTick() {
  if (process.env.SONG_TAG_BACKFILL_CRON !== '1') return;
  if (Date.now() - _lastSongTagBackfillAt < SONG_TAG_BACKFILL_INTERVAL_MS) return;
  try {
    const [ncmStatus, qqStatus] = await Promise.all([ncm.loginStatus(), qq.loginStatus()]);
    const ncmUid = ncmStatus?.loggedIn ? ncmStatus.userId : null;
    const qqUid = qqStatus?.loggedIn ? qqStatus.userId : null;
    if (!ncmUid && !qqUid) return; // 没登录：不消耗间隔，下个 tick 继续探（loginStatus 很轻）
    _lastSongTagBackfillAt = Date.now(); // 真正要跑了才记时间戳
    const r = await runBackfill({ force: false, ncmUid, qqUid });
    if (r.enqueued > 0) {
      trace(`[songtag-backfill] cron enqueued=${r.enqueued} skipped=${r.skipped} pool=${r.candidatePool}`);
    }
  } catch (e) {
    console.warn('[songtag-backfill] cron error:', e.message);
  }
}

// 测试可见 hook（注入 + 重置时间戳，便于单测驱动 tick）
export const _songTagBackfillInternals = {
  tick: _runSongTagBackfillTick,
  resetClock: () => { _lastSongTagBackfillAt = 0; },
  setLastAt: (n) => { _lastSongTagBackfillAt = n; },
  intervalMs: () => SONG_TAG_BACKFILL_INTERVAL_MS,
};

// ===== 口味图式蒸馏（add-taste-learning-loop P2）=====
//
// 每人每天最多一次自动蒸馏；LLM 失败自动回落规则版兜底，撤销过的图式不再重建。
// 默认开启（单角色一天一次模型调用），TASTE_SCHEMA_AUTO=0 可关。
// 手动入口：POST /api/reflection/distill-schema（绕过当日一次闸）。

function _tasteSchema() {
  if (!_tasteSchemaService) {
    _tasteSchemaService = new TasteSchemaService({
      memoryTarget: id => stationMemoryTarget(_station, id),
      getSongStats: id => _station?.getReflectionAgent?.()?.store?.songStats?.(id) || [],
      readLegacyFiles: async () => {
        const read = async name => {
          try { return await import('node:fs/promises').then(fs => fs.readFile(resolve(resolveDataRoot(), 'user', name), 'utf8')); }
          catch { return ''; }
        };
        return { taste: await read('taste.md'), moodRules: await read('mood-rules.md') };
      },
    });
  }
  return _tasteSchemaService;
}

export async function runTasteSchemaDistill({ personIds = null, manual = true } = {}) {
  if (!_station) return { ok: false, code: 'STATION_UNAVAILABLE' };
  const service = _tasteSchema();
  const ids = personIds?.length ? personIds : stationPersonIds(_station);
  const results = [];
  for (const id of ids) {
    try {
      const result = await service.distill(id, { manual });
      results.push({ personId: id, ...result });
      if (result.ok) trace(`[taste-schema] person=${id} revision=${result.revision} source=${result.source}`);
      else if (!['ALREADY_TODAY', 'SCHEMA_REVOKED'].includes(result.code)) {
        console.warn(`[taste-schema] person=${id} skipped: ${result.code}`);
      }
    } catch (e) {
      console.warn(`[taste-schema] person=${id} failed:`, e.message);
      results.push({ personId: id, ok: false, code: 'DISTILL_FAILED' });
    }
  }
  return { ok: true, results };
}

async function _runTasteSchemaTick() {
  if (!_station) return;
  if (process.env.TASTE_SCHEMA_AUTO === '0') {
    trace('[taste-schema] TASTE_SCHEMA_AUTO=0, skipping');
    return;
  }
  await runTasteSchemaDistill({ manual: false });
}

export function start() {
  if (_started) return { started: true, taskCount: _scheduledTasks.length };
  _started = true;
  try {
  _librarySyncService?.start?.();
  // taste consolidation：默认关闭，需 CONSOLIDATION_AUTO=1 才开
  // 手动 POST /api/taste/consolidate 始终可用。
  if (process.env.CONSOLIDATION_AUTO === '1') {
    console.log('[scheduler] auto consolidation enabled (CONSOLIDATION_AUTO=1)');
    _schedule('*/30 * * * *', async () => {
      if (consolidator.isRunning()) return;
      if (!consolidator.shouldRunAuto()) return;
      try {
        const r = await consolidator.runConsolidation({ trigger: 'auto' });
        if (r.ok) console.log('[consolidate] auto:', r.summary);
        else console.warn('[consolidate] auto failed:', r.error);
      } catch (e) {
        console.warn('[consolidate] auto error:', e.message);
      }
    });
  } else {
    console.log('[scheduler] auto consolidation OFF — set CONSOLIDATION_AUTO=1 to enable');
  }

  // v2: working memory sweep（每 30 分钟，无 env gate）
  _schedule('*/30 * * * *', () => {
    _runWorkingSweep().catch(e => console.warn('[memory-sweep] tick error:', e.message));
  });
  console.log('[scheduler] v2 working memory sweep registered (every 30 min)');

  // v2: dreaming consolidation（每小时，MEMORY_CONSOLIDATION_AUTO 控制）
  _schedule('0 * * * *', () => {
    _runMemoryConsolidation().catch(e => console.warn('[memory-consolidate] tick error:', e.message));
  });
  if (process.env.MEMORY_CONSOLIDATION_AUTO === '1') {
    console.log('[scheduler] v2 dreaming consolidation auto-on (MEMORY_CONSOLIDATION_AUTO=1)');
  } else {
    console.log('[scheduler] v2 dreaming consolidation OFF — set MEMORY_CONSOLIDATION_AUTO=1 to enable');
  }

  // v2: 每天 23:00 跑 daily summary
  _schedule('0 23 * * *', () => {
    _runDailySummary().catch(e => console.warn('[memory-summary] tick error:', e.message));
  });
  // v2: 每周日 23:30 跑 weekly summary
  _schedule('30 23 * * 0', () => {
    _runWeeklySummary().catch(e => console.warn('[memory-summary] weekly tick error:', e.message));
  });
  if (process.env.MEMORY_SUMMARY_AUTO === '1') {
    console.log('[scheduler] v2 daily + weekly summary auto-on (MEMORY_SUMMARY_AUTO=1)');
  } else {
    console.log('[scheduler] v2 summary OFF — set MEMORY_SUMMARY_AUTO=1 to enable');
  }

  // 口味图式蒸馏：每天 09:20，默认开（TASTE_SCHEMA_AUTO=0 关）
  _schedule('20 9 * * *', () => {
    _runTasteSchemaTick().catch(e => console.warn('[taste-schema] tick error:', e.message));
  });
  console.log(process.env.TASTE_SCHEMA_AUTO === '0'
    ? '[scheduler] taste-schema distillation OFF (TASTE_SCHEMA_AUTO=0)'
    : '[scheduler] taste-schema distillation registered (daily 09:20, per person once/day)');

  // 后台增量打标（song-structured-tags）：每 15 分钟 tick 一次，内部用间隔闸控真实节奏。
  // 默认 OFF —— 整库回填会烧 LLM token，先让用户用 SONG_TAG_BACKFILL_CRON=1 主动开。
  _schedule('*/15 * * * *', () => {
    _runSongTagBackfillTick().catch(e => console.warn('[songtag-backfill] tick error:', e.message));
  });
  if (process.env.SONG_TAG_BACKFILL_CRON === '1') {
    const everyMin = Math.round(SONG_TAG_BACKFILL_INTERVAL_MS / 60000);
    console.log(`[scheduler] song-tag backfill cron ON (every ~${everyMin}min, respects TTL)`);
  } else {
    console.log('[scheduler] song-tag backfill cron OFF — set SONG_TAG_BACKFILL_CRON=1 to enable');
  }

  // Persistent library reconciliation. Each callback catches its own failure so
  // one provider outage cannot disable subsequent cron executions.
  _schedule('*/30 * * * *', () => {
    Promise.resolve(_librarySyncService?.periodic?.())
      .catch(e => console.warn('[library-sync] periodic error:', e.message));
  });
  _schedule('0 4 * * 0', () => {
    Promise.resolve(_librarySyncService?.weekly?.())
      .catch(e => console.warn('[library-sync] weekly error:', e.message));
  });
  return { started: true, taskCount: _scheduledTasks.length };
  } catch (error) {
    stop();
    throw error;
  }
}

export function stop() {
  if (!_started && _scheduledTasks.length === 0) return;
  for (const task of _scheduledTasks.splice(0)) {
    try { task?.stop?.(); } catch {}
    try { task?.destroy?.(); } catch {}
  }
  try { _librarySyncService?.stop?.(); } catch {}
  _started = false;
}

export default { start, stop, attach, detach };
