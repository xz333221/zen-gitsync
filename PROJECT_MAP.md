# zen-git 项目地图

> 适用版本: `zen-gitsync v2.13.19`
> 勘察日期: 2026-06-21
> 目的: 给后续所有子任务(阅读、改动、验证)提供"先看哪里、可以不看哪里"的优先级指引

---

## 1. 仓库性质: **单包 + 内嵌子项目**(伪 monorepo)

不是标准 pnpm/lerna/nx/turbo monorepo —— 没有 `pnpm-workspace.yaml` / `lerna.json` / `nx.json` / `turbo.json`。

但**结构上等价于 monorepo**:
- 根 `package.json`(`zen-gitsync` CLI 工具)负责 npm 发布 / 全局 `g` 命令
- `src/ui/client/` 自带**独立** `package.json`(Vue 3 + TS 前端子项目)
- 后端代码在 `src/ui/server/`(Node.js Express + Socket.IO),没有独立 package.json,共用根 node_modules

**运行端口分工**(强约束,`.claude/rules/preview-launch.md`):
| 端口 | 角色 | 启动入口 |
|------|------|---------|
| 5544 | vite dev server (HMR) | `npm run dev:vue` |
| 5545 | backend Express + Socket.IO | `npm run dev:server` |
| 后端真实端口 | 写入根目录 `.port` 文件,vite 读它做 proxy | backend 启动时落盘 |

---

## 2. 总规模统计(2026-06-21 快照)

| 子系统 | 类别 | 文件数 | 行数 | 平均行/文件 |
|--------|------|--------|------|-------------|
| **后端** | `src/ui/server/index.js` | 1 | 420 | 420 |
| | `src/ui/server/middleware/*.js` | 1 | 51 | 51 |
| | `src/ui/server/socket/*.js` | 1 | 226 | 226 |
| | `src/ui/server/routes/*.js` | 15 | 9 954 | 664 |
| | `src/ui/server/utils/*.js` | 7 | 690 | 99 |
| | `src/ui/server/utils/*.test.js` | 2 | 247 | 124 |
| | `src/utils/index.js` | 1 | 1 089 | 1 089 |
| | `src/utils/*.test.js` | 1 | 85 | 85 |
| | **后端小计** | **29** | **12 762** | 440 |
| **前端** | `src/ui/client/src/**/*.vue` | 85 | 53 629 | 631 |
| | `src/ui/client/src/**/*.ts`(非 d.ts) | 29 | 5 716 | 197 |
| | `src/ui/client/src/styles/*.{scss,css}` | 7 | 4 340 | 620 |
| | i18n `lang/zh/index.js` | 1 | 2 043 | — |
| | i18n `lang/en/index.js` | 1 | 2 034 | — |
| | **前端小计(代码)** | **121** | **63 685** | 526 |
| | **前端小计(含 i18n)** | **123** | **67 762** | 551 |
| | **全仓代码总计** | **152** | **80 524** | 530 |

> 统计口径:排除 `node_modules/`、`.git/`、`src/ui/public/assets/*`(vite build 产物)、`test/` 内的 git 测试夹具文件、`.claude/skills/`、`.agents/`、`.codebuddy/`、`.iflow/`、`.trae/`、`.windsurf/`、`.workbuddy/`、`.shared/` 等 IDE/agent 配置目录。

---

## 3. 完整目录树(精选,3 层深度)

```
zen-git/
├── package.json              ← 根:zen-gitsync v2.13.19,bin="g",type=module
├── index.js                  ← 根入口:re-export config + startServer
├── server.js                 ← 后端专用启动器(npm start:server 走这里)
├── .port                     ← 当前 backend 端口(5545)
├── .claude/
│   ├── launch.json           ← preview 工具双 server 配置(zen-vite 5544 + zen-backend 5545)
│   ├── rules/                ← 项目强约束规则(hmr-debug / i18n / preview-launch / tsc / syntax)
│   ├── skills/               ← 仓库专属 skill(15 个,见 §7)
│   ├── verify/               ← 临时验证产物
│   └── settings.local.json
│
├── index.js / server.js      ← 顶层入口(见上)
│
├── src/
│   ├── gitCommit.js          ← CLI 主程序(455 行,bin `g`,被 `npm run g*` 全部调用)
│   ├── config.js             ← 默认配置 + ~/.git-commit-tool.json 读写(350 行)
│   ├── utils/index.js        ← 后端通用工具(1089 行,被 server/index.js 全量 import)
│   ├── utils/parseCwdArg.test.js
│   │
│   └── ui/
│       ├── client/           ← 【核心前端】Vue 3 + TS + Vite 子项目
│       │   ├── package.json          ← name=client,private,Vite + Vue + Element Plus + Pinia
│       │   ├── vite.config.ts        ← strictPort=true,port 5544,读 .port 配 proxy
│       │   ├── tsconfig.json/app.json/node.json
│       │   ├── playwright.config.ts  ← e2e 测试配置
│       │   ├── index.html            ← SPA 入口 HTML
│       │   ├── e2e/                  ← 4 个 Playwright spec(目录选择器、抽屉、风格、阶段)
│       │   ├── i18n.config.cjs       ← vue-i18n 配置
│       │   ├── public/               ← vite 静态资源
│       │   ├── vite-plugins/svg-icon.ts ← 自定义 vite 插件
│       │   ├── verify/               ← 验证脚本(audit-real.mjs / sync-upstream-icons.mjs)
│       │   └── src/                  ← 见 §4 详细结构
│       │
│       ├── server/           ← 【核心后端】Express + Socket.IO
│       │   ├── index.js              ← bootstrap(420 行,装配全部 route + socket)
│       │   ├── middleware/requestLogger.js
│       │   ├── socket/registerUiSocketHandlers.js (226 行)
│       │   ├── routes/               ← 15 个路由模块(见 §5)
│       │   └── utils/                ← 9 个工具(含 2 个 test)
│       │
│       └── public/           ← vite build 产物(git ignore 候选),已有 ~70 个 hashed JS/CSS
│
├── scripts/                  ← 构建/转换/发布/验证脚本(见 §6)
├── docs/                     ← 内部技术文档(UI-OVERVIEW / UX-AUDIT / OPTIMIZATION-PLAN)
├── test/                     ← 杂项验证 + git 测试夹具(混入长中文文件名)
│   ├── demo-realistic.mjs
│   ├── diff-prompt.test.mjs
│   ├── server-regression.test.mjs
│   ├── ts-demo.test.ts
│   ├── test111/, test222/, teststash/, test一个很长很长.../, 不同类型文件测试/
│
├── public/images/            ← 静态资源(根级,服务 vite 之前)
├── skills/                   ← 历史备份 skills(.claude/skills 是当前唯一权威)
│
└── docs/screenshots/         ← 视觉验证截图存证目录
```

---

## 4. 前端核心结构 `src/ui/client/src/`(85 .vue + 29 .ts + 7 样式)

```
src/ui/client/src/
├── main.ts                   ← SPA 入口(createApp + Pinia + i18n + 全局样式)
├── App.vue                   ← 根组件(异步加载 11 个首屏面板,见下)
├── main.css                  ← 全局基础重置 + 变量
│
├── views/                    ← 【核心】路由级别大视图,文件最大、最重
│   ├── EditorView.vue        ← 1999 行,Monaco 编辑器主视图
│   ├── SourceMapView.vue     ← 1808 行,源码地图视图
│   ├── WorkbenchView.vue     ← 4579 行 ⭐ 全仓最大单文件,工作台编排器
│   └── components/           ← 6 个常驻首屏面板
│       ├── GitStatus.vue          (2557 行)
│       ├── LogList.vue            (2140 行)
│       ├── CommitForm.vue         (1218 行)
│       └── CommandHistory.vue     (1142 行)
│
├── components/               ← 【核心】60+ 可复用 UI 组件
│   ├── buttons/              ← 17 个按钮型组件(CommitButton/PushButton/StageButton 等)
│   ├── flow/                 ← 流程编排器(节点 + 配置面板)
│   │   ├── nodes/            ← 10 种节点:Base/Code/Command/Condition/Confirm/Start/UserInput/Version/Wait + NodeContextMenu
│   │   ├── NodeConfigPanel.vue       (2087 行)
│   │   ├── FlowOrchestrationWorkspace.vue (1423 行)
│   │   └── FlowExecutionViewer.vue
│   ├── icons/                ← ListIcon / TreeIcon
│   ├── SvgIcon/              ← 全局 SVG 图标组件
│   ├── ActivityBar.vue       ← 左侧活动栏
│   ├── AppErrorBanner.vue    ← 全局错误条
│   ├── AppVersionBadge.vue   ← 版本徽章
│   ├── AISplitChatPane/Dialog/DirectPane ← AI 拆分对话相关
│   ├── BranchSelector.vue
│   ├── CommandConsole.vue    ← 4034 行 ⭐,命令控制台
│   ├── CommonDialog.vue      ← 通用对话框
│   ├── CustomCommandManager / CustomCommandsPanel
│   ├── DirectorySelector.vue ← 998 行
│   ├── ExecutionLogManager.vue
│   ├── FileActionButtons / FileDiffViewer(2288) / FileGroup / FileTreeView
│   ├── GitActionButtons / GitCommandPreview / GitGlobalSettingsDialog(1553)
│   ├── GlobalLoading
│   ├── IconButton            ← 见根 MIGRATION_ICON_BUTTON.md
│   ├── ImagePreview / InstanceSwitcher / JobLogDetails
│   ├── MarkdownPreview / MindmapPreview
│   ├── MonacoDiffViewer / MonacoEditor(821)
│   ├── NpmScriptsPanel / NpmSettingsDialog(818)
│   ├── PackageJsonSelector / ProjectStartupButton / ProjectStartupDialog
│   ├── PushProgressModal(857)
│   ├── RemoteRepoCard
│   ├── SuccessModal
│   ├── TemplateManager
│   ├── TreeNodeItem
│   └── UpgradeDialog
│
├── stores/                   ← Pinia 状态管理(6 个 store)
│   ├── gitStore.ts           ← 核心 Git 状态(staged/unstaged/branch/...)
│   ├── configStore.ts        ← 配置读写
│   ├── instancesStore.ts     ← 多实例切换
│   ├── localeStore.ts        ← 语言切换
│   ├── editorTabs.ts         ← 编辑器标签页
│   └── workbenchStatus.ts    ← 工作台状态
│
├── utils/                    ← 前端工具(11 个文件)
│   ├── path.ts               ← 路径处理(被全仓引用)
│   ├── fileTree.ts / fileIcon.ts / fileKind.ts ← 文件树 + 图标
│   ├── commandParser.ts      ← 命令解析
│   ├── editorLang.ts
│   ├── jobStatus.ts
│   ├── materialFileIcons.ts  ← material-icons.json + materialFallbackMap.json + materialCloneAliases.json
│   ├── appVersion.ts
│   └── index.ts              ← barrel
│
├── composables/              ← 组合式函数(5 个)
│   ├── useAnsiToHtml.ts
│   ├── useGlobalLoading.ts
│   ├── useNetworkStatus.ts
│   ├── useSuccessModal.ts
│   └── useTerminalSessions.ts
│
├── lang/                     ← 【重要】i18n 翻译
│   ├── static.ts             ← 类型导出
│   ├── static.d.ts
│   ├── zh/index.js  (2043 行,中文翻译源)
│   └── en/index.js  (2034 行,英文翻译)
│
├── locales/index.ts          ← vue-i18n 配置
├── plugins/elementPlus.ts
├── types/                    ← TS 类型定义(conflict / instances / workbench)
├── styles/                   ← SCSS/CSS
│   ├── tailwindcss.css / common.scss / dark-theme.scss
│   ├── unified-dialogs.scss / workbench.scss
│   └── markdown-renderer.css
└── assets/
    ├── icons/material/       ← ~700 个 material 图标 SVG(由 sync-upstream-icons.mjs 同步)
    ├── icons/svg/            ← 项目自定义 SVG 图标
    └── logo.svg
```

**前端阅读优先级**(决定哪些先看):
1. `main.ts` + `App.vue` —— SPA 启动 / 路由
2. `views/WorkbenchView.vue` (4579 行) —— 工作台是最近几个大版本的迭代重心
3. `views/components/GitStatus.vue` / `LogList.vue` / `CommitForm.vue` —— 首屏三件套
4. `stores/gitStore.ts` —— 全部 Git 操作的中心
5. `components/flow/` —— 流程编排器的节点与连线
6. `lang/zh/index.js` —— 新增中文文本必加项

---

## 5. 后端核心结构 `src/ui/server/`(420 + 51 + 226 + 9954 + 937 ≈ 11 588 行)

```
src/ui/server/
├── index.js                  ← 420 行,bootstrap Express + Socket.IO + 全部路由 + 全部 socket
├── middleware/
│   └── requestLogger.js      ← 51 行,简易请求日志
├── socket/
│   └── registerUiSocketHandlers.js  ← 226 行,UI 侧 socket 事件
├── routes/                   ← 15 个路由模块,按行数排序:
│   ├── workbench.js          ⭐ 3212 行,工作台后端(子任务执行、日志、流式推送)
│   ├── gitOps.js            ⭐ 1179 行,Git 高阶操作(merge/rebase/cherry-pick 等)
│   ├── npm.js               ⭐ 1203 行,npm 脚本执行 + 进度推送
│   ├── config.js            ⭐ 1207 行,~/.git-commit-tool.json 读写 + 大量配置项
│   ├── codeAnalysis.js      ⭐ 995 行,代码分析
│   ├── fs.js                ⭐ 701 行,文件系统操作
│   ├── terminal.js          318 行,终端会话
│   ├── fileOpen.js          279 行
│   ├── exec.js              273 行,通用命令执行
│   ├── git.js               190 行,基础 Git 命令
│   ├── code.js              110 行
│   ├── branchStatus.js      101 行
│   ├── process.js           82 行
│   ├── status.js            66 行
│   └── instances.js         38 行
└── utils/                    ← 9 个工具(含 2 个单测)
    ├── instanceRegistry.js           270 行 ⭐,多实例注册表
    ├── pathGuard.js                 155 行,路径越权防护(沙箱)
    ├── pathGuard.test.js            138 行
    ├── shellQuote.js                67 行
    ├── shellQuote.test.js           109 行
    ├── startServerOnAvailablePort.js 101 行
    ├── createSavePortToFile.js       46 行
    ├── randomStartPort.js            51 行
    └── (9 个 .js,共 937 行)
```

**配套:** `src/utils/index.js` (1089 行) —— 真正通用的 Git/fs/exec 工具集,**被 server/index.js 全量 import**,很多同名函数在 routes/ 也有封装层。

**后端阅读优先级:**
1. `src/ui/server/index.js` —— 知道所有路由如何装配
2. `src/utils/index.js` —— 知道 execGitCommand / registerSocketIO 这些核心工具在哪
3. `routes/workbench.js` (3212) —— 工作台是当前最重、最近改的最频繁的后端模块
4. `routes/gitOps.js` (1179) + `routes/config.js` (1207) —— Git 高阶操作与配置持久化
5. `utils/instanceRegistry.js` (270) —— 多实例切换的实现

---

## 6. 关键入口 / 配置文件清单

| 类型 | 路径 | 作用 |
|------|------|------|
| **CLI 入口** | `src/gitCommit.js` (455 行) | `npm run g*` 全部走这里,bin `g` |
| **后端启动** | `server.js` (47 行) | `npm run start:server` 专用,等价于 `npm run dev:server` |
| **库入口** | `index.js` (33 行) | `npm publish` 时供外部引用,导出 `config` + `startServer` |
| **前端入口** | `src/ui/client/src/main.ts` | Vue app 启动 |
| **根组件** | `src/ui/client/src/App.vue` | SPA 路由 + 异步加载 11 个首屏面板 |
| **vite 配置** | `src/ui/client/vite.config.ts` | `strictPort: true`,5544,读 `.port` 配 proxy |
| **后端配置** | `src/config.js` (350 行) | 默认配置 + `~/.git-commit-tool.json` 读写 |
| **TS 配置** | `src/ui/client/{tsconfig,tsconfig.app,tsconfig.node}.json` | `@/*` `@components/*` 等路径别名 |
| **包元数据** | `package.json` (根) / `src/ui/client/package.json` | 根是发布包,client 是 private 子项目 |
| **preview** | `.claude/launch.json` | preview 工具配置双 server(zen-vite 5544 + zen-backend 5545) |
| **端口落盘** | `.port` | backend 启动时写入,被 vite.config.ts 读取 |
| **i18n 配置** | `src/ui/client/i18n.config.cjs` | vue-i18n |
| **e2e 配置** | `src/ui/client/playwright.config.ts` | Playwright |
| **release 脚本** | `scripts/release.js` (19953 字节) | `npm run release` 走完整发版流程(build + push + npm publish) |

---

## 7. 测试与验证目录

| 类型 | 路径 | 说明 |
|------|------|------|
| **单元测试(后端)** | `src/ui/server/utils/pathGuard.test.js` | 138 行,Node 内置 test runner |
| | `src/ui/server/utils/shellQuote.test.js` | 109 行 |
| | `src/utils/parseCwdArg.test.js` | 85 行 |
| **集成 / 回归测试** | `test/server-regression.test.mjs` | mjs 风格,无测试框架 |
| **测试夹具** | `test/test111/` `test/test222/` `test/teststash/` `test/不同类型文件测试/` `test/test一个很长很长...的文件夹/` | 用来测边界文件名、stash、merge、UI 测试 |
| **杂项 .mjs** | `test/demo-realistic.mjs` `test/diff-prompt.test.mjs` `test/ts-demo.test.ts` | 早期探索性脚本 |
| **E2E (Playwright)** | `src/ui/client/e2e/*.spec.ts` (4 个) | `directory-selector` / `drawer-real-ui` / `drawer-style-demo` / `selective-stage` |
| **前端验证脚本** | `scripts/verify-file-search.mjs` `verify-subtask-row.mjs` | 本地浏览器驱动验证(子任务行、文件搜索) |
| | `src/ui/client/verify-mindmap.mjs` `src/ui/client/verify/audit-real.mjs` `sync-upstream-icons.mjs` | 思维导图截图 / UI 审查 / material-icons 同步 |
| **skills(行为约束)** | `.claude/skills/` 15 个: | auto-capture-lessons / auto-commit / auto-preview-verify / auto-update-readme / auto-validate / dev-server-diagnostics / design-taste-frontend / full-output-enforcement / gpt-taste / high-end-visual-design / image-to-code / impeccable / industrial-brutalist-ui / minimalist-ui / redesign-existing-projects / stitch-design-taste / ui-ux-pro-max |
| **规则文档** | `.claude/rules/` 5 个: | hmr-debug-check / i18n-check / preview-launch / syntax-check / tsc-check + README 总纲 |

---

## 8. 文档目录

| 路径 | 性质 | 说明 |
|------|------|------|
| `README.md` (38223 字节) | 外部 | 英文 + 中文双章节,项目门面 |
| `PRODUCT.md` | 内部 | 产品定位 |
| `CHANGELOG.md` (11761 字节) | 外部 | 发布历史 |
| `LICENSE` (10888 字节) | 外部 | Apache-2.0 |
| `MIGRATION_ICON_BUTTON.md` | 内部 | IconButton 重构迁移说明 |
| `SVG_ICON_SETUP.md` | 内部 | SVG 图标体系说明 |
| `源码笔记.md` (61422 字节) ⭐ | 内部 | 当前最详尽的项目源码笔记(v2.13.18),**子任务阅读前先看这个** |
| `docs/UI-OVERVIEW.md` (25015) | 内部 | UI 全景图 |
| `docs/UX-AUDIT.md` (17502) | 内部 | UX 审查 |
| `docs/OPTIMIZATION-PLAN.md` (12743) | 内部 | 优化计划 |
| `docs/screenshots/{audit-pass2.md,audit-report.md}` | 内部 | 视觉验证截图清单 |
| `scripts/README_COLOR_CONVERTER.md` 等 4 篇 | 内部 | 颜色/字号/间距/样式变量转换脚本说明 |
| `test-mindmap.md` `verify-1-home.png` 等 7 个 | 临时 | 早期验证产物,可清理 |
| `src/ui/client/{README.md,stats.html}` | 内部 | 前端子项目 README + 构建统计 |
| `src/ui/client/e2e/README.md` | 内部 | e2e 使用说明 |

---

## 9. 核心 vs 次要目录分级(决定后续阅读优先级)

### 🟢 核心(改动 / 阅读时必须看)

| 目录 | 理由 |
|------|------|
| `src/gitCommit.js` `src/config.js` `index.js` `server.js` | CLI + 后端启动入口,改动任何业务都要触碰 |
| `src/ui/server/index.js` | 所有路由的装配点 |
| `src/ui/server/routes/workbench.js` (3212 行) | 当前迭代重心,改 UI 工作台必读 |
| `src/ui/server/routes/gitOps.js` `config.js` `npm.js` `fs.js` | 高频改动的后端业务 |
| `src/utils/index.js` | 后端通用工具,几乎被全栈引用 |
| `src/ui/client/src/views/WorkbenchView.vue` (4579 行) | 全仓最大单文件,最近多次迭代 |
| `src/ui/client/src/views/components/{GitStatus,LogList,CommitForm}.vue` | 首屏主面板,改 UI 必看 |
| `src/ui/client/src/App.vue` `main.ts` `vite.config.ts` | 前端入口 |
| `src/ui/client/src/stores/` (6 个 store) | 全部状态管理 |
| `src/ui/client/src/lang/{zh,en}/index.js` | i18n 必加项(规则见 `.claude/rules/i18n-check.md`) |
| `src/ui/client/src/components/flow/` | 流程编排器的节点 / 面板 |
| `package.json` `src/ui/client/package.json` `.claude/launch.json` | 配置核心 |
| `.claude/rules/*.md` | 改前端必读 hmr-debug-check + preview-launch;改任何代码必读 syntax/tsc/i18n-check |

### 🟡 次要(只在相关任务时看)

| 目录 | 理由 |
|------|------|
| `src/ui/server/utils/instanceRegistry.js` | 多实例切换,只在涉及多开时 |
| `src/ui/server/middleware/requestLogger.js` | 单文件 51 行,简单 |
| `src/ui/server/utils/{pathGuard,shellQuote}.js` + test | 路径/转义工具,改跨目录或 exec 时看 |
| `src/ui/client/src/components/buttons/` (17 个) | 拆得很细,改特定按钮时只看对应文件 |
| `src/ui/client/src/composables/` (5 个) | 用到再读 |
| `src/ui/client/src/utils/{fileTree,fileIcon,materialFileIcons}.ts` | 文件树与图标,改文件浏览器时看 |
| `src/ui/client/src/types/` | 纯类型,改对应业务时看 |
| `scripts/release.js` `scripts/dev-ping.cjs` | 发布 / 探测时看 |
| `test/` | 测试用例和夹具,跑回归时看 |
| `src/ui/client/e2e/` | Playwright e2e,跑 e2e 时看 |
| `src/ui/client/verify/` | 验证脚本,辅助视觉验证时用 |

### ⚪ 可忽略(历史 / 产物 / 临时)

| 目录 / 文件 | 理由 |
|------|------|
| `.agents/` `.codebuddy/` `.iflow/` `.trae/` `.windsurf/` `.workbuddy/` `.shared/` | 多 IDE/agent 配置备份,**当前权威是 `.claude/`**,这些是历史路径,不要改 |
| `skills/`(根) | 同上,历史 skill 备份 |
| `src/ui/public/assets/*` | vite build 产物(~70 个 hashed JS/CSS),`.gitignore` 候选,git 也没全 ignore,占用大量体积 |
| `src/ui/client/.claude/codediff.txt` (72 MB ⚠️) | 大型 diff 存证,不应进仓库 |
| `src/ui/client/stats.html` (1 MB) | rollup-plugin-visualizer 输出,构建产物 |
| `test-mindmap.md` `verify-1-home.png` 等 7 个根目录验证产物 | 早期一次性输出,可清理 |
| `node_modules/` `pnpm-lock.yaml` `package-lock.json` | 依赖管理,自动生成 |
| `docs/screenshots/*.png` | 历史截图存档 |

---

## 10. 命名 / 路径别名速查(前端)

`src/ui/client/tsconfig.app.json` 定义:

| 别名 | 解析到 |
|------|--------|
| `@/*` | `./src/*` |
| `@components/*` | `./src/components/*` |
| `@views/*` | `./src/views/*` |
| `@stores/*` | `./src/stores/*` |
| `@utils/*` | `./src/utils/*` |
| `@assets/*` | `./src/assets/*` |
| `@styles/*` | `./src/styles/*` |

> 注意:**`App.vue` 中两种引用风格混用** —— `@views/components/GitStatus.vue`(别名)和 `@/views/...`(通用别名)都有;`src/components/flow/...` 的内部引用则用 `@/components/flow/...`。改一处时两种风格都要搜。

---

## 11. 子任务快速定位指引(给后续任务用)

| 子任务类型 | 先看 |
|-----------|------|
| 改前端组件样式/逻辑 | 该 .vue 文件 + 同目录 store + `lang/{zh,en}/index.js` + `.claude/rules/{i18n-check,hmr-debug-check}.md` |
| 改后端某个 route | 对应 `src/ui/server/routes/*.js` + `src/utils/index.js`(看是否有同名底层函数)+ `src/ui/server/index.js`(确认是否需要注册) |
| 新增前端功能 | `App.vue`(路由)、`views/`(放主视图)、`components/`(放子组件)、`stores/`(状态)、`lang/`(中英文案) |
| 新增后端 API | `src/ui/server/routes/`(新文件)、`src/ui/server/index.js`(import + register)、`src/ui/server/utils/`(如需新工具) |
| 改 CLI 行为 | `src/gitCommit.js`、`src/config.js` |
| 发版 | `scripts/release.js` + `package.json#version` + `CHANGELOG.md` |
| 改 dev server 启动 | `.claude/launch.json`、`vite.config.ts`、`package.json` 的 `dev*` scripts、`.claude/rules/preview-launch.md` |
| 跑测试 | `src/ui/server/utils/*.test.js`(Node 内置 test runner)、`test/*.test.mjs`、`src/ui/client/e2e/*.spec.ts`(Playwright) |
| 视觉验证 | `scripts/verify-*.mjs`、`src/ui/client/verify-*.mjs`、`.claude/skills/auto-preview-verify/SKILL.md` |

---

## 12. 已知坑(影响后续子任务决策)

- **`src/ui/client/.claude/codediff.txt` 72 MB** —— 这个文件不应进 git,首次清理时机成熟时建议 `git rm` + 加 `.gitignore`
- **`src/ui/public/assets/*`** —— vite build 产物,应整体 ignore,目前散落在 git 里
- **多 IDE skills 备份目录** —— `.agents/ .codebuddy/ .iflow/ .trae/ .windsurf/ .workbuddy/ .shared/` 都是历史备份,**权威只在 `.claude/`**,不要在这些目录里新增 skill
- **`App.vue` 路径别名混用** —— `@views/components/...` 和 `@/views/...` 都存在,搜索时注意两种
- **端口 5544/5545 是 hard requirement** —— 改 launch.json / vite.config.ts / package.json dev scripts 时不要破坏这个分工,详见 `.claude/rules/preview-launch.md`
- **后端 `routes/workbench.js` 3212 行** —— 当前最大的后端文件,新功能优先考虑新增 route 而不是继续塞这个文件
- **i18n 改动强约束** —— 任何 .vue 模板 / .ts 字符串里的中文都必须同步加 `lang/zh/index.js` + `lang/en/index.js`,详见 `.claude/rules/i18n-check.md`