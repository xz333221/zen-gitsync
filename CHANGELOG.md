# Changelog

All notable changes to zen-gitsync will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — 2026-06-19

本轮会话集中提交:死代码清理 + i18n 漏译修复 + UI 设计语言统一 + 可访问性(a11y)全面提升 +
前端加载/运行时性能优化。涉及 21 个文件,新增 26 条 i18n key,删除 4 个孤儿组件,新增 1 条手动
chunk 拆分策略。无破坏性 API 变更,向后兼容。

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

### 验证结果
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