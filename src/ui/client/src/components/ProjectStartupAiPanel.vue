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
  **服务端实测扫到的**事实(各目录脚本 / 标志文件 / README 摘要),把答案按启动顺序列出来,
  每条一个按钮,点了就在新终端里跑起来(后端 routes/projectStartupAi.js)。

  四条交互口径:
  · 配了模型才自动分析;没配就只显示一句"先去添加模型",不发请求。
  · **没内容就不出现**:这个目录没有 package.json / 启动相关文件(NO_FACTS),或者模型
    一条都没排出来,面板整块不渲染 —— 与下面的 NPM 脚本面板同一口径,空壳只占地方。
  · 结果按 项目路径 + 语言 + 模型 缓存(utils/projectStartupCache),切目录/重挂载都不会
    重复问模型;刷新按钮是**显式**的强制重跑入口。
  · npm 类建议直接跑(服务端已校验脚本名真实存在);shell 类是模型给的原话,
    执行前必须再弹一次确认 —— 命令的每个字都由用户过目后才落到终端里。
-->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import IconButton from '@components/IconButton.vue'
import SvgIcon from '@components/SvgIcon/index.vue'
import { $t } from '@/lang/static'
import { useConfigStore } from '@stores/configStore'
import {
  dropStartupSuggestions,
  pendingStartupSuggestions,
  readStartupSuggestions,
  startupSuggestionsKey,
  trackPendingStartupSuggestions,
  writeStartupSuggestions,
  type StartupSuggestion,
} from '@/utils/projectStartupCache'

const configStore = useConfigStore()

// 手风琴折叠状态 —— 与 NPM 脚本面板相反:**默认展开**(这个面板空着就没有存在意义)
const collapsed = ref(false)

function toggleCollapsed() {
  collapsed.value = !collapsed.value
}

type Status = 'idle' | 'loading' | 'done' | 'empty' | 'no-facts' | 'error' | 'no-model'

const status = ref<Status>('idle')
const suggestions = ref<StartupSuggestion[]>([])
const errorText = ref('')
const runningId = ref('')
/** 本次会话里已经点过启动的条目 —— 只是视觉反馈,不进缓存 */
const launchedIds = ref<Set<string>>(new Set())

const hasModel = computed(() => Array.isArray(configStore.models) && configStore.models.length > 0)

/**
 * 这个目录压根没有 package.json / 启动相关文件,或者模型没排出任何一条可执行的:
 * **整块面板不渲染**。理由同 NpmScriptsPanel —— 一个点开只有一句"看不出来"的空壳,
 * 在左栏里既占地方又让人以为是自己哪里配错了。
 * 只藏"没内容",不藏真报错:网关挂了之类得让人看见。
 */
const visible = computed(() => status.value !== 'empty' && status.value !== 'no-facts')

const locale = computed(() => (String(configStore.locale || '').startsWith('en') ? 'en' : 'zh'))
const modelKey = computed(() => {
  const models = Array.isArray(configStore.models) ? configStore.models : []
  const model = models.find((m: any) => m?.isDefault) || models[0]
  return String(model?.model || model?.id || '')
})
/** 换目录 / 换语言 / 换模型都不能读到上一份 —— SPA 切目录不刷新页面,路径必须进 key */
const cacheKey = computed(() => startupSuggestionsKey(configStore.currentDirectory, locale.value, modelKey.value))

let controller: AbortController | null = null
let requestToken = 0

function applyResult(list: StartupSuggestion[]) {
  suggestions.value = list
  launchedIds.value = new Set()
  status.value = list.length ? 'done' : 'empty'
}

/** 挂载 / 换目录时走这里:能命中缓存就直接换上,否则发起一次分析 */
function sync() {
  if (!hasModel.value) {
    status.value = 'no-model'
    return
  }
  const key = cacheKey.value
  const cached = readStartupSuggestions(key)
  if (cached) {
    // 换 key 时先把在跑的那次作废(它的响应回来会覆盖掉这份命中缓存的旧结果)
    requestToken++
    applyResult(cached)
    return
  }
  const pending = pendingStartupSuggestions(key)
  if (pending) {
    // 另一个实例已经在问了(切目录后又切回来),挂上去等结果,不重复花一次模型调用
    status.value = 'loading'
    const token = ++requestToken
    void pending.then(() => {
      if (token !== requestToken) return
      applyResult(readStartupSuggestions(key) || [])
    })
    return
  }
  void analyze()
}

async function analyze() {
  if (!hasModel.value) {
    status.value = 'no-model'
    return
  }

  controller?.abort()
  const myController = new AbortController()
  controller = myController
  const token = ++requestToken
  const key = cacheKey.value
  status.value = 'loading'
  errorText.value = ''
  dropStartupSuggestions(key)

  const task = (async () => {
    try {
      const response = await fetch('/api/project-startup/suggestions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale: locale.value }),
        signal: myController.signal,
      })
      const result = await response.json().catch(() => null)
      if (token !== requestToken) return

      if (!result) {
        status.value = 'error'
        errorText.value = $t('@NPM02:分析失败，请稍后重试')
        return
      }

      if (result.success === false) {
        // NO_MODEL / NO_FACTS 是本地语义,用本地语义表达;其余(网关报错)原样带出 —— 那句话本身就是排查线索
        if (result.code === 'NO_MODEL') {
          status.value = 'no-model'
          return
        }
        if (result.code === 'NO_FACTS') {
          // 不是错误,是"这个目录压根没有能起的东西" —— 面板直接不出现
          status.value = 'no-facts'
          return
        }
        errorText.value = result.error || $t('@NPM02:分析失败，请稍后重试')
        status.value = 'error'
        return
      }

      const list = Array.isArray(result.suggestions) ? result.suggestions as StartupSuggestion[] : []
      writeStartupSuggestions(key, list)
      applyResult(list)
    } catch (error: any) {
      if (error?.name === 'AbortError') return
      if (token !== requestToken) return
      status.value = 'error'
      errorText.value = error?.message || $t('@NPM02:分析失败，请稍后重试')
    } finally {
      if (controller === myController) controller = null
    }
  })()

  trackPendingStartupSuggestions(key, task)
  await task
}

function markLaunched(id: string) {
  const next = new Set(launchedIds.value)
  next.add(id)
  launchedIds.value = next
}

async function launch(item: StartupSuggestion) {
  runningId.value = item.id
  try {
    if (item.kind === 'npm' && item.packagePath && item.scriptName) {
      const response = await fetch('/api/run-npm-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packagePath: item.packagePath, scriptName: item.scriptName }),
      })
      const result = await response.json().catch(() => null)
      if (result?.success) {
        markLaunched(item.id)
        ElMessage.success(`${$t('@NPM02:已在新终端中启动')}: ${item.command}`)
      } else {
        ElMessage.error(result?.error || $t('@NPM02:启动失败'))
      }
      return
    }

    // shell 类:命令是模型给的原话,执行前必须让用户过目
    try {
      await ElMessageBox.confirm(
        item.command,
        $t('@NPM02:确认在 {dir} 里执行这条命令？', { dir: item.cwdLabel || item.cwd || '.' }),
        {
          confirmButtonText: $t('@NPM02:执行'),
          cancelButtonText: $t('@NPM02:取消'),
          type: 'warning',
        }
      )
    } catch {
      return // 用户取消
    }

    const response = await fetch('/api/exec-in-terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: item.command, workingDirectory: item.cwd }),
    })
    const result = await response.json().catch(() => null)
    if (result?.success) {
      markLaunched(item.id)
      ElMessage.success(`${$t('@NPM02:已在新终端中启动')}: ${item.command}`)
    } else {
      ElMessage.error(result?.error || $t('@NPM02:启动失败'))
    }
  } catch (error: any) {
    ElMessage.error(`${$t('@NPM02:启动失败')}: ${error?.message || error}`)
  } finally {
    runningId.value = ''
  }
}

onMounted(() => {
  // 默认展开 + 自动分析:打开界面就能看到"这项目怎么起",不用再点一次
  sync()
})

// 切工作目录**不会刷新页面**(只清空列表),所以这里得自己跟着换 ——
// 顺带覆盖"在设置里刚加完模型回来"的情况(hasModel 变了)
watch([cacheKey, hasModel], () => sync())
</script>

<template>
  <div v-if="visible" class="startup-ai-panel">
    <div class="panel-header accordion-header" @click="toggleCollapsed">
      <div class="header-left">
        <el-icon class="accordion-chevron" :class="{ 'is-collapsed': collapsed }">
          <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
            <path fill="currentColor" d="M340.864 149.312a30.592 30.592 0 0 0 0 42.752L652.736 512 340.864 831.872a30.592 30.592 0 0 0 0 42.752 29.12 29.12 0 0 0 41.728 0L714.24 534.336a32 32 0 0 0 0-44.672L382.592 149.376a29.12 29.12 0 0 0-41.728 0z"/>
          </svg>
        </el-icon>
        <svg-icon icon-class="g-ai" class-name="ai-icon" />
        <span class="panel-title">{{ $t('@NPM02:AI 启动建议') }}</span>
        <span v-if="status === 'done'" class="panel-count">{{ suggestions.length }}</span>
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

      <div v-if="status === 'done'" class="suggestion-list">
        <div
          v-for="item in suggestions"
          :key="item.id"
          class="suggestion-item"
          :class="{ 'is-launched': launchedIds.has(item.id) }"
        >
          <div class="suggestion-order">{{ item.order }}</div>

          <div class="suggestion-main">
            <!-- 标题独占剩下的宽度(窄栏时最多折成两行),「启动」按钮贴着右上角。
                 按钮能上移是因为它只占 ~52px,不像「类型 pill + 目录」会把标题挤成两三个字
                 (见 lessons/left-column-card-footer.md) —— 那两个元素仍旧待在命令行那一行。
                 "已启动"直接长在按钮上,不再另起一个文字标签:标签会把窄栏标题再砍掉 33px,
                 而卡片绿边框 + 禁用按钮本来就在说同一件事。 -->
            <div class="suggestion-head">
              <span class="suggestion-name" :title="item.title">{{ item.title }}</span>
              <div class="suggestion-actions">
                <el-button
                  :type="launchedIds.has(item.id) ? 'default' : 'primary'"
                  size="small"
                  :disabled="launchedIds.has(item.id)"
                  :loading="runningId === item.id"
                  @click="launch(item)"
                >
                  {{ launchedIds.has(item.id) ? $t('@NPM02:已启动') : $t('@NPM02:启动') }}
                </el-button>
              </div>
            </div>

            <!-- 命令行右侧放类型/目录:命令普遍很短(``npm run dev``),右侧本来就有空;
                 单独占一行的底栏只为了摆这两个元素,现在这一行省掉了 -->
            <div class="suggestion-cmdline">
              <span class="suggestion-cmd" :title="item.command">{{ item.command }}</span>
              <span class="suggestion-meta">
                <span class="suggestion-tag" :class="item.kind === 'npm' ? 'is-npm' : 'is-shell'">
                  {{ item.kind === 'npm' ? $t('@NPM02:npm 脚本') : $t('@NPM02:命令行') }}
                </span>
                <span
                  v-if="item.packageLabel || item.cwdLabel"
                  class="suggestion-where"
                  :title="item.packagePath || item.cwd"
                >
                  {{ item.packageLabel || item.cwdLabel }}
                </span>
              </span>
            </div>

            <span v-if="item.reason" class="suggestion-reason" :title="item.reason">{{ item.reason }}</span>
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

.panel-count {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  padding: var(--spacing-xs) 6px;
  background: var(--bg-container);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-card);
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

.panel-body {
  padding: 6px;
}

.state-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
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
  gap: 6px;
  /* 面板在左栏底部,不给自己加拖拽调高 —— 列表内部滚动,免得把文件列表挤没 */
  max-height: 300px;
  overflow-y: auto;
}

.suggestion-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--border-card);
  border-radius: var(--radius-md);
  background: var(--bg-input);
  transition: var(--transition-ui-base);
}

.suggestion-item:hover {
  border-color: var(--tint-primary-30);
}

.suggestion-item.is-launched {
  border-color: var(--color-success);
}

.suggestion-order {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  font-size: var(--font-size-xs);
  font-weight: 700;
  color: var(--color-primary);
  background: var(--tint-primary-12);
  border: 1px solid var(--tint-primary-22);
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
  /* 最长两行后省略 —— 标题是这张卡片的主语,宁可换行也不缩成一个词 */
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
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}

.suggestion-actions {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 命令 + 类型 pill + 目录:同一行。命令换行时整块自然下移,不会把 pill 挤没 */
.suggestion-cmdline {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 6px;
  min-width: 0;
}

.suggestion-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.suggestion-tag {
  flex-shrink: 0;
  padding: 0 5px;
  border-radius: 999px;
  font-size: var(--font-size-xs);
  font-weight: 600;
  border: 1px solid transparent;

  &.is-npm {
    color: var(--color-primary);
    background: var(--tint-primary-12);
    border-color: var(--tint-primary-22);
  }

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
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  color: var(--color-text);
  background: var(--bg-container);
  /* 命令是要照着看的那一行,长命令换行显示,不截断 */
  white-space: normal;
  overflow-wrap: anywhere;
}

.suggestion-reason {
  font-size: var(--font-size-xs);
  line-height: 1.5;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
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
