# zen-git 全量审计发现与执行计划(OPTIMIZATION-FINDINGS)

> **审计日期**:2026-06-26
> **审计范围**:`zen-gitsync v2.13.30`(发布包名),仓库根 `E:/workspace/github_workspace/zen-git`
> **审计方式**:四路并行只读审计 — 服务端 / 前端 / 依赖与配置 / 测试与文档,共回收 **148** 条原始发现。
> **本文件目标**:去重合并 → 按六大维度分类 → 每条带文件路径/行号/问题/方案/优先级/影响面/风险 → 末尾给出推荐执行顺序。
> **后续约束**:本任务**只交付清单**,不修改任何源码;执行阶段按本文件末尾的顺序逐项开 PR。
> **关联文档**:`docs/OPTIMIZATION-PLAN.md`(已落地的 5 项 UI 优化) · `docs/UX-AUDIT.md`(24 条 a11y/UX 问题) · `docs/PROJECT_MAP.md`(项目地图) · `CHANGELOG.md`(变更日志) · `memory/zen-git-security-perf-audit-2026-06-21.md`(上轮审计)。

---

## 0. 执行摘要

| 维度 | 合并后条目 | 高优先 | 中优先 | 低优先 | 高优占比 |
|------|-----------|--------|--------|--------|---------|
| ① 代码质量 | 16 | 2 | 7 | 7 | 12% |
| ② 性能 | 9 | 1 | 5 | 3 | 11% |
| ③ 安全 | 11 | **9** | 2 | 0 | 82% |
| ④ 可维护性 | 14 | 2 | 5 | 7 | 14% |
| ⑤ 依赖与配置 | 12 | 3 | 4 | 5 | 25% |
| ⑥ 测试与文档 | 8 | **5** | 3 | 0 | 62% |
| **合计** | **70** | **22** | **26** | **22** | — |

**最紧急(本周内)**:
1. **SEC-RCE-1** `vm.runInContext` RCE(`/api/execute-code-node`)
2. **SEC-INJ-1~4** `shell:true` 注入(`/api/exec-stream`、socket `exec_interactive`、`/api/run-npm-script`、`open-new-tab-gui`)
3. **SEC-PATH-1~3** 任意文件读/写/删(`/api/file-content`、`/api/resolve-conflict`、`/api/revert_file`、code-analysis)
4. **SEC-CHDIR-1** `process.chdir` 到攻击者路径(`/api/change_directory`)
5. **DEP-SEC-1** `.npmrc` 明文 NPM_TOKEN 泄露 — **立即撤销并轮换**
6. **DEP-REL-1** `release.js` `git add .` + 自动 push(可能误发布)
7. **TEST-1** `test/ts-demo.test.ts` 携带合并冲突标记,跑 `node --test` 直接挂掉
8. **TEST-2** `CHANGELOG.md` 落后 6 个 minor 版本 / 6 周没更新

**最大收益(本季度)**:
- 拆 `WorkbenchView.vue`(3508 行)→ 4 子组件
- 拆 `CommandConsole.vue`(3728 行)→ 4 子组件
- 拆 `gitStore.ts`(2406 行)→ 4 store
- 拆 `configStore.ts`(1282 行)→ 5 store
- 补 `workbench.js`(3410 行)、`npm.js`(1356 行)、`gitOps.js`(1145 行)、`exec.js`(279 行) 0 测试覆盖

---

## 1. 维度① · 代码质量

| 编号 | 文件 / 行号 | 类别 | 问题描述 | 推荐方案 | 优先级 | 影响面 | 风险 |
|------|-------------|------|---------|---------|--------|--------|------|
| CQ-1 | `src/utils/index.js` L244/307-316/419-432 | 一致性 | `MAX_OUTPUT_LENGTH = 5000` 在同一文件出现 3 次,`addCommandToHistory` 内还有局部 shadow;截断字符串不一致(`'... (output truncated)'` vs `'...[truncated]'`),且按字节截断可能切断多字节中文 | 提取模块顶层 `const MAX_OUTPUT_LENGTH = 5000`,改用 `Buffer.byteLength` 判断,在 80% 处回退到最近的 char boundary | 低 | CLI 命令历史 tooltip 显示 | 极低 |
| CQ-2 | `src/ui/server/index.js` L79-419 | 状态管理 | `currentProjectPath` / `projectRoomId` / `isGitRepo` / `branchStatusCache` / `recentPushStatus` 全是模块级 `let`,在 async handler 内无锁修改 → 并发请求状态不一致 | 包装成 `state` 对象 + `withState(mutator)` 串行辅助(或引入 `immer`/deep clone 快照) | 中 | 整个 server 模块;尤其在 `/api/change_directory` 与 `/api/branch-status` 并发时 | 中(全模块改造) |
| CQ-3 | `src/ui/client/src/views/EditorView.vue` L63,188-213 | Vue 响应式 | `treeNodes` 是 `ref<TreeNode[]>` 但 `filterTree()` 直接 mutate 子属性再返回同一数组,Vue tracking 依赖数组 identity,容易出现"搜索后状态陈旧" | 改 `nodes.map(...)` 生成新顶层数组,或换 `shallowRef` + 版本号手动 bump | 中 | 文件树搜索交互 | 中(可能影响状态保留) |
| CQ-4 | `src/ui/client/src/views/WorkbenchView.vue` L114,350 | Vue 响应式 | `dirtySubIds.value.clear()` 在 `computed` 返回的 Set 上 mutate,绕过 Vue tracking — 可读但反模式 | `subSnapshot.value.clear(); subSnapshot.value = new Map()` 重新赋值 | 中 | 任务清除子任务按钮 | 低 |
| CQ-5 | `src/ui/client/src/views/WorkbenchView.vue` L183-201 | 性能/可读性 | `watch` 源是 `{ id, title, desc, promptId, simpleOverride, sequential }` 的浅展开对象 + `deep: true`,但源字段都是标量,deep 无意义 | 去掉 `{ deep: true }`,或把 watcher 源改为 getter 返回的浅值 | 低 | Workbench 任务编辑流 | 极低 |
| CQ-6 | `src/ui/client/src/stores/gitStore.ts` L27 · `CommandConsole.vue` L37 | 模块副作用 | `const backendPort = getBackendPort()` 在模块顶层同步执行,如果 `.port` 文件尚未生成就缓存 `3000`,后续永不重读 | 在 `initSocket` / 组件 `onMounted` 里再调用 | 中 | 首次 preview_start 后 socket 连错端口 → 短暂 ECONNREFUSED | 低 |
| CQ-7 | `src/ui/client/src/App.vue` L107-112,224-228 · `EditorView.vue` L467-521 · `SourceMapView.vue` L30-36 | 重复 | 三处 `MutationObserver(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })` 几乎一致 | 提取 `useThemeObserver()` composable,返回 `readonly(ref<string>)` | 中 | 3 个视图主题切换 | 极低 |
| CQ-8 | `src/ui/client/src/composables/useNetworkStatus.ts` L31-39,84-145 | 内存安全 | fetch patch 引用保存到模块作用域,`start()` 多次调用会被 `patched` 守卫拦截,但 HMR 闭包可能持有 stale `ref` | 改单例 + HMR-safe 清理,或 `getNetworkStatus()` 工厂 | 低 | HMR 边缘场景内存泄漏 | 低 |
| CQ-9 | `src/ui/client/src/components/CommandConsole.vue` L1947-1952,2205-2226 | 内存泄漏 | 交互式命令注册 5 个 socket listener,各分支虽调用 `socket.off` 但若组件 unmount 时命令仍运行 → listener 不清,detached Vue ref 继续接收推送 | 把 `socket.off(...)` 全部移到 `onUnmounted`,与 `socket.disconnect()` 同位置 | **高** | 长时间使用 CommandConsole | 中(改动 socket 生命周期) |
| CQ-10 | `src/ui/client/src/views/WorkbenchView.vue` L275-281,252-272 | 重复 | `formatSubErrorTime` 与 `copyToClipboard` 在多组件重复出现(LogList、AISplitChatPane、AISplitDirectPane 等) | 提取到 `src/ui/client/src/utils/datetime.ts` 与 `clipboard.ts` | 低 | 多组件复用 | 极低 |
| CQ-11 | `src/ui/client/src/App.vue` L884-1628 | 体积 | `<style>` 块 ~1500 行,**未** scoped,含大量通用组件样式(`.status-box`、`.branch-name`、`.form-label` 等) | 通用样式迁到 `styles/common.scss`,App.vue 只留 shell 样式 | 中 | 全局 CSS 选择器冲突 | 低 |
| CQ-12 | `src/ui/client/src/main.css` L75-110 · `styles/common.scss` L11-20 | 重复 | `:focus-visible` 与 `@media (prefers-reduced-motion: reduce)` 两处声明 | 保留一处(`main.css` 优先,导入顺序在 `main.ts` 已固定) | 低 | 全局样式 | 极低 |
| CQ-13 | `src/ui/server/utils/logger.js` L40-54 | 健壮性 | `redact` 递归无循环引用守卫,遇 `Buffer`/`Uint8Array` 会按 numeric key 输出巨大对象 | 加 `WeakSet seen`,`Buffer` 打印 length 不打内容 | 低 | 调试日志可读性 | 极低 |
| CQ-14 | `src/utils/index.js` L621-625 + `gitCommit.js` L94,112,118 | API 设计 | `exec_exit(exit)` 用 truthy 判断,字符串 `'false'` 会被当 true;函数名歧义("退出"还是"成功") | 改 `if (exit === true)`,参数类型 `boolean` | 低 | CLI 退出行为 | 极低 |
| CQ-15 | `src/ui/server/routes/branchStatus.js` L35-89 | 死代码/误导 | `forceRefresh` 解析后只跳过缓存,但下游 `git rev-list --left-right --count` 仍执行;注释声称"不再走5分钟长缓存"但根本没 5 分钟缓存 | 删除过期注释,要么真加 5s ahead/behind 缓存,要么删 `force` 参数 | 低 | 分支状态查询性能 | 极低 |
| CQ-16 | `src/ui/client/src/stores/gitStore.ts` L148,166,211,225,232,256,432,467,477,512,519,602,614,619,686,690 等 ~15 处 | 噪音 | `console.log($t(...))` 在 dev 大量输出,污染控制台 | 用 `if (import.meta.env.DEV)` 守卫,或发布构建通过 wrapper 剥离 | 低 | dev 调试体验 | 极低 |

---

## 2. 维度② · 性能

| 编号 | 文件 / 行号 | 类别 | 问题描述 | 推荐方案 | 优先级 | 影响面 | 风险 |
|------|-------------|------|---------|---------|--------|--------|------|
| PERF-1 | `src/ui/client/src/views/EditorView.vue` L20,31-35 · `components/MonacoEditor.vue` L18-24 · `views/SourceMapView.vue` L18 | bundle | Monaco (~3 MB) 静态 `import * as monaco from 'monaco-editor'` + worker 在 `MonacoEditor.vue` 顶部,被全局 dialog 引用,导致 entry chunk 必含 Monaco | `defineAsyncComponent` 包装 `MonacoEditor.vue`;worker 引入放进 async wrapper;vite `optimizeDeps.exclude: ['monaco-editor']` | 中 | 首屏 LCP / bundle size | 中(首次打开设置 dialog 短暂 spinner) |
| PERF-2 | `src/ui/client/src/views/SourceMapView.vue` L20-24 | bundle | `@vue-flow/*` + `dagre` (~150 KB) 静态导入 | 拆 `SourceMapGraph.vue` 子组件并 `defineAsyncComponent`,仅在用户切到"图"模式加载 | 中 | Source map 首次打开延迟 | 低 |
| PERF-3 | `src/ui/client/src/components/MindmapPreview.vue` · `views/EditorView.vue` L27 | bundle | `flow-mindmap` (~500 KB) 静态引入 | `defineAsyncComponent` MindmapPreview,仅在用户点击 .mindmap 文件时加载 | 中 | 编辑器首屏 LCP | 低 |
| PERF-4 | `src/ui/client/src/stores/gitStore.ts` L19 · `components/CommandConsole.vue` L33 · instances store | 连接生命周期 | 三个独立 `io()` socket 并行,后端多占 TCP/文件句柄,清理复杂 | 单一 `useSocket()` composable + 共享连接,或 `await import('socket.io-client')` 懒加载 | 低 | socket 连接数 / 清理逻辑 | 中(需验证 reconnect/emit 等价) |
| PERF-5 | `src/ui/client/src/main.ts` L27 | bundle | `local-file-picker/dist/file-picker.css` (~10–30 KB) 打包入 entry | 移到 `AttachmentZone.vue` 局部引入 | 低 | bundle size | 极低 |
| PERF-6 | `src/config.js` L84-92 | 启动/响应 | `loadConfig` 调用 `execSync('git rev-parse --show-toplevel')` 阻塞事件循环,在 `/api/config/getConfig` 热路径上每次都跑 | 按 cwd 缓存 `gitRoot`,`process.chdir` 时失效;或 `await execFile` 替换 `execSync` | 中 | 配置相关接口响应延迟 | 低 |
| PERF-7 | `src/ui/server/routes/npm.js` L589-810 | DoS | `/api/scan-npm-scripts` 递归 4 层 × 50 dir,无全局文件上限;100k-dir monorepo 可饿死事件循环 | 加 `MAX_FILES = 5000`,用 `p-limit` 限并发 8,响应暴露 `fileReadCount` | 中 | 大 monorepo 扫描卡死 | 低 |
| PERF-8 | `src/ui/server/utils/instanceRegistry.js` L98-107,104-106 | IO | `writeAll` 用 pretty `JSON.stringify(..., null, 2)` → 文件 ~2× 大小,每 5s × N 实例重写 + Windows EPERM 概率放大 | 改紧凑 JSON,显式 fsync 之前不要 rename;`heartbeat` 走紧凑,`register/unregister` 走 pretty | 低 | registry 文件 IO / 多开实例 | 低 |
| PERF-9 | `src/ui/server/routes/npm.js` L65-77 | IO | `/api/app-version` 每请求 `readFileSync` + `JSON.parse` `package.json` | 启动时读一次缓存到内存,hot-reload 时重读 | 低 | 应用版本轮询 | 极低 |

---

## 3. 维度③ · 安全(最高优先级)

> **项目已有 `pathGuard.js`(路径守护)与 `shellQuote.js`(shell 转义),但未在多个高危端点统一应用。** 这是本维度所有高危项的根因。

| 编号 | 文件 / 行号 | 类别 | 问题描述 | 推荐方案 | 优先级 | 影响面 | 风险 |
|------|-------------|------|---------|---------|--------|--------|------|
| **SEC-RCE-1** | `src/ui/server/routes/code.js` L58-110 (`/api/execute-code-node`) | RCE | `vm.runInContext` 包装用户 `req.body.script` 并执行 `main(param)`,沙箱仅含 `input/param/main`;Node vm **默认不隔离**原型/`process`/`require`,攻击者可 `this.constructor.constructor('return process')().exit()` 或 `require('child_process').exec(...)`;无 auth、无项目作用域检查;`timeout: 800` 是软上限,紧密循环仍阻塞事件循环 | 删除端点,或 (a) 加 auth/scope,(b) 用 `node:worker_threads` + `resourceLimits` + 禁 `parentPort/require`,(c) 至少用 `vm.constants.DONT_CONTEXTIFY` + 冻结 global + `importModuleDynamically: 'reject'` | **高** | 前端有依赖,删除需同步改前端;worker 化可能影响 `main(param)` 契约 | 高(影响功能) |
| **SEC-INJ-1** | `src/ui/server/socket/registerUiSocketHandlers.js` L52-89 (`exec_interactive`) | 命令注入 | `spawn(command.trim(), [], { shell: true, cwd: execDirectory })`,`command` 直接来自 socket payload,`shell:true` 走 `/bin/sh -c` 或 `cmd.exe /c`,可执行任意 shell;`cwd` 部分由用户控制(`directory` 拼接到 `currentProjectPath`) | 用 `string-argv` 等真实 tokenizer 拆 argv,改 `spawn(bin, argv, { shell: false })`;若保留自由 shell,强制 trust model(只绑 localhost)+ UI 强提示 | **高** | Interactive Console 全功能 | 高(影响功能) |
| **SEC-INJ-2** | `src/ui/server/routes/exec.js` L53-105 (`/api/exec-stream`) | 命令注入 | 同 SEC-INJ-1,`shell:true` 拼接用户命令;SSE 流在 client disconnect 时未清理 listener,泄漏句柄 | `execFile`/argv 模式;`pathGuard.ensureWithinCwd` 校验 `directory`;`req.on('close')` 时 `kill('SIGTERM')` | **高** | 通用命令流式执行 | 中 |
| **SEC-INJ-3** | `src/ui/server/routes/exec.js` L34-50 (`/api/exec`) | 易回退 | 当前用 `execGitCommand` 走 `execFile('git', argv)`,**当前安全**;但 handler 名为"通用执行",误导;未来维护者改回 `exec` 即重新引入注入 | 改名 `/api/exec-git`,或在 token 解析后强制 `bin='git'` 校验;加注入回归测试 `git status; touch /tmp/pwn` 不执行第二条 | 中 | API 命名 | 低 |
| **SEC-INJ-4** | `src/ui/server/routes/fs.js` L331-420 (`/api/open-new-tab-gui` + `/api/open_terminal`) | 命令注入 | `directoryPath` 拼入 `gnome-terminal -- bash -c "cd '${dir}' && g ui; exec bash"` — **单引号可逃逸**(`/foo'); rm -rf /; ('`);Windows `start "" /D "${winPath}" cmd /k g ui` 的双引号转义不完备 | 三平台统一改 `spawn(cmd, [dir, ...], { shell: false })`;统一使用现有 `shellQuote.shQuote`;`ensureWithinCwd` 约束路径 | **高** | 跨平台终端启动 | 中 |
| **SEC-INJ-5** | `src/ui/server/routes/npm.js` L970-1021 (`/api/run-npm-script`) | 命令注入 | `packagePath` / `scriptName` 拼入 `start cmd /K "cd /d ${packagePath} && ${npmCommand}"` 等 3 平台 shell;无单/双引号转义;**`scriptName` 是用户输入但未做白名单校验** | `spawn` argv 数组;至少 `scriptName` 校验 `/^[a-zA-Z0-9_:-]+$/` | **高** | npm 脚本"在新终端打开"功能 | 中 |
| **SEC-PATH-1** | `src/ui/server/routes/git/diff.js` L121-152,154-196,199-242,245-294 | 路径穿越 | `/api/file-content` / `/api/git-file-content` / `/api/resolve-conflict` / `/api/revert_file` 全部接 `req.query.file` 直传 `fs.readFile` 或 `git diff -- filePath`,**未走 `safePathInProject`**,`?file=/etc/passwd` 直接读;`/api/resolve-conflict` 还能写任意路径;`/api/revert_file` 仅靠"是否 `??` 开头"防御,绕过容易 | 每个 handler 顶部加 `safePathInProject(filePath)`;`/api/resolve-conflict` 额外限制只能写 git-tracked 文件 | **高** | diff/revert/conflict 全套功能 | 低 |
| **SEC-PATH-2** | `src/ui/server/routes/fs.js` L67-161 (`/api/change_directory`) | 路径穿越 + 后续放大 | `req.body.path` 接 `process.chdir`,无项目根/合法性校验;之后所有 fs/git 操作均以新 cwd 为基准,结合 `DELETE /api/editor/entry` 可一气呵成 `chdir('/'); DELETE editor/entry?path=Users` 清空用户家目录 | 维持 `process.chdir` 但加白名单(原 cwd 的祖先/后代 + 实际目录);**更优**:不再 chdir,所有 `execGitCommand/spawn` 走 per-request `cwd` 参数 | **高** | 整个 server 假设单 cwd 的设计 | **高**(全模块重构) |
| **SEC-PATH-3** | `src/ui/server/routes/codeAnalysis.js` L422-540,933-987 | 路径穿越 + DoS | `req.query.path` / `req.body.path` / `basePath` 全无 `ensureWithinCwd` 校验;`scanDirectory` 无深度上限(对比 `/api/scan-npm-scripts` 有 4 层) | `path` 绑定 `getCurrentProjectPath()`;加深度上限;对 LLM prompt 用 `<code>` fence 包裹,截断到 1–2 KB | **高** | code-analysis 全套 | 中 |
| SEC-SYM-1 | `src/ui/server/utils/pathGuard.js` L81-94 · `routes/fs.js` L38 | 符号链接逃逸 | `pathGuard` 暴露 `realpath` 选项,但 fs.js 编辑端点全部不传 `{ realpath: true }`;项目内创建 `foo -> /etc` 后 `/api/editor/file?path=foo/passwd` 即可读 | fs.js 所有读端点改 `ensureWithinCwd(p, cwd, { realpath: true })`;UI 文件选择器排除指向项目外的 symlink | 中 | 编辑器读 | 中(可能误杀项目内合法 symlink) |
| SEC-PROMPT-1 | `src/ui/server/routes/codeAnalysis.js` L967-987 (`/api/code-analysis/drill`) | Prompt 注入 | prompt 模板直接拼接 `file` 内容 + `parentChain.slice(0,500)` + `content.slice(0,7000)`,仓库里若含 `"Assistant: ignore previous..."` 直接进 LLM;若 LLM 有 tool 执行能力,组合 SEC-RCE-1 即 RCE | `<code>` fence + 明确"作数据处理"前缀;截断到 1–2 KB;`parentChain` 不直接进入 prompt | 中 | AI drill 功能 | 低(LLM 精度微降) |

> **未列为高危但需注意的次级安全项**:`SEC-LLM-1`(workbench 中 LLM 输出若被 `vm`/`eval` 即 RCE,目前 spot-check 未见,但需审计)、`SEC-CLI-1`(`gitCommit.js --cmd=` 任意 `exec`,本地工具但可武器化,需 `--insecure` flag 或白名单)、`SEC-LOCK-1`(`/api/add-file` 绕过 locked-files 过滤,前端补但 REST 客户端可绕过)。

---

## 4. 维度④ · 可维护性

| 编号 | 文件 / 行号 | 类别 | 问题描述 | 推荐方案 | 优先级 | 影响面 | 风险 |
|------|-------------|------|---------|---------|--------|--------|------|
| MAINT-1 | `src/ui/server/routes/exec.js` L21-23 | 正确性 | `splitCommandArgs = command.trim().split(/\s+/)` 不能处理 `"file with spaces.txt"` → 单 token 串拆成多 argv,git 报"pathspec did not match" | 用 `terminal.js` L30-55 的 `splitArgs`(已处理引号)或引入 `string-argv`(~1 KB) | 中 | 非流式 `/api/exec` 单空格文件名 | 低 |
| MAINT-2 | `src/ui/server/routes/terminal.js` L57-77 | 健壮性 | `isUrl` 用正则切换 argv vs URL,PowerShell 路径拼接脆弱,`powershell -ArgumentList` 空格拆分导致空格路径崩溃 | 用 `Start-Process -ArgumentList` 数组字面量,或 `spawn('powershell.exe', ['-NoProfile', '-Command', psScript])` + 参数化注入 | 中 | Windows "open URL/file" | 中 |
| MAINT-3 | `src/ui/server/socket/registerUiSocketHandlers.js` · `routes/exec.js` · `routes/fs.js` · `routes/npm.js` | 重复 + 安全放大 | "在新终端打开某目录执行某命令" 在 `terminal.js` L116-136(用 shellQuote)、`fs.js` L331-420(裸拼)、`npm.js` L970-1006(裸拼)三处独立实现 — 安全补丁要改 3 遍 | 抽 `src/ui/server/utils/launchTerminal.js`(`launchInExternalTerminal({ platform, cwd, command, command2 })`),三处统一调用 | 中 | 跨平台终端 | 中(三平台 × 三调用方回归) |
| MAINT-4 | `src/config.js` L84-92,152-177,192-197 | 数据完整性 | (a) `loadConfig` 在 hot path `execSync` git;(b) `loadConfig` 无 schema 校验,`projects[key]="garbage"` 会 spread 成 `{0:'g',1:'a'...}` 后续 `commandTemplates.map` 炸;(c) `saveConfig` parse 失败仅 `console.warn` 后**返回 undefined**,调用方按成功处理 → 用户看到 200 OK 但其实没写盘 | 缓存 gitRoot;轻量 schema 校验(Zod 或手写);`saveConfig` 返回 `{ ok, error }` 或 throw,让路由返 500 | 中 | 配置读写全套 | 中(契约变更需审计 ~10 调用点) |
| MAINT-5 | `src/config.js` L295-315 (`saveRecentDirectory`) | 正确性 | `unshift(dirPath)` 用原始大小写,Windows 下 `C:\Project` 和 `C:\PROJECT` 产生两条"看起来一样"的项 | 始终 `unshift(normalizeProjectPath(dirPath))`,展示用单独字段 | 低 | "最近目录"列表 | 极低 |
| MAINT-6 | `src/ui/server/utils/instanceRegistry.js` L98-107,218-240 | 原子性 + 竞态 | (a) `writeAll` 在 Windows EPERM 下可能留下 stale `.tmp`;(b) `watch` 回调 fire 并行未防 stale data 覆盖 | 镜像 `config.js` 的 unlink+writeFile fallback;`inflight` 布尔防 re-arm | 低 | 多实例 UI | 低 |
| MAINT-7 | `src/ui/server/routes/fs.js` L222-227 · `routes/gitOps.js` 等 | 一致性 | 部分路由用 `process.argv` 派生 cwd,部分用 `getCurrentProjectPath()`,`process.chdir` 后两类可能不一致 | 统一用 `getCurrentProjectPath()` | 低 | 多路由调用顺序 | 低 |
| MAINT-8 | `src/ui/client/src/views/WorkbenchView.vue` 全文 3508 行 | 体积 | 单组件含任务 CRUD + 子任务 CRUD + prompt CRUD + AI 拆分 + 执行编排 + 附件 + 脏追踪 + simple 对话渲染 | 拆 `TaskHeader` / `SubTaskList` / `SimpleConversation` / `ExecutionLogDialog`,目标 < 1000 行/文件;已有 composables 继续下沉逻辑 | 中 | 整个 Workbench 视图 | 中(大切片,需并行测试) |
| MAINT-9 | `src/ui/client/src/components/CommandConsole.vue` 全文 3728 行 | 体积 | 单组件含命令执行 + 终端会话 + 交互进程 + 编排执行 + 项目启动 + 自定义命令管理 | 拆 `<CommandExecutor>` / `<TerminalSessions>` / `<OrchestrationRunner>` / `<ProjectStartupRunner>`,shell 仅装配 | 中 | 整个 Console 视图 | 中(大切片) |
| MAINT-10 | `src/ui/client/src/stores/gitStore.ts` 2406 行 | 体积 | 单 Pinia store 含分支/状态/提交/stash/log 分页/socket 生命周期/项目房间;git log 显示历史曾合并 `gitLogStore` | 拆 `useBranchStore` / `useCommitStore` / `useSocketStore` / `useStashStore`,每 ~400–600 行 | 中 | 全前端依赖 | 中(跨 store 依赖需仔细迁移) |
| MAINT-11 | `src/ui/client/src/stores/configStore.ts` 1282 行 | 体积 | 单 store 含通用设置/模型/UI 布局/workbench/npm/编排/locked files | 按域拆 `useGeneralStore` / `useModelStore` / `useUiStore` / `useNpmStore` / `useWorkbenchConfigStore` | 低 | 几乎所有配置面板 | 低(纯 search-and-replace) |
| MAINT-12 | 散落 magic numbers (`instanceRegistry.js` L23-25 · `randomStartPort.js` L20-21 · `src/ui/server/index.js` L67-77 · `src/utils/index.js` L211) | 可发现性 | 时间/限制常量散落 20+ 文件,单位混用(秒/毫秒/对象),改值需狩猎 | 新建 `src/ui/server/utils/constants.js` 集中命名导出 | 低 | 全 server | 低(纯重构) |
| MAINT-13 | `src/ui/client/src/components/CommandConsole.vue` L45,92,106,513,516,523,700,703,920,924,1084,1197,1293,1320,2381 等 ~15 处 | i18n | `ElMessage.error/warning` 与模板 tooltip 硬编码中文(`'提交后启动项执行失败'`、`'未找到 start 节点'`、`'继续执行'`、`'暂停执行'` 等),未走 `$t()` | 全部包 `$t('@CF05E:<原文>')`,同步登记 zh/en lang 文件 | **高** | 前端可访问性 + 多语言 | 极低(纯文本替换) |
| MAINT-14 | `src/ui/client/src/views/components/*.vue` 等多处 `<style>`(App.vue L1262/1312/1468/1497,ActivityBar.vue L256/289/321,AISplitChatPane.vue L535-788,AISplitDirectPane.vue L679,AppVersionBadge.vue L306) | 设计令牌一致性 | 大量硬编码 `#fff`、`#909399`、`#606266`、`#303133`、`#409eff`、`#f4f4f5`、`#67c23a`、`#cb3837` 与 `box-shadow rgba(...)` 绕过 `variables.scss` 的 `--text-tertiary`、`--text-secondary`、`--color-primary`、`--btn-shadow-hover` 等 token | 替换为 `var(--text-tertiary)` 等;`#cb3837`(npm 红)提为命名 token;`.commit-hash` 样式改用 token(已落地) | 中 | 全前端视觉一致性 | 低(token 值需确认) |

---

## 5. 维度⑤ · 依赖与配置

| 编号 | 文件 / 行号 | 类别 | 问题描述 | 推荐方案 | 优先级 | 影响面 | 风险 |
|------|-------------|------|---------|---------|--------|--------|------|
| **DEP-SEC-1** | `.npmrc` | **凭证泄露** | 内嵌明文 NPM token(`//registry.npmjs.org/:_authToken=npm_<redacted>`),已 commit 到仓库,任何贡献者可发布 | **立即**在 npmjs.org 撤销该 token;`.npmrc` 改为 `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`;`.npmrc` 加 `.gitignore`,保留 `.npmrc.example`;CI 用 OIDC/trusted publishing | **高** | 发版权限 | 中(撤销后贡献者需重新登录,CI 换新 secret) |
| **DEP-REL-1** | `scripts/release.js` L423,480-483 | 发版风险 | `commitChanges` 用 `git add .`(可能把未追踪文件一起带上) + `git push origin <branch>` + `git push origin --tags`;release 容易把本地脏文件一起发布 | 仅 `git add package.json CHANGELOG.md`(或 release 显式清单);push 前恢复用户确认;`npm publish` 前加 `npm whoami --registry=...` 校验 | **高** | 整个 release 流程 | 中(交互恢复会拖慢 release) |
| DEP-REL-2 | `scripts/release.js` L50-81 | 副作用过大 | `terminateGitProcesses` Windows 跑 `taskkill /f /im git.exe /t`、POSIX 跑 `pkill -f 'git'`,**无条件**杀所有 git.exe(用户的 GitHub Desktop、VS Code git helper 也遭殃),即使未发现锁也跑 | 仅在 `hasBusyLocks === true` 时调用 kill;删除无条件 log | **高** | 用户其他 Git 工具 | 低 |
| DEP-REL-3 | `scripts/release.js` L352-375 | 配置突变 | 发版过程中向 `tsconfig.app.json` 写入 `"types": ["node"]`,失败回滚路径缺失,容易把半改状态提交到 release commit | 永久在 `tsconfig.app.json` 写 `"types": ["node"]`(`@types/node` 已在 deps),`release.js` 移除该 mutation | 中 | release 流程 | 极低 |
| DEP-REL-4 | `scripts/release.js` L286 | 类型检查工具错配 | `runTypeCheck` 跑 `npx tsc --noEmit`(不检查 `.vue`),项目标准 `vue-tsc -b --noEmit`(在 client `package.json`) | 改 `npx vue-tsc -b --noEmit`,与 dev 流程一致 | 中 | release gate | 低(可能暴露之前隐藏的 vue-tsc 错误) |
| DEP-REL-5 | `scripts/release.js` L77,203,427,445,457 | 跨平台脆弱 | 5 处 `execSync('sleep N \|\| ping -n N+1 127.0.0.1 > nul')`,Windows cmd/PowerShell `sleep` 不存在 | 用 `await new Promise(r => setTimeout(r, ms))`,删平台分支 | 低 | release 稳定性 | 极低 |
| DEP-REL-6 | `scripts/release.js` L540-546 | 副作用 | `npm publish` 成功后跑 `npm run update:g`(`npm install -g zen-gitsync --registry...`),自动改用户全局 Node 环境 | 加 `--no-self-update` flag,默认不跑 | 中 | 用户全局环境 | 极低 |
| DEP-DEP-1 | `package.json` L93 (`acorn`) | 死依赖 | `acorn ^8.16.0` 列入 `dependencies`,但 src/scripts 全无直接 import,作为 vite/vue-tsc 的 transitive 即可 | 从 `dependencies` 删,留作 transitive | 低 | npm tarball 体积 | 极低 |
| DEP-DEP-2 | `package.json` L94,101 · `src/ui/client/package.json` L29,34 | 私有/未知包 | `ai-model-form ^0.2.0` + `local-file-picker ^0.1.7` 是 0.x 内部包,客户端 `types/*.d.ts` 有 shim → 上游类型可能缺失;`local-file-picker` 在 vite.config 不在 `optimizeDeps.exclude` → dev HMR 风险 | 文档化来源(内部?scoped registry?);`.npmrc` 加 scoped registry 规则;`.d.ts` shim 加 staleness 检查 | 中 | 安装确定性 | 低 |
| DEP-DEP-3 | `src/ui/client/package.json` L35-36 | 双 markdown 管线 + beta | `marked@18` 与 `markstream-vue@1.0.3-beta.2`(beta 在生产!)都用于 markdown | 二选一;若 `markstream-vue` 作 wrapper,删 `marked`;避免 beta 依赖进生产 tarball | **高** | 发布包稳定性 | 中(需审计 MarkdownPreview.vue 与 chat UI 兼容) |
| DEP-DEP-4 | `src/ui/client/package.json` L42 (`zen-ai-chat-ui`) | beta 在生产 | `^0.1.0-beta.1` 已集成 workbench chat UI(commit `bb512b9`),进生产 tarball | pin 精确版本直到 0.1.0 稳定;client `package.json` 加 `overrides` 锁定 transitive semver | **高** | 生产依赖稳定性 | 低(配合 `overrides` 平衡) |
| DEP-DEP-5 | `src/ui/client/package.json` L37 · `vite.config.ts` | Monaco 配置不全 | `monaco-editor ^0.55.1` 已 manualChunks,但 `optimizeDeps` 没 exclude → dev 首次会 pre-bundle ~3 MB | 加 `optimizeDeps.exclude: ['monaco-editor']`,配合 PERF-1 异步化 | 中 | dev 首启延迟 | 低 |
| DEP-DEP-6 | `src/ui/client/package.json` L46 · `vite.config.ts` L21 | Tailwind v4 残留检查 | `@tailwindcss/vite` 已升级 v4,旧 `tailwind.config.js` / `postcss.config.*` 可能被忽略或报警 | `find src/ui/client -name "tailwind.config.*" -o -name "postcss.config.*"`,有就迁移或删 | 低 | 构建警告 | 极低 |
| DEP-DEP-7 | `src/ui/client/package.json` L51 (`sass-embedded`) | 双 sass 风险 | `sass-embedded ^1.92.0` 与 peer `sass` 可能并存 | `npm ls sass`,若都在,删未被 vite 选用的那个 | 低 | npm 体积 | 极低 |
| DEP-CFG-1 | `.npmrc` · `package.json` L23-24 | registry 缺失 | root `.npmrc` 只设 token,无 `registry=`,私有包(internal registry)客户端可能装不上 | 加 `registry=` 或 scoped 规则 | 中 | 安装确定性 | 低 |
| DEP-CFG-2 | `.nvmrc`(`20`) vs `package.json#engines`(`>=20.19`) | 一致性 | `.nvmrc` pin 20 而 engines 要 20.19,`nvm use 20` 装的可能是 20.0–20.18 | `.nvmrc` 写 `20.19` 或文档化差异原因 | 低 | 开发者体验 | 极低 |
| DEP-CFG-3 | `index.js` L19,22 · `package.json` 无 `types` 字段 | DX | 包发布无 `index.d.ts`,TS 消费者拿到 `any`;`default` 与命名导出混用 | 手写 `index.d.ts` 或 `tsc --emitDeclarationOnly`;`package.json` 加 `"types": "./index.d.ts"` | 中 | CLI 工具 TS 集成 | 极低 |
| DEP-CFG-4 | `scripts/release.js` (`.js` 走 ESM) vs `scripts/*.cjs` | 模块系统 | root `"type":"module"` 让 `release.js` 走 ESM,`run-tests.cjs` / `dev-ping.cjs` / `convert-*.cjs` 走 CJS — 功能上 OK,但易混淆 | `release.js` 改 `.mjs`(自描述模块类型) | 低 | 工程规范 | 极低 |
| DEP-CFG-5 | `src/ui/client/playwright.config.ts` L64-67 | 测试配置 | `webServer: undefined` 等价于省略,Playwright 仍可能警告;`workers:1 + fullyParallel:false` 串行 — 慢 | 真正配置 `webServer`(backend + vite),或删误导注释;考虑加 firefox/webkit project | 低 | e2e 速度 | 极低 |
| DEP-CFG-6 | `.github/` 无 `workflows/` | CI 缺失 | 无 CI 跑 `npm test` / `vue-tsc` / `npm audit` / `release` | 加 `ci.yml`(install → test → tsc → build) + `release.yml`(tag 触发,跑 `npm run release`,NPM_TOKEN secret) | 中 | 发布质量门 | 极低 |
| DEP-CFG-7 | `package.json` 无 coverage / bundle analyzer | 可观测性 | 无 `c8` / `@vitest/coverage-*` / `rollup-plugin-visualizer` — manualChunks 是否真的有效无证据 | root devDeps 加 `c8` + `test:coverage`;client devDeps 加 `rollup-plugin-visualizer` + `build:analyze` | 中 | 性能/测试可见性 | 极低 |
| DEP-CFG-8 | `scripts/verify-file-search.mjs` L10 · `scripts/verify-subtask-row.mjs` | 依赖路径脆弱 | 从 `'../src/ui/client/node_modules/playwright/index.mjs'` 相对导入,playwright 移动/hoist 即坏 | root 加 `playwright`,或统一用 `@playwright/test` 通过 `npx playwright test`;脚本迁 `src/ui/client/e2e/manual/` | 中 | verify 脚本稳定性 | 低 |
| DEP-CFG-9 | `scripts/convert-*.cjs`(colors / fontsize / spacing / standard) | 历史包袱 | 4 个一次性迁移脚本无 npm script / CI 钩 / 测试;README 称"一次性",与现行管道无关 | 移到 `scripts/archive/` 并加 README 说明"勿运行,除非懂为什么" | 低 | 工程整洁 | 极低 |
| DEP-CFG-10 | `package.json` L16 (concurrently 颜色) | UX 噪音 | `-c blue,green` 与其他工具输出撞色 | 选高对比色,或让内部工具自己配色 | 低 | dev 终端可读性 | 极低 |
| DEP-CFG-11 | `package.json` L95-107 (`chalk` / `boxen` / `ora` / `log-update` / `cli-table3`) | 依赖收敛 | 5 个 TUI 库服务于 gitCommit.js 单点 spinner/status;Node 20+ `node:util.styleText` 可替 chalk | 审计实际用法,只保留真正在用的;chalk 5 ESM-only 与 CJS helpers 混用易出岔 | 低 | npm 体积 | 低 |

---

## 6. 维度⑥ · 测试与文档

| 编号 | 文件 / 行号 | 类别 | 问题描述 | 推荐方案 | 优先级 | 影响面 | 风险 |
|------|-------------|------|---------|---------|--------|--------|------|
| **TEST-1** | `test/ts-demo.test.ts` L94-98 | **测试破损** | 包含未解决合并冲突标记 `<<<<<<< HEAD / ======= / >>>>>>> 7b32aeb44ee1c79e9e3102aa310583154804d017`,`node --test` 直接抛 parse 错;且文件名后缀被 `run-tests.cjs` 的 `\.(test|spec)\.(mjs\|js\|ts)$` 命中 → 整次 runner 中断 | 删文件,或移 `test/_examples/` 改 `.example.ts` 跳过;若真有测试意图,先解决 merge 标记 | **高** | 阻塞 `npm test` | 极低(零生产调用) |
| **TEST-2** | `CHANGELOG.md` L8 (`## [Unreleased] — 2026-06-19`) | 文档滞后 | 落后 **6 个 minor 版本 / 6 周**(v2.13.21 → v2.13.30 期间 44 条 feature/fix commit 与 6 个 release 标签未记录);memory `feedback_release_must_use_npm_run_release.md` 已标 | 删 "Unreleased" 改为 auto-generated Conventional Commits log;或在 `release.js` 加前置 gate "CHANGELOG 必须在上版本 tag 后有改动" | **高** | 用户感知 / release gate | 极低 |
| **TEST-3** | `src/utils/index.js`(1101 行,`PROJECT_MAP` 指出"被 server/index.js 整体 import") | 覆盖空白 | 20+ 公共函数中只有 `parseCwdArg`(85 行 12 case)有单元测试;`execGitCommand` 仅 `server-regression.test.mjs` 4-regex 字符串 sniff;`writeConfigAtomic`(caf8430 提交引入的原子写竞争修复)**完全未测试** | 加 `src/utils/execGitCommand.test.js` / `lockFile.test.js` / `writeConfigAtomic.test.js`(两个并发写者 → 最终文件是其一、无半写 JSON) | **高** | 高风险回归拦截 | 低 |
| **TEST-4** | `src/ui/server/routes/{exec,npm,workbench,gitOps,fs,terminal}.js` | 覆盖空白 | 6 个高风险路由文件零单元测试,涵盖 shell/process 边界与安全相关逻辑(`exec.js` 279 行、`npm.js` 1356 行、`workbench.js` 3410 行、`gitOps.js` 1145 行、`fs.js` 701 行、`terminal.js` 318 行) | 至少加:`exec.js` argv 注入回归 · `config.js` 原子写竞态 · `terminal.js` 环境变量解析 · `pathGuard` realpath 符号链接逃逸 | **高** | 整条 server 路由层 | 中(初始测试可能要 mock socket/io) |
| **TEST-5** | `test/` 与 `tests/` 双目录 | 工程整洁 | `tests/` 完全空;`test/` 混入 4 个 .html mockup、3 个 .txt fixture、5 个中文 fixture 目录,与 4 个真测试并列 | (a) 删空 `tests/`;(b) `test/fixtures/` 收纳非测试材料;(c) `test/` 根目录只留 `*.test.{mjs,js,ts}` 便于 `run-tests.cjs` 干净发现 | **高** | 后续贡献者发现 | 低 |
| TEST-6 | `scripts/run-tests.cjs` L15-41 | 扫描不全 | `SCAN_DIRS` 硬编码 `test/` / `src/utils/` / `src/ui/server/`,**未递归** `src/ui/server/{routes,socket,middleware}`;`tests/` 目录被静默跳过 | 改为单次递归 `src/` 跳过 node_modules/.dot 文件;或将 `tests/` 加入并文档化意图 | 中 | 测试发现一致性 | 低 |
| TEST-7 | `src/ui/client/e2e/`(`drawer-real-ui.spec.ts` 仅截图无断言、`selective-stage.spec.ts` 依赖外部文件否则 `test.skip()`) | e2e 不可靠 | 4 个 e2e 中 0 个是可靠 CI gate:`drawer-real-ui` 只是截图/计算样式,`drawer-style-demo` 静态 HTML diff,`selective-stage` 跳过条件不满足就 skip | CI 中 `test.skip` 上述两个,移入 `verify/`;为 `selective-stage` 配 `globalSetup` 种 2 个 dummy 文件 | 中 | e2e CI 信任 | 低 |
| TEST-8 | `package.json` `test` 脚本未接入 `auto-validate` 流程 | 流程缺失 | `.claude/rules/README.md` 的强制流程只跑 get_errors / vue-tsc / i18n,`npm test` 未纳入 | 在 `.claude/rules/README.md` 或 `auto-validate/SKILL.md` 加 `pre-validate` 跑 `npm test`,失败立即停 | 中 | 单元测试成为 commit gate | 极低(只多 ~1–2s) |
| TEST-9 | `docs/OPTIMIZATION-PLAN.md` 28 个 `- [ ]` 全未勾 | 文档自夸 | OPT-1 / OPT-2 / OPT-4 / OPT-5 代码已落地(commit `944e3a5`),但 checkbox 全空;OPT-3 部分落地(loading 视觉但 `aria-busy` 未确认) | 把已完成的勾为 `- [x]` 并加日期;OPT-3 全文 grep `:loading` + `:aria-busy` 确认后勾 | **高** | 文档可信度 | 极低(纯文档) |
| TEST-10 | `docs/UX-AUDIT.md`(P0×4)+ `PROJECT_MAP.md`(v2.13.19,落后 7 版本) | 文档漂移 | UX-AUDIT §4 修复路线图未更新状态(代码已落地 3/4 P0);PROJECT_MAP §2 行数与当前差异 `workbench.js` 3212→3410、`gitOps.js` 1179→1145、`config.js` 1207→1210、`src/utils/index.js` 1089→1101 | UX-AUDIT 加 §4.1 "Status as of 2026-06-26" 列(F-P0-01/02/04 ✅,F-P0-03 🚧);PROJECT_MAP 加 `last-verified` frontmatter 让 auto-update-readme 检测;`cloc` 重算行数 | 中 | 文档与代码一致 | 极低 |
| TEST-11 | `README.md` L59/458 (英文/中文) | 文档过度承诺 | README 宣传 "header one-click theme toggle"、"Network error banner"、"Git SHA ≥ 4.5:1"、"commit button `aria-busy`"、"relative-time status" — 后两项未在代码中确认 | grep `aria-busy` / `relative-time`,要么加实现+测试,要么把 README 措辞软化为 "loading state" / "time-ago" | 中 | 用户预期 | 极低 |
| TEST-12 | `CHANGELOG.md` L135-160 (v2.13.16 死代码清理) | 文档内部矛盾 | v2.13.16 列 "Removed ThemeSwitcher.vue",遗留事项又写 "ThemeSwitcher.vue 实际功能缺失" — 与 v2.13.x 后 OPT-2 把主题切换直接 inline 在 App.vue 相矛盾 | 下次更新加注脚 "OPT-2 选择 App.vue inline 而非新 ThemeSwitcher.vue",删遗留事项对应行 | 低 | 文档可读性 | 极低 |
| TEST-13 | `docs/UI-OVERVIEW.md` §4 组件清单 | 文档遗漏 | 漏列 `AppErrorBanner.vue`(262 行,`App.vue` 已挂载,§7 a11y 也未提 `role=alert aria-live=assertive`) | 补 §4 表 + §7 交叉链接 | 低 | 文档完整 | 极低 |

---

## 7. 推荐执行顺序(分 4 阶段,每阶段可独立发版)

> 设计原则:**安全 → 依赖 → 测试 → 重构**。先把可被远程利用的 RCE/注入/路径穿越堵死(否则后续 PR 一旦合并可能被攻击者先下手),再把发版流程的"自伤点"修了,再补测试与文档让回归拦截可见,最后做大规模重构与优化。每阶段内部再按"独立 commit"切分,便于回滚。

### 阶段 A · **安全 + 发版止血(1 周内必须完成)**

> 7 项,**全部高优先级**。每项独立 PR,合并前需 `npm test` + `vue-tsc` 通过。

| 顺序 | ID | 摘要 | 涉及文件(主要) | 预计 commit 数 |
|------|----|------|-----------------|---------------|
| A1 | DEP-SEC-1 | 撤销 .npmrc 明文 token,改 ${NPM_TOKEN} + .gitignore + OIDC | `.npmrc`、`.gitignore`、CI 配置 | 1 |
| A2 | SEC-PATH-2 | `process.chdir` 加白名单,或改 per-request cwd | `routes/fs.js` + 全 server 调用 `getCurrentProjectPath` | 1–2 |
| A3 | SEC-PATH-1 | diff.js / resolve-conflict / revert_file 全加 `safePathInProject` | `routes/git/diff.js` | 1 |
| A4 | SEC-INJ-1,2,4,5 | exec_stream / exec_interactive / open_terminal / open-new-tab-gui / run-npm-script 全部 `spawn(argv, shell:false)` + `shellQuote` | `routes/exec.js`、`socket/registerUiSocketHandlers.js`、`routes/fs.js`、`routes/npm.js`、新建 `utils/launchTerminal.js` | 2–3 |
| A5 | SEC-RCE-1 | 删除 `/api/execute-code-node` 或迁 `worker_threads` + `resourceLimits` | `routes/code.js` | 1 |
| A6 | SEC-PATH-3 + SEC-PROMPT-1 | code-analysis `path` 绑定项目根 + `<code>` fence | `routes/codeAnalysis.js` | 1 |
| A7 | DEP-REL-1,2,3,4,6 | release.js `git add .` 改显式清单 + kill 守卫 + 删 tsconfig mutation + 改 vue-tsc + `update:g` 加 flag | `scripts/release.js`、`tsconfig.app.json`、`package.json` | 2 |

**阶段 A 完成判据**:`SEC-*` 高危项全清,release 流程不会再误发布本地脏文件,NPM_TOKEN 已轮换。

### 阶段 B · **测试补齐 + 文档同步(2 周内)**

> 让回归拦截可见,文档反映现状。

| 顺序 | ID | 摘要 | 涉及文件 | 预计 commit 数 |
|------|----|------|---------|---------------|
| B1 | TEST-1 | 删 `test/ts-demo.test.ts`(或解决 merge marker) | `test/ts-demo.test.ts` | 1 |
| B2 | TEST-5,6 | `tests/` 处理;`run-tests.cjs` 改为递归 `src/` | `tests/`、`scripts/run-tests.cjs` | 1 |
| B3 | TEST-3 | `src/utils/index.js` 补 `execGitCommand` / `lockFile` / `writeConfigAtomic` 测试 | `src/utils/*.test.js` | 2 |
| B4 | TEST-4 | 6 个高风险路由各加最小测试集(argv 注入 / 原子写 / realpath / 环境变量) | `src/ui/server/routes/**/*.test.js` | 3–4 |
| B5 | TEST-8 | `auto-validate` 流程加 `npm test` 步骤 | `.claude/skills/auto-validate/SKILL.md` 或 `.claude/rules/README.md` | 1 |
| B6 | TEST-2 | CHANGELOG 补齐 v2.13.21~30 + 改 release.js 前置 gate | `CHANGELOG.md`、`scripts/release.js` | 1 |
| B7 | TEST-9,10,11,12,13 | OPTIMIZATION-PLAN 勾选 + UX-AUDIT §4.1 + PROJECT_MAP 重算 + README 措辞修正 + UI-OVERVIEW 补 AppErrorBanner | docs/* + README.md | 2 |
| B8 | DEP-CFG-6 | 加 GitHub Actions `ci.yml` + `release.yml` | `.github/workflows/*.yml` | 1 |

**阶段 B 完成判据**:`npm test` + `vue-tsc` + `npm audit` 三门在 CI 上跑通,文档与代码一致。

### 阶段 C · **前端 bundle + 性能优化(2 周内)**

> 不改行为,只改加载策略;每项都有 `vite build --mode production` 的 bundle 报告做前后对比。

| 顺序 | ID | 摘要 | 涉及文件 | 预计 commit 数 |
|------|----|------|---------|---------------|
| C1 | PERF-1 + DEP-DEP-5 | Monaco `defineAsyncComponent` + `optimizeDeps.exclude` | `MonacoEditor.vue`、`EditorView.vue`、`SourceMapView.vue`、`vite.config.ts` | 1 |
| C2 | PERF-2 + PERF-3 | `SourceMapGraph` / `MindmapPreview` 异步化 | 新建子组件 + 修改父 | 1 |
| C3 | PERF-4 + PERF-5 | 单一 `useSocket()` composable + `local-file-picker` CSS 局部化 | `composables/useSocket.ts`、`main.ts`、`AttachmentZone.vue` | 1 |
| C4 | CQ-3,4,5,7 | Vue 响应式问题修复 + `useThemeObserver` 提取 | 多组件 | 2 |
| C5 | MAINT-13 | i18n 清理(~15 处硬编码中文) | `CommandConsole.vue` + `lang/{zh,en}/index.js` | 1 |
| C6 | DEP-DEP-3,4 | `marked`/`markstream-vue` 二选一 + `zen-ai-chat-ui` pin + overrides | `package.json`(client) | 1 |
| C7 | DEP-CFG-7 | 加 c8 / rollup-plugin-visualizer,产出覆盖率与 bundle 报告 | `package.json`(root + client) + CI artifact | 1 |

**阶段 C 完成判据**:首屏 LCP 与 entry chunk 大小可量化下降,无视觉/交互回归。

### 阶段 D · **大文件拆分 + 可维护性重构(滚动推进)**

> 风险最高、收益最长期,建议每文件拆完单独 1 个 PR + e2e 回归。

| 顺序 | ID | 摘要 | 预计 commit 数 |
|------|----|------|---------------|
| D1 | MAINT-8 | 拆 `WorkbenchView.vue`(3508 → 4 子组件) | 4 |
| D2 | MAINT-9 | 拆 `CommandConsole.vue`(3728 → 4 子组件) | 4 |
| D3 | MAINT-10 | 拆 `gitStore.ts`(2406 → 4 store) | 4 |
| D4 | MAINT-11 | 拆 `configStore.ts`(1282 → 5 store) | 3 |
| D5 | MAINT-14 | 硬编码颜色/阴影全换 `var(--…)` token | 3 |
| D6 | MAINT-3 | 抽 `launchInExternalTerminal`,3 处统一 | 1 |
| D7 | MAINT-12 | magic numbers → `utils/constants.js` | 1 |
| D8 | CQ-2 | `src/ui/server/index.js` 状态改 `withState` 串行 | 1 |
| D9 | CQ-6,8,9 | module-scope 副作用清理 + CommandConsole socket 生命周期 | 2 |
| D10 | MAINT-4 | `config.js` schema 校验 + `saveConfig` 错误契约 | 1 |
| D11 | MAINT-1,2 | `splitCommandArgs` + PowerShell argv 化 | 1 |
| D12 | SEC-SYM-1 + MAINT-7 | `realpath:true` 默认开启 + cwd accessor 统一 | 1 |

**阶段 D 完成判据**:WorkbenchView / CommandConsole / gitStore / configStore 均 < 800 行;`pathGuard` 与 `shellQuote` 在所有 shell/path 调用点统一应用。

### 阶段 E · **依赖收敛与工程整洁(随时可做)**

> 风险最低,作为 PR 收尾的"顺手"项。

| 顺序 | ID | 摘要 |
|------|----|------|
| E1 | DEP-DEP-1 | 删 `acorn` 直接 dep |
| E2 | DEP-CFG-3 | 加 `index.d.ts` + `types` 字段 |
| E3 | DEP-REL-5 | `sleep/ping` → `setTimeout` |
| E4 | DEP-CFG-4 | `release.js` 改 `.mjs` |
| E5 | DEP-DEP-6,7 | Tailwind 残留 / sass 双装清理 |
| E6 | DEP-CFG-9,2 | convert-*.cjs 移 archive;`.nvmrc` 改 20.19 |
| E7 | DEP-DEP-2,11 | 私有包/`.npmrc` registry 文档化 + TUI 库收敛 |

---

## 8. 风险与回滚预案

| 阶段 | 主要风险 | 缓解 |
|------|---------|------|
| A | `process.chdir` 白名单可能误伤用户多项目并行;`/api/execute-code-node` 删除可能影响前端 | 保留 per-request cwd 双模式(开关);前端先 grep `execute-code-node` 用法,无人用再删 |
| A | release.js 改动可能让 release 流程首次失败 | release 前在 dry-run 分支跑通;保留 `release.js` git history 便于 revert |
| B | 测试补齐可能暴露历史上未拦截的 bug | 视为好事;短期 disable 而非删除,留 ticket |
| C | 异步化 Monaco/VueFlow 可能让首次打开有 spinner | 加 loading 占位 + 缓存;超过 200ms 才显示 |
| D | 大文件拆分是已知高风险 | 一文件一 PR,e2e 全跑;不并行多个拆文件 PR |

---

## 9. 度量与闭环

每完成一项,在本文件对应行加 `- [x] YYYY-MM-DD #PR-NNN` 并在 `CHANGELOG.md` 引用本文件 section;`auto-update-readme` skill 在 release 时同步勾选状态。每月底跑一遍四路审计脚本(可考虑固化到 `npm run audit:internal`),对比本文件新增/关闭数量。

> **本文件与现有 `OPTIMIZATION-PLAN.md` 的关系**:本文件不替代 `OPTIMIZATION-PLAN.md`,后者是 UI 5 项落地清单;本文件是全量审计与中长期执行计划,优先级维度更广。建议把已完成的 OPT-1/2/4/5 在本文件 §1 的相关项也勾选,并在 CHANGELOG 注明"OPT-PLAN 闭环"。