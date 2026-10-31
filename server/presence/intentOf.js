// intentOf.js — 群聊 ambient 一拍里「谁心里有事」的确定性打分（add-companion-expression-and-reception D1）。
//
// 纯函数：输入是这一拍开始时的只读事实，输出 0–1 分与原因码。分数与原因码只进 trace，
// 不进提示词。出声者不看分（照旧先跑）；跟话候选 = 分 ≥ 阈值的成员，按分降序、同分按轮换，最多 1 位。
// 被点名邀请的人走 FloorRunner，不占这个名额。
//
// Python 伪代码：
//   def intent_of(f):
//       score = max(1.0 if f.followup_due else 0, 1.0 if f.invited else 0,
//                   0.7 if f.mentioned else 0, 0.5 if f.open_loop else 0)
//       return min(1.0, score + (0.2 if f.long_silent else 0))

export const INTENT_WEIGHTS = Object.freeze({ followupDue: 1, invited: 1, mentioned: 0.7, openLoop: 0.5, longSilent: 0.2 });
export const INTENT_THRESHOLD = 0.5;
export const MAX_INTENT_FOLLOWERS = 1;

const REASON = Object.freeze({ followupDue: 'followup-due', invited: 'invited', mentioned: 'mentioned',
  openLoop: 'open-loop', longSilent: 'long-silent' });

/** 主事实取最高分，「很久没开口」只做加分：它自己永远到不了阈值。 */
export function intentOf(facts = {}) {
  const reasons = Object.keys(REASON).filter(key => facts[key] === true);
  const main = Math.max(0, ...reasons.filter(key => key !== 'longSilent').map(key => INTENT_WEIGHTS[key]));
  const score = Math.min(1, main + (facts.longSilent === true ? INTENT_WEIGHTS.longSilent : 0));
  return Object.freeze({ score: Math.round(score * 100) / 100, reasons: Object.freeze(reasons.map(key => REASON[key])) });
}

/**
 * candidates 已按轮换排好（上一拍跟过话的人在最后）；稳定排序保证同分按轮换。
 * 返回 chosen（要问的人）与 scored（全部打分，供 trace）。
 */
export function chooseFollowers(candidates = [], scoreOf, { threshold = INTENT_THRESHOLD, max = MAX_INTENT_FOLLOWERS } = {}) {
  const scored = candidates.map(personId => ({ personId, ...scoreOf(personId) }));
  const chosen = scored.filter(item => item.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(item => item.personId);
  return { chosen, scored };
}

const timeOf = value => (Number.isFinite(value) ? value : Date.parse(value));

/**
 * 从账本与心里话里取一位成员的事实。turns 是最近的可见回合（旧→新），names 是成员显示名。
 * 只看所有人都看得见的可见回合；不读私聊或记忆。
 */
export function intentFacts({ personId, wake = {}, turns = [], names = new Map(), openLoop = false, invited = false }) {
  const followupDue = (Array.isArray(wake.followups) ? wake.followups : []).some(item => item?.personId === personId);
  let lastIndex = -1;
  turns.forEach((turn, index) => { if (turn.role === 'assistant' && turn.speakerVirtualPersonId === personId) lastIndex = index; });
  const name = String(names.get(personId) || '').trim();
  const mentioned = name.length > 0 && turns.slice(lastIndex + 1)
    .some(turn => turn.speakerVirtualPersonId !== personId && String(turn.visibleText || turn.message?.content || '').includes(name));
  const interval = Number(wake.firedAtMs) - Number(wake.previousWakeAtMs);
  const lastAt = lastIndex >= 0 ? timeOf(turns[lastIndex].createdAt) : NaN;
  const longSilent = Number.isFinite(interval) && interval > 0
    && (lastIndex < 0 || (Number.isFinite(lastAt) && Number(wake.firedAtMs) - lastAt > 2 * interval));
  return { followupDue, invited: invited === true, mentioned, openLoop: openLoop === true, longSilent };
}
