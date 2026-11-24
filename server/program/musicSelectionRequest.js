import { validateJsonSchema } from '../virtual-person/jsonSchemaValidator.js';
import { createHash } from 'node:crypto';
import { CONTINUATION_BATCH_SIZE } from './continuationBudget.js';
import { providerRegistry } from '../music/providerRegistry.js';

export const MUSIC_CAPABILITY = 'music';
export const MUSIC_MUTATION_CAPABILITY = 'music.commit';
export const HARD_TAG_FILTER_PROPERTIES = {
  language: { type: 'string' },
  gender: { type: 'string', enum: ['male', 'female'] },
  has_vocal: { type: 'boolean' },
  vocal_state: { type: 'string', enum: ['instrumental'] },
  minYear: { type: 'number' },
  maxYear: { type: 'number' },
  region: { type: 'string' },
};

export const TAG_FILTER_PROPERTIES = {
  ...HARD_TAG_FILTER_PROPERTIES,
  genre: { type: 'string' },
  mood: { type: 'string' },
  tempo: { type: 'string', enum: ['slow', 'mid', 'fast'] },
  minEnergy: { type: 'number' },
  maxEnergy: { type: 'number' },
  minValence: { type: 'number' },
  maxValence: { type: 'number' },
  artistGenre: { type: 'string' },
  themes: { type: 'array', items: { type: 'string' } },
  instruments: { type: 'array', items: { type: 'string' } },
};

function buildSelectionParameters({ tagProperties, tagsDescription = '', softPreferencesDescription }) {
  return {
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
        tags: {
          type: 'object',
          additionalProperties: false,
          ...(tagsDescription ? { description: tagsDescription } : {}),
          properties: tagProperties,
        },
        excludeVersions: { type: 'array', items: { type: 'string', enum: ['live', 'remix', 'cover', 'instrumental'] } },
        requiredVersion: { type: 'string', enum: ['live', 'remix', 'studio', 'instrumental'] },
        excludedSongIds: { type: 'array', maxItems: 100, items: { type: 'string' } },
        excludedArtists: { type: 'array', maxItems: 20, items: { type: 'string' } },
      } },
      softPreferences: { type: 'string', description: softPreferencesDescription },
      preferredArtists: { type: 'array', maxItems: 10, items: { type: 'string' },
        description: '软歌手偏好：只影响候选排序，不过滤候选、不放宽 constraints；只取前 5 个。' },
      continueMode: { type: 'string', enum: ['same', 'off'] },
    },
  };
}

// mode/delivery 不做 JSON schema 级必填：自动任务里 select_music 可以传 `{}`（参数会被
// 锁定请求取代）；对话路径缺少它们时由 normalizeMusicSelection 的显式检查给出可纠正的
// TypeError，再被工具层转成 typed 失败。
export const MUSIC_SELECTION_PARAMETERS = buildSelectionParameters({
  tagProperties: TAG_FILTER_PROPERTIES,
  softPreferencesDescription: '本轮氛围与当前角色审美参考，不能用于放宽 constraints。',
});

export const SELECT_MUSIC_PARAMETERS = buildSelectionParameters({
  tagProperties: HARD_TAG_FILTER_PROPERTIES,
  tagsDescription: '客观排他硬标签（仅限语种、男女声、人声/纯音乐、发行年代、歌手地区）；曲风、情绪、快慢、能量与配器请放 softPreferences。',
  softPreferencesDescription: '曲风流派（如 jazz/爵士、R&B、民谣）、情绪氛围（浪漫、慵懒、微醺）、快慢节奏、配器与角色审美参考：对已打标歌曲加权排前，同时保留未打标歌曲供你在候选窗口里凭自身理解挑选；不放宽客观 constraints。',
});

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

const TEMPO_SOFT_LABELS = Object.freeze({ slow: '慢歌', mid: '中速', fast: '快歌' });

function extractVibeSoftTerms(tags = {}) {
  if (!tags || typeof tags !== 'object') return [];
  const terms = [];
  const push = raw => {
    const val = text(raw, 80);
    if (val && !terms.some(existing => existing.toLowerCase() === val.toLowerCase())) terms.push(val);
  };
  push(tags.genre);
  push(tags.artistGenre);
  push(tags.mood);
  if (tags.tempo && TEMPO_SOFT_LABELS[tags.tempo]) push(TEMPO_SOFT_LABELS[tags.tempo]);
  if (tags.maxEnergy != null && Number.isFinite(Number(tags.maxEnergy)) && Number(tags.maxEnergy) <= 0.45) push('轻柔');
  if (tags.minEnergy != null && Number.isFinite(Number(tags.minEnergy)) && Number(tags.minEnergy) >= 0.65) push('动感');
  if (tags.minValence != null && Number.isFinite(Number(tags.minValence)) && Number(tags.minValence) >= 0.55) push('温暖');
  if (tags.maxValence != null && Number.isFinite(Number(tags.maxValence)) && Number(tags.maxValence) <= 0.42) push('伤感');
  for (const key of ['themes', 'instruments']) {
    const list = Array.isArray(tags[key]) ? tags[key] : tags[key] != null ? [tags[key]] : [];
    for (const item of list) push(item);
  }
  return terms;
}

function mergeSoftPreferences(existing, extraTerms = []) {
  const base = text(existing, 1000);
  const baseLower = base.toLowerCase();
  const added = extraTerms.filter(term => term && !baseLower.includes(term.toLowerCase()));
  if (!added.length) return base;
  return base ? `${base}；${added.join('、')}` : added.join('、');
}

function hasHardConstraints(constraints = {}) {
  const tags = constraints.tags || {};
  if (Object.values(tags).some(val => val != null && val !== '' && (!Array.isArray(val) || val.length > 0))) return true;
  if (constraints.requiredVersion) return true;
  return ['excludeVersions', 'excludedSongIds', 'excludedArtists']
    .some(key => Array.isArray(constraints[key]) && constraints[key].length > 0);
}

export function continuationSelection(request, { previousTrack = null } = {}) {
  const source = normalizeMusicSelection(request);
  // 锚点按计划自身的 artist → 刚播完那一首 → 第一个 target 依次回退。
  const anchor = text(source.artist, 80) || text(previousTrack?.artist, 80) || text(source.targets[0]?.artist, 80);
  // 续播只表达软偏好：一次点播的歌手与主观氛围标签可以被加权，但不会变成“此后只放这些”的硬约束，
  // 也就不会随提交写回 plan 而自我固化。歌单与整专续播保持原 mode，继续沿同一歌单/专辑往后取。
  const preferredArtists = source.mode === 'playlist' || source.mode === 'album' || !anchor
    ? source.preferredArtists
    : [...new Set([anchor, ...source.preferredArtists])].slice(0, 5);
  const rawTags = source.constraints?.tags || {};
  const nextTags = Object.fromEntries(
    Object.entries(rawTags).filter(([key]) => Object.hasOwn(HARD_TAG_FILTER_PROPERTIES, key)),
  );
  const nextConstraints = { ...source.constraints, tags: nextTags };
  const softPreferences = mergeSoftPreferences(source.softPreferences, extractVibeSoftTerms(rawTags));
  const mode = source.mode === 'exact' || source.mode === 'artist'
    || (source.mode === 'constrained' && !hasHardConstraints(nextConstraints))
    ? 'discovery'
    : source.mode;
  return normalizeMusicSelection({ ...source, mode, artist: '', targets: [], reference: null,
    constraints: nextConstraints, softPreferences, preferredArtists,
    count: CONTINUATION_BATCH_SIZE, delivery: 'append' });
}

/**
 * 续播提交后存回 runtime 的计划：同样的续播归一，但不带“刚播完那一首”的锚点。
 * 锚点只服务这一轮排序；存回去的话，下个边界会把新锚点叠在旧锚点前面，
 * 几轮之后偏好歌手就成了最近放过的五位，选歌越续越窄。
 * 对自身幂等：continuationPlan(continuationPlan(x)) 与 continuationPlan(x) 相同。
 */
export function continuationPlan(request) {
  return continuationSelection(request);
}
