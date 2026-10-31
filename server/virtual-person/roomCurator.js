// roomCurator.js — 房间此刻该由谁来选歌/出声（纯函数，只读）。
//
// 输入：房间（memberIds 按入群顺序、activeVirtualPersonId = 设置里的主持人）、成员是否可用。
// 输出：主持人可用就是主持人；否则第一个可用成员；都不可用为 null。
// 没有 memberIds 的旧房间沿用主持人字段。
//
// Python 伪代码：
//   curator = room.host if available(room.host) else next((m for m in room.members if available(m)), None)
export function roomCurator(room, isAvailable = () => true) {
  if (!room) return null;
  if (!Array.isArray(room.memberIds)) return room.activeVirtualPersonId || null;
  const members = room.memberIds.filter(id => isAvailable(id) === true);
  return members.includes(room.activeVirtualPersonId) ? room.activeVirtualPersonId : members[0] || null;
}
