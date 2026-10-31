import { providerRegistry } from '../music/providerRegistry.js';

// 同步目标同样由注册表决定，避免「新源能播但永远不同步」这种静默缺口。
const PROVIDERS = providerRegistry.defaultSourceCandidates();

function keyOf(provider, accountUid) {
  return `${provider}:${accountUid}`;
}

function message(error) {
  return String(error?.message || error || 'unknown library sync error');
}

export class LibrarySyncCoordinator {
  constructor({ store, adapters, tasteBootstrap = null, trace = () => {}, onSettled = () => {} } = {}) {
    if (!store) throw new TypeError('LibrarySyncCoordinator requires store');
    if (!adapters) throw new TypeError('LibrarySyncCoordinator requires adapters');
    this.store = store;
    this.adapters = adapters;
    this.trace = trace;
    this.tasteBootstrap = tasteBootstrap;
    this.onSettled = () => { try { onSettled(); } catch { /* presentation must not change sync results */ } };
    this.liveRuns = new Map();
    this.currentUid = new Map();
  }

  isRunning(provider, accountUid) {
    return this.liveRuns.has(keyOf(provider, accountUid));
  }

  currentAccountUid(provider) {
    return this.currentUid.get(provider) || null;
  }

  recoverStaleRuns() {
    const library = this.store.recoverStaleRuns();
    const taste = this.tasteBootstrap?.recoverStaleRuns?.() || 0;
    return { library, taste };
  }

  _requestTasteBootstrap(provider, accountUid, reason) {
    try {
      const result = this.tasteBootstrap?.request?.(provider, accountUid, { reason });
      result?.promise?.catch?.(error => this.trace(`[taste-bootstrap] failed provider=${provider}: ${message(error)}`));
      return result || null;
    } catch (error) {
      this.trace(`[taste-bootstrap] request failed provider=${provider}: ${message(error)}`);
      return null;
    }
  }

  async resolveCurrent(provider) {
    const identity = await this.adapters.resolveAccountIdentity(provider);
    if (!identity?.accountUid) {
      this.currentUid.delete(provider);
      return identity;
    }
    this.currentUid.set(provider, String(identity.accountUid));
    return identity;
  }

  async discover(provider, { trigger = 'startup' } = {}) {
    const identity = await this.resolveCurrent(provider);
    if (!identity?.accountUid) {
      return { accepted: false, running: false, skipped: 'no-verified-uid', error: identity?.error || null };
    }
    const accountUid = String(identity.accountUid);
    let source = this.store.ensureSource(provider, accountUid);
    if (source.import_status === 'complete') {
      this._requestTasteBootstrap(provider, accountUid, `${trigger}-discover`);
      return { accepted: false, running: false, skipped: 'already-imported', source };
    }
    if (source.import_status === 'importing' && !this.isRunning(provider, accountUid)) {
      source = this.store.setSourceState(provider, accountUid, {
        import_status: 'partial', run_started_at: null,
        last_error: 'stale import recovered during identity discovery',
      });
    }
    return this.startImport(provider, accountUid, { trigger });
  }

  async discoverAll({ trigger = 'startup' } = {}) {
    return Promise.all(PROVIDERS.map(provider => this.discover(provider, { trigger }).catch(error => ({
      provider, accepted: false, running: false, error: message(error),
    }))));
  }

  async requestImport(provider, { trigger = 'manual' } = {}) {
    if (!PROVIDERS.includes(provider)) throw new Error(`unsupported library provider: ${provider}`);
    const identity = await this.resolveCurrent(provider);
    if (!identity?.accountUid) {
      return { accepted: false, running: false, error: identity?.error || 'not logged in' };
    }
    this.store.ensureSource(provider, identity.accountUid);
    return this.startImport(provider, identity.accountUid, { trigger });
  }

  startImport(provider, accountUid, { trigger = 'manual' } = {}) {
    const runKey = keyOf(provider, accountUid);
    const existing = this.liveRuns.get(runKey);
    if (existing) {
      return { accepted: false, running: true, joined: true, source: this.store.getSource(provider, accountUid), promise: existing };
    }
    const promise = this._runImport(provider, accountUid, { trigger });
    this.liveRuns.set(runKey, promise);
    promise.then(
      () => { this.liveRuns.delete(runKey); this.onSettled(); },
      () => { this.liveRuns.delete(runKey); this.onSettled(); },
    );
    return { accepted: true, running: true, joined: false, source: this.store.getSource(provider, accountUid), promise };
  }

  runImport(provider, accountUid, options = {}) {
    return this.startImport(provider, accountUid, options).promise;
  }

  startSync(provider, accountUid, { weekly = false, trigger = weekly ? 'weekly' : 'periodic' } = {}) {
    const runKey = keyOf(provider, accountUid);
    const existing = this.liveRuns.get(runKey);
    if (existing) return { accepted: false, running: true, joined: true, promise: existing };
    const promise = this._runSync(provider, accountUid, { weekly, trigger });
    this.liveRuns.set(runKey, promise);
    promise.then(
      () => { this.liveRuns.delete(runKey); this.onSettled(); },
      () => { this.liveRuns.delete(runKey); this.onSettled(); },
    );
    return { accepted: true, running: true, joined: false, promise };
  }

  runSync(provider, accountUid, options = {}) {
    return this.startSync(provider, accountUid, options).promise;
  }

  async syncCurrent(provider, { weekly = false } = {}) {
    const identity = await this.resolveCurrent(provider);
    if (!identity?.accountUid) return { skipped: 'no-verified-uid', error: identity?.error || null };
    const source = this.store.ensureSource(provider, identity.accountUid);
    if (source.import_status !== 'complete') {
      return this.runImport(provider, identity.accountUid, { trigger: weekly ? 'weekly-resume' : 'periodic-resume' });
    }
    return this.runSync(provider, identity.accountUid, { weekly });
  }

  async syncAllCurrent({ weekly = false } = {}) {
    return Promise.all(PROVIDERS.map(provider => this.syncCurrent(provider, { weekly }).catch(error => ({
      provider, error: message(error),
    }))));
  }

  async _runImport(provider, accountUid, { trigger } = {}) {
    this.trace(`[library] import start provider=${provider} trigger=${trigger}`);
    this.store.beginRun(provider, accountUid, { kind: 'import' });
    let playlistSnapshot;
    try {
      playlistSnapshot = await this.adapters.fetchPlaylistsSnapshot(provider, accountUid);
    } catch (error) {
      this.store.failImport(provider, accountUid, message(error));
      return { complete: false, failed: true, error: message(error) };
    }
    const items = Array.isArray(playlistSnapshot?.items) ? playlistSnapshot.items : [];
    if (!playlistSnapshot?.complete && items.length === 0) {
      const error = playlistSnapshot?.error || 'playlist list snapshot incomplete';
      this.store.failImport(provider, accountUid, error);
      return { complete: false, failed: true, error };
    }

    this.store.reconcilePlaylistSet(provider, accountUid, items, { complete: playlistSnapshot.complete === true });
    const failures = [];
    for (const playlist of items) {
      try {
        const snapshot = await this.adapters.fetchPlaylistTracksSnapshot(provider, playlist, accountUid);
        this.store.reconcileTracks(provider, accountUid, playlist, snapshot.items, {
          complete: snapshot.complete === true,
          error: snapshot.error,
        });
        if (!snapshot.complete) failures.push(`${playlist.id}: ${snapshot.error || 'incomplete snapshot'}`);
      } catch (error) {
        const reason = message(error);
        failures.push(`${playlist.id}: ${reason}`);
        this.store.setPlaylistState(provider, accountUid, playlist.id, { sync_status: 'failed', last_error: reason });
      }
    }
    if (!playlistSnapshot.complete) failures.unshift(playlistSnapshot.error || 'playlist list incomplete');
    const complete = playlistSnapshot.complete === true && failures.length === 0;
    this.store.finishImport(provider, accountUid, {
      complete,
      error: complete ? null : failures.join('; '),
    });
    if (complete) this._requestTasteBootstrap(provider, accountUid, 'import-complete');
    this.trace(`[library] import finish provider=${provider} complete=${complete}`);
    return { complete, failed: false, playlists: items.length, errors: failures };
  }

  async _runSync(provider, accountUid, { weekly, trigger } = {}) {
    if (this.currentAccountUid(provider) && this.currentAccountUid(provider) !== String(accountUid)) {
      return { skipped: 'not-current-account' };
    }
    this.trace(`[library] sync start provider=${provider} trigger=${trigger}`);
    this.store.beginRun(provider, accountUid, { kind: 'sync' });
    let playlistSnapshot;
    try {
      playlistSnapshot = await this.adapters.fetchPlaylistsSnapshot(provider, accountUid);
    } catch (error) {
      this.store.failSync(provider, accountUid, message(error));
      return { complete: false, failed: true, error: message(error) };
    }
    const items = Array.isArray(playlistSnapshot?.items) ? playlistSnapshot.items : [];
    this.store.reconcilePlaylistSet(provider, accountUid, items, { complete: playlistSnapshot?.complete === true });
    const failures = [];
    let fetched = 0;
    let skippedByCount = 0;
    for (const playlist of items) {
      const remoteCount = Number(playlist?.trackCount);
      const localCount = this.store.activeMembershipCount(provider, accountUid, playlist.id);
      const countKnown = Number.isFinite(remoteCount);
      if (!weekly && countKnown && remoteCount === localCount) {
        skippedByCount += 1;
        continue;
      }
      fetched += 1;
      try {
        const snapshot = await this.adapters.fetchPlaylistTracksSnapshot(provider, playlist, accountUid);
        this.store.reconcileTracks(provider, accountUid, playlist, snapshot.items, {
          complete: snapshot.complete === true,
          error: snapshot.error,
        });
        if (!snapshot.complete) failures.push(`${playlist.id}: ${snapshot.error || 'incomplete snapshot'}`);
      } catch (error) {
        const reason = message(error);
        failures.push(`${playlist.id}: ${reason}`);
        this.store.setPlaylistState(provider, accountUid, playlist.id, { sync_status: 'failed', last_error: reason });
      }
    }
    if (!playlistSnapshot?.complete) failures.unshift(playlistSnapshot?.error || 'playlist list incomplete');
    const complete = playlistSnapshot?.complete === true && failures.length === 0;
    this.store.finishSync(provider, accountUid, { complete, error: complete ? null : failures.join('; ') });
    if (complete) this._requestTasteBootstrap(provider, accountUid, 'sync-complete');
    this.trace(`[library] sync finish provider=${provider} complete=${complete}`);
    return { complete, failed: false, weekly, playlists: items.length, fetched, skippedByCount, errors: failures };
  }
}
