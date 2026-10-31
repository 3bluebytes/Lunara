// presencePreferenceTool.js — 普通回合里你明确说「多说点 / 安静点 / 可以说话了」时的 typed tool
// （add-companion-expression-and-reception D5 / 3.3）。
//
// 必须引用本轮用户原话里的连续片段（和 remember_person_fact 同一口径），不凭语气推测；
// 写进接收信号并读回成功后才返回成功，模型据此才能说「好」。ambient 回合没有这个能力。
//   more   → asked_more 信号（−0.3，2 小时半衰期），心跳间隔变短；
//   quiet  → 当前听歌来源本次一起听撤弦（listener-asked-quiet），换来源或下次一起听恢复；
//   resume → 清掉当前听歌来源的「安静点」。
// 不改持久开关（「一起听歌时伙伴会主动说话」仍在设置里），不碰播放。
//
// Python 伪代码：
//   def set_presence_preference(preference, source_quote, ctx):
//       if source_quote not in ctx.user_text: return fail('PRESENCE_SOURCE_REQUIRED')
//       listening = active_listening_session()
//       if preference == 'quiet': reception.ask_quiet(listening); assert reception.is_quiet(listening)
import { createToolOutcome } from '../virtual-person/VirtualPersonTypes.js';

export const PRESENCE_PREFERENCE_CAPABILITY = 'presence.preference';

function outcome(ok, code, text, facts = {}) {
  return createToolOutcome({ kind: ok ? 'success' : 'business_failure', code, facts,
    modelContext: text, presentation: { displayText: text, speak: false } });
}

export function registerPresencePreferenceTool(toolRegistry, { getReception, getListeningSessionId }) {
  const askedMore = new Set();
  toolRegistry.register('set_presence_preference', {
    capability: PRESENCE_PREFERENCE_CAPABILITY,
    definition: {
      description: '只有用户明确说希望你们一起听歌时多主动说话（more）、先安静别主动说话（quiet）或可以继续主动说话了（resume）时调用。'
        + 'quiet 只管这一次一起听；成功后才能答应。没接话、只是在忙都不是这个意思。',
      parameters: { type: 'object', additionalProperties: false, required: ['preference', 'sourceQuote'], properties: {
        preference: { type: 'string', enum: ['more', 'quiet', 'resume'] },
        sourceQuote: { type: 'string', minLength: 2, maxLength: 200, description: '本轮用户原话中的连续片段，用作依据。' },
      } },
    },
    handler(args, context) {
      const quote = String(args.sourceQuote || '').trim();
      if (quote.length < 2 || !String(context.userText || '').includes(quote)) {
        return outcome(false, 'PRESENCE_SOURCE_REQUIRED', '没有找到对应的用户原话，不能把推测当成用户的要求。');
      }
      const reception = getReception?.();
      if (!reception) return outcome(false, 'PRESENCE_PREFERENCE_UNAVAILABLE', '主动说话的节奏现在没法调整。');
      const listening = getListeningSessionId?.() || null;
      if (args.preference === 'more') {
        const key = `${context.userTurnId || context.requestId || ''}`;
        if (!key || !askedMore.has(key)) {
          if (key) askedMore.add(key);
          if (askedMore.size > 64) askedMore.delete(askedMore.values().next().value);
          reception.askMore(listening || context.sessionId);
        }
        return outcome(true, 'PRESENCE_MORE_NOTED', '已记下：一起听时可以多主动说几句（这个倾向会随时间慢慢淡去）。');
      }
      if (!listening) {
        return outcome(false, 'PRESENCE_NOT_LISTENING', '现在没有在一起听，所以没有需要调整的主动说话。');
      }
      if (args.preference === 'quiet') {
        reception.askQuiet(listening);
        if (!reception.isQuiet(listening)) return outcome(false, 'PRESENCE_PREFERENCE_UNAVAILABLE', '这次没能设置成功，不能答应。');
        return outcome(true, 'PRESENCE_QUIET_SET',
          '已生效：这次一起听不再主动开口；换个来源或下次一起听会恢复，聊天里也有一键恢复。用户说话时照常回应。',
          { listeningSessionId: listening });
      }
      reception.restore(listening);
      return reception.isQuiet(listening)
        ? outcome(false, 'PRESENCE_PREFERENCE_UNAVAILABLE', '这次没能恢复，不能答应。')
        : outcome(true, 'PRESENCE_QUIET_CLEARED', '已恢复：一起听时可以照常偶尔主动说话。', { listeningSessionId: listening });
    },
  });
}

export default registerPresencePreferenceTool;
