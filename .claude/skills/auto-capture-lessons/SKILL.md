---
name: auto-capture-lessons
description: zen-gitsync 专属经验沉淀 skill。每次响应结束前自检本轮有没有可总结的教训(踩坑、误判、走了不该走的路径、用户纠正过的方向、确认有效的非显然做法),按性质分流到三种位置:跨工作流通用经验 → 新 skill / 现有 skill;项目特定事实 → 项目文档;用户偏好/协作风格 → memory 系统。不写日记、不写复盘、不记录"做了什么",只记录"以后怎么做能少走弯路"。适用触发词:总结一下、记一下这个坑、保存经验、踩坑记录、沉淀一下。
---

# 经验沉淀流程

## 触发时机

**每次响应结束前(无论该轮是改代码、跑流程、纯调研、回答问题),都要做一次自检**:

```
本轮我有没有踩坑?
  - 卡住 ≥3 分钟
  - 走了 A → 取消 → B → 取消 → C 这种反复路径
  - 用错了某个工具 / 写错了某个文件
  - 用户纠正过我的方向 / 用法 / 命名

本轮有没有发现非显然但被验证有效的做法?
  - 用户说过"对,就这么做"
  - 看似绕路但实际更快的方案
  - 反直觉但正确的判定

任何一个为"是" → 进入本 skill 的判断流程。
两者都为"否" → 直接结束,不要为沉淀而沉淀。
```

### 反例(不要记录)

| 不写 | 为什么 |
|------|--------|
| "本轮完成了 X 功能的开发" | 这是 commit message 该写的内容,不是 skill |
| "今天花了 30 分钟" | 时间信息对将来没价值 |
| "学到了 Vue 3 的 X 用法" | 通用技术细节,查文档更快 |
| "用户希望 Y 风格" | 没有具体可执行的规则时不要写 |
| "差点忘了加 i18n" | 这就是 i18n-check.md 已经在做的事,不需要重复 |

---

## 步骤 1 — 给本轮的教训归类

按"经验性质"分流到三个目标位置之一:

| 经验性质 | 目标位置 | 典型场景 |
|---------|---------|---------|
| **跨多个工作流/组件通用的工程经验** | 新建或追加到 `.claude/skills/<name>/SKILL.md` | "preview 启好但浏览器走的是 backend 生产 bundle"、"vue-tsc 要 cd 到 client 目录" |
| **项目特定的事实/约定/陷阱** | `.claude/rules/` 或项目内 `docs/` | "Job 状态字段是 running/pending/done 不是 active"、"pre 块最大 64KB 截断" |
| **用户偏好 / 协作风格 / AI 行为习惯** | 全局记忆系统 `~/.zen-gitsync/memory/`（见 2c） | "用户希望先看 computed style 再看 snapshot"、"用户偏好短响应不带总结" |

### 选择位置时的判定

- **这条经验对将来别的任务也用得上吗?**
  - 用得上 → skill
  - 只跟这个项目有关 → rules/docs
- **是对 Claude 行为的约束/偏好,还是客观事实?**
  - 主观偏好 → memory(feedback 类型)
  - 客观事实 → skill 或 rules
- **重复一次就够,还是要持续遵守?**
  - 一次性查表 → rules 单条
  - 要持续遵守 → skill 步骤化

---

## 步骤 2 — 按目标位置写入

### 2a. 写入 skill(新增或追加)

**新增 skill** 的判定标准(三个都满足才新建,否则追加到现有 skill):
- [ ] 现有 skills 目录里没有同类 skill 可容纳
- [ ] 内容超过 5 行,有完整的触发/步骤/反例结构
- [ ] 未来会被 Claude 多次复用,不是一次性教训

新 skill 模板:

```markdown
---
name: <kebab-case>
description: <一句话定位 + 适用触发词>
---

# <标题>

## 触发时机
## 步骤 1 ...
## 步骤 2 ...
## 不要做的事
```

**追加到现有 skill** 的判定:
- 经验明确归属某个现有 skill(如本次示例 → dev-server-diagnostics)
- 不破坏原 skill 的章节结构

追加方式:用 Edit 在最相关的章节插入,优先放在"步骤 0a / 步骤 1"这种靠前位置(防止 Claude 看不到),或"不要做的事"表格末尾。

### 2b. 写入 rules

`.claude/rules/` 是给本项目 Claude 协作规则用的,每次会话都加载。

新增或追加到现有 rule 文件(如 `i18n-check.md`、`syntax-check.md`):

```markdown
# <新规则标题>

## 规则
1. ...

## 反例
- ...
```

只在经验**会反复踩**、且**查文档查不到**时写。已经在文档里写过的事实不要重复。

### 2c. 写入全局记忆系统

⚠️ **2026-09-29 起不再用 `~/.claude/projects/<proj>/memory/`。** 记忆真源已迁到
`~/.zen-gitsync/memory/`,规范见该目录 `RULES.md`,落盘流程走全局 `memory-capture` skill
(`~/.claude/skills/memory-capture/SKILL.md`)。本节只做分流。

| 经验性质 | 落点 |
|---------|------|
| 跨项目通用(本机环境、沙箱边界、通用坑) | `~/.zen-gitsync/memory/GLOBAL.md` |
| 只跟本仓有关的项目事实/约定/陷阱 | `~/.zen-gitsync/memory/projects/<slug>/INDEX.md` + `lessons/<topic>.md` |
| 用户偏好 / 协作风格 | 同上,文件名用 `user-preference-<topic>.md` |

写入流程:
1. **先 glob + grep 现有 `lessons/*.md`**,同主题必须追加,不新建近似重复文件
2. 写 lesson(**≤25 行**):`# 坑是什么` / 现象根因 / `**How to apply:**`
3. **同步在对应 `INDEX.md` 加一行** `- [标题](lessons/<file>.md) — ≤100 字摘要` —— 没索引的记忆等于不存在
4. 收尾只说一两句"已沉淀到 X",**不展开写了什么**,不阻塞主任务

---

## 步骤 3 — 自检沉淀是否合理

写入前再过一遍:

- [ ] 这条经验**能减少将来 5 分钟以上的弯路**吗?不能 → 别写
- [ ] **没有重复**已存在的 skill / rule / memory?有 → 追加,不新建
- [ ] **不包含敏感信息**(commit hash、个人邮箱之外的隐私、token)?
- [ ] **不包含 git 历史/代码结构**(这些 git log / Read 能查到,不是经验)
- [ ] **不是"今天做了什么"的复盘**(commit message 是干这个的)

---

## 步骤 4 — 不阻塞主任务

沉淀是收尾,不是核心:
- 在响应末尾用一两句告知用户"已沉淀到 X",**不展开**写了什么
- 如果本轮主任务是改代码,**不要**为了写 skill 把 commit 流程卡住
- 如果用户已经在等下一轮,沉淀用 TaskCreate 排到下一轮再做

---

## 完整示例

### 示例 1:跨工作流通用经验(本次真实场景)

**触发**:本轮改前端代码后用 preview 验证,发现 preview 启了但浏览器加载的是 backend 生产 bundle,走了 5 分钟弯路。

**判定**:跨多个前端任务都可能踩,不属于任何一个现有 skill 的范畴,但 dev-server-diagnostics 的"步骤 0"判定不够前置。

**执行**:
- **不新建 skill**(内容只是给现有 skill 加一步)
- Edit `dev-server-diagnostics/SKILL.md`,在步骤 0 之前插入"步骤 0a — 先看 preview 浏览器加载的是 vite 还是 backend 静态资源"
- 在"不要做的事"表追加对应误操作

**告知**:"已把'preview 走 backend bundle 误判'加到 dev-server-diagnostics 步骤 0a"

### 示例 2:用户偏好

**触发**:用户说"不要再在响应末尾加'完成。改动汇总:...'这种总结了"

**判定**:对 Claude 行为的主观约束,跨所有任务。

**执行**:
- Write `~/.zen-gitsync/memory/projects/<slug>/lessons/user-preference-no-trailing-summary.md`
- 追加一行到同目录 `INDEX.md`

**告知**:已记到 memory,以后不再加

### 示例 3:项目特定事实

**触发**:本轮读 `types/workbench.ts` 发现 Job.status 枚举是 running/pending/done/error/stopped,文档里没写。

**判定**:项目特定事实,跨任务可复用,但不属于任何 skill。

**执行**:
- Edit `.claude/rules/workbench-types.md`(如果存在)或新建小节

---

## 不要做的事

| 误操作 | 为什么错 |
|--------|----------|
| 每个响应都写 skill | 大部分响应没有可沉淀的教训,强写就是噪音 |
| 把 commit message 复述到 skill | commit message 已经是历史,skill 是给将来的 |
| 写"今天遇到了 X 终于解决" | 这是日记,不是经验。写"X 的根因是 Y,以后先查 Y" |
| 把多个不相关的教训塞进一个 skill | 一个 skill 一个主题,方便后续检索 |
| 写到 skill 但不更新 INDEX.md | 写在角落里的经验等于没写 |
| 写了之后不验证 skill 真的会被加载 | 写到 `.claude/skills/` 但 description 写得模糊 → Claude 不会触发 |
| 在响应**开头**就沉淀 | 沉淀是收尾,主任务先做完 |