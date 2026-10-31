import { createHash } from 'node:crypto';
import { createToolOutcome, ToolOutcomeKind } from './VirtualPersonTypes.js';
import { escapePeerMarkers } from './peerMessage.js';

/**
 * 群聊回合内的发言权交接（add-group-companion-dialogue P1a）。
 *
 * 一轮里只有「初始计划最后一位」能邀请一位不在计划里的成员接话；被邀请者只能接话
 * 或用一句话拒绝。工具只登记意图，追加谁、何时追加、失败怎么收束都由 runtime 决定，
 * 这里不调度、不写账本，也不碰播放。
 *
 * 预算与顺序由本轮的 FloorRunner（floorRunner.js，state.run）裁定：工具先做自己的目标/证据校验，
 * 再向 runner 登记；被邀请者可用 return_floor 把话交回邀请者一次（A→B→A），之后不能再交接。
 *
 * yield_floor 是带音乐提交权的邀请：只有本轮音乐负责人能用；是否真的转移由 runtime
 * 在邀请者说完后重验（本轮没有音乐候选/提交），并且在被邀请者开始回应时才生效。
 */
export const GROUP_FLOOR_INVITE_CAPABILITY = 'group.floor.invite';
export const GROUP_FLOOR_DECLINE_CAPABILITY = 'group.floor.decline';
export const GROUP_FLOOR_YIELD_CAPABILITY = 'group.floor.yield';
export const GROUP_FLOOR_RETURN_CAPABILITY = 'group.floor.return';
// 主持建议（P2）：只给本轮开始时的主持人；只登记建议，切换要用户在界面上确认。
export const GROUP_HOST_SUGGEST_CAPABILITY = 'group.host.suggest';

const MAX_RESPONSES_PER_ROUND = 3;
const MAX_PLANNED_FOR_HANDOFF = 2;
const SELF_DESCRIPTION_MAX_CHARS = 300;
const DECLINE_TEXT_MAX_CHARS = 120;
const ASK_MAX_CHARS = 80;
const REASON_KINDS = ['persona_self_description', 'listener_request', 'neutral'];
const HOST_REASON_KINDS = ['persona_self_description', 'listener_request'];
const HOST_REASON_MAX_CHARS = 60;

const INTRO_MAX_CHARS = 120;

function personaSection(personaDocument, title) {
  const match = String(personaDocument || '').match(new RegExp(`(?:^|\\n)##\\s*${title}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'u'));
  return match ? match[1] : '';
}

// 生成器兜底写的占位（「（待补充）」等）不是自述。
const bounded = (text, max) => (/^（(?:待补充|未填写)/u.test(text) ? '' : text.length > max ? `${text.slice(0, max)}…` : text);

/** persona「## 我喜欢的音乐」小节：成员自述、房间内公开人设；其余小节与私人记忆一律不取。 */
export function personaSelfDescription(personaDocument = '') {
  return bounded(personaSection(personaDocument, '我喜欢的音乐').replace(/\s+/gu, ' ').trim(), SELF_DESCRIPTION_MAX_CHARS);
}

/**
 * persona「## 我是谁」的第一段：房间内公开的人设底色。只取第一段——后面的「我的故事」
 * 与「我对这个用户的态度」不算公开自述，不进别人的提示词。
 */
export function personaIntro(personaDocument = '') {
  const first = personaSection(personaDocument, '我是谁').trim().split(/\n\s*\n/u)[0] || '';
  const text = first.replace(/\s+/gu, ' ').trim();
  return bounded(text, INTRO_MAX_CHARS);
}

/** 证据来源随公开自述变化：自述被改写后旧引用自然失效。 */
export function personaSourceRef(personId, personaDocument = '') {
  const hash = createHash('sha256').update(`${personaIntro(personaDocument)}\n${personaSelfDescription(personaDocument)}`)
    .digest('hex').slice(0, 12);
  return `persona:${personId}:${hash}`;
}

/**
 * 成员公开画像（add-group-companion-dialogue D4）：只有名字、公开自述两段与来源编号。
 * 不读记忆、反思、图式、生活资料、私聊或其他会话的观察；成员本人的公开发言已经以
 * 同伴信封出现在全员可读的历史里，这里不重复。
 */
export function memberPublicProfile(person) {
  if (!person?.id) return null;
  const intro = personaIntro(person.personaDocument);
  const selfDescription = personaSelfDescription(person.personaDocument);
  return Object.freeze({
    id: person.id,
    displayName: person.displayName || person.id,
    intro,
    selfDescription,
    sourceRef: intro || selfDescription ? personaSourceRef(person.id, person.personaDocument) : null,
  });
}

/**
 * 交付前重验主持建议：对象不再是成员、已归档，或所引的公开自述被改写/撤掉时，
 * 建议整条丢弃（主持建议没有「中性」版本）。只判断不改状态：返回关闭原因码，仍有效返回 null。
 */
export function revalidateHostSuggestion(floor, person, { isMember = true } = {}) {
  const suggestion = floor?.hostSuggestion;
  if (!suggestion) return null;
  if (!isMember || !person || person.status === 'archived') return 'target_unavailable';
  if (suggestion.reasonKind !== 'persona_self_description') return null;
  const current = memberPublicProfile(person);
  return current.sourceRef && (current.intro || current.selfDescription) && suggestion.evidenceRefs.includes(current.sourceRef)
    ? null : 'persona_source_changed';
}

/**
 * 交付前重验邀请证据：被邀请者的公开自述在这一轮里被改写或撤掉时，引用失效，
 * 邀请降级为中性（不再声称依据对方自述）。返回关闭的原因码；没有变化返回 null。
 */
export function revalidateInvitationEvidence(floor, person) {
  const invitation = floor?.invitation;
  if (!invitation || invitation.reasonKind !== 'persona_self_description') return null;
  const current = person && person.status !== 'archived' && personaSelfDescription(person.personaDocument)
    ? personaSourceRef(person.id, person.personaDocument) : null;
  if (current && invitation.evidenceRefs.includes(current)) return null;
  floor.invitation = Object.freeze({ ...invitation, reasonKind: 'neutral', evidenceRefs: [] });
  return current ? 'persona_source_changed' : 'persona_source_unavailable';
}

/**
 * 每个群聊回合一份的交接状态。runtime 拥有并修改它；工具只通过 toolContext 读、登记意图。
 * persons 是本轮成员实体，只投影公开自述，不读记忆、反思、生活资料或私聊。
 */
export function createGroupFloor({ plan = [], memberIds = [], persons = [], userTurnId, hostId = null }) {
  const planned = new Set(plan);
  const inviterId = plan.length && plan.length <= MAX_PLANNED_FOR_HANDOFF ? plan.at(-1) : null;
  const byId = new Map(persons.map(person => [person.id, person]));
  const candidates = inviterId ? memberIds.filter(id => !planned.has(id) && byId.has(id)).map(id => {
    const { displayName, selfDescription, sourceRef } = memberPublicProfile(byId.get(id));
    // 邀请证据只认「喜欢的音乐」：没有这段自述就只能中性邀请。
    return Object.freeze({ id, displayName, selfDescription, sourceRef: selfDescription ? sourceRef : null });
  }) : [];
  // 主持建议的对象：除主持人外的现任成员；证据只认对方公开自述（「我是谁」或「喜欢的音乐」）或用户本轮原话。
  const hostCandidates = hostId && byId.has(hostId) ? memberIds.filter(id => id !== hostId && byId.has(id)).map(id => {
    const { displayName, intro, selfDescription, sourceRef } = memberPublicProfile(byId.get(id));
    return Object.freeze({ id, displayName, sourceRef: intro || selfDescription ? sourceRef : null });
  }) : [];
  return {
    plan: [...plan],
    inviterId: candidates.length ? inviterId : null,
    candidates,
    hostId: hostCandidates.length ? hostId : null,
    hostCandidates,
    hostSuggestion: null,
    listenerRef: `turn:${userTurnId}`,
    invitation: null,
    mutationAccepted: false,
    names: new Map(persons.map(person => [person.id, person.displayName || person.id])),
  };
}

/** 本次回应在交接里的角色：只有它决定工具可见性与提示词小节；让位只给握有音乐提交权的邀请者。 */
export function floorCapabilities(role, { canTransferMusic = false, canSuggestHost = false } = {}) {
  const host = canSuggestHost ? [GROUP_HOST_SUGGEST_CAPABILITY] : [];
  if (role === 'inviter') return [GROUP_FLOOR_INVITE_CAPABILITY, ...(canTransferMusic ? [GROUP_FLOOR_YIELD_CAPABILITY] : []), ...host];
  if (role === 'invited') return [GROUP_FLOOR_DECLINE_CAPABILITY, GROUP_FLOOR_RETURN_CAPABILITY];
  return host;
}

/** 给 PromptAssembler 的有界投影：只有名字、公开自述与证据编号，没有调度内部状态。 */
export function floorBrief(floor, role, { canTransferMusic = false, canSuggestHost = false } = {}) {
  if (!floor || (!role && !canSuggestHost)) return null;
  const suggestHost = canSuggestHost
    ? { suggestHost: { listenerRef: floor.listenerRef, candidates: floor.hostCandidates.map(item => ({ ...item })) } } : {};
  if (!role) return { role: null, ...suggestHost };
  if (role === 'inviter') {
    return { role, listenerRef: floor.listenerRef, canYield: canTransferMusic,
      candidates: floor.candidates.map(item => ({ ...item })), ...suggestHost };
  }
  const nameOf = id => floor.names.get(id) || id || '';
  if (role === 'returned') return { role, fromName: nameOf(floor.returnInvitation?.fromPersonId) };
  const invitation = floor.invitation;
  return { role, fromName: nameOf(invitation?.fromPersonId), ownsMusic: floor.musicAuthority === 'transferred',
    ...(invitation?.ask ? { ask: invitation.ask } : {}) };
}

function failure(code, modelContext, correlationId) {
  return createToolOutcome({
    kind: ToolOutcomeKind.BUSINESS_FAILURE,
    code,
    modelContext,
    presentation: { displayText: '', speak: false, retryable: true },
    internal: { correlationId },
  });
}

const INVITE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['toPersonId', 'reasonKind', 'evidenceRefs'],
  properties: {
    toPersonId: { type: 'string', description: '被邀请成员的 ID，必须来自“本轮发言权”里的候选。' },
    reasonKind: { type: 'string', enum: REASON_KINDS,
      description: 'persona_self_description=依据对方公开自述；listener_request=用户本轮原话提到对方；neutral=中性邀请，不断言对方擅长什么。' },
    evidenceRefs: { type: 'array', maxItems: 3, items: { type: 'string' },
      description: '证据编号，来自“本轮发言权”。neutral 可为空。' },
    ask: { type: 'string',
      description: `可选：想请对方接的话题或问题，用你自己的话写，${ASK_MAX_CHARS} 字以内。对方会在发言权说明里看到，用户在交接标注里也看得到；只是话题，不带任何权限。` },
  },
};

/** invite 与 yield 共用一次交接额度与同一套目标/证据校验。 */
function registerInvitation(args, context, { transferMusicAuthority }) {
  const floor = context.groupFloor?.state;
  const correlationId = context.correlationId;
  if (context.groupFloor?.role !== 'inviter' || !floor || floor.inviterId !== context.virtualPersonId) {
    return failure('FLOOR_NOT_AVAILABLE', '本轮你不能邀请别人接话；直接用自己的话回答。', correlationId);
  }
  if (transferMusicAuthority && context.groupAction?.ownerId !== context.virtualPersonId) {
    return failure('FLOOR_NOT_AVAILABLE', '本轮你不负责提交音乐，不能把选歌交出去；可以用 invite_floor 只邀请对方说话。', correlationId);
  }
  if (floor.invitation) {
    return failure('FLOOR_ALREADY_SPENT', '本轮已经邀请过一位成员，不能再邀请；直接完成你的回复。', correlationId);
  }
  const toPersonId = String(args.toPersonId || '').trim();
  const candidate = floor.candidates.find(item => item.id === toPersonId);
  if (!candidate) {
    return failure('FLOOR_TARGET_INVALID',
      `只能邀请这些成员：${floor.candidates.map(item => item.id).join('、') || '（无）'}。不能邀请自己、已安排发言的成员或不在本群的人。`, correlationId);
  }
  const refs = new Set((args.evidenceRefs || []).map(String));
  const reasonKind = String(args.reasonKind || '');
  const evidenceOk = reasonKind === 'neutral'
    || (reasonKind === 'persona_self_description' && candidate.sourceRef && refs.has(candidate.sourceRef))
    || (reasonKind === 'listener_request' && refs.has(floor.listenerRef));
  if (!evidenceOk) {
    return failure('FLOOR_EVIDENCE_INVALID',
      '证据编号与理由不匹配。没有对方的公开自述或用户原话作依据时，用 reasonKind=neutral 中性邀请，并且不要断言对方擅长什么。', correlationId);
  }
  // ask 只是话题：单行、有界、中和信封标记；它会进对方的发言权说明，所以不能借它伪造别人说的话。
  const ask = args.ask == null ? '' : escapePeerMarkers(String(args.ask).replace(/\s+/gu, ' ').trim());
  if (args.ask != null && (!ask || ask.length > ASK_MAX_CHARS)) {
    return failure('FLOOR_ASK_INVALID', `ask 是 1–${ASK_MAX_CHARS} 字的一句话题；写短一点，或者不填。`, correlationId);
  }
  const accepted = floor.run ? floor.run.invite(context.virtualPersonId, toPersonId) : { ok: true };
  if (!accepted.ok) {
    return failure(accepted.code, accepted.code === 'FLOOR_ALREADY_SPENT'
      ? '本轮已经邀请过一位成员，不能再邀请；直接完成你的回复。'
      : '本轮现在不能再交接发言；直接用自己的话回答。', correlationId);
  }
  floor.invitation = Object.freeze({
    fromPersonId: context.virtualPersonId,
    toPersonId,
    reasonKind,
    evidenceRefs: reasonKind === 'neutral' ? [] : [...refs].slice(0, 3),
    transferMusicAuthority: Boolean(transferMusicAuthority),
    ...(ask ? { ask } : {}),
  });
  const handoff = transferMusicAuthority
    ? `已登记：你说完后由 ${candidate.displayName} 接话，并由对方自己挑这一轮的歌。你这轮不要再选歌或提交音乐；用一两句话自然地把话和选歌交给 ${candidate.displayName}，不要替对方说会放什么。`
    : `已登记：你说完后由 ${candidate.displayName} 接话。现在用你自己的一两句话自然地把话交给 ${candidate.displayName}；不要替对方说话，也不要预告对方会怎么回答。`;
  const askNote = ask ? `你想请对方接的话题已经转给 ${candidate.displayName}，回复里不必再对 ${candidate.displayName} 转述一遍。` : '';
  return createToolOutcome({
    kind: ToolOutcomeKind.SUCCESS,
    code: transferMusicAuthority ? 'FLOOR_YIELDED' : 'FLOOR_INVITED',
    facts: { toPersonId },
    modelContext: askNote ? `${handoff}${askNote}` : handoff,
    presentation: { displayText: '', speak: false },
    internal: { correlationId },
  });
}

export function registerFloorTools(toolRegistry) {
  toolRegistry.register('invite_floor', {
    capability: GROUP_FLOOR_INVITE_CAPABILITY,
    definition: {
      description: '群聊里，在你说完后邀请一位还没安排发言的成员接着说。每轮最多一次，可选，不是必须。想请对方说什么、回答什么，写进 ask；可见回复里不必再对对方转述一句指令。邀请被接受后，你的回复要用自己的话自然地把话交给对方；不要替对方说话。',
      parameters: INVITE_PARAMETERS,
    },
    handler: (args, context) => registerInvitation(args, context, { transferMusicAuthority: false }),
  });

  toolRegistry.register('yield_floor', {
    capability: GROUP_FLOOR_YIELD_CAPABILITY,
    definition: {
      description: '群聊里，把话和这一轮的选歌一起交给一位还没安排发言的成员：对方接话时自己选歌并提交。和 invite_floor 共用每轮一次的额度。要么你自己选歌，要么让位，不要同时做；你已经选过候选或提交过音乐时，选歌不会转移。',
      parameters: INVITE_PARAMETERS,
    },
    handler: (args, context) => registerInvitation(args, context, { transferMusicAuthority: true }),
  });

  toolRegistry.register('suggest_host', {
    capability: GROUP_HOST_SUGGEST_CAPABILITY,
    definition: {
      description: '群聊里，建议以后由另一位成员当这个聊天的当前伙伴（主持）。只登记一条建议，用户在界面上确认后才会换人；调用后你仍是主持，不要说已经换了。只在用户表达想换人主持、以后多听谁的时候用；每轮最多一次，不是必须。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['toPersonId', 'reasonKind', 'evidenceRefs'],
        properties: {
          toPersonId: { type: 'string', description: '被建议成员的 ID，必须来自“主持建议”里的成员。' },
          reasonKind: { type: 'string', enum: HOST_REASON_KINDS,
            description: 'persona_self_description=依据对方公开自述；listener_request=用户本轮原话提到想让对方主持。' },
          evidenceRefs: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' },
            description: '证据编号，来自“主持建议”或成员公开自述。主持建议必须有依据。' },
          reason: { type: 'string', description: `可选：给用户看的一句理由，${HOST_REASON_MAX_CHARS} 字以内。` },
        },
      },
    },
    handler(args, context) {
      const floor = context.groupFloor?.state;
      const correlationId = context.correlationId;
      if (!floor || floor.hostId !== context.virtualPersonId || !floor.hostCandidates.length) {
        return failure('HOST_SUGGESTION_NOT_AVAILABLE', '本轮你不能建议换主持；直接用自己的话回答。', correlationId);
      }
      if (floor.hostSuggestion) {
        return failure('HOST_SUGGESTION_ALREADY_SPENT', '本轮已经提过一条主持建议；直接完成你的回复。', correlationId);
      }
      const toPersonId = String(args.toPersonId || '').trim();
      const candidate = floor.hostCandidates.find(item => item.id === toPersonId);
      if (!candidate) {
        return failure('HOST_SUGGESTION_TARGET_INVALID',
          `只能建议这些成员：${floor.hostCandidates.map(item => item.id).join('、')}。不能建议自己或不在本群的人。`, correlationId);
      }
      const refs = new Set((args.evidenceRefs || []).map(String));
      const reasonKind = String(args.reasonKind || '');
      const evidenceOk = (reasonKind === 'persona_self_description' && candidate.sourceRef && refs.has(candidate.sourceRef))
        || (reasonKind === 'listener_request' && refs.has(floor.listenerRef));
      if (!evidenceOk) {
        return failure('HOST_SUGGESTION_EVIDENCE_INVALID',
          '主持建议必须引用对方的公开自述或用户本轮原话的证据编号；没有依据就不要提建议，直接回答。', correlationId);
      }
      const reason = args.reason == null ? '' : escapePeerMarkers(String(args.reason).replace(/\s+/gu, ' ').trim());
      if (args.reason != null && (!reason || reason.length > HOST_REASON_MAX_CHARS)) {
        return failure('HOST_SUGGESTION_REASON_INVALID', `reason 是 1–${HOST_REASON_MAX_CHARS} 字的一句话；写短一点，或者不填。`, correlationId);
      }
      floor.hostSuggestion = Object.freeze({
        fromPersonId: context.virtualPersonId,
        toPersonId,
        reasonKind,
        evidenceRefs: [...refs].slice(0, 3),
        ...(reason ? { reason } : {}),
      });
      return createToolOutcome({
        kind: ToolOutcomeKind.SUCCESS,
        code: 'HOST_SUGGESTED',
        facts: { toPersonId },
        modelContext: `已记下建议：以后由 ${candidate.displayName} 主持，等用户在界面上确认。现在还没有换人，你仍是主持；可以用一句话自然地提一下，不要说已经换了。`,
        presentation: { displayText: '', speak: false },
        internal: { correlationId },
      });
    },
  });

  toolRegistry.register('return_floor', {
    capability: GROUP_FLOOR_RETURN_CAPABILITY,
    definition: {
      description: '你被邀请接话、说完后想听邀请你的人再接一句时调用：把话交回给对方。每轮只能交回一次，之后谁都不能再交接。可选，不是必须。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
    },
    handler(_args, context) {
      const floor = context.groupFloor?.state;
      const correlationId = context.correlationId;
      const inviterId = floor?.invitation?.fromPersonId;
      if (context.groupFloor?.role !== 'invited' || floor?.invitation?.toPersonId !== context.virtualPersonId || floor.declined) {
        return failure('FLOOR_NOT_AVAILABLE', '你现在不能把话交回去；直接用自己的话回答。', correlationId);
      }
      const accepted = floor.run ? floor.run.invite(context.virtualPersonId, inviterId) : { ok: true };
      if (!accepted.ok) {
        return failure(accepted.code, accepted.code === 'FLOOR_ALREADY_SPENT'
          ? '你已经把话交回去了；直接完成你的回复。' : '本轮不能再交接发言；直接用自己的话回答。', correlationId);
      }
      floor.returnInvitation = Object.freeze({ fromPersonId: context.virtualPersonId, toPersonId: inviterId });
      const name = floor.names.get(inviterId) || inviterId;
      return createToolOutcome({
        kind: ToolOutcomeKind.SUCCESS,
        code: 'FLOOR_RETURNED',
        facts: { toPersonId: inviterId },
        modelContext: `已登记：你说完后由 ${name} 再接一句，这一轮到此为止。用你自己的话自然地把话交回给 ${name}；不要替对方说话。`,
        presentation: { displayText: '', speak: false },
        internal: { correlationId },
      });
    },
  });

  toolRegistry.register('decline_floor', {
    capability: GROUP_FLOOR_DECLINE_CAPABILITY,
    definition: {
      description: '你被邀请接话但不想接时调用，留下一句你自己的自然回应（不超过 120 字）。调用后本轮你的发言就是这句话。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string', description: '一句自然的回应，例如把话交还给邀请你的人。' } },
      },
    },
    async handler(args, context) {
      const floor = context.groupFloor?.state;
      const correlationId = context.correlationId;
      if (context.groupFloor?.role !== 'invited' || floor?.invitation?.toPersonId !== context.virtualPersonId) {
        return failure('FLOOR_NOT_AVAILABLE', '你没有被邀请接话；直接用自己的话回答。', correlationId);
      }
      const text = String(args.text || '').replace(/\s+/gu, ' ').trim();
      if (!text || text.length > DECLINE_TEXT_MAX_CHARS) {
        return failure('FLOOR_DECLINE_TEXT_INVALID', `拒绝时留一句 1–${DECLINE_TEXT_MAX_CHARS} 字的自然回应。`, correlationId);
      }
      floor.declined = true;
      return createToolOutcome({
        kind: ToolOutcomeKind.SUCCESS,
        code: 'FLOOR_DECLINED',
        terminal: true,
        modelContext: '已记录：你这轮不接话。',
        presentation: { displayText: text, speak: true },
        internal: { correlationId },
      });
    },
  });
}

export { MAX_RESPONSES_PER_ROUND };
