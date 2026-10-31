// VoiceDirectory.js — 稳定声音身份、历史别名与用户保留声线。
// 历史预设只用于兼容解析；实际可选声音只来自自定义 TTS 接口保留的声音。
// 系统语音与本地模型均已关闭，旧数据库值不改写，也不再假设任何兜底声音。

import { createHash } from 'node:crypto';
import { createVoiceProfile, deriveStyleTags } from './VoiceProfile.js';

/**
 * 预设声音身份。
 *
 * 仅为既有角色保留的声音身份，不参与新建伙伴候选；原绑定已退休。
 */
export const PRESET_VOICES = Object.freeze([
  {
    id: 'vp_sweet_lady',
    displayName: '柔声女声',
    description: '温柔电台女声',
    gender: 'female',
  },
  {
    id: 'vp_mature_woman',
    displayName: '成熟女声',
    description: '沉稳知性女声',
    gender: 'female',
  },
  {
    id: 'vp_chengshu_male',
    displayName: '沉稳男声',
    description: '沉稳亲切男声',
    gender: 'male',
  },
  {
    id: 'vp_warm_girl',
    displayName: '温暖少女',
    description: '清新柔和女声',
    gender: 'female',
  },
  {
    id: 'vp_radio_host',
    displayName: '深夜男主播',
    description: '深夜电台男声',
    gender: 'male',
  },
  {
    id: 'vp_gentleman',
    displayName: '温润男声',
    description: '温文尔雅男声',
    gender: 'male',
  },
  {
    id: 'vp_lyrical',
    displayName: '抒情男声',
    description: '温和抒情男声',
    gender: 'male',
  },
  {
    id: 'vp_news_anchor',
    displayName: '新闻女声',
    description: '专业新闻女主播',
    gender: 'female',
  },
  {
    id: 'vp_male_announcer',
    displayName: '播报男声',
    description: '专业男播报',
    gender: 'male',
  },
  {
    id: 'vp_sweet_female',
    displayName: '甜美女性',
    description: '经典甜美声音',
    gender: 'female',
  },
  {
    id: 'vp_young_girl',
    displayName: '少女精品',
    description: '清新少女音',
    gender: 'female',
  },
  {
    id: 'vp_robot',
    displayName: '机械战甲',
    description: '机器人金属音',
    gender: null,
  },
]);

/**
 * 历史供应商 voice id → 稳定身份。
 *
 * 这些字符串是**曾经落进数据库的值**，因此必须永久可解析；迁移不重写它们，
 * 回滚时也就不需要恢复任何用户数据。
 */
export const LEGACY_ALIASES = Object.freeze({
  'Chinese (Mandarin)_Sweet_Lady': 'vp_sweet_lady',
  'Chinese (Mandarin)_Mature_Woman': 'vp_mature_woman',
  'female-chengshu-jingpin': 'vp_chengshu_male',
  'Chinese (Mandarin)_Warm_Girl': 'vp_warm_girl',
  'Chinese (Mandarin)_Radio_Host': 'vp_radio_host',
  'Chinese (Mandarin)_Gentleman': 'vp_gentleman',
  'Chinese (Mandarin)_Lyrical_Voice': 'vp_lyrical',
  'Chinese (Mandarin)_News_Anchor': 'vp_news_anchor',
  'Chinese (Mandarin)_Male_Announcer': 'vp_male_announcer',
  'female-tianmei': 'vp_sweet_female',
  'female-shaonv-jingpin': 'vp_young_girl',
  'Robot_Armor': 'vp_robot',
});

// 曾直接保存的本地源 voice id 只做兼容别名，不恢复任何模型绑定。
const RETIRED_LOCAL_ALIASES = Object.freeze({
  zf_002: 'vp_sweet_lady', zf_026: 'vp_mature_woman', zm_011: 'vp_chengshu_male',
  zf_001: 'vp_warm_girl', zm_010: 'vp_radio_host', zm_020: 'vp_gentleman',
  zm_030: 'vp_lyrical', zf_040: 'vp_news_anchor', zm_012: 'vp_male_announcer',
  zf_003: 'vp_sweet_female', zf_019: 'vp_young_girl',
});

/** 旧 MiniMax 原生声线 id → 当时的中文显示名。供迁移种子回填保留声音的名称。 */
export const LEGACY_NATIVE_DISPLAY_NAMES = Object.freeze({
  'Chinese (Mandarin)_Sweet_Lady': '柔声女声',
  'Chinese (Mandarin)_Mature_Woman': '成熟女声',
  'female-chengshu-jingpin': '沉稳男声',
  'Chinese (Mandarin)_Warm_Girl': '温暖少女',
  'Chinese (Mandarin)_Radio_Host': '深夜男主播',
  'Chinese (Mandarin)_Gentleman': '温润男声',
  'Chinese (Mandarin)_Lyrical_Voice': '抒情男声',
  'Chinese (Mandarin)_News_Anchor': '新闻女声',
  'Chinese (Mandarin)_Male_Announcer': '播报男声',
  'female-tianmei': '甜美女性',
  'female-shaonv-jingpin': '少女精品',
  'Robot_Armor': '机械战甲',
});

/** 当前显示名 → 稳定身份（历史上一直允许用中文显示名查找声音）。 */
const LEGACY_NAME_ALIASES = Object.freeze(Object.fromEntries(
  PRESET_VOICES.map(preset => [preset.displayName, preset.id]),
));

/**
 * 更早一轮的显示名。其中四个后来被改名（甜美女声→柔声女声、电台男主播→深夜男主播、
 * 傲娇御姐→成熟女声、成熟精品→沉稳男声）——改名不能让仍引用旧名字的数据或调用方失声。
 */
const LEGACY_DISPLAY_NAME_ALIASES = Object.freeze({
  '甜美女声': 'vp_sweet_lady',
  '电台男主播': 'vp_radio_host',
  '温暖少女': 'vp_warm_girl',
  '傲娇御姐': 'vp_mature_woman',
  '成熟精品': 'vp_chengshu_male',
  '播报男声': 'vp_male_announcer',
  '抒情男声': 'vp_lyrical',
  '新闻女声': 'vp_news_anchor',
  '温润男声': 'vp_gentleman',
  '甜美女性': 'vp_sweet_female',
  '少女精品': 'vp_young_girl',
  '机械战甲': 'vp_robot',
});

/** 默认只认为 keyless provider 可用——这是安全的默认，不假设用户配了付费凭据。 */
// 系统语音已关闭：不默认假设任何 provider 可用；探针失败也回到这个安全默认。
const KEYLESS_PROVIDERS = Object.freeze(new Set());

let _profiles = null;
let _availableProviders = null;

/** 由旧签名（传入供应商 voice 列表）注册的额外别名，独立存放以免修改冻结的常量表。 */
const LEGACY_ALIASES_EXTRA = new Map();

function buildProfile(preset) {
  return createVoiceProfile({
    id: preset.id,
    sourceProvider: preset.native?.providerId || preset.keyless?.providerId || '',
    sourceVoiceId: preset.native?.sourceVoiceId || preset.keyless?.sourceVoiceId || '',
    displayName: preset.displayName,
    description: preset.description,
    gender: preset.gender || null,
    styleTags: deriveStyleTags(preset.displayName, preset.description),
  });
}

/**
 * @param {string[]} [ttsVoices] 兼容旧签名：传入的供应商 voice id 会被登记为别名，
 *   但不再充当预设来源（预设现在由本模块自己拥有）。
 * @param {{ getAvailableProviders?: () => Set<string> }} [options]
 */
export function initialize(ttsVoices = null, { getAvailableProviders = null } = {}) {
  if (_profiles) return _profiles;
  _profiles = [...PRESET_VOICES.map(buildProfile), ..._customPresets.map(buildProfile)];
  _availableProviders = typeof getAvailableProviders === 'function' ? getAvailableProviders : null;
  // 旧调用方传入的列表视为额外别名来源，保证任何历史 id 都能解析。
  if (Array.isArray(ttsVoices)) {
    for (const voice of ttsVoices) {
      const id = voice?.id || voice?.sourceVoiceId;
      if (!id || LEGACY_ALIASES[id]) continue;
      const fallback = PRESET_VOICES.find(preset => preset.displayName === voice?.name);
      if (fallback) LEGACY_ALIASES_EXTRA.set(id, fallback.id);
    }
  }
  return _profiles;
}

export function isInitialized() { return _profiles !== null; }

/** 把任意历史引用（供应商 voice id / 现行或旧显示名 / 稳定 id）解析为稳定身份 id。 */
export function resolveProfileId(ref) {
  const value = String(ref || '').trim();
  if (!value) return null;
  if (value.startsWith('vp_')) return _profiles?.some(profile => profile.id === value) ? value : null;
  return LEGACY_ALIASES[value] || RETIRED_LOCAL_ALIASES[value] || LEGACY_ALIASES_EXTRA.get(value)
    || _customAliases.get(value) || LEGACY_NAME_ALIASES[value] || LEGACY_DISPLAY_NAME_ALIASES[value] || null;
}

/** 按任意历史引用取预设身份。 */
export function getVoiceProfile(ref) {
  const id = resolveProfileId(ref);
  if (!id || !_profiles) return null;
  return _profiles.find(profile => profile.id === id) || null;
}

/** 取该身份的 provider 绑定（原生 + keyless 回落）。 */
export function getVoiceBinding(ref) {
  const id = resolveProfileId(ref);
  if (!id) return null;
  const preset = PRESET_VOICES.find(item => item.id === id)
    || _customPresets.find(item => item.id === id)
;
  if (!preset) return null;
  return {
    id, native: preset.native || null, keyless: preset.keyless || null, unavailable: preset.unavailable === true,
    params: preset.params || null,
  };
}

function availableProviders() {
  if (_availableProviders) {
    try {
      return _availableProviders();
    } catch {
      // 探测失败时退回安全默认，而不是让解析整体失败。
    }
  }
  return KEYLESS_PROVIDERS;
}

/**
 * 把一个声音引用解析成本次合成真正要用的 `(providerId, voiceId)`。
 *
 * 这是"既有虚拟人不失声"的关键：原生 provider 可用就用原声线（声线不变），
 * 不可用就回落到 keyless 声音（音色会变，但**仍然出声**）。
 *
 * @returns {{ profileId, providerId, voiceId, isFallback, unavailable }|null}
 */
export function resolveVoiceRef(ref, { providers = null } = {}) {
  const binding = getVoiceBinding(ref);
  if (!binding) return null;
  const available = providers || availableProviders();
  const has = id => Boolean(id) && (typeof available.has === 'function' ? available.has(id) : available.includes(id));
  if (binding.unavailable) return { profileId: binding.id, providerId: null, voiceId: null, isFallback: false, unavailable: true };
  if (binding.native && has(binding.native.providerId)) {
    return {
      profileId: binding.id,
      providerId: binding.native.providerId,
      voiceId: binding.native.sourceVoiceId,
      isFallback: false,
      unavailable: false,
      // 这把声音自己记录的合成参数（多接口声音池里每把声音可以有自己的 model）。
      ...(binding.params ? { params: { ...binding.params } } : {}),
    };
  }
  if (binding.keyless && has(binding.keyless.providerId)) {
    return {
      profileId: binding.id,
      providerId: binding.keyless.providerId,
      voiceId: binding.keyless.sourceVoiceId,
      // 音色与原生不同：调用方应据此如实告知用户，而不是假装声线未变。
      isFallback: true,
      unavailable: false,
    };
  }
  return { profileId: binding.id, providerId: null, voiceId: null, isFallback: true, unavailable: true };
}

/** 列举预设身份。 */
export function listVoiceProfiles({ includeLegacy = false } = {}) {
  return (_profiles || []).filter(profile => includeLegacy || !PRESET_VOICES.some(item => item.id === profile.id));
}

/**
 * 列举预设身份，并附上「这次实际会用哪把声音」。
 *
 * 界面必须能如实告知回落（tts-provider spec 的「回落导致音色改变时如实告知」）：
 * 没有 MiniMax 凭据时，所有身份的 `displayName` 仍是原生声音的名字，但实际
 * 发声的是 keyless 回落声音——只看名字会把回落呈现为原有声音。
 *
 * @param {{ providers?: Set<string>|string[] }} [options]
 */
export function listResolvedVoiceProfiles({ providers = null } = {}) {
  const available = providers || availableProviders();
  return listVoiceProfiles().map(profile => {
    const resolved = resolveVoiceRef(profile.id, { providers: available });
    const preset = _customPresets.find(item => item.id === profile.id);
    const sourceLabel = resolved?.providerId ? (preset?.providerName || '自定义接口') : '未就绪';
    return {
      ...profile,
      sourceLabel,
      resolvedProviderId: resolved?.providerId ?? null,
      resolvedVoiceId: resolved?.voiceId ?? null,
      isFallback: resolved?.isFallback === true,
      unavailable: resolved?.unavailable === true,
    };
  });
}

/**
 * 按风格标签筛选。
 * 只在用户保留的当前声线中查找，不把已退休的预设重新推荐给模型。
 */
export function findVoiceProfilesByStyle(tags) {
  if (!_profiles) return [];
  const tagArr = Array.isArray(tags) ? tags : [tags];
  return listVoiceProfiles().filter(profile => tagArr.some(tag => profile.styleTags.includes(tag)));
}

/**
 * 自定义接口保留声音（来自 ttsCustomConfig 的统一声音池），以稳定身份并入目录。
 * 每条记录所属接口（providerId = 接口 id）、接口名与可选 model；身份 id 由配置落盘，
 * 缺省时按旧规则由源 voice id 派生（vp_cx_<hash>），改名不影响已落库的引用。
 */
let _customPresets = [];
/** 源 voice id → 身份，每次同步重建；同一源 id 只给第一个登记的声音，不被后来的接口抢走。 */
const _customAliases = new Map();

export function setCustomVoiceEntries(entries = []) {
  const seen = new Set();
  const ids = new Set();
  _customPresets = [];
  _customAliases.clear();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const sourceVoiceId = String(entry?.sourceVoiceId || '').trim();
    const providerId = String(entry?.providerId || entry?.endpointId || 'custom').trim();
    const key = `${providerId}::${sourceVoiceId}`;
    if (!sourceVoiceId || seen.has(key)) continue;
    const displayName = String(entry?.displayName || '').trim() || sourceVoiceId;
    const profileId = String(entry?.profileId || '').trim()
      || `vp_cx_${createHash('sha1').update(sourceVoiceId).digest('hex').slice(0, 8)}`;
    if (ids.has(profileId)) continue;
    seen.add(key);
    ids.add(profileId);
    const model = String(entry?.model || '').trim();
    _customPresets.push({
      id: profileId,
      displayName,
      description: String(entry?.description || '').trim() || '自定义接口声音',
      gender: entry?.gender || null,
      native: { providerId, sourceVoiceId },
      providerName: String(entry?.providerName || '').trim() || null,
      ...(model ? { params: { model } } : {}),
    });
    // 源 voice id 也注册为别名：历史数据或手填值可能用源 id 引用这个声音。
    if (!_customAliases.has(sourceVoiceId)) _customAliases.set(sourceVoiceId, profileId);
  }
  rebuildProfilesIfInitialized();
  return _customPresets.map(preset => preset.id);
}

function rebuildProfilesIfInitialized() {
  if (!_profiles) return;
  _profiles = [...PRESET_VOICES.map(buildProfile), ..._customPresets.map(buildProfile)];
}

/** Reset (for testing) */
export function reset() {
  _profiles = null;
  _availableProviders = null;
  _customPresets = [];
  _customAliases.clear();
  LEGACY_ALIASES_EXTRA.clear();
}
