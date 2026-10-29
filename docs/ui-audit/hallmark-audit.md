# Hallmark 审计与 polish（2026-10-30 · v2.18.26）

方法：Hallmark v2.0.0（`~/.codebuddy/skills/hallmark`），对 `src/ui/client/src` 跑
`sloplint --scope app`，再按 `references/gates.md` §4 人工走一遍 app 形态的判据。
深度按 `references/redesign.md` 取 **polish**：系统与布局都不动，只改判据点名的
tells（空态壳、动效、状态表达）。

## 一、先说结论：1597 条里有 1400 条不该按字面改

| Gate | 条数 | 是什么 | 为什么不逐条改 |
|---|---|---|---|
| 24b | 617 | 间距不在 4px 台阶上（5 / 6 / 9 / 14px） | 本仓的间距是"4px 骨架 + 光学微调"，全量对齐等于把每个面板重排一遍，探针里的几何断言会集体失效 |
| 48 | 487 | 颜色字面量不在令牌块里 | 绝大多数是 `color-mix(令牌 55%, #000)` 这类**对比度算式**（活动栏徽标有实测 ≥6:1 的注释）与 Element Plus 覆盖，属于主题外的例外 |
| 33 | 149 | `<svg>` 没有 `aria-hidden` / `aria-label` | 图标都在带 `aria-label` 的 button 内；该补，但属于 a11y 债，单独排 |

另外三条是**本仓既有口径**，不是缺陷：

- **39a 禁用态**：全应用 34 处统一走 `--disabled-opacity` + `cursor: default`，
  三通道（fill / ink / cursor）改法要动所有控件，先记账。
- **62 减少动效**：`styles/common.scss` 开头已有全局 kill switch
  （`prefers-reduced-motion: reduce` 下 `animation/transition-duration: 0.01ms`），
  linter 只读单文件所以看不见。
- **10a 动效属性**：`--transition-all` 这个名字骗人，它的值早就是
  `color / background-color / border-color / box-shadow / opacity / transform`
  的显式列表，不是 `transition: all`。

## 二、本轮动手的三件事

### 1. 空态不再套壳（5 个面）

判据：3（图标砖 + 标题的等宽卡片）、29（装饰性光斑）、以及用户既有口径
「不要圆角 + 单 border 的卡片」。

原来同一个"这里没有东西"长成了四种样子，其中三种是**虚线圈 + 淡底 + 圆角**，
工作台侧栏那处更重：135° 渐变底 + 右上角径向光斑 + 52px 圆角图标砖 + 彩色投影。

现在统一成**裸文字 + 留白**（侧栏走共享 `EmptyState`，图标 28px / 35% 不透明度）：

| 面 | 文件 |
|---|---|
| 工作台左栏 | `views/components/WorkbenchSidebar.vue`（改用 `components/EmptyState.vue`） |
| 看板空列 | `views/components/WorkbenchKanban.vue` `.kb-col__empty` |
| 控制台右栏 | `views/components/OrchestratorConsole.vue` `.oc-empty` |
| 执行日志 | `components/ExecutionLogManager.vue` `.exec-logs__empty` |
| 记忆库 | `components/MemoryPanel.vue` `.mem-panel__empty` |
| 项目管理 | `views/components/ProjectManagePanel.vue` `.pm-list__state` |

**保留虚线**的只剩真正是"动作 / 放置目标"的那几处（看板「+ 新建任务」、拖放区）——
虚线是 affordance，不是装饰；两者长得像会让人以为空列也能点。

![旧写法（虚线框空态）](./hallmark-shots/empty-boxed-legacy-light.png)
![现在（平铺空态）](./hallmark-shots/empty-flat-light.png)

### 2. 暗色看板列身降浓度

判据：23（单一强调色的占屏面积）。浅色档是 `9% hue` 兑白底，落在暗色画布上
（`color-mix(hue N%, transparent)` 合成到 `--surface-canvas`）时，两整列 600px 高的
棕色 / 墨绿块就成了这一屏最大的色块，靠近处看是"染色"，不是"氛围"。

暗色档：`pending 12% → 6%`、`active 9% → 5%`、`done 9% → 5%`；
**列头的 26% 色带和角色 ink 一个字都没动**，身份仍由列头 + 计数 chip + 状态点承担。
浅色档不动（那是用户逐轮调过的口径，`verify:wb-colors` 的 C3 也按浅色口径断言）。

![深色（列身降浓度后）](./hallmark-shots/after-dark-workbench.png)

### 3. 顺带确认的既有优点（没动）

亮/暗两套角色色、进度条的 `--role-*-bar`、卡片不给自己染底色（第五轮）、
空态与动作的图标语义，都是这套 UI 里已经做对的部分，本轮没有回退。

![浅色现状](./hallmark-shots/after-light-workbench.png)

## 三、回归

- `npm run tsc` / `npm run build`：绿
- `verify:wb-colors`：9/10（C3d 需要一条出错任务，当前数据里没有 —— 数据依赖）
- `verify:wb-progress-report`：67/68（P15c `items=0`，间隔档位下拉未取到，与本轮无关）
- `verify:memory-panel`：12/12
- `verify:project-manager`：50/50
- `verify:ui-consistency`：38 PASS / 5 FAIL，5 条红全落在本轮**没碰**的文件里
  （`CopySessionButton` / `WorkbenchTaskMoveMenu` / `SchedulePanel` /
  `ProjectManageItem` / `DispatchSettings`）+ 图标尺寸棘轮浮动（13 > 12），存量

复现审计：

```bash
node ~/.codebuddy/skills/hallmark/scripts/sloplint.mjs src/ui/client/src --scope app
```

## 四、没做、但值得排期的

1. **活动栏 / 顶栏的 `#fff` `#000`**：换成 `--color-white` / `--color-black`
   像素为零，只是让 48 条 gate 变绿，优先级低于上面的视觉问题。
2. **emoji 当图标**（30a，32 处）：flow 节点的 📋⏰📦✋🧩🚀🔀⌨️、执行日志的 📁⏱、
   Git 锁定区的 🔒 —— 换成 SVG 收益明显（emoji 是最典型的"生成感"），
   但要同步 i18n 与断言里读到的字形，适合单独一轮。
3. **svg 的 aria-hidden**（33，149 处）：机械但量大。
