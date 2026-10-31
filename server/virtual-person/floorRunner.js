// floorRunner.js — 一套发言权协议：用户回合与 ambient 一拍共用的「谁接下一句」状态机
// （add-companion-expression-and-reception D3）。
//
// 它只管规则，不调模型、不写账本、不碰播放，也不管音乐提交权（让位与两阶段转移仍由 runtime 负责）：
//   - 队列：初始成员按顺序跑；被邀请者插到队首；
//   - 邀请：每轮 1 次，外加至多 1 次回传给原邀请者（A→B→A）；邀请在邀请者真正入账后才生效，
//     同一回合里重复邀请也算用掉；
//   - 上限：可见句数按回合类型配置；放不下被邀请者那一句时不接受邀请；
//   - 结束：被打断（你开口、来源/模式变了、撤销）或已接受的音乐 mutation 立即停止。
//
// 调用方式（Python 伪代码）：
//   run = create_floor_run(kind='ambient', initial=[('a', 'holder')], member_ids=..., can_open_invite=...)
//   while (entry := run.next()):
//       result = run_turn(entry)            # 模型回合里工具调用 run.invite(entry.person_id, to)
//       run.settle(entry.person_id, spoke=result.spoke, terminal_mutation=..., declined=...)

export const FLOOR_KINDS = Object.freeze({
  // 用户回合：计划里的人都跑（「每个人都说说」可以超过 3 位），再加至多两跳交接。
  listener: Object.freeze({ maxLines: Infinity }),
  // ambient 一拍：含出声者最多 3 句，正好容纳 A→B→A。
  ambient: Object.freeze({ maxLines: 3 }),
});

export function createFloorRun({ kind, initial = [], memberIds = [], canOpenInvite = () => false } = {}) {
  const limits = FLOOR_KINDS[kind];
  if (!limits) throw new TypeError(`unknown floor kind: ${kind}`);
  const queue = initial.map(entry => Object.freeze({ personId: entry.personId, role: entry.role }));
  const ran = [];
  let current = null;
  let pending = null;
  let invitation = null;
  let returned = null;
  let lines = 0;
  let stopReason = null;

  const roomForInvited = () => lines + 2 <= limits.maxLines;

  const run = {
    kind,
    get lines() { return lines; },
    get invitation() { return invitation; },
    get returnInvitation() { return returned; },
    get stopReason() { return stopReason; },
    get current() { return current; },

    next() {
      if (stopReason || lines >= limits.maxLines || !queue.length) return null;
      current = queue.shift();
      pending = null;
      ran.push(current.personId);
      return current;
    },

    /** 当前发言者此刻可以邀请谁；没有资格时为空。 */
    inviteTargets(fromPersonId) {
      if (stopReason || current?.personId !== fromPersonId || pending || !roomForInvited()) return [];
      if (!invitation) {
        if (current.role === 'invited' || current.role === 'returned' || !canOpenInvite(fromPersonId, run)) return [];
        return memberIds.filter(id => id !== fromPersonId && !ran.includes(id));
      }
      if (!returned && current.role === 'invited' && invitation.toPersonId === fromPersonId) return [invitation.fromPersonId];
      return [];
    },

    /** 登记邀请意图；只有 settle(spoke) 之后才真正把被邀请者排进来。 */
    invite(fromPersonId, toPersonId) {
      const targets = run.inviteTargets(fromPersonId);
      if (!targets.length) {
        const spent = pending || invitation;
        return { ok: false, code: spent && current?.personId === fromPersonId ? 'FLOOR_ALREADY_SPENT' : 'FLOOR_NOT_AVAILABLE' };
      }
      if (!targets.includes(toPersonId)) return { ok: false, code: 'FLOOR_TARGET_INVALID', targets };
      pending = Object.freeze({ fromPersonId, toPersonId, hop: invitation ? 'return' : 'invite' });
      return { ok: true, hop: pending.hop };
    },

    settle(personId, { spoke = false, terminalMutation = false, declined = false } = {}) {
      if (current?.personId !== personId) return;
      const hop = pending;
      current = null;
      pending = null;
      if (spoke) lines += 1;
      if (terminalMutation) { stopReason = 'mutation'; return; }
      if (!hop || !spoke || declined) return;
      if (hop.hop === 'invite') invitation = hop;
      else returned = hop;
      const index = queue.findIndex(entry => entry.personId === hop.toPersonId);
      if (index >= 0) queue.splice(index, 1);
      queue.unshift(Object.freeze({ personId: hop.toPersonId, role: hop.hop === 'invite' ? 'invited' : 'returned', invitation: hop }));
    },

    interrupt(reason = 'interrupted') {
      if (!stopReason) stopReason = reason;
    },
  };
  return run;
}
