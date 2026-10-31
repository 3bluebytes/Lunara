// VoiceProfile.js — Type definition and builder for TTS voice profiles
//
// VoiceProfile describes a sound model voice (e.g. "电台男主播" from MiniMax),
// which serves as the foundation for creating a RadioHost.
// This is NOT related to music playback sources.

import { randomUUID } from 'node:crypto';

/**
 * Create a VoiceProfile instance.
 * @param {object} data
 * @param {string} data.sourceProvider - e.g. 'minimax', 'custom'
 * @param {string} data.sourceVoiceId - Original voice ID from the TTS platform
 * @param {string} data.displayName - Human-readable name
 * @param {string} [data.description]
 * @param {string} [data.gender]
 * @param {string[]} [data.styleTags]
 * @param {string} [data.previewUrl]
 * @param {object} [data.techParams] - TTS-specific params (speed, pitch, etc.)
 * @returns {object} VoiceProfile
 */
export function createVoiceProfile(data) {
  return {
    id: data.id || `vp_${randomUUID().slice(0, 8)}`,
    sourceProvider: String(data.sourceProvider || 'minimax'),
    sourceVoiceId: String(data.sourceVoiceId || ''),
    displayName: String(data.displayName || ''),
    description: String(data.description || ''),
    gender: data.gender || null,
    styleTags: Array.isArray(data.styleTags) ? data.styleTags : deriveStyleTags(data.displayName, data.description),
    previewUrl: data.previewUrl || null,
    techParams: data.techParams || {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Derive style tags from voice display name and description.
 * @param {string} name
 * @param {string} desc
 * @returns {string[]}
 */
export function deriveStyleTags(name, desc) {
  const tags = new Set();
  const text = `${name || ''} ${desc || ''}`.toLowerCase();

  if (/男/.test(text)) tags.add('male');
  if (/女/.test(text)) tags.add('female');
  if (/甜|暖/.test(text)) tags.add('warm');
  if (/冷|成熟/.test(text)) tags.add('mature');
  if (/电台|播报|新闻/.test(text)) tags.add('broadcast');
  if (/深夜|抒情|温润/.test(text)) tags.add('gentle');
  if (/温柔|少女|清新/.test(text)) tags.add('soft');
  if (/少年/.test(text)) tags.add('youthful');
  if (/机械|金属/.test(text)) tags.add('robotic');

  if (tags.size === 0) tags.add('neutral');
  return [...tags];
}
