// groupFloorRound.js — 群聊一轮里，计划回应之后的追加回应：被邀请者接话、A→B→A 收尾，以及音乐提交权的两阶段转移。
//
// 谁接下一句由 FloorRunner 决定；这里只负责「这一位现在能不能开始」的重验、跑这一句（回调 VirtualPersonRuntime
// 的 runResponse，同一条回应链，不另起 Agent），以及把交接结果写成 round result 的 floor 摘要。
// 追加回应失败不写替身句，只把回合标 partial；音乐提交权在被邀请者没接住时还给邀请者。
//
// Python 伪代码：
//   if cancelled or mutation_accepted or not inviter_ok or not still_member: return skip()
//   if music_authority == "pending": owner = invited; music_authority = "transferred"
//   response = run_response(invited, deadline=floor_deadline)
//   return summary("answered" | "declined" | "failed")

import { floorRequestId } from './responsePlan.js';
import { revalidateHostSuggestion } from './floorTools.js';
import { policyFromUserText } from '../memory/memoryPolicy.js';

// 群聊追加段的截止：被邀请者与 A→B→A 收尾共用 budgetMs；剩余不足 minReturnMs 时不开始收尾。
export const FLOOR_LIMITS = Object.freeze({ budgetMs: 30_000, minReturnMs: 2_000 });

/**
 * 音乐权转移的第一步与收尾（第二步在被邀请者开始回应时）：
 * - 邀请者说完：本轮已有任何音乐候选/提交结果就拒绝转移，只交发言权；否则进入 pending。
 * - 被邀请者拒绝：负责人还给邀请者。被邀请者自己提交了音乐就记 committedMusic。
 * 被邀请者用不到邀请者的候选：offer 绑定创建者，commit 会拒绝别人的 offer。
 */
export function settleMusicAuthority({ groupFloor, groupAction, floorRole, outcomes, committed }) {
  const invitation = groupFloor.invitation;
  if (!invitation?.transferMusicAuthority) return;
  if (floorRole === 'inviter') {
    const touchedMusic = outcomes.some(item => item.ok && !String(item.code).startsWith('FLOOR_')
      && (String(item.code).startsWith('MUSIC_') || item.facts?.offerId));
    groupFloor.musicAuthority = touchedMusic || groupFloor.mutationAccepted ? 'rejected' : 'pending';
    return;
  }
  if (floorRole === 'invited' && groupFloor.musicAuthority === 'transferred') {
    groupFloor.committedMusic = Boolean(committed && committed.code !== 'FLOOR_DECLINED');
    if (groupFloor.declined) returnMusicAuthority(groupFloor, groupAction);
  }
}

/** round result 里的交接摘要；待转移的音乐权在交接结束时还给邀请者。 */
function floorSummary(groupFloor, groupAction, status) {
  const invitation = groupFloor.invitation;
  if (invitation.transferMusicAuthority && groupFloor.musicAuthority === 'pending') returnMusicAuthority(groupFloor, groupAction);
  return Object.freeze({ fromPersonId: invitation.fromPersonId, toPersonId: invitation.toPersonId, status,
    ...(invitation.transferMusicAuthority ? { musicAuthority: groupFloor.musicAuthority } : {}) });
}

function returnMusicAuthority(groupFloor, groupAction) {
  groupAction.ownerId = groupFloor.invitation.fromPersonId;
  groupFloor.musicAuthority = 'returned';
}

/** 交接关系写在双方的 turn 上：邀请者记录交给谁，被邀请者记录在回复谁（设计稿的「回复 X」）。 */
export function turnFloorMetadata(groupFloor, floorRole) {
  const invitation = groupFloor?.invitation;
  if (!invitation) return null;
  if (floorRole === 'inviter' && !groupFloor.mutationAccepted) {
    return { role: 'inviter', targetPersonId: invitation.toPersonId, reasonKind: invitation.reasonKind,
      ...(invitation.ask ? { ask: invitation.ask } : {}),
      // 邀请者落账时转移还没生效（要等被邀请者开始回应），所以只记「让出了选歌」。
      ...(groupFloor.musicAuthority === 'pending' ? { musicAuthority: 'offered' } : {}) };
  }
  if (floorRole === 'invited') {
    const authority = invitation.transferMusicAuthority && groupFloor.musicAuthority !== 'rejected'
      ? { musicAuthority: groupFloor.musicAuthority, committedMusic: groupFloor.committedMusic === true } : {};
    const returned = groupFloor.returnInvitation && !groupFloor.declined ? { returnedTo: groupFloor.returnInvitation.toPersonId } : {};
    return { role: 'invited', fromPersonId: invitation.fromPersonId,
      replyToTurnId: groupFloor.replyToTurnId || null, declined: groupFloor.declined === true, ...authority, ...returned,
      ...(invitation.ask ? { ask: invitation.ask } : {}) };
  }
  if (floorRole === 'returned' && groupFloor.returnInvitation) {
    return { role: 'returned', fromPersonId: groupFloor.returnInvitation.fromPersonId,
      replyToTurnId: groupFloor.returnReplyToTurnId || null };
  }
  return null;
}

export class GroupFloorResponses {
  constructor({ conversationStore, registry, sessionTrace = null, floorBudgetMs = FLOOR_LIMITS.budgetMs,
    runResponse, notifyResponseCommitted = () => {} } = {}) {
    this.conversationStore = conversationStore;
    this.registry = registry;
    this.sessionTrace = sessionTrace;
    this.floorBudgetMs = floorBudgetMs;
    this.runResponse = runResponse;
    this.notifyResponseCommitted = notifyResponseCommitted;
  }

  /**
   * 计划回应全部结束后，按已接受的 invite_floor 追加一位被邀请者。
   * 追加前重验：邀请者已正常提交、本轮没有已接受的播放 mutation、未取消、目标仍是成员。
   * 被邀请者失败不写替身句，只把回合标 partial；返回值是 round result 的 floor 摘要。
   */
  async runInvited({ input, round, groupFloor, groupAction, controller, responses }) {
    const { sessionId } = input;
    const invitation = groupFloor.invitation;
    const summary = status => floorSummary(groupFloor, groupAction, status);
    const inviterResponse = responses.find(response => response.virtualPersonId === invitation.fromPersonId);
    const entity = this.registry.get(invitation.toPersonId);
    const room = this.conversationStore.getSession(sessionId);
    if (controller.signal.aborted || groupFloor.mutationAccepted || !inviterResponse?.ok || !entity
        || entity.status === 'archived' || room?.archivedAt
        || this.conversationStore.membershipToken(sessionId, entity.id) !== round.memberTokens[entity.id]) {
      return this.skip({ input, round, groupFloor, groupAction, controller, inviterResponse });
    }
    const requestId = floorRequestId(round.roundId, entity.id);
    groupFloor.replyToTurnId = inviterResponse.sourceTurnId;
    // round 级剩余截止（D 失败收束）：追加段从这里起算，被邀请者与回传收尾共用；超时按 floor 失败收束。
    groupFloor.deadlineAt ??= Date.now() + this.floorBudgetMs;
    if (groupFloor.musicAuthority === 'pending') {
      // 两阶段的第二步：被邀请者真正开始回应时才成为本轮唯一音乐负责人。
      groupAction.ownerId = entity.id;
      groupFloor.musicAuthority = 'transferred';
      this.sessionTrace?.record({ sessionId, requestId, roundId: round.roundId },
        { type: 'music_authority_transfer_started', toPersonId: entity.id });
    }
    const run = () => this.runResponse({ ...input, requestId, entity, round, signal: controller.signal,
      groupAction, groupFloor, floorRole: 'invited', deadlineAt: groupFloor.deadlineAt });
    const response = await (this.sessionTrace?.enter
      ? this.sessionTrace.enter({ sessionId, requestId, roundId: round.roundId, virtualPersonId: entity.id }, run)
      : run());
    if (!response) {
      if (groupFloor.musicAuthority === 'transferred') returnMusicAuthority(groupFloor, groupAction);
      return summary('failed');
    }
    responses.push(response);
    this.conversationStore.observeTurns(round.memberIds.filter(id => this.conversationStore.membershipToken(sessionId, id) === round.memberTokens[id]),
      [response.sourceTurnId], policyFromUserText(input.userText, sessionId));
    this.notifyResponseCommitted(input, response);
    return summary(groupFloor.declined ? 'declined' : 'answered');
  }

  /**
   * 主持建议入账前重验（P2）：对象仍是成员、证据仍有效才写到建议者这一轮的消息上，
   * status 固定 pending。是否已应用由界面对照房间的权威 activeVirtualPersonId 判断，
   * 不在这里另存第二份「谁是主持」。这里绝不改 activeVirtualPersonId。
   */
  settleHostSuggestion(groupFloor, round, traceContext) {
    const suggestion = groupFloor?.hostSuggestion;
    if (!suggestion) return null;
    const { sessionId } = traceContext;
    const target = this.registry.get(suggestion.toPersonId);
    const dropped = revalidateHostSuggestion(groupFloor, target, {
      isMember: this.conversationStore.membershipToken(sessionId, suggestion.toPersonId) === round.memberTokens[suggestion.toPersonId],
    });
    if (dropped) {
      this.sessionTrace?.record(traceContext, { type: 'host_suggestion_dropped', toPersonId: suggestion.toPersonId, reason: dropped });
      return null;
    }
    this.sessionTrace?.record(traceContext, { type: 'host_suggestion_recorded', toPersonId: suggestion.toPersonId,
      reasonKind: suggestion.reasonKind });
    return { toPersonId: suggestion.toPersonId, reasonKind: suggestion.reasonKind, evidenceRefs: [...suggestion.evidenceRefs],
      ...(suggestion.reason ? { reason: suggestion.reason } : {}), status: 'pending' };
  }

  /**
   * 邀请已登记但被邀请者没有开始。已接受的播放 mutation 是本轮正常的终点；其余原因
   * （取消、邀请者失败、成员或房间变化）都是追加回应缺失，回合记 partial。
   */
  skip({ input, round, groupFloor, groupAction, controller = null, inviterResponse = null }) {
    const reason = controller?.signal.aborted ? 'cancelled'
      : groupFloor.mutationAccepted ? 'mutation'
        : inviterResponse && !inviterResponse.ok ? 'inviter-failed'
          : !inviterResponse ? 'inviter-missing' : 'membership';
    groupFloor.incomplete = reason !== 'mutation';
    this.sessionTrace?.record({ sessionId: input.sessionId, requestId: round.roundId, roundId: round.roundId },
      { type: 'floor_skipped', toPersonId: groupFloor.invitation.toPersonId, reason });
    return floorSummary(groupFloor, groupAction, 'skipped');
  }

  /**
   * A→B→A 的最后一跳：被邀请者用 return_floor 交回后，原邀请者再收一句尾。
   * 与 runInvited 同样重验（未取消、无已接受 mutation、被邀请者已正常提交、仍是成员）；
   * 失败不写替身句。音乐提交权不随回传移动：仍在本轮当前负责人手里。
   */
  async runReturn({ input, round, groupFloor, groupAction, controller, responses }) {
    const { sessionId } = input;
    const hop = groupFloor.returnInvitation;
    const summary = status => Object.freeze({ fromPersonId: hop.fromPersonId, toPersonId: hop.toPersonId, status });
    const invitedResponse = responses.findLast(response => response.virtualPersonId === hop.fromPersonId);
    const entity = this.registry.get(hop.toPersonId);
    if (controller.signal.aborted || groupFloor.mutationAccepted || !invitedResponse?.ok || !entity
        || entity.status === 'archived' || this.conversationStore.getSession(sessionId)?.archivedAt
        || this.conversationStore.membershipToken(sessionId, entity.id) !== round.memberTokens[entity.id]) {
      this.sessionTrace?.record({ sessionId, requestId: round.roundId, roundId: round.roundId },
        { type: 'floor_return_skipped', toPersonId: hop.toPersonId });
      if (!groupFloor.mutationAccepted) groupFloor.incomplete = true;
      return summary('skipped');
    }
    // 被邀请者用掉了大半截止：剩下的时间不够收一句尾，就不开始。
    if (!(groupFloor.deadlineAt - Date.now() >= FLOOR_LIMITS.minReturnMs)) {
      this.sessionTrace?.record({ sessionId, requestId: round.roundId, roundId: round.roundId },
        { type: 'floor_return_skipped', toPersonId: hop.toPersonId, reason: 'deadline' });
      groupFloor.incomplete = true;
      return summary('skipped');
    }
    const requestId = floorRequestId(round.roundId, entity.id);
    groupFloor.returnReplyToTurnId = invitedResponse.sourceTurnId;
    const run = () => this.runResponse({ ...input, requestId, entity, round, signal: controller.signal,
      groupAction, groupFloor, floorRole: 'returned', deadlineAt: groupFloor.deadlineAt });
    const response = await (this.sessionTrace?.enter
      ? this.sessionTrace.enter({ sessionId, requestId, roundId: round.roundId, virtualPersonId: entity.id }, run)
      : run());
    if (!response) {
      groupFloor.incomplete = true;
      return summary('failed');
    }
    responses.push(response);
    this.conversationStore.observeTurns(round.memberIds.filter(id => this.conversationStore.membershipToken(sessionId, id) === round.memberTokens[id]),
      [response.sourceTurnId], policyFromUserText(input.userText, sessionId));
    this.notifyResponseCommitted(input, response);
    return summary(response.ok ? 'answered' : 'failed');
  }
}
