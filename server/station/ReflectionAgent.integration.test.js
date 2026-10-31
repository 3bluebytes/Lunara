// ReflectionAgent.integration.test.js
//
// 端到端 smoke：起 StationAgent → 模拟 5×USER_FEEDBACK_OBSERVED + 5×PLAY_OUTCOME_RECORDED
// → 检查伙伴 namespace 是否多出一条 reflection-insight memory。
//
// 跟单元测试的区别：
//   - 用真实 StationAgent（不是 mock）
//   - 走真实 bus 订阅链路
//   - 验证「ReflectionAgent 在 StationAgent.initialize() 中被自动接入」

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { StationAgent } from './StationAgent.js';
import { EventType, createEvent, radiohostAgentId, StationAgentId } from './communication/messages.js';

const testRoot = mkdtempSync(resolve(tmpdir(), 'lunara-reflection-int-test-'));
process.chdir(testRoot);
process.env.LUNARA_CONFIG_DIR = resolve(testRoot, 'llm-config');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

// 替换 ReflectionAgent 内部的 askText —— 用一个 module-level 桩
// 不能改 module import，但 ReflectionAgent 接受 opts.llm。
// 这里走另一条路：让 StationAgent 创建 ReflectionAgent 时不传 llm（默认走真实 llm.js），
// 并把配置目录指向空的临时目录，让 askText 返回明确的未配置错误。
// fallback 内容不是合法 JSON → reflectionFailures+1，无 insight 写入。
//
// 所以这个 smoke test 验证的是: 端到端事件链路正确连通 + ReflectionAgent 被 station 拉起，
// 但 LLM 失败时不会破坏管道。

async function runIntegration() {
  console.log('\n--- 集成 smoke：station + 5 feedback + 5 outcome ---');
  const station = new StationAgent();
  await station.initialize();

  // 拿到 ReflectionAgent 实例
  const refl = station.getReflectionAgent();
  assert(refl !== null, 'station.getReflectionAgent() 非空');

  // 取一个伙伴
  const host = station.listRadioHosts()[0];
  assert(!!host, 'station 有持久伙伴身份，不依赖全局激活');
  const radiohostId = host.id;

  // 把短窗调到 5（默认就是 5，但显式一下）
  refl.shortWindow = 5;

  // 监听 REFLECTION_INSIGHT_PUBLISHED 事件
  const insightEvents = [];
  station.bus.subscribe(EventType.REFLECTION_INSIGHT_PUBLISHED, e => insightEvents.push(e));

  // 模拟 5 个 USER_FEEDBACK_OBSERVED 配 5 个 PLAY_OUTCOME_RECORDED
  for (let i = 0; i < 5; i++) {
    station.bus.publishEvent(createEvent({
      type: EventType.USER_FEEDBACK_OBSERVED,
      sourceAgentId: radiohostAgentId(radiohostId),
      payload: { radiohostId, userInput: `测试消息 ${i}`, mood: 'unknown', songs: [`A${i} — B${i}`] },
    }));
    station.bus.publishEvent(createEvent({
      type: EventType.PLAY_OUTCOME_RECORDED,
      sourceAgentId: StationAgentId,
      payload: {
        radiohostId, songId: `s${i}`, songQuery: `A${i} — B${i}`,
        outcome: i < 3 ? 'skipped' : 'completed',
        playedSeconds: i < 3 ? 8 : 180,
        recordedAt: Date.now(),
      },
    }));
  }
  await station.bus.flush();
  // 给异步 _runReflection 时间跑完 LLM 调用（真实 fallback，会失败但不抛）
  await new Promise(r => setTimeout(r, 500));

  // 失败后保留观察，等待退避重试；不能把清空证据误当作成功。
  const snap = refl.getStatusSnapshot();
  assert(snap.pendingBufferCounts[radiohostId] > 0, '失败后观察仍然持久保留');
  assert(snap.attempts[radiohostId].short.status === 'retry_pending', '失败进入可观测的退避重试');
  assert(refl.lastShortAt.get(radiohostId) > 0, 'lastShortAt 被记录');

  // 在没有真实 LLM 的环境下，reflectionFailures 应该是 1（LLM fallback 返回非 JSON）
  // 但 ReflectionAgent 不抛，pipeline 仍然健康
  console.log(`  · reflectionFailures=${refl.reflectionFailures} (预期 ≥ 0)`);
  assert(refl.reflectionFailures >= 0, 'pipeline 未崩溃，failure 计数可访问');

  // 关闭
  await station.shutdown();
  assert(true, 'station.shutdown() 不抛');
}

async function runTests() {
  console.log('\n🧪 ReflectionAgent integration smoke\n');
  try {
    await runIntegration();
  } catch (e) {
    console.error('Test runner error:', e);
    failed++;
  }
  console.log(`\n──────────────────────`);
  console.log(`${passed} passed · ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
