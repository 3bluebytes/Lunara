import { splitLeadingQuote } from './chatQuote.js';
import { webSourcesHtml } from './webSources.js';
import { parseRoleplaySegments } from './roleplaySpeech.js';

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

function groupSegmentRuns(segments) {
  const runs = [];
  for (const segment of Array.isArray(segments) ? segments : []) {
    const type = segment?.type ? String(segment.type) : '';
    const content = String(segment?.content ?? '');
    if (!content.trim()) continue;
    const item = { type, content, inline: segment?.inline === true };
    if (item.inline && runs.length > 0) {
      runs.at(-1).push(item);
    } else {
      runs.push([item]);
    }
  }
  return runs;
}

function inlineSpanHtml(item) {
  const typeClass = item.type ? ` class="chat-seg-${escapeHtml(item.type)}"` : '';
  return `<span${typeClass}>${escapeHtml(item.content.trim())}</span>`;
}

export function voiceButtonHtml(voice, turnId, { playingVoice = false, loadingVoice = false, beats = null } = {}) {
  if (!voice?.canSynthesize || !turnId) return '';
  const hasBeatAudio = (Array.isArray(beats) && beats.some(beat => Boolean(beat?.audioUrl)))
    || (Array.isArray(voice?.beats) && voice.beats.some(beat => Boolean(beat?.audioUrl)));
  const hasAudio = Boolean(voice.audioUrl || voice.url || hasBeatAudio);
  const state = loadingVoice ? 'loading' : playingVoice ? 'playing' : hasAudio ? 'ready' : 'idle';
  const label = loadingVoice ? '正在合成…' : playingVoice ? '■ 停止' : hasAudio ? '▶ 重听' : '生成语音';
  const ariaLabel = loadingVoice ? '正在合成这段语音' : playingVoice ? '停止播放这段语音' : hasAudio ? '重听这段语音' : '生成并播放这段语音';
  const busyAttr = loadingVoice ? ' aria-busy="true"' : '';
  return `<div class="chat-voice-bar"><button type="button" class="quiet-button chat-voice-btn" data-voice-turn="${escapeHtml(turnId)}" data-voice-state="${state}" data-has-audio="${hasAudio ? '1' : '0'}" aria-pressed="${playingVoice && !loadingVoice ? 'true' : 'false'}"${busyAttr} aria-label="${escapeHtml(ariaLabel)}">${label}</button><span class="chat-voice-note" role="status" aria-live="polite"></span></div>`;
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

function beatInnerHtml(beat, { forceRoleplayClasses = true } = {}) {
  const action = typeof beat?.action === 'string' ? beat.action.trim() : '';
  const say = typeof beat?.say === 'string' ? beat.say.trim() : '';
  if (forceRoleplayClasses) {
    const actionHtml = action ? `<div class="roleplay-action">${escapeHtml(action)}</div>` : '';
    const speechHtml = (say || !action) ? `<div class="roleplay-speech">${escapeHtml(say)}</div>` : '';
    return `${actionHtml}${speechHtml}`;
  }
  return `<div class="chat-text">${escapeHtml(say)}</div>`;
}

function isMultiBeatMessage({ role, beats, beatProgress } = {}) {
  return role === 'assistant'
    && Array.isArray(beats)
    && (beats.length > 1 || (beats.length >= 1 && Number(beatProgress?.totalCount) > 1));
}

export function buildChatMessageHtml({ text, segments, beats = null, beatProgress = null, interactionMode = null, visibleBeatCount = null, activeBeatIndex = null, tracks, time = '', speakerName = '', replyToName = '', hostsTrack = false, floorAsk = '', role = null, hostSuggestion = null, musicRecommendation = null, webSources = null, voice = null, turnId = null, playingVoice = false, loadingVoice = false } = {}) {
  const body = messageBodyHtml({ text, segments, beats, beatProgress, interactionMode, visibleBeatCount, activeBeatIndex, tracks, time, speakerName, replyToName, hostsTrack, floorAsk, role, hostSuggestion, musicRecommendation, webSources, voice, turnId, playingVoice, loadingVoice });
  if (isMultiBeatMessage({ role, beats, beatProgress })) {
    return body;
  }
  return `${body}${hostSuggestionHtml(hostSuggestion)}${musicRecommendationHtml(musicRecommendation)}${role === 'assistant' ? webSourcesHtml(webSources) : ''}`;
}

function messageBodyHtml({ text, segments, beats, beatProgress, interactionMode, visibleBeatCount, activeBeatIndex, tracks, time, speakerName, replyToName, hostsTrack, floorAsk, role, hostSuggestion, musicRecommendation, webSources, voice, turnId, playingVoice, loadingVoice }) {
  const speakerHtml = speakerLineHtml(speakerName, replyToName, hostsTrack, floorAsk);
  const voiceHtml = role === 'assistant' ? voiceButtonHtml(voice, turnId, { playingVoice, loadingVoice, beats }) : '';

  if (isMultiBeatMessage({ role, beats, beatProgress })) {
    let deliveredBeats = beats;
    if (beatProgress && !beatProgress.done && Number.isFinite(Number(beatProgress.deliveredCount))) {
      deliveredBeats = beats.slice(0, Math.max(1, Math.floor(Number(beatProgress.deliveredCount))));
    }
    const shownBeats = Number.isFinite(Number(visibleBeatCount)) && Number(visibleBeatCount) > 0
      ? deliveredBeats.slice(0, Math.max(1, Math.floor(Number(visibleBeatCount))))
      : deliveredBeats;
    const trailingHtml = `${trackListHtml(tracks)}${hostSuggestionHtml(hostSuggestion)}${musicRecommendationHtml(musicRecommendation)}${webSourcesHtml(webSources)}<div class="chat-time">${escapeHtml(time)}</div>${voiceHtml}`;
    const bubblesHtml = shownBeats.map((beat, idx) => {
      const beatIdx = Number.isInteger(beat?.index) ? beat.index : idx;
      const isFirst = idx === 0;
      const isLast = idx === shownBeats.length - 1;
      const isMiddle = !isFirst && !isLast;
      const isSpeaking = Number.isInteger(activeBeatIndex) && activeBeatIndex === beatIdx;
      const classes = [
        'chat-beat-bubble',
        isFirst ? 'is-first' : '',
        isMiddle ? 'is-middle' : '',
        isLast ? 'is-last' : '',
        isSpeaking ? 'is-speaking' : '',
      ].filter(Boolean).join(' ');
      return `<div class="${classes}" data-beat-index="${escapeHtml(beatIdx)}"${isSpeaking ? ' data-speaking="1"' : ''}>`
        + `${beatInnerHtml(beat, { forceRoleplayClasses: true })}`
        + `${isLast ? trailingHtml : ''}`
        + '</div>';
    }).join('');
    const pendingAttr = beatProgress && !beatProgress.done ? ' data-beat-pending="1"' : '';
    const turnAttr = turnId ? ` data-turn-id="${escapeHtml(turnId)}"` : '';
    return `${speakerHtml}<div class="chat-beat-group"${turnAttr}${pendingAttr}>${bubblesHtml}</div>`;
  }

  let effectiveSegments = segments;
  if (role === 'assistant' && (!Array.isArray(beats) || !beats.length) && !Array.isArray(effectiveSegments)
    && interactionMode === 'roleplay' && typeof text === 'string' && text.trim()) {
    const parsed = parseRoleplaySegments(text);
    if (parsed.hasAction && parsed.segments.length) effectiveSegments = parsed.segments;
  }

  if (role === 'assistant' && Array.isArray(beats) && beats.length === 1) {
    const beat = (beats[0]?.say || beats[0]?.action || typeof text !== 'string' || !text.trim())
      ? beats[0]
      : { ...beats[0], say: text };
    const content = beatInnerHtml(beat, { forceRoleplayClasses: Boolean(beat?.action || interactionMode === 'roleplay') });
    return `${speakerHtml}<div class="chat-bubble">${content}${trackListHtml(tracks)}<div class="chat-time">${escapeHtml(time)}</div>${voiceHtml}</div>`;
  }

  let content = '';
  if (Array.isArray(effectiveSegments)) {
    content = groupSegmentRuns(effectiveSegments).map(run => {
      if (run.length > 1) {
        return `<div class="chat-segment chat-seg-mixed">${run.map(inlineSpanHtml).join('')}</div>`;
      }
      const segment = run[0];
      const typeClass = segment.type ? ` chat-seg-${escapeHtml(segment.type)}` : '';
      return `<div class="chat-segment${typeClass}">${escapeHtml(segment.content)}</div>`;
    }).join('');
  } else {
    content = role === 'user' ? userTextHtml(text) : `<div class="chat-text">${escapeHtml(text)}</div>`;
  }
  return `${speakerHtml}<div class="chat-bubble">${content}${trackListHtml(tracks)}<div class="chat-time">${escapeHtml(time)}</div>${voiceHtml}</div>`;
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
