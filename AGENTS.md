# zen-gitsync · Agent 协作规则

## 先查经验，再动手

本项目有长期记忆系统（索引 + 懒加载正文，**别一次性全读**）：

```
~/.zen-gitsync/memory/INDEX.md                              ← 全局索引
~/.zen-gitsync/memory/projects/c-workspace-github_workspace-xz333221-zen-gitsync/INDEX.md
```

开工第一步读项目 `INDEX.md`；**只有命中某条的关键词才去 Read 对应的 `lessons/<topic>.md`**。
里面装的是"再犯就出事"的结论（双落盘路径、探针假绿、契约改名要同步探针、共享工作区…）。
通用坑看 `~/.zen-gitsync/memory/GLOBAL.md`。

## 验证顺序（改代码后按此跑，别跳）

1. 服务端产物：`node --check <file>`
2. 前端类型：`cd src/ui/client && NODE_OPTIONS= npm run tsc`
3. i18n：改过 `$t()` 文案就 `node scripts/verify-i18n-keys.mjs`（zh/en 都要补新 key）
4. 前端"完成"：`cd src/ui/client && NODE_OPTIONS= npm run build`（`vue-tsc -b && vite build`）
5. 改过 UI 契约（class / 默认值 / localStorage key）→ `grep <关键词> scripts/` 同步探针，并跑对应 `verify:*` + `-- --reverse`

## 硬约束

- **共享工作区**：本仓库常有多个 Agent 会话并发改文件。提交前 `git status --short`，**永不 `git add .`**，只提自己独占的文件。别人的 hunk 混在自己文件里 → 用 blob 路线按 hunk 暂存，细节见 `lessons/shared-worktree.md`。
- **`tmp-*` 脚本从不入库**：验完删掉，或改名 `verify-*` + 在 `package.json` 加同名 `verify:` 入口。
- **grep 前排除 `node_modules`**（含 `src/ui/public` 构建产物），否则输出被刷爆、后面的匹配全被吞。
- **`node_modules/.trash/` 里的旧构建产物仍会被 grep 命中** —— 判断"是不是我引入的"要先看 `git status --short`。
- **改 UI 前先读根目录 `.impeccable.md`**（设计上下文，来源 `PRODUCT.md`）。

## 环境入口

- 开发：`cd src/ui/client && NODE_OPTIONS= npm run dev`（前端 5544，`dev:server` 后端 5545）
- 探针：`npm run dev:ping` 先确认 vite 在不在，再起别的
- Playwright：`ZEN_BASE=http://127.0.0.1:5544`，代理 target 写 `127.0.0.1` 不写 `localhost`
