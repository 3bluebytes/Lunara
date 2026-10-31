/** Browsing a room preserves the independently selected listening session. */
export function createConversationController({ store, apiClient, storage = null, onChanged = () => {}, onBeforeSend = () => {}, onAfterSend = () => {}, onError = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = handle => clearTimeout(handle) } = {}) {
  let rooms = [];
  let loadGeneration = 0;
  let restoredSelection = false;
  const local = new Map();
  const pending = new Map();
  const cancelled = new Set();
  // 「正在输入」（服务端 presence-activity）：只是瞬时提示，不进转写、不碰播放。
  // sid → personId → { correlationId, timer }；同一人更新的 correlation 覆盖旧的，迟到的 idle 被丢弃。
  const composing = new Map();
  const COMPOSING_MAX_MS = 30_000;
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
  function snapshot() { return { rooms, room: room(), sessionId: id(), local: stateFor(id()), pending: pending.has(id()), composing: composingIds(id()),
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
    const { sessionId: sid, personId, correlationId, state, outcome } = payload || {};
    if (!sid || !personId || !correlationId || !rooms.some(item => item.sessionId === sid && item.memberIds?.includes(personId))) return false;
    if (state === 'composing') holdComposing(sid, personId, correlationId, COMPOSING_MAX_MS);
    else if (state === 'idle') {
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
  function mergeTurns(sid, turns, { replace = false } = {}) {
    const view = stateFor(sid);
    const merged = new Map((replace ? [] : view.turns).map(turn => [turn.turnId, turn]));
    for (const turn of turns) if (turn.turnId) merged.set(turn.turnId, turn);
    view.turns = [...merged.values()].sort((a, b) => (a.sequence || a.createdAt) - (b.sequence || b.createdAt)).slice(-500);
    view.loaded = true;
  }
  async function loadTranscript(sid, { older = false } = {}) {
    const view = stateFor(sid);
    const generation = ++view.generation;
    const before = older ? `&before=${view.turns.find(turn => Number.isInteger(turn.sequence))?.sequence || 1}` : '';
    const result = await apiClient.get(`/api/conversations/${encodeURIComponent(sid)}/turns?limit=100${before}`);
    if (result.sessionId !== sid || view.generation !== generation) return;
    const optimistic = !older && pending.has(sid) ? view.turns.find(turn => turn.turnId === pending.get(sid)) : null;
    mergeTurns(sid, result.turns || [], { replace: !older });
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
    const result = await apiClient.post('/api/conversations', input);
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
    const messages = message.messages || (message.message?.say ? [message.message] : []);
    if (!messages.length) return false;
    const view = stateFor(sid);
    const nextSequence = Math.max(0, ...view.turns.map(turn => turn.sequence || 0));
    mergeTurns(sid, messages.filter(item => item.sourceTurnId).map((item, i) => ({ turnId: item.sourceTurnId,
      role: 'assistant', text: item.say, speakerVirtualPersonId: item.virtualPersonId,
      presentation: item.presentation, queueItemId: item.queueItemId, tracks: item.tracks,
      ...(item.groupFloor ? { groupFloor: item.groupFloor } : {}),
      ...(item.hostSuggestion ? { hostSuggestion: item.hostSuggestion } : {}),
      ...(item.webSources ? { webSources: item.webSources } : {}),
      ...(item.musicRecommendation ? { musicRecommendation: item.musicRecommendation } : {}),
      sequence: item.sequence || nextSequence + i + 1, createdAt: Date.now() })));
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
    pending.set(sid, requestId); emit(); onBeforeSend({ sessionId: sid, requestId });
    try {
      const heard = heardOccurrence(sid);
      const payload = { message: text, sessionId: sid, requestId,
        ...(previousRequest ? { interruptRequestId: previousRequest } : {}),
        ...(heard ? { playbackIdentity: heard } : {}) };
      await apiClient.chat(payload);
      if (cancelled.has(requestId) || pending.get(sid) !== requestId) return true;
      await loadTranscript(sid);
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
      if (pending.get(sid) === requestId) pending.delete(sid);
      cancelled.delete(requestId);
      onAfterSend({ sessionId: sid, requestId });
      emit();
    }
    return true;
  }
  async function cancel() {
    const sid = id(), requestId = pending.get(sid);
    if (requestId) cancelled.add(requestId);
    try { await apiClient.post(`/api/conversations/${encodeURIComponent(sid)}/cancel`, requestId ? { requestId } : {}); }
    finally { onAfterSend({ sessionId: sid, requestId }); }
    // Keep the room serialized until its aborted response has reached a terminal state.
  }
  return { refresh, select, create, update, updateRoomById, deleteRoomById, member, host, acceptRecommendation, send, cancel, consume, consumeActivity,
    beginEdit, cancelEdit, fork,
    consumeListenerQuiet, refreshListenerQuiet, restoreListenerQuiet, saveView, loadTranscript,
    stateFor, roomName, snapshot, person, isPending: () => pending.has(id()),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
}
