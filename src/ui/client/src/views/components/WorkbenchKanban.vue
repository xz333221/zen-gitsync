<!--
  ~ Copyright 2026 xz333221
  ~
  ~ Licensed under the Apache License, Version 2.0 (the "License");
  ~ you may not use this file except in compliance with the License.
  ~ You may obtain a copy of the License at
  ~
  ~     http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing, software
  ~ distributed under the License is distributed on an "AS IS" BASIS,
  ~ WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  ~ See the License for the specific language governing permissions and
  ~ limitations under the License.
  -->
<!--
  多项目编排台 · 中栏：任务看板。

  关于「列」的一处重要克制：这四列是**推导出来的阶段**，不是可拖拽的状态字段。
  待处理/进行中/已完成 全部由执行事实推出（后端 deriveTaskColumn）：
  有 job 在跑就是进行中、最近一条 job 跑完才是已完成……
  所以卡片不支持拖动换列——拖过去也没有对应的写操作可做，
  与其做一个拖了就弹回去的假交互，不如让动作落在「执行 / 查看详情」这两个真按钮上。

  「手动标完成」是 2026-10-01 补的，它是上面那句话唯一的例外，而且不违反它的理由：
  推导不出来的是**两件只有人知道的事** —— 一条待在「待处理」里的任务其实早在别处干完了；
  一条「进行中」的任务模型已经不说话了，用户比静默看门狗更早判断它干完了。
  这两件事有对应的写操作（后端 POST/DELETE /tasks/:id/done，落到 task.manualDoneAt），
  所以卡片右下角给了一颗真按钮（.kb-card__btn--done），而不是让它去拖列。
  列本身仍然是推导的：撤销标记之后回到哪一列，还是执行事实说了算。

  点卡片 = 直接进任务编辑器（open-task）：编辑器是"浮在看板之上的弹窗"，
  关掉就回到原来的位置和筛选，本身就不会丢上下文。
  （曾经这里先弹一个只读详情弹窗、再从里面点「打开编辑器」——那多出来的一跳，
   在编辑器还是独立页面时是为了保住看板位置；编辑器改成弹窗之后这个理由就不成立了，
   2026-09-20 去掉。执行 / 停止 / 删除仍然留在卡片上，扫全局时就地处理的路子没变。
   其中「停止」是 2026-09-30 补的：一条任务卡了半小时，用户在看板上看着它转，
   想停却只能点进编辑器翻到那一栏 —— 「就地处理」在"任务正在跑"这个最需要它的场景上恰恰是缺的。）

  工具条上只有一个搜索框：原来并排的「仅看报错」勾选框 2026-09-29 去掉——
  "哪条任务报过错"卡片自己就有标记（.kb-card.has-error + 小红点），
  真要筛也就少数几次，为此常驻一个勾选框占着工具条不划算。

  列表视图 2026-09-30 补上时间列并改成最新的在最上边。此前它有两处对不上：
  一是「状态 / 时间」两列其实从没露过面（表格被 nowrap 正文撑到横向溢出，
  两列被推出可视区，DOM 里量得到、屏幕上什么都没有 —— 详见 .kb-table 的注释），
  二是那列时间用的是 `updatedAt || createdAt`，撑不起排序：执行完成只写 jobs.json，
  tasks.json 里的 updatedAt 一直停在创建/编辑时刻，于是十几行全是同一个时间。
  现在时间列与排序键都统一到 cardTime（与看板卡片同一口径），排序键 = 显示键。

  被点开过的那张卡片（.kb-card.is-opened，id 由上层给的 openedTaskId）取消 hover：
  「执行 / 停止 / ×」不再随鼠标浮出、卡片也不再抬升、正文右侧的渐隐一并撤掉。
  理由是这条任务已经在编辑器里了（执行 / 停止 / 删除在那儿都有），卡片上再摆一份
  只会跟正文抢右下角那块地方 —— 顺带把"鼠标恰好停在这张上"的误触也堵掉。
  键盘仍然可达（:focus-within 照旧浮出），否则 Tab 过去就摸不到这几个按钮。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { $t } from '@/lang/static'
import { Search } from '@element-plus/icons-vue'
import TaskExecutorIcon from '@/components/TaskExecutorIcon.vue'
import type { BoardTask, BoardTaskLive, TaskColumn } from '@/types/workbench'
import { taskExecutorName, type TaskExecutorId } from '@/utils/taskExecutor'
import { projectTagStyle } from '@/utils/projectTag'
import { formatDurationMs, relativeTimeFromIso, clockFromIso } from '@/utils/relativeTime'
import { reportSilentMs } from '@/utils/progressReport'

const props = defineProps<{
  tasks: BoardTask[]
  /** 视图为「全部项目」时在卡片上标出项目名，避免同名任务分不清 */
  projectLabels: Record<string, string>
  showProjectLabel: boolean
  /**
   * 用户从看板上点开过的任务 id（null = 还没点开过任何一条）。
   * 这张卡片取消 hover —— 见文件头那段说明。
   * 刻意**不**复用上层的 selectedTaskId：它在首次加载时就会自动落到某条任务上
   * （applyRestoredSelection），拿它当"点开过"会让一张从没被碰过的卡片莫名丢掉操作按钮。
   */
  openedTaskId: string | null
}>()

const emit = defineEmits<{
  /** 打开任务编辑器（上层把编辑器弹窗顶起来，不换页） */
  'open-task': [task: BoardTask]
  'run-task': [task: BoardTask]
  /** 停止这条任务正在跑的那一轮（与编辑器的「停止」同一个接口，确认弹窗也在上层统一） */
  'stop-task': [task: BoardTask]
  /** 手动把这条任务标成「已完成」（在跑的会连这一轮一起停掉，代价说明在上层） */
  'complete-task': [task: BoardTask]
  /** 撤销手动标的完成标记，退回待处理 */
  'reopen-task': [task: BoardTask]
  'delete-task': [task: BoardTask]
  'create-task': []
}>()

const VIEW_KEY = 'wb.boardView.v1'

const view = ref<'kanban' | 'list'>((() => {
  try {
    const v = localStorage.getItem(VIEW_KEY)
    return v === 'list' ? 'list' : 'kanban'
  } catch {
    return 'kanban'
  }
})())
watch(view, (v) => {
  try { localStorage.setItem(VIEW_KEY, v) } catch { /* 隐私模式：不落地也不影响使用 */ }
})

const search = ref('')

const COLUMNS: { key: TaskColumn; labelKey: string }[] = [
  { key: 'todo', labelKey: '@WORKBENCH:待处理' },
  { key: 'doing', labelKey: '@WORKBENCH:进行中' },
  { key: 'done', labelKey: '@WORKBENCH:已完成' },
]

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  return props.tasks.filter(t => {
    if (!q) return true
    return (t.title || '').toLowerCase().includes(q) || (t.desc || '').toLowerCase().includes(q)
  })
})

const columns = computed(() =>
  COLUMNS.map(c =>
    c.key === 'done'
      ? { ...c, tasks: filtered.value.filter(t => t.column === c.key).sort(byDoneAtDesc) }
      : { ...c, tasks: filtered.value.filter(t => t.column === c.key) }
  )
)

/**
 * 「已完成」列要回答的是"我刚干完的是什么"，所以按**完成时间**倒序，最新完成的在最上边。
 * 另两列不动：待处理/进行中沿用 tasks.json 的顺序（= 创建顺序），那里"先来后到"更有意义。
 *
 * 排序键刻意和卡片上显示的时间是同一个值（见 cardTime）——
 * 拿 A 排、显示 B 的话，用户看到的会是一列时间乱跳的卡片，看着就像没排过。
 * 回退链：手动完成标记 → 最近一条 job 的结束时间 → updatedAt → createdAt。
 * 手动标记排在最前：手动收掉的任务往往**没有**"跑完的时刻"（最近一条 job 可能是
 * 三天前那次报错），拿它当完成时间，用户刚点完完成、卡片上写着「3 天前」，
 * 排序也会把它沉到底下 —— 而他刚做的那件事本该在最上面。
 * 更后面两级是给"没有 job 记录却进了已完成列"的任务兜底的
 * （例如完成任务后执行记录被清空），它们的完成时刻只能退到最后一次被改动的时刻。
 */
function doneAt(t: BoardTask): string {
  return String(t.manualDoneAt || t.lastJobEndedAt || t.updatedAt || t.createdAt || '')
}

function byDoneAtDesc(a: BoardTask, b: BoardTask): number {
  // ISO 字符串直接字典序比较即可（与后端 laterOf 同一口径）
  return doneAt(b).localeCompare(doneAt(a))
}

/**
 * 一条任务"最近发生了什么"的时间 —— 看板卡片（cardTime）与列表视图的时间列**共用这一个**。
 *
 * 已完成的给完成时刻（doneAt），其余给最后变动时刻。列表视图单独再写一遍
 * `updatedAt || createdAt` 的话，同一条任务在两个视图里会显示两个时间；
 * 更糟的是拿显示不出来的那个键去排序（列表视图 2026-09-30 之前就是），
 * 用户会看到一列看不出先后的时间 —— 看着就像没排过。
 */
function cardTime(t: BoardTask): string {
  return t.column === 'done' ? doneAt(t) : (t.updatedAt || t.createdAt || '')
}

/**
 * 卡片上那行「用时 x」；不适用时是空串（模板据此整行不渲染）。
 *
 * **只在没有 job 在跑时给值**：正在跑的那个时长每 5s 都在长，已经写在活动区第一行的
 * 「已运行 x」里（live.elapsedMs）。两处各给一份、一个会长一个不长的数字，
 * 用户会以为其中一个坏了 —— 所以判据是「这张卡片有没有活动区」，不是「哪一列」。
 *
 * 服务端给不出（lastDurationMs 为 null：从没执行过 / 老记录缺 startedAt 或 endedAt）
 * 就空着。用时是给人判断"这条是不是特别磨"的参考，宁可没有也不要一个假的 0。
 */
function cardDuration(t: BoardTask): string {
  if (t.live) return ''
  return formatDurationMs(t.lastDurationMs)
}

/**
 * 用时那一行的悬停提示：把「用时」背后的两个绝对时刻摊开（几点起、几点止）。
 *
 * 相对时间（"3 小时前"）+ 用时（"12 分"）已经能回答"跑了多久"，但答不了"是哪一段"——
 * 排查某段时间里到底跑过什么时，得能指着绝对时刻。两者都取不到就退回空提示，
 * 不拼一个"无"/"-"出来占位。
 */
function cardTimeTitle(t: BoardTask): string {
  const dur = cardDuration(t)
  if (!dur) return ''
  const from = clockFromIso(t.lastJobStartedAt)
  const to = clockFromIso(t.lastJobEndedAt)
  // 只有起止都拿得到才给区间；缺一头的话那串时刻对不上号，反而误导
  if (!from || !to) return dur
  return `${dur} · ${from} → ${to}`
}

/**
 * 「AI 判定完成」那个小标的悬停提示：把模型给的依据原样摆出来。
 *
 * 标本身只有四个字，看不出"凭什么说它完成了" —— 而依据正是用户唯一能判断
 * 该不该信这次自动收尾的东西。没给依据时退回一句"模型未给依据"，
 * 而不是把标也一起藏掉：藏了的话卡片就和不声不响换列没区别了。
 */
function autoDoneTitle(t: BoardTask): string {
  const reason = (t.autoCompleted?.reason || '').trim()
  const head = $t('@WORKBENCH:静默超时后由 AI 核对，判定这条任务已经完成')
  return reason ? `${head}\n${reason}` : head
}

/**
 * 列表视图的行序：最新的在最上边。
 *
 * 排序键 = 显示键（cardTime），理由同上面那段：按 A 排、显示 B 的话，
 * 用户看到的是一列时间乱跳的行。回退到空串的任务（连 createdAt 都没有）
 * 会沉到最后 —— 没有任何时刻可依据时，"最旧的"是比"最新"更安全的默认。
 *
 * 复制一份再排：filtered 同一份数组还被看板的 columns 用着，原地 sort 会把它一起改掉。
 */
const listRows = computed(() => [...filtered.value].sort((a, b) => cardTime(b).localeCompare(cardTime(a))))

/**
 * 列轨道数跟着列数走。
 * 写死在 CSS 里的 `repeat(4, ...)` 在去掉「评审中」之后留了一条**空轨道**——
 * 三条列各占 1/4，剩下 1/4 全白，正是"评审列占了很大面积"观感的来源。
 * 这里用内联样式取值（而不是改 CSS 里的数字），增删列时不用再记得改 CSS。
 * 窄屏堆叠走的是 @media 改 `display`（不是改轨道数），所以不会被内联样式压住。
 */
const columnsStyle = computed(() => ({
  gridTemplateColumns: `repeat(${columns.value.length}, minmax(0, 1fr))`,
}))

/** 卡片标题：优先任务标题；没写标题时用描述压平成一行（与侧边栏任务行同一约定） */
function cardTitle(t: BoardTask): string {
  const title = (t.title || '').trim()
  if (title) return title
  return (t.desc || '').replace(/\s+/g, ' ').trim()
}

/**
 * 项目名。标签的颜色单走 projectTagStyle(t.projectPath) ——
 * 名字给人读，色相给眼睛扫，两者都按任务上的原始 projectPath 取，
 * 不在这里再引一次路径归一逻辑（两侧规则一分叉，颜色就会和名字对不上）。
 */
function projectLabel(t: BoardTask): string {
  return props.projectLabels[t.projectPath] || ''
}

/** 最近一次执行报过错——给卡片一个"需要你看一眼"的标记 */
function hasError(t: BoardTask): boolean {
  return t.lastJobStatus === 'error'
}

/**
 * 卡片上那个品牌图标该画谁：**在跑时以 live.agent 为准**，没在跑才看最近一条 job 的 agent。
 *
 * 两个字段本来就有分工（live 跑完即消失、lastJobAgent 是历史事实），正常情况下同源；
 * 但"同一个任务连点两次执行、换了执行器"这类场景下，跑着的那条和最新落盘的那条可能不是同一条
 * （pickLiveActivity 挑的是"最近有动静的"，latestJob 挑的是"启动最晚的"）。
 * 正在跑的那条才是用户此刻要看的，所以 live 优先。
 *
 * 空串 = 认不出（老记录没写 agent 字段）→ 不渲染图标，而不是回落成某个品牌：
 * 猜错的执行器比不显示更糟（与后端 jobAgent 同一口径）。
 */
function cardAgent(t: BoardTask): string {
  return t.live?.agent || t.lastJobAgent || ''
}

/**
 * 列表视图那一行状态摘要（看板视图是分行显示，这里只放得下一行）。
 * 优先级与卡片相反：列表行窄，先给**最新的回复**——"它刚说了什么"最能回答
 * "跑到哪了"；没写过正文的任务才退到思考，再退到最近一次工具调用。
 *
 * 执行器图标不进这个字符串：它要渲染成图标而不是字符（拼进来只会得到一串会被
 * text-overflow 截断的文本），由模板摆在整行最前，这里只管文本口径。
 */
function liveSummary(live: BoardTaskLive): string {
  const elapsed = $t('@WORKBENCH:已运行 {elapsed}', { elapsed: formatDurationMs(live.elapsedMs) })
  const text = live.lastLine || live.lastThought || live.lastTool
  return text ? `${elapsed} · ${text}` : elapsed
}
</script>

<template>
  <div class="kb">
    <div class="kb__toolbar">
      <div class="kb__views" role="tablist">
        <button
          type="button"
          role="tab"
          class="kb__view-btn"
          :class="{ 'is-active': view === 'kanban' }"
          :aria-selected="view === 'kanban'"
          @click="view = 'kanban'"
        >{{ $t('@WORKBENCH:看板视图') }}</button>
        <button
          type="button"
          role="tab"
          class="kb__view-btn"
          :class="{ 'is-active': view === 'list' }"
          :aria-selected="view === 'list'"
          @click="view = 'list'"
        >{{ $t('@WORKBENCH:列表视图') }}</button>
      </div>

      <div class="kb__filters">
        <div class="kb__search">
          <el-icon class="kb__search-icon"><Search /></el-icon>
          <input
            class="kb__search-input"
            type="search"
            v-model="search"
            :placeholder="$t('@WORKBENCH:搜索任务标题或描述')"
            :aria-label="$t('@WORKBENCH:搜索任务标题或描述')"
          />
        </div>
      </div>
    </div>

    <!-- 看板视图 -->
    <div v-if="view === 'kanban'" class="kb__columns" :style="columnsStyle">
      <section v-for="col in columns" :key="col.key" class="kb-col" :class="'kb-col--' + col.key">
        <header class="kb-col__head">
          <span class="kb-col__dot" aria-hidden="true" />
          <h3 class="kb-col__title">{{ $t(col.labelKey) }}</h3>
          <span class="kb-col__count">{{ col.tasks.length }}</span>
        </header>

        <ul class="kb-col__list">
          <li
            v-for="t in col.tasks"
            :key="t.id"
            class="kb-card"
            :class="{
              'is-running': t.runningJobs > 0,
              'has-error': hasError(t),
              'is-opened': t.id === openedTaskId,
            }"
            :data-task-id="t.id"
            :aria-current="t.id === openedTaskId ? 'true' : undefined"
            role="button"
            tabindex="0"
            @click="emit('open-task', t)"
            @keydown.enter.prevent="emit('open-task', t)"
            @keydown.space.prevent="emit('open-task', t)"
          >
            <!--
              首行 = 所属项目色标 + 标题 + 时间，三样同一行。
              · 色标原先自己占一行（一枚 60px 的胶囊推着标题和活动区往下走），
                现在跟标题并排：卡片窄，能省一行是一行。
              · 进行中那枚黄点去掉了 —— "在跑"由列本身 + 卡片上的活动区表达，
                再来一枚一闪一闪的圆点属于重复编码，而且它是这张卡上唯一的纯装饰动效。
              · 标题不再单独占行，跟着一起上移。
              title 给完整路径：项目名可能重名（两个都叫 notebook），路径才是唯一答案。
            -->
            <div class="kb-card__row1">
              <span
                v-if="showProjectLabel && projectLabel(t)"
                class="kb-card__project-chip"
                :style="projectTagStyle(t.projectPath)"
                :title="t.projectPath"
              >{{ projectLabel(t) }}</span>
              <p class="kb-card__title" :title="cardTitle(t)">{{ cardTitle(t) || $t('@WORKBENCH:未命名任务') }}</p>
              <span class="kb-card__time">{{ relativeTimeFromIso(cardTime(t)) }}</span>
            </div>

            <!--
              跑完的任务：用时**独占一行**，不挤进上面那个时间位。
              实测首行（项目色标 + 标题 + 时间）在真实数据上已经排满，
              再塞一串「用时 30 分 0 秒」会把项目色标压出 1px 的省略号
              （verify-wb-card-row1 的 C 组守的正是"色标一枚都不许被压窄"）。
              竖着放只多一行 16px，横向一个字节都不占；而且「什么时候跑的」与
              「跑了多久」本来就是两个维度，分两行读比挤在一行清楚 ——
              同理它也没去挤活动区那行"已运行 x · 工具 n 次"。
            -->
            <p v-if="cardDuration(t)" class="kb-card__spent" :title="cardTimeTitle(t)">
              {{ $t('@WORKBENCH:用时 {d}', { d: cardDuration(t) }) }}
            </p>

            <!--
              「这条不是跑完的，是**判**完的」—— 紧跟在那行用时下面（它修饰的就是上面那个时长）。

              为什么**另起一行**、而不是挂在那行用时后面：那行有探针按逐字相等断言
              （verify-wb-task-duration 的 A1「与服务端 lastDurationMs 逐字一致」，A3 还要求
              它不被裁掉尾巴），往里面塞一枚标会同时踩到这两条 —— 而且那行本来就窄。
              竖着放只多一行 16px，横向一个字节都不占。

              为什么要标出来：自动收尾与"进程自己正常退出"在看板上长得一模一样
              （都是「已完成」+ 一段用时），但含义差很远 —— 后者是跑完了，
              前者是**模型读了它的思考与最后那段话，认为活已经干完**。不标的话，
              用户看到的就是一条任务不声不响换了列，而模型给的依据（悬停可见）
              只躺在 jobs.json 里没人看得到。
            -->
            <p v-if="t.autoCompleted" class="kb-card__auto-done" :title="autoDoneTitle(t)">
              {{ $t('@WORKBENCH:AI 判定完成') }}
            </p>

            <!--
              正在跑的任务：把"现在在干嘛"直接写在卡片上。
              在此之前卡片只有右上角一个圆点 —— 一次跑二十分钟的任务，
              用户盯着看只知道"还在跑"，是在改代码还是卡住了完全看不出来，
              只能点进编辑器翻输出。服务端随卡片一起把事实摘要发过来
              （decorateTaskForBoard 的 live，与右栏进度报告同一份实现）。
              证据顺序沿用进度报告面板：工具调用（正在做什么）→ 思考（为什么）
              → 最新回复；每一行没有内容就整行不渲染，不写"暂无"。
            -->
            <div v-if="t.live" class="kb-card__live">
              <p class="kb-card__live-meta">
                <!-- 执行器只留图标 + 悬停提示：卡片这一行本来就窄（已运行 x 分 y 秒 · 工具 n 次），
                     再钉一个 "Claude Code" 文本会把工具次数挤到第二行去。
                     v-if 挡住的是"认不出"（老记录没写 agent 字段）——那时宁可不画 -->
                <span
                  v-if="cardAgent(t)"
                  class="kb-card__live-agent"
                  :title="taskExecutorName(cardAgent(t))"
                >
                  <TaskExecutorIcon :executor="cardAgent(t) as TaskExecutorId" class="kb-card__live-agent-icon" />
                </span>
                <span>{{ $t('@WORKBENCH:已运行 {elapsed}', { elapsed: formatDurationMs(t.live.elapsedMs) }) }}</span>
                <!-- 次数看总数，鼠标停上去看分布：119 次里 118 次都是 Bash，
                     和"改了三处代码"是完全不同的两件事 -->
                <span v-if="t.live.toolCallCount" :title="t.live.toolMix || ''">
                  {{ $t('@WORKBENCH:工具 {n} 次', { n: t.live.toolCallCount }) }}
                </span>
                <!--
                  PID：左栏那个「执行监控」面板去掉了，它的字段里只有这一个卡片上没有，
                  所以并到这一行来（面板其余字段卡片本来就都有，且比它更全）。
                  不走 $t：PID 是中英文都这么写的通用缩写，没有可翻译的余地。
                  放静默之前：静默是"它可能卡住了"的信号，该留在行尾最显眼。
                -->
                <span v-if="t.live.pid" class="kb-card__live-pid">PID {{ t.live.pid }}</span>
                <!-- 静默只在**显然静默**时才有值（服务端有阈值）；0 不画（reportSilentMs） -->
                <span v-if="reportSilentMs(t.live.silentMs) !== null" class="kb-card__live-silent">
                  {{ $t('@WORKBENCH:静默 {elapsed}', { elapsed: formatDurationMs(reportSilentMs(t.live.silentMs)) }) }}
                </span>
              </p>
              <p v-if="t.live.lastTool" class="kb-card__live-line is-tool" :title="t.live.lastTool">
                {{ t.live.lastTool }}
              </p>
              <p v-if="t.live.lastThought" class="kb-card__live-line is-thought" :title="t.live.lastThought">
                <span class="kb-card__live-tag">{{ $t('@WORKBENCH:最近思考') }}</span>{{ t.live.lastThought }}
              </p>
              <p v-if="t.live.lastLine" class="kb-card__live-line" :title="t.live.lastLine">
                <span class="kb-card__live-tag">{{ $t('@WORKBENCH:最新回复') }}</span>{{ t.live.lastLine }}
              </p>
            </div>

            <!--
              已经跑完的任务：留下"它最后说了什么"。
              卡片过去只有标题 + 时间，而模型收尾时常常反问一句「要 push 吗？」——
              这类任务看着是完成了，其实在等用户回话，用户却只能点进去翻日志才知道。
              live 覆盖不到这一段：它只在 running 时有值、跑完就消失，恰好把最有信息量的
              收尾丢掉（服务端 decorateTaskForBoard 的 lastReply，与这里二选一）。
              样式沿用 live 里「思考」那行的竖线 —— 同一个含义（这是它说的原话）；
              不加标签：卡片窄，一行放不下 4 个字的标签还挤掉正文。

              执行器图标（有才渲染）摆在引文开头：这句收尾的话是**它**说的，
              图标就贴着它，比跑到卡片别处去找更直接。
            -->
            <p v-else-if="t.lastReply" class="kb-card__reply" :title="t.lastReply">
              <span
                v-if="cardAgent(t)"
                class="kb-card__quote-agent"
                :title="taskExecutorName(cardAgent(t))"
              >
                <TaskExecutorIcon :executor="cardAgent(t) as TaskExecutorId" class="kb-card__quote-agent-icon" />
              </span><span class="kb-card__reply-text">{{ t.lastReply }}</span>
            </p>

            <div class="kb-card__actions">
              <!--
                这一格是「对这条任务现在能做什么」。头两颗互斥、**不并排**：
                空闲时能做的只有"跑一轮"，在跑时能做的只有"停掉这一轮"，
                两个按钮同时摆着会让人以为"在跑也能再跑一轮"（服务端也确实拒绝）。
                位置固定在同一格还有个几何上的理由：两个标签都是 2 个汉字、同字号同内边距，
                操作组宽度因此**一个像素都不变** —— 下面那段按组宽反推的渐隐距离不用跟着改。
                （2026-10-01 加的「完成 / 撤销」也是 2 个汉字、且每张卡上最多出现一颗，
                 组宽仍是常数：96px。改动组宽就必须同步改那两组数字，否则按钮会露出半截字形。）
              -->
              <button
                v-if="t.runningJobs === 0"
                type="button"
                class="kb-card__btn"
                :title="$t('@WORKBENCH:执行')"
                @click.stop="emit('run-task', t)"
                @keydown.stop
              >{{ $t('@WORKBENCH:执行') }}</button>
              <!--
                停止：只有真在跑（runningJobs > 0 ⟺ 服务端推导出的「进行中」列）时才在。
                条件用 runningJobs 而不是 `!!t.live`：两者在服务端同源（都是"有 running/pending
                的 job"），但 runningJobs 是这张卡片列归属的判据本身，跟着它走不会出现
                "卡片在待处理列却带个停止按钮"这种自相矛盾的状态。
                点了做什么（确认弹窗、调哪个接口、jobId 从哪来）全在上层 —— 卡片只管发出意图，
                与 run / delete 一致。
              -->
              <button
                v-else
                type="button"
                class="kb-card__btn kb-card__btn--stop"
                :title="$t('@WORKBENCH:停止')"
                :aria-label="$t('@WORKBENCH:停止')"
                @click.stop="emit('stop-task', t)"
                @keydown.stop
              >{{ $t('@WORKBENCH:停止') }}</button>
              <!--
                手动「完成」：这颗按钮是看板上唯一一个**不由执行事实决定**的动作源头
                （列仍然是推导的，只是推导时多听一句人话 —— 详见文件头那段）。
                待处理 / 进行中都给：待处理里那条可能早在别处干完了，
                进行中那条可能只是模型不说话了，两件都只有用户知道。

                已完成列上的卡片不给这颗按钮 —— 列本身已经是答案了；真正需要它的只有
                **手动标进去**的那种卡（它的最近一条 job 并不是 done，撤销才有意义），
                所以那里换成一个「撤销」。自己跑完的卡上放撤销会是个骗人的按钮：
                撤掉标记它还是"最近一条 job 跑完了"，下次刷新照样在已完成列。

                在跑的那张卡上点「完成」会连这一轮一起停掉（一张卡不能既已完成又在跑），
                代价说明与确认弹窗在上层 —— 卡片只管发出意图，与 run / stop / delete 一致。
              -->
              <button
                v-if="t.column !== 'done'"
                type="button"
                class="kb-card__btn kb-card__btn--done"
                :title="$t('@WORKBENCH:标记为已完成')"
                :aria-label="$t('@WORKBENCH:标记为已完成')"
                @click.stop="emit('complete-task', t)"
                @keydown.stop
              >{{ $t('@WORKBENCH:完成') }}</button>
              <button
                v-else-if="t.manualDoneAt"
                type="button"
                class="kb-card__btn"
                :title="$t('@WORKBENCH:撤销完成标记，退回待处理')"
                :aria-label="$t('@WORKBENCH:撤销完成标记')"
                @click.stop="emit('reopen-task', t)"
                @keydown.stop
              >{{ $t('@WORKBENCH:撤销') }}</button>
              <button
                type="button"
                class="kb-card__btn kb-card__btn--danger"
                :title="$t('@WORKBENCH:删除')"
                :aria-label="$t('@WORKBENCH:删除')"
                @click.stop="emit('delete-task', t)"
                @keydown.stop
              >×</button>
            </div>
          </li>

          <!--
            「新建任务」常驻待处理列末尾，不再只在列空时出现。
            之前入口和空状态是同一个 `v-if="col.tasks.length === 0"`：列里一有卡片，
            新建入口就整块消失，用户只能绕到左侧栏去建（看板里无处可点）。
            两件事本来就无关——空状态说的是"这列没有卡片"，新建入口说的是"能往这儿加卡片"。
            列空时它顺带兼任空状态（--solo 撑高），所以待处理列不会再渲染下面的 kb-col__empty。
            位置沿用 Trello「Add a card」的做法：跟着列表滚（不吸底），长列表滚到底就是它。
          -->
          <li v-if="col.key === 'todo'" class="kb-col__add">
            <button
              type="button"
              class="kb-col__add-btn"
              :class="{ 'kb-col__add-btn--solo': col.tasks.length === 0 }"
              @click="emit('create-task')"
            >
              <span class="kb-col__add-plus" aria-hidden="true">+</span>
              <span>{{ $t('@WORKBENCH:新建任务') }}</span>
            </button>
          </li>
          <li v-else-if="col.tasks.length === 0" class="kb-col__empty">
            <span>{{ $t('@WORKBENCH:暂无任务') }}</span>
          </li>
        </ul>
      </section>
    </div>

    <!-- 列表视图 -->
    <div v-else class="kb__table-wrap">
      <table class="kb-table">
        <thead>
          <tr>
            <th class="kb-table__th">{{ $t('@WORKBENCH:任务') }}</th>
            <th class="kb-table__th kb-table__th--narrow">{{ $t('@WORKBENCH:状态') }}</th>
            <th class="kb-table__th kb-table__th--time">{{ $t('@WORKBENCH:时间') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="t in listRows"
            :key="t.id"
            class="kb-table__row"
            tabindex="0"
            @click="emit('open-task', t)"
            @keydown.enter.prevent="emit('open-task', t)"
            @keydown.space.prevent="emit('open-task', t)"
          >
            <td class="kb-table__td">
              <span class="kb-table__name">{{ cardTitle(t) || $t('@WORKBENCH:未命名任务') }}</span>
              <!-- 项目色标：与看板卡片同一枚（见 .kb-card__project-chip 的样式注释），
                   列表视图是同一批任务的另一种画法，两处长得不一样会让人以为是两份数据 -->
              <span
                v-if="showProjectLabel && projectLabel(t)"
                class="kb-table__project"
                :style="projectTagStyle(t.projectPath)"
                :title="t.projectPath"
              >{{ projectLabel(t) }}</span>
              <!-- 状态列的"进行中"太粗，跑起来之后一眼看不出进度：这里补一行
                   最新回复 / 思考 / 工具（与卡片上的 live 同一份数据）。
                   执行器图标摆最前（与看板卡片同一个位置：整块执行事实的开头） -->
              <span v-if="t.live" class="kb-table__live">
                <template v-if="cardAgent(t)">
                  <span class="kb-table__agent" :title="taskExecutorName(cardAgent(t))">
                    <TaskExecutorIcon :executor="cardAgent(t) as TaskExecutorId" class="kb-table__agent-icon" />
                  </span>
                </template>
                {{ liveSummary(t.live) }}
                <span v-if="reportSilentMs(t.live.silentMs) !== null" class="kb-table__live-silent">
                  {{ $t('@WORKBENCH:静默 {elapsed}', { elapsed: formatDurationMs(reportSilentMs(t.live.silentMs)) }) }}
                </span>
              </span>
              <!-- 跑完的任务同理给一行"最后说了什么"：列表视图与看板卡片是同一批任务的
                   两种画法，一边有、一边没有会让人以为是两份数据 -->
              <span v-else-if="t.lastReply" class="kb-table__live kb-table__live--reply">
                <template v-if="cardAgent(t)">
                  <span class="kb-table__agent" :title="taskExecutorName(cardAgent(t))">
                    <TaskExecutorIcon :executor="cardAgent(t) as TaskExecutorId" class="kb-table__agent-icon" />
                  </span>
                </template>{{ t.lastReply }}
              </span>
            </td>
            <td class="kb-table__td">
              <span class="kb-table__status" :class="'is-' + t.column">
                {{ $t(COLUMNS.find(c => c.key === t.column)!.labelKey) }}
              </span>
            </td>
            <td class="kb-table__td kb-table__td--num">
              <!-- 与看板卡片首行同一个口径：同一批任务的两种画法，一边有一边没有
                   会让人以为是两份数据 -->
              <span class="kb-table__time" :title="cardTimeTitle(t)">
                <template v-if="cardDuration(t)">
                  <span class="kb-table__dur">{{ $t('@WORKBENCH:用时 {d}', { d: cardDuration(t) }) }}</span>
                  <span class="kb-table__time-sep" aria-hidden="true">·</span>
                </template>
                <!-- 「AI 判定完成」在列表视图里也得有：同一批任务的两种画法，
                     一边有一边没有会让人以为是两份数据（卡片那边见 .kb-card__spent 的注释） -->
                <template v-if="t.autoCompleted">
                  <span class="kb-table__auto-done" :title="autoDoneTitle(t)">
                    {{ $t('@WORKBENCH:AI 判定完成') }}
                  </span>
                  <span class="kb-table__time-sep" aria-hidden="true">·</span>
                </template>
                <span>{{ relativeTimeFromIso(cardTime(t)) }}</span>
              </span>
            </td>
          </tr>
          <tr v-if="listRows.length === 0">
            <td class="kb-table__td kb-table__empty" colspan="3">{{ $t('@WORKBENCH:暂无任务') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.kb {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}

/* ── 工具条 ─────────────────────────────────────────── */
.kb__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.kb__views {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: var(--radius-lg);
  background: var(--bg-subtle);
  flex-shrink: 0;
}
.kb__view-btn {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  line-height: 20px;
  padding: 0 10px;
  border-radius: var(--radius-base);
  cursor: pointer;
  transition: background var(--transition-fast) var(--ease-custom), color var(--transition-fast) var(--ease-custom);
}
.kb__view-btn:hover { color: var(--text-primary); }
.kb__view-btn.is-active {
  background: var(--surface-elevated);
  box-shadow: var(--shadow-card-rest);
  color: var(--color-primary);
  font-weight: 500;
}
.kb__filters {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
  flex-wrap: wrap;
}
.kb__search { position: relative; display: inline-flex; align-items: center; }
.kb__search-icon {
  position: absolute;
  left: 7px;
  font-size: var(--font-size-sm);
  color: var(--text-meta);
  pointer-events: none;
}
.kb__search-input {
  width: 168px;
  height: 24px;
  padding: 0 8px 0 24px;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  background: var(--bg-subtle);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  outline: none;
  transition: border-color var(--transition-fast) var(--ease-custom), width var(--transition-base) var(--ease-custom);
}
.kb__search-input:focus {
  border-color: var(--color-primary);
  box-shadow: var(--focus-ring-soft);
  width: 216px;
}
.kb__search-input::placeholder { color: var(--text-meta); }

/* ── 看板列 ─────────────────────────────────────────── */
.kb__columns {
  display: grid;
  /* 轨道数由 columnsStyle 内联给出（= 列数），别在这儿写死数字 */
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
/* 2026-10-04：列第一次有了角色色。
   之前三列除了一个 6px 圆点之外全是同一个蓝 + 同一个灰底，三列并排时
   眼睛只能靠位置和文字判断"这是哪一列"；而"单调"也不只是审美问题 ——
   看板的核心心智模型就是"待处理 → 进行中 → 已完成"这条流水线，
   角色色正好是这条模型最直接的视觉表达。每列挑一个角色（pending / active / done）。

   ⚠️ 同日晚按用户反馈返工过一次（"白主题下感觉颜色偏深偏暗"）。原写法是
   列头 `color-mix(--col-ink 14%, transparent)` —— **从 ink 调色**，而 ink 是为
   小字过 AA 刻意压暗过的档（active 的 ink 是 #b45309 深棕、done 是 #047857 墨绿），
   兑进中性底出来的是灰褐 / 灰绿；列身那 6% 又是透明的，落在 --surface-canvas
   (#e7ebf2，本身已是 92% 明度的灰) 上再掉一档明度。两层叠起来整列是脏的。
   现在三档浓度全部从 --col-hue（纯色相）兑进 near-white，是**同一色相的三档强度**：
     列身 9%（surface，氛围）→ 列头色带 26%（标识）→ 卡片 16%（wash，信号）。
   基底都是 --surface-elevated 而不是 transparent：透明会让浓度随下层底色漂。 */
.kb-col {
  --col-hue: var(--role-pending-hue);
  --col-ink: var(--role-pending-ink);
  --col-surface: var(--role-pending-surface);
  --col-wash: var(--role-pending-wash);
  --col-edge: var(--role-pending-edge);
  --col-glow: var(--role-pending-glow);
  /* 列头那条带子：从 hue 直接兑基底，**不是**叠在列身上 ——
     叠的话列头会比列身更暗，读起来像一块阴影而不是一条标识。 */
  --col-band: color-mix(in srgb, var(--col-hue) 26%, var(--surface-elevated));
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  border-left: 1px solid var(--border-color);
  background: var(--col-surface);
}
.kb-col--doing {
  --col-hue: var(--role-active-hue);
  --col-ink: var(--role-active-ink);
  --col-surface: var(--role-active-surface);
  --col-wash: var(--role-active-wash);
  --col-edge: var(--role-active-edge);
  --col-glow: var(--role-active-glow);
}
.kb-col--done {
  --col-hue: var(--role-done-hue);
  --col-ink: var(--role-done-ink);
  --col-surface: var(--role-done-surface);
  --col-wash: var(--role-done-wash);
  --col-edge: var(--role-done-edge);
  --col-glow: var(--role-done-glow);
}
.kb-col:first-child { border-left: none; }
.kb-col__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  flex-shrink: 0;
  background: var(--col-band);
  border-bottom: 1px solid var(--col-edge);
}
.kb-col__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--col-ink);
  box-shadow: var(--col-glow);
}
.kb-col--doing .kb-col__dot { animation: kb-pulse 1.4s ease-in-out infinite; }
@keyframes kb-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(1.35); }
}
.kb-col__title {
  margin: 0;
  font-size: var(--font-size-sm);
  font-weight: 600;
  letter-spacing: var(--letter-spacing-wide);
  /* 标题吃角色色的 ink（各档都过 AA 4.5:1），不再用中性 secondary ——
     三列标题的明度本来几乎一样，这是"并排看不出区别"的另一半原因。 */
  color: var(--col-ink);
  flex: 1;
  min-width: 0;
}
.kb-col__count {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--col-ink);
  font-variant-numeric: tabular-nums;
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--col-ink) 10%, transparent);
}
.kb-col__list {
  list-style: none;
  margin: 0;
  /* 上内边距**不能是 0**（2026-10-04 用户报"卡片和上边的看板类型的 title 之间没有间距"）：
     卡片自己的外边距只有 margin-bottom，首屏第一张会和列头那条色带直接贴死，
     看起来像色带把卡片压住了。12px 与左右两侧同档，四边才是齐的。 */
  padding: 12px;
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 0;
}

/* ── 卡片：浮起表面 + 静息阴影，hover 抬升 ── */
.kb-card {
  position: relative;
  /*
   * hover 渐隐的**纵向那层**：条带之外一律不透明，条带之内全透明。
   * 横向那层（见 .kb-card__actions 附近）照旧只管"右侧渐隐"，两层 **add** 起来正好是
   * 「只把操作组压住的那一条带洗掉，上面几行照旧读得到」。
   * ⚠️ 2026-10-02 修：遮罩原先只有横向一层，三行引文的卡 hover 一下，
   * **每一行**的右端都被洗掉 102px —— 按钮只压着最后一行，上面两行的尾巴却一起没了，
   * 右上角于是空出一大块（用户报的"hover 一片空白"）。
   * ⚠️ 合成方式必须是 **add**，不能是 intersect：intersect 只能把两层相乘，
   * 横向层在行 1、行 2 上本来就是 0（那正是要渐隐的），一相交它们就永远是 0 ——
   * 交集写出来跟单层一模一样（第一版就踩了这个，改完 11 条断言全绿、截图却没变）。
   * 两个数字都是从真实 DOM 量出来的（scripts/verify-wb-card-fade-band.cjs 守着几何，
   * 同脚本还直接数像素，守住"上面几行的字真的还在"）：
   *   · 19px：倒数第二行的行盒下沿 = 末行行高 16.5，更深一点的墨迹（中英混排的下伸部）
   *     实测在 18.3px —— 过渡带从它**下面**开始，那行就一像素都不受影响。
   *   · 14px：末行墨迹上沿实测 15.5px，按钮盒顶实测 12px —— 终点在墨迹上沿之下，
   *     整组按钮连同它的内边距都落在全透明区里，不会露出半截字形。
   * 元素比条带还矮时（单行引文 / 单行标题）两个 stop 都会被 clamp，等价于整行渐隐 ——
   * 那本来就是想要的结果。
   */
  --kb-mask-outside-band: linear-gradient(to bottom, #000 calc(100% - 19px), transparent calc(100% - 14px));
  padding: 12px;
  margin-bottom: 8px;
  border: 1px solid var(--border-color-light);
  border-radius: var(--radius-lg);
  background: var(--surface-elevated);
  box-shadow: var(--shadow-card-rest);
  cursor: pointer;
  transition: border-color var(--transition-fast) var(--ease-custom),
              background var(--transition-fast) var(--ease-custom),
              box-shadow var(--transition-fast) var(--ease-custom),
              transform var(--transition-fast) var(--ease-custom);
}
.kb-card:hover {
  border-color: var(--border-card-hover);
  background: var(--surface-elevated);
  box-shadow: var(--shadow-card-lift);
  transform: translateY(-1px);
}
/* 卡片状态与列状态是同一套角色 —— "进行中"的卡和"进行中"的列必然同色，
   而不是靠两处各写一遍数值凑巧一致。
   ⚠️ 用的是 wash 那一档（16%）不是 surface（9%）：surface 是列身那种"氛围"，
   卡片是"信号"，两者同浓度就会糊进列身里分不出哪张在跑。
   而且这一档是**不透明**的 —— 上一版拿 6% 透明色当卡片自己的背景，
   等于把卡片的白底换成了"列身色再加一层脏"，比旁边的白卡更暗也更浑；
   现在的写法是白底往色相方向偏一点，卡片仍然是卡片，只是暖了。 */
.kb-card.is-running {
  border-color: var(--role-active-edge);
  background: var(--role-active-wash);
}
.kb-card.has-error {
  border-color: var(--role-error-edge);
  background: var(--role-error-wash);
}
/* 点开过的那张（.is-opened）：常驻一圈主色描边，让"这张不再有 hover 操作"看着是条规则，
   而不是"这张卡坏了"。描边色与上面两个状态色同用 color-mix 那一套写法。
   hover 时描边不变（还是主色），只把抬升撤掉 —— 抬升是"我要点你了"的暗示，
   而这张卡的操作已经在编辑器里了，不该再暗示。 */
.kb-card.is-opened,
.kb-card.is-opened:hover {
  border-color: color-mix(in srgb, var(--color-primary) 42%, var(--border-color));
}
.kb-card.is-opened:hover {
  box-shadow: var(--shadow-card-rest);
  transform: none;
}

/* 首行：项目色标 + 标题 + 时间 —— 三者都是单行文本。
   baseline 而不是 center：三者的盒子高度天生不同（胶囊 18px = 16px 行高 + 上下各 1px 边框、
   标题 14px × 1.5 = 21px、时间是 11px 的默认行高），按 center 对的是**盒心**，
   盒心对齐了、里面那行字却各偏几 px；按基线才是三行字站在同一条线上。 */
.kb-card__row1 {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  margin-bottom: 8px;
  font-size: var(--font-size-xs);
  color: var(--text-meta);
}
.kb-card__time { margin-left: auto; flex-shrink: 0; font-variant-numeric: tabular-nums; }
/* ── 「用时 x」：跑完的任务独占一行（为什么不挤首行见模板里那段） ──────────
   字色比首行那段时间亮一档：相对时间是"什么时候的事"（背景），用时是用户盯着
   这一列时真正在找的东西，扫视时先落在它身上。
   不进 hover 那条右侧渐隐名单：字串短，渐隐起点在右侧 64px 处，
   加进去等于把它的尾巴（多半是"0 秒"）洗掉。 */
.kb-card__spent {
  margin: -2px 0 8px;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
/*
 * 「AI 判定完成」：卡片上紧跟「用时 x」的那一枚小标（模板那段的理由写在那里）。
 * 配色照抄项目色标那套（跟 surface-elevated 混，深浅两套主题自动成立），
 * 色相固定用成功色 —— 它说的是"这条已经落进「已完成」列了"这个事实。
 * 形状用圆角矩形而**不是胶囊**：胶囊在这张卡上是「项目名」的专用形状，
 * 两者会同时出现（卡片顶部一枚、这里一枚），同形状会让人以为它们是一类东西。
 * 宽度按内容收（inline-block）：整行铺满的话会看着像一条分隔线，而不是一枚标记。
 */
.kb-card__auto-done {
  display: inline-block;
  /* 悬停提示（模型给的依据）挂在整个 <p> 上，所以内边距留在 p 上而不是标自己身上 ——
     鼠标移到标右边的空白也要能出提示 */
  margin: -4px 0 8px;
  padding: 0 5px;
  border: 1px solid color-mix(in srgb, var(--color-success) 24%, var(--surface-elevated));
  border-radius: var(--radius-base);
  background: color-mix(in srgb, var(--color-success) 9%, var(--surface-elevated));
  color: color-mix(in srgb, var(--color-success) 62%, var(--text-primary));
  font-size: var(--font-size-xs);
  line-height: 1.6;
}
/*
 * 列表视图里那一枚**不带框**：那一格有探针按"整格只有一行"断言
 * （verify-wb-task-duration 的 E2 量的是格高 / line-height），带上边框和内边距
 * 就有把行高顶出去的风险 —— 而它要说的信息（"这条是判完成的"）只靠颜色 + 文字就说清了。
 */
.kb-table__auto-done {
  color: color-mix(in srgb, var(--color-success) 62%, var(--text-primary));
}
.kb-card__title {
  margin: 0;
  /* 与色标 / 时间同排（见 .kb-card__row1）：必须压掉 flex item 默认的 min-width: auto，
     否则它"内容多宽就多宽"—— 色标缩不出省略号，时间也会被挤出卡片。

     基准尺寸必须是 0 而不是 auto：basis: auto 时标题的基准 = 整段文字的 max-content
     （一条任务标题动辄三四百 px），容器偏窄时负空间按「基准 × 收缩系数」分摊，
     基准只有几十 px 的色标被连累缩成 "zen-g…"（实测最长那张只剩 "z…"）——
     项目名是这枚胶囊存在的全部意义，缩掉它就白放在首行了。
     basis: 0 让标题基准归零 → 负空间几乎全归标题承担，色标保住全宽，
     标题在剩下的宽度里单行省略（见下面 white-space / text-overflow 那段）。 */
  flex: 1 1 0;
  min-width: 0;
  font-size: var(--font-size-base);
  font-weight: 500;
  line-height: 1.5;
  color: var(--text-primary);
  /* 一行到底、超出打省略号（完整标题在原生提示里，见模板的 :title）。
     原来折两行（-webkit-line-clamp: 2）：首行被色标 + 时间挤掉之后，第二行常年只有
     小半行字，"折了却折不全"比直接省略更难扫读 —— 卡片的职责是"一眼认出是哪条"，
     不是把标题读完；要读全文有右侧编辑器。 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* ── 所属项目色标（看板卡片 + 列表行共用一套，视图为「全部项目」时才渲染） ──
   原来只是一行灰字：扫一眼分不出哪几张卡是同一个项目的，而这正是它存在的理由。
   现在是一枚胶囊，三层颜色全部由项目色相混出，色相由项目路径哈希给出
   （见 utils/projectTag.ts，行内样式只塞一个 --tag-hue）。
   胶囊左侧原来还点了一枚同色实心圆点，2026-09-29 去掉：色相已经由胶囊自己的
   底色 / 描边 / 文字三层承载，再点一个圆点等于把同一个信号说两遍。

   三层颜色（底色 / 描边 / 文字）都由 color-mix 从同一个饱和色与**主题变量**混出来，
   而不是浅色一套、深色再覆写一套：--surface-elevated 就是卡片底色（深浅主题各有一个），
   混出来的标签天然"比卡片深一档"，两个主题都不用再挑第二组颜色 ——
   大面积淡色底正是深色主题最容易挑歪的地方。

   色相取值见 HUES 的注释：只占 140°–350° 半圈，避开卡片已经在用的报错红 / 运行橙。 */
.kb-card__project-chip,
.kb-table__project {
  /* 色相从行内样式来（两处都直接挂在胶囊元素自己身上，见 projectTagStyle）。
     兜底写在 var() 的第二参**而不是**这里再声明一次 --tag-hue：声明在这里会盖掉
     内联样式塞进来的值（第一版就这么写的，结果 62 枚色标全是同一个兜底蓝）。 */
  --tag-ink: hsl(var(--tag-hue, 200) 62% 44%);
  display: inline-block;
  max-width: 100%;
  padding: 0 6px;
  border: 1px solid color-mix(in srgb, var(--tag-ink) 24%, var(--surface-elevated));
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--tag-ink) 9%, var(--surface-elevated));
  color: color-mix(in srgb, var(--tag-ink) 62%, var(--text-primary));
  font-size: var(--font-size-xs);
  line-height: 16px;
  /* 胶囊靠 ellipsis 收尾而不是裁断：项目名长的（notebook2026）要能看出被截了 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 卡片里与色标同排（.kb-card__row1 是 flex 行）：项目名长的（flowdash-md-preview）要能
   收缩出省略号而不是把时间挤出卡片。flex item 的 min-width 默认是 auto
   （= 内容宽），不显式压到 0 就永远不缩 —— 胶囊自己的 max-width/ellipsis 全都不生效。
   收缩只发生在胶囊身上：同行的 .kb-card__time 是 flex-shrink: 0。 */
.kb-card__row1 .kb-card__project-chip {
  flex: 0 1 auto;
  min-width: 0;
}
/* 列表行里要与任务名同行（.kb-table__name 是 inline）：
   抬 1px 是把胶囊的**文字基线**与同行任务名的基线对齐后做的光学微调——
   胶囊上下各多 3px 边框/内边距，纯基线对齐时看着略低。 */
.kb-table__project {
  margin-left: 6px;
  vertical-align: 1px;
}

/* ── 卡片上的「现在在干嘛」（只在任务正在跑时出现） ──
   与任务标题之间用一条浅虚线隔开：上面是"这是什么任务"，下面是"它现在怎么样了"。
   视觉口径刻意与右栏进度报告面板的 .rpt__* 一致（同一批事实，两处看起来该是一回事） */
.kb-card__live {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border-color-light);
  min-width: 0;
}
.kb-card__live-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-meta);
  font-variant-numeric: tabular-nums;
}
/**
 * 执行器品牌图标（卡片活动区 / 卡片引文 / 列表行三处共用同一个口径）。
 *
 * 12px 是量出来的：三处正文都是 var(--font-size-xs) = 11px，三种品牌标在这几处
 * 全是实心小色块，跟着 11px 走时细节糊成一团；抬到 12px 既能认出是哪家的标，
 * 又不比旁边的时间 / 工具次数抢眼。字号写在这一层（而不是给 img 写 px）是因为
 * TaskExecutorIcon 自带 `width: 1em`，父级字号定了它就跟着走。
 *
 * 图标不描边。早先给三个 icon 类加过一圈 1px currentColor 的描边（理由是彩色标压在
 * 白底上边界会糊），但品牌标原图自带留白、底色也不浅，描边反倒像给图标套了个方框，
 * 用户明确说不需要，已去掉。真遇到某张图在白底上糊，改图不改框。
 *
 * 两处各用各的类名（不共用一个 .kb-card__agent）：一个在活动区那一行里、一个在引文里，
 * 验证脚本按类名找元素时不会把两处搞混。
 */
.kb-card__live-agent,
.kb-card__quote-agent,
.kb-table__agent {
  display: inline-flex;
  align-items: center;
  flex: none;
  font-size: 12px;
  color: var(--text-meta);
}

/* 活动区那一行是 flex 行（gap: 6px），图标不用自己留间距；引文与列表行不是 flex，靠外边距推 */
.kb-card__live-agent,
.kb-table__agent { margin-right: 4px; }

/**
 * 引文里的图标与正文。
 *
 * 竖线（border-left）标的是"这是它说的原话"，图标是说话的人 —— 两者一起摆在引文开头：
 * 右边是那根竖线，图标紧贴它内侧，正文跟在图标后面。
 *
 * 布局是「图标 + 正文」的 flex 行（规则在下面 .kb-card__reply 处），不用负外边距把图标
 * 拽到竖线外面：那是个和 padding 数字的巧合游戏 —— 吃掉 padding-left(6px) 之后图标
 * 正好压在竖线上，要真挪出去得吃 14px 以上，而卡片本身只有 10px 内边距，再往外就捅到
 * 卡片边框；而且负外边距让图标落在内容盒之外，验证脚本量到的位置和肉眼看到的对不上
 * （本仓库第一次实现就在这儿栽了，见 .claude/rules/hmr-debug-check.md 的"看错元素"）。
 * flex 没有这些隐性约定：位置由布局算出来，量到的就是看到的。
 */
/* 正文那一块：占满剩余宽度。包一层是因为引文同时是"图标 + 正文"的 flex 行，
   line-clamp 要的 display:-webkit-box 和 flex 互斥，得落在正文这层上 */
.kb-card__reply-text { flex: 1 1 auto; min-width: 0; margin-left: 4px; }

/* 静默：卡片上最接近"可能卡住了"的信号，用告警色 */
.kb-card__live-silent { color: var(--color-warning-dark); }
.kb-card__live-line {
  margin: 4px 0 0;
  font-size: var(--font-size-xs);
  line-height: 1.5;
  color: var(--text-meta);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-word;
}
/* 工具行只给一行：它是"正在做什么"的标签（`Edit src/App.vue`），
   折成两行会被读成一句内容，而它本来不是 */
.kb-card__live-line.is-tool {
  -webkit-line-clamp: 1;
  line-clamp: 1;
}
/* 思考那行比工具行**亮一档**并带左侧竖线 —— 多数任务一句正文都不写，
   它是"它在干嘛"最直接的证据，不该和工具名一样灰 */
.kb-card__live-line.is-thought {
  color: var(--text-secondary);
  /* 2026-10-04：原本是 border-left: 2px solid var(--border-color-light)
     的缩进竖条（同 .kb-card__reply 那一套）。改成纯缩进。
     .kb-card__reply 自己那根暂时留着 —— verify-wb-card-reply.cjs:302
     断言 borderLeft === '2px'，要一起改探针，不在本轮。 */
  padding-left: 8px;
}
.kb-card__live-tag {
  margin-right: 4px;
  color: var(--text-meta);
}

/* ── 跑完之后留下的「最后说了什么」（只在没有 job 在跑时出现） ──
   与 .kb-card__live 的分工：那个答"现在在干嘛"（实时，跑完就消失），这个答"它最后
   交代了什么"（跑完才出现）。分隔线与引用竖线都沿用 live 那一套（虚线分区块、
   竖线标"这是它说的原话"），两处看起来该是一回事。
   截 3 行：摘录长度是按这 3 行的容量定的（服务端 MAX_REPLY_CHARS = 100），
   宽一点的窗口整段看得见，窄窗口会从尾巴切掉几个字 —— 切到的是收尾那句话的末几个字，
   不是它整句话；完整摘录在悬停提示里。竖线不算在 clamp 内，但它只有 2px。 */
.kb-card__reply {
  /* 「执行器图标 + 正文」的 flex 行：图标是第一个 flex item、正文占满剩余宽度 */
  display: flex;
  align-items: flex-start;
  margin: 6px 0 0;
  /* 左侧缩进只留那根 2px 竖线，**不留 padding-left**：引文是 flex 行，
     padding-left 会把图标一起往右推（实测正好推到正文上）。竖线本身已经是引文的视觉缩进。 */
  padding: 6px 0 0;
  border-top: 1px dashed var(--border-color-light);
  border-left: 2px solid var(--border-color-light);
  font-size: var(--font-size-xs);
  line-height: 1.5;
  color: var(--text-secondary);
  word-break: break-word;
}
/* 截 3 行的活儿落在这块正文上，不在引文容器上 —— 引文是 flex 行，
   line-clamp 要的 display:-webkit-box 和 flex 互斥（谁写在后面谁赢，很容易看着像没生效） */
.kb-card__reply-text {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* hover 才出现的操作组：绝对定位不占位，空闲时连点击也一起让开
   （否则隐形的按钮会吞掉本该落到卡片的点击） */
.kb-card__actions {
  position: absolute;
  right: 8px;
  bottom: 6px;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding-left: 12px;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--transition-fast) var(--ease-custom);
}
/*
 * 点开过的卡片（.is-opened）不参与 hover 那套：操作组不浮出、正文右侧也不渐隐。
 * 用 `:not(.is-opened)` 改**触发侧**而不是事后去覆盖 opacity / mask ——
 * 遮罩与浮层是成对的（遮罩是遮**字**的），只撤一个就会留下"按钮没了但字白少一截"的半吊子状态。
 * :focus-within 那一路**不加**这个条件：Tab 进卡片里的按钮时操作组照旧浮出，
 * 否则「执行 / 停止 / ×」对键盘用户就等于消失了（它们 pointer-events 也归零，鼠标和键盘都点不到）。
 */
.kb-card:not(.is-opened):hover .kb-card__actions,
.kb-card:focus-within .kb-card__actions {
  opacity: 1;
  pointer-events: auto;
}

/*
 * 操作组（绝对定位在右下角）会压在**卡片最后一行**的右端。这里**不用"给它加背景"的办法去盖**：
 *   · 面板/容器类底色 token 在深色主题下本身就是半透明的
 *     （--bg-panel-dark = rgba(255,255,255,.06)），拿它当浮层背景等于没挡；
 *   · 换成不透明的 --bg-container 又比卡片暗，左边缘会留一道色阶；
 *   · 而且浮层底色还得跟着 hover / focus-within / is-running 逐一对齐，很容易漏。
 * 改成把**底下的文字在右侧渐隐掉**：不涉及任何颜色，深浅主题都成立，也没有接缝。
 * （组内按钮本身是 transparent，所以必须让它所在区域完全透明，不能只减淡。）
 *
 * ⚠️ 渐隐必须**同时**限在纵向那条带里（`--kb-mask-outside-band` + 两层 add，
 * 2026-10-02 修）：操作组只压着**最后一行**（高 18px），而引文能到 3 行、活动区那行能到 2 行。
 * 只挂一层横向渐隐的话，**每一行**的右端都会被洗掉同样的宽度 —— 一张三行引文的卡，
 * hover 一下右上角就空出两大块空白（用户 2026-10-02 报的"hover 上一片空白"）。
 * 加上纵向那层之后，只有按钮真正压住的那一条带渐隐，上面几行照旧读得到。
 *
 * ⚠️ 遮的必须是「压在操作组底下的那一行」，**不是无脑遮标题**（2026-10-01 修）。
 * 操作组是 `bottom: 6px`，它压住的永远是卡片**最后一行**：卡片底下有活动区 / 引文时，
 * 那一行离标题隔着整整一段正文（实测标题墨迹带与按钮墨迹带相差 18~122px），
 * 再遮标题就是遮空气 —— 用户看到的是「hover 一下，标题右半截白掉了，而右下角的
 * 按钮根本没碰到它」。所以标题只在**它自己就是最后一行**时（从没跑过的待处理卡，
 * 卡里只有 row1 那一行）才渐隐：那种卡实测标题墨迹带下沿与按钮墨迹带上沿只差 1px
 * （`×` 是 14px 字号，往上探了 3.5px），尾巴确实压在按钮上。
 * 判据写成 `:has(~ ...)` 而不是在模板里算一个 is-sole-row 传进来：后者要跟四处 v-if
 * 手工对齐，以后卡片再加一行正文，漏改一处就又是同一个 bug。
 *
 * 渐隐位置按操作组的实际占位反推：
 *   · 正文行（活动区最后一行 / 引文）的元素右边缘 = 内容盒右边缘，组左边缘在内容盒
 *     右侧 ~92px 处（padding-left 12 + 「执行」32 + gap 2 + 「完成」32 + gap 2 + ×16… 实测组宽 96），
 *     所以 mask 在「距右侧 102px」处就完全透明 —— 留 4px 余量，按钮（含 padding）
 *     整个落在全透明区里，不会露出半截字形；再往左 16px 是淡出段。
 *   · 标题的右边缘**不是**内容盒右边缘：它右边还并排着一枚时间（`.kb-card__time`
 *     是 `margin-left: auto`），照搬 102px 会把标题多洗掉整整一枚时间那么宽（实测
 *     41px 宽的时间 = 多空 54px）。它真正要盖住的只有 [操作组左边缘 + 那 12px 内边距,
 *     标题右边缘] 这十来 px（时间串最短时最坏 ~20px），所以透明区取 52px、淡出段 16px。
 * 英文标签（Run / Stop / Done）比中文窄，组更小、左边缘更靠右，同样被完全透明区覆盖，不会失效。
 * 「停止」不用另算：它与「执行」同为 2 个汉字、同字号同内边距，宽度一模一样
 * （英文下 Stop 比 Run 宽约 3px，两处余量都吃得下），组宽不因卡片在跑而变。
 * 「完成 / 撤销」（2026-10-01 加）同理：两颗都是 2 个汉字，且在每张卡上最多出现一颗，
 * 所以**最宽的那种卡**（三颗按钮，实测组宽 96）仍是常数 —— 上面两组数字按它反推即可。
 * 只有两颗按钮的那张（自己跑完的已完成卡：执行 + ×）更窄，窄不会露字形，不用另算。
 */
/* 活动区的那一行：它渲染在哪一行取决于哪个字段有值（工具 / 思考 / 回复 / 只有时长），
   所以对**最后渲染出来的那个孩子**渐隐，而不是逐个类名去猜 */
.kb-card:not(.is-opened):hover .kb-card__live > :last-child,
.kb-card:focus-within .kb-card__live > :last-child,
/* 「最后回复」是卡片的最后一块，操作组正压在它右下角 */
.kb-card:not(.is-opened):hover .kb-card__reply,
.kb-card:focus-within .kb-card__reply {
  /* 层序 = 「上面横向渐隐、下面带外不透明」，两层 add（= mask-composite 的默认值，
     这里显式写出来：这一行是这个效果的全部机关所在，写出来才看得见）。
     推导见 .kb-card 上 --kb-mask-outside-band 那段 —— **不能改成 intersect**。 */
  -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 118px), transparent calc(100% - 102px)), var(--kb-mask-outside-band);
  mask-image: linear-gradient(to right, #000 calc(100% - 118px), transparent calc(100% - 102px)), var(--kb-mask-outside-band);
  -webkit-mask-composite: source-over;
  mask-composite: add;
}
/* 标题：只在它自己是卡片最后一行时才遮（判据与理由见上），位置按标题自己的右边缘另算。
   `~ *:not(.kb-card__actions)` = 「row1 后面还有别的兄弟节点」，操作组本身不算。
   单行元素：纵向那层的两个 stop 都被 clamp 掉 → 与改动前的整行渐隐等价。 */
.kb-card:not(.is-opened):hover .kb-card__row1:not(:has(~ *:not(.kb-card__actions))) .kb-card__title,
.kb-card:focus-within .kb-card__row1:not(:has(~ *:not(.kb-card__actions))) .kb-card__title {
  -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 68px), transparent calc(100% - 52px)), var(--kb-mask-outside-band);
  mask-image: linear-gradient(to right, #000 calc(100% - 68px), transparent calc(100% - 52px)), var(--kb-mask-outside-band);
  -webkit-mask-composite: source-over;
  mask-composite: add;
}
.kb-card__btn {
  border: none;
  background: transparent;
  color: var(--text-meta);
  font-size: var(--font-size-xs);
  line-height: 18px;
  padding: 0 5px;
  border-radius: var(--radius-base);
  cursor: pointer;
  transition: color var(--transition-fast) var(--ease-custom);
}
.kb-card__btn:hover { color: var(--color-primary); background: var(--bg-subtle-hover); }
.kb-card__btn--danger { font-size: var(--font-size-base); padding: 0 4px; }
.kb-card__btn--danger:hover { color: var(--color-danger-light); }
/*
 * 「停止」**不用红色**：它跟 × 永远同框（一条在跑的任务卡上就这两个按钮），
 * 两颗都染红就只剩位置能区分了，而位置恰恰是最不该被依赖的那个线索。
 * 用告警色（--color-warning）：这张卡的边框/底色本来就是它染的（.kb-card.is-running），
 * 同一行最右边的「静默 x 分」也是它 —— 停止是这个状态自带的动作，
 * 让它跟"正在跑"共用一套颜色，读起来是"对当前状态下手"；
 * 红留给 ×，含义收窄成唯一一个：把任务整个删掉。
 */
.kb-card__btn--stop:hover { color: var(--color-warning-dark); background: var(--bg-subtle-hover); }
/*
 * 「完成」用成功色、「撤销」用主色 —— 与「停止」用告警色同一条思路：
 * 颜色说明**这一下会对任务做什么**（收进已完成 / 只是把标记退回来），
 * 而不是给按钮排名次。红仍然只留给 ×。
 */
.kb-card__btn--done:hover { color: var(--color-success-dark); background: var(--bg-subtle-hover); }
.kb-card__btn:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }

.kb-col__empty {
  padding: 18px 8px;
  margin: 0 2px;
  text-align: center;
  font-size: var(--font-size-xs);
  color: var(--text-meta);
  list-style: none;
  border: 1px dashed var(--border-color-light);
  border-radius: var(--radius-lg);
  background: var(--bg-subtle);
}

/* ── 「新建任务」幽灵项（常驻待处理列末尾） ─────────────
   虚线 + 透明底，与实心卡片拉开层级：一眼能看出它是"动作"不是"任务"。
   宽度 100% 对齐上面的卡片内容盒（列表本身有 0 8px 内边距），不比卡片宽也不比它窄。 */
.kb-col__add {
  list-style: none;
  margin: 0;
  padding: 0;
}
.kb-col__add-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  width: 100%;
  padding: 5px 10px;
  font-size: var(--font-size-xs);
  line-height: 20px;
  color: var(--text-meta);
  background: transparent;
  border: 1px dashed var(--border-color-medium);
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition: color var(--transition-fast) var(--ease-custom),
              border-color var(--transition-fast) var(--ease-custom),
              background var(--transition-fast) var(--ease-custom);
}
.kb-col__add-btn:hover {
  color: var(--color-primary);
  border-color: var(--color-primary);
  background: var(--bg-subtle);
}
.kb-col__add-btn:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }
.kb-col__add-plus { font-size: var(--font-size-base); line-height: 1; }
/* 列空时它同时是空状态：撑高成一个"落点"，别让整列只剩一粒小按钮 */
.kb-col__add-btn--solo { padding: 18px 8px; }

/* ── 列表视图 ───────────────────────────────────────── */
.kb__table-wrap {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}
.kb-table {
  width: 100%;
  /* fixed 是这两列能露出来的前提（2026-09-30 修）：
     默认的 auto 布局按**内容**算列宽，而「任务」那一格里有两段 white-space: nowrap
     的正文（.kb-table__name 的长标题、.kb-table__live 的回复摘录），
     它的 max-content 宽度（实测 1055px）远大于容器（918px）。
     auto 布局下表格不会裁掉超宽的那一格，而是把整张表撑到 1181px 横向溢出，
     右边的「状态 / 时间」两列被推出可视区右侧 —— DOM 里量得到、屏幕上没有。
     fixed 下未声明宽度的列平分剩余空间，nowrap 正文由各自的 ellipsis 收尾。 */
  table-layout: fixed;
  border-collapse: collapse;
  font-size: var(--font-size-sm);
}
.kb-table__th {
  position: sticky;
  top: 0;
  z-index: 1;
  text-align: left;
  padding: 7px 10px;
  font-size: var(--font-size-xs);
  font-weight: 500;
  color: var(--text-meta);
  background: var(--glass-bg);
  backdrop-filter: var(--glass-filter);
  -webkit-backdrop-filter: var(--glass-filter);
  border-bottom: 1px solid var(--border-color);
  white-space: nowrap;
}
.kb-table__th--narrow { width: 96px; }
/* 时间列比状态列宽：加了「用时」之后是「用时 12 分 · 3 小时前」，96px 装不下
   （fixed 布局下不会裁，会直接把那一格撑成两行，行高跟着跳）。
   这点宽度是从「任务」列那格拿的 —— 它本来就靠 ellipsis 收尾，多让 52px 代价最小。 */
.kb-table__th--time { width: 148px; }
.kb-table__row {
  cursor: pointer;
  transition: background var(--transition-fast) var(--ease-custom);
}
.kb-table__row:hover { background: var(--bg-container-hover); }
.kb-table__td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-color);
  color: var(--text-secondary);
  vertical-align: middle;
}
.kb-table__td--num { font-variant-numeric: tabular-nums; }
/* 列表视图的时间格是**独立一列**，宽度自己说了算（见 .kb-table__th--time），
   所以两个事实并排放：「用时 12 分 · 3 小时前」。
   不换行：换行会把这一行的行高只由它决定，整张表参差不齐；
   宽度不够时省略号收尾（title 里有完整内容），而不是让它换行。 */
.kb-table__time { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 与卡片那行同一档语义：用时是"要读的"，相对时间是"背景" */
.kb-table__dur { color: var(--text-primary); }
.kb-table__time-sep { margin: 0 3px; opacity: .55; }
.kb-table__name { color: var(--text-primary); }
/* .kb-table__project 的样式与卡片那枚共用，见上方 .kb-card__project-chip 一段 */
/* 进行中那一行的"跑到哪了"：与任务名同一格，占满剩余宽度后省略号收尾 */
.kb-table__live {
  display: block;
  margin-top: 2px;
  font-size: var(--font-size-xs);
  color: var(--text-meta);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.kb-table__live-silent { margin-left: 6px; color: var(--color-warning-dark); }
/* 「最后回复」在列表行里用同一根引用竖线（与看板卡片的 .kb-card__reply 同一个含义）。
   不写 padding-left：图标与正文之间已经由 .kb-table__agent 的右外边距管着，
   再叠一层内边距会把图标推到正文上去（与卡片那边同一条坑）。 */
/* 2026-10-04：原本是 border-left: 2px 缩进竖条，改成纯 padding。 */
.kb-table__live--reply {
  padding-left: 8px;
  color: var(--text-secondary);
}
.kb-table__status {
  font-size: var(--font-size-xs);
  padding: 1px 6px;
  border-radius: var(--radius-base);
  background: var(--bg-subtle);
  color: var(--text-secondary);
}
.kb-table__status.is-doing { color: var(--color-warning-dark); }
.kb-table__status.is-done { color: var(--color-success-dark); }
.kb-table__empty {
  text-align: center;
  padding: 28px 10px;
  color: var(--text-meta);
}

/* ── 窄屏：三列竖排 ─────────────────────────────────── */
/* 手机宽度下横排三列每列只剩 1/3 屏，卡片标题一律成省略号，不如竖着排、整块滚动。
   这里切的是 display 而**不是** grid-template-columns：轨道数由 columnsStyle 内联
   给出（= 列数，见脚本里的注释），媒体查询压不过内联样式，而 display 不受它影响。 */
@media (max-width: 860px) {
  .kb__columns {
    display: block;
    overflow-y: auto;
  }
  .kb-col {
    border-left: none;
    border-top: 1px solid var(--border-color);
  }
  .kb-col:first-child { border-top: none; }
  /* 每列不再各自滚：一屏三个滚动区手感很碎，交给外层整块滚 */
  .kb-col__list { overflow: visible; }
}
</style>
