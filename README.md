
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
3. 工具将自动执行以下操作：
    - `git add .`
    - `git commit -m "你的提交信息"`
    - `git push`

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
#### 定时执行自动提交，默认间隔1小时
```bash
$ g -y --interval
$ g -y --interval=秒数 
```
#### 指定目录提交
```bash
$ g --path=./
```
或
```bash
$ g --cwd=./
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
