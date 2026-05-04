# zen-gitsync Copilot 全局规则

## 代码修改后的强制流程

每当本轮对话中使用了 `replace_string_in_file`、`multi_replace_string_in_file` 或 `create_file` 工具之后，**必须严格按以下顺序执行**，不允许跳过任何步骤：

### 第一步：执行 auto-validate（代码验证）

加载并执行 `.agents/skills/auto-validate/SKILL.md` 中定义的全量验证流程：

1. `get_errors` 语法检查 → 有错误立即修复
2. TSC 类型检查（涉及 `.ts` / `.tsx` / `.vue` 时）→ 有错误立即修复
3. i18n 合规检查 → 有裸中文字符串立即补充翻译 key

**全部通过后才能进入下一步。**

### 第二步：执行 auto-commit（Git 提交）

加载并执行 `.agents/skills/auto-commit/SKILL.md` 中定义的提交流程：

1. `git status` 收集本轮变更文件
2. `git add <具体文件>`（禁止 `git add .`）
3. 生成 Conventional Commits 风格的中文提交信息
4. `git commit -m "..."`
5. 询问用户是否 `git push`

---

## 约束

- 验证未全部通过时，**禁止执行提交步骤**
- 上述流程对每一轮代码修改都是**强制性**的，不受用户是否提及"提交"影响
- 仅修改文档/配置（`.md`、`.json` 中的非代码内容）时可跳过 TSC 检查，但仍需执行 `get_errors` 和提交
