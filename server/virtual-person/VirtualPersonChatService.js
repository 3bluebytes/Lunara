// Compatibility adapter between the persistent virtual-person runtime and the
// existing HTTP/WebSocket player contract. The runtime owns the visible turn;
// this adapter owns presentation delivery exactly once.

import { deliveryPayload } from './presentationDelivery.js';
import { beatSpokenText, beatsToVisibleText, toSpeechPerformance } from './replyBeats.js';

const DEFAULT_SESSION_ID = 'conversation:primary';

function normalizeSessionId(value) {
  const id = String(value || DEFAULT_SESSION_ID).trim().slice(0, 128);
  return id || DEFAULT_SESSION_ID;
}

function audioHashFromUrl(url) {
  const clean = String(url || '').trim().split(/[?#]/)[0];
  const match = /^\/tts\/([a-zA-Z0-9_-]+)\.(?:wav|mp3)$/i.exec(clean);
  return match ? match[1] : null;
}

export class VirtualPersonChatService {
  constructor({ runtime, presentationService, conversationStore = null, queueService, sessionTrace = null, logger = console } = {}) {
    if (!runtime || typeof runtime.handleTurn !== 'function') {
      throw new TypeError('VirtualPersonChatService requires runtime.handleTurn()');
    }
    if (!presentationService || typeof presentationService.deliver !== 'function') {
      throw new TypeError('VirtualPersonChatService requires presentationService.deliver()');
    }
    if (!queueService || typeof queueService.publishSnapshot !== 'function') {
      throw new TypeError('VirtualPersonChatService requires queueService.publishSnapshot()');
    }
    this.runtime = runtime;
    this.presentationService = presentationService;
    this.conversationStore = conversationStore || null;
    this.queueService = queueService;
    this.logger = logger;
  }

  async handleChat({ message, sessionId = DEFAULT_SESSION_ID, requestId, playbackIdentity = null,
    speak = true, mentionedPersonIds = [], mode = 'ordinary', onDraft = null,
    interruptRequestId = null, signal = null } = {}) {
    const sid = normalizeSessionId(sessionId);
    // 群聊里 runtime 每提交一位就回调一次：先把这位的话（和声音）发出去，后面的人继续生成。
    // 回合结束时只补发还没发过的；claimPresentation 与本地集合共同保证同一条不发两次。
    const delivered = new Set();
    const early = [];
    let earlyNarrations = 0;
    const onResponseCommitted = (item, { roundId } = {}) => {
      const task = this._deliver({ sessionId: item.sessionId || sid, roundId: roundId || requestId, items: [item], delivered })
        .then(result => { earlyNarrations += result.narrations; })
        .catch(error => this.logger?.warn?.('[virtual-person] early presentation failed', error?.code || error?.name || 'error'));
      early.push(task);
      return task;
    };
    const response = await this.runtime.handleTurn({
      sessionId: sid, requestId, userText: message,
      clientState: { playbackIdentity }, speak, mentionedPersonIds, onResponseCommitted,
      mode, onDraft, interruptRequestId, signal,
    });
    await Promise.all(early);
    const responses = response.responses || [response];
    const final = await this._deliver({ sessionId: response.sessionId, roundId: response.roundId || response.requestId,
      items: responses, delivered, partial: Boolean(response.partial) });
    const narrations = earlyNarrations + final.narrations;
    const present = item => ({ requestId: item.requestId, virtualPersonId: item.virtualPersonId,
      speakerId: item.virtualPersonId, sourceTurnId: item.sourceTurnId || item.presentation?.sourceTurnId,
      displayText: item.displayText || item.presentation?.displayText || '', ok: item.ok,
      ...(item.groupFloor ? { groupFloor: item.groupFloor } : {}),
      ...(item.hostSuggestion ? { hostSuggestion: item.hostSuggestion } : {}),
      ...(item.webSources ? { webSources: item.webSources } : {}) });
    return {
      ok: response.ok, type: 'conversation', requestId: response.requestId,
      sessionId: response.sessionId, conversationId: response.sessionId, virtualPersonId: response.virtualPersonId,
      message: response.displayText || response.presentation?.displayText || '',
      displayText: response.displayText || response.presentation?.displayText || '',
      narration: narrations, added: narrations, tracks: 0,
      sourceTurnId: response.sourceTurnId || response.presentation?.sourceTurnId,
      ...(response.responses ? { responses: responses.map(present), partial: response.partial, cancelled: response.cancelled,
        ...(response.floor ? { floor: response.floor } : {}) } : {}),
      ...(!delivered.size ? { replayed: true } : {}),
      ...(response.ok ? {} : { code: response.code, errorId: response.errorId }),
    };
  }

  _itemExtraMeta(item, storedTurn = null) {
    return {
      ...(item.groupFloor ? { groupFloor: item.groupFloor } : {}),
      ...(item.hostSuggestion ? { hostSuggestion: item.hostSuggestion } : {}),
      ...(item.webSources ? { webSources: item.webSources } : {}),
      ...(storedTurn?.message?.segments ? { segments: storedTurn.message.segments } : {}),
    };
  }

  _buildBeatsVoiceExtra(beats) {
    if (!Array.isArray(beats) || !beats.length) return null;
    const speakable = beats.filter(beat => Boolean(beatSpokenText(beat)));
    const ready = speakable.filter(beat => Boolean(beat.audioUrl));
    if (!speakable.length && !ready.length) return null;
    const status = ready.length === speakable.length
      ? 'ready'
      : (ready.length > 0 ? 'partial' : 'missing');
    const firstUrl = ready[0]?.audioUrl || null;
    const durations = ready.map(beat => beat.durationMs).filter(Number.isFinite);
    const totalDurationMs = durations.length ? durations.reduce((sum, ms) => sum + ms, 0) : null;
    return {
      canSynthesize: true,
      status,
      url: firstUrl,
      audioUrl: firstUrl,
      durationMs: totalDurationMs,
      beats: beats.map((beat, idx) => {
        const index = Number.isInteger(beat.index) ? beat.index : idx;
        const spoken = beatSpokenText(beat);
        if (!spoken) {
          return { index, canSynthesize: false, status: 'none', audioUrl: null, durationMs: null };
        }
        return {
          index,
          canSynthesize: Boolean(spoken),
          status: beat.audioUrl ? 'ready' : 'missing',
          audioUrl: beat.audioUrl || null,
          durationMs: beat.audioUrl && Number.isFinite(beat.durationMs) ? beat.durationMs : null,
        };
      }),
    };
  }

  async _synthesizeBeat({ presentation, spoken, performance = null, skipPublish = false } = {}) {
    if (!spoken) return null;
    if (!skipPublish) {
      this.presentationService.publish?.({ type: 'virtual-person-message', presentation });
    }
    if (typeof this.presentationService.synthesize === 'function') {
      if (presentation.expiresAt < Date.now()) return null;
      try {
        const audio = await this.presentationService.synthesize({
          text: spoken,
          voiceProfileId: presentation.voiceProfileId,
          correlationId: presentation.correlationId,
          ...(performance ? { performance } : {}),
        });
        return presentation.expiresAt > Date.now() ? audio || null : null;
      } catch {
        return null;
      }
    }
    // 兼容未提供 .synthesize 的测试替身：走 deliver 并保持非 speak 跳过以外的字段。
    try {
      const result = await this.presentationService.deliver({
        ...presentation,
        spokenText: spoken,
        speak: true,
        ...(performance ? { performance } : {}),
      });
      return result?.audio || null;
    } catch {
      return null;
    }
  }

  async _deliverMultiBeatRadio({ sessionId, item, presentation, isCurrent, partial, claimed }) {
    const sourceTurnId = presentation.sourceTurnId || item.sourceTurnId || null;
    const workingBeats = presentation.beats.map(beat => ({ ...beat }));
    const totalCount = workingBeats.length;
    if (typeof this.presentationService.synthesize === 'function') {
      this.presentationService.publish?.({ type: 'virtual-person-message', presentation });
    }
    const slots = workingBeats.map((beat, idx) => {
      let resolve;
      const promise = new Promise(res => { resolve = res; });
      return {
        idx,
        beat,
        spoken: beatSpokenText(beat),
        performance: toSpeechPerformance(beat.voice),
        promise,
        resolve,
      };
    });
    let nextToStart = 0;
    let aborted = false;
    const runWorker = async () => {
      while (!aborted && nextToStart < slots.length) {
        if (!isCurrent()) {
          aborted = true;
          break;
        }
        const slot = slots[nextToStart++];
        if (!slot.spoken) {
          slot.resolve(null);
          continue;
        }
        const audio = await this._synthesizeBeat({
          presentation,
          spoken: slot.spoken,
          performance: slot.performance,
          skipPublish: true,
        });
        slot.resolve(audio);
        await Promise.resolve();
      }
    };
    const workersPromise = Promise.all(
      Array.from({ length: Math.min(2, slots.length) }, () => runWorker()),
    ).then(() => {
      for (const slot of slots) slot.resolve(null);
    }).catch(() => {
      for (const slot of slots) slot.resolve(null);
    });

    let narrations = 0;
    let firstSnapshotPublished = false;
    let previousHadAudio = false;
    const metaExtras = this._itemExtraMeta(item);

    for (let i = 0; i < totalCount; i += 1) {
      if (!isCurrent()) {
        aborted = true;
        break;
      }
      const audio = await slots[i].promise;
      if (!isCurrent()) {
        aborted = true;
        break;
      }
      const beat = workingBeats[i];
      const beatIndex = Number.isInteger(beat.index) ? beat.index : i;
      if (audio?.url) {
        const hash = audio.hash || audioHashFromUrl(audio.url);
        beat.audioUrl = audio.url;
        if (hash) beat.hash = hash;
        if (Number.isFinite(audio.durationMs)) beat.durationMs = audio.durationMs;
        if (sourceTurnId) {
          this.conversationStore?.updateTurnVoice?.(sourceTurnId, {
            beatIndex,
            voiceProfileId: presentation.voiceProfileId,
            audioUrl: audio.url,
            ...(hash ? { hash } : {}),
            ...(Number.isFinite(audio.durationMs) ? { durationMs: audio.durationMs } : {}),
            synthesizedAt: Date.now(),
          });
        }
      }
      const deliveredBeats = workingBeats.slice(0, i + 1);
      const isLast = i === totalCount - 1;
      const hasRemainingSpeakable = slots.slice(i + 1).some(s => Boolean(s.spoken));
      const delayBeforeMs = i === 0 || !previousHadAudio ? 0 : (workingBeats[i - 1]?.pauseAfterMs ?? 0);
      previousHadAudio = Boolean(audio?.url);
      const beatOverlay = audio?.url ? {
        beatIndex: i,
        beatCount: totalCount,
        isLastBeat: isLast || !hasRemainingSpeakable,
        delayBeforeMs,
        turnDuckLeaseId: sourceTurnId,
        holdDuckLease: !isLast && hasRemainingSpeakable,
        text: slots[i].spoken,
      } : null;
      const voiceExtra = this._buildBeatsVoiceExtra(isLast ? workingBeats : deliveredBeats);
      const payload = deliveryPayload({
        presentation: {
          ...presentation,
          displayText: isLast ? presentation.displayText : beatsToVisibleText(deliveredBeats),
        },
        audio,
        sessionId,
        virtualPersonId: item.virtualPersonId,
        allowAudio: true,
        reason: item.ok ? 'virtual-person:reply' : 'virtual-person:safe-failure',
        beatOverlay,
        extra: {
          ...metaExtras,
          beats: deliveredBeats,
          beatProgress: { deliveredCount: i + 1, totalCount, done: isLast },
          ...(voiceExtra ? { voice: voiceExtra } : {}),
        },
      });
      this.queueService.publishSnapshot({
        sessionId,
        conversationId: sessionId,
        message: payload.message,
        ...(partial === undefined ? {} : { partial }),
        ...(payload.overlayNarration ? { overlayNarrations: [payload.overlayNarration] } : {}),
      });
      if (!firstSnapshotPublished) {
        firstSnapshotPublished = true;
        this.runtime.completePresentation?.(item.requestId);
        const idx = claimed.indexOf(item.requestId);
        if (idx >= 0) claimed.splice(idx, 1);
      }
      if (payload.overlayNarration) narrations += 1;
    }

    if (aborted) {
      const voiceExtra = this._buildBeatsVoiceExtra(workingBeats);
      const payload = deliveryPayload({
        presentation,
        audio: null,
        sessionId,
        virtualPersonId: item.virtualPersonId,
        allowAudio: false,
        reason: item.ok ? 'virtual-person:reply' : 'virtual-person:safe-failure',
        extra: {
          ...metaExtras,
          beats: workingBeats,
          beatProgress: { deliveredCount: totalCount, totalCount, done: true },
          ...(voiceExtra ? { voice: voiceExtra } : {}),
        },
      });
      this.queueService.publishSnapshot({
        sessionId,
        conversationId: sessionId,
        message: payload.message,
        ...(partial === undefined ? {} : { partial }),
      });
      if (!firstSnapshotPublished) {
        firstSnapshotPublished = true;
        this.runtime.completePresentation?.(item.requestId);
        const idx = claimed.indexOf(item.requestId);
        if (idx >= 0) claimed.splice(idx, 1);
      }
    }

    await workersPromise;
    return narrations;
  }

  /**
   * 交付一批已提交的回应：逐条领取 presentation、合成声音，再合成一次 snapshot 发布。
   * 领取失败（已交付或被别的请求领走）的跳过；发布失败时释放本批领取以便重试。
   */
  async _deliver({ sessionId, roundId, items, delivered, partial = undefined }) {
    const claimed = [];
    const messages = [];
    const overlayNarrations = [];
    let streamedNarrations = 0;
    const isCurrent = () => !this.runtime.isPresentationCurrent
      || this.runtime.isPresentationCurrent(sessionId, roundId);
    const flushPending = () => {
      if (!messages.length) return;
      const batchMessages = [...messages];
      const batchOverlays = [...overlayNarrations];
      messages.length = 0;
      overlayNarrations.length = 0;
      this.queueService.publishSnapshot({
        sessionId, conversationId: sessionId,
        message: batchMessages[0], ...(batchMessages.length > 1 ? { messages: batchMessages } : {}),
        ...(partial === undefined ? {} : { partial }),
        ...(batchOverlays.length && isCurrent() ? { overlayNarrations: batchOverlays } : {}),
      });
    };
    try {
      for (const item of items) {
        if (!item.presentation || delivered.has(item.requestId)) continue;
        if (this.runtime.claimPresentation && !this.runtime.claimPresentation(item.requestId)) continue;
        delivered.add(item.requestId);
        claimed.push(item.requestId);
        const rawPresentation = item.presentation;
        const hasBeats = Array.isArray(rawPresentation.beats) && rawPresentation.beats.length > 0;
        if (hasBeats) {
          if (rawPresentation.beats.length > 1 && rawPresentation.speak && isCurrent()) {
            flushPending();
            streamedNarrations += await this._deliverMultiBeatRadio({
              sessionId, item, presentation: rawPresentation, isCurrent, partial, claimed,
            });
            continue;
          }
          const workingBeats = rawPresentation.beats.map(beat => ({ ...beat }));
          let audio = null;
          const allowSpeak = rawPresentation.speak && isCurrent() && workingBeats.length === 1;
          const spoken = allowSpeak ? beatSpokenText(workingBeats[0]) : '';
          if (allowSpeak && spoken) {
            audio = await this._synthesizeBeat({
              presentation: rawPresentation,
              spoken,
              performance: toSpeechPerformance(workingBeats[0].voice),
              skipPublish: false,
            });
            if (audio?.url && rawPresentation.sourceTurnId) {
              const hash = audio.hash || audioHashFromUrl(audio.url);
              const beatIndex = Number.isInteger(workingBeats[0].index) ? workingBeats[0].index : 0;
              workingBeats[0].audioUrl = audio.url;
              if (hash) workingBeats[0].hash = hash;
              if (Number.isFinite(audio.durationMs)) workingBeats[0].durationMs = audio.durationMs;
              this.conversationStore?.updateTurnVoice?.(rawPresentation.sourceTurnId, {
                beatIndex,
                voiceProfileId: rawPresentation.voiceProfileId,
                audioUrl: audio.url,
                ...(hash ? { hash } : {}),
                ...(Number.isFinite(audio.durationMs) ? { durationMs: audio.durationMs } : {}),
                synthesizedAt: Date.now(),
              });
            }
          } else {
            await this.presentationService.deliver({ ...rawPresentation, speak: false, spokenText: '' });
          }
          const voiceExtra = this._buildBeatsVoiceExtra(workingBeats);
          const beatOverlay = audio?.url && isCurrent() && workingBeats.length === 1 ? {
            beatIndex: 0,
            beatCount: 1,
            isLastBeat: true,
            delayBeforeMs: 0,
            turnDuckLeaseId: rawPresentation.sourceTurnId || item.sourceTurnId || null,
            holdDuckLease: false,
            text: spoken,
          } : null;
          const payload = deliveryPayload({
            presentation: rawPresentation,
            audio: isCurrent() ? audio : null,
            sessionId,
            virtualPersonId: item.virtualPersonId,
            allowAudio: isCurrent(),
            reason: item.ok ? 'virtual-person:reply' : 'virtual-person:safe-failure',
            beatOverlay,
            extra: {
              ...this._itemExtraMeta(item),
              beats: workingBeats,
              beatProgress: { deliveredCount: workingBeats.length, totalCount: workingBeats.length, done: true },
              ...(voiceExtra ? { voice: voiceExtra } : {}),
            },
          });
          messages.push(payload.message);
          if (payload.overlayNarration) overlayNarrations.push(payload.overlayNarration);
          continue;
        }

        const presentation = isCurrent() ? rawPresentation : { ...rawPresentation, speak: false, spokenText: '' };
        const result = await this.presentationService.deliver(presentation);
        if (result.audio?.url && presentation.sourceTurnId) {
          const hash = result.audio.hash || audioHashFromUrl(result.audio.url);
          this.conversationStore?.updateTurnVoice?.(presentation.sourceTurnId, {
            audioUrl: result.audio.url,
            ...(hash ? { hash } : {}),
            ...(Number.isFinite(result.audio.durationMs) ? { durationMs: result.audio.durationMs } : {}),
            ...(presentation.voiceProfileId ? { voiceProfileId: presentation.voiceProfileId } : {}),
            synthesizedAt: Date.now(),
          });
        }
        const storedTurn = presentation.sourceTurnId ? this.conversationStore?.getTurn?.(presentation.sourceTurnId) : null;
        const storedVoice = storedTurn?.message?.voice;
        const audioUrl = result.audio?.url || storedVoice?.audioUrl || null;
        const voiceExtra = (storedVoice?.spokenText || audioUrl)
          ? {
            canSynthesize: true,
            status: audioUrl ? 'ready' : 'missing',
            url: audioUrl,
            audioUrl,
            durationMs: result.audio?.durationMs ?? storedVoice?.durationMs ?? null,
          }
          : null;
        const payload = deliveryPayload({ presentation, audio: result.audio, sessionId,
          virtualPersonId: item.virtualPersonId, allowAudio: isCurrent(),
          reason: item.ok ? 'virtual-person:reply' : 'virtual-person:safe-failure',
          extra: {
            ...this._itemExtraMeta(item, storedTurn),
            ...(voiceExtra ? { voice: voiceExtra } : {}),
          } });
        messages.push(payload.message);
        if (payload.overlayNarration) overlayNarrations.push(payload.overlayNarration);
      }
      const batchNarrations = overlayNarrations.length && isCurrent() ? overlayNarrations.length : 0;
      flushPending();
      for (const id of claimed) this.runtime.completePresentation?.(id);
      return { narrations: streamedNarrations + batchNarrations };
    } catch (error) {
      for (const id of claimed) {
        delivered.delete(id);
        this.runtime.releasePresentation?.(id);
      }
      throw error;
    }
  }
}
