// Query lookup is not recording equivalence: retrieve an existing collection reference,
// preserve version qualifiers, and refuse multiple native identities.
export function collectionOrigin(track) {
  const origin = String(track?.collectionOrigin || track?.candidateOrigin || track?.source || '');
  return /^[a-z]+:(?:liked|playlist|library)(?::|$)/.test(origin) ? origin : '';
}
export function collectionPriority(track) {
  if (!collectionOrigin(track)) return 0;
  return track.collectionKind === 'liked' || /:liked(?::|$)/.test(collectionOrigin(track)) ? 2 : 1;
}
const normalize = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
export function findCollectionMatch(query, tracks = [], { sources = null } = {}) {
  const text = normalize(query);
  const matches = new Map();
  if (!text) return { status: 'none', track: null };
  for (const row of tracks) {
    if (!collectionOrigin(row)) continue;
    const provider = String(row.provider || row.source || '').split(':')[0];
    const songId = String(row.song_id ?? row.songId ?? '');
    if (!provider || !songId || (sources && !sources.includes(provider))) continue;
    const title = normalize(row.title), artist = normalize(row.artist);
    if (!title || !artist) continue;
    const forms = [title, `${artist} ${title}`, `${title} ${artist}`];
    for (const sep of [' — ', ' - ', ' – ']) forms.push(`${artist}${sep}${title}`, `${title}${sep}${artist}`);
    if (!forms.includes(text)) continue;
    matches.set(`${provider}:${songId}`, { ...row, provider, song_id: songId });
  }
  const all = [...matches.values()];
  // A title-only homonym remains ambiguous even if one artist's version is liked.
  if (new Set(all.map(row => normalize(row.artist))).size > 1) return { status: 'ambiguous', track: null };
  const priority = Math.max(0, ...all.map(collectionPriority));
  const rows = all.filter(row => collectionPriority(row) === priority);
  return rows.length === 1 ? { status: 'matched', track: rows[0] }
    : { status: rows.length ? 'ambiguous' : 'none', track: null };
}
