export function sanitizeExternalText(value, max = 1200) {
  let text = String(value || '').slice(0, max);
  if (/(?:stack\s*trace|traceback|sdk request failed|internal_tool_error)/i.test(text)) return '';
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, '[external link omitted]');
  text = text.replace(/(?:api[_ -]?key|authorization|cookie|token|secret|signature)\s*[:=]\s*[^\s,;]+/gi, '[sensitive value omitted]');
  return text.trim();
}

// 默认上限适用于所有工具；候选 offer 这类已知有界的结构化结果可以显式放宽深度与条数。
export function sanitizeFacts(value, depth = 0, { maxDepth = 4, maxItems = 20 } = {}) {
  const limits = { maxDepth, maxItems };
  if (depth > maxDepth || value == null) return value == null ? null : '[bounded]';
  if (Array.isArray(value)) return value.slice(0, maxItems).map(item => sanitizeFacts(item, depth + 1, limits));
  if (typeof value === 'string') return sanitizeExternalText(value);
  if (typeof value !== 'object') return value;
  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    if (/url|cookie|token|secret|authorization|credential|error|stack|diagnostic|header|config/i.test(key)) continue;
    clean[key] = sanitizeFacts(item, depth + 1, limits);
  }
  return clean;
}
