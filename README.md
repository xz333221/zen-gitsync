# zen-gitsync

[English](#zen-gitsync) | [中文](#zen-gitsync-1)

A Git automation platform with interactive commits, scheduled sync, custom command orchestration, file locking, and a visual GUI.

## Installation

Install globally via npm:

```bash
npm install -g zen-gitsync
```

## v2.x.x
- Added graphical user interface (GUI) mode
- Support for standardized commit message format

### Launch GUI:
```shell
$ g ui
```
![ui](https://home.flowdash.cn/upload/VditorFiles/2026-1/image_zbQZpiL6.png)

### Command Orchestration

![Command Orchestration](https://home.flowdash.cn/upload/VditorFiles/2026-1/zen-gitsync_SBAJdlvm.png)

### Commands

#### Interactive commit:
```bash
$ g
Enter your commit message: fix login page style
```

#### Commit directly (skip prompt):
```bash
$ g -y
```

#### Set default commit message:
```bash
$ g --set-default-message="update"
```

#### Get current config:
```bash
$ g get-config
```

#### Commit with inline message:
```bash
$ g -m <message>
$ g -m=<message>
```

#### Show help:
```shell
$ g -h
$ g --help
```

#### Scheduled auto-commit (default interval: 1 hour):
```bash
$ g -y --interval
$ g -y --interval=<seconds>
```

#### Specify working directory:
```bash
$ g --path=<path>
$ g --cwd=<path>
```

#### Sync a folder in background (Windows cmd):
```shell
start /min cmd /k "g -y --path=<your-folder> --interval"
```

#### Scheduled command execution (Windows cmd):
```shell
start /min cmd /k "g --cmd=\"echo hello\" --cmd-interval=5"     # run every 5 seconds
start /min cmd /k "g --cmd=\"echo at-time\" --at=23:59"         # run once at 23:59
start /min cmd /k "g --cmd=\"echo daily\" --at=23:59 --daily"   # run daily at 23:59
```

#### Suppress git diff output:
```shell
$ g --no-diff
```

#### Print formatted git log:
```shell
$ g log
$ g log --n=5
```

#### File locking (only effective within the tool):
```shell
# Lock a file (locked files are excluded from commits)
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

## v2.x.x
- 新增图形用户界面（GUI）模式
- 支持标准化的提交信息格式

### 启动图形界面：
```shell
$ g ui
```
![ui](https://home.flowdash.cn/upload/VditorFiles/2026-1/image_zbQZpiL6.png)

### 命令编排

![命令编排](https://home.flowdash.cn/upload/VditorFiles/2026-1/zen-gitsync_SBAJdlvm.png)

### 命令列表

#### 交互式提交：
```bash
$ g
请输入你的提交信息: 修复了登录页样式问题
```

#### 直接提交（跳过输入）：
```bash
$ g -y
```

#### 设置默认提交信息：
```bash
$ g --set-default-message="提交"
```

#### 获取当前配置：
```bash
$ g get-config
```

#### 传入 message 直接提交：
```bash
$ g -m <message>
$ g -m=<message>
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

#### 后台同步文件夹（Windows cmd）：
```shell
start /min cmd /k "g -y --path=你要同步的文件夹 --interval"
```

#### 定时执行命令（Windows cmd）：
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
# 锁定文件（锁定后的文件不会被包含在提交中）
$ g --lock-file=config.json

# 解锁文件
$ g --unlock-file=config.json

# 查看所有锁定的文件
$ g --list-locked

# 检查文件是否被锁定
$ g --check-lock=config.json
```
