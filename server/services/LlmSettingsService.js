// LlmSettingsService.js — provider 注册表的设置面（读/写/发现/使用中/会话覆盖）。
//
// 路由层的唯一依赖：这里保证任何返回给前端的对象不含 apiKey 明文（hasKey 语义），
// 删除/停用使用中 provider 的回落语义由 llmProviders 负责，本层不重复实现。

import {
  listModelProviders, saveModelProvider, deleteModelProvider,
  setActiveModel, getActiveModel, getModelCapability, saveModelCapability, deleteModelCapability,
  getModelFailoverPolicy, saveModelFailoverPolicy,
} from '../llmProviders.js';
import { discoverModels } from '../llmDiscovery.js';
import { chat as defaultChat } from '../llm.js';

/** 保存后自动探测只排启用模型：停用模型保留配置，但不为它发起探测。 */
function enabledModels(provider) {
  const disabled = new Set(provider?.disabledModels || []);
  return (provider?.models || []).filter(model => !disabled.has(model));
}

export class LlmSettingsService {
  constructor({ sessionOverrides = null, discover = discoverModels, chat = defaultChat,
    capabilityProbe = null, usageLedger = null } = {}) {
    this.sessionOverrides = sessionOverrides;
    this.discoverModels = discover;
    this.chat = chat;
    // 能力探测接线（server/app/createCapabilityProbeWiring.js）：保存后后台探测 + 手动探测入口。
    this.capabilityProbe = capabilityProbe;
    // 用量账本接线（server/llmUsageLedger.js）：今日调用/token/失败分类的只读摘要。
    this.usageLedger = usageLedger;
  }

  /** 用量摘要（GET /api/llm/usage）：只回数值与分类，不含提示或回复正文。 */
  async usageSummary({ days = 1 } = {}) {
    if (!this.usageLedger) return { ok: false, error: '用量账本不可用' };
    return { ok: true, ...this.usageLedger.summary({ days }) };
  }

  /**
   * 用量报告（GET /api/llm/usage/report）：逐日连续序列 + totals + 按模型拆分。
   * days 的夹紧/回落由账本负责；账本不可用时与 usageSummary 同样如实返回。
   */
  async usageReport({ days = 30 } = {}) {
    if (!this.usageLedger) return { ok: false, error: '用量账本不可用' };
    return { ok: true, ...this.usageLedger.report({ days }) };
  }

  async registry() {
    return {
      ok: true,
      providers: await listModelProviders(),
      activeModel: await getActiveModel(),
    };
  }

  async createProvider(patch = {}) {
    const provider = await saveModelProvider(patch);
    this.capabilityProbe?.scheduleAfterSave?.({ providerId: provider.id, models: enabledModels(provider) });
    return { ok: true, provider };
  }

  async updateProvider(id, patch = {}) {
    const provider = await saveModelProvider({ ...patch, id });
    // 保存模型后后台探测一次（只探测启用且尚无档案的模型，fire-and-forget，不阻塞保存响应）。
    this.capabilityProbe?.scheduleAfterSave?.({ providerId: provider.id, models: enabledModels(provider) });
    return { ok: true, provider };
  }

  /** 手动/保存后的能力探测；force=true 时允许覆盖用户声明（用户显式点击的场景）。 */
  async probeCapability({ providerId, model = null, force = true } = {}) {
    const requested = String(model || '').trim();
    // 停用模型不发起任何探测；provider 不存在或未指定模型时保持原有行为。
    if (requested) {
      const providers = await listModelProviders();
      const provider = providers.find(candidate => candidate.id === String(providerId || '').trim());
      if (provider && (provider.disabledModels || []).includes(requested)) {
        return { ok: false, error: '模型已停用，启用后再探测' };
      }
    }
    if (!this.capabilityProbe) return { ok: false, error: '能力探测不可用' };
    try {
      return await this.capabilityProbe.probeNow({ providerId, model, force });
    } catch (error) {
      return { ok: false, error: error?.code === 'LLM_PROBE_UNREACHABLE' ? '模型端点不可达，请检查网络与地址' : '能力探测失败' };
    }
  }

  /** 用户显式声明能力（可选覆盖）：source 'user'，自动探测与观测都不会静默改写。 */
  async saveCapability({ providerId, model, capability = {} } = {}) {
    try {
      const saved = await saveModelCapability({ providerId, model, capability, source: 'user', overwrite: true });
      return { ok: true, capability: saved };
    } catch (error) {
      return { ok: false, error: error?.message || '保存能力档案失败' };
    }
  }

  async clearCapability({ providerId, model } = {}) {
    return { ok: true, removed: await deleteModelCapability({ providerId, model }) };
  }

  async deleteProvider(id) {
    return { ok: true, ...(await deleteModelProvider(id)) };
  }

  async chooseActiveModel(patch = {}) {
    return { ok: true, activeModel: await setActiveModel(patch) };
  }

  /** 故障切换策略（GET /api/llm/failover）：缺省 = 关闭，只含 providerId/model 与开关。 */
  async failoverPolicy() {
    return { ok: true, policy: await getModelFailoverPolicy() };
  }

  /**
   * 保存故障切换策略（PUT /api/llm/failover）：非法目标返回可纠正的错误，
   * 不抛原始异常；响应里没有 apiKey/baseUrl。
   */
  async saveFailoverPolicy(patch = {}) {
    try {
      return { ok: true, policy: await saveModelFailoverPolicy(patch || {}) };
    } catch (error) {
      return { ok: false, error: error?.message || '保存故障切换策略失败' };
    }
  }

  async discover(input = {}) {
    return this.discoverModels(input);
  }

  /**
   * 连通性测试：用给定端点真实发一条消息（走该协议的适配器），
   * 验证"能拉到模型列表"之外模型是否真的能对话。失败如实抛错（不含 key）。
   */
  async testModel(input = {}) {
    const baseUrl = String(input?.baseUrl || '').trim();
    const model = String(input?.model || '').trim();
    if (!baseUrl || !model) throw new Error('连通性测试需要 baseUrl 与 model');
    const started = Date.now();
    const result = await this.chat(
      [{ role: 'user', content: '连通性测试：只回复两个字：正常' }],
      null,
      {
        endpoint: { baseUrl, apiKey: String(input?.apiKey || ''), model, api: input?.api || 'openai-completions' },
        // 探针同样依赖正文：额度/超时来自 connectivity_probe 规格（1024 + 思考余量），
        // 关思考是成本选择（档案允许时才发送），未知模型靠思考余量兜底。
        taskId: 'connectivity_probe',
        temperature: 0,
        thinkingMode: 'disabled',
      },
    );
    return {
      ok: true,
      latencyMs: Date.now() - started,
      reply: String(result?.message?.content || '').trim().slice(0, 200),
      finishReason: result?.finishReason || null,
    };
  }

  /** 会话当前覆盖（无覆盖 → {override: null}，界面显示"跟随全局"）。 */
  async sessionModel(sessionId) {
    const override = this.sessionOverrides ? await this.sessionOverrides.get(sessionId) : null;
    return { ok: true, sessionId, override };
  }

  /**
   * 设置/清除会话模型覆盖。`reasoningEffort` 原样透传给 overrides.set：
   * 缺省/null 表示跟随模型默认（不写该字段），清除模型覆盖时档位一起清除。
   */
  async setSessionModel({ sessionId, providerId = null, model = null, reasoningEffort = null } = {}) {
    if (!this.sessionOverrides) return { ok: false, error: '会话模型覆盖不可用' };
    const override = await this.sessionOverrides.set(sessionId,
      providerId && model
        ? { providerId, model, ...(reasoningEffort != null ? { reasoningEffort } : {}) }
        : null);
    return { ok: true, sessionId, override };
  }
}
