# zen-gitsync

[English](#zen-gitsync) | [中文](#zh)

A Git automation platform with interactive commits, scheduled sync, custom command orchestration, file locking, and a visual GUI.

## Table of Contents

- [Installation](#installation)
- [What''s New](#v2xx--whats-new)
- [GUI](#gui)
  - [Core Git Panel](#core-git-panel)
  - [Branch Management](#branch-management)
  - [Stash Management](#stash-management)
  - [Tag Management](#tag-management)
  - [Commit Message Templates](#commit-message-templates)
  - [Custom Commands](#custom-commands)
  - [Flow Orchestration](#flow-orchestration-visual-workflow-designer)
  - [NPM Scripts Panel](#npm-scripts-panel)
  - [Built-in Terminal](#built-in-terminal)
  - [Project Startup](#project-startup)
  - [Built-in Code Editor](#built-in-code-editor)
  - [Source Map](#source-map-ai-codebase-visualization)
  - [Workbench](#workbench-task-driven-claude-execution)
  - [Settings](#settings)
- [CLI Commands](#cli-commands)

---

## Installation

Install globally via npm:

```bash
npm install -g zen-gitsync
```

---

## v2.x.x — What''s New

- **Visual GUI** — Full graphical interface for Git operations
- **Branch management** — Create, switch, and track local/remote branches
- **Stash management** — Save and restore stashes with locked-file filtering
- **Tag management** — Create lightweight and annotated tags
- **Merge support** — Detect and complete in-progress merges
- **Flow orchestration** — Drag-and-drop visual workflow designer
- **NPM scripts panel** — Discover and run npm scripts from `package.json`
- **Built-in terminal** — Run commands with real-time streaming output
- **Custom commands** — Save, parameterize, and reuse shell commands
- **Project startup** — Auto-run commands or workflows when a project opens
- **Built-in code editor** — Monaco-based file editor with Markdown preview
- **Source map** — AI-generated interactive codebase dependency graph
- **Workbench** — task-driven Claude execution with prompt presets, subtask splitting, isolated bypass-permissions windows, live stdout streaming, AI-generated presets, and sub-task file attachments
- **Reset to remote** — One-click `git reset --hard origin/<branch>` from the Git panel (auto-refreshes branch info first to avoid wrong-target resets)
- **AI commit message** — Generate commit message from staged diff automatically
- **Selection-scoped diff** — AI commit message and quick commit/push use only the diff of currently selected files when the Git view is the active tab
- **Commit templates** — Save type/scope/description/message templates
- **Theme & language** — Light/dark theme and Chinese/English UI

---

## GUI

### Launch the GUI:
```shell
$ g ui
```

![ui](https://raw.githubusercontent.com/xz333221/zen-gitsync/main/public/images/zen-gitsync-ui-git.png)

The GUI runs as a local web server and opens in your default browser. It attaches to the current Git repository automatically. The activity bar on the left switches between four views: **Git**, **Editor**, **Source Map**, and **Workbench**.

---

### Core Git Panel

| Feature | Description |
|---|---|
| File list | Shows all changed files grouped by staged / unstaged / untracked / conflicted |
| View toggle | Switch between flat list and directory tree view (persisted) |
| Selection mode | Multi-select files to stage or stash only chosen files. When the Git view is the active tab, **Quick Commit / Quick Push** and **AI commit message** automatically scope their action to the current selection (button label switches to *Commit Selected* / *Push Selected*). |
| Per-file actions | Stage, unstage, or revert individual files |
| Stage | Stage all or selected files (respects locked files) |
| Commit | Structured form (type / scope / description / body / footer) or free-text |
| AI commit message | Generate commit message from staged diff using an AI model |
| Push | Push to remote with live progress modal |
| Quick commit+push | One-click stage → commit → push |
| Pull / Fetch | Pull from or fetch the upstream branch |
| Reset to remote | One-click `git reset --hard origin/<branch>`; auto-refreshes branch info first to avoid stale-branch targets; hidden when working tree is clean and no unpushed commits |
| Merge | Merge another branch; detects and surfaces in-progress merge state |
| Diff viewer | Monaco-based side-by-side diff for any changed file |
| Commit log | Browse commit history with author, date, branch tags, and changed files |
| Remote URL | Display and one-click copy the remote repository URL |
| Auto-refresh | Silently refreshes status and branch info when the window gains focus, the tab becomes visible, or you switch back to the **Git** view in the Activity Bar |

#### Structured Commit Form

The commit form supports two modes toggled by a switch:

- **Standard mode** — separate fields for type (`feat` / `fix` / `docs` / `style` / `refactor` / `test` / `chore`), scope, short description, body, and footer — produces a Conventional Commits message automatically
- **Free-text mode** — single text area for any commit message

In either mode, click **AI Generate** to fill in the fields automatically based on the staged diff.

---

### Branch Management

- View all local and remote branches
- Create a new branch from any base branch
- Switch branches
- Track upstream status (commits ahead / behind)

---

### Stash Management

- Save stash with an optional message
- Optionally include untracked files
- Optionally exclude locked files from stash
- Apply, pop, or drop individual stash entries

---

### Tag Management

- Create **lightweight** or **annotated** tags
- Target a specific commit
- List, push, or delete tags

---

### Commit Message Templates

Save reusable templates for:
- **Type** — `feat`, `fix`, `chore`, …
- **Scope** — component or module name
- **Description** — short summary
- **Full message** — complete commit message

---

### Custom Commands

![Command Orchestration](https://home.flowdash.cn/upload/VditorFiles/2026-1/zen-gitsync_SBAJdlvm.png)

Create, manage, and run shell commands from the sidebar:

- Define commands with a name, shell command, and working directory
- Add **parameters** with names, descriptions, and default values (referenced via `{{paramName}}`)
- Run a command instantly in a new terminal session
- Save command **templates** for quick reuse

---

### Flow Orchestration (Visual Workflow Designer)

Build automated pipelines with a drag-and-drop canvas:

| Node type | Purpose |
|---|---|
| **Start** | Entry point of the flow (one per flow, not deletable) |
| **Command** | Execute a saved custom command |
| **Wait** | Pause execution for 1–3600 seconds |
| **Version** | Bump `package.json` version (patch / minor / major) or modify a dependency |

- Nodes are executed in topological order
- Flows are saved and editable
- Each node can be individually enabled or disabled

---

### NPM Scripts Panel

- Automatically discovers all `package.json` files in the project tree
- Lists their `scripts` entries
- Run any script with one click
- Configure the scan root and exclusion patterns per package

---

### Built-in Terminal

- Open new terminal sessions from within the GUI
- Commands stream output in real time (Server-Sent Events)
- Running processes are tracked and can be stopped individually
- Cross-platform: uses `cmd.exe` on Windows, `sh` on Unix

---

### Project Startup

Configure commands or workflows to run automatically when a project is opened:

- Toggle auto-run on / off
- Drag to reorder startup items
- Mix custom commands and flow workflows in any order

---

### Built-in Code Editor

A full IDE-like editor (second icon in the activity bar) for browsing and editing project files without leaving the tool:

| Feature | Description |
|---|---|
| File tree | Collapsible directory tree with file-type icons |
| Multi-tab editing | Open multiple files simultaneously; tabs show unsaved (●) indicator |
| Monaco editor | Syntax highlighting for JS, TS, Vue, Python, Go, JSON, CSS, and more |
| Markdown preview | Toggle between source and rendered preview for `.md` files |
| Save | `Ctrl+S` to save; optional auto-save on focus loss |
| Create | New file or folder inline in the file tree |
| Rename / Delete | Rename or delete any file or folder directly from the tree |
| Resizable sidebar | Drag the divider to adjust file tree width |
| Theme sync | Editor theme follows the global light / dark setting |

---

### Source Map (AI Codebase Visualization)

A dedicated view (third icon in the activity bar) that uses an AI model to build a visual dependency graph of your project:

| Feature | Description |
|---|---|
| File scanner | Recursively scans all source files and builds a file tree |
| AI analysis | Sends file contents to an OpenAI-compatible model to infer structure |
| Dependency graph | Interactive node-edge graph (drag, zoom, fit-view, minimap) |
| Subsystems | Automatically clusters files into color-coded subsystems |
| Node detail | Click a node to view its source code in a Monaco editor panel |
| Tech stack | Detects the language and frameworks in use |
| Entry point | Identifies the main entry file and function |
| Analysis log | Real-time progress log during scanning and analysis |
| Resizable panels | File tree, graph, and source panels are all independently resizable |

Configure the model endpoint, API key, and model name in **Settings → AI**.

---

### Workbench (Task-Driven Claude Execution)

A dedicated view (fourth icon in the activity bar) for batch-running Claude against your repo. Define a task, split it into ordered subtasks, attach a reusable prompt preset, then click **Run task** — each subtask launches in its own terminal window with `claude --permission-mode bypassPermissions`, so context never piles up.

| Feature | Description |
|---|---|
| Task list | Create, edit, delete tasks; each shows its subtask count |
| Subtask breakdown | Add / edit / remove subtasks per task, with per-subtask status |
| Subtask attachments | Attach up to 9 files per subtask (image / PDF / text / Markdown / CSV / JSON / log, ≤ 5 MB each); their absolute paths are appended to the prompt so Claude reads them directly |
| Prompt presets | Reusable prompt templates with `{{task.title}}` / `{{task.desc}}` / `{{sub.title}}` / `{{sub.desc}}` / `{{repo.path}}` / `{{branch}}` variable interpolation |
| AI prompt generation | "New / Edit preset" dialog has an **AI Generate** button — the server reads the current project tree (depth 2) + README + manifests (package.json / pyproject.toml / go.mod / Cargo.toml / …) and asks the configured LLM to draft a project-aware preset (name + body) |
| Per-subtask override | Override the preset's content for a specific subtask in its description field |
| Sequential execution | Runs subtasks in declared order; the next one starts only after the previous process exits |
| Pipe-mode launcher | Spawns `claude -p "<prompt>" --output-format text --permission-mode bypassPermissions --dangerously-skip-permissions` with stdout/stderr piped to the server — no external terminal window is opened, so output streams directly into the UI |
| Isolated windows | Every subtask runs as its own detached process with fresh context, so memory and conversation state never accumulate across subtasks |
| Live log | Each running subtask has an expandable "执行日志 / Execution log" panel that auto-scrolls and shows accumulated `stdout` + `stderr` (capped at 256 KB server-side, last 64 KB rendered client-side) |
| Live status | Subtask status (todo / pending / running / done / error) and PID stream in real time over SSE |
| Cross-view indicator | While any Workbench subtask is running, a pulsing dot appears on the Workbench icon in the Activity Bar so you can see job state from the Git or Editor view |

Prompt presets and tasks are persisted to `~/.zen-gitsync/prompts.json` and `~/.zen-gitsync/tasks.json` (cross-project, shared across repos).

---

### Settings

| Setting | Description |
|---|---|
| Git user | Set `user.name` and `user.email` |
| Default commit message | Fallback message when none is provided |
| Theme | Light / dark (follows system preference by default) |
| Language | Chinese / English |
| File locking | Lock files so they are never staged or stashed |
| NPM paths | Configure where to look for `package.json` files |

---

## Development Notes

### Line endings

The repo ships a `.gitattributes` that locks source files to **LF** and Windows scripts (`.bat` / `.cmd` / `.ps1`) to **CRLF**. This takes precedence over `core.autocrlf`, so the working tree is identical on Windows, macOS, and Linux — generated files like `auto-imports.d.ts` and `components.d.ts` will not show up as "modified" just because the dev server rewrote them with different line endings.

If you change `.gitattributes` rules, renormalize the index in one shot:

```bash
git add --renormalize .
```

---

## CLI Commands

### Interactive commit:
```bash
$ g
Enter your commit message: fix login page style
```

### Commit directly (skip prompt):
```bash
$ g -y
```

### Commit with inline message:
```bash
$ g -m <message>
$ g -m=<message>
```

### Set default commit message:
```bash
$ g --set-default-message="update"
```

### Get current config:
```bash
$ g get-config
```

### Show help:
```shell
$ g -h
$ g --help
```

### Scheduled auto-commit (default interval: 1 hour):
```bash
$ g -y --interval
$ g -y --interval=<seconds>
```

### Specify working directory:
```bash
$ g --path=<path>
$ g --cwd=<path>
```

### Sync a folder in background (Windows):
```shell
start /min cmd /k "g -y --path=<your-folder> --interval"
```

### Scheduled command execution (Windows):
```shell
start /min cmd /k "g --cmd=\"echo hello\" --cmd-interval=5"     # every 5 seconds
start /min cmd /k "g --cmd=\"echo at-time\" --at=23:59"         # once at 23:59
start /min cmd /k "g --cmd=\"echo daily\" --at=23:59 --daily"   # daily at 23:59
```

### Suppress git diff output:
```shell
$ g --no-diff
```

### Print formatted git log:
```shell
$ g log
$ g log --n=5
```

### File locking (only effective within the tool):
```shell
# Lock a file (locked files are excluded from commits and stashes)
$ g --lock-file=config.json

# Unlock a file
$ g --unlock-file=config.json

# List all locked files
$ g --list-locked

# Check if a file is locked
$ g --check-lock=config.json
```

---

<a name="zh"></a>

# zen-gitsync

[English](#zen-gitsync) | [中文](#zh)

`zen-gitsync` 是一个 Git 自动化工作平台，支持交互式提交、定时同步、自定义命令编排、文件锁定与可视化 GUI 界面。

## 目录

- [安装](#安装)
- [新特性](#v2xx--新特性)
- [GUI 界面](#gui-界面)
  - [核心 Git 面板](#核心-git-面板)
  - [分支管理](#分支管理)
  - [Stash 管理](#stash-管理)
  - [Tag 管理](#tag-管理)
  - [提交信息模板](#提交信息模板)
  - [自定义命令](#自定义命令)
  - [可视化流程编排](#可视化流程编排)
  - [NPM 脚本面板](#npm-脚本面板)
  - [内置终端](#内置终端)
  - [项目启动](#项目启动)
  - [内置代码编辑器](#内置代码编辑器)
  - [源码地图](#源码地图ai-代码库可视化)
  - [工作台](#工作台任务驱动的-claude-执行)
  - [设置](#设置)
- [命令行](#命令行)

---

## 安装

通过 npm 全局安装：

```bash
npm install -g zen-gitsync
```

---

## v2.x.x — 新特性

- **可视化 GUI** — 完整的 Git 图形操作界面
- **分支管理** — 创建、切换、追踪本地/远程分支
- **Stash 管理** — 储藏与恢复变更，支持排除锁定文件
- **Tag 管理** — 创建轻量/附注标签
- **合并支持** — 自动检测并引导完成进行中的合并
- **可视化流程编排** — 拖拽式工作流设计器
- **NPM 脚本面板** — 发现并运行 `package.json` 中的脚本
- **内置终端** — 实时流式输出的命令执行终端
- **自定义命令** — 保存、参数化并复用 Shell 命令
- **项目启动** — 打开项目时自动运行命令或工作流
- **内置代码编辑器** — 基于 Monaco 的文件编辑器，支持 Markdown 预览
- **源码地图** — AI 生成的交互式代码库依赖关系图
- **工作台** — 任务驱动的 Claude 执行视图：提示词预置、子任务拆分、独立 bypass-permissions 进程、stdout 实时回传、AI 自动生成预置提示词、子任务附件
- **重置到远程** — 在 Git 面板一键执行 `git reset --hard origin/<branch>`（点击前会先自动刷新分支信息，避免重置到陈旧分支）
- **AI 生成提交信息** — 基于 staged diff 自动生成提交消息
- **选择模式差异** — 当 Git 视图为当前激活标签时，AI 生成提交信息与一键提交/推送仅作用于当前勾选文件的 diff
- **提交模板** — 保存类型/范围/描述/完整提交信息模板
- **主题与语言** — 支持明/暗主题，中英文界面切换

---

## GUI 界面

### 启动图形界面：
```shell
$ g ui
```

![ui](https://raw.githubusercontent.com/xz333221/zen-gitsync/main/public/images/zen-gitsync-ui-git.png)

GUI 以本地 Web 服务器形式运行，自动在浏览器中打开，并附加到当前 Git 仓库。左侧 Activity Bar 可在四个视图之间切换：**Git**、**编辑器**、**源码地图**、**工作台**。

---

### 核心 Git 面板

| 功能 | 说明 |
|---|---|
| 文件列表 | 按已暂存/未暂存/未追踪/冲突分组显示所有变更文件 |
| 视图切换 | 平铺列表与目录树形视图切换（持久化保存） |
| 选择模式 | 多选文件，仅对选中文件执行暂存或储藏。在 Git 视图下，**一键提交 / 一键推送** 与 **AI 生成提交信息** 会自动仅作用于当前勾选的文件（按钮文案切换为「一键提交所选」/「一键推送所选」） |
| 单文件操作 | 对每个文件独立执行暂存、取消暂存或还原 |
| 暂存 | 暂存全部或选中文件（自动排除锁定文件） |
| 提交 | 结构化表单（类型/范围/描述/正文/页脚）或自由文本 |
| AI 生成提交信息 | 基于 staged diff 自动生成提交消息 |
| 推送 | 推送到远程，实时显示进度弹窗 |
| 快速提交+推送 | 一键完成暂存 → 提交 → 推送 |
| 拉取 / Fetch | 从上游拉取或仅获取远程信息 |
| 重置到远程 | 一键执行 `git reset --hard origin/<branch>`；点击前会先刷新分支信息，避免重置到陈旧分支；当工作区干净且无未推送提交时按钮自动隐藏 |
| 合并 | 合并其他分支，自动检测并引导处理合并中间状态 |
| Diff 查看器 | 基于 Monaco 编辑器的并排文件差异视图 |
| 提交日志 | 浏览历史提交（作者、时间、分支标签、变更文件） |
| 远程地址 | 显示并一键复制远程仓库 URL |
| 自动刷新 | 窗口获得焦点、标签页重新可见，或从 Activity Bar 切回 **Git** 视图时，自动静默刷新文件状态与分支信息 |

#### 结构化提交表单

提交表单支持通过开关切换两种模式：

- **标准模式** — 分别填写类型（`feat` / `fix` / `docs` / `style` / `refactor` / `test` / `chore`）、范围、简短描述、正文和页脚，自动组合成符合 Conventional Commits 规范的提交信息
- **自由模式** — 单一文本框，输入任意提交信息

两种模式下均可点击 **AI 生成** 按钮，根据当前 staged diff 自动填充提交信息。

---

### 分支管理

- 查看所有本地和远程分支
- 从任意基础分支创建新分支
- 切换分支
- 追踪上游状态（领先/落后提交数）

---

### Stash 管理

- 创建 stash，支持自定义备注
- 可选是否包含未追踪文件
- 可选排除已锁定的文件
- 应用（apply）、弹出（pop）或删除（drop）单条 stash

---

### Tag 管理

- 创建**轻量标签**或**附注标签**
- 可指定特定 commit
- 列出、推送或删除标签

---

### 提交信息模板

为以下内容保存可复用模板：
- **类型** — `feat`、`fix`、`chore` 等
- **范围** — 组件或模块名
- **描述** — 简短说明
- **完整信息** — 完整提交消息

---

### 自定义命令

![命令编排](https://home.flowdash.cn/upload/VditorFiles/2026-1/zen-gitsync_SBAJdlvm.png)

在侧边栏创建、管理并运行 Shell 命令：

- 定义命令（名称、Shell 命令、工作目录）
- 添加**参数**（名称、描述、默认值，通过 `{{paramName}}` 引用）
- 一键在新终端会话中执行命令
- 保存**命令模板**快速复用

---

### 可视化流程编排

通过拖拽画布构建自动化流程：

| 节点类型 | 用途 |
|---|---|
| **开始节点** | 流程入口（每个流程唯一，不可删除） |
| **命令节点** | 执行一个已保存的自定义命令 |
| **等待节点** | 暂停执行 1–3600 秒 |
| **版本节点** | 修改 `package.json` 版本号（patch/minor/major）或依赖版本 |

- 节点按拓扑顺序执行
- 流程可保存并二次编辑
- 每个节点可单独启用/禁用

---

### NPM 脚本面板

- 自动扫描项目中所有 `package.json` 文件
- 列出其中的 `scripts` 条目
- 一键运行任意脚本
- 可配置扫描根路径和排除规则

---

### 内置终端

- 在 GUI 内直接打开新的终端会话
- 命令输出实时流式显示（Server-Sent Events）
- 追踪运行中的进程，随时可以停止
- 跨平台：Windows 使用 `cmd.exe`，Unix 使用 `sh`

---

### 项目启动

配置在项目打开时自动执行的命令或工作流：

- 一键开启/关闭自动运行
- 拖拽调整启动项顺序
- 可混合使用自定义命令与流程工作流

---

### 内置代码编辑器

Activity Bar 第二个视图，在 GUI 内直接浏览并编辑项目文件：

| 功能 | 说明 |
|---|---|
| 文件树 | 可折叠的目录树，附带文件类型图标 |
| 多标签页 | 同时打开多个文件，未保存文件显示 ● 标记 |
| Monaco 编辑器 | 支持 JS、TS、Vue、Python、Go、JSON、CSS 等语法高亮 |
| Markdown 预览 | `.md` 文件可切换源码与渲染预览模式 |
| 保存 | `Ctrl+S` 手动保存；可选失去焦点时自动保存 |
| 新建 | 在文件树中内联创建文件或文件夹 |
| 重命名 / 删除 | 在树中直接对文件或文件夹重命名、删除 |
| 侧边栏调整 | 拖拽分隔条自由调整文件树宽度 |
| 主题同步 | 编辑器主题跟随全局明/暗设置 |

---

### 源码地图（AI 代码库可视化）

Activity Bar 第三个视图，调用 AI 模型将项目代码库生成可交互的依赖关系图：

| 功能 | 说明 |
|---|---|
| 文件扫描 | 递归扫描所有源码文件并构建文件树 |
| AI 分析 | 将文件内容发送到 OpenAI 兼容接口，推断项目结构 |
| 依赖关系图 | 可拖拽、缩放、适配视图的节点边图（带缩略图导航） |
| 子系统聚类 | 自动将文件聚类为颜色区分的子系统 |
| 节点详情 | 点击节点在右侧 Monaco 面板中查看对应源码 |
| 技术栈检测 | 识别项目使用的语言和框架 |
| 入口点识别 | 标记主入口文件和入口函数 |
| 分析日志 | 扫描与分析过程实时输出进度日志 |
| 多面板布局 | 文件树、关系图、源码三个面板均可独立拖拽调整宽度 |

在 **设置 → AI** 中配置模型接口地址、API Key 和模型名称。

---

### 工作台（任务驱动的 Claude 执行）

Activity Bar 第四个视图，用于在当前仓库上批量调度 Claude：定义任务、拆成有序子任务、绑定可复用的提示词预置，点 **执行任务** 后按顺序依次执行。

| 功能 | 说明 |
|---|---|
| 任务列表 | 新建、编辑、删除任务；每条任务显示子任务数量 |
| 子任务拆分 | 增删改子任务，实时显示每个子任务的执行状态 |
| 子任务附件 | 每个子任务最多挂 9 个附件（图片 / PDF / 文本 / Markdown / CSV / JSON / log，单个 ≤ 5 MB）；执行时绝对路径会自动追加到 prompt 末尾，Claude 直接按路径读取 |
| 提示词预置 | 可复用提示词模板，支持 `{{task.title}}` / `{{task.desc}}` / `{{sub.title}}` / `{{sub.desc}}` / `{{repo.path}}` / `{{branch}}` 变量插值 |
| AI 生成预置 | 「新建 / 编辑预置」对话框内置 **AI 生成** 按钮：服务端读取当前项目目录树（depth=2）+ README + 9 种 manifest（package.json / pyproject.toml / go.mod / Cargo.toml …），调用已配置的 LLM 一键产出贴合项目结构的提示词（名称 + 正文），生成后用户可继续手动调整再保存 |
| 子任务覆盖 | 在子任务描述框可独立覆盖预置提示词的内容 |
| 顺序执行 | 按声明顺序依次执行子任务；上一个进程退出后才启动下一个 |
| 管道模式启动 | 直接以 `claude -p "<prompt>" --output-format text --permission-mode bypassPermissions --dangerously-skip-permissions` 拉起进程，stdout / stderr 通过管道回传服务端，不再弹外部终端窗口 |
| 独立上下文 | 每个子任务都是独立的 detached 进程，上下文与状态不会跨子任务累积 |
| 实时日志 | 正在执行的子任务可展开「执行日志」面板，自动滚到底，展示累积的 stdout / stderr（服务端缓存 256 KB，客户端渲染最近 64 KB） |
| 实时状态 | 子任务状态（todo / pending / running / done / error）和 PID 通过 SSE 实时推送 |
| 跨视图指示 | 任意子任务运行中时，Activity Bar 上的工作台图标会显示脉动小圆点；切换到 Git 或编辑器视图也能看到运行状态 |

提示词预置与任务数据持久化到 `~/.zen-gitsync/prompts.json` 和 `~/.zen-gitsync/tasks.json`（跨项目共享）。子任务附件落盘在 `~/.zen-gitsync/workbench-images/<subId>/`。

---

### 设置

| 设置项 | 说明 |
|---|---|
| Git 用户信息 | 设置 `user.name` 和 `user.email` |
| 默认提交信息 | 未填写时的回退提交消息 |
| 主题 | 明亮/暗黑模式（默认跟随系统） |
| 语言 | 中文 / English |
| 文件锁定 | 锁定文件，使其永远不被暂存或储藏 |
| NPM 路径 | 配置 `package.json` 的扫描位置 |

---

## 开发约定

### 行尾规范

仓库根的 `.gitattributes` 把**所有源代码锁定为 LF**（`.ts` `.js` `.vue` `.json` `.md` 等），**Windows 脚本锁定为 CRLF**（`.bat` / `.cmd` / `.ps1`）。`.gitattributes` 的优先级高于 `core.autocrlf`，所以无论本地 git 怎么配，签出与提交的行尾都一致；dev server 重新生成的 `auto-imports.d.ts`、`components.d.ts` 不会再因为行尾不一致而显示为"内容相同的 modified"。

如果你修改了 `.gitattributes` 的规则，需要一次性重新归一索引：

```bash
git add --renormalize .
```

---

## 命令行

#### 交互式提交：
```bash
$ g
请输入你的提交信息: 修复了登录页样式问题
```

#### 直接提交（跳过输入）：
```bash
$ g -y
```

#### 传入 message 直接提交：
```bash
$ g -m <message>
$ g -m=<message>
```

#### 设置默认提交信息：
```bash
$ g --set-default-message="提交"
```

#### 获取当前配置：
```bash
$ g get-config
```

#### 查看帮助：
```shell
$ g -h
$ g --help
```

#### 定时执行自动提交（默认间隔 1 小时）：
```bash
$ g -y --interval
$ g -y --interval=<seconds>
```

#### 指定目录提交：
```bash
$ g --path=<path>
$ g --cwd=<path>
```

#### 后台同步文件夹（Windows）：
```shell
start /min cmd /k "g -y --path=你要同步的文件夹 --interval"
```

#### 定时执行命令（Windows）：
```shell
start /min cmd /k "g --cmd=\"echo hello\" --cmd-interval=5"     # 每5秒执行一次
start /min cmd /k "g --cmd=\"echo at-time\" --at=23:59"         # 在23:59执行一次
start /min cmd /k "g --cmd=\"echo daily\" --at=23:59 --daily"   # 每天23:59执行一次
```

#### 不显示 git diff 内容：
```shell
$ g --no-diff
```

#### 格式化打印 git log：
```shell
$ g log
$ g log --n=5
```

#### 文件锁定功能（仅在工具中有效）：
```shell
# 锁定文件（锁定后的文件不会被暂存或储藏）
$ g --lock-file=config.json

# 解锁文件
$ g --unlock-file=config.json

# 查看所有锁定的文件
$ g --list-locked

# 检查文件是否被锁定
$ g --check-lock=config.json
```
