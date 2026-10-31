import { sanitizeFacts, sanitizeExternalText } from './toolFacts.js';
import { PERSON_MEMORY_CAPABILITY, registerPersonMemoryTools, retrievePersonMemories } from './personMemory.js';
import { PRESENCE_PREFERENCE_CAPABILITY } from '../presence/presencePreferenceTool.js';
import { AgentLoop } from './AgentLoop.js';
import { registerWebAccessTools } from '../web-access/webTools.js';
import { WEB_CAPABILITY } from '../web-access/policy.js';
import { IntentRouter } from './IntentRouter.js';
import { tryBasicPlaybackFallback } from './basicPlaybackFallback.js';
import { ContextBudgeter } from './ContextBudgeter.js';
import { ConversationStore } from './ConversationStore.js';
import { PresentationService } from './PresentationService.js';
import { PromptAssembler } from './PromptAssembler.js';
import { VirtualPersonChatService } from './VirtualPersonChatService.js';
import { VirtualPersonRegistry } from './VirtualPersonRegistry.js';
import { VirtualPersonRuntime } from './VirtualPersonRuntime.js';
import { VirtualPersonToolRegistry } from './VirtualPersonToolRegistry.js';
import { createToolOutcome, ToolOutcomeKind } from './VirtualPersonTypes.js';

import { registerMusicTools } from './musicTools.js';
import { registerFloorTools } from './floorTools.js';
import { createContextualResponsePlanner } from './responseRouting.js';
import { registerAmbientTools } from '../presence/ambientTools.js';
import { createAmbientRecommendations } from '../presence/ambientRecommendations.js';
import { MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY } from '../program/musicSelectionRequest.js';
import { describeCompanionMode } from '../playback/companionModes.js';
const PERSONA_CREATE_CAPABILITY = 'persona.create';
const PERSONA_SWITCH_CAPABILITY = 'persona.switch';

function explicitCreationIntent(text) {
  const value = String(text || '');
  if (/(?:不要|别|不必|无需).{0,8}(?:创建|新建|添加|保存|建).{0,30}(?:伙伴|人格|虚拟人)/u.test(value)) return false;
  return /(?:创建|新建|添加|保存|建).{0,40}(?:伙伴|人格|虚拟人)/u.test(value)
    || /(?:伙伴|人格|虚拟人).{0,24}(?:创建|新建|添加|保存)/u.test(value);
}

function explicitActivationIntent(text) {
  const value = String(text || '');
  // 否定在前就不是切换请求：「不要让小满主持」「别叫 Mio 来接」与「不用换人」同样拒绝。
  if (/(?:不要|别|不用|不必|无需|不想|不许).{0,12}(?:切换|换成|换到|换回|换人|改用|接手|接着聊|主持|来接|来聊)/u.test(value)) return false;
  return /(?:切换|换成|换到|换回|换人|改用)/u.test(value)
    || /(?:让|叫|由).{1,24}(?:来接|接着聊|接手|主持|来聊)/u.test(value);
}

function personFacts(entity) {
  if (!entity) return null;
  return {
    id: entity.id,
    kind: entity.kind,
    displayName: entity.displayName,
    voiceProfileId: entity.voiceProfileId,
    status: entity.status,
  };
}

function retrieveMemories(getMemoryService, input, conversationStore = null) {
  return retrievePersonMemories(getMemoryService?.(), conversationStore, input);
}

export function createVirtualPersonRuntimeComposition({
  chat,
  dbPath,
  synthesize,
  publish,
  queueService,
  playbackRuntime,
  getMemoryService = () => null,
  isSharedMemoryActive = () => true,
  getMusicService = null,
  getEnvironment = null,
  getLifeContext = null,
  personaGateway = null,
  observeCommittedTurn = null,
  sessionTrace = null,
  webAccess = null,
  logger = console,
} = {}) {
  const registry = new VirtualPersonRegistry({ dbPath });
  const conversationStore = new ConversationStore({ dbPath });
  const toolRegistry = new VirtualPersonToolRegistry({ logger });
  if (webAccess) registerWebAccessTools(toolRegistry, webAccess);
  // 表达偏好（影响串词该怎么说话）的写入/撤销会让已备好未播的串词失效；关系事实、
  // 歌曲反馈与逐歌观察不进入串词语境，不触发重备。候选池失效保持对所有记忆变更生效。
  registerPersonMemoryTools(toolRegistry, { getMemoryService, conversationStore, registry,
    onMemoryChanged: ({ sessionId, affectsNarration = false } = {}) => {
      getMusicService?.()?.pool?.invalidate();
      if (affectsNarration && sessionId && typeof playbackRuntime?.invalidatePreparedNarrations === 'function') {
        Promise.resolve(playbackRuntime.invalidatePreparedNarrations(sessionId)).catch(() => {});
      }
    } });
  if (getMusicService) registerMusicTools(toolRegistry, getMusicService);
  // 群聊交接工具只在 runtime 按发言角色授予能力时可见；单聊永远拿不到。
  registerFloorTools(toolRegistry);
  // 心跳叫醒的一轮（ambient turn）只拿 presence.ambient 能力；普通回合的能力里没有它。
  registerAmbientTools(toolRegistry);
  if (personaGateway) {
    toolRegistry.register('persona_create_radiohost', {
      capability: PERSONA_CREATE_CAPABILITY,
      definition: {
        description: '仅当用户明确要求创建、添加或保存一个新的伙伴虚拟人时调用。人格内容必须由你在本轮直接写出并填入 personaDraft；工具只做校验和保存，不会替你生成人格。创建后不会自动切换。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['displayName', 'voiceProfileId', 'personaDraft'],
          properties: {
            displayName: { type: 'string', description: '伙伴显示名，最多 80 字。' },
            voiceProfileId: { type: 'string', description: '平台已有的声音配置 ID。' },
            personaDraft: {
              type: 'object',
              additionalProperties: false,
              required: ['character', 'speechHabit', 'emotionalExpression', 'musicTaste',
                'interpersonalDistance', 'backgroundStory', 'boundaries'],
              properties: {
                name: { type: 'string', maxLength: 20, description: '伙伴名，2-4 个字；未提供时用 displayName。' },
                character: { type: 'string', maxLength: 100, description: '性格底色，如：俏皮可爱、话少踏实。' },
                speechHabit: { type: 'string', maxLength: 200, description: '说话习惯，20-60 字。' },
                emotionalExpression: { type: 'string', maxLength: 150, description: '情感表达方式，15-40 字。' },
                musicTaste: { type: 'string', maxLength: 200, description: '音乐审美，20-60 字，包含年代、流派、节奏、情绪、场景。' },
                interpersonalDistance: { type: 'string', maxLength: 150, description: '人际距离定位，10-30 字。' },
                backgroundStory: { type: 'string', maxLength: 300, description: '故事感设定，40-120 字。' },
                boundaries: { type: 'string', maxLength: 150, description: '边界设定，15-40 字：不过度打扰、不替代用户判断、不打探隐私。' },
              },
            },
          },
        },
      },
      async handler(args, context) {
        if (!explicitCreationIntent(context.userText)) {
          return createToolOutcome({
            kind: ToolOutcomeKind.BUSINESS_FAILURE,
            code: 'EXPLICIT_PERSONA_CREATION_REQUIRED',
            modelContext: '用户没有明确要求持久创建伙伴。可以建议，但不要创建。',
            presentation: { displayText: '如果你想把这个人格保存成一位伙伴，请明确告诉我。', speak: false },
            internal: { correlationId: context.correlationId },
          });
        }
        let entity;
        try {
          entity = await personaGateway.create({
            displayName: String(args?.displayName || '').trim().slice(0, 80),
            voiceProfileId: String(args?.voiceProfileId || '').trim().slice(0, 128),
            personaDraft: args?.personaDraft,
          });
        } catch (error) {
          // 草稿校验失败是可纠正的：把边界信息交回模型，而不是报内部错误。
          return createToolOutcome({
            kind: ToolOutcomeKind.BUSINESS_FAILURE,
            code: 'PERSONA_DRAFT_INVALID',
            modelContext: `人格草稿不合法或保存失败：${String(error?.message || '').slice(0, 300)}。请修正 personaDraft 后重试，不要省略必填维度。`,
            presentation: { displayText: '这个人格还没保存成功，可以调整后再试一次。', speak: false, retryable: true },
            internal: { correlationId: context.correlationId },
          });
        }
        const facts = personFacts(entity);
        return createToolOutcome({
          kind: ToolOutcomeKind.SUCCESS,
          code: 'RADIOHOST_PERSONA_CREATED',
          facts,
          modelContext: `已创建伙伴，但尚未激活：${JSON.stringify(facts)}`,
          presentation: { displayText: `已经创建 ${facts.displayName}，目前还没有切换过去。`, speak: false },
          internal: { correlationId: context.correlationId },
        });
      },
    });
    toolRegistry.register('persona_list', {
      readOnly: true,
      capability: PERSONA_SWITCH_CAPABILITY,
      definition: {
        description: '列出可切换的虚拟人，用于回答有哪些人格或在切换前确认目标。',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
      },
      async handler(_args, context) {
        const persons = (await personaGateway.list()).map(personFacts).slice(0, 50);
        return createToolOutcome({
          kind: ToolOutcomeKind.SUCCESS,
          code: 'PERSONA_LISTED',
          facts: { persons },
          modelContext: `可用虚拟人：${JSON.stringify(persons)}`,
          presentation: { displayText: `目前有 ${persons.length} 位可用虚拟人。`, speak: false },
          internal: { correlationId: context.correlationId },
        });
      },
    });
    toolRegistry.register('persona_list_voices', {
      readOnly: true,
      capability: PERSONA_CREATE_CAPABILITY,
      definition: {
        description: '创建伙伴前列出平台可用声音。用户只描述声音气质但没有给 voiceProfileId 时先调用。',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
      },
      async handler(_args, context) {
        const voices = (await personaGateway.listVoices()).slice(0, 50).map(item => ({
          id: String(item.id || '').slice(0, 128),
          name: String(item.displayName || item.name || '').slice(0, 80),
          note: String(item.description || item.note || '').slice(0, 200),
        })).filter(item => item.id);
        return createToolOutcome({
          kind: ToolOutcomeKind.SUCCESS,
          code: 'PERSONA_VOICES_LISTED',
          facts: { voices },
          modelContext: `可用于新伙伴的声音：${JSON.stringify(voices)}`,
          presentation: { displayText: `目前有 ${voices.length} 个声音可选。`, speak: false },
          internal: { correlationId: context.correlationId },
        });
      },
    });
    toolRegistry.register('persona_activate', {
      capability: PERSONA_SWITCH_CAPABILITY,
      definition: {
        description: '按用户明确指定的 ID 设置本聊天下一轮的默认当前伙伴（私聊替换对方；群聊保留其他成员）。创建人格不会自动调用本工具。',
        parameters: {
          type: 'object', additionalProperties: false, required: ['virtualPersonId'],
          properties: { virtualPersonId: { type: 'string', description: 'persona_list 返回的稳定虚拟人 ID。' } },
        },
      },
      async handler(args, context) {
        if (!explicitActivationIntent(context.userText)) {
          return createToolOutcome({
            kind: ToolOutcomeKind.BUSINESS_FAILURE,
            code: 'EXPLICIT_PERSONA_ACTIVATION_REQUIRED',
            modelContext: '用户没有明确要求切换虚拟人；继续由当前人格回应。',
            presentation: { displayText: '如果你想换一位虚拟人来聊，请明确告诉我。', speak: false },
            internal: { correlationId: context.correlationId },
          });
        }
        const result = await personaGateway.activate({
          id: String(args?.virtualPersonId || '').trim().slice(0, 128),
          sessionId: context.sessionId,
        });
        if (!result?.entity) {
          return createToolOutcome({
            kind: ToolOutcomeKind.BUSINESS_FAILURE,
            code: 'PERSONA_NOT_AVAILABLE',
            modelContext: '目标虚拟人不存在或已归档。请列出可用人格后让用户选择。',
            presentation: { displayText: '没有找到这位可切换的虚拟人。', speak: false },
            internal: { correlationId: context.correlationId },
          });
        }
        const facts = personFacts(result.entity);
        return createToolOutcome({
          kind: ToolOutcomeKind.SUCCESS,
          code: 'PERSONA_ACTIVATED',
          facts,
          modelContext: `会话活跃虚拟人已切换；本轮仍由原说话者完成确认，下一轮由目标人格承接：${JSON.stringify(facts)}`,
          presentation: { displayText: `好，下一句话开始由 ${facts.displayName} 来接。`, speak: false },
          internal: { correlationId: context.correlationId },
        });
      },
    });
  }
  const contextBudgeter = new ContextBudgeter({
    // 默认按现行 128K–1M 窗口模型定（约 8.7 万汉字）；小窗口或费用敏感场景用环境变量调回。
    maxBytes: Number.parseInt(process.env.CONVERSATION_CONTEXT_MAX_BYTES || '262144', 10),
    maxMessages: Number.parseInt(process.env.CONVERSATION_CONTEXT_MAX_MESSAGES || '128', 10),
    maxToolResultBytes: Number.parseInt(process.env.CONVERSATION_TOOL_RESULT_MAX_BYTES || '4000', 10),
  });
  const presentationService = new PresentationService({ synthesize, publish });
  // 唯一的 AgentLoop：对话、选歌任务与串词共用同一个（不新建第二套 Agent）。
  const agentLoop = new AgentLoop({
    chat,
    toolRegistry,
    contextBudgeter,
    intentRouter: new IntentRouter(),
    timeoutMs: Number.parseInt(process.env.VIRTUAL_PERSON_TURN_TIMEOUT_MS || '120000', 10),
  });
  // ambient 推荐（add-ambient-music-recommendation）：会话库里的推荐表 + 闸门；没有选歌服务时不推荐。
  const ambientRecommendations = getMusicService ? createAmbientRecommendations({ conversationStore, getMusicService,
    playbackRuntime, trace: (sessionId, event) => sessionTrace?.recordScoped?.(sessionId, event), logger }) : null;
  const runtime = new VirtualPersonRuntime({
    conversationStore,
    registry,
    promptAssembler: new PromptAssembler(),
    contextBudgeter,
    agentLoop,
    responsePlanner: createContextualResponsePlanner({ agentLoop, toolRegistry }),
    presentationService,
    retrieveMemories: input => retrieveMemories(getMemoryService, { ...input, isSharedMemoryActive }, conversationStore),
    getEnvironment,
    getLifeContext: getLifeContext
      ? ({ sessionId, entity, participants }) => {
        try {
          return getLifeContext({ sessionId, personId: entity?.id, participants });
        } catch {
          return null;
        }
      }
      : null,
    capabilityResolver: (entity, { musicOwnerId }) => {
      // 「多说点 / 安静点」的 typed tool 由 presence 装配注册；没注册时这个能力不对应任何工具。
      const capabilities = [PERSON_MEMORY_CAPABILITY, PRESENCE_PREFERENCE_CAPABILITY];
      if (webAccess?.policy.snapshot().enabled) capabilities.push(WEB_CAPABILITY);
      if (getMusicService) {
        capabilities.push(MUSIC_CAPABILITY);
        if (entity.id === musicOwnerId) capabilities.push(MUSIC_MUTATION_CAPABILITY);
      }
      if (personaGateway) capabilities.push(PERSONA_SWITCH_CAPABILITY);
      if (personaGateway && entity.kind === 'root') capabilities.push(PERSONA_CREATE_CAPABILITY);
      return capabilities;
    },
    getRuntimeState: ({ sessionId }) => {
      const snapshot = playbackRuntime.listeningSnapshot?.(sessionId) || playbackRuntime.snapshot();
      return sanitizeFacts({
        playback: snapshot,
        companionMode: describeCompanionMode(snapshot.companionModeId),
        ...(playbackRuntime.listeningSnapshot ? {} : { queue: queueService.snapshot() }),
      });
    },
    basicPlaybackFallback: getMusicService
      ? input => tryBasicPlaybackFallback(input, { getMusicService, toolRegistry })
      : null,
    // 「正在输入」只是瞬时提示：直接广播，不进账本、不进 runtime-state。
    onActivity: payload => publish({ type: 'presence-activity', payload }),
    onTurnCommitted: async event => {
      publish({ type: 'TURN_COMMITTED', payload: event });
      if (typeof observeCommittedTurn === 'function') await observeCommittedTurn(event);
    },
    sessionTrace,
    webAccess,
    ambientRecommendations,
    logger,
  });
  const chatService = new VirtualPersonChatService({ runtime, presentationService, queueService, sessionTrace, logger });
  return Object.freeze({ runtime, chatService, registry, conversationStore, toolRegistry, presentationService, agentLoop, contextBudgeter,
    ambientRecommendations });
}

export {
  PERSONA_CREATE_CAPABILITY,
  PERSONA_SWITCH_CAPABILITY,
  retrieveMemories,
};
export default createVirtualPersonRuntimeComposition;
