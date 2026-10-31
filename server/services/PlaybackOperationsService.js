import { ServiceError } from './ServiceError.js';
import { PlaybackEventType } from '../playback/playbackRuntimeTypes.js';

const PLAYBACK_EVENT_TYPES = Object.freeze(new Set(Object.values(PlaybackEventType)));

// Server-internal facts and commits enter the runtime directly from the commit
// service, the continuation effect sink and the narration workers — never from
// the wire. The dispatch boundary exists for client media facts and listener
// controls only; accepting these types here would let a client forge a program
// commit or a continuation failure, bypassing canonical resolution, hard
// constraint validation and the commit receipts.
const WIRE_FORBIDDEN_EVENT_TYPES = Object.freeze(new Set([
  PlaybackEventType.PROGRAM_COMMITTED,
  PlaybackEventType.CONTINUATION_FAILED,
  PlaybackEventType.LISTENING_SESSION_CREATED,
  PlaybackEventType.LISTENING_PLAN_CHANGED,
  // 会话删除只走会话服务的删除入口；wire 接受它等于允许客户端清掉别人的待播队列。
  PlaybackEventType.LISTENING_SESSION_REMOVED,
  PlaybackEventType.NARRATION_WINDOW_OPENED,
  PlaybackEventType.TRACK_NARRATION_READY,
  PlaybackEventType.TRACK_NARRATION_FAILED,
  PlaybackEventType.TRACK_NARRATION_ASSET_READY,
  PlaybackEventType.TRACK_NARRATION_ASSET_FAILED,
  // 模式修改只经校验过的专用路由进入（requestId/expectedRevision/封闭枚举），
  // 不接受客户端伪造的通用 pb-event。
  PlaybackEventType.COMPANION_MODE_CHANGED,
  // 封面补全由服务端封面缓存回投；让 wire 接受它等于允许客户端给队列项写任意图片地址。
  PlaybackEventType.TRACK_ARTWORK_RESOLVED,
]));

export class PlaybackOperationsService {
  constructor({
    applyOutcome,
    playbackRuntime,
    queueService,
    mediaAssets = null,
    trackFailures = null,
    recordings = null,
    trace = null,
  } = {}) {
    this.applyOutcome = applyOutcome;
    this.playbackRuntime = playbackRuntime;
    this.queueService = queueService;
    this.mediaAssets = mediaAssets;
    // 脱敏计数（`server/playback/trackFailureStats.js`）：只记封闭分类与源，不记原文。
    this.trackFailures = trackFailures;
    // 代表源粘性：只在「这台设备真的开始播这首」时观察，不看提交、不看展示。
    this.recordings = recordings;
    this.trace = typeof trace === 'function' ? trace : null;
  }

  /**
   * 播放失败的闭环：把对应本地媒体资产标记为 broken，下一次解析重新下载。
   * trace 只带身份与稳定分类；URL、凭据和供应商报文一律不落。
   * 非本地 URL 或不认识的资产不会误伤任何文件。
   */
  async quarantineFailedMedia(event, state) {
    const index = Number.isInteger(state?.currentIndex) ? state.currentIndex : -1;
    const item = index >= 0 ? state?.queue?.[index] || null : null;
    let quarantined = null;
    try {
      quarantined = await this.mediaAssets?.quarantineByUrl?.(item?.url) ?? null;
    } catch {
      quarantined = null;
    }
    const kind = String(event?.failureKind || 'unknown');
    try {
      this.trackFailures?.record?.({ provider: item?.provider || item?.source || quarantined?.provider, kind });
    } catch { /* 计数失败不影响播放事实 */ }
    try {
      this.trace?.({
        event: 'media-asset-playback-failed',
        failureKind: kind,
        queueItemId: item?.queueItemId ?? null,
        provider: quarantined?.provider ?? null,
        songId: item?.songId ?? null,
        reason: 'track-failed',
        quarantined: quarantined != null,
        positionSeconds: Number.isFinite(Number(event?.positionSeconds)) ? Number(event.positionSeconds) : null,
      });
    } catch { /* 诊断不影响播放事实 */ }
    return quarantined;
  }

  /**
   * 一次真实播放是「上次实际播放的源」的唯一证据。身份层缺失、未合并或写入失败都
   * 不影响播放事实本身：这里只做旁路观察，异常一律吞掉。
   */
  notePlaybackIdentity(state) {
    if (!this.recordings) return;
    const index = Number.isInteger(state?.currentIndex) ? state.currentIndex : -1;
    const item = index >= 0 ? state?.queue?.[index] || null : null;
    const provider = item?.source || item?.provider;
    if (!provider || !item?.songId) return;
    try { this.recordings.notePlayback?.({ provider, songId: item.songId }); } catch { /* 观察失败不影响播放 */ }
  }

  recordOutcome(input) {
    return this.applyOutcome(input);
  }

  async dispatch(event) {
    if (!event || !PLAYBACK_EVENT_TYPES.has(event.type)) {
      throw new ServiceError(400, `unknown pb-event type: ${event?.type}`, 'unknown_playback_event');
    }
    if (WIRE_FORBIDDEN_EVENT_TYPES.has(event.type)) {
      throw new ServiceError(400, `pb-event type is server-internal: ${event.type}`, 'server_internal_playback_event');
    }
    if (!this.playbackRuntime?.submit) {
      throw new ServiceError(503, 'playback runtime unavailable', 'playback_runtime_unavailable');
    }
    const result = await this.playbackRuntime.submit(event);
    if (!result.accepted) {
      if (event.type === PlaybackEventType.TRACK_DISMISS_REQUESTED && result.reason === 'duplicate event') {
        return { ok: true, idempotent: true, state: result.state, commands: [], effects: [] };
      }
      throw new ServiceError(409, result.reason || 'playback event rejected', 'playback_event_rejected');
    }
    if (event.type === PlaybackEventType.TRACK_FAILED) {
      await this.quarantineFailedMedia(event, result.state);
    }
    if (event.type === PlaybackEventType.TRACK_STARTED || event.type === PlaybackEventType.TRACK_REATTACHED) {
      this.notePlaybackIdentity(result.state);
    }
    return {
      ok: true,
      state: result.state,
      commands: result.commands || [],
      effects: result.effects || [],
    };
  }
}
