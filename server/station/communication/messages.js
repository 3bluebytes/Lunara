import { randomUUID } from 'node:crypto';

export const EventType = Object.freeze({
  /** Sanitized committed virtual-person turn; raw tool payloads and internal errors are excluded. */
  TURN_COMMITTED:              'TURN_COMMITTED',
  RADIOHOST_CREATED:                  'RADIOHOST_CREATED',
  RADIOHOST_ACTIVATED:                'RADIOHOST_ACTIVATED',
  RADIOHOST_MEMORY_UPDATED:           'RADIOHOST_MEMORY_UPDATED',
  RADIOHOST_OBSERVATION_REPORTED:     'RADIOHOST_OBSERVATION_REPORTED',
  USER_FEEDBACK_OBSERVED:      'USER_FEEDBACK_OBSERVED',
  PLAYBACK_STATE_CHANGED:      'PLAYBACK_STATE_CHANGED',
  STATION_MEMORY_UPDATED:      'STATION_MEMORY_UPDATED',
  // ↓ 新增（add-reflection-layer change）
  /** Authoritative playback observation: { observationKey, virtualPersonId, radiohostId, sessionId, programId, requestId, songId, songQuery, outcome:'completed'|'skipped'|'partial'|'banned'|'technical_failure', playedSeconds, recordedAt } */
  PLAY_OUTCOME_RECORDED:       'PLAY_OUTCOME_RECORDED',
  /** Payload: { radiohostId, memoryId, window:'short'|'long', tags:string[], confidence:number } — 不携带 content body，订阅者按 memoryId 回查 */
  REFLECTION_INSIGHT_PUBLISHED:'REFLECTION_INSIGHT_PUBLISHED',
});

export const StationAgentId = 'station';
export const radiohostAgentId = id => `radiohost:${id}`;

export function createEvent(fields) {
  if (!fields || !fields.type) throw new Error('createEvent: type required');
  if (!fields.sourceAgentId) throw new Error('createEvent: sourceAgentId required');
  return {
    id: randomUUID(),
    type: fields.type,
    sourceAgentId: fields.sourceAgentId,
    payload: fields.payload || {},
    createdAt: Date.now(),
    correlationId: fields.correlationId || undefined,
  };
}
