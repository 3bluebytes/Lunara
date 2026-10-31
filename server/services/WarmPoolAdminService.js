import { ServiceError } from './ServiceError.js';

export class WarmPoolAdminService {
  constructor({ getStation } = {}) {
    this.getStation = getStation;
  }

  _pool(statusCode = 503) {
    const pool = this.getStation?.()?.getWarmPoolService?.();
    if (!pool) throw new ServiceError(statusCode, 'warm pool not initialized', 'warm_pool_unavailable');
    return pool;
  }

  status() {
    try {
      return this._pool().getStatusSnapshot();
    } catch (error) {
      if (error?.code === 'warm_pool_unavailable') return { enabled: false, error: error.message };
      throw error;
    }
  }

  async refresh() {
    const pool = this._pool();
    return { ok: true, ...await pool.refresh() };
  }
}
