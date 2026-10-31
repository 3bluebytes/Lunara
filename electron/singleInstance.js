// singleInstance.js — 桌面单实例契约（desktop-packaging 规格：同一数据根只允许一个桌面进程）。
//
// - 拿不到锁：说明已有一个 Lunara 桌面进程在运行，调用方必须直接 app.quit()。
// - 拿到锁：注册 second-instance 监听，二次启动时聚焦既有窗口。
// - 全部容错：锁/监听失败只降级告警，不阻塞启动（单实例是保护，不是开关）。
//
// 可测试性：app 以替身注入（requestSingleInstanceLock + on），不拉真 Electron。

export function acquireSingleInstance(app, {
  onSecondInstance = () => {},
  log = console,
} = {}) {
  let gotLock = false;
  try {
    gotLock = app.requestSingleInstanceLock() === true;
  } catch (error) {
    log?.warn?.(`[desktop] 单实例锁请求失败（按未获得处理）: ${error?.message || error}`);
    gotLock = false;
  }
  if (!gotLock) return false;

  try {
    app.on('second-instance', () => {
      try {
        onSecondInstance();
      } catch (error) {
        log?.warn?.(`[desktop] 聚焦既有窗口失败: ${error?.message || error}`);
      }
    });
  } catch (error) {
    log?.warn?.(`[desktop] second-instance 监听注册失败: ${error?.message || error}`);
  }
  return true;
}
