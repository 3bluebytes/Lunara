import { PlaybackEventType as P } from '../playback/playbackRuntimeTypes.js';
import { classifyPlaybackTransition } from '../playback/playbackOutcome.js';
import { reflectionText } from './ReflectionObservationStore.js';
import { createEvent, EventType } from './communication/messages.js';

const current = snapshot => snapshot?.queue?.[snapshot.currentIndex] || null;

/** Observe accepted state transitions, not uncorrelated browser analytics reports. */
export class ListeningReflectionBridge {
  constructor({ reflection, logger = console } = {}) {
    this.reflection = reflection;
    this.store = reflection?.store;
    this.logger = logger;
    this.observed = new Set();
  }

  attach(runtime) {
    this.restore(runtime.snapshot());
    return runtime.subscribe((next, event, previous) => {
      try { this.observe(next, event, previous); }
      catch { this.logger.warn('[reflection] playback observation capture failed'); }
    });
  }

  restore(snapshot) {
    if (!this.store?.db || this.reflection.disabled) return;
    for (const track of [...(snapshot.queue || []), ...Object.values(snapshot.suspendedSessions || {}).flatMap(session => session.queue || [])]) {
      const owner = track.virtualPersonId ? { personId: track.virtualPersonId, sessionId: track.conversationId, requestId: track.requestId } : this.store.requestOwner(track.requestId);
      if (owner) this.store.rememberProgram(track.programId, owner);
    }
  }

  observe(next, event, previous) {
    if (!previous) return;
    const learning = Boolean(this.store?.db && !this.reflection.disabled);
    const track = current(previous);
    if (learning && event.type === P.PROGRAM_COMMITTED) {
      for (const added of event.tracks || []) {
        const owner = (added.virtualPersonId ? { personId: added.virtualPersonId, sessionId: added.conversationId, requestId: added.requestId } : null) || this.store.requestOwner(added.requestId)
          || (event.source === 'auto_continue' ? this.store.programOwner(track?.programId) : null);
        if (owner) this.store.rememberProgram(added.programId, owner);
      }
    }
    // Switching output suspends the old room. It is not a dislike, skip or partial play:
    // the shared classifier reports it as `superseded`, which reflection never learns from.
    const classified = classifyPlaybackTransition(next, event, previous);
    if (!classified || classified.outcome === 'superseded') return;
    const { outcome } = classified;
    const owner = learning ? (track.virtualPersonId ? { personId: track.virtualPersonId, sessionId: track.conversationId, requestId: track.requestId } : null)
      || this.store.programOwner(track.programId) || this.store.requestOwner(track.requestId) : null;
    // Old/unknown programs still produce operational facts, but never gain an
    // invented private-memory owner from getActiveRadiohost(). Disabling learning must
    // not disable the scheduler's independent playback observations.
    const eventKey = `playback:${track.programId}:${previous.txn.correlationId}`;
    if (this.observed.has(eventKey)) return;
    const data = { songId: track.songId, provider: reflectionText(track.source || track.provider || '', 32),
        songQuery: reflectionText(`${track.title} — ${track.artist}`, 160),
        programId: track.programId, requestId: owner?.requestId || track.requestId, outcome,
        playedSeconds: Number.isFinite(Number(event.playedSeconds ?? event.deliveredDuration))
          ? Math.max(0, Number(event.playedSeconds ?? event.deliveredDuration)) : null };
    const inserted = !owner || this.store.append({
      eventKey, personId: owner.personId, sessionId: owner.sessionId, kind: 'playback', data,
    });
    if (inserted) {
      this.observed.add(eventKey);
      if (this.observed.size > 256) this.observed.delete(this.observed.values().next().value);
      // Keep scheduler listeners on the authoritative stream. The shared key
      // makes the reflection bus subscriber idempotent with this durable write.
      this.reflection?.bus?.publishEvent(createEvent({ type: EventType.PLAY_OUTCOME_RECORDED,
        sourceAgentId: 'playback-runtime', correlationId: previous.txn.correlationId,
        payload: { ...data, observationKey: eventKey,
          ...(owner ? { virtualPersonId: owner.personId, radiohostId: owner.personId, sessionId: owner.sessionId } : {}),
          recordedAt: this.store?.now?.() ?? Date.now() } }));
      if (owner) this.reflection._kick(owner.personId);
    }
  }
}
