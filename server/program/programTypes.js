export const ProgramMode = Object.freeze({
  EXPLICIT: 'explicit',
  CURATED: 'curated',
});

export const ProgramStage = Object.freeze({
  CANDIDATE: 'candidate',
  RESOLVED: 'resolved',
  COMMITTED: 'committed',
});

const candidatePrograms = new WeakSet();
const resolvedPrograms = new WeakSet();
const committedPrograms = new WeakSet();
const MODES = new Set(Object.values(ProgramMode));

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function requiredString(value, field) {
  const result = String(value ?? '').trim();
  if (!result) throw new TypeError(`${field} must be a non-empty string`);
  return result;
}

function array(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return clone(value);
}

function normalizeCandidate(item, index) {
  if (!item || typeof item !== 'object') {
    throw new TypeError(`candidates[${index}] must be an object`);
  }
  return {
    candidateId: requiredString(item.candidateId, `candidates[${index}].candidateId`),
    query: requiredString(item.query, `candidates[${index}].query`),
    sourceSongId: item.sourceSongId == null ? null : String(item.sourceSongId),
    genericReason: String(item.genericReason || ''),
    evidence: clone(item.evidence ?? null),
    orderedTarget: clone(item.orderedTarget ?? null),
  };
}

function normalizeResolvedTrack(track, index) {
  if (!track || typeof track !== 'object') {
    throw new TypeError(`tracks[${index}] must be an object`);
  }
  return {
    candidateId: requiredString(track.candidateId, `tracks[${index}].candidateId`),
    songId: requiredString(track.songId, `tracks[${index}].songId`),
    title: requiredString(track.title, `tracks[${index}].title`),
    artist: requiredString(track.artist, `tracks[${index}].artist`),
    url: requiredString(track.url, `tracks[${index}].url`),
    source: requiredString(track.source, `tracks[${index}].source`),
    duration: Number.isFinite(Number(track.duration)) ? Number(track.duration) : 0,
    album: String(track.album || ''),
    artwork: String(track.artwork || ''),
    lyric: clone(track.lyric ?? { lrc: '', tlyric: '' }),
    cached: track.cached === true,
    substitutedFrom: track.substitutedFrom == null ? null : clone(track.substitutedFrom),
    evidence: clone(track.evidence ?? null),
  };
}

export function createCandidateProgram(input = {}) {
  const mode = String(input.mode || '').trim();
  if (!MODES.has(mode)) throw new TypeError(`mode must be one of: ${[...MODES].join(', ')}`);
  const requestedCount = Number(input.requestedCount);
  if (!Number.isInteger(requestedCount) || requestedCount < 1) {
    throw new TypeError('requestedCount must be a positive integer');
  }
  if (!Array.isArray(input.candidates)) throw new TypeError('candidates must be an array');

  const program = deepFreeze({
    stage: ProgramStage.CANDIDATE,
    requestId: requiredString(input.requestId, 'requestId'),
    mode,
    requestedCount,
    genericSegments: array(input.genericSegments, 'genericSegments'),
    constraints: clone(input.constraints ?? {}),
    candidates: input.candidates.map(normalizeCandidate),
    createdAt: Number.isFinite(Number(input.createdAt)) ? Number(input.createdAt) : Date.now(),
    metadata: clone(input.metadata ?? {}),
  });
  candidatePrograms.add(program);
  return program;
}

export function createResolvedProgram(candidateProgram, input = {}) {
  if (!candidatePrograms.has(candidateProgram)) {
    throw new TypeError('createResolvedProgram requires a CandidateProgram');
  }
  if (!Array.isArray(input.tracks)) throw new TypeError('tracks must be an array');

  const program = deepFreeze({
    stage: ProgramStage.RESOLVED,
    requestId: candidateProgram.requestId,
    mode: candidateProgram.mode,
    requestedCount: candidateProgram.requestedCount,
    genericSegments: clone(candidateProgram.genericSegments),
    constraints: clone(candidateProgram.constraints),
    tracks: input.tracks.map(normalizeResolvedTrack),
    failures: array(input.failures, 'failures'),
    resolution: clone(input.resolution ?? {}),
    candidateCreatedAt: candidateProgram.createdAt,
    resolvedAt: Number.isFinite(Number(input.resolvedAt)) ? Number(input.resolvedAt) : Date.now(),
    metadata: clone(candidateProgram.metadata),
  });
  resolvedPrograms.add(program);
  return program;
}

export function createCommittedProgram(resolvedProgram, input = {}) {
  if (!resolvedPrograms.has(resolvedProgram)) {
    throw new TypeError('createCommittedProgram requires a ResolvedProgram');
  }
  if (resolvedProgram.tracks.length === 0) {
    throw new TypeError('CommittedProgram requires at least one resolved track');
  }

  const program = deepFreeze({
    stage: ProgramStage.COMMITTED,
    programId: requiredString(input.programId, 'programId'),
    requestId: resolvedProgram.requestId,
    mode: resolvedProgram.mode,
    requestedCount: resolvedProgram.requestedCount,
    text: String(input.text || ''),
    segments: array(input.segments, 'segments'),
    narrationItems: array(input.narrationItems, 'narrationItems'),
    tracks: clone(resolvedProgram.tracks),
    failures: clone(resolvedProgram.failures),
    resolution: clone(resolvedProgram.resolution),
    committedAt: Number.isFinite(Number(input.committedAt)) ? Number(input.committedAt) : Date.now(),
    metadata: clone(resolvedProgram.metadata),
  });
  committedPrograms.add(program);
  return program;
}

export function isCandidateProgram(value) {
  return candidatePrograms.has(value);
}
