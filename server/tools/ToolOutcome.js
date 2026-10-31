const TOOL_OUTCOME = Symbol.for('lunara.tool-outcome');

class ToolOutcome {
  constructor(ok, content, data = null) {
    this.ok = !!ok;
    this.content = String(content || '');
    this.data = data ?? null;
    Object.defineProperty(this, TOOL_OUTCOME, { value: true });
  }

  toString() {
    return this.content;
  }

  [Symbol.toPrimitive]() {
    return this.content;
  }
}

export function toolSuccess(content, data = null) {
  return new ToolOutcome(true, content, data);
}

export function toolFailure(content, data = null) {
  return new ToolOutcome(false, content, data);
}

function isToolOutcome(value) {
  return !!(value && value[TOOL_OUTCOME] === true);
}

export function normalizeToolOutcome(value) {
  if (isToolOutcome(value)) {
    return { ok: value.ok, content: value.content, data: value.data };
  }
  return { ok: false, content: '操作结果未能确认，请稍后重试。', data: { code: 'UNTYPED_TOOL_RESULT' } };
}
