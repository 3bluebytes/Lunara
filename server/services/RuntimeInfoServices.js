import { providerRegistry } from '../music/providerRegistry.js';
import { describeSourceFailure, isSourceFailureCode } from '../music/sourceFailure.js';

// 源名单来自注册表，只有展示文案留在这里：注册表表达「是什么」，文案属于界面层。
// `ready` 在设置页的含义就是「可以用作播放源」，因此直接取 playable——
// 目录源（仅跳转网页）不再能冒充可选播放源。
const SOURCE_NOTES = Object.freeze({
  qq: '已内置（支持扫码登录）',
  ncm: '已接入',
});

// `weight` 是推荐目标份额（目录源没有）：设置页据此渲染滑块，用户不配置时即均分。
function defaultSources(weights = {}) {
  return providerRegistry.list().map(source => ({
    id: source.id,
    name: source.displayName,
    ready: source.playable,
    note: SOURCE_NOTES[source.id] || (source.playable ? '已接入' : '占位 — 仅跳转网页'),
    ...(source.playable && typeof weights[source.id] === 'number' ? { weight: weights[source.id] } : {}),
  }));
}

export class SettingsHttpService {
  constructor({
    state, tts, voices = [], getVoices = null, providerStatus = null,
    // () => Promise<Array<{id, state, since, authenticated}>>：派生健康状态。
    // 用函数而不是构造期取值，避免设置页一直显示启动那一刻的过期状态。
    sourceHealth = null,
    // () => ({ [provider]: share }) | null：近 7 天实际收听占比，由既有 plays 记录聚合。
    // 只有目标、看不到实际，用户调了滑块却不知道有没有生效。
    playbackMix = null,
    getSnapshot, update, logger = console,
  } = {}) {
    this.state = state;
    this.tts = tts;
    this._voices = voices;
    // 声音列表与 provider 状态会随用户配置变化（例如填入付费 key 后原生声音变得可用），
    // 因此支持函数形式：构造时取值会让设置页一直显示过期的回落状态。
    this._getVoices = typeof getVoices === 'function' ? getVoices : null;
    this._providerStatus = typeof providerStatus === 'function' ? providerStatus : null;
    this._sourceHealth = typeof sourceHealth === 'function' ? sourceHealth : null;
    this._playbackMix = typeof playbackMix === 'function' ? playbackMix : null;
    this.getSnapshot = getSnapshot;
    this.updateSettings = update;
    this.logger = logger;
  }

  /** 当前声音选项（每次读取都重新求值）。 */
  get voices() {
    if (this._getVoices) {
      try {
        const value = this._getVoices();
        return Array.isArray(value) ? value : [];
      } catch (error) {
        this.logger?.warn?.(`[settings] voice options failed: ${error.message}`);
        return [];
      }
    }
    return Array.isArray(this._voices) ? this._voices : [];
  }

  /** 各声音 provider 的就绪状态，供设置页展示与下载入口判断。 */
  get providers() {
    if (!this._providerStatus) return [];
    try {
      const value = this._providerStatus();
      return Array.isArray(value) ? value : [];
    } catch (error) {
      this.logger?.warn?.(`[settings] provider status failed: ${error.message}`);
      return [];
    }
  }

  /**
   * 源列表 + 派生健康状态。健康信息缺失时**保留原有字段形状**、只是不带 state，
   * 这样前端不需要为「服务端没接健康探测」写第二套分支。
   */
  /** 近 N 天实际收听占比：没有数据时**不给字段**，界面据此写「还没有最近收听」。 */
  withPlaybackMix(sources) {
    if (!this._playbackMix) return sources;
    let mix = null;
    try { mix = this._playbackMix(); } catch (error) {
      this.logger?.warn?.(`[settings] playback mix failed: ${error?.message || error}`);
      return sources;
    }
    if (!mix || typeof mix !== 'object') return sources;
    return sources.map(source => (source.ready && typeof mix[source.id] === 'number'
      ? { ...source, actualShare: mix[source.id] } : source));
  }

  async sourceOptions(weights = null) {
    let targets = weights;
    if (!targets || typeof targets !== 'object') {
      // 单独调用 sourceOptions 时也要带上权重，不能只在 snapshot 里才有。
      try {
        targets = (await this.getSnapshot({ state: this.state, tts: this.tts }))?.recommendationWeights || {};
      } catch { targets = {}; }
    }
    const base = this.withPlaybackMix(defaultSources(targets));
    if (!this._sourceHealth) return base;
    let health = [];
    try {
      health = await this._sourceHealth();
    } catch (error) {
      this.logger?.warn?.(`[settings] source health failed: ${error.message}`);
      return base;
    }
    const byId = new Map((Array.isArray(health) ? health : []).map(item => [item?.id, item]));
    return base.map(source => {
      const entry = byId.get(source.id);
      if (!entry) return source;
      return {
        ...source,
        state: entry.state,
        // 原因码是内部词汇；界面要的是「QQ 音乐需要会员」这种人话。
        // 只有真正的失败原因码才配文案：`catalog-only` 是能力描述，
        // 把它当成故障会告诉用户「Apple Music 暂时没能拿到这首歌」。
        ...(isSourceFailureCode(entry.state)
          ? { stateText: describeSourceFailure(entry.state, { source: source.name }) } : {}),
        ...(entry.since != null ? { since: entry.since } : {}),
        authenticated: entry.authenticated ?? null,
      };
    });
  }

  async snapshot() {
    const current = await this.getSnapshot({ state: this.state, tts: this.tts });
    return {
      current,
      options: {
        // 传 `{}` 而不是 undefined：这是「已经问过了，就是没有」，避免 sourceOptions
        // 再调用一次 getSnapshot（那会让每次读设置多打一次 LLM 配置与偏好）。
        source: await this.sourceOptions(current?.recommendationWeights ?? {}),
        tts: this.voices.map(voice => ({ ...voice })),
        ttsProviders: this.providers.map(provider => ({ ...provider })),
      },
    };
  }

  async update(input) {
    const result = await this.updateSettings(input, {
      state: this.state,
      tts: this.tts,
      ttsVoiceIds: this.voices.map(voice => voice.id),
    });
    const current = result?.current || {};
    this.logger?.log?.(`[settings] llm=${current.llm?.model || '(未配置)'} (ready=${result?.ready}) source=${current.source} voice=${current.voice} primary=${current.primarySource}`);
    return result;
  }
}

export class HealthService {
  constructor({ providers = {}, getLlmConfig, getNow, env = process.env, getLastBudgetRejection = null,
    getTrackFailures = null } = {}) {
    this.providers = providers;
    this.getLlmConfig = getLlmConfig;
    this.getNow = getNow;
    this.env = env;
    // 最近一次模型日内预算拒绝（server/llmUsageLedger.js）：只含任务、上限与用量数字。
    this.getLastBudgetRejection = getLastBudgetRejection;
    // 播放失败的脱敏计数：判断「该不该做同源刷新续播」需要先知道失败是哪一类。
    this.getTrackFailures = getTrackFailures;
  }

  async snapshot() {
    const { ncm, qq } = this.providers;
    const [ncmOk, ncmLogin, qqOk, qqLogin, llmConfig] = await Promise.all([
      ncm.ping(),
      ncm.loginStatus(),
      qq.ping(),
      qq.loginStatus(),
      this.getLlmConfig(),
    ]);
    // cookieStored 只暴露布尔值，不暴露凭据内容：登录态核验依赖上游接口，
    // 上游故障时 loggedIn 会暂时为 false，前端需要据此区分
    // 「从未登录」与「已保存凭据但此刻验证不了」，避免把用户困在首启设置里。
    const withStored = (provider, login) => ({
      ...(login || { loggedIn: false }),
      cookieStored: !!provider?.getCookie?.(),
    });
    const lastBudgetRejection = (() => {
      try { return this.getLastBudgetRejection?.() || null; } catch { return null; }
    })();
    return {
      ncm: ncmOk,
      ncmLogin: withStored(ncm, ncmLogin),
      qq: qqOk,
      qqLogin: withStored(qq, qqLogin),
      minimax: !!this.env.MINIMAX_API_KEY,
      llm: { ready: llmConfig.ready, model: llmConfig.model, lastBudgetRejection },
      now: this.getNow(),
      trackFailures: (() => {
        try { return this.getTrackFailures?.() || null; } catch { return null; }
      })(),
    };
  }
}

export default { SettingsHttpService, HealthService };
