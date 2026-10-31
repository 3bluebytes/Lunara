// sourceHealthSignal.js — 解析/播放路径到派生健康状态的**单向**信号。
//
// 健康状态由 RuntimeInfoServices 暴露给设置页，但它的生产者是解析器：只有真正
// 试过某个源，才知道它刚才是好是坏。这个模块只做一次函数注册，避免让解析器
// （被大量离线测试导入）在模块加载时就打开数据库或依赖组合根。
//
// 约定：没有注册监听者时是 no-op；监听者抛错一律吞掉——健康状态是派生信息，
// 永远不能改变一次解析的成败或延迟。

let reporter = null;

/** 组合根注册「把一次尝试结果记下来」的接收者；传非函数即解除。 */
export function setSourceHealthReporter(fn) {
  reporter = typeof fn === 'function' ? fn : null;
}

/**
 * 报告一次源尝试结果。
 * @param {string} provider 源 id
 * @param {string|null} code 失败原因码；null 表示这次该源成功给出了可播资源
 */
export function reportSourceHealth(provider, code = null) {
  if (!reporter) return;
  const id = String(provider ?? '').trim();
  if (!id) return;
  try {
    reporter(id, code == null ? null : String(code));
  } catch { /* 派生状态绝不冒泡到解析路径 */ }
}

/** 仅测试使用：清掉注册，避免用例之间互相影响。 */
export function resetSourceHealthReporter() {
  reporter = null;
}
