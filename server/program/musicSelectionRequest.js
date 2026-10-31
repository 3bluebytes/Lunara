import { validateJsonSchema } from '../virtual-person/jsonSchemaValidator.js';
import { createHash } from 'node:crypto';
import { CONTINUATION_BATCH_SIZE } from './continuationBudget.js';
import { providerRegistry } from '../music/providerRegistry.js';

export const MUSIC_CAPABILITY = 'music';
export const MUSIC_MUTATION_CAPABILITY = 'music.commit';
export const TAG_FILTER_PROPERTIES = {
  language: { type: 'string' }, gender: { type: 'string', enum: ['male', 'female'] }, genre: { type: 'string' },
  mood: { type: 'string' }, tempo: { type: 'string', enum: ['slow', 'mid', 'fast'] }, has_vocal: { type: 'boolean' },
  minYear: { type: 'number' }, maxYear: { type: 'number' }, minEnergy: { type: 'number' }, maxEnergy: { type: 'number' },
  minValence: { type: 'number' }, maxValence: { type: 'number' }, artistGenre: { type: 'string' }, region: { type: 'string' },
  vocal_state: { type: 'string', enum: ['instrumental'] },
  themes: { type: 'array', items: { type: 'string' } }, instruments: { type: 'array', items: { type: 'string' } },
};
// mode/delivery 不做 JSON schema 级必填：自动任务里 select_music 可以传 `{}`（参数会被
// 锁定请求取代）；对话路径缺少它们时由 normalizeMusicSelection 的显式检查给出可纠正的
// TypeError，再被工具层转成 typed 失败。
export const MUSIC_SELECTION_PARAMETERS = {
  type: 'object', additionalProperties: false,
  properties: {
    mode: { type: 'string', enum: ['exact', 'artist', 'playlist', 'album', 'constrained', 'discovery'] },
    delivery: { type: 'string', enum: ['replace_now', 'after_current', 'append', 'recommend_only'] },
    count: { type: 'integer', minimum: 1, maximum: 10 },
    targets: { type: 'array', maxItems: 10, items: { type: 'object', required: ['title'], additionalProperties: false,
      properties: { title: { type: 'string' }, artist: { type: 'string' }, songId: { type: 'string' }, source: { type: 'string' } } } },
    reference: { type: 'object', additionalProperties: false, required: ['selectionId', 'indexes'], properties: {
      selectionId: { type: 'string' }, indexes: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 10 } },
    } },
    artist: { type: 'string' },
    playlist: { type: 'object', required: ['source', 'playlistId'], additionalProperties: false,
      properties: { source: { type: 'string', enum: providerRegistry.defaultSourceCandidates() }, playlistId: { type: 'string' } } },
    // 整张专辑（add-album-sequencing）：稳定引用，不展开成逐个 targets。
    album: { type: 'object', required: ['source', 'albumId'], additionalProperties: false,
      properties: { source: { type: 'string', enum: providerRegistry.defaultSourceCandidates() }, albumId: { type: 'string' } } },
    constraints: { type: 'object', additionalProperties: false, properties: {
      tags: { type: 'object', additionalProperties: false, properties: TAG_FILTER_PROPERTIES },
      excludeVersions: { type: 'array', items: { type: 'string', enum: ['live', 'remix', 'cover', 'instrumental'] } },
      requiredVersion: { type: 'string', enum: ['live', 'remix', 'studio', 'instrumental'] },
      excludedSongIds: { type: 'array', maxItems: 100, items: { type: 'string' } },
      excludedArtists: { type: 'array', maxItems: 20, items: { type: 'string' } },
    } },
    softPreferences: { type: 'string', description: '本轮氛围与当前角色审美参考，不能用于放宽 constraints。' },
    preferredArtists: { type: 'array', maxItems: 10, items: { type: 'string' },
      description: '软歌手偏好：只影响候选排序，不过滤候选、不放宽 constraints；只取前 5 个。' },
    continueMode: { type: 'string', enum: ['same', 'off'] },
  },
};

function text(value, max = 200) { return String(value || '').trim().slice(0, max); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

/** 歌手名匹配口径：大小写不敏感的包含匹配。硬过滤与软偏好共用同一实现，避免两处漂移。 */
export function artistMatchesRequest(trackArtist, artist) {
  const name = text(artist, 80).toLowerCase();
  return Boolean(name) && String(trackArtist || '').toLowerCase().includes(name);
}

export function normalizeMusicSelection(input = {}) {
  // Internal normalized requests use null for absent fields; all supplied values remain strict.
  const compact = value => Array.isArray(value) ? value.map(compact) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([, item]) => item != null).map(([key, item]) => [key, compact(item)])) : value;
  const validation = validateJsonSchema(compact(input), MUSIC_SELECTION_PARAMETERS);
  if (!validation.valid) throw new TypeError(validation.errors.join('; '));
  const mode = text(input.mode);
  if (!['exact', 'artist', 'playlist', 'album', 'constrained', 'discovery'].includes(mode)) throw new TypeError('明确指定选歌模式');
  if (!['replace_now', 'after_current', 'append', 'recommend_only'].includes(input.delivery)) throw new TypeError('明确指定播放时机');
  const constraints = input.constraints || {};
  if (Object.keys(constraints).some(key => !['tags', 'excludeVersions', 'requiredVersion', 'excludedSongIds', 'excludedArtists'].includes(key))
    || Object.keys(constraints.tags || {}).some(key => !Object.hasOwn(TAG_FILTER_PROPERTIES, key))) throw new TypeError('不支持的硬约束，不能忽略');
  const targets = (input.targets || []).slice(0, 10).map(item => ({ title: text(item.title), artist: text(item.artist),
    songId: text(item.songId), source: text(item.source) }));
  if (targets.some(item => !item.title)) throw new TypeError('点播目标缺少歌名');
  if (mode === 'exact' && !targets.length && !input.reference) throw new TypeError('点播需要目标或已确认的歌曲引用');
  if (mode === 'artist' && !text(input.artist)) throw new TypeError('指定歌手模式需要歌手');
  if (mode === 'playlist' && (!providerRegistry.isPlayable(input.playlist?.source) || !text(input.playlist?.playlistId))) throw new TypeError('歌单需要音乐源和稳定 ID');
  // 整张专辑只能靠稳定引用：缺源或缺 ID 一律可纠正地失败，不靠标题猜是哪张。
  if (input.album != null && (!providerRegistry.isPlayable(input.album?.source) || !text(input.album?.albumId))) {
    throw new TypeError('整张专辑需要音乐源和专辑 ID');
  }
  if (mode === 'album' && !input.album) throw new TypeError('整张专辑需要音乐源和专辑 ID');
  if (mode === 'album' && targets.length) throw new TypeError('整张专辑不需要逐个点歌，去掉 targets');
  for (const key of ['excludeVersions', 'excludedSongIds', 'excludedArtists']) if (constraints[key] && !Array.isArray(constraints[key])) throw new TypeError(`${key} requires an array`);
  const versions = constraints.excludeVersions || [];
  if (versions.some(value => !['live', 'remix', 'cover', 'instrumental'].includes(value))) throw new TypeError('不支持的版本约束');
  if (constraints.requiredVersion && !['live', 'remix', 'studio', 'instrumental'].includes(constraints.requiredVersion)) throw new TypeError('不支持的版本约束');
  if (constraints.requiredVersion && versions.includes(constraints.requiredVersion)) throw new TypeError('版本条件互相冲突');
  for (const [min, max] of [['minYear', 'maxYear'], ['minEnergy', 'maxEnergy'], ['minValence', 'maxValence']]) {
    if (constraints.tags?.[min] != null && constraints.tags?.[max] != null && constraints.tags[min] > constraints.tags[max]) throw new TypeError('标签范围互相冲突');
  }
  const result = { mode, delivery: input.delivery, count: Math.min(10, Math.max(1, Number.parseInt(input.count, 10) || targets.length || 2)),
    targets, artist: text(input.artist), playlist: mode === 'playlist' ? { source: input.playlist.source, playlistId: text(input.playlist.playlistId) } : null,
    album: input.album ? { source: text(input.album.source, 40), albumId: text(input.album.albumId) } : null,
    constraints: { tags: { ...(constraints.tags || {}) }, excludeVersions: [...new Set(versions)].sort(),
      requiredVersion: constraints.requiredVersion || null, excludedSongIds: [...new Set((constraints.excludedSongIds || []).map(String))].sort(),
      excludedArtists: [...new Set((constraints.excludedArtists || []).map(value => text(value)).filter(Boolean))].sort() },
    softPreferences: text(input.softPreferences, 1000), continueMode: input.continueMode === 'off' ? 'off' : 'same',
    preferredArtists: [...new Set((input.preferredArtists || []).map(value => text(value, 80)).filter(Boolean))].slice(0, 5),
    reference: input.reference ? { selectionId: text(input.reference.selectionId), indexes: (input.reference.indexes || []).map(Number) } : null };
  return Object.freeze(result);
}

export function selectionSignature(request, context) {
  const { delivery: _delivery, continueMode: _continueMode, ...selection } = request;
  return createHash('sha256').update(JSON.stringify(stable({ request: selection,
    conversationId: context.sessionId, personId: context.virtualPersonId,
    memoryRevision: context.memoryRevision || 0, membershipRevision: context.membershipRevision || 0,
    libraryRevision: context.libraryRevision || 0, sharedRevision: context.sharedRevision || 0,
  }))).digest('hex');
}

export function continuationSelection(request, { previousTrack = null } = {}) {
  const source = normalizeMusicSelection(request);
  // 锚点按计划自身的 artist → 刚播完那一首 → 第一个 target 依次回退。
  const anchor = text(source.artist, 80) || text(previousTrack?.artist, 80) || text(source.targets[0]?.artist, 80);
  // 续播只表达软偏好：一次点播的歌手可以被加权，但不会变成“此后只放这位”的硬约束，
  // 也就不会随提交写回 plan 而自我固化。歌单与整专续播保持原 mode，继续沿同一歌单/专辑往后取。
  const preferredArtists = source.mode === 'playlist' || source.mode === 'album' || !anchor
    ? source.preferredArtists
    : [...new Set([anchor, ...source.preferredArtists])].slice(0, 5);
  const mode = source.mode === 'exact' || source.mode === 'artist' ? 'discovery' : source.mode;
  return normalizeMusicSelection({ ...source, mode, artist: '', targets: [], reference: null,
    preferredArtists, count: CONTINUATION_BATCH_SIZE, delivery: 'append' });
}
