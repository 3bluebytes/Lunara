// groupVoice.js — 一拍开始时谁出声、谁文字跟（add-companion-heartbeat D9，纯函数）。
//
// 输入：权威播放快照、当前房间（memberIds 按入群顺序、activeVirtualPersonId = 设置里的主持人）、
//      成员是否可用（伙伴被归档就不可用）。
// 输出：{ holderId, hostId, delegated, followerIds }。只读，不写房间、不改设置里的主持人。
//
// 规则：
//   - 单聊：维持原口径，正在放的这首由谁负责就是谁出声，没人跟；群里只剩一个可用成员时由她出声、没人跟；
//   - 群聊：默认主持人出声；听歌人那一轮由非主持人提交的歌（user_request）在放时，出声权临时转给她；
//     自动续播的歌归主持人；
//   - 主持人被移出或归档 → 第一个可用成员；临时出声者不在了 → 回到主持人。
//
// Python 伪代码：
//   voice = resolve_voice(snapshot, room)       # {'holderId': 'xiaoman', 'followerIds': ['lunara'], ...}
import { currentTrack, speakerOf } from './presenceState.js';
import { roomCurator } from '../virtual-person/roomCurator.js';

export function resolveVoice({ snapshot, room, isAvailable = () => true } = {}) {
  const roomMembers = Array.isArray(room?.memberIds) ? room.memberIds : [];
  const members = roomMembers.filter(id => isAvailable(id) === true);
  if (roomMembers.length <= 1 || !members.length) {
    const holderId = speakerOf(snapshot);
    return { holderId, hostId: holderId, delegated: false, followerIds: [] };
  }
  const hostId = roomCurator(room, isAvailable);
  const track = currentTrack(snapshot);
  const delegateId = track?.narration?.context?.reason === 'user_request' && members.includes(track.virtualPersonId)
    && track.virtualPersonId !== hostId ? track.virtualPersonId : null;
  const holderId = delegateId || hostId;
  return { holderId, hostId, delegated: Boolean(delegateId), followerIds: members.filter(id => id !== holderId) };
}

/** 跟话轮换：上一拍最后跟话的人排到最后，其余保持入群顺序。 */
export function rotateFollowers(followerIds, lastFollowerId) {
  const ids = [...followerIds];
  const index = ids.indexOf(lastFollowerId);
  if (index < 0) return ids;
  return [...ids.slice(0, index), ...ids.slice(index + 1), lastFollowerId];
}
