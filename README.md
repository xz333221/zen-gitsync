
# zen-gitsync

`zen-gitsync` 是一个简单的命令行工具，用于自动化 Git 提交和推送操作。只需在控制台输入 `g`，即可自动执行 `git add`、`git commit` 和 `git push` 操作，极大提升 Git 工作流程的效率。

## 特性

- 一键执行 `git add`、`git commit`、`git push`
- 使用交互式命令行输入提交信息
- 提交信息颜色随机显示

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

```bash
$ g
请输入你的提交信息: 修复了登录页样式问题
```

完成提交后，你会看到一个随机颜色的提交信息确认
