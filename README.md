# zen-gitsync

[English](#zen-gitsync) | [中文](#zh)

A Git automation platform with interactive commits, scheduled sync, custom command orchestration, file locking, and a visual GUI.

## Table of Contents

- [Installation](#installation)
- [What's New](#v2xx--whats-new)
- [GUI](#gui)
  - [Core Git Panel](#core-git-panel)
  - [GitHub / Gitee Repositories](#github--gitee-repositories)
  - [Quick Directory Switch](#quick-directory-switch)
  - [Branch Management](#branch-management)
  - [Remote Management](#remote-management)
  - [Stash Management](#stash-management)
  - [Tag Management](#tag-management)
  - [Commit Message Templates](#commit-message-templates)
  - [Custom Commands](#custom-commands)
  - [Flow Orchestration](#flow-orchestration-visual-workflow-designer)
  - [NPM Scripts Panel](#npm-scripts-panel)
  - [Console Panel](#console-panel)
  - [Project Startup](#project-startup)
  - [Views at a glance](#views-at-a-glance)
  - [Built-in Code Editor](#built-in-code-editor)
  - [Workbench](#workbench-task-driven-agent-execution)
  - [AI Agent](#ai-agent-web)
  - [Settings](#settings)
  - [Self-Upgrade](#self-upgrade)
- [Development Notes](#development-notes)
- [CLI Commands](#cli-commands)

---

## Installation

Install globally via npm:

```bash
npm install -g zen-gitsync
```

---

## v2.x.x — What's New

- **Visual GUI** — Full graphical interface for Git operations
- **Branch management** — Create, switch, and track local/remote branches
- **Remote management** — Manage multiple remotes (add / rename / retarget / delete) from one dialog, configure multi push URLs, and push to a chosen remote or to all remotes at once
- **Repository browser** — GitHub / Gitee tabs listing every repository your CLI account can see (private ones included), with search, sorting (recently pushed / recently created / most starred / name), grouping by workspace, and cards that carry last-push date, fork count, default branch and license
- **Stash management** — Save and restore stashes with locked-file filtering
- **Tag management** — Create lightweight and annotated tags
- **Merge support** — Detect and complete in-progress merges
- **Flow orchestration** — Drag-and-drop visual workflow designer
- **NPM scripts panel** — Discover and run npm scripts from `package.json`
- **Built-in terminal** — Run commands with real-time streaming output
- **Custom commands** — Save, parameterize, and reuse shell commands
- **Project startup** — Auto-run commands or workflows when a project opens
- **Built-in code editor** — Monaco-based file editor with Markdown preview
- **Workbench** — a multi-project board with a kanban view and a master-agent dispatch console; task-driven agent execution (Claude Code or OpenCode) with prompt presets, isolated per-task processes, live streaming output, AI-generated presets and task-level attachments
- **Repository cloning** — clone any GitHub / Gitee repository into a folder straight from the repo browser, with an *Already cloned* badge (and its local path) backed by a whole-disk local-repository scan
- **Skill / MCP marketplace** — install skills and MCP servers from the Agent view into the current project or the `g ai` agent
- **Reset to remote** — One-click `git reset --hard origin/<branch>` from the Git panel (auto-refreshes branch info first to avoid wrong-target resets)
- **AI commit message** — Generate commit message from staged diff automatically
- **Selection-scoped diff** — AI commit message and quick commit/push use only the diff of currently selected files when the Git view is the active tab
- **Commit templates** — Save type/scope/description/message templates
- **Theme & language** — Light/dark theme and Chinese/English UI; one-click theme toggle in the header (no need to dig into settings)
- **Network error banner** — Global banner appears when the backend is unreachable, with one-click retry and relative-time status
- **Accessibility (WCAG 2.1 AA)** — Dialog focus trap & restore, role-based separators, keyboard-only panel resize (`← → ↑ ↓`), screen-reader friendly commit context menu, ARIA-pressed toggle buttons, commit button `aria-busy` during in-flight commits, Git SHA hashes meet ≥ 4.5:1 contrast in both light and dark themes
- **Faster cold start** — `monaco-editor` / `@vue-flow` / `flow-mindmap` / `dagre` are split into independent chunks and lazy-loaded so the Git panel boots without waiting on the code editor or visual workflow designer

> Detailed per-release changes can be found via `git log` or the [GitHub Releases](https://github.com/xz333221/zen-gitsync/releases) page.

---

## GUI

### Launch the GUI:
```shell
$ g ui
```

The GUI runs as a local web server and opens in your default browser on the first free port it finds in `4000–6000` (set `PORT` to pin a fixed one). It attaches to the current Git repository automatically. The activity bar on the left switches between **Git**, **Console**, **Agent**, **Editor**, **Workbench**, **System Monitor** and **Mindmap**, top to bottom. See the [Core Git Panel](#core-git-panel) screenshot below for what the main view looks like.

### Architecture at a glance

```
                  ┌─────────────────────────────────────────────┐
                  │  Header:  current dir · theme · instances   │
                  ├─────────────────────────────────────────────┤
                  │  Activity Bar (left rail)                   │
                  │  ┌───┐                                      │
                  │  │Git│────► Git panel  (files + commit)     │
                  │  └───┘                                      │
                  │  ┌──────┐                                   │
                  │  │Consol│─► Saved commands + terminal       │
                  │  └──────┘                                   │
                  │  ┌──────┐                                   │
                  │  │Agent │─► Web agent + Skill/MCP plaza     │
                  │  └──────┘                                   │
                  │  ┌──────┐                                   │
                  │  │Edit  │─► Monaco editor + file tree       │
                  │  └──────┘                                   │
                  │  ┌──────┐                                   │
                  │  │Bench │─► Board: projects·kanban·agent│
                  │  └──────┘                                   │
                  │  ┌──────┐                                   │
                  │  │Monit │─► System monitor                  │
                  │  └──────┘                                   │
                  │  ┌──────┐                                   │
                  │  │ Mind │─► Mindmap                         │
                  │  └──────┘                                   │
                  └─────────────────────────────────────────────┘
                       ▲              ▲              ▲
                       │              │              │
                  Pinia stores ──── EventBus ──── Socket.IO
                       ▲
                       │
                  Backend Express server (free port 4000–6000) → git / npm / shell
```

### A typical day in the GUI

```
  1.  g ui            → browser opens on the first free port in 4000–6000
  2.  Glance header   → current dir, branch, instance count, theme toggle
  3.  Edit files      → Activity Bar → Editor, save with Ctrl+S
  4.  Stage & commit  → Activity Bar → Git, pick files, fill commit form, push
  5.  AI commit msg   → click ✨ AI 生成 in commit form, diff → Conventional Commits
  6.  Background job  → Activity Bar → Workbench, run task, watch live logs
  7.  Quick command   → Activity Bar → Console → pick saved command → run
```

---

### Core Git Panel

![Git panel — file list, structured commit form, history](https://raw.githubusercontent.com/xz333221/zen-gitsync/main/public/images/git-panel-changes.png)

> Single-screen view of "what changed → what to commit → what was committed". The left column lists changed files grouped by staged / unstaged / untracked / conflicted; the right side stacks the structured commit form on top of a chronological commit history. No tab switching required for the 80% case.

| Feature | Description |
|---|---|
| File list | Shows all changed files grouped by staged / unstaged / untracked / conflicted — plus intent-to-add files as their own "to be staged" group |
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
| In-diff preview | Toggle a preview pane below the diff for `.html` / `.htm` / `.svg` (sandboxed iframe with JavaScript enabled — interactive reports work, isolated from the app via an opaque origin), `.md` / `.markdown` (rendered Markdown) and Office documents (`.doc` / `.docx` / `.xls` / `.xlsx` / `.ppt` / `.pptx` / `.odt` / `.ods` / `.odp`, converted server-side) — same preview experience as the built-in editor, with a draggable vertical resizer; split ratio is persisted per project |
| Commit log | Browse commit history with author, date, branch tags, and changed files |
| Remote URL | Display and one-click copy the remote repository URL; the gear icon beside it opens **Remote Management** (multi-remote setups, multi push URLs) |
| Auto-refresh | Silently refreshes status and branch info when the window gains focus, the tab becomes visible, or you switch back to the **Git** view in the Activity Bar |

#### Structured Commit Form

The commit form supports two modes toggled by a switch:

- **Standard mode** — separate fields for type (`feat` / `fix` / `docs` / `style` / `refactor` / `test` / `chore`), scope, short description, body, and footer — produces a Conventional Commits message automatically
- **Free-text mode** — single text area for any commit message

In either mode, click **AI Generate** to fill in the fields automatically based on the staged diff.

---

### GitHub / Gitee Repositories

> The Git view has three tabs: **当前项目** (current project), **GitHub 仓库**, and **Gitee 仓库**. The latter two list every repository your `gh` / `gitee` account can see — private ones included. ZenGitSync never touches your token: both panels shell out to the official CLI (`gh`, `@gitee/gitee-cli`), which keeps its own credentials.

- **Zero-config guidance** — a missing CLI shows the install command for your platform (winget / Homebrew / `npm install -g @gitee/gitee-cli`) with one-click install and auto-refresh; an installed but signed-out CLI shows the sign-in command plus one-click sign-in, then polls until you finish the interactive flow in the terminal
- **Search** — filters by name, full path and description; the header switches to `匹配 M / 共 N 个仓库` so you can tell how much got filtered out
- **Sort** — recently pushed (default) / recently created / most starred / name. Sorting happens in the frontend, so both tabs behave identically — their CLIs do not (`gh` returns most-recently-pushed first, `gitee` returns `owner/name` alphabetical)
- **Group by workspace** — repositories are grouped by their `owner` by default, so everything under one account or organisation sits together instead of being scattered across the grid by push date; group order follows the current sort rule (the workspace pushed most recently comes first) and so does the order inside each group, with the header showing how many repositories that workspace holds. Switch to **No grouping** for a flat, cross-workspace timeline
- **No refetch on tab switch** — the list is cached per account, so coming back to the tab paints instantly instead of shelling out to `gh repo list` again; once the cache is a minute old it paints from cache first and refreshes quietly in the background, while **刷新** always pulls for real
- **Informative cards** — repository name, description and privacy / fork / language / star badges, plus a third line with last-push date, fork count, non-`main` default branch and license (each omitted when there is nothing to say)
- **Clone straight to a folder** — a repository that is not on your disk yet offers **Clone to folder…**: pick a directory and the clone runs over SSH (`git@github.com:owner/repo.git`), with an `https://` URL normalised first so it never stalls on a Git Credential Manager prompt
- **"Already cloned" badge** — the server keeps a whole-disk index of local Git repositories (built in the background and refreshable on demand), so a card for a repo you already have shows its local path instead of offering another clone
- **One click to open or copy** — clicking a card opens the repository page in your browser; the actions that appear on hover copy the URL or open it

---

### Quick directory switch

![Directory switcher dialog](https://raw.githubusercontent.com/xz333221/zen-gitsync/main/public/images/directory-switcher.png)

> Click the directory name in the header (or the folder icon) to open this dialog. Type a path, hit **浏览** to use the OS file picker, or pick from **常用目录** for one-click switching. **使用新标签打开** spawns a new GUI tab on that path so you can keep the current project open.

The header row beside the directory name carries its own quick actions: open in the file manager, open in a terminal, copy the folder name (last path segment only), open with `g ai`, and one button per detected editor / AI tool — VS Code, Codex, OpenCode, Kimi Code, ZCode, DeepSeek Harness and Claude Code (right-click the Claude button for the default / fully-approved menu, or right-click any tool button to update it to the latest version). Tools that are not installed are collected into a **more** menu, where clicking one opens the install guide.

When the GUI is opened on a directory that is not a Git repository, the right pane shows the **Recent projects** list instead — every recent directory with its Git badges (behind / ahead / uncommitted) and one-click "open in a new tab". Each page load runs a `git fetch` pass over all of them automatically, so the ahead/behind badges show the real state rather than the snapshot from the last fetch; the **刷新全部** button does the same thing on demand.

The same list (and the **常用目录** list in the directory switcher dialog) carries a short note underneath the cards. With an AI model configured it is an **AI status summary** — one paragraph written by the model from the freshly fetched states, naming the projects that need a pull, have unpushed commits or uncommitted changes, and saying so when everything is in sync. It is generated once per distinct state right after the **刷新全部** pass finishes (never mid-refresh), cached for the page, and there is a regenerate button on the right; the summary is shared between the panel and the dialog, so opening the switcher never triggers a second call. Without a model configured it falls back to a static note explaining what the badges mean.

---

### Branch Management

- View all local and remote branches
- Create a new branch from any base branch
- Switch branches
- Track upstream status (commits ahead / behind)

---

### Remote Management

- Keep any number of remotes (`origin`, `upstream`, `backup`, …) in one dialog: add, rename, retarget the URL, or delete
- Each remote shows its fetch URL plus any explicit push URLs, with **Upstream** / **Push default** badges so you can tell at a glance which one the current branch tracks
- Give one remote several **push URLs** (e.g. GitHub + Gitee) so a single push reaches several hosts, or clear them all to fall back to the fetch URL
- The **Push** dropdown appears once more than one remote is configured: push to a specific remote, push to every remote at once (with per-remote success / failure results), or jump into remote management. With a single remote the button looks and behaves exactly as before
- Deleting the remote that the current branch tracks automatically unsets the upstream, so later pulls don't trip over a dangling config

> Open it from the gear icon next to the remote URL in the status bar, or via **Manage remotes…** in the Push dropdown.

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

Create, manage, and run shell commands from the sidebar (Console view):

- Define commands with a name, shell command, and working directory
- Add **parameters** with names, descriptions, and default values (referenced via `{{paramName}}`)
- Run a command instantly in a new terminal session
- Save command **templates** for quick reuse
- Each command has its own **enable / disable** toggle so you can stage a suite of commands without running them

**Scheduled commit** (pinned to the bottom of the same sidebar): auto `git add -A` + `git commit` on an interval.

- Interval in minutes / hours / days, with an optional commit right on start
- Commit message: the configured default message, a per-schedule message, or AI-generated
- Push to the remote after every successful commit (can be turned off)
- The panel echoes the **equivalent `g` CLI command** — e.g. `g -y --interval=1800 --path="<dir>"` (`--interval` is in **seconds**) — with a one-click copy button, so the same schedule can be reproduced from a terminal without the GUI

---

### Flow Orchestration (Visual Workflow Designer)

Build automated pipelines with a drag-and-drop canvas:

| Node type | Purpose |
|---|---|
| **Start** | Entry point of the flow (one per flow, not deletable) |
| **Command** | Execute a saved custom command |
| **Wait** | Pause execution for 1–3600 seconds |
| **Version** | Bump `package.json` version (patch / minor / major) or modify a dependency |
| **Confirm** | Pause the flow and wait for the user to confirm before continuing |
| **User input** | Pause the flow and collect parameter values from the user |
| **Code** | Run an inline code snippet and pass its output to downstream nodes |
| **Condition** | Branch the flow according to a condition |

- Nodes are executed in topological order
- Flows are saved and editable
- Each node can be individually enabled or disabled

---

### NPM Scripts Panel

> The panel lives inside the Git view (left column). It scans every `package.json` in the repo on demand, groups scripts by package, and lets you click any script name to run it directly. The panel's own settings dialog configures the scan root and exclusion patterns.

- Automatically discovers all `package.json` files in the project tree
- Lists their `scripts` entries
- Run any script with one click
- Configure the scan root and exclusion patterns per package

---

### Console Panel

![Console panel — saved commands on the left, execution terminal on the right](https://raw.githubusercontent.com/xz333221/zen-gitsync/main/public/images/console-panel.png)

> Three-pane layout: saved custom commands on the left, **自定义指令执行** (saved custom commands + terminal sessions) tab on top, and a live terminal on the right. Click any saved command in the sidebar to launch it in a new terminal session; the terminal streams output in real time over SSE and supports running multiple sessions side by side. The `cmd.exe` shell is used on Windows, `sh` on Unix.

- Open new terminal sessions from within the GUI (one per command)
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

### Views at a glance

| View | Purpose | Persistent state | Highlights |
|---|---|---|---|
| **Git** | Day-to-day staging, committing, pushing, history review | Per-project UI prefs (view mode, layout ratios) | Structured commit form, AI commit message, selection-scoped quick push |
| **Editor** | Browse & edit project files without leaving the GUI | Open tabs, unsaved markers, recent files | Monaco editor with syntax highlighting, Markdown preview, file search |
| **Workbench** | Multi-project board for dispatching and running agent tasks | Tasks, prompts, board layout, log retention | Kanban board, master-agent console, executor choice, live chat-style logs |
| **Agent** | Chat with the built-in AI agent (web + CLI sessions) | Sessions, pending questions | Streaming answers, tool-call cards, Skill / MCP plaza |

**Console**, **System Monitor** and **Mindmap** are utility views on the same rail.

---

### Built-in Code Editor

A full IDE-like editor (fourth icon in the activity bar) for browsing and editing project files without leaving the tool:

| Feature | Description |
|---|---|
| File tree | Collapsible directory tree with file-type icons; **auto-refreshes every 15s** to pick up changes made outside the GUI (skipped when the tab is hidden or the search box is non-empty) |
| File search | Type in the sidebar search box to filter the tree (180 ms debounce); matched substrings are highlighted in node names; `Ctrl+F` / `Cmd+F` focuses the box; `Esc` clears the query or blurs the input |
| Multi-tab editing | Open multiple files simultaneously; tabs show unsaved (●) indicator |
| Monaco editor | Syntax highlighting for JS, TS, Vue, Python, Go, JSON, CSS, and more |
| Markdown preview | Toggle between source and rendered preview for `.md` files |
| Save | `Ctrl+S` to save; optional auto-save on focus loss |
| Create | New file or folder inline in the file tree |
| Rename / Delete | Rename or delete any file or folder directly from the tree |
| Resizable sidebar | Drag the divider to adjust file tree width |
| Theme sync | Editor theme follows the global light / dark setting |

---

### Workbench (Task-Driven Agent Execution)

![Workbench — multi-project board](https://raw.githubusercontent.com/xz333221/zen-gitsync/main/public/images/workbench-board.png)

> Three panes on one board: the project list with its run monitor on the left, a kanban board in the middle, and the **master-agent console** on the right. Type an instruction into the console — the master agent decides which project it lands in, or you can target the project you selected yourself. Clicking a card opens the task editor as an overlay over the board, which stays mounted underneath.

A dedicated view for running coding agents across one or many projects. Every task carries its own prompt preset, attachments and executor, and runs as its own detached process, so context never piles up.

| Feature | Description |
|---|---|
| Task list | Create, edit, delete tasks. Rows are grouped by project (current project first), each a single line — the title, or the first characters of the description (ellipsised) when the title is empty. Tasks with neither a title nor a description count as drafts that are never saved (switching away drops them) |
| Multi-project board | Three resizable / collapsible panes: the project list with its run monitor, the kanban board, and the master-agent console. Drag a divider to resize (project list 180–420 px, console 260–560 px), double-click it to reset the responsive default, or fold a side away — the top-bar button folds the project list, the console folds into a 32 px rail that expands on click. The run monitor has its own divider (120 px up to half the viewport height) for when several jobs run at once. All widths / heights are remembered across sessions |
| Kanban board | **Todo / Doing / Done** columns with the done column sorted newest-first; a filter checkbox narrows the board to tasks whose last run failed, and a table view is one click away for a denser listing |
| Master-agent console | Give the master agent an instruction and it dispatches a new task, deciding the target project itself (or honouring the project you selected). Enter dispatches, Shift+Enter starts a new line. Dispatching can be paused and resumed — while paused, a dispatch creates the task without running it |
| Dispatch default prompts | Give every dispatch a standing prompt: one **global** entry that applies to all projects, plus one **per project** that is appended after it whenever you dispatch to that project (it supplements the global one rather than replacing it). Both are edited from the gear button in the console's composer; the combined text is prepended to the instruction, a "Default prompt (global + this project)" checkbox appears next to **Run now** so a single dispatch can opt out, and the activity feed records which level was attached. The prompt is copied onto the task at dispatch time, so editing the setting later never rewrites tasks that already exist; it lands in the task's own prompt field, where you can still edit it per task |
| Open-with menu per project | Hovering a project row in the board's project list reveals two buttons: **Open folder** (straight to your file manager) and **Open with**, a menu holding file manager / terminal / `g ui` in a new tab plus every editor and AI tool (VS Code, Codex, OpenCode, Kimi Code, ZCode, DeepSeek Harness, and Claude Code in default or fully-approved mode). Tools that are not installed are dimmed and labelled "Not installed" — clicking one opens the very same install guide the top bar uses. Every action applies to that row's project only; the board's selection is never touched |
| Task editor overlay | Clicking a board card opens the editor as an overlay: a flat sidebar holding the task list and prompt presets, then the task header, preset selector, executor split-button, the execution-log / clear-execution actions, and a chat-style execution body. The description collapses into a one-line "Task description (optional)" summary until clicked, showing a "Filled" badge and the attachment count once there is content |
| Executor choice | Run each task with **Claude Code** or **OpenCode**. The global default is set in **Settings → General → Task executor** (`config.taskExecutor`); the split-button next to the run button switches it for the next run and remembers that pick in the browser. A continued conversation always stays on the executor that started it — Claude's `--resume` and OpenCode's `--session` ids are not interchangeable |
| Attachments | Up to 9 files per task (image / PDF / text / Markdown / CSV / JSON / log, ≤ 20 MB each); images over 3.5 MB are re-encoded / downscaled in the browser before upload so 4K screenshots still fit what the model and the reader can take. Their absolute paths are appended to the prompt so the agent reads them directly. Right-click an image attachment to copy it to the system clipboard (`image/png` / `jpeg` / `webp` / `gif`) |
| Prompt presets | Reusable prompt templates with `{{task.title}}` / `{{task.desc}}` / `{{repo.path}}` / `{{branch}}` variable interpolation |
| AI prompt generation | The "New / Edit preset" dialog carries an **AI Generate project architecture** button plus an **Edit instruction** button: the server recursively finds every sub-project (a directory holding `.git` or one of 9 manifests), reads each one's key files on its own (manifest 20 KB / README 8 KB / a 2-level tree), calls the LLM concurrently to produce a per-sub-project architecture description, and merges them into one when there are several. **Edit instruction** customises the prompt used for generation (persisted to `~/.zen-gitsync/ai-instruction.json`) |
| Pipe-mode launcher | Spawns the selected executor as a detached process with stdout/stderr piped to the server — no external terminal window is opened, so output streams directly into the UI. Claude Code runs as `claude -p - --output-format stream-json --verbose --permission-mode bypassPermissions --dangerously-skip-permissions` (the prompt goes in over stdin to dodge Windows' 32 K command-line limit); OpenCode runs as `opencode run --format json --auto --thinking`, following whatever default model OpenCode itself is configured with |
| Isolated processes | Every run is its own detached process with fresh context, so memory and conversation state never accumulate across tasks |
| Live log | The "执行日志 / Execution log" panel **opens by default** and auto-scrolls, showing accumulated `stdout` + `stderr` (last 64 KB rendered client-side; the server keeps up to 100 MB per job) |
| Live status | Task status (pending / running / done / error / cancelled) and PID stream in real time over SSE |
| Tool-call stream | The model's tool calls are rendered inline in the conversation flow, so you can follow what the agent actually did |
| Finish notice | When a run finishes or fails you get an in-app toast while the page is in the foreground, and a system notification when it is not — so you can be looking at another view or window and still be told |
| Cross-view indicator | While any Workbench task is running, a pulsing dot appears on the Workbench icon in the Activity Bar so you can see job state from the Git or Editor view |
| Execution log manager (dialog) | The "Execution logs" button in the workbench top bar opens a dialog with the list / filter / batch delete / clear / retention-policy UI (defaults: 500 records, 256 MB); the task execution view stays mounted so no work-in-progress state is dropped |
| Continue chat | After a task reaches a done / error / cancelled state, a follow-up composer appears; sending a message resumes the previous session (`claude --resume <session_id>` for Claude Code, `--session` for OpenCode), and each new turn stacks into the same chat-style flow |
| Local tool detection | On startup + every 10 min the server probes 7 CLIs (`code`, `claude`, `codex`, `opencode`, `kimi`, `zcode`, `dsh`). Tools that are missing are dimmed and labelled "Not installed" — clicking one opens the install guide, and right-clicking a tool button offers an update to the latest published version |

Prompt presets and tasks are persisted to `~/.zen-gitsync/prompts.json` and `~/.zen-gitsync/tasks.json` (cross-project, shared across repos); run history and the retention policy live in `jobs.json` / `jobs-config.json`, the master-agent console state in `orchestrator.json`, and task attachments under `~/.zen-gitsync/workbench-images/_task-<taskId>/`.

---

### AI Agent (Web)

A dedicated view (robot icon in the activity bar) for chatting with the built-in AI agent directly from the browser. The left sidebar lists all saved sessions (both Web and CLI origins); the right pane is a full chat interface with streaming responses, thinking process display, and tool-call visualization.

| Feature | Description |
|---|---|
| Session list | Browse, search, rename, and delete past conversations; sessions created via `g ai` in the terminal also appear here with a **CLI** badge |
| Live session entry | Sending the first message of a new session makes it show up in the list **immediately** with a "Generating..." badge, instead of waiting for the whole turn to finish; once the reply ends and the server persists the session, the entry is replaced by the real timestamp and message count |
| Streaming chat | SSE-based real-time streaming with thinking process, content, tool calls, and tool results rendered inline |
| Tool call display | Each tool invocation (run_command, read_file, edit_file, list_files, search_text, write_file) is shown as a collapsible card with arguments preview and execution result |
| Recent-projects awareness | Ask "which of my projects need a pull?" and the agent calls its built-in `list_projects` tool instead of scanning the disk: it returns exactly the list behind the GUI's **Recent projects** panel (recent directories plus any directory a task was created in, with branch / ahead / behind / uncommitted counts and task progress), so the agent's answer and the UI agree. Ahead/behind reads local refs, so the agent can pass `refresh=true` to run a `git fetch` pass first when the question is about pulling |
| Session persistence | All conversations are saved to `~/.zen-gitsync/agent-sessions/` as JSON files; the CLI agent (`g ai`) writes to the same directory so Web and CLI sessions are unified |
| Skill / MCP plaza | The **Skill plaza** and **MCP plaza** tabs list skills and MCP servers from several sources, each with its description, weekly downloads / usage count and install state. Install one into the **current project** or into the **`g ai` agent** — entries already installed can be uninstalled from the same card, and ones that still need environment variables are flagged. From a terminal, `g ai` lists what is installed with `/skills` (`/mcp` is an alias) |
| SSH-first cloning | When you ask it to clone a repo (or add a remote) it uses the SSH form — `git@github.com:owner/repo.git` / `git@gitee.com:owner/repo.git` — converting an `https://` URL first, so the clone never stalls on a Git Credential Manager username/password prompt; it falls back to https only when SSH genuinely fails (`Permission denied (publickey)` / host-key verification) and says which one it used. The same preference is injected into every workbench task, whose executor is an external CLI with a system prompt this app does not own |
| Per-turn tool limit | A single message may trigger up to N tool calls in a row (default **200**, range 1–2000). Configurable in **Settings → AI models → Agent Runtime**; hitting the limit ends the turn and asks you to send another message. The same setting drives the CLI agent |
| Preset questions | Quick-start buttons on the welcome screen for common tasks (view project structure, analyze code quality, write tests, check git status, start the project) |
| Stop generation | A floating stop button appears during streaming; aborts the LLM request and any running child processes |
| Theme sync | The chat area follows the GUI's current theme (light / dark / auto) |

---

### Settings

![User settings dialog — general tab](https://raw.githubusercontent.com/xz333221/zen-gitsync/main/public/images/settings-general.png)

> Click the gear icon in the top-right header. The dialog has six tabs — **General settings / AI models / Git global settings / Commit settings / Edit config / Editor settings** — and most toggles take effect immediately without restarting the GUI. Clicking the default-model name in the footer jumps straight to the **AI models** tab. Two things that used to live here have their own dialogs now: locked files are managed from the **Locked files** dialog in the Git view, and the npm scan root from the NPM scripts panel's settings.

| Tab | What's inside |
|---|---|
| General settings | Appearance (theme — light / dark / follow the system — and language), task execution (task executor, task-finish notifications) and UI options (file-list view, diff split ratio, AI diff explanation, command console, layout ratios) |
| AI models | OpenAI-compatible endpoints — API key, base URL, model name — with several entries side by side, a default model, plus the **Agent runtime** section holding the per-turn tool-call budget |
| Git global settings | `user.name` / `user.email`, auto-set upstream, pull strategy, auto-prune remote branches, line-ending handling, the default branch for `git init` |
| Commit settings | Standardised commit form, skip hooks (`--no-verify`), Enter-to-commit, auto-close the push modal, pull before push, auto-fill the default commit message |
| Edit config | Raw JSON editor for the config, plus a button to open the file on disk |
| Editor settings | Editor behaviour such as auto-save on focus loss |

---

### Self-Upgrade

The footer version chip in the GUI checks npm for newer releases once per session. When an update is available, a **Upgrade** button appears next to the version; clicking it streams `npm install -g zen-gitsync` output into a modal dialog. On success, the dialog switches to a "Restart and reload now" CTA. Clicking it calls `POST /api/app-restart`, which **self-respawns a new Node process** (no external launcher / desktop shell is required), waits for the new process to bind its port, streams that port back to the browser over NDJSON, and gracefully exits the old process. The browser then **redirects** to the new port (preserving the current path, query, and hash) so the upgraded backend serves the next request. The footer version also updates instantly to the new number so you can see the bump even before restarting. If the child process fails to come up within 15s, the old process is preserved and an error toast is shown — your session stays connected.

On macOS / Linux, the global install is run under `sudo -n` (non-interactive); if sudo can't authenticate non-interactively, re-launch the GUI with admin rights and try again.

---

## Development Notes

### Line endings

The repo ships a `.gitattributes` that locks source files to **LF** and Windows scripts (`.bat` / `.cmd` / `.ps1`) to **CRLF**. This takes precedence over `core.autocrlf`, so the working tree is identical on Windows, macOS, and Linux — generated files like `auto-imports.d.ts` and `components.d.ts` will not show up as "modified" just because the dev server rewrote them with different line endings.

If you change `.gitattributes` rules, renormalize the index in one shot:

```bash
git add --renormalize .
```

### Package manager

All `package.json` scripts use **npm** (`npm install`, `npm run dev`, `npm run release`, etc.). The `package-lock.json` is git-ignored, so each developer generates it locally. The CLI's own `bin` entry and most devDeps are pinned to caret ranges.

---

## CLI Commands

### AI coding agent (terminal):
Launch an interactive AI agent that writes code, runs commands, and commits for you.
It uses the default model configured in `g ui` (Settings → AI models). If no model is
configured yet, `g ai` launches an interactive setup wizard — pick a provider, choose a
model, enter your API key, test the connection, and you're ready to go.

```bash
$ g ai                          # interactive REPL
$ g ai "fix the failing test"   # one-shot task, then exit
$ g ai --model=2                # pick the 2nd configured model (index or name)
```

The first-run setup wizard and `/addmodel` provider/model lists support **↑↓ keys to switch
selection + Enter to confirm** (typing a number also jumps directly; `0` selects the trailing
"custom / manual input" entry). Non-TTY environments (CI, piped input) automatically fall back
to numeric input. `Esc` or `Ctrl+C` cancels the wizard cleanly.

`/skills` (alias `/mcp`) lists the skills and MCP servers already installed for the agent and
where they came from. Installation itself happens in the GUI's **Skill / MCP plaza** (Agent
view): pick the current project or the `g ai` agent as the target, and the entry becomes usable
from that side.

In-session commands: `/help`, `/model`, `/addmodel`, `/cd <path>`, `/image [path]`, `/think`, `/tools`, `/stats`, `/new`, `/resume`, `/skills` (`/mcp` is an alias), `/clear`, `/exit` (or `/quit`).

Reasoning, tool calls and answers have separate visual sections. Reasoning returned by the model is shown in full by default;
`/think full` restores full display, `/think off` hides it, and `/think compact` previews the first 12 nonblank lines. All three modes appear in the `/` menu and support completion after `/think `.
Tool output defaults to a few head/tail lines; `/tools full` shows subsequent tool results in full and
`/tools compact` restores compact output. These display settings do not reduce model token usage.

Each turn ends with completion time, total duration, first-token latency (including reasoning), first-answer
latency, model/tool durations and provider-reported input/output token usage across all model calls.
Cache and reasoning tokens are shown as subsets when reported. Missing or partial usage is labelled explicitly;
`/stats` also shows session totals. `Ctrl+C` stops an active task while keeping the conversation open.
Progress is saved after each tool result; `/resume` restores the working directory and reported usage.

Tool-call budget: one message may trigger up to N tool calls in a row before the turn is
force-ended with a "max tool iterations reached" notice (send another message to continue).
N defaults to **200** and is configurable in **Settings → AI models → Agent Runtime**
(`aiMaxToolIterations` in `~/.zen-gitsync/config.json`, range 1–2000) — the Web agent shares
the same value.

Images: press `Alt+V` in the REPL to paste a clipboard image (screenshot), or attach a
local file with `/image <path>`; images are sent as multimodal `image_url` parts with your
next message (requires a vision-capable model). `/image` alone lists pending images,
`/image clear` drops them.

The terminal UI follows the Codex / Claude Code style: boxed input composer, animated
waiting spinner, dim-italic streaming thinking, `⏺` tool blocks with smart argument
summaries, and lightweight Markdown rendering (bold, inline code, headers, code fences).

Permission model: everything inside the launch directory runs directly; other
directories are readable/writable too; only system-destroying commands
(disk format, `rm -rf /`, shutdown, ...) are hard-blocked by a built-in safety guard.

### Interactive commit:
```bash
$ g
Enter your commit message: fix login page style
```

### Commit directly (skip prompt):
```bash
$ g -y
```

### AI-generated commit (skip prompt):
```bash
$ g --ai                  # the model writes the message, then commit + push
$ g --ai --no-diff        # same, without printing the diff
$ g --ai --interval=600   # AI commit every 10 minutes
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

### Add helper scripts to `package.json`:
```bash
$ g addScript        # adds "g:y": "g -y"
$ g addResetScript   # adds "g:reset": "git reset --hard origin/<current-branch>"
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

`--repeat=daily` and `--at-repeat=daily` are aliases of `--daily`. Custom commands run in a
shell by default; add `--cmd-strict` to split the command into argv and run it through
`execFile` instead — pipes, redirection and globs then stop working, which is exactly the
point when you do not want shell interpretation.

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
  - [GitHub / Gitee 仓库](#github--gitee-仓库)
  - [快速切换目录](#快速切换目录)
  - [分支管理](#分支管理)
  - [远程仓库管理](#远程仓库管理)
  - [Stash 管理](#stash-管理)
  - [Tag 管理](#tag-管理)
  - [提交信息模板](#提交信息模板)
  - [自定义命令](#自定义命令)
  - [可视化流程编排](#可视化流程编排)
  - [NPM 脚本面板](#npm-脚本面板)
  - [控制台面板](#控制台面板)
  - [项目启动](#项目启动)
  - [视图一览](#视图一览)
  - [内置代码编辑器](#内置代码编辑器)
  - [工作台](#工作台任务驱动的智能体执行)
  - [智能体](#智能体web-端)
  - [设置](#设置)
  - [自升级](#自升级)
- [开发约定](#开发约定)
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
- **远程仓库管理** — 在一个弹窗里管理多个远程仓库（添加/重命名/改地址/删除）、配置多推送地址，并支持推送到指定远程或一键推送全部
- **仓库浏览器** — GitHub / Gitee 两个 Tab 列出 CLI 账号下的全部仓库（含私有），支持搜索、排序（最近推送 / 最近创建 / 星标最多 / 仓库名）与按工作空间分组，卡片带最近推送日期、Fork 数、默认分支与许可证
- **Stash 管理** — 储藏与恢复变更，支持排除锁定文件
- **Tag 管理** — 创建轻量/附注标签
- **合并支持** — 自动检测并引导完成进行中的合并
- **可视化流程编排** — 拖拽式工作流设计器
- **NPM 脚本面板** — 发现并运行 `package.json` 中的脚本
- **内置终端** — 实时流式输出的命令执行终端
- **自定义命令** — 保存、参数化并复用 Shell 命令
- **项目启动** — 打开项目时自动运行命令或工作流
- **内置代码编辑器** — 基于 Monaco 的文件编辑器，支持 Markdown 预览
- **工作台** — 多项目看板 + 主 Agent 派发控制台；任务驱动的智能体执行（Claude Code 或 OpenCode），支持提示词预置、任务级附件、独立进程、实时流式回传与 AI 生成预置提示词
- **仓库克隆** — 在仓库浏览器里把任意 GitHub / Gitee 仓库直接克隆到指定文件夹，卡片带「已克隆」徽标与本地路径（由全盘本地仓库扫描得出）
- **Skill / MCP 广场** — 在智能体页把 Skill 与 MCP 服务安装到当前项目或 `g ai` 智能体
- **重置到远程** — 在 Git 面板一键执行 `git reset --hard origin/<branch>`（点击前会先自动刷新分支信息，避免重置到陈旧分支）
- **AI 生成提交信息** — 基于 staged diff 自动生成提交消息
- **选择模式差异** — 当 Git 视图为当前激活标签时，AI 生成提交信息与一键提交/推送仅作用于当前勾选文件的 diff
- **提交模板** — 保存类型/范围/描述/完整提交信息模板
- **主题与语言** — 支持明/暗主题，中英文界面切换;header 一键切换主题(无需进入设置)
- **网络错误横幅** — 后端不可达时全局弹出横幅,支持一键重试与相对时间状态
- **可访问性(WCAG 2.1 AA)** — 弹窗焦点陷阱与归还、`role="separator"` 键盘可达的分隔条、纯键盘(`← → ↑ ↓`)调整面板宽度、屏幕阅读器友好的提交右键菜单、ARIA-pressed 切换按钮、提交按钮在提交过程中挂 `aria-busy`、Git 提交哈希在明/暗主题下对比度均 ≥ 4.5:1
- **更快的冷启动** — `monaco-editor` / `@vue-flow` / `flow-mindmap` / `dagre` 拆分为独立 chunk 并按需懒加载,Git 面板首屏不再等待代码编辑器或可视化流程编排模块

> 每个版本的详细变更可通过 `git log` 或 [GitHub Releases](https://github.com/xz333221/zen-gitsync/releases) 页面查看。

---

## GUI 界面

### 启动图形界面：
```shell
$ g ui
```

GUI 以本地 Web 服务器形式运行，自动在浏览器中打开，并附加到当前 Git 仓库。端口默认在 `4000–6000` 里挑第一个可用的（可用 `PORT` 固定）。左侧 Activity Bar 自上而下为 **Git** / **控制台** / **智能体** / **编辑器** / **工作台** / **系统监控** / **思维导图**。主界面长什么样可参考下方[核心 Git 面板](#核心-git-面板)的截图。

### 监听地址

GUI 服务默认只监听 `127.0.0.1`（回环地址）。服务当前没有认证层，一旦绑到 `0.0.0.0`，命令执行、写 `package.json`、用系统关联程序打开文件这类接口对同网段任何主机都是可调用的。

需要跨机访问（比如在另一台设备或 WSL 里打开）时，显式放开：

```shell
$ ZEN_HOST=0.0.0.0 g ui      # macOS / Linux
$ set ZEN_HOST=0.0.0.0 && g ui   # Windows cmd
$ $env:ZEN_HOST="0.0.0.0"; g ui  # PowerShell
```

放开后启动横幅会多一行黄色提示，提醒确认网络环境可信。用 `ZEN_HOST` 放开时，该地址会自动加入 Origin 白名单（`0.0.0.0` 表示所有网卡，此时本机各网卡地址的来源都会放行），否则从另一台设备访问会被下面的跨站守卫拦掉。

### 跨站请求守卫

监听收敛到回环地址之后，剩下的主要入口是本机浏览器里的恶意页面——跨站 `fetch` 或 DNS rebinding 都能打到这些接口上。服务没有认证层，所以对所有 `/api` 请求做 Origin 校验：

| 请求来源 | 结果 |
|---|---|
| 无 `Origin` 头（curl / CLI / 同源 GET） | 放行 |
| `localhost` / `127.0.0.1` / `[::1]` 的任意端口 | 放行（开发期前后端端口不同） |
| `file://` 页面（`Origin: null`） | 放行 |
| 其他任何来源 | 403 |

需要放开额外来源时用 `ZEN_ALLOWED_ORIGINS`（逗号分隔的完整 origin，含协议与端口）：

```shell
$ ZEN_ALLOWED_ORIGINS="https://zen.example.com,http://10.0.0.5:8080" g ui
```

### 一眼看懂架构

```
                  ┌─────────────────────────────────────────────┐
                  │  顶部条: 当前目录 · 主题 · 实例数            │
                  ├─────────────────────────────────────────────┤
                  │  Activity Bar(左侧导航)                     │
                  │  ┌───┐                                      │
                  │  │Git│────► Git 面板 (文件列表 + 提交)       │
                  │  └───┘                                      │
                  │  ┌──────┐                                   │
                  │  │控制 │──► 保存的命令 + 终端                 │
                  │  └──────┘                                   │
                  │  ┌──────┐                                   │
                  │  │智能 │──► Web 智能体 + Skill/MCP 广场      │
                  │  └──────┘                                   │
                  │  ┌──────┐                                   │
                  │  │编辑 │──► Monaco 编辑器 + 文件树           │
                  │  └──────┘                                   │
                  │  ┌──────┐                                   │
                  │  │工作 │──► 看板: 项目 · 看板 · 主 Agent     │
                  │  └──────┘                                   │
                  │  ┌──────┐                                   │
                  │  │监控 │──► 系统监控                         │
                  │  └──────┘                                   │
                  │  ┌──────┐                                   │
                  │  │导图 │──► 思维导图                         │
                  │  └──────┘                                   │
                  └─────────────────────────────────────────────┘
                       ▲              ▲              ▲
                       │              │              │
                  Pinia stores ──── EventBus ──── Socket.IO
                       ▲
                       │
                  后端 Express(4000–6000 中挑可用端口) → git / npm / shell
```

### GUI 典型一天

```
  1.  g ui              → 浏览器自动打开（4000–6000 中第一个可用端口）
  2.  看顶部条          → 当前目录 / 当前分支 / 实例数 / 主题切换
  3.  编辑文件          → Activity Bar → 编辑器,Ctrl+S 保存
  4.  暂存并提交        → Activity Bar → Git,勾选文件,填提交表单,推送
  5.  AI 生成提交信息   → 点击提交表单里的 ✨ AI 生成,基于 diff 生成
  6.  后台任务          → Activity Bar → 工作台,执行任务,实时日志
  7.  快速命令          → Activity Bar → 控制台 → 选保存的命令 → 执行
```

---

### 核心 Git 面板

![Git 面板 — 文件列表、结构化提交表单、提交历史](https://raw.githubusercontent.com/xz333221/zen-gitsync/main/public/images/git-panel-changes.png)

> 单屏覆盖"改了什么 → 要提交什么 → 已经提交了什么"。左侧按 已暂存 / 未暂存 / 未追踪 / 冲突 分组列出变更文件；右侧上半部分是结构化提交表单，下半部分是时间倒序的提交历史。80% 的日常操作不需要切换 tab。

| 功能 | 说明 |
|---|---|
| 文件列表 | 按已暂存/未暂存/未追踪/冲突分组显示所有变更文件；`git add -N` 的意向添加文件单独成一组「已声明添加（待暂存）」 |
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
| 差异内预览 | 在差异下方一键展开预览面板：`.html` / `.htm` / `.svg` 走沙箱化 iframe（允许 JS 执行，报告类页面的按钮/交互可用，同时以不透明 origin 与宿主应用隔离），`.md` / `.markdown` 走 Markdown 渲染，Office 文档（`.doc` / `.docx` / `.xls` / `.xlsx` / `.ppt` / `.pptx` / `.odt` / `.ods` / `.odp`）走服务端转换预览，与内置编辑器一致的预览体验；上下比例可拖拽，按项目持久化 |
| 提交日志 | 浏览历史提交（作者、时间、分支标签、变更文件） |
| 远程地址 | 显示并一键复制远程仓库 URL；旁边的齿轮图标打开 **远程仓库管理**（多远程、多推送地址） |
| 自动刷新 | 窗口获得焦点、标签页重新可见，或从 Activity Bar 切回 **Git** 视图时，自动静默刷新文件状态与分支信息 |

#### 结构化提交表单

提交表单支持通过开关切换两种模式：

- **标准模式** — 分别填写类型（`feat` / `fix` / `docs` / `style` / `refactor` / `test` / `chore`）、范围、简短描述、正文和页脚，自动组合成符合 Conventional Commits 规范的提交信息
- **自由模式** — 单一文本框，输入任意提交信息

两种模式下均可点击 **AI 生成** 按钮，根据当前 staged diff 自动填充提交信息。

---

### GitHub / Gitee 仓库

> Git 视图有三个 Tab：**当前项目**、**GitHub 仓库**、**Gitee 仓库**。后两个列出你的 `gh` / `gitee` 账号下能看到的全部仓库（含私有）。ZenGitSync 全程不接触你的令牌：面板调用的是官方 CLI（`gh`、`@gitee/gitee-cli`），凭据由 CLI 自己保管。

- **零配置引导** — 没装 CLI 时按平台给出安装命令（winget / Homebrew / `npm install -g @gitee/gitee-cli`），支持一键安装并自动刷新；装了但没登录时给出登录命令 + 一键登录，然后轮询等你走完终端里的交互流程
- **搜索** — 按仓库名、完整路径、描述过滤；顶部提示同时显示 `匹配 M / 共 N 个仓库`，一眼看出筛掉了多少
- **排序** — 最近推送（默认）/ 最近创建 / 星标最多 / 仓库名。排序在前端做，两个 Tab 口径一致 —— 它们的 CLI 并不一致（`gh` 按推送时间倒序，`gitee` 按 `owner/name` 字母序）
- **按工作空间分组** — 默认按 `owner` 分组，同一账号／组织下的仓库收拢在一起，不再被推送时间打散在整屏里；组间顺序跟随当前排序规则（最近有推送的空间排前面），组内同样排序，组头写明该空间下的仓库数（只有一个空间时不显示组头）。切到「不分组」即回到跨空间的平铺视图
- **切 Tab 不重拉** — 列表按账号各缓存一份，切回来直接渲染，不再重跑一遍 `gh repo list`；缓存超过一分钟后先用它画出来、再在后台静默刷新，点「刷新」则永远真的去拉
- **信息更全的卡片** — 仓库名、描述，以及私有 / Fork / 语言 / 星标徽标，第三行再给最近推送日期、Fork 数、非 `main` 的默认分支与许可证（没有的项直接省略，不留占位）
- **直接克隆到文件夹** — 本地还没有的仓库提供「克隆到文件夹」：选好目录即可开始克隆，走 SSH 形式（`git@github.com:owner/repo.git`），遇到 `https://` 地址会先归一化，不会再卡在 Git Credential Manager 的账密弹窗上
- **「已克隆」徽标** — 服务端维护一份全盘本地 Git 仓库索引（后台构建、也可随时手动重扫），因此本地已有的仓库卡片会直接标出本地路径，而不是再让你克隆一遍
- **一键打开 / 复制** — 点击卡片在浏览器打开仓库主页，悬浮时出现的按钮可复制地址或直接打开

---

### 快速切换目录

![切换目录弹窗](https://raw.githubusercontent.com/xz333221/zen-gitsync/main/public/images/directory-switcher.png)

> 点击顶部条里的目录名（或文件夹图标）即可弹出该对话框。直接输入路径、点击 **浏览** 唤起系统文件选择器，或从 **常用目录** 一键切换。**使用新标签打开** 会在新 GUI 标签里加载目标路径，原项目保持不动。

目录名旁边的顶部条自带一排快捷操作：在资源管理器中打开、在终端中打开、复制文件夹名称（只复制最后一级目录名）、用 `g ai` 打开，以及每个已检测到的编辑器 / AI 工具各一个按钮 —— VS Code、Codex、OpenCode、Kimi Code、ZCode、DeepSeek Harness 与 Claude Code（右键 Claude 按钮可选默认 / 完全批准，右键任意工具按钮可升级到最新版本）。没安装的工具会收进 **更多** 菜单，点一下弹出安装引导。

当 GUI 打开在一个**不是 Git 仓库**的目录上时，右侧会改为显示「最近项目」列表 —— 每个最近目录一张卡片，带 Git 徽标（落后 / 领先 / 未提交）与「在新标签页打开」。每次打开界面时会自动对所有项目跑一遍 `git fetch`，让「领先/落后」显示真实状态而不是上次 fetch 时的快照；**刷新全部** 按钮可以随时手动再刷一遍。

这份列表（以及切换目录弹窗里的 **常用目录**）在卡片下方还有一段说明。配置了 AI 模型时，它是模型根据刚刷新的状态写成的 **AI 项目状态解读**：一段话说清哪些项目该 pull、哪些有未推送的提交、哪些只是工作区脏了，全都同步干净时也会明确说明。它在「刷新全部」跑完的那一刻按状态生成一次（刷新途中不会生成），整页缓存复用，右侧带重新生成按钮；面板与弹窗共用同一份解读，打开弹窗不会多问一次模型。没配模型时退回一段静态说明，讲清徽标里的数字各是什么意思。

---

### 分支管理

- 查看所有本地和远程分支
- 从任意基础分支创建新分支
- 切换分支
- 追踪上游状态（领先/落后提交数）

---

### 远程仓库管理

- 在同一个弹窗里管理任意数量的远程仓库（`origin` / `upstream` / `backup` 等）：添加、重命名、修改地址、删除
- 逐个展示拉取地址与显式配置的推送地址，并用 **上游** / **默认推送** 标签标出当前分支跟踪的目标
- 单个远程可配置多个 **推送地址**（如 GitHub + Gitee 双备份），一次推送同时到达多个主机；全部清空则回落到拉取地址
- 配置了多个远程后，**推送** 按钮右侧会出现下拉：推送到指定远程、一键推送全部远程（逐条展示成功/失败结果），或直接进入远程管理。单远程时按钮外观与行为完全不变
- 删除当前分支上游所指向的远程时会自动解除上游跟踪，避免后续拉取因残留配置报错

> 从底部状态栏远程地址旁的齿轮图标进入，或使用推送下拉里的 **管理远程…**。

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

在侧边栏（控制台视图）创建、管理并运行 Shell 命令：

- 定义命令（名称、Shell 命令、工作目录）
- 添加**参数**（名称、描述、默认值，通过 `{{paramName}}` 引用）
- 一键在新终端会话中执行命令
- 保存**命令模板**快速复用
- 每条命令都有 **启用 / 禁用** 开关，可以在不立即运行的情况下预排一组命令

**定时提交**（固定在同一侧边栏底部）：按间隔自动 `git add -A` + `git commit`。

- 间隔可选分钟 / 小时 / 天，可设置启动时立即提交一次
- 提交信息：全局默认信息、本次自定义信息，或 AI 生成
- 每次提交成功后自动推送到远程（可关闭）
- 面板底部同步显示**等效的 `g` 命令行**（如 `g -y --interval=1800 --path="<目录>"`，`--interval` 单位为**秒**），带一键复制按钮，方便在终端里复现同一套定时任务

---

### 可视化流程编排

通过拖拽画布构建自动化流程：

| 节点类型 | 用途 |
|---|---|
| **开始节点** | 流程入口（每个流程唯一，不可删除） |
| **命令节点** | 执行一个已保存的自定义命令 |
| **等待节点** | 暂停执行 1–3600 秒 |
| **版本节点** | 修改 `package.json` 版本号（patch/minor/major）或依赖版本 |
| **用户确认** | 暂停流程，等用户确认后继续 |
| **用户输入** | 暂停流程并收集参数值 |
| **代码节点** | 执行一段内联代码，并把输出传给后续节点 |
| **条件** | 按条件分支 |

- 节点按拓扑顺序执行
- 流程可保存并二次编辑
- 每个节点可单独启用/禁用

---

### NPM 脚本面板

> 面板嵌在 Git 视图左下角。按需扫描仓库里的所有 `package.json`，按包分组列出 scripts，点击脚本名即可直接运行。扫描根路径与排除规则在面板自己的设置弹窗里配置。

- 自动扫描项目中所有 `package.json` 文件
- 列出其中的 `scripts` 条目
- 一键运行任意脚本
- 可配置扫描根路径和排除规则

---

### 控制台面板

![控制台面板 — 左侧保存的命令，右侧执行终端](https://raw.githubusercontent.com/xz333221/zen-gitsync/main/public/images/console-panel.png)

> 三栏布局：左侧是已保存的自定义命令，顶部是 **自定义指令执行**（已保存命令 + 终端会话）两个 tab，右侧是实时终端。点击侧边栏任意命令即可在新终端会话里执行；终端通过 SSE 实时回传输出，支持多个会话并行。Windows 用 `cmd.exe`，Unix 用 `sh`。

- 在 GUI 内直接打开新的终端会话（每条命令独立会话）
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

### 视图一览

| 视图 | 用途 | 持久化状态 | 高亮特性 |
|---|---|---|---|
| **Git** | 日常暂存、提交、推送、历史回看 | 每个项目的 UI 偏好（视图模式、布局比例） | 结构化提交表单、AI 生成提交信息、选择范围一键推送 |
| **编辑器** | 不离开 GUI 浏览并编辑项目文件 | 打开的 tab、未保存标记、最近访问 | Monaco 编辑器带语法高亮、Markdown 预览、文件搜索 |
| **工作台** | 多项目看板：派发并执行智能体任务 | 任务、提示词、看板布局、日志保留策略 | 看板视图、主 Agent 控制台、执行器选择、对话式实时日志 |
| **智能体** | 与内置 AI 智能体对话（Web + CLI 会话） | 会话、待回答问题 | 流式回答、工具调用卡片、Skill / MCP 广场 |

**控制台**、**系统监控**、**思维导图** 是同一导航栏上的辅助视图。

---

### 内置代码编辑器

Activity Bar 第四个视图，在 GUI 内直接浏览并编辑项目文件：

| 功能 | 说明 |
|---|---|
| 文件树 | 可折叠的目录树，附带文件类型图标；**每 15 秒自动刷新一次**，捕获 GUI 外部对文件的改动（标签页隐藏或搜索框非空时跳过） |
| 文件搜索 | 在侧边栏搜索框中输入关键字过滤文件树（180ms 防抖），命中片段会在节点名中高亮；`Ctrl+F` / `Cmd+F` 聚焦搜索框，`Esc` 清空内容或失焦 |
| 多标签页 | 同时打开多个文件，未保存文件显示 ● 标记 |
| Monaco 编辑器 | 支持 JS、TS、Vue、Python、Go、JSON、CSS 等语法高亮 |
| Markdown 预览 | `.md` 文件可切换源码与渲染预览模式 |
| 保存 | `Ctrl+S` 手动保存；可选失去焦点时自动保存 |
| 新建 | 在文件树中内联创建文件或文件夹 |
| 重命名 / 删除 | 在树中直接对文件或文件夹重命名、删除 |
| 侧边栏调整 | 拖拽分隔条自由调整文件树宽度 |
| 主题同步 | 编辑器主题跟随全局明/暗设置 |

---

### 工作台（任务驱动的智能体执行）

![工作台 — 多项目编排台](https://raw.githubusercontent.com/xz333221/zen-gitsync/main/public/images/workbench-board.png)

> 一块看板三栏：左侧项目列表（下方是执行监控），中间看板，右侧是 **主 Agent 控制台**。在控制台里写一条指令，由主 Agent 判断落到哪个项目，也可以先选中项目再指派。点击卡片时任务编辑器以浮层打开，看板保持挂载不丢状态。

面向单个或多个项目运行编码智能体：每个任务自带提示词预置、附件与执行器，各自跑在独立进程里，上下文不会跨任务累积。

| 功能 | 说明 |
|---|---|
| 任务列表 | 新建、编辑、删除任务；按项目分组（当前项目排在最前），每条任务只占一行 —— 有标题显示标题，没标题则显示描述前若干字符（超出省略）；标题和描述都没填的任务视为草稿，切走时直接丢弃、不落盘 |
| 多项目看板 | 三栏均可拖动 / 可折叠：项目列表（含执行监控）、看板、主 Agent 控制台。拖动分隔条调整宽度（项目列表 180–420 px、控制台 260–560 px），双击恢复响应式默认值；两侧也都能收起 —— 顶栏按钮收项目列表，控制台自己的按钮把它收成 32px 收纳条、点一下展开。项目列表下方的执行监控有独立分隔条（120 px ～ 视口高度一半），并行跑多个任务时上下拖动即可加高。所有宽高跨会话记住 |
| 看板视图 | **待处理 / 进行中 / 已完成** 三列，已完成列按完成时间倒序；顶部勾选可只看「最近一次执行报错」的任务；一键切换成表格视图，信息密度更高 |
| 主 Agent 控制台 | 写一条指令，主 Agent 派发成一个新任务，落点由它判断（或遵从此前选中的项目）；Enter 派发，Shift+Enter 换行。调度可暂停 / 恢复，暂停期间派发只建任务不执行 |
| 派发默认提示词 | 给每次派发配一段常驻提示词：一条**全局**的（所有项目都附加）+ 每个项目一条（派发到该项目时追加在全局之后，是补充而不是覆盖）。两者都在控制台输入区的齿轮按钮里设置；拼好的正文放在指令**之前**，「立即执行」旁边会多出一个「默认提示词（全局 + 本项目）」勾选，单次派发可以取消勾选，活动流里也记下这条指令附带的是哪一级。提示词在派发那一刻就抄进任务自己的提示词字段，之后改设置不会回头改写已建任务，单条任务仍可再改 |
| 项目行打开方式 | 编排台项目列表里 hover 任意一行会出现两个按钮：「打开文件夹」一键进资源管理器，以及「打开方式」菜单 —— 文件管理器 / 终端 / 新标签页跑 `g ui`，以及各编辑器与 AI 工具（VS Code、Codex、OpenCode、Kimi Code、ZCode、DeepSeek Harness，加上默认权限或完全批准的 Claude Code）。没安装的工具会置灰并标「未安装」，点它弹的是顶栏那套安装引导；菜单里的动作只作用于该行项目，不会改变看板选中态 |
| 任务编辑器浮层 | 点击看板卡片时以浮层打开：左侧是扁平化的任务列表与提示词预置，右侧依次是任务头部、预置下拉、执行器 split 按钮、「执行日志 / 清空执行」动作，以及对话式执行主体。描述默认折叠成一行「任务描述（可选）」摘要，点击展开；已填写描述或挂有附件时摘要右侧显示「已填写」徽标与附件数量 |
| 执行器选择 | 每个任务可用 **Claude Code** 或 **OpenCode** 执行。全局默认在 **设置 → 通用设置 → 任务执行器**（`config.taskExecutor`）；执行按钮旁的 split 按钮可临时切换下一次执行用的执行器，选择记在浏览器里。续聊固定沿用最初那个执行器 —— Claude 的 `--resume` 与 OpenCode 的 `--session` 会话 id 互不通用 |
| 附件 | 每个任务最多挂 9 个附件（图片 / PDF / 文本 / Markdown / CSV / JSON / log，单个 ≤ 20 MB）；超过 3.5 MB 的图片会先在浏览器里压缩（先按原分辨率转 WebP，压不下去再逐级降采样），4K 屏截图不用再手动裁剪；执行时绝对路径会自动追加到 prompt 末尾，智能体直接按路径读取。**右键图片附件可一键复制到系统剪贴板**（支持 png / jpeg / webp / gif） |
| 提示词预置 | 可复用提示词模板，支持 `{{task.title}}` / `{{task.desc}}` / `{{repo.path}}` / `{{branch}}` 变量插值 |
| AI 生成预置 | 「新建 / 编辑预置」对话框内置 **AI 生成项目架构说明** 按钮 + **编辑指令** 按钮：服务端递归识别当前项目里的所有子项目（含 `.git` 或 9 种 manifest 之一的目录），为每个子项目独立读取关键文件（manifest 20 KB / README 8 KB / 2 层目录树），并发调 LLM 产出各子项目架构说明，多子项目场景再合并成一份整体说明；用户可点「编辑指令」自定义生成策略（持久化到 `~/.zen-gitsync/ai-instruction.json`）；`max_tokens=4000`，单次请求最多 20 分钟 |
| 管道模式启动 | 选定执行器以 detached 进程拉起，stdout / stderr 通过管道回传服务端，不再弹外部终端窗口。Claude Code 走 `claude -p - --output-format stream-json --verbose --permission-mode bypassPermissions --dangerously-skip-permissions`（prompt 从 stdin 喂入，避开 Windows 32K 命令行上限）；OpenCode 走 `opencode run --format json --auto --thinking`，模型跟随 opencode 自身配置的默认值 |
| 独立进程 | 每次执行都是独立的 detached 进程，上下文与状态不会跨任务累积 |
| 实时日志 | 「执行日志」面板**默认展开**，方便随时回看上次执行结果；面板内自动滚到底，展示累积的 stdout / stderr（客户端渲染最近 64 KB，服务端单个 job 最多保留 100 MB 输出） |
| 实时状态 | 任务状态（pending / running / done / error / cancelled）和 PID 通过 SSE 实时推送 |
| 工具调用流 | 模型的工具调用直接渲染在对话流里，能看清智能体具体做了什么 |
| 结束提示 | 任务结束或报错时：页面在前台弹应用内提示，页面在后台/别的窗口发系统通知，切到别的视图也不会漏掉结果 |
| 跨视图指示 | 任意任务运行中时，Activity Bar 上的工作台图标会显示脉动小圆点；切换到 Git 或编辑器视图也能看到运行状态 |
| 执行日志管理（弹窗） | 顶部「执行日志」按钮唤起弹窗：列表 / 过滤 / 批量删除 / 清空 / 保留策略全部可在此一次性管理（默认保留 500 条、256 MB）；弹窗关闭后任务执行视图常驻，避免切换时不必要的卸载 |
| 继续对话 | 任务进入终态（done / error / cancelled）后出现续聊输入框；发送续聊消息会用 `claude --resume <session_id>`（Claude Code）或 `--session`（OpenCode）续接上一轮会话，**新一轮 = 新 job**，多轮纵向堆叠成对话流 |
| 本地工具检测 | 启动时 + 每 10 分钟探测 7 个 CLI（`code` / `claude` / `codex` / `opencode` / `kimi` / `zcode` / `dsh`）。未安装的工具置灰并标「未安装」，点击弹出安装引导；右键工具按钮可升级到最新已发布版本 |

提示词预置与任务数据持久化到 `~/.zen-gitsync/prompts.json` 和 `~/.zen-gitsync/tasks.json`（跨项目共享）；执行历史与保留策略在 `jobs.json` / `jobs-config.json`，主 Agent 控制台状态在 `orchestrator.json`，任务附件落盘在 `~/.zen-gitsync/workbench-images/_task-<taskId>/`。

---

### 智能体（Web 端）

Activity Bar 中的机器人图标视图，可直接在浏览器中与内置 AI 智能体对话。左侧边栏列出所有已保存的会话（含 Web 端和 CLI 端来源）；右侧为完整的对话界面，支持流式输出、思考过程展示和工具调用可视化。

| 功能 | 说明 |
|---|---|
| 会话列表 | 浏览、搜索、重命名、删除历史对话；通过 `g ai` 在终端创建的会话也会出现在这里，带 **CLI** 标记 |
| 会话实时入列 | 新会话发出第一条消息后，左侧列表**立刻**出现这一条（带「正在生成中…」标记），不用等整轮回答跑完；回答结束、服务端落盘后自动替换成真实的时间与条数 |
| 流式对话 | 基于 SSE 的实时流式输出，包含思考过程、正文内容、工具调用和工具结果的内联渲染 |
| 工具调用展示 | 每次工具调用（run_command、read_file、edit_file、list_files、search_text、write_file）以可折叠卡片形式展示，含参数预览和执行结果 |
| 最近项目感知 | 问「我哪些项目需要 pull」时，智能体调用内置的 `list_projects` 工具，而不是自己去扫盘：返回的就是 GUI「最近项目」面板那份清单（最近目录 + 建过任务的目录，带分支 / 领先 / 落后 / 未提交数与任务进度），回答与界面对得上。领先/落后读的是本地引用，因此问到"要不要拉"时它可以带 `refresh=true` 先联网 fetch 一轮再答 |
| 会话持久化 | 所有对话保存为 JSON 文件到 `~/.zen-gitsync/agent-sessions/`；CLI 智能体（`g ai`）写入同一目录，Web 端与 CLI 端会话统一管理 |
| Skill / MCP 广场 | **Skill 广场** 与 **MCP 广场** 两个 tab 列出多个来源的 Skill 与 MCP 服务，每项带说明、周下载 / 使用次数与安装状态。可安装到**当前项目**或 **`g ai` 智能体**；已安装的可在同一张卡片上卸载，还缺环境变量的会标出「还缺环境变量」。终端侧 `g ai` 用 `/skills`（`/mcp` 为别名）查看已装清单 |
| 克隆优先 SSH | 让它克隆仓库（或加远端）时走 SSH 形式 —— `git@github.com:owner/repo.git` / `git@gitee.com:owner/repo.git`；拿到 `https://` 地址先换算，克隆不会停在 Git Credential Manager 的账号密码弹窗上。只有 SSH 真的不可用（`Permission denied (publickey)` / 主机密钥校验失败）才退回 https，并说明这次走的是哪条。同一条偏好也会注入到每个工作台任务的 prompt —— 那里执行器是外部 CLI，系统提示词不归本应用管，环境上下文块是唯一的注入口 |
| 单轮工具调用上限 | 一条消息内智能体最多连续调用多少次工具（默认 **200**，可调范围 1–2000）。在 **设置 → AI 模型配置 → 智能体运行时** 中修改；达到上限本轮会被强制结束并提示再发一条消息继续。CLI 智能体共用同一项设置 |
| 预设问题 | 开场界面提供快捷按钮（查看项目结构、分析代码质量、写测试、Git 状态检查、帮我启动项目）|
| 停止生成 | 流式输出期间出现浮动停止按钮；中止 LLM 请求及正在运行的子进程 |
| 主题同步 | 对话区域跟随 GUI 当前主题（浅色 / 深色 / 自动）|

---

### 设置

![用户设置弹窗 — 通用 tab](https://raw.githubusercontent.com/xz333221/zen-gitsync/main/public/images/settings-general.png)

> 点击顶部条右上角齿轮图标。弹窗共 6 个 tab —— **通用设置 / AI 模型配置 / Git 全局设置 / 提交设置 / 编辑配置 / 编辑器设置**，大部分开关即时生效，无需重启 GUI。点击底栏的 **默认模型** 名称可一键定位到「AI 模型配置」tab。原先放在这里的两项现在各有自己的入口：锁定文件在 Git 视图的 **锁定文件管理** 弹窗里管理，npm 扫描根路径在 NPM 脚本面板自己的设置弹窗里配置。

| tab | 内容 |
|---|---|
| 通用设置 | 外观（主题 —— 浅色 / 深色 / 跟随系统，以及界面语言）、任务执行（任务执行器、任务完成提示），以及界面选项（文件列表视图、文件差异分割、AI 差异说明、命令控制台、布局比例） |
| AI 模型配置 | 兼容 OpenAI 协议的模型端点 —— API Key、baseURL、模型名，可多套并存并设置默认模型；另有 **智能体运行时** 存放单轮工具调用上限 |
| Git 全局设置 | `user.name` / `user.email`、自动设置上游、拉取策略、自动清理远程分支、换行符处理、`git init` 默认分支 |
| 提交设置 | 标准化提交、跳过钩子检查（`--no-verify`）、回车自动提交、Push 完成自动关闭、推送前拉取更新、自动填充默认提交信息 |
| 编辑配置 | 直接编辑配置 JSON，并可打开系统配置文件 |
| 编辑器设置 | 编辑器行为，例如失去焦点时自动保存 |

---

### 自升级

GUI 底栏版本号每个会话会向 npm 查询一次最新版本。检测到更新时版本旁会出现 **升级** 按钮，点击后在弹窗里实时回传 `npm install -g zen-gitsync` 的输出；升级成功后弹窗会切换为「**立即重启并刷新**」主 CTA。点击后调用 `POST /api/app-restart`，后端**自行 spawn 新 Node 进程**（不依赖任何外层 launcher / 桌面壳），通过 NDJSON 流把新进程端口推回前端，旧进程再优雅退出；浏览器**重定向**到新端口（保留当前 path、query、hash）由新后端服务后续请求。同时底栏版本号会立刻刷新到新版本号，重启前就能看到。若子进程 15 秒内未就绪，旧进程不退出并弹错误提示，您的会话保持连接。

> macOS / Linux 上全局安装需要 sudo，前端会用 `sudo -n` 非交互式尝试；如非免密 sudo，请以管理员权限重启 GUI 后再试。

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

### AI 编码智能体（终端）：
启动交互式 AI 智能体，自动写代码、跑命令、提交代码。
默认使用 `g ui` 中配置的模型（设置 → AI 模型）。如果尚未配置任何模型，`g ai` 会启动
交互式配置向导 —— 选择服务商、选择模型、输入 API Key、测试连接，完成后即可直接使用。

```bash
$ g ai                          # 交互式 REPL
$ g ai "修复失败的测试"           # 单发模式：执行一轮后退出
$ g ai --model=2                # 使用第 2 个已配置的模型（序号或名称）
```

启动配置向导与 `/addmodel` 的"服务商 / 模型"列表支持 **↑↓ 键切换 + Enter 确认**（也可
直接输入数字跳转，`0` = 列表底部的"自定义 / 手动输入"）；非 TTY 环境下自动回退为数字输入。
`Esc` 或 `Ctrl+C` 一键取消整个向导。

`/skills`（`/mcp` 为别名）列出智能体当前已安装的 Skill 与 MCP 服务及来源。安装本身在 GUI 的
**Skill / MCP 广场**（智能体视图）里完成：选择安装到当前项目或 `g ai` 智能体，装好后对应一侧即可使用。

会话内命令：`/help`、`/model`、`/addmodel`、`/cd <路径>`、`/image [路径]`、`/think`、`/tools`、`/stats`、`/new`、`/resume`、`/skills`（`/mcp` 为别名）、`/clear`、`/exit`（或 `/quit`）。

思考、工具调用和回答分区展示。默认完整显示模型返回的思考，`/think full` 恢复完整显示，
`/think off` 隐藏思考，`/think compact` 切换为前 12 行非空预览。三种模式均直接列在 `/` 菜单中，输入 `/think ` 后也可补全。
工具结果默认保留头尾几行，
`/tools full` 显示后续完整工具结果，`/tools compact` 恢复精简。这些显示设置不会减少模型的 Token 消耗。

每轮结束显示完成时间、总耗时、首响应（含思考首字）、正文等待、模型与工具耗时，以及本轮所有模型调用的
输入 / 输出 Token 总量；服务端提供时还显示其中的缓存与推理 Token。用量来自服务端真实返回，
缺失或不完整时明确标注；`/stats` 还可查看会话累计用量。执行中按 `Ctrl+C` 停止当前任务并保留会话。
每个工具结果后保存进度，`/resume` 同时恢复工作目录和用量统计。

工具调用预算：一条消息内智能体最多连续调用 N 次工具，触顶后本轮被强制结束并提示
"已达单轮最大工具调用次数"，再发一条消息即可继续。N 默认 **200**，可在
**设置 → AI 模型配置 → 智能体运行时** 修改（即 `~/.zen-gitsync/config.json` 的
`aiMaxToolIterations`，范围 1–2000），Web 端智能体共用同一项设置。

图片：在 REPL 中按 `Alt+V` 粘贴剪贴板图片（截图），或用 `/image <路径>` 附加本地图片；
图片以多模态 `image_url` 部件随下一条消息发送（需视觉模型）。单独 `/image` 查看待发送图片，
`/image clear` 清除。

终端 UI 对标 Codex / Claude Code 风格：盒式输入框、等待 spinner、灰斜体流式思考、
`⏺` 工具块 + 智能参数摘要、轻量 Markdown 渲染（加粗、行内代码、标题、代码块）。

权限模型：启动目录内所有操作直接执行；其他目录同样可读写；仅系统级破坏命令
（格式化磁盘、`rm -rf /`、关机等）由内置安全守卫硬拦截。

#### 交互式提交：
```bash
$ g
请输入你的提交信息: 修复了登录页样式问题
```

#### 直接提交（跳过输入）：
```bash
$ g -y
```

#### AI 生成提交信息并提交（跳过输入）：
```bash
$ g --ai                  # 模型写好提交信息，然后提交 + 推送
$ g --ai --no-diff        # 同上，但不打印 diff
$ g --ai --interval=600   # 每 10 分钟用 AI 提交一次
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

#### 向 `package.json` 写入快捷脚本：
```bash
$ g addScript        # 写入 "g:y": "g -y"
$ g addResetScript   # 写入 "g:reset": "git reset --hard origin/<当前分支>"
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

`--repeat=daily` 与 `--at-repeat=daily` 是 `--daily` 的别名。自定义命令默认在 shell 里执行；
加 `--cmd-strict` 后会拆成 argv 走 `execFile`，管道 / 重定向 / 通配符随之失效 —— 当你不希望
命令被 shell 解释时，这正是想要的效果。

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
