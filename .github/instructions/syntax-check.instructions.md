---
applyTo: "**/*.{ts,tsx,vue,js,mjs,cjs}"
---

# 代码修改后自动语法检查

每次使用 `replace_string_in_file`、`multi_replace_string_in_file` 或 `create_file` 修改或创建代码文件后，**必须立即**调用 `get_errors` 工具对该文件进行语法检查。

## 规则

1. 修改或创建任意 `.ts` / `.tsx` / `.vue` / `.js` / `.mjs` / `.cjs` 文件后，使用 `get_errors` 检查被修改的文件路径。
2. 若 `get_errors` 返回错误，**立即修复**，然后再次调用 `get_errors` 确认错误已消除。
3. 只有确认 `get_errors` 无错误后，才可以向用户报告操作完成。
4. 若同一次操作修改了多个文件，对所有被修改文件统一调用一次 `get_errors`（传入多个路径）。

## 不需要检查的情况

- 只读操作（`read_file`、`grep_search` 等）
- 修改的是 `.md`、`.json`、`.yaml`、`.txt` 等非代码文件
