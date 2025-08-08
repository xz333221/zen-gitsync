# zen-gitsync

`zen-gitsync` 是一个简单的命令行工具，用于自动化 Git 提交和推送操作。只需在控制台输入 `g`，并输入提交内容，即可自动执行 `git add`、`git commit` 和 `git push` 操作，极大提升 Git 工作流程的效率。

## 安装

通过 npm 安装 `zen-gitsync`，并进行全局安装：

```bash
npm install -g zen-gitsync
```

## 使用方法

1. 在终端中，输入 `g` 并按回车。
2. 输入提交信息，按回车确认提交。
3. 工具将自动查看远程分支并自动提交


### 示例：
#### 交互式提交：
```bash
$ g
请输入你的提交信息: 修复了登录页样式问题
```
#### 直接提交：
```bash
$ g -y
```
#### 设置默认提交信息：
```bash
$ g --set-default-message="提交"
```
#### 获取默认提交信息：
```bash
$ g get-config
```
#### 传入message直接提交：
```bash
$ g -m <message>
$ g -m=<message>
```

#### 查看帮助
```shell
$ g -h
$ g --help
```

#### 文件锁定功能
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

#### 定时执行自动提交，默认间隔1小时
```bash
$ g -y --interval
$ g -y --interval=<seconds> 
```
#### 指定目录提交
```bash
$ g --path=<path> 
```
或
```bash
$ g --cwd=<path> 
```

#### 添加项目script
```json
{
   "scripts": {
      "g:y": "g -y"
   }
}
```

#### cmd同步文件夹
```shell
start /min cmd /k "g -y --path=你要同步的文件夹 --interval"
```

#### cmd 定时执行命令
```shell
start /min cmd /k "g --cmd=\"echo hello\" --cmd-interval=5"     # 每5秒执行一次echo hello
start /min cmd /k "g --cmd=\"echo at-time\" --at=23:59" # 在23:59执行一次echo at-time
```

#### 不显示git diff内容
```shell
$ g --no-diff
```

#### 格式化打印git log
```shell
$ g log
$ g log --n=5
```

## ✨ 新特性 (v2.0.0)
- 新增图形用户界面(GUI)模式
- 支持标准化的提交信息格式

### 启动图形界面：
```shell
$ g ui
```
![Zen GitSync UI](https://raw.githubusercontent.com/xz333221/zen-gitsync/main/public/images/zen-gitsync-ui.png)

## 🔒 文件锁定功能

文件锁定功能允许您临时排除某些文件不被包含在 Git 提交中，而无需修改 `.gitignore` 文件。这对于以下场景特别有用：

- 临时排除配置文件（如包含敏感信息的配置）
- 跳过正在开发中的实验性文件
- 避免提交临时的调试文件

### 特点：
- ✅ 不修改 `.gitignore` 文件
- ✅ 支持命令行和 Web UI 操作
- ✅ 锁定状态持久保存
- ✅ 支持相对路径和绝对路径
- ✅ 自动跳过锁定文件，显示清晰的提示信息

### 使用场景示例：
```shell
# 锁定配置文件，避免提交敏感信息
$ g --lock-file=.env

# 锁定正在开发的功能文件
$ g --lock-file=src/experimental-feature.js

# 查看当前锁定的文件
$ g --list-locked

# 开发完成后解锁文件
$ g --unlock-file=src/experimental-feature.js
```
