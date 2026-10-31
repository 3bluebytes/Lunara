const ERROR_COPY = Object.freeze({
  '切换失败': '没有切换成功，当前对话没有变化。请稍后再试。',
  '创建失败': '这位伙伴暂时没有创建成功。请检查声音配置后再试。',
  '归档失败': '暂时无法归档这位伙伴，当前会话没有变化。',
  '对话恢复失败': '暂时没能取回之前的对话。你仍然可以继续说话，稍后刷新重试。',
  '登录操作失败': '登录操作没有完成，请稍后再试。',
  '设置错误': '设置没有保存成功，请检查填写内容后再试。',
});

export function userFacingToastMessage(type, title, message = '', { curated = false } = {}) {
  const fallback = String(message || '').trim();
  if (type !== 'error') return fallback;
  // curated：调用方已确认消息只来自产品文案边界（自研路由的 userMessage 等），
  // 不是原始异常或内部错误，直接展示，避免掩盖“为什么没保存”。
  if (curated) return fallback;
  return ERROR_COPY[String(title || '').trim()]
    || '刚才的操作没有完成。当前状态已经保留，请稍后再试。';
}

