// providerRegistry.js — 音乐源的唯一声明处。
//
// 在这之前，「一个音乐源是什么」散在 15+ 处硬编码白名单里（settingsService、
// musicResolver、musicTools、songTagTools、library/*、candidates、authRoutes…）。
// 漏改一处的表现不是崩溃，而是静默忽略：标签不写、曲库不同步、歌单不显示。
//
// 这个模块只做**声明**，不做统一接口适配层：各 provider 的函数签名确实不同
// （qq.playlistAllTracks(disstid, {limit}) vs ncm.playlistAllTracks(id, {limit, offset})），
// 强行抽象会新增一个「行为不一致」的来源。调用方仍显式调用具体模块，
// 但每次调用前必须过能力门 `supports(id, capability)`。
//
// 两条硬规则（fail closed，缺省即不合法，没有默认值）：
//   1. `playable` 必须显式声明。目录源（只能看不能播）必须同时标 catalogOnly，
//      否则「推荐一首播不了的歌」就没有结构性防线。
//   2. 可播源必须声明 search 与 url —— 少任何一个都不构成可播放。

/** 能力的封闭集合。未在此列出的能力名在注册时直接拒绝，避免拼写漂移。 */
export const MUSIC_CAPABILITIES = Object.freeze([
  'search',   // 按关键词搜索曲目
  'url',      // 取得可播放地址
  'lyric',    // 歌词
  'playlist', // 歌单读取与曲库同步
  'album', // 专辑曲目读取（整专连播）
  'like',       // 读取「我喜欢 / 收藏」歌单（曲库同步与状态校准用）
  'like-write', // 写入「我喜欢 / 收藏」。风险远高于读取，必须单独声明
  'recommend',// 推荐
  'discover', // 发现（与推荐分开：QQ 有独立的发现接口）
  'comments', // 评论
]);

const AUTH_MODES = Object.freeze(['qr-cookie', 'cookie', 'none']);

const ID_PATTERN = /^[a-z][a-z0-9_-]*$/;

/**
 * 现状声明。改这里之前先读一遍文件头的两条硬规则。
 *
 * 只注册实际接入的源；历史 Apple 身份留在用户数据里，不再作为活跃能力。
 */
const DECLARATIONS = Object.freeze([
  Object.freeze({
    id: 'qq',
    displayName: 'QQ 音乐',
    playable: true,
    authMode: 'qr-cookie',
    // priority 是**回退顺序**，不是「默认主源」。默认主源来自设置项，
    // 这里的取值刻意保持与历史实现一致（非 qq 主源时回退链以 ncm 开头）。
    priority: 1,
    // like-write 已在真机验证双向可用：写「我喜欢」必须走官方签名通道
    // （musics.fcg + ag-1 + zzc sign），明文 musicu.fcg 对 dirId 201 加歌会 80105。
    // 见 server/music/qqWebSign.js 与 openspec/changes/add-track-like-mirroring。
    capabilities: Object.freeze(['search', 'url', 'lyric', 'playlist', 'album', 'like', 'like-write', 'recommend', 'discover', 'comments']),
  }),
  Object.freeze({
    id: 'ncm',
    displayName: '网易云音乐',
    playable: true,
    authMode: 'cookie',
    priority: 0,
    // like-write 已在真机验证双向可用（/like 加与删同端点）。
    capabilities: Object.freeze(['search', 'url', 'lyric', 'playlist', 'album', 'like', 'like-write', 'recommend', 'comments']),
  }),
]);

function fail(message) {
  throw new TypeError(`[music-source] ${message}`);
}

function normalizeId(value) {
  return String(value ?? '').trim().toLowerCase();
}

function validate(raw, index) {
  if (!raw || typeof raw !== 'object') fail(`declaration #${index} is not an object`);
  // 声明必须写成规范形式：id 会进 URL、日志与数据库，静默改名会把 bug 藏起来。
  // 对外查询（get/supports）仍然宽容大小写，对内声明不宽容。
  const id = String(raw.id ?? '').trim();
  if (!id) fail(`declaration #${index} is missing an id`);
  if (!ID_PATTERN.test(id)) fail(`source "${id}" has an invalid id (want ${ID_PATTERN})`);
  const displayName = String(raw.displayName ?? '').trim();
  if (!displayName) fail(`source "${id}" is missing displayName`);

  // 不做默认值：一个源忘记声明 playable 时，宁可注册失败，也不能被当成可用源。
  if (typeof raw.playable !== 'boolean') fail(`source "${id}" must declare playable explicitly`);
  const catalogOnly = raw.catalogOnly === true;
  const jumpOut = raw.jumpOut === true;
  if (raw.playable === false && !catalogOnly) {
    fail(`source "${id}" is not playable, so it must be declared catalogOnly`);
  }
  if (raw.playable === true && (catalogOnly || jumpOut)) {
    fail(`source "${id}" is playable, so it cannot be catalogOnly or jumpOut`);
  }

  const authMode = String(raw.authMode ?? '').trim();
  if (!AUTH_MODES.includes(authMode)) fail(`source "${id}" has an invalid authMode "${authMode}"`);

  const priority = Number(raw.priority);
  if (!Number.isFinite(priority)) fail(`source "${id}" must declare a finite priority`);

  if (!Array.isArray(raw.capabilities)) fail(`source "${id}" must declare a capabilities array`);
  const seen = new Set();
  for (const capability of raw.capabilities) {
    const name = String(capability ?? '').trim();
    if (!MUSIC_CAPABILITIES.includes(name)) fail(`source "${id}" declares an unknown capability "${name}"`);
    if (seen.has(name)) fail(`source "${id}" declares capability "${name}" twice`);
    seen.add(name);
  }
  if (raw.playable === true) {
    for (const required of ['search', 'url']) {
      if (!seen.has(required)) fail(`playable source "${id}" must declare "${required}"`);
    }
  }

  return Object.freeze({
    id,
    displayName,
    playable: raw.playable,
    catalogOnly,
    jumpOut,
    authMode,
    priority,
    capabilities: Object.freeze([...seen]),
  });
}

export function createProviderRegistry({ declarations = DECLARATIONS } = {}) {
  if (!Array.isArray(declarations)) fail('declarations must be an array');
  const byId = new Map();
  for (const [index, raw] of declarations.entries()) {
    const declaration = validate(raw, index);
    if (byId.has(declaration.id)) fail(`duplicate source id "${declaration.id}"`);
    byId.set(declaration.id, declaration);
  }

  // 稳定排序：priority 升序，同优先级按 id，保证回退链与展示顺序可复现。
  const ordered = Object.freeze([...byId.values()]
    .sort((a, b) => (a.priority - b.priority) || a.id.localeCompare(b.id)));

  function get(id) {
    return byId.get(normalizeId(id)) || null;
  }

  function list() {
    return ordered;
  }

  function ids() {
    return ordered.map(source => source.id);
  }

  /** 能力门：调用具体 provider 之前必须先过这一关。 */
  function supports(id, capability) {
    const source = get(id);
    return Boolean(source) && source.capabilities.includes(String(capability ?? '').trim());
  }

  function isPlayable(id) {
    return get(id)?.playable === true;
  }

  function playableSources() {
    return ordered.filter(source => source.playable);
  }

  function catalogOnlySources() {
    return ordered.filter(source => source.catalogOnly);
  }

  /** 设置页「默认播放源」候选：只列可播源，目录源不参与。 */
  function defaultSourceCandidates() {
    return playableSources().map(source => source.id);
  }

  /**
   * 确定搜索的回退链：主源优先，其余按注册表顺序。
   * 主源未知或不可播时退回注册表顺序，不在调用点写 `primary === 'qq' ? … : …`。
   */
  function orderFor(primaryId) {
    const chain = defaultSourceCandidates();
    const primary = normalizeId(primaryId);
    if (!chain.includes(primary)) return Object.freeze(chain);
    return Object.freeze([primary, ...chain.filter(id => id !== primary)]);
  }

  function displayName(id) {
    return get(id)?.displayName || normalizeId(id);
  }

  return Object.freeze({
    get, list, ids, supports, isPlayable, playableSources, catalogOnlySources,
    defaultSourceCandidates, orderFor, displayName,
  });
}

export const providerRegistry = createProviderRegistry();
