import { resolveCompanionModePolicy } from '../playback/companionModes.js';
import { artistKeyOf } from '../songtags/songTagStore.js';
import { isMemoryRevoked } from '../memory/memoryProvenance.js';
import { memoryApplies } from '../memory/memoryPolicy.js';
import { mentionsIdentity } from './ProgramNarrationComposer.js';

// 表达偏好的内容兜底：机制上线前保存的纠正（如"介绍歌不用每次都提点我"）只带
// person-relationship 标签，按标签检索永远看不到。内容同时含纠正语气与表达方式
// 关键词的 user_explicit_feedback 记忆，同样按表达偏好对待。误捞的代价有界：
// 只影响串词语气与收尾，不会变成听歌偏好或点歌指令。
const CORRECTION_MARKER = /(?:不要|别|不用|不必|无需|少)/u;
const DELIVERY_KEYWORD = /(?:提点|叮嘱|照看|关照|提醒我|口癖|固定格式|套话|教我|安排我|指导我|教我怎么|告诉我怎么|介绍歌|介绍音乐|串词)/u;
const looksLikeExpressionCorrection = content => CORRECTION_MARKER.test(content) && DELIVERY_KEYWORD.test(content);

/**
 * 表达偏好：用户对"怎么说话/怎么介绍"的明确纠正（有原话依据、可撤回）。
 * 聊天经由既有关系记忆消费；串词在此单独取用，上限小而固定。
 */
export function retrieveExpressionPreferences(service, { namespace, sessionId, isGroup = false, limit = 5 } = {}) {
  if (!service?.store) return [];
  const applicable = row => !isMemoryRevoked(service.store, row) && memoryApplies(row, { sessionId, isGroup });
  const isExpression = row => String(row.tags || '').includes('expression-preference')
    || looksLikeExpressionCorrection(String(row.content || ''));
  const byNamespace = ns => service.searchMemory(undefined, { namespace: ns, type: 'semantic', limit: 100 })
    .filter(row => row.source === 'user_explicit_feedback' && isExpression(row) && applicable(row));
  const seen = new Set();
  const result = [];
  for (const row of [...byNamespace(namespace), ...byNamespace('station')]
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    result.push({ content: String(row.content || '').slice(0, 300) });
    if (result.length >= limit) break;
  }
  return result;
}

const SONG_MEMORY_LIMIT = 160;

/**
 * 关于这首歌/这位歌手的关系记忆：只取听众亲口说过（user_explicit_feedback / 人工种子）、
 * 未撤回、适用于当前聊天的；反思推断、口味图式和表达偏好不在此列。提到这首歌的排在
 * 只提到歌手的前面。串词只当素材用自己的话带出，不照念（quotes-memory 校验）。
 */
export function retrieveSongMemories(service, { namespace, sessionId, isGroup = false, track, limit = 3 } = {}) {
  if (!service?.store || !track) return [];
  // 提及按歌名/歌手的核心形式判断（“袁娅维TIA RAY”也认“袁娅维”），单字名不算提及。
  const mentions = value => content => String(value || '').trim().length >= 2 && mentionsIdentity(content, value);
  const mentionsTitle = mentions(track.title);
  const mentionsArtist = mentions(track.artist);
  const eligible = row => {
    const content = String(row.content || '');
    return ['user_explicit_feedback', 'manual_seed'].includes(row.source)
      && !String(row.tags || '').includes('expression-preference') && !looksLikeExpressionCorrection(content)
      && (mentionsTitle(content) || mentionsArtist(content))
      && !isMemoryRevoked(service.store, row) && memoryApplies(row, { sessionId, isGroup });
  };
  const byNamespace = ns => (ns ? service.searchMemory(undefined, { namespace: ns, type: 'semantic', limit: 100 }) : [])
    .filter(eligible);
  const seen = new Set();
  const rows = [...byNamespace(namespace), ...byNamespace('station')].filter(row => !seen.has(row.id) && seen.add(row.id));
  const rank = row => (mentionsTitle(String(row.content)) ? 1 : 0);
  return rows.sort((a, b) => rank(b) - rank(a) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, limit).map(row => String(row.content).slice(0, SONG_MEMORY_LIMIT));
}

// 收藏状态：true 已收藏、false 明确取消；读不到就是未知（null），不当作不喜欢。
function likeStatusOf(getTrackLikeService, track) {
  try {
    const like = getTrackLikeService()?.getLike?.(track.source, track.songId);
    return typeof like?.desired === 'boolean' ? like.desired : null;
  } catch { return null; }
}

const PUBLIC_NOTE_LIMIT = 200;

/**
 * 推荐事实：推荐人身份 + 推荐人在推荐那一轮公开说过的话。
 * 那一轮以串词人提交该曲目的回应（track.requestId）为锚，向前截到本轮用户发言；
 * 锚还没落库时只在该回应仍在运行时取当前轮尾部，否则宁可没有，不拿别的轮充数。
 */
function recommendationOf({ track, registry, conversationStore, room, sessionId, isGroup }) {
  const personId = String(track.recommendedBy || '').trim();
  if (!personId) return null;
  const recommender = registry.get(personId);
  if (!recommender) return null;
  const recommendation = { personId, displayName: recommender.displayName || personId, publicNote: null };
  if (!room?.memberIds?.includes(personId)) return recommendation;
  const turns = conversationStore.listTurns(sessionId, { limit: 20, visibleOnly: true, includeRequestId: track.requestId || null });
  let end = track.requestId ? turns.findIndex(turn => turn.requestId === track.requestId) : -1;
  if (end < 0) {
    const anchor = track.requestId && typeof conversationStore.getRequest === 'function'
      ? conversationStore.getRequest(track.requestId) : null;
    if (anchor?.state !== 'running') return recommendation;
    end = turns.length;
  }
  const notes = [];
  for (let index = end - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn.role === 'user') break;
    if (turn.speakerVirtualPersonId !== personId) continue;
    if (!conversationStore.canReadTurn(track.virtualPersonId || 'lunara', turn, { isGroup })) continue;
    notes.unshift(String(turn.message?.content || '').trim());
  }
  const note = notes.filter(Boolean).join(' ');
  recommendation.publicNote = note ? note.slice(0, PUBLIC_NOTE_LIMIT) : null;
  return recommendation;
}

/** 串词语境的装配：叙述者、可核实曲目事实、关于本曲的记忆与收藏、推荐事实、陪伴模式策略、生活场景线索、表达偏好与最近可见对话。 */
export function createNarrationContextProvider({ registry, conversationStore, getSongTagStore, getMemoryService = () => null, getTrackLikeService = () => null, getCompanionModeSnapshot = () => null, getLifeSnapshot = () => null }) {
  return effect => {
    const store = getSongTagStore();
    const song = store.getTags(effect.track.songId, effect.track.source);
    const artist = store.getArtistTags(song?.artist_key || artistKeyOf(effect.track.artist));
    const person = registry.get(effect.track.virtualPersonId);
    const room = conversationStore.getSession(effect.listeningSessionId);
    const isGroup = (room?.memberIds?.length || 0) > 1;
    const modeSnapshot = typeof getCompanionModeSnapshot === 'function'
      ? getCompanionModeSnapshot(effect.listeningSessionId) : null;
    // 串词只用已授权的场景标签/概括，不逐字念事项；拿不到或未授权就为空。
    let lifeScene = null;
    try {
      const audience = { sessionId: effect.listeningSessionId, listeningSessionId: effect.listeningSessionId,
        personId: person?.id, participants: room?.memberIds };
      const member = person?.id && !room?.archivedAt && room?.memberIds?.includes(person.id);
      const lifeSnapshot = member ? getLifeSnapshot(audience) : null;
      if (lifeSnapshot && Array.isArray(lifeSnapshot.entries)) {
        lifeScene = {
          plannedScene: lifeSnapshot.plannedScene || null,
          confirmedScene: lifeSnapshot.confirmedScene?.sceneTag || null,
          notes: lifeSnapshot.entries.map(item => item.sceneTag).filter(Boolean).slice(0, 3),
        };
      }
    } catch { lifeScene = null; }
    return {
      person,
      trackFacts: { song, artist },
      companionMode: modeSnapshot ? {
        modeId: effect.effectiveCompanionModeId ?? modeSnapshot.companionModeId ?? null,
        label: resolveCompanionModePolicy(effect.effectiveCompanionModeId)?.label
          || modeSnapshot.companionModeLabel || null,
        policy: effect.effectiveCompanionModeId ?? modeSnapshot.companionModeId ?? null,
      } : null,
      lifeScene,
      // 群里成员的显示名：只用来校验串词没把推荐归错人。
      memberNames: isGroup ? room.memberIds.map(id => registry.get(id)?.displayName).filter(Boolean) : [],
      recommendation: recommendationOf({ track: effect.track, registry, conversationStore, room,
        sessionId: effect.listeningSessionId, isGroup }),
      expressionPreferences: retrieveExpressionPreferences(getMemoryService(), {
        namespace: person?.memoryNamespace, sessionId: effect.listeningSessionId, isGroup }),
      songKnowledge: {
        memories: retrieveSongMemories(getMemoryService(), {
          namespace: person?.memoryNamespace, sessionId: effect.listeningSessionId, isGroup, track: effect.track }),
        liked: likeStatusOf(getTrackLikeService, effect.track),
      },
      recentConversation: conversationStore.listTurns(effect.listeningSessionId, { limit: 8, visibleOnly: true })
        .filter(turn => conversationStore.canReadTurn(effect.track.virtualPersonId || 'lunara', turn, { isGroup }))
        .map(turn => ({ role: turn.role, personId: turn.speakerVirtualPersonId, text: turn.message.content,
          presentation: turn.message.presentation || null, requestId: turn.requestId || null,
          createdAt: turn.createdAt ?? null })),
    };
  };
}

export default createNarrationContextProvider;
