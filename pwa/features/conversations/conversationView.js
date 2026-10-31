import { escapeHtml as esc } from '../chat/chatMarkup.js';
import { splitLeadingQuote } from '../chat/chatQuote.js';
import { ROOT_VIRTUAL_PERSON_ID } from '../radiohost/radiohostController.js';
import { deriveConversationGroups, deriveConversationPresentation, deriveCurrentTrackIntroduction } from './conversationPresentation.js';
import { APP_ICON, COVER_FALLBACK, applyArtwork } from '../playback/artworkImage.js';
import { colorFor, identityDots, wallTime, queueEstimates, deliveredTime, acquaintanceDays, dateLabel } from '../../visuals/cikePresentation.js';

// 歌在放、但这一轮没有生成串词时的一句话（已定稿，改文案先问产品）。
// 它既不是开场白，也不是「还没有播放记录」：「只听歌」「偶尔介绍」本来就会有
// 整首不插话的歌，留白是正常态。所以这几句话只说「这一首留白、你听着」，
// 不解释成异常，也不提陪伴模式或系统。
const NO_NARRATION_LINE = '这首留白，剩下的交给耳朵。';

// 真的没有在放的歌时的开场白。不能说「还没有播放记录」：这句话在真的没放过歌的
// 新聊天里成立，在「听完了一轮、队列空了」或正在浏览别的聊天时就是假话。
const NO_TRACK_OPENING = '这里还没有在放的歌。告诉我你此刻的心情，或者直接说一首想听的歌，我们就从这里开始。';

// 侧栏导航的全部目标：rooms 之外的每一项都是并列的页面，互斥切换。
const NAV_MODES = ['people', 'today', 'settings'];
// 整页工作区：这些目标会接管主内容区，让聊天/聆听面板让位。
const WORKSPACE_MODES = ['today', 'settings'];

// 思考档位的显示名与「模型支持哪些档位」：优先 Provider 声明，其次已证实旋钮；
// 没有信息时只提供「跟随模型默认」，不硬套一组滑块。
const ROOM_EFFORT_LABELS = Object.freeze({
  none: '关闭', minimal: '最小', low: '低', medium: '中', high: '高',
  xhigh: '很高', max: '最高', ultra: '超高',
});
const roomEffortLabel = level => ROOM_EFFORT_LABELS[level] || String(level || '');
function roomEffortLevels(provider, model) {
  const declared = provider?.modelInfo?.[model]?.reasoningEfforts;
  if (Array.isArray(declared) && declared.length) return declared;
  const knob = provider?.capabilities?.[model]?.thinking?.budgetKnob;
  if (knob === 'reasoning_effort') return ['low'];
  if (knob === 'thinking_budget') return ['low', 'medium', 'high'];
  return [];
}

export function validateRoomTitle(value) {
  const title = String(value ?? '').trim();
  if (!title) return { valid: false, error: '请填写聊天名称。' };
  if (title.length > 80) return { valid: false, error: '聊天名称不能超过 80 个字符。' };
  if (/[\u0000-\u001f\u007f]/u.test(title)) return { valid: false, error: '聊天名称中不能包含控制字符。' };
  return { valid: true, title };
}

export function createConversationView({ controller, store, apiClient, chatController, chatInputView,
  playbackRuntimeClient, documentLike = document, onError = () => {}, onBrowse = () => {}, onTodayOpen = null,
  onSettingsOpen = null, onSettingsClose = null, sidebarPresentation = null } = {}) {
  const options = { onTodayOpen, onSettingsOpen, onSettingsClose };
  const $ = selector => documentLike.querySelector(selector);
  const cleanups = [];
  let filter = '', showArchived = false, pickerMode = 'create', shownId = null, shownLastTurnId = null, rendered = '', personDetailId = null;
  let navMode = 'rooms', listenAfterCreate = false, creatingRoom = false;
  let settingsVisible = false;
  // 会话模型/思考档选择器共享的最近一次注册表读取（开关选项要按所选模型刷新）。
  let roomModelRegistry = { providers: [], override: null };
  // 行内会话管理：菜单只允许一个实例，撤销条只保留最近一次归档；分组折叠是纯视图状态。
  let menuSid = null, menuTrigger = null, renameSid = null, deleteSid = null, undoSid = null, undoTimer = null;
  const collapsedGroups = new Set();
  const name = person => person?.displayName || person?.id || 'Lunara';
  const on = (selector, type, fn) => {
    const element = typeof selector === 'string' ? $(selector) : selector;
    if (!element) return;
    const wrapped = event => {
      try { return Promise.resolve(fn(event)).catch(onError); }
      catch (error) { onError(error); return undefined; }
    };
    element.addEventListener(type, wrapped); cleanups.push(() => element.removeEventListener(type, wrapped));
  };
  const avatar = ids => `<span class="person-avatar ${ids.length > 1 ? 'group' : ''}">${identityDots(ids)}</span>`;
  // 布局习惯由主题 token 声明（见各主题 tokens.css），共享代码不按主题 id 分支：
  //   --shell-sidebar: pinned       宽屏下侧栏常驻展开；
  //                    collapsible  保留列表，但展开由独立 presentation adapter 管理；
  //   --shell-person: page     人物详情以页面而不是模态框打开。
  const shellToken = token => String(documentLike.defaultView?.getComputedStyle?.(documentLike.documentElement)?.getPropertyValue?.(token) || '').trim();
  const pinnedSidebar = () => shellToken('--shell-sidebar') === 'pinned' && !documentLike.defaultView?.matchMedia('(max-width: 960px)').matches;
  // 常驻侧栏不收起：导航切换、重复点击当前页、打开歌曲整理都只走这一个入口。
  const collapseSidebar = (options = {}) => {
    if (sidebarPresentation?.collapse(options)) return;
    if (!pinnedSidebar()) $('.conversation-sidebar')?.classList?.remove?.('expanded');
  };
  let listeningStartedAt = null;
  let listeningStartedFor = null;
  let personReturnFocus = null;
  function renderMoment() {
    const now = Date.now();
    const view = presentation();
    const { runtime, listeningRoom, focusedRoom, focusedListeningRuntime } = view;
    if (listeningStartedFor !== runtime?.activeListeningSessionId) {
      listeningStartedFor = runtime?.activeListeningSessionId;
      listeningStartedAt = null;
    }
    if (listeningStartedAt == null && runtime?.phase === 'playing') listeningStartedAt = now;
    const setText = (id, text) => { const node = $(id); if (node) node.textContent = text; };
    setText('#focus-clock', wallTime(now));
    const ids = focusedRoom?.memberIds || [];
    const liveId = view.focusedListeningPerson?.id;
    const companion = $('#listening-companion-dots');
    if (companion) companion.innerHTML = identityDots(ids, focusedRoom?.sessionId === runtime?.activeListeningSessionId && runtime?.phase === 'playing' ? liveId : null);
    setText('#listening-company', ids.length > 1 ? `有 ${ids.length} 位伙伴在这里。` : '有人陪你听。');
    setText('#listening-elapsed', listeningStartedAt != null && focusedRoom?.sessionId === runtime?.activeListeningSessionId
      ? `本次打开后，已经一起听了 ${Math.floor((now - listeningStartedAt) / 60000)} 分钟` : '从一首歌开始');
    const focusCompany = $('#focus-company');
    if (focusCompany) focusCompany.innerHTML = listeningRoom
      ? `${identityDots(listeningRoom.memberIds, runtime?.phase === 'playing' ? view.listeningPerson?.id : null)} 你和 ${esc(listeningRoom.memberIds.map(id => name(controller.person(id))).join('、'))} 在听`
      : '从一首歌开始';
    const caption = $('#cike-player-caption');
    if (caption) caption.innerHTML = view.track && listeningRoom
      ? `${identityDots(listeningRoom.memberIds)} 你和 ${esc(listeningRoom.memberIds.map(id => name(controller.person(id))).join('、'))} 在听` : '从一首歌开始';
    // 双行波形下行（伙伴声音）用当前在听这一首的伙伴颜色；没有在听的伙伴就退回主题强调色。
    const speakerId = view.listeningPerson?.id;
    $('.persistent-player')?.style?.[speakerId ? 'setProperty' : 'removeProperty']?.('--player-speaker', ...(speakerId ? [colorFor(speakerId)] : []));
    const estimates = queueEstimates(focusedListeningRuntime?.queue, focusedListeningRuntime?.currentIndex,
      focusedListeningRuntime?.positionSeconds, now);
    const upcoming = view.focusedQueueItems.filter(entry => entry.state === 'upcoming').slice(0, 12);
    const nextList = $('#listening-next-queue');
    if (nextList) nextList.innerHTML = upcoming.map(({item}) => {
      const candidateSpeakerId = item.narration?.speakerVirtualPersonId || item.virtualPersonId;
      const speakerId = controller.person(candidateSpeakerId) ? candidateSpeakerId : null;
      const at = estimates.get(item.queueItemId);
      return `<div class="cike-queue-row"><time>${at != null ? `约 ${wallTime(at)}` : '稍后'}</time><span><strong>${esc(item.title || '未知歌曲')}</strong><small>${esc(item.artist || '')}</small></span>${speakerId ? `<span class="cike-queue-speaker" title="${esc(name(controller.person(speakerId)))} 的曲目">${identityDots([speakerId])} ${esc(name(controller.person(speakerId)))}</span>` : '<span></span>'}<time>${Number(item.duration) > 0 ? `${Math.floor(Number(item.duration) / 60)}:${String(Math.floor(Number(item.duration) % 60)).padStart(2, '0')}` : '—'}</time></div>`;
    }).join('') || '<p class="sb-empty">下一首还在路上</p>';
    const actualEstimates = queueEstimates(runtime?.queue, runtime?.currentIndex, runtime?.positionSeconds, now);
    const next = view.queueItems.find(entry => entry.state === 'upcoming')?.item;
    setText('#focus-next-track', next ? `${actualEstimates.has(next.queueItemId) ? `约 ${wallTime(actualEstimates.get(next.queueItemId))} · ` : ''}接下来 · ${next.title || '下一首'}` : '此刻，就听这一首。');
    for (const message of documentLike.querySelectorAll?.('.chat-msg[data-speaker-id]') || []) {
      message.style?.setProperty?.('--person-color', colorFor(message.dataset.speakerId));
    }
  }
  const rememberView = () => controller.saveView({ draft: $('#compose-input').value, scroll: $('#chat-scroll').scrollTop });
  function presentation() {
    const snapshot = controller.snapshot();
    const app = store.getState();
    return deriveConversationPresentation({
      rooms: snapshot.rooms,
      focusedRoom: snapshot.room,
      persons: app.virtualPersons || [],
      runtime: app.runtimeState,
    });
  }
  function renderNavigation() {
    const sidebar = $('.conversation-sidebar');
    sidebar?.classList.toggle('people-mode', navMode === 'people');
    const peopleList = $('#people-list');
    if (peopleList) peopleList.hidden = navMode !== 'people';
    // 人物列表自带标题与「新增伙伴」入口：只在人物页出现，和聊天标题互斥。
    const peopleHeading = $('#people-list-heading');
    if (peopleHeading) peopleHeading.hidden = navMode !== 'people';
    const todayPanel = $('#today-panel');
    if (todayPanel) todayPanel.hidden = navMode !== 'today';
    // 设置是同一批并列页面之一：由导航决定显隐，而不是自己压在别的页面上。
    const settingsPanel = $('#settings-panel');
    if (settingsPanel) settingsPanel.hidden = navMode !== 'settings';
    const leftSettings = settingsVisible && navMode !== 'settings';
    settingsVisible = navMode === 'settings';
    if (leftSettings) options.onSettingsClose?.();
    const workspaceOpen = WORKSPACE_MODES.includes(navMode);
    $('#app')?.classList?.toggle('today-open', navMode === 'today');
    $('#app')?.classList?.toggle('settings-open', navMode === 'settings');
    for (const selector of ['#listening-panel', '#main-content']) {
      const content = $(selector);
      if (content) content.hidden = workspaceOpen;
    }
    const roomList = $('#room-list');
    const roomSearch = $('.room-search-label');
    const roomHeading = $('#room-list-heading');
    // 常驻侧栏和独立可收缩侧栏在帐本/设置页也保留列表，实际显隐交给各自的表现层。
    const hideRooms = workspaceOpen && !['pinned', 'collapsible'].includes(shellToken('--shell-sidebar'));
    if (roomList) roomList.hidden = hideRooms;
    if (roomSearch) roomSearch.hidden = hideRooms;
    if (roomHeading) roomHeading.hidden = hideRooms;
    $('#nav-conversations')?.classList?.toggle('active', navMode === 'rooms');
    $('#nav-people')?.classList?.toggle('active', navMode === 'people');
    $('#nav-today')?.classList?.toggle('active', navMode === 'today');
    $('#nav-settings')?.classList?.toggle('active', navMode === 'settings');
    $('#nav-conversations')?.setAttribute('aria-current', navMode === 'rooms' ? 'page' : 'false');
    $('#nav-people')?.setAttribute('aria-current', navMode === 'people' ? 'page' : 'false');
    $('#nav-today')?.setAttribute('aria-current', navMode === 'today' ? 'page' : 'false');
    $('#nav-settings')?.setAttribute('aria-current', navMode === 'settings' ? 'page' : 'false');
  }
  function renderPeople() {
    const people = (store.getState().virtualPersons || []).filter(person => !person.archivedAt && person.status !== 'archived');
    const list = $('#people-list');
    if (!list) return;
    list.innerHTML = people.map(person => `<button class="person-row" type="button" data-person="${esc(person.id)}">
      ${avatar([person.id])}<span>${esc(name(person))}</span></button>`).join('')
      || '<p class="room-empty">还没有可浏览的人物</p>';
  }
  function setNavigationMode(mode) {
    navMode = NAV_MODES.includes(mode) ? mode : 'rooms';
    renderNavigation();
    renderPeople();
    if (navMode === 'today') {
      options.onTodayOpen?.();
      $('#today-panel')?.focus?.({ preventScroll: true });
    }
    if (navMode === 'settings') {
      options.onSettingsOpen?.();
      $('#settings-panel')?.focus?.({ preventScroll: true });
    }
  }
  // 以对话框自身的 open 为准关闭人物页：person-page 类可能已被一次过期的 close 事件拿掉。
  function closePersonPage() {
    const detail = $('#person-detail');
    if (detail?.open) detail.close?.();
  }
  function toggleNavigation(mode) {
    const nextMode = NAV_MODES.includes(mode) ? mode : 'rooms';
    const handled = sidebarPresentation?.navigate(nextMode) ?? null;
    if (handled === false) return false; // 同图标只收起，保留当前页与人物详情。
    closePersonPage();
    const sidebar = $('.conversation-sidebar');
    if (handled === true) {
      if (WORKSPACE_MODES.includes(nextMode)) rememberView();
      setNavigationMode(nextMode);
      documentLike.body.classList.remove('rooms-open');
      syncSidebar();
      return true;
    }
    if (WORKSPACE_MODES.includes(nextMode)) {
      rememberView();
      setNavigationMode(nextMode);
      collapseSidebar();
      documentLike.body.classList.remove('rooms-open');
      syncSidebar();
      return;
    }
    const shouldClose = !pinnedSidebar() && sidebar?.classList?.contains?.('expanded') && navMode === nextMode;
    setNavigationMode(nextMode);
    sidebar?.classList?.toggle?.('expanded', !shouldClose);
  }
  async function browse(id) {
    if (!id) return;
    closePersonPage();
    navMode = 'rooms';
    renderNavigation();
    rememberView(); onBrowse(); documentLike.body.classList.remove('rooms-open');
    collapseSidebar();
    syncSidebar();
    await controller.select(id);
    // 打开即已读：只清服务端未读标记，不触发任何模型或播放动作。
    // 放在 select 完成之后，避免嵌套进 refresh → select 的调用链。
    const room = controller.snapshot().rooms.find(item => item.sessionId === id);
    if (room?.unreadAt) controller.updateRoomById(id, { unread: false }).catch(onError);
  }
  function renderRoomRow(room, playingId, selectedId, groupKind) {
    const local = controller.stateFor(room.sessionId);
    const lastText = local.turns.at(-1)?.text || room.lastMessage || '';
    // 侧栏预览只说这条聊天自己的话：引用块是给模型看的上下文，不是近况；
    // 只发了一条引用时退一步显示引用行（丢掉 `> ` 标记），不让预览空掉。
    const { quote, body } = splitLeadingQuote(lastText);
    const last = body.trim().replace(/\s+/gu, ' ') || quote.filter(Boolean).join(' ') || '聊聊近况，或者一起听首歌';
    const selected = selectedId === room.sessionId;
    const archived = Boolean(room.archivedAt);
    const label = controller.roomName(room);
    return `<div class="room-row-wrap">
      <button class="room-row ${selected ? 'selected' : ''}" data-room="${esc(room.sessionId)}" aria-current="${selected}">
        ${groupKind === 'host' ? '' : avatar(room.memberIds)}<span class="room-row-meta"><span class="room-row-title"><strong>${esc(label)}</strong>
          ${playingId === room.sessionId && store.getState().runtimeState.currentSongId ? '<span class="room-row-playing">此刻</span>' : local.unread || room.unreadAt ? '<span class="room-unread" aria-label="未读消息"></span>' : ''}</span><span class="room-row-preview">${esc(last.slice(0, 70))}</span></span>${room.lastTurnAt ? `<time class="room-row-time">${wallTime(room.lastTurnAt)}</time>` : ''}</button>
      <span class="room-row-actions">
        <button class="room-action" type="button" data-room-archive="${esc(room.sessionId)}" title="${archived ? '恢复聊天' : '归档'}" aria-label="${archived ? `恢复聊天 ${label}` : `归档 ${label}`}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8Z"/><path d="M3 4h18v4H3z"/><path d="M10 12h4v4h-4z"/></svg>
        </button>
        <button class="room-action" type="button" data-room-more="${esc(room.sessionId)}" title="更多操作" aria-label="${esc(label)} 的更多操作">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>
        </button>
      </span>
    </div>`;
  }
  function renderList() {
    const snapshot = controller.snapshot();
    const playingId = store.getState().runtimeState?.activeListeningSessionId;
    const rooms = snapshot.rooms.filter(room => Boolean(room.archivedAt) === showArchived
      && controller.roomName(room).toLowerCase().includes(filter));
    const groups = deriveConversationGroups({
      rooms,
      persons: store.getState().virtualPersons || [],
      rootPersonId: ROOT_VIRTUAL_PERSON_ID,
    });
    $('#room-list').innerHTML = groups.map(group => {
      const collapsed = collapsedGroups.has(group.key);
      return `<div class="room-group" data-group="${esc(group.key)}">
      <button class="room-group-heading" type="button" data-group-toggle="${esc(group.key)}" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${collapsed ? '展开' : '折叠'} ${esc(group.label)} 分组">
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="m2 3.5 3 3 3-3"/></svg>
        ${group.kind === 'host' ? identityDots([group.key.slice(5)]) : ''}<span>${esc(group.label)}</span><span class="room-group-count">${group.rooms.length}</span>
      </button>
      ${collapsed ? '' : group.rooms.map(room => renderRoomRow(room, playingId, snapshot.sessionId, group.kind)).join('')}
    </div>`;
    }).join('') || '<p class="room-empty">这里还没有聊天</p>';
  }
  function renderPlayer() {
    const view = presentation();
    const { runtime, track, listeningPerson: person, listeningRoom: room } = view;
    const focusedRoom = view.focusedRoom;
    const focusedTrack = view.focusedListeningTrack;
    const focusedPerson = view.focusedListeningPerson;
    const focusedTurns = focusedRoom ? controller.stateFor(focusedRoom.sessionId).turns : [];
    const introduction = deriveCurrentTrackIntroduction(focusedTrack, focusedTurns);
    const roomIntroduction = $('#room-introduction');
    if (roomIntroduction) roomIntroduction.textContent = introduction && controller.person(introduction.speakerVirtualPersonId)
      ? `这一首由 ${name(controller.person(introduction.speakerVirtualPersonId))} 介绍`
      : '此刻在这里，也在等你说话';
    const listeningTurns = room ? controller.stateFor(room.sessionId).turns : [];
    const focusIntroduction = deriveCurrentTrackIntroduction(track, listeningTurns);
    const intro = $('#listening-intro');
    if (intro) {
      // 旁白块只有三种状态，每种都只陈述真的成立的事：
      //   1. 这一轮真的生成了串词 — 原文 + 出处（谁写的、给哪首写的）；
      //   2. 歌在放、但没有串词 — 留白一句话（NO_NARRATION_LINE）。这不是异常，
      //      也不能说成「还没有播放记录」；
      //   3. 真的没有在放的歌 — 开场白。
      const narration = $('#listening-narration');
      if (narration) narration.hidden = !focusedRoom;
      intro.hidden = !focusedRoom;
      $('#listening-intro-text').textContent = introduction?.text
        || (focusedTrack ? NO_NARRATION_LINE : NO_TRACK_OPENING);
      const speaker = introduction
        ? controller.person(introduction.speakerVirtualPersonId)
        : null;
      // 发丝线与署名只属于真正生成的那段串词：它说明谁写的、为哪首写的。
      // 没生成串词还留着《歌名》推歌手记，就是给一句随口的话安上不存在的出处。
      const source = $('#listening-intro-source');
      if (source) {
        source.textContent = introduction
          ? `${speaker ? `${name(speaker)} · ` : ''}《${focusedTrack?.title || '当前歌曲'}》推歌手记${deliveredTime(focusedTrack, focusedTurns) ? ` · ${deliveredTime(focusedTrack, focusedTurns)}` : ''}`
          : '';
        source.hidden = !introduction;
      }
      const rule = intro.querySelector?.('.listening-narration-rule');
      if (rule) rule.hidden = !introduction;
      // 旁白署名行（参考稿「LUNARA 的旁白」）：谁在说话就写谁。
      const narrationLabel = $('#listening-narration-label');
      if (narrationLabel) narrationLabel.textContent = speaker ? `${name(speaker)} 的旁白` : '本首的介绍';
    }
    // 听歌主视觉 / 空闲问候互斥：选中聊天 → 主视觉；未选中 → 时刻 + 陪伴语。
    const hero = $('#listening-hero');
    const welcome = $('#listening-welcome');
    if (hero) hero.hidden = !focusedRoom;
    if (welcome) welcome.hidden = Boolean(focusedRoom);
    const artworkCaption = [focusedTrack?.album, focusedTrack?.artist].find(Boolean) || '';
    for (const captionId of ['#listening-artwork-caption', '#focus-artwork-caption']) {
      const captionNode = $(captionId);
      if (captionNode) captionNode.textContent = artworkCaption;
    }
    const focusRecommendation = $('#focus-player-recommendation');
    if (focusRecommendation) {
      focusRecommendation.hidden = !focusIntroduction;
      $('#focus-player-recommendation-text').textContent = focusIntroduction?.text || '';
      const speaker = focusIntroduction
        ? controller.person(focusIntroduction.speakerVirtualPersonId)
        : null;
      $('#focus-player-recommendation-source').textContent = focusIntroduction
        ? `${speaker ? `${name(speaker)} · ` : ''}来自「${controller.roomName(room)}」的推荐${deliveredTime(track, listeningTurns) ? ` · ${deliveredTime(track, listeningTurns)}` : ''}`
        : '';
    }
    // 有曲目但缺封面用占位封面；没有任何曲目时显示 Lunara 应用图标。
    applyArtwork($('#player-cover'), track ? (track.artwork || COVER_FALLBACK) : APP_ICON);
    const focusedQueue = $('#sb-queue');
    if (focusedQueue) {
      focusedQueue.innerHTML = view.focusedQueueItems.length
        ? view.focusedQueueItems.map(({ item, index, state }) => `<div class="sb-q-item ${state === 'current' ? 'active' : state === 'played' ? 'played' : ''}" data-focused-jump="${index}" data-queue-item-id="${esc(item.queueItemId || '')}">
          <span class="sb-q-num">${String(index + 1).padStart(2, '0')}</span><span class="sb-q-info"><span class="sb-q-title">${esc(item.title || '未知歌曲')}</span><span class="sb-q-artist">${esc(item.artist || '')}</span></span></div>`).join('')
        : '<div class="sb-empty">这个会话还没有播放列表</div>';
      if (focusedRoom?.sessionId === runtime?.activeListeningSessionId) {
        focusedQueue.querySelectorAll?.('[data-focused-jump]').forEach(element => {
          element.addEventListener?.('click', () => {
            const queueItemId = element.dataset?.queueItemId;
            if (queueItemId) void playbackRuntimeClient.selectQueueItem?.(queueItemId);
          });
        });
      }
    }
    // 收起态窄列的「接下来」：同一份 focusedQueueItems 的紧凑投影，只读，
    // 不承接点击（切歌入口仍在播放条队列弹层）。
    const stripQueue = $('#listening-strip-queue');
    if (stripQueue) {
      const upcoming = view.focusedQueueItems.filter(entry => entry.state === 'upcoming').slice(0, 12);
      stripQueue.innerHTML = upcoming.length
        ? `<div class="strip-queue-head">接下来</div>` + upcoming.map(({ item, index }) =>
            `<div class="strip-queue-row"><span class="strip-queue-idx">${String(index + 1).padStart(2, '0')}</span><span class="strip-queue-title">${esc(item.title || '未知歌曲')}</span></div>`).join('')
        : '';
      stripQueue.hidden = !upcoming.length;
    }
    const hasListeningSource = Boolean(room && track);
    const playerPerson = $('#player-person');
    playerPerson.textContent = hasListeningSource ? name(person) : '—';
    playerPerson.disabled = !hasListeningSource || !person;
    playerPerson.setAttribute('aria-label', hasListeningSource
      ? `查看当前伙伴 ${name(person)}` : '当前没有伙伴');
    const playerSource = $('#player-source');
    playerSource.textContent = hasListeningSource ? controller.roomName(room) : '未开始一起听';
    playerSource.disabled = !hasListeningSource;
    const pending = runtime?.pendingSwitch;
    const target = controller.snapshot().rooms.find(item => item.sessionId === pending?.listeningSessionId);
    const selected = focusedRoom;
    if (selected) $('#room-listen').textContent = selected.archivedAt ? '恢复聊天'
      : runtime?.activeListeningSessionId === selected.sessionId && track ? '正在一起听'
        : runtime?.activeListeningSessionId !== selected.sessionId && track ? '和 TA 一起听' : '一起听';
    const mismatch = $('#source-mismatch');
    if (mismatch) {
      mismatch.hidden = !view.sourceMismatch;
      if (view.sourceMismatch) {
        const source = room ? controller.roomName(room) : name(person || { displayName: '当前听歌会话' });
        $('#source-mismatch-copy').textContent = `你正在浏览「${controller.roomName(selected)}」，音乐仍来自「${source}」。`;
      }
    }
    $('#player-switch-cancel').hidden = !pending;
    $('#player-switch-cancel').textContent = target ? `等待与 ${controller.roomName(target)} 一起听 · 取消` : '取消等待';
    renderList();
  }
  // 「正在输入」：只显示这个聊天里的成员；文本即可访问名称，状态区礼貌播报。
  function composingCopy(snapshot, room) {
    const ids = (snapshot.composing || []).filter(id => room.memberIds.includes(id));
    return ids.length ? `${ids.map(id => name(controller.person(id))).join('、')} 正在输入…` : '';
  }
  // 等回复时输入框上方已有「正在回应… · 停止」：那时把谁在输入并进这一条，不再另起一行重复。
  // 只有伙伴主动开口（你没在等回复）时，才单独显示这一行。
  function renderComposing(snapshot, room) {
    const row = $('#room-composing');
    if (!row) return;
    const text = snapshot.pending ? '' : composingCopy(snapshot, room);
    if ($('#room-composing-text').textContent !== text) $('#room-composing-text').textContent = text;
    row.hidden = !text;
  }
  // 「安静点」：只在被要求安静的那个听歌来源里显示；恢复后焦点回到输入框，不丢键盘位置。
  function renderListenerQuiet(snapshot, room) {
    const row = $('#room-quiet');
    if (!row) return;
    const show = Boolean(snapshot.listenerQuiet);
    if (show) {
      const who = room.memberIds.length > 1 ? '大家' : name(controller.person(room.activeVirtualPersonId));
      const text = `这次一起听，${who}先不主动开口；你说话时照常回应。`;
      if ($('#room-quiet-text').textContent !== text) $('#room-quiet-text').textContent = text;
      const button = $('#room-quiet-restore');
      button.disabled = Boolean(snapshot.restoringQuiet);
      button.textContent = snapshot.restoringQuiet ? '正在恢复…' : '恢复主动说话';
    } else if (!row.hidden && row.contains?.(documentLike.activeElement)) {
      $('#compose-input')?.focus?.();
    }
    row.hidden = !show;
  }
  function render() {
    const snapshot = controller.snapshot();
    const room = snapshot.room;
    renderNavigation();
    renderPeople();
    if (!room) { renderList(); return; }
    $('#room-title').textContent = controller.roomName(room);
    const focusedPerson = controller.person(room.activeVirtualPersonId);
    const focusedPersonButton = $('#conversation-person');
    if (focusedPersonButton) {
      focusedPersonButton.innerHTML = identityDots(room.memberIds);
      focusedPersonButton.setAttribute('aria-label', `查看 ${name(focusedPerson)} 的人物资料`);
    }
    chatInputView.setMentionCandidates?.(room.memberIds.length > 1
      ? room.memberIds.map(id => ({ id, name: name(controller.person(id)), color: colorFor(id) })) : []);
    $('#room-members').innerHTML = room.memberIds.map(id => `<button data-person="${esc(id)}">${esc(name(controller.person(id)))}${id === room.activeVirtualPersonId ? ' · 当前伙伴' : ''}</button>`).join('');
    const archived = Boolean(room.archivedAt);
    const listenState = archived ? 'archived' : store.getState().runtimeState?.activeListeningSessionId === room.sessionId ? 'active' : 'idle';
    $('#room-listen').textContent = { archived: '恢复聊天', active: '正在一起听', idle: '一起听' }[listenState];
    // 主题可据此收起「正在一起听」（已经是听歌来源时按钮只是状态）；按钮本身仍在。
    $('#room-listen').dataset.state = listenState;
    $('#room-invite').disabled = archived || room.memberIds.length >= 8;
    const switched = shownId !== room.sessionId;
    const view = snapshot.local;
    // 当前伙伴与成员变化也要重绘：主持建议的确认状态对照的是房间的权威值。
    // 推荐卡片对照的是推荐状态与「这个聊天是不是当前听歌来源」：两者变了也重绘。
    const key = JSON.stringify([room.activeVirtualPersonId, room.memberIds, listenState,
      view.turns.map(turn => [turn.turnId, turn.text, turn.musicRecommendation?.status || null])]);
    if (switched || rendered !== key) {
      const scroll = $('#chat-scroll');
      const position = scroll.scrollTop;
      const lastTurnId = view.turns.at(-1)?.turnId || null;
      // New conversation or a newly appended turn: follow the bottom even if the
      // reader left the pane scrolled up earlier. Merely re-rendering the same
      // transcript (theme, presence, draft) keeps their place.
      const followBottom = switched || lastTurnId !== shownLastTurnId;
      chatController.replaceTranscript(view.turns, { scroll: false, room, listening: listenState === 'active' });
      if (!view.turns.length) $('#chat-list').innerHTML = `<div class="chat-empty"><span class="chat-empty-signal" aria-hidden="true"></span><strong>${esc(controller.roomName(room))}</strong><span>从一句近况，或一首想听的歌开始。</span></div>`;
      requestAnimationFrame(() => { if (controller.snapshot().sessionId === room.sessionId) {
        scroll.scrollTop = followBottom ? scroll.scrollHeight : position;
      } });
      rendered = key;
      shownLastTurnId = lastTurnId;
    }
    if (switched || view.restoreDraft) { $('#compose-input').value = view.draft; chatInputView.syncSize?.(); view.restoreDraft = false; }
    // 参考稿输入条占位：默认单伙伴（Lunara）房间用产品语文案；群聊保留点名提示。
    $('#compose-input').placeholder = room.memberIds.length > 1 ? '跟大家说点什么…'
      : room.activeVirtualPersonId === 'lunara' ? '说说此刻的心情，或点一首歌…'
        : `跟 ${name(controller.person(room.activeVirtualPersonId))} 说点什么…`;
    chatInputView.setLocked(archived, archived ? '聊天已归档，可以恢复后接着聊' : '', { source: 'room' });
    chatInputView.setPending?.(snapshot.pending, archived ? '聊天已归档，可以恢复后接着聊'
      : snapshot.pending ? (composingCopy(snapshot, room) || '正在回复…') : '');
    // 改写提示条只跟随本聊天的编辑状态；回应进行中或已归档时消息上的动作收起。
    const editRow = $('#compose-edit');
    if (editRow) editRow.hidden = !view.edit || archived;
    $('#chat-list')?.classList?.toggle('actions-locked', Boolean(snapshot.pending || archived));
    renderComposing(snapshot, room);
    renderListenerQuiet(snapshot, room);
    $('#room-history').hidden = !view.hasOlder;
    shownId = room.sessionId;
    renderPlayer();
    renderMoment();
  }
  function openPicker(mode, options = {}) {
    pickerMode = mode;
    listenAfterCreate = mode === 'create' && options.listenAfterCreate === true;
    const snapshot = controller.snapshot();
    $('#room-picker-title').textContent = mode === 'create' ? '创建聊天' : '邀请伙伴';
    $('#room-picker-submit').textContent = mode === 'create'
      ? listenAfterCreate ? '创建并一起听' : '开始聊天'
      : '邀请加入';
    $('#room-name').value = mode === 'create' ? String(options.title || '') : '';
    $('#room-name').parentElement.hidden = mode !== 'create';
    $('#room-name').required = mode === 'create';
    $('#room-picker-error').textContent = '';
    const people = store.getState().virtualPersons.filter(person => !person.archivedAt && person.status !== 'archived'
      && (mode === 'create' || !snapshot.room.memberIds.includes(person.id)));
    const selectedIds = new Set(options.memberIds || (mode === 'create' ? ['lunara'] : []));
    $('#room-person-choices').innerHTML = people.map(person => `<label class="person-choice">${avatar([person.id])}<span>${esc(name(person))}</span><input type="checkbox" name="person" value="${esc(person.id)}" ${selectedIds.has(person.id) ? 'checked' : ''} /></label>`).join('') || '<p>所有伙伴都在这个聊天里了。</p>';
    $('#room-picker').showModal();
  }

  function openCreateRoomForPerson(person, { listenAfterCreate: shouldListen = false } = {}) {
    const candidate = (store.getState().virtualPersons || []).find(item => item.id === person?.id && !item.archivedAt && item.status !== 'archived');
    if (!candidate) throw new Error('找不到这位可用的伙伴，请刷新人物列表后重试。');
    const memberIds = [...new Set(['lunara', candidate.id])];
    openPicker('create', {
      memberIds,
      title: `和 ${name(candidate)} 的聊天`,
      listenAfterCreate: shouldListen,
    });
    $('#room-name').focus();
  }
  /** 会话级模型覆盖：读注册表 + 当前覆盖，填充"本轮会话模型"选择器（中途可改，下一轮生效）。 */
  async function refreshRoomModelOptions(sessionId) {
    const select = $('#room-model-select');
    if (!select || !sessionId) return;
    try {
      const [registry, session] = await Promise.all([
        apiClient.get('/api/llm/providers'),
        apiClient.get(`/api/llm/session-model?sessionId=${encodeURIComponent(sessionId)}`),
      ]);
      const providers = (registry?.providers || [])
        // 停用模型保留在注册表里，但会话覆盖不能选它：先剪掉再判断 provider 是否还有可用模型。
        .map(provider => ({
          ...provider,
          models: (provider.models || []).filter(model => !(provider.disabledModels || []).includes(model)),
        }))
        .filter(provider => provider.enabled && provider.models.length);
      roomModelRegistry = { providers, override: session?.override || null };
      select.innerHTML = '<option value="">跟随全局</option>' + providers.map(provider => provider.models.map(model => {
        const value = `${provider.id}::${model}`;
        const current = session?.override?.providerId === provider.id && session?.override?.model === model;
        return `<option value="${esc(value)}"${current ? ' selected' : ''}>${esc(provider.name || provider.id)} · ${esc(model)}</option>`;
      }).join('')).join('');
      renderRoomEffortOptions();
    } catch {
      select.innerHTML = '<option value="">跟随全局（模型列表暂不可用）</option>';
      roomModelRegistry = { providers: [], override: null };
      renderRoomEffortOptions();
    }
  }

  /** 会话思考档：跟随模型默认 + 当前所选模型支持的档位；无模型覆盖时禁用。 */
  function renderRoomEffortOptions() {
    const select = $('#room-model-effort');
    if (!select) return;
    const { providers, override } = roomModelRegistry;
    const provider = override ? providers.find(candidate => candidate.id === override.providerId) || null : null;
    const model = provider && override?.model ? override.model : '';
    const levels = model ? roomEffortLevels(provider, model) : [];
    const defaultEffort = model ? provider?.modelDefaults?.[model]?.reasoningEffort || '' : '';
    const current = override?.reasoningEffort || '';
    const options = [['', defaultEffort ? `跟随模型默认（${roomEffortLabel(defaultEffort)}）` : '跟随模型默认']];
    for (const level of levels) options.push([level, roomEffortLabel(level)]);
    if (current && !options.some(([value]) => value === current)) options.push([current, roomEffortLabel(current)]);
    select.innerHTML = options.map(([value, label]) =>
      `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`).join('');
    select.disabled = !provider;
  }

  function openOptions() {
    const { room } = controller.snapshot();
    $('#room-rename').value = controller.roomName(room);
    $('#room-options-after').disabled = Boolean(room.archivedAt);
    void refreshRoomModelOptions(room.sessionId);
    $('#room-member-settings').innerHTML = room.memberIds.map(id => `<div class="member-setting"><span>${esc(name(controller.person(id)))}</span><button class="quiet-button" data-host="${esc(id)}" ${id === room.activeVirtualPersonId ? 'disabled' : ''}>${id === room.activeVirtualPersonId ? '当前伙伴' : '设为当前伙伴'}</button><button class="quiet-button" data-remove="${esc(id)}" ${room.memberIds.length === 1 ? 'disabled' : ''}>移出</button></div>`).join('');
    $('#room-options').showModal();
  }
  /** 把当前伙伴的字段直接填入面板——不再需要"先点编辑"才能看到可编辑值。 */
  function renderProfileFields(person) {
    const nameInput = $('#person-detail-name-input');
    const personaInput = $('#person-detail-persona-input');
    const voiceHint = $('#person-detail-voice-hint');
    if (nameInput) nameInput.value = person.displayName || '';
    if (personaInput) personaInput.value = person.personaDocument || '';
    // 在场性格：一起听歌时她多常主动说一句（角色 metadata，缺省「自然」）。
    const presence = person.metadata?.presence || {};
    const presenceSelect = $('#person-detail-presence-select');
    const presenceStyle = $('#person-detail-presence-style');
    if (presenceSelect) presenceSelect.value = ['quiet', 'balanced', 'lively'].includes(presence.temperament) ? presence.temperament : 'balanced';
    if (presenceStyle) presenceStyle.value = presence.style || '';
    setProfileEditing(!profileEditGated());
    renderVoiceOptions(
      [{ id: person.voiceProfileId, displayName: person.voiceProfileId }],
      person.voiceProfileId,
    );
    if (voiceHint) voiceHint.textContent = '';
    // 声音列表是异步的；失败不影响名字与人格的编辑。
    apiClient.get('/api/station/voices').then(result => {
      if (personDetailId !== person.id) return;
      const voices = Array.isArray(result?.voices) ? result.voices : [];
      if (voices.length) renderVoiceOptions(voices, person.voiceProfileId);
      // 这个人当前配的声音若正回落，必须如实说明原因，而不是只显示一个原生声音的名字。
      const current = voices.find(voice => voice.id === person.voiceProfileId);
      if (voiceHint && current?.isFallback) {
        voiceHint.textContent = '当前音色已变化（所选声音来源不可用，正在用另一把声音）';
      }
    }).catch(error => {
      if (personDetailId !== person.id || !voiceHint) return;
      voiceHint.textContent = `列表未加载（${error.message}）`;
    });
  }

  // 主题 token --person-edit: toggle 表示人物页先只读展示，点「编辑」才进入编辑；
  // 其余主题不设这个 token，表单一直可编辑（与以前一样）。
  function profileEditGated() { return shellToken('--person-edit') === 'toggle'; }
  function setProfileEditing(editing) {
    $('#person-profile-form')?.classList?.toggle('is-editing', editing);
    for (const id of ['#person-detail-name-input', '#person-detail-persona-input', '#person-detail-presence-style']) {
      const field = $(id);
      if (field) field.readOnly = !editing;
    }
    const toggle = $('#person-detail-edit');
    if (toggle) {
      toggle.textContent = editing ? '取消编辑' : '编辑';
      toggle.setAttribute?.('aria-pressed', String(editing));
    }
  }

  function renderVoiceOptions(voices, selectedId) {
    const select = $('#person-detail-voice-select');
    if (!select) return;
    select.innerHTML = voices.map(voice => {
      const label = `${voice.displayName || voice.id}${voice.unavailable ? '（不可用）' : voice.isFallback ? '（音色已变化）' : ''}`;
      return `<option value="${esc(voice.id)}"${voice.id === selectedId ? ' selected' : ''}>${esc(label)}</option>`;
    }).join('') || '<option value="">（当前声音不在可选列表中）</option>';
  }

  /** 就地面板内保存：不再弹出第二层对话框。 */
  async function saveProfile() {
    const person = controller.person(personDetailId);
    if (!person) return;
    const message = $('#person-detail-save-msg');
    const button = $('#person-detail-save');
    const displayName = $('#person-detail-name-input')?.value?.trim() || '';
    if (!displayName) {
      if (message) message.textContent = '请填写名字。';
      return;
    }
    if (button) { button.disabled = true; button.textContent = '保存中…'; }
    try {
      const presenceSelect = $('#person-detail-presence-select');
      const result = await apiClient.patch(`/api/virtual-persons/${encodeURIComponent(person.id)}`, {
        displayName,
        personaDocument: $('#person-detail-persona-input')?.value ?? '',
        voiceProfileId: $('#person-detail-voice-select')?.value || person.voiceProfileId,
        ...(presenceSelect ? { presence: { temperament: presenceSelect.value || 'balanced',
          style: String($('#person-detail-presence-style')?.value ?? '').trim() } } : {}),
      });
      if (result?.ok === false) throw new Error(result.error || '保存失败');
      if (result?.person) applyPersonUpdate(result.person);
      // 标题也要跟着改：只更新列表而留旧标题，用户会以为没保存成功。
      const saved = result?.person || { ...person, displayName, personaDocument: $('#person-detail-persona-input')?.value ?? '', voiceProfileId: $('#person-detail-voice-select')?.value || person.voiceProfileId };
      const title = $('#person-detail-name');
      if (title) title.textContent = name(saved);
      if (message) message.textContent = '已保存';
      if (profileEditGated()) setProfileEditing(false);
    } catch (error) {
      // 失败时字段保持用户输入，不清空也不回退，便于修正后重试。
      if (message) message.textContent = error.message;
    } finally {
      if (button) { button.disabled = false; button.textContent = '保存修改'; }
    }
  }

  /** 面板内试听：走与串词相同的合成路径。 */
  async function previewPersonVoice() {
    const person = controller.person(personDetailId);
    if (!person) return;
    const message = $('#person-detail-save-msg');
    const button = $('#person-detail-listen');
    const audio = $('#person-detail-preview');
    const voiceProfileId = $('#person-detail-voice-select')?.value || person.voiceProfileId;
    if (button) button.disabled = true;
    try {
      const result = await apiClient.post('/api/tts/preview', { voiceProfileId });
      if (result?.ok === false) throw new Error(result.error || '试听失败');

      if (!result?.url) throw new Error('试听没有返回音频');
      if (audio) { audio.src = result.url; audio.hidden = false; try { await audio.play?.(); } catch {} }
      if (message) message.textContent = result.isFallback ? '试听（音色已变化）' : '试听';
    } catch (error) {
      if (message) message.textContent = `试听失败：${error.message}`;
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function openPerson(id) {
    personDetailId = id;
    const person = controller.person(id);
    if (!person) return;
    const runtime = store.getState().runtimeState;
    const track = runtime?.queue?.[runtime.currentIndex];
    $('#person-detail-name').textContent = name(person);
    const inListeningRoom = controller.snapshot().rooms.find(room => room.sessionId === runtime?.activeListeningSessionId)?.memberIds?.includes(id);
    $('#person-detail-state').textContent = inListeningRoom && track && runtime?.phase === 'playing' ? '此刻在陪你听' : '随时可以来聊聊';
    const days = acquaintanceDays(person.createdAt);
    const known = $('#person-known-days');
    if (known) { known.textContent = days == null ? '' : `认识第 ${days} 天`; known.hidden = days == null; }
    const signal = $('#person-detail-signal');
    if (signal) signal.innerHTML = identityDots([id], inListeningRoom && runtime?.phase === 'playing' ? id : null);
    renderProfileFields(person);
    const saveMessage = $('#person-detail-save-msg');
    if (saveMessage) saveMessage.textContent = '';
    const audio = $('#person-detail-preview');
    if (audio) { audio.hidden = true; audio.removeAttribute?.('src'); }
    $('#person-detail-memories').innerHTML = '<p>正在读取记忆…</p>';
    const dialog = $('#person-detail');
    if (!dialog.open) {
      personReturnFocus = documentLike.activeElement;
      if (shellToken('--shell-person') === 'page' && typeof dialog.show === 'function') {
        $('#app')?.classList?.add('person-page');
        dialog.show();
        if (documentLike.defaultView?.matchMedia('(max-width: 960px)').matches) {
          documentLike.body.classList.remove('rooms-open'); syncSidebar();
        }
        $('#person-detail-name-input')?.focus?.();
      } else dialog.showModal();
    }
    // 根陪伴者可以编辑但不可删除。
    const deleteButton = $('#person-detail-delete');
    if (deleteButton) deleteButton.hidden = id === ROOT_VIRTUAL_PERSON_ID;
    try {
      const result = await apiClient.get(`/api/memory/person/${encodeURIComponent(id)}`);
      if (result?.ok === false) throw new Error('memory unavailable');
      if (personDetailId !== id) return;
      $('#person-detail-memories').innerHTML = [...(result.memories || [])]
        .sort((a,b) => (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0))
        .map(memory => `<article class="person-memory" data-memory="${esc(memory.id)}"><time>${dateLabel(memory.createdAt)}</time><div><p>${esc(memory.content)}</p>
        <details><summary>查看依据或修正</summary><p>${esc(memory.evidence?.quote || memory.summary || '来自与你的互动')}</p><label>正确的记忆<textarea>${esc(memory.content)}</textarea></label><button class="quiet-button" data-correct-memory>保存修正</button></details></div><button class="quiet-button" data-forget-memory>忘记这条</button></article>`).join('') || '<p class="person-empty">还没有持久记忆。<br>聊过的经历会慢慢积累在这里。</p>';
    } catch {
      if (personDetailId !== id) return;
      $('#person-detail-memories').innerHTML = '<p role="alert">记忆暂时没有读到。<button type="button" class="quiet-button" data-person-memory-retry>重试</button></p>';
    }
  }
  /**
   * 编辑后本地列表必须立即反映新值：conversationController.refresh() 不会重载
   * virtualPersons（那一份由 radiohostController 加载）。生产装配传入的是完整 store，
   * 但只读包装也能被传入，因此更新必须可缺省，不能让一次成功保存变成报错。
   */
  function applyPersonUpdate(person) {
    if (typeof store.update !== 'function') return;
    const persons = store.getState().virtualPersons || [];
    const next = persons.map(item => (item.id === person.id ? { ...item, ...person } : item));
    store.update({ virtualPersons: next }, { type: 'virtual-person.updated' });
  }

  function applyPersonRemoval(personId) {
    if (typeof store.update !== 'function') return;
    const persons = store.getState().virtualPersons || [];
    const state = store.getState();
    store.update({
      virtualPersons: persons.filter(item => item.id !== personId),
      activeRadiohost: state.activeRadiohost?.id === personId ? null : state.activeRadiohost,
    }, { type: 'virtual-person.removed' });
  }

  /** 删除不可回退，因此先拉取真实影响面再让用户确认。 */
  async function openDeletePerson() {
    const person = controller.person(personDetailId);
    if (!person || person.id === ROOT_VIRTUAL_PERSON_ID) return;
    const dialog = $('#person-delete-confirm');
    if (!dialog) return;
    const lead = $('#person-delete-lead');
    const list = $('#person-delete-impact');
    const errorSlot = $('#person-delete-error');
    if (lead) lead.textContent = `即将删除「${name(person)}」。`;
    if (list) list.innerHTML = '<li>正在统计…</li>';
    if (errorSlot) errorSlot.textContent = '';
    if (!dialog.open) dialog.showModal();
    try {
      const result = await apiClient.get(`/api/virtual-persons/${encodeURIComponent(person.id)}/deletion-impact`);
      if (result?.ok === false) throw new Error(result.error || '无法读取删除影响');
      const impact = result?.impact || {};
      if (list) {
        const rows = [`${impact.memories || 0} 条与你的记忆（永久移除）`, '它的人格设定与人物形象'];
        if (impact.rooms) rows.push(`它在 ${impact.rooms} 段聊天中的成员关系`);
        list.innerHTML = rows.map(row => `<li>${esc(row)}</li>`).join('');
      }
    } catch (error) {
      if (list) list.innerHTML = '';
      if (errorSlot) errorSlot.textContent = error.message;
    }
  }

  async function confirmDeletePerson() {
    const person = controller.person(personDetailId);
    if (!person) return;
    const errorSlot = $('#person-delete-error');
    const button = $('#person-delete-confirm-button');
    if (button) button.disabled = true;
    try {
      const result = await apiClient.delete(`/api/virtual-persons/${encodeURIComponent(person.id)}`);
      if (result?.ok === false) throw new Error(result.error || '删除失败');
      // 先关详情面板再关确认框：确认框的 close 监听据此跳过焦点回退（人都删了，没有可回退的入口）。
      $('#person-detail')?.close?.();
      $('#person-delete-confirm')?.close?.();
      applyPersonRemoval(person.id);
      // 成员关系是服务端清理的，本地 room 快照要重新拉取，否则成员列表还挂着已删除的人。
      try { await controller.refresh(); } catch { /* 刷新失败不撤销删除，下次交互会再同步 */ }
      render();
    } catch (error) {
      if (errorSlot) errorSlot.textContent = error.message;
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function listen(delivery) {
    const { room } = controller.snapshot();
    if (room.archivedAt) { await controller.update({ archived: false }); return; }
    onBrowse();
    const snapshot = store.getState().runtimeState;
    const scoped = snapshot?.activeListeningSessionId === room.sessionId ? snapshot : snapshot?.suspendedSessions?.[room.sessionId];
    if (!scoped?.queue?.length) {
      $('#room-listen').disabled = true;
      try {
        const result = await apiClient.post('/api/next', { sessionId: room.sessionId, delivery: 'append' });
        if (result.ok === false) throw new Error('暂时没找到可以播放的歌，可以先点一首歌或检查音乐源登录。');
      }
      finally { $('#room-listen').disabled = false; }
    }
    await playbackRuntimeClient.listenWith(room.sessionId, delivery);
    const current = store.getState().runtimeState;
    if (delivery === 'now' && current?.activeListeningSessionId === room.sessionId && current.phase === 'paused') await playbackRuntimeClient.resume();
  }
  /**
   * ===== 行内会话管理：归档撤销条、更多菜单、重命名与删除确认。 =====
   * 菜单是单实例 popover；所有动作以打开时捕获的 sessionId 在点击时重新解析快照，
   * 会话已被刷新移除时直接关闭，不会对旧目标提交变更。
   */
  function showUndoToast(sid, title) {
    undoSid = sid;
    const toast = $('#sb-undo-toast');
    if (!toast) return;
    $('#sb-undo-toast-text').textContent = `已归档「${title}」`;
    toast.hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(hideUndoToast, 5000);
  }
  function hideUndoToast() {
    clearTimeout(undoTimer); undoTimer = null; undoSid = null;
    const toast = $('#sb-undo-toast');
    if (toast) toast.hidden = true;
  }
  function positionRoomMenu(menu, anchor) {
    const rect = anchor?.getBoundingClientRect?.();
    if (!rect || !documentLike.defaultView) return;
    const menuRect = menu.getBoundingClientRect?.() || { width: 0, height: 0 };
    const width = menuRect.width || 168;
    const height = menuRect.height || 200;
    const windowWidth = documentLike.defaultView.innerWidth || rect.right + width;
    const windowHeight = documentLike.defaultView.innerHeight || rect.bottom + height;
    const left = Math.max(8, Math.min(rect.right - width, windowWidth - width - 8));
    const top = rect.bottom + 6 + height > windowHeight ? Math.max(8, rect.top - height - 6) : rect.bottom + 6;
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }
  function openRoomMenu(button) {
    const sid = button?.dataset?.roomMore;
    const room = controller.snapshot().rooms.find(item => item.sessionId === sid);
    const menu = $('#room-row-menu');
    if (!room || !menu) return;
    menuSid = sid; menuTrigger = button;
    const archived = Boolean(room.archivedAt);
    menu.classList.toggle('archived', archived);
    $('#room-row-menu-pin').textContent = room.pinnedAt ? '取消置顶' : '置顶';
    $('#room-row-menu-unread').textContent = room.unreadAt ? '标为已读' : '标为未读';
    $('#room-row-menu-archive').textContent = archived ? '取消归档' : '归档';
    // 归档会话只保留恢复与删除：置顶/重命名/未读对它没有意义。
    for (const action of ['pin', 'rename', 'unread']) {
      const item = menu.querySelector(`[data-menu-action="${action}"]`);
      if (item) item.hidden = archived;
    }
    menu.hidden = false;
    positionRoomMenu(menu, button);
    menu.querySelector('[data-menu-action]:not([hidden])')?.focus?.();
  }
  function closeRoomMenu(refocus = false) {
    const menu = $('#room-row-menu');
    if (!menu || menu.hidden) return;
    menu.hidden = true; menuSid = null;
    if (refocus) menuTrigger?.focus?.();
    menuTrigger = null;
  }
  function openRoomRename(sid) {
    const room = controller.snapshot().rooms.find(item => item.sessionId === sid);
    const dialog = $('#room-rename-dialog');
    if (!room || !dialog) return;
    renameSid = sid;
    $('#room-rename-input').value = controller.roomName(room);
    $('#room-rename-error').textContent = '';
    dialog.showModal();
  }
  function openRoomDeleteConfirm(sid) {
    const room = controller.snapshot().rooms.find(item => item.sessionId === sid);
    const dialog = $('#room-delete-confirm');
    if (!room || !dialog) return;
    deleteSid = sid;
    $('#room-delete-lead').textContent = `即将删除「${controller.roomName(room)}」。`;
    $('#room-delete-error').textContent = '';
    dialog.showModal();
  }
  /** 行内归档：立即生效，撤销条提供时限内的恢复；正在浏览的会话由 controller 回落。 */
  async function archiveRoomFromRow(sid) {
    const room = controller.snapshot().rooms.find(item => item.sessionId === sid);
    if (!room) return;
    await controller.updateRoomById(sid, { archived: true });
    showUndoToast(sid, controller.roomName(room));
  }
  function restoreRoomFromRow(sid) {
    hideUndoToast();
    if (showArchived) { showArchived = false; $('#room-archived').textContent = '已归档'; }
    return controller.updateRoomById(sid, { archived: false });
  }
  function syncSidebar() {
    const narrow = documentLike.defaultView?.matchMedia('(max-width: 960px)').matches;
    const expanded = documentLike.body.classList.contains('rooms-open');
    $('.conversation-sidebar').inert = Boolean(narrow && !expanded);
    $('#room-menu').setAttribute('aria-expanded', String(expanded));
  }
  function closeSidebar() {
    collapseSidebar({ explicit: true });
    documentLike.body.classList.remove('rooms-open');
    syncSidebar();
  }
  function init() {
    renderMoment();
    const momentTimer = setInterval(renderMoment, 30000);
    momentTimer.unref?.();
    cleanups.push(() => clearInterval(momentTimer));
    on('#nav-conversations', 'click', () => toggleNavigation('rooms'));
    on('#nav-people', 'click', () => {
      if (toggleNavigation('people') === false) return;
      const first = (store.getState().virtualPersons || []).find(person => !person.archivedAt && person.status !== 'archived');
      // 窄屏抽屉里的「人物」是列表页：一进来就直接打开第一位伙伴的详情，会把列表连同标题旁的
      // 「新增伙伴」入口一起藏掉。桌面常驻侧栏没有这个问题，继续按稿直接展开第一位。
      const drawer = documentLike.defaultView?.matchMedia?.('(max-width: 960px)')?.matches === true;
      if (!drawer && shellToken('--shell-person') === 'page' && first) return openPerson(first.id);
    });
    on('#nav-today', 'click', () => toggleNavigation('today'));
    on('#today-panel', 'click', event => {
      if (!event.target?.closest?.('[data-action="back-to-chat"]')) return;
      setNavigationMode('rooms');
      $('#compose-input')?.focus?.({ preventScroll: true });
    });
    on('#nav-settings', 'click', () => toggleNavigation('settings'));
    on('#sb-settings-open', 'click', () => toggleNavigation('settings'));
    on('#nav-create', 'click', () => $('#create-launcher')?.showModal?.());
    // 聊天标题旁的 ＋ 只新建聊天（早先把「认识新伙伴」并进同一个选择器，两个动作混在一起）；
    // 新增伙伴的入口在人物列表标题旁（#people-list-create，由 radiohostView 打开召唤面板）。
    on('#room-list-create', 'click', () => openPicker('create'));
    on('#create-room-option', 'click', () => { $('#create-launcher')?.close?.(); openPicker('create'); });
    on('#radiohost-cast-new', 'click', () => { $('#create-launcher')?.close?.(); collapseSidebar(); });
    // 窄轨上的「登录」入口现在指向统一的音乐源浮窗：账号行只在浮窗里出现，
    // 直接聚焦隐藏的 .sb-account-btn 会静默失败。
    on('#nav-account', 'click', () => {
      if (sidebarPresentation?.navigate('account') === false) return;
      setNavigationMode('rooms');
      $('.conversation-sidebar')?.classList?.add?.('expanded');
      (documentLike.querySelector('#source-menu-open')
        || documentLike.querySelector('.sb-account-btn'))?.focus?.();
    });
    on('#room-list', 'click', event => {
      const groupToggle = event.target.closest?.('[data-group-toggle]');
      if (groupToggle) {
        const key = groupToggle.dataset.groupToggle;
        collapsedGroups.has(key) ? collapsedGroups.delete(key) : collapsedGroups.add(key);
        renderList();
        return;
      }
      const archiveButton = event.target.closest?.('[data-room-archive]');
      if (archiveButton) {
        const sid = archiveButton.dataset.roomArchive;
        const room = controller.snapshot().rooms.find(item => item.sessionId === sid);
        return room?.archivedAt ? restoreRoomFromRow(sid) : archiveRoomFromRow(sid);
      }
      if (event.target.closest?.('[data-room-more]')) return openRoomMenu(event.target.closest('[data-room-more]'));
      const button = event.target.closest('[data-room]');
      if (button) return browse(button.dataset.room);
    });
    // 菜单打开时滚动列表会让锚点脱位：直接收起。
    on('#room-list', 'scroll', () => closeRoomMenu());
    on('#room-row-menu', 'click', async event => {
      const action = event.target.closest?.('[data-menu-action]')?.dataset?.menuAction;
      if (!action || !menuSid) return;
      const sid = menuSid;
      closeRoomMenu(true);
      const room = controller.snapshot().rooms.find(item => item.sessionId === sid);
      if (!room) return;
      if (action === 'pin') await controller.updateRoomById(sid, { pinned: !room.pinnedAt });
      if (action === 'unread') await controller.updateRoomById(sid, { unread: !room.unreadAt });
      if (action === 'rename') return openRoomRename(sid);
      if (action === 'archive') {
        return room.archivedAt ? restoreRoomFromRow(sid) : archiveRoomFromRow(sid);
      }
      if (action === 'delete') openRoomDeleteConfirm(sid);
    });
    on(documentLike, 'click', event => {
      // 点在另一行的“更多”上时由列表处理器换锚点打开，这里不拦截。
      if (!menuSid) return;
      if (event.target?.closest?.('#room-row-menu') || event.target?.closest?.('[data-room-more]')) return;
      closeRoomMenu();
    });
    on(documentLike, 'keydown', event => { if (event.key === 'Escape') closeRoomMenu(true); });
    on('#sb-undo-toast-undo', 'click', () => {
      const sid = undoSid;
      if (sid) return restoreRoomFromRow(sid);
      hideUndoToast();
    });
    on('#sb-undo-toast-view', 'click', () => {
      hideUndoToast();
      if (showArchived) return;
      showArchived = true;
      $('#room-archived').textContent = '返回聊天';
      renderList();
    });
    on('#sb-undo-toast-close', 'click', () => hideUndoToast());
    on('#room-rename-form', 'submit', async event => {
      event.preventDefault();
      if (!renameSid) return;
      const title = validateRoomTitle($('#room-rename-input').value);
      if (!title.valid) { $('#room-rename-error').textContent = title.error; return; }
      await controller.updateRoomById(renameSid, { title: title.title });
      renameSid = null;
      $('#room-rename-dialog')?.close?.();
    });
    on('#room-delete-cancel', 'click', () => $('#room-delete-confirm')?.close?.());
    on('#room-delete-confirm-button', 'click', async () => {
      const sid = deleteSid;
      const button = $('#room-delete-confirm-button');
      if (!sid || !button) return;
      button.disabled = true;
      try {
        await controller.deleteRoomById(sid);
        deleteSid = null;
        $('#room-delete-confirm')?.close?.();
      } catch (error) {
        // 守卫拒绝（例如正在一起听）要在弹层内如实说明，而不是静默关闭。
        $('#room-delete-error').textContent = error.message;
      } finally { button.disabled = false; }
    });
    on('#people-list', 'click', event => { const button = event.target.closest('[data-person]'); if (button) return openPerson(button.dataset.person); });
    on('#room-menu', 'click', () => { documentLike.body.classList.toggle('rooms-open'); syncSidebar(); });
    // “回到聊天”在窄屏会隐藏原来的聆听入口；等现有 shell 完成切 pane，
    // 再把焦点交给可见输入框，而不是让焦点落在已隐藏的专注按钮上。
    on('#focus-mode-chat', 'click', () => requestAnimationFrame(() => {
      if (documentLike.defaultView?.matchMedia('(max-width: 960px)').matches) $('#compose-input')?.focus?.();
    }));
    on('#sidebar-close', 'click', closeSidebar);
    on(documentLike, 'keydown', event => {
      if (event.key === 'Escape' && documentLike.body.classList.contains('rooms-open')) {
        documentLike.body.classList.remove('rooms-open'); syncSidebar(); $('#room-menu').focus();
      }
    });
    const viewport = documentLike.defaultView?.matchMedia('(max-width: 960px)');
    viewport?.addEventListener('change', syncSidebar);
    cleanups.push(() => viewport?.removeEventListener('change', syncSidebar));
    syncSidebar();
    on('#room-search', 'input', event => { filter = event.target.value.trim().toLowerCase(); renderList(); });
    on('#room-invite', 'click', () => openPicker('invite'));
    on('#room-archived', 'click', event => { showArchived = !showArchived; event.target.textContent = showArchived ? '返回聊天' : '已归档'; renderList(); });
    on('#room-settings', 'click', openOptions);
    on('#room-members', 'click', event => { const button = event.target.closest('[data-person]'); if (button) return openPerson(button.dataset.person); });
    on('#conversation-person', 'click', () => openPerson(controller.snapshot().room?.activeVirtualPersonId || 'lunara'));
    on('#room-picker-form', 'submit', async event => {
      event.preventDefault();
      if (creatingRoom) return;
      const ids = [...$('#room-person-choices').querySelectorAll('input:checked')].map(input => input.value);
      if (!ids.length || ids.length + (pickerMode === 'invite' ? controller.snapshot().room.memberIds.length : 0) > 8) { $('#room-picker-error').textContent = '请选择 1 至 8 位伙伴。'; return; }
      const title = pickerMode === 'create' ? validateRoomTitle($('#room-name').value) : null;
      if (title && !title.valid) {
        $('#room-picker-error').textContent = title.error;
        $('#room-name').focus();
        return;
      }
      creatingRoom = true;
      $('#room-picker-submit').disabled = true;
      $('#room-picker').setAttribute?.('aria-busy', 'true');
      try {
        rememberView();
        if (pickerMode === 'create') await controller.create({ title: title.title, memberIds: ids });
        else for (const id of ids) await controller.member(id);
        const shouldListen = listenAfterCreate;
        listenAfterCreate = false;
        $('#room-picker').close();
        if (shouldListen) {
          try { await listen('now'); }
          catch (error) { onError(error); }
        }
      } catch (error) { $('#room-picker-error').textContent = error.message; }
      finally {
        creatingRoom = false;
        $('#room-picker').setAttribute?.('aria-busy', 'false');
        $('#room-picker-submit').disabled = false;
      }
    });
    on('#room-rename-save', 'click', async () => { await controller.update({ title: $('#room-rename').value }); $('#room-options').close(); });
    on('#room-archive', 'click', async () => { await controller.update({ archived: true }); $('#room-options').close(); });
    on('#room-model-select', 'change', async event => {
      const { room } = controller.snapshot();
      const value = String(event.target?.value || '');
      const [providerId, model] = value.split('::');
      try {
        await apiClient.put('/api/llm/session-model', {
          sessionId: room.sessionId,
          ...(providerId && model ? { providerId, model } : {}),
        });
        // 换模型后旧档位不再适用：服务端已清空，界面同步回「跟随模型默认」。
        roomModelRegistry = {
          ...roomModelRegistry,
          override: providerId && model ? { providerId, model } : null,
        };
        renderRoomEffortOptions();
      } catch { /* 选择器下次打开会如实重读服务端状态 */ }
    });
    on('#room-model-effort', 'change', async event => {
      const { room } = controller.snapshot();
      const override = roomModelRegistry.override;
      if (!override) return;
      const value = String(event.target?.value || '').trim();
      try {
        await apiClient.put('/api/llm/session-model', {
          sessionId: room.sessionId,
          providerId: override.providerId,
          model: override.model,
          reasoningEffort: value || null,
        });
        const next = { providerId: override.providerId, model: override.model };
        if (value) next.reasoningEffort = value;
        roomModelRegistry = { ...roomModelRegistry, override: next };
      } catch { /* 下次打开聊天设置会如实重读服务端状态 */ }
    });
    on('#room-member-settings', 'click', async event => {
      const host = event.target.closest('[data-host]'), remove = event.target.closest('[data-remove]');
      if (host) await controller.host(host.dataset.host);
      if (remove) await controller.member(remove.dataset.remove, true);
      if (host || remove) { $('#room-options').close(); openOptions(); }
    });
    on('#compose-input', 'input', rememberView); on('#chat-scroll', 'scroll', rememberView);
    on('#compose-edit-cancel', 'click', () => { controller.cancelEdit(); $('#compose-input')?.focus?.(); });
    on('#compose-input', 'keydown', event => {
      if (event.key === 'Escape' && controller.snapshot().local.edit) { event.preventDefault(); controller.cancelEdit(); }
    });
    // profile 字段在面板内直接可编辑，没有中间弹层。
    on('#person-profile-form', 'submit', event => { event.preventDefault(); return saveProfile(); });
    on('#person-detail-listen', 'click', () => previewPersonVoice());
    // 「取消编辑」把字段恢复成已保存的值；换声音会直接进入编辑，好让「保存修改」出现。
    on('#person-detail-edit', 'click', () => {
      const person = controller.person(personDetailId);
      if ($('#person-profile-form')?.classList?.contains?.('is-editing')) { if (person) renderProfileFields(person); }
      else setProfileEditing(true);
    });
    for (const id of ['#person-detail-voice-select', '#person-detail-presence-select']) on(id, 'change', () => { if (profileEditGated()) setProfileEditing(true); });
    on('#person-detail-chat', 'click', () => {
      const person = controller.person(personDetailId);
      $('#person-detail')?.close?.();
      if (!person) return;
      const room = controller.snapshot().rooms.find(room => !room.archivedAt && room.memberIds.length === 1 && room.memberIds.includes(person.id));
      return room ? browse(room.sessionId) : openCreateRoomForPerson(person);
    });
    on('#person-detail', 'close', () => {
      // close 事件是异步派发的：同一拍里 close() 后又 show()（如在人物页再点「人物」）时，
      // 这个事件到达时对话框已经重新打开，不能再拿掉 person-page，否则人物页会叠在聊天上。
      if ($('#person-detail')?.open) return;
      $('#app')?.classList?.remove('person-page');
      if (!documentLike.activeElement || documentLike.activeElement === documentLike.body || $('#person-detail')?.contains?.(documentLike.activeElement)) {
        const target = [personReturnFocus, $('#compose-input'), $('#focus-mode-enter'), $('#mobile-pane-chat'), $('#nav-people')]
          .find(node => node?.isConnected && node.getClientRects?.().length && !node.closest?.('[inert]'));
        target?.focus?.();
      }
    });
    on('#person-detail', 'keydown', event => {
      if (event.key === 'Escape' && !$('#person-delete-confirm')?.open) { event.preventDefault(); $('#person-detail')?.close?.(); }
    });
    on('#person-detail-delete', 'click', () => openDeletePerson());
    on('#person-delete-confirm-button', 'click', () => confirmDeletePerson());
    on('#person-delete-cancel', 'click', () => { $('#person-delete-confirm')?.close?.(); $('#person-detail-delete')?.focus?.(); });
    // 经 ✕ 或 Esc 关闭确认框同样是取消，焦点也必须回给删除入口——
    // 只盯"取消"按钮会让键盘用户落在关闭后的虚空中。成功删除路径会先关详情面板，此监听自然跳过。
    on('#person-delete-confirm', 'close', () => {
      if (!$('#person-detail')?.open) return;
      $('#person-detail-delete')?.focus?.();
    });
    on('#room-quiet-restore', 'click', () => { void controller.restoreListenerQuiet(); });
    on('#room-history', 'click', () => controller.loadTranscript(controller.snapshot().sessionId, { older: true }));
    on('#room-listen', 'click', () => listen('now')); on('#room-after', 'click', () => listen('after_current'));
    on('#mismatch-listen-now', 'click', () => listen('now'));
    on('#mismatch-listen-after', 'click', () => listen('after_current'));
    on('#mismatch-return-source', 'click', () => {
      const sessionId = store.getState().runtimeState?.activeListeningSessionId;
      if (sessionId) return browse(sessionId);
    });
    on('#room-options-after', 'click', async () => { await listen('after_current'); $('#room-options').close(); });
    on('#player-artwork', 'click', () => $('#focus-mode-enter')?.click?.());
    on('#player-person', 'click', () => { const runtime = store.getState().runtimeState;
      const personId = runtime?.queue?.[runtime.currentIndex]?.virtualPersonId || runtime?.listeningPlan?.curatorId;
      return personId ? openPerson(personId) : undefined; });
    on('#player-source', 'click', () => browse(store.getState().runtimeState?.activeListeningSessionId));
    on('#player-switch-cancel', 'click', () => playbackRuntimeClient.cancelListeningSwitch());
    on('#person-detail-memories', 'click', async event => {
      if (event.target.closest('[data-person-memory-retry]')) return openPerson(personDetailId);
      const button = event.target.closest('[data-forget-memory], [data-correct-memory]'); if (!button) return;
      const row = button.closest('[data-memory]'); button.disabled = true;
      try { await apiClient.post(`/api/memory/records/${row.dataset.memory}`, { forget: button.hasAttribute('data-forget-memory'), content: row.querySelector('textarea').value }); await openPerson(personDetailId); }
      finally { button.disabled = false; }
    });
    documentLike.querySelectorAll('[data-close-dialog]').forEach(button => on(button, 'click', () => button.closest('dialog').close()));
    cleanups.push(controller.subscribe(render));
    cleanups.push(() => clearTimeout(undoTimer));
    cleanups.push(store.subscribe((next, previous) => {
      if (next.runtimeState !== previous.runtimeState) { renderPlayer(); renderMoment(); }
      if (next.virtualPersons !== previous.virtualPersons) render();
    }));
    return api;
  }
  const api = { init, render, browse, openPerson, openCreateRoomForPerson, rememberView,
    openSettings: () => toggleNavigation('settings'),
    // 离开设置页 = 回到聊天：只换主内容区，不顺手展开侧栏（关闭要能原样还原）。
    closeSettings: () => setNavigationMode('rooms'),
    listen: delivery => listen(delivery), destroy: () => cleanups.splice(0).forEach(fn => fn()) };
  return api;
}
