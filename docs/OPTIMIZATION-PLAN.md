# zen-git 优化方案与实施 Checklist

> 本轮挑选 **5 项** 高 ROI 优化(覆盖视觉 / 可发现性 / 交互反馈 / 可访问性 / 错误恢复 5 个维度),
> 避免一次性改动过大,每项可在 1 个 commit 内独立交付。
>
> 依据:`docs/UX-AUDIT.md`(24 条问题,P0×4 + P1×7 + P2×13)
> 编制日期:2026-06-19

---

## 0. 挑选原则

| 原则 | 含义 |
|------|------|
| **高 ROI** | 用户感知明显 / 改动小 / 不引入新依赖 |
| **跨维度** | 一项视觉、一项交互、一项可发现性、一项可访问性、一项错误恢复 |
| **可独立验证** | 每项都有可在浏览器或 Playwright 里复现的验收点 |
| **不破坏现有 WCAG 工作** | 优先补齐剩余 20% 缺口,不重写已有 a11y 实现 |

## 1. 选中的 5 项一览

| 编号 | 标题 | 维度 | 审计编号 | 预估改动 | ROI |
|------|------|------|----------|----------|-----|
| OPT-1 | 暗色模式 `.commit-hash` 对比度达标 | 视觉 / a11y | F-P0-02 | 1 个 SCSS 块 + 2 个 token | ⭐⭐⭐⭐⭐ |
| OPT-2 | header 加主题切换 ☀/🌙 快捷入口 | 可发现性 | F-P0-04 | 1 个按钮 + i18n | ⭐⭐⭐⭐⭐ |
| OPT-3 | 提交按钮 click 后 loading 视觉态 | 交互反馈 | F-P1-04 | 1 个 el-button 加 `:loading` | ⭐⭐⭐⭐ |
| OPT-4 | 分隔条两套实现统一为 `role=separator` | 可访问性 + 代码质量 | F-P1-02 | 2 个 panel 组件 | ⭐⭐⭐⭐ |
| OPT-5 | 全局网络错误横幅 AppErrorBanner | 错误恢复 | F-P0-01 | 1 个新组件 + 1 个 composable | ⭐⭐⭐ |

未选中的 P0(移动端响应式 F-P0-03)涉及 3 处布局重构,改动面过大,留待下一轮单独立项。

---

## 2. 各项详细 Checklist

### OPT-1 · 暗色模式 `.commit-hash` 对比度达标

- **现状**
  - `src/ui/client/src/styles/dark-theme.scss:1004-1008` 强制:
    ```scss
    .commit-hash, .commit-id {
      color: rgba(255, 255, 255, 0.7) !important;
      background: rgba(255, 255, 255, 0.1) !important;
    }
    ```
  - 实测对比度 **1.0:1**(WCAG AA 最低 4.5:1),暗色模式下 SHA 完全不可读。
- **目标**
  - 暗色 `.commit-hash` / `.commit-id` 对比度 **≥ 4.5:1**。
  - 视觉上仍然保持 "低权重次要文字" 调性(不抢主标题),但保证可读。
  - 通过 SCSS 变量复用,不重复 hard-code 颜色。
- **改动文件清单**
  | 文件 | 改动 |
  |------|------|
  | `src/ui/client/src/styles/variables.scss` | 新增 `--commit-hash-fg`(亮色已存在 var,深色覆盖)、`--commit-hash-bg` 两个 token |
  | `src/ui/client/src/styles/dark-theme.scss` | `[data-theme="dark"]` 块下用 `--commit-hash-fg` / `--commit-hash-bg` 覆盖,值选 `var(--color-text-secondary)` + 透明背景 |
  | `src/ui/client/src/views/components/LogList.vue` | `.commit-hash` 样式块改用变量,移除硬编码颜色 |
  | `src/ui/client/src/lang/zh/index.js` + `src/ui/client/src/lang/en/index.js` | 不需要新增 key(无文案变更) |
- **验收标准**
  - [ ] 切到暗色模式,提交记录每行 SHA 文字清晰可读,目视无锯齿。
  - [ ] Playwright 复算:在 `audit-pass2.md` 对比度结论里,`.commit-hash` 的 ratio ≥ 4.5。
  - [ ] 亮色模式视觉无回归(SHA 仍为蓝色 + 浅蓝底)。
  - [ ] `vue-tsc -b --noEmit` 零错误;`node --check` 对 SCSS 不做要求(走 vite build 验证)。

---

### OPT-2 · header 加主题切换 ☀/🌙 快捷入口

- **现状**
  - 主题切换路径:设置 → 通用设置 → 外观 → 主题(4 次点击)。
  - 审计中 `probeDarkModeToggle` 全 UI 找不到任何 `[aria-label*=主题/Theme/暗/Dark]` 控件。
  - Header 右侧已有齿轮按钮(打开设置),无主题图标。
- **目标**
  - header 齿轮旁加一个 32×32 图标按钮,一键切 light/dark,带 `aria-label`。
  - 图标随当前主题切换(Sun ↔ Moon)。
  - 状态持久化走现有 `localeStore` / `configStore` 的主题字段,不引入新的 storage key。
- **改动文件清单**
  | 文件 | 改动 |
  |------|------|
  | `src/ui/client/src/components/Header.vue`(或 App.vue header 区块) | 在齿轮按钮前插入 `<button class="theme-toggle">`,图标用 element-plus icons `Sunny` / `Moon` |
  | `src/ui/client/src/stores/configStore.ts` | 暴露 `toggleTheme()` action(若已存在则复用) |
  | `src/ui/client/src/main.css` 或新 SCSS | `.theme-toggle` 样式:32×32、`min-width/min-height: 32px`、hover bg 走 `--bg-container-hover` |
  | `src/ui/client/src/lang/zh/index.js` | 新增 `'@THEME:切换到深色模式'` / `'@THEME:切换到浅色模式'` |
  | `src/ui/client/src/lang/en/index.js` | 同步英文 `'Switch to dark mode'` / `'Switch to light mode'` |
- **验收标准**
  - [ ] 任意视图下,header 都能看到主题按钮(60 视口下也可见,移动端优化留 OPT-2.1 后续)。
  - [ ] 点击图标立即切换 `data-theme` 属性,vite HMR 实时反映,无需 reload。
  - [ ] F12 检查按钮 `aria-label` 随当前主题动态变化。
  - [ ] Playwright:点 1 次切到 dark,再点 1 次切回 light,`document.documentElement.dataset.theme` 正确切换。
  - [ ] 设置里的"主题"下拉同步反映新值(数据源唯一)。
  - [ ] `vue-tsc` 零错误,新增 i18n key 在中英两个文件都已登记。

---

### OPT-3 · 提交按钮 click 后 loading 视觉态

- **现状**
  - LogList 的 "提交" 按钮静态 `hasSpinner: false`,点击后无明显 loading 视觉。
  - 用户提交时容易重复点击,或误以为没生效。
  - audit 现场:点击提交后 1.5s 期间,按钮完全无变化。
- **目标**
  - 提交按钮在请求 in-flight 时显示 el-loading spinner + 文案变 "提交中…"。
  - 成功 toast: "已提交 SHA xxxxxx"(沿用 `ElMessage.success`,本轮不强求 a11y 增强,那是 OPT-后续项)。
  - 失败 toast: "提交失败: <reason>"。
  - 整个过程,提交按钮 `:disabled="isCommitting"` 防重复点击。
- **改动文件清单**
  | 文件 | 改动 |
  |------|------|
  | `src/ui/client/src/views/components/LogList.vue` | 提交按钮改 `:loading="isCommitting"` + `:disabled="isCommitting"`,`isCommitting` 在 `doCommit()` 里 set true/false |
  | `src/ui/client/src/lang/zh/index.js` | 新增 `'@LOG:提交中'` / `'@LOG:已提交 {sha}'`(可选) / `'@LOG:提交失败: {reason}'` |
  | `src/ui/client/src/lang/en/index.js` | 同步英文 |
- **验收标准**
  - [ ] 点击提交 → 按钮立刻出现 spinner + "提交中…" + disabled。
  - [ ] 模拟后端 200ms 延迟时,spinner 持续显示 ≥ 200ms。
  - [ ] 成功后 spinner 消失,toast 出现,按钮恢复可点。
  - [ ] 失败后按钮恢复可点,toast 出现红色错误样式。
  - [ ] 重复点击 3 次,只发 1 次请求(看 Network `/api/git-commit`)。
  - [ ] `vue-tsc` 零错误,i18n 完整。

---

### OPT-4 · 分隔条两套实现统一为 `role=separator`

- **现状**
  - App.vue 主区 3 个 `role="separator" tabindex="0" aria-orientation=...`(完整实现)。
  - `NpmScriptsPanel.vue` / `CustomCommandsPanel.vue` 各有 1 个 `.resize-handle`,缺 `role/tabindex/aria-orientation`。
  - 屏幕阅读器 / 纯键盘用户无法操作后面这两个分隔条。
  - 后人改组件易混淆走错分支。
- **目标**
  - 两套实现统一为 `role="separator" tabindex="0" aria-orientation="vertical|horizontal"`。
  - 键盘 `Arrow` 键可调节(沿用 App.vue 已有的 nudgeH/nudgeV 思路,提到 composable)。
  - 触屏 cursor 保留 `ns-resize` / `ew-resize`。
- **改动文件清单**
  | 文件 | 改动 |
  |------|------|
  | `src/ui/client/src/composables/useResizeHandle.ts`(新建) | 封装 `nudge(direction, axis)` 共用逻辑 |
  | `src/ui/client/src/App.vue` | 把现有的 v-resizer / h-resizer / v-resizer-2 改成调用 `useResizeHandle()` |
  | `src/ui/client/src/components/NpmScriptsPanel.vue` | `.resize-handle` 加 `role="separator" tabindex="0" aria-orientation` + keydown 监听 |
  | `src/ui/client/src/components/CustomCommandsPanel.vue` | 同上 |
- **验收标准**
  - [ ] Playwright 探测全 UI 5 个分隔条,全部带 `role="separator" tabindex="0" aria-orientation`。
  - [ ] 键盘 Tab 可聚焦每个分隔条,Enter/Arrow 有视觉变化或可调宽度。
  - [ ] 鼠标拖动行为与改动前一致(回归测试)。
  - [ ] `vue-tsc` 零错误。
  - [ ] 审计脚本中 `splitters` 数组里 `hasRole: true` 比例从 60% → 100%。

---

### OPT-5 · 全局网络错误横幅 AppErrorBanner

- **现状**
  - 模拟后端 500 时,4 个面板同时进入"暂无 X"空状态,共 26 个 `.el-empty` 节点。
  - 用户分不清"后端断" vs "仓库真的空"。
  - 没有任何全局请求失败信号。
- **目标**
  - 拦截全局 `fetch`(包一层 try/catch 或用 Axios 拦截器),错误时在 header 下方置顶一个红条 `AppErrorBanner`:"无法连接到本地服务,请检查后端进程",带"重试"按钮。
  - 重试按钮触发最近一次失败的请求。
  - 恢复后自动隐藏(下一次成功请求时清除 error 状态)。
  - 不打断用户当前操作(non-blocking,absolute 定位,可手动关闭)。
- **改动文件清单**
  | 文件 | 改动 |
  |------|------|
  | `src/ui/client/src/composables/useNetworkStatus.ts`(新建) | 暴露 `isOnline: Ref<boolean>`、`lastError: Ref<string \| null>`、`retry()`,监听全局 fetch |
  | `src/ui/client/src/components/AppErrorBanner.vue`(新建) | 模板:`v-if="isOnline === false"` 红条,带关闭按钮 + 重试按钮 |
  | `src/ui/client/src/App.vue` | 在 header 下方插入 `<AppErrorBanner />`,初始化 `useNetworkStatus()` |
  | `src/ui/client/src/utils/fetcher.ts`(新建或扩展) | 统一 `fetch` 入口,失败时调用 `useNetworkStatus().markError()` |
  | `src/ui/client/src/lang/zh/index.js` | 新增 `'@NET:无法连接到本地服务,请检查后端进程'` / `'@NET:重试'` / `'@NET:关闭'` |
  | `src/ui/client/src/lang/en/index.js` | 同步英文 |
- **验收标准**
  - [ ] Playwright `context.route('**/api/**', 500)` 模拟后端故障,reload 后 AppErrorBanner 出现在 header 下方。
  - [ ] Banner 视觉:红底/黄底(用现有 `--color-danger` token),不影响其他面板布局(absolute 浮层,不挤压内容)。
  - [ ] 点 "重试" 触发最近一次失败请求,若仍失败 → Banner 仍显示并更新错误时间。
  - [ ] 关闭按钮可手动隐藏 Banner(不再次显示,直到下一次新错误)。
  - [ ] 恢复路由后(去掉 mock)再发请求,Banner 自动消失。
  - [ ] 屏幕阅读器读到 `role="alert" aria-live="assertive"`。
  - [ ] `vue-tsc` 零错误,i18n 完整。

---

## 3. 实施顺序与并行建议

| 顺序 | 任务 | 理由 |
|------|------|------|
| 1 | OPT-1 暗色 commit-hash | 5 分钟改完,风险最低,先热手 |
| 2 | OPT-2 header 主题按钮 | 与 OPT-1 共享 dark-theme 变量测试 |
| 3 | OPT-3 提交按钮 loading | 独立组件改完即用 |
| 4 | OPT-4 分隔条统一 | 涉及 2 个 panel + 1 个 composable,放中间 |
| 5 | OPT-5 全局错误横幅 | 改动面最大、依赖前 4 项视觉对齐,放最后 |

每项独立 commit,commit 信息沿用项目风格:`fix(ui): ...` / `feat(ui): ...` / `refactor(ui): ...` / `docs(ui): ...`。

## 4. 不在本轮范围(明确排除)

- **F-P0-03 移动端响应式重构** — 涉及 3 处布局(顶栏 alert 折叠 + ActivityBar 转 bottom tab + 徽章收起),需独立半天工时 + 跨组件测试,留作下一轮专项。
- **F-P1-01 64 个 < 24×24 元素扫描** — 纯机械活,可在 OPT-1/2/3 顺手做(本轮 OPT-2 主题按钮已写 32×32,顺带把 IconButton 统一),完整清单留作 audit-3 后续。
- **F-P1-06 toast `aria-live=assertive`** — 与 OPT-5 Banner 共享 a11y 思路,本轮只在 OPT-5 落实 Banner 的 aria-live,toast 单独 PR。
- **F-P1-07 el-tooltip 防抖** — 审计发现 activity bar 的 el-tooltip 已用 `:show-after="300"`,问题主要在 14 条 P2 范围内的零散 tooltip,影响有限,留待 P2 清理批次。
- **所有 P2(13 条)** — 按需在后续日常 commit 顺手做。

## 5. 验证 / 交付节奏

每完成一项 OPT:
1. `cd src/ui/client && npx vue-tsc -b --noEmit` → 0 错误
2. i18n check: 新增 key 在 zh/en 两个 lang 文件都已登记
3. 浏览器手动验证(走 vite dev 5544 HMR)
4. 跑 `docs/screenshots/audit-pass2.md` 复算逻辑(脚本本地维护)看是否在原 issue 上有改善
5. `git commit`(独立 commit),汇报用户

整体节奏:**每天 1 项 OPT,1 周 5 个 commit**,留 2 天 buffer 处理 OPT-4/OPT-5 联调问题。

---

## 6. 追踪方式

本文件即作为 checklist,完成时把 `- [ ]` 改成 `- [x]` 并在 commit 信息里引用 OPT 编号(如 `OPT-1`),便于回溯。

> 完成后,可把本文件归档到 `docs/OPTIMIZATION-PLAN-2026-06.md` 并在 README 的"Roadmap"段落摘要。
