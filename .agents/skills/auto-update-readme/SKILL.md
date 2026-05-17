---
name: auto-update-readme
description: zen-gitsync 专属 README 自动维护 skill。每次新增功能或修改现有功能后，对比 README.md 与本轮实际改动，判断文档是否需要补充或更新，并在提交前完成双语（英文 + 中文）同步更新。适用触发词：更新文档、更新 README、check readme、文档同步。
---

# zen-gitsync README 自动维护流程

## 触发时机

满足以下**任意一个**条件时执行本 skill：

1. 用户主动要求（"更新 README"、"更新文档"、"check readme"等）
2. 本轮对话完成了**新功能开发**或**现有功能的重要改动**，且 auto-validate 已通过

> 纯重构、样式调整、依赖升级、配置变更、测试代码，**不触发**本 skill。

---

## 步骤 1 — 读取并理解当前 README

```
read_file("e:\workspace\xz333221_space\zen-gitsync\README.md", startLine: 1, endLine: 100)
```

重点识别：
- 英文 TOC（`## Table of Contents`）中已有哪些章节
- 中文目录（`## 目录`）中已有哪些条目
- 各功能章节已描述的内容边界

---

## 步骤 2 — 分析本轮改动

对照本轮对话中实际修改/新增的文件，提炼以下信息：

| 维度         | 要提炼的内容                                         |
|--------------|------------------------------------------------------|
| 功能名称     | 这个功能叫什么，用一句话描述                         |
| 所属模块     | 归属 GUI 的哪个子面板，还是 CLI、配置、服务端        |
| 用户可见行为 | 用户能看到/操作什么（按钮、交互、显示条件等）        |
| 触发条件     | 功能何时出现（如"仅工作区有变更时显示"）             |

---

## 步骤 3 — 判断 README 是否需要更新

逐项检查：

- [ ] 新功能是否已在英文 TOC 中列出？
- [ ] 新功能是否已在中文目录中列出？
- [ ] 对应章节是否已有描述？描述是否准确反映当前实现？

**判断结论：**
- **无需更新**：README 已完整描述该功能 → 告知用户"README 无需更新"，直接结束
- **需要更新**：有遗漏或描述过时 → 进入步骤 4

---

## 步骤 4 — 定位插入/修改位置

### README 结构约定

```
# zen-gitsync              ← 英文标题（GitHub 锚点 #zen-gitsync）

## Table of Contents       ← 英文目录
## Installation
## v2.x.x — What's New
## GUI
  ### Core Git Panel
  ### Branch Management
  ### Stash Management
  ### Tag Management
  ### Commit Message Templates
  ### Custom Commands
  ### Flow Orchestration
  ### NPM Scripts Panel
  ### Built-in Terminal
  ### Project Startup
  ### Built-in Code Editor
  ### Source Map
  ### Settings
## CLI Commands

---

<a name="zh"></a>

# zen-gitsync              ← 中文标题

## 目录                    ← 中文目录
## 安装
## v2.x.x — 更新内容
## 图形界面 (GUI)
  ### 核心 Git 面板
  ### 分支管理
  ### 储藏管理
  ### 标签管理
  ### 提交信息模板
  ### 自定义命令
  ### 流程编排
  ### NPM 脚本面板
  ### 内置终端
  ### 项目启动
  ### 内置代码编辑器
  ### Source Map（代码库可视化）
  ### 设置
## CLI 命令
```

### 定位规则

| 新功能归属         | 插入位置                                    |
|--------------------|---------------------------------------------|
| GUI 子面板         | `### GUI` 区块下，对应或相邻 `###` 章节处  |
| 核心 Git 操作      | `### Core Git Panel` / `### 核心 Git 面板` |
| CLI 新命令         | `## CLI Commands` / `## CLI 命令` 末尾     |
| 全局新特性         | `## What's New` / `## 更新内容` 首条       |

---

## 步骤 5 — 编写更新内容

### 写作标准

- **简洁**：每个功能点用 1–3 句话说明，附必要的触发条件
- **并列格式**：与同章节其他功能保持同级列表或段落风格
- **不重复**：只描述本功能独有的能力，不重述已有说明
- **双语同步**：英文和中文内容**同步更新**，缺一不可

### 语言风格参考

```markdown
<!-- 英文示例 -->
- **Stash → Pull → Stash Pop**: A one-click button (visible only when the working tree has changes)
  that stashes current changes, pulls remote updates, then pops the stash — keeping your work safe
  during pulls.

<!-- 中文示例 -->
- **储藏后拉取（Stash → Pull → Stash Pop）**：仅在工作区有未提交更改时显示的一键操作按钮，
  依次执行储藏 → 拉取 → 还原储藏，在拉取时无需手动处理本地更改。
```

---

## 步骤 6 — 执行文件修改

使用 `replace_string_in_file` 或 `multi_replace_string_in_file` 精确插入内容：

- 英文章节和中文章节**分两次**替换（或合并为一次 multi_replace）
- 若同时需要更新 TOC/目录，也一并替换
- **不改动**其他无关章节的内容
- 修改后用 `get_errors` 确认 README 无语法错误

---

## 步骤 7 — 纳入本轮提交

README 更新后：

1. 将 `README.md` 加入本轮 `git add` 列表（与功能代码同一次提交，或单独提交）
2. 单独提交时使用 `docs(readme): 补充 <功能名> 文档` 格式
3. 与功能代码同提交时，提交信息优先反映功能，README 变更视为附带

---

## 约束

- **禁止**在判断"无需更新"后仍修改 README
- **禁止**删除或改写现有已准确的内容
- **禁止**添加与本轮改动无关的章节
- README 中文和英文内容**必须同步**，不允许只更新一种语言
- 若 README 结构发生较大变动（如新增顶级章节），需告知用户并确认
