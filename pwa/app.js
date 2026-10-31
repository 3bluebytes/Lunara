// app.js — Lunara 桌面客户端
import { createAudioGraphController } from './audioGraph.js';
import { migrateStorageKey } from './storageMigration.js';
import { createAppState, reduceServerMessage } from './core/appState.js';
import { createApiClient } from './core/apiClient.js';
import { createWsClient } from './core/wsClient.js';
import { createClientPresence } from './core/clientPresence.js';
import { userFacingToastMessage } from './core/toastPolicy.js';
import { createPlaybackController } from './features/playback/playbackController.js';
import { createPlaybackRuntimeClient } from './features/playback/playbackRuntimeClient.js';
import { createNarrationCoordinator } from './features/playback/narrationCoordinator.js';
import { createPlaybackView } from './features/playback/playbackView.js';
import { createConversationController } from './features/conversations/conversationController.js';
import { createConversationView } from './features/conversations/conversationView.js';
import { createTodayView } from './features/today/todayView.js';
import { createListeningShellController } from './features/conversations/listeningShellController.js';
import { createListeningReactions } from './features/listening/listeningReactions.js';
import { createReactionConfirm } from './features/listening/reactionConfirm.js';
import { canDismissRequiredSetup, createFirstRunCoordinator } from './features/conversations/firstRunCoordinator.js';
import { createChatController } from './features/chat/chatController.js';
import { createChatInputView } from './features/chat/chatInputView.js';
import { escapeHtml } from './features/chat/chatMarkup.js';
import { createRadiohostController } from './features/radiohost/radiohostController.js';
import { createRadiohostView } from './features/radiohost/radiohostView.js';
import { createAuthController } from './features/auth/authController.js';
import { initAuthView } from './features/auth/authView.js';
import { createSourceFailureWarning } from './features/auth/sourceFailureWarning.js';
import { createRecordingReviewView } from './features/library/recordingReviewView.js';
import { initSourceMenu } from './features/auth/sourceMenu.js';
import { createMemoryController } from './features/memory/memoryController.js';
import { initMemoryView } from './features/memory/memoryView.js';
import { createSettingsController } from './features/settings/settingsController.js';
import { initSettingsView } from './features/settings/settingsView.js';
import { createPresenceAmbientSetting } from './features/settings/presenceAmbientSetting.js';
import { createWebAccessSetting } from './features/settings/webAccessSetting.js';
import { createRoutineSettings } from './features/settings/routineSettings.js';
import { createLlmProvidersSettings } from './features/settings/llmProvidersSettings.js';
import { createUsageSettings } from './features/settings/usageSettings.js';
import { createSongTagInspector } from './features/settings/songTagInspector.js';
import { createTasteController } from './features/taste/tasteController.js';
import { initTasteView } from './features/taste/tasteView.js';
import { createAtmosphereHost } from './themes/atmosphereHost.js';
import { createArtworkThemeController } from './visuals/artworkThemeController.js';
import { createSidebarResize } from './features/shell/sidebarResize.js';
import { createMoonlightSidebar } from './themes/moonlight/sidebar.js';
import { createTodaySplit } from './features/today/todaySplit.js';
import { createThemeController } from './visuals/themeController.js';
import { createNocturneMaterialController } from './visuals/nocturneMaterial.js';
import { createTopBarView } from './features/shell/topBarView.js';
import { createAppearancePopover } from './features/shell/appearancePop.js';
import { createTimelineView } from './features/shell/timelineView.js';
import { createChatAsideView } from './features/chat/chatAsideView.js';
import { createWaveformVisualizer } from './visuals/waveformVisualizer.js';
import { createRuntimePlaybackCallbacks } from './runtimePlaybackCallbacks.js';
import { createTooltipLayer } from './core/tooltip.js';

const $ = s => document.querySelector(s);
const audio = $('#audio');
const audioMusic = $('#audioMusic');
let conversationController;
let conversationView;
let topBarView = null;
let appearancePop = null;
let timelineView = null;
let firstRunCoordinator = null;
let autoplayRecoveryIdentity = null;
let startupBootstrapped = false;
let latestAuthSnapshot = null;
let setupResumePromise = null;
let automaticSetupPrompted = false;
const appStore = createAppState({
  queue: [],
  cursor: -1,
  activeRadiohost: null,
  virtualPersons: [],
  sessionId: 'conversation:primary',
  runtimeState: null,
});
const apiClient = createApiClient();

const state = {
  audioCtx: null,
  audioGraph: null,
  foregroundTurnId: null,
};

// 设置页等处的 `data-tip` 解释气泡（pwa/core/tooltip.js）：一处挂载，页面自己只写文案。
const tooltipLayer = createTooltipLayer({ documentLike: document }).init();

const authController = createAuthController({
  apiClient,
});
const authView = initAuthView({
  controller: authController,
  onError: error => showToast('error', '登录操作失败', error.message),
});
const sourceFailureWarning = createSourceFailureWarning({ onAction: ({ kind, source, code }) => {
  if (kind === 'voice') { settingsView.open(); settingsView.setPage('voice'); }
  else if (code === 'requires-auth' && authController.canLogin(source)) void authView.openSource(source);
  else { settingsView.open(); settingsView.setPage('general'); }
} });
const moonlightSidebar = createMoonlightSidebar().init();
const recordingReviewView = createRecordingReviewView({
  apiClient,
  beforeToggle: () => {
    const navigation = moonlightSidebar.navigate('recordings');
    return navigation === true ? 'open' : navigation ?? true;
  },
  onOpen: () => { if (!moonlightSidebar.isDesktop()) $('#sidebar-close')?.click(); },
});
const settingsController = createSettingsController({
  apiClient,
});
const sourceMenu = initSourceMenu({
  settingsController,
  // 浮窗在窄侧栏里空间有限：打开时顺便把最新状态取一次，而不是等下一次轮询。
  onOpen: () => { void settingsController.load().catch(() => {}); },
});
const settingsView = initSettingsView({
  controller: settingsController,
  authController,
  onSourceLogin: source => { void authView.openSource(source); },
  onSourceLogout: source => authView.logoutSource(source),
  storage: localStorage,
  getActiveRadiohost: () => appStore.getState().activeRadiohost,
  getMode: () => 'chat',
  onError: error => showToast('error', '设置错误', error.message),
  // 设置保存成功走 toast：页面里的内联说明仍然保留（那里写着值是多少），
  // toast 只负责「这次点下去确实存住了」。
  onToast: (type, title, message, options) => showToast(type, title, message, options),
  onOpen: () => { void routineSettings.refresh(); void llmProvidersSettings.refresh(); void songTagInspector.refresh(); void presenceAmbientSetting.refresh(); void webAccessSetting.refresh(); },
  onSectionChange: page => {
    void memoryView.setActive(page === 'memory');
    // 用量页只在自己可见时读账本，切走就不再请求。
    void usageSettings.setActive(page === 'usage');
  },
  // 设置是壳层页面：由导航层切换，和帐本/人物走同一条路径，
  // 切到别的页面时设置自然让位，而不是继续压在聊天页上。
  onPageEnter: () => conversationView?.openSettings?.(),
  onPageLeave: () => conversationView?.closeSettings?.(),
});
// 「设置 → 常规 → 作息」：生活上下文里工作日/上班时间/时区的来源。
const routineSettings = createRoutineSettings({ apiClient, showToast });
// 「设置 → 模型」：provider 注册表 + 使用中模型（unified-model-providers）。
const llmProvidersSettings = createLlmProvidersSettings({ apiClient, showToast });
// 「设置 → 使用统计」：账本聚合成热力图/趋势（add-usage-dashboard），只读、按需加载。
const usageSettings = createUsageSettings({ apiClient });
// 「设置 → 歌曲标签」：已入库歌曲标签的浏览与手动修正（song-tag-inspection）。
const songTagInspector = createSongTagInspector({ apiClient, showToast });
// 「设置 → 常规 → 陪伴」：一起听歌时伙伴会主动说话（add-companion-heartbeat）。
const presenceAmbientSetting = createPresenceAmbientSetting({ apiClient, showToast });
const webAccessSetting = createWebAccessSetting({ apiClient, showToast });
const memoryController = createMemoryController({
  apiClient,
});
const tasteController = createTasteController({ apiClient });
const tasteView = initTasteView({ controller: tasteController });
const memoryView = initMemoryView({
  controller: memoryController,
  onToast: showToast,
});

migrateStorageKey(localStorage, 'claudio.bootDone', 'lunara.bootDone');
[
  ['claudio_queue', 'lunara_queue'],
  ['claudio_cursor', 'lunara_cursor'],
  ['claudio_time', 'lunara_time'],
].forEach(([legacy, current]) => migrateStorageKey(sessionStorage, legacy, current));

// ===================== 视觉功能 =====================
// 主题氛围层（星点、浮尘等）由当前主题的 atmosphere.js 提供，宿主负责挂载与卸载。
const atmosphereHost = createAtmosphereHost({ container: $('#theme-atmosphere') });
const waveformVisualizer = createWaveformVisualizer({
  container: $('#waveform'),
  isIdle: () => audio.paused && audioMusic.paused,
  getProgress: () => (audioMusic.duration > 0 ? audioMusic.currentTime / audioMusic.duration : 0),
  isVoiceActive: () => !audio.paused,
  onAmplitude: amplitude => atmosphereHost.update({ amplitude }),
  barCount: 48,
  maxBarHeight: 24,
  idleBarHeight: 6,
});
const sidebarResize = createSidebarResize({
  handle: $('#sidebar-resize'),
  root: document.documentElement,
  storage: localStorage,
  windowLike: window,
  onError: () => {},
}).init();
// 帐本页「列表 | 编辑器」分隔线：只写 --today-list-width，不碰手记数据或播放。
const todaySplit = createTodaySplit({
  panel: $('#today-panel'),
  getHandle: () => document.querySelector('.today-split'),
  storage: localStorage,
  windowLike: window,
  onError: () => {},
}).init();
const artworkThemeController = createArtworkThemeController({
  root: document.documentElement,
  store: appStore,
  storage: localStorage,
  toggle: $('#artwork-theme-toggle'),
  onPaletteChange: () => {
    syncMetaThemeColor();
    atmosphereHost.refresh();
  },
}).init();

// --ambient-hue 的最终值是"主题基底或封面覆盖"，meta theme-color 只认这个解析后的值，
// 否则封面取色关闭时会写出 hsl(null …)。
function syncMetaThemeColor() {
  const resolved = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--ambient-hue'),
  );
  const hue = Number.isFinite(resolved) ? resolved : 230;
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', `hsl(${hue} 30% 11%)`);
}
const artworkThemeQuick = $('#artwork-theme-quick');
function syncArtworkThemeQuick() {
  const enabled = artworkThemeController.isEnabled();
  artworkThemeQuick?.setAttribute('aria-pressed', String(enabled));
  artworkThemeQuick?.setAttribute('title', enabled ? '关闭随歌曲封面变色' : '开启随歌曲封面变色');
}
function toggleArtworkThemeQuick() {
  artworkThemeController.setEnabled(!artworkThemeController.isEnabled());
  syncArtworkThemeQuick();
}
artworkThemeQuick?.addEventListener('click', toggleArtworkThemeQuick);
$('#artwork-theme-toggle')?.addEventListener('change', syncArtworkThemeQuick);
syncArtworkThemeQuick();

// 主题切换：先应用 data-theme（氛围层挂载时会读主题 token），再换氛围层。
const themeController = createThemeController({
  root: document.documentElement,
  storage: localStorage,
  container: $('#theme-choices'),
  modernistBaseContainer: $('#modernist-base-setting'),
  onThemeChange: theme => {
    artworkThemeController.setTheme(theme);
    syncArtworkThemeQuick();
    syncMetaThemeColor();
    atmosphereHost.activate(theme);
    waveformVisualizer.refresh();
    topBarView?.sync();
    // 浮层跟着布局走：换到别的版式就收起（触发器已随布局消失），同一版式里只换分组。
    appearancePop?.sync();
    timelineView?.sync();
    moonlightSidebar.setTheme(theme);
  },
  onError: () => {},
}).init();
// 夜场材质（实底 / 玻璃）：独立偏好，只写 data-material，不触发主题重挂。
const nocturneMaterial = createNocturneMaterialController({
  root: document.documentElement,
  storage: localStorage,
  container: $('#nocturne-material-setting'),
}).init();
syncMetaThemeColor();
// 首帧由 themes/boot.js 按保存的主题画出；控制器接管后再放开过渡动画。
// 后台窗口不跑 requestAnimationFrame，用定时器兜底，免得过渡一直被关着。
const endThemeBoot = () => { delete document.documentElement.dataset.themeBooting; };
requestAnimationFrame(() => requestAnimationFrame(endThemeBoot));
setTimeout(endThemeBoot, 500);
waveformVisualizer.init();

function setupAnalyser(targetAudio) {
  const el = targetAudio || audio;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!state.audioGraph) {
      state.audioGraph = createAudioGraphController({
        getAudioContext: () => state.audioCtx || (state.audioCtx = new Ctx()),
        musicAudio: audioMusic,
      });
    }
    const node = state.audioGraph.setupAnalyser(el);
    if (!node) return;
    state.audioCtx = state.audioGraph.audioCtx;
    waveformVisualizer.setAnalyser(node.analyser);
  } catch {}
}

let playbackController;
let playbackRuntimeClient;
const narrationCoordinator = createNarrationCoordinator({
  audio,
  locationHref: window.location.href,
}).init();

function releaseForegroundTurn() {
  if (!state.foregroundTurnId) return;
  narrationCoordinator.endForegroundTurn(state.foregroundTurnId);
  state.foregroundTurnId = null;
}
const playbackView = createPlaybackView({
  store: appStore,
  narrationAudio: audio,
  musicAudio: audioMusic,
  documentLike: document,
  windowLike: window,
  navigatorLike: navigator,
  locationHref: window.location.href,
  getController: () => playbackController,
  getRuntimeClient: () => playbackRuntimeClient,
  // 卡片指的歌已经不在当前队列里：点卡片只会在**当前队列**里解析身份，
  // 所以这里什么都不做，但必须当场说清（否则按钮看起来像坏的）。
  onCardUnavailable: () => showToast('info', '这首歌已经不在当前队列里',
    '点卡片只能切到队列里还在的歌；想让 Lunara 重新排这首，直接跟它说一句。', { curated: true }),
  onError: error => showToast('error', '播放操作失败', error.message),
  onUnlock: unlockInput,
});

playbackController = createPlaybackController({
  store: appStore,
  narrationAudio: audio,
  musicAudio: audioMusic,
  narrationCoordinator,
  apiClient,
  storage: localStorage,
  locationHref: window.location.href,
  getAudioGraph: () => state.audioGraph,
  callbacks: playbackView.callbacks,
});
playbackController.init();
playbackView.init();

// 喜欢：意图存服务端并按 remoteState 如实呈现；不喜欢由 runtime 原子移出并跳过。
const newLikeRequestId = () => (globalThis.crypto?.randomUUID
  ? `like_${globalThis.crypto.randomUUID()}`
  : `like_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
const reactionConfirm = createReactionConfirm({ documentLike: document }).init();
const listeningReactions = createListeningReactions({
  documentLike: document,
  localStorageLike: localStorage,
  onDislike: target => playbackRuntimeClient?.dismissTrack?.(target),
  // 用户按按钮是用户动作：直接打 HTTP，不进 agent，也不写关系记忆。
  onLike: ({ provider, songId, desired }) => apiClient.post('/api/track-like',
    { provider, songId, desired, requestId: newLikeRequestId() }),
  onRetryLike: ({ provider, songId }) => apiClient.post('/api/track-like/retry',
    { provider, songId, requestId: newLikeRequestId() }),
  fetchLike: ({ provider, songId }) => apiClient.get(
    `/api/track-like?provider=${encodeURIComponent(provider)}&songId=${encodeURIComponent(songId)}`),
  // 云端已有这首还点喜欢、以及不可逆的「不喜欢」：先弹一次确认，再动手。
  confirmAction: request => reactionConfirm.confirm(request),
  onNotice: notice => { if (notice?.title) showToast(notice.type || 'info', notice.title, notice.message || '', { curated: true }); },
  onError: error => showToast('error', '喜欢没同步成功', error?.message || '已记在本机，可稍后重试。'),
});
listeningReactions.init();
appStore.subscribe(snapshot => {
  const runtimeState = snapshot.runtimeState;
  const queue = Array.isArray(runtimeState?.queue) ? runtimeState.queue : [];
  const index = Number.isInteger(runtimeState?.currentIndex) ? runtimeState.currentIndex : -1;
  listeningReactions.setTrack(queue[index] ? { ...queue[index],
    listeningSessionId: runtimeState.activeListeningSessionId, outputGeneration: runtimeState.outputGeneration,
    browsingSessionId: snapshot.sessionId } : null);
});
playbackRuntimeClient = createPlaybackRuntimeClient({
  store: appStore,
  narrationAudio: audio,
  musicAudio: audioMusic,
  narrationCoordinator,
  apiClient,
  locationHref: window.location.href,
  callbacks: createRuntimePlaybackCallbacks({
    playbackView,
    setupAnalyser,
    musicAudio: audioMusic,
    onTrackEnded: (_command, duration) => {
      void playbackController.reportOutcomeForCurrent('completed', duration);
    },
    onError: (error, command) => console.warn('[runtime-playback] failed', command?.type, error?.message),
    onAutoplayBlocked: (error, command) => {
      if (handleAutoplayBlocked(error, command)) firstRunCoordinator?.handleAutoplayBlocked(error, command);
    },
  }),
});
playbackRuntimeClient.init();

function hidePlaybackRecovery() {
  const panel = $('#playback-recovery');
  const button = $('#playback-recovery-start');
  if (panel) panel.hidden = true;
  if (button) button.disabled = false;
  autoplayRecoveryIdentity = null;
}

function handleAutoplayBlocked(error, command) {
  if (error?.name !== 'NotAllowedError') return false;
  const runtime = appStore.getState().runtimeState;
  const index = Number.isInteger(runtime?.currentIndex) ? runtime.currentIndex : -1;
  const current = runtime?.queue?.[index];
  const queueItemId = command?.queueItemId;
  const correlationId = command?.correlationId;
  if (!queueItemId || !correlationId || !current
    || current.queueItemId !== queueItemId
    || runtime.txn?.queueItemId !== queueItemId
    || runtime.txn?.correlationId !== correlationId
    || (command.listeningSessionId && command.listeningSessionId !== runtime.activeListeningSessionId)) return false;
  autoplayRecoveryIdentity = { queueItemId, correlationId, sessionId: runtime.activeListeningSessionId };
  const panel = $('#playback-recovery');
  const button = $('#playback-recovery-start');
  if (panel) panel.hidden = false;
  if (button) button.disabled = typeof playbackRuntimeClient.retry !== 'function';
  return true;
}

const playbackRecoveryStart = $('#playback-recovery-start');
playbackRecoveryStart?.addEventListener('click', async () => {
  const identity = autoplayRecoveryIdentity;
  const runtime = appStore.getState().runtimeState;
  const index = Number.isInteger(runtime?.currentIndex) ? runtime.currentIndex : -1;
  const current = runtime?.queue?.[index];
  if (!identity || !current || current.queueItemId !== identity.queueItemId
    || runtime?.txn?.correlationId !== identity.correlationId
    || runtime?.activeListeningSessionId !== identity.sessionId) {
    hidePlaybackRecovery();
    return;
  }
  playbackRecoveryStart.disabled = true;
  try {
    await playbackRuntimeClient.retry();
    if (autoplayRecoveryIdentity) playbackRecoveryStart.disabled = false;
  } catch (error) {
    playbackRecoveryStart.disabled = false;
    showToast('error', '暂时无法开始播放', error.message);
  }
});
audioMusic.addEventListener('playing', hidePlaybackRecovery);
const unsubscribePlaybackRecovery = appStore.subscribe(next => {
  if (!autoplayRecoveryIdentity) return;
  const runtime = next.runtimeState;
  const index = Number.isInteger(runtime?.currentIndex) ? runtime.currentIndex : -1;
  const current = runtime?.queue?.[index];
  if (runtime?.activeListeningSessionId !== autoplayRecoveryIdentity.sessionId
    || current?.queueItemId !== autoplayRecoveryIdentity.queueItemId
    || runtime?.txn?.correlationId !== autoplayRecoveryIdentity.correlationId) hidePlaybackRecovery();
});

// ===================== WS =====================
function handleServerMessage(m) {
  console.log('[ws]', m.type, m.partial !== undefined ? `partial=${m.partial}` : '');
  if (m.type === 'hello') {
    console.log('[playback] authoritative runtime connected');
    for (const issue of m.sourceIssues || []) sourceFailureWarning.consume({ ...issue, type: 'music-source-status' });
    for (const issue of m.voiceIssues || []) sourceFailureWarning.consume({ ...issue, type: 'voice-endpoint-status' });
  }
  else if (m.type === 'music-source-status' || m.type === 'voice-endpoint-status') sourceFailureWarning.consume(m);
  else if (m.type === 'runtime-command') {
    void playbackRuntimeClient.execute(m.command);
  }
  else if (m.type === 'runtime-state') {
    playbackView.refresh();
    const phase = m.state?.phase;
    if (phase === 'speaking') playbackView.setStatus('speaking');
    else if (phase === 'playing') playbackView.setStatus('playing');
    else if (phase === 'loading') playbackView.setStatus('loading');
    else if (phase === 'paused') playbackView.setStatus('paused');
    else if (phase === 'error' || phase === 'exhausted' || phase === 'idle') playbackView.setStatus(phase);
  }
  else if (m.type === 'queue-update') applyQueueUpdate(m);
  else if (m.type === 'presence-activity') conversationController.consumeActivity(m.payload);
  else if (m.type === 'presence-listener-quiet') conversationController.consumeListenerQuiet(m.payload);
  else if (m.type === 'environment') listeningShell.syncEnvironment(m.environment);
  else if (m.type === 'library-updated') void recordingReviewView.handleServerEvent(m);
  else if (m.type === 'thinking') playbackView.setStatus('thinking');
  else if (m.type === 'thinking-done') {
    // 服务端明确告诉我们想完了：只在还卡在 thinking 时清掉，
    // 不要踩掉 speaking / playing 这种正在进行的状态。
    if ($('#status').dataset.state === 'thinking') playbackView.setStatus('idle');
    // 解锁兜底：agent 跑完后，如果 audio 实际没在播任何真东西
    // 就主动解锁。判断"没在播"用 src 是不是空，比 audio.paused 可靠
    // （phantom play() 会把 paused 翻 false 但其实啥也没播）。
    const noRealSrcNarr = !audio.src || audio.src === window.location.href;
    const noRealSrcMusic = !audioMusic.src || audioMusic.src === window.location.href;
    if (chatInputView.isLocked() && (audio.paused && audioMusic.paused || (noRealSrcNarr && noRealSrcMusic))) {
      unlockInput();
    }
  }
  else if (m.type === 'control') playbackView.handleControl(m.cmd);

  radiohostView.handleServerEvent(m);
}

const wsClient = createWsClient({
  store: appStore,
  onMessage: handleServerMessage,
  onOpen: () => { playbackView.setStatus('Idle'); void conversationController?.refreshListenerQuiet?.(); clientPresence?.connected(); },
  onClose: () => playbackView.setStatus('Idle'),
  onError: error => console.warn('[ws] connection error', error),
});

function connectWS() {
  return wsClient.connect();
}

// ===================== 聊天 =====================
const chatList = $('#chat-list');
const chatScroll = $('#chat-scroll');
const esc = escapeHtml;
const chatInputView = createChatInputView({
  compose: $('#compose'),
  input: $('#compose-input'),
  sendButton: $('#compose-send'),
  hint: $('#compose-hint'),
  hintText: $('#compose-hint-text'),
  onSubmit: send,
  onCancel: () => conversationController?.cancel(),
  onWarmAudio: warmAudio,
});
const chatController = createChatController({
  chatList,
  chatScroll,
  onTrackCardClick: button => playbackView.handleTrackCard(button),
  getSpeakerName: id => appStore.getState().virtualPersons
    ?.find(person => person.id === id)?.displayName || id || 'Lunara',
  // 主持建议的确认只走既有的「设为当前伙伴」路由；聊天文字从不当作确认。
  onConfirmHost: personId => conversationController.host(personId),
  // ambient 推荐的「放这首」只走推荐接口：排到当前歌之后，不切换听歌来源。
  onAcceptRecommendation: turnId => conversationController.acceptRecommendation(turnId),
  // 编辑只预填输入框，发送时才改写聊天；分叉只切换正在查看的聊天，不切换听歌来源。
  onEditMessage: turnId => { if (conversationController.beginEdit(turnId)) focusComposeEnd(); },
  onForkMessage: turnId => conversationController.fork(turnId).then(focusComposeEnd)
    .catch(error => showToast('error', '没能分叉', error.message)),
  // 引用只把那条消息的引用块写进输入框（可编辑文本），发送时才进账本。
  onQuoteMessage: quoteText => chatInputView.insertQuote(quoteText),
});
function focusComposeEnd() {
  const input = $('#compose-input');
  input?.focus?.();
  input?.setSelectionRange?.(input.value.length, input.value.length);
}
chatInputView.init();
// 「回来了」打招呼的依据：只上报窗口可见与是否在输入（add-app-open-greeting D1）。
const clientPresence = createClientPresence({ getSocket: () => wsClient.getSocket(), input: $('#compose-input') });
clientPresence.init();
const radiohostController = createRadiohostController({
  store: appStore,
  apiClient,
});
const radiohostView = createRadiohostView({
  controller: radiohostController,
  store: appStore,
  documentLike: document,
  onToast: showToast,
  autoLoad: false,
  onRenderMeta: () => renderSidebarMeta(),
  onLoaded: async () => {
    await conversationController.refresh();
    const focusedSessionId = appStore.getState().sessionId;
    await conversationController.loadTranscript(focusedSessionId);
    const listeningSessionId = appStore.getState().runtimeState?.activeListeningSessionId;
    if (listeningSessionId && listeningSessionId !== focusedSessionId) {
      await conversationController.loadTranscript(listeningSessionId);
    }
  },
  onCreateChat: person => conversationView.openCreateRoomForPerson(person),
  onListenWith: person => conversationView.openCreateRoomForPerson(person, { listenAfterCreate: true }),
  onStationMemoryEvent: message => memoryView.handleServerEvent(message),
});

conversationController = createConversationController({
  store: appStore, apiClient, storage: localStorage,
  onBeforeSend: ({ requestId }) => {
    releaseForegroundTurn();
    state.foregroundTurnId = narrationCoordinator.beginForegroundTurn(requestId);
  },
  onAfterSend: ({ requestId }) => {
    if (state.foregroundTurnId === requestId) releaseForegroundTurn();
  },
  onError: error => showToast('error', '聊天操作失败', error.message),
});
// 帐本：打开时才加载本地手记；浏览/编辑不切歌。作息在设置 → 常规管理。
const todayView = createTodayView({
  apiClient,
  getPeople: () => appStore.getState().virtualPersons || [],
  showToast: (kind, title, message, options) => showToast(kind, title, message, options),
  onError: error => showToast('error', '今日加载失败', error.message),
}).init();
conversationView = createConversationView({
  controller: conversationController, store: appStore, apiClient, chatController,
  chatInputView, playbackRuntimeClient,
  sidebarPresentation: moonlightSidebar,
  onBrowse: () => { releaseForegroundTurn(); narrationCoordinator.cancel(task => task.lane === 'foreground', 'conversation-browsed'); },
  onTodayOpen: () => { void todayView.load(); },
  onSettingsOpen: () => settingsView.open(),
  onSettingsClose: () => {
    void memoryView.setActive(false);
    void usageSettings.setActive(false);
    settingsView.stopPreview();
  },
  onError: error => showToast('error', '操作失败', error.message),
}).init();
// 「外观」浮层：时间线顶栏和舞台版式页眉共用一个面板。宿主只负责触发按钮，
// 打开前后收起顶栏的「全部」浮层，关掉后同步两处按钮的 aria-expanded。
appearancePop = createAppearancePopover({
  documentLike: document,
  appearance: {
    themes: () => themeController.choices(),
    theme: () => themeController.current(),
    setTheme: id => themeController.set(id),
    material: () => nocturneMaterial.material(),
    setMaterial: name => nocturneMaterial.set(name),
    base: () => themeController.modernistBase(),
    setBase: name => themeController.setModernistBase(name),
    artwork: () => artworkThemeController.isEnabled(),
    setArtwork: enabled => { artworkThemeController.setEnabled(enabled); syncArtworkThemeQuick(); },
  },
  beforeOpen: () => topBarView?.closeOverlay({ restoreFocus: false }),
  onOpenChange: () => {
    $('#appearance-quick')?.setAttribute('aria-expanded', String(appearancePop.isOpen()));
    topBarView?.sync();
  },
  onSettings: () => $('#nav-settings')?.click(),
  onError: error => showToast('error', '操作失败', error.message),
}).init();
// 舞台版式（月色 / 素色）的页眉入口：贴着这个按钮弹出，关闭后焦点还给同一个按钮。
$('#appearance-quick')?.addEventListener('click', () => appearancePop.toggle({
  anchor: true,
  returnFocus: () => $('#appearance-quick')?.focus?.(),
}));

topBarView = createTopBarView({
  controller: conversationController, store: appStore, documentLike: document,
  browse: id => conversationView.browse(id),
  appearance: appearancePop,
  onError: error => showToast('error', '操作失败', error.message),
}).init();
timelineView = createTimelineView({
  store: appStore, controller: conversationController, documentLike: document,
  runtimeClient: () => playbackRuntimeClient,
  onError: error => showToast('error', '操作失败', error.message),
}).init();
createChatAsideView({ documentLike: document, onError: error => showToast('error', '操作失败', error.message) }).init();
const listeningShell = createListeningShellController({
  appElement: $('#app'),
  documentLike: document,
  windowLike: window,
  beforePresentationChange: () => conversationView?.rememberView(),
}).init();

firstRunCoordinator = createFirstRunCoordinator({
  storage: localStorage,
  store: appStore,
  playbackRuntimeClient,
  requestDefaultMusic: ({ sessionId, requestId, delivery }) => apiClient.post('/api/next', {
    sessionId, requestId, delivery,
  }),
  focusRoot: sessionId => conversationView.browse(sessionId),
  onSetupRequired: state => {
    // 设置已是应用内页面，不再首启强拉：只提示一次，用户自己点「设置」完成连接。
    if (!automaticSetupPrompted) {
      automaticSetupPrompted = true;
      if (state.missing === 'source-login' && state.source) {
        void authView.openSource(state.source);
      } else {
        showToast('error', '设置还没完成', '模型或音乐源未配置：点左侧「设置 → 模型与连接」填写后，Lunara 才能开始一起听。');
      }
    }
  },
  onState: state => {
    if (['started', 'returning-session', 'completed', 'autoplay-blocked'].includes(state.kind)) {
      const settings = settingsController.getSnapshot();
      if (canDismissRequiredSetup({ status: state, settings, auth: latestAuthSnapshot })) {
        settingsView.close();
      }
    } else if (state.kind === 'bootstrap-unavailable') {
      showToast('error', '无法读取播放状态', '为避免重复选歌，Lunara 暂时没有自动开始。');
    } else if (state.kind === 'request-failed') {
      showToast('error', '还没有开始播放', '暂时未能确认选歌结果，请稍后检查队列。');
    } else if (state.kind === 'root-unavailable') {
      showToast('error', 'Lunara 聊天暂不可用', '没有找到主聊天，因此没有提交选歌请求。');
    }
  },
});

function applyQueueUpdate(message) {
  conversationController.consume(message);
  const belongs = (message.conversationId || message.sessionId) === appStore.getState().sessionId;
  playbackView.handleQueueUpdate({ ...message, overlayNarrations: belongs ? message.overlayNarrations : [] });
}

function unlockInput() {
  if (!conversationController?.isPending() && !conversationController?.snapshot().room?.archivedAt) chatInputView.setLocked(false);
}

function warmAudio() {
  if (state.audioCtx?.state === 'suspended') state.audioCtx.resume().catch(() => {});
}

function send(message) {
  return conversationController.send(message, { interrupt: conversationController.isPending() });
}
function renderSidebarMeta() {
  settingsView.renderSidebarMeta();
}

radiohostView.init();
connectWS();

// ===================== 启动 =====================

function applyRuntimeSnapshot(snapshot) {
  if (!snapshot?.runtime || !Array.isArray(snapshot.runtime.queue)) return false;
  reduceServerMessage(appStore, { type: 'runtime-state', state: snapshot.runtime });
  playbackView.refresh();
  return true;
}

async function resumeFirstRunAfterSetup() {
  if (!startupBootstrapped || firstRunCoordinator.getSnapshot().kind !== 'needs-setup' || setupResumePromise) return setupResumePromise;
  setupResumePromise = (async () => {
    const settings = settingsController.getSnapshot();
    const auth = latestAuthSnapshot;
    if (!settings?.current || !auth) return;
    let runtime = null;
    try {
      const now = await apiClient.get('/api/now');
      if (applyRuntimeSnapshot(now)) runtime = now.runtime;
    } catch {}
    await firstRunCoordinator.start({
      runtime,
      settings,
      auth,
      rooms: conversationController.snapshot().rooms,
    });
  })().catch(error => showToast('error', '暂时无法恢复首启', error.message)).finally(() => {
    setupResumePromise = null;
  });
  return setupResumePromise;
}

const unsubscribeFirstRunAuth = authController.subscribe(snapshot => {
  latestAuthSnapshot = snapshot;
  void resumeFirstRunAfterSetup();
});
const unsubscribeFirstRunSettings = settingsController.subscribe(() => {
  void resumeFirstRunAfterSetup();
});

async function bootstrapFirstRun() {
  const [settingsResult, authResult, nowResult, environmentResult] = await Promise.allSettled([
    settingsView.start(),
    authController.refresh(),
    apiClient.get('/api/now'),
    apiClient.get('/api/environment'),
  ]);
  const settings = settingsResult.status === 'fulfilled' ? settingsResult.value : null;
  const auth = authResult.status === 'fulfilled' ? authResult.value : null;
  latestAuthSnapshot = auth;
  const now = nowResult.status === 'fulfilled' ? nowResult.value : null;
  const hasRuntime = applyRuntimeSnapshot(now);
  // 天气角标的初始状态；此后靠 environment 事件增量更新。
  if (environmentResult.status === 'fulfilled' && environmentResult.value?.ok) {
    listeningShell.syncEnvironment(environmentResult.value.environment);
  }

  let peopleReady = false;
  try { peopleReady = await radiohostView.load(); } catch {}
  startupBootstrapped = true;
  await firstRunCoordinator.start({
    runtime: hasRuntime ? now.runtime : null,
    settings,
    auth,
    rooms: peopleReady ? conversationController.snapshot().rooms : [],
  });
}

void bootstrapFirstRun().catch(error => {
  showToast('error', 'Lunara 暂时无法启动', error.message);
});

// 注册新 SW —— v=14 之后 SW 不再代缓存，所有请求直走网络。
// 同时主动清掉本地任何旧 cache，下一次刷新就能拿新版。
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js?v=17').catch(() => {});
  if (window.caches) {
    caches.keys().then(keys => keys.forEach(k => caches.delete(k))).catch(() => {});
  }
}

// ===================== Toast 系统 =====================
const activeToasts = new Map();

function dismissToast(element, key) {
  if (!element?.parentNode) return;
  clearTimeout(element.__dismissTimer);
  activeToasts.delete(key);
  element.classList.add('dismiss');
  setTimeout(() => element.remove(), 300);
}

function showToast(type, title, msg, options) {
  const stack = $('#toast-stack');
  if (!stack) return;
  const safeMessage = userFacingToastMessage(type, title, msg, options);
  const key = `${type}:${title}:${safeMessage}`;
  const existing = activeToasts.get(key);
  if (existing?.parentNode) {
    existing.__count = (existing.__count || 1) + 1;
    const count = existing.querySelector('.toast-count');
    if (count) count.textContent = `×${existing.__count}`;
    clearTimeout(existing.__dismissTimer);
    existing.__dismissTimer = setTimeout(() => dismissToast(existing, key), 5000);
    return;
  }
  while (stack.children.length >= 3) {
    const oldest = stack.firstElementChild;
    if (!oldest) break;
    clearTimeout(oldest.__dismissTimer);
    activeToasts.delete(oldest.dataset.toastKey || '');
    oldest.remove();
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.dataset.toastKey = key;
  el.__count = 1;
  el.innerHTML = `<span class="toast-status" aria-hidden="true"></span><div class="toast-body"><div class="toast-title">${esc(title)}</div><div>${esc(safeMessage)}</div></div><span class="toast-count" aria-label="重复次数"></span><button class="toast-close" aria-label="关闭通知">✕</button>`;
  stack.appendChild(el);
  activeToasts.set(key, el);
  el.querySelector('.toast-close').addEventListener('click', () => dismissToast(el, key));
  el.__dismissTimer = setTimeout(() => dismissToast(el, key), 5000);
}

// ===================== 伙伴面板 =====================
// ===================== 创建伙伴 Modal =====================
window.addEventListener('beforeunload', event => {
  // 留在页面继续编辑时，保留连接与视图；真正离开由浏览器释放资源。
  if (event.defaultPrevented) return;
  sourceFailureWarning.destroy();
  authView.destroy();
  sourceMenu.destroy();
  recordingReviewView.destroy();
  settingsView.destroy();
  reactionConfirm.destroy();
  listeningReactions.destroy();
  tooltipLayer.destroy();
  tasteView.destroy();
  memoryView.destroy();
  conversationView.destroy();
  listeningShell.destroy();
  chatInputView.destroy();
  clientPresence.destroy();
  radiohostView.destroy();
  wsClient.destroy();
  playbackRuntimeClient.destroy();
  playbackView.destroy();
  playbackController.destroy();
  waveformVisualizer.destroy();
  atmosphereHost.destroy();
  artworkThemeQuick?.removeEventListener('click', toggleArtworkThemeQuick);
  $('#artwork-theme-toggle')?.removeEventListener('change', syncArtworkThemeQuick);
  appearancePop?.destroy();
  themeController.destroy();
  artworkThemeController.destroy();
  sidebarResize.destroy();
  moonlightSidebar.destroy();
  todaySplit.destroy();
}, { once: true });
