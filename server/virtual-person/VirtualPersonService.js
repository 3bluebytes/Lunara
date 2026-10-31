import { normalizePresenceSetting } from '../presence/presenceTemperament.js';
import { PlaybackPhase } from '../playback/playbackRuntimeTypes.js';
import { ServiceError } from '../services/ServiceError.js';
import { ROOT_ID } from './VirtualPersonRegistry.js';
import { publicRecommendation } from '../presence/ambientRecommendations.js';

function required(value, name, max = 256) {
  const text = String(value || '').trim();
  if (!text) throw new TypeError(`${name} is required`);
  return text.slice(0, max);
}

export class VirtualPersonService {
  constructor({ registry, conversationStore, createRadiohost = null, loadPersona = () => '', runtime = null, playbackRuntime = null,
    countMemories = null, purgeMemories = null, deletePersonaFile = null, unregisterLegacyHost = null,
    onRoomDeleted = null, resolveVoiceProfile = null, ambientRecommendations = null } = {}) {
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
    this.unregisterLegacyHost = unregisterLegacyHost || (() => false);
    // 诊断副本的生命周期跟随会话删除：DB 删除成功后通知清理（盘点由组合根负责）。
    this.onRoomDeleted = typeof onRoomDeleted === 'function' ? onRoomDeleted : null;
    // 声音身份目录在 station 层，本类不反向依赖；注入解析函数后，
    // 编辑声音时才能拒绝"写进去就再也解析不到"的未知引用。未注入则不校验。
    this.resolveVoiceProfile = typeof resolveVoiceProfile === 'function' ? resolveVoiceProfile : null;
    // ambient 推荐（add-ambient-music-recommendation）：展示实时状态与「放这首」确认。未注入时没有推荐卡片动作。
    this.ambientRecommendations = ambientRecommendations;
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
    return this.conversationStore.listTurns(required(sessionId, 'sessionId', 128), {
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
        createdAt: turn.createdAt,
      };
    });
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
    const room = this.conversationStore.createRoom({ title: input.title, memberIds, hostId: input.hostId || memberIds[0] });
    if (this.playbackRuntime) await this.playbackRuntime.submit({ type: 'LISTENING_SESSION_CREATED',
      eventId: `room:${room.sessionId}`, listeningSessionId: room.sessionId });
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
    if (input.archived) {
      this.runtime?.cancel(sessionId);
      await this._silenceBeforeArchive(sessionId);
    }
    return this.conversationStore.updateRoom(sessionId, input);
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
    const deleted = this.conversationStore.deleteRoom(sessionId);
    // 记录清理是诊断副本的收尾：删除已完成，这里只通知；失败由组合根如实告警。
    if (deleted) {
      try { this.onRoomDeleted?.(sessionId); } catch { /* 通知失败不影响删除结果 */ }
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
   * 编辑发送前的回退（add-chat-edit-and-fork）：只改聊天账本，不碰播放、听歌来源或显式记忆。
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
    const { turnId: rewoundId, text } = this._branchCall(() => this.conversationStore.rewindFromTurn(sid, turnId));
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

  async create(input = {}) {
    this.initialize();
    const displayName = required(input.displayName, 'displayName', 80);
    const voiceProfileId = required(input.voiceProfileId, 'voiceProfileId', 128);
    const personaHint = String(input.personaHint || '').trim().slice(0, 4000);
    // 预令人设与声音是两个正交维度：人设决定是谁，声音只决定怎么念。
    const personaPresetId = input.personaPresetId ? String(input.personaPresetId).slice(0, 64) : null;
    let entity;
    if (typeof this.createRadiohost === 'function') {
      const legacyHost = await this.createRadiohost({ displayName, voiceProfileId, personaPresetId, personaHint,
        // 只在调用方真的提供了草稿时才透传：坏草稿必须在这里失败，而不是被静默退回模型生成。
        ...(Object.hasOwn(input, 'personaDraft') ? { personaDraft: input.personaDraft } : {}) });
      [entity] = this.registry.importRadioHosts([legacyHost], this.loadPersona);
      entity ||= this.registry.get(legacyHost.id);
    } else {
      entity = this.registry.createRadiohost({ displayName, voiceProfileId, personaDocument: personaHint });
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
    if (fields.displayName !== undefined) {
      const displayName = String(fields.displayName || '').trim();
      if (!displayName) throw new TypeError('displayName cannot be empty');
      if (displayName.length > 80) throw new TypeError('displayName exceeds 80 characters');
      patch.displayName = displayName;
    }
    if (fields.personaDocument !== undefined) {
      const personaDocument = String(fields.personaDocument || '').trim();
      // 人格可以为空（回到系统默认），但不能超长注入 prompt。
      if (personaDocument.length > 4000) throw new TypeError('personaDocument exceeds 4000 characters');
      patch.personaDocument = personaDocument;
    }
    if (fields.relationshipStance !== undefined) {
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
    return this.registry.update(personId, patch);
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

    const detached = await attempt(() => this.conversationStore.resetActiveVirtualPerson(personId, ROOT_ID));
    const removed = await attempt(() => this.registry.remove(personId));
    const unregistered = await attempt(() => this.unregisterLegacyHost(entity.id));
    const personaFile = await attempt(() => this.deletePersonaFile(entity.id));
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
