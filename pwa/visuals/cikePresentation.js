// Read-only presentation helpers. No storage, player cursor or network ownership.
const PARTNER_COLORS = Object.freeze(['#d9b8d6', '#b9d3a6', '#d9b79b', '#a8c8d8', '#d6c891', '#c1b9e2']);
// 返回 CSS 颜色值：伙伴落在固定的色板槽位，颜色本身由当前主题的 --partner-N 决定，
// 主题没声明时回落到原来的颜色。
export function colorFor(personId) {
  if (!personId || personId === 'lunara') return 'var(--partner-lunara, #cfd6e6)';
  let hash = 2166136261;
  for (const char of String(personId)) hash = Math.imul(hash ^ char.codePointAt(0), 16777619) >>> 0;
  const slot = hash % PARTNER_COLORS.length;
  return `var(--partner-${slot + 1}, ${PARTNER_COLORS[slot]})`;
}
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function identityDots(ids = [], liveId = null) {
  return `<span class="identity-dots" aria-hidden="true">${[...new Set(ids)].map(id => `<span class="identity-dot${id === liveId ? ' is-live' : ''}" data-person-id="${esc(id)}" style="--person-color:${colorFor(id)}"></span>`).join('')}</span>`;
}
export function wallTime(value = Date.now()) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}` : '';
}
export function dateLabel(value) {
  if (value == null || value === '') return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.getFullYear()}.${String(date.getMonth()+1).padStart(2,'0')}.${String(date.getDate()).padStart(2,'0')}` : '';
}
export function acquaintanceDays(createdAt, now = Date.now()) {
  if (createdAt == null || createdAt === '') return null;
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created) || created > now) return null;
  return Math.floor((now - created) / 86400000) + 1;
}
export function queueEstimates(queue = [], currentIndex = -1, positionSeconds = 0, now = Date.now()) {
  const result = new Map();
  if (currentIndex < 0 || !queue[currentIndex]) return result;
  let at = now;
  for (let i = currentIndex; i < queue.length - 1; i++) {
    const duration = Number(queue[i].durationSeconds ?? queue[i].duration);
    if (!(duration > 0)) break;
    at += Math.max(0, duration - (i === currentIndex ? Number(positionSeconds) || 0 : 0)) * 1000;
    if (queue[i+1].queueItemId) result.set(queue[i+1].queueItemId, at);
  }
  return result;
}
// 排版宽度代理，不改标题原文，也不参与音乐身份或选择。
export function trackTitleSize(title) {
  let units = 0;
  for (const char of String(title ?? '')) {
    units += /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char) ? 2 : 1;
  }
  return units > 72 ? 'extra-long' : units > 28 ? 'long' : 'normal';
}

export function lyricGap(lines = [], position = 0) {
  const timed = lines.filter(line => Number.isFinite(line.time) && line.time >= 0);
  const next = timed.find(line => line.time > position);
  const previous = [...timed].reverse().find(line => line.time <= position);
  if (!next || next.time - position < 8 || (previous && position - previous.time < 10)) return null;
  return Math.ceil(next.time - position);
}
export function deliveredTime(track, turns = []) {
  const id = track?.queueItemId;
  if (!id) return '';
  const turn = [...turns].reverse().find(t => t.role === 'assistant' && (t.turnId === `intro:${id}` || (t.presentation === 'track_intro' && (t.queueItemId || t.tracks?.[0]?.queueItemId) === id)));
  return turn?.createdAt != null ? wallTime(turn.createdAt) : '';
}
