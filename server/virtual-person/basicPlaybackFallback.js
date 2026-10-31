import { MUSIC_MUTATION_CAPABILITY } from '../program/musicSelectionRequest.js';

const AGENT_FAILURE_CODES = new Set([
  'AGENT_TIMEOUT', 'AGENT_ROUND_LIMIT', 'EMPTY_ASSISTANT_RESPONSE',
  'LLM_API_ERROR', 'LLM_INVALID_RESPONSE', 'LLM_TIMEOUT',
]);

const RESUME_COMMANDS = new Set(['播放', '播放歌曲', '继续播放', '继续播放歌曲', '恢复播放', '接着播放']);
const NEXT_COMMANDS = new Set(['切歌', '下一首', '切到下一首', '播放下一首']);

function exactCommand(text) {
  const value = String(text || '').normalize('NFKC').trim().replace(/[。.!！\s]+$/u, '');
  if (RESUME_COMMANDS.has(value)) return 'resume';
  if (NEXT_COMMANDS.has(value)) return 'next';
  return null;
}

/** Degraded control only after the existing AgentLoop has failed. */
export async function tryBasicPlaybackFallback(input, { getMusicService, toolRegistry } = {}) {
  const { error, userText, sessionId, requestId, roundId, virtualPersonId, userTurnId,
    groupAction, capabilities, signal, isCurrent, clientState = null } = input || {};
  if (!AGENT_FAILURE_CODES.has(error?.code) || signal?.aborted || (isCurrent && !isCurrent())) return null;
  if (groupAction?.ownerId !== virtualPersonId || !capabilities?.includes(MUSIC_MUTATION_CAPABILITY)) return null;
  const action = exactCommand(userText);
  if (!action) return null;
  const service = getMusicService?.();
  if (!service?.musicActionStatus || !service?.playbackRuntime || !toolRegistry) return null;
  const status = service.musicActionStatus({ requestId, roundId });
  if (status && status !== 'failed') return null;
  const state = service.playbackRuntime.snapshot();
  const scoped = service.playbackRuntime.listeningSnapshot(sessionId);
  if (state.activeListeningSessionId !== sessionId || scoped.active !== true) return null;
  const index = scoped.currentIndex;
  if (!Number.isInteger(index) || index < 0 || !scoped.queue?.[index]
    || scoped.queue[index].songId !== scoped.currentSongId) return null;
  if (action === 'resume' && scoped.phase !== 'paused') return null;
  if (action === 'next' && (!['playing', 'paused', 'loading'].includes(scoped.phase)
    || index + 1 >= scoped.queue.length)) return null;
  if (signal?.aborted || (isCurrent && !isCurrent())) return null;
  const outcome = await toolRegistry.execute('control_listening', { action }, {
    correlationId: requestId, requestId, roundId, sessionId, virtualPersonId, userTurnId,
    groupAction, capabilities, signal, isCurrent, userText, clientState,
  });
  if (!outcome.ok || !outcome.terminal || !outcome.presentation?.displayText) return null;
  return { finalText: outcome.presentation.displayText, rounds: 0, outcomes: [outcome], fallback: true };
}
