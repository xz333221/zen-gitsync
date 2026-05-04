---
applyTo: "**/*.{ts,tsx,vue}"
---

# 代码修改后执行 TSC 语法检查

每次使用 `replace_string_in_file`、`multi_replace_string_in_file` 或 `create_file` 修改或创建 `.ts` / `.tsx` / `.vue` 文件后，**必须立即**在终端执行一次 TSC 类型检查，确认无编译错误。

## 规则

1. 修改或创建任意 `.ts` / `.tsx` / `.vue` 文件后，切换到客户端目录并运行：
   ```
   cd src/ui/client && npx tsc --noEmit
   ```
2. 若 TSC 输出任何错误，**立即修复**，然后再次执行上述命令确认错误已消除。
3. 只有 `tsc --noEmit` 零错误退出后，才可以向用户报告操作完成。
4. 若同一次操作修改了多个文件，只需在所有文件改完后统一执行一次 TSC，不需要每改一个文件执行一次。

## 不需要执行的情况

- 只读操作（`read_file`、`grep_search` 等）
- 修改的是 `.md`、`.json`、`.yaml`、`.txt`、`.js`、`.cjs`、`.mjs` 等非 TypeScript 文件
- 仅修改样式（纯 CSS / SCSS 变量调整，无逻辑代码变动）
