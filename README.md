# zen-gitsync

`zen-gitsync` 是一个工作平台工具，集成部分 git 功能，可自定义命令，编排命令，设置自启动

## 安装

通过 npm 安装 `zen-gitsync`，并进行全局安装：

```bash
npm install -g zen-gitsync
```

## v2.x.x
- 新增图形用户界面(GUI)模式
- 支持标准化的提交信息格式

### 启动图形界面：
```shell
$ g ui
```
### 其他命令：
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
#### 文件锁定功能(仅在工具中有效)

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
