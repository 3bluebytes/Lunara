export function createMemoryController({ apiClient, onChanged = () => {} } = {}) {
  if (!apiClient) throw new TypeError('memory api client is required');
  let memories = [];
  let candidates = [];
  const listeners = new Set([onChanged]);

  function snapshot() {
    return { memories: [...memories], candidates: [...candidates], total: memories.length };
  }

  async function load() {
    const memoryResult = await apiClient.get('/api/memory/shared');
    if (memoryResult?.ok === false) throw new Error(memoryResult.error || '记忆加载失败');
    memories = Array.isArray(memoryResult?.memories) ? memoryResult.memories : [];
    candidates = (memoryResult.candidates || []).filter(item => ['pending', 'unverified'].includes(item.status));
    const next = snapshot();
    for (const listener of listeners) listener(next);
    return next;
  }

  async function add(content, tags) {
    const normalized = String(content || '').trim();
    if (!normalized) throw new Error('记忆内容不能为空');
    const result = await apiClient.post('/api/station/memory', {
      content: normalized,
      source: 'user_explicit_feedback',
      tags: tags || undefined,
    });
    if (result?.ok === false) throw new Error(result.error || '写入失败');
    return result;
  }

  async function consolidate() {
    const result = await apiClient.post('/api/station/consolidate', {});
    if (result?.ok === false) throw new Error(result.error || '合并失败');
    return result;
  }

  const subscribe = listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  async function mutate(path, body) {
    const result = await apiClient.post(path, body);
    if (result?.ok === false) throw new Error('记忆修改失败');
    return result;
  }
  const correct = (id, content) => mutate(`/api/memory/records/${encodeURIComponent(id)}`, { content });
  const forget = id => mutate(`/api/memory/records/${encodeURIComponent(id)}`, { forget: true });
  const dismissCandidate = id => mutate(`/api/memory/claims/${encodeURIComponent(id)}/revoke`, {});
  return Object.freeze({ load, add, correct, forget, dismissCandidate, consolidate, subscribe, getSnapshot: snapshot });
}
