import { createHash } from 'node:crypto';

/** A bounded, deterministic speaker plan. Personas use the same AgentLoop and model. */
export function planResponses({ room, persons, userText, mentionedPersonIds = [] }) {
  const members = room.memberIds.map(id => persons.find(person => person.id === id && person.status !== 'archived')).filter(Boolean);
  const text = String(userText || '');
  const mentions = members.filter(person => mentionedPersonIds.includes(person.id)
    || text.includes(`@${person.displayName}`) || text.includes(`@${person.id}`));
  const everyone = /每[个位人]|大家都|所有人|每位|各自|一人一/u.test(text);
  const host = members.find(person => person.id === room.activeVirtualPersonId) || members[0];
  if (!host) throw new Error('conversation has no available participants');
  let ordered;
  if (everyone) ordered = [...mentions, ...members.filter(person => !mentions.includes(person))];
  else if (mentions.length) ordered = mentions;
  else if (/你们|一起聊|都聊聊|补充/u.test(text)) ordered = [host, ...members.filter(person => person !== host).slice(0, 1)];
  else ordered = [host];
  // 主持人在多人计划里就排最后：先听完别人说的/推的，再由主持人收歌提交（本轮音乐负责人是计划最后一位）。
  // 只点名非主持人时计划里没有主持人，不追加。
  if (ordered.length > 1 && ordered.includes(host)) ordered = [...ordered.filter(person => person !== host), host];
  return ordered.map(person => person.id);
}

export function responseRequestId(roundId, personId, index) {
  return index === 0 ? roundId : `response:${createHash('sha256').update(`${roundId}\0${personId}`).digest('hex').slice(0, 40)}`;
}

/** 群聊追加的被邀请回应：确定性身份，不占用初始计划的序号。 */
export function floorRequestPrefix(roundId) {
  return `floor:${roundId}:`;
}

export function floorRequestId(roundId, personId) {
  return `${floorRequestPrefix(roundId)}${personId}`;
}

export function isFloorRequestId(requestId) {
  return String(requestId || '').startsWith('floor:');
}
