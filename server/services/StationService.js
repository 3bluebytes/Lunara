import { ServiceError } from './ServiceError.js';

export class StationService {
  constructor({ getStation = () => null, listVoices = () => [], virtualPersonService = null } = {}) {
    this.getStation = getStation;
    this.listVoices = listVoices;
    this.virtualPersonService = virtualPersonService;
  }

  _station() {
    const station = this.getStation();
    if (!station) throw new ServiceError(503, 'station not initialized', 'station_unavailable');
    return station;
  }

  list() {
    return this._station().getRadiohostRegistrySummary();
  }

  active() {
    return this._station().getActiveRadiohost();
  }

  async create(input) {
    const host = await this._station().createRadioHost(input);
    this.virtualPersonService?.syncLegacyHosts?.([host]);
    return host;
  }

  async activate(id, sessionId = 'conversation:primary') {
    if (this.virtualPersonService) {
      const result = await this.virtualPersonService.activate({ id, sessionId });
      return result ? { current: result.entity, session: result.session } : null;
    }
    return this._station().activateRadiohost(id);
  }

  async delete(id) {
    const deleted = await this._station().deleteRadioHost(id);
    if (deleted) this.virtualPersonService?.archive?.(id);
    return deleted;
  }

  voices() {
    this._station();
    return this.listVoices();
  }
}
