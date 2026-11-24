#!/usr/bin/env node
// 仓库独立 NCM 入口。与内嵌路径共用同一监听、停机和依赖日志边界。
// 不直接 require 上游 app.js，避免绕过受管生命周期与日志保护。
// 兼容旧的 PORT/HOST 环境变量；按本地边界只监听 loopback。
import { startEmbeddedNcm } from '../server/ncmEmbedded.js';

const host = String(process.env.HOST || '127.0.0.1').trim();
if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
  console.error(`独立网易云服务只监听 loopback，不支持 HOST=${host}（Lunara 无鉴权，不对外暴露）。`);
  process.exitCode = 1;
} else {
  process.env.NCM_BASE_URL = `http://127.0.0.1:${process.env.PORT || '3000'}`;
  const handle = await startEmbeddedNcm({ env: process.env });
  if (!handle) {
    process.exitCode = 1;
  } else {
    console.log(`网易云音乐服务就绪 → ${handle.baseUrl}${handle.mode === 'reused' ? '（复用已有实例）' : ''}`);
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => { handle.stop().finally(() => process.exit(0)); });
    }
  }
}
