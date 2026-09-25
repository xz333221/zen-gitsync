# zen-gitsync 项目地图（Project Map）

> 单包（single package）项目，CLI + GUI + 后端 API 三体一位，前端走 Vite + Vue 3，后端走 Express + Socket.IO。
> 本文档用于后续子任务快速定位模块；阅读前请先扫一遍「核心 vs 次要」分级表，再按需深入。
>
> **last-verified**: 2026-09-25
> **verified-by**: README 全量对齐 + 目录/行数复算（数据目录收敛、工作台单任务执行重构、仓库克隆之后）
> **auto-update-readme 触发器**: 若 git log 显示距离 last-verified > 30 天,需重新 cloc 重算行数

---

## 1. 基础元信息

| 字段 | 值 |
|------|----|
| 包名 | `zen-gitsync` |
| 版本 | `2.17.14`（`package.json`，截至 2026-09-25） |
| 类型 | `type: "module"`（ESM） |
| 是否 monorepo | **否**，单包。`src/ui/client/` 里有独立的 `package.json`（私有名 `client`），仅作为 vite dev server 的子工程存在，不发布到 npm |
| 总提交数 | 2146（截至 2026-09-25） |
| 主要 commit 类型 | 近 500 次：`chore` ×148 / `feat` ×147 / `fix` ×120 / `refactor` ×30 / `docs` ×15 / `test` ×12 |
| License | Apache-2.0 |
| 主仓库 | `xz333221/zen-gitsync`（`git remote -v` 已指向带 s 的新名，旧重定向告警已消失）；根目录已无 `CHANGELOG.md` 与 `pnpm-lock.yaml` |

## 2. 技术栈

| 层 | 栈 |
|----|----|
| **CLI** | Node.js (ESM, engines ≥ 20.19) + chalk + ora + cli-table3 + log-update + boxen |
| **GUI 后端** | Express 5 + Socket.IO 4 + child_process + iconv-lite + pdf-parse |
| **GUI 前端** | Vue 3.5 + Vite 8 + Pinia 3 + vue-i18n 9 + Element Plus 2.11 |
| **智能体对话渲染** | zen-ai-chat-ui 0.1.0-beta.9（工作台执行流 + 智能体页共用） |
| **可视化/编辑器** | monaco-editor 0.55、@vue-flow/core 1.48（+ minimap / controls）、flow-mindmap 0.6、dagre 0.8、markstream-vue 1.0.3-beta、@vue-office/docx·excel·pptx（Office 预览） |
| **样式** | Tailwind 4 + SCSS + 大量自研 CSS variables（`styles/*.scss`） |
| **类型检查** | vue-tsc + tsc 5.7 |
| **测试** | Playwright 1.60（e2e，`src/ui/client/e2e/`）+ vitest 3（组件/工具单测，`*.test.ts`）+ 原生 `.test.mjs` / `.test.js`（`test/`、`src/ui/server/**`、`src/cli/**`，共 109 个测试文件） |

## 3. 三段式架构

```
            ┌─────────────────────────────────────────────┐
            │  CLI (npm bin: `g`)                         │
            │  src/gitCommit.js (433 行)                  │
            │  src/config.js (723 行, 用户配置管理)        │
            │  src/utils/index.js (1053 行, 共享工具)      │
            │  src/cli/ (19 文件 / 5.6k 行: cleanup、      │
            │            customCommand、ui、ai/ 18 模块)   │
            └──────────────────────┬──────────────────────┘
                                   │
                ┌──────────────────┴──────────────────┐
                ▼                                     ▼
   ┌──────────────────────┐             ┌──────────────────────────┐
   │  GUI 后端 (Express)  │  proxy /api │  GUI 前端 (Vite + Vue)   │
   │  src/ui/server/      │ ◄──────────►│  src/ui/client/src/      │
   │  入口 index.js(621)  │             │  入口 main.ts + App.vue  │
   │  routes/ (47 文件)   │             │  views/ (7 顶层视图)     │
   │  socket/             │             │  components/ (50 组件)   │
   │  utils/ (15 文件)    │             │  stores/ (10 个 pinia)   │
   └──────────────────────┘             │  lang/ (zh + en, 5.5k 行)│
                                        └──────────────────────────┘
```

**端口分工**（规则见 `.claude/rules/preview-launch.md`）：
- `5544` → Vite dev server（HMR，preview 工具只问这个端口）
- `5545` → Express 后端（写到根目录 `.port`，vite.config 读它做 proxy target）
- 生产 / CLI 场景（`g ui`）**不固定端口**：`utils/randomStartPort.js` 在 `4000–6000` 里随机挑一个起点，`startServerOnAvailablePort` 顺序探测可用端口；设 `PORT` 可强制固定

---

## 4. 完整目录树（去除 `node_modules`、`.git`、图标 SVG）

```
zen-gitsync/                                    [根: 配置文件 + 顶层脚本]
├── package.json            # npm 主入口,bin: g → src/gitCommit.js
├── index.js                # 启动 UI server 的 ESM 包装(导出 startServer)
├── server.js               # 直接 node 启动 UI server 的 CLI 入口
├── nodemon.json            # dev:server 的 nodemon 配置
├── .gitignore .npmignore .npmrc.example .nvmrc .port .gitattributes
├── LICENSE                  # Apache-2.0
├── README.md                # 用户文档(英 + 中),约 1.3k 行
├── AGENTS.md                # AI 工具入口(指向 CLAUDE.md)
├── PRODUCT.md               # 产品定位
├── 源码笔记.md               # 中文源码结构笔记
├── .workbuddy/              # WorkBuddy 会话记忆
├── docs/                    # [文档目录]
│   ├── PROJECT_MAP.md       # ← 本文件
│   ├── UI-OVERVIEW.md / UX-AUDIT.md / OPTIMIZATION-PLAN.md / OPTIMIZATION-FINDINGS.md / CODE_REVIEW_2026-08-29.md
│   ├── migrations/          # MIGRATION_ICON_BUTTON.md / SVG_ICON_SETUP.md
│   ├── wechat-article.md
│   └── screenshots/         # UI 截图(audit-* 审计产物 + article/ 文章配图)
├── public/images/           # README 直接引用的 6 张界面截图(git-panel-changes / console-panel / ...)
├── scripts/                 # [运维脚本]
│   ├── release.js           # 发版(必走)
│   ├── run-tests.cjs        # npm test 入口
│   ├── dev-ping.cjs         # dev server 探测
│   ├── verify-*.mjs/.cjs    # i18n / 配置并发 / 数据目录迁移 / 工作台各专项校验
│   └── convert-*-to-vars.cjs # 4 个颜色/字号/间距 → CSS vars 转换器
├── src/                     # [核心: 三段式主体]
│   ├── gitCommit.js         # CLI 主控(433 行)
│   ├── config.js            # 用户配置读写(723 行)
│   ├── configSplit.js / dataDirMigration.js / fsAtomic.js  # 配置拆分 / 数据目录迁移 / 原子写
│   ├── paths.js             # 数据路径唯一真相源(DATA_DIR = ~/.zen-gitsync/)
│   ├── aiCommit.js          # AI 生成提交信息(`g --ai` 与 GUI 共用)
│   ├── utils/               # 共享工具(index.js 1053 行 + aiEndpoint / shellPath / parseCwdArg …)
│   ├── cli/                 # CLI 子系统: cleanup / customCommand / ui
│   │                        #   ai/ 18 模块(agent、termui、turn、transport、tools、skills、mcp、
│   │                        #   sessionStore、telemetry、safety、images、modelSetup …)
│   └── ui/
│       ├── client/          # [核心: 前端工程]
│       │   ├── package.json # 私有子工程(name: client)
│       │   ├── vite.config.ts
│       │   ├── tsconfig.json + tsconfig.app.json + tsconfig.node.json
│       │   ├── playwright.config.ts
│       │   ├── i18n.config.cjs + i18n.secret.example.cjs
│       │   ├── index.html   # Vite 入口 HTML
│       │   ├── auto-imports.d.ts + components.d.ts (unplugin 生成)
│       │   ├── e2e/         # Playwright 测试
│       │   ├── public/      # 静态资源(public/ 自身构建产物由 src/ui/public/ 提供)
│       │   ├── vite-plugins/svg-icon/   # 自定义 svg icon plugin
│       │   └── src/
│       │       ├── main.ts                # Vue 应用入口
│       │       ├── App.vue                # 根组件 (1874 行, 包含全局 UI shell)
│       │       ├── views/
│       │       │   ├── AgentView.vue      # 智能体页(会话 + Skill/MCP 广场入口)
│       │       │   ├── ConsoleView.vue    # 控制台(自定义命令 + 终端)
│       │       │   ├── EditorView.vue     # Monaco 编辑器视图
│       │       │   ├── MindmapView.vue / MonitorView.vue
│       │       │   ├── SourceMapView.vue  # 依赖关系图(**Activity Bar 入口已隐藏**)
│       │       │   ├── WorkbenchView.vue  # 工作台 (2746 行, 任务编辑器浮层)
│       │       │   └── components/        # 视图级子组件
│       │       │       ├── GitStatus.vue        (2550 行)
│       │       │       ├── LogList.vue          (2140 行)
│       │       │       ├── CommitForm.vue / CommandHistory.vue / CommitGraphCell.vue
│       │       │       ├── WorkbenchBoard.vue   (983 行, 多项目编排台)
│       │       │       ├── WorkbenchKanban.vue  (583 行, 看板 / 表格)
│       │       │       ├── WorkbenchProjectPanel.vue / WorkbenchAgentPanel.vue
│       │       │       ├── WorkbenchSidebar.vue / WorkbenchDefaultPromptDialog.vue
│       │       │       └── WorkbenchTaskCreateDialog.vue / OrchestratorConsole.vue
│       │       ├── components/           # 50 个通用组件
│       │       │   ├── CommandConsole.vue    (3807 行, **第二大**)
│       │       │   ├── FileDiffViewer.vue    (2288 行) + DiffPreviewPanel.vue / OfficePreview.vue
│       │       │   ├── GitGlobalSettingsDialog.vue (6 个 tab 的统一设置弹窗)
│       │       │   ├── MarketplacePanel.vue  # Skill / MCP 广场
│       │       │   ├── ActivityBar.vue / AppErrorBanner.vue / AppVersionBadge.vue
│       │       │   ├── AttachmentZone.vue / BranchSelector.vue / CanvasModal.vue
│       │       │   ├── AiDiffSummary.vue / CommonDialog.vue
│       │       │   ├── CustomCommandManager.vue / CustomCommandsPanel.vue
│       │       │   ├── DirectorySelector.vue / ExecutionLogManager.vue
│       │       │   ├── FileActionButtons.vue / FileGroup.vue / FileTreeView.vue
│       │       │   ├── GitActionButtons.vue / GitCommandPreview.vue
│       │       │   ├── GlobalLoading.vue / IconButton.vue / ViewLoading.vue
│       │       │   ├── ImagePreview.vue / InstanceSwitcher.vue / TaskExecutorIcon.vue
│       │       │   ├── JobLogDetails.vue
│       │       │   ├── MarkdownPreview.vue / MindmapPreview.vue
│       │       │   ├── MonacoDiffViewer.vue / MonacoEditor.vue
│       │       │   ├── NpmScriptsPanel.vue / NpmSettingsDialog.vue
│       │       │   ├── PackageJsonSelector.vue / ProjectStartupButton.vue
│       │       │   ├── ProjectStartupDialog.vue / PushProgressModal.vue
│       │       │   ├── RecentDirectoriesList.vue / RecentDirectoriesSummary.vue
│       │       │   ├── RemoteReposList.vue / RemoteRepoCard.vue / RemoteManagerDialog.vue
│       │       │   ├── SvgIcon/index.vue + index.ts
│       │       │   ├── TemplateManager.vue / TreeNodeItem.vue
│       │       │   ├── ToolInstallDialog.vue / UpgradeDialog.vue
│       │       │   ├── buttons/         # 16 个原子按钮组件
│       │       │   │   ├── CommitButton.vue / ConfigEditorButton.vue
│       │       │   │   ├── CreateTagButton.vue / DiscardAllChangesButton.vue
│       │       │   │   ├── GitOperationsButton.vue / MergeBranchButton.vue
│       │       │   │   ├── PushButton.vue / QuickCommitButton.vue
│       │       │   │   ├── QuickPushButton.vue / ResetToRemoteButton.vue
│       │       │   │   ├── StageButton.vue / StashChangesButton.vue
│       │       │   │   ├── StashListButton.vue (818 行)
│       │       │   │   ├── StashSelectedFilesButton.vue
│       │       │   │   ├── TagListButton.vue (735 行)
│       │       │   │   └── UnstageAllButton.vue
│       │       │   ├── flow/            # 工作流编排子系统
│       │       │   │   ├── FlowExecutionViewer.vue
│       │       │   │   ├── FlowOrchestrationWorkspace.vue (1423 行)
│       │       │   │   ├── NodeConfigPanel.vue (2087 行)
│       │       │   │   ├── NodeInputConfig.vue / CodeNodeInputConfig.vue
│       │       │   │   ├── ParamListContainer.vue / UserInputParamConfig.vue
│       │       │   │   └── nodes/       # 8 种节点类型
│       │       │   │       ├── BaseNode.vue
│       │       │   │       ├── CodeNode.vue / CommandNode.vue
│       │       │   │       ├── ConditionNode.vue / ConfirmNode.vue
│       │       │   │       ├── StartNode.vue / UserInputNode.vue
│       │       │   │       ├── VersionNode.vue / WaitNode.vue
│       │       │   │       └── NodeContextMenu.vue
│       │       │   └── icons/ListIcon.vue / TreeIcon.vue
│       │       ├── composables/   # Vue composables
│       │       │   ├── useAnsiToHtml.ts / useGlobalLoading.ts
│       │       │   ├── useNetworkStatus.ts / useSuccessModal.ts
│       │       │   └── useTerminalSessions.ts
│       │       ├── stores/        # Pinia stores(10 个)
│       │       │   ├── configStore.ts       # 全局配置
│       │       │   ├── editorTabs.ts        # 编辑器 tab 状态
│       │       │   ├── gitStore.ts          # Git 操作 + 状态
│       │       │   ├── instancesStore.ts    # 多实例(g ui 进程)管理
│       │       │   ├── localeStore.ts       # i18n
│       │       │   ├── mindmapStore.ts / monitorStore.ts
│       │       │   ├── terminalSessions.ts  # 终端会话计数(Activity Bar 徽标)
│       │       │   ├── toolsStore.ts        # 本地 CLI 探测(7 个工具 + 版本)
│       │       │   └── workbenchStatus.ts   # 工作台运行状态
│       │       ├── lang/
│       │       │   ├── zh/index.js (2777 行) + index.d.ts
│       │       │   ├── en/index.js (2766 行) + index.d.ts
│       │       │   └── static.ts + static.d.ts
│       │       ├── locales/index.ts          # vue-i18n 实例化(setLocale / getLocale)
│       │       ├── plugins/elementPlus.ts    # Element Plus 配置
│       │       ├── styles/                  # SCSS / CSS
│       │       │   ├── main.css / tailwindcss.css / common.scss
│       │       │   ├── dark-theme.scss / unified-dialogs.scss
│       │       │   ├── workbench.scss / markdown-renderer.css
│       │       ├── types/                   # 类型声明(.d.ts)
│       │       │   ├── ai-model-form.d.ts / conflict.ts
│       │       │   ├── element-plus-locale.d.ts / instances.ts
│       │       │   ├── json.d.ts / local-file-picker.d.ts / workbench.ts
│       │       ├── utils/                   # 工具函数
│       │       │   ├── appVersion.ts / commandParser.ts / editorLang.ts
│       │       │   ├── fileIcon.ts / fileKind.ts / fileTree.ts
│       │       │   ├── jobStatus.ts / jobToolCalls.ts / path.ts
│       │       │   ├── agentAvatar.ts / taskExecutor.ts / taskNotify.ts
│       │       │   ├── localClones.ts / remoteUrl.ts   # 本地仓库索引 / SSH-HTTP 地址归一化
│       │       │   ├── materialFileIcons.ts + material-*.json / materialFallbackMap.json / materialCloneAliases.json
│       │       │   └── index.ts
│       │       ├── assets/icons/material/  # 1196 个 material 风格 svg 图标
│       │       └── vite-env.d.ts
│       ├── public/                # [构建产物] vite build 输出到此
│       │   ├── index.html
│       │   ├── favicon.svg / logo.svg / vite.svg
│       │   └── assets/
│       └── server/                # [核心: GUI 后端 Express]
│           ├── index.js           # 入口(601 行,startUIServer)
│           ├── middleware/requestLogger.js
│           ├── routes/            # 47 个路由文件(含 git/ 和 workbench/ 子目录)
│           │   ├── workbench.js        # 主入口 → workbench/ 子目录
│           │   ├── workbench/          # 工作台子系统(20 个子模块)
│           │   │   ├── index.js (1383 行) / taskRunner.js (791 行, claude + opencode 双执行器) / jobStore.js
│           │   │   ├── agentRoutes.js / agentChat.js / agentSessionStore.js / agentMarketplace.js
│           │   │   ├── orchestratorStore.js / projectRegistry.js / targetResolver.js / projectTool.js
│           │   │   ├── instructionStore.js / promptParts.js / envContext.js
│           │   │   ├── llmClient.js / jsonParse.js / pdfText.js
│           │   │   ├── projectScan.js / attachmentUtils.js / shared.js
│           │   ├── config.js           (1211 行)
│           │   ├── npm.js              (1460 行)
│           │   ├── gitOps.js           (1416 行)
│           │   ├── codeAnalysis.js / fs.js / fileOpen.js
│           │   ├── exec.js / terminal.js / process.js / status.js
│           │   ├── localRepos.js       # 全盘本地仓库索引(GET 快照 / POST 重扫)
│           │   ├── recentDirectoriesAiSummary.js  # 最近项目的 AI 状态解读
│           │   ├── remoteRepos.js      # GitHub / Gitee 仓库浏览
│           │   ├── git.js + git/
│           │   │   ├── stash.js / tags.js / remotes.js
│           │   │   ├── clone.js        # 克隆到指定文件夹(SSH 优先)
│           │   │   ├── aiDiffSummary.js
│           │   │   └── diff.js + diffUtils.js
│           │   ├── code.js             # **code 节点 RCE 入口,审计 SEC-RCE-1 标记**
│           │   ├── branchStatus.js / mindmap.js / monitor.js / instances.js
│           ├── socket/
│           │   └── registerUiSocketHandlers.js
│           └── utils/               # 15 个工具模块
│               ├── instanceRegistry.js (跨进程 GUI 注册表)
│               ├── pathGuard.js / shellQuote.js / gitArgs.js / gitExitCode.js
│               ├── startServerOnAvailablePort.js / randomStartPort.js / createSavePortToFile.js
│               ├── localRepoScan.js    # 全盘本地仓库扫描(缓存到 ~/.zen-gitsync/local-repos.json)
│               ├── directoryFetch.js / directoryGitState.js  # 最近目录批量 fetch / Git 状态
│               ├── officePreview.js    # Office 文档服务端转换预览
│               └── asyncRoute.js / logger.js / perfMark.js
├── test/                     # [次要: 测试 + 历史遗留样本]
│   ├── config.test.mjs / config.atomic-write.test.mjs / config.cache-invalidation.test.mjs
│   ├── configSplit.test.mjs / dataDirMigration.test.mjs / package-files.test.mjs
│   ├── security-hardening.test.mjs / exec-git-injection.test.mjs / socket-handlers.test.mjs
│   ├── server-regression.test.mjs / tool-installers.test.mjs / diff-prompt.test.mjs
│   ├── demo-realistic.mjs（不再是测试，历史样例）
│   ├── dialog-test.txt / locked-test.txt / test-merge.txt
│   ├── flex-layout-test.html / grid-expand-collapse.html / vertical-flex-layout-test.html  # 历史调试页
│   ├── test111/ / test222/ / teststash/ / 不同类型文件测试/  # 真实仓库测试样本
│   └── 测试一个很长很长很长的文件名.md  # 中文边界测试
├── public/images/           # README 引用的 6 张界面截图(见 §4 根目录)
├── .claude/                 # Claude 会话规范
│   ├── launch.json          # preview 工具双 server 配置(zen-backend + zen-vite)
│   ├── settings.local.json
│   ├── rules/               # hmr-debug-check / i18n-check / preview-launch /
│   │                        # syntax-check / tsc-check / README.md (共 6 个)
│   ├── skills/              # 项目级 skill(ui-ux-pro-max 等)
│   └── verify/              # 验证截图产物
├── .github/                 # copilot-instructions + instructions/(tsc/syntax/i18n 检查)
├── .shared/                 # 跨 AI 工具共享 skill(ui-ux-pro-max)
└── (无 .agents/ 、skills/ 、e2e/ ，均已清理)
```

---

## 5. 关键文件速查表

| 类别 | 文件 | 行数 | 作用 |
|------|------|------|------|
| **CLI 入口** | `src/gitCommit.js` | 433 | `g` 命令主控,支持 ui/ai/log/addScript/addResetScript/get-config 等子命令 |
| **CLI 配置** | `src/config.js` | 723 | 读写 `~/.zen-gitsync/config.json`,包含代理、最近目录、locale、AI 模型 |
| **数据路径** | `src/paths.js` | 82 | `DATA_DIR = ~/.zen-gitsync/` 及全部子路径的唯一真相源 |
| **共享工具** | `src/utils/index.js` | 1053 | execGitCommand / 帮助文案 / git lock / addScript 等 |
| **GUI 后端入口** | `src/ui/server/index.js` | 621 | 启 Express + Socket.IO + 注册所有路由/中间件 |
| **工作台后端** | `src/ui/server/routes/workbench/index.js` | 1383 | 任务/派发/日志路由;执行器在 `taskRunner.js`(791 行) |
| **GUI 前端入口** | `src/ui/client/src/main.ts` | 36 | Vue app 启动,挂 Pinia + i18n + SvgIcon |
| **Vite 配置** | `src/ui/client/vite.config.ts` | 167 | strictPort=5544 / proxy / manualChunks |
| **i18n 入口** | `src/ui/client/src/locales/index.ts` | 78 | createI18n + setLocale/getLocale |
| **Playwright** | `src/ui/client/playwright.config.ts` | 71 | baseURL=http://localhost:5544 |
| **TS 配置** | `src/ui/client/tsconfig.app.json` | 23 | strict + paths + alias |
| **dev:ping** | `scripts/dev-ping.cjs` | 67 | 探测 vite + backend 双 server |
| **发版** | `scripts/release.js` | — | 必走发版链路(详见 MEMORY);单次 npm install 已不限时 |
| **根 README** | `README.md` | ~1.3k 行 | 用户文档(中英双语) |

---

## 6. 代码统计(2026-09-25 复算)

| 模块 | 文件数 | 行数 |
|------|------|------|
| **前端 .vue 总计** | 107 | **~62,500** |
| └ views/WorkbenchView.vue | 1 | **2,746**(单任务执行重构后) |
| └ views/components/WorkbenchBoard.vue | 1 | 983 |
| └ views/components/WorkbenchKanban.vue | 1 | 583 |
| └ components/CommandConsole.vue | 1 | **3,807**(第二大) |
| └ views/components/GitStatus.vue | 1 | 2,550 |
| └ components/FileDiffViewer.vue | 1 | 2,288 |
| └ views/components/LogList.vue | 1 | 2,140 |
| └ flow/NodeConfigPanel.vue | 1 | 2,087 |
| └ views/EditorView.vue | 1 | 1,999 |
| └ App.vue | 1 | 1,874 |
| **前端 .ts(不含 *.test.ts)** | 72 | **~10,800** |
| **GUI 后端 .js(不含 *.test.js)** | 67 | **~22,300** |
| └ routes/workbench/index.js | 1 | 1,383 |
| └ routes/npm.js | 1 | 1,460 |
| └ routes/gitOps.js | 1 | 1,416 |
| └ routes/config.js | 1 | 1,211 |
| └ routes/workbench/taskRunner.js | 1 | 791 |
| └ routes/code.js | 1 | 110 左右(审计 SEC-RCE-1 高危) |
| **CLI(src/, 不含 UI 与测试) .js** | 166 | **~50,000**(其中 `src/cli/` 19 文件 / 5,618 行) |
| └ src/utils/index.js | 1 | 1,053 |
| └ src/config.js | 1 | 723 |
| └ src/gitCommit.js | 1 | 433 |
| **i18n zh + en** | 2 | **5,543** |
| **测试文件(全仓)** | 109 | — |
| **总计(不含图标 SVG 与测试)** | — | **~95,000** |

> 1196 个图标 SVG 占 `src/ui/client/src/assets/icons/material/` 大量体积但非业务代码。
>
> **关键变化溯源**(自 2026-06-26 时点起):
> - 工作台从「子任务」模型重构为**单任务会话 + 多项目看板**(4baf1343 / 1f054fd0),`WorkbenchView.vue` 4579 → 2746
> - `routes/workbench.js` 拆成 `routes/workbench/` 20 个子模块;新增 `localRepos.js` / `remoteRepos.js` / `git/clone.js`
> - 数据目录收敛到 `~/.zen-gitsync/`(`paths.js` + `dataDirMigration.js`),配置读写拆出 `configSplit.js` / `fsAtomic.js`
> - CLI 新增 `src/cli/ai/` 18 个模块(g ai 重构)与 `--ai` / `addScript` / `addResetScript`

---

## 7. 核心 vs 次要 vs 忽略 三档分类（决定后续子任务阅读优先级）

### 🟢 核心 CORE（必读，几乎所有功能改动都涉及）

| 路径 | 说明 | 优先级 |
|------|------|--------|
| `src/gitCommit.js` | CLI 主控 | P0 |
| `src/config.js` | 用户配置 | P0 |
| `src/utils/index.js` | 共享工具(被前后端都用) | P0 |
| `src/utils/aiEndpoint.js` | **AI 请求的 baseURL/请求头统一构造**(客户端身份 + OpenCode 网关的会话头/协议族) | P1 |
| `src/ui/server/index.js` | GUI 后端入口,所有路由注册中心 | P0 |
| `src/ui/client/src/main.ts` + `App.vue` | 前端启动 + 全局 shell | P0 |
| `src/ui/client/src/views/WorkbenchView.vue` | 工作台任务编辑器(浮层) | P0 |
| `src/ui/client/src/views/components/WorkbenchBoard.vue` + `WorkbenchKanban.vue` + `OrchestratorConsole.vue` | 多项目编排台 / 看板 / 主 Agent 控制台 | P0 |
| `src/ui/client/src/components/CommandConsole.vue` | 命令控制台(第二大) | P0 |
| `src/ui/client/src/views/components/GitStatus.vue` | Git 状态视图 | P0 |
| `src/ui/client/src/stores/*.ts` (10 个) | 全部 Pinia store | P0 |
| `src/ui/client/src/lang/zh/index.js` + `en/index.js` | **i18n 改动必须同步** | P0 |
| `src/ui/client/src/locales/index.ts` | i18n 运行时 | P0 |
| `src/ui/client/vite.config.ts` | 构建/端口/proxy | P0 |
| `.claude/rules/` (6 个 md) | 项目强制规则 | P0 |
| `src/ui/server/routes/` (按需进入) | 后端 API 路由 | P1 |

### 🟡 次要 SECONDARY（功能相关时才需要看）

| 路径 | 说明 | 触发条件 |
|------|------|---------|
| `src/ui/client/src/views/EditorView.vue` | Monaco 编辑视图 | 改编辑器/Monaco 相关 |
| `src/ui/client/src/views/SourceMapView.vue` | 依赖关系图(**Activity Bar 入口已隐藏**) | 改源码地图 |
| `src/ui/client/src/views/AgentView.vue` + `components/MarketplacePanel.vue` | 智能体页 + Skill/MCP 广场 | 改智能体 / 广场 |
| `src/ui/client/src/components/flow/` (17 文件) | 工作流节点系统(8 种节点) | 改节点类型/编排 |
| `src/ui/client/src/components/buttons/` (16 文件) | 原子按钮 | 改单一 git 操作 |
| `src/ui/client/src/components/JobLogDetails.vue` / `ExecutionLogManager.vue` | 工作台日志 | 改任务日志 |
| `src/ui/client/src/types/` (7 文件) | 类型声明 | 加新依赖/类型 |
| `src/ui/client/src/composables/` (10+ 文件) | composables | 加新 composable |
| `src/ui/client/src/utils/` (20+ 文件) | 前端工具 | 加新工具 |
| `src/ui/client/src/stores/toolsStore.ts` | 本地 CLI 探测(7 工具 + 版本/最新版) | 改工具检测 / 安装引导 |
| `src/ui/server/utils/localRepoScan.js` | 全盘本地仓库扫描 | 改「已克隆」徽标 |
| `src/ui/client/src/plugins/elementPlus.ts` | Element Plus 配置 | 改组件库配置 |
| `src/ui/server/socket/registerUiSocketHandlers.js` | Socket.IO 事件 | 加新实时事件 |
| `src/ui/server/utils/instanceRegistry.js` | 跨进程实例注册表 | 改多实例行为 |
| `src/ui/client/src/styles/` (7 个 scss/css) | 全局样式 | 改主题/暗色 |
| `docs/OPTIMIZATION-PLAN.md` / `UI-OVERVIEW.md` / `UX-AUDIT.md` | UX 审计产物 | 视觉相关任务 |
| `scripts/release.js` | 发版链路 | 准备发版 |
| `scripts/dev-ping.cjs` | dev server 探测 | 起 preview/调试 |
| `src/ui/client/e2e/` (Playwright) | E2E 测试 | 改完 UI 跑回归 |
| `test/` (根目录) | 早期 .test.mjs + 仓库测试样本 | 改 utils 时看回归 |

### ⚫ 忽略 IGNORE（除非特别指定，否则跳过）

| 路径 | 说明 |
|------|------|
| `.shared/` | 跨 AI 共享 skill 库(由 `.claude/skills/` 引用) |
| `.workbuddy/` | WorkBuddy 会话记忆归档 |
| `test/test111/` `test222/` `teststash/` `不同类型文件测试/` | Git 仓库测试样本(真实仓库) |
| `src/ui/client/src/assets/icons/material/` (1196 个 SVG) | 第三方图标集,按需引用,无需阅读 |
| `src/ui/client/auto-imports.d.ts` `components.d.ts` | unplugin 自动生成,**不要手改** |
| `src/ui/client/.claude/codediff.txt` | Claude Code post_tool_hook 产物 |
| `.gitignore` 排除的：`node_modules/` `dist/` `.env.local` `lib/` `i18n.secret.*` | 不进 git |

---

## 8. 阅读顺序建议（按子任务类型）

### 改前端组件 / 样式
1. `.claude/rules/hmr-debug-check.md`(验证规范)
2. `.claude/rules/i18n-check.md`(中文字符串)
3. `.claude/rules/syntax-check.md` + `tsc-check.md`
4. 改文件 → `src/ui/client/src/lang/zh|en/index.js` 同步
5. `scripts/dev-ping.cjs` → 启 preview → 浏览器验证

### 改后端 API
1. `src/utils/index.js` 看共享工具
2. `src/ui/server/routes/` 对应文件
3. `src/ui/server/index.js` 是否需要注册新路由
4. `src/ui/server/socket/registerUiSocketHandlers.js` 是否需要新事件
5. `src/ui/client/src/stores/` + 对应组件消费

### 改 CLI 命令
1. `src/gitCommit.js` 主流程
2. `src/config.js` 是否需要新配置项
3. `package.json` 加 `g:xxx` 脚本

### 改工作台 (Workbench)
1. `views/components/WorkbenchBoard.vue` (多项目编排台三栏壳)
2. `views/components/WorkbenchKanban.vue` (看板 / 表格) + `OrchestratorConsole.vue` (主 Agent 派发)
3. `views/WorkbenchView.vue` (任务编辑器浮层：任务字段 / 附件 / 执行日志 / 续聊)
4. `views/components/WorkbenchSidebar.vue` / `WorkbenchProjectPanel.vue`
5. `routes/workbench/index.js` + `taskRunner.js` (后端执行引擎，claude / opencode 双执行器)

### 改可视化流程编排 (Flow)
1. `components/flow/FlowOrchestrationWorkspace.vue` (画布，节点类型注册)
2. `components/flow/NodeConfigPanel.vue` (节点配置)
3. `components/flow/nodes/` 8 种节点(start / command / wait / version / confirm / code / condition / user_input)

### 改智能体 (Web + CLI)
1. `views/AgentView.vue` + `components/MarketplacePanel.vue` (对话 + Skill/MCP 广场)
2. `routes/workbench/agentRoutes.js` / `agentChat.js` / `agentMarketplace.js`
3. CLI 侧：`src/cli/ai/agent.js` 与同目录 17 个模块(termui / turn / transport / tools / skills / mcp …)

### 国际化 (i18n)
1. `src/ui/client/src/lang/zh/index.js` 加 key
2. `src/ui/client/src/lang/en/index.js` 加翻译
3. 命名空间复用文件内已有前缀(规则见 `i18n-check.md`)

### 发版
1. `MEMORY.md` → `feedback_release_must_use_npm_run_release.md`(强制 `npm run release`)
2. `scripts/release.js`(build + push + npm publish 完整链路)

---

## 9. 注意事项 & 已知约束

- **数据目录唯一**：所有持久化都在 `~/.zen-gitsync/`(`src/paths.js` 是唯一真相源)，旧散落文件由 `src/dataDirMigration.js` 幂等迁入。
- **HMR 链路陷阱**：所有"前端改了不生效"先按 `.claude/rules/hmr-debug-check.md` 规则 0 排查。
- **i18n 硬约束**：任何新中文字符串必须 `$t()` 包裹 + 双语文件同步。
- **三档改动流程**：代码改完必须走 auto-validate → auto-preview-verify(前端) → auto-update-readme(功能) → auto-commit(详见 `.claude/rules/README.md`)。
- **workbench 子系统是近期开发重点**：多项目看板 / 派发 / 双执行器都在 `routes/workbench/` + `views/components/Workbench*.vue`。
- **源码地图入口当前隐藏**：`ActivityBar.vue` 的 `SHOW_SOURCE_MAP = false`，视图本身仍可用。
- **前端组件大文件普遍存在**：单文件超过 2000 行的有 5 个(`CommandConsole` / `FileDiffViewer` / `GitStatus` / `LogList` / `NodeConfigPanel`)，编辑时优先看是否已有同主题的更小文件可拆分。
