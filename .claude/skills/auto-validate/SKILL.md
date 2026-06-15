---
name: auto-validate
description: zen-gitsync 项目专属代码验证 skill。大模型完成一轮代码修改后，按固定顺序执行全量验证：get_errors 语法 → TSC 类型 → i18n 合规。覆盖前端 TS/Vue 与后端 JS 两个子系统，对任何未通过的检查项必须当场修复再继续下一项。
---

# zen-gitsync 自动验证流程

## 触发时机

每次回答**涉及代码修改**（`replace_string_in_file` / `multi_replace_string_in_file` / `create_file`）的问题之后，**必须依次**执行以下全部检查步骤，全部通过后才能向用户报告完成。

---

## 步骤 1 — get_errors 语法检查

对**所有被修改或新建**的文件路径，调用一次 `get_errors` 工具（支持传入多个路径）。

```
get_errors([
  "绝对路径/file1.vue",
  "绝对路径/file2.ts",
  ...
])
```

- 若有错误：**立即修复**，然后再次调用 `get_errors` 确认归零。
- 适用范围：`.ts` / `.tsx` / `.vue` / `.js` / `.mjs` / `.cjs`

---

## 步骤 2 — TSC 类型检查（仅改过 .ts / .tsx / .vue 时）

若本次修改涉及前端 TypeScript / Vue 文件，执行：

```bash
cd e:\workspace\xz333221_space\zen-gitsync\src\ui\client
npx tsc --noEmit
```

- 零输出 = 通过。
- 有错误：**立即修复**，重新执行直到零错误。
- 若只改了后端 `.js` 文件，跳过此步骤。

---

## 步骤 3 — i18n 合规检查

检查**所有被修改的前端文件**（`.ts` / `.tsx` / `.vue`）中是否存在未国际化的中文字符串：

### 判断标准
- 出现在模板 `<template>` 或脚本逻辑中的中文字面量，必须用 `$t(...)` 包裹。
- 以下位置的中文**不需要**处理：
  - 注释 `// ...` / `/* ... */`
  - `console.log` / `console.error` 调试语句
  - TSDoc 类型注释
  - `.json` / `.md` 等非代码文件

### 如何修复
1. 用 `$t('@<命名空间>:<中文原文>')` 替换裸中文。
2. 命名空间取该文件内**已有**的 `@XXXXX:` 前缀；若文件无现成命名空间，取文件相对路径的哈希前5位（可自行约定）。
3. 同步向两个语言文件**各加一条**（缺一不可）：
   - `src/ui/client/src/lang/zh/index.js` — 值 = 原中文
   - `src/ui/client/src/lang/en/index.js` — 值 = 准确英文翻译
4. 新条目插入到**同命名空间相邻条目**旁，不要乱序插入。

### 语言文件格式示例
```js
// zh/index.js
'@76872:储藏详情': '储藏详情',

// en/index.js
'@76872:储藏详情': 'Stash Details',
```

---

## 通过标准

| 检查项 | 通过条件 |
|--------|----------|
| get_errors | 返回 0 个错误 |
| TSC | `npx tsc --noEmit` 零输出、零错误 |
| i18n | 无裸中文字面量，zh/en 语言文件均已同步 |

三项全部通过后，才可以向用户报告"操作完成"。

---

## 快速参考：项目关键路径

| 路径 | 说明 |
|------|------|
| `src/ui/client/` | Vue 3 + TypeScript 前端（vite） |
| `src/ui/client/src/lang/zh/index.js` | 中文语言包 |
| `src/ui/client/src/lang/en/index.js` | 英文语言包 |
| `src/ui/server/` | Express 后端路由（纯 JS） |
| `src/config.js` | 配置管理（读/写 `~/.git-commit-tool.json`） |
| `src/ui/client/tsconfig.json` | TSC 入口（references app + node） |
