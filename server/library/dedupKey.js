// Fuzzy association key shared by the candidate pool and persistent library.
// It is deliberately non-unique: provider-native identity remains authoritative.
function normalizePart(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s()（）\[\]【】«»"'·\-–—,，.。/\\:;]/g, '');
}

export function dedupKey(titleOrTrack, artist) {
  const title = typeof titleOrTrack === 'object' ? titleOrTrack?.title : titleOrTrack;
  const performer = typeof titleOrTrack === 'object' ? titleOrTrack?.artist : artist;
  return `${normalizePart(title)}|${normalizePart(performer)}`;
}
