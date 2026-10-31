// AuthService.js — provider-neutral login orchestration used by HTTP routes.

function normalizeSource(source) {
  return String(source || 'ncm').toLowerCase() === 'qq' ? 'qq' : 'ncm';
}

export class AuthService {
  constructor({
    providers = {},
    prefs,
    onLoggedIn = () => {},
  } = {}) {
    this.providers = providers;
    this.prefs = prefs;
    this.onLoggedIn = onLoggedIn;
  }

  _provider(source) {
    const normalized = normalizeSource(source);
    const provider = this.providers[normalized];
    if (!provider) throw new Error(`${normalized} auth provider unavailable`);
    return { source: normalized, provider };
  }

  _saveCookie(source, cookie) {
    this.prefs?.setPref?.(`${source}_cookie`, String(cookie || ''));
  }

  _notifyLoggedIn(source, status) {
    if (!status?.loggedIn) return;
    try {
      const pending = this.onLoggedIn({
        source,
        userId: status.userId,
        nickname: status.nickname || '',
      });
      Promise.resolve(pending).catch(() => {});
    } catch {}
  }

  async loginWithCookie(source, cookie) {
    const normalizedCookie = String(cookie || '').trim();
    if (!normalizedCookie) throw new TypeError('empty cookie');

    const { source: normalized, provider } = this._provider(source);
    const previousCookie = provider.getCookie?.() || '';
    provider.setCookie(normalizedCookie);

    const status = await provider.loginStatus();
    if (!status?.loggedIn) {
      if (previousCookie) provider.setCookie(previousCookie);
      else provider.clearCookie?.();
      return { ok: true, loggedIn: false, reason: status?.reason };
    }

    this._saveCookie(normalized, normalizedCookie);
    this._notifyLoggedIn(normalized, status);

    return {
      ok: true,
      loggedIn: true,
      userId: status.userId,
      nickname: status.nickname || '',
      avatarUrl: status.avatarUrl || '',
      vipType: status.vipType || 0,
    };
  }

  async logout(source) {
    const { source: normalized, provider } = this._provider(source);
    await provider.logout();
    this._saveCookie(normalized, '');
    return { ok: true, source: normalized };
  }

  async startQr(source) {
    const { source: normalized, provider } = this._provider(source);
    // NCM historically requires a clean provider session before creating a QR.
    // QQ keeps the current verified session until the new scan succeeds, so a
    // QR generation/check failure cannot silently log out the current account.
    if (normalized === 'ncm' && provider.getCookie?.()) {
      try { await provider.logout(); } catch {}
      this._saveCookie(normalized, '');
    }
    const key = await provider.qrKey();
    if (!key) throw new Error('qr key failed');
    const { qrimg } = await provider.qrCreate(key);
    return { ok: true, key, qrimg };
  }

  async checkQr(source, key) {
    const { source: normalized, provider } = this._provider(source);
    const result = await provider.qrCheck(String(key || '').trim());
    if (result?.code === 803 && result.cookie) {
      const { cookie: _secret, ...publicResult } = result;
      const login = await this.loginWithCookie(normalized, result.cookie);
      if (!login.loggedIn) {
        return { ok: false, code: 500, error: login.reason || '扫码凭证校验失败' };
      }
      return { ok: true, ...publicResult, ...login };
    }
    const { cookie: _secret, ...publicResult } = result || {};
    return { ok: true, ...publicResult };
  }
}
