export function parseEvidence(row) {
  try { return typeof row?.evidence === 'object' ? row.evidence || {} : JSON.parse(row?.evidence || '{}'); }
  catch { return {}; }
}

/** Ownership is the namespace. Origin is provenance; only explicit restrictions narrow applicability. */
export function policyFromUserText(text, sessionId, now = Date.now()) {
  const value = String(text || '');
  return {
    ...( /(?:只限|仅限|只在|只对).{0,8}(?:这次|本次|这个会话|这个聊天|这里)|(?:这次|本次|今天|今晚).{0,8}(?:就好|才|限定|只|想听|要听)/u.test(value)
      ? { onlyConversationId: sessionId, until: now + 24 * 60 * 60 * 1000 } : {}),
    disclosure: /(?:别|不要|不许|不想|不能).{0,10}(?:群里|群聊|其他人|别人).{0,8}(?:提|说|知道|分享)|(?:保密|只告诉你|你我之间)/u.test(value) ? 'private' : 'normal',
  };
}

export function memoryApplies(row, { sessionId, isGroup = false, now = Date.now() } = {}) {
  const policy = row.policy || parseEvidence(row).policy || {};
  return !/(?:^|,)(?:revoked|superseded)(?:,|$)/u.test(row.tags || '')
    && (!row.expiresAt || row.expiresAt > now)
    && (!policy.until || policy.until > now)
    && (!policy.onlyConversationId || policy.onlyConversationId === sessionId)
    && !(isGroup && policy.disclosure === 'private');
}
