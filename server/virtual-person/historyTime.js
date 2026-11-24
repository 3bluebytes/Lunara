// historyTime.js — 同一聊天历史里的时间感（add-conversation-time-sense）。
//
// 模型历史本身不带时间：昨晚说的"明早面试"和刚才说的看起来一样。这里只补两样：
//   1. 用户消息与前一条消息隔了至少一小时（或是窗口里第一条）时，正文前加 `[10月1日 23:30]`；
//      连续聊天的消息不加，刚发出的消息（一小时内）不加，所以普通请求逐字节不变。
//   2. 距这个聊天上一条消息过了多久，交给系统提示的"当前真实状态"。
// 只标用户消息：助手历史不加前缀，模型不会学着在回复里输出时间戳。
//
// Python 伪代码：
//   for prev, turn in pairs(turns):
//       if turn.role == 'user' and now - turn.at >= HOUR and (prev is None or turn.at - prev.at >= HOUR):
//           label[turn.id] = fmt(turn.at)
import { formatZhDateTime } from './PromptAssembler.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const USER_BURST_WINDOW_MS = 2 * 60_000;
export const REAL_CLOCK_RESET_MS = 25 * 60_000;

const at = turn => (Number.isFinite(turn?.createdAt) ? turn.createdAt : null);

/** 需要标注时间的用户 turn：turnId → 标签文字。 */
export function historyTimeLabels(turns, now) {
  const labels = new Map();
  let previous = null;
  for (const turn of turns) {
    const time = at(turn);
    if (time === null) continue;
    if (turn.role === 'user' && now - time >= HOUR && (previous === null || time - previous >= HOUR)) {
      labels.set(turn.turnId, formatZhDateTime(time, new Date(now)));
    }
    previous = time;
  }
  return labels;
}

export function humanGap(ms) {
  if (ms >= DAY) return `${Math.floor(ms / DAY)} 天`;
  const hours = Math.floor(ms / HOUR);
  const minutes = Math.floor((ms % HOUR) / 60_000);
  if (hours > 0) return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
  return `${Math.max(1, minutes)} 分钟`;
}

function priorTurnForGap(turns, now) {
  const timed = (Array.isArray(turns) ? turns : [])
    .filter(turn => (turn?.role === 'user' || turn?.role === 'assistant') && at(turn) !== null && at(turn) <= now);
  if (!timed.length) return null;
  const lastUser = timed.findLastIndex(turn => turn.role === 'user');
  const current = lastUser >= 0 && now - at(timed[lastUser]) < REAL_CLOCK_RESET_MS;
  if (!current) return timed.at(-1) || null;
  let burstStart = lastUser;
  while (
    burstStart > 0
    && timed[burstStart - 1].role === 'user'
    && at(timed[burstStart]) >= at(timed[burstStart - 1])
    && at(timed[burstStart]) - at(timed[burstStart - 1]) < USER_BURST_WINDOW_MS
  ) {
    burstStart -= 1;
  }
  return timed[burstStart - 1] || null;
}

/** 距上一条可见消息已经过去多少真实毫秒；找不到前序消息时返回 null。 */
export function sessionElapsedMs(turns, now) {
  const last = priorTurnForGap(turns, now);
  if (!last) return null;
  return Math.max(0, now - at(last));
}

/**
 * 距这个聊天上一条消息过了多久；不到 25 分钟返回空串。
 * >= 25 分钟时注入现实时钟流逝与瞬态生理/现场归零事实。
 */
export function sessionGapLine(turns, now) {
  const last = priorTurnForGap(turns, now);
  if (!last) return '';
  const gap = now - at(last);
  if (gap < REAL_CLOCK_RESET_MS) return '';
  return `距这个聊天上一条消息已过 ${humanGap(gap)}（上一条在 ${formatZhDateTime(at(last), new Date(now))}）；历史里方括号是那条用户消息的发送时间，当时说的"明天""刚才"按那个时间理解。现实时间已经过去，此前对话中的瞬态生理喘息、紧绷与半截动作现场早已自然平复归零；若上文停在半途，这也是真实发生过的离开，请以当下的真实状态自然接住重逢，不要假装时间静止。`;
}
