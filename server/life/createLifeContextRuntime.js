// 生活上下文的应用装配：数据库位置、失效通知与 getLifeContext 注入点。
// 组合根只保留一行调用，职责与依赖都在这里（工厂注入依赖）。

import { resolve, dirname } from 'node:path';
import { LifeContextStore } from './LifeContextStore.js';
import { LifeContextService } from './LifeContextService.js';

export function createLifeContextRuntime({ resolveDatabasePath, playbackRuntime, now } = {}) {
  const store = new LifeContextStore({
    dbPath: resolve(dirname(resolveDatabasePath()), 'life.db'),
    ...(now ? { now } : {}),
  });
  const service = new LifeContextService({
    store,
    ...(now ? { now } : {}),
    onRevisionChange: () => {
      // 授权/内容变化让依赖旧生活资料的未播串词作废；歌曲、进度与历史不动。
      const snapshot = playbackRuntime.snapshot();
      const sessions = [snapshot.activeListeningSessionId, ...Object.keys(snapshot.suspendedSessions || {})];
      for (const sessionId of new Set(sessions)) void playbackRuntime.invalidatePreparedNarrations(sessionId, { includeCurrent: true });
    },
  });
  const lifeTargetDate = () => {
    const timeZone = service.getRoutine().timeZone || undefined;
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
  };
  return Object.freeze({
    store,
    service,
    start: () => store.initialize(),
    stop: () => store.close(),
    lifeTargetDate,
    getLifeContext: ({ sessionId, personId, participants }) => service.buildLifeContextSnapshot({
      personId, participants, targetDate: lifeTargetDate(), listeningSessionId: sessionId,
    }),
  });
}

export default createLifeContextRuntime;
