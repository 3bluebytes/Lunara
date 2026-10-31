import { validateJsonSchema } from './jsonSchemaValidator.js';
import { randomUUID } from 'node:crypto';
import { createToolOutcome, ToolOutcomeKind } from './VirtualPersonTypes.js';
import { prepareToolArguments } from './toolArgumentPreparation.js';

// 归一失败是「参数不合约定」，不是内部错误：给模型可纠正的 typed 结果，绝不执行副作用。
const PREPARATION_FAILURES = Object.freeze({
  AMBIGUOUS_ARGUMENT_WRAPPER: '参数外层包装和别的字段混在一起，无法判断意图；请只传工具 schema 声明的字段。',
  NESTED_ARGUMENT_WRAPPER: '参数里出现了多层包装，无法判断意图；请只传工具 schema 声明的字段。',
  INVALID_ARGUMENT_WRAPPER: '参数外层包装必须是一个对象；请按工具 schema 传参数。',
});

function invalidArgumentsOutcome(preparationError, correlationId) {
  const hint = PREPARATION_FAILURES[String(preparationError?.code || '')]
    || '工具参数无法归一；请按工具 schema 重新传参。';
  return createToolOutcome({
    kind: ToolOutcomeKind.BUSINESS_FAILURE,
    code: 'INVALID_TOOL_ARGUMENTS',
    modelContext: `工具参数不符合约定，请修正：${hint}`,
    presentation: { displayText: '这次操作的条件不完整，可以调整后再试。', speak: false },
    internal: { correlationId },
  });
}

function normalizeDefinition(name, definition = {}) {
  if (definition.type === 'function' && definition.function) return definition;
  return {
    type: 'function',
    function: {
      name,
      description: String(definition.description || ''),
      parameters: definition.parameters || { type: 'object', properties: {}, additionalProperties: false },
    },
  };
}

export class VirtualPersonToolRegistry {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    this._tools = new Map();
  }

  register(name, {
    definition,
    handler,
    capability = 'general',
    authorize = null,
    readOnly = false,
    optionalNullObjectFields = null,
  } = {}) {
    const normalizedName = String(name || '').trim();
    if (!normalizedName) throw new TypeError('tool name is required');
    if (typeof handler !== 'function') throw new TypeError(`tool ${normalizedName} requires handler`);
    if (this._tools.has(normalizedName)) throw new Error(`tool already registered: ${normalizedName}`);
    // 显式 opt-in：只有这里列出的字段，null 才可能被当作缺省；registry 不再全量清理 null。
    const optionalNullFields = Array.isArray(optionalNullObjectFields)
      ? Object.freeze([...new Set(optionalNullObjectFields.map(String).filter(Boolean))])
      : null;
    this._tools.set(normalizedName, {
      definition: normalizeDefinition(normalizedName, definition),
      handler,
      capability: String(capability || 'general'),
      authorize: typeof authorize === 'function' ? authorize : null,
      // 只读查询：AgentLoop 跨轮不复用它的结果，模型每轮都看到当前状态。
      readOnly: readOnly === true,
      optionalNullObjectFields: optionalNullFields,
    });
    return this;
  }

  /**
   * 同步、纯、幂等的参数归一。直调 registry 与经 AgentLoop 走同一份合同。
   * 未知工具原样返回（由 execute 给出既有的 TOOL_NOT_AVAILABLE）。
   */
  prepareArguments(name, args) {
    const tool = this._tools.get(String(name || ''));
    if (!tool) return args;
    return prepareToolArguments(args, {
      parameters: tool.definition.function.parameters,
      optionalNullObjectFields: tool.optionalNullObjectFields,
    });
  }

  isReadOnly(name) {
    return this._tools.get(String(name || ''))?.readOnly === true;
  }

  definitions({ capabilities = null } = {}) {
    const allowed = Array.isArray(capabilities) ? new Set(capabilities.map(String)) : null;
    return [...this._tools.values()]
      .filter(tool => !allowed || allowed.has(tool.capability))
      .map(tool => structuredClone(tool.definition));
  }

  async execute(name, args, context = {}) {
    const tool = this._tools.get(String(name || ''));
    const correlationId = String(context.correlationId || '');
    if (!tool) {
      return createToolOutcome({
        kind: ToolOutcomeKind.BUSINESS_FAILURE,
        code: 'TOOL_NOT_AVAILABLE',
        modelContext: '这个能力当前不可用。',
        presentation: { displayText: '这个能力当前不可用。', speak: false, retryable: false },
        internal: { correlationId },
      });
    }
    try {
      context.signal?.throwIfAborted();
      if (context.isCurrent && !context.isCurrent()) throw new Error('response is no longer current');
      // 归一必须早于能力/授权判断、schema 校验和 handler：同一份 prepared 参数是唯一事实。
      let preparedArgs;
      try {
        preparedArgs = this.prepareArguments(name, args);
      } catch (preparationError) {
        return invalidArgumentsOutcome(preparationError, correlationId);
      }
      const allowed = Array.isArray(context.capabilities) ? new Set(context.capabilities.map(String)) : null;
      if (allowed && !allowed.has(tool.capability)) {
        return createToolOutcome({
          kind: ToolOutcomeKind.BUSINESS_FAILURE,
          code: 'TOOL_NOT_AUTHORIZED',
          modelContext: '当前虚拟人的能力配置不允许执行这个工具。',
          presentation: { displayText: '当前人格不能执行这项操作。', speak: false, retryable: false },
          internal: { correlationId },
        });
      }
      if (tool.authorize && !await tool.authorize(preparedArgs, context)) {
        return createToolOutcome({
          kind: ToolOutcomeKind.BUSINESS_FAILURE,
          code: 'TOOL_NOT_AUTHORIZED',
          modelContext: '当前请求没有执行这个持久操作的权限。',
          presentation: { displayText: '这项操作需要你明确确认。', speak: false, retryable: true },
          internal: { correlationId },
        });
      }
      // Public web material never bootstraps a same-round write authority, even
      // via a plausible sourceQuote or another group member. Monotonic host flag;
      // model arguments cannot clear it. A fresh user round gets a fresh scope.
      if (context.groupAction?.webReadOnly === true && !tool.readOnly) {
        return createToolOutcome({ kind: ToolOutcomeKind.BUSINESS_FAILURE, code: 'WEB_READ_ONLY_TURN',
          modelContext: '本轮已经读取外部资料，后续只允许只读工具。不要执行记忆、人格或音乐写操作；需要下一轮用户明确发起。',
          presentation: { displayText: '资料已查到。这一轮先核对信息；如果需要保存或播放，请在下一条消息中明确告诉我。', speak: false } });
      }
      const validation = validateJsonSchema(preparedArgs === undefined ? {} : preparedArgs, tool.definition.function.parameters);
      if (!validation.valid) return createToolOutcome({ kind: ToolOutcomeKind.BUSINESS_FAILURE,
        code: 'INVALID_TOOL_ARGUMENTS', modelContext: `工具参数不符合约定，请修正：${validation.errors.slice(0, 8).join('; ')}`,
        presentation: { displayText: '这次操作的条件不完整，可以调整后再试。', speak: false } });
      const raw = await tool.handler(preparedArgs === undefined ? {} : preparedArgs, context);
      if (raw && typeof raw === 'object' && raw.kind && raw.code) return createToolOutcome(raw);
      throw new TypeError(`tool ${name} returned an untyped outcome`);
    } catch (error) {
      const errorId = `err_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
      this.logger?.error?.(`[virtual-person] tool ${name} failed errorId=${errorId}`, error);
      return createToolOutcome({
        kind: ToolOutcomeKind.INTERNAL_FAILURE,
        code: 'INTERNAL_TOOL_ERROR',
        modelContext: '工具暂时失败。不要猜测失败细节，也不要输出内部诊断信息。',
        presentation: {
          displayText: '刚才的操作没有完成，你可以稍后再试。',
          spokenText: '刚才没有操作成功。',
          speak: false,
          severity: 'error',
          retryable: true,
        },
        internal: { correlationId, errorId },
      });
    }
  }
}
