import { EventEmitter } from 'node:events';
import {
  createPlaybackRuntimeState,
  hydratePlaybackRuntimeState,
  reducePlayback,
  listeningSnapshot,
  resumeCommandsForState,
  resumeEffectsForState,
} from './PlaybackRuntime.js';
import { cloneRuntimeValue, deepFreeze } from './playbackRuntimeTypes.js';

/** 封面 repair 事件的 eventId 后缀：同一个 occurrence + 同一张图只提交一次。 */
function artworkEventSuffix(artwork) {
  let hash = 0;
  const text = String(artwork || '');
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) % 0xffffffff;
  return hash.toString(36);
}

function providerOf(item) {
  // 队列项只该带 provider 本身；历史快照里可能是 'qq:daily' 之类，取第一段。
  return String(item?.source || '').split(':')[0].trim().toLowerCase();
}

export class PlaybackRuntimeHost {
  constructor({
    initialState = null,
    persistence = null,
    commandSink = null,
    effectSink = null,
    onError = null,
    idempotencyWindow = undefined,
    // 封面补全：{ peek(provider, songId), resolve(provider, songId, { signal }) }。
    // 缺省时不补全（评估、纯离线测试与无封面环境下行为不变）。
    artwork = null,
    artworkBackfillDelayMs = 400,
    artworkBackfillConcurrency = 2,
    now = () => Date.now(),
  } = {}) {
    this.state = initialState ? hydratePlaybackRuntimeState(initialState) : createPlaybackRuntimeState();
    this.persistence = persistence;
    this.commandSink = typeof commandSink === 'function' ? commandSink : async () => {};
    this.effectSink = typeof effectSink === 'function' ? effectSink : async () => {};
    this.onError = typeof onError === 'function' ? onError : () => {};
    this.idempotencyWindow = idempotencyWindow;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.events = new EventEmitter();
    this.chain = Promise.resolve();
    this.recoveryStarted = false;
    this.narrationStaleSeq = 0;
    this.stopped = false;
    this.lifecycleGeneration = 0;
    this.artwork = artwork && typeof artwork.resolve === 'function' ? artwork : null;
    this.artworkBackfillDelayMs = Math.max(0, Number(artworkBackfillDelayMs) || 0);
    this.artworkBackfillConcurrency = Math.max(1, Number(artworkBackfillConcurrency) || 2);
    this._artworkTimer = null;
    this._artworkBusy = false;
    this._artworkRecheck = false;
    // 任何被接受的迁移都可能带进「没有封面」的 occurrence；补全只改元数据。
    this.events.on('snapshot', () => this._scheduleArtworkBackfill());
    this.ready = this._restore().then(snapshot => {
      this._scheduleArtworkBackfill();
      return snapshot;
    });
  }

  /**
   * 补全队列里缺封面的歌曲项：先吃缓存（不发网络），再对仍缺的做有界查询。
   * 只提交 metadata-only 事件，永不重建队列、切换当前项或改变 phase。
   */
  async backfillArtwork() {
    if (!this.artwork || this.stopped) return { repaired: 0, checked: 0 };
    if (this._artworkBusy) {
      this._artworkRecheck = true;
      return { repaired: 0, checked: 0, busy: true };
    }
    this._artworkBusy = true;
    const generation = this.lifecycleGeneration;
    const active = () => !this.stopped && generation === this.lifecycleGeneration;
    let repaired = 0;
    let checked = 0;
    try {
      const pending = this._artworkCandidates();
      checked = pending.length;
      const remote = [];
      for (const item of pending) {
        if (!active()) break;
        const provider = providerOf(item);
        if (!provider) continue;
        const known = this.artwork.peek?.(provider, item.songId) || null;
        if (known) {
          if (await this._repairArtwork(item, known)) repaired += 1;
          continue;
        }
        remote.push(item);
      }
      // 有界并发：整队列可能一次有二十多个空封面，逐个串行会把恢复拖长。
      let cursor = 0;
      const worker = async () => {
        while (active() && cursor < remote.length) {
          const item = remote[cursor];
          cursor += 1;
          const provider = providerOf(item);
          let found = null;
          try { found = await this.artwork.resolve(provider, item.songId); } catch { found = null; }
          if (!found || !active()) continue;
          if (await this._repairArtwork(item, found)) repaired += 1;
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.artworkBackfillConcurrency, remote.length) }, worker));
    } finally {
      this._artworkBusy = false;
      if (this._artworkRecheck && active()) {
        this._artworkRecheck = false;
        this._scheduleArtworkBackfill();
      }
    }
    return { repaired, checked };
  }

  _artworkCandidates() {
    return (this.state?.queue || []).filter(item => item
      && String(item.queueItemId || '').trim()
      && String(item.songId || '').trim()
      && !String(item.artwork || '').trim());
  }

  async _repairArtwork(item, artwork) {
    const result = await this.submit({
      type: 'TRACK_ARTWORK_RESOLVED',
      eventId: `artwork:${item.queueItemId}:${artworkEventSuffix(artwork)}`,
      listeningSessionId: this.state.activeListeningSessionId,
      queueItemId: item.queueItemId,
      artwork,
    });
    return result?.accepted === true;
  }

  _scheduleArtworkBackfill() {
    if (!this.artwork || this.stopped) return;
    if (this._artworkBusy) { this._artworkRecheck = true; return; }
    if (this._artworkTimer) return;
    const timer = setTimeout(() => {
      this._artworkTimer = null;
      void this.backfillArtwork().catch(error => this.onError(error, { type: 'artwork-backfill' }));
    }, this.artworkBackfillDelayMs);
    timer?.unref?.();
    this._artworkTimer = timer;
  }

  async _restore() {
    if (!this.persistence?.load) return this.snapshot();
    try {
      const loaded = await this.persistence.load();
      if (loaded != null) this.state = hydratePlaybackRuntimeState(loaded);
      for (const command of resumeCommandsForState(this.state)) {
        if (!this.stopped) await this.commandSink(command, this.snapshot());
      }
    } catch (error) {
      this.onError(error, { type: 'restore' });
      this.state = createPlaybackRuntimeState();
    }
    return this.snapshot();
  }

  /**
   * Recover persisted work that needs the rest of the server to be initialized
   * (selection services, conversation store, TTS assets). Called by the runtime lifecycle
   * after every other subsystem has started, so a recovered continuation cannot
   * race conversation-store initialization. Effects stay fire-and-forget: startup
   * must not wait for a generation bounded by model latency.
   */
  async startRecovery() {
    await this.ready;
    if (this.stopped) {
      this.stopped = false;
      this.ready = this._restore().then(snapshot => {
        this._scheduleArtworkBackfill();
        return snapshot;
      });
      await this.ready;
    }
    if (this.recoveryStarted) return this.snapshot();
    this.recoveryStarted = true;
    const generation = this.lifecycleGeneration;
    for (const effect of resumeEffectsForState(this.state)) {
      Promise.resolve()
        .then(() => !this.stopped && generation === this.lifecycleGeneration && this.effectSink(effect, this.snapshot()))
        .catch(error => this.onError(error, effect));
    }
    return this.snapshot();
  }

  async stop() {
    this.stopped = true;
    this.lifecycleGeneration += 1;
    if (this._artworkTimer) { clearTimeout(this._artworkTimer); this._artworkTimer = null; }
    this.recoveryStarted = false;
    await this.ready;
    await this.chain;
    return this.snapshot();
  }

  snapshot() {
    return deepFreeze(cloneRuntimeValue(this.state));
  }

  listeningSnapshot(sessionId) {
    return listeningSnapshot(this.state, sessionId);
  }

  subscribe(listener) {
    this.events.on('snapshot', listener);
    return () => this.events.off('snapshot', listener);
  }

  /**
   * A memory change (expression preference saved/revoked, feedback recorded) can
   * contradict what an already prepared introduction says. Best-effort: a rejected
   * event merely means the next preparation keeps the older context.
   */
  invalidatePreparedNarrations(listeningSessionId, { includeCurrent = false } = {}) {
    if (!listeningSessionId) return Promise.resolve({ accepted: false, reason: 'listeningSessionId required' });
    return this.submit({ type: 'NARRATION_CONTEXT_STALE_REQUESTED',
      eventId: `narration-stale:${listeningSessionId}:${Date.now()}:${this.narrationStaleSeq += 1}`,
      listeningSessionId: String(listeningSessionId), includeCurrent });
  }

  submit(event) {
    const generation = this.lifecycleGeneration;
    const run = async () => {
      await this.ready;
      if (this.stopped || generation !== this.lifecycleGeneration) {
        return { accepted: false, reason: 'playback runtime stopped', state: this.snapshot(), commands: [], effects: [] };
      }
      if (event.signal?.aborted || (typeof event.guard === 'function' && !event.guard())) {
        return { accepted: false, reason: 'request cancelled', state: this.snapshot(), commands: [], effects: [] };
      }
      const result = reducePlayback(this.state, event, { idempotencyWindow: this.idempotencyWindow, nowMs: this.now() });
      if (!result.accepted) return result;
      const previousSnapshot = this.snapshot();
      const snapshot = result.state;
      if (this.persistence?.save) {
        try {
          await this.persistence.save(snapshot);
        } catch (error) {
          this.onError(error, { type: 'persist', event });
          return deepFreeze({ accepted: false, reason: 'playback persistence failed', state: previousSnapshot, commands: [], effects: [] });
        }
      }
      this.state = snapshot;
      if (this.stopped) return result;
      this.events.emit('snapshot', snapshot, event, previousSnapshot);
      for (const command of result.commands) {
        if (this.stopped || generation !== this.lifecycleGeneration) break;
        try { await this.commandSink(command, snapshot); } catch (error) { this.onError(error, command); }
      }
      for (const effect of result.effects) {
        // Effects can produce a PROGRAM_COMMITTED event back into this host.
        // Run them after the serialized transition instead of awaiting them
        // inside the chain, otherwise continuation would deadlock itself.
        Promise.resolve()
          .then(() => !this.stopped && generation === this.lifecycleGeneration && this.effectSink(effect, snapshot))
          .catch(error => this.onError(error, effect));
      }
      return result;
    };
    const submitted = this.chain.then(run, run);
    this.chain = submitted.then(() => undefined, () => undefined);
    return submitted;
  }
}

export default PlaybackRuntimeHost;
