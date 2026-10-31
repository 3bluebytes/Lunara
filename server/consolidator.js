// consolidator.js — 偏好自洁
// 周期性把 plays + outcome + messages 喂给 LLM，让它重写
// user/taste.md / user/no-go.md / user/mood-rules.md。
// 每个文件覆写前先备份到 user/.history/<name>.<ISO>.<auto|manual>.md。

import { readFile, writeFile, rename, mkdir, copyFile, readdir, unlink, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';

import * as state from './state.js';
import * as envMod from './env.js';
import * as context from './context.js';
import * as llm from './llm.js';
import { resolveDataRoot, resolvePackageRoot } from './runtimePaths.js';

// 双锚点：user/* 运行期状态锚数据根；prompts 随安装分发锚包根。
const DATA_ROOT = resolveDataRoot();
const PACKAGE_ROOT = resolvePackageRoot();
const HISTORY_DIR = resolve(DATA_ROOT, 'user/.history');
const TASTE_PATH      = resolve(DATA_ROOT, 'user/taste.md');
const NO_GO_PATH      = resolve(DATA_ROOT, 'user/no-go.md');
const MOOD_RULES_PATH = resolve(DATA_ROOT, 'user/mood-rules.md');
const PROMPT_PATH     = resolve(PACKAGE_ROOT, 'prompts/taste-consolidator.md');
const KEEP_HISTORY    = 20;

let _running = false;

export function isRunning() { return _running; }

async function readSafe(p, fallback = '') {
  try { return await readFile(p, 'utf8'); } catch { return fallback; }
}

async function backupAndWrite(filePath, newContent, { trigger }) {
  await mkdir(HISTORY_DIR, { recursive: true });

  // 备份当前
  if (existsSync(filePath)) {
    const baseName = filePath.split('/').pop();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const suffix = trigger === 'manual' ? 'manual' : 'auto';
    const backup = resolve(HISTORY_DIR, `${baseName}.${stamp}.${suffix}.md`);
    try { await copyFile(filePath, backup); } catch {}

    // 清理超量历史
    try {
      const all = (await readdir(HISTORY_DIR))
        .filter(n => n.startsWith(baseName + '.'));
      if (all.length > KEEP_HISTORY) {
        const stats = await Promise.all(all.map(async n => ({
          name: n,
          mtime: (await stat(resolve(HISTORY_DIR, n))).mtimeMs,
        })));
        stats.sort((a, b) => a.mtime - b.mtime);
        for (const s of stats.slice(0, all.length - KEEP_HISTORY)) {
          try { await unlink(resolve(HISTORY_DIR, s.name)); } catch {}
        }
      }
    } catch {}
  }

  // 临时文件 + rename：原子写
  const tmp = filePath + '.tmp.' + Date.now();
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tmp, newContent, 'utf8');
  await rename(tmp, filePath);
}

function buildSinceTs() {
  const lastAt = state.lastConsolidationAt();
  if (lastAt) return lastAt;
  // 首次：取过去 14 天
  return Date.now() - 14 * 24 * 3600 * 1000;
}

function formatPlay(p) {
  const sec = p.played_seconds != null ? `${p.played_seconds}s` : '?';
  const oc  = p.outcome || 'unknown';
  return `- [${oc}/${sec}] ${p.title || '?'} — ${p.artist || '?'}`;
}

async function buildPrompt(inputs) {
  const tpl = await readFile(PROMPT_PATH, 'utf8');
  const env = await envMod.snapshot();
  return tpl
    .replace('{{current_taste}}',      inputs.currentTaste     || '(empty)')
    .replace('{{current_no_go}}',      inputs.currentNoGo      || '(empty)')
    .replace('{{current_mood_rules}}', inputs.currentMoodRules || '(empty)')
    .replace('{{recent_plays_with_outcome}}', inputs.playsText || '(none)')
    .replace('{{recent_messages}}',    inputs.messagesText || '(none)')
    .replace('{{environment}}',        JSON.stringify(env, null, 2));
}

/**
 * @param {{ trigger?: 'auto'|'manual', dryRun?: boolean }} opts
 * @returns {Promise<{ ok: boolean, jobId?: number, status?: string, summary?: string, error?: string, output?: object }>}
 */
export async function runConsolidation({ trigger = 'auto', dryRun = false } = {}) {
  if (_running) return { ok: false, error: 'already-running' };
  _running = true;

  // 1) 拉输入
  const since = buildSinceTs();
  const plays = state.playsWithOutcomeSince(since);
  const messages = state.messagesSince(since);
  const inputCount = plays.length + messages.length;

  // 阈值：太少信号直接跳
  if (plays.length < 3 && trigger === 'auto') {
    _running = false;
    return { ok: false, error: 'not-enough-signal', plays: plays.length };
  }

  const jobId = state.startConsolidation({ trigger, dryRun, inputCount });

  try {
    const [currentTaste, currentNoGo, currentMoodRules] = await Promise.all([
      readSafe(TASTE_PATH),
      readSafe(NO_GO_PATH),
      readSafe(MOOD_RULES_PATH),
    ]);

    const playsText = plays.map(formatPlay).join('\n').slice(0, 6000);
    const messagesText = messages
      .map(m => `[${m.role}] ${m.text}`)
      .join('\n')
      .slice(0, 4000);

    // 2) 装 prompt
    const prompt = await buildPrompt({
      currentTaste, currentNoGo, currentMoodRules,
      playsText, messagesText,
    });

    // 3) 调 LLM
    const text = await llm.askText(prompt, { taskId: 'taste_consolidation' });
    const parsed = llm.extractJson(text);

    // 4) 严格校验
    const isValid = parsed
      && typeof parsed.taste      === 'string'
      && typeof parsed.no_go      === 'string'
      && typeof parsed.mood_rules === 'string'
      && typeof parsed.summary    === 'string';

    if (!isValid) {
      state.finishConsolidation(jobId, {
        status: 'parse_error',
        summary: null,
        error: 'invalid-json: ' + (text || '').slice(0, 300),
      });
      return { ok: false, error: 'parse_error', raw: text?.slice(0, 500) };
    }

    if (dryRun) {
      state.finishConsolidation(jobId, {
        status: 'success',
        summary: '[dryRun] ' + parsed.summary,
      });
      return { ok: true, jobId, status: 'success', summary: parsed.summary, output: parsed, dryRun: true };
    }

    // 5) 备份并原子写入
    await backupAndWrite(TASTE_PATH,      parsed.taste,      { trigger });
    await backupAndWrite(NO_GO_PATH,      parsed.no_go,      { trigger });
    await backupAndWrite(MOOD_RULES_PATH, parsed.mood_rules, { trigger });

    // 6) 立刻让 prompt 缓存失效
    context.invalidateCache();

    // 7) log
    state.finishConsolidation(jobId, { status: 'success', summary: parsed.summary });
    return { ok: true, jobId, status: 'success', summary: parsed.summary };
  } catch (e) {
    state.finishConsolidation(jobId, {
      status: 'error',
      error: e.message || String(e),
    });
    return { ok: false, error: e.message || String(e) };
  } finally {
    _running = false;
  }
}

/**
 * 自动触发条件：
 *  ① 自上次 success 起新增 plays ≥ 30
 *  ② 距离上次 success ≥ 24h 且新增 plays ≥ 5
 */
export function shouldRunAuto() {
  const lastAt = state.lastConsolidationAt();
  const newPlays = state.playsCountSince(lastAt || 0);
  if (newPlays >= 30) return true;
  if (lastAt && Date.now() - lastAt >= 24 * 3600 * 1000 && newPlays >= 5) return true;
  return false;
}

export default { runConsolidation, isRunning, shouldRunAuto };
