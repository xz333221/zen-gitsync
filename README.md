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

# Zen GitSync 功能说明

## 自动文件监控与状态更新

Zen GitSync现在支持自动文件监控和状态更新功能：

- 当Git仓库内的文件发生变动时，系统会自动检测并更新Git状态
- 采用防抖(debounce)技术，避免频繁变动导致的性能问题
- 用户可以通过界面上的开关随时启用或禁用自动更新功能
- 设置会自动保存，下次打开应用时仍然生效

### 使用方法

1. 在Git状态面板的顶部有一个开关按钮，用于切换自动更新状态
2. 绿色表示自动更新已启用，灰色表示已禁用
3. 即使禁用了自动更新，用户仍然可以通过刷新按钮手动更新状态

### 技术说明

该功能使用以下技术实现：
- 服务端使用chokidar监控文件系统变化
- 使用Socket.IO实现服务器与客户端的实时通信
- 采用1000ms防抖延迟，优化性能并避免重复更新

### 注意事项

- 自动监控只会监控Git工作目录下的文件变动
- 监控器会自动过滤.git目录、node_modules目录和隐藏文件
- 在大型仓库中可能会增加服务器资源消耗