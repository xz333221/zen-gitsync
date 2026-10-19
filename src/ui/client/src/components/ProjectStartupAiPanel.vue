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
  「AI 启动建议」面板(挂在 NPM 脚本面板**上面**,与它同一个手风琴家族,默认展开)。

  下面的 NPM 脚本面板把项目里所有 package.json 脚本平铺出来,但一个 monorepo 十几个包、
  上百条脚本时,「哪条才是入口、按什么顺序跑」只能靠人认。这个面板让默认模型读一遍
  **服务端实测扫到的**事实(各目录脚本 / 标志文件 / 可执行文件 / README 摘要),
  把答案按启动顺序列出来,每条一个按钮,点了就在新终端里跑起来(后端 routes/projectStartupAi.js)。

  五条交互口径:
  · 配了模型才自动分析;没配就只显示一句"先去添加模型",不发请求。
  · **面板恒显示**(含非 Git 仓库目录):没扫到事实(NO_FACTS)或模型没排出建议时,
    显示的是一句明确的空态提示,而不是整块消失 —— 用户要求"非 git 的仓库也展示出来",
    而且空壳面板恰好是告诉用户"这个功能在、只是这个目录看不出怎么起"的唯一地方。
  · 结果按 项目路径 + 语言 + 模型 缓存(utils/projectStartupCache),切目录/重挂载都不会
    重复问模型;刷新按钮是**显式**的强制重跑入口。
  · npm 类建议直接跑(服务端已校验脚本名真实存在);shell 类是模型给的原话,
    执行前必须再弹一次确认 —— 命令的每个字都由用户过目后才落到终端里。
  · 真报错(网关挂了之类)照旧显示错误态,不藏。
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import IconButton from '@components/IconButton.vue'
import SvgIcon from '@components/SvgIcon/index.vue'
import { $t } from '@/lang/static'
import { useConfigStore } from '@stores/configStore'
import { useProjectStartupSuggestions } from '@/composables/useProjectStartupSuggestions'
import type { StartupSuggestion } from '@/utils/projectStartupCache'

const configStore = useConfigStore()

/**
 * 要分析哪个项目。
 *   · 不传（Git 视图左栏的用法）：分析**当前项目** —— 与抽出 composable 之前逐字一致。
 *   · 传路径（「项目管理」视图逐个项目展开的用法）：分析指定项目，服务端会拿项目清单
 *     白名单校验这个路径。挂在 `v-if="expanded"` 后面时，组件挂载才发请求 = 展开才分析。
 */
const props = defineProps<{ projectPath?: string }>()

// 状态机与请求逻辑全在 composable 里（与「项目管理」视图共用同一份实现）
const { status, suggestions, errorText, runningId, launchedIds, hasModel, sync, analyze, launch } =
  useProjectStartupSuggestions(() => ({
    // 缓存键始终用真实目录（不传 prop 时就是当前项目）
    cachePath: props.projectPath || configStore.currentDirectory,
    // 请求体里的 projectPath 只在"分析指定项目"时才给：不传 = 服务端分析当前项目，
    // 这正是 Git 视图这个面板原来的行为（带上它反而会多走一层清单白名单校验）
    requestPath: props.projectPath || '',
  }))

// 手风琴折叠状态 —— 与 NPM 脚本面板相反:**默认展开**(这个面板空着就没有存在意义)
const collapsed = ref(false)

/**
 * 「下一步」= 第一条还没启动的建议。只有它用实心 primary 按钮:
 * 六条建议并排六个实心蓝按钮,等于没有主次,也压过了左栏别的动作;
 * 把"下一步"挑出来,面板"按顺序启动"的语义才落到视觉上。
 */
const nextId = computed(() => suggestions.value.find((item) => !launchedIds.value.has(item.id))?.id || '')

/**
 * 「在哪个目录/子包」的标签。根目录的 label 就是一个 "." —— 跟在命令后面像标点,
 * 又不提供任何"在哪个子包"的信息(根目录本来就是默认值),直接不显示。
 */
function whereLabel(item: StartupSuggestion): string {
  const label = item.packageLabel || item.cwdLabel || ''
  return label === '.' || label === './' ? '' : label
}

function toggleCollapsed() {
  collapsed.value = !collapsed.value
}

/**
 * 面板**恒显示**:没有事实(NO_FACTS)或模型没排出建议(empty)时显示的是一句明确的
 * 空态提示,而不是整块不渲染。理由:
 * · 用户要求"非 git 的仓库也展示出来" —— 非 Git 目录(发布产物 / 下载的应用)恰恰是
 *   最容易命中 NO_FACTS 的一类,整块藏掉等于这个功能在那里的用户体验就是"不存在"。
 * · 空壳面板是告诉用户"功能在、只是这个目录看不出怎么起"的唯一地方;藏掉它,
 *   用户只会以为自己哪里配错了,或者根本没这个功能。
 * 注意与 NpmScriptsPanel 的口径区分:那个面板藏掉没问题(脚本扫不到就是真没有可点的),
 * 而这个面板藏着会让"AI 启动建议"在整个界面上凭空消失。
 */

onMounted(() => {
  // 默认展开 + 自动分析:打开界面就能看到"这项目怎么起",不用再点一次。
  // 传了 projectPath 时（「项目管理」视图逐个项目展开），这一句就是"展开才分析"的落点 ——
  // 面板挂在 `v-if="expanded"` 后面，展开才挂载、挂载才走这里。
  sync()
})
</script>

<template>
  <div class="startup-ai-panel">
    <div class="panel-header accordion-header" @click="toggleCollapsed">
      <div class="header-left">
        <el-icon class="accordion-chevron" :class="{ 'is-collapsed': collapsed }">
          <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
            <path fill="currentColor" d="M340.864 149.312a30.592 30.592 0 0 0 0 42.752L652.736 512 340.864 831.872a30.592 30.592 0 0 0 0 42.752 29.12 29.12 0 0 0 41.728 0L714.24 534.336a32 32 0 0 0 0-44.672L382.592 149.376a29.12 29.12 0 0 0-41.728 0z"/>
          </svg>
        </el-icon>
        <svg-icon icon-class="g-ai" class-name="ai-icon" />
        <span class="panel-title">{{ $t('@NPM02:AI 启动建议') }}</span>
        <span v-if="status === 'done'" class="panel-count">{{ launchedIds.size }}/{{ suggestions.length }}</span>
      </div>
      <div class="header-right" @click.stop>
        <IconButton
          size="small"
          :disabled="status === 'loading' || !hasModel"
          :tooltip="$t('@NPM02:重新分析启动方式')"
          @click="analyze"
        >
          <el-icon :class="{ 'is-rotating': status === 'loading' }">
            <Refresh />
          </el-icon>
        </IconButton>
      </div>
    </div>

    <div v-show="!collapsed" class="panel-body">
      <div v-if="status === 'no-model'" class="state-box">
        <p class="state-text">{{ $t('@NPM02:未配置 AI 模型，请先在通用设置里添加模型') }}</p>
      </div>

      <div v-else-if="status === 'loading'" class="state-box">
        <el-icon class="is-loading state-spinner">
          <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
            <path fill="currentColor" d="M512 64a32 32 0 0 1 32 32v192a32 32 0 0 1-64 0V96a32 32 0 0 1 32-32zm0 640a32 32 0 0 1 32 32v192a32 32 0 1 1-64 0V736a32 32 0 0 1 32-32zm448-192a32 32 0 0 1-32 32H736a32 32 0 1 1 0-64h192a32 32 0 0 1 32 32zm-640 0a32 32 0 0 1-32 32H96a32 32 0 0 1 0-64h192a32 32 0 0 1 32 32z"/>
          </svg>
        </el-icon>
        <p class="state-text">{{ $t('@NPM02:正在分析这个项目的启动方式…') }}</p>
      </div>

      <div v-else-if="status === 'error'" class="state-box state-box--error">
        <p class="state-text">{{ errorText }}</p>
      </div>

      <!-- 没有事实 / 没排出建议:明确的空态提示,而不是整块面板消失 -->
      <div v-else-if="status === 'no-facts'" class="state-box">
        <p class="state-text">{{ $t('@NPM02:这个目录里没有识别到启动相关的文件') }}</p>
      </div>

      <div v-else-if="status === 'empty'" class="state-box">
        <p class="state-text">{{ $t('@NPM02:没有分析出启动方式，可以点右上角刷新重试') }}</p>
      </div>

      <div v-if="status === 'done'" class="suggestion-list">
        <div
          v-for="item in suggestions"
          :key="item.id"
          class="suggestion-item"
          :class="{
            'is-launched': launchedIds.has(item.id),
            'is-next': item.id === nextId,
          }"
          :aria-current="item.id === nextId ? 'step' : undefined"
        >
          <!-- 序号即步骤状态:未开始=灰描边数字,下一步=实心蓝,已启动=绿色 ✓。
               三步状态共用同一个 18px 圆,纵向连成一条时间线(见 .suggestion-item::before),
               一眼能看出"走到第几步、还剩几步" -->
          <div class="suggestion-order">
            <svg
              v-if="launchedIds.has(item.id)"
              class="suggestion-check"
              viewBox="0 0 16 16"
              aria-hidden="true"
            >
              <path
                fill="none"
                stroke="currentColor"
                stroke-width="2.4"
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M3.2 8.4 6.4 11.6 12.8 4.6"
              />
            </svg>
            <template v-else>{{ item.order }}</template>
          </div>

          <div class="suggestion-main">
            <!-- 标题独占剩下的宽度(窄栏时最多折成两行),「启动」按钮贴右。
                 按钮之间只有"下一步"是实心 --primary,其余是白底描边:
                 六条并排六个实心蓝按钮会抹平主次,也压过左栏别的动作。
                 "已启动"直接长在按钮上,不再另起文字标签。 -->
            <div class="suggestion-head">
              <span class="suggestion-name" :title="item.title">{{ item.title }}</span>
              <div class="suggestion-actions">
                <el-button
                  :type="item.id === nextId && !launchedIds.has(item.id) ? 'primary' : 'default'"
                  size="small"
                  :disabled="launchedIds.has(item.id)"
                  :loading="runningId === item.id"
                  @click="launch(item)"
                >
                  {{ launchedIds.has(item.id) ? $t('@NPM02:已启动') : $t('@NPM02:启动') }}
                </el-button>
              </div>
            </div>

            <!-- 命令行右侧放类型/目录/说明:命令普遍很短(``npm run dev``),右侧本来就有空。
                 npm 类的命令已经自报家门(npm run ...),不再挂「npm 脚本」pill ——
                 同义重复,还占掉窄栏里很贵的行宽;只有 shell 类需要额外标出来(它点之前要二次确认) -->
            <div class="suggestion-cmdline">
              <span class="suggestion-cmd" :title="item.command">{{ item.command }}</span>
              <span v-if="item.kind !== 'npm'" class="suggestion-tag is-shell">
                {{ $t('@NPM02:命令行') }}
              </span>
              <span
                v-if="whereLabel(item)"
                class="suggestion-where"
                :title="item.packagePath || item.cwd"
              >
                {{ whereLabel(item) }}
              </span>
              <span v-if="item.reason" class="suggestion-reason" :title="item.reason">{{ item.reason }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
/* 手风琴外壳与 NpmScriptsPanel 逐项对齐(它是本栏目里"长什么样"的唯一参照),
   两块的差异只有默认展开/收起那一个 ref */
.startup-ai-panel {
  position: relative;
  background: var(--bg-container);
  border-radius: 0;
  margin-top: var(--spacing-md);
  overflow: hidden;
  box-shadow: var(--shadow-md);
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 5px 8px 5px var(--spacing-md);
  background: var(--bg-input);
}

.accordion-header {
  cursor: pointer;
  user-select: none;
}

.accordion-header:hover {
  background: var(--bg-input-hover) !important;
}

.accordion-chevron {
  color: var(--text-secondary);
  transition: transform var(--transition-base) ease;
  transform: rotate(90deg);
  flex-shrink: 0;
}

.accordion-chevron.is-collapsed {
  transform: rotate(0deg);
}

.header-left {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  min-width: 0;
}

.ai-icon {
  width: 18px;
  height: 18px;
}

.panel-title {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text);
}

/* 进度:0/6 → 6/6。不再用描边徽标(那看起来像个小按钮),只留一枚淡底数字 */
.panel-count {
  font-size: var(--font-size-xs);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
  padding: 1px 6px;
  background: var(--bg-input-hover);
  border-radius: 999px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
}

.is-rotating {
  animation: rotating 1s linear infinite;
}

@keyframes rotating {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* 列表是"行"不是"卡片":行要通到面板两边,悬停底色才像一条列表项,
   所以 body 左右不留白,状态盒自己补回 6px */
.panel-body {
  padding: 6px 0;
}

.state-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 0 6px;
  padding: 18px 12px;
  border: 1px dashed var(--border-card);
  border-radius: var(--radius-md);
}

.state-box--error {
  border-style: solid;
  border-color: var(--color-danger);
  background: var(--tint-danger-08);
}

.state-text {
  margin: 0;
  text-align: center;
  font-size: var(--font-size-sm);
  line-height: 1.5;
  color: var(--text-secondary);
  word-break: break-word;
}

.state-box--error .state-text {
  color: var(--color-danger-dark);
}

.state-spinner {
  font-size: 22px;
  color: var(--color-primary);
}

.suggestion-list {
  display: flex;
  flex-direction: column;
  /* 面板在左栏底部,不给自己加拖拽调高 —— 列表内部滚动,免得把文件列表挤没。
     330px 按"六条两行行高"实测调:旧的 300px 会把第 5 条拦腰截断 */
  max-height: 330px;
  overflow-y: auto;
  padding-bottom: 2px;
  /* 左栏可拖拽,窄到 212px 时说明只剩个位数宽度(半截省略号);按"列表自身的宽度"
     而不是视口宽度做判断 —— 容器查询正好是这个语义 */
  container-type: inline-size;
}

@container (max-width: 260px) {
  /* 窄栏里说明只剩个位数宽度,留着就是半截省略号;类型 pill 会被挤到下一行单独站着 */
  .suggestion-reason,
  .suggestion-tag {
    display: none;
  }
}

/* 行式列表:分隔线代替卡片四边框,悬停整行 --bg-input-hover。
   与下方 NpmScriptsPanel 的 .script-item 同一族语法,两块相邻面板不再各说各话 */
.suggestion-item {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--border-card);
  transition: background var(--transition-base) ease;
}

.suggestion-item:last-child {
  border-bottom: 0;
}

.suggestion-item:hover {
  background: var(--bg-input-hover);
}

/* 步骤之间的连接线:贯穿整行、从序号圆底下穿过(圆有不透明底,线自然断开) */
.suggestion-item::before {
  content: '';
  position: absolute;
  left: 18.5px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--border-card);
}

.suggestion-item:first-child::before {
  top: 15px;
}

.suggestion-item:last-child::before {
  bottom: calc(100% - 15px);
}

/* 序号 = 步骤状态:未开始灰描边 / 下一步实心蓝 / 已启动绿底 ✓ */
.suggestion-order {
  position: relative;
  z-index: 1;
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--text-meta);
  background: var(--bg-container);
  border: 1px solid var(--border-card);
}

.suggestion-item.is-next .suggestion-order {
  color: #fff;
  background: var(--color-primary);
  border-color: var(--color-primary);
}

.suggestion-item.is-launched .suggestion-order {
  color: #fff;
  background: var(--color-success);
  border-color: var(--color-success);
}

.suggestion-check {
  display: block;
  width: 10px;
  height: 10px;
}

.suggestion-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.suggestion-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--font-size-sm);
  font-weight: 600;
  line-height: 1.35;
  color: var(--color-text);
  /* 最长两行后省略 —— 标题是这一行的主语,宁可换行也不缩成一个词 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

/* 标题 + 启动按钮:同一行。按钮 flex-shrink:0 靠右,标题吃掉剩下的宽度
   (窄栏时折两行,见 .suggestion-name 的 line-clamp) */
.suggestion-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.suggestion-actions {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 紧凑一档:22px 高让整行从 64px 收到 ~53px,六条才可能一个屏幕放完 */
.suggestion-actions :deep(.el-button) {
  height: 22px;
  padding: 0 10px;
}

/* 命令 + 类型 pill + 目录:同一行。命令换行时整块自然下移,不会把 pill 挤没 */
.suggestion-cmdline {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 3px 6px;
  min-width: 0;
}

.suggestion-tag {
  flex-shrink: 0;
  padding: 0 5px;
  border-radius: 999px;
  font-size: var(--font-size-xs);
  font-weight: 600;
  border: 1px solid transparent;

  &.is-shell {
    color: #9c27b0;
    background: rgba(156, 39, 176, 0.12);
    border-color: rgba(156, 39, 176, 0.25);
  }
}

/* 目录名在 pill 右边,窄了截断(配 title 提示);不再 flex:1 去撑满 —— 撑满会把
   命令挤到换行,反而更松散 */
.suggestion-where {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 45%;
  font-size: var(--font-size-xs);
  color: var(--text-meta);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.suggestion-cmd {
  flex: 0 1 auto;
  min-width: 0;
  padding: 1px 5px;
  border-radius: var(--radius-xs);
  font-size: var(--font-size-xs);
  line-height: 1.4;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  color: var(--color-text);
  /* 卡片底也是白的，命令再用 --bg-container 等于没有底色；--bg-subtle 才看得出是"代码块" */
  background: var(--bg-subtle);
  /* 命令是要照着看的那一行,长命令换行显示,不截断 */
  white-space: normal;
  overflow-wrap: anywhere;
}

/* 已启动：序号变绿 ✓ 之后，标题和命令一起降级，别再用绿边框另说一遍 */
.suggestion-item.is-launched .suggestion-name,
.suggestion-item.is-launched .suggestion-cmd {
  color: var(--text-secondary);
}

/* 说明跟在「类型 pill + 目录」后面,吃掉行尾剩下的宽度 —— 这就是第三行消失的原因。
   flex-basis 必须是 0 而不是 auto:这一行是 flex-wrap 的(长命令要能换行),
   而换行判据看的是各个元素的**假定宽度**(basis),写 auto 的话说明一长(普遍都长)
   整块会被挤到第二行,卡片又变回三行。basis=0 让它永远留在本行、再按剩余宽度截断。
   拿不到宽度(窄栏 / 命令特别长)时整块宽度为 0,自然看不见,不留半截省略号。 */
.suggestion-reason {
  flex: 1 1 0;
  min-width: 0;
  font-size: var(--font-size-xs);
  line-height: 1.4;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.suggestion-list::-webkit-scrollbar {
  width: 8px;
}

.suggestion-list::-webkit-scrollbar-track {
  background: var(--bg-input);
  border-radius: var(--radius-base);
}

.suggestion-list::-webkit-scrollbar-thumb {
  background: var(--border-card);
  border-radius: var(--radius-base);
}

.suggestion-list::-webkit-scrollbar-thumb:hover {
  background: var(--border-card-hover);
}
</style>
