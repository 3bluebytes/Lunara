// presenceDelivery.js — 一行已入账的主动开口怎么送到用户面前（P1 与 ambient turn 共用）。
//
// 输入：已入账的 presence turn、说话角色、会话、是否允许出声、仍然有效的判断。
// 顺序：PresentationService 生成呈现（sourceTurnId = 这一行）→ 共享交付形状 →
//       先标未读再发布（正在看这个聊天的那端可以立刻清掉）。
// 输出：'spoken'（带人声叠加）或 'text-only'。异常抛给调用方：已入账的话刷新后仍可见，不补发。
import { deliveryPayload } from '../virtual-person/presentationDelivery.js';
import { beatSpokenText, toSpeechPerformance } from '../virtual-person/replyBeats.js';
import { publicRecommendation } from './ambientRecommendations.js';

function audioHashFromUrl(url) {
  const clean = String(url || '').trim().split(/[?#]/)[0];
  const match = /^\/tts\/([a-zA-Z0-9_-]+)\.(?:wav|mp3)$/i.exec(clean);
  return match ? match[1] : null;
}

function buildBeatsVoiceExtra(beats) {
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

export async function deliverPresenceTurn({ presentationService, queueService, conversationStore, turn, person,
  sessionId, correlationId, voice = false, isCurrent = () => true }) {
  const rawBeats = Array.isArray(turn.message?.beats) && turn.message.beats.length ? turn.message.beats : null;
  if (!rawBeats) {
    const envelope = presentationService.create({ text: turn.visibleText, entity: person,
      sourceTurnId: turn.turnId, correlationId, conversationId: sessionId, speak: voice });
    const delivered = await presentationService.deliver(envelope);
    const payload = deliveryPayload({ presentation: envelope, audio: delivered.audio, sessionId,
      virtualPersonId: person.id, reason: 'virtual-person:presence', allowAudio: voice && isCurrent(),
      extra: { presentation: 'presence', sequence: turn.sequence,
        // ambient 推荐卡片（add-ambient-music-recommendation）：只带展示字段，确认凭 turnId。
        ...(turn.message?.musicRecommendation ? { musicRecommendation: publicRecommendation(turn.message.musicRecommendation) } : {}) } });
    conversationStore.updateRoom(sessionId, { unread: true });
    queueService.publishSnapshot({ sessionId, conversationId: sessionId, message: payload.message,
      ...(payload.overlayNarration ? { overlayNarrations: [payload.overlayNarration] } : {}) });
    return payload.overlayNarration ? 'spoken' : 'text-only';
  }

  const workingBeats = rawBeats.map((beat, idx) => ({
    ...beat,
    index: Number.isInteger(beat.index) ? beat.index : idx,
  }));
  const recExtra = turn.message?.musicRecommendation
    ? { musicRecommendation: publicRecommendation(turn.message.musicRecommendation) }
    : {};

  if (!voice || !isCurrent()) {
    const envelope = presentationService.create({
      text: turn.visibleText,
      spokenText: '',
      entity: person,
      sourceTurnId: turn.turnId,
      correlationId,
      conversationId: sessionId,
      speak: false,
      beats: workingBeats,
    });
    await presentationService.deliver(envelope);
    const voiceExtra = buildBeatsVoiceExtra(workingBeats);
    const payload = deliveryPayload({
      presentation: envelope,
      audio: null,
      sessionId,
      virtualPersonId: person.id,
      reason: 'virtual-person:presence',
      allowAudio: false,
      extra: {
        presentation: 'presence',
        sequence: turn.sequence,
        beats: workingBeats,
        beatProgress: { deliveredCount: workingBeats.length, totalCount: workingBeats.length, done: true },
        ...(voiceExtra ? { voice: voiceExtra } : {}),
        ...recExtra,
      },
    });
    conversationStore.updateRoom(sessionId, { unread: true });
    queueService.publishSnapshot({ sessionId, conversationId: sessionId, message: payload.message });
    return 'text-only';
  }

  const overlayNarrations = [];
  let previousHadAudio = false;
  for (let i = 0; i < workingBeats.length; i += 1) {
    if (!isCurrent()) break;
    const beat = workingBeats[i];
    const spoken = beatSpokenText(beat);
    const performance = toSpeechPerformance(beat.voice);
    let audio = null;
    if (spoken) {
      const envelope = presentationService.create({
        text: turn.visibleText,
        spokenText: spoken,
        entity: person,
        sourceTurnId: turn.turnId,
        correlationId,
        conversationId: sessionId,
        speak: true,
        beats: workingBeats,
        ...(performance ? { performance } : {}),
      });
      const delivered = await presentationService.deliver(envelope);
      audio = delivered.audio;
      if (audio?.url) {
        const hash = audio.hash || audioHashFromUrl(audio.url);
        beat.audioUrl = audio.url;
        if (hash) beat.hash = hash;
        if (Number.isFinite(audio.durationMs)) beat.durationMs = audio.durationMs;
        conversationStore.updateTurnVoice?.(turn.turnId, {
          beatIndex: beat.index,
          voiceProfileId: person.voiceProfileId,
          audioUrl: audio.url,
          ...(hash ? { hash } : {}),
          ...(Number.isFinite(audio.durationMs) ? { durationMs: audio.durationMs } : {}),
          synthesizedAt: Date.now(),
        });
      }
    }
    const isLast = i === workingBeats.length - 1;
    const delayBeforeMs = i === 0 || !previousHadAudio ? 0 : (workingBeats[i - 1]?.pauseAfterMs ?? 0);
    previousHadAudio = Boolean(audio?.url);
    if (audio?.url && isCurrent()) {
      const overlayEnvelope = presentationService.create({
        text: turn.visibleText,
        spokenText: spoken,
        entity: person,
        sourceTurnId: turn.turnId,
        correlationId,
        conversationId: sessionId,
        speak: true,
      });
      const { overlayNarration } = deliveryPayload({
        presentation: overlayEnvelope,
        audio,
        sessionId,
        virtualPersonId: person.id,
        reason: 'virtual-person:presence',
        allowAudio: true,
        beatOverlay: {
          beatIndex: i,
          beatCount: workingBeats.length,
          isLastBeat: isLast,
          delayBeforeMs,
          turnDuckLeaseId: turn.turnId,
          holdDuckLease: i < workingBeats.length - 1,
          text: spoken,
        },
      });
      if (overlayNarration) overlayNarrations.push(overlayNarration);
    }
  }
  for (let idx = 0; idx < overlayNarrations.length; idx += 1) {
    overlayNarrations[idx].beatCount = overlayNarrations.length;
    overlayNarrations[idx].isLastBeat = idx === overlayNarrations.length - 1;
    overlayNarrations[idx].holdDuckLease = idx < overlayNarrations.length - 1;
  }
  const finalEnvelope = presentationService.create({
    text: turn.visibleText,
    spokenText: '',
    entity: person,
    sourceTurnId: turn.turnId,
    correlationId,
    conversationId: sessionId,
    speak: false,
    beats: workingBeats,
  });
  const voiceExtra = buildBeatsVoiceExtra(workingBeats);
  const payload = deliveryPayload({
    presentation: finalEnvelope,
    audio: null,
    sessionId,
    virtualPersonId: person.id,
    reason: 'virtual-person:presence',
    allowAudio: false,
    extra: {
      presentation: 'presence',
      sequence: turn.sequence,
      beats: workingBeats,
      beatProgress: { deliveredCount: workingBeats.length, totalCount: workingBeats.length, done: true },
      ...(voiceExtra ? { voice: voiceExtra } : {}),
      ...recExtra,
    },
  });
  conversationStore.updateRoom(sessionId, { unread: true });
  queueService.publishSnapshot({
    sessionId,
    conversationId: sessionId,
    message: payload.message,
    ...(overlayNarrations.length && isCurrent() ? { overlayNarrations } : {}),
  });
  return overlayNarrations.length && isCurrent() ? 'spoken' : 'text-only';
}
