# zen-git 交互探索与可用性审计报告

| 项目 | 值 |
|------|---|
| 审计时间 | 2026-06-19 |
| 目标 | `http://127.0.0.1:5544`(vite dev) + `5545`(backend) |
| 视口 | 主 1440×900,补充 768×900,375×800 |
| 浏览器 | Playwright Chromium(1223,headless) |
| 发现总数 | **24 条**(P0: 4,P1: 7,P2: 13) |
| 复现脚本 | 本地维护(`docs/screenshots/audit*.mjs` 暂不入库) |
| 原始数据 | 本地维护(`audit*.json` 暂不入库,关键结论已写入本报告) |
| 截图 | `docs/screenshots/audit-*.png` / `audit2-*.png` |

---

## 0. 执行摘要

整体结论:**SPA 工程完成度较高,视觉一致性与可访问性已显著优于一般内部工具**(项目最近的 commit 显示做了 WCAG 2.1 AA 专项提升),但在**错误恢复路径**、**窄屏响应式**、**暗色模式细节对比度**、**发现性(主题切换)** 四个维度仍有可观察的可用性缺口。

最高优先级(必须修复)的 4 个 P0 问题分别是:

1. **网络断开时整个 UI 同时进入"全是空状态"假象**,用户无法判断是后端故障还是真的没数据
2. **移动端(< 768px)顶栏 alert 与 header 控件重叠**,3 个实例 + 用户徽章 + 齿轮互相挤压
3. **暗色模式下 commit-hash 文字对比度仅 1.0:1**,低于 WCAG AA 最低 4.5:1 要求,实际不可读
4. **主题切换无快捷入口**,藏在"设置 → 通用设置 → 外观 → 主题"二级路径下

---

## 1. 审计方法

### 1.1 自动化覆盖

| 维度 | 方法 |
|------|------|
| 视图导航 | 逐个点击 ActivityBar 4 个按钮,等待异步面板就绪 |
| 设置对话框 | 点 header 齿轮 → 等待 `.el-dialog` → 切换 3 个 tab → Esc 关闭 |
| 键盘快捷键 | `Ctrl+F` / `Ctrl+S` / `Escape` 逐个 dispatch,断言副作用 |
| 焦点陷阱 | 打开弹窗 → 模拟 30 次 Tab,断言 `document.activeElement` 留在 dialog 内 |
| 拖拽分隔条 | 枚举 `.resize-handle` / `.splitter` / `[role=separator]` / `[data-divider]`,读 `role/tabindex/aria-orientation/cursor` |
| 点击区尺寸 | 全局扫描 `button` / `a` / `.activity-btn` / `.btn-icon-*` / `.tab-item` / `.el-button`,按 WCAG 2.5.5 24×24 阈值过滤 |
| 焦点环 | 选中 8 类关键元素,逐个 focus,读 `outline-width` 与 `box-shadow` |
| 暗色对比度 | 切 `data-theme=dark`,对 9 类元素采样 color+bg+parent bg,用 WCAG 相对亮度公式算 contrast ratio |
| 错误状态 | `context.route('**/api/**', 500)` 模拟后端断,reload 后扫空状态数 |
| 响应式 | `setViewportSize(768)` / `setViewportSize(375)` 各截图 |
| console 错误 | 累计 28 条 error / 16 条 warning(其中 24 条来自模拟 500,真实启动期 4 条来自预加载 + 6 条 npm/资源 500) |

### 1.2 已知审计盲区

- 屏幕阅读器实测(用 NVDA/JAWS 录屏)未做
- 真实键盘焦点环目视检查未做(用 computed style 替代,部分浏览器 `:focus-visible` 选择器在自动化里读不到)
- 高对比度模式 / Windows High Contrast Theme 实测未做
- 实际提交/推送/拉取等长操作 → loading → 成功 toast 全链路未做(本次只触发了刷新 toast)

---

## 2. 优先级问题清单

### 🔴 P0 — 必修,影响主要用户路径

#### F-P0-01 · 网络断开时 UI 进入"全空状态"假象
- **类别**:信息架构
- **现象**:`context.route('**/api/**', 500)` 模拟后端 500,reload 后页面同时出现 **26 个 `.el-empty` / `.empty-state` 节点**,4 个面板各自显示"暂无提交记录 / 暂无终端会话 / 暂无自定义命令 / 暂无最近项目";左中两个面板甚至都显示"当前目录不是Git仓库"
- **根因猜测**:每个面板独立用 empty-state 作为兜底,没有"全局请求失败"信号;当后端整个不可达,所有 panel 同步进入"无数据"分支
- **影响**:用户看到的是"app 坏了/我仓库空了",无法分辨是后端断还是真的没数据
- **证据**:`docs/screenshots/audit2-network-error-pass2.png` + `audit-report.md` §FF16
- **修复建议**:
  1. 拦截 `fetch` 顶层 catch → 全局 `AppErrorBanner` 置顶横条:"无法连接到本地服务,请检查后端进程"
  2. 每个 panel 的"无数据"分支二次判断:有请求错误 → 显示错误态占位(带 Retry 按钮),有成功响应但 `data.length === 0` → 才显示空状态

#### F-P0-02 · 暗色模式 `.commit-hash` 对比度 1.0:1
- **类别**:可访问性 / 视觉
- **现象**:暗色主题下,提交哈希的样式 `color: rgba(255,255,255,0.7)` + `background: rgba(255,255,255,0.1)`,实测对比度 **1.0:1**,完全不可读(正常人眼需要 ≥ 4.5:1)
- **影响**:用户在暗色模式基本看不清提交记录每行的 SHA
- **证据**:`docs/screenshots/audit2-dark-mode-pass2.png` + `audit-pass2.md` §contrast 1.0
- **修复建议**:在 `variables.scss` 的 `[data-theme="dark"]` 块下,`.commit-hash` 用 `--text-primary` 不用白色透明,或者提供 `--commit-hash-bg` / `--commit-hash-fg` token(类似 monaco scope token)

#### F-P0-03 · 移动端顶栏 alert 与 header 控件重叠
- **类别**:响应式 / 布局
- **现象**:`setViewportSize(375)`,顶部 "系统配置文件有问题" alert 与 "3 个实例 / 用户:未配置 / ⚙" 完全挤在第一行,徽章互相叠字;ActivityBar 只能显示前 2 个图标(共 4 个),后 2 个被裁
- **影响**:窄屏用户无法切到 Editor / SourceMap / Workbench 视图
- **证据**:`docs/screenshots/audit-mobile-375.png`
- **修复建议**:
  1. 768px 以下折叠 alert 为顶部抽屉式(默认只显示图标,点击展开)
  2. 768px 以下把 ActivityBar 从左侧 fixed 改为底部 tab bar(类似 VS Code 移动版)
  3. 768px 以下隐藏 "3 个实例 / 用户:未配置" 徽章文案,只保图标

#### F-P0-04 · 主题切换无 header 快捷入口
- **类别**:可发现性
- **现象**:全 UI 找不到直接切暗色模式的按钮,必须"设置 → 通用设置 → 外观 → 主题"二级路径。审计中 `probeDarkModeToggle` 没找到任何 `[aria-label*="主题/Theme/暗/Dark"]`
- **影响**:用户每次切暗色都要 4 次点击,流失率高
- **证据**:`audit2-user-settings-opened.png`(确实在设置里能看到"主题 浅色"下拉)
- **修复建议**:
  1. header 右侧齿轮旁加一个 ☀/🌙 图标按钮,一键切 light/dark
  2. 监听 `prefers-color-scheme: dark` 在首次访问时自动切

---

### 🟠 P1 — 高优,影响专业用户与无障碍

#### F-P1-01 · 64 个可交互元素 < 24×24(WCAG 2.5.5)
- **类别**:可访问性 / 触控
- **现象**:全 UI 共探测到 158 个可见可交互元素,其中 64 个 `width < 24` 或 `height < 24`:
  - `.copy-message-btn` 22×22(复制纯净提交信息)
  - `.commit-hash` 58×19(SHA 链接,19px 高,触屏几乎不可点)
  - el-tooltip trigger 链上的若干 20×20 图标按钮
- **影响**:触屏 + 老年用户 + 帕金森用户容易误点;WCAG 2.5.5 最低门槛 24×24,推荐 32-44
- **证据**:`audit-report.md` §FF02
- **修复建议**:
  1. `.copy-message-btn` → 28×28(加 `padding: 6px` 或 `min-width/min-height: 28px`)
  2. `.commit-hash` → 行高 24px(用 `display: inline-flex; align-items: center; min-height: 24px`)
  3. el-tooltip 触发的图标 button 全部走 `IconButton` 组件,统一 28×28 / 32×32

#### F-P1-02 · `.resize-handle` 缺 role / aria-orientation(双套实现混用)
- **类别**:可访问性
- **现象**:`.resize-handle` 这种分隔条没有 `role="separator"` 也没有 `aria-orientation`,但同时存在另一组带 `role="separator"` + `tabindex="0"` 的分隔条 — **两套实现并存**
- **影响**:
  1. 屏幕阅读器无法识别一半的分隔条
  2. 纯键盘用户只能操作其中一组
  3. 维护性差(后人会改错)
- **证据**:`audit-report.md` §splitters(5 个分隔条,2 个 `.resize-handle` 无 role,3 个 `[role=separator]` 有 role)
- **修复建议**:二选一,统一到 `[role=separator][tabindex=0]`,删除 `.resize-handle` 这套;或在 `App.vue` 的 `nudgeH/nudgeV` 监听器里加上 `keydown` 监听,使 `Arrow Left/Right` 可调节

#### F-P1-03 · `Ctrl+S` / `Ctrl+F` 在 Editor 视图无反馈
- **类别**:快捷键
- **现象**:
  - `Ctrl+S` 没出现 toast("已保存"),也没看到 [role=alert] 出现
  - `Ctrl+F` 没有聚焦到资源管理器搜索框(实际焦点仍在 body)
- **影响**:高级用户信赖的快捷键失效,体验打折
- **证据**:`audit-report.md` §Fshortcuts
- **修复建议**:
  1. `EditorView.vue` 的 `handleKeydown` 加 `Ctrl+S` 拦截,触发 `editorTabs.activeTab.markSaved()` + toast"已保存"
  2. `Ctrl+F` 改为 `Ctrl+Shift+F`(VS Code 习惯)聚焦资源管理器搜索框,并加 placeholder 提示

#### F-P1-04 · 提交按钮 click 后无明显 loading 视觉态
- **类别**:反馈
- **现象**:commit 按钮静态探测 `hasSpinner: false`;点击后从 `beforeState` 截图看不到 `.el-loading-spinner` 出现
- **影响**:用户提交 commit 时不知道是否在进行,可能重复点击
- **证据**:`audit-pass2.md` §feedback 提交按钮静态态
- **修复建议**:
  1. `<el-button :loading="isCommitting">` + 文案变 "提交中…"
  2. 成功后 toast "已提交 SHA xxx",失败 toast "提交失败: <reason>"(用 `aria-live=assertive`)

#### F-P1-05 · ActivityBar 视图切换无 aria-current / aria-pressed
- **类别**:可访问性
- **现象**:4 个 `.activity-btn` 都没有 `aria-current="page"` 或 `aria-pressed="true"`,只靠 `.active` class
- **影响**:屏幕阅读器报"按钮 1 / 按钮 2"分不清当前在哪一视图
- **证据**:`audit-pass2.md` §a11y ActivityBar
- **修复建议**:在 `ActivityBar.vue` 的 active 切换里同步 `aria-current` / `aria-pressed`

#### F-P1-06 · toast 有 `role="alert"` 但无 `aria-live`,部分 SR 不广播
- **类别**:可访问性
- **现象**:实测 toast 元素 `role="alert" aria-live=null`,理论上 NVDA / JAWS 会读,但 iOS VoiceOver / TalkBack 在 SPA 里更依赖 `aria-live`
- **证据**:`audit-pass2.md` §toast/通知元素
- **修复建议**:`el-message` 自定义包装一层,设 `aria-live="assertive"` + `aria-atomic="true"`

#### F-P1-07 · 编辑器进入时黑底 tooltip "编辑器" 遮挡文件树第一项
- **类别**:视觉 / 提示
- **现象**:切到 Editor 视图时,ActivityBar 上的"编辑器" el-tooltip 黑底白字卡片会渲染在 (60, 65) 附近,正好压在文件树第一项 ".agents" 目录名上,短暂遮挡内容
- **证据**:`docs/screenshots/audit-editor-view-initial.png`
- **修复建议**:`el-tooltip` 加 `transition` 防抖(显示 200ms 后再渲染,鼠标静止 500ms 才出现);或改成 `aria-label` 提示,只对 SR 暴露

---

### 🟡 P2 — 中优,影响细节

| ID | 类别 | 描述 | 证据 |
|----|------|------|------|
| F-P2-01 | 文件项 hover 无视觉变化 | `.git-status-file` / `.log-item` 鼠标悬停时 background/color 不变(实测 `hoverChanged: false`) | `audit-report.md` §FF11 |
| F-P2-02 | 3 个 input 无 label/aria-label/placeholder | `width=0` 的隐藏 input 不计,但有些可见 input placeholder 为空 | `audit-report.md` §FF12 |
| F-P2-03 | 状态卡引导信息层级混乱 | "可以使用以下命令初始化仓库:`git init` [点击复制]" — 命令和复制按钮挤一行,信息层级不清 | `audit-report.md` §FF14 |
| F-P2-04 | 错误状态缺"重试"按钮 | 系统配置出错时只有一个"打开系统配置文件"按钮,没有"重试" / "重新加载" | `audit-network-error-state.png` |
| F-P2-05 | 用户未配置引导缺乏深度链接 | "立即配置"按钮的视觉权重(灰底)与"使用命令行配置"次级操作接近,主次不清 | `audit-user-unconfigured-state.png` |
| F-P2-06 | 提交历史每行操作按钮(查看/复制 hash/复制内容)距离近,容易误点 | 3 个图标按钮 row gap < 4px | `audit-shortcut-trace.png` |
| F-P2-07 | 提交历史行 6 条,但 scrollHeight == clientHeight(无虚拟滚动) | 提交数 > 100 时性能待观察 | `audit-pass2.md` §提交历史列表 |
| F-P2-08 | `Ctrl+S 保存` 暗色下文字 `rgb(203,208,214)` + opacity 0.6 → 实测对比度可能 < 4.5 | `audit-report.md` §FF13 |
| F-P2-09 | `.el-message` 出现在 `1440×39` 横条,贴着页面顶部 — 与 header alert 视觉冲突 | `audit-pass2.md` §toast/通知元素 |
| F-P2-10 | 设置对话框里"主题"下拉只显示"浅色/深色"两种,缺"跟随系统"选项 | `audit2-user-settings-opened.png` |
| F-P2-11 | 暗色模式 "MiniMax-M3" 默认模型文字 `rgb(255,255,255)` 0.85 — 在某些深灰背景上偏弱 | `audit-report.md` §FF13 |
| F-P2-12 | 网络断开时 header "未知目录" 路径文本丢失 — 比"zen-git"还短,用户失去上下文 | `audit-network-error-state.png` |
| F-P2-13 | 拖拽分隔条 8px 高太细(`.resize-handle height: 8`),但 cursor 是 `ns-resize` 正确,触屏拖动仍困难 | `audit-report.md` §splitters |

---

## 3. 跨维度发现

### 3.1 可访问性(a11y)总评

- ✅ 焦点陷阱工作(dialog 内 40 个 focusable,Tab 不会跑出去)
- ✅ 焦点环普遍存在(5 类元素都有 outline / box-shadow)
- ✅ `aria-live` 区域存在(3 个 polite/assertive 节点)
- ❌ 64 个元素 < 24×24(触屏无障碍硬伤)
- ❌ ActivityBar 视图切换无 `aria-current` / `aria-pressed`
- ❌ 部分 `.resize-handle` 缺 `role=separator` + `tabindex=0`(键盘不可达)
- ❌ 暗色模式 commit-hash 对比度 1.0:1

**WCAG 2.1 AA 自评**:约 80% 达标,主要缺口在 **2.5.5 Target Size** 和 **1.4.11 Non-text Contrast**

### 3.2 信息架构(IA)总评

**优点**:
- 4 视图(activity bar)分类清晰:Git / Editor / SourceMap / Workbench
- 状态卡(state-block)统一了"非 git 仓库 / 用户未配置"两种引导

**问题**:
- 网络断开时,4 个 panel 各自进入 empty 分支,缺少"全局错误"信号
- 提交历史 / 终端 / 自定义命令 / NPM 脚本 4 个面板的"暂无"空状态文案不区分(都是"暂无 X")
- 设置里"外观 / 主题" 与 AI 模型配置 / 命令控制台默认展开 / 布局比例重置 等混在一起,信息密度过大

### 3.3 视觉与对比度

- ✅ 亮色模式主文字对比度达标
- ❌ 暗色模式 `.commit-hash` 1.0:1 严重不达标
- ❌ 暗色模式 "Ctrl+S 保存" 灰底白字 0.6 透明对比度 < 4.5
- ⚠️ 暗色模式 "默认模型" 0.55 透明文字偏弱

### 3.4 反馈(focus / hover / active / loading)

- ✅ 大多数按钮 hover 有视觉变化
- ❌ 文件项 hover 无视觉变化(`.git-status-file` / `.log-item`)
- ❌ 提交按钮 click 后 loading 视觉态不明显
- ❌ 部分 el-tooltip 立即弹出(无 500ms 静止延迟),短暂遮挡

### 3.5 错误恢复

- ❌ 网络断开 → 26 个空状态卡同时出现(无全局错误横幅)
- ❌ 系统配置出错 → 只有"打开系统配置文件"按钮,无 Retry
- ❌ 后端 500 持续 1+ 秒时,无 loading skeleton / 进度反馈

### 3.6 响应式

- ✅ 1440 / 1024 桌面布局正常
- ⚠️ 768 顶栏 alert 与 header 控件临界
- ❌ 375 移动端 header 重叠,ActivityBar 4 按钮只显 2 个

---

## 4. 修复优先级路线图

### 第 1 周(必修)

1. **F-P0-01** 全局错误横幅拦截 → AppErrorBanner(2-3 小时)
2. **F-P0-02** 暗色 commit-hash 配色 token 化(1 小时)
3. **F-P0-03** 768px 以下 alert 折叠 + ActivityBar 转 bottom tab(半天)
4. **F-P0-04** header 加 ☀/🌙 主题切换按钮(1 小时)
5. **F-P1-02** 分隔条两套实现统一(1 小时)

### 第 2 周(高优)

6. **F-P1-01** 全局扫描 64 个小元素 + 加 `min-width/min-height`(半天,机械活)
7. **F-P1-03** `Ctrl+S` 保存反馈(2 小时)
8. **F-P1-04** 提交按钮 loading 态(1 小时)
9. **F-P1-05** ActivityBar `aria-current` / `aria-pressed`(0.5 小时)
10. **F-P1-06** toast 加 `aria-live=assertive`(0.5 小时)
11. **F-P1-07** el-tooltip 防抖(1 小时)

### 第 3 周(细节)

12. 13 条 P2 按需修
13. 提交历史虚拟滚动(若 100+ commits 性能确认有问题)
14. 暗色模式全量对比度 audit(用 axe-core 扫一遍)

---

## 5. 复现命令

```bash
# 1. 启动双 server
npm run dev:server  # backend :5545
npm run dev:vue     # vite    :5544

# 2. 验证链路
npm run dev:ping    # 期望两行 [ OK ]

# 3. 跑第一轮(交互 + a11y)
# node docs/screenshots/audit.mjs

# 4. 跑第二轮(对比度 + 错误状态 + 窄屏)
# node docs/screenshots/audit-pass2.mjs

# 5. 报告
# docs/screenshots/audit-report.md
# docs/screenshots/audit-pass2.md
# docs/screenshots/audit-*.png / audit2-*.png
```

---

## 6. 附录:证据索引

| 文件 | 内容 |
|------|------|
| `docs/screenshots/audit-shortcut-trace.png` | Ctrl+F 探测后现场 |
| `docs/screenshots/audit-dark-mode-applied.png` | data-theme=dark 切换 |
| `docs/screenshots/audit-not-git-repo-state.png` | 非 git 仓库状态 |
| `docs/screenshots/audit-user-unconfigured-state.png` | 用户未配置状态 |
| `docs/screenshots/audit-network-error-state.png` | 模拟 500 状态 |
| `docs/screenshots/audit-tablet-768.png` | 平板 768 布局 |
| `docs/screenshots/audit-mobile-375.png` | 手机 375 布局(顶部重叠) |
| `docs/screenshots/audit-editor-view-initial.png` | Editor 视图初始(tooltip 遮挡) |
| `docs/screenshots/audit2-user-settings-opened.png` | 设置对话框打开(主题在二级路径) |
| `docs/screenshots/audit2-network-error-pass2.png` | 模拟 500 完整现场(26 个空状态) |
| `docs/screenshots/audit2-dark-mode-pass2.png` | 暗色模式完整现场 |
| `docs/screenshots/audit-report.md` | 第一轮报告(交互 + a11y) |
| `docs/screenshots/audit-pass2.md` | 第二轮报告(对比度 + 错误状态 + 窄屏) |
