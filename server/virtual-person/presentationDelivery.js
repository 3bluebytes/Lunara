// presentationDelivery.js — 已领取 PresentationEnvelope 的交付形状（聊天回复与主动开口共用）。
//
// 输入：envelope 经 PresentationService.deliver 后的结果。输出：一条聊天气泡 message，
// 以及（仅当仍允许出声且合成出音频时）一条 overlay narration。发布由调用方合成一次
// queueService.publishSnapshot，这里不发布、不写状态。
//
// Python 伪代码：
//   message, overlay = delivery_payload(presentation, audio, session_id=sid, reason='virtual-person:reply')
export function deliveryPayload({ presentation, audio = null, sessionId, virtualPersonId, reason,
  allowAudio = true, overlayType = 'listener_response', extra = {} }) {
  const message = { say: presentation.displayText, mood: presentation.mood || 'neutral', reason,
    virtualPersonId, speakerId: virtualPersonId, conversationId: sessionId,
    sourceTurnId: presentation.sourceTurnId, turnId: presentation.sourceTurnId, ...extra };
  const overlayNarration = audio?.url && allowAudio ? {
    kind: 'narration', url: audio.url, text: presentation.spokenText,
    type: overlayType, source: audio.source || null, duck: true,
    virtualPersonId, voiceProfileId: presentation.voiceProfileId,
    sourceTurnId: presentation.sourceTurnId, conversationId: sessionId,
    expiresAt: presentation.expiresAt,
  } : null;
  return { message, overlayNarration };
}
