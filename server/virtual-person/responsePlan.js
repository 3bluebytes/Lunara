import { createHash } from 'node:crypto';

// 直达或降级路径没有语义判断；只匹配句首明确的集体行动，不用「歌」「首」猜意图。
const COLLECTIVE_MUSIC_REQUEST = /^(?:请|麻烦)?\s*(?:(?:你们(?:俩|两位)?|大家|两位|三位)\s*(?:一起|每[人位]|各自|各|一人|分别)?|一起|每[人位]|各自|各|一人|分别)\s*(?:都\s*)?(?:推(?:荐)?|选|挑|找|放|播|排|点)\s*(?:[一两二三几\d]+\s*首|歌(?:曲|单)?)/u;

function needsHostLastForMusic(text) {
  const request = text.replace(/^(?:\s*@\S+\s+)+/u, '').trim();
  return COLLECTIVE_MUSIC_REQUEST.test(request);
}

/** A bounded, deterministic speaker plan. Personas use the same AgentLoop and model. */
export function planResponses({ room, persons, userText, mentionedPersonIds = [] }) {
  const members = room.memberIds.map(id => persons.find(person => person.id === id && person.status !== 'archived')).filter(Boolean);
  const text = String(userText || '');
  const mentionOrder = person => {
    const indices = [text.indexOf(`@${person.displayName}`), text.indexOf(`@${person.id}`)].filter(index => index >= 0);
    if (indices.length) return Math.min(...indices);
    const explicitIndex = mentionedPersonIds.indexOf(person.id);
    return explicitIndex >= 0 ? 1e6 + explicitIndex : 2e6 + members.indexOf(person);
  };
  const mentions = members.filter(person => mentionedPersonIds.includes(person.id)
    || text.includes(`@${person.displayName}`) || text.includes(`@${person.id}`))
    .sort((a, b) => mentionOrder(a) - mentionOrder(b));
  const everyone = /每[个位人]|大家都|所有人|每位|各自|一人一/u.test(text);
  const host = members.find(person => person.id === room.activeVirtualPersonId) || members[0];
  if (!host) throw new Error('conversation has no available participants');
  let ordered;
  if (everyone) ordered = [...mentions, ...members.filter(person => !mentions.includes(person))];
  else if (mentions.length) ordered = mentions;
  else if (/你们|一起聊|都聊聊|补充/u.test(text)) ordered = [host, ...members.filter(person => person !== host).slice(0, 1)];
  else ordered = [host];
  // 只有明确要求多人选歌才把主持人放到最后；其余保留点名或自然出场顺序。
  if (ordered.length > 1 && ordered.includes(host) && needsHostLastForMusic(text)) {
    ordered = [...ordered.filter(person => person !== host), host];
  }
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
