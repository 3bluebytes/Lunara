# 安全政策与漏洞报告

## 受支持版本

目前项目处于首次公开发布阶段，仅对当前主分支最新版本提供安全修复：

| 版本 | 支持状态 |
| --- | --- |
| `0.1.x` | ✅ 支持 |

## 报告安全漏洞

如果你发现了可能影响 Lunara 用户隐私或安全的问题，请通过公开仓库的 [GitHub 私密漏洞报告](https://github.com/3bluebytes/Lunara/security/advisories/new) 联系维护者。在维护者确认与修复前，**请勿在公开 Issue、Pull Request 或社区讨论中发布漏洞利用细节或个人数据**。

提交报告时请尽量包含：

- Lunara 版本号或提交哈希、操作系统与架构；
- 受影响的配置或功能模块、以及可复现的步骤；
- 请使用合成数据或最小复现案例，**切勿附上**真实的 API Key、音乐账号 Cookie、私人聊天内容、`.env`、`~/.lunara/config.json`、数据库文件或 `~/.lunara/sessions/` 下的完整会话跟踪日志；截图与日志片段请务必先脱敏。

## 安全边界说明

- **本地单用户模型**：Lunara 是本地单用户应用，服务默认仅绑定 `127.0.0.1` 并校检 loopback `Host` 且不下发 CORS 头，设计上**没有远程账号与鉴权**。请勿将 `LUNARA_HOST` 设为 `0.0.0.0`，也不要把本地端口暴露或转发到局域网 / 公网。
- **普通使用问题**：不涉及安全或隐私泄露的功能故障，请通过 [GitHub Issues](https://github.com/3bluebytes/Lunara/issues) 反馈。
