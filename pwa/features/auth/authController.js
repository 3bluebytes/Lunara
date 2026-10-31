// Existing provider auth routes; warnings ask this adapter about capabilities instead of naming providers.
const LOGIN_PATHS = Object.freeze({ qq: '/api/login/qq', ncm: '/api/login' });
function loginPath(source) {
  if (!Object.hasOwn(LOGIN_PATHS, source)) throw new TypeError('这个音乐源暂未提供登录入口，请在设置中检查');
  return LOGIN_PATHS[source];
}
function loggedOut() {
  return { loggedIn: false };
}

export function createAuthController({ apiClient, onChanged = () => {} } = {}) {
  if (!apiClient) throw new TypeError('auth api client is required');
  let sources = { ncm: loggedOut(), qq: loggedOut() };
  const listeners = new Set([onChanged]);

  function emit() {
    const snapshot = {
      ncm: { ...sources.ncm },
      qq: { ...sources.qq },
    };
    for (const listener of listeners) listener(snapshot);
    return snapshot;
  }

  async function refresh() {
    const health = await apiClient.get('/api/health');
    // 保留 cookieStored：loggedIn 为 false 可能只是上游核验暂时失败，
    // 首跑协调器需要凭据是否已存这一事实来决定是否弹首启设置。
    const normalize = login => ({ ...(login || {}), loggedIn: !!login?.loggedIn });
    sources = {
      ncm: health?.ncmLogin ? normalize(health.ncmLogin) : loggedOut(),
      qq: health?.qqLogin ? normalize(health.qqLogin) : loggedOut(),
    };
    return emit();
  }

  async function createQr(source = 'ncm') {
    const path = `${loginPath(source)}/qr`;
    // Creating an NCM QR session ends the existing session first, so this must
    // be a POST: a cross-site GET could otherwise log the account out.
    const result = await apiClient.post(path, {});
    if (!result?.ok || !result.key || !result.qrimg) throw new Error(result?.error || '二维码生成失败');
    return result;
  }

  function checkQr(source = 'ncm', key) {
    const path = `${loginPath(source)}/qr/check`;
    return apiClient.get(`${path}?key=${encodeURIComponent(key)}`);
  }

  async function loginWithCookie(source, cookie) {
    if (!cookie?.trim()) throw new Error('Cookie 不能为空');
    const path = `${loginPath(source)}/cookie`;
    const result = await apiClient.post(path, { cookie: cookie.trim() });
    if (!result?.loggedIn) throw new Error(result?.reason || result?.error || 'cookie 无效');
    sources = { ...sources, [source]: result };
    emit();
    return result;
  }

  async function logout(source) {
    await apiClient.post(`/api/logout?source=${encodeURIComponent(source)}`, {});
    sources = { ...sources, [source]: loggedOut() };
    emit();
    return true;
  }

  const subscribe = listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return Object.freeze({ refresh, createQr, checkQr, loginWithCookie, logout, subscribe,
    canLogin: source => Object.hasOwn(LOGIN_PATHS, source) });
}
