// Compatibility adapter between the persistent virtual-person runtime and the
// existing HTTP/WebSocket player contract. The runtime owns the visible turn;
// this adapter owns presentation delivery exactly once.

import { deliveryPayload } from './presentationDelivery.js';

const DEFAULT_SESSION_ID = 'conversation:primary';

function normalizeSessionId(value) {
  const id = String(value || DEFAULT_SESSION_ID).trim().slice(0, 128);
  return id || DEFAULT_SESSION_ID;
}

export class VirtualPersonChatService {
  constructor({ runtime, presentationService, queueService, sessionTrace = null, logger = console } = {}) {
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

  /**
   * 交付一批已提交的回应：逐条领取 presentation、合成声音，再合成一次 snapshot 发布。
   * 领取失败（已交付或被别的请求领走）的跳过；发布失败时释放本批领取以便重试。
   */
  async _deliver({ sessionId, roundId, items, delivered, partial = undefined }) {
    const claimed = [];
    const messages = [];
    const overlayNarrations = [];
    const isCurrent = () => !this.runtime.isPresentationCurrent
      || this.runtime.isPresentationCurrent(sessionId, roundId);
    try {
      for (const item of items) {
        if (!item.presentation || delivered.has(item.requestId)) continue;
        if (this.runtime.claimPresentation && !this.runtime.claimPresentation(item.requestId)) continue;
        delivered.add(item.requestId);
        claimed.push(item.requestId);
        const presentation = isCurrent() ? item.presentation : { ...item.presentation, speak: false, spokenText: '' };
        const result = await this.presentationService.deliver(presentation);
        const payload = deliveryPayload({ presentation, audio: result.audio, sessionId,
          virtualPersonId: item.virtualPersonId, allowAudio: isCurrent(),
          reason: item.ok ? 'virtual-person:reply' : 'virtual-person:safe-failure',
          extra: { ...(item.groupFloor ? { groupFloor: item.groupFloor } : {}),
            ...(item.hostSuggestion ? { hostSuggestion: item.hostSuggestion } : {}),
            ...(item.webSources ? { webSources: item.webSources } : {}) } });
        messages.push(payload.message);
        if (payload.overlayNarration) overlayNarrations.push(payload.overlayNarration);
      }
      if (messages.length) this.queueService.publishSnapshot({
        sessionId, conversationId: sessionId,
        message: messages[0], ...(messages.length > 1 ? { messages } : {}),
        ...(partial === undefined ? {} : { partial }),
        ...(overlayNarrations.length && isCurrent() ? { overlayNarrations } : {}),
      });
      for (const id of claimed) this.runtime.completePresentation?.(id);
    } catch (error) {
      for (const id of claimed) {
        delivered.delete(id);
        this.runtime.releasePresentation?.(id);
      }
      throw error;
    }
    return { narrations: overlayNarrations.length };
  }
}
