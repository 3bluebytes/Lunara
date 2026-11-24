import { existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as llm from '../llm.js';
import { clearPersonaCache, personaPath } from '../persona/personaLoader.js';
import { getPersonaPreset } from '../persona/personaPresets.js';
import { normalizePresenceSetting } from '../presence/presenceTemperament.js';
import { PlaybackPhase } from '../playback/playbackRuntimeTypes.js';
import { ServiceError } from '../services/ServiceError.js';
import { buildPersonaExpandPrompt, extractExpandedPersonaDocument } from '../station/PersonaGenerator.js';
import {
  ROOT_ID,
  ROOT_PERSONA,
  ROOT_RELATIONSHIP,
  extractRelationshipStance,
} from './VirtualPersonRegistry.js';
import { publicRecommendation } from '../presence/ambientRecommendations.js';
import { toPlainText } from '../tts/performance/markers.js';
import { parseRoleplaySegments, sanitizeSpeechForTts } from './roleplaySpeech.js';
import { beatSpokenText, isMixedRoleplayBeats, toSpeechPerformance } from './replyBeats.js';

function mapSynthesisError(error) {
  if (error instanceof ServiceError) return error;
  const code = error?.code || '';
  if (code === 'TTS_CREDIT_EXHAUSTED') return new ServiceError(402, '语音接口额度已用尽，请检查后重试。', 'tts_credit_exhausted');
  if (code === 'TTS_AUTH_FAILED') return new ServiceError(502, '语音接口鉴权失败，请检查设置中的 API Key。', 'tts_auth_failed');
  if (code === 'TTS_RATE_LIMITED' || code === 'TTS_UPSTREAM_BUSY') return new ServiceError(429, '语音服务暂时繁忙，请稍后再试。', 'tts_rate_limited');
  if (code === 'TTS_PROVIDER_UNAVAILABLE') return new ServiceError(503, '当前角色绑定的声音暂不可用，请检查语音设置。', 'tts_unavailable');
  return new ServiceError(503, '这次语音合成没有成功，稍后再试一次。', 'tts_synthesis_failed');
}

const SINGLE_LINE_CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const MULTILINE_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

function normalizePersonaText(value, fieldName = 'personaDocument', max = 4000) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (MULTILINE_CONTROL_RE.test(text)) {
    throw new TypeError(`invalid ${fieldName}: control characters are not allowed`);
  }
  if (text.length > max) {
    throw new TypeError(`${fieldName} exceeds ${max} characters`);
  }
  return text;
}

function audioHashFromUrl(url) {
  const clean = String(url || '').trim().split(/[?#]/)[0];
  const match = /^\/tts\/([a-zA-Z0-9_-]+)\.(?:wav|mp3)$/i.exec(clean);
  return match ? match[1] : null;
}

function required(value, name, max = 256) {
  const text = String(value || '').trim();
  if (!text) throw new TypeError(`${name} is required`);
  return text.slice(0, max);
}

export class VirtualPersonService {
  constructor({ registry, conversationStore, createRadiohost = null, loadPersona = () => '', runtime = null, playbackRuntime = null,
    countMemories = null, purgeMemories = null, deletePersonaFile = null, savePersonaFile = null, unregisterLegacyHost = null,
    onRoomDeleted = null, resolveVoiceProfile = null, ambientRecommendations = null,
    ttsLifecycle = null, synthesizeSpeech = null, askText = null } = {}) {
    if (!registry) throw new TypeError('VirtualPersonService requires registry');
    if (!conversationStore) throw new TypeError('VirtualPersonService requires conversationStore');
    this.registry = registry;
    this.conversationStore = conversationStore;
    this.createRadiohost = createRadiohost;
    this.runtime = runtime;
    this.playbackRuntime = playbackRuntime;
    this.loadPersona = loadPersona;
    // 删除伙伴需要跨越记忆 / 文件 / 遗留注册项三类存储。它们不属于本服务的职责，
    // 因此以回调注入，与本类已有的 createRadiohost / loadPersona 注入方式一致。
    this.countMemories = countMemories || (() => 0);
    this.purgeMemories = purgeMemories || (() => 0);
    this.deletePersonaFile = deletePersonaFile || (() => false);
    this.savePersonaFile = typeof savePersonaFile === 'function' ? savePersonaFile : null;
    this.unregisterLegacyHost = unregisterLegacyHost || (() => false);
    // 诊断副本的生命周期跟随会话删除：DB 删除成功后通知清理（盘点由组合根负责）。
    this.onRoomDeleted = typeof onRoomDeleted === 'function' ? onRoomDeleted : null;
    // 声音身份目录在 station 层，本类不反向依赖；注入解析函数后，
    // 编辑声音时才能拒绝"写进去就再也解析不到"的未知引用。未注入则不校验。
    this.resolveVoiceProfile = typeof resolveVoiceProfile === 'function' ? resolveVoiceProfile : null;
    // ambient 推荐（add-ambient-music-recommendation）：展示实时状态与「放这首」确认。未注入时没有推荐卡片动作。
    this.ambientRecommendations = ambientRecommendations;
    this.ttsLifecycle = ttsLifecycle;
    this.synthesizeSpeech = typeof synthesizeSpeech === 'function' ? synthesizeSpeech : null;
    this.askText = typeof askText === 'function' ? askText : null;
    this._speechInFlight = new Map();
    this.initialized = false;
  }

  initialize() {
    if (this.initialized && this.registry.db && this.conversationStore.db) return this;
    this.registry.initialize();
    this.conversationStore.initialize();
    this.initialized = true;
    return this;
  }

  list({ includeArchived = false } = {}) {
    this.initialize();
    return this.registry.list({ includeArchived });
  }

  syncLegacyHosts(hosts = []) {
    this.initialize();
    this.registry.importRadioHosts(hosts, this.loadPersona);
    return hosts.map(host => this.registry.get(host.id)).filter(Boolean);
  }

  get(id) {
    this.initialize();
    return this.registry.get(required(id, 'virtualPersonId', 128));
  }

  transcript(sessionId, { limit = 100, beforeSequence = null } = {}) {
    this.initialize();
    const sid = required(sessionId, 'sessionId', 128);
    const room = this.conversationStore.getSession(sid);
    return this.conversationStore.listTurns(sid, {
      limit: Math.max(1, Math.min(Number(limit) || 100, 500)),
      visibleOnly: true,
      beforeSequence,
    }).map(turn => {
      const presentation = turn.message.presentation || null;
      // Track-intro turns created before queueItemId became explicit still have
      // the occurrence identity in their stable turn id.
      const queueItemId = turn.message.queueItemId
        || (presentation === 'track_intro' && turn.turnId.startsWith('intro:queue:')
          ? turn.turnId.slice('intro:'.length) : null);
      const isUnseparatedFallback = this._isUnseparatedRoleplayFallbackTurn(turn, room);
      const hasBeats = Array.isArray(turn.message?.beats) && turn.message.beats.length > 0
        && turn.role === 'assistant' && presentation !== 'track_intro' && !turn.message?.technicalFailure
        && !isUnseparatedFallback;
      const beatsProjection = hasBeats ? this._projectBeatsTurnVoice(turn) : null;
      const resolvedSpeech = hasBeats ? null : this._resolveTurnSpeechAndSegments(turn, room);
      const voice = hasBeats ? beatsProjection.voice : this._projectTurnVoice(turn, room, resolvedSpeech);
      return {
        turnId: turn.turnId,
        conversationId: turn.sessionId,
        sequence: turn.sequence,
        role: turn.role,
        speakerVirtualPersonId: turn.speakerVirtualPersonId,
        text: turn.visibleText,
        ...(presentation ? { presentation } : {}),
        ...(queueItemId ? { queueItemId } : {}),
        ...(turn.message.tracks ? { tracks: turn.message.tracks } : {}),
        // 群聊交接关系（「回复 X」）：只是展示元数据，不进入模型历史。
        ...(turn.message.groupFloor ? { groupFloor: turn.message.groupFloor } : {}),
        // 主持建议：确认按钮刷新后仍在；是否已应用由客户端对照房间当前伙伴判断。
        ...(turn.message.hostSuggestion ? { hostSuggestion: turn.message.hostSuggestion } : {}),
        ...(turn.message.webSources ? { webSources: turn.message.webSources } : {}),
        // ambient 推荐卡片：状态以推荐表为准（过期是惰性判定的）。
        ...(turn.message.musicRecommendation ? { musicRecommendation: publicRecommendation(turn.message.musicRecommendation,
          this._recommendationView(turn.turnId)) } : {}),
        ...(beatsProjection ? { beats: beatsProjection.beats } : {}),
        ...(!hasBeats && resolvedSpeech?.segments ? { segments: resolvedSpeech.segments } : {}),
        ...(voice ? { voice } : {}),
        createdAt: turn.createdAt,
      };
    });
  }

  _isUnseparatedRoleplayFallbackTurn(turn, room = null) {
    if (room?.interactionMode !== 'roleplay') return false;
    // 有无括号都算：叙述 + 引号对白混在一拍里的旧回合，朗读只念解析出的台词。
    return isMixedRoleplayBeats(turn?.message?.beats);
  }

  _projectBeatsTurnVoice(turn) {
    const rawBeats = Array.isArray(turn?.message?.beats) ? turn.message.beats : [];
    const projectedBeats = rawBeats.map((beat, idx) => {
      const spoken = beatSpokenText(beat);
      const rawUrl = spoken && beat.audioUrl ? String(beat.audioUrl) : null;
      const aliveUrl = rawUrl && (!this.ttsLifecycle || this.ttsLifecycle.existsByUrl(rawUrl)) ? rawUrl : null;
      const next = {
        ...beat,
        index: Number.isInteger(beat.index) ? beat.index : idx,
      };
      if (aliveUrl) {
        next.audioUrl = aliveUrl;
      } else {
        delete next.audioUrl;
        delete next.hash;
        delete next.durationMs;
      }
      return next;
    });
    const speakable = projectedBeats.filter(beat => Boolean(beatSpokenText(beat)));
    const ready = speakable.filter(beat => Boolean(beat.audioUrl));
    if (!speakable.length && !ready.length) {
      return { beats: projectedBeats, voice: null };
    }
    const status = ready.length === speakable.length
      ? 'ready'
      : (ready.length > 0 ? 'partial' : 'missing');
    const firstUrl = ready[0]?.audioUrl || null;
    const durations = ready.map(beat => beat.durationMs).filter(Number.isFinite);
    const totalDurationMs = durations.length ? durations.reduce((sum, ms) => sum + ms, 0) : null;
    const voiceBeats = projectedBeats.map(beat => {
      const spoken = beatSpokenText(beat);
      if (!spoken && !beat.audioUrl) {
        return { index: beat.index, canSynthesize: false, status: 'none', audioUrl: null, durationMs: null };
      }
      return {
        index: beat.index,
        canSynthesize: Boolean(spoken),
        status: beat.audioUrl ? 'ready' : 'missing',
        audioUrl: beat.audioUrl || null,
        durationMs: beat.audioUrl && Number.isFinite(beat.durationMs) ? beat.durationMs : null,
      };
    });
    return {
      beats: projectedBeats,
      voice: {
        canSynthesize: true,
        status,
        url: firstUrl,
        audioUrl: firstUrl,
        durationMs: totalDurationMs,
        beats: voiceBeats,
      },
    };
  }

  _resolveTurnSpeechAndSegments(turn, room = null) {
    if (!turn || turn.role !== 'assistant' || turn.message?.presentation === 'track_intro'
      || turn.message?.technicalFailure) {
      return { segments: turn?.message?.segments || null, spokenText: '', isRoleplayTurn: false };
    }
    const stored = turn.message?.voice && typeof turn.message.voice === 'object' ? turn.message.voice : null;
    const isRoleplayTurn = room?.interactionMode === 'roleplay' || Array.isArray(turn.message?.segments);
    if (isRoleplayTurn) {
      const parsed = parseRoleplaySegments(turn.visibleText || '');
      const spokenText = parsed.hasSpeech ? toPlainText(sanitizeSpeechForTts(parsed.spokenText || '')).trim() : '';
      return {
        segments: parsed.hasAction ? parsed.segments : null,
        spokenText,
        isRoleplayTurn: true,
      };
    }
    const radioFallback = String(turn.visibleText || '')
      .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1')
      .replace(/https?:\/\/[^\s<>]+/g, '')
      .trim();
    const spokenText = stored?.spokenText !== undefined
      ? String(stored.spokenText || '').trim()
      : radioFallback;
    return { segments: null, spokenText, isRoleplayTurn: false };
  }

  _existingAudioUrl(stored, resolved) {
    const spokenMatches = !resolved.isRoleplayTurn
      || stored?.spokenText === undefined
      || String(stored.spokenText || '').trim() === resolved.spokenText;
    const rawUrl = spokenMatches ? (stored?.audioUrl || null) : null;
    return rawUrl && (!this.ttsLifecycle || this.ttsLifecycle.existsByUrl(rawUrl)) ? rawUrl : null;
  }

  _projectTurnVoice(turn, room = null, resolvedSpeech = null) {
    if (!turn || turn.role !== 'assistant' || turn.message?.presentation === 'track_intro') return null;
    const resolved = resolvedSpeech || this._resolveTurnSpeechAndSegments(turn, room);
    const stored = turn.message?.voice && typeof turn.message.voice === 'object' ? turn.message.voice : null;
    const spokenText = resolved.spokenText;
    const audioUrl = this._existingAudioUrl(stored, resolved);
    if (!spokenText && !audioUrl) return null;
    return {
      canSynthesize: true,
      status: audioUrl ? 'ready' : 'missing',
      url: audioUrl,
      audioUrl,
      durationMs: audioUrl ? (stored?.durationMs ?? null) : null,
    };
  }

  async _syncPlaybackInteractionMode(sessionId, interactionMode) {
    if (typeof this.playbackRuntime?.submit !== 'function') return;
    const modeId = interactionMode === 'roleplay' ? 'music_only' : null;
    await this.playbackRuntime.submit({
      type: 'COMPANION_MODE_CHANGED',
      eventId: `room-mode:${sessionId}:${interactionMode}:${Date.now()}`,
      requestId: `room-mode:${sessionId}:${interactionMode}:${Date.now()}`,
      listeningSessionId: sessionId,
      modeId,
      modeSource: 'explicit',
    });
  }

  /** 对单个助手消息按需合成语音（仅念台词，剥除舞台动作），并发去重并在成功后持久化音频引用。 */
  async synthesizeTurnSpeech(sessionId, turnId) {
    this.initialize();
    const sid = required(sessionId, 'sessionId', 128);
    const tid = required(turnId, 'turnId', 256);
    const room = this.conversationStore.getSession(sid);
    if (!room) throw new ServiceError(404, '找不到这个聊天。', 'conversation_not_found');
    const turn = this.conversationStore.getTurn(tid);
    if (!turn || turn.sessionId !== sid || turn.supersededAt || turn.role !== 'assistant'
      || turn.message?.presentation === 'track_intro' || turn.message?.technicalFailure) {
      throw new ServiceError(404, '找不到这条可以朗读的消息。', 'turn_not_found');
    }
    const isUnseparatedFallback = this._isUnseparatedRoleplayFallbackTurn(turn, room);
    if (Array.isArray(turn.message?.beats) && turn.message.beats.length > 0 && !isUnseparatedFallback) {
      return this._synthesizeBeatsTurnSpeech(sid, tid, turn, room);
    }
    const stored = turn.message?.voice && typeof turn.message.voice === 'object' ? turn.message.voice : null;
    const resolved = this._resolveTurnSpeechAndSegments(turn, room);
    const spokenText = resolved.spokenText;
    if (!spokenText) {
      throw new ServiceError(409, '这一段只有动作与神态描写，没有可朗读的台词。', 'turn_has_no_speech');
    }
    const existingUrl = this._existingAudioUrl(stored, resolved);
    if (existingUrl) {
      this.ttsLifecycle?.touchByUrl?.(existingUrl);
      return { audioUrl: existingUrl, durationMs: stored?.durationMs ?? null, cached: true };
    }
    if (!this.synthesizeSpeech) {
      throw new ServiceError(503, '语音服务暂未就绪，请检查语音设置后重试。', 'tts_unavailable');
    }
    if (this._speechInFlight.has(tid)) return this._speechInFlight.get(tid);

    const task = (async () => {
      const entity = this.registry.get(turn.speakerVirtualPersonId);
      const voiceProfileId = entity?.voiceProfileId || stored?.voiceProfileId || null;
      const previousHash = stored?.hash || audioHashFromUrl(stored?.audioUrl);
      let audio = null;
      try {
        audio = await this.synthesizeSpeech({
          text: spokenText,
          voiceProfileId,
          allowFallback: !resolved.isRoleplayTurn,
        });
      } catch (error) {
        throw mapSynthesisError(error);
      }
      if (!audio?.url) {
        throw new ServiceError(503, '这次语音合成没有成功，稍后再试一次。', 'tts_synthesis_failed');
      }
      const hash = audio.hash || audioHashFromUrl(audio.url);
      this.conversationStore.updateTurnVoice(tid, {
        ...(isUnseparatedFallback ? { beats: null } : {}),
        spokenText,
        voiceProfileId,
        audioUrl: audio.url,
        ...(hash ? { hash } : {}),
        ...(Number.isFinite(audio.durationMs) ? { durationMs: audio.durationMs } : {}),
        synthesizedAt: Date.now(),
      });
      if (previousHash && previousHash !== hash && this.ttsLifecycle?.purgeUnreferencedHashes) {
        try {
          const preserveHashes = this.ttsLifecycle.readPinnedHashes?.();
          this.ttsLifecycle.purgeUnreferencedHashes([previousHash], { preserveHashes });
        } catch {}
      }
      return { audioUrl: audio.url, durationMs: audio.durationMs ?? null, cached: audio.source === 'cache' };
    })().finally(() => {
      if (this._speechInFlight.get(tid) === task) this._speechInFlight.delete(tid);
    });

    this._speechInFlight.set(tid, task);
    return task;
  }

  async _synthesizeBeatsTurnSpeech(sid, tid, turn, room) {
    const rawBeats = turn.message.beats;
    const entries = rawBeats.map((beat, idx) => ({
      beatIndex: Number.isInteger(beat.index) ? beat.index : idx,
      beat,
      spoken: beatSpokenText(beat),
    }));
    const speakableEntries = entries.filter(entry => Boolean(entry.spoken));
    if (!speakableEntries.length) {
      throw new ServiceError(409, '这一段只有动作与神态描写，没有可朗读的台词。', 'turn_has_no_speech');
    }
    const isAlive = url => Boolean(url && (!this.ttsLifecycle || this.ttsLifecycle.existsByUrl(url)));
    const allCached = speakableEntries.every(entry => isAlive(entry.beat.audioUrl));
    if (allCached) {
      for (const entry of speakableEntries) {
        this.ttsLifecycle?.touchByUrl?.(entry.beat.audioUrl);
      }
      const projected = this._projectBeatsTurnVoice(turn);
      const firstUrl = projected.beats.find(b => b.audioUrl)?.audioUrl || null;
      return {
        audioUrl: firstUrl,
        durationMs: projected.voice?.durationMs ?? null,
        cached: true,
        beats: projected.beats,
      };
    }
    if (!this.synthesizeSpeech) {
      throw new ServiceError(503, '语音服务暂未就绪，请检查语音设置后重试。', 'tts_unavailable');
    }
    if (this._speechInFlight.has(tid)) return this._speechInFlight.get(tid);

    const task = (async () => {
      const entity = this.registry.get(turn.speakerVirtualPersonId);
      const stored = turn.message?.voice && typeof turn.message.voice === 'object' ? turn.message.voice : null;
      const voiceProfileId = entity?.voiceProfileId || stored?.voiceProfileId || null;
      const missingEntries = [];
      for (const entry of speakableEntries) {
        if (isAlive(entry.beat.audioUrl)) {
          this.ttsLifecycle?.touchByUrl?.(entry.beat.audioUrl);
        } else {
          missingEntries.push(entry);
        }
      }

      let cursor = 0;
      let firstError = null;
      let anyUncached = false;
      const replacedHashes = [];
      const workerCount = Math.min(2, missingEntries.length);
      const runWorker = async () => {
        while (!firstError && cursor < missingEntries.length) {
          const entry = missingEntries[cursor++];
          const performance = toSpeechPerformance(entry.beat.voice);
          let audio = null;
          try {
            audio = await this.synthesizeSpeech({
              text: entry.spoken,
              voiceProfileId,
              ...(performance ? { performance } : {}),
              allowFallback: room?.interactionMode !== 'roleplay',
            });
          } catch (error) {
            if (!firstError) firstError = mapSynthesisError(error);
            break;
          }
          if (!audio?.url) {
            if (!firstError) {
              firstError = new ServiceError(503, '这次语音合成没有成功，稍后再试一次。', 'tts_synthesis_failed');
            }
            break;
          }
          if (audio.source !== 'cache') anyUncached = true;
          const hash = audio.hash || audioHashFromUrl(audio.url);
          const prevHash = entry.beat.hash || audioHashFromUrl(entry.beat.audioUrl);
          if (prevHash && prevHash !== hash) replacedHashes.push(prevHash);
          this.conversationStore.updateTurnVoice(tid, {
            beatIndex: entry.beatIndex,
            voiceProfileId,
            audioUrl: audio.url,
            ...(hash ? { hash } : {}),
            ...(Number.isFinite(audio.durationMs) ? { durationMs: audio.durationMs } : {}),
            synthesizedAt: Date.now(),
          });
        }
      };

      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
      if (replacedHashes.length && this.ttsLifecycle?.purgeUnreferencedHashes) {
        try {
          const preserveHashes = this.ttsLifecycle.readPinnedHashes?.();
          this.ttsLifecycle.purgeUnreferencedHashes(replacedHashes, { preserveHashes });
        } catch {}
      }
      if (firstError) throw firstError;

      const updatedTurn = this.conversationStore.getTurn(tid) || turn;
      const projected = this._projectBeatsTurnVoice(updatedTurn);
      const firstUrl = projected.beats.find(b => b.audioUrl)?.audioUrl || null;
      return {
        audioUrl: firstUrl,
        durationMs: projected.voice?.durationMs ?? null,
        cached: !anyUncached,
        beats: projected.beats,
      };
    })().finally(() => {
      if (this._speechInFlight.get(tid) === task) this._speechInFlight.delete(tid);
    });

    this._speechInFlight.set(tid, task);
    return task;
  }

  /** 重听已有音频前检查磁盘存活并续命 LRU mtime；失效则如实告知前端重新合成。 */
  touchTurnSpeech(sessionId, turnId) {
    this.initialize();
    const sid = required(sessionId, 'sessionId', 128);
    const tid = required(turnId, 'turnId', 256);
    const room = this.conversationStore.getSession(sid);
    if (!room) throw new ServiceError(404, '找不到这个聊天。', 'conversation_not_found');
    const turn = this.conversationStore.getTurn(tid);
    if (!turn || turn.sessionId !== sid || turn.supersededAt || turn.role !== 'assistant') {
      throw new ServiceError(404, '找不到这条消息。', 'turn_not_found');
    }
    const isUnseparatedFallback = this._isUnseparatedRoleplayFallbackTurn(turn, room);
    if (Array.isArray(turn.message?.beats) && turn.message.beats.length > 0 && turn.message?.presentation !== 'track_intro' && !isUnseparatedFallback) {
      const projected = this._projectBeatsTurnVoice(turn);
      const speakable = projected.beats.filter(beat => Boolean(beatSpokenText(beat)));
      const aliveSpeakable = speakable.filter(beat => Boolean(beat.audioUrl));
      for (const beat of aliveSpeakable) {
        this.ttsLifecycle?.touchByUrl?.(beat.audioUrl);
      }
      const allExist = speakable.length > 0 && aliveSpeakable.length === speakable.length;
      return {
        touched: allExist,
        exists: allExist,
        audioUrl: allExist ? (projected.voice?.audioUrl || null) : null,
        beats: projected.beats,
      };
    }
    const resolved = this._resolveTurnSpeechAndSegments(turn, room);
    const url = this._existingAudioUrl(turn.message?.voice, resolved);
    if (url) this.ttsLifecycle?.touchByUrl?.(url);
    return { touched: Boolean(url), exists: Boolean(url), audioUrl: url || null };
  }

  _recommendationView(turnId) {
    try { return this.ambientRecommendations?.view?.(turnId) || null; } catch { return null; }
  }

  /** 你点「放这首」：交给推荐模块（过期、来源、幂等与提交都在那里判定）。 */
  async acceptRecommendation(sessionId, turnId) {
    this.initialize();
    const sid = required(sessionId, 'sessionId', 128);
    const tid = required(turnId, 'turnId', 256);
    // 被改写掉的推荐卡片已不在聊天里：不能再经旧链接排歌。
    if (!this.ambientRecommendations || this.conversationStore.getTurn(tid)?.supersededAt) return { ok: false, code: 'RECOMMENDATION_NOT_FOUND' };
    const result = await this.ambientRecommendations.accept({ sessionId: sid, turnId: tid });
    return { ...result, ...(result?.recommendation
      ? { recommendation: { turnId: tid, ...publicRecommendation(result.recommendation) } } : {}) };
  }

  rooms(options = {}) {
    this.initialize();
    this.conversationStore.ensureSession('conversation:primary', ROOT_ID);
    return this.conversationStore.listRooms(options);
  }

  async createRoom(input = {}) {
    this.initialize();
    const memberIds = [...new Set(input.memberIds || [ROOT_ID])];
    for (const id of memberIds) this._requireAvailable(id);
    const room = this.conversationStore.createRoom({
      title: input.title,
      memberIds,
      hostId: input.hostId || memberIds[0],
      interactionMode: input.interactionMode,
    });
    if (this.playbackRuntime) {
      await this.playbackRuntime.submit({ type: 'LISTENING_SESSION_CREATED',
        eventId: `room:${room.sessionId}`, listeningSessionId: room.sessionId });
      if (room.interactionMode === 'roleplay') {
        await this._syncPlaybackInteractionMode(room.sessionId, 'roleplay');
      }
    }
    return room;
  }

  /**
   * 归档是「收起列表」，但不能让声音留在看不见的会话里：
   * 归档正在听的那一个会话前先按暂停（队列与位置保留，恢复后从原位继续），
   * 并取消指向它的待切换，避免被归档的会话稍后自动开声。
   * 停顿不下来就 fail closed，不把“已归档、仍在放”这种状态写进去。
   */
  async updateRoom(sessionId, input) {
    this.initialize();
    const before = this.conversationStore.getSession(sessionId);
    if (input.archived) {
      this.runtime?.cancel(sessionId);
      await this._silenceBeforeArchive(sessionId);
    }
    const updated = this.conversationStore.updateRoom(sessionId, input);
    if (updated && input?.interactionMode !== undefined && before && before.interactionMode !== updated.interactionMode) {
      await this._syncPlaybackInteractionMode(sessionId, updated.interactionMode);
    }
    return updated;
  }

  async _silenceBeforeArchive(sessionId) {
    const submit = this.playbackRuntime?.submit;
    if (typeof submit !== 'function') return;
    let snapshot = this.playbackRuntime.snapshot?.();
    if (!snapshot) return;
    if (snapshot.pendingSwitch?.listeningSessionId === sessionId) {
      await submit({ type: 'LISTENING_SWITCH_CANCELLED',
        eventId: `room-archived-cancel-switch:${sessionId}:${Date.now()}`, listeningSessionId: sessionId });
      snapshot = this.playbackRuntime.snapshot?.() || snapshot;
    }
    if (snapshot.activeListeningSessionId !== sessionId) return;
    if (![PlaybackPhase.PLAYING, PlaybackPhase.LOADING].includes(snapshot.phase)) return;
    const track = snapshot.currentIndex >= 0 ? snapshot.queue?.[snapshot.currentIndex] : null;
    if (!track) return;
    await submit({
      type: 'PAUSE_REQUESTED',
      eventId: `room-archived:${sessionId}:${Date.now()}`,
      listeningSessionId: sessionId,
      // 身份锚定当前 occurrence：迟到的旧 pause 不能暂停另一首歌。
      ...(snapshot.outputGeneration != null ? { outputGeneration: snapshot.outputGeneration } : {}),
      ...(track.songId != null ? { songId: track.songId } : {}),
      ...(track.programId != null ? { programId: track.programId } : {}),
    });
    const after = this.playbackRuntime.snapshot?.() || snapshot;
    if (after.activeListeningSessionId === sessionId
      && [PlaybackPhase.PLAYING, PlaybackPhase.LOADING].includes(after.phase)) {
      throw new ServiceError(409, '这个聊天还在播放，先按暂停再归档。', 'conversation_still_playing');
    }
  }

  /**
   * 删除不可回退，且不能破坏唯一的播放真相源：
   * 会话仍是在听的那一个、或正要切换过去时 fail closed；其余会话（包括留有
   * 挂起待播队列的）先让 runtime 丢弃该会话的挂起状态，再删聊天记录。
   * 只删除聊天而留下挂起队列，会形成指向不存在会话的孤儿播放状态。
   */
  async deleteRoom(sessionId) {
    this.initialize();
    this.runtime?.cancel(sessionId);
    const snapshot = this.playbackRuntime?.snapshot?.();
    if (snapshot) {
      if (snapshot.activeListeningSessionId === sessionId) {
        throw new ServiceError(409, '这个聊天正在一起听，先切到别的聊天再删除。', 'conversation_actively_listening');
      }
      if (snapshot.pendingSwitch?.listeningSessionId === sessionId) {
        throw new ServiceError(409, '这个聊天正要切换过去播放，等切换完成或取消后再删除。', 'conversation_pending_switch');
      }
      if (typeof this.playbackRuntime.submit === 'function') {
        // 挂起状态属于运行时而不是聊天记录：先释放它，再删记录。被拒说明这条
        // 会话刚刚变成了活动会话，此时 fail closed 而不是继续删。
        const removal = await this.playbackRuntime.submit({
          type: 'LISTENING_SESSION_REMOVED',
          eventId: `room-deleted:${sessionId}:${Date.now()}`,
          listeningSessionId: sessionId,
        });
        if (removal && removal.accepted === false) {
          throw new ServiceError(409, '这个聊天正在被播放，暂时不能删除。', 'conversation_playback_busy');
        }
      }
    }
    const candidateVoiceHashes = this.conversationStore.voiceHashesForSession?.(sessionId) || [];
    const preserveVoiceHashes = this.ttsLifecycle?.readPinnedHashes?.();
    const deleted = this.conversationStore.deleteRoom(sessionId);
    // 记录清理是诊断副本的收尾：删除已完成，这里只通知；失败由组合根如实告警。
    if (deleted) {
      try { this.onRoomDeleted?.(sessionId); } catch { /* 通知失败不影响删除结果 */ }
      try { this.ttsLifecycle?.purgeUnreferencedHashes?.(candidateVoiceHashes, { preserveHashes: preserveVoiceHashes }); } catch {}
    }
    return deleted;
  }

  invite(sessionId, personId) {
    this.initialize();
    this._requireAvailable(personId);
    return this.conversationStore.addMember(sessionId, personId);
  }

  remove(sessionId, personId) {
    this.initialize();
    return this.conversationStore.removeMember(sessionId, personId);
  }

  cancel(sessionId, expectedRoundId = null) {
    return this.runtime?.cancel(sessionId, expectedRoundId) || false;
  }

  /**
   * 编辑发送前的回退（add-chat-edit-and-fork）：改聊天账本并撤回从被改写消息学到的记忆，不碰播放或听歌来源。
   * 回合在跑时拒绝，避免回退与正在入账的回应交错。
   */
  rewind(sessionId, turnId) {
    this.initialize();
    const sid = required(sessionId, 'sessionId', 128);
    const room = this.conversationStore.getSession(sid);
    if (!room) throw new ServiceError(404, '找不到这个聊天。', 'conversation_not_found');
    if (room.archivedAt) throw new ServiceError(409, '聊天已归档，恢复后才能改写。', 'conversation_archived');
    if (this.runtime?.presenceActivity?.(sid)?.busy) {
      throw new ServiceError(409, '正在回应，等这一轮结束再改写。', 'conversation_busy');
    }
    const targetTurn = this.conversationStore.getTurn?.(turnId);
    const candidateVoiceHashes = targetTurn && targetTurn.sessionId === sid
      ? (this.conversationStore.voiceHashesFromTurn?.(sid, targetTurn.sequence) || [])
      : [];
    const preserveVoiceHashes = this.ttsLifecycle?.readPinnedHashes?.();
    const { turnId: rewoundId, text } = this._branchCall(() => this.conversationStore.rewindFromTurn(sid, turnId));
    try { this.ttsLifecycle?.purgeUnreferencedHashes?.(candidateVoiceHashes, { preserveHashes: preserveVoiceHashes }); } catch {}
    return { turnId: rewoundId, text };
  }

  /** 从一条用户消息分叉出新聊天：登记为可听的会话，但不切换当前听歌来源。 */
  async fork(sessionId, turnId) {
    this.initialize();
    const sid = required(sessionId, 'sessionId', 128);
    const room = this.conversationStore.getSession(sid);
    if (!room) throw new ServiceError(404, '找不到这个聊天。', 'conversation_not_found');
    for (const id of room.memberIds) {
      try { this._requireAvailable(id); } catch {
        throw new ServiceError(409, '这个聊天里有伙伴已经不可用，没法分叉。', 'conversation_member_unavailable');
      }
    }
    const { room: conversation, text } = this._branchCall(() => this.conversationStore.forkFromTurn(sid, turnId));
    if (this.playbackRuntime) await this.playbackRuntime.submit({ type: 'LISTENING_SESSION_CREATED',
      eventId: `room:${conversation.sessionId}`, listeningSessionId: conversation.sessionId });
    return { conversation, text };
  }

  _branchCall(run) {
    try { return run(); } catch (error) {
      if (/message not found/.test(error?.message)) throw new ServiceError(404, '找不到这条消息，可能已经被改写。', 'message_not_found');
      if (error instanceof TypeError) throw new ServiceError(400, '只能从你发的消息改写或分叉。', 'message_not_user');
      throw error;
    }
  }

  _requireAvailable(id) {
    const person = this.registry.get(required(id, 'personId', 128));
    if (!person || person.status === 'archived') throw new Error('virtual person not available');
    return person;
  }

  session(sessionId) {
    this.initialize();
    const sid = required(sessionId, 'sessionId', 128);
    return this.conversationStore.getSession(sid)
      || this.conversationStore.ensureSession(sid, ROOT_ID);
  }

  /**
   * 显式可观测的 AI 人格扩写：基于用户草稿与可选灵感预设生成可编辑的四段式正文。
   * 模型未配置（503）或调用失败（502）时直接报错，绝不静默回退预设冒充生成结果。
   */
  async expandPersonaDraft(input = {}) {
    this.initialize();
    const draft = normalizePersonaText(input.draft ?? '', 'draft', 4000);
    const rawDisplayName = String(input.displayName ?? '').trim();
    if (rawDisplayName.length > 80) throw new TypeError('displayName exceeds 80 characters');
    if (rawDisplayName && SINGLE_LINE_CONTROL_RE.test(rawDisplayName)) {
      throw new TypeError('invalid displayName: control characters are not allowed');
    }
    const rawPresetId = String(input.presetId ?? input.personaPresetId ?? '').trim();
    let preset = null;
    if (rawPresetId) {
      if (rawPresetId.length > 64) throw new TypeError('personaPresetId exceeds 64 characters');
      preset = getPersonaPreset(rawPresetId);
      if (!preset) throw new TypeError(`invalid personaPresetId: unknown persona preset "${rawPresetId}"`);
    }
    if (!draft && !preset) {
      throw new ServiceError(400, '请先写几句人物想法，或先点选一个性格模板再扩写。', 'persona_expand_empty_input');
    }
    const prompt = buildPersonaExpandPrompt({ draft, displayName: rawDisplayName, preset });
    const runAsk = this.askText || ((text, opts) => llm.askText(text, opts));
    let raw;
    try {
      raw = await runAsk(prompt, { taskId: 'persona_generation' });
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      if (error instanceof llm.LLMNotConfiguredError
        || error?.name === 'LLMNotConfiguredError'
        || error?.code === 'LLM_NOT_CONFIGURED') {
        throw new ServiceError(503, '请先在「设置 → 模型与连接」配置可用模型后再使用 AI 扩写。', 'llm_not_configured');
      }
      throw new ServiceError(502, '这次 AI 扩写没有成功，原有草稿已保留，请稍后重试。', 'persona_expand_failed');
    }
    const personaDocument = extractExpandedPersonaDocument(raw);
    if (!personaDocument) {
      throw new ServiceError(502, '这次 AI 扩写没有生成有效内容，原有草稿已保留，请稍后重试。', 'persona_expand_empty_output');
    }
    return { personaDocument };
  }

  async create(input = {}) {
    this.initialize();
    const displayName = String(input.displayName || '').trim();
    if (!displayName) throw new TypeError('displayName is required');
    if (displayName.length > 80) throw new TypeError('displayName exceeds 80 characters');
    if (SINGLE_LINE_CONTROL_RE.test(displayName)) {
      throw new TypeError('invalid displayName: control characters are not allowed');
    }
    const voiceProfileId = required(input.voiceProfileId, 'voiceProfileId', 128);
    const personaHint = normalizePersonaText(input.personaHint || '', 'personaHint', 4000);
    const hasExplicitDocument = Object.hasOwn(input, 'personaDocument')
      && input.personaDocument !== undefined
      && input.personaDocument !== null;
    const personaDocument = hasExplicitDocument
      ? normalizePersonaText(input.personaDocument, 'personaDocument', 4000)
      : undefined;

    // 预令人设与声音正交，且允许不选预设纯手写创建；显式传了未知预设仍 fail closed。
    const rawPresetId = String(input.personaPresetId || '').trim();
    let preset = null;
    if (rawPresetId) {
      if (rawPresetId.length > 64) throw new TypeError('personaPresetId exceeds 64 characters');
      preset = getPersonaPreset(rawPresetId);
      if (!preset) throw new TypeError(`invalid personaPresetId: unknown persona preset "${rawPresetId}"`);
    }
    const personaPresetId = preset ? preset.id : null;

    const useDirectDocument = hasExplicitDocument
      && (personaDocument.length > 0 || (!personaPresetId && !personaHint && !Object.hasOwn(input, 'personaDraft')));

    let entity;
    if (typeof this.createRadiohost === 'function') {
      const legacyHost = await this.createRadiohost({
        displayName,
        voiceProfileId,
        personaPresetId,
        personaHint,
        ...(useDirectDocument ? { personaDocument } : {}),
        // 只在调用方真的提供了草稿时才透传：坏草稿必须在这里失败，而不是被静默退回模型生成。
        ...(Object.hasOwn(input, 'personaDraft') ? { personaDraft: input.personaDraft } : {}),
      });
      [entity] = this.registry.importRadioHosts(
        [legacyHost],
        useDirectDocument ? () => personaDocument : this.loadPersona,
      );
      entity ||= this.registry.get(legacyHost.id);
    } else {
      const doc = useDirectDocument ? personaDocument : personaHint;
      entity = this.registry.createRadiohost({
        displayName,
        voiceProfileId,
        personaDocument: doc,
        relationshipStance: extractRelationshipStance(doc),
      });
    }
    if (entity && preset?.defaultTemperament && !entity.metadata?.presence) {
      entity = this.registry.update(entity.id, {
        presence: normalizePresenceSetting({ temperament: preset.defaultTemperament, style: '' }),
      });
    }
    return entity;
  }

  async activate({ id, sessionId } = {}) {
    this.initialize();
    const personId = required(id, 'virtualPersonId', 128);
    const sid = required(sessionId, 'sessionId', 128);
    const entity = this.registry.get(personId);
    if (!entity || entity.status === 'archived') return null;
    this.conversationStore.setActiveVirtualPerson(sid, entity.id);
    return { entity, session: this.conversationStore.getSession(sid) };
  }

  archive(id) {
    this.initialize();
    const personId = required(id, 'virtualPersonId', 128);
    if (personId === ROOT_ID) throw new Error('root Lunara cannot be archived');
    const archived = this.registry.updateStatus(personId, 'archived');
    if (archived) this.conversationStore.resetActiveVirtualPerson(personId, ROOT_ID);
    return archived;
  }

  /**
   * 修改一个伙伴的设置。只影响该伙伴自身，不动预设与其他人。
   *
   * 校验全部先于写入，任一字段不合法则整体不生效，避免留下半改状态。
   */
  updatePerson(id, fields = {}) {
    this.initialize();
    const personId = required(id, 'virtualPersonId', 128);
    const existing = this.registry.get(personId);
    if (!existing || existing.status === 'archived') throw new Error('virtual person not available');
    const patch = {};
    let syncDiskPersona = false;
    if (fields.displayName !== undefined) {
      const displayName = String(fields.displayName || '').trim();
      if (!displayName) throw new TypeError('displayName cannot be empty');
      if (displayName.length > 80) throw new TypeError('displayName exceeds 80 characters');
      if (SINGLE_LINE_CONTROL_RE.test(displayName)) {
        throw new TypeError('invalid displayName: control characters are not allowed');
      }
      patch.displayName = displayName;
    }
    if (fields.personaDocument !== undefined) {
      const personaDocument = normalizePersonaText(fields.personaDocument, 'personaDocument', 4000);
      if (personId === ROOT_ID && personaDocument === '') {
        patch.personaDocument = ROOT_PERSONA;
        patch.relationshipStance = fields.relationshipStance !== undefined
          ? String(fields.relationshipStance || '').trim().slice(0, 4000)
          : ROOT_RELATIONSHIP;
        patch.userAuthoredPersona = false;
      } else {
        patch.personaDocument = personaDocument;
        if (fields.relationshipStance === undefined) {
          patch.relationshipStance = extractRelationshipStance(personaDocument);
        }
        syncDiskPersona = personId !== ROOT_ID;
      }
    }
    if (fields.relationshipStance !== undefined && patch.relationshipStance === undefined) {
      patch.relationshipStance = String(fields.relationshipStance || '').trim().slice(0, 4000);
    }
    if (fields.voiceProfileId !== undefined) {
      const voiceProfileId = String(fields.voiceProfileId || '').trim();
      if (!voiceProfileId) throw new TypeError('voiceProfileId cannot be empty');
      if (voiceProfileId.length > 128) throw new TypeError('voiceProfileId exceeds 128 characters');
      // 未知引用会被写库，随后该伙伴的每次合成都解析失败——"不失声"不能靠
      // 合成层兜底来保护可预防的输入错误，必须在编辑入口拒绝。
      if (this.resolveVoiceProfile && !this.resolveVoiceProfile(voiceProfileId)) {
        throw new TypeError(`voiceProfileId is not a known voice profile: ${voiceProfileId}`);
      }
      patch.voiceProfileId = voiceProfileId;
    }
    // 在场性格（话多/话少 + 在场方式原文）是人格的运行时参数，存在 metadata_json，不迁移 schema。
    if (fields.presence !== undefined) patch.presence = normalizePresenceSetting(fields.presence);
    if (!Object.keys(patch).length) return existing;
    const updated = this.registry.update(personId, patch);
    if (syncDiskPersona && updated) {
      this._persistPersonaFile(personId, updated.personaDocument);
    }
    return updated;
  }

  _persistPersonaFile(personId, personaDocument) {
    const content = personaDocument ? `${personaDocument}\n` : '';
    if (this.savePersonaFile) {
      try { this.savePersonaFile(personId, content); } catch (e) {
        console.warn(`[virtual-person] persona file sync failed for ${personId}: ${e.message}`);
      }
      return;
    }
    try {
      const file = personaPath(personId);
      if (!existsSync(dirname(file))) return;
      writeFileSync(file, content, 'utf8');
      clearPersonaCache(personId);
    } catch (e) {
      console.warn(`[virtual-person] persona.md writeback failed for ${personId}: ${e.message}`);
    }
  }

  /**
   * 删除伙伴前披露将被永久移除的内容。
   * 删除不可回退，因此调用方必须在确认前拿到真实数量，而不是估算。
   */
  personDeletionImpact(id) {
    this.initialize();
    const personId = required(id, 'virtualPersonId', 128);
    const entity = this.registry.get(personId);
    if (!entity) return null;
    const rooms = this.conversationStore.listRooms?.({ includeArchived: true }) || [];
    const memberOf = rooms.filter(room => (room.memberIds || []).includes(personId)).length;
    return {
      id: entity.id,
      displayName: entity.displayName,
      isRoot: entity.id === ROOT_ID,
      deletable: entity.id !== ROOT_ID,
      memories: Number(this.countMemories(entity)) || 0,
      rooms: memberOf,
    };
  }

  /**
   * 硬删除一个伙伴：记忆、人格文件、实体行、遗留注册项与会话引用全部清理。
   *
   * 记忆最先销毁（唯一不可再生的数据），且这一步失败时立即中止、什么都不动：
   * 继续删下去要么留下"人还在、记忆没了"，要么留下"人删了、记忆变成
   * 永远够不着的孤儿"——两种半成品都比"保持原样、可重试"更糟。
   * 其余步骤各自独立，任一失败不阻断其余清理；部分失败如实记入 errors，
   * 人格文件放在最后，重试总能收敛。
   */
  async deletePerson(id) {
    this.initialize();
    const personId = required(id, 'virtualPersonId', 128);
    if (personId === ROOT_ID) throw new Error('root Lunara cannot be deleted');
    const entity = this.registry.get(personId);
    if (!entity) return { deleted: false, reason: 'not-found' };

    let memories = 0;
    try {
      memories = Number(await this.purgeMemories(entity)) || 0;
    } catch (error) {
      return { deleted: false, reason: 'purge-failed', errors: [String(error?.message || error)] };
    }

    const errors = [];
    const attempt = async step => {
      try {
        return await step();
      } catch (error) {
        errors.push(String(error?.message || error));
        return undefined;
      }
    };

    const candidateVoiceHashes = this.conversationStore.voiceHashesForPerson?.(personId) || [];
    const preserveVoiceHashes = this.ttsLifecycle?.readPinnedHashes?.();
    const detached = await attempt(() => this.conversationStore.resetActiveVirtualPerson(personId, ROOT_ID));
    const removed = await attempt(() => this.registry.remove(personId));
    const unregistered = await attempt(() => this.unregisterLegacyHost(entity.id));
    const personaFile = await attempt(() => this.deletePersonaFile(entity.id));
    if (removed === true && candidateVoiceHashes.length) {
      try { this.ttsLifecycle?.purgeUnreferencedHashes?.(candidateVoiceHashes, { preserveHashes: preserveVoiceHashes }); } catch {}
    }
    const result = {
      deleted: removed === true,
      memories,
      personaFile: personaFile === true,
      legacyHost: unregistered === true,
    };
    if (detached !== undefined) result.detachedRooms = detached;
    if (errors.length) result.errors = errors;
    return result;
  }
}
