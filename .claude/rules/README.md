# zen-gitsync 全局规则

本文件定义 Claude 在本仓库协作时必须遵守的流程约束。

## 代码修改后的强制流程

每当本轮对话中使用了 `Edit`、`Write`（或多文件批量编辑）工具之后，**必须严格按以下顺序执行**，不允许跳过任何步骤：

### 第零步：改前端代码前先验 dev server 活着（强约束）

**仅当本轮会改动前端代码（`.vue` / `.ts` / `.tsx` / 前端目录下的 `.js` / CSS）时才执行。**

优先用项目脚本探测：

```
npm run dev:ping
```

输出形如：

```
dev server status:
  [  OK  ]  backend  127.0.0.1:4065/api/app-version
  [  OK  ]  vite     127.0.0.1:5544/@vite/client
```

- 两个都 OK → 一切正常,可以开始改前端代码,后续浏览器验证走 HMR 链路
- 任何一个 DOWN → **先告诉用户启动缺失的 dev server(`npm run dev` 启整体,或单独 `npm run start:vue` 启 vite)再继续改代码**,否则改完 reload 也拿不到新 chunk,会被迫绕去 `vite build` 验证,白花 1 分多钟
- 脚本不存在或异常时,退化为手动探测:

  ```
  curl -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5544/@vite/client
  ```

  返回 200 才说明 vite 在跑(返回 404/000 = vite 没启)。

**为什么是强约束**:`preview_start` 的 "started successfully" 只代表 wrapper 进程跑了,不代表 vite 在跑(本仓库 `npm run dev` 用 concurrently 同时启后端+vite,常因端口冲突而 vite 子进程没起)。本仓库曾因 vite 没起改了 5 轮前端代码、reload 4 次,最后才发现 dev server 整个就没在跑。

### 第一步：auto-validate（代码验证）

加载并执行 `.claude/skills/auto-validate/SKILL.md` 中定义的全量验证流程：

1. 语法检查 → 有错误立即修复
2. TSC 类型检查（涉及 `.ts` / `.tsx` / `.vue` 时）→ 有错误立即修复
3. i18n 合规检查 → 有裸中文字符串立即补充翻译 key

**全部通过后才能进入下一步。**

### 第一点三步：hmr-debug-check（浏览器验证时的 5 步检查）

如果本轮改动了前端代码并且通过浏览器验证视觉效果，加载并执行 `.claude/rules/hmr-debug-check.md`：

1. 看 dev server stdout 有没有 hmr update
2. 看 Network 的 chunk 是否 200 且 hash 变了
3. 用 `preview_eval` 拉目标元素 outerHTML 而不是看 snapshot 文本
4. 用 `preview_inspect` / `getComputedStyle` 核对关键 CSS
5. 截图存证

**DOM 没变时先排除"看错元素"再怀疑工具链**——本仓库曾因此走半小时弯路。

### 第一点五步：auto-update-readme（README 同步）

加载并执行 `.claude/skills/auto-update-readme/SKILL.md` 中定义的检查流程：

1. 读取当前 README.md，对比本轮新增/修改的功能
2. 判断是否需要更新文档
3. 若需要：用 `Edit` 更新英文和中文两个章节，将 `README.md` 纳入本轮提交

> 纯重构、样式微调、依赖升级、配置变更等不触发此步骤。

### 第二步：auto-commit（Git 提交）

加载并执行 `.claude/skills/auto-commit/SKILL.md` 中定义的提交流程：

1. `git status` 收集本轮变更文件
2. `git add <具体文件>`（禁止 `git add .`）
3. 生成 Conventional Commits 风格的中文提交信息
4. `git commit -m "..."`
5. 询问用户是否 `git push`

---

## 约束

- 验证未全部通过时，**禁止执行提交步骤**
- 上述流程对每一轮代码修改都是**强制性**的，不受用户是否提及"提交"影响
- 仅修改文档/配置（`.md`、`.json` 中的非代码内容）时可跳过 TSC 检查，但仍需执行语法检查和提交

## Skill 目录统一

所有 skill 统一在 `.claude/skills/` 下，**不要**继续使用 `.agents/skills/`、`.windsurf/skills/`、`.trae/skills/`、`.iflow/skills/` 这几个目录。
修改或新增 skill 时直接更新 `.claude/skills/<skill-name>/SKILL.md`，旧路径仅作为历史备份保留。