export class LibraryAdminService {
  constructor({ providers = {}, candidates, state } = {}) {
    this.providers = providers;
    this.candidates = candidates;
    this.state = state;
  }

  _primarySource() {
    try {
      const saved = this.state?.getPref?.('settings');
      const parsed = saved ? JSON.parse(saved) : null;
      return parsed?.primarySource || 'qq';
    } catch {
      return 'qq';
    }
  }

  async snapshot() {
    const [ncmStatus, qqStatus] = await Promise.all([
      this.providers.ncm.loginStatus(),
      this.providers.qq.loginStatus(),
    ]);
    const ncmUid = ncmStatus?.loggedIn ? ncmStatus.userId : null;
    const qqUid = qqStatus?.loggedIn ? qqStatus.userId : null;
    if (!ncmUid && !qqUid) {
      return {
        ok: true,
        candidates: [],
        counts: { ncm: { liked: 0, playlist: 0, daily: 0 }, qq: { liked: 0, playlist: 0, daily: 0 } },
        loggedIn: { ncm: false, qq: false },
        primarySource: 'qq',
        cachedAt: 0,
      };
    }
    const { list, counts, cachedAt } = await this.candidates.loadCandidates({ ncmUid, qqUid });
    return {
      ok: true,
      candidates: list,
      counts,
      loggedIn: { ncm: Boolean(ncmUid), qq: Boolean(qqUid) },
      primarySource: this._primarySource(),
      cachedAt,
    };
  }
}
