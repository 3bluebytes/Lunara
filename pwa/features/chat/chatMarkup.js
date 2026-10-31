import { splitLeadingQuote } from './chatQuote.js';
import { webSourcesHtml } from './webSources.js';

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function buildTrackCardHtml(track = {}) {
  const songId = track.songId ?? track.song_id ?? '';
  const queueItemId = track.queueItemId ?? '';
  const batchId = track.batchId ?? '';
  // 可选 = 卡片带着稳定的播放身份（队列出现位置，或至少 canonical songId）。
  // 不能拿媒体 url 当门槛：聊天气泡里的歌来自已提交的账本，本来就没有 url，
  // 拿它判断会让历史卡片全部变成不可点的死卡。
  const selectable = Boolean(String(queueItemId || songId).trim());
  const className = selectable ? 'chat-track' : 'chat-track unavailable';
  const artwork = track.artwork || track.pic_url || '';
  const title = track.title || '?';
  const subtitle = [track.artist, track.album].filter(Boolean).join(' · ');
  const queueIndex = track.__queueIdx != null
    ? ` data-queue-idx="${escapeHtml(track.__queueIdx)}"`
    : '';
  const queueAttr = queueItemId ? ` data-queue-item-id="${escapeHtml(queueItemId)}"` : '';
  const cover = artwork
    ? `<img src="${escapeHtml(artwork)}" alt="" loading="lazy" />`
    : '<svg class="ct-cover-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V6.4l10-2v11.6"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>';
  const label = `播放《${title}》${subtitle ? ` — ${subtitle}` : ''}`;
  return `<button class="${className}" data-song-id="${escapeHtml(songId)}" data-batch-id="${escapeHtml(batchId)}"${queueAttr}${queueIndex} ${selectable ? '' : 'disabled'} aria-label="${escapeHtml(label)}">
    <span class="ct-cover">${cover}<span class="ct-cover-play" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span></span>
    <span class="ct-meta">
      <span class="ct-title">${escapeHtml(title)}</span>
      <span class="ct-artist">${escapeHtml(subtitle)}</span>
    </span>
  </button>`;
}

function trackListHtml(tracks) {
  if (!Array.isArray(tracks) || !tracks.length) return '';
  return `<div class="chat-tracks">${tracks.map(buildTrackCardHtml).join('')}</div>`;
}

/**
 * 长回复的纯文本与段落：判定编辑式排版用。
 * 段按换行切、去空；字数只数非空白码点，空行/缩进不影响判定。
 * 拿不到文本（无 text 且无 segments）返回 null，由调用方回退气泡。
 */
function editorialPlainText({ text, segments } = {}) {
  if (typeof text === 'string' && text.trim()) return text;
  if (Array.isArray(segments)) {
    const joined = segments.map(segment => String(segment?.content ?? '')).join('\n');
    return joined.trim() ? joined : null;
  }
  return null;
}

/**
 * 编辑式排版判定：assistant 长纯文本回复改用无气泡底的阅读排版。
 * 规则：非空白字数 > 120，或段数 ≥ 2 且字数 > 80。
 * 用户消息与未知角色不走此分支。
 */
export function shouldRenderEditorial({ role, text, segments } = {}) {
  try {
    if (role !== 'assistant') return false;
    const plain = editorialPlainText({ text, segments });
    if (!plain) return false;
    const paragraphs = plain.split('\n').map(part => part.trim()).filter(Boolean);
    const charCount = [...paragraphs.join('')].length;
    return charCount > 120 || (paragraphs.length >= 2 && charCount > 80);
  } catch {
    return false;
  }
}

function editorialHtml(plainText, trailingHtml = '') {
  const paragraphs = plainText.split('\n').map(part => escapeHtml(part.trim())).filter(Boolean);
  // 段落一律同级：不设标题段/开场段，首段也不加粗、不放大、不换字体。
  // 编辑式排版只体现在容器形式上：无气泡底、左缘强调竖线、段间距。
  const bodyHtml = paragraphs.map(part => `<p>${part}</p>`).join('');
  // 卡片与时间留在容器内（CSS 的 .chat-editorial .chat-tracks / .chat-time 依赖这层嵌套）。
  return `<div class="chat-editorial" data-presentation="editorial">${bodyHtml}${trailingHtml}</div>`;
}

/**
 * 用户正文里的引用块（add-chat-message-quote）：只认开头连续的 `>` 行。
 * 引用是用户自己写进输入框的普通文本，所以这里只做排版，不做语义解释；
 * 助手正文不解析，免得模型的话被前端改排版。
 */
function userTextHtml(text) {
  const { quote, body } = splitLeadingQuote(text);
  const quoteHtml = quote.filter(line => line).map(line => `<p>${escapeHtml(line)}</p>`).join('');
  if (!quoteHtml) return `<div class="chat-text">${escapeHtml(text)}</div>`;
  const rest = body.trim();
  return `<blockquote class="chat-quote">${quoteHtml}</blockquote>${rest ? `<div class="chat-text">${escapeHtml(rest)}</div>` : ''}`;
}

function speakerLineHtml(speakerName, replyToName = '', hostsTrack = false, floorAsk = '') {
  const speaker = String(speakerName || '').trim();
  if (!speaker) return '';
  const reply = String(replyToName || '').trim();
  const replyHtml = reply ? `<span class="chat-speaker-reply">回复 ${escapeHtml(reply)}</span>` : '';
  const hostHtml = hostsTrack ? '<span class="chat-speaker-reply">主持这一首</span>' : '';
  // 交接时邀请者想请对方接的话题（typed ask）：伙伴之间没有用户看不到的话，所以标在被邀请者这一轮上。
  const ask = String(floorAsk || '').trim();
  const askHtml = reply && ask ? `<div class="chat-floor-ask">${escapeHtml(reply)} 想听你说：${escapeHtml(ask)}</div>` : '';
  return `<div class="chat-speaker"><span class="chat-speaker-signal" aria-hidden="true"></span><span class="chat-speaker-name">${escapeHtml(speaker)}</span>${replyHtml}${hostHtml}</div>${askHtml}`;
}

/**
 * 主持建议（add-group-companion-dialogue P2）：建议只是记录，确认按钮走既有的「设为当前伙伴」路由。
 * state 由调用方对照房间当前伙伴得出：pending 可确认；applied 已是当前伙伴；unavailable 对方已不在聊天里。
 */
export function hostSuggestionHtml(suggestion) {
  if (!suggestion?.toPersonId) return '';
  const name = escapeHtml(suggestion.targetName || suggestion.toPersonId);
  const reason = String(suggestion.reason || '').trim();
  const reasonHtml = reason ? `<span class="chat-host-reason">${escapeHtml(reason)}</span>` : '';
  if (suggestion.state === 'applied') {
    return `<div class="chat-host-suggestion" data-state="applied"><span class="chat-host-label">${name} 现在主持这个聊天</span></div>`;
  }
  if (suggestion.state === 'unavailable') {
    return `<div class="chat-host-suggestion" data-state="unavailable"><span class="chat-host-label">建议过让 ${name} 主持，${name} 已不在这个聊天</span></div>`;
  }
  return `<div class="chat-host-suggestion" data-state="pending"><span class="chat-host-label">建议以后由 ${name} 主持</span>${reasonHtml}`
    + `<button type="button" class="quiet-button chat-host-confirm" data-host-suggestion="${escapeHtml(suggestion.toPersonId)}" data-host-name="${name}" aria-label="确认以后由 ${name} 主持这个聊天">让 ${name} 主持</button>`
    + '<span class="chat-host-note" role="status" aria-live="polite"></span></div>';
}

// 推荐卡片的文案：只陈述推荐表的事实（已安排 ≠ 正在播放）。
export const RECOMMENDATION_COPY = Object.freeze({
  queued: '已排到这首之后',
  unavailable: '这首现在放不了',
  expired: '推荐已过期',
  notSource: '到这个聊天一起听时才能放',
});

/**
 * ambient 推荐卡片（add-ambient-music-recommendation）。state 由调用方对照推荐状态、过期时间与
 * 当前听歌来源得出：pending 可点；not-source 按钮仍可聚焦但不可用；queued/unavailable/expired 只有说明。
 */
export function musicRecommendationHtml(view) {
  if (!view?.turnId || !view.title) return '';
  const title = escapeHtml(String(view.title).replace(/[《》]/gu, ''));
  const artist = view.artist ? `<span class="chat-recommendation-artist">${escapeHtml(view.artist)}</span>` : '';
  const head = `<span class="chat-recommendation-title">《${title}》</span>${artist}`;
  const state = ['pending', 'not-source', 'queued', 'unavailable', 'expired'].includes(view.state) ? view.state : 'expired';
  if (state === 'pending' || state === 'not-source') {
    const blocked = state === 'not-source';
    return `<div class="chat-recommendation" data-state="${state}">${head}`
      + `<button type="button" class="quiet-button chat-recommendation-accept" data-recommendation-turn="${escapeHtml(view.turnId)}"`
      + `${blocked ? ' aria-disabled="true"' : ''} aria-label="把《${title}》排到这首之后">放这首</button>`
      + `<span class="chat-recommendation-note" role="status" aria-live="polite">${blocked ? RECOMMENDATION_COPY.notSource : ''}</span></div>`;
  }
  const copy = { queued: RECOMMENDATION_COPY.queued, unavailable: RECOMMENDATION_COPY.unavailable, expired: RECOMMENDATION_COPY.expired }[state];
  return `<div class="chat-recommendation" data-state="${state}">${head}<span class="chat-recommendation-note">${copy}</span></div>`;
}

export function buildChatMessageHtml({ text, segments, tracks, time = '', speakerName = '', replyToName = '', hostsTrack = false, floorAsk = '', role = null, hostSuggestion = null, musicRecommendation = null, webSources = null } = {}) {
  return `${messageBodyHtml({ text, segments, tracks, time, speakerName, replyToName, hostsTrack, floorAsk, role })}${hostSuggestionHtml(hostSuggestion)}${musicRecommendationHtml(musicRecommendation)}${role === 'assistant' ? webSourcesHtml(webSources) : ''}`;
}

function messageBodyHtml({ text, segments, tracks, time, speakerName, replyToName, hostsTrack, floorAsk, role }) {
  let content = '';
  if (Array.isArray(segments)) {
    content = segments.map(segment => {
      const typeClass = segment?.type ? ` chat-seg-${escapeHtml(segment.type)}` : '';
      return `<div class="chat-segment${typeClass}">${escapeHtml(segment?.content)}</div>`;
    }).join('');
  } else {
    content = role === 'user' ? userTextHtml(text) : `<div class="chat-text">${escapeHtml(text)}</div>`;
  }
  const speakerHtml = speakerLineHtml(speakerName, replyToName, hostsTrack, floorAsk);
  if (shouldRenderEditorial({ role, text, segments })) {
    // 编辑式排版不带气泡容器：卡片与时间随段落一起放进 .chat-editorial。
    const trailing = `${trackListHtml(tracks)}<div class="chat-time">${escapeHtml(time)}</div>`;
    return `${speakerHtml}${editorialHtml(editorialPlainText({ text, segments }), trailing)}`;
  }
  return `${speakerHtml}<div class="chat-bubble">${content}${trackListHtml(tracks)}<div class="chat-time">${escapeHtml(time)}</div></div>`;
}

export function parsePersistedChats(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed)
      .filter(([, html]) => typeof html === 'string')
      .map(([radiohostId, html]) => [radiohostId, html.replaceAll('chat-msg claudio', 'chat-msg assistant')]));
  } catch {
    return {};
  }
}
