# Lunara Windows 构建日志

目标:在 Windows 上验证 Lunara(Electron 桌面应用)能否编译并运行。
开始时间: 2026-10-31

## 环境信息

| 项目 | 值 |
|---|---|
| OS | Windows(通过 Git Bash 操作) |
| Node | v24.18.0 |
| npm | 11.16.0 |
| Python | 3.14.6 |
| MSVC Build Tools | 18/BuildTools,MSVC 14.51.36231 (cl.exe 19.51) |
| 仓库 | https://github.com/3bluebytes/Lunara (commit 825abea, v0.1.0) |

项目关键依赖:
- electron ^39.8.10 + electron-builder ^26.15.3(已有 win/NSIS 配置)
- better-sqlite3 ^12.9.0(原生模块,需要本地编译或预编译二进制)
- ffmpeg-static / ffprobe-static(install 脚本从 GitHub 下载二进制)
- NeteaseCloudMusicApi、@sansenjian/qq-music-api(纯 JS)

## 问题记录

### 问题 1: ffmpeg-static 安装脚本下载二进制超时(已定位)
- 时间: 2026-10-31
- 现象: `npm install` 失败,ffmpeg-static 的 `node install.js` 报
  `connect ETIMEDOUT 20.205.243.166:443`(GitHub 直连超时,20.205.243.166 是 github.com 的 IP)
- 原因: 本机无法直连 GitHub(curl 实测:直连 000/超时,19s 失败)
- 环境现状: npm registry 已配置为 npmmirror;本机 127.0.0.1:7890 有可用代理(Clash 系,实测经代理访问 GitHub 200/1.4s)
- 解决: 双保险 —— 设置代理环境变量 + npmmirror 镜像:
  - `HTTPS_PROXY/HTTP_PROXY=http://127.0.0.1:7890`
  - `FFMPEG_BINARIES_URL=https://registry.npmmirror.com/-/binary/ffmpeg-static`
  - `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
  - `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`
  - `npm_config_better_sqlite3_binary_host_mirror=https://npmmirror.com/mirrors/better-sqlite3`

### 问题 2: npm cleanup EPERM 警告(轻微)
- `npm warn cleanup EPERM rmdir ... node_modules\pkijs\node_modules\@noble\hashes`
- Windows 上常见的文件占用/杀软扫描导致的清理失败警告,通常重装可自愈。

### 问题 3: 本机 npm 启用 allow-scripts 安全机制,安装脚本被拦截(已解决)
- 时间: 2026-10-31
- 现象: 首次 `npm install` 虽然成功装包,但 4 个带 install/postinstall 脚本的包没有执行脚本:
  better-sqlite3(下载/编译 .node)、electron(下载 electron.exe 二进制)、electron-winstaller、ffmpeg-static(下载 ffmpeg.exe)
- 原因: 本机 npm 配置了 allowScripts 白名单机制,未批准的安装脚本默认不执行
- 解决: `npm approve-scripts better-sqlite3 electron electron-winstaller ffmpeg-static`,重跑 `npm install`
- 结果: electron.exe / ffmpeg.exe / ffprobe.exe(win32/x64) / better_sqlite3.node(Node24 ABI) 全部就位
- 注意: better_sqlite3.node 当前是 Node ABI 版,Electron 运行还需 electron-rebuild 切换 ABI

### 问题 4: npm_config_better_sqlite3_binary_host_mirror 已被 npm 判为未知配置(轻微)
- `npm warn Unknown env config "better-sqlite3-binary-host-mirror"`
- 但 binary 实际下载成功,可能走的 prebuild-install 默认 GitHub 源(经代理可用),不影响结果

### 问题 5: scripts/doctor.mjs 使用 Unix 专属的环境变量前缀语法(已修复)
- 时间: 2026-10-31
- 现象: doctor 的「Electron ABI 对齐」检查在 Windows 上必败,报「Electron 未安装或读取 ABI 失败」
- 原因: `execSync(\`ELECTRON_RUN_AS_NODE=1 .bin/electron -e ...\`)` 是 bash 语法;
  两个 Windows 不兼容点: ① cmd.exe 不支持 `VAR=value cmd` 前缀; ② node_modules/.bin/electron 在 Windows 是 .cmd shim,不能被 spawn 直接执行
- 修复: 改用 `spawnSync` + 显式 `env: { ELECTRON_RUN_AS_NODE: '1' }`,并直接指向 `node_modules/electron/dist/electron.exe`
- 结果: doctor 现在正确输出「Electron 当前 ABI = 140」
- 状态: ✅ 已修复(这是本次验证发现的第一个代码级 Mac-only 问题)

### 问题 6【严重】 electron/main.js 动态 import 用 Windows 裸路径 → 启动即崩(已修复)
- 时间: 2026-10-31
- 现象: `npm start` 后 `[boot] failed ERR_UNSUPPORTED_ESM_URL_SCHEME: Only URLs with a scheme in: file, data, node, and electron are supported... Received protocol 'd:'`,服务端未起,窗口无内容
- 原因: `electron/main.js:152` `await import(resolve(ROOT, 'server/index.js'))` 直接传 Windows 绝对路径。
  ESM 动态导入要求 URL 或可转 URL 的路径;POSIX 绝对路径(mac `/Users/...`)能隐式处理,
  但 Windows 的 `D:\...` 被解析为 `d:` 协议 → 报错。**这是本次验证发现的最核心 Mac-only 问题**
- 修复: `await import(pathToFileURL(resolve(ROOT, 'server/index.js')).href)`,从 'url' 导入 `pathToFileURL`(Node 内置,双平台正确)
- 状态: ✅ 已修复,待重启验证

### 问题 7(轻微): 首次截图时 Lunara 窗口被其它窗口遮挡/位置偏左
- 非缺陷,仅窗口位置恢复问题;置前后确认 UI 完整渲染(标签栏/封面/介绍区块均正常)

### 问题 8【严重·流程教训】 git reset --hard 回滚了已修复的生产代码(已恢复)
- 修 CRLF 时执行了 `git rm --cached -r . && git reset --hard`,把当时已修好的
  electron/main.js、scripts/doctor.mjs、bin/lunara.js 全部回滚到 HEAD
- 打包产物未受影响(构建于回滚前),但工作区代码丢失;后续发现 bin/lunara.js 测试报错与修复前一致才察觉
- 处理: 三个修复全部重新应用,并用 asar 抽取验证了最终安装包含修复
- 教训: 大规模重新检出/规范化前,应先 commit 或 stash 已有修改

### 问题 9: 第二次构建的安装包内 better_sqlite3.node ABI 错误(已修复)
- 现象: 第二次构建的安装包启动报 ERR_DLOPEN_FAILED(NODE_MODULE_VERSION 137 ≠ 140)
- 原因: `npm test` 的 pretest 会把 better-sqlite3 rebuild 回 Node ABI;随后 electron-builder 的
  重建缓存误判「已是最新」跳过重编,把 Node ABI 的 .node 打进了包
- 修复: 打包前强制 `npx electron-rebuild -f -w better-sqlite3` 再 dist:win
- 注意: 这是平台无关的构建顺序陷阱(mac 上 `npm test && npm run dist:mac` 同样会触发),
  建议在 dist 脚本里固化强制 rebuild

### 问题 10【关键经验】 node:test 的 after hook 按注册顺序(FIFO)执行,不是 LIFO
- 多个测试假设「后注册的清理先跑」(先 close DB 再 rm 临时目录),实际按注册顺序执行,
  导致 rm 先于 close,Windows 上因文件被锁 EPERM;POSIX 上 rm 打开中的文件也能成功,故 mac 从不暴露
- 修复: virtual-person 5 个测试文件的清理改为单 hook 顺序清理 / 文件级 after 统一清理
- 另: Windows 进程不能删除自己的当前工作目录(EPERM),需先 chdir(tmpdir()) 再删

### 问题 11: 测试污染真实数据根 ~/.lunara(已修复+清理)
- expressionPreferences / narrationWiring 的 MemoryService 未设 LUNARA_DB_PATH,写入了真实
  ~/.lunara/data/state.db;撤销记录(writeKey 确定性)永久拦截后续重跑
- 修复: 测试内固定 LUNARA_DB_PATH;删除被污染的 state.db(应用自动重建)

### 问题 12: dataRootMigration 源库句柄泄漏(生产 bug,已修复)
- `runMigration` 的 `openSourceDatabase` 返回的 db 从不关闭;POSIX 无感,
  Windows 上迁移后源目录被句柄锁定无法清理
- 修复: 复制校验完成后 `attempt.db.close()`

### 问题 13: userData 的 ENOTDIR 语义差异(生产改进,已修复)
- Windows 无 ENOTDIR: 路径分量被普通文件占位时 copyFile 也报 ENOENT,
  「模板缺失则容忍」逻辑会吞掉真实故障
- 修复: ENOENT 时检查模板父目录是否真的是目录,堵死则照常告警

### 问题 14: 测试断言的平台假设(已修复 17 处)
- 路径正则用 `/`(runtimePaths)、注入假路径未过 path.resolve(ensure-electron、start-music-source、
  bin applyCliEnv)、POSIX 权限位 0600/0700 断言(songTag/ttsCustom/ttsFallback/llmConfig/llmProviders/
  sessionTraceStore)、shebang+exec 位(audioToolPaths)、chmod 0o555 目录只读(dataRootMigration)
- 策略: 路径断言改平台无关;纯 POSIX 语义加 win32 skip 并注明原因

### 问题 15: git autocrlf=true 把整个工作区转成 CRLF(已修复)
- CSS 断言用 \n 匹配必败。新增 .gitattributes 锁定 LF + `git config core.autocrlf input` + 重新检出

## ✅ 最终状态(2026-11-01)
- 测试: **388/388 全部通过**(修复前 366/388)
- 桌面运行: npm start 开发模式 ✅ / win-unpacked 打包版 ✅(HTTP 200、UI 渲染正常)
- 安装包: `dist-desktop/Lunara Setup 0.1.0.exe`(NSIS x64,226MB,含全部修复,asar 抽取验证过)
- 遗留(非构建问题): LLM endpoint 需首次启动在设置浮层配置;QQ 音乐需扫码登录后才有播放 URL

## 对仓库的修改清单

生产代码(5 个文件):
- electron/main.js — 动态 import pathToFileURL 化(修复启动即崩)
- bin/lunara.js — 同上(importServerModule)
- scripts/doctor.mjs — Electron ABI 探测跨平台化(spawnSync + 显式 env)
- server/app/dataRootMigration.js — 源库句柄用完即关
- server/userData.js — ENOENT/ENOTDIR 平台差异消歧

测试/配置:
- .gitattributes(新增,锁 LF) + 本日志 windows-build-log.md
- 17 处测试修复: 路径正则/权限 skip/FIFO hook 顺序/DB 句柄关闭/LUNARA_DB_PATH 隔离

## Windows 构建备忘(重装环境时)
1. npm registry → npmmirror;本机 7890 端口有 Clash 系代理，GitHub 直连不通需走代理
2. 本机 npm 启用 allowScripts 白名单，新装带安装脚本的包需 `npm approve-scripts <pkg>`
3. 打包前强制 `npx electron-rebuild -f -w better-sqlite3`(ABI 缓存陷阱)
4. 需 MSVC Build Tools(cl 19.51 已验证)+ Python 3.x(better-sqlite3 本地编译)

## 附: Windows 窗口观感现代化(2026-11-01)

用户反馈默认标题栏「像上个世纪」。根因与修复:

- 原因: `titleBarStyle: 'hiddenInset'` 是 macOS 专属，Windows 上回落到默认标题栏 +
  Electron 默认菜单栏(File/Edit/View…)
- 先试了 `titleBarOverlay`(WCO): CDP 验证选项合法且小窗口能渲染，但在本机
  Windows build 26200 上**最大化状态下 WCO 按钮不绘制**(系统层 bug，多次截图验证)，放弃
- 最终方案【已落地】: `frame: false` + 自绘窗控
  - electron/main.js: Windows 分支改 `frame: false`；新增 `lunara:window-control` IPC 通道
    (复用 isAppWindow 同源校验)与 maximize 状态上行
  - electron/preload.cjs: 新增 `lunaraDesktop.win`（minimize/toggleMaximize/close/onMaximizeChange）
  - pwa/index.html: #drag-bar 内加 #win-controls 三键(最小化/最大化/关闭) + 内联脚本仅在
    win32 桌面壳启用（加 html.electron-win 类，浏览器/mac 不渲染）
  - pwa/styles.css: 窗控样式(46x34/三键/关闭红悬停/最大化⇄还原图标切换)
- 验证: CDP Page.captureScreenshot 确认按钮渲染；模拟点击验证最小化/最大化/还原与
  is-maximized 图标切换；测试套件 388/388 无回归
- 教训: 排查时 CopyFromScreen 受窗口层级/DPI 虚拟化干扰严重，**用 CDP
  Page.captureScreenshot 直接截页面自身渲染**才是可靠验证手段
