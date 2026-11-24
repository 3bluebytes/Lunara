// turnFailure.js — 回合失败的分类与兜底文案（纯函数，不读写任何状态）。
//
// 输入是 AgentLoop 抛出的错误或工具 outcome，输出是失败码和可以直接给听众看的安全文案；
// 原始异常、凭据、堆栈和内部错误 ID 不从这里出去。入账与呈现仍由 VirtualPersonRuntime 负责。

export function safeFailure(error) {
  if (error?.code === 'LLM_API_ERROR' && (error.status === 401 || error.status === 403)) {
    return '模型连接的认证或访问权限未通过，暂时无法回复。请检查模型连接设置，或切换可用模型后重试。';
  }
  // 没接模型不是“没接住”：重说一遍不会好，要把人引到设置里。
  if (error?.code === 'LLM_NOT_CONFIGURED') {
    return '我这边还没接上模型，所以暂时回不了话。到「设置 → 模型与连接」接入一个模型，再跟我说一次。';
  }
  return '刚才这句话我没能接住。你愿意的话，再跟我说一次。';
}

const SAFE_TURN_FAILURE_CODES = new Set([
  'AGENT_TIMEOUT', 'AGENT_ROUND_LIMIT', 'EMPTY_ASSISTANT_RESPONSE',
  'EMPTY_TOOL_PRESENTATION', 'LLM_API_ERROR', 'LLM_INVALID_RESPONSE', 'LLM_NOT_CONFIGURED', 'LLM_TIMEOUT',
]);
// 回合截止与单次模型请求超时（含同端点重试后仍超时）对用户是同一件事：想得太久。
export const TIMEOUT_FAILURE_CODES = new Set(['AGENT_TIMEOUT', 'LLM_TIMEOUT']);

export function classifyTurnFailure(error) {
  return SAFE_TURN_FAILURE_CODES.has(error?.code) ? error.code : 'TURN_INTERNAL_ERROR';
}

export function unsafeDiagnosticText(text) {
  return /\berr_[a-f0-9]{8,}\b|INTERNAL_TOOL_ERROR|(?:stack\s*trace|traceback)|(?:api[_ -]?key|authorization|cookie|token|secret)\s*[:=]|https?:\/\/\S*[?&](?:token|key|auth|signature)=/i
    .test(String(text || ''));
}

/** 已被接受的终止性 mutation：播放器/账本已经改变，之后的取消不能把它说成没做。 */
export function acceptedTerminal(outcomes = []) {
  return (Array.isArray(outcomes) ? outcomes : []).find(outcome => outcome?.ok && outcome.terminal) || null;
}

// 回合截止时模型往往还在改正上一步（如重选解析失败的歌）：上一个非终止失败的文案是改正前的中间态，
// 不能当作结论。超时只如实说「太久了」；尝试过音乐动作时补一句没有改动（未提交本身是事实）。
export function timeoutFallback(outcomes = []) {
  const triedMusic = (Array.isArray(outcomes) ? outcomes : []).some(outcome => /^MUSIC_/u.test(String(outcome?.code || '')));
  return triedMusic
    ? '这次我想得太久，超时了，队列和播放状态都没有变化。你再说一次，我重新来。'
    : '这次我想得太久，超时了。你愿意的话，再跟我说一次。';
}

export function safeOutcomeFallback(outcomes = []) {
  return [...outcomes].reverse().find(outcome => outcome?.presentation?.displayText)?.presentation?.displayText || '';
}
