export function createTasteController({ apiClient } = {}) {
  if (!apiClient) throw new TypeError('taste api client is required');

  async function status() {
    const result = await apiClient.get('/api/taste/status');
    if (result?.ok === false) throw new Error(result.error || '品味状态加载失败');
    return result;
  }

  async function history(limit = 3) {
    const bounded = Math.max(1, Math.min(50, Number(limit) || 3));
    const result = await apiClient.get(`/api/taste/log?limit=${bounded}`);
    if (result?.ok === false) throw new Error(result.error || '品味记录加载失败');
    return result;
  }

  return Object.freeze({ status, history });
}
