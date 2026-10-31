/**
 * Presentation-only projection for the two independent conversation states:
 * the room the user is browsing and the listening session owned by runtime.
 */
export function deriveConversationPresentation({
  rooms = [],
  focusedRoom = null,
  persons = [],
  runtime = null,
} = {}) {
  const projectSession = session => {
    const queue = Array.isArray(session?.queue) ? session.queue : [];
    const currentIndex = Number.isInteger(session?.currentIndex) ? session.currentIndex : -1;
    // The queue cursor identifies an occurrence, while currentSongId identifies
    // only a song. The same song may appear more than once in one queue.
    const track = queue[currentIndex] || (session?.currentSongId != null
      ? queue.find(item => String(item?.song_id ?? item?.songId) === String(session.currentSongId)) || null
      : null);
    return Object.freeze({
      runtime: session,
      track,
      queueItems: Object.freeze(queue.map((item, index) => Object.freeze({
        item,
        index,
        state: index === currentIndex ? 'current' : index < currentIndex ? 'played' : 'upcoming',
      }))),
    });
  };
  const active = projectSession(runtime);
  const listeningSessionId = runtime?.activeListeningSessionId || null;
  const listeningRoom = rooms.find(room => room.sessionId === listeningSessionId) || null;
  const findPerson = id => persons.find(person => person.id === id) || null;
  const listeningPerson = findPerson(active.track?.virtualPersonId || runtime?.listeningPlan?.curatorId || listeningRoom?.activeVirtualPersonId);
  const focusedSessionId = focusedRoom?.sessionId || null;
  const focusedCheckpoint = focusedSessionId && runtime
    ? focusedSessionId === listeningSessionId
      ? runtime
      : runtime.suspendedSessions?.[focusedSessionId] || null
    : null;
  const focused = projectSession(focusedCheckpoint);
  const focusedListeningPerson = findPerson(focused.track?.virtualPersonId
    || focusedCheckpoint?.listeningPlan?.curatorId || focusedRoom?.activeVirtualPersonId);

  return Object.freeze({
    focusedRoom,
    focusedPerson: findPerson(focusedRoom?.activeVirtualPersonId),
    listeningSessionId,
    listeningRoom,
    listeningPerson,
    track: active.track,
    queueItems: active.queueItems,
    focusedListeningRuntime: focused.runtime,
    focusedListeningTrack: focused.track,
    focusedQueueItems: focused.queueItems,
    focusedListeningPerson,
    focusedHasCheckpoint: Boolean(focusedCheckpoint),
    sourceMismatch: Boolean(focusedRoom && listeningSessionId && focusedRoom.sessionId !== listeningSessionId),
    runtime,
  });
}

/** Resolve only the delivered chat introduction for this exact queue occurrence. */
export function deriveCurrentTrackIntroduction(track, turns = []) {
  const queueItemId = String(track?.queueItemId || '').trim();
  if (!queueItemId) return null;
  const expectedTurnId = `intro:${queueItemId}`;
  const match = [...(Array.isArray(turns) ? turns : [])].reverse().find(turn => {
    if (turn?.role !== 'assistant') return false;
    const presentation = turn.presentation || turn.message?.presentation;
    if (presentation !== 'track_intro' && turn.turnId !== expectedTurnId) return false;
    const turnQueueItemId = String(turn.queueItemId || turn.message?.queueItemId
      || turn.tracks?.find(item => item?.queueItemId)?.queueItemId || '').trim();
    return turnQueueItemId ? turnQueueItemId === queueItemId : turn.turnId === expectedTurnId;
  });
  const text = String(match?.text ?? match?.visibleText ?? match?.message?.content ?? '').trim();
  if (!match || !text) return null;
  return Object.freeze({
    queueItemId,
    text,
    turnId: match.turnId || null,
    speakerVirtualPersonId: match.speakerVirtualPersonId || null,
  });
}

/**
 * 侧栏会话分组的纯投影：置顶组在最前，其余单人房间按主持名分组，两人及以上的会话归入群聊。
 * 人数按成员列表直接计数（Lunara 也算一个人）：成员数 ≥2 即群聊；
 * 单人房间用唯一成员的显示名作为组名（空成员回退 Lunara）。
 */
export function deriveConversationGroups({ rooms = [], persons = [], rootPersonId = 'lunara' } = {}) {
  const recency = room => Number(room?.lastTurnAt || room?.createdAt || 0);
  const personName = id => persons.find(person => person.id === id)?.displayName || String(id || '');
  const pinned = [];
  const groupChats = [];
  const hostRooms = new Map();
  for (const room of rooms) {
    const members = room?.memberIds || [];
    if (room?.pinnedAt) pinned.push(room);
    else if (members.length >= 2) groupChats.push(room);
    else {
      const key = members[0] || rootPersonId;
      if (!hostRooms.has(key)) hostRooms.set(key, []);
      hostRooms.get(key).push(room);
    }
  }
  const byRecency = (a, b) => recency(b) - recency(a);
  const sections = [];
  if (pinned.length) sections.push({ key: 'pinned', label: '置顶', kind: 'pinned', rooms: [...pinned].sort(byRecency) });
  for (const [key, list] of [...hostRooms.entries()].sort((a, b) => Math.max(...b[1].map(recency)) - Math.max(...a[1].map(recency)))) {
    sections.push({ key: `host:${key}`, label: personName(key), kind: 'host', rooms: list.sort(byRecency) });
  }
  if (groupChats.length) sections.push({ key: 'group-chat', label: '群聊', kind: 'group', rooms: groupChats.sort(byRecency) });
  return sections;
}
