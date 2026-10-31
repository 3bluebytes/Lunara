/**
 * 群聊历史里给「别人」说的话加的说话人标注。它只是给模型看的上下文格式，不是可见文本：
 * 模型偶尔会照着格式把标签说出来，所以模型输出和旧账本里开头的标签都要剥掉。
 */
const SPEAKER_LABEL_PREFIX = /^(?:\s*\[历史说话人[：:][^\]\n]{0,40}\]\s*)+/u;

export function speakerLabel(displayName) {
  return `[历史说话人：${displayName}]`;
}

export function stripSpeakerLabel(text) {
  return typeof text === 'string' ? text.replace(SPEAKER_LABEL_PREFIX, '') : text;
}
