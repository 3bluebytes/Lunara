// 陪伴模式：一份版本化预设，两类职责。Runtime 据此判定自动串词资格与频率，
// Agent/串词消费同一预设的表达说明：资格是许可不是义务，不带句数字数。模式不重写 persona、不改选歌硬条件、
// 不触发定时闲聊，也不改变视觉专注模式。

export const COMPANION_MODE_IDS = Object.freeze(['music_only', 'occasional', 'conversational']);
const COMPANION_MODE_POLICY_VERSION = 1;

// 非静音预设共用的自动口播最小启动间隔（按被接受的实际开口事实计时）。
export const AUTOMATIC_NARRATION_MIN_INTERVAL_MS = 120_000;

const COMPANION_MODE_POLICIES = Object.freeze({
  music_only: Object.freeze({
    id: 'music_only',
    label: '只听歌',
    automaticNarration: false,
    // 每几个实际激活 occurrence 提供一次自动资格；music_only 永不。
    cadence: 0,
    promptGuide: '当前是只听歌模式：不要主动口播或展开话题。用户主动提问时正常回答，可以完整表达，但不要借机恢复自动串词。',
  }),
  occasional: Object.freeze({
    id: 'occasional',
    label: '偶尔介绍',
    automaticNarration: true,
    cadence: 3,
    promptGuide: '当前是偶尔介绍模式：隔几首歌会轮到一次自动开口机会；有想分享的音乐细节或感受就简短聊聊音乐本身，其余时候让歌安静地放就好。这只关乎自动串词，用户主动对话时按你的人设正常交流。',
  }),
  conversational: Object.freeze({
    id: 'conversational',
    label: '多聊一点',
    automaticNarration: true,
    cadence: 1,
    promptGuide: '当前是多聊一点模式：每首歌开始时你都可以按自己的性格聊聊这首歌、联想到的事或此刻的气氛，长短随你；确实没什么想补充时也可以让歌安静地放。描述以已知上下文和歌曲事实为准。这只关乎自动串词，用户主动对话时按你的人设正常交流。',
  }),
});

export function isCompanionModeId(value) {
  return COMPANION_MODE_IDS.includes(value);
}

/** 新会话默认模式。旧 snapshot 缺字段/为 null 时由 hydrate 归一到它，不存在第四种策略。 */
export const DEFAULT_COMPANION_MODE_ID = 'conversational';

export function resolveCompanionModePolicy(modeId) {
  return isCompanionModeId(modeId) ? COMPANION_MODE_POLICIES[modeId] : null;
}

/** epoch 内第 position 个被计数的 occurrence 是否有自动资格（1、4、7… 对 cadence 3）。 */
export function occurrencePositionAutoEligible(policy, position) {
  if (!policy?.automaticNarration || !Number.isInteger(position) || position < 1) return false;
  const cadence = Math.max(1, Number(policy.cadence) || 1);
  return (position - 1) % cadence === 0;
}

/** UI / prompt 用的有界摘要；非法/空 id 返回 null，由调用方决定兜底。 */
export function describeCompanionMode(modeId) {
  const policy = resolveCompanionModePolicy(modeId);
  if (!policy) return null;
  return Object.freeze({
    modeId: policy.id,
    label: policy.label,
    policyVersion: COMPANION_MODE_POLICY_VERSION,
    guidance: policy.promptGuide,
  });
}
