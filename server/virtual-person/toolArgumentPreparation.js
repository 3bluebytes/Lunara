// 安全参数归一（harden-native-agent-harness design §1）。
//
// 目标只有一个：让「模型多包了一层」和「确认可等价缺省的可选对象 null」不影响
// 授权、参数校验与去重身份；其余一律 fail closed。这里刻意不做：
//   - enum 映射（original → exact 之类的猜测）
//   - 截断 JSON 修复
//   - 递归解包或全量 null 清理
//   - 丢弃未知字段
// 纯函数、同步、幂等：同一个入参连续归一两次结果相同，且从不修改入参。

/** 唯一允许被当作「外层包装」的键；只有 schema 没有声明它们时才考虑解开。 */
export const ARGUMENT_WRAPPER_KEYS = Object.freeze(['params', 'arguments', 'parameters']);

export class ToolArgumentPreparationError extends Error {
  /** code 是稳定分类，message 只描述结构，不回显任何参数值（可能包含私人内容）。 */
  constructor(code, message) {
    super(message);
    this.name = 'ToolArgumentPreparationError';
    this.code = code;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function declaredProperties(parameters) {
  const properties = parameters && typeof parameters === 'object' ? parameters.properties : null;
  return properties && typeof properties === 'object' ? properties : {};
}

function isRequired(parameters, name) {
  return Array.isArray(parameters?.required) && parameters.required.includes(name);
}

/** nullable 的对象字段保留 null 语义：删掉会把「显式清空」变成「没提」。 */
function isNullableProperty(propertySchema) {
  if (!propertySchema || typeof propertySchema !== 'object') return false;
  if (propertySchema.nullable === true) return true;
  if (Array.isArray(propertySchema.type) && propertySchema.type.includes('null')) return true;
  return Array.isArray(propertySchema.enum) && propertySchema.enum.includes(null);
}

/**
 * 归一一个工具调用的参数。
 *
 * @param {unknown} args 模型给出的参数（对象、已解析 JSON 或其它）
 * @param {{ parameters?: object|null, optionalNullObjectFields?: string[]|null }} policy
 *        parameters 是工具注册时的 JSON Schema；optionalNullObjectFields 是该工具显式
 *        opt-in 的「null 等价于缺省」的顶层对象字段名。
 * @returns {unknown} 归一后的参数；非对象入参原样返回，交给 schema 校验拒绝。
 */
export function prepareToolArguments(args, { parameters = null, optionalNullObjectFields = null } = {}) {
  if (!isPlainObject(args)) return args;
  const properties = declaredProperties(parameters);

  // 始终返回浅拷贝：调用方（授权、handler）不会意外改到模型原对象。
  let prepared = { ...args };
  const keys = Object.keys(args);
  const wrapperKeys = keys.filter(key => ARGUMENT_WRAPPER_KEYS.includes(key) && !Object.hasOwn(properties, key));
  if (wrapperKeys.length) {
    // 外层包装必须独占：与其它键并列时无法判断模型到底想表达哪一层参数。
    if (keys.length !== 1) {
      throw new ToolArgumentPreparationError('AMBIGUOUS_ARGUMENT_WRAPPER',
        `argument wrapper cannot be combined with other top-level keys (${wrapperKeys[0]})`);
    }
    const inner = args[keys[0]];
    if (!isPlainObject(inner)) {
      throw new ToolArgumentPreparationError('INVALID_ARGUMENT_WRAPPER', 'argument wrapper must contain an object');
    }
    // 只解一层。再套一层就不是「格式噪音」，而是意图不明，直接拒绝而不是继续猜。
    const nested = Object.keys(inner).filter(key => ARGUMENT_WRAPPER_KEYS.includes(key) && !Object.hasOwn(properties, key));
    if (nested.length) {
      throw new ToolArgumentPreparationError('NESTED_ARGUMENT_WRAPPER', 'nested argument wrapper is ambiguous');
    }
    prepared = { ...inner };
  }

  const policyFields = Array.isArray(optionalNullObjectFields) ? optionalNullObjectFields : [];
  for (const field of policyFields) {
    const name = String(field || '');
    if (!name || !Object.hasOwn(prepared, name) || prepared[name] !== null) continue;
    const declared = properties[name];
    // 只在 schema 明确声明为顶层对象、非必填、非 nullable 时，null 才等价于缺省。
    if (!declared || typeof declared !== 'object' || declared.type !== 'object') continue;
    if (isRequired(parameters, name) || isNullableProperty(declared)) continue;
    delete prepared[name];
  }

  return prepared;
}
