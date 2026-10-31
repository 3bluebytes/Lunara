import { createToolOutcome } from './VirtualPersonTypes.js';
import { MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY, MUSIC_SELECTION_PARAMETERS, TAG_FILTER_PROPERTIES } from '../program/musicSelectionRequest.js';
import { matchesTags, hasAnyTagFilter } from '../songtags/songTagRetrieval.js';
import { cleanTrack } from '../program/MusicSelectionService.js';
import * as libraryTools from '../tools/musicTools.js';
import * as songTagTools from '../tools/songTagTools.js';
import { normalizeToolOutcome } from '../tools/ToolOutcome.js';
import { providerRegistry } from '../music/providerRegistry.js';
import { sanitizeFacts, sanitizeExternalText } from './toolFacts.js';
import { policyFromUserText } from '../memory/memoryPolicy.js';
import { parseEvidence } from '../memory/memoryPolicy.js';
import { isMemoryRevoked } from '../memory/memoryProvenance.js';
import { createHash } from 'node:crypto';
import { saveFamiliarArtistFeedback } from '../program/familiarArtistCadence.js';
import { OFFER_MAX_CANDIDATES } from '../program/musicSelectionOffers.js';

const object = properties => ({ type: 'object', additionalProperties: false, properties });
// `message` is the internal status handed to the model. `userMessage` is the reviewed
// listener-safe line. A handler that only writes `message` opts out of every visible
// channel, so operation copy can never be dumped on the listener verbatim.
const fail = message => ({ ok: false, code: 'MUSIC_ACTION_UNAVAILABLE', message, userMessage: message });

// 客户端随消息带来的「用户当时在听哪一首」，只在指向本聊天时才算数。
function heardOccurrence(context) {
  const identity = context.clientState?.playbackIdentity;
  if (!identity || identity.listeningSessionId !== context.sessionId) return null;
  return typeof identity.queueItemId === 'string' && identity.queueItemId ? identity.queueItemId : null;
}

// Reviewed product fallback per failure code. Used only when the turn's model round
// failed, and only for what the handler did not describe itself.
const USER_FACING_FALLBACK = {
  ALBUM_UNAVAILABLE: '这张专辑现在读不到，队列没有变化。',
  INVALID_MUSIC_REQUEST: '这次没听清要放什么，队列没有变化。',
  SELECTION_OFFER_UNAVAILABLE: '刚才那组候选已经不能用了，需要重新选一次。',
  INVALID_SELECTION_INDEXES: '这次没有对上是哪几首，队列没有变化。',
  SELECTION_INDEXES_UNPLAYABLE: '有几首现在放不了，队列没有变化。',
  MUSIC_NOT_COMMITTED: '这次没能把歌排上去，队列和播放状态都没有变化。',
  MUSIC_ACTION_IN_PROGRESS: '这一轮我已经在选歌了，没有重复提交。',
  MUSIC_ACTION_UNCONFIRMED: '上一次播放操作没有确认完成，队列可能没有变化。',
  MUSIC_OWNER_REQUIRED: '这一轮的音乐由负责提交的角色决定，我没有重复操作。',
  MEMORY_WRITE_FAILED: '这条反馈还没有保存成功。',
};
const DEFAULT_USER_FALLBACK = '这次没有完成，队列和播放状态都没有变化。';
const MUTATING_MUSIC_TOOLS = new Set(['select_music', 'commit_music_selection', 'record_music_feedback',
  'control_listening', 'narrate_current_track', 'edit_listening_queue', 'set_familiar_artist_cadence']);
// 候选 offer 的两步指引：候选不是已播放，选序号后才提交，交付方式保持原样。
const OFFER_MODEL_CONTEXT = `先读 facts.brief（选歌简报）再挑序号：它按优先级列出本轮要求、用户显式反馈、口味画像、伙伴自己的审美、推断信号与近期收听。
每首候选的 features 是可解释特征：tags 为 null 表示还没有标注，未标注不等于不符合；tasteMatches 是命中的口味信号（+ 正向、- 负向，都是推断）；probe 为 true 表示这是一首试探歌曲。
特征和简报只帮你挑选，不放宽任何硬条件，候选提交时仍会逐项复核。
下一步：从上面的 candidates 里选择要放的歌曲序号（index，1 起始），调用 commit_music_selection，参数为 { offerId, indexes }，一次最多 10 个序号、不可重复。
候选只是候选，不代表已经播放，也不代表用户听过；不要编造 candidates 之外的歌曲、歌手、歌单或 songId。
交付方式（是否播放、replace_now/append/recommend_only）由本轮 select_music 的请求锁定，commit_music_selection 不能改写；recommend_only 提交后仍然不会播放。
候选不合适时宁可少选几首，也不要选明显不符的候选或改口说已经安排。
要播放时，提交后这一轮就结束：把要对用户说的一两句话写在调用 commit_music_selection 的同一条消息里，只提你选中的歌。`;
// 简报正文上限：第 1–3 部分不截断，可能略超 MUSIC_BRIEF_MAX_CHARS，这里只防失控。
const BRIEF_FACT_MAX_CHARS = 16_000;
const OFFER_FACT_LIMITS = { maxDepth: 6, maxItems: Math.max(20, OFFER_MAX_CANDIDATES) };
const NON_OWNER_OFFER_NOTE = '这一轮的音乐由别的成员负责：你调用 commit_music_selection 只会把选中的歌登记为你的推荐，不会播放，提交后你还要自己说一两句推荐了哪首、为什么。只在正文里提到的歌不算推荐。';

function hasFreshUserInput(value) {
  return /[\p{L}\p{N}]/u.test(String(value || ''));
}

function toolOutcome(result) {
  const ok = result?.ok !== false;
  const code = result?.code || (ok ? 'MUSIC_RESULT' : 'MUSIC_UNAVAILABLE');
  const terminal = ok && result?.terminal === true;
  // 工具可以显式给出 facts（如候选 offer 的序号窗口）；否则按旧口径从结果字段里取。
  const rawFacts = result?.facts && typeof result.facts === 'object' ? result.facts : null;
  // 候选 offer 的事实结构已知且有界（窗口、特征）：放宽深度与条数，其余工具保持默认上限。
  const facts = sanitizeFacts(rawFacts
    || Object.fromEntries(Object.entries(result || {}).filter(([key]) => !['message', 'userMessage', 'context', 'candidates', 'error', 'terminal', 'facts', 'modelContext', 'offer', 'brief'].includes(key))),
  0, rawFacts?.offerId ? OFFER_FACT_LIMITS : undefined);
  // 简报是长文本，单独按自己的上限清洗；它已经在 facts 里，不再重复写进「运行结果」那一行。
  if (typeof rawFacts?.brief === 'string') facts.brief = sanitizeExternalText(rawFacts.brief, BRIEF_FACT_MAX_CHARS);
  const status = sanitizeExternalText(result?.message || '');
  const reviewed = sanitizeExternalText(result?.userMessage || '');
  // Only a terminal outcome may end the turn with a line, and only a reviewed one.
  // Terminal outcomes are declared through the visible line, never through raw status.
  const displayText = terminal ? reviewed : ok ? '' : reviewed || USER_FACING_FALLBACK[code] || DEFAULT_USER_FALLBACK;
  const modelContext = [
    `运行结果（内部状态，不是给用户的原话，不要原样复述）：${JSON.stringify({ ...facts, brief: undefined })}`,
    status,
    sanitizeExternalText(result?.modelContext || ''),
    code === 'MUSIC_NOT_COMMITTED' && result?.offerId && result?.failedItems?.length
      // 能放的会直接提交（部分成功不走这里）；走到这里说明选中的都放不了。
      ? '选中的序号都没能解析出可播放版本（见 failedItems），队列没有变化。可以在同一 offerId 的候选内换别的序号再提交一次（resolvedIndexes 中如有成功项一并保留）；每项已在同一次提交内重试过，不要原样重复同样的参数。保持原请求的交付方式和硬约束。'
      : '',
    code === 'MUSIC_COMMITTED' ? '已提交表示歌曲已安排，实际出声还需等待串词和媒体确认；可以说已选好或已安排，不要仅凭提交就宣称已经响起。' : '',
  ].filter(Boolean).join('\n');
  // 播放提交后不再调模型：发起提交的同一条消息里写好的话，只提到这些已提交的歌时才能直接给用户看。
  // 请求数量没凑齐时只用固定文案，避免模型提前说的歌单和实际不一致。
  const titles = terminal && code === 'MUSIC_COMMITTED' && !(Number(result?.selectedCount) < Number(result?.requestedCount))
    ? (Array.isArray(result?.tracks) ? result.tracks : []).map(track => String(track?.title || '').replace(/[《》]/gu, '').trim()).filter(Boolean)
    : [];
  const cleanTitle = title => String(title || '').replace(/[《》]/gu, '').trim();
  const othersTitles = titles.length && Array.isArray(result?.recommendedTitles)
    ? result.recommendedTitles.map(cleanTitle).filter(title => titles.includes(title)) : [];
  const modelLine = titles.length ? { allowedTitles: titles, ...(othersTitles.length ? { othersTitles } : {}) } : null;
  return createToolOutcome({ kind: ok ? 'success' : 'business_failure', code, terminal,
    facts, modelContext, presentation: { displayText, speak: false, ...(modelLine ? { modelLine } : {}) } });
}

// 纯查询工具：不改队列、偏好或账号数据，跨轮重新执行以反映当前状态。
const READ_ONLY_MUSIC_TOOLS = new Set(['get_user_playlists', 'get_playlist_tracks', 'search_library', 'search_music', 'get_listening_state']);

export function registerMusicTools(registry, getService) {
  const register = (name, description, parameters, handler, capability = MUSIC_CAPABILITY) => registry.register(name, {
    capability, definition: { description, parameters }, readOnly: READ_ONLY_MUSIC_TOOLS.has(name),
    // 只有这两个字段已确认 null 与「未指定」同义；不处理版本/硬约束或任何其它工具。
    ...(name === 'select_music' ? { optionalNullObjectFields: ['playlist', 'reference'] } : {}),
    handler: async (args, context) => {
      if (MUTATING_MUSIC_TOOLS.has(name) && Object.hasOwn(context, 'userText')
        && !hasFreshUserInput(context.userText)) {
        return createToolOutcome({ kind: 'business_failure', code: 'NO_FRESH_MUSIC_REQUEST',
          modelContext: '本轮用户没有提出新的音乐操作。不要重放上一轮的选歌、播放或反馈动作。',
          presentation: { displayText: '我看到了你的追问。要我重新换一首，请明确说“再换一首”；这轮我没有改动队列。', speak: false } });
      }
      const service = getService();
      if (!service) return toolOutcome(fail('音乐服务还没准备好。'));
      return toolOutcome(await handler(service, args, context));
    },
  });
  register('set_familiar_artist_cadence', '仅在用户明确反馈推荐歌手熟悉度频率时调用。希望熟悉歌手占多数、陌生歌手偶尔穿插用 familiar_first；明确撤销该安排用 clear。sourceQuote 必须是本轮用户原话的连续片段。仅反馈时调用本工具即可；若同时要求换歌或推荐，还要调用 select_music。本工具不改队列，且应先于选歌执行。', {
    type: 'object', additionalProperties: false, required: ['mode', 'sourceQuote'], properties: {
      mode: { type: 'string', enum: ['familiar_first', 'clear'] },
      sourceQuote: { type: 'string', minLength: 2, maxLength: 1000 },
    },
  }, (service, args, context) => {
    const quote = String(args.sourceQuote || '').trim();
    if (!quote || !String(context.userText || '').includes(quote) || !context.userTurnId
      || !context.virtualPersonId || !service.conversationStore?.db) {
      return { ok: false, code: 'FAMILIAR_ARTIST_SOURCE_REQUIRED',
        message: '缺少本轮用户原话或写入身份，不能更改熟悉歌手频率。',
        userMessage: '这条频率偏好还没有保存成功。' };
    }
    if (context.groupAction && context.groupAction.ownerId !== context.virtualPersonId) {
      return { ok: false, code: 'MUSIC_OWNER_REQUIRED',
        message: '本轮音乐偏好只能由负责音乐的角色记录。', userMessage: '这条频率偏好还没有保存成功。' };
    }
    // The registry checks this on entry; check again at the actual write boundary.
    if (context.signal?.aborted || (context.isCurrent && !context.isCurrent())) {
      return { ok: false, code: 'STALE_MUSIC_TURN',
        message: '本轮已经取消或角色成员已变化，频率偏好未写入。', userMessage: '这条频率偏好还没有保存成功。' };
    }
    const saved = saveFamiliarArtistFeedback(service.conversationStore.db, {
      personId: context.virtualPersonId, sourceTurnId: context.userTurnId,
      userText: context.userText, mode: args.mode,
    });
    if (!saved) return { ok: false, code: 'FAMILIAR_ARTIST_FEEDBACK_INVALID',
      message: '频率偏好参数无效，未写入。', userMessage: '这条频率偏好还没有保存成功。' };
    if (!saved.replayed) service.pool?.invalidate();
    return { ok: true, code: saved.mode === 'clear' ? 'FAMILIAR_ARTIST_CADENCE_CLEARED' : 'FAMILIAR_ARTIST_CADENCE_SAVED',
      terminal: context.toolCallCount === 1, replayed: saved.replayed === true,
      message: '频率偏好已按本轮用户原话保存。', userMessage: saved.displayText };
  }, MUSIC_MUTATION_CAPABILITY);
  register('select_music', '按结构化条件选歌或点播。先在对话中理解指代，再提供准确目标/selectionId 与 1 起始序号。用户明确说不想听某位歌手时用 constraints.excludedArtists，不能写成必选 artist；只有用户明确提出的条件才能写入硬标签 constraints.tags，气氛猜测放 softPreferences。推荐不播放用 recommend_only。保留当前条件的纠正必须把完整条件一并传入。用户要听整张专辑时用 mode=album 加 album.source/albumId（不要拆成 targets 逐个点歌，也不要靠歌名猜专辑）；专辑内的歌按专辑顺序一批一批往后取。群聊每人推荐时前面的角色仅提案（开放式选歌也要用 commit_music_selection 登记，只在正文提到的歌不算），最后的负责人统一提交。非点播条件只返回候选（不会直接播放）：拿到候选后必须选序号并调用 commit_music_selection 提交。点播（exact）要播放时直接提交，提交后这一轮就结束、不会再让你说话：要对用户说的话写在调用本工具的同一条消息里（只提点到的歌，说已安排，不说已经在放）。',
    MUSIC_SELECTION_PARAMETERS, async (service, args, context) => {
      // 「刚推荐过的歌」的短引用 r1 → 那条 ambient 推荐的真实 selection（不改写续播计划，推荐人另记）。
      const ref = context.recommendationRef;
      const accepting = ref && args?.reference?.selectionId === ref.ref;
      const result = accepting
        ? await service.execute({ ...args, reference: { ...args.reference, selectionId: ref.selectionId } },
          { ...context, acceptingRecommendation: { turnId: ref.turnId, selectionId: ref.selectionId, recommendedBy: ref.recommendedBy } })
        : await service.execute(args, context);
      if (accepting && result?.ok === true && result.code === 'MUSIC_COMMITTED') {
        try { ref.markQueued(); } catch { /* 推荐状态只是展示；入队事实以 runtime 为准 */ }
      }
      if (result?.ok === true && result.code === 'MUSIC_CANDIDATES_OFFERED') {
        // 候选事实只暴露 offer 身份与有界序号窗口；候选本身不是已播放，也不是已提交。
        // 群聊非负责人：同样选序号提交，但提交只是登记推荐，由本轮负责人决定是否播放。
        const nonOwner = Boolean(context.groupAction && context.groupAction.ownerId !== context.virtualPersonId);
        return { ...result, modelContext: nonOwner ? `${OFFER_MODEL_CONTEXT}\n${NON_OWNER_OFFER_NOTE}` : OFFER_MODEL_CONTEXT,
          facts: { offerId: result.offerId, mode: result.request?.mode || null, delivery: result.request?.delivery || null,
            requestedCount: result.request?.count ?? null, candidateCount: result.offer?.candidates?.length ?? 0,
            ...(result.brief ? { brief: result.brief } : {}),
            candidates: (result.offer?.candidates || []).map((candidate, position) => ({ index: candidate.index, songId: candidate.songId,
              title: candidate.title, artist: candidate.artist, album: candidate.album, source: candidate.source,
              duration: candidate.duration,
              ...(Array.isArray(result.offer?.features) ? { features: result.offer.features[position] ?? null } : {}) })) } };
      }
      return result;
    });
  register('commit_music_selection', '提交你在 select_music 候选里选中的歌曲。群聊里你不是本轮音乐负责人时，提交只登记为你的推荐、不会播放。提交播放后这一轮就结束，不会再让你说话：要对用户说的话请写在调用本工具的同一条消息里（只提你选中的歌，说已安排，不说已经在放）。必须原样使用 select_music 返回的 offerId，indexes 是候选的 1 起始序号（最多 10 个、不可重复）。交付方式、数量与硬约束由那一次 select_music 的请求锁定，这里不能改写；提交失败时不要换成候选以外的歌；返回 SELECTION_INDEXES_UNPLAYABLE 时，避开 knownUnplayableIndexes 里列出的全部序号，从同一组候选的其余序号里选（或少交几首）再提交。只推荐不播放的请求提交后仍然不会播放。',
    {
      type: 'object', additionalProperties: false, required: ['offerId', 'indexes'],
      properties: {
        offerId: { type: 'string', minLength: 1, maxLength: 200 },
        indexes: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'integer', minimum: 1 } },
        delivery: { type: 'string', enum: ['replace_now', 'after_current', 'append', 'recommend_only'] },
      },
    // 只有 music 能力即可见：群聊非负责人的提交由服务登记为推荐（add-peer-message-protocol D5），
    // 播放与否只由负责人决定；单聊里每个角色本来就是负责人。
    }, (service, args, context) => {
      // 兜底：没有提交权、又不是群聊里登记推荐的非负责人，一律拒绝。
      const canCommit = !Array.isArray(context.capabilities) || context.capabilities.includes(MUSIC_MUTATION_CAPABILITY);
      const registersRecommendation = Boolean(context.groupAction && context.groupAction.ownerId !== context.virtualPersonId);
      if (!canCommit && !registersRecommendation) {
        return { ok: false, code: 'MUSIC_OWNER_REQUIRED', message: '本轮音乐由负责提交的角色决定，这里不重复提交。',
          userMessage: '这一轮的音乐由负责提交的角色决定，我没有重复操作。' };
      }
      return service.commitSelection(args, context);
    });
  register('get_user_playlists', '查看用户各音乐源的歌单与稳定 ID。', object({
    source: { type: 'string', enum: ['all', ...providerRegistry.defaultSourceCandidates()] }, limit: { type: 'integer', minimum: 1, maximum: 50 },
  }), async (service, args) => {
    const result = normalizeToolOutcome(await (service.getUserPlaylists || libraryTools.getUserPlaylists)(args));
    return { ok: result.ok, ...result.data, message: result.ok ? '' : '读取歌单失败。',
      userMessage: result.ok ? '' : '没有读取到歌单，请检查音乐源登录。' };
  });
  register('get_playlist_tracks', '按音乐源和歌单 ID 读取曲目及稳定歌曲 ID，支持分页。', object({
    source: { type: 'string', enum: providerRegistry.defaultSourceCandidates() }, playlistId: { type: 'string' },
    offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 },
  }), async (service, args) => {
    const result = normalizeToolOutcome(await service.getPlaylistTracks(args));
    return { ok: result.ok, ...result.data, message: result.ok ? '' : '读取歌单曲目失败。',
      userMessage: result.ok ? '' : '没有读取到这张歌单。' };
  });
  register('search_library', '在已导入曲库和在线候选中按标题/艺人 query 与已验证标签 tags 查找。未知标签不会当作符合条件；候选仍须提交时验证可播放。', object({
    query: { type: 'string' }, tags: object(TAG_FILTER_PROPERTIES),
  }), async (service, args) => {
    const source = await service.getCandidates();
    const query = String(args.query || '').trim().toLowerCase();
    const rows = source.map(cleanTrack).filter(track => (!query || `${track.title} ${track.artist}`.toLowerCase().includes(query))
      && (!hasAnyTagFilter(args.tags) || matchesTags({ ...track, song_id: track.songId }, args.tags, service.getSongTagStore())));
    return { ok: true, tracks: rows.slice(0, 20), total: rows.length };
  });
  register('search_music', '查找一首歌的可播放版本，返回已核实的歌曲资料，不播放。', object({ query: { type: 'string' } }),
    async (service, args) => {
      if (!String(args.query || '').trim()) return fail('请提供艺人或歌名。');
      const result = await service.programCommitService.resolveTrack(args.query);
      return { ok: result.ok === true, tracks: result.ok ? [cleanTrack(result)] : [],
        message: result.ok ? '' : '解析可播放版本失败。', userMessage: result.ok ? '' : '没有找到可播放版本。' };
    });
  register('get_listening_state', '查看本聊天的独立播放队列、当前歌曲、进度和续播条件；没有其他聊天的私人列表。', object({}),
    (service, _args, context) => ({ ok: true, listening: service.playbackRuntime.listeningSnapshot(context.sessionId) }));
  register('record_music_feedback', '仅记录用户对某首具体歌曲的明确喜欢/不喜欢；对歌手整体作品的评价应使用关系记忆，不要误记成当前歌曲的反馈。必须提供本轮原话依据，不能根据技术失败、暂停或切聊天推断。', object({
    songId: { type: 'string' }, sentiment: { type: 'string', enum: ['like', 'dislike', 'neutral'] }, sourceQuote: { type: 'string' },
  }), (service, args, context) => {
    const quote = String(args.sourceQuote || '').trim();
    if (!quote || !context.userText.includes(quote) || !['like', 'dislike', 'neutral'].includes(args.sentiment)) {
      return fail('缺少本轮用户原话依据，不能记录反馈。', '这条反馈我没有记下来。');
    }
    const listening = service.playbackRuntime.listeningSnapshot(context.sessionId);
    const track = listening.queue.find(item => item.songId === (args.songId || listening.currentSongId));
    if (!track) return fail('本聊天没有这首歌的明确记录。', '这个聊天里没有这首歌的明确记录。');
    const policy = policyFromUserText(context.userText, context.sessionId);
    const person = service.registry.get(context.virtualPersonId);
    const memory = service.getMemoryService();
    if (!memory?.store || !person) return fail('记忆暂时不可用。');
    const writeKey = createHash('sha256').update(`${context.userTurnId}:${person.id}:${track.songId}:${args.sentiment}:${quote}`).digest('hex');
    if (isMemoryRevoked(memory.store, { namespace: person.memoryNamespace, evidence: { writeKey, sourceTurnId: context.userTurnId } })) return fail('这条反馈来源已被撤回。');
    const existing = memory.searchMemory(undefined, { namespace: person.memoryNamespace, limit: 500 }).find(row => parseEvidence(row).writeKey === writeKey);
    if (existing) return { ok: true, code: 'MUSIC_FEEDBACK_RECORDED', memoryId: existing.id, replayed: true };
    const labels = { like: '喜欢', dislike: '不喜欢', neutral: '没有表达喜欢或讨厌' };
    const saved = memory.addMemory({ namespace: person.memoryNamespace,
      type: policy.until ? 'working' : 'semantic', source: 'user_explicit_feedback', importance: 7, confidence: 0.7,
      content: `用户与我一起听歌时，对 ${track.artist}《${track.title}》的反馈：${labels[args.sentiment]}。原话：${quote}`,
      tags: ['person-relationship', 'music-feedback', `song:${track.songId}`], expiresAt: policy.until,
      evidence: JSON.stringify({ writeKey, sourceTurnId: context.userTurnId, originSessionId: context.sessionId, ownerId: person.id,
        songId: track.songId, source: track.source, sentiment: args.sentiment, quote, policy }),
    });
    if (saved?.ok) service.pool?.invalidate();
    return { ok: saved?.ok === true, code: saved?.ok ? 'MUSIC_FEEDBACK_RECORDED' : 'MEMORY_WRITE_FAILED',
      memoryId: saved?.id, message: saved?.ok ? '这条反馈已经记入我与你的听歌经历。' : '反馈还没有保存成功。' };
  });
  register('control_listening', '控制本聊天的音乐。用户只浏览聊天不会切歌；要求与你一起听本聊天已有队列时用 listen，立即切换音乐来源。说继续、恢复播放时用 resume；已播完或续播失败且允许自动续播时 resume/retry 都会继续选歌；队列放完且不允许自动续播时回复会如实收尾。只有明确要求等当前歌曲结束时才用 after_current。', object({
    action: { type: 'string', enum: ['listen', 'after_current', 'cancel_switch', 'pause', 'resume', 'next', 'retry'] },
  }), async (service, args, context) => service.mutate(context, async markCommitAttempt => {
    const state = service.playbackRuntime.snapshot();
    const actions = { listen: 'LISTENING_SESSION_SWITCH_REQUESTED', after_current: 'LISTENING_SESSION_SWITCH_REQUESTED',
      cancel_switch: 'LISTENING_SWITCH_CANCELLED', pause: 'PAUSE_REQUESTED', resume: 'RESUME_REQUESTED', next: 'NEXT_REQUESTED', retry: 'RETRY_REQUESTED' };
    if (!actions[args.action]) return fail('不支持这项播放操作。');
    // 暂停/跳过针对的是用户发这句话时在听的那一首。模型思考期间换了歌，
    // 就把新歌告诉模型去确认，不替用户对后来的歌动手。
    const heard = ['pause', 'next'].includes(args.action) ? heardOccurrence(context) : null;
    if (heard) {
      const current = state.activeListeningSessionId === context.sessionId
        ? state.queue?.[state.currentIndex] || null : null;
      const currentId = state.txn?.queueItemId || current?.queueItemId || null;
      if (currentId !== heard) {
        const verb = args.action === 'pause' ? '暂停' : '跳过';
        const name = current ? `${current.artist ? `${current.artist} 的` : ''}《${current.title || current.songId}》` : '';
        return { ok: false, code: 'LISTENING_TARGET_CHANGED',
          message: current
            ? `用户说这句话时在听的那首已经不在播了，现在在播的是${name}。不要直接${verb}它，先问用户这一首是否也要${verb}。`
            : '用户说这句话时在听的那首已经不在播了。不要再执行这项操作，如实告诉用户。',
          userMessage: current ? `刚才那首已经不在播了，现在这首${name}也要${verb}吗？` : '刚才那首已经不在播了。' };
      }
    }
    markCommitAttempt();
    const result = await service.playbackRuntime.submit({ type: actions[args.action],
      eventId: `control:${context.requestId}:${args.action}`, listeningSessionId: context.sessionId,
      signal: context.signal, guard: context.isCurrent,
      delivery: args.action === 'after_current' ? 'after_current' : 'now',
      runtimeVersion: state.version, outputGeneration: state.outputGeneration,
      ...(state.activeListeningSessionId === context.sessionId ? { songId: state.currentSongId } : {}),
      ...(heard ? { queueItemId: heard } : {}),
    });
    const listening = service.playbackRuntime.listeningSnapshot(context.sessionId);
    // 可见回复只陈述 runtime 实际接受的结果：已激活下一首、已请求续选、
    // 或诚实收尾（队列放完且没有续选），不接受但无歌可播时不得宣称切歌或续播。
    const continuationRequested = listening.pendingContinuation?.status === 'requested';
    const exhaustedWithoutContinuation = listening.phase === 'exhausted' && !continuationRequested;
    const finishedCopy = '好，队列到这里放完了，想继续我再来选。';
    const messages = {
      listen: exhaustedWithoutContinuation ? finishedCopy
        : listening.phase === 'exhausted' ? '好，我接着为这个聊天续上音乐。' : '好，回到这个聊天一起听。',
      after_current: '好，这首结束后切到这个聊天。',
      cancel_switch: '好，已经取消稍后的切换。',
      pause: '好，先暂停。',
      resume: exhaustedWithoutContinuation ? finishedCopy
        : listening.phase === 'exhausted' ? '好，我接着续上音乐。' : '好，继续播放。',
      next: exhaustedWithoutContinuation ? finishedCopy
        : continuationRequested ? '好，这首跳过，我接着选几首新的。' : '好，换到下一首。',
      retry: exhaustedWithoutContinuation ? finishedCopy : '好，我再试一次续播。',
    };
    return { ok: result.accepted, code: result.accepted ? 'LISTENING_CONTROLLED' : 'LISTENING_STATE_CHANGED', terminal: result.accepted,
      listening,
      message: result.accepted ? `播放操作已提交：${args.action}。` : '播放操作被拒绝：本聊天当前没有在播放，或播放状态刚刚变化。',
      userMessage: result.accepted ? messages[args.action] : '本聊天现在没有在播放，或者播放状态刚刚变了。' };
  }), MUSIC_MUTATION_CAPABILITY);
  register('narrate_current_track', '让本聊天正在播的这一首的串词现在说出来。只对真正在播的那一首有效；用户想再听一遍同一首的开场介绍时也用它。不要用它去讲已经不在播的歌，也不要自己复述串词内容。', object({
    queueItemId: { type: 'string' },
  }), async (service, args, context) => {
    const scoped = service.playbackRuntime.listeningSnapshot(context.sessionId);
    const index = Number.isInteger(scoped.currentIndex) ? scoped.currentIndex : -1;
    const current = index >= 0 ? scoped.queue[index] : null;
    if (!current) return fail('这个聊天现在没有在播的歌。');
    if (scoped.activeListeningSessionId !== context.sessionId) return fail('这个聊天现在不是正在收听的那个，切过去之后我再讲。');
    if (args.queueItemId && String(args.queueItemId) !== current.queueItemId) return fail('这一首现在没在播；等它播的时候我会讲。');
    if (scoped.phase !== 'playing') return fail('这首歌还没有真正开始播放，先让它响起来。');
    const result = await service.playbackRuntime.submit({
      type: 'NARRATION_REQUESTED',
      eventId: `narration-request:${context.requestId}:${current.queueItemId}`,
      queueItemId: current.queueItemId,
      songId: current.songId,
      programId: current.programId,
      correlationId: scoped.txn?.correlationId || null,
      listeningSessionId: context.sessionId,
      outputGeneration: scoped.outputGeneration,
      runtimeVersion: scoped.runtimeVersion,
      signal: context.signal,
      guard: context.isCurrent,
    });
    if (!result.accepted) return fail('播放状态刚刚变了，等一下再说。');
    return { ok: true, code: 'NARRATION_REQUESTED', terminal: true, narrating: true,
      queueItemId: current.queueItemId, title: current.title, artist: current.artist,
      message: '串词请求已提交，会在媒体确认后播出；确认之前不要说已经讲过了。',
      userMessage: '好，我来说说这一首。' };
  });
  register('edit_listening_queue', '只修改本聊天的待播队列。clear 清空待播项，remove 按稳定歌曲 ID 删除待播项，reorder 按提供的 ID 顺序重排待播项。当前已播过的和正在播的那一首不在待播列表里，删不掉、也重排不了；想换掉它们用 control_listening 的 next，找新歌用 select_music。当前歌继续播放。', object({
    action: { type: 'string', enum: ['clear', 'remove', 'reorder'] }, songIds: { type: 'array', items: { type: 'string' } },
  }), async (service, args, context) => service.mutate(context, async markCommitAttempt => {
    const scoped = service.playbackRuntime.listeningSnapshot(context.sessionId);
    markCommitAttempt();
    const result = await service.playbackRuntime.submit({ type: 'QUEUE_EDIT_REQUESTED', eventId: `queue:${context.requestId}:${args.action}`,
      listeningSessionId: context.sessionId, signal: context.signal, guard: context.isCurrent, expectedQueueVersion: scoped.queueVersion, action: args.action, songIds: args.songIds || [] });
    return { ok: result.accepted, listening: service.playbackRuntime.listeningSnapshot(context.sessionId),
      message: result.accepted ? '待播队列已更新。' : '队列编辑被拒绝：队列版本已经变化，或目标不在待播列表中。',
      userMessage: result.accepted ? '' : '待播队列刚刚发生了变化，或者这些歌已经不在待播列表里。' };
  }), MUSIC_MUTATION_CAPABILITY);
  for (const [name, handler] of [['get_song_tags', songTagTools.getSongTags], ['correct_song_tags', songTagTools.correctSongTags], ['delete_song_tags', songTagTools.deleteSongTags]]) {
    const definition = songTagTools.TOOL_DEFS.find(item => item.function.name === name).function;
    register(name, definition.description, definition.parameters, async (service, args, context) => {
      const result = normalizeToolOutcome(await handler(args, { store: service.getSongTagStore?.(), currentTrack: () => {
        const room = service.playbackRuntime.listeningSnapshot(context.sessionId);
        const track = room.queue[room.currentIndex];
        return track ? { ...track, song_id: track.songId } : null;
      } }));
      if (result.ok && result.data?.changed) service.pool?.invalidate();
      return { ok: result.ok, ...result.data, message: result.content,
        userMessage: result.ok ? '' : result.content };
    }, name === 'get_song_tags' ? MUSIC_CAPABILITY : MUSIC_MUTATION_CAPABILITY);
  }
}
