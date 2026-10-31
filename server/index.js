// index.js — Express + WS 入口
// 把所有模块拼起来，对外暴露 PWA 静态文件、HTTP API、WS /stream。

import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { runServerEntrypoint } from './app/runServerEntrypoint.js';

import * as llm from './llm.js';
import { createSessionModelOverrides } from './llmProviders.js';
import { setSessionModelOverrides } from './llm.js';
import { LlmSettingsService } from './services/LlmSettingsService.js';
import * as ncm from './ncm.js';
import { createMusicSourceComponent, resolveAudioDirectUrl } from './app/createMusicSourceWiring.js';
import * as qq from './qq.js';
import * as tts from './tts.js';
import * as state from './state.js';
import * as envMod from './env.js';
import * as scheduler from './scheduler.js';
import * as candidates from './candidates.js';
import * as consolidator from './consolidator.js';
import * as musicResolver from './musicResolver.js';
import { ListeningReflectionBridge } from './station/ListeningReflectionBridge.js';
import { createPresenceWiring } from './presence/createPresenceWiring.js';
import { trace, traceSection } from './trace.js';
import { StationAgent } from './station/StationAgent.js';
import { StationDreamingService } from './station/StationDreamingService.js';
import { loadPersonaMarkdown, deletePersonaMarkdown } from './persona/personaLoader.js';
import * as VoiceDirectory from './station/VoiceDirectory.js';
import { generateDailySummary } from './memory/summary.js';
import { createBus } from './station/communication/AgentMessageBus.js';
import { EventType, createEvent, StationAgentId } from './station/communication/messages.js';
import { getSongTagStore } from './songtags/songTagStore.js';
import { enqueueTagging } from './songtags/taggingQueue.js';
// 选曲上下文要用曲库 revision 与「喜欢的歌手」，两者读同一个 LibraryStore 单例。
// 6ec3e54 把曲库装配抽进 createLibraryWiring 时删掉了这条 import，但 musicSelectionService
// 的两个 getter 仍在调用 getLibraryStore()；缺失的绑定让每次 select_music 都在 context()
// 末尾抛 ReferenceError，被工具层压成 INTERNAL_TOOL_ERROR（播放因此一直失败）。
import { getLibraryStore } from './library/libraryStore.js';
import { getTrackLikeStore } from './music/trackLikeStore.js';
import { TrackLikeService } from './services/TrackLikeService.js';
import { createLikeHydration } from './music/likeHydration.js';
import { createLibraryWiring } from './app/createLibraryWiring.js';
import { readSourcePolicy } from './music/sourcePolicy.js';
import { getSettingsSnapshot, updateSettings, restoreRuntimeSettings, readRecommendationWeights } from './settingsService.js';
import { createLocationService, createLazyAutoLocation, readStoredLocation } from './locationService.js';
import { createTtsCustomService, migrateLegacyMinimaxTtsConfig } from './tts/ttsCustomService.js';
import { getPublicLLMConfig } from './llmConfig.js';
import { WebSocketHub } from './realtime/WebSocketHub.js';
import { createPersonVoice, syncCustomVoices } from './tts/personVoice.js';
import { QueueService } from './playback/QueueService.js';
import { RadioRequestService } from './requests/RadioRequestService.js';
import { createMusicSelectionAgent } from './program/MusicSelectionAgent.js';
import { MusicSelectionService } from './program/MusicSelectionService.js';
import { findCuratedFallbacks, validateCuratedFallback } from './program/curatedFallbacks.js';
import { createProductionMusicCandidateSupply } from './program/musicCandidateSupply.js';
import { playbackMixShares } from './music/recommendationMix.js';
import { getPlaylistTracks, getAlbumTracks } from './tools/musicTools.js';
import { ProgramCommitService } from './program/ProgramCommitService.js';
import { createNarrationWiring } from './app/createNarrationWiring.js';
import { validateResolvedTrackAgainstRequest } from './program/programConstraintValidation.js';
import { resumeCommandsForState } from './playback/PlaybackRuntime.js';
import { createPlaybackRuntimeComposition } from './playback/createPlaybackRuntimeComposition.js';
import { createLifeContextRuntime } from './life/createLifeContextRuntime.js';
import { AuthService } from './services/AuthService.js';
import { StationService } from './services/StationService.js';
import { MemoryAdminService } from './services/MemoryAdminService.js';
import { HealthService, SettingsHttpService } from './services/RuntimeInfoServices.js';
import { productionSourceHealth } from './app/createSourceHealthWiring.js';
import { createPlaybackOperationsService } from './app/createPlaybackOperationsWiring.js';
import { getTrackFailureStats } from './playback/trackFailureStats.js';
import { WarmPoolAdminService } from './services/WarmPoolAdminService.js';
import { ReflectionAdminService } from './services/ReflectionAdminService.js';
import { TasteAdminService } from './services/TasteAdminService.js';
import { collectStationTasteSchemas } from './memory/TasteSchemaService.js';
import { projectTasteProfileToStationMemory as projectCanonicalTasteProfile } from './library/tasteProfileProjection.js';
import { createVirtualPersonRuntimeComposition } from './virtual-person/createVirtualPersonRuntimeComposition.js';
import { createWebAccess } from './web-access/createWebAccess.js';
import { VirtualPersonService } from './virtual-person/VirtualPersonService.js';
import { consolidateStation } from './station/StationConsolidation.js';
import { createHttpApp } from './app/createHttpApp.js';
import { registerDefaultRoutes } from './http/registerDefaultRoutes.js';
import { resolveTtsCacheDir, resolveDatabasePath, resolveAudioCacheDir, resolveImageCacheDir, resolveDataRoot } from './runtimePaths.js';
import { createSessionTraceWiring, recordTrackIntroTurn } from './app/createSessionTraceWiring.js';
import { createLlmRuntimeWiring } from './app/createLlmRuntimeWiring.js';
import { createRuntime } from './app/createRuntime.js';
import { createProductionLifecycle } from './app/createProductionLifecycle.js';
import { ManagedTaskGroup } from './app/ManagedTaskGroup.js';
import { ensureUserDataFiles } from './userData.js';
import { startRuntime, stopRuntime } from './app/startRuntime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT || '8080', 10);

// ---- Station Agent (initialized in start()) ----
let _station = null;
let _dream = null;

async function projectTasteProfileToStationMemory({ provider, accountUid, profile }) {
  return projectCanonicalTasteProfile({ station: _station, provider, accountUid, profile });
}

// The request-shape guard must accept the address this process actually binds,
// which `start()` may override per call, so it reads this through a getter.
let _boundHost = String(process.env.LUNARA_HOST || '127.0.0.1');
const app = createHttpApp({ bindHost: () => _boundHost });

// ---- 静态资源 ----
// 壳层 JS/CSS 强制重新验证（no-cache = 每次带 ETag 条件请求，未变更返回 304）：
// 模块入口虽有 ?v= 版本号，但子模块 import 无版本号，启发式缓存曾让新版设置页
// 配上旧 app.js（provider 卡片空白）。no-cache 让所有更新即时可见，代价可忽略。
app.use('/', express.static(resolve(ROOT, 'pwa'), {
  setHeaders: (res, filePath) => {
    if (/\.(js|mjs|css|html)$/.test(String(filePath))) res.setHeader('Cache-Control', 'no-cache');
  },
}));
app.use('/tts', express.static(resolveTtsCacheDir(), {
  maxAge: '7d',
  fallthrough: false,
}));
app.use('/audio', express.static(resolveAudioCacheDir(), {
  maxAge: '1d',
  fallthrough: false,
}));
app.use('/img', express.static(resolveImageCacheDir(), {
  maxAge: '7d',
  fallthrough: false,
}));

// ---- WS bus ----
const httpServer = createServer(app);
const webSocketHub = new WebSocketHub({
  hello: () => ({ type: 'hello', name: 'Lunara', now: envMod.getNow(), playbackRuntime: true, sourceIssues: productionSourceHealth.sourceIssues(), voiceIssues: voiceHealth.issues() }),
  queueSnapshot: () => queueService.snapshot(),
  runtimeSnapshot: () => playbackRuntime.snapshot(),
  runtimeCommands: snapshot => resumeCommandsForState(snapshot),
  // HTTP 守卫不覆盖 upgrade 路径，WS 必须自己过同一条本地边界；Host 与 Origin 自洽即足够。
  localBoundary: { bindHost: () => _boundHost },
});
function broadcast(msg) {
  return webSocketHub.broadcast(msg);
}
productionSourceHealth.subscribe(broadcast);
// ---- 环境感知（位置 + 天气） ----
// 坐标来源是用户设置的位置偏好；未设置位置时伙伴不感知天气，也不广播天气。
// _environmentAbort 常备：模块导入期的自动定位就要能被停机中止；stop() 中止并置空，
// start() 补建。置空期间迟发的环境广播直接跳过，不带出无主 fetch。
let _environmentAbort = new AbortController();
envMod.setLocationProvider(() => readStoredLocation(state));

async function currentEnvironmentEvent() {
  if (!_environmentAbort) return null; // 停机后迟发的环境请求直接跳过，不带出无主 fetch
  void triggerAutoLocation();
  const weather = await envMod.getWeather({ signal: _environmentAbort.signal });
  return envMod.environmentEventPayload(weather);
}

let _environmentBroadcastQueued = false;
function broadcastEnvironment() {
  if (_environmentBroadcastQueued) return;
  _environmentBroadcastQueued = true;
  setTimeout(() => {
    _environmentBroadcastQueued = false;
    currentEnvironmentEvent()
      .then(environment => { if (environment) broadcast({ type: 'environment', environment }); })
      .catch(() => {});
  }, 0);
}

// 天气缓存自然刷新（≥30 分钟一次）后向在线客户端广播最新环境。
envMod.setWeatherRefreshListener(() => broadcastEnvironment());

const locationService = createLocationService({
  state,
  getSignal: () => _environmentAbort?.signal ?? null,
  onChanged: () => {
    envMod.invalidateWeatherCache();
    broadcastEnvironment();
  },
});
// 自动定位改为**懒触发**：服务启动本身不发任何网络请求。触发点 =
// 真实消费者索取环境的时刻（GET /api/environment、聊天回合组装 prompt、
// 设置页显式「自动定位」）。首次响应如实返回"暂无位置"，定位完成后经
// onChanged 广播补发；每进程成功一次即止，失败 5 分钟退避。见 locationService。
const triggerAutoLocation = createLazyAutoLocation(locationService, { logger: console });

// ---- 会话执行记录（私有 JSONL）----（装配见 server/app/createSessionTraceWiring.js）
const { capabilityProbe, usageLedger, onModelEvent } = createLlmRuntimeWiring();
const { sessionTrace, recordServiceEvent, onRoomDeleted } = createSessionTraceWiring({ getConversationStore: () => virtualPerson?.conversationStore, getRegistry: () => virtualPerson?.registry, onModelEvent });

// ---- 播放队列 ----
// 每个 item 有 { kind, status:'upcoming'|'playing'|'played', ... }
const queueService = new QueueService({ publish: message => broadcast(message) });
let radioRequestService = null;
let musicSelectionService = null;
const playbackRuntime = createPlaybackRuntimeComposition({
  prefs: state,
  queueService,
  publish: broadcast,
  trace: recordServiceEvent('playback'),
  getRadioRequestService: () => radioRequestService,
  prepareTrackNarration: (effect, options) => narrationAgent.prepareTrack(effect, options),
  resolveTrackNarrationAsset: (effect, options) => programNarrationComposer.resolveTrackNarrationAsset(effect, options),
  onTrackNarrationStarted: (snapshot, event, track) => recordTrackIntroTurn({ sessionTrace,
    conversationStore: virtualPerson.conversationStore, queueService, publish: broadcast, snapshot, event, track }),
});

// ---- 声音身份：仅自定义接口与系统语音，无本地模型服务 ----
const { resolvePersonVoice, synthesizeForPerson, performanceCapabilityForPerson, voiceHealth } = createPersonVoice({ publish: broadcast, failureLog: state.ttsFailureLog });

// ---- 持续对话虚拟人 runtime ----
// 每位角色通过同一个 AgentLoop 使用结构化音乐工具；PlaybackRuntime 独占真实音频输出。
const lifeContext = createLifeContextRuntime({ resolveDatabasePath, playbackRuntime }); // life.db，默认私有；变更失效未播串词
let virtualPersonService = null;
const webAccess = createWebAccess({ state });
const virtualPerson = createVirtualPersonRuntimeComposition({
  sessionTrace,
  webAccess,
  chat: (messages, tools, options) => llm.chat(messages, tools, options),
  synthesize: ({ text, voiceProfileId, signal }) => synthesizeForPerson(text, { voiceProfileId, signal }),
  publish: broadcast,
  queueService,
  playbackRuntime,
  getMemoryService: () => _station?.stationMemory,
  isSharedMemoryActive: row => _station?.isStationSeedActive(row) ?? false,
  getMusicService: () => musicSelectionService,
  getEnvironment: () => {
    void triggerAutoLocation();
    return envMod.snapshot();
  },
  getLifeContext: lifeContext.getLifeContext,
  personaGateway: {
    create: input => virtualPersonService.create(input),
    list: () => virtualPersonService.list(),
    activate: input => virtualPersonService.activate(input),
    listVoices: () => VoiceDirectory.listVoiceProfiles(),
  },
  observeCommittedTurn: event => {
    if (!_station?.bus) return;
    _station.bus.publishEvent(createEvent({
      type: EventType.TURN_COMMITTED,
      sourceAgentId: `virtual-person:${event.virtualPersonId}`,
      payload: event,
      correlationId: event.requestId,
    }));
  },
  logger: console,
});
virtualPersonService = new VirtualPersonService({
  registry: virtualPerson.registry,
  conversationStore: virtualPerson.conversationStore,
  createRadiohost: input => {
    if (!_station) throw new Error('station unavailable');
    return _station.createRadioHost(input);
  },
  runtime: virtualPerson.runtime,
  playbackRuntime,
  ambientRecommendations: virtualPerson.ambientRecommendations,
  loadPersona: loadPersonaMarkdown,
  // 删除伙伴需要跨越记忆 / 文件 / 遗留注册项三类存储。这些不属于 VirtualPersonService
  // 的职责，因此在装配处注入，与本类已有的 createRadiohost / loadPersona 注入方式一致。
  countMemories: entity => {
    const store = _station?.stationMemory?.store;
    return store && entity?.memoryNamespace ? store.countByNamespace(entity.memoryNamespace) : 0;
  },
  purgeMemories: entity => {
    const store = _station?.stationMemory?.store;
    return store && entity?.memoryNamespace ? store.deleteByNamespace(entity.memoryNamespace) : 0;
  },
  deletePersonaFile: id => deletePersonaMarkdown(id),
  unregisterLegacyHost: async id => {
    if (!_station?.deleteRadioHost) return false;
    try {
      // 遗留 radiohosts 注册项：虚拟人创建时会双写一份，删实体时必须一并清理。
      return (await _station.deleteRadioHost(id)) !== false;
    } catch (error) {
      console.warn(`[virtual-person] legacy host cleanup failed for ${id}:`, error.message);
      return false;
    }
  },
  // 编辑声音时拒绝未知引用：legacy 别名（供应商 voice id、新旧显示名）都算已知。
  resolveVoiceProfile: id => VoiceDirectory.resolveProfileId(id),
  onRoomDeleted,
});
const { programNarrationComposer, narrationAgent } = createNarrationWiring({
  agentLoop: virtualPerson.agentLoop, toolRegistry: virtualPerson.toolRegistry, registry: virtualPerson.registry,
  conversationStore: virtualPerson.conversationStore, getSongTagStore, getMemoryService: () => _station?.stationMemory,
  // trackLikeService 在下方才初始化；串词时一定已就绪，读不到时 narrationContext 当作未知。
  getTrackLikeService: () => trackLikeService,
  getListeningSnapshot: sessionId => playbackRuntime.listeningSnapshot(sessionId),
  getLifeSnapshot: lifeContext.getLifeContext,
  getMusicService: () => musicSelectionService, synthesize: synthesizeForPerson, getPerformanceCapability: performanceCapabilityForPerson, sessionTrace });
const likeHydration = createLikeHydration();

const getSourcePolicy = () => readSourcePolicy(state);
const programCommitService = new ProgramCommitService({
  getSourcePolicy,
  resolveTrack: (query, options) => musicResolver.resolveTrack(query, options),
  findSubstitutes: findCuratedFallbacks,
  validateSubstitute: validateCuratedFallback,
  queueService,
  playbackRuntime,
  attemptsPerCandidate: Number.parseInt(process.env.PROGRAM_RESOLUTION_ATTEMPTS || '1', 10),
  resolutionBudgetMs: Number.parseInt(process.env.PROGRAM_RESOLUTION_BUDGET_MS || '12000', 10),
  onTrackCommitted: (track, program) => {
    state.logPlay({
      query: `${track.artist} ${track.title}`.trim(),
      song_id: track.songId,
      title: track.title,
      artist: track.artist,
      album: track.album,
      url: track.url,
      duration: track.duration,
      source: track.source,
    });
    likeHydration.request(program);
  },
  validateResolvedTrack: (track, context) => validateResolvedTrackAgainstRequest(track, {
    request: context.candidateProgram?.metadata?.musicSelection,
    songTagStore: getSongTagStore(),
  }),
  trace: recordServiceEvent('program'),
});

const musicCandidateSupply = createProductionMusicCandidateSupply({
  getSourcePolicy,
  recommendationWeights: () => readRecommendationWeights(state), trace: recordServiceEvent('music') });
musicSelectionService = new MusicSelectionService({
  getSourcePolicy, getSourceFailures: () => productionSourceHealth.authFailures(),
  programCommitService, playbackRuntime, registry: virtualPerson.registry,
  // 候选交给模型挑选时在后台预解析可播放版本（并发 3），提交时复用；预热批次不预解析。
  preResolveConcurrency: 3,
  trace: recordServiceEvent('music'),
  conversationStore: virtualPerson.conversationStore,
  getMemoryService: () => _station?.stationMemory,
  isSharedMemoryActive: row => _station?.isStationSeedActive(row) ?? false,
  getSongTagStore, getPlaylistTracks, getAlbumTracks,
  getRecentPlays: sinceTs => state.recentPlaysIdentitySince(sinceTs),
  getListeningHistory: ({ personId, since }) => (store => ({ plays: state.playsWithOutcomeSince(since), songStats: store?.db ? store.songStats(personId, { limit: 200 }) : [],
    observations: store?.db ? store.recentPlaybackObservations(personId, { since }) : [] }))(_station?.getReflectionAgent()?.store),
  getFamiliarArtists: () => getLibraryStore().listLikedArtists(),
  getLibraryRevision: () => JSON.stringify([
    getLibraryStore().db.prepare('SELECT COUNT(*) AS count, MAX(last_seen_at) AS latest, MAX(removed_at) AS removed FROM library_tracks').get(),
    getSongTagStore().db.prepare('SELECT COUNT(*) AS count, MAX(updated_at) AS latest FROM song_tags').get(),
  ]),
  getCandidates: input => musicCandidateSupply.getCandidates(input), searchArtistCatalog: (artist, options) => musicCandidateSupply.searchArtistCatalog(artist, options),
});
musicSelectionService.attachOutcomeLedger();


// ---- HTTP API ----

const authService = new AuthService({
  providers: { ncm, qq },
  prefs: state,
  onLoggedIn: ({ source, userId, nickname }) => {
    musicSelectionService.clearUnplayableForProvider(source);
    productionSourceHealth.recordAuthenticated(source);
    void librarySyncCoordinator.discover(source, { trigger: 'login' }).catch(error =>
      trace(`[library] login discovery failed provider=${source}: ${error.message}`));
  },
});

// 启动时恢复 cookie（NCM + QQ 各自）
const savedCookie = state.getPref('ncm_cookie');
if (savedCookie) ncm.setCookie(savedCookie);
const savedQQCookie = state.getPref('qq_cookie');
if (savedQQCookie) qq.setCookie(savedQQCookie);

// 续播与手动下一首的受限任务入口：同一 AgentLoop、无合成用户消息（见 program/MusicSelectionAgent.js）。
const musicSelectionAgent = createMusicSelectionAgent({ agentLoop: virtualPerson.agentLoop, toolRegistry: virtualPerson.toolRegistry, registry: virtualPerson.registry });
radioRequestService = new RadioRequestService({ conversationService: virtualPerson.chatService,
  musicService: musicSelectionService, getMusicSelectionAgent: () => musicSelectionAgent,
  sessionTrace, playbackRuntime, conversationStore: virtualPerson.conversationStore,
  // 续选人 = 房间当前主持人；被归档的角色不可用，回退到第一个可用成员。
  isPersonAvailable: id => {
    const person = virtualPerson.registry.get(id);
    return Boolean(person) && person.status !== 'archived';
  } });

// Browser reports provide playback analytics. The runtime bridge owns person-specific learning.
async function applyPlayOutcome({ song_id, outcome, played_seconds }) {
  const r = state.recordOutcome({
    song_id: String(song_id),
    outcome: String(outcome),
    played_seconds: Number(played_seconds) || 0,
  });
  // Bus event for any interested subscriber (e.g. taste consolidation, dreaming).
  if (_station?.bus && r.ok && r.updated > 0) {
    _station.bus.publishEvent(createEvent({
      type: EventType.PLAYBACK_STATE_CHANGED,
      sourceAgentId: StationAgentId,
      payload: { song_id: String(song_id), outcome: String(outcome), played_seconds: Number(played_seconds) || 0 },
    }));
  }
  return r;
}

const playbackOperationsService = createPlaybackOperationsService({
  applyOutcome: applyPlayOutcome, playbackRuntime, queueService, trace: recordServiceEvent('media'),
});

// 「喜欢」意图的唯一入口：本地意图落 state.db，远端镜像受 like-write 能力门约束
// （QQ 没有该能力，因此只会是 local_only）。不经过 AgentLoop，不写角色记忆。
const trackLikeService = new TrackLikeService({
  store: getTrackLikeStore(),
  providers: { ncm, qq },
});
likeHydration.attach(trackLikeService);

const memoryAdminService = new MemoryAdminService({
  getStation: () => _station,
  getDreaming: () => _dream,
  conversationStore: virtualPerson.conversationStore,
  invalidate: () => musicSelectionService.pool?.invalidate(),
  generateDailySummary,
  consolidateStation,
});

// ---- Memory API ----
// ---- Radiohost API ----
const stationService = new StationService({
  getStation: () => _station,
  // 带上「这次实际会用哪把声音」：创建伙伴与伙伴面板的声音选择器据此如实标注回落，
  // 否则用户看到的是原生声音的名字，听到的却是本地回落声音。
  listVoices: () => VoiceDirectory.listResolvedVoiceProfiles(),
  virtualPersonService,
});

const warmPoolAdminService = new WarmPoolAdminService({ getStation: () => _station });
const reflectionAdminService = new ReflectionAdminService({ getStation: () => _station });
const tasteAdminService = new TasteAdminService({
  consolidator,
  state,
  root: resolveDataRoot(),
  environmentSnapshot: () => envMod.snapshot(),
  getSchema: () => collectStationTasteSchemas(_station),
});
const { libraryAdminService, librarySyncCoordinator, librarySyncService, songTagAdminService,
  recordingReviewService } = createLibraryWiring({ providers: { ncm, qq }, candidates, state, trace,
  projectProfile: projectTasteProfileToStationMemory, publish: broadcast,
  onIdentityChanged: () => musicSelectionService?.invalidatePrepared({ reason: 'recording-identity-changed' }),
});

// ---- 模型 provider 注册表（unified-model-providers）----
// 会话覆盖存 state prefs；解析链在 llm.chat 内部（显式 endpoint → 会话覆盖 → 使用中 → legacy）。
const sessionModelOverrides = createSessionModelOverrides({ getPref: state.getPref, setPref: state.setPref });
setSessionModelOverrides(sessionModelOverrides);
const llmSettingsService = new LlmSettingsService({ sessionOverrides: sessionModelOverrides, capabilityProbe, usageLedger });

// ---- 设置：LLM provider + 音源 + TTS 音色 + 主播放源 ----
// 选项来自 VoiceDirectory 的预设身份（稳定 vp_* id），不再是供应商 voice id。
// 每个选项带上当前实际会用到的 provider 与是否回落，使设置页能如实呈现。
function ttsVoiceOptions() {
  // 与 /api/station/voices 共用同一份解析，避免两个界面给出不一致的回落结论。
  return VoiceDirectory.listResolvedVoiceProfiles().map(profile => ({
    id: profile.id,
    name: profile.displayName,
    note: profile.description,
    providerId: profile.resolvedProviderId,
    voiceId: profile.resolvedVoiceId,
    sourceLabel: profile.sourceLabel,
    isFallback: profile.isFallback,
  }));
}

const settingsHttpService = new SettingsHttpService({
  state,
  tts,
  getVoices: () => ttsVoiceOptions(),
  providerStatus: () => tts.providerStatus(), sourceHealth: productionSourceHealth.snapshot,
  playbackMix: () => playbackMixShares(),
  getSnapshot: getSettingsSnapshot,
  update: updateSettings,
});

// ---- 自定义 TTS 接口：配置/发现/保留声音（服务见 tts/ttsCustomService.js）----
// key 只进服务端文件，读接口永远只回 hasKey；保存后同步每个接口的 provider 与 VoiceDirectory。
const ttsCustomService = createTtsCustomService({
  onConfigChanged: syncCustomVoices, getPerson: id => virtualPerson.registry.get(id),
  synthesize: (text, options) => tts.synth(text, options), storeAudio: audio => tts.storeAudio(audio),
});
const ttsPreviewService = {
  async preview({ voiceProfileId, text } = {}) {
    const voice = resolvePersonVoice(voiceProfileId);
    if (!voice || voice.unavailable || !voice.providerId) {
      return { error: '这把声音当前不可用，请换一个或检查声音服务配置。' };
    }
    // 试听只是确认音色，本地合成没有费用但没有时间上限——不截断的话
    // 一段超长文本会让 CPU 空转数分钟。
    const previewText = String(text || '').trim().slice(0, 500) || '接下来是陈奕迅的《富士山下》。';
    try {
      const audio = await tts.synth(previewText, {
        providerId: voice.providerId,
        voiceId: voice.voiceId, params: voice.params || {},
      });
      return { url: audio?.url || null, providerId: audio?.providerId || voice.providerId, isFallback: voice.isFallback };
    } catch (error) {
      return { error: '这把声音试听失败，请检查声音配置后重试。' };
    }
  },
};
const healthService = new HealthService({
  providers: { ncm, qq },
  getLlmConfig: getPublicLLMConfig,
  getNow: () => envMod.getNow(),
  getLastBudgetRejection: () => usageLedger.lastRejection(),
  getTrackFailures: () => getTrackFailureStats().inspect(),
});

// 陪伴感：只读观察 → 心跳叫醒 → 主循环 ambient turn，她自己决定说不说（openspec: add-companion-heartbeat）。
const presence = createPresenceWiring({ playbackRuntime, sessionTrace, state, virtualPerson, queueService,
  clientHub: webSocketHub, usageLedger, publish: broadcast,
  getActivity: sessionId => virtualPerson.runtime.presenceActivity(sessionId) });

registerDefaultRoutes(app, {
  webAccess,
  presence, authService, radioRequestService, playbackOperationsService, playbackRuntime, queueService,
  memoryAdminService, stationService, virtualPersonService, warmPoolAdminService,
  reflectionAdminService, tasteAdminService, libraryAdminService, librarySyncService, songTagAdminService, recordingReviewService,
  trackLikeService,
  // 同源音频中继：缓存失败时由服务端现取现转，避免跨源媒体元素被 Web Audio 图静音。
  resolveAudioDirectUrl,
  settingsService: settingsHttpService, healthService, ttsStatusService: { status: () => ({ providers: tts.providerStatus() }) }, ttsPreviewService, ttsCustomService, ttsFailureLog: state.ttsFailureLog, locationService,
  environmentService: { getNow: () => envMod.getNow(), environmentEvent: currentEnvironmentEvent },
  llmSettingsService,
  lifeContextService: lifeContext.service,
});

// LLM 只从独立用户配置文件读取；state.db 中旧 llm provider 字段被安全忽略。
const _restoredSettings = restoreRuntimeSettings({ state, tts });
if (Object.keys(_restoredSettings).length > 0) {
  console.log(`[settings] restored source=${_restoredSettings.source} voice=${_restoredSettings.voice} primary=${_restoredSettings.primarySource || 'qq'}`);
}

// ---- 启动生命周期 ----
let _runtimeHandle = null;
let _stationResources = null;
let _maintenanceTasks = null;

async function startStationComponent() {
  const bus = createBus();
  _stationResources = new ManagedTaskGroup();
  _station = new StationAgent({ bus, virtualPersonRegistry: virtualPerson.registry });
  await _station.initialize();
  virtualPersonService.initialize();
  virtualPersonService.syncLegacyHosts(_station.registry.list());
  _stationResources.addCleanup(new ListeningReflectionBridge({ reflection: _station.getReflectionAgent() }).attach(playbackRuntime));
  // 反思提炼的「没完的事」写进伙伴在那个聊天里的心里话（add-companion-heartbeat 阶段 C）；写不进去就丢弃。
  _station.getReflectionAgent()?.setOpenLoopSink?.(loop => virtualPerson.conversationStore?.notes?.acceptOpenLoop(loop));

  const warmPool = _station.getWarmPoolService?.();
  if (warmPool && !warmPool.disabled) {
    musicSelectionService.pool = warmPool;
    // 预热：runtime 低队列触发与定时兜底进同一入口，只挂起一批歌，边界处零模型调用。
    warmPool.prepare = ({ signal } = {}) => radioRequestService.prepareContinuation({ signal });
    warmPool.getActiveDemand = () => radioRequestService.preparationDemand();
    _stationResources.addCleanup(playbackRuntime.subscribe((_snapshot, event) => {
      if (['PROGRAM_COMMITTED', 'LISTENING_PLAN_CHANGED', 'LISTENING_SESSION_SWITCH_REQUESTED', 'TRACK_STARTED',
        'RADIO_MODE_CHANGED'].includes(event?.type)) void warmPool.refresh();
    }));
    void warmPool.refresh();
  }

  for (const eventType of [
    EventType.RADIOHOST_CREATED,
    EventType.RADIOHOST_ACTIVATED,
    EventType.RADIOHOST_MEMORY_UPDATED,
    EventType.STATION_MEMORY_UPDATED,
  ]) {
    _stationResources.addCleanup(_station.bus.subscribe(eventType, event => {
      broadcast({ type: eventType, payload: event.payload });
    }));
  }
  console.log(`[station] initialized — ${_station.listRadioHosts().length} radiohost(s), active: ${_station.getActiveRadiohost()?.name || 'none'}`);
}

async function stopStationComponent() {
  await _stationResources?.stop().catch(error => console.warn('[station] subscription cleanup:', error.message));
  _stationResources = null;
  if (_station) await _station.shutdown();
  _station = null;
}

function startDreamingComponent() {
  if (!_station) throw new Error('station unavailable');
  _dream = new StationDreamingService({
    bus: _station.bus,
    stationMemoryService: _station.stationMemory,
    invalidate: () => musicSelectionService.pool?.invalidate(),
  });
  _dream.initialize();
}

function stopDreamingComponent() {
  _dream?.shutdown();
  _dream = null;
}

function startSchedulerComponent() {
  if (!_station) throw new Error('station unavailable');
  scheduler.attach(_station, { librarySyncService });
  scheduler.start();
}

function stopSchedulerComponent() {
  scheduler.stop();
  scheduler.detach();
}

function runStationConsolidation(label) {
  if (!_station?.stationMemory) return;
  try {
    const report = consolidateStation(_station.stationMemory);
    if (report.promoted + report.merged + report.pruned > 0) {
      console.log(`[station] ${label} consolidation: promoted=${report.promoted} merged=${report.merged} pruned=${report.pruned}`);
    }
  } catch (error) {
    console.warn(`[station] ${label} consolidation:`, error.message);
  }
}

function startMaintenanceComponent() {
  _maintenanceTasks = new ManagedTaskGroup();
  _maintenanceTasks.timeout(async () => {
    for (const [source, provider] of [['ncm', ncm], ['qq', qq]]) {
      if (!state.getPref(`${source}_cookie`)) continue;
      try {
        const status = await provider.loginStatus();
        if (status.loggedIn) void librarySyncCoordinator.discover(source, { trigger: 'maintenance' });
      } catch {}
    }
  }, 3000);
  _maintenanceTasks.timeout(() => runStationConsolidation('startup'), 5000);
  _maintenanceTasks.interval(() => runStationConsolidation('periodic'), 60 * 60 * 1000);
}

async function stopMaintenanceComponent() {
  await _maintenanceTasks?.stop();
  _maintenanceTasks = null;
}

function productionLifecycle() {
  return createProductionLifecycle({
    musicSource: createMusicSourceComponent({ ncm }),
    realtime: {
      start: () => webSocketHub.attach(httpServer),
      stop: () => webSocketHub.close(),
    },
    station: { start: startStationComponent, stop: stopStationComponent },
    lifeContext,
    virtualPerson: {
      start: () => virtualPerson.runtime.initialize(),
      // 关闭时先停运行时，再落盘待写记录：退出后不应留下“已发生但未记录”的回合。
      stop: async () => { presence.stop(); webAccess.dispose(); virtualPerson.runtime.shutdown(); await sessionTrace.flush(); },
    },
    dreaming: { start: startDreamingComponent, stop: stopDreamingComponent },
    scheduler: { start: startSchedulerComponent, stop: stopSchedulerComponent },
    playback: {
      // Ready first, then recover persisted work once every other subsystem owns
      // its stores; recovery itself must not delay listening.
      start: () => playbackRuntime.startRecovery(),
      stop: () => playbackRuntime.stop(),
    },
    maintenance: { start: startMaintenanceComponent, stop: stopMaintenanceComponent },
  });
}

export async function start(port = PORT, options = {}) {
  if (_runtimeHandle && !_runtimeHandle.stopped) return httpServer;
  const host = String(options.host || process.env.LUNARA_HOST || '127.0.0.1');
  _boundHost = host;
  if (!_environmentAbort) _environmentAbort = new AbortController();
  // Fresh installs carry user/*.example templates in the package; existing files are never touched.
  await ensureUserDataFiles({ templateRoot: ROOT, dataRoot: resolveDataRoot() });
  const runtime = await createRuntime({
    config: { port, host },
    services: {
      radioRequestService, queueService, stationService, memoryAdminService,
      settingsService: settingsHttpService, healthService, playbackOperationsService,
      lifeContextService: lifeContext.service,
    },
    lifecycle: productionLifecycle(),
  });
  _runtimeHandle = await startRuntime({ runtime, app, server: httpServer, port, host });
  // 一次性迁移：旧 MiniMax 配置与已存声音选择 → 自定义配置（幂等；官方端点不说 OpenAI 协议）。
  migrateLegacyMinimaxTtsConfig({
    state,
    collectLegacyVoiceSelections: () => (virtualPerson.registry.list() || []).map(e => e.voiceProfileId).filter(id => id && !String(id).startsWith('vp_')),
  });
  syncCustomVoices();

  const address = _runtimeHandle.address;
  console.log(`\n  Lunara is on the air → http://${host}:${address.port}\n`);
  if (options.probeProviders !== false) {
    ncm.ping().then(ok => {
      if (!ok) console.warn('  ⚠ NeteaseCloudMusicApi 没在 ' + ncm.getBaseUrl() + ' 上响应，网易云源本次不可用');
    });
  }
  return httpServer;
}

export async function stop() {
  // 先中止在途定位/天气 fetch，再走运行时停机：网络句柄不跨生命周期存活。
  _environmentAbort?.abort();
  _environmentAbort = null;
  if (!_runtimeHandle) return;
  const handle = _runtimeHandle;
  _runtimeHandle = null;
  await stopRuntime(handle);
}

export function getRuntimeHandle() {
  return _runtimeHandle;
}

// 直接 node server/index.js 时自动启动
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runServerEntrypoint({ start, stop, port: PORT });
}
