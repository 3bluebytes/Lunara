import { randomUUID } from 'node:crypto';

export const VirtualPersonKind = Object.freeze({
  ROOT: 'root',
  RADIOHOST: 'radiohost',
});

export const TurnRole = Object.freeze({
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL: 'tool',
});

export const TurnVisibility = Object.freeze({
  VISIBLE: 'visible',
  INTERNAL: 'internal',
});

export const RequestState = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ABORTED: 'aborted',
});

export const ToolOutcomeKind = Object.freeze({
  SUCCESS: 'success',
  BUSINESS_FAILURE: 'business_failure',
  INTERNAL_FAILURE: 'internal_failure',
});

function requiredString(value, name, max = 512) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new TypeError(`${name} must not be empty`);
  return normalized.slice(0, max);
}

function optionalString(value, max = 4096) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, max) : '';
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function createVirtualPersonEntity(input = {}) {
  const kind = Object.values(VirtualPersonKind).includes(input.kind)
    ? input.kind
    : VirtualPersonKind.RADIOHOST;
  const id = requiredString(input.id || `person_${randomUUID().slice(0, 12)}`, 'virtualPerson.id', 128);
  if (kind === VirtualPersonKind.ROOT && input.parentId) {
    throw new TypeError('root virtual person cannot have parentId');
  }
  return deepFreeze({
    id,
    parentId: input.parentId ? requiredString(input.parentId, 'virtualPerson.parentId', 128) : null,
    kind,
    displayName: requiredString(input.displayName || id, 'virtualPerson.displayName', 80),
    personaDocument: optionalString(input.personaDocument, 20_000),
    relationshipStance: optionalString(input.relationshipStance, 4000),
    voiceProfileId: optionalString(input.voiceProfileId, 128),
    toolProfileId: optionalString(input.toolProfileId || 'default', 128),
    modelProfileId: optionalString(input.modelProfileId || 'dialogue', 128),
    memoryNamespace: requiredString(input.memoryNamespace || `person:${id}`, 'virtualPerson.memoryNamespace', 256),
    status: optionalString(input.status || 'active', 32),
    createdAt: Number(input.createdAt) || Date.now(),
    updatedAt: Number(input.updatedAt) || Date.now(),
  });
}

export function createToolOutcome(input = {}) {
  const kind = Object.values(ToolOutcomeKind).includes(input.kind)
    ? input.kind
    : (input.ok ? ToolOutcomeKind.SUCCESS : ToolOutcomeKind.BUSINESS_FAILURE);
  const ok = kind === ToolOutcomeKind.SUCCESS;
  const presentation = input.presentation && typeof input.presentation === 'object'
    ? {
        displayText: optionalString(input.presentation.displayText, 2000),
        spokenText: optionalString(input.presentation.spokenText, 1000),
        speak: input.presentation.speak === true,
        severity: optionalString(input.presentation.severity || (ok ? 'info' : 'warning'), 32),
        retryable: input.presentation.retryable === true,
        // 终止性提交可以放行模型在同一条消息里写好的话（committedLine.js 机械校验）；只放已提交的歌名。
        ...(Array.isArray(input.presentation.modelLine?.allowedTitles)
          ? { modelLine: {
            allowedTitles: input.presentation.modelLine.allowedTitles
              .map(title => optionalString(title, 120)).filter(Boolean).slice(0, 10),
            // 其中由本轮其他成员推荐的歌名：回复不能把它们说成自己挑的。
            ...(Array.isArray(input.presentation.modelLine.othersTitles) && input.presentation.modelLine.othersTitles.length
              ? { othersTitles: input.presentation.modelLine.othersTitles
                .map(title => optionalString(title, 120)).filter(Boolean).slice(0, 10) }
              : {}),
          } }
          : {}),
      }
    : { displayText: '', spokenText: '', speak: false, severity: ok ? 'info' : 'warning', retryable: false };
  return deepFreeze({
    ok,
    kind,
    code: requiredString(input.code || (ok ? 'OK' : 'OPERATION_FAILED'), 'toolOutcome.code', 128),
    terminal: ok && input.terminal === true,
    facts: input.facts && typeof input.facts === 'object' ? structuredClone(input.facts) : {},
    modelContext: optionalString(input.modelContext, 12_000),
    presentation,
    internal: {
      correlationId: optionalString(input.internal?.correlationId, 128),
      errorId: optionalString(input.internal?.errorId, 128),
    },
  });
}

export function createPresentationEnvelope(input = {}) {
  const displayText = requiredString(input.displayText, 'presentation.displayText', 8000);
  const speak = input.speak === true;
  const spokenText = optionalString(input.spokenText, 2000);
  if (speak && !spokenText) throw new TypeError('spokenText is required when speak=true');
  return deepFreeze({
    displayText,
    spokenText,
    speak,
    virtualPersonId: requiredString(input.virtualPersonId, 'presentation.virtualPersonId', 128),
    voiceProfileId: optionalString(input.voiceProfileId, 128),
    mood: optionalString(input.mood, 64),
    sourceTurnId: requiredString(input.sourceTurnId, 'presentation.sourceTurnId', 128),
    correlationId: optionalString(input.correlationId, 128),
    conversationId: optionalString(input.conversationId, 128),
    expiresAt: Number(input.expiresAt) || Date.now() + 120_000,
  });
}

export function createCommittedTurnEvent(input = {}) {
  return deepFreeze({
    type: 'TURN_COMMITTED',
    sessionId: requiredString(input.sessionId, 'turnEvent.sessionId', 128),
    requestId: requiredString(input.requestId, 'turnEvent.requestId', 128),
    virtualPersonId: requiredString(input.virtualPersonId, 'turnEvent.virtualPersonId', 128),
    userTurnId: requiredString(input.userTurnId, 'turnEvent.userTurnId', 128),
    assistantTurnId: requiredString(input.assistantTurnId, 'turnEvent.assistantTurnId', 128),
    displayText: requiredString(input.displayText, 'turnEvent.displayText', 8000),
    outcomeCodes: Object.freeze((Array.isArray(input.outcomeCodes) ? input.outcomeCodes : []).map(String).slice(0, 32)),
    committedAt: Number(input.committedAt) || Date.now(),
  });
}

export function createTurnId() {
  return `turn_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

export function createRequestId() {
  return `rq_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}
