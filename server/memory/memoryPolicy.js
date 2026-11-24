export function parseEvidence(row) {
  try { return typeof row?.evidence === 'object' ? row.evidence || {} : JSON.parse(row?.evidence || '{}'); }
  catch { return {}; }
}

// "别让别人知道 / 别在群里提"、"别告诉别人 / 别跟大家说"、"别说出去 / 别外传"、"保密 / 只告诉你"都表示只限这段关系。
const PRIVATE_DISCLOSURE = new RegExp([
  '(?:别|不要|不许|不想|不能).{0,10}(?:群里|群聊|其他人|别人).{0,8}(?:提|说|知道|分享)',
  '(?:别|不要|不许|不能|不准)\\s*(?:告诉|跟|和|对|让)\\s*(?:别人|其他人|任何人|大家|别的伙伴|其他伙伴|谁)',
  '(?:别|不要|不许|不能)\\s*(?:说出去|外传|传出去|声张|到处说)',
  '保密|只告诉你|你我之间|咱俩的秘密|我们之间的秘密',
].join('|'), 'u');

const TEMPORARY_SCOPE = /(?:只限|仅限|只在|只对).{0,8}(?:这次|本次|这个会话|这个聊天|这里)|(?:这次|本次|今天|今晚).{0,8}(?:就好|限定|只|想听|要听)/u;

/**
 * 一条显式记忆的适用范围：私密与否看整句原话（有一处「别告诉别人」就按私密处理，宁可收窄）；
 * 「这次/今天只…」这类临时限定只看依据片段所在的那句，以及紧挨着的、只有限定词的短句（如「这次就好。」）。
 * 一句话里先说「今天只想听爵士。」再说「我叫小明」，名字不跟着变成临时的。
 */
export function policyForQuote(text, quote, sessionId, now = Date.now()) {
  const value = String(text || '');
  const start = value.indexOf(String(quote || ''));
  if (!quote || start < 0) return policyFromUserText(value, sessionId, now);
  const end = start + String(quote).length;
  const sentences = [...value.matchAll(/[^。！？!?；;\n]+[。！？!?；;\n]*/gu)].map(match => ({ from: match.index, to: match.index + match[0].length, text: match[0] }));
  const hit = sentences.map((sentence, index) => (sentence.from < end && sentence.to > start ? index : -1)).filter(index => index >= 0);
  // 只由限定词组成的短句（「这次就好」「只限这次」）才管到相邻的句子；「今天只想听爵士」有自己的内容，只管它自己。
  const bare = sentence => sentence && TEMPORARY_SCOPE.test(sentence.text)
    && !sentence.text.replace(/只限|仅限|只在|只对|这次|本次|今天|今晚|这个会话|这个聊天|这里|就好|限定|而已|吧|啊|哦|呀|哈|[\s。！？!?；;，,、~～]/gu, '');
  const scoped = [hit[0] - 1, ...hit, hit.at(-1) + 1].filter(index => index === hit[0] - 1 || index === hit.at(-1) + 1
    ? bare(sentences[index]) : true).map(index => sentences[index]?.text || '').join('');
  const temporal = policyFromUserText(scoped, sessionId, now);
  return { ...temporal, disclosure: policyFromUserText(value, sessionId, now).disclosure };
}

/** Ownership is the namespace. Origin is provenance; only explicit restrictions narrow applicability. */
export function policyFromUserText(text, sessionId, now = Date.now()) {
  const value = String(text || '');
  return {
    // 「今天才知道…」是在说一件长期的事，「才」不算限定。
    ...( TEMPORARY_SCOPE.test(value)
      ? { onlyConversationId: sessionId, until: now + 24 * 60 * 60 * 1000 } : {}),
    disclosure: PRIVATE_DISCLOSURE.test(value) ? 'private' : 'normal',
  };
}

/**
 * 这条记忆此刻还算不算数：撤回、取代、过期与「只限这次/这个聊天」的临时范围是用户的硬指令。
 * 私下说的、敏感的照样适用——在群聊里提不提是伙伴自己的分寸（见 discretionLabel），不在这里滤掉。
 * shared：内容会脱离来源标签、或交给当时不在场的人（口味图式、没听过这句话的读者），私下与敏感的就不给。
 */
export function memoryApplies(row, { sessionId, now = Date.now(), shared = false } = {}) {
  const policy = row.policy || parseEvidence(row).policy || {};
  return !/(?:^|,)(?:revoked|superseded)(?:,|$)/u.test(row.tags || '')
    && (!row.expiresAt || row.expiresAt > now)
    && (!policy.until || policy.until > now)
    && (!policy.onlyConversationId || policy.onlyConversationId === sessionId)
    && !(shared && (policy.disclosure === 'private' || policy.sensitive === true));
}

/** 提示词里的来源标签：私下说的、反思判为敏感的。没有标签返回空串。 */
export function discretionLabel(policy) {
  const marks = [policy?.disclosure === 'private' ? '对方私下跟你说的' : '', policy?.sensitive === true ? '比较私人的事' : '']
    .filter(Boolean);
  return marks.length ? `（${marks.join('，')}）` : '';
}

/** 记忆行上的来源标签（策略在 row.policy 或 evidence.policy 里）。 */
export function memoryDiscretionLabel(row) {
  return discretionLabel(row?.policy || parseEvidence(row).policy || {});
}
