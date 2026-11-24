export const INTERACTION_MODES = Object.freeze(['radio', 'roleplay']);

export function normalizeInteractionMode(value) {
  return String(value || '').trim() === 'roleplay' ? 'roleplay' : 'radio';
}

export function assertInteractionMode(value) {
  const normalized = String(value ?? '').trim();
  if (!INTERACTION_MODES.includes(normalized)) {
    throw new TypeError(`invalid interactionMode: ${normalized || '(empty)'}`);
  }
  return normalized;
}

const SKIP_PAREN_CONTENT = /^(?:[\d\s\-–—/.,:年月日号版]+|(?:feat\.?|ft\.?|live|remix|ver\.?|demo|instrumental|acoustic)[^）)]*)$/iu;
const URL_IN_SPEECH = /\[([^\]]+)\]\(https?:\/\/[^)]+\)|https?:\/\/[^\s<>]+/giu;
const QUOTE_SPAN_RE = /(“[^”\n]{1,500}”|「[^」\n]{1,500}」|"[^"\n]{1,500}")/gu;
const ACTION_STARTER_RE = /^(?:我(?!(?:们|觉得|认为|猜|想说|想问|想跟你说|问你|告诉你|劝你|看你还是|希望你))|声音|语气|嗓音|目光|眼神|视线|手指|指尖|呼吸|眉头|嘴角|耳根|脸色|顿了顿|沉默|半晌|良久|片刻|低声|轻声|抬眼|垂眼|转身|背对|靠在|坐在|站在)/u;
const QUOTE_COMMENTARY_RE = /(?:这句|那句|这几个字|这四个字|这三个字|这两个字|这种话|那句话|怎么唱|写过一句|常说)/u;
const OTHER_SPEAKER_PROMPT_RE = /^(?:你|你们|他|她|别人|有人)[^“「]{0,12}[：:]$/u;

function cleanSpokenPiece(text) {
  return String(text || '')
    .replace(URL_IN_SPEECH, (_, label) => label || '')
    .replace(/[“”「」『』]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function joinSpokenPieces(pieces) {
  return pieces
    .map(cleanSpokenPiece)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+([，。！？；：、,.!?;:])/gu, '$1')
    .trim();
}

function splitInlineQuotedParagraph(para) {
  const text = String(para ?? '').trim();
  if (!text) return null;
  const matches = [...text.matchAll(QUOTE_SPAN_RE)];
  if (!matches.length) return null;

  const spansWholeEnds = matches.length >= 2
    && (matches[0].index ?? 0) === 0
    && (matches.at(-1).index ?? 0) + matches.at(-1)[0].length === text.length;

  for (const match of matches) {
    const index = match.index ?? 0;
    const token = match[0];
    const before = text.slice(0, index).trimEnd();
    if (before && !/[，,。！？!?；;：:—…]$/u.test(before)) return null;
    const inner = token.slice(1, -1).trim();
    if (!inner) return null;
    const after = text.slice(index + token.length).trim();
    if (!/[。！？!?…，,；;：:—～~]$/u.test(inner) && after !== '' && !spansWholeEnds) {
      return null;
    }
  }

  const pieces = [];
  const unquotedParts = [];
  let pos = 0;
  for (const match of matches) {
    const index = match.index ?? 0;
    if (index > pos) {
      const gap = text.slice(pos, index).trim();
      if (gap) {
        unquotedParts.push(gap);
        pieces.push({ type: 'action', content: gap });
      }
    }
    pieces.push({ type: 'speech', content: match[0], _inner: match[0].slice(1, -1).trim() });
    pos = index + match[0].length;
  }
  if (pos < text.length) {
    const tail = text.slice(pos).trim();
    if (tail) {
      unquotedParts.push(tail);
      pieces.push({ type: 'action', content: tail });
    }
  }

  const meaningfulUnquotedChars = [...unquotedParts.join('').replace(/[\s，,。！？!?；;：:、—…]/gu, '')].length;
  if (meaningfulUnquotedChars === 0) return null;

  if (matches.length >= 2) {
    if (unquotedParts.some(part => OTHER_SPEAKER_PROMPT_RE.test(part))) return null;
  } else {
    const outerJoined = unquotedParts.join(' ');
    const lastOuter = unquotedParts.at(-1) || '';
    if (/[?？]$/u.test(lastOuter) || QUOTE_COMMENTARY_RE.test(outerJoined)) return null;
    const quoteInner = pieces.find(piece => piece.type === 'speech')?._inner || '';
    const trailingAfterQuote = (matches[0].index ?? 0) + matches[0][0].length < text.length
      ? text.slice((matches[0].index ?? 0) + matches[0][0].length).trim()
      : '';
    const commaQuoteWithI = /[，,]$/u.test(quoteInner) && Boolean(trailingAfterQuote)
      && /^我(?!(?:们|觉得|认为|猜|想说|想问|想跟你说|问你|告诉你|劝你|看你还是|希望你))/u.test(trailingAfterQuote);
    const matchesActionStarter = unquotedParts.every(part => ACTION_STARTER_RE.test(part));
    if (!commaQuoteWithI && !matchesActionStarter) return null;
  }

  return pieces.map((piece, idx) => ({
    type: piece.type,
    content: piece.content,
    ...(idx > 0 ? { inline: true } : {}),
  }));
}

function mergeAdjacentSegments(segments) {
  const cleaned = [];
  for (const segment of segments) {
    const content = String(segment?.content || '').trim();
    if (!content) continue;
    cleaned.push({
      type: segment?.type === 'action' ? 'action' : 'speech',
      content,
      ...(segment?.inline === true ? { inline: true } : {}),
    });
  }
  const merged = [];
  for (let i = 0; i < cleaned.length; i += 1) {
    const item = cleaned[i];
    // 禁止把前后自然段合进带 inline 后继或从 inline 结尾的混排段落，避免破坏同段混排结构。
    const nextInline = cleaned[i + 1]?.inline === true;
    const prev = merged.at(-1);
    if (prev && !prev.inline && !item.inline && !nextInline && prev.type === item.type) {
      prev.content = `${prev.content}\n${item.content}`;
    } else {
      merged.push(item);
    }
  }
  return merged;
}

/**
 * 将「私语」或长回复拆分为舞台动作描写（action）与角色实际开口台词（speech）。
 * - 路径 A：显式星号 `*...*` 或括号 `（...）` / `(...)` 动作描写（排除纯年份/Live 等曲目标注），
 *   同时识别单自然段内“引号台词 + 行内动作插叙”；
 * - 路径 B：网文混排兜底（总长 > 80 字，包含引号台词且引号外有 >= 12 字叙述描写）；
 * - 路径 C：其余情况视为纯台词（speech）。
 */
export function parseRoleplaySegments(text) {
  const raw = String(text ?? '').trim();
  if (!raw) {
    return { segments: [], spokenText: '', hasAction: false, hasSpeech: false };
  }

  // 路径 A：显式 *...* 或 （...） / (...)，与自然段内“引号台词 + 行内动作”
  const markerRegex = /(\*[^*\n]{1,500}\*|[（(][^()（）\n]{2,500}[）)])/gu;
  const rawItems = [];
  let cursor = 0;
  let foundExplicitAction = false;
  let hasInlineAction = false;

  const pushUnbracketed = slice => {
    const trimmed = String(slice || '').trim();
    if (!trimmed) return;
    for (const para of trimmed.split(/\n+/)) {
      const cleanPara = para.trim();
      if (!cleanPara) continue;
      const inlineParts = splitInlineQuotedParagraph(cleanPara);
      if (inlineParts) {
        hasInlineAction = true;
        rawItems.push(...inlineParts);
      } else {
        rawItems.push({ type: 'speech', content: cleanPara, _plainPara: true });
      }
    }
  };

  for (const match of raw.matchAll(markerRegex)) {
    const index = match.index ?? 0;
    const token = match[0];
    const inner = token.slice(1, -1).trim();
    const isParen = token.startsWith('（') || token.startsWith('(');
    if (!inner || (isParen && SKIP_PAREN_CONTENT.test(inner))) {
      continue;
    }
    if (index > cursor) pushUnbracketed(raw.slice(cursor, index));
    rawItems.push({ type: 'action', content: token.startsWith('*') ? inner : token });
    foundExplicitAction = true;
    cursor = index + token.length;
  }
  if (cursor < raw.length) pushUnbracketed(raw.slice(cursor));

  // 路径 B：无显式括号/星号时，兼容「叙述描写 + 引号对白」网文混排
  if (!foundExplicitAction && [...raw].length > 80) {
    const rawQuoteMatches = [...raw.matchAll(QUOTE_SPAN_RE)];
    if (rawQuoteMatches.length > 0) {
      let pos = 0;
      let unquotedChars = 0;
      for (const match of rawQuoteMatches) {
        const index = match.index ?? 0;
        if (index > pos) {
          const prose = raw.slice(pos, index).trim();
          if (prose) unquotedChars += [...prose.replace(/\s+/gu, '')].length;
        }
        pos = index + match[0].length;
      }
      if (pos < raw.length) {
        const tail = raw.slice(pos).trim();
        if (tail) unquotedChars += [...tail.replace(/\s+/gu, '')].length;
      }
      if (unquotedChars >= 12) {
        const pathBItems = [];
        let usedPathB = false;
        for (const item of rawItems) {
          if (!item._plainPara) {
            pathBItems.push(item);
            continue;
          }
          const para = item.content;
          const qMatches = [...para.matchAll(QUOTE_SPAN_RE)];
          if (!qMatches.length) {
            pathBItems.push({ type: 'action', content: para });
            usedPathB = true;
          } else {
            let p = 0;
            for (const qm of qMatches) {
              const qi = qm.index ?? 0;
              if (qi > p) {
                const before = para.slice(p, qi).trim();
                if (before) pathBItems.push({ type: 'action', content: before });
              }
              pathBItems.push({ type: 'speech', content: qm[0] });
              p = qi + qm[0].length;
            }
            if (p < para.length) {
              const after = para.slice(p).trim();
              if (after) pathBItems.push({ type: 'action', content: after });
            }
            usedPathB = true;
          }
        }
        if (usedPathB) {
          const mergedB = mergeAdjacentSegments(pathBItems);
          const spokenB = joinSpokenPieces(mergedB.filter(s => s.type === 'speech').map(s => s.content));
          if (spokenB) {
            return {
              segments: mergedB,
              spokenText: spokenB,
              hasAction: mergedB.some(s => s.type === 'action'),
              hasSpeech: true,
            };
          }
        }
      }
    }
  }

  if (foundExplicitAction || hasInlineAction) {
    const finalized = mergeAdjacentSegments(rawItems.map(({ _plainPara, ...rest }) => rest));
    const spokenText = joinSpokenPieces(finalized.filter(s => s.type === 'speech').map(s => s.content));
    return {
      segments: finalized,
      spokenText,
      hasAction: finalized.some(s => s.type === 'action'),
      hasSpeech: Boolean(spokenText),
    };
  }

  // 路径 C：普通口语回复
  const spokenText = joinSpokenPieces([raw]);
  return {
    segments: [{ type: 'speech', content: raw }],
    spokenText,
    hasAction: false,
    hasSpeech: Boolean(spokenText),
  };
}

/**
 * 将长台词按自然句界切分为不超过 maxChars 个码点的有序片段，避免单次非流式 TTS 超时。
 */
export function splitSpeechChunks(text, { maxChars = 220 } = {}) {
  const input = String(text ?? '').trim();
  if (!input) return [];
  const limit = Math.max(20, Number(maxChars) || 220);
  const codepoints = value => [...value].length;
  if (codepoints(input) <= limit) return [input];

  const hardSlice = piece => {
    const chars = [...piece];
    const out = [];
    for (let i = 0; i < chars.length; i += limit) {
      const slice = chars.slice(i, i + limit).join('').trim();
      if (slice) out.push(slice);
    }
    return out;
  };

  const splitByClause = sentence => {
    if (codepoints(sentence) <= limit) return [sentence];
    const clauses = sentence.split(/(?<=[，、；：,;:\s])/u).map(s => s.trim()).filter(Boolean);
    const out = [];
    let current = '';
    for (const clause of clauses) {
      if (codepoints(clause) > limit) {
        if (current) { out.push(current); current = ''; }
        out.push(...hardSlice(clause));
        continue;
      }
      const next = current ? `${current} ${clause}` : clause;
      if (codepoints(next) <= limit) current = next;
      else {
        if (current) out.push(current);
        current = clause;
      }
    }
    if (current) out.push(current);
    return out;
  };

  const sentences = input.split(/(?<=[。！？!?…\n])/u).map(s => s.trim()).filter(Boolean);
  const chunks = [];
  let buffer = '';
  for (const sentence of sentences) {
    const pieces = splitByClause(sentence);
    for (const piece of pieces) {
      const candidate = buffer ? `${buffer} ${piece}` : piece;
      if (codepoints(candidate) <= limit) {
        buffer = candidate;
      } else {
        if (buffer) chunks.push(buffer);
        buffer = piece;
      }
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

const SPEAKABLE_RE = /[\p{L}\p{N}]/u;

/**
 * 清洗送给神经 TTS 的口语文本：消除句首孤立省略号、句中密集省略号与叠字顿号导致的电音吞字。
 * 不再基于正则词表猜测情绪或自动注入叹气/轻笑标记。
 */
export function sanitizeSpeechForTts(rawText) {
  const text = String(rawText ?? '')
    .replace(URL_IN_SPEECH, (_, label) => label || '')
    .replace(/[“”「」『』"]/gu, '')
    .replace(/(.)、(?=\1)/gu, '$1，')
    .replace(/^[\s….。，,；;：:、—\-·]+/u, '')
    .replace(/(?<=[。！？!?])\s*(?:…+|\.{2,}|—+)\s*$/u, '')
    .replace(/(?:…+|\.{2,}|—+)\s*$/u, '。')
    .replace(/(?:…+|\.{3,}|—{2,})/gu, '，')
    .replace(/[，,]{2,}/gu, '，')
    .replace(/[。]{2,}/gu, '。')
    .replace(/([，,])\s*([。！？!?])/gu, '$2')
    .replace(/([。！？!?])\s*[，,]+/gu, '$1')
    .replace(/\s+/gu, ' ')
    .replace(/\s+([，。！？；：、,.!?;:])/gu, '$1')
    .trim();

  if (!text || !SPEAKABLE_RE.test(text)) return '';
  return text;
}
