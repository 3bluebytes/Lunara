function clone(value) {
  return structuredClone(value);
}

/**
 * Read-only compatibility projection used by chat, tools, and queue rendering.
 * PlaybackRuntime is the only writer of queue/current semantics; this class can
 * only project a runtime snapshot or publish presentation metadata alongside
 * the latest projection.
 */
export class QueueService {
  constructor(options = {}) {
    this.publish = typeof options.publish === 'function' ? options.publish : () => {};
    this._queue = [];
    this._cursor = -1;
    this._runtimeVersion = null;
    this._runtimePhase = null;
    this._runtimeCorrelationId = null;
  }

  snapshot() {
    return {
      queue: clone(this._queue),
      cursor: this._cursor,
      ...(Number.isInteger(this._runtimeVersion) ? { runtimeVersion: this._runtimeVersion } : {}),
      ...(this._runtimePhase ? { runtimePhase: this._runtimePhase } : {}),
      ...(this._runtimeCorrelationId ? { runtimeCorrelationId: this._runtimeCorrelationId } : {}),
    };
  }

  publishSnapshot(extra = {}) {
    const message = { type: 'queue-update', ...this.snapshot(), ...clone(extra) };
    this.publish(message);
    return message;
  }

  projectRuntimeSnapshot(runtimeSnapshot, extra = {}) {
    if (!runtimeSnapshot || !Array.isArray(runtimeSnapshot.queue)) {
      return { ok: false, error: 'runtime snapshot required', snapshot: this.snapshot() };
    }
    this._queue = runtimeSnapshot.queue.map((track, index) => ({
      kind: 'track',
      queueItemId: track.queueItemId,
      queue_item_id: track.queueItemId,
      song_id: track.songId,
      title: track.title,
      artist: track.artist,
      album: track.album || '',
      duration: track.duration || 0,
      url: track.url,
      pic_url: track.artwork || null,
      lyric: track.lyric || null,
      source: track.source || '',
      programId: track.programId,
      program_id: track.programId,
      requestId: track.requestId,
      status: index < runtimeSnapshot.currentIndex
        ? 'played'
        : index === runtimeSnapshot.currentIndex ? 'playing' : 'upcoming',
    }));
    this._cursor = Number.isInteger(runtimeSnapshot.currentIndex)
      ? runtimeSnapshot.currentIndex
      : -1;
    this._runtimeVersion = Number.isInteger(runtimeSnapshot.version)
      ? runtimeSnapshot.version
      : null;
    this._runtimePhase = runtimeSnapshot.phase || null;
    this._runtimeCorrelationId = runtimeSnapshot.txn?.correlationId || null;

    if (extra.publish !== false) {
      const { publish: _publish, ...presentation } = extra;
      this.publishSnapshot(presentation);
    }
    return {
      ok: true,
      projected: this._queue.length,
      runtimeVersion: this._runtimeVersion,
      snapshot: this.snapshot(),
    };
  }
}
