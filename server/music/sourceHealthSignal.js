// sourceHealthSignal.js — 解析/播放路径到派生健康状态的**单向**信号。
//
// 健康状态由 RuntimeInfoServices 暴露给设置页，但它的生产者是解析器：只有真正
// 试过某个源，才知道它刚才是好是坏。这里只注册观察者并绑定恢复观察的代次，避免让解析器
// （被大量离线测试导入）在模块加载时就打开数据库或依赖组合根。
//
// 约定：没有注册监听者时是 no-op；监听者抛错一律吞掉——健康状态是派生信息，
// 永远不能改变一次解析的成败或延迟。

let reporter = null;
let captureAttempt = null;
let reporterGeneration = 0;

/** 组合根注册观察者和来源故障代次读取器；替换接线使所有旧恢复回调失效。 */
export function setSourceHealthReporter(fn, capture = null) {
  reporter = typeof fn === 'function' ? fn : null;
  captureAttempt = typeof capture === 'function' ? capture : null;
  reporterGeneration += 1;
}

/** 必须早于解析的异步操作调用；返回的成功回调不携带媒体或账号数据。 */
export function beginSourceHealthAttempt(provider) {
  const id = String(provider ?? '').trim();
  const generation = reporterGeneration;
  let attempt;
  try { attempt = captureAttempt?.(id); } catch { return () => {}; }
  return () => {
    if (generation === reporterGeneration) reportSourceHealth(id, null, attempt);
  };
}

/**
 * 报告一次源尝试结果。
 * @param {string} provider 源 id
 * @param {string|null} code 失败原因码；null 表示这次该源成功给出了可播资源
 */
export function reportSourceHealth(provider, code = null, attempt = undefined) {
  if (!reporter) return;
  const id = String(provider ?? '').trim();
  if (!id) return;
  try {
    reporter(id, code == null ? null : String(code), attempt);
  } catch { /* 派生状态绝不冒泡到解析路径 */ }
}

/** 仅测试使用：清掉注册，避免用例之间互相影响。 */
export function resetSourceHealthReporter() {
  setSourceHealthReporter(null);
}
