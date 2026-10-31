// TtsProviderRegistry.js — provider 注册、优先级选择与就绪状态汇总。
//
// 选择顺序由注册时的优先级决定（数组顺序即优先级），网关按此顺序决定
// "先试谁、失败后回落到谁"。registry 本身不做合成，也不做缓存。

import { assertTtsProvider } from './TtsProvider.js';

export class TtsProviderRegistry {
  /** @param {{ providers?: object[], logger?: object }} [options] */
  constructor({ providers = [], logger = console } = {}) {
    this.logger = logger;
    this._providers = [];
    for (const provider of providers) this.register(provider);
  }

  register(provider) {
    const normalized = assertTtsProvider(provider);
    const existing = this._providers.findIndex(item => item.id === normalized.id);
    if (existing >= 0) this._providers[existing] = normalized;
    else this._providers.push(normalized);
    return normalized;
  }

  /** 移除 provider（接口被删除时）；不存在时返回 false。 */
  unregister(id) {
    const index = this._providers.findIndex(provider => provider.id === this._indexOf(id));
    if (index < 0) return false;
    this._providers.splice(index, 1);
    return true;
  }

  get(id) {
    return this._providers.find(provider => provider.id === this._indexOf(id)) || null;
  }

  has(id) {
    return this.get(id) !== null;
  }

  /** 全部已注册 provider，按优先级排列。 */
  list() {
    return [...this._providers];
  }

  /**
   * 按优先级返回可用的 provider。
   * 单次 isConfigured() 抛错不应让整个选择过程失败——视为不可用。
   */
  available() {
    return this._providers.filter(provider => {
      try {
        return provider.isConfigured() === true;
      } catch (error) {
        this.logger?.warn?.(`[tts] provider "${provider.id}" isConfigured() threw: ${error.message}`);
        return false;
      }
    });
  }

  /**
   * 决定本次合成的尝试顺序。
   *
   * - 显式指定 providerId 时只试它，失败即失败，不静默换声音源
   * - 未指定时按优先级返回全部可用 provider，由网关逐个回落；
   *   explicitOnly 的 provider（免费声音）只在被显式指定时参与，不做隐式回落
   */
  resolve({ providerId = null } = {}) {
    if (providerId) {
      const provider = this.get(providerId);
      if (!provider) return { providers: [], reason: 'unknown-provider' };
      if (!this.available().some(item => item.id === provider.id)) {
        return { providers: [], reason: 'provider-unavailable', provider };
      }
      return { providers: [provider], reason: 'explicit' };
    }
    const providers = this.available().filter(provider => provider.explicitOnly !== true);
    return { providers, reason: providers.length ? 'priority' : 'none-available' };
  }

  /** 健康检查用：不参与合成，只报告状态。 */
  status() {
    return this._providers.map(provider => {
      let configured = false;
      let error = null;
      try {
        configured = provider.isConfigured() === true;
      } catch (caught) {
        error = caught.message;
      }
      return {
        id: provider.id,
        label: provider.label,
        requiresCredentials: provider.requiresCredentials,
        configured,
        error,
      };
    });
  }

  /** 默认音色：第一个可用 provider 的第一个音色。 */
  defaultVoiceRef() {
    for (const provider of this.available().filter(item => item.explicitOnly !== true)) {
      const voices = this._safeVoices(provider);
      if (voices.length) return { providerId: provider.id, voiceRef: voices[0].id };
    }
    return null;
  }

  _safeVoices(provider) {
    try {
      const voices = provider.listVoices();
      return Array.isArray(voices) ? voices : [];
    } catch (error) {
      this.logger?.warn?.(`[tts] provider "${provider.id}" listVoices() threw: ${error.message}`);
      return [];
    }
  }

  _indexOf(id) {
    return String(id ?? '').trim();
  }
}
