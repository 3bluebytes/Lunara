export class ApiError extends Error {
  constructor(message, { status = 0, body = null, cause } = {}) {
    super(message || '请求失败', cause ? { cause } : undefined);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function defaultRequestId() {
  if (globalThis.crypto?.randomUUID) return `rq_${globalThis.crypto.randomUUID()}`;
  return `rq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function readResponse(response) {
  try {
    return await response.json();
  } catch (jsonError) {
    try {
      const text = await response.text?.();
      return text ? { message: text } : null;
    } catch {
      if (response.ok) return null;
      throw jsonError;
    }
  }
}

function errorMessage(body, status) {
  if (typeof body === 'string' && body.trim()) return body.trim();
  if (body && typeof body === 'object') {
    return body.error || body.message || `请求失败（HTTP ${status}）`;
  }
  return `请求失败（HTTP ${status}）`;
}

/**
 * 服务端的 request boundary 对**所有**状态变更方法都要求 JSON content-type
 * （否则 415），包括不带 body 的 DELETE。因此这里不能只在有 body 时才设它。
 */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** A single HTTP boundary for all browser feature modules. */
export function createApiClient({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  requestIdFactory = defaultRequestId,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');

  async function request(path, {
    method = 'GET',
    body,
    headers = {},
    signal,
    requestId,
  } = {}) {
    const id = requestId || requestIdFactory();
    const init = {
      method,
      headers: { ...headers, 'x-request-id': id },
      signal,
    };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    if (body !== undefined || MUTATING_METHODS.has(String(method).toUpperCase())) {
      init.headers['content-type'] ??= 'application/json';
    }

    let response;
    try {
      response = await fetchImpl(path, init);
    } catch (cause) {
      throw new ApiError(cause?.message || '无法连接 Lunara 服务', { cause });
    }

    let parsed;
    try {
      parsed = await readResponse(response);
    } catch (cause) {
      throw new ApiError('服务返回了无法解析的数据', {
        status: response.status,
        cause,
      });
    }
    if (!response.ok) {
      throw new ApiError(errorMessage(parsed, response.status), {
        status: response.status,
        body: parsed,
      });
    }
    return parsed;
  }

  function get(path, options) {
    return request(path, { ...options, method: 'GET' });
  }

  function post(path, body, options = {}) {
    return request(path, { ...options, method: 'POST', body });
  }

  function patch(path, body, options = {}) {
    return request(path, { ...options, method: 'PATCH', body });
  }

  function put(path, body, options = {}) {
    return request(path, { ...options, method: 'PUT', body });
  }

  // 删除语义由服务端定义（不可回退），客户端只负责发请求并把错误如实抛出。
  function remove(path, options = {}) {
    return request(path, { ...options, method: 'DELETE' });
  }

  function chat({ requestId, ...payload }) {
    const id = requestId || requestIdFactory();
    return post('/api/chat', { ...payload, requestId: id }, { requestId: id });
  }

  return Object.freeze({ request, get, post, patch, put, delete: remove, chat });
}
