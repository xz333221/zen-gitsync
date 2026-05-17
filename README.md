# zen-gitsync

[English](#zen-gitsync) | [中文](#zen-gitsync-1)

A Git automation platform with interactive commits, scheduled sync, custom command orchestration, file locking, and a visual GUI.

## Installation

Install globally via npm:

```bash
npm install -g zen-gitsync
```

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
- **AI code analysis** — Scan project files with an OpenAI-compatible model
- **Commit templates** — Save type/scope/description/message templates
- **Theme & language** — Light/dark theme and Chinese/English UI

---

## GUI

### Launch the GUI:
```shell
$ g ui
```

![ui](https://home.flowdash.cn/upload/VditorFiles/2026-1/image_zbQZpiL6.png)

The GUI runs as a local web server and opens in your default browser. It attaches to the current Git repository automatically.

### Core Git Panel

| Feature | Description |
|---|---|
| File tree | Shows all changed files with status (new / modified / deleted / renamed) |
| Stage | Stage all or selected files (respects locked files) |
| Commit | Commit with message, optional skip-hooks (`--no-verify`) |
| Push | Push to remote with live progress modal |
| Quick commit+push | One-click stage → commit → push |
| Pull / Fetch | Pull from or fetch the upstream branch |
| Merge | Merge another branch; detects and surfaces in-progress merge state |
| Diff viewer | Monaco-based side-by-side diff for any changed file |
| Commit log | Browse commit history with author, date, and changed files |
| Remote URL | Display and one-click copy the remote repository URL |

### Branch Management

- View all local and remote branches
- Create a new branch from any base branch
- Switch branches
- Track upstream status (commits ahead / behind)

### Stash Management

- Save stash with an optional message
- Optionally include untracked files
- Optionally exclude locked files from stash
- Apply, pop, or drop individual stash entries

### Tag Management

- Create **lightweight** or **annotated** tags
- Target a specific commit
- List, push, or delete tags

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

### AI Code Analysis

Connect an OpenAI-compatible API to analyze your codebase:

- Recursively scans source files (JS, TS, Vue, Python, Go, and more)
- Sends file contents to the configured model
- Results displayed inside the GUI

Configure the model endpoint, API key, and model name in **Settings → AI**.

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

# zen-gitsync

[English](#zen-gitsync) | [中文](#zen-gitsync-1)

`zen-gitsync` 是一个 Git 自动化工作平台，支持交互式提交、定时同步、自定义命令编排、文件锁定与可视化 GUI 界面。

## 安装

通过 npm 全局安装：

```bash
npm install -g zen-gitsync
```

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
- **AI 代码分析** — 调用 OpenAI 兼容接口扫描分析项目代码
- **提交模板** — 保存类型/范围/描述/完整提交信息模板
- **主题与语言** — 支持明/暗主题，中英文界面切换

---

## GUI 界面

### 启动图形界面：
```shell
$ g ui
```

![ui](https://home.flowdash.cn/upload/VditorFiles/2026-1/image_zbQZpiL6.png)

GUI 以本地 Web 服务器形式运行，自动在浏览器中打开，并附加到当前 Git 仓库。

### 核心 Git 面板

| 功能 | 说明 |
|---|---|
| 文件树 | 显示所有变更文件及状态（新增/修改/删除/重命名） |
| 暂存 | 暂存全部或选中文件（自动排除锁定文件） |
| 提交 | 填写提交信息，可选跳过 hooks（`--no-verify`） |
| 推送 | 推送到远程，实时显示进度弹窗 |
| 快速提交+推送 | 一键完成暂存 → 提交 → 推送 |
| 拉取 / Fetch | 从上游拉取或仅获取远程信息 |
| 合并 | 合并其他分支，自动检测并引导处理合并中间状态 |
| Diff 查看器 | 基于 Monaco 编辑器的并排文件差异视图 |
| 提交日志 | 浏览历史提交（作者、时间、变更文件） |
| 远程地址 | 显示并一键复制远程仓库 URL |

### 分支管理

- 查看所有本地和远程分支
- 从任意基础分支创建新分支
- 切换分支
- 追踪上游状态（领先/落后提交数）

### Stash 管理

- 创建 stash，支持自定义备注
- 可选是否包含未追踪文件
- 可选排除已锁定的文件
- 应用（apply）、弹出（pop）或删除（drop）单条 stash

### Tag 管理

- 创建**轻量标签**或**附注标签**
- 可指定特定 commit
- 列出、推送或删除标签

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

### AI 代码分析

接入 OpenAI 兼容接口，分析项目代码库：

- 递归扫描源码文件（JS、TS、Vue、Python、Go 等）
- 将文件内容发送到配置的模型
- 分析结果在 GUI 内展示

在 **设置 → AI** 中配置模型接口地址、API Key 和模型名称。

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
