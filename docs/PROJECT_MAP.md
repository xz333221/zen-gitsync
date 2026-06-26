# zen-gitsync 项目地图（Project Map）

> 单包（single package）项目，CLI + GUI + 后端 API 三体一位，前端走 Vite + Vue 3，后端走 Express + Socket.IO。
> 本文档用于后续子任务快速定位模块；阅读前请先扫一遍「核心 vs 次要」分级表，再按需深入。
>
> **last-verified**: 2026-06-26
> **verified-by**: 全量审计 + 4 阶段优化执行(参见 `docs/OPTIMIZATION-FINDINGS.md`)
> **auto-update-readme 触发器**: 若 git log 显示距离 last-verified > 30 天,需重新 cloc 重算行数

---

## 1. 基础元信息

| 字段 | 值 |
|------|----|
| 包名 | `zen-gitsync` |
| 版本 | `2.13.30`（`package.json`，截至 2026-06-26） |
| 类型 | `type: "module"`（ESM） |
| 是否 monorepo | **否**，单包。`src/ui/client/` 里有独立的 `package.json`（私有名 `client`），仅作为 vite dev server 的子工程存在，不发布到 npm |
| 总提交数 | 1660+（截至 2026-06-21） |
| 主要 commit 类型 | `feat` ×81 / `chore` ×44 / `fix` ×41 / `refactor` ×17 |
| License | Apache-2.0 |
| 主仓库 | `xz333221/zen-gitsync`（注意带 s，README/CHANGELOG 显示旧名 `zen-git`，见 MEMORY） |

## 2. 技术栈

| 层 | 栈 |
|----|----|
| **CLI** | Node.js (ESM) + chalk + ora + cli-table3 + log-update |
| **GUI 后端** | Express 5 + Socket.IO 4 + child_process + iconv-lite |
| **GUI 前端** | Vue 3.5 + Vite 8 + Pinia 3 + vue-i18n 9 + Element Plus 2.11 |
| **可视化/编辑器** | monaco-editor 0.55、@vue-flow/core 1.48、flow-mindmap 0.3、dagre 0.8、markstream-vue 1.0.3-beta |
| **样式** | Tailwind 4 + SCSS + 大量自研 CSS variables（`styles/*.scss`） |
| **类型检查** | vue-tsc + tsc 5.7 |
| **测试** | Playwright 1.60（e2e，`src/ui/client/e2e/`）+ 原生 `.test.mjs`（`test/`、`src/ui/server/utils/`） |

## 3. 三段式架构

```
            ┌─────────────────────────────────────────────┐
            │  CLI (npm bin: `g`)                         │
            │  src/gitCommit.js (455 行)                  │
            │  src/config.js (350 行, 用户配置管理)       │
            │  src/utils/index.js (1089 行, 共享工具)     │
            └──────────────────────┬──────────────────────┘
                                   │
                ┌──────────────────┴──────────────────┐
                ▼                                     ▼
   ┌──────────────────────┐             ┌──────────────────────────┐
   │  GUI 后端 (Express)  │  proxy /api │  GUI 前端 (Vite + Vue)   │
   │  src/ui/server/      │ ◄──────────►│  src/ui/client/src/      │
   │  入口 index.js(420)  │             │  入口 main.ts + App.vue  │
   │  routes/ (12 文件)   │             │  views/ (3 顶层视图)     │
   │  socket/             │             │  components/ (50+ 组件)  │
   │  utils/              │             │  stores/ (6 个 pinia)    │
   └──────────────────────┘             │  lang/ (zh + en, 4k+ 行) │
                                        └──────────────────────────┘
```

**端口分工**（规则见 `.claude/rules/preview-launch.md`）：
- `5544` → Vite dev server（HMR，preview 工具只问这个端口）
- `5545` → Express 后端（写到根目录 `.port`，vite.config 读它做 proxy target）

---

## 4. 完整目录树（去除 `node_modules`、`.git`、图标 SVG）

```
zen-gitsync/                                    [根: 配置文件 + 顶层脚本]
├── package.json            # npm 主入口,bin: g → src/gitCommit.js
├── index.js                # 启动 UI server 的 ESM 包装(导出 startServer)
├── server.js               # 直接 node 启动 UI server 的 CLI 入口
├── pnpm-lock.yaml
├── .gitignore .npmignore .npmrc .port .gitattributes
├── LICENSE                  # Apache-2.0
├── README.md                # 用户文档(英 + 中)
├── PRODUCT.md               # 产品定位
├── CHANGELOG.md             # 版本变更
├── 源码笔记.md               # 中文源码结构笔记
├── MIGRATION_ICON_BUTTON.md
├── SVG_ICON_SETUP.md
├── docs/                    # [文档目录]
│   ├── OPTIMIZATION-PLAN.md
│   ├── UI-OVERVIEW.md
│   ├── UX-AUDIT.md
│   ├── screenshots/         # 26 张 UI 截图
│   └── PROJECT_MAP.md       # ← 本文件
├── scripts/                 # [运维脚本]
│   ├── release.js           # 发版(必走)
│   ├── dev-ping.cjs         # dev server 探测
│   ├── verify-file-search.mjs
│   ├── verify-subtask-row.mjs
│   ├── convert-*-to-vars.cjs # 4 个颜色/字号/间距 → CSS vars 转换器
│   └── README_*.md          # 转换器用法
├── src/                     # [核心: 三段式主体]
│   ├── gitCommit.js         # CLI 主控(455 行)
│   ├── config.js            # 用户配置 ~/.git-commit-tool.json(350 行)
│   ├── utils/index.js       # 共享工具 1089 行 + parseCwdArg.test.js
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
│       │       ├── App.vue                # 根组件 (1899 行, 包含全局 UI shell)
│       │       ├── views/
│       │       │   ├── EditorView.vue     # Monaco 编辑器视图 (1999 行)
│       │       │   ├── SourceMapView.vue  # @vue-flow 流程编排 (1808 行)
│       │       │   ├── WorkbenchView.vue  # 工作台 (4579 行, **最大**)
│       │       │   └── components/        # 视图级子组件
│       │       │       ├── GitStatus.vue        (2557 行)
│       │       │       ├── LogList.vue          (2140 行)
│       │       │       ├── CommitForm.vue       (1218 行)
│       │       │       └── CommandHistory.vue   (1142 行)
│       │       ├── components/           # 50+ 通用组件
│       │       │   ├── CommandConsole.vue    (4034 行, **第二大**)
│       │       │   ├── FileDiffViewer.vue    (2288 行)
│       │       │   ├── GitGlobalSettingsDialog.vue (1553 行)
│       │       │   ├── AISplitChatPane.vue / AISplitDialog.vue / AISplitDirectPane.vue
│       │       │   ├── ActivityBar.vue / AppErrorBanner.vue / AppVersionBadge.vue
│       │       │   ├── AttachmentZone.vue / BranchSelector.vue
│       │       │   ├── CommandConsole.vue / CommonDialog.vue
│       │       │   ├── CustomCommandManager.vue (1233 行)
│       │       │   ├── CustomCommandsPanel.vue / DirectorySelector.vue (998 行)
│       │       │   ├── ExecutionLogManager.vue
│       │       │   ├── FileActionButtons.vue / FileGroup.vue / FileTreeView.vue
│       │       │   ├── GitActionButtons.vue / GitCommandPreview.vue
│       │       │   ├── GlobalLoading.vue / IconButton.vue
│       │       │   ├── ImagePreview.vue / InstanceSwitcher.vue
│       │       │   ├── JobLogDetails.vue (813 行)
│       │       │   ├── MarkdownPreview.vue / MindmapPreview.vue
│       │       │   ├── MonacoDiffViewer.vue / MonacoEditor.vue (821 行)
│       │       │   ├── NpmScriptsPanel.vue / NpmSettingsDialog.vue
│       │       │   ├── PackageJsonSelector.vue / ProjectStartupButton.vue
│       │       │   ├── ProjectStartupDialog.vue / PushProgressModal.vue (857 行)
│       │       │   ├── RemoteRepoCard.vue / SuccessModal.vue
│       │       │   ├── SvgIcon/index.vue + index.ts
│       │       │   ├── TemplateManager.vue / TreeNodeItem.vue
│       │       │   ├── UpgradeDialog.vue
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
│       │       ├── stores/        # Pinia stores
│       │       │   ├── configStore.ts       # 全局配置
│       │       │   ├── editorTabs.ts        # 编辑器 tab 状态
│       │       │   ├── gitStore.ts          # Git 操作 + 状态
│       │       │   ├── instancesStore.ts    # 多实例(g ui 进程)管理
│       │       │   ├── localeStore.ts       # i18n
│       │       │   └── workbenchStatus.ts   # 工作台状态
│       │       ├── lang/
│       │       │   ├── zh/index.js (2043 行) + index.d.ts
│       │       │   ├── en/index.js (2034 行) + index.d.ts
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
│       │       │   ├── jobStatus.ts / path.ts
│       │       │   ├── materialFileIcons.ts + material-*.json / materialFallbackMap.json / materialCloneAliases.json
│       │       │   └── index.ts
│       │       ├── assets/icons/material/  # 1196 个 material 风格 svg 图标
│       │       └── vite-env.d.ts
│       ├── public/                # [构建产物] vite build 输出到此
│       │   ├── index.html
│       │   ├── favicon.svg / logo.svg / vite.svg
│       │   └── assets/
│       └── server/                # [核心: GUI 后端 Express]
│           ├── index.js           # 入口(420 行,startUIServer)
│           ├── middleware/requestLogger.js
│           ├── routes/            # 12 个 REST 路由注册器(行数 = 2026-06-26 cloc)
│           │   ├── workbench.js        (3410 行, **最大**,已 +198 行)
│           │   ├── config.js           (1210 行)
│           │   ├── npm.js              (1356 行,已 +153 行)
│           │   ├── gitOps.js           (1145 行,已 -34 行)
│           │   ├── codeAnalysis.js     (995 行)
│           │   ├── fs.js               (701 行)
│           │   ├── git.js              (179 行) + git/
│           │   │   ├── stash.js        (552 行)
│           │   │   ├── diff.js         (352 行) + diffUtils.js (128 行)
│           │   │   └── tags.js         (172 行)
│           │   ├── terminal.js         (318 行)
│           │   ├── fileOpen.js         (279 行)
│           │   ├── exec.js             (279 行,已 +6 行)
│           │   ├── code.js             (110 行, **code 节点 RCE 入口,审计 SEC-RCE-1 标记**)
│           │   ├── branchStatus.js     (101 行)
│           │   ├── process.js          (82 行)
│           │   ├── status.js           (66 行)
│           │   └── instances.js        (38 行)
│           ├── socket/
│           │   └── registerUiSocketHandlers.js (226 行)
│           └── utils/
│               ├── instanceRegistry.js (270 行, 跨进程 GUI 注册表)
│               ├── pathGuard.js (155) + pathGuard.test.js (138)
│               ├── shellQuote.js (67) + shellQuote.test.js (109)
│               ├── startServerOnAvailablePort.js (101)
│               ├── randomStartPort.js (51)
│               └── createSavePortToFile.js (46)
├── test/                     # [次要: 测试 + 历史遗留样本]
│   ├── diff-prompt.test.mjs  # 真实 vitest/jest 风格测试(11k)
│   ├── server-regression.test.mjs
│   ├── ts-demo.test.ts
│   ├── demo-realistic.mjs
│   ├── dialog-test.txt / locked-test.txt / test-merge.txt
│   ├── flex-layout-test.html / grid-expand-collapse.html / vertical-flex-layout-test.html  # 历史调试页
│   ├── test111/ / test222/ / teststash/ / 不同类型文件测试/  # 真实仓库测试样本
│   └── 测试一个很长很长很长的文件名.md  # 中文边界测试
├── e2e/                     # 实际是 src/ui/client/e2e/ 的镜像
├── public/images/           # 顶层 public(几乎没用,主要是 src/ui/public/)
├── .claude/                 # Claude 会话规范
│   ├── launch.json          # preview 工具双 server 配置(zen-backend + zen-vite)
│   ├── settings.local.json
│   ├── rules/               # hmr-debug-check / i18n-check / preview-launch /
│   │                        # syntax-check / tsc-check / README.md
│   ├── skills/              # 17 个 skill(本会话加载入口)
│   └── verify/              # 验证截图产物
├── .agents/ .codebuddy/ .iflow/ .trae/ .windsurf/ .workbuddy/  # 其它 AI 工具配置镜像
├── .shared/                # 跨 AI 工具共享 skill(ui-ux-pro-max)
├── skills/                  # 历史 skill 备份(已迁移到 .claude/skills/)
├── skills-lock.json
├── verify-mindmap.mjs / verify-rich.mjs / verify-sourcemap-theme.mjs  # 一次性验证脚本
└── test-*.png / verify-*.png  # 调试截图(基本不再用)
```

---

## 5. 关键文件速查表

| 类别 | 文件 | 行数 | 作用 |
|------|------|------|------|
| **CLI 入口** | `src/gitCommit.js` | 455 | `g` 命令主控,支持 ui/log/addScript/get-config 等子命令 |
| **CLI 配置** | `src/config.js` | 350 | 读写 `~/.git-commit-tool.json`,包含代理、最近目录、locale |
| **共享工具** | `src/utils/index.js` | 1089 | execGitCommand / 端口选择 / git lock 处理等 |
| **GUI 后端入口** | `src/ui/server/index.js` | 420 | 启 Express + Socket.IO + 注册所有路由/中间件 |
| **GUI 前端入口** | `src/ui/client/src/main.ts` | 36 | Vue app 启动,挂 Pinia + i18n + SvgIcon |
| **Vite 配置** | `src/ui/client/vite.config.ts` | 167 | strictPort=5544 / proxy / 7 个 manualChunks |
| **i18n 入口** | `src/ui/client/src/locales/index.ts` | 78 | createI18n + setLocale/getLocale |
| **Playwright** | `src/ui/client/playwright.config.ts` | 71 | baseURL=http://localhost:5544 |
| **TS 配置** | `src/ui/client/tsconfig.app.json` | 23 | strict + paths + 7 个 alias |
| **dev:ping** | `scripts/dev-ping.cjs` | 67 | 探测 vite + backend 双 server |
| **发版** | `scripts/release.js` | ~600 | 必走发版链路(详见 MEMORY) |
| **根 README** | `README.md` | 38k | 用户文档(中英双语) |
| **变更日志** | `CHANGELOG.md` | 12k | 版本变更 |

---

## 6. 代码统计(2026-06-26 cloc 重算)

| 模块 | 文件数 | 行数 |
|------|------|------|
| **前端 .vue 总计** | 110+ | **~54,000**(已合并 composable 与 component 分拆后的实际值) |
| └ WorkbenchView.vue | 1 | **3,508**(已拆为多个 composable 与子组件,2026-06 ef80c2f 起) |
| └ CommandConsole.vue | 1 | **4,019**(本轮 i18n 收敛 -14 行,但 + 部分原始脚本) |
| └ views/components/GitStatus.vue | 1 | 2,557 |
| └ FileDiffViewer.vue | 1 | 2,288 |
| └ LogList.vue | 1 | 2,140 |
| └ flow/NodeConfigPanel.vue | 1 | 2,087 |
| └ EditorView.vue | 1 | 1,999 |
| └ App.vue | 1 | 1,899 |
| **前端 .ts/.tsx** | 24 | **~6,000**(新增 `composables/useThemeObserver.ts` 87 行) |
| **GUI 后端 .js** | 31 | **~13,200** |
| └ routes/workbench.js | 1 | **3,410** |
| └ routes/config.js | 1 | **1,210** |
| └ routes/npm.js | 1 | **1,356** |
| └ routes/gitOps.js | 1 | **1,145** |
| └ routes/code.js | 1 | **110**(审计 SEC-RCE-1 高危) |
| **CLI 顶层 .js** | 7 | **~2,800**(新增 `cli/cleanup.js` / `cli/customCommand.js` / `cli/ui.js`) |
| └ src/utils/index.js | 1 | **1,133** |
| └ src/config.js | 1 | **408** |
| └ src/gitCommit.js | 1 | **446** |
| **i18n zh + en** | 2 | **~4,200**(本轮 +28 条 key) |
| **test/ 新增** | 3 | ~580(`config.atomic-write` / `exec-git-injection` / `socket-handlers`) |
| **总计核心代码** | ~180 | **~80,500** |

> 1196 个图标 SVG 占 `src/ui/client/src/assets/icons/material/` 大量体积但非业务代码。
>
> **行数变更溯源**(自 2026-06-19 审计时点起):
> - `routes/workbench.js` 3212 → 3410(+198,新增 chat UI 集成)
> - `routes/npm.js` 1203 → 1356(+153)
> - `routes/gitOps.js` 1179 → 1145(-34,部分方法抽出)
> - `routes/exec.js` 273 → 279(+6,SEC-INJ-3 命名清晰化)
> - `WorkbenchView.vue` 4579 → 3508(-1071,ef80c2f 拆 composable 与子组件)
> - 新增 `cli/cleanup.js` + `customCommand.js` + `ui.js`(f012bb4)

---

## 7. 核心 vs 次要 vs 忽略 三档分类（决定后续子任务阅读优先级）

### 🟢 核心 CORE（必读，几乎所有功能改动都涉及）

| 路径 | 说明 | 优先级 |
|------|------|--------|
| `src/gitCommit.js` | CLI 主控 | P0 |
| `src/config.js` | 用户配置 | P0 |
| `src/utils/index.js` | 共享工具(被前后端都用) | P0 |
| `src/ui/server/index.js` | GUI 后端入口,所有路由注册中心 | P0 |
| `src/ui/client/src/main.ts` + `App.vue` | 前端启动 + 全局 shell | P0 |
| `src/ui/client/src/views/WorkbenchView.vue` | **最大业务视图**,工作台 | P0 |
| `src/ui/client/src/components/CommandConsole.vue` | 命令控制台(第二大) | P0 |
| `src/ui/client/src/views/components/GitStatus.vue` | Git 状态视图 | P0 |
| `src/ui/client/src/stores/*.ts` (6 个) | 全部 Pinia store | P0 |
| `src/ui/client/src/lang/zh/index.js` + `en/index.js` | **i18n 改动必须同步** | P0 |
| `src/ui/client/src/locales/index.ts` | i18n 运行时 | P0 |
| `src/ui/client/vite.config.ts` | 构建/端口/proxy | P0 |
| `.claude/rules/` (6 个 md) | 项目强制规则 | P0 |
| `src/ui/server/routes/` (按需进入) | 后端 API 路由 | P1 |

### 🟡 次要 SECONDARY（功能相关时才需要看）

| 路径 | 说明 | 触发条件 |
|------|------|---------|
| `src/ui/client/src/views/EditorView.vue` | Monaco 编辑视图 | 改编辑器/Monaco 相关 |
| `src/ui/client/src/views/SourceMapView.vue` | vue-flow 流程编排 | 改工作流编排 |
| `src/ui/client/src/components/flow/` (12 文件) | 工作流节点系统 | 改节点类型/编排 |
| `src/ui/client/src/components/buttons/` (16 文件) | 原子按钮 | 改单一 git 操作 |
| `src/ui/client/src/components/JobLogDetails.vue` / `AISplit*` | 工作台子组件 | 改任务日志/AI 分屏 |
| `src/ui/client/src/types/` (7 文件) | 类型声明 | 加新依赖/类型 |
| `src/ui/client/src/composables/` (5 文件) | composables | 加新 composable |
| `src/ui/client/src/utils/` (10+ 文件) | 前端工具 | 加新工具 |
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
| `.agents/` `.codebuddy/` `.iflow/` `.trae/` `.windsurf/` `.workbuddy/` | 其它 AI 工具配置镜像(已合并到 `.claude/`) |
| `.shared/` | 跨 AI 共享 skill 库(由 `.claude/skills/` 引用) |
| `skills/` | **历史 skill 备份**,已迁移到 `.claude/skills/`(`.gitignore` 已例外保留但不再维护) |
| `public/images/` | 顶层 public,几乎空目录 |
| `verify-*.png` `test-*.png` `test-rich-demo.png` | 历史调试截图(单次使用) |
| `test/test111/` `test222/` `teststash/` `不同类型文件测试/` | Git 仓库测试样本(真实仓库) |
| `src/ui/client/src/assets/icons/material/` (1196 个 SVG) | 第三方图标集,按需引用,无需阅读 |
| `verify-mindmap.mjs` `verify-rich.mjs` `verify-sourcemap-theme.mjs` | 一次性验证脚本 |
| `src/ui/client/auto-imports.d.ts` `components.d.ts` | unplugin 自动生成,**不要手改** |
| `src/ui/client/.claude/codediff.txt` | Claude Code post_tool_hook 产物 |
| `src/ui/client/_shot.mjs` `stats.html` | 单次截图脚本/bundle 可视化产物 |
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

### 改工作流编排 (Workbench)
1. `views/WorkbenchView.vue` (主壳)
2. `components/flow/FlowOrchestrationWorkspace.vue` (画布)
3. `components/flow/NodeConfigPanel.vue` (节点配置)
4. `components/flow/nodes/` 节点类型
5. `routes/workbench.js` (后端执行引擎)

### 国际化 (i18n)
1. `src/ui/client/src/lang/zh/index.js` 加 key
2. `src/ui/client/src/lang/en/index.js` 加翻译
3. 命名空间复用文件内已有前缀(规则见 `i18n-check.md`)

### 发版
1. `MEMORY.md` → `feedback_release_must_use_npm_run_release.md`(强制 `npm run release`)
2. `scripts/release.js`(build + push + npm publish 完整链路)

---

## 9. 注意事项 & 已知约束

- **远程仓库迁移**：本地指向 `xz333221/zen-git`(不带 s),实际 GitHub 仓库已迁到 `xz333221/zen-gitsync`。push 会收到重定向警告(见 MEMORY)。
- **HMR 链路陷阱**：所有"前端改了不生效"先按 `.claude/rules/hmr-debug-check.md` 规则 0 排查。
- **i18n 硬约束**：任何新中文字符串必须 `$t()` 包裹 + 双语文件同步。
- **三档改动流程**：代码改完必须走 auto-validate → auto-preview-verify(前端) → auto-update-readme(功能) → auto-commit(详见 `.claude/rules/README.md`)。
- **workbench 子目录最近修改最多**：从 mtime 看，本仓库最近的开发重点在 workbench 子系统(`WorkbenchView.vue` / `JobLogDetails.vue` / `CommitForm.vue` / `GlobalLoading.vue` / `LogList.vue`)。
- **前端组件大文件普遍存在**：单文件超过 2000 行的有 7 个，编辑时优先看是否已有同主题的更小文件可拆分。
