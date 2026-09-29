# 跨轮记忆（记忆库）

> 2026-09-29 起，**每次派发任务**都会告诉智能体本机有一份经验库。
> 这份文档讲清它是什么、为什么这么设计、怎么排查。

## 它解决什么

多个智能体在**同一仓库**轮流干活时，每个都是失忆的 —— 前一个刚摸清"这台机器
`npm run dev` 起不来、要 cd 进 client 目录"，后一个照样踩一遍。记忆库让经验跨任务存活。

需求里最关键的一句是：**「总结要尽可能简洁，或者用索引的方式，不然上下文会太长」**。
这句话决定了整个设计。

## 目录形状

```
~/.zen-gitsync/memory/            ← 跟 aiContext 并列，同一套"本机派生数据"思路
├── INDEX.md          全局索引 · **唯一进 prompt 的东西** · ≤30 行
├── GLOBAL.md         跨项目经验正文 · ≤40 行 · 按需读
├── RULES.md          完整规范（注入的是精简版，口径以本文件为准）
├── skills/memory-capture/SKILL.md
└── projects/<slug>/
    ├── INDEX.md      本项目索引 · ≤40 条 · 每条 ≤100 字
    ├── lessons/*.md  正文 · 单条 ≤25 行 · **命中才读**
    └── archive/      冻结历史 · **永不读**
```

`<slug>` = `可读部分-路径哈希6位`，例如
`c-workspace-github_workspace-xz333221-zen-gitsync-f4b3bd`

**哈希不是装饰**（2026-09-29 实测踩到）：只做"小写 + 非 [a-z0-9_] 压成 `-`"的话，
`C:\中文\项目` 与 `C:\中文\别的` 会塌成同一个 `c-` —— 两个仓库共用一份 lessons，
A 项目的教训被当成 B 项目的读进 prompt，**且不报任何错**。这是记忆系统最坏的失效方式。

## 为什么是"指针"而不是把索引塞进 prompt

把 `INDEX.md` 全文拼进每次派发是最省事也最糟的做法：索引随记忆线性增长，
于是**每次派发都要为每一条不相关的历史经验付 token**。塞路径 + 塞纪律（各 5~8 行，
`MEMORY_BLOCK_MAX_BYTES = 2048` 封顶），剩下的交给 Agent 自己的 read 工具按需取。

所以记忆块的位置刻意在 `taskRunner.js` 的 `prefixBlocks` 里，排在任务正文**之前**：
`[环境上下文 → 记忆指针 → 任务正文]`。放末尾等于把"背景"讲成"当前任务"，
Agent 会以为这轮用户要求它去整理记忆库。

## 谁在写

**Agent 自己**，不是服务端。服务端只做三件事：铺种子、算 slug、在 prompt 里给指针。

理由：Agent 才知道"这次踩的坑"是什么；少一次 LLM 调用；写完能自己验证路径对不对。
代价是**没有服务端兜底校验** —— 纪律（"写完必须补索引行"）靠 prompt 里的文字约束。

## 开关

单条任务设 `memoryContext: false` 整块关掉，与 `envContext: false` 同一口径。
续接轮自动关掉捕获纪律（`capture: !resumeSessionId`）—— 同一场对话里讲第二遍纯属噪音。

## 界面（设置 → 记忆库）

| 能力 | 实现 |
|---|---|
| 范围切换 | `GET /api/memory/scopes` —— 全局两篇 + 每个项目（按项目 `INDEX.md` 头里记的仓库路径标注） |
| 浏览 | `GET /api/memory/entries?scope=` —— 条目按 mtime 倒序，**标出哪些有索引行** |
| 展开看正文 | `GET /api/memory/entry?scope=&file=` —— 给**原始 markdown** 而非渲染结果（用户多半是照着去改文件） |
| 删除 | `POST /api/memory/batch-delete`，必须带 `confirm: true`；**连带清掉 `INDEX.md` 里那一行** |

组件 `src/ui/client/src/components/MemoryPanel.vue`，路由 `src/ui/server/routes/memory.js`，
数据层 `src/memory/library.js`。

### 安全边界（与注入链路同等重要）

**前端只传 `{scope, file}` 两个字符串，永不传路径。** 绝对路径由服务端从 `scope`
重新拼，所以不合法参数**压根不参与路径拼接** —— 拼不出 `~/.claude/settings.json`。
（对比 `mindmap.js`：那边让前端传 path，得靠 `validatePath` + `pathGuard` 双重拦。）

- `isValidScope`：`global` / `global-index` / `可读部分-6位哈希`
- `isValidFile`：kebab 文件名 + `.md`，挡掉 `.` / `..` / 斜杠
- 全局两篇**不可删**（删了整套记忆失去记账口径）

### 「未索引」徽标

有索引行 = Agent 查得到；没有 = 这条经验**永远不会被召回**。徽标就是把这件事
在界面上说清楚，而不是让用户以为"记下来就有人用"。

## 排查

| 症状 | 先查 |
|---|---|
| 智能体不查记忆 | `node scripts/verify-memory-context.cjs` —— A/B/C 组任一红就是注入被改坏了 |
| 面板打不开 / 404 | `npm run verify:memory-context` 的 H2 组（只 import 不调用 = 接口没挂上） |
| 派发 prompt 里没有记忆块 | `task.memoryContext === false`（单任务关）；或该仓库还没建过项目目录（块里会明说"本项目还没有条目"，这是正常的） |
| 记忆串到别的项目 | slug 撞了 → 看 `projects/` 下有没有两个目录的 `INDEX.md` 头里记着**同一个仓库路径** |
| 改了源码探针还绿 | 探针只查源码结构，**链接期错误（少了具名导出）它查不出** —— 跑 `node --test` 或 `node --input-type=module -e "import('...')"` |
| 装完第一次开工作台就崩 | `src/memory/**` 不在 `package.json#files` → `node --test test/package-files.test.mjs` |
| 新加的测试文件没被 `npm test` 跑到 | `scripts/run-tests.cjs` 的 `SCAN_DIRS` 是**显式枚举**（不是通配），新目录要手动加一行 → `node scripts/run-tests.cjs --list` |

## 验证

```bash
npm run verify:memory-context              # 24 组契约（含面板接口守卫与链接期 import）
npm run verify:memory-context -- --reverse # 把 A~D 打回去，必须如期翻红
npm run verify:memory-panel                # 16 组：起真 express 打真 HTTP
npm run verify:memory-panel -- --reverse   # 去掉 confirm / 放开全局 / 放开 file 校验
node --test src/memory/store.test.js       # 13 例（沙箱 HOME，slug / 幂等 / 预算）
node --test src/memory/library.test.js     # 15 例（形状校验 / 越界 / 删条目连带清索引）
```

`--reverse` 不是走过场：它把坏形状打回源码，断言必须**全部翻红**。
全绿却没翻红 = 断言恒真 = 没验。**反证里还要先断言"变异确实生效了"** ——
否则 `.replace()` 模式一失配，变异就是空操作、守卫照旧，报出来的却是
"断言恒真"，把真正的原因盖住（踩过一次）。

## 边界（重要）

本模块**只写 `~/.zen-gitsync/memory/` 下的路径**，一个字节都不碰用户工作区，
也不碰第三方工具的配置目录（`~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`、
`~/.config/opencode/AGENTS.md`）。探针 I 组专门守这条。

用户**自己**在那些文件里写规则是另一回事（本仓库 `CLAUDE.md` → `AGENTS.md` 转发就是这么做的），
但产品不该替用户改别人家的配置。
