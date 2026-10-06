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
<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue'
import { ElDropdown, ElDropdownMenu, ElDropdownItem, ElIcon, ElMessage, ElMessageBox } from 'element-plus'
import { ArrowDown, Close, Loading } from '@element-plus/icons-vue'
import { $t } from '@/lang/static'
import { useInstancesStore } from '@/stores/instancesStore'
import { getFolderNameFromPath } from '@/utils/path'
import type { InstanceInfo } from '@/types/instances'
import ServerClosedOverlay from '@/components/ServerClosedOverlay.vue'

const store = useInstancesStore()
const dropdownVisible = ref(false)
const closingPid = ref<number | null>(null)
const closingAll = ref(false)
// 「关闭当前实例」兜底遮罩:window.close() 被浏览器拦截时展示(见 requestClose)
const selfClosed = ref(false)
const selfClosedName = ref('')
let selfCloseFallbackTimer: number | null = null

// 组件卸载时清掉兜底定时器,避免向已卸载的组件写状态、或干扰后续测试/热更新
onBeforeUnmount(() => {
  if (selfCloseFallbackTimer != null) {
    window.clearTimeout(selfCloseFallbackTimer)
    selfCloseFallbackTimer = null
  }
})

// 列表为空时不渲染（单实例用户无意义）
const hasAny = computed(() => store.list.length > 0)

const count = computed(() => store.list.length)

// 「关闭全部」现在把当前实例也算进去，所以只要列表里有实例就能用
// （极端情况：只剩自己一个 → 按钮显示「关闭所有实例 (1)」，点了就关掉自己 + 本页）。
const canCloseAll = computed(() => count.value > 0)

// 触发器文本：总数 + 当前项目名
const triggerText = computed(() => `${count.value} ${$t('@INSSW:个实例')}`)

function handleOpen(port: number) {
  if (!port) return
  // 注意不要带 'noopener':带 noopener 打开的标签页没有 opener,
  // 浏览器(Chrome/Firefox)会把它当作用户手动打开的页面,禁止它随后
  // 用 window.close() 关掉自己 —— 「关闭当前实例」就会变成僵尸页面。
  // 两边都是本机同源的实例 UI,opener 暴露可接受。
  window.open(`http://localhost:${port}`, '_blank')
}

function pathSubtitle(instance: InstanceInfo): string {
  return getFolderNameFromPath(instance.projectPath) || instance.projectName
}

function instanceInitial(instance: InstanceInfo): string {
  return (instance.projectName || pathSubtitle(instance) || '?').slice(0, 1).toUpperCase()
}

// 「当前实例的后台已经关了，收尾这个 tab」——「关闭当前实例」与「关闭所有实例
// （含当前）」共用同一套收尾：
//   1) 先试着 window.close()；Chrome 90+ 禁止脚本关闭用户手动打开的 tab，
//      这里大概率被静默忽略 —— 能关则最好；
//   2) 250ms 后页面还活着(window.close 被拦截)就亮全屏遮罩，并停掉 store 的
//      轮询 / socket 重连，避免僵尸页面对已关闭的端口无限重连。
//      若 window.close 成功，页面已卸载，这个定时器自然不会执行。
function beginSelfClose(name: string) {
  selfClosedName.value = name
  try { window.close() } catch (_) { /* 浏览器拦截,忽略 */ }
  if (selfCloseFallbackTimer != null) {
    window.clearTimeout(selfCloseFallbackTimer)
  }
  selfCloseFallbackTimer = window.setTimeout(() => {
    selfCloseFallbackTimer = null
    selfClosed.value = true
    try { store.stop() } catch (_) { /* store 未启动,忽略 */ }
  }, 250)
}

async function requestClose(instance: InstanceInfo) {
  if (closingPid.value != null || closingAll.value) return
  // 当前实例的关闭同时影响后台和当前 tab,文案单独区分,避免用户以为只是关别人。
  const isSelf = instance.pid === store.currentInstanceId
  const title = isSelf
    ? $t('@INSSW:关闭当前实例')
    : $t('@INSSW:关闭实例')
  const content = isSelf
    ? $t('@INSSW:关闭当前实例确认内容', { name: instance.projectName })
    : $t('@INSSW:关闭实例确认内容', { name: instance.projectName, port: instance.port })
  try {
    await ElMessageBox.confirm(content, title, {
      confirmButtonText: $t('@INSSW:确认关闭'),
      cancelButtonText: $t('@INSSW:取消'),
      type: 'warning',
      autofocus: false,
    })
  } catch {
    return
  }

  closingPid.value = instance.pid
  try {
    await store.closeInstance(instance.pid)
    ElMessage.success(
      isSelf
        ? $t('@INSSW:当前实例已关闭', { name: instance.projectName })
        : $t('@INSSW:实例已关闭', { name: instance.projectName })
    )
    // 关掉当前实例的后台服务后,再尝试关当前 tab(关不掉则亮兜底遮罩)。
    if (isSelf) {
      beginSelfClose(instance.projectName)
    }
  } catch (error) {
    ElMessage.error(`${$t('@INSSW:关闭实例失败')}: ${(error as Error).message}`)
    await store.refresh()
  } finally {
    closingPid.value = null
  }
}

async function requestCloseAll() {
  if (!canCloseAll.value || closingAll.value) return
  // 文案里的数字是**总数**（含当前实例），与按钮上的 (N)、下拉里的实例条数一致。
  const target = count.value
  try {
    await ElMessageBox.confirm(
      $t('@INSSW:关闭所有实例确认内容', { count: target }),
      $t('@INSSW:关闭所有实例'),
      {
        confirmButtonText: $t('@INSSW:确认关闭'),
        cancelButtonText: $t('@INSSW:取消'),
        type: 'warning',
        autofocus: false,
      },
    )
  } catch {
    return
  }

  closingAll.value = true
  try {
    const result = await store.closeAllInstances()
    if (result.failed === 0) {
      ElMessage.success($t('@INSSW:关闭所有实例成功', { closed: result.closed }))
    } else {
      ElMessage.warning(
        $t('@INSSW:关闭所有实例部分失败', { closed: result.closed, failed: result.failed }),
      )
    }
    // 当前实例也在这批里：后端已经在 graceful 退出，本页跟着收尾
    // （与「关闭当前实例」同一条路：先试关 tab，关不掉亮兜底遮罩）。
    if (result.selfClose) {
      beginSelfClose(store.currentInstance?.projectName ?? '')
    }
  } catch (error) {
    ElMessage.error(`${$t('@INSSW:关闭实例失败')}: ${(error as Error).message}`)
    await store.refresh()
  } finally {
    closingAll.value = false
  }
}
</script>

<template>
  <el-dropdown
    v-if="hasAny"
    trigger="click"
    placement="bottom-end"
    popper-class="instance-switcher-popper"
    @command="handleOpen"
    @visible-change="dropdownVisible = $event"
  >
    <button
      type="button"
      class="instance-switcher"
      :class="{ 'is-open': dropdownVisible }"
      :aria-label="triggerText"
      :aria-expanded="dropdownVisible"
    >
      <el-icon class="switcher-icon">
        <!-- apps/layers 图标 -->
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      </el-icon>
      <span class="switcher-count">{{ count }}</span>
      <span class="switcher-label">{{ $t('@INSSW:运行中') }}</span>
      <el-icon class="switcher-chevron"><ArrowDown /></el-icon>
    </button>
    <template #dropdown>
      <el-dropdown-menu class="instance-dropdown-menu">
        <li class="instance-menu-header" role="presentation">
          <div>
            <strong>{{ $t('@INSSW:运行中的实例') }}</strong>
            <span>{{ $t('@INSSW:点击实例可在新标签页打开') }}</span>
          </div>
          <div class="instance-header-actions">
            <button
              v-if="canCloseAll"
              type="button"
              class="instance-close-all"
              :class="{ 'is-loading': closingAll }"
              :disabled="closingAll || closingPid != null"
              :aria-label="$t('@INSSW:关闭所有实例')"
              :title="$t('@INSSW:关闭所有实例 {count}', { count })"
              @click.stop.prevent="requestCloseAll"
            >
              <el-icon v-if="closingAll"><Loading /></el-icon>
              <el-icon v-else><Close /></el-icon>
              <span>{{ $t('@INSSW:关闭所有实例 {count}', { count }) }}</span>
            </button>
          </div>
        </li>

        <!-- 当前实例(整行 disabled 防止误触发 dropdown 的 command → 新标签页打开;
             内置独立关闭按钮走自己的 click,实现"先关后台再关 tab"流程) -->
        <el-dropdown-item v-if="store.currentInstance" disabled class="instance-menu-item instance-menu-item--current">
          <div class="instance-row instance-row--current">
            <span class="instance-avatar" aria-hidden="true">{{ instanceInitial(store.currentInstance) }}</span>
            <div class="instance-content">
              <div class="instance-row-main">
                <span class="instance-name">{{ store.currentInstance.projectName }}</span>
                <span class="instance-current-label">{{ $t('@INSSW:当前') }}</span>
              </div>
              <span class="instance-path" :title="store.currentInstance.projectPath">
                {{ store.currentInstance.projectPath }}
              </span>
            </div>
            <div class="instance-action">
              <span class="port-badge">:{{ store.currentInstance.port }}</span>
              <button
                type="button"
                class="instance-close"
                :class="{ 'is-loading': closingPid === store.currentInstance.pid }"
                :disabled="closingPid != null || closingAll"
                :aria-label="$t('@INSSW:关闭当前实例')"
                :title="$t('@INSSW:关闭当前实例')"
                @click.stop.prevent="requestClose(store.currentInstance)"
              >
                <el-icon v-if="closingPid === store.currentInstance.pid"><Loading /></el-icon>
                <el-icon v-else><Close /></el-icon>
              </button>
            </div>
          </div>
        </el-dropdown-item>

        <!-- 其他运行中的实例 -->
        <el-dropdown-item
          v-for="inst in store.otherInstances"
          :key="inst.pid"
          :command="inst.port"
          class="instance-menu-item"
        >
          <div class="instance-row">
            <span class="instance-avatar" aria-hidden="true">{{ instanceInitial(inst) }}</span>
            <div class="instance-content">
              <div class="instance-row-main">
                <span class="instance-name">{{ inst.projectName }}</span>
              </div>
              <span class="instance-path" :title="inst.projectPath">{{ inst.projectPath }}</span>
            </div>
            <div class="instance-action">
              <span class="port-badge">:{{ inst.port }}</span>
              <button
                type="button"
                class="instance-close"
                :class="{ 'is-loading': closingPid === inst.pid }"
                :disabled="closingPid != null || closingAll"
                :aria-label="$t('@INSSW:关闭实例 {name}', { name: inst.projectName })"
                :title="$t('@INSSW:关闭实例')"
                @click.stop.prevent="requestClose(inst)"
              >
                <el-icon v-if="closingPid === inst.pid"><Loading /></el-icon>
                <el-icon v-else><Close /></el-icon>
              </button>
            </div>
          </div>
        </el-dropdown-item>

        <!-- 空状态 -->
        <el-dropdown-item v-if="store.otherInstances.length === 0" disabled>
          <span class="instance-empty">{{ $t('@INSSW:无其他运行中的实例') }}</span>
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>

  <!-- 「关闭当前实例」兜底遮罩:后台已关、window.close() 又被浏览器拦截时,
       页面还活着但已与服务端断开 —— 明确告知用户此标签页可以安全关闭,
       避免停留在僵尸页面上误以为实例还在运行。
       遮罩本体与 useServerLifecycle 的「服务端已退出」路径共用同一组件。 -->
  <ServerClosedOverlay :visible="selfClosed" :name="selfClosedName" />
</template>

<style scoped>
.instance-switcher {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  cursor: pointer;
  border-radius: var(--radius-lg);
  /* 2026-10-06：默认态跟顶栏另外两个图标按钮（命令历史 / Git 操作，都是
     IconButton 的 border:none + background:transparent）对齐 —— 之前这里
     写的是 1px --border-component + --bg-subtle，在同排三个按钮里只有它
     带框带底，看起来像"另一个东西"。hover / is-open 仍保留 primary 描边
     和 7% 底色，所以"可点"这件事没丢，只是默认不再抢眼。 */
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium, 500);
  transition: border-color var(--transition-base) ease, box-shadow var(--transition-base) ease, background var(--transition-base) ease, color var(--transition-base) ease, transform var(--transition-fast) ease;
  user-select: none;
  flex-shrink: 0;
}

.instance-switcher:hover,
.instance-switcher.is-open {
  border-color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 7%, var(--bg-container));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary) 11%, transparent);
  color: var(--text-primary);
}

.instance-switcher:active { transform: scale(0.98); }

.instance-switcher:focus-visible {
  outline: var(--focus-outline);
  outline-offset: 2px;
}

.switcher-icon {
  font-size: var(--font-size-lg);
  display: flex;
  align-items: center;
}

.switcher-icon svg {
  width: 16px;
  height: 16px;
}

.switcher-count,
.switcher-label,
.switcher-chevron {
  display: none;
}

.instance-row {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  width: min(340px, calc(100vw - 32px));
  padding: 8px 6px;
}

.instance-row--current {
  position: relative;
}

.instance-row-main {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.instance-name {
  font-weight: 600;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.instance-content {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.port-badge {
  flex-shrink: 0;
  padding: 2px 5px;
  border: 1px solid color-mix(in srgb, var(--color-primary) 28%, var(--border-color));
  border-radius: 5px;
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 5%, transparent);
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
}

.instance-path {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

.instance-avatar {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: var(--radius-lg);
  color: var(--text-secondary);
  background: var(--bg-panel);
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: var(--font-size-sm);
  font-weight: 700;
}

.instance-current-label {
  flex-shrink: 0;
  color: var(--color-primary);
  font-size: var(--font-size-xs);
  font-weight: 600;
}

.instance-action {
  position: relative;
  display: grid;
  place-items: center;
  min-width: 42px;
  min-height: 30px;
}

.instance-close {
  position: absolute;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  opacity: 0;
  transform: scale(0.86);
  pointer-events: none;
  transition: opacity var(--transition-fast) ease, transform var(--transition-fast) ease, color var(--transition-fast) ease, background var(--transition-fast) ease;
}

.instance-close:hover {
  color: var(--color-danger-dark);
  background: color-mix(in srgb, var(--el-color-danger) 10%, transparent);
}

.instance-close:focus-visible {
  outline: 2px solid var(--el-color-danger);
  outline-offset: 1px;
}

.instance-close.is-loading :deep(svg) {
  animation: rotating 1s linear infinite;
}

.instance-empty {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  font-style: italic;
}

:global(.instance-switcher-popper.el-popper) {
  overflow: hidden;
  border: 1px solid var(--dialog-border-color);
  border-radius: var(--radius-xl);
  box-shadow: var(--dialog-shadow);
}

:global(.instance-switcher-popper .el-dropdown-menu) {
  min-width: 354px;
  padding: 6px;
}

:global(.instance-switcher-popper .instance-menu-header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 9px 10px 10px;
  border-bottom: 1px solid var(--border-color-light);
  margin-bottom: 4px;
}

:global(.instance-switcher-popper .instance-menu-header > div) {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

:global(.instance-switcher-popper .instance-menu-header strong) {
  color: var(--text-primary);
  font-size: var(--font-size-mid);
  font-weight: 650;
  letter-spacing: -0.1px;
}

:global(.instance-switcher-popper .instance-menu-header span) {
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
}

/* 2026-10-06：删掉了原来的 .instance-total 徽章 —— 它和左边
   「关闭所有实例 (6)」里的数字是同一个count，同屏出现两次、就贴在旁边，
   纯冗余。计数信息没丢，仍由那枚按钮的文案承载。 */
:global(.instance-switcher-popper .instance-header-actions) {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

:global(.instance-switcher-popper .instance-close-all) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid color-mix(in srgb, var(--el-color-danger) 28%, var(--border-color));
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--el-color-danger) 4%, transparent);
  color: var(--color-danger-dark);
  font-size: var(--font-size-xs);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--transition-fast) ease, border-color var(--transition-fast) ease, color var(--transition-fast) ease, opacity var(--transition-fast) ease;
}

:global(.instance-switcher-popper .instance-close-all:hover) {
  background: color-mix(in srgb, var(--el-color-danger) 12%, transparent);
  border-color: color-mix(in srgb, var(--el-color-danger) 50%, var(--border-color));
}

:global(.instance-switcher-popper .instance-close-all:focus-visible) {
  outline: 2px solid var(--el-color-danger);
  outline-offset: 1px;
}

:global(.instance-switcher-popper .instance-close-all:disabled) {
  cursor: not-allowed;
  opacity: var(--disabled-opacity);
}

:global(.instance-switcher-popper .instance-close-all.is-loading :deep(svg)) {
  animation: rotating 1s linear infinite;
}

:global(.instance-switcher-popper .instance-close-all .el-icon) {
  font-size: var(--font-size-sm);
}

:global(.instance-switcher-popper .instance-menu-item) {
  height: auto;
  padding: 0;
  border-radius: var(--radius-lg);
  line-height: normal;
}

:global(.instance-switcher-popper .instance-menu-item:not(.is-disabled):hover),
:global(.instance-switcher-popper .instance-menu-item:not(.is-disabled):focus) {
  background: var(--bg-panel-hover);
}

/* 2026-10-06：当前实例行**不再做「选中」态**。
   原来这里给的是 `color-mix(--color-primary 7%)` 淡蓝底 + 一根 2px 主色竖条
   （::before），看上去像"这一项被选中了"，而它其实只是"你正在看这一项"——
   而且它是 disabled 的（点不动，也不该被点），根本不是可选列表里的一个选项。
   降级成普通行：底色交给 hover 规则统一管，竖条删掉。
   「当前」两个字保留 —— 那是**标识**（哪个是我），不是**选中态**（我选了哪个），
   去掉的话这一行就彻底看不出是本页面了。 */
:global(.instance-switcher-popper .instance-menu-item--current.is-disabled) {
  position: relative;
  opacity: 1;
  cursor: default;
  background: transparent;
}

:global(.instance-switcher-popper .instance-menu-item:not(.is-disabled):hover .port-badge),
:global(.instance-switcher-popper .instance-menu-item:not(.is-disabled):focus-within .port-badge) {
  opacity: 0;
  transform: scale(0.88);
}

:global(.instance-switcher-popper .instance-menu-item:not(.is-disabled):hover .instance-close),
:global(.instance-switcher-popper .instance-menu-item:not(.is-disabled):focus-within .instance-close) {
  opacity: 1;
  transform: scale(1);
  pointer-events: auto;
}

/* 当前实例行是 disabled 的（点自己没意义），吃不到上面那条
   `:not(.is-disabled):hover` —— 所以单独给一份不含 `:not()` 的。
   `:not()` 不提升特异性，`:not(.is-disabled):hover` 与 `:hover`
   同为 (0,3,0)，两条并存时按书写顺序后者生效，所以这条必须写在它后面。 */
:global(.instance-switcher-popper .instance-menu-item--current:hover .instance-close),
:global(.instance-switcher-popper .instance-menu-item--current:focus-within .instance-close) {
  opacity: 1;
  transform: scale(1);
  pointer-events: auto;
}

/* 同样两条：hover 时让端口徽章淡出，给 × 让位。
   写在一起是因为它们永远是成对出现——只淡出不显现会留下一个空档。 */
:global(.instance-switcher-popper .instance-menu-item--current:hover .port-badge),
:global(.instance-switcher-popper .instance-menu-item--current:focus-within .port-badge) {
  opacity: 0;
  transform: scale(0.88);
}

/* 2026-10-06：当前实例行的关闭按钮**也改成 hover 才显示**，
   与其余实例行一致。

   改前这里有一整套"当前行例外"（`position: static` + `opacity: 1` +
   `pointer-events: auto` + port-badge 不淡出），理由是"让用户一眼能看到
   我也能被关"。但这个理由站不住：
     · 列表顶部已经有一枚显眼的「关闭所有实例 (6)」按钮，关闭能力不缺曝光；
     · 平时 6 行里 5 行的 × 都是隐的，只有第一行常驻，反而像"这一行特殊"；
     · 端口徽章和 × 并排常驻，把这一行的右端塞得比别的行满。

   ⚠️ 关键：不能只删这几条。当前行是 **disabled** 的（点自己没意义），
   而 hover 显现那条规则写的是 `.instance-menu-item:not(.is-disabled):hover`
   —— 所以删完之后当前行会**永远不显现**。必须给 `--current` 补一条
   不带 `:not(.is-disabled)` 的 hover/focus-within 规则（下一段）。

   也因此这里不能靠"通用 hover 规则"覆盖：`:not()` 不参与提升特异性，
   `:not(.is-disabled):hover` 与 `:hover` 同为 (0,3,0)，谁写在后面谁赢。 */

:global(.instance-switcher-popper .port-badge) {
  transition: opacity var(--transition-fast) ease, transform var(--transition-fast) ease;
}

@keyframes rotating {
  to { transform: rotate(360deg); }
}
</style>
