import { providerRegistry } from '../music/providerRegistry.js';

// 源名单来自注册表：新增一个音乐源不再需要在库层再改一处白名单。
const PROVIDERS = new Set(providerRegistry.defaultSourceCandidates());

function providerModule(providers, provider) {
  const name = String(provider || '').trim();
  if (!PROVIDERS.has(name) || !providers[name]) {
    throw new Error(`unsupported library provider: ${name || '(empty)'}`);
  }
  return { name, module: providers[name] };
}

function incomplete(error, items = [], reportedCount = null) {
  return {
    items: Array.isArray(items) ? items : [],
    complete: false,
    reportedCount: Number.isFinite(Number(reportedCount)) ? Number(reportedCount) : null,
    fetchedCount: Array.isArray(items) ? items.length : 0,
    error: String(error?.message || error || 'provider snapshot failed'),
  };
}

function validateSnapshot(snapshot, label) {
  if (!snapshot || !Array.isArray(snapshot.items)) {
    return incomplete(`${label}: invalid snapshot shape`);
  }
  const fetchedCount = snapshot.items.length;
  const reportedCount = Number.isFinite(Number(snapshot.reportedCount))
    ? Number(snapshot.reportedCount)
    : fetchedCount;
  const complete = snapshot.complete === true && fetchedCount === reportedCount;
  return {
    items: snapshot.items,
    complete,
    reportedCount,
    fetchedCount,
    error: complete ? null : String(snapshot.error || `${label}: count mismatch ${fetchedCount}/${reportedCount}`),
  };
}

export class ProviderAdapters {
  constructor({ providers = {} } = {}) {
    this.providers = providers;
  }

  async resolveAccountIdentity(provider) {
    const { name, module } = providerModule(this.providers, provider);
    try {
      const status = await module.loginStatus();
      const accountUid = status?.loggedIn && status?.userId != null
        ? String(status.userId).trim()
        : '';
      if (!accountUid) {
        return { provider: name, accountUid: null, error: status?.reason || 'no verified account uid' };
      }
      return { provider: name, accountUid, error: null };
    } catch (error) {
      return { provider: name, accountUid: null, error: String(error?.message || error) };
    }
  }

  async fetchPlaylistsSnapshot(provider, accountUid) {
    const { name, module } = providerModule(this.providers, provider);
    try {
      if (typeof module.libraryPlaylistsSnapshot !== 'function') {
        throw new Error(`${name} strict playlist snapshot is unavailable`);
      }
      return validateSnapshot(await module.libraryPlaylistsSnapshot(accountUid), `${name} playlists`);
    } catch (error) {
      return incomplete(error);
    }
  }

  async fetchPlaylistTracksSnapshot(provider, playlist, accountUid) {
    const { name, module } = providerModule(this.providers, provider);
    const playlistId = String(playlist?.id ?? playlist?.playlist_id ?? '').trim();
    if (!playlistId) return incomplete(`${name} tracks: playlist id is required`);
    const reportedCount = playlist?.trackCount ?? playlist?.remote_track_count ?? null;
    try {
      if (typeof module.libraryTracksSnapshot !== 'function') {
        throw new Error(`${name} strict track snapshot is unavailable`);
      }
      return validateSnapshot(
        await module.libraryTracksSnapshot(playlistId, { reportedCount, accountUid }),
        `${name} playlist ${playlistId}`,
      );
    } catch (error) {
      return incomplete(error, [], reportedCount);
    }
  }
}

export function createProviderAdapters(options) {
  return new ProviderAdapters(options);
}
