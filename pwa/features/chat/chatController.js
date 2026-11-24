import { buildChatMessageHtml, RECOMMENDATION_COPY } from './chatMarkup.js';
import { buildQuoteText } from './chatQuote.js';
import { sanitizeSpeechForTts } from './roleplaySpeech.js';

/**
 * 日期分隔标签（参考稿：今晚 / 18:14）：同一天的消息只出现一条分隔线，
 * 标签 = 相对日期词 + 该组首条消息的时间。跨天后重新插入。
 */
export function formatChatDateDivider(value, clock = () => new Date()) {
  const date = value ? new Date(value) : clock();
  if (Number.isNaN(date.getTime())) return null;
  const now = clock();
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const startOfDay = input => new Date(input.getFullYear(), input.getMonth(), input.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000);
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  let dayLabel;
  if (dayDiff === 0) dayLabel = date.getHours() >= 18 ? '今晚' : '今天';
  else if (dayDiff === -1) dayLabel = '昨天';
  else if (dayDiff < 0 && dayDiff >= -6) dayLabel = weekdays[date.getDay()];
  else dayLabel = `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${dayLabel} / ${time}`;
}

function sameCalendarDay(left, right) {
  if (!left || !right) return false;
  const a = new Date(left);
  const b = new Date(right);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return false;
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function createChatController({
  chatList,
  chatScroll,
  documentLike = globalThis.document,
  requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  clock = () => new Date(),
  onTrackCardClick = () => {},
  getSpeakerName = id => id || 'Lunara',
  // 主持建议的确认：调用方走既有的 POST /api/virtual-persons/:id/activate，失败时 reject。
  onConfirmHost = null,
  // ambient 推荐的「放这首」：调用方走 POST /api/conversations/:id/recommendations/:turnId/accept，
  // 返回服务端结果（含被拒的 409）；网络失败时 reject。
  onAcceptRecommendation = null,
  // 用户消息的「编辑」「存为新聊天继续」（add-chat-edit-and-fork）：回调收到 turnId；未注入就不显示按钮。
  onEditMessage = null,
  onForkMessage = null,
  // 消息的「引用」（add-chat-message-quote）：回调收到已经拼好的引用行（不含 `> `），
  // 由输入框负责写进草稿；未注入就不显示按钮。
  onQuoteMessage = null,
  // 消息的「收进手帐」：回调收到可预填手帐的只读摘要与配乐；未注入就不显示按钮。
  onSaveToJournal = null,
  // 气泡语音按需合成/播放：仅在注入回调且消息有可朗读台词时绑定点击与播放同步。
  onToggleTurnVoice = null,
  getPlayingTurnId = () => null,
  isTurnVoiceLoading = () => false,
  narrationCoordinator = null,
  hasPendingTurnAudio = null,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = handle => clearTimeout(handle),
} = {}) {
  if (!chatList) throw new TypeError('chat list is required');
  const renderedTurnIds = new Set();
  const turnElements = new Map();
  const activeBeatReveals = new Map();
  const completedRevealTurnIds = new Set();
  const maxStartedBeatCountByTurn = new Map();
  const seenTurnIds = new Set();
  const hydratedRoomIds = new Set();
  const elementClickBound = new WeakSet();
  const elementTurnIds = new WeakMap();
  const elementActionFlag = new WeakMap();
  const boundBeatGroups = new WeakSet();
  let currentRoomId = null;
  let activeSpeakingTurnId = null;
  let activeSpeakingBeatIndex = null;
  let lastDividerDay = null;

  function timeString(value = null) {
    const date = value ? new Date(value) : clock();
    if (Number.isNaN(date.getTime())) return '';
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  function scrollBottom() {
    requestFrame?.(() => {
      if (chatScroll) chatScroll.scrollTop = chatScroll.scrollHeight;
    });
  }

  function bindTrackCards(root) {
    root?.querySelectorAll?.('.chat-track')?.forEach(button => {
      if (button.dataset?.chatBound === '1') return;
      if (button.dataset) button.dataset.chatBound = '1';
      button.addEventListener?.('click', () => onTrackCardClick(button));
    });
  }

  /** 主持建议的显示状态只看房间的权威当前伙伴与成员，不在前端另存一份。 */
  function hostSuggestionView(suggestion, room) {
    if (!suggestion?.toPersonId) return null;
    const state = room?.activeVirtualPersonId === suggestion.toPersonId ? 'applied'
      : Array.isArray(room?.memberIds) && !room.memberIds.includes(suggestion.toPersonId) ? 'unavailable' : 'pending';
    return { toPersonId: suggestion.toPersonId, targetName: getSpeakerName(suggestion.toPersonId),
      reason: suggestion.reason || '', state };
  }

  /** 确认按钮：保存中不禁用（焦点留在按钮上），失败恢复按钮并给出可重试的提示，不暴露内部错误。 */
  function bindHostSuggestion(root) {
    root?.querySelectorAll?.('.chat-host-confirm')?.forEach(button => {
      if (button.dataset?.bound === '1') return;
      if (button.dataset) button.dataset.bound = '1';
      button.addEventListener?.('click', async () => {
        if (button.getAttribute?.('aria-busy') === 'true' || typeof onConfirmHost !== 'function') return;
        const name = button.dataset?.hostName || '';
        const note = button.parentElement?.querySelector?.('.chat-host-note');
        button.setAttribute?.('aria-busy', 'true');
        button.textContent = '正在设置…';
        if (note) note.textContent = '';
        try {
          await onConfirmHost(button.dataset.hostSuggestion);
          button.textContent = `已让 ${name} 主持`;
          if (note) note.textContent = `${name} 现在主持这个聊天。`;
        } catch {
          button.textContent = `再试一次：让 ${name} 主持`;
          if (note) note.textContent = '没能设好，当前伙伴没有变，可以再试一次。';
        } finally {
          button.setAttribute?.('aria-busy', 'false');
        }
      });
    });
  }

  /** 推荐卡片的显示状态：推荐表状态 + 过期时间 + 这个聊天是不是当前听歌来源（runtime-state 给的）。 */
  function recommendationView(recommendation, turnId, listening) {
    if (!recommendation?.title || !turnId) return null;
    const expired = Number.isFinite(Number(recommendation.expiresAt)) && Number(recommendation.expiresAt) <= now();
    const status = recommendation.status === 'pending' && expired ? 'expired' : recommendation.status;
    const state = status === 'pending' ? (listening ? 'pending' : 'not-source') : status;
    return { turnId, title: recommendation.title, artist: recommendation.artist || '', state };
  }

  /** 「放这首」：提交中标 aria-busy；只有服务端说已排上才写已安排；忙时可再试；失败不暴露内部错误。 */
  function bindRecommendation(root) {
    root?.querySelectorAll?.('.chat-recommendation-accept')?.forEach(button => {
      if (button.dataset?.bound === '1') return;
      if (button.dataset) button.dataset.bound = '1';
      button.addEventListener?.('click', async () => {
        const note = button.parentElement?.querySelector?.('.chat-recommendation-note');
        if (button.getAttribute?.('aria-disabled') === 'true') {
          if (note && button.parentElement?.dataset?.state !== 'queued') note.textContent = note.textContent || RECOMMENDATION_COPY.notSource;
          return;
        }
        if (button.getAttribute?.('aria-busy') === 'true' || typeof onAcceptRecommendation !== 'function') return;
        button.setAttribute?.('aria-busy', 'true');
        button.textContent = '正在安排…';
        if (note) note.textContent = '';
        let settled = null;
        try {
          const result = await onAcceptRecommendation(button.dataset.recommendationTurn);
          const status = result?.ok === true ? 'queued' : result?.recommendation?.status;
          if (status === 'queued') settled = RECOMMENDATION_COPY.queued;
          else if (status === 'unavailable') settled = RECOMMENDATION_COPY.unavailable;
          else if (status === 'expired' || result?.code === 'RECOMMENDATION_NOT_PENDING') settled = RECOMMENDATION_COPY.expired;
          else if (result?.code === 'RECOMMENDATION_NOT_LISTENING_SOURCE') settled = RECOMMENDATION_COPY.notSource;
        } catch {
          settled = null;
        } finally {
          button.setAttribute?.('aria-busy', 'false');
        }
        if (settled) {
          button.setAttribute?.('aria-disabled', 'true');
          button.textContent = '放这首';
          if (note) note.textContent = settled;
        } else {
          button.textContent = '再试一次';
          if (note) note.textContent = '这次没排上，队列没有变化，可以再试一次。';
        }
      });
    });
  }

  /**
   * 消息动作条：只用服务端落账的 turn（turn_ 前缀），乐观气泡与本地占位没有动作。
   * 引用对用户与助手消息都开放（引用哪一句都说得通）；编辑与分叉只属于用户自己的话。
   */
  function messageActionsHtml(turnId, { role = null, quoteText = '', hasJournalContent = false } = {}) {
    if (!/^turn_/.test(turnId)) return '';
    const buttons = [
      typeof onQuoteMessage === 'function' && quoteText
        ? '<button type="button" class="chat-msg-action" data-msg-action="quote">引用</button>' : '',
      typeof onSaveToJournal === 'function' && hasJournalContent
        ? '<button type="button" class="chat-msg-action" data-msg-action="journal">收进手帐</button>' : '',
      role === 'user' && typeof onEditMessage === 'function' ? '<button type="button" class="chat-msg-action" data-msg-action="edit">编辑</button>' : '',
      role === 'user' && typeof onForkMessage === 'function' ? '<button type="button" class="chat-msg-action" data-msg-action="fork">存为新聊天继续</button>' : '',
    ].join('');
    return buttons ? `<div class="chat-msg-actions">${buttons}</div>` : '';
  }

  /** 悬停或键盘聚焦时显示；触屏轻触气泡切换显示，不常驻占位。 */
  function bindMessageActions(element, turnId, quoteText = '', journalPayload = null) {
    const actions = element.querySelector?.('.chat-msg-actions');
    elementActionFlag.set(element, Boolean(actions));
    if (!actions) return;
    actions.querySelectorAll?.('[data-msg-action]')?.forEach(button => {
      button.addEventListener?.('click', event => {
        event?.stopPropagation?.();
        if (button.dataset?.msgAction === 'quote') { if (quoteText) onQuoteMessage?.(quoteText); }
        else if (button.dataset?.msgAction === 'journal') { if (journalPayload) onSaveToJournal?.(journalPayload); }
        else if (button.dataset?.msgAction === 'edit') onEditMessage(turnId);
        else onForkMessage(turnId);
      });
    });
  }

  function ensureElementClickBound(element, turnId) {
    if (turnId) elementTurnIds.set(element, turnId);
    const group = element.querySelector?.('.chat-beat-group');
    if (group && !boundBeatGroups.has(group)) {
      boundBeatGroups.add(group);
      group.addEventListener?.('click', event => {
        const tid = element.dataset?.turnId || elementTurnIds.get(element) || turnId;
        if (!tid || !activeBeatReveals.has(tid)) return;
        event?.stopPropagation?.();
        fastForwardTurn(tid);
      });
    }
    if (elementClickBound.has(element)) return;
    elementClickBound.add(element);
    element.addEventListener?.('click', event => {
      const tid = element.dataset?.turnId || elementTurnIds.get(element) || turnId;
      if (tid && activeBeatReveals.has(tid)) {
        fastForwardTurn(tid);
        return;
      }
      if (!elementActionFlag.get(element)) return;
      // 点歌卡、推荐卡这种自己带动作的元素不该顺手把动作条翻出来。
      if (event?.target?.closest?.('button:not(.chat-msg-action), a')) return;
      element.classList?.toggle?.('actions-open');
    });
  }

  function bindVoiceButton(root, turnId) {
    root?.querySelectorAll?.('.chat-voice-btn')?.forEach(button => {
      if (button.dataset?.voiceBound === '1') return;
      if (button.dataset) button.dataset.voiceBound = '1';
      button.addEventListener?.('click', event => {
        event?.stopPropagation?.();
        const note = button.parentElement?.querySelector?.('.chat-voice-note') || null;
        void onToggleTurnVoice?.({ turnId: button.dataset?.voiceTurn || turnId, button, note });
      });
    });
  }

  function findVoiceButton(turnId) {
    if (!turnId || !chatList?.querySelectorAll) return null;
    for (const button of chatList.querySelectorAll('.chat-voice-btn')) {
      if (button.dataset?.voiceTurn === turnId) return button;
    }
    return null;
  }

  function applyVoiceButtonState(button, { loading = false, hasAudio = null, noteText = null } = {}) {
    if (!button) return;
    const tid = button.dataset?.voiceTurn || '';
    if (typeof hasAudio === 'boolean' && button.dataset) {
      button.dataset.hasAudio = hasAudio ? '1' : '0';
    }
    button.setAttribute?.('aria-busy', loading ? 'true' : 'false');
    const effectiveHasAudio = button.dataset?.hasAudio === '1';
    const isPlaying = !loading && Boolean(tid && getPlayingTurnId?.() === tid);
    const nextState = loading ? 'loading' : isPlaying ? 'playing' : effectiveHasAudio ? 'ready' : 'idle';
    if (button.dataset) button.dataset.voiceState = nextState;
    button.textContent = loading ? '正在合成…' : isPlaying ? '■ 停止' : effectiveHasAudio ? '▶ 重听' : '生成语音';
    button.setAttribute?.('aria-pressed', isPlaying ? 'true' : 'false');
    button.setAttribute?.('aria-label', loading ? '正在合成这段语音' : isPlaying ? '停止播放这段语音' : effectiveHasAudio ? '重听这段语音' : '生成并播放这段语音');
    if (noteText !== null) {
      const note = button.parentElement?.querySelector?.('.chat-voice-note');
      if (note) note.textContent = noteText;
    }
  }

  function updateTurnVoiceButton(turnId, options = {}) {
    applyVoiceButtonState(findVoiceButton(turnId), options);
  }

  function syncSpeakingBeatDom(activeTurnId, activeBeatIndex) {
    const setBubbleSpeaking = (bubble, isMatch) => {
      if (!bubble) return;
      if (bubble.classList) {
        if (typeof bubble.classList.add === 'function' && typeof bubble.classList.remove === 'function') {
          if (isMatch) bubble.classList.add('is-speaking');
          else bubble.classList.remove('is-speaking');
        } else if (typeof bubble.classList.toggle === 'function') {
          const currently = Boolean(bubble.classList.contains?.('is-speaking'));
          if (currently !== isMatch) bubble.classList.toggle('is-speaking');
        }
      }
      if (bubble.dataset) {
        if (isMatch) bubble.dataset.speaking = '1';
        else delete bubble.dataset.speaking;
      }
    };
    for (const [tid, element] of turnElements.entries()) {
      element.querySelectorAll?.('.chat-beat-bubble')?.forEach(bubble => {
        const idx = Number(bubble.dataset?.beatIndex);
        const isMatch = Boolean(activeTurnId && tid === activeTurnId && Number.isInteger(activeBeatIndex) && idx === activeBeatIndex);
        setBubbleSpeaking(bubble, isMatch);
      });
    }
  }

  function syncPlayingBeat(activeTurnId = null, activeBeatIndex = null) {
    activeSpeakingTurnId = activeTurnId || null;
    activeSpeakingBeatIndex = Number.isInteger(activeBeatIndex) ? activeBeatIndex : null;
    syncSpeakingBeatDom(activeSpeakingTurnId, activeSpeakingBeatIndex);
  }

  function syncPlayingTurn(activeTurnId = null, activeBeatIndex = undefined) {
    activeSpeakingTurnId = activeTurnId || null;
    if (activeBeatIndex !== undefined) {
      activeSpeakingBeatIndex = Number.isInteger(activeBeatIndex) ? activeBeatIndex : null;
    } else if (!activeTurnId) {
      activeSpeakingBeatIndex = null;
    }
    chatList?.querySelectorAll?.('.chat-voice-btn')?.forEach(button => {
      const tid = button.dataset?.voiceTurn || '';
      if ((tid && isTurnVoiceLoading?.(tid)) || button.getAttribute?.('aria-busy') === 'true') return;
      const isPlaying = Boolean(activeTurnId && tid === activeTurnId);
      const hasAudio = button.dataset?.hasAudio === '1';
      const nextState = isPlaying ? 'playing' : hasAudio ? 'ready' : 'idle';
      if (button.dataset) button.dataset.voiceState = nextState;
      button.textContent = isPlaying ? '■ 停止' : hasAudio ? '▶ 重听' : '生成语音';
      button.setAttribute?.('aria-pressed', isPlaying ? 'true' : 'false');
      button.setAttribute?.('aria-label', isPlaying ? '停止播放这段语音' : hasAudio ? '重听这段语音' : '生成并播放这段语音');
    });
    syncSpeakingBeatDom(activeSpeakingTurnId, activeSpeakingBeatIndex);
  }

  function insertDateDivider(createdAt) {
    if (!createdAt) return;
    const label = formatChatDateDivider(createdAt, clock);
    if (!label || sameCalendarDay(createdAt, lastDividerDay)) return;
    lastDividerDay = createdAt;
    const divider = documentLike.createElement('div');
    divider.className = 'chat-date-divider';
    divider.textContent = label;
    chatList.appendChild(divider);
  }

  function resolveInteractionMode(payload, options) {
    if (payload?.interactionMode) return payload.interactionMode;
    const room = options?.room;
    if (room) {
      if (Array.isArray(room.memberIds) && room.memberIds.length > 1) return 'radio';
      if (room.interactionMode) return room.interactionMode;
    }
    return chatList?.dataset?.interactionMode || 'radio';
  }

  function renderTurnElementContent(element, payload, options = {}, { visibleBeatCount = null } = {}) {
    const {
      role, text, segments, beats = null, beatProgress = null, tracks,
      speakerVirtualPersonId = null, speakerName = '', turnId = null, createdAt = null,
      groupFloor = null, hostSuggestion = null, musicRecommendation = null, webSources = null, voice = null,
    } = payload;
    const { room = null, listening = false } = options;
    const stableTurnId = String(turnId || '').trim();
    const effectiveInteractionMode = resolveInteractionMode(payload, options);
    const resolvedSpeaker = role === 'assistant'
      ? (speakerName || getSpeakerName(speakerVirtualPersonId))
      : '';
    // 被邀请接话的伙伴标「回复 X」；关系来自 runtime 落账的 groupFloor，不从文本猜。
    const replyToName = role === 'assistant' && groupFloor?.role === 'invited' && groupFloor.fromPersonId
      ? getSpeakerName(groupFloor.fromPersonId) : '';
    // 「主持这一首」只在选歌真的交过来、且这位自己提交了音乐时出现。
    const floorAsk = replyToName && typeof groupFloor?.ask === 'string' ? groupFloor.ask : '';
    const hostsTrack = role === 'assistant' && groupFloor?.role === 'invited'
      && groupFloor.musicAuthority === 'transferred' && groupFloor.committedMusic === true;
    const beatsText = Array.isArray(beats)
      ? beats.map(beat => [beat?.action, beat?.say].filter(Boolean).join(' ')).filter(Boolean).join('\n')
      : '';
    const effectiveText = typeof text === 'string' && text.trim() ? text : beatsText;
    // 引用摘要只描述已落账的这条消息本身：不涉及队列、播放或其它 turn。
    const quoteText = typeof onQuoteMessage === 'function' && stableTurnId
      ? buildQuoteText({ role, speakerName: resolvedSpeaker, text: effectiveText, segments, tracks })
      : '';
    const journalText = effectiveText.trim()
      ? effectiveText.trim()
      : Array.isArray(segments)
        ? segments.map(segment => String(segment?.content || '')).join('\n').trim()
        : '';
    const firstTrack = Array.isArray(tracks) && tracks[0]?.title ? tracks[0] : null;
    const journalPayload = typeof onSaveToJournal === 'function' && stableTurnId && (journalText || firstTrack)
      ? {
        turnId: stableTurnId,
        role,
        speakerName: resolvedSpeaker || (role === 'user' ? '我' : 'Lunara'),
        text: journalText,
        track: firstTrack ? {
          provider: firstTrack.provider || 'qq',
          songId: String(firstTrack.songId ?? firstTrack.song_id ?? ''),
          title: String(firstTrack.title || ''),
          artist: String(firstTrack.artist || ''),
          album: String(firstTrack.album || ''),
        } : null,
        createdAt,
      }
      : null;
    const activeBeatIndex = stableTurnId && activeSpeakingTurnId === stableTurnId
      ? activeSpeakingBeatIndex
      : null;
    element.innerHTML = buildChatMessageHtml({
      role,
      text,
      segments,
      beats,
      beatProgress,
      interactionMode: effectiveInteractionMode,
      visibleBeatCount,
      activeBeatIndex,
      tracks,
      time: timeString(createdAt),
      speakerName: resolvedSpeaker,
      replyToName,
      hostsTrack,
      floorAsk,
      hostSuggestion: role === 'assistant' ? hostSuggestionView(hostSuggestion, room) : null,
      webSources: role === 'assistant' ? webSources : null,
      musicRecommendation: role === 'assistant' ? recommendationView(musicRecommendation, stableTurnId, listening) : null,
      voice: role === 'assistant' ? voice : null,
      turnId: stableTurnId,
      playingVoice: Boolean(stableTurnId && getPlayingTurnId?.() === stableTurnId),
      loadingVoice: Boolean(stableTurnId && isTurnVoiceLoading?.(stableTurnId)),
    }) + messageActionsHtml(stableTurnId, { role, quoteText, hasJournalContent: Boolean(journalPayload) });
    bindMessageActions(element, stableTurnId, quoteText, journalPayload);
    ensureElementClickBound(element, stableTurnId);
    bindVoiceButton(element, stableTurnId);
    bindTrackCards(element);
    bindHostSuggestion(element);
    bindRecommendation(element);
  }

  function expectedTotalBeats(payload) {
    const len = Array.isArray(payload?.beats) ? payload.beats.length : 0;
    const progressTotal = Number(payload?.beatProgress?.totalCount);
    if (payload?.beatProgress && payload.beatProgress.done === false && Number.isFinite(progressTotal) && progressTotal > len) {
      return Math.floor(progressTotal);
    }
    return len;
  }

  function hasAnyBeatAudio(payload) {
    if (Array.isArray(payload?.beats) && payload.beats.some(beat => Boolean(beat?.audioUrl))) return true;
    if (payload?.voice?.audioUrl || payload?.voice?.url) return true;
    if (Array.isArray(payload?.voice?.beats) && payload.voice.beats.some(beat => Boolean(beat?.audioUrl))) return true;
    return false;
  }

  function turnHasLiveAudio(turnId, payload) {
    if (typeof hasPendingTurnAudio === 'function') {
      return Boolean(hasPendingTurnAudio(turnId, payload));
    }
    return hasAnyBeatAudio(payload);
  }

  function scheduleNextBeatReveal(state, currentTime = now()) {
    const prevBeat = state.payload.beats?.[state.visibleCount - 1];
    const rawPause = Number(prevBeat?.pauseAfterMs);
    const delayMs = Number.isFinite(rawPause) && rawPause >= 0 ? rawPause : 350;
    if (!Number.isFinite(state.stepStartedAt)) state.stepStartedAt = currentTime;
    const elapsed = Math.max(0, currentTime - state.stepStartedAt);
    const remainingMs = Math.max(0, delayMs - elapsed);
    state.timer = setTimer(() => {
      state.timer = null;
      if (!activeBeatReveals.has(state.turnId)) return;
      const total = Array.isArray(state.payload.beats) ? state.payload.beats.length : 0;
      if (state.visibleCount >= total) {
        activeBeatReveals.delete(state.turnId);
        completedRevealTurnIds.add(state.turnId);
        return;
      }
      state.visibleCount += 1;
      state.stepStartedAt = now();
      const done = state.visibleCount >= total;
      renderTurnElementContent(state.element, state.payload, state.options, {
        visibleBeatCount: done ? null : state.visibleCount,
      });
      if (state.options?.scroll !== false) scrollBottom();
      if (done) {
        activeBeatReveals.delete(state.turnId);
        completedRevealTurnIds.add(state.turnId);
      } else {
        scheduleNextBeatReveal(state);
      }
    }, remainingMs);
  }

  function startBeatReveal(turnId, element, payload, options, { visibleCount = 1, unlockedCount = null, stepStartedAt = null, mode = 'timer' } = {}) {
    const existing = activeBeatReveals.get(turnId);
    if (existing?.timer != null) clearTimer(existing.timer);
    const loadedCount = Array.isArray(payload.beats) ? payload.beats.length : 0;
    const total = expectedTotalBeats(payload);
    const isStreamDone = !payload.beatProgress || payload.beatProgress.done !== false;
    if (mode === 'audio') {
      if (isStreamDone && !turnHasLiveAudio(turnId, payload)) {
        activeBeatReveals.delete(turnId);
        completedRevealTurnIds.add(turnId);
        maxStartedBeatCountByTurn.delete(turnId);
        renderTurnElementContent(element, payload, options, { visibleBeatCount: null });
        return;
      }
      const startedBound = maxStartedBeatCountByTurn.get(turnId) || 0;
      const effectiveUnlocked = Math.max(1, Number(unlockedCount) || Number(visibleCount) || 1, startedBound);
      if (isStreamDone && loadedCount >= total && effectiveUnlocked >= total) {
        activeBeatReveals.delete(turnId);
        completedRevealTurnIds.add(turnId);
        maxStartedBeatCountByTurn.delete(turnId);
        renderTurnElementContent(element, payload, options, { visibleBeatCount: null });
        return;
      }
      const clamped = Math.max(1, Math.min(Math.max(loadedCount, 1), effectiveUnlocked));
      const state = {
        turnId,
        element,
        payload,
        options,
        visibleCount: clamped,
        unlockedCount: effectiveUnlocked,
        stepStartedAt: null,
        mode: 'audio',
        timer: null,
      };
      activeBeatReveals.set(turnId, state);
      renderTurnElementContent(element, payload, options, { visibleBeatCount: clamped });
      return;
    }
    const clamped = Math.max(1, Math.min(loadedCount, Number(visibleCount) || 1));
    if (clamped >= loadedCount && isStreamDone) {
      activeBeatReveals.delete(turnId);
      completedRevealTurnIds.add(turnId);
      renderTurnElementContent(element, payload, options, { visibleBeatCount: null });
      return;
    }
    const state = {
      turnId,
      element,
      payload,
      options,
      visibleCount: clamped,
      unlockedCount: clamped,
      stepStartedAt: Number.isFinite(stepStartedAt) ? stepStartedAt : null,
      mode: 'timer',
      timer: null,
    };
    activeBeatReveals.set(turnId, state);
    renderTurnElementContent(element, payload, options, { visibleBeatCount: clamped });
    scheduleNextBeatReveal(state);
  }

  function advanceTurnReveal(turnId, nextVisibleCount = 1) {
    if (!turnId) return false;
    const count = Math.max(1, Math.floor(Number(nextVisibleCount) || 1));
    const prevStarted = maxStartedBeatCountByTurn.get(turnId) || 0;
    if (count > prevStarted) maxStartedBeatCountByTurn.set(turnId, count);
    const state = activeBeatReveals.get(turnId);
    if (!state) return false;
    state.unlockedCount = Math.max(state.unlockedCount || state.visibleCount || 1, count);
    const total = expectedTotalBeats(state.payload);
    const loadedCount = Array.isArray(state.payload.beats) ? state.payload.beats.length : 0;
    const isStreamDone = !state.payload.beatProgress || state.payload.beatProgress.done !== false;
    if (isStreamDone && loadedCount >= total && state.unlockedCount >= total) {
      return fastForwardTurn(turnId, { render: true });
    }
    const targetVisible = Math.max(state.visibleCount || 1, Math.min(Math.max(loadedCount, 1), state.unlockedCount));
    if (targetVisible !== state.visibleCount) {
      state.visibleCount = targetVisible;
      renderTurnElementContent(state.element, state.payload, state.options, { visibleBeatCount: targetVisible });
      if (state.options?.scroll !== false) scrollBottom();
    }
    return true;
  }

  function fastForwardTurn(turnId, { render = true } = {}) {
    const state = activeBeatReveals.get(turnId);
    if (!state) return false;
    if (state.timer != null) clearTimer(state.timer);
    activeBeatReveals.delete(turnId);
    completedRevealTurnIds.add(turnId);
    maxStartedBeatCountByTurn.delete(turnId);
    if (render) {
      renderTurnElementContent(state.element, state.payload, state.options, { visibleBeatCount: null });
    }
    return true;
  }

  function fastForwardAllReveals({ render = true } = {}) {
    for (const turnId of [...activeBeatReveals.keys()]) {
      fastForwardTurn(turnId, { render });
    }
  }

  function shouldAnimateRoleplayBeats(payload, options, { isLive = false } = {}) {
    if (!isLive || payload?.role !== 'assistant' || !payload?.turnId) return false;
    if (completedRevealTurnIds.has(payload.turnId)) return false;
    if (resolveInteractionMode(payload, options) !== 'roleplay') return false;
    return Array.isArray(payload.beats) && payload.beats.length > 1;
  }

  function shouldGateRadioBeats(payload, options, { isLive = false } = {}) {
    if (!narrationCoordinator?.subscribe) return false;
    if (!isLive || payload?.role !== 'assistant' || !payload?.turnId) return false;
    if (completedRevealTurnIds.has(payload.turnId)) return false;
    if (resolveInteractionMode(payload, options) === 'roleplay') return false;
    if (expectedTotalBeats(payload) <= 1) return false;
    return Boolean(payload.beatProgress && payload.beatProgress.done === false) || turnHasLiveAudio(payload.turnId, payload);
  }

  function normalizeTurnPayload(turn) {
    const turnId = String(turn?.turnId || '').trim() || null;
    return {
      role: turn.role,
      text: turn.text,
      segments: turn.segments || null,
      beats: Array.isArray(turn.beats) ? turn.beats : null,
      beatProgress: turn.beatProgress || null,
      interactionMode: turn.interactionMode || null,
      tracks: turn.tracks,
      turnId,
      createdAt: turn.createdAt,
      speakerVirtualPersonId: turn.speakerVirtualPersonId || null,
      speakerName: turn.speakerName || '',
      presentation: turn.presentation || null,
      groupFloor: turn.groupFloor || null,
      hostSuggestion: turn.hostSuggestion || null,
      musicRecommendation: turn.musicRecommendation || null,
      webSources: turn.webSources || null,
      voice: turn.voice || null,
    };
  }

  function append(turn, options = {}) {
    const { scroll = true, room = null, listening = false, live = false, resumeRevealState = null } = options;
    const payload = normalizeTurnPayload(turn);
    const stableTurnId = String(payload.turnId || '').trim();
    if (stableTurnId && renderedTurnIds.has(stableTurnId)) return null;
    chatList.querySelector?.('.chat-empty')?.remove?.();
    const element = documentLike.createElement('div');
    element.className = `chat-msg ${payload.role}`;
    if (stableTurnId) {
      element.dataset && (element.dataset.turnId = stableTurnId);
      renderedTurnIds.add(stableTurnId);
      turnElements.set(stableTurnId, element);
    }
    if (payload.speakerVirtualPersonId && element.dataset) {
      element.dataset.speakerId = payload.speakerVirtualPersonId;
    }
    // 主动开口与普通回复同样是她的气泡；只留一个样式钩子，不加标签、不另起状态。
    if (payload.presentation === 'presence' && element.dataset) element.dataset.presentation = 'presence';
    if (resumeRevealState && expectedTotalBeats(payload) > 1) {
      startBeatReveal(stableTurnId, element, payload, { scroll, room, listening }, resumeRevealState);
    } else if (shouldAnimateRoleplayBeats(payload, { room, listening }, { isLive: live })) {
      startBeatReveal(stableTurnId, element, payload, { scroll, room, listening }, { visibleCount: 1, mode: 'timer' });
    } else if (shouldGateRadioBeats(payload, { room, listening }, { isLive: live })) {
      startBeatReveal(stableTurnId, element, payload, { scroll, room, listening }, { visibleCount: 1, unlockedCount: 1, mode: 'audio' });
    } else {
      renderTurnElementContent(element, payload, { room, listening }, { visibleBeatCount: null });
    }
    chatList.appendChild(element);
    if (scroll) scrollBottom();
    return element;
  }

  function updateTurn(turn, { room = null, listening = false } = {}) {
    const payload = normalizeTurnPayload(turn);
    const stableTurnId = String(payload.turnId || '').trim();
    if (!stableTurnId) return null;
    const element = turnElements.get(stableTurnId);
    if (!element) {
      return append(turn, { scroll: true, room, listening, live: Boolean(turn?.__liveArrival) });
    }
    const activeReveal = activeBeatReveals.get(stableTurnId);
    if (activeReveal) {
      activeReveal.payload = payload;
      activeReveal.options = { ...activeReveal.options, room, listening };
      if (activeReveal.mode === 'audio') {
        const isStreamDone = !payload.beatProgress || payload.beatProgress.done !== false;
        const total = expectedTotalBeats(payload);
        const loadedCount = Array.isArray(payload.beats) ? payload.beats.length : 0;
        const startedBound = maxStartedBeatCountByTurn.get(stableTurnId) || 0;
        activeReveal.unlockedCount = Math.max(activeReveal.unlockedCount || 1, startedBound);
        if ((isStreamDone && !turnHasLiveAudio(stableTurnId, payload))
          || (isStreamDone && loadedCount >= total && activeReveal.unlockedCount >= total)) {
          fastForwardTurn(stableTurnId, { render: true });
        } else {
          activeReveal.visibleCount = Math.max(
            activeReveal.visibleCount || 1,
            Math.min(Math.max(loadedCount, 1), activeReveal.unlockedCount),
          );
          renderTurnElementContent(element, payload, { room, listening }, { visibleBeatCount: activeReveal.visibleCount });
        }
      } else {
        renderTurnElementContent(element, payload, { room, listening }, { visibleBeatCount: activeReveal.visibleCount });
      }
    } else {
      renderTurnElementContent(element, payload, { room, listening }, { visibleBeatCount: null });
    }
    return element;
  }

  function appendWithDivider(turn, options = {}) {
    if (turn?.role === 'user') fastForwardAllReveals({ render: true });
    insertDateDivider(turn?.createdAt);
    return append(turn, { ...options, live: options.live !== false });
  }

  function replaceTranscript(turns = [], { scroll = true, room = null, listening = false, live = null } = {}) {
    const nextRoomId = room?.sessionId || null;
    const roomSwitched = nextRoomId !== currentRoomId;
    if (roomSwitched) {
      fastForwardAllReveals({ render: false });
      seenTurnIds.clear();
      currentRoomId = nextRoomId;
    }
    const visible = (Array.isArray(turns) ? turns : [])
      .filter(turn => turn?.role === 'user' || turn?.role === 'assistant')
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
    const fromHistoryLoad = Boolean(turns?.__fromHistoryLoad) || live === false;
    const wasHydrated = nextRoomId ? hydratedRoomIds.has(nextRoomId) : renderedTurnIds.size > 0;
    if (wasHydrated && activeBeatReveals.size) {
      for (const revealingTurnId of [...activeBeatReveals.keys()]) {
        const revealIdx = visible.findIndex(turn => turn.turnId === revealingTurnId);
        const interruptedByLaterUser = revealIdx >= 0 && visible.some(
          (turn, idx) => idx > revealIdx && turn.role === 'user' && turn.turnId && !seenTurnIds.has(turn.turnId),
        );
        if (interruptedByLaterUser || revealIdx < 0) {
          fastForwardTurn(revealingTurnId, { render: false });
        }
      }
    }
    const preservedReveals = new Map();
    if (!roomSwitched) {
      for (const [tid, revealState] of activeBeatReveals.entries()) {
        if (revealState.timer != null) clearTimer(revealState.timer);
        preservedReveals.set(tid, {
          visibleCount: revealState.visibleCount,
          unlockedCount: revealState.unlockedCount,
          stepStartedAt: revealState.stepStartedAt,
          mode: revealState.mode,
        });
      }
      activeBeatReveals.clear();
    }
    renderedTurnIds.clear();
    turnElements.clear();
    chatList.innerHTML = '';
    lastDividerDay = null;
    if (!visible.length) {
      chatList.innerHTML = '<div class="chat-empty"><span class="chat-empty-signal" aria-hidden="true"></span><strong>这一段对话还没有开始</strong><span>随便说点什么，Lunara 会从这里一直记下去。</span></div>';
      if (nextRoomId && fromHistoryLoad) hydratedRoomIds.add(nextRoomId);
      return 0;
    }
    for (const turn of visible) {
      const turnId = String(turn.turnId || '').trim() || null;
      const resumeRevealState = turnId && preservedReveals.has(turnId) ? preservedReveals.get(turnId) : null;
      const turnIsLive = live === true
        || Boolean(turn?.__liveArrival)
        || (!fromHistoryLoad && wasHydrated && Boolean(turnId && !seenTurnIds.has(turnId)));
      insertDateDivider(turn.createdAt);
      append(turn, { scroll, room, listening, live: turnIsLive, resumeRevealState });
      if (turnId) seenTurnIds.add(turnId);
    }
    if (nextRoomId && (visible.length > 0 || fromHistoryLoad)) hydratedRoomIds.add(nextRoomId);
    return visible.length;
  }

  const unsubscribeNarration = narrationCoordinator?.subscribe?.(event => {
    const task = event?.task;
    if (!task || task.lane === 'runtime' || task.meta?.kind === 'turn_voice') return;
    const turnId = defaultTaskTurnId(task);
    if (!turnId) return;
    if (event.type === 'started') {
      const beatIdx = defaultTaskBeatIndex(task);
      if (Number.isInteger(beatIdx)) advanceTurnReveal(turnId, beatIdx + 1);
    } else if (event.type === 'cancelled' || event.type === 'error') {
      fastForwardTurn(turnId, { render: true });
    } else if (event.type === 'finished') {
      const item = task.meta?.item;
      const isLast = item ? (item.isLastBeat !== false && !item.holdDuckLease)
        : (task.meta?.isLastBeat !== false && !task.meta?.holdDuckLease);
      if (isLast) fastForwardTurn(turnId, { render: true });
    }
  }) || (() => {});

  function destroy() {
    unsubscribeNarration();
    for (const state of activeBeatReveals.values()) {
      if (state.timer != null) clearTimer(state.timer);
    }
    activeBeatReveals.clear();
    maxStartedBeatCountByTurn.clear();
  }

  return Object.freeze({
    replaceTranscript,
    scrollBottom,
    appendWithDivider,
    updateTurn,
    syncPlayingTurn,
    syncPlayingBeat,
    updateTurnVoiceButton,
    advanceTurnReveal,
    fastForwardTurn,
    fastForwardAllReveals,
    destroy,
  });
}

function defaultTaskTurnId(task) {
  return task?.meta?.sourceTurnId || task?.meta?.item?.sourceTurnId || null;
}

function defaultTaskBeatIndex(task) {
  const idx = task?.meta?.beatIndex ?? task?.meta?.item?.beatIndex;
  return Number.isInteger(idx) ? idx : null;
}

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

function buildOrderedPlayableBeats(turnData, synthResult = null) {
  const beats = Array.isArray(turnData?.beats) && turnData.beats.length
    ? turnData.beats
    : (Array.isArray(synthResult?.beats) && synthResult.beats.length ? synthResult.beats : null);
  if (!beats) return [];
  const voiceBeats = Array.isArray(turnData?.voice?.beats)
    ? turnData.voice.beats
    : (Array.isArray(synthResult?.beats) ? synthResult.beats : null);
  const items = [];
  let pendingDelayMs = 0;
  for (let i = 0; i < beats.length; i += 1) {
    const beat = beats[i] || {};
    const beatIndex = Number.isInteger(beat.index) ? beat.index : i;
    const rawPause = Number(beat.pauseAfterMs);
    const pauseAfterMs = Number.isFinite(rawPause) && rawPause > 0 ? rawPause : 0;
    const projected = findProjectedVoiceBeat(voiceBeats, beat, i);
    if (projected?.canSynthesize === false || beat?.canSynthesize === false) {
      pendingDelayMs += pauseAfterMs;
      continue;
    }
    const url = beat.audioUrl || projected?.audioUrl || null;
    if (url) {
      items.push({
        beatIndex,
        url,
        durationMs: beat.durationMs ?? projected?.durationMs ?? null,
        text: beat.say || '',
        delayBeforeMs: items.length > 0 ? pendingDelayMs : 0,
      });
      pendingDelayMs = pauseAfterMs;
    } else {
      pendingDelayMs += pauseAfterMs;
    }
  }
  return items;
}

function turnNeedsSynthesis(turnData) {
  if (!turnData) return true;
  if (Array.isArray(turnData.beats) && turnData.beats.length > 0) {
    const voiceBeats = Array.isArray(turnData.voice?.beats) ? turnData.voice.beats : null;
    const speakable = [];
    for (let i = 0; i < turnData.beats.length; i += 1) {
      const beat = turnData.beats[i];
      if (isSpeakableBeat(beat, i, voiceBeats)) {
        speakable.push({ beat, projected: findProjectedVoiceBeat(voiceBeats, beat, i) });
      }
    }
    if (speakable.length > 0) {
      return speakable.some(({ beat, projected }) => !Boolean(beat?.audioUrl || projected?.audioUrl));
    }
    if (turnData.voice?.canSynthesize === false) return false;
  }
  return !Boolean(turnData?.voice?.audioUrl || turnData?.voice?.url);
}

/**
 * 协调多拍组的单一语音按钮按需合成、缓存重听、中断停止与 Turn Ducking Lease 元数据。
 */
export function createTurnVoicePlayer({
  getTurn,
  synthesizeTurnSpeech,
  touchTurnSpeech = null,
  chatController = null,
  getChatController = () => chatController,
  narrationCoordinator,
  clearStream = null,
} = {}) {
  if (!narrationCoordinator?.enqueue || !narrationCoordinator?.cancel) {
    throw new TypeError('createTurnVoicePlayer requires narrationCoordinator');
  }
  let activeTurnVoiceId = null;
  const loadingVoiceTurnIds = new Set();
  const pendingTokensByTurn = new Map();
  const resolveChat = () => getChatController?.() || chatController;

  const unsubscribe = narrationCoordinator.subscribe?.(event => {
    const tid = defaultTaskTurnId(event?.task);
    const beatIdx = defaultTaskBeatIndex(event?.task);
    if (event?.type === 'started') {
      activeTurnVoiceId = tid || null;
      resolveChat()?.syncPlayingTurn?.(activeTurnVoiceId, beatIdx);
    } else if (['finished', 'cancelled', 'error'].includes(event?.type)) {
      if (tid && pendingTokensByTurn.has(tid)) {
        const set = pendingTokensByTurn.get(tid);
        if (event?.task?.token != null) set.delete(event.task.token);
        if (set.size > 0) {
          activeTurnVoiceId = tid;
          resolveChat()?.syncPlayingTurn?.(tid, null);
          return;
        }
        pendingTokensByTurn.delete(tid);
      }
      if (tid && activeTurnVoiceId === tid) activeTurnVoiceId = null;
      resolveChat()?.syncPlayingTurn?.(activeTurnVoiceId, null);
    }
  }) || (() => {});

  async function toggleTurnVoice({ turnId } = {}) {
    if (!turnId) return;
    if (activeTurnVoiceId === turnId) {
      pendingTokensByTurn.delete(turnId);
      narrationCoordinator.cancel(task => defaultTaskTurnId(task) === turnId, 'user-stopped');
      activeTurnVoiceId = null;
      resolveChat()?.syncPlayingTurn?.(null, null);
      return;
    }
    if (loadingVoiceTurnIds.has(turnId)) return;
    clearStream?.();
    resolveChat()?.fastForwardTurn?.(turnId);
    narrationCoordinator.cancel(task => task.lane === 'foreground', 'user-voice-switch');
    let turn = getTurn?.(turnId) || null;
    loadingVoiceTurnIds.add(turnId);
    resolveChat()?.updateTurnVoiceButton?.(turnId, { loading: true, noteText: '' });
    try {
      let synthResult = null;
      let shouldSynthesize = turnNeedsSynthesis(turn);
      if (!shouldSynthesize && typeof touchTurnSpeech === 'function') {
        const touched = await touchTurnSpeech(turnId);
        turn = getTurn?.(turnId) || turn;
        if (touched?.exists === false) shouldSynthesize = true;
      }
      if (shouldSynthesize) {
        synthResult = await synthesizeTurnSpeech(turnId);
        turn = getTurn?.(turnId) || turn;
      }
      const playableBeats = buildOrderedPlayableBeats(turn, synthResult);
      const fallbackUrl = turn?.voice?.audioUrl || synthResult?.audioUrl || null;
      if (!playableBeats.length && !fallbackUrl) {
        throw new Error('语音服务暂未就绪，请稍后再试。');
      }
      loadingVoiceTurnIds.delete(turnId);
      resolveChat()?.updateTurnVoiceButton?.(turnId, { loading: false, hasAudio: true, noteText: '' });

      const tokens = new Set();
      pendingTokensByTurn.set(turnId, tokens);
      activeTurnVoiceId = turnId;
      resolveChat()?.syncPlayingTurn?.(turnId, null);
      const stamp = Date.now();
      if (playableBeats.length) {
        for (let i = 0; i < playableBeats.length; i += 1) {
          const item = playableBeats[i];
          const isLastBeat = i === playableBeats.length - 1;
          const token = narrationCoordinator.enqueue({
            id: `turn-voice:${turnId}:beat:${item.beatIndex}:${stamp}`,
            lane: 'foreground',
            url: item.url,
            delayBeforeMs: item.delayBeforeMs,
            meta: {
              kind: 'turn_voice',
              sourceTurnId: turnId,
              beatIndex: item.beatIndex,
              beatCount: playableBeats.length,
              isLastBeat,
              turnDuckLeaseId: turnId,
              holdDuckLease: !isLastBeat,
              durationMs: item.durationMs,
              text: item.text,
            },
            onError: () => {
              resolveChat()?.updateTurnVoiceButton?.(turnId, {
                loading: false,
                hasAudio: true,
                noteText: '这段语音暂时放不出来，再试一次。',
              });
            },
          });
          if (token != null) tokens.add(token);
        }
      } else {
        const token = narrationCoordinator.enqueue({
          id: `turn-voice:${turnId}:${stamp}`,
          lane: 'foreground',
          url: fallbackUrl,
          meta: {
            kind: 'turn_voice',
            sourceTurnId: turnId,
            isLastBeat: true,
            turnDuckLeaseId: turnId,
            holdDuckLease: false,
            durationMs: turn?.voice?.durationMs ?? synthResult?.durationMs ?? null,
            text: turn?.text || '',
          },
          onError: () => {
            resolveChat()?.updateTurnVoiceButton?.(turnId, {
              loading: false,
              hasAudio: true,
              noteText: '这段语音暂时放不出来，再试一次。',
            });
          },
        });
        if (token != null) tokens.add(token);
      }
      if (!tokens.size) {
        pendingTokensByTurn.delete(turnId);
        activeTurnVoiceId = null;
        resolveChat()?.syncPlayingTurn?.(null, null);
      }
    } catch (error) {
      loadingVoiceTurnIds.delete(turnId);
      pendingTokensByTurn.delete(turnId);
      if (activeTurnVoiceId === turnId) activeTurnVoiceId = null;
      resolveChat()?.updateTurnVoiceButton?.(turnId, {
        loading: false,
        hasAudio: !turnNeedsSynthesis(getTurn?.(turnId)),
        noteText: error?.message || '这次语音合成没有成功，稍后再试一次。',
      });
    }
  }

  return Object.freeze({
    toggleTurnVoice,
    getPlayingTurnId: () => activeTurnVoiceId,
    isTurnVoiceLoading: turnId => loadingVoiceTurnIds.has(turnId),
    destroy() {
      unsubscribe();
      pendingTokensByTurn.clear();
      loadingVoiceTurnIds.clear();
      activeTurnVoiceId = null;
    },
  });
}
