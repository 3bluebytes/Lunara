// ambientTools.js — ambient turn 的 typed 工具（add-companion-heartbeat D2.3）。
//
// 终止工具 presence_respond：
//   - action=quiet：这次安静陪着，正常终止（空呈现）；
//   - action=speak：按 ambientLineDefect 机械校验，通过才登记 facts.text；不通过是可纠正失败；
//     noteIds 写这句话接的是哪几条心里话（n 编号），说出口后它们记为「提过」；
//     群聊里可带 invite（m 编号）点名一位伙伴接话，由 toolContext.ambientFloor 映射并交给 FloorRunner。
// 心里话工具（阶段 B，非终止）：
//   - note_thought：记一条心里话；schedule_followup：约自己过几分钟 / 这首放完 / 下次一起听时再想；
//     二者只在 ambient 回合可用，写进 toolContext.innerNotes.stage 暂存，入账时与可见回合同一事务落库；
//   - settle_thought（presence.notes 能力）：ambient 回合暂存；普通回合立即了结，重复调用无副作用。
// n 编号只在本轮有效，由组装上下文时的映射换成真实 note id，模型看不到真实 id。
// 工具不调模型、不写账本、不碰播放；接受也不代表已经入账或出声——入账在
// VirtualPersonRuntime.handleAmbientTurn 的会话队列里重验后进行。
//
// Python 伪代码：
//   ctx.inner_notes = {'map': {'n1': 'note:...'}, 'stage': stage_or_None, 'store': notes, ...}
//   await registry.execute('note_thought', {'text': '这几首都是雨天的歌'}, ctx)   # 只写 stage
import { createToolOutcome, ToolOutcomeKind } from '../virtual-person/VirtualPersonTypes.js';
import { stripPeerMarkers } from '../virtual-person/peerMessage.js';
import { NOTE_LIMITS, noteIdOf } from '../virtual-person/companionNotes.js';
import { AMBIENT_LINE_MAX_CHARS, ambientLineDefect, ambientRuleFeedback } from './ambientLine.js';

export const AMBIENT_CAPABILITY = 'presence.ambient';
export const INNER_NOTES_CAPABILITY = 'presence.notes';
export const AMBIENT_RESPOND_TOOL_NAME = 'presence_respond';
export const NOTE_THOUGHT_TOOL_NAME = 'note_thought';
export const SCHEDULE_FOLLOWUP_TOOL_NAME = 'schedule_followup';
export const SETTLE_THOUGHT_TOOL_NAME = 'settle_thought';
// 推荐一首（add-ambient-music-recommendation）：只在叫醒时闸门放行才由 runtime 加进白名单。
export const AMBIENT_RECOMMEND_CAPABILITY = 'presence.recommend';
export const RECOMMEND_TRACK_TOOL_NAME = 'recommend_track';
export const AMBIENT_TOOLS = Object.freeze([NOTE_THOUGHT_TOOL_NAME, SCHEDULE_FOLLOWUP_TOOL_NAME, SETTLE_THOUGHT_TOOL_NAME,
  AMBIENT_RESPOND_TOOL_NAME]);
const MAX_STAGED_CREATES = 3;
const SHORT_ID = /^n\d{1,2}$/;
const titleKey = value => String(value ?? '').replace(/[《》\s]/gu, '').toLowerCase();
/** 这句话有没有点到暂存的那首（忽略书名号、空白与大小写）。 */
export const mentionsTitle = (text, title) => Boolean(titleKey(title)) && titleKey(text).includes(titleKey(title));
const RECOMMEND_FAILURE_COPY = Object.freeze({
  RECOMMENDATION_UNRESOLVED: '没找到这首能放的版本，或者它不符合你们现在一起听的条件。',
  RECOMMENDATION_EXCLUDED: '这首刚放过、已经在队列里，或者对方说过不喜欢。',
  RECOMMENDATION_INVALID: '歌名或歌手没写清楚。',
});

const failure = (code, modelContext, context, { retryable = false, facts = {} } = {}) => createToolOutcome({
  kind: ToolOutcomeKind.BUSINESS_FAILURE, code, facts, modelContext,
  presentation: { displayText: '', speak: false, retryable },
  internal: { correlationId: context?.correlationId },
});

const noted = (code, facts, modelContext, context) => createToolOutcome({
  kind: ToolOutcomeKind.SUCCESS, code, facts, modelContext,
  presentation: { displayText: '', speak: false },
  internal: { correlationId: context?.correlationId },
});

const accepted = (code, facts, modelContext, context) => createToolOutcome({
  kind: ToolOutcomeKind.SUCCESS, code, terminal: true, facts, modelContext,
  // 呈现留空：AgentLoop 不产出可见回复，运行时入账成功后自己交付。
  presentation: { displayText: '', speak: false },
  internal: { correlationId: context?.correlationId },
});

export function registerAmbientTools(registry) {
  if (!registry || typeof registry.register !== 'function') throw new TypeError('registerAmbientTools requires a tool registry');
  const registered = new Set(registry.definitions({ capabilities: [AMBIENT_CAPABILITY] })
    .map(definition => String(definition?.function?.name || '')));
  if (registered.has(AMBIENT_RESPOND_TOOL_NAME)) return registry;
  registerNoteTools(registry);
  registerRecommendTool(registry);
  registry.register(AMBIENT_RESPOND_TOOL_NAME, {
    capability: AMBIENT_CAPABILITY,
    definition: {
      description: '给出这一轮的结果：action=speak 时写下你要说的一两句话（能直接念出来的纯文本）；action=quiet 表示这次安静陪着、不开口。说出口的话会被机械校验，被拒绝时按提示修改或改为 quiet；接受即结束这一轮，不代表已经出声。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['action'],
        properties: {
          action: { type: 'string', enum: ['speak', 'quiet'] },
          text: { type: 'string', maxLength: AMBIENT_LINE_MAX_CHARS * 2, description: '一两句话；action=quiet 时不填。' },
          noteIds: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 4 },
            description: '这句话接的是你心里记着的哪几条（n 编号）；没有就不填。' },
          invite: { type: 'string', maxLength: 4,
            description: '群聊里 action=speak 时可选：点名一位伙伴接你的话（m 编号，见情境说明）；没有就不填。' },
        },
      },
    },
    handler: (args, context = {}) => {
      const task = context.ambientTask;
      if (!task) return failure('AMBIENT_TASK_UNAVAILABLE', '这一轮没有可用的情境，到此结束。', context);
      if (context.finishReason != null && context.finishReason !== 'tool_calls') {
        return failure('AMBIENT_TRUNCATED', '上一次响应没有完整结束，请重新提交。', context, { retryable: true });
      }
      if (args.action === 'quiet') {
        return accepted('AMBIENT_QUIET', { action: 'quiet' }, '这次安静陪着，这一轮结束。', context);
      }
      if (args.action !== 'speak') {
        return failure('AMBIENT_INVALID_ACTION', 'action 只能是 speak 或 quiet。', context, { retryable: true });
      }
      const text = stripPeerMarkers(String(args.text || '')).text;
      const noteIds = [...new Set(Array.isArray(args.noteIds) ? args.noteIds.map(String) : [])];
      const notes = context.innerNotes;
      const unknown = noteIds.find(id => !notes?.map?.has(id));
      // 暂存了推荐：这句话就是推荐本身，必须点到同一首 canonical 歌名。
      const staged = context.ambientRecommendation?.stage;
      const rule = ambientLineDefect(text, task) || (unknown ? 'unknown_note' : null)
        || (staged && !mentionsTitle(text, staged.title) ? 'recommendation_not_mentioned' : null);
      if (rule) {
        return failure('AMBIENT_LINE_REJECTED', `${ambientRuleFeedback(rule)}\n修改后重新提交一次，或者提交 action=quiet。`,
          context, { retryable: true, facts: { rejectedRule: rule } });
      }
      // 点名：短编号由 runtime 映射成成员；预算（每拍一次 + 至多一次回传、句数上限）由 FloorRunner 裁定。
      // 邀请者这句真正入账后邀请才生效；被拒绝时什么也不登记，可以改掉 invite 再交。
      const inviteRef = args.invite == null ? '' : String(args.invite).trim();
      let invitedPersonId = null;
      if (inviteRef) {
        const floor = context.ambientFloor;
        const target = floor?.refs?.get(inviteRef);
        if (!target) {
          const refs = [...(floor?.refs?.keys() || [])];
          return failure('AMBIENT_INVITE_INVALID', refs.length
            ? `invite 只能写这些编号：${refs.join('、')}。改正后重新提交，或者去掉 invite。`
            : '这一轮不能点名别人接话。去掉 invite 后重新提交。', context, { retryable: true });
        }
        const registered = floor.invite(target);
        if (!registered?.ok) {
          return failure(registered?.code || 'FLOOR_NOT_AVAILABLE', '这一拍不能再点名别人接话。去掉 invite 后重新提交。',
            context, { retryable: true });
        }
        invitedPersonId = target;
      }
      // 说出口才算提过：入账时与这句话同一事务把这些 note 记为 raised。
      if (noteIds.length && notes?.stage) notes.stage.raises.push(...noteIds.map(id => notes.map.get(id)));
      return accepted('AMBIENT_LINE_ACCEPTED', { action: 'speak', text, ...(noteIds.length ? { noteIds } : {}),
        ...(invitedPersonId ? { invitedPersonId } : {}) },
        '这句话已被接受，这一轮结束；不要再提交，也不要声称已经出声。', context);
    },
  });
  return registry;
}

/**
 * recommend_track：心里正好想到一首和此刻有关的歌时，先确认它能放（不播放、不入队）。
 * context.ambientRecommendation = { stage, resolve }：resolve 走 MusicSelectionService.recommendTrack；
 * 成功只写 stage（入账时与这句话同一事务落库），歌名追加进本轮上下文，让那句话可以点名它。
 */
function registerRecommendTool(registry) {
  registry.register(RECOMMEND_TRACK_TOOL_NAME, {
    capability: AMBIENT_RECOMMEND_CAPABILITY,
    definition: {
      description: '只有你此刻心里正好想到一首具体的歌、而且它和你们现在聊的、正在听的或你记着的事有关时才用：先确认这首能放，不会播放也不会加进队列，对方点了才排到这首之后。确认成功后用 presence_respond action=speak 说一两句为什么想放给对方听，话里要提到这首歌名；没有特别想到的歌就不要用。每轮最多一首。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['title', 'artist'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 80, description: '歌名。' },
          artist: { type: 'string', minLength: 1, maxLength: 80, description: '歌手。' },
        },
      },
    },
    handler: async (args, context = {}) => {
      const recommendation = context.ambientRecommendation;
      if (!recommendation || typeof recommendation.resolve !== 'function') {
        return failure('RECOMMENDATION_NOT_AVAILABLE', '这一轮不能推荐歌。', context);
      }
      if (recommendation.stage) return failure('RECOMMENDATION_ALREADY_SPENT', '这一轮已经推荐过一首了。', context);
      let result;
      try {
        result = await recommendation.resolve({ title: String(args.title || ''), artist: String(args.artist || '') });
      } catch {
        result = { ok: false, code: 'RECOMMENDATION_UNRESOLVED' };
      }
      const track = result?.ok === true ? result.track : null;
      if (!track?.songId || !track.title) {
        const code = RECOMMEND_FAILURE_COPY[result?.code] ? result.code : 'RECOMMENDATION_UNRESOLVED';
        return failure(code, `${RECOMMEND_FAILURE_COPY[code]}不要换成别的歌；可以不推荐，直接说话或者安静。`,
          context, { retryable: true });
      }
      const title = String(track.title).replace(/[《》]/gu, '').trim();
      const artist = String(track.artist || '').trim();
      recommendation.stage = { selectionId: result.selectionId, provider: String(track.source || ''), songId: String(track.songId),
        title, artist };
      if (context.ambientTask) context.ambientTask.contextText = `${context.ambientTask.contextText || ''}\n《${title}》`;
      return noted('RECOMMENDATION_STAGED', { title, artist },
        `这首能放：《${title}》（${artist}）。它还没有播放，也不会自动播放，对方点了才会排到这首之后。现在用 presence_respond action=speak 说一两句为什么想放给对方听，话里要提到《${title}》；不要说已经安排或正在放。`,
        context);
    },
  });
}

function registerNoteTools(registry) {
  registry.register(NOTE_THOUGHT_TOOL_NAME, {
    capability: AMBIENT_CAPABILITY,
    definition: {
      description: '把一个想法先记在心里（只有你知道，对方看不到）。之后醒来或对方再来聊时你还会看到它。不是记忆，也不会告诉对方；不要记对方没说过的事。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['text'],
        properties: { text: { type: 'string', minLength: 1, maxLength: NOTE_LIMITS.textMax, description: '一句话写清楚你在想什么。' } },
      },
    },
    handler: (args, context = {}) => {
      const notes = context.innerNotes;
      if (!notes?.stage) return failure('NOTES_UNAVAILABLE', '这一轮不能记心里话。', context);
      if (notes.stage.creates.length >= MAX_STAGED_CREATES) return failure('NOTES_LIMIT', '这一轮已经记得够多了。', context);
      const text = String(args.text || '').trim();
      notes.stage.creates.push({ noteId: noteIdOf('ambient', notes.originKey, notes.stage.creates.length), kind: 'thought',
        text, origin: 'ambient', sourceRefs: notes.sourceRefs || [] });
      return noted('NOTE_STAGED', { kind: 'thought' }, '记在心里了（这一轮结束时才算数）。', context);
    },
  });
  registry.register(SCHEDULE_FOLLOWUP_TOOL_NAME, {
    capability: AMBIENT_CAPABILITY,
    definition: {
      description: '约自己过一会儿再想想某件事：inMinutes（2–120 分钟后），或 after=current_track（这首放完后）/ next_listening（下次一起听时），二选一。到时候你会被叫醒、并看到这条；这只是你自己的打算，不是给对方设的提醒，不要说「我会提醒你」。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['about'],
        properties: {
          about: { type: 'string', minLength: 1, maxLength: NOTE_LIMITS.aboutMax, description: '到时候想什么。' },
          inMinutes: { type: 'integer', minimum: 2, maximum: 120 },
          after: { type: 'string', enum: ['current_track', 'next_listening'] },
        },
      },
    },
    handler: (args, context = {}) => {
      const notes = context.innerNotes;
      if (!notes?.stage) return failure('NOTES_UNAVAILABLE', '这一轮不能约下次。', context);
      if ((args.inMinutes == null) === (args.after == null)) {
        return failure('FOLLOWUP_WHEN_INVALID', 'inMinutes 和 after 必须且只能填一个。', context, { retryable: true });
      }
      if (notes.stage.creates.length >= MAX_STAGED_CREATES) return failure('NOTES_LIMIT', '这一轮已经记得够多了。', context);
      let dueAt = null;
      let wakeCondition = null;
      if (args.inMinutes != null) dueAt = Number(notes.nowMs?.() ?? Date.now()) + args.inMinutes * 60_000;
      else if (args.after === 'next_listening') wakeCondition = 'nextListening';
      else if (notes.currentQueueItemId) wakeCondition = `afterCurrentTrack:${notes.currentQueueItemId}`;
      else return failure('FOLLOWUP_NO_TRACK', '现在没有在放的歌，换成 inMinutes 或 next_listening。', context, { retryable: true });
      notes.stage.creates.push({ noteId: noteIdOf('ambient', notes.originKey, notes.stage.creates.length), kind: 'followup',
        text: String(args.about || '').trim(), origin: 'ambient', sourceRefs: notes.sourceRefs || [], dueAt, wakeCondition });
      return noted('FOLLOWUP_STAGED', { when: args.inMinutes != null ? 'minutes' : args.after },
        '约好了（这一轮结束时才算数）；到时候你会再想起它。', context);
    },
  });
  registry.register(SETTLE_THOUGHT_TOOL_NAME, {
    capability: INNER_NOTES_CAPABILITY,
    definition: {
      description: '了结你心里记着的一条（noteId 用 n 编号）：status=resolved 表示已经聊开了或有结果了；dropped 表示不再需要惦记。不会告诉对方。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['noteId', 'status'],
        properties: {
          noteId: { type: 'string', maxLength: 4 },
          status: { type: 'string', enum: ['resolved', 'dropped'] },
        },
      },
    },
    handler: (args, context = {}) => {
      const notes = context.innerNotes;
      const shortId = String(args.noteId || '').trim();
      const noteId = SHORT_ID.test(shortId) ? notes?.map?.get(shortId) : null;
      if (!noteId) return failure('NOTE_NOT_VISIBLE', '没有这一条；只能用这一轮列出的 n 编号。', context, { retryable: true });
      if (notes.stage) notes.stage.settles.push({ noteId, status: args.status });
      // 普通回合立即落库：只对 open/raised 生效，同一请求重试不会再改变什么。
      else notes.store?.settle({ personId: notes.personId, sessionId: notes.sessionId, noteId, status: args.status });
      return noted('NOTE_SETTLED', { status: args.status }, '好，这一条放下了。', context);
    },
  });
}

export default registerAmbientTools;
