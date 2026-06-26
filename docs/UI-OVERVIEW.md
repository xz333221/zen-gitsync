# zen-git SPA UI 总览

> 截图归档 + 视觉规范。配套截图见 [`screenshots/`](./screenshots/)(2026-06-19 通过 Playwright 自动抓取,1440×900,chromium headless)。
>
> 数据基于 `src/ui/client/src/**` 当前 main 分支(2026-06-19),版本 v2.13.16。

---

## 一、目录

- [二、应用形态与顶层布局](#二应用形态与顶层布局)
- [三、截图清单](#三截图清单)
- [四、4 个主视图](#四4-个主视图)
  - [4.1 Git 视图(默认首屏)](#41-git-视图默认首屏)
  - [4.2 编辑器视图](#42-编辑器视图)
  - [4.3 源码地图视图](#43-源码地图视图)
  - [4.4 工作台视图](#44-工作台视图)
- [五、关键对话框与状态卡](#五关键对话框与状态卡)
- [六、设计规范](#六设计规范)
  - [6.1 配色](#61-配色)
  - [6.2 字体 / 字距 / 行高](#62-字体--字距--行高)
  - [6.3 间距 / 圆角 / 阴影](#63-间距--圆角--阴影)
  - [6.4 动效 / 过渡](#64-动效--过渡)
  - [6.5 主题与暗色模式](#65-主题与暗色模式)
- [七、可访问性 / 焦点 / 交互](#七可访问性--焦点--交互)
- [八、组件清单](#八组件清单)

---

## 二、应用形态与顶层布局

zen-git SPA 是 **VS Code 风格三段式布局**,固定视口,无路由切换(4 个 view 由 `activeView` ref 切换,`KeepAlive` 缓存实例):

```
┌──────────────────────────────────────────────────────────┐
│  Header  (64px)                                          │
│  ┌──────────┬──────────────────────────┬────────────────┐ │
│  │ Logo     │  DirectorySelector       │ 3实例│xuze ⚙ │ │
│  └──────────┴──────────────────────────┴────────────────┘ │
├──────┬───────────────────────────────────────────────────┤
│      │                                                   │
│ Act- │   <view-pane>  4 选 1 活动视图:                  │
│ ivi- │   ├─ git      4-面板 grid (默认)                │
│ ty   │   ├─ editor   文件树 + Monaco                    │
│ Bar  │   ├─ source-map  VueFlow 调用图                 │
│ 48px │   └─ workbench  任务列表 + 任务详情              │
│      │                                                   │
├──────┴───────────────────────────────────────────────────┤
│  Footer  (32px)                                          │
│  ⎇ main │ ↻ │ 🔗 git@github.com:... │ 默认模型 │ v2.13.16│
└──────────────────────────────────────────────────────────┘
```

- 顶部 `Header`:Logo + 中央目录选择器(`DirectorySelector` 顶置变体)+ 右侧实例切换器 + 用户名 + 设置齿轮。
- 左侧 `ActivityBar`:48px 宽,4 个图标按钮(每个对应一个 view),带未提交/未保存徽标。
- 主体 `view-pane`:在 4 个视图间切换,`git` 视图内部是 **3 列 × 2 行 CSS Grid**(左 GitStatus / 中 CommitForm + CommandConsole / 右 LogList),含 3 条可拖拽分隔条(2 竖 + 1 横),支持键盘左右方向键调整。
- 底部 `Footer`:分支选择器(BranchSelector) + 远程仓库卡片(RemoteRepoCard) + 默认模型提示 + 版本徽标(AppVersionBadge)。

> 关键源码:`src/ui/client/src/App.vue`(主壳)、`src/ui/client/src/components/ActivityBar.vue`(活动栏)。

---

## 三、截图清单

| # | 文件 | 类型 | 主题 | 备注 |
|---|------|------|------|------|
| 01 | `01-git-view-light.png` | 视图 | light | Git 视图首屏(4 面板全部加载) |
| 02 | `02-editor-view-light.png` | 视图 | light | 编辑器视图,左侧文件树 |
| 03 | `03-sourcemap-view-light.png` | 视图 | light | 源码地图,VueFlow 画布 |
| 04 | `04-workbench-view-light.png` | 视图 | light | 工作台,任务列表 + 任务详情 |
| 05 | `05-user-settings-dialog-general-light.png` | 对话框 | light | 设置 - 通用设置 tab |
| 06 | `06-user-settings-dialog-git-light.png` | 对话框 | light | 设置 - Git 全局设置 tab |
| 07 | `07-user-settings-dialog-commit-light.png` | 对话框 | light | 设置 - 提交设置 tab |
| 08 | `08-git-view-dark.png` | 视图 | dark | 暗色 Git 视图 |
| 09 | `09-editor-view-dark.png` | 视图 | dark | 暗色编辑器 |
| 10 | `10-sourcemap-view-dark.png` | 视图 | dark | 暗色源码地图 |
| 11 | `11-workbench-view-dark.png` | 视图 | dark | 暗色工作台 |
| 12 | `12-user-settings-dialog-dark.png` | 对话框 | dark | 暗色设置对话框 |
| 13 | `13-state-user-unconfigured-light.png` | 状态 | light | Git 用户未配置 |
| 14 | `14-state-not-git-repo-light.png` | 状态 | light | 非 Git 仓库目录 |

截图见 `screenshots/` 目录(14 张主流程 + 12 张审计对照)。复现命令需本地启动 vite dev server(`127.0.0.1:5544`)后跑 Playwright 抓图脚本。

---

## 四、4 个主视图

### 4.1 Git 视图(默认首屏)

**截图:** `01-git-view-light.png` / `08-git-view-dark.png`

三列 × 两行 CSS Grid,默认列比 `2 : 3 : 3`,可拖拽调整并持久化到 `~/.git-commit-tool.json` 的 `ui.layout`:

```
┌──────────┬──────────┬──────────┐
│          │ Commit   │          │
│          │ Form     │          │
│ Git      ├──────────┤ LogList  │
│ Status   │ Command  │ (提交    │
│ (文件树) │ Console  │  历史)   │
│          │ (终端)   │          │
└──────────┴──────────┴──────────┘
   ↕v1      ↕h         ↕v2
```

- **GitStatus(左 `grid-area: git-status`)**:
  - 顶部图标工具栏:刷新、Stage 全部、Unstage 全部、Pull、Push、Stash、Merge、Reset、Discard 等 8 个 IconButton
  - 三种文件分组视图:未暂存 / 已暂存 / 已修改(可折叠),每组用 `FileGroup` + `TreeNodeItem` 渲染
  - 文件操作按钮组(底部折叠面板):NPM 脚本、自定义命令、Stash 列表
  - **Git 文件状态颜色**(统一 token):added `#10b981` / modified `#f59e0b` / deleted `#ef4444` / untracked `#8b5cf6` / conflicted `#f97316` / locked `#dc2626`
  - 选中文件后中间区显示 `FileDiffViewer`(走 `MonacoDiffViewer` 渲染)
- **CommitForm(中上 `grid-area: commit-form`)**:
  - AI 一键生成提交信息按钮 + 手动编辑
  - `type` 切换:feat / fix / docs / style / refactor / test / chore + 自由模式
  - 关联 issue、`-m` / `-am` / `-amend` 单选
  - `GitCommandPreview` 实时显示将执行的 git 命令
  - `GitActionButtons`:提交 / 暂存 / 推送 / 合并 / 重置 等主操作
  - 提交成功后弹 `SuccessModal`
- **CommandConsole(中下 `grid-area: cmd-console`)**:macOS 风格红黄绿圆点 + 5 个 tab(终端 / 命令历史 / 文件搜索 / 自定义命令 / 全屏),底部终端命令输入框 + 执行
- **LogList(右 `grid-area: log-list`)**:Element Plus 表格 + 提交 hash / 作者 / 日期 / message 列,支持日期范围 / 作者过滤,行点击展开 `FileDiffViewer`

**特殊状态(被截图覆盖)**:
- 用户未配置(`13-state-user-unconfigured-light.png`):中央 `state-block--warning` 卡,带 SVG 用户+对勾图标、立即配置按钮、CLI 命令片段
- 非 Git 仓库(`14-state-not-git-repo-light.png`):中央 `state-block--empty` 卡,显示 `git init` 提示(点击可复制)

### 4.2 编辑器视图

**截图:** `02-editor-view-light.png` / `09-editor-view-dark.png`

`KeepAlive` 缓存实例,布局:`左 280px 文件树 | 右 Monaco 编辑器`(带 tab 栏)。

- **左 - 资源管理器(`FileTreeView`)**:搜索框(180ms 防抖,避免大目录卡顿)+ 工具栏(新建文件 / 新建文件夹 / 刷新) + 递归 `TreeNodeItem`,每节点带类型图标(`getFileIconClass` / `getFolderIconClass`,从 `fileIcon.ts` 取)
- **右 - 编辑器**:
  - 顶 tab 栏:打开的多个文件 tab,激活态有 `inset 0 -2px 0` 的 primary 色下划线,脏文件有 12×12 实心圆点
  - 内容区:Monaco Editor,worker 走 `?worker` 注入(避免主线程卡顿)
  - 关联预览:右下角 ImagePreview / MarkdownPreview / MindmapPreview 三态切换(Markdown 渲染用 `markdown-renderer.css`)
- **底部操作**:保存(Ctrl+S)、关闭、关闭其他

> 关键组件:`src/ui/client/src/views/EditorView.vue`、`src/ui/client/src/components/MonacoEditor.vue`、`src/ui/client/src/components/MarkdownPreview.vue`、`src/ui/client/src/components/MindmapPreview.vue`、`src/ui/client/src/components/ImagePreview.vue`。

### 4.3 源码地图视图

**截图:** `03-sourcemap-view-light.png` / `10-sourcemap-view-dark.png`

`@vue-flow` 实现的代码调用图分析工具。布局:

- **顶栏**:项目路径输入框(默认 `configStore.currentDirectory`)+ 橙色 `开始分析` 按钮 + 全屏 / 适配视图 / 折叠展开 三个图标按钮
- **左侧**:`文件列表` / `大纲` 双 tab(用 underline 风格 tab 切换)
- **中央**:VueFlow 画布,点状背景(`--sm-bg-pattern: #cbd5e1`),节点是文件 / 函数矩形,边是调用关系,dagre 自动布局;左下角 Controls(放大缩小/适配),右下角 MiniMap
- **右侧**:`源码面板` 折叠抽屉,显示当前选中节点的源代码(Monaco readOnly)
- **底部**:`AGENT 日志` 流式输出区,显示扫描 / 分析 / 调 AI 的过程日志(info / success / error / thinking 4 种 type)

> 关键组件:`src/ui/client/src/views/SourceMapView.vue`,VueFlow + Background + Controls + MiniMap + dagre 自动布局。

### 4.4 工作台视图

**截图:** `04-workbench-view-light.png` / `11-workbench-view-dark.png`

AI 任务编排(支持"复杂任务拆子任务" + "简单任务直接执行"两种模式)。

- **左栏(280px) - 任务列表**:
  - 顶部:任务 / 任务列表 切换 tab,统计徽标显示总任务数
  - 新建任务按钮
  - 按项目根路径分组(`zen-git` / `flowdash/article-gene...` / `未关联项目`),每组有项目名 + 任务数
  - 每个任务项:状态图标(圆形,4 态:todo / running / done / error)+ 标题 + 状态徽标(简单/复杂 badge)+ 进度(已完成子任务数 / 总数)
- **中栏 - 任务编辑区**:
  - 顶行:任务标题(可编辑) + 提示词模板下拉(从 `prompts` 列表选)+ 简单 / 复杂 类型切换 + 4 个主操作按钮(`AI 拆分` / `执行任务` / `清空执行` / `执行日志`)
  - 任务描述(可选)多行文本框
  - 子任务拆分区:左半 `+ 添加子任务` / `保存拆分` / `清空` 操作栏,下面是子任务卡片列表(可标记完成)
  - 右半:新子任务输入框 + 描述 + 附件区(`附件 0/9` + `添加附件` 按钮)
- **右侧(默认折叠抽屉)** - 子任务详情/执行日志,默认 `LogsDialog` 收起,通过 `JobLogDetails` 查看执行历史

> 关键组件:`src/ui/client/src/views/WorkbenchView.vue`、`src/ui/client/src/components/AISplitDialog.vue`、`src/ui/client/src/components/AttachmentZone.vue`、`src/ui/client/src/components/JobLogDetails.vue`、`src/ui/client/src/components/ExecutionLogManager.vue`。

---

## 五、关键对话框与状态卡

| 组件 | 文件 | 触发方式 | 用途 |
|------|------|---------|------|
| `UserSettingsDialog` | `components/GitGlobalSettingsDialog.vue` | 头部 ⚙ 按钮 | 三 tab:通用 / Git 全局 / 提交(已截图 05-07, 12) |
| `CommonDialog` | `components/CommonDialog.vue` | 多处通用 | Element Plus el-dialog 二次封装,统一 header / footer 渐变、圆角 16、阴影 --dialog-shadow |
| `SuccessModal` | `components/SuccessModal.vue` | 提交成功后 | 全屏成功提示 + 跳转 |
| `UpgradeDialog` | `components/UpgradeDialog.vue` | 检测到新版本 | 升级提示,带 `npm i -g` 命令 |
| `NpmSettingsDialog` | `components/NpmSettingsDialog.vue` | NPM 脚本面板 | npm registry / 镜像配置 |
| `ProjectStartupDialog` | `components/ProjectStartupDialog.vue` | 启动项目 | 选择启动命令 / 端口 |
| `ProjectStartupButton` | `components/ProjectStartupButton.vue` | 工具栏 | 触发 ProjectStartupDialog |
| `PushProgressModal` | `components/PushProgressModal.vue` | 推送时 | 推送进度流式 |
| `CustomCommandManager` | `components/CustomCommandManager.vue` | 自定义命令面板 | CRUD 自定义命令 |
| `TemplateManager` | `components/TemplateManager.vue` | 提交表单下拉 | 管理提交信息模板 |
| `AISplitDialog` | `components/AISplitDialog.vue` | 工作台 AI 拆分 | AI 自动拆子任务 |
| `JobLogDetails` | `components/JobLogDetails.vue` | 工作台 | 查看 job 执行日志 |
| `ExecutionLogManager` | `components/ExecutionLogManager.vue` | 工作台 | 执行日志归档 |
| `AISplitChatPane` | `components/AISplitChatPane.vue` | AI 拆分 | AI 聊天面板(流式) |
| `AISplitDirectPane` | `components/AISplitDirectPane.vue` | AI 拆分 | 直跑模式面板 |
| `CommonDialog` | `components/CommonDialog.vue` | 通用 | 统一弹窗壳 |
| `ConfigBrokenBanner` | `App.vue` 内联 | 配置损坏时 | 顶部 40px 警告条(`configStore.hasConfigLoadError`),含查看原因 tooltip + 打开系统配置文件按钮 |

`state-block` 状态卡统一设计语言(在 `App.vue` / `state-block.scss` 中):
- **variant=empty**(非 git 仓库等中性空态):灰图标,主文案居中
- **variant=warning**(用户未配置等需引导):橙图标 + 描边,带主按钮 + 备用 CLI 引导

---

## 六、设计规范

所有 token 集中在 `src/ui/client/src/styles/variables.scss`,组件只引用 var,禁止硬编码颜色/尺寸。

### 6.1 配色

#### 主色 / 语义色

| Token | 值 | 用途 |
|-------|----|------|
| `--color-primary` | `#3b82f6` | 品牌主色(蓝) |
| `--color-primary-light` | `#60a5fa` | hover / loading 内环 |
| `--color-primary-dark` | `#2563eb` | active / 文字强调 |
| `--color-primary-gradient` | `linear-gradient(135deg, #1e3a5f, #2563eb, #0ea5e9)` | 品牌渐变(深蓝→中蓝→青) |
| `--color-success` | `#67c23a` | 成功 |
| `--color-warning` | `#e6a23c` | 警告 |
| `--color-danger` | `#f56c6c` | 危险 |
| `--color-info` | `#909399` | 信息 |
| `--color-cancelled` | `#9ca3af` | 取消 / 禁用 |
| `--color-think` | `#8b5cf6` | AI 思考区(紫) |

#### 背景 / 面板

| Token | light | dark |
|-------|-------|------|
| `--bg-page` | `#f0f2f5` | `#141820`(深蓝炭黑) |
| `--bg-container` | `#fff` | `#1c2130`(深蓝容器) |
| `--bg-panel` | `#f5f7fa` | `rgba(255,255,255,0.06)` |
| `--bg-console` | `#f0f2f5` | `#0d1117`(GitHub dark) |
| `--bg-header` | `rgba(255,255,255,0.82)` 毛玻璃 | `rgba(18,22,32,0.90)` |
| `--bg-input` | `white` | `#24292e` |
| `--bg-code` | `#f6f8fa` | `#1a2035` |

#### 文字(4 档)

```
--text-primary    303133   标题 / 重要正文
--text-title      374151   次级标题
--text-secondary  606266   次要正文
--text-tertiary   909399   辅助 / 占位
--text-placeholder c0c4cc   input placeholder
```

#### Git 状态色(独立 token,5 种)

| 状态 | 颜色 | 用途 |
|------|------|------|
| `added` | `#10b981` 绿 | 新增文件 |
| `modified` | `#f59e0b` 橙 | 修改文件 |
| `deleted` | `#ef4444` 红 | 删除文件 |
| `untracked` | `#8b5cf6` 紫 | 未跟踪 |
| `conflicted` | `#f97316` 橙红 | 冲突 |
| `locked` | `#dc2626` 深红 | 锁定 |

#### 复合 tint token(替代散落 `color-mix`)

`--tint-primary-04 / 06 / 08 / 10 / 12 / 14 / 16 / 18 / 22 / 30 / 35 / 45 / 50 / 55` —— `color-mix(in srgb, var(--color-primary) X%, transparent)`。同样有 `tint-success / tint-warning / tint-danger / tint-info / tint-think` 系列。

### 6.2 字体 / 字距 / 行高

#### 正文字体
```css
body {
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui,
    'Plus Jakarta Sans', sans-serif;
}
```
- 标题 / 品牌:`'Plus Jakarta Sans', sans-serif`(700 weight)
- 等宽(token `--font-mono`):`'JetBrains Mono', ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Courier New", monospace`

#### 字号(基础 7 档)
```
xs    10px   徽标 / 极小注释
sm    12px   次要文字 / footer
base  14px   正文
md    16px   重要正文
lg    18px   小标题
xl    20px   标题(H1 Logo)
2xl   22px   大标题
3xl   24px   弹窗标题
```
**扩展档**(Workbench 密集 UI):`11 / 11.5 / 12.5 / 13.5 / 15 / 17 px`

#### 字距
```
--letter-spacing-tight    -0.4px
--letter-spacing-heading  -0.25px
--letter-spacing-base     -0.1px
--letter-spacing-wide      0.3px
--letter-spacing-wider     0.6px
```

#### 行高
```
--line-height-tight    1.2
--line-height-normal   1.4
--line-height-relaxed  1.6
```

#### 字重
```
normal    400
medium    500
semibold  600
bold      700
```

### 6.3 间距 / 圆角 / 阴影

#### 间距 7 档
```
xs  2px   紧贴
sm  4px   icon 紧邻
base 8px 组件内边距基本单位
md  12px
lg  16px  卡片 padding / 区块间隔
xl  24px  大区块
2xl 32px  弹窗边距
3xl 48px  页面边距
```

#### 圆角 7 档
```
2xs  2px
xs   2px(同上,别名)
sm   3px
base 4px
md   6px 按钮 / input / 文件树项
lg   8px 卡片
xl   12px 大卡片
full 50% 头像 / 圆形 icon
pill 999px 胶囊徽标
```

#### 阴影 5 档(冷蓝色调,带轻微蓝)

```
--shadow-sm   0 1px 3px  rgba(30,58,95,0.05)
--shadow-base 0 1px 4px  rgba(30,58,95,0.06)
--shadow-md   0 2px 8px  rgba(30,58,95,0.09)
--shadow-lg   0 4px 16px rgba(30,58,95,0.10)
--shadow-xl   0 8px 32px rgba(30,58,95,0.13)
```

#### 弹窗专属 token
```
--dialog-radius      16px
--dialog-radius-sm   12px
--dialog-shadow      0 20px 48px / 0 6px 18px / 0 0 0 1px  (三层叠加)
--dialog-overlay     rgba(17,24,39,0.44)
--dialog-transition  all 0.22s cubic-bezier(0.22, 1, 0.36, 1)
```

#### 按钮
```
--btn-radius    10px
--btn-radius-sm 8px
--btn-radius-lg 12px
--btn-shadow-hover 0 8px 18px rgba(37,99,235,0.16)  primary
                  ...                              success/warning/danger 各一档
```

#### 焦点 ring
```
--focus-ring        0 0 0 3px color-mix(primary 18%, transparent)
--focus-ring-soft   0 0 0 3px color-mix(primary 12%, transparent)
--focus-ring-strong 0 0 0 4px color-mix(primary 18%, transparent)
```

### 6.4 动效 / 过渡

#### 过渡函数
```
--ease-in       ease-in
--ease-out      ease-out
--ease-in-out   ease-in-out
--ease-custom   cubic-bezier(0.4, 0, 0.2, 1)       通用
--ease-bounce   cubic-bezier(0.22, 1, 0.36, 1)    弹窗
```

#### 过渡时间
```
--transition-fast 0.1s
--transition-base 0.2s
--transition-slow 0.3s
```

#### 关键动效
- **加载 spinner**(`App.vue`):三层错位旋转环(外 1.4s,中 2.1s 反向,内 2.8s),配 3 个跳动点(交错 0.15s 延迟),带柔光晕 + 顶部 radial-gradient 高光;`prefers-reduced-motion` 时降到 3s
- **配置损坏 banner 滑入**:`banner-slide-down 0.32s` cubic-bezier
- **拖拽分隔条**:RAF 节流 60fps 合并,mousemove 期间只读取最近一次的 clientX
- **tab 切换**:`.22s` 全过渡

### 6.5 主题与暗色模式

- **切换机制**:`document.documentElement.setAttribute('data-theme', 'dark' | 'light')`,所有 dark 覆盖在 `styles/dark-theme.scss` 通过 `[data-theme="dark"]` 选择器
- **暗色特点**:
  - 背景走深蓝炭黑(`#141820`)而非纯黑,带蓝调质感
  - 容器 `#1c2130`,与背景形成层次
  - 文字次要/辅助档全部提亮一档(`#d8dce2` / `#cbd0d6`)
  - 控制台/终端用 GitHub dark 配色(`#0d1117` / `#161b22` / `#090d12`)
  - warning 在暗色下用更亮的橙(`--tint-warning-04` 等)

---

## 七、可访问性 / 焦点 / 交互

`recent commit 13c6727 refactor(ui): 可访问性(WCAG 2.1 AA)全面提升,补全局焦点环 + 弹窗焦点陷阱 + 键盘可达`
`recent commit 944e3a5 feat(ui): 主题一键切换 + 全局网络错误横幅 + 提交按钮 loading 态`
`recent commit caeaac1 refactor(ui): GUI 客户端硬化 — composable 收敛 + 设计令牌 + i18n + a11y`

- **焦点环**:所有可交互元素 `:focus-visible` 用 `--focus-ring` 或 `--focus-ring-soft`
- **拖拽分隔条键盘可达**:`role="separator"` + `tabindex="0"` + `aria-orientation` + `aria-valuenow/min/max`,左右/上下方向键 ±2% 调整
- **对话框焦点陷阱**:`CommonDialog` 统一处理 Esc 关闭 / 焦点循环
- **配置损坏 banner**:`role="alert" aria-live="polite"`,包含可点击"查看原因"tooltip
- **网络错误横幅**(`AppErrorBanner.vue`,944e3a5 落地):`role="alert" aria-live="assertive"`,patch 全局 fetch,失败时顶部红条,带"重试"+"关闭",绝对定位不挤压布局;`useNetworkStatus` composable(159 行)负责 fetch patch + online/offline 事件兜底
- **主题切换按钮**(Header,944e3a5):齿轮旁 32×32 图标,`aria-label` 动态反映当前可切换到的主题
- **提交按钮 loading 态**(CommitButton,944e3a5):`:loading="isCommitting"` + `:disabled="isCommitting"`,挂 `aria-busy` + `aria-label`,锁定 `min-width` 防宽度抖动
- **提交哈希对比度**(OPT-1,944e3a5):暗色 `.commit-hash` / `.commit-id` 通过 `--commit-hash-fg/bg` token 提升对比度 ≥ 4.5:1(WCAG AA)
- **活动栏按钮**:`aria-pressed` 反映 activeView 状态,`aria-label` **动态包含徽标数**(caeaac1 增强)— Git/Editor/Workbench 各自带"X 个未提交/未保存/任务正在执行"后缀,屏幕阅读器可读
- **loading 容器**:`role="status" aria-live="polite"`,spinner SVG `aria-hidden="true"`
- **减弱 motion**:`@media (prefers-reduced-motion: reduce)` 全局降速,spinner 降到 3s
- **i18n**:所有用户可见文案必须经 `$t('@<namespace>:<key>')` 包裹,语言文件在 `src/ui/client/src/lang/{zh,en}/index.js`(由 `.claude/rules/i18n-check.md` 强制)

---

## 八、组件清单

> 全部在 `src/ui/client/src/components/`,按用途分组。Views 在 `src/ui/client/src/views/`,首屏 6 个面板异步加载。

### 首屏主面板(异步)
| 组件 | 路径 |
|------|------|
| `GitStatus` | `views/components/GitStatus.vue` |
| `CommitForm` | `views/components/CommitForm.vue` |
| `LogList` | `views/components/LogList.vue` |
| `CommandConsole` | `components/CommandConsole.vue`(本轮 26 处 i18n 收敛) |
| `RemoteRepoCard` | `components/RemoteRepoCard.vue` |
| `AppVersionBadge` | `components/AppVersionBadge.vue`(本轮 2 处 token 替换) |
| `BranchSelector` | `components/BranchSelector.vue` |
| `DirectorySelector` | `components/DirectorySelector.vue`(顶置变体 `variant="header"`) |
| `ActivityBar` | `components/ActivityBar.vue`(本轮 3 按钮 aria-label 动态化) |
| `InstanceSwitcher` | `components/InstanceSwitcher.vue` |
| `AppErrorBanner` | `components/AppErrorBanner.vue`(**944e3a5 新增,262 行,role="alert" aria-live="assertive"**) |

### 视图(KeepAlive 缓存)
| 组件 | 路径 | 说明 |
|------|------|------|
| `EditorView` | `views/EditorView.vue` | 文件树 + Monaco |
| `SourceMapView` | `views/SourceMapView.vue` | VueFlow + dagre |
| `WorkbenchView` | `views/WorkbenchView.vue` | 任务编排 + AI 拆分 |

### 通用基础组件
- `IconButton.vue` — 透明方形按钮,支持 size sm/md/lg(20/22/24),hover 变 danger 色
- `SvgIcon/index.vue` + `index.ts` — 集中 SVG 图标注册与使用,全局注册在 `main.ts` 调 `initSvg(app)`
- `icons/TreeIcon.vue`、`icons/ListIcon.vue` — 视图切换图标

### Git / 文件操作
- `FileTreeView.vue` / `TreeNodeItem.vue` — 文件树(递归)
- `FileGroup.vue` — 分组容器(未暂存/已暂存/已修改)
- `FileDiffViewer.vue` / `MonacoDiffViewer.vue` — 差异查看
- `FileActionButtons.vue` — 文件级操作
- `AttachmentZone.vue` — 附件拖拽
- `MarkdownPreview.vue` / `MindmapPreview.vue` / `ImagePreview.vue` — 文件预览
- `MonacoEditor.vue` — Monaco 封装

### 按钮组(`components/buttons/`)
16 个操作按钮:`StageButton` / `UnstageAllButton` / `CommitButton` / `QuickCommitButton` / `PushButton` / `QuickPushButton` / `PullButton(implicit)` / `StashChangesButton` / `StashListButton` / `StashSelectedFilesButton` / `MergeBranchButton` / `ResetToRemoteButton` / `DiscardAllChangesButton` / `GitOperationsButton` / `CreateTagButton` / `TagListButton` / `ConfigEditorButton`

### 对话框
`CommonDialog`(统一壳) + 11 个业务对话框(见第五节表格)

### AI 相关
`AISplitDialog` / `AISplitChatPane` / `AISplitDirectPane` / `JobLogDetails` / `ExecutionLogManager` / `TemplateManager` / `CustomCommandManager` / `CustomCommandsPanel`

### 状态/加载
`GlobalLoading.vue` — 全局 loading composable + 弹层;`SuccessModal` / `UpgradeDialog` / `PushProgressModal` / `ProjectStartupDialog`

### 工具
- `stores/`:6 个 Pinia store(configStore / gitStore / editorTabs / instancesStore / localeStore / workbenchStatus)
- `composables/`:Vue 3 组合式工具
  - `useThemeObserver.ts`(caeaac1 新增,87 行)— 统一 5 处重复 MutationObserver,响应式 + 命令式双用法,setup 注册 + onBeforeUnmount 自动 disconnect
  - `useNetworkStatus.ts`(944e3a5 新增,159 行)— 全局 fetch patch + online/offline 事件兜底
  - `useGlobalLoading` / `useSuccessModal` / 等
- `utils/`:路径处理、文件图标类、editor 语言、job 状态色、文件树构建、合并去重等
- `lang/`:静态 `$t` 函数 + `static.d.ts` 类型 + `zh/` `en/` 翻译(本轮 +28 条 key)
- `locales/`:Vue-i18n 配置(动态 locale,zh-CN / en-US)
- `types/`:TS 类型定义(workbench, 等)
- `plugins/`:Vue 插件
- `stores/`:见上

### 第三方库关键依赖
- **element-plus** 2.x(全量按需 + resolve.alias 优化)
- **vue 3.5.13**(`<script setup>` + Composition API + KeepAlive)
- **pinia 3.0.2**(状态管理)
- **@vue-flow/core** + `dagre`(SourceMap 拓扑)
- **monaco-editor** + `?worker` 注入(代码编辑器)
- **socket.io-client** 4.8(实时通信)
- **local-file-picker** 0.1(目录选择)

---

> 设计 token 源:[`src/ui/client/src/styles/variables.scss`](../src/ui/client/src/styles/variables.scss) / [`dark-theme.scss`](../src/ui/client/src/styles/dark-theme.scss) / [`common.scss`](../src/ui/client/src/styles/common.scss) / [`unified-dialogs.scss`](../src/ui/client/src/styles/unified-dialogs.scss) / [`workbench.scss`](../src/ui/client/src/styles/workbench.scss)  
> 顶层壳:[`src/ui/client/src/App.vue`](../src/ui/client/src/App.vue) / [`main.ts`](../src/ui/client/src/main.ts)
