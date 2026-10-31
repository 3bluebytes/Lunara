// presenceDelivery.js — 一行已入账的主动开口怎么送到用户面前（P1 与 ambient turn 共用）。
//
// 输入：已入账的 presence turn、说话角色、会话、是否允许出声、仍然有效的判断。
// 顺序：PresentationService 生成呈现（sourceTurnId = 这一行）→ 共享交付形状 →
//       先标未读再发布（正在看这个聊天的那端可以立刻清掉）。
// 输出：'spoken'（带人声叠加）或 'text-only'。异常抛给调用方：已入账的话刷新后仍可见，不补发。
import { deliveryPayload } from '../virtual-person/presentationDelivery.js';
import { publicRecommendation } from './ambientRecommendations.js';

export async function deliverPresenceTurn({ presentationService, queueService, conversationStore, turn, person,
  sessionId, correlationId, voice = false, isCurrent = () => true }) {
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
