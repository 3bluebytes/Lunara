import { buildChatMessageHtml, RECOMMENDATION_COPY } from './chatMarkup.js';
import { buildQuoteText } from './chatQuote.js';

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
  // 用户消息的「编辑」「从这里分叉」（add-chat-edit-and-fork）：回调收到 turnId；未注入就不显示按钮。
  onEditMessage = null,
  onForkMessage = null,
  // 消息的「引用」（add-chat-message-quote）：回调收到已经拼好的引用行（不含 `> `），
  // 由输入框负责写进草稿；未注入就不显示按钮。
  onQuoteMessage = null,
  now = () => Date.now(),
} = {}) {
  if (!chatList) throw new TypeError('chat list is required');
  const renderedTurnIds = new Set();
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
  function messageActionsHtml(turnId, { role = null, quoteText = '' } = {}) {
    if (!/^turn_/.test(turnId)) return '';
    const buttons = [
      typeof onQuoteMessage === 'function' && quoteText
        ? '<button type="button" class="chat-msg-action" data-msg-action="quote">引用</button>' : '',
      role === 'user' && typeof onEditMessage === 'function' ? '<button type="button" class="chat-msg-action" data-msg-action="edit">编辑</button>' : '',
      role === 'user' && typeof onForkMessage === 'function' ? '<button type="button" class="chat-msg-action" data-msg-action="fork">从这里分叉</button>' : '',
    ].join('');
    return buttons ? `<div class="chat-msg-actions">${buttons}</div>` : '';
  }

  /** 悬停或键盘聚焦时显示；触屏轻触气泡切换显示，不常驻占位。 */
  function bindMessageActions(element, turnId, quoteText = '') {
    const actions = element.querySelector?.('.chat-msg-actions');
    if (!actions) return;
    actions.querySelectorAll?.('[data-msg-action]')?.forEach(button => {
      button.addEventListener?.('click', event => {
        event?.stopPropagation?.();
        if (button.dataset?.msgAction === 'quote') { if (quoteText) onQuoteMessage?.(quoteText); }
        else if (button.dataset?.msgAction === 'edit') onEditMessage(turnId);
        else onForkMessage(turnId);
      });
    });
    element.addEventListener?.('click', event => {
      // 点歌卡、推荐卡这种自己带动作的元素不该顺手把动作条翻出来。
      if (event?.target?.closest?.('button:not(.chat-msg-action), a')) return;
      element.classList?.toggle?.('actions-open');
    });
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

  function append({ role, text, segments, tracks, speakerVirtualPersonId = null, speakerName = '', turnId = null, createdAt = null,
    presentation = null, groupFloor = null, hostSuggestion = null, musicRecommendation = null, webSources = null },
  { scroll = true, room = null, listening = false } = {}) {
    const stableTurnId = String(turnId || '').trim();
    if (stableTurnId && renderedTurnIds.has(stableTurnId)) return null;
    chatList.querySelector?.('.chat-empty')?.remove?.();
    const element = documentLike.createElement('div');
    element.className = `chat-msg ${role}`;
    if (stableTurnId) {
      element.dataset && (element.dataset.turnId = stableTurnId);
      renderedTurnIds.add(stableTurnId);
    }
    if (speakerVirtualPersonId && element.dataset) element.dataset.speakerId = speakerVirtualPersonId;
    // 主动开口与普通回复同样是她的气泡；只留一个样式钩子，不加标签、不另起状态。
    if (presentation === 'presence' && element.dataset) element.dataset.presentation = 'presence';
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
    // 引用摘要只描述已落账的这条消息本身：不涉及队列、播放或其它 turn。
    const quoteText = typeof onQuoteMessage === 'function' && stableTurnId
      ? buildQuoteText({ role, speakerName: resolvedSpeaker, text, segments, tracks })
      : '';
    element.innerHTML = buildChatMessageHtml({
      role,
      text,
      segments,
      tracks,
      time: timeString(createdAt),
      speakerName: resolvedSpeaker,
      replyToName,
      hostsTrack,
      floorAsk,
      hostSuggestion: role === 'assistant' ? hostSuggestionView(hostSuggestion, room) : null,
      webSources: role === 'assistant' ? webSources : null,
      musicRecommendation: role === 'assistant' ? recommendationView(musicRecommendation, stableTurnId, listening) : null,
    }) + messageActionsHtml(stableTurnId, { role, quoteText });
    chatList.appendChild(element);
    bindMessageActions(element, stableTurnId, quoteText);
    bindTrackCards(element);
    bindHostSuggestion(element);
    bindRecommendation(element);
    if (scroll) scrollBottom();
    return element;
  }

  function appendWithDivider(turn, options = {}) {
    insertDateDivider(turn?.createdAt);
    return append(turn, options);
  }

  function replaceTranscript(turns = [], { scroll = true, room = null, listening = false } = {}) {
    renderedTurnIds.clear();
    chatList.innerHTML = '';
    lastDividerDay = null;
    const visible = (Array.isArray(turns) ? turns : [])
      .filter(turn => turn?.role === 'user' || turn?.role === 'assistant')
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
    if (!visible.length) {
      chatList.innerHTML = '<div class="chat-empty"><span class="chat-empty-signal" aria-hidden="true"></span><strong>这一段对话还没有开始</strong><span>随便说点什么，Lunara 会从这里一直记下去。</span></div>';
      return 0;
    }
    for (const turn of visible) {
      const turnId = String(turn.turnId || '').trim() || null;
      insertDateDivider(turn.createdAt);
      append({
        role: turn.role,
        text: turn.text,
        tracks: turn.tracks,
        turnId,
        createdAt: turn.createdAt,
        speakerVirtualPersonId: turn.speakerVirtualPersonId || null,
        presentation: turn.presentation || null,
        groupFloor: turn.groupFloor || null,
        hostSuggestion: turn.hostSuggestion || null,
        musicRecommendation: turn.musicRecommendation || null,
        webSources: turn.webSources || null,
      }, { scroll, room, listening });
    }
    return visible.length;
  }

  return Object.freeze({ replaceTranscript, scrollBottom, appendWithDivider });
}
