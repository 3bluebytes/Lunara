import { sanitizeSpeechForTts } from '../chat/roleplaySpeech.js';

function findProjectedVoiceBeat(voiceBeats, beat, arrayIndex) {
  if (!Array.isArray(voiceBeats) || !voiceBeats.length) return null;
  const targetIndex = Number.isInteger(beat?.index) ? beat.index : arrayIndex;
  const byIndex = voiceBeats.find((vb, idx) => (Number.isInteger(vb?.index) ? vb.index : idx) === targetIndex);
  return byIndex || voiceBeats[arrayIndex] || null;
}

function isSpeakableBeat(beat, arrayIndex = 0, voiceBeats = null) {
  const projected = findProjectedVoiceBeat(voiceBeats, beat, arrayIndex);
  if (typeof projected?.canSynthesize === 'boolean') return projected.canSynthesize;
  if (typeof beat?.canSynthesize === 'boolean') return beat.canSynthesize;
  const rawSource = typeof beat?.spoken === 'string' && beat.spoken.trim()
    ? beat.spoken
    : (typeof beat?.say === 'string' ? beat.say : '');
  const stripped = rawSource.replace(/\{[^{}]*\}/g, '');
  return Boolean(sanitizeSpeechForTts(stripped));
}

/** Browsing a room preserves the independently selected listening session. */
export function createConversationController({ store, apiClient, storage = null, onChanged = () => {}, onBeforeSend = () => {}, onAfterSend = () => {}, onError = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = handle => clearTimeout(handle), now = () => Date.now() } = {}) {
  let rooms = [];
  let loadGeneration = 0;
  let restoredSelection = false;
  const local = new Map();
  const pending = new Map();
  const pendingStartedAt = new Map();
  const pendingPhase = new Map();
  const cancelled = new Set();
  // 「正在输入」（服务端 presence-activity）：只是瞬时提示，不进转写、不碰播放。
  // sid → personId → { correlationId, timer }；同一人更新的 correlation 覆盖旧的，迟到的 idle 被丢弃。
  const composing = new Map();
  const COMPOSING_MAX_MS = 65_000;
  const BUBBLE_GRACE_MS = 8_000;
  // 「安静点」（服务端 presence-listener-quiet / status）：哪个听歌来源这次一起听不主动开口；只是可见事实 + 一键恢复。
  let listenerQuietSessionId = null;
  let restoringQuiet = false;
  const listeners = new Set([onChanged]);
  const id = () => store.getState().sessionId;
  const room = () => rooms.find(item => item.sessionId === id());
  const person = personId => store.getState().virtualPersons.find(item => item.id === personId);
  const roomName = item => item?.title || item?.memberIds.map(member => person(member)?.displayName || member).join('、') || '新聊天';
  function stateFor(sid) {
    if (!local.has(sid)) {
      let saved = {};
      try { saved = JSON.parse(storage?.getItem(`lunara.room:${sid}`) || '{}'); } catch {}
      // edit：正在改写的那条用户消息（只在内存里，随该聊天的草稿走）；发送时才回退账本。
      local.set(sid, { draft: saved.draft || '', retry: saved.retry || null, scroll: saved.scroll ?? null, turns: [], loaded: false, unread: false, hasOlder: false, generation: 0, edit: null });
    }
    return local.get(sid);
  }
  const composingIds = sid => [...(composing.get(sid)?.keys() || [])];
  function snapshot() { return { rooms, room: room(), sessionId: id(), local: stateFor(id()), pending: pending.has(id()),
    pendingSince: pendingStartedAt.get(id()) ?? null, pendingPhase: pendingPhase.get(id()) || 'chat',
    composing: composingIds(id()),
    listenerQuiet: Boolean(listenerQuietSessionId) && listenerQuietSessionId === id(), restoringQuiet }; }
  function consumeListenerQuiet(payload = {}) {
    const { sessionId: sid, quiet } = payload || {};
    if (!sid || typeof quiet !== 'boolean') return false;
    if (quiet) listenerQuietSessionId = sid;
    else if (listenerQuietSessionId === sid) listenerQuietSessionId = null;
    else return false;
    emit();
    return true;
  }
  async function refreshListenerQuiet() {
    try {
      const status = await apiClient.get('/api/presence/status');
      listenerQuietSessionId = typeof status?.listenerQuietSessionId === 'string' ? status.listenerQuietSessionId : null;
      emit();
    } catch { /* 读不到就保持现状；下次重连再读 */ }
    return listenerQuietSessionId;
  }
  /** 一键恢复：服务端确认后才收起；失败保留提示并交给 onError。 */
  async function restoreListenerQuiet() {
    const sid = listenerQuietSessionId;
    if (!sid || restoringQuiet) return false;
    restoringQuiet = true;
    emit();
    try {
      const result = await apiClient.post('/api/presence/listener-quiet/restore', { sessionId: sid });
      if (result?.ok === false) throw new Error('没能恢复');
      if (listenerQuietSessionId === sid) listenerQuietSessionId = result?.listenerQuietSessionId ?? null;
      return true;
    } catch {
      onError(new Error('没能恢复主动说话，可以再试一次。'));
      return false;
    } finally {
      restoringQuiet = false;
      emit();
    }
  }
  function stopComposing(sid, personId, correlationId = null) {
    const people = composing.get(sid);
    const entry = people?.get(personId);
    if (!entry || (correlationId && entry.correlationId !== correlationId)) return false;
    clearTimer(entry.timer);
    people.delete(personId);
    if (!people.size) composing.delete(sid);
    return true;
  }
  function holdComposing(sid, personId, correlationId, ms) {
    const people = composing.get(sid) || new Map();
    clearTimer(people.get(personId)?.timer);
    // 兜底：丢了 idle 或气泡也不能让提示一直挂着。
    const timer = setTimer(() => { if (stopComposing(sid, personId, correlationId) && sid === id()) emit(); }, ms);
    people.set(personId, { correlationId, timer });
    composing.set(sid, people);
  }
  function consumeActivity(payload = {}) {
    const { sessionId: sid, personId, correlationId, state, outcome, phase } = payload || {};
    if (!sid || !personId || !correlationId || !rooms.some(item => item.sessionId === sid && item.memberIds?.includes(personId))) return false;
    if (state === 'composing') {
      if (phase === 'music') pendingPhase.set(sid, 'music');
      holdComposing(sid, personId, correlationId, COMPOSING_MAX_MS);
    } else if (state === 'idle') {
      const current = composing.get(sid)?.get(personId);
      if (current?.correlationId !== correlationId) return false;
      // 已入账：气泡还在路上（语音合成等），撑到气泡出现或短暂兜底；没入账就立即收起。
      if (outcome === 'committed') holdComposing(sid, personId, correlationId, BUBBLE_GRACE_MS);
      else stopComposing(sid, personId, correlationId);
    } else return false;
    if (sid === id()) emit();
    return true;
  }
  function emit() { for (const listener of listeners) listener(snapshot()); }
  function saveView({ draft, scroll }) {
    const view = stateFor(id());
    Object.assign(view, { draft, scroll });
    try { storage?.setItem(`lunara.room:${id()}`, JSON.stringify({ draft, scroll, retry: view.retry })); } catch {}
  }
  function mergeBeatArrays(prevBeats, nextBeats) {
    if (!Array.isArray(nextBeats)) return prevBeats;
    if (!Array.isArray(prevBeats) || !prevBeats.length) {
      return nextBeats.map((beat, index) => ({
        ...beat,
        index: Number.isInteger(beat?.index) ? beat.index : index,
      }));
    }
    const byIndex = new Map();
    prevBeats.forEach((beat, index) => {
      const idx = Number.isInteger(beat?.index) ? beat.index : index;
      byIndex.set(idx, { ...beat, index: idx });
    });
    nextBeats.forEach((beat, index) => {
      const idx = Number.isInteger(beat?.index) ? beat.index : index;
      const existing = byIndex.get(idx) || {};
      byIndex.set(idx, { ...existing, ...beat, index: idx });
    });
    return [...byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, beat]) => beat);
  }
  function mergeTurns(sid, turns, { replace = false } = {}) {
    const view = stateFor(sid);
    const prevById = new Map(view.turns.map(turn => [turn.turnId, turn]));
    const merged = new Map((replace ? [] : view.turns).map(turn => [turn.turnId, turn]));
    for (const turn of turns) {
      if (!turn?.turnId) continue;
      if (!replace && merged.has(turn.turnId)) {
        const prev = merged.get(turn.turnId);
        const nextTurn = {
          ...prev,
          ...turn,
          ...(Array.isArray(turn.beats) ? { beats: mergeBeatArrays(prev.beats, turn.beats) } : {}),
          sequence: prev.sequence ?? turn.sequence,
          createdAt: prev.createdAt ?? turn.createdAt,
        };
        if (!('beatProgress' in turn) && Array.isArray(turn.beats) && prev.beatProgress) {
          delete nextTurn.beatProgress;
        }
        if (prev.__liveArrival || turn.__liveArrival) {
          Object.defineProperty(nextTurn, '__liveArrival', { value: true, configurable: true });
        }
        merged.set(turn.turnId, nextTurn);
      } else {
        const prevExisting = prevById.get(turn.turnId);
        const nextTurn = prevExisting?.__liveArrival && !turn.__liveArrival ? { ...turn } : turn;
        if (prevExisting?.__liveArrival && !nextTurn.__liveArrival) {
          Object.defineProperty(nextTurn, '__liveArrival', { value: true, configurable: true });
        }
        merged.set(turn.turnId, nextTurn);
      }
    }
    view.turns = [...merged.values()].sort((a, b) => (a.sequence || a.createdAt) - (b.sequence || b.createdAt)).slice(-500);
    view.loaded = true;
  }
  async function loadTranscript(sid, { older = false, markNewAssistantLive = null } = {}) {
    const view = stateFor(sid);
    const generation = ++view.generation;
    const before = older ? `&before=${view.turns.find(turn => Number.isInteger(turn.sequence))?.sequence || 1}` : '';
    const result = await apiClient.get(`/api/conversations/${encodeURIComponent(sid)}/turns?limit=100${before}`);
    if (result.sessionId !== sid || view.generation !== generation) return;
    const optimistic = !older && pending.has(sid) ? view.turns.find(turn => turn.turnId === pending.get(sid)) : null;
    mergeTurns(sid, result.turns || [], { replace: !older });
    let hasNewLiveAssistant = false;
    if (markNewAssistantLive instanceof Set) {
      for (const loadedTurn of view.turns) {
        if (loadedTurn?.role === 'assistant' && loadedTurn.turnId && !markNewAssistantLive.has(loadedTurn.turnId)) {
          Object.defineProperty(loadedTurn, '__liveArrival', { value: true, configurable: true });
          hasNewLiveAssistant = true;
        }
      }
    }
    Object.defineProperty(view.turns, '__fromHistoryLoad', { value: !hasNewLiveAssistant, configurable: true });
    if (optimistic && !view.turns.some(turn => turn.role === 'user' && turn.text === optimistic.text
      && turn.createdAt >= optimistic.createdAt - 1000)) view.turns.push(optimistic);
    view.hasOlder = result.turns?.length === 100;
    if (sid === id()) emit();
  }
  function select(sid) {
    const selected = rooms.find(item => item.sessionId === sid);
    if (!selected) return Promise.resolve();
    stateFor(sid).unread = false;
    try { storage?.setItem('lunara.selected-room', sid); } catch {}
    store.update({ sessionId: sid, activeRadiohost: person(selected.activeVirtualPersonId) || null }, { type: 'conversation.selected' });
    emit();
    return loadTranscript(sid).catch(error => { if (sid === id()) onError(error); });
  }
  async function refresh() {
    const generation = ++loadGeneration;
    const result = await apiClient.get('/api/conversations?archived=true');
    if (generation !== loadGeneration) return;
    rooms = result.conversations || [];
    const firstLoad = !restoredSelection;
    if (firstLoad) {
      restoredSelection = true;
      let saved;
      try { saved = storage?.getItem('lunara.selected-room'); } catch {}
      const savedRoom = saved ? rooms.find(item => item.sessionId === saved && !item.archivedAt) : null;
      if (savedRoom && savedRoom.sessionId !== id()) return select(savedRoom.sessionId);
      // 初始 sessionId 是硬编码默认值，命中真实房间不代表用户选过它；无存档时必须显式落到最新房间。
      if (!savedRoom) {
        const newest = rooms.find(item => !item.archivedAt);
        if (newest && newest.sessionId !== id()) return select(newest.sessionId);
      }
    } else if (!room()) {
      const first = rooms.find(item => !item.archivedAt);
      if (first) return select(first.sessionId);
    }
    const current = room();
    if (current) store.update({ activeRadiohost: person(current.activeVirtualPersonId) || null });
    emit();
  }
  async function create(input) {
    const payload = {
      ...input,
      ...(input?.hostId ? { hostId: input.hostId } : {}),
    };
    const result = await apiClient.post('/api/conversations', payload);
    await refresh(); await select(result.conversation.sessionId);
    return result.conversation;
  }
  async function update(input) {
    return updateRoomById(id(), input);
  }
  /** 列表行内操作以 sessionId 为目标，不再要求先选中该会话。 */
  async function updateRoomById(sid, input) {
    await apiClient.post(`/api/conversations/${encodeURIComponent(sid)}`, input);
    await refresh();
    if (input.archived && sid === id()) {
      const next = rooms.find(item => !item.archivedAt);
      if (next) await select(next.sessionId);
    }
  }
  async function deleteRoomById(sid) {
    await apiClient.delete(`/api/conversations/${encodeURIComponent(sid)}`);
    await refresh();
    if (sid === id()) {
      const next = rooms.find(item => !item.archivedAt);
      if (next) await select(next.sessionId);
    }
  }
  async function member(personId, remove = false) {
    await apiClient.post(`/api/conversations/${encodeURIComponent(id())}/members`, { personId, remove });
    await refresh();
  }
  /**
   * ambient 推荐的「放这首」：只调推荐接口（不碰听歌来源、不发 /api/chat）。服务端的拒绝（409/404/503）
   * 照样返回结果，网络失败才抛出。推荐状态以服务端为准写回本地 turn，重绘时卡片随之变化。
   */
  async function acceptRecommendation(turnId, sid = id()) {
    let result;
    try {
      result = await apiClient.post(`/api/conversations/${encodeURIComponent(sid)}/recommendations/${encodeURIComponent(turnId)}/accept`, {});
    } catch (error) {
      if (!error?.body || typeof error.body !== 'object') throw error;
      result = error.body;
    }
    const status = result?.ok === true ? 'queued' : result?.recommendation?.status;
    const turn = stateFor(sid).turns.find(item => item.turnId === turnId);
    if (turn?.musicRecommendation && status) turn.musicRecommendation = { ...turn.musicRecommendation, status };
    return result;
  }
  async function host(personId) {
    try {
      await apiClient.post(`/api/virtual-persons/${encodeURIComponent(personId)}/activate`, { sessionId: id() });
    } finally {
      // 成功或失败都重读房间：界面只显示服务端的当前伙伴，失败时自然回到原值。
      await refresh().catch(() => {});
    }
  }
  function consume(message) {
    const sid = message.conversationId || message.sessionId;
    if (!sid) return false;
    const messages = message.messages || ((message.message?.say || message.message?.beats?.length) ? [message.message] : []);
    if (!messages.length) return false;
    const view = stateFor(sid);
    const existingById = new Map(view.turns.map(turn => [turn.turnId, turn]));
    let seqCursor = Math.max(0, ...view.turns.map(turn => turn.sequence || 0));
    mergeTurns(sid, messages.filter(item => item.sourceTurnId).map(item => {
      const existing = existingById.get(item.sourceTurnId);
      const sequence = existing?.sequence ?? item.sequence ?? (++seqCursor);
      const createdAt = existing?.createdAt ?? now();
      const text = item.say ?? (Array.isArray(item.beats)
        ? item.beats.map(beat => [beat?.action, beat?.say].filter(Boolean).join(' ')).filter(Boolean).join('\n')
        : '');
      const turn = {
        turnId: item.sourceTurnId,
        role: 'assistant',
        text,
        speakerVirtualPersonId: item.virtualPersonId,
        presentation: item.presentation,
        queueItemId: item.queueItemId,
        tracks: item.tracks,
        ...(item.groupFloor ? { groupFloor: item.groupFloor } : {}),
        ...(item.hostSuggestion ? { hostSuggestion: item.hostSuggestion } : {}),
        ...(item.webSources ? { webSources: item.webSources } : {}),
        ...(item.musicRecommendation ? { musicRecommendation: item.musicRecommendation } : {}),
        ...(item.segments ? { segments: item.segments } : {}),
        ...(Array.isArray(item.beats) ? { beats: item.beats } : {}),
        ...(item.beatProgress ? { beatProgress: item.beatProgress } : {}),
        ...(item.voice ? { voice: item.voice } : {}),
        sequence,
        createdAt,
      };
      if (!existing) Object.defineProperty(turn, '__liveArrival', { value: true, configurable: true });
      return turn;
    }));
    Object.defineProperty(view.turns, '__fromHistoryLoad', { value: false, configurable: true });
    // 气泡到了：这位的「正在输入」随之收起。
    for (const item of messages) if (item.virtualPersonId) stopComposing(sid, item.virtualPersonId);
    view.unread = sid !== id();
    // 她主动说的话会在服务端标未读；正开着这个聊天时当场就算读过，不打扰、不刷新列表。
    if (!view.unread && messages.some(item => item.presentation === 'presence')) {
      Promise.resolve(apiClient.post(`/api/conversations/${encodeURIComponent(sid)}`, { unread: false })).catch(() => {});
    }
    emit(); return true;
  }
  /**
   * 「编辑」（add-chat-edit-and-fork，参考 pi-web #1009）：只把原话填进输入框并记下目标，不碰账本；
   * 取消、切换聊天或刷新都不会截断聊天。输入框里有别的草稿时不覆盖。
   */
  function beginEdit(turnId) {
    const view = stateFor(id());
    const turn = view.turns.find(item => item.turnId === turnId && item.role === 'user');
    if (!turn || pending.has(id()) || room()?.archivedAt) return false;
    if (view.draft.trim() && view.draft.trim() !== turn.text.trim()) {
      onError(new Error('输入框里还有没发的话，先发出去或清空再改写。'));
      return false;
    }
    view.edit = { turnId, text: turn.text };
    view.draft = turn.text; view.restoreDraft = true;
    emit();
    return true;
  }
  function cancelEdit() {
    const view = stateFor(id());
    if (!view.edit) return;
    view.edit = null;
    saveView({ draft: '', scroll: view.scroll });
    view.restoreDraft = true;
    emit();
  }
  /** 改写的发送：先请求从目标起回退，成功后照常发送；失败把草稿与编辑状态原样还回去。 */
  async function rewindForEdit(sid, view, text) {
    const edit = view.edit;
    view.edit = null;
    try {
      await apiClient.post(`/api/conversations/${encodeURIComponent(sid)}/rewind`, { turnId: edit.turnId });
    } catch (error) {
      view.edit = edit; view.draft = text; view.restoreDraft = true;
      if (sid === id()) onError(error);
      emit();
      return false;
    }
    const from = view.turns.find(turn => turn.turnId === edit.turnId)?.sequence;
    if (Number.isFinite(from)) view.turns = view.turns.filter(turn => !(Number(turn.sequence) >= from));
    return true;
  }
  /** 从一条用户消息分叉：服务端建新聊天并复制之前的历史；这里只切换正在查看的聊天并预填原话。 */
  async function fork(turnId) {
    const sid = id();
    const result = await apiClient.post(`/api/conversations/${encodeURIComponent(sid)}/fork`, { turnId });
    const forked = result.conversation;
    const view = stateFor(forked.sessionId);
    view.draft = String(result.text || ''); view.edit = null; view.restoreDraft = true;
    await refresh(); await select(forked.sessionId);
    return forked;
  }
  // 在正在听的聊天里说「下一首/暂停」时，指的是此刻听到的这一首；服务端据此拒绝
  // 对模型思考期间才换上的歌动手。浏览别的聊天或没有在播的歌时不附带。
  function heardOccurrence(sid) {
    const runtime = store.getState().runtimeState;
    if (runtime?.activeListeningSessionId !== sid || !['playing', 'paused', 'loading'].includes(runtime.phase)) return null;
    const track = runtime.queue?.[runtime.currentIndex];
    const queueItemId = runtime.txn?.queueItemId || track?.queueItemId;
    return queueItemId ? { listeningSessionId: sid, queueItemId, songId: track?.songId ?? null } : null;
  }
  async function send(raw, { interrupt = false } = {}) {
    const text = String(raw || '').trim();
    const sid = id();
    const previousRequest = pending.get(sid);
    if (!text || (previousRequest && !interrupt) || room()?.archivedAt) return false;
    const view = stateFor(sid);
    if (view.edit) {
      // 改写不作插话：回应还在进行时先不发，草稿留着。
      if (previousRequest) {
        view.draft = text; view.restoreDraft = true;
        onError(new Error('等这一轮回应结束再发送改写。'));
        emit();
        return false;
      }
      if (!await rewindForEdit(sid, view, text)) return false;
    }
    const requestId = !previousRequest && view.retry?.text === text ? view.retry.requestId : `chat:${globalThis.crypto.randomUUID()}`;
    if (previousRequest) cancelled.add(previousRequest);
    view.turns = view.turns.filter(turn => turn.turnId !== requestId);
    const optimistic = { turnId: requestId, role: 'user', text, sequence: Math.max(0, ...view.turns.map(turn => turn.sequence || 0)) + 1, createdAt: Date.now() };
    view.turns.push(optimistic); view.draft = ''; view.scroll = null;
    try { storage?.setItem(`lunara.room:${sid}`, JSON.stringify({ draft: '', scroll: null })); } catch {}
    pending.set(sid, requestId); pendingStartedAt.set(sid, now()); pendingPhase.set(sid, 'chat'); emit(); onBeforeSend({ sessionId: sid, requestId });
    try {
      const heard = heardOccurrence(sid);
      const payload = { message: text, sessionId: sid, requestId,
        ...(previousRequest ? { interruptRequestId: previousRequest } : {}),
        ...(heard ? { playbackIdentity: heard } : {}) };
      await apiClient.chat(payload);
      if (cancelled.has(requestId) || pending.get(sid) !== requestId) return true;
      const knownBeforeLoad = new Set(view.turns.map(turn => turn.turnId));
      await loadTranscript(sid, { markNewAssistantLive: knownBeforeLoad });
      view.retry = null;
      stateFor(sid).unread = sid !== id();
    } catch (error) {
      if (!cancelled.has(requestId) && pending.get(sid) === requestId) {
        optimistic.text = `${text}\n（暂未确认送达，请稍后刷新查看）`;
        view.draft = text;
        view.retry = { requestId, text };
        view.restoreDraft = true;
        try { storage?.setItem(`lunara.room:${sid}`, JSON.stringify({ draft: text, scroll: view.scroll, retry: view.retry })); } catch {}
        if (sid === id()) onError(error);
      }
    } finally {
      if (pending.get(sid) === requestId) { pending.delete(sid); pendingStartedAt.delete(sid); pendingPhase.delete(sid); }
      cancelled.delete(requestId);
      onAfterSend({ sessionId: sid, requestId });
      emit();
    }
    return true;
  }
  function markMusicPhase(sid = id()) {
    if (!sid || pendingPhase.get(sid) === 'music') return;
    pendingPhase.set(sid, 'music');
    if (sid === id()) emit();
  }
  async function synthesizeTurnSpeech(turnId, sid = id()) {
    if (!sid || !turnId) throw new Error('找不到要朗读的消息。');
    const result = await apiClient.post(
      `/api/conversations/${encodeURIComponent(sid)}/turns/${encodeURIComponent(turnId)}/speech`,
      {},
    );
    const turn = stateFor(sid).turns.find(item => item.turnId === turnId);
    if (turn) {
      const prevVoiceBeats = Array.isArray(turn.voice?.beats) ? turn.voice.beats : null;
      if (Array.isArray(result?.beats) && result.beats.length) {
        if (Array.isArray(turn.beats) && turn.beats.length) {
          const byIndex = new Map(result.beats.map((beat, i) => [Number.isInteger(beat?.index) ? beat.index : i, beat]));
          turn.beats = turn.beats.map((beat, i) => {
            const idx = Number.isInteger(beat?.index) ? beat.index : i;
            const synthBeat = byIndex.get(idx);
            if (!synthBeat) return beat;
            return {
              ...beat,
              index: idx,
              ...(synthBeat.audioUrl ? { audioUrl: synthBeat.audioUrl } : {}),
              ...(synthBeat.hash ? { hash: synthBeat.hash } : {}),
              ...(Number.isFinite(Number(synthBeat.durationMs)) ? { durationMs: Number(synthBeat.durationMs) } : {}),
              ...(Number.isFinite(Number(synthBeat.pauseAfterMs)) ? { pauseAfterMs: Number(synthBeat.pauseAfterMs) } : {}),
            };
          });
        } else {
          turn.beats = result.beats.map((beat, i) => ({
            ...beat,
            index: Number.isInteger(beat?.index) ? beat.index : i,
          }));
        }
      }
      const hasBeatAudio = Array.isArray(turn.beats) && turn.beats.some(beat => Boolean(beat?.audioUrl));
      const allBeatsReady = Array.isArray(turn.beats) && turn.beats.length > 0
        && turn.beats.every((beat, i) => !isSpeakableBeat(beat, i, prevVoiceBeats) || Boolean(beat?.audioUrl));
      const primaryUrl = result?.audioUrl
        || (hasBeatAudio ? turn.beats.find(beat => beat?.audioUrl)?.audioUrl : null)
        || null;
      if (primaryUrl || hasBeatAudio) {
        let nextVoiceBeats;
        if (Array.isArray(turn.beats) && turn.beats.length > 0) {
          nextVoiceBeats = turn.beats.map((beat, i) => {
            const idx = Number.isInteger(beat?.index) ? beat.index : i;
            const projected = findProjectedVoiceBeat(prevVoiceBeats, beat, i);
            const resultBeat = findProjectedVoiceBeat(result?.beats, beat, i);
            const canSynthesize = typeof resultBeat?.canSynthesize === 'boolean'
              ? resultBeat.canSynthesize
              : isSpeakableBeat(beat, i, prevVoiceBeats);
            const audioUrl = beat?.audioUrl || resultBeat?.audioUrl || null;
            const rawDuration = beat?.durationMs ?? resultBeat?.durationMs ?? projected?.durationMs;
            const durationMs = audioUrl && Number.isFinite(Number(rawDuration)) ? Number(rawDuration) : null;
            return {
              index: idx,
              canSynthesize,
              status: (!canSynthesize && !audioUrl) ? 'none' : (audioUrl ? 'ready' : 'missing'),
              audioUrl,
              durationMs,
            };
          });
        } else if (Array.isArray(result?.beats)) {
          nextVoiceBeats = result.beats;
        }
        turn.voice = {
          ...(turn.voice || {}),
          canSynthesize: true,
          status: Array.isArray(turn.beats) && turn.beats.length > 0
            ? (allBeatsReady ? 'ready' : (hasBeatAudio ? 'partial' : 'missing'))
            : 'ready',
          url: primaryUrl,
          audioUrl: primaryUrl,
          durationMs: result?.durationMs ?? turn.voice?.durationMs ?? null,
          ...(nextVoiceBeats ? { beats: nextVoiceBeats } : {}),
        };
      }
    }
    return result;
  }
  async function touchTurnSpeech(turnId, sid = id()) {
    if (!sid || !turnId) return { touched: false, exists: false, audioUrl: null };
    const result = await apiClient.post(
      `/api/conversations/${encodeURIComponent(sid)}/turns/${encodeURIComponent(turnId)}/speech/touch`,
      {},
    );
    if (result?.exists === false) {
      const turn = stateFor(sid).turns.find(item => item.turnId === turnId);
      if (turn?.voice) {
        const clearedVoiceBeats = Array.isArray(turn.voice.beats)
          ? turn.voice.beats.map((vb, i) => {
            if (!vb || typeof vb !== 'object') return vb;
            const beat = Array.isArray(turn.beats) ? turn.beats[i] : null;
            const canSynth = typeof vb.canSynthesize === 'boolean'
              ? vb.canSynthesize
              : (beat ? isSpeakableBeat(beat, i, turn.voice.beats) : true);
            return {
              ...vb,
              canSynthesize: canSynth,
              audioUrl: null,
              durationMs: null,
              status: canSynth ? 'missing' : 'none',
            };
          })
          : undefined;
        turn.voice = {
          ...turn.voice,
          url: null,
          audioUrl: null,
          status: 'missing',
          ...(clearedVoiceBeats ? { beats: clearedVoiceBeats } : {}),
        };
      }
      if (Array.isArray(turn?.beats)) {
        turn.beats = turn.beats.map(beat => {
          if (!beat || typeof beat !== 'object') return beat;
          const { audioUrl, hash, ...rest } = beat;
          return rest;
        });
      }
    }
    return result;
  }
  async function cancel() {
    const sid = id(), requestId = pending.get(sid);
    if (requestId) cancelled.add(requestId);
    try { await apiClient.post(`/api/conversations/${encodeURIComponent(sid)}/cancel`, requestId ? { requestId } : {}); }
    finally { onAfterSend({ sessionId: sid, requestId }); }
    // Keep the room serialized until its aborted response has reached a terminal state.
  }
  return { refresh, select, create, createRoom: create, update, updateRoomById, deleteRoomById, member, host, acceptRecommendation, send, cancel, consume, consumeActivity,
    beginEdit, cancelEdit, fork, markMusicPhase, synthesizeTurnSpeech, touchTurnSpeech,
    consumeListenerQuiet, refreshListenerQuiet, restoreListenerQuiet, saveView, loadTranscript,
    stateFor, roomName, snapshot, person, isPending: () => pending.has(id()),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
}
