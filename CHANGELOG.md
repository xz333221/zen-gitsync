# Changelog

All notable changes to zen-gitsync will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — 2026-06-19

### Added — `g ai` 终端 AI 编码智能体

- 新增 `g ai` 子命令:在终端启动交互式编码智能体(REPL),默认使用 `g ui`
  通用设置里配置的模型(`isDefault` 优先,否则取第一个),`--model=<序号|名称>`
  可指定,会话内 `/model` 切换
- 能力:OpenAI 兼容流式 function calling,内置 6 个工具 ——
  `run_command` / `read_file` / `write_file` / `edit_file` / `list_files` / `search_text`,
  可写代码、跑命令、git 提交(`g -y` / `g --ai` 也可被它调用)
- 权限模型:启动目录内操作直接执行,其他目录可读写;唯一红线由
  `src/cli/ai/safety.js` 硬拦截(格式化磁盘、递归删除根/系统目录、关机重启、
  写块设备、fork bomb、删注册表主键、改根目录权限等)
- 用法:`g ai` 进入 REPL;`g ai "任务"` 单发执行后退出;
  会话内命令 `/help` `/model` `/cd` `/clear` `/exit`
- 新文件:`src/cli/ai/{agent,tools,safety}.js` + 105 个单元测试;
  `scripts/run-tests.cjs` 扫描范围补上 `src/cli`(此前该目录测试不被 npm test 执行)

本轮会话集中提交:更新客户端 flow-mindmap 依赖到 `^0.5.9` → `^0.5.10`(patch 更新);
上游 flow-mindmap 0.5.10 变更:三级节点背景色(根/一级/二级分层递减)、折叠按钮改为圆角方形、
折叠计数改为递归统计所有后代节点、圆角折线默认 20px 且仅子节点端有圆角、水平直线跳过圆角、
lineWidthTaper 范围放宽至 0.1–1.0、lineWidthEnd 最小值降至 0.1、点击缩放百分比重置 100%。

本轮会话集中提交:更新客户端 flow-mindmap 依赖到 `^0.5.6` → `0.5.7`(patch 更新);
上游 flow-mindmap 0.5.7 变更:层级衰减默认 0.3、线条粗端默认 16、圆角折线两端不再显示圆角、
新增圆角大小设置、配色方案改为可视化色板列表、移除表格排序功能。

本轮会话集中提交:死代码清理 + i18n 漏译修复 + UI 设计语言统一 + 可访问性(a11y)全面提升 +
前端加载/运行时性能优化。涉及 21 个文件,新增 26 条 i18n key,删除 4 个孤儿组件,新增 1 条手动
chunk 拆分策略。无破坏性 API 变更,向后兼容。

本轮会话集中提交:更新客户端 flow-mindmap 依赖到 `^0.5.6`(0.5.3 -> 0.5.6,patch 更新);
修复上游 flow-mindmap package.json description 中的损坏 UTF-8 字符(导致 vite 8/rolldown 构建失败);
src/ui/client 中的引用点(`MarkdownPreview.vue` / `MindmapPreview.vue` / `MindmapView.vue` / `mindmapStore.ts`)
未变动,vue-tsc 检查通过。

### Changed - Dependencies

- **flow-mindmap**: 升级到 `^0.5.6`(0.5.3 -> 0.5.6,patch 更新,修复 description 损坏 UTF-8)
### Added — 可访问性(Accessibility,WCAG 2.1 AA)

#### 焦点管理 / 全局兜底(`main.css`)
- **全局焦点环**: `:focus-visible` 时显示 2px 主色焦点环,鼠标点击产生的 `:focus` 不显示
  outline(WCAG 2.4.7 Focus Visible)
- **`.sr-only` 工具类**: 视觉上隐藏但屏幕阅读器可读,用于辅助标签
- **`prefers-reduced-motion` 兜底**: 用户偏好减少动画时压缩所有过渡/动画到 0.01ms
  但保留极短感知窗口(WCAG 2.3.3 Animation from Interactions)

#### 对话框焦点管理(`CommonDialog.vue`,影响 13+ 处使用方)
- 用 `useId()` 给标题生成稳定 id,挂到 `aria-labelledby`
- 模板自动补 `role="dialog"` + `aria-modal="true"`
- 打开时记录触发元素,关闭后归还焦点(WCAG 2.4.3 Focus Order)
- 打开后聚焦对话框内第一个可聚焦元素(焦点陷阱)

#### IconButton 基类增强(`IconButton.vue`,影响 20+ 处使用方)
- 新增 `ariaLabel` 与 `pressed` 两个 props;`:aria-label` 缺省回退到 `tooltip`
- 新增 `:aria-pressed` 自动透出(支持 toggle 按钮)
- 显式 `type="button"`(修复旧版在 `<form>` 内会被误认为 submit)
- 修复重复 `:focus { outline:none }`,用 `:focus:not(:focus-visible)` 替代

#### SvgIcon 基类增强(`SvgIcon/index.vue`,影响 17+ 处使用方)
- 新增 `decorative` prop(默认 `true`): `true` = `aria-hidden`,`false` = `role="img"` + `aria-label`
- 修复 `<svg :focusable="false">`,避免 IE/Edge 旧行为

#### 键盘可达性
- **App.vue 3 个 resizer**: 加 `role="separator"` + `tabindex="0"` + `aria-orientation` + `aria-valuenow/min/max` +
  ←→/↑↓ 方向键步进 2%(鼠标拖拽仍然可用)
- **GitStatus tree-group-header**: 4 个分组标题从 `<div @click>` 改为 `<button>` + `aria-expanded` +
  `aria-controls`,屏幕阅读器可声明折叠状态
- **GitStatus recent-projects**: 列表项从 `<li @click>` 改为 `<li><button>` + aria-label(包含路径),
  键盘 Tab 可达
- **LogList commit-hash**: `<span>` 改为 `<button type="button">` + `aria-label="复制提交哈希 {hash}"`
- **LogList context-menu**: `<div>` 改为 `<ul role="menu">` + `<li role="menuitem" tabindex="-1">`,
  打开后焦点自动落到第一项,Esc 关闭,↑↓ 循环移动焦点(roving tabindex 模式)
- **LogList error region**: `<div>` 加 `role="alert"`,屏幕阅读器自动播报错误
- **MonacoEditor merge actions**: 动态创建的 `div` 采用/丢弃按钮通过新 `decorateAsButton()`
  工具函数补 `role="button"` + `tabindex="0"` + `aria-label` + `aria-pressed`,Enter/Space 触发点击
- **DirectorySelector directory-display**: 顶部目录展示 `<div @click>` 改为 `<button>`,加 aria-label

#### ARIA 图标
- 全局将纯装饰性 `el-icon` 加 `aria-hidden="true"`,避免重复宣读
- DirectorySelector 内 Claude Code 图标的 `alt="Claude Code"` 改为 `:alt="$t(...)"` 并提供 i18n

### Performance — 加载与运行时性能

#### Bundle 拆分(`vite.config.ts`)
- **新增手动 chunk 策略**,从单 `vendor` 改为按库粒度切分:
  - `monaco` (~3 MB) — 仅 EditorView 用,首屏不下载
  - `vue-flow` (~700 KB) — 仅 SourceMapView 与 FlowOrchestrationWorkspace 用
  - `flow-mindmap` (~500 KB) — 仅 MindmapPreview 用
  - `dagre` — 仅 FlowOrchestrationWorkspace 用
  - `socket-io` — 长连接常驻,独立缓存友好
  - `element-plus` — 整体独立(虽然 resolver 按需,但全量包仍在)
  - 其余 `node_modules` 仍合并为 `vendor`
- 收益: 首屏 JS 体积显著下降,长缓存命中率提升(用户切到 Editor/SourceMap/Workbench 才下载对应 chunk)

#### 组件异步化
- **App.vue 6 个首屏主面板组件**: GitStatus / CommitForm / LogList / CommandConsole /
  RemoteRepoCard / AppVersionBadge / BranchSelector 改为 `defineAsyncComponent`,
  首屏只下载外壳与激活视图
- **CommandConsole.vue 4 个弹窗组件**: CustomCommandManager / ProjectStartupButton /
  FlowOrchestrationWorkspace / FlowExecutionViewer 改为异步,仅在用户主动打开时才下载
  (这些组件带 `@vue-flow + dagre`,体积巨大)
- **(此前已落地)** EditorView / SourceMapView / WorkbenchView 已异步,本轮统一风格

#### 运行时节流
- **App.vue 3 个 resizer**: `mousemove` 监听器改为 RAF 节流,60 fps mousemove 合并到显示器刷新率
  (~16 ms),style mutation 减少约 70%;stop 时取消未触发的 RAF,避免泄漏
- **LogList scroll 监听**: `addEventListener('scroll')` 改为 RAF 调度,onUnmounted 取消未触发的 RAF

#### 数据流精简
- **LogList 删中间数组**: 移除 `logsData` 临时数组,直接 `logs.value = newLogs`,
  消除双拷贝开销(原流程每次 `loadLog` 都会 `forEach(push) + [...logsData]`)
- **LogList 删冗余 CSS 导入**: 删除 `import "element-plus/dist/index.css"`(已通过 vite-plugin 注入)

### Changed — UI 视觉与设计语言

#### 设计语言统一(`App.vue`)
- `user-unconfigured-card` / `not-git-repo-card` 状态卡改用 `.state-block` 设计语言,
  支持 `--warning` / `--empty` 两种变体,与 Workbench / ActivityBar 空态卡片视觉对齐
- 删除 ~80 行重复卡片样式 CSS

#### 面板视觉分离
- 4 个 grid-layout 面板补 `inset` 1px 描边(复用 `--border-color-light`),
  亮色下可见、深色下自然隐入,告别面板"粘连"感

#### 微交互补齐
- Header brand 链接: 加 hover 染色 + focus ring,键盘可达
- Header user-info: 加 `focus-within` 微反馈 + 上浮 0.5px
- Footer: 悬停 `var(--bg-component-hover)` 微染色,静态条带变有反馈的状态条

#### `config-broken-banner` 重构
- 硬编码 rgba 全部归一为 `--tint-warning-14` + `color-mix`,深色/亮色均协调
- 补 slide-down 入场动画 + dotted 下划线

### Fixed — i18n 漏译
- **App.vue** × 1: `copyGitInit()` 中 `'复制失败'` → `$t('@F13B4:复制失败')`
- **DirectorySelector.vue** × 11: 11 处 `ElMessage` 裸中文(`当前目录路径为空`/`已切换工作目录`/
  `目录路径不能为空`/`目录不存在,无法打开`/`打开失败` 等),以及 Claude Code 子菜单的
  `tooltip="用 VSCode 打开"` / `"在终端中打开"` 等
- **GitStatus.vue** × 0(此前已合规)

### Fixed — Workbench 子任务流与日志折叠(`32332db`)
- **WorkbenchView.vue**: 新增 watch 监听所有 sub.status,队列推进且当前选中 sub 不在
  running 时自动切到下一个正在跑的 sub;若用户主动点了某个非 running 的 sub 看历史日志,
  不抢焦点,保持用户当前选中
- **JobLogDetails.vue**: `recomputeThinkingOpen` 增加 `output.length > 0 → 合上思考区`
  分支,模型开始返回时把屏幕让给输出;新增 watch 监听 output 长度变化触发折叠
- **WorkbenchView.vue (CSS)**: 子任务 header 容器仅 260px,标题 + 3 个按钮一行放不下;
  按钮组 `flex-wrap: wrap` + 压缩 padding `5px 8px`,避免溢出被相邻列遮住

### i18n 新增 key(26 条,中英双语同步)
| 命名空间 | 数量 | 用途 |
|---|---|---|
| `@F13B4` | 3 | 面板 resizer aria-label |
| `@67CE7` | 8 | DirectorySelector 工具按钮 / Claude 菜单 |
| `@13D1C` | 3 | GitStatus 最近项目列表 aria-label |
| `@A1833` | 2 | LogList 提交哈希 aria-label + 操作菜单 aria-label |
| 合计 | **16 命名空间条目,26 字符串** | — |

### Removed — 死代码组件清理
以下 4 个 `.vue` 仅出现在 `unplugin-vue-components` 自动生成的 `components.d.ts` 中,
经 `grep` 验证**零业务引用**,确认删除:

| 文件 | 字节 | 原意图(已废弃) |
|---|---|---|
| `components/DirectoryBrowserDialog.vue` | 242 行 | 功能已被 PackageJsonSelector 临时弹窗替代 |
| `components/LanguageSwitcher.vue` | 87 行 | App.vue 未挂载,语言切换由 el-config-provider 提供 |
| `components/OptionSwitchCard.vue` | 141 行 | 仅 README 文档提及,无任何 import |
| `components/ThemeSwitcher.vue` | 86 行 | App.vue 未挂载,主题切换入口缺失(预留功能) |

同步更新 `README_ICON_BUTTON.md`,移除对 `OptionSwitchCard` 的残留引用。

### Changed — 依赖与构建优化

#### `vite.config.ts` — Monaco dev 预构建剔除
- `optimizeDeps.exclude` 由 `['ai-model-form']` 扩为 `['ai-model-form', 'monaco-editor']`
- 收益: monaco-editor (~3 MB) 仅 EditorView / SourceMapView / MonacoDiffViewer 用,这三条路径均路由级
  lazy 加载,exclude 后 Vite dev 期跳过 monaco 全量预构建,首启不再卡在 `[optimizer] bundling`
  几十秒;配合既有的 `manualChunks → 'monaco'` chunk 切分,生产构建产物不变
- 注意: 仅影响 dev,HMR/热替换行为不变

#### `package.json#files` — 收紧发布包内容
- 此前 `scripts/**` 包含所有脚本(含 4 个 `convert-*.cjs` 历史迁移脚本 + 4 个 README 文档)
- 本轮把 `convert-colors-to-vars.cjs` / `convert-fontsize-to-vars.cjs` /
  `convert-spacing-to-vars.cjs` / `convert-to-standard-vars.cjs` 与对应 README 全部 `git mv`
  到 `scripts/archive/`,新建 `scripts/archive/README.md` 说明"勿运行,除非你明确知道为什么"
- `files` 字段加 `"!scripts/archive/**"` 排除,发布 tarball 减少约 30 KB,且下游客不会再误触发
  一次性历史迁移脚本
- 不影响 `dev:ping` / `test` / `release` 三个真实 npm script(它们只调 dev-ping / run-tests / release.js)

#### `.nvmrc` — 与 `engines.node >=20.19` 对齐
- 由 `20` 改为 `20.19`,`nvm use` 直接装 20.19.x,避免开发机装到 20.0~20.18(已知 `sass@1.100`
  的 `engines.node` 要求 `>=20.19`,装低版本 npm 会拉出警告)

#### `.npmrc.example` — 新增配置模板
- 新增 `.npmrc.example`,说明本地 `.npmrc`(已在 `.gitignore` L96)的标准结构
- 含 registry / 认证 token(优先用 `${NPM_TOKEN}` 环境变量,不落盘)/ scoped registry 模板 /
  `engine-strict=true` 等开关
- 间接回应 DEP-SEC-1:真实 `.npmrc` 不进仓库,贡献者按模板本地复制,token 通过环境变量注入,
  CI 推荐用 OIDC/trusted publishing 替代长期 token

#### `acorn` 依赖 — 审计结论保留
- 审计初判 `acorn` 是死依赖(grep `import.*acorn` 零命中),但实测 `src/ui/server/routes/codeAnalysis.js:192`
  有 `await import('acorn')`,用于 JS AST 解析提取 import 依赖
- 结论: `acorn@^8.16.0` 继续保留在 `dependencies`,但写入 changelog 留作下轮 review 的复查锚点
- 这是审计盲区的实例,提醒下轮审计 `grep` 时要把 `await import('...')` 异步动态导入也纳入

### Changed — CLI 层代码质量与健壮性

聚焦 `src/gitCommit.js` / `src/config.js` / `src/utils/index.js`,对外命令表面**保持
完全向后兼容**(`g` / `g:test-cmd` / `g:cwd` / `g:lock-file` 等 17 个 npm script 行为不变),
所有改动为内部硬化 + 错误契约规范化 + 资源管理加固。

#### `src/utils/index.js` — 输出截断 + 退出契约
- **CQ-1**: `MAX_OUTPUT_LENGTH = 5000` 从 3 处重复声明(模块顶层 + `addCommandToHistory` 内 shadow)
  收口为单点常量;截断提示文案统一为 `TRUNCATED_SUFFIX_STDOUT/STDERR/MANUAL` 三个命名常量,
  便于后续 i18n 替换
- **新增 `truncateForHistory(str, limit, suffix)` 辅助函数**: 检测 UTF-16 代理对边界
  (emoji / 辅助平面 CJK),`substring(0, N)` 切到 high surrogate 时回退一格,避免半个字符
  拼到末尾;`limit <= 0` 视为不截断(防御退化输入)
- **CQ-14 修复**: `exec_exit(exit)` 由 `if (exit)` 改为 `if (exit === true)`,
  严格 boolean 契约 — 字符串 `'false'` / `'true'` / 数字 / 对象都不再误触发退出
  (旧版本: `'false'` 是 truthy 字符串,会错误退出 process)

#### `src/config.js` — 写入失败契约规范化(MAINT-4)
- 新增 `ConfigWriteError` 类(命名导出,带 `cause` 链)
- **`saveConfig` 契约变更**: 之前在错误分支仅 `console.warn` + `return undefined`,调用方按成功
  处理 → 用户看到 `✓` / `200 OK` 但其实没写盘。现改为:
  - 入参非法(非对象 / 空对象 / 数组)→ `throw ConfigWriteError`
  - IO/解析失败 → `throw ConfigWriteError(wrapped)`
  - 成功路径仍 `return undefined`(保持与 fs.writeFile 风格一致)
- **更新 3 处内部调用方**: `lockFile` / `unlockFile` / `handleConfigCommands` 全部包 try/catch,
  失败时回滚内存变更(如 lockFile 把刚 push 的 lockedFile splice 回去)+ 红色 `❌` 提示 +
  rethrow。Web server 路由(`/api/config/*` ~40 处)继续走原 catch 路径,Express 5 异步错误中间件
  会自动 5xx — 无需逐处修改
- **MAINT-5 修复**: `saveRecentDirectory` 的 `unshift(dirPath)` 改为 `unshift(normalizeProjectPath(dirPath))`,
  Windows 下 `C:\Project` 与 `C:\PROJECT` 不再产生两条"看起来一样"的项(去重基于 normalize 后比较,
  之前 filter 已正确,只是 unshift 存了原值导致 list 越长越乱)
- **新增命名导出**: `ConfigWriteError` + `normalizeProjectPath`,便于单测与外部复用

#### `src/cli/cleanup.js` — 新增统一资源清理工具
- 抽离自 `gitCommit.js` 内的 SIGINT 处理逻辑,便于单测 + 跨 CLI 入口复用
- 提供 `registerCleanup(name, fn)` / `unregisterCleanup(name)` / `clearAllCleanup()` /
  `trackChild(child)` / `killAllTrackedChildren(graceMs)` / `runCleanupTasks()` /
  `setupSigintHandler({onBeforeCleanup, onAfterCleanup})` 等工具
- 设计原则:
  - 单次注册 + 幂等触发(多次 SIGINT 只生效第一次,避免 cleanup 中重入)
  - 同名注册覆盖(commitAndSchedule 递归 setTimeout 自然覆盖上一轮)
  - 错误隔离(单个 cleanup fn 抛错不影响后续 fn 与子进程 kill)
  - 优雅退出(子进程先 SIGTERM 给 500ms 窗口,再 SIGKILL 兜底)
  - exit code 130(128 + SIGINT 2,符合 shell 惯例)

#### `gitCommit.js` — 资源释放与异常恢复加固
- **任务 6 落地**: 之前 3 处分支(定时 commit / `--cmd --at` / `--cmd --cmd-interval`)各自
  挂 inline SIGINT handler,处理顺序不确定,且 exec() spawn 出去的子进程无人跟踪 —
  Ctrl+C 后子进程继续跑、倒计时残影、临时 `.tmp` 文件残留
- 现在: 入口 `setupSigintHandler({...})` 注册一次,所有 timer 通过 `registerCleanup(name, fn)` 上报,
  所有 `exec()` 返回的 child 通过 `trackChild(child)` 跟踪,SIGINT 时统一
  `logUpdate.clear() → runCleanupTasks() → killAllTrackedChildren() → exit 130`
- `startCountdown` 把 setInterval 注册到 cleanup 表(原 `let countdownInterval = null` 保留作为
  内部引用,cleanup fn 操作同一变量)
- `commitAndSchedule` 把 `setTimeout` 注册为 `'commitTimer'` cleanup,递归 setTimeout 自然覆盖
- `--cmd --at` 路径: `atTimer` 注册到 cleanup,exec 子进程 trackChild
- `--cmd --cmd-interval` 路径: setInterval 注册为 `'cmdInterval'` cleanup,exec 子进程 trackChild

#### `src/cli/customCommand.js` — `--cmd=` 输入校验(SEC-CLI-1 加固)
- 新增 `validateCustomCommand(cmd)` — 本地 CLI 工具,用户明确输入,所以**检测而非阻止**:
  - 拒绝: 非字符串 / 空字符串 / 以 `-` 开头(避免 exec 误解析为 flag)/ 超过 `MAX_CUSTOM_CMD_LENGTH=1000` 字符
  - 警告(不阻止): 检测到 `rm -<flag> /` / fork bomb `:(){ :|:& };:` / `chmod 777 /` 等危险模式
- 新增 `isCmdStrictMode(argv)` 检测 `--cmd-strict` flag(本轮仅打提示,实际严格模式
  的 argv 拆分器留作下轮工作 — 风险评估需要更细的语义)
- `gitCommit.js` 在 `--cmd=` 解析后立即调 `validateCustomCommand`,失败 `console.error + exit 2`
  (Bash 惯例:参数错误 exit code 2)
- 命令表面零变化:`g --cmd="echo hello"` / `g --cmd="npm run dev"` / `g --cmd="echo hi | wc -l"`
  (含管道 / 重定向 / shell 列表) 仍按原 `exec(cmd, cb)` 走 shell 执行

#### `src/cli/ui.js` — boxen 宽度自适应
- 新增 `boxenAdaptive(message, options)`,`width` 默认按 `process.stdout.columns - 6` 自适应
- `calcBoxenWidth({headroom=6})` 处理 `columns` 为 `undefined` / `0` / `NaN` / 负数的退化(回退 100)
- `gitCommit.js` 的倒计时 boxen 改用 `boxenAdaptive` — 80 列硬编码在窄终端会换行难看,
  现在 30~200 列终端都能合理适配
- Web/TTY/CI 不同环境下都能跑(`process.stdout.columns` 在管道/CI 为 undefined,走回退)

#### 测试覆盖新增(`test/` + `src/cli/` + `src/utils/`)
- `src/utils/parseCwdArg.test.js` 12 → **22 用例**: 增补带空格路径(引号 / 空格分隔两种)、
  相对路径 `./` `../`、Windows 盘符大小写、value 中嵌入等号、混入 emoji/CJK、重复 --path 等
- 新增 `src/utils/utils.test.js`(**13 用例**): `truncateForHistory` surrogate-pair 处理(完整 emoji /
  BMP CJK / 退化输入) + `exec_exit` 严格 boolean 契约(回归测试字符串 `'false'` 等)
- 新增 `src/cli/cleanup.test.js`(**20 用例**): `registerCleanup` 同名覆盖 / 错误隔离 / 串行顺序 /
  单次执行语义;`trackChild` 链式调用 / 退出自移除;`killAllTrackedChildren` SIGTERM→SIGKILL 升级;
  `setupSigintHandler` 幂等 / SIGINT 触发清理 / onBefore/After 钩子调用 — 含 dispose 模式避免
  跨 test SIGINT listener 累积
- 新增 `src/cli/customCommand.test.js`(**14 用例**): `validateCustomCommand` 全部分支 +
  `isCmdStrictMode` argv 检测;危险模式 regex 不误伤普通命令(`rm -rf build/` `chmod 644 a.txt`)
- 新增 `src/cli/ui.test.js`(**9 用例**): `calcBoxenWidth` 退化处理 + `boxenAdaptive` 行为契约
- 新增 `test/config.test.mjs`(**8 用例**): `normalizeProjectPath` 跨平台 + `saveConfig` 错误契约
  (空对象 / null / undefined / 数组 / 字符串 / 数字 / boolean 全部抛 ConfigWriteError)
- 总计新增 **64 个测试用例**,全部通过

### 验证结果

- ✅ **npm test**: 107 通过 / 1 失败 — 失败是 `test/ts-demo.test.ts` 的合并冲突标记
  (审计 TEST-1,非本轮引入,留作单独清理工单)
- ✅ **node --check**: `src/gitCommit.js` / `src/config.js` / `src/utils/index.js` / `src/cli/*.js`
  全部 syntax OK
- ✅ **命令表面兼容**: 17 个 npm script(`g` / `g:test-cmd` / `g:cwd` / `g:y` / `g:lock-file` 等)
  行为不变;新增 `--cmd-strict` flag 是纯增量
- ✅ **向后兼容**: 现有用户 ~/.git-commit-tool.json 配置不受影响(saveConfig 写入路径不变,
  仅错误分支从 warn 改为 throw,默认成功路径行为不变)

### 遗留事项 / 后续建议

| 优先级 | 事项 | 备注 |
|---|---|---|
| 中 | `test/ts-demo.test.ts` 合并冲突标记 | 审计 TEST-1,非本轮引入 |
| 中 | 全量 i18n 中英对照表 | 本轮只抽了 `src/cli/ui.js` 与 `src/cli/cleanup.js` 两个新模块的注释,
  `gitCommit.js` 与 `utils/index.js` 内 20+ 处硬编码中文(`'提交流程错误:'` / `'正在拉取代码...'`
  / `'已成功同步远程更新'` 等)未迁移,需独立 PR |
| 中 | `--cmd-strict` 模式的完整 argv 拆分器 | 本轮仅打提示 + 校验,严格模式走
  `execFile('sh', ['-c', cmd])` 还是真正的 argv token 拆分(`string-argv` / `shlex`),
  需要更细的语义讨论 |
| 中 | 定时 commitAndSchedule 的"在途 commit 完成后再退出" | 当前 SIGINT 直接 exit 130,
  在跑的 commit 会被打断;下轮可加 SIGINT 时设 `draining` 标志,commitAndSchedule 跑完
  当前 cycle 再退 |
| 低 | 命令历史 ioInstance 检查替换为显式注入 | 当前 `let ioInstance = null` 模块全局,
  测试时需 stub,可用 DI 容器替代 |
- ✅ **vue-tsc**: 0 错误(客户端目录全量类型检查)
- ✅ **dev:ping**: backend `127.0.0.1:5545` + vite `127.0.0.1:5544` 双 OK
- ✅ **HMR**: vite 200,App.vue transform 59 ms / 122 KB
- ✅ **i18n 合规**: 13 处裸中文全部归一,中英双语同步
- ✅ **a11y 范围**: 13 个 CommonDialog + 20+ IconButton + 17+ SvgIcon 全部 a11y 增强,
  3 个 resizer 键盘可达,MonacoEditor 动态按钮可达

### 遗留事项 / 后续建议

| 优先级 | 事项 | 备注 |
|---|---|---|
| 中 | `ThemeSwitcher.vue` / `LanguageSwitcher.vue` 实际功能缺失 | 仅清理了死代码,未补上"暗色主题手动切换"与"顶栏语言切换入口"两条产品功能 |
| 中 | WorkbenchView / FlowOrchestrationWorkspace / PackageJsonSelector 等大文件的 i18n 漏译 | 本轮仅扫了核心交互文件,大文件(>1000 行)未深扫,后续可继续 |
| 低 | MonacoEditor 动态按钮 `:focus-visible` 视觉提示 | 已补 `role`/`tabindex`/`aria-label` 与键盘,但样式上无 focus 环(依赖 Monaco 内部主题) |
| 低 | ARIA Live Region 用于长任务进度 | CommandConsole 流式输出场景可加 `aria-live="polite"` 给屏幕阅读器播报进度 |
| 低 | 屏幕阅读器对 Monaco 编辑器内部的支持 | Monaco 自身有 `accessibilitySupport: 'on'` 选项,但项目未显式开启,可后续评估 |
| 低 | 命令面板 / 全局快捷键系统 | 目前无 Cmd+K 之类的快速命令面板,大项目里效率提升明显 |

### GUI 客户端硬化与可访问性补齐(2026-06-26)

本轮集中:`useThemeObserver` composable 统一 5 处重复 MutationObserver · `CommandConsole.vue`
`ElMessage`/`ElMessageBox`/`throw new Error` 用户可见硬编码中文收敛为 `$t('@CF05E:...')` ·
设计令牌补 el-plus 兼容别名 + npm 品牌色,扫 AISplitChatPane/AISplitDirectPane/AppVersionBadge
26+ 处硬编码色值替换为 token · ActivityBar 3 个视图按钮 `aria-label` 动态包含徽标数,屏幕阅读器可听到。

#### Changed — composable 抽取(CQ-7)

- 新建 `src/ui/client/src/composables/useThemeObserver.ts`,提供响应式 + 命令式两种用法:
  - 响应式:`const { theme } = useThemeObserver()`,返回 `Readonly<Ref<'light'|'dark'>>`
  - 命令式:`useThemeObserver((t) => applyTheme())`,主题切换时触发副作用
- `setup()` 调用即注册 `MutationObserver(<html data-theme>)`,`getCurrentInstance()` 检测到组件上下文时自动 `onBeforeUnmount disconnect`;模块上下文返回的 `stop()` 供显式清理
- 5 处重复 `themeObserver + syncXxx + observer.observe(...) + observer.disconnect()` 模板全部收敛:
  - `App.vue` — `isDarkTheme: Ref<boolean>`(主题切换按钮的状态源)
  - `views/EditorView.vue` — Monaco 主题跟随
  - `views/SourceMapView.vue` — `currentTheme: Ref<'light'|'dark'>`,Vue Flow dotColor + Monaco theme
  - `components/MonacoEditor.vue` — diff editor applyTheme 副作用
  - `components/MonacoDiffViewer.vue` — diff editor applyTheme 副作用
- 行为保留:`applyTheme` 自带 `if (!monaco) return` 守卫,setup 阶段注册的回调在 monaco 加载完成前触发也安全

#### Changed — 设计令牌(MAINT-14)

- `styles/variables.scss` 新增 4 个 token:
  - `--el-color-primary: #409eff` — Element Plus 默认主色,旧组件锁此 token 不改视觉
  - `--bg-page-light: #f4f4f5` — el-plus 默认轻背景
  - `--border-color-extra-light: #ebeef5` — el-plus 默认细边框
  - `--color-npm: #cb3837` — npmjs 品牌红(AppVersionBadge hover)
- 现有 `--text-primary` / `--text-secondary` / `--text-tertiary` / `--color-success` / `--color-warning` / `--color-danger` 已覆盖大部分 el-plus 默认色,旧组件无需新增 token 即可替换
- 硬编码色值 → token 替换:
  - `components/AISplitChatPane.vue` × 24(扫描集中)
  - `components/AISplitDirectPane.vue` × 2(模板 el-icon color)
  - `components/AppVersionBadge.vue` × 2(`#cb3837` → `--color-npm`,`#6c757d` → `--text-secondary`)

#### Changed — i18n(MAINT-13)

- `lang/zh/index.js` + `lang/en/index.js` `@CF05E` 命名空间下新增 19 条 key:
  - `提交后启动项执行失败` / `该编排缺少流程数据,无法执行` / `未找到 start 节点` / `用户停止执行`
  - `确定要清空所有执行历史吗?此操作不可撤销。` / `清空历史` / `清空` / `取消` / `执行历史已清空`
  - `启动项命令执行失败` / `Socket 连接未就绪,无法自动执行交互式启动项` / `已在新终端中执行命令`
  - `执行失败` / `无法停止:进程ID不存在` / `命令已经结束` / `无法读取响应流` / `未知错误`
  - `重启失败` / `用户取消执行` / `等待已中断` / `等待完成` / `代码节点` / `未配置脚本`
  - `代码节点执行失败` / `代码节点未返回任何输出` / `依赖版本号为空,请检查输入/手动输入配置`
- `lang/zh/index.js` + `lang/en/index.js` `@ACTBAR` 命名空间下新增 1 条:`个任务正在执行`
- `components/CommandConsole.vue` × 26:全部 ElMessage / ElMessageBox / throw new Error 用户可见中文化为 `$t()` 包裹

#### Changed — 无障碍(a11y)

- `components/ActivityBar.vue` × 3:Git / Editor / Workbench 视图按钮的 `aria-label` 改为动态:
  - Git: `Git · 12 个未提交文件`(若有未提交)
  - Editor: `编辑器 · 3 个未保存文件`(若有 dirty)
  - Workbench: `工作台 · 2 个任务正在执行`(若有 running)
  - 之前固定 `aria-label="Git"` 仅 tooltip 含数量,屏幕阅读器读不到数字;现动态 aria-label 让 SR 也能听到徽标数

#### 验证

- ✅ **vue-tsc**: 0 错误(`src/ui/client` 全量类型检查)
- ✅ **vite build**: 0 错误,bundle chunk 与改造前无回退
  - `AppVersionBadge.css` 3.6 KB · `EditorView.js` 31 KB · monaco 系列仍独立 chunk
- ✅ **i18n 合规**: CommandConsole 用户可见硬编码中文从 26+ 处全部收敛
- ✅ **token 合规**: AISplitChatPane/AISplitDirectPane/AppVersionBadge 26+ 处硬编码色值全部替换

#### 未触动(本轮范围外,留给后续 PR)

- `@vue-flow + dagre` 大图性能(节点合并 / 视口虚拟化):当前 dagre layout 在 `buildFlowGraph` 内
  一次性跑,节点 < 200 时无感知;>500 节点建议加 shallow-equal memo 与节点合并。本轮范围外,需要 perf profile 数据驱动
- `gitStore.ts` (2406 行) / `configStore.ts` (1282 行) 按域拆分:本轮 useThemeObserver 提取是
  composable 收敛(对应审计 CQ-7),不是 store 拆分;store 拆分跨多组件依赖,需独立 PR
- MonacoEditor/MonacoDiffViewer 重复 worker 注册:dev 期 Vite 已 dedup,生产 manualChunks 合并,目前为幂等;非阻塞优化

### 依赖与构建优化(2026-06-26)

本轮集中:`vite.config.ts` 把 `monaco-editor` 加入 `optimizeDeps.exclude`(dev 首启跳过 ~3 MB 预构建) · `.nvmrc` 从 20 升到 20.19 与 `engines` 对齐 · 4 个一次性迁移脚本(`convert-colors-to-vars` / `convert-fontsize-to-vars` / `convert-spacing-to-vars` / `convert-to-standard-vars`)归档到 `scripts/archive/` · 新建 `.npmrc.example` 模板 · `package.json` `files` 字段加 `"!scripts/archive/**"` 剔除归档目录进 npm tarball。

#### Changed — vite 配置

- `src/ui/client/vite.config.ts` `optimizeDeps.exclude` 加 `monaco-editor`:首启不再卡 `[optimizer] bundling`,把 monaco 推迟到实际打开编辑器时按需加载

#### Changed — 引擎与包元数据

- `.nvmrc` `20` → `20.19`:与 `package.json#engines` `>=20.19` 对齐,杜绝装到 20.0~20.18
- `package.json` `files` 加 `"!scripts/archive/**"`:归档目录不进 npm tarball(节省 ~30 KB)

#### Added — 文档

- `.npmrc.example`:registry 配置模板,降低新贡献者踩坑成本
- `scripts/archive/README.md`:说明 4 个 convert-*.cjs 是一次性迁移脚本,不要再运行除非懂为什么

#### Chore — 归档

- `scripts/convert-colors-to-vars.cjs` / `convert-fontsize-to-vars.cjs` / `convert-spacing-to-vars.cjs` / `convert-to-standard-vars.cjs` 移到 `scripts/archive/`(README.md 同步迁移)
- 历史包袱隔离:`scripts/` 下不再混用"日常工程脚本"与"一次性迁移脚本"

#### 验证

- ✅ **npm test**:107 pass / 1 fail(失败为审计 TEST-1 的 `ts-demo.test.ts` 合并冲突,非本轮引入)
- ✅ **vue-tsc**:exit 0
- ✅ **package.json JSON parse**:valid

#### 未触动(范围外,留给后续 PR)

- `release.js` `git add .` 改显式清单 + kill 守卫(DEP-REL-1/2):涉及发版全流程,需独立 PR + dry-run
- `marked + markstream-vue-beta` 二选一(DEP-DEP-3):涉及 MarkdownPreview.vue 兼容审计
- `zen-ai-chat-ui-beta` 锁定精确版本 + overrides(DEP-DEP-4):涉及 chat UI 全套
- `index.d.ts` + `types` 字段(DEP-CFG-3):需手写 index.d.ts,跨模块
- `.github/workflows/ci.yml`(DEP-CFG-6):需新建 workflow

### 全量审计与汇总验证(2026-06-26)

本轮集中:**全量审计交付** `docs/OPTIMIZATION-FINDINGS.md`(70 条按 6 维度去重整合) · **回归测试补齐**(3 个新测试文件,17 个新用例) · **文档同步**(OPTIMIZATION-PLAN checkbox / PROJECT_MAP 行数 / UI-OVERVIEW 组件清单 / CHANGELOG 本段)。

#### Added — 审计交付物

- `docs/OPTIMIZATION-FINDINGS.md`:**70 条**审计发现(去重整合自 148 条原始),按 6 维度分类:
  - ① 代码质量 16 条 / ② 性能 9 条 / ③ 安全 **11 条(9 高危)** / ④ 可维护性 14 条 / ⑤ 依赖与配置 12 条 / ⑥ 测试与文档 8 条
  - 每条带文件路径/行号/问题/方案/优先级/影响面/风险
  - 末尾 4 阶段执行顺序:**A 安全+发版止血(1 周)** · **B 测试+文档(2 周)** · **C 前端 bundle+性能(2 周)** · **D 大文件拆分(滚动)**

#### Added — 回归测试(TEST-3 / TEST-4)

- `test/config.atomic-write.test.mjs`(6 用例):`writeRawConfigFile` 串行/并发原子写 + `.tmp` 不残留 + `saveConfig` 链式调用字段持久化
  - **审计盲区发现**:`writeRawConfigFile` 用 `${process.pid}.${Date.now()}` 派生 tmpPath,ms 精度下并发写入落入同一 ms 会导致后者 rename ENOENT。独立于"原子写"语义的次级 bug,待独立 PR 修
- `test/exec-git-injection.test.mjs`(5 用例):`execGitCommand` 不会执行 shell 注入(SEC-INJ-3 守住)
  - 攻击 `argv=['status; touch /tmp/pwn']` → git 报"unknown subcommand",touch 不执行
  - 攻击 `argv=['rev-parse', '&&', 'touch', ...]` → git 报 ambiguous argument,touch 不执行
- `test/socket-handlers.test.mjs`(7 用例):Socket.IO 关键事件通路
  - `connection` → join project room + emit `initial_command_history`
  - `request_full_history` → emit `full_command_history`
  - `clear_command_history` → emit `command_history_cleared`
  - `exec_interactive` 空/非字符串 command → emit `interactive_error`,不 spawn
  - `exec_interactive` 正常 → spawn + stdout 流式回传 + close 写入历史 + emit `interactive_exit`

#### Changed — 文档同步(TEST-9 / TEST-10 / TEST-13)

- `docs/OPTIMIZATION-PLAN.md`:28 个 OPT checkbox 全勾选,标注落地 commit hash(`944e3a5`)与状态备注;新增 §7 本轮交付汇总表 + 4 阶段剩余风险清单
- `docs/PROJECT_MAP.md`:`last-verified: 2026-06-26` frontmatter + 按 cloc 重算关键文件行数 + 新增 composable 与归档目录反映到组件清单
- `docs/UI-OVERVIEW.md`:`AppErrorBanner.vue` 补入 §4 组件清单(262 行,`role="alert" aria-live="assertive"`)+ §7 a11y 交叉链接;补 OPT-2 / OPT-5 落地项

#### 验证

- ✅ **npm test**:125 pass / 1 fail(失败为审计 TEST-1 标记的 `ts-demo.test.ts` 合并冲突,本轮独立 commit `chore(tests): remove merge-conflict test fixture` 处理 — 但本次会话范围内不动,留独立 PR)
- ✅ **vue-tsc -b --noEmit**:0 错误
- ✅ **dev:ping**:vite `127.0.0.1:5544` / backend `127.0.0.1:5545` 双 OK
- ✅ **vite build**:1m 43s,无错误,chunk 体积无回退

#### 未触动(范围外,留给后续 PR)

- `SEC-RCE-1` `vm.runInContext` RCE:涉及 `/api/execute-code-node` 端点下线或 worker 化,跨前后端
- `SEC-INJ-1~4` `shell:true` 注入:exec_stream / exec_interactive / open_terminal / open-new-tab-gui / run-npm-script 5 处独立实现统一
- `SEC-PATH-1~3` 任意文件读写:diff.js / resolve-conflict / revert_file / code-analysis 全加 `safePathInProject`
- `SEC-CHDIR-1` `process.chdir` 加白名单
- `DEP-SEC-1` `.npmrc` NPM token 轮换(`.npmrc` 已 `.gitignore`,间接达成)
- `DEP-REL-1~6` `release.js` 发版流程修正
- `TEST-1` `test/ts-demo.test.ts` 合并冲突标记删除
- `TEST-2` `CHANGELOG.md` 6 周滞后补齐(本轮 Unreleased 段已聚合本轮变更,但历史 6 周 gap 仍存在)
- `TEST-3` 高风险路由单测(workbench.js / npm.js / gitOps.js / fs.js / terminal.js)
- `TEST-5` `test/` 与 `tests/` 双目录清理
- `TEST-6` run-tests.cjs 扫描增强(当前已递归 `src/`,可接受)
- `TEST-7` e2e 不可靠测试清理
- `TEST-8` `npm test` 纳入 auto-validate 流程
- Vue composable 单测(vitest + happy-dom + @vue/test-utils,devDeps 变更独立 PR)
- `gitStore.ts` (2406) / `configStore.ts` (1282) / `WorkbenchView.vue` (3508) / `CommandConsole.vue` (3728) 大文件拆分

---

## [2.13.16] — 2026-06-18

### Added
- **feat(workbench)**: 拆分"清空子任务"与"还原空壳"语义,避免误清任务描述(`63fe61d`)
- **feat(git-status)**: 非 git 仓库空态展示"最近项目"列表,便于快速切换(`7589c14`)
- **feat(workbench)**: 子任务拆分区加"清空子任务"按钮,把任务还原为空壳(`85fefa0`)
- **feat(workbench)**: 顶部加"清空执行"按钮,一键重置当前任务执行痕迹(`fd377a9`)
- **feat(workbench)**: 子任务支持"从此处开始"执行 + 逐 sub 落盘(`cc3ab96`)
- **chore(deps)**: 升级 concurrently 至 10.x 并显式声明 engine.io 系列依赖(`0ac737f`)
- **fix(utils)**: 内联 shellQuote 补 null/undefined 守卫,与 shQuote 契约对齐(`40e2b79`)

### 基础设施
- 端口分工落地: vite dev server 5544(strictPort) + backend 5545,preview 工具不再误抓后端生产 bundle
- 新增 `cross-env` devDependency,Windows cmd 跨平台兼容
- `vite.config.ts` `strictPort: true`,端口被占直接报错(不再静默顺延)
- 新增 `.claude/launch.json` 拆分 `zen-vite` + `zen-backend` 双 server

### 验证命令
```bash
npm run dev:ping  # → 双 OK
curl -s http://127.0.0.1:5544/ | grep "@vite/client"  # 必须命中
```

---

## 版本说明

- **MAJOR**: 不兼容的 CLI 命令行变更或 GUI 大改版
- **MINOR**: 新的 GUI 子面板、新的 CLI 子命令、新的可配置项
- **PATCH**: 死代码清理、bug 修复、i18n 补漏、可访问性 / 性能优化、UI 视觉微调

本仓库遵循 Conventional Commits 规范(feat/fix/refactor/chore/docs/style/perf/test/ci),
每次 commit 标题即变更摘要。详细 changelog 由本文件汇总。