import { createPresentationEnvelope } from './VirtualPersonTypes.js';

export class PresentationService {
  constructor({ synthesize = null, publish = null } = {}) {
    this.synthesize = typeof synthesize === 'function' ? synthesize : null;
    this.publish = typeof publish === 'function' ? publish : null;
  }

  create({ text, spokenText = null, entity, sourceTurnId, correlationId = '', conversationId = '', mood = '', speak = true,
    beats = null, performance = null } = {}) {
    const displayText = String(text || '').trim();
    const approvedSpoken = spokenText == null ? displayText : String(spokenText).trim();
    const shouldSpeak = speak && Boolean(approvedSpoken);
    return createPresentationEnvelope({
      displayText,
      spokenText: shouldSpeak ? approvedSpoken : '',
      speak: shouldSpeak,
      ...(Array.isArray(beats) && beats.length ? { beats } : {}),
      ...(performance && typeof performance === 'object' && !Array.isArray(performance) ? { performance } : {}),
      virtualPersonId: entity.id,
      voiceProfileId: entity.voiceProfileId,
      mood,
      sourceTurnId,
      correlationId,
      conversationId,
    });
  }

  async deliver(envelope) {
    if (!envelope || typeof envelope !== 'object' || !envelope.virtualPersonId) {
      throw new TypeError('PresentationService.deliver requires PresentationEnvelope');
    }
    const approved = createPresentationEnvelope(envelope);
    this.publish?.({ type: 'virtual-person-message', presentation: approved });
    if (!approved.speak || !approved.spokenText || !this.synthesize || approved.expiresAt < Date.now()) return { envelope: approved, audio: null };
    try {
      const audio = await this.synthesize({
        text: approved.spokenText,
        voiceProfileId: approved.voiceProfileId,
        correlationId: approved.correlationId,
        ...(approved.performance ? { performance: approved.performance } : {}),
      });
      return { envelope: approved, audio: approved.expiresAt > Date.now() ? audio || null : null };
    } catch {
      return { envelope: approved, audio: null };
    }
  }
}
