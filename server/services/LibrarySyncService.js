import { ServiceError } from './ServiceError.js';
import { providerRegistry } from '../music/providerRegistry.js';

const PROVIDERS = new Set(providerRegistry.defaultSourceCandidates());

function publicRun(run) {
  if (!run) return null;
  const { promise: _promise, ...rest } = run;
  return rest;
}

export class LibrarySyncService {
  constructor({ coordinator, store, providers = {}, logger = console } = {}) {
    if (!coordinator) throw new TypeError('LibrarySyncService requires coordinator');
    if (!store) throw new TypeError('LibrarySyncService requires store');
    this.coordinator = coordinator;
    this.store = store;
    this.providers = providers;
    this.logger = logger;
    this.started = false;
    this.unsubscribers = [];
  }

  _contain(label, operation) {
    void Promise.resolve().then(operation).then(result => {
      if (result?.promise) return result.promise;
      if (Array.isArray(result)) {
        return Promise.allSettled(result.map(item => item?.promise).filter(Boolean));
      }
      return null;
    }).catch(error => this.logger?.warn?.(`[library] ${label}: ${error.message}`));
  }

  start() {
    if (this.started) return { started: true, duplicate: true };
    this.started = true;
    this.coordinator.recoverStaleRuns();
    for (const provider of PROVIDERS) {
      const module = this.providers[provider];
      if (typeof module?.onCookieChange !== 'function') continue;
      const unsubscribe = module.onCookieChange(() => {
        this._contain(`${provider} cookie discovery failed`, () => this.coordinator.discover(provider, { trigger: 'cookie' }));
      });
      if (typeof unsubscribe === 'function') this.unsubscribers.push(unsubscribe);
    }
    this._contain('startup identity discovery failed', () => this.coordinator.discoverAll({ trigger: 'startup' }));
    return { started: true, duplicate: false };
  }

  stop() {
    if (!this.started && this.unsubscribers.length === 0) return { stopped: true, duplicate: true };
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      try { unsubscribe(); } catch {}
    }
    this.started = false;
    return { stopped: true, duplicate: false };
  }

  async import({ provider } = {}) {
    const name = String(provider || '').trim();
    if (!PROVIDERS.has(name)) throw new ServiceError(400, 'provider must be ncm or qq', 'invalid_provider');
    const run = await this.coordinator.requestImport(name, { trigger: 'manual' });
    if (run?.error && !run?.source) throw new ServiceError(409, run.error, 'provider_not_logged_in');
    const accountUid = run?.source?.account_uid || this.coordinator.currentAccountUid(name);
    return {
      ok: true,
      provider: name,
      accountUid,
      ...publicRun(run),
      source: accountUid ? this.store.sourceStatus(name, accountUid) : null,
    };
  }

  async status() {
    const identities = await Promise.all([...PROVIDERS].map(async provider => {
      try { return await this.coordinator.resolveCurrent(provider); }
      catch (error) { return { provider, accountUid: null, error: error.message }; }
    }));
    const current = new Map(identities.map(identity => [identity.provider, identity.accountUid || null]));
    const sources = this.store.allSourceStatuses().map(source => ({
      ...source,
      current_source: current.get(source.provider) === source.account_uid,
      running: this.coordinator.isRunning(source.provider, source.account_uid),
      stale: source.run_started_at != null && !this.coordinator.isRunning(source.provider, source.account_uid),
    }));
    return { ok: true, sources };
  }

  periodic() {
    return this.coordinator.syncAllCurrent({ weekly: false });
  }

  weekly() {
    return this.coordinator.syncAllCurrent({ weekly: true });
  }
}
