---
name: auto-commit
description: zen-gitsync 专属 Git 自动提交 skill。大模型完成一轮代码修改并通过全部验证（get_errors / TSC / i18n）之后，立即执行 Git 暂存 → 生成符合项目风格的 Conventional Commits 提交信息 → git commit。每次涉及代码修改的回答结束、验证全部通过后必须自动执行，无需用户主动触发。适用触发词：提交代码、git commit、自动提交、commit 一下、帮我提交。
---

# zen-gitsync 自动 Git 提交流程

## 触发时机

满足以下**全部**条件时执行本 skill：

1. 本轮对话涉及代码修改（`replace_string_in_file` / `multi_replace_string_in_file` / `create_file`）
2. auto-validate skill 的所有检查已通过（get_errors 无报错、TSC 无新增错误、i18n 合规）

> 以上条件满足后**无需用户说"提交"等触发词，必须自动执行**。
> 若验证尚未通过，**禁止提交**，先修复再提交。

---

## 步骤 1 — 收集变更文件

运行以下命令，获取本次会话相关的修改/新增文件：

```bash
cd e:\workspace\xz333221_space\zen-gitsync
git status --short
```

从输出中筛选出**本轮修改**相关的文件（对照本次对话中实际改过的路径）。

---

## 步骤 2 — 暂存文件

对本次改动的文件执行 `git add`：

```bash
git add <file1> <file2> ...
```

**原则：**
- 只 add 本轮实际修改/新建的文件，不要 `git add .`
- 不暂存与本次任务无关的文件（如未改动的测试文件、第三方文件）

---

## 步骤 3 — 生成提交信息

按照项目的 **Conventional Commits** 风格生成一行提交信息：

```
<type>(<scope>): <简洁的中文描述>
```

### type 选择规则

| 变更类型           | type       |
|--------------------|------------|
| 新功能             | `feat`     |
| Bug 修复           | `fix`      |
| 样式/CSS 调整      | `style`    |
| 重构（不改功能）   | `refactor` |
| 性能优化           | `perf`     |
| 测试相关           | `test`     |
| 构建/依赖/脚本     | `chore`    |
| 文档               | `docs`     |
| 国际化             | `i18n`     |

### scope 选择规则

取修改最集中的模块目录名，例如：
- 改了 `src/ui/client/src/views/SourceMapView.vue` → scope = `source-map`
- 改了 `src/ui/server/routes/codeAnalysis.js` → scope = `code-analysis`
- 同时改前端后端 → scope = 最核心的那个，或省略括号

### 示例

```
feat(source-map): 用扁平 flatTree 替换递归 SmTreeNode 文件树
fix(code-analysis): 添加程序化子系统检测，不再依赖纯 AI 识别
style(source-map): 文件树样式与 EditorView 保持一致
```

---

## 步骤 4 — 执行提交

```bash
cd e:\workspace\xz333221_space\zen-gitsync
git commit -m "<生成的提交信息>"
```

提交后，输出 `git log --oneline -1` 确认提交成功，并将提交 hash 和信息告知用户。

---

## 步骤 5 — 询问是否推送

提交完成后，**主动询问用户**是否需要推送到远端：

> "已提交 `<hash> <message>`，是否推送到 origin/main？"

- 用户确认后执行：`git push origin main`（或当前分支）
- 用户拒绝则停止，不主动推送

---

## 约束与禁令

- **禁止** `git add .` 或 `git add -A`（防止暂存无关文件）
- **禁止**在验证未通过时提交
- **禁止** `--no-verify`（不绕过 git hooks）
- **禁止** `git push --force`
- 提交信息必须是**中文描述**，type/scope 保留英文
- 若 `git status` 显示无变动文件，告知用户"工作区无待提交内容"，终止流程
