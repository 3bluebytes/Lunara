import { matchesTags, hasAnyTagFilter } from '../songtags/songTagRetrieval.js';
import { artistMatchesRequest } from './musicSelectionRequest.js';

const LANGUAGE_RULES = Object.freeze([
  { pattern: /粤语|广东话|cantonese/i, accepted: ['粤语', 'cantonese', 'yue'], label: '粤语' },
  { pattern: /国语|普通话|mandarin/i, accepted: ['国语', '普通话', 'mandarin', 'zh'], label: '国语' },
  { pattern: /英语|英文|english/i, accepted: ['英语', '英文', 'english', 'en'], label: '英语' },
]);

const GENDER_RULES = Object.freeze([
  { pattern: /女声|女歌手|female/i, accepted: ['female', '女', '女性'], label: '女声' },
  { pattern: /男声|男歌手|male/i, accepted: ['male', '男', '男性'], label: '男声' },
]);

function normalized(value) {
  return String(value || '').trim().toLowerCase();
}

function matches(value, accepted) {
  const text = normalized(value);
  return accepted.some(item => text === item || text.includes(item));
}

export function requestedTrackCount(text, fallback) {
  const input = String(text || '');
  const chinese = input.match(/([一二两三四五六七八九十])首/);
  const arabic = input.match(/(\d{1,2})\s*首/);
  const map = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const count = arabic ? Number(arabic[1]) : chinese ? map[chinese[1]] : Number(fallback);
  return Number.isInteger(count) && count > 0 ? Math.min(count, 10) : Math.max(1, Number(fallback) || 1);
}

export function validateResolvedTrackAgainstRequest(track, { request = null, requestText = '', songTagStore = null } = {}) {
  if (request) return validateSelectionConstraints(track, request, songTagStore);
  const languageRule = LANGUAGE_RULES.find(rule => rule.pattern.test(requestText));
  const genderRule = GENDER_RULES.find(rule => rule.pattern.test(requestText));
  if (!languageRule && !genderRule) return { ok: true, evidence: {} };

  const tags = songTagStore?.getTags?.(track.songId, track.source) || null;
  const artistTags = tags?.artist_key
    ? songTagStore?.getArtistTags?.(tags.artist_key) || null
    : null;
  const failures = [];
  if (languageRule && !matches(tags?.language, languageRule.accepted)) {
    failures.push(tags?.language ? `language:${tags.language}` : `language:${languageRule.label}:unverified`);
  }
  if (genderRule && !matches(artistTags?.gender, genderRule.accepted)) {
    failures.push(artistTags?.gender ? `gender:${artistTags.gender}` : `gender:${genderRule.label}:unverified`);
  }
  return {
    ok: failures.length === 0,
    evidence: {
      requestedLanguage: languageRule?.label || null,
      requestedVocalGender: genderRule?.label || null,
      canonicalLanguage: tags?.language || null,
      canonicalArtistGender: artistTags?.gender || null,
      failures,
    },
  };
}


const VERSION_MARKERS = {
  live: /\blive\b|现场|演唱会|演唱會|音乐会/iu,
  remix: /\bremix\b|混音|重混/iu,
  cover: /\bcover\b|翻唱/iu,
  instrumental: /\binstrumental\b|伴奏|纯音乐/iu,
  studio: /\bstudio\b|录音室|錄音室/iu,
};
export function validateSelectionConstraints(track, request, store) {
  const constraints = request.constraints || {};
  const failures = [];
  if (hasAnyTagFilter(constraints.tags) && !matchesTags({ ...track, song_id: track.songId || track.song_id }, constraints.tags, store)) failures.push('unverified-tags');
  const versionText = `${track.title || ''} ${track.album || ''} ${track.version || ''}`;
  for (const version of constraints.excludeVersions || []) if (VERSION_MARKERS[version]?.test(versionText)) failures.push(`excluded-version:${version}`);
  if (constraints.requiredVersion && !VERSION_MARKERS[constraints.requiredVersion]?.test(versionText)) failures.push(`unverified-version:${constraints.requiredVersion}`);
  if ((constraints.excludedSongIds || []).includes(String(track.songId || track.song_id))) failures.push('excluded-song');
  const creditedArtists = String(track.artist || '').toLocaleLowerCase().split(/\s*(?:[,，、/|&;；]|\b(?:feat\.?|ft\.?)\b)\s*/iu).map(value => value.trim());
  if ((constraints.excludedArtists || []).some(artist => creditedArtists.includes(String(artist).trim().toLocaleLowerCase()))) {
    failures.push('excluded-artist');
  }
  if (request.artist && !artistMatchesRequest(track.artist, request.artist)) failures.push('artist-mismatch');
  return { ok: !failures.length, evidence: { constraints, failures } };
}
