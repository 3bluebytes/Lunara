import assert from 'node:assert/strict';
import test from 'node:test';
import { StationService } from './StationService.js';

test('StationService delegates radiohost lifecycle without exposing StationAgent to routes', async () => {
  const calls = [];
  const station = {
    getRadiohostRegistrySummary: () => [{ id: 'radiohost-1', name: 'Nono' }],
    getActiveRadiohost: () => ({ id: 'radiohost-1', name: 'Nono' }),
    createRadioHost: async input => { calls.push(['create', input]); return { id: 'radiohost-2', ...input }; },
    activateRadiohost: id => { calls.push(['activate', id]); return id === 'radiohost-2' ? { active: { id } } : null; },
    deleteRadioHost: async id => { calls.push(['delete', id]); return id === 'radiohost-2'; },
  };
  const service = new StationService({
    getStation: () => station,
    listVoices: () => [{ id: 'voice-1', name: 'Voice' }],
  });

  assert.deepEqual(service.list(), [{ id: 'radiohost-1', name: 'Nono' }]);
  assert.deepEqual(service.active(), { id: 'radiohost-1', name: 'Nono' });
  assert.deepEqual(await service.create({ voiceProfileId: 'voice-1' }), {
    id: 'radiohost-2', voiceProfileId: 'voice-1',
  });
  assert.deepEqual(await service.activate('radiohost-2'), { active: { id: 'radiohost-2' } });
  assert.equal(await service.delete('radiohost-2'), true);
  assert.deepEqual(service.voices(), [{ id: 'voice-1', name: 'Voice' }]);
  assert.deepEqual(calls, [
    ['create', { voiceProfileId: 'voice-1' }],
    ['activate', 'radiohost-2'],
    ['delete', 'radiohost-2'],
  ]);
});

test('StationService reports an explicit unavailable status before initialization', () => {
  const service = new StationService({ getStation: () => null });
  assert.throws(() => service.list(), error => {
    assert.equal(error.statusCode, 503);
    assert.match(error.message, /station not initialized/);
    return true;
  });
});

test('legacy StationService activation delegates to the same conversation authority', async () => {
  const calls = [];
  const current = { id: 'radiohost-2', name: 'Nono', voiceProfileId: 'voice-1' };
  const service = new StationService({
    getStation: () => ({
      activateRadiohost: () => assert.fail('must not activate the process-wide radiohost'),
    }),
    virtualPersonService: {
      activate: input => { calls.push(['session', input]); return { entity: current, session: { sessionId: input.sessionId } }; },
    },
  });

  assert.deepEqual(await service.activate('radiohost-2', 'conversation:test'), {
    current,
    session: { sessionId: 'conversation:test' },
  });
  assert.deepEqual(calls, [
    ['session', { id: 'radiohost-2', sessionId: 'conversation:test' }],
  ]);
});
