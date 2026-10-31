// ambientTurn.js — ambient turn 的纯函数部分（add-companion-heartbeat D2.2）。
//
// buildAmbientMarker：末尾那条临时 role:'user' 运行时提示（app_open 换成「刚打开 app」的情境）。只活在一次 AgentLoop.run 里：
//   不入账、不投影、不进观察、不以正文进 trace。内容只有当地时段、已知的间隔、
//   唤醒时累计的权威播放计数与当前曲目；不含 wake id、原因码、预算或性格档位。
// ambientMemoryQuery：记忆检索用的 query（最近一条用户原话 + 当前曲目，只在进程内使用）。
// ambientResultOf：把 AgentLoop 的结果或异常解释成 speak / quiet / silent(封闭原因)。
//
// Python 伪代码：
//   marker = build_ambient_marker(wake=wake, last_user_turn_at_ms=..., current_track=track)
//   result = ambient_result_of(result=loop_result, error=None, aborted=False)

export const AMBIENT_MARKER_PREFIX = '［运行时提示，不是对方说的话］';
const MEMORY_QUERY_MAX = 200;
// 绕过 presence_respond 的纯文本只为 trace 截取（2026-10-21 观测修订）：够看出是「说出来的安静」还是真台词。
const TRACE_TEXT_MAX = 280;
export const ambientTraceText = value => clean(value).slice(0, TRACE_TEXT_MAX);

// 纯文本的一次纠正（2026-10-22）：不出口，请她用 presence_respond 重交；开口与否仍由她判断，
// 判断标准写明「是不是在跟对方说话」——实机里绕过工具的多是自言自语、评歌和描述气氛。
export const AMBIENT_PLAIN_TEXT_CORRECTION = [
  AMBIENT_MARKER_PREFIX,
  '你刚才直接写了一段文字，没有用 presence_respond 提交，对方看不到。',
  '先想一下：这句是在跟对方说话、对方听了能接的吗？是的话，用 presence_respond action=speak 提交（可以改写）；',
  '如果只是自言自语、评价正在放的歌或描述气氛，就提交 action=quiet。只提交一次。',
].join('\n');
const clean = value => String(value ?? '').trim();
const titleOf = value => clean(value).replace(/[《》]/g, '').slice(0, 80);

const DAY_PARTS = [[5, '深夜'], [8, '清晨'], [11, '上午'], [13, '中午'], [17, '下午'], [19, '傍晚'], [23, '晚上'], [24, '深夜']];
function dayPart(ms, timeZone) {
  let hour;
  try {
    hour = Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms)));
  } catch { hour = new Date(ms).getHours(); }
  return DAY_PARTS.find(([end]) => hour < end)?.[1] || '深夜';
}

function sinceText(nowMs, atMs) {
  if (!Number.isFinite(atMs) || atMs > nowMs) return '';
  const minutes = Math.round((nowMs - atMs) / 60_000);
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `大约 ${minutes} 分钟`;
  if (minutes < 24 * 60) return `大约 ${Math.round(minutes / 60)} 小时`;
  return '一天以上';
}

// 回来了（add-app-open-greeting D8）：离开时长只给粗粒度档位，不暴露精确时间戳。
const AWAY_TEXT = Object.freeze({ hour: '一个多小时', hours: '几个小时', overnight: '大半天', day: '一天多', days: '好几天' });

/** 离开时长的档位：不到 1 小时为 null（不算回来）。 */
export function awayBucket(awayMs) {
  const hours = Number(awayMs) / 3_600_000;
  if (!(hours >= 1)) return null;
  if (hours < 2) return 'hour';
  if (hours < 7) return 'hours';
  if (hours < 24) return 'overnight';
  if (hours < 48) return 'day';
  return 'days';
}

export const awayText = bucket => AWAY_TEXT[bucket] || '';

// 她自己约过的事（followup）只告诉约的那个人；说成「你之前想着」，不说成提醒或任务。
function wakeReasonText(wake) {
  const mine = (Array.isArray(wake?.followups) ? wake.followups : [])
    .filter(item => item?.personId === wake?.personId && clean(item.about)).map(item => `「${clean(item.about).slice(0, 120)}」`);
  if (mine.length) return `你之前想着${mine.slice(0, 3).join('、')}，想回头再想想`;
  if (wake?.reason === 'app_open') return '对方回来了';
  return wake?.reason === 'heartbeat' ? '过了一阵' : '有事发生';
}

// 回来了：不说「在一起听」，不写精确间隔、这段时间的播放计数或曲目（可能根本没在听）。
function appOpenMarker(wake, nowMs, timeZone) {
  const away = awayText(awayBucket(wake?.awayMs));
  return [
    AMBIENT_MARKER_PREFIX,
    `现在是当地的${dayPart(nowMs, timeZone)}。对方刚打开 app，${away ? `离你们上次见面过了${away}，` : ''}此刻还没有跟你说话。`,
    `这次醒来是因为：${wakeReasonText(wake)}。`,
  ].join('\n');
}

export function buildAmbientMarker({ wake, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  lastUserTurnAtMs = null, lastSpokeAtMs = null, currentTrack = null } = {}) {
  const nowMs = Number(wake?.firedAtMs) || Date.now();
  if (wake?.reason === 'app_open') return appOpenMarker(wake, nowMs, timeZone);
  const sinceUser = sinceText(nowMs, lastUserTurnAtMs);
  const sinceSpoke = sinceText(nowMs, lastSpokeAtMs);
  const gaps = [sinceUser && `距对方上次说话${sinceUser}`, sinceSpoke && `距你上次开口${sinceSpoke}`].filter(Boolean);
  const counts = wake?.sinceLastWake || {};
  const changes = [
    wake?.reason === 'session_open' ? '一起听刚开始' : '',
    Number(counts.completed) > 0 ? `完整听完了 ${Number(counts.completed)} 首` : '',
    Number(counts.skipped) > 0 ? `跳过了 ${Number(counts.skipped)} 首` : '',
    wake?.reason === 'queue_exhausted' ? '这一批歌放完了' : '',
  ].filter(Boolean);
  const title = titleOf(currentTrack?.title);
  const artist = clean(currentTrack?.artist).slice(0, 80);
  return [
    AMBIENT_MARKER_PREFIX,
    `现在是当地的${dayPart(nowMs, timeZone)}。你们在一起听歌，对方此刻没有在跟你说话。`,
    gaps.length ? `${gaps.join('；')}。` : '',
    `这段时间：${changes.length ? changes.join('，') : '没什么变化'}。`,
    title ? `现在在放《${title}》${artist ? `（${artist}）` : ''}。` : '',
    `这次醒来是因为：${wakeReasonText(wake)}。`,
  ].filter(Boolean).join('\n');
}

/** 权威播放快照里的当前曲目（runtimeState.playback 是 PlaybackRuntime 快照）；没有为 null。 */
export function currentTrackOf(runtimeState) {
  const playback = runtimeState?.playback;
  return Array.isArray(playback?.queue) ? playback.queue[playback.currentIndex] || null : null;
}

export function ambientMemoryQuery({ lastUserText = '', currentTrack = null } = {}) {
  return [clean(lastUserText), titleOf(currentTrack?.title), clean(currentTrack?.artist)]
    .filter(Boolean).join(' ').slice(0, MEMORY_QUERY_MAX);
}

const SILENT_BY_CODE = Object.freeze({
  AGENT_ROUND_LIMIT: 'rejected', AGENT_TIMEOUT: 'timeout', LLM_BUDGET_EXHAUSTED: 'llm-budget',
});

/**
 * @returns {{action:'speak', text:string} | {action:'quiet', dropped?:'plain-text', droppedText?:string} | {action:'silent', reason:string}}
 *   reason ∈ CompanionHeartbeat 的封闭原因码（interrupted / rejected / timeout / llm-budget / error）。
 */
export function ambientResultOf({ result = null, error = null, aborted = false } = {}) {
  if (aborted) return { action: 'silent', reason: 'interrupted' };
  if (error) {
    if (error.code === 'EMPTY_ASSISTANT_RESPONSE') return { action: 'quiet' };
    return { action: 'silent', reason: SILENT_BY_CODE[error.code] || 'error' };
  }
  const accepted = [...(result?.outcomes || [])].reverse().find(outcome => outcome?.ok === true && outcome?.terminal
    && (outcome.code === 'AMBIENT_LINE_ACCEPTED' || outcome.code === 'AMBIENT_QUIET'));
  if (accepted?.facts?.action === 'speak' && clean(accepted.facts.text)) return { action: 'speak', text: clean(accepted.facts.text) };
  if (accepted) return { action: 'quiet' };
  // 没调 presence_respond、直接回了纯文本：一律按安静，不出口。实机里这种回复多半是
  // 「我不出声，就让曲子放着」这类把安静说出来的话；想开口必须走 presence_respond 的校验。
  // droppedText 只给 trace，用来核对这个判断；调用方不得把它往外传。
  const plain = clean(result?.finalText);
  return plain ? { action: 'quiet', dropped: 'plain-text', droppedText: ambientTraceText(plain) } : { action: 'quiet' };
}
