<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Plus, RefreshRight, VideoPlay } from '@element-plus/icons-vue'
import CommonDialog from '@components/CommonDialog.vue'
import { useConfigStore } from '@stores/configStore'

const { t } = useI18n()

export type ProjectStartupItem = {
  id: string
  type: 'command' | 'workflow'
  refId: string
  createdAt: number
}

export interface ProjectStartupDialogEmits {
  (e: 'update:visible', value: boolean): void
  (e: 'execute-command', command: any): void
  (e: 'execute-workflow', workflow: any): void
}

const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<ProjectStartupDialogEmits>()

const configStore = useConfigStore()

const STORAGE_KEY = 'zen-gitsync-project-start-items'
const AUTO_RUN_KEY = 'zen-gitsync-project-start-auto-run'

const dialogVisible = computed({
  get: () => props.visible,
  set: (v: boolean) => emit('update:visible', v)
})

const autoRunEnabled = ref(localStorage.getItem(AUTO_RUN_KEY) === 'true')

watch(autoRunEnabled, (v) => {
  try {
    localStorage.setItem(AUTO_RUN_KEY, String(v))
  } catch {
    // ignore
  }
})

const items = ref<ProjectStartupItem[]>([])

function safeParseItems(raw: string | null): ProjectStartupItem[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((x) => x && typeof x === 'object')
      .map((x) => ({
        id: String((x as any).id ?? ''),
        type: ((x as any).type === 'workflow' ? 'workflow' : 'command') as 'command' | 'workflow',
        refId: String((x as any).refId ?? (x as any).commandId ?? ''),
        createdAt: Number((x as any).createdAt ?? Date.now())
      }))
      .filter((x) => x.id && x.refId)
  } catch {
    return []
  }
}

function loadItems() {
  items.value = safeParseItems(localStorage.getItem(STORAGE_KEY))
}

function persistItems() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.value))
  } catch {
    // ignore
  }
}

watch(
  dialogVisible,
  (v) => {
    if (v) {
      loadItems()
    }
  },
  { immediate: true }
)

const customCommands = computed(() => configStore.customCommands || [])
const customCommandById = computed(() => {
  const map = new Map<string, any>()
  for (const c of customCommands.value) {
    if (c?.id) map.set(String(c.id), c)
  }
  return map
})

const orchestrations = computed(() => configStore.orchestrations || [])
const orchestrationById = computed(() => {
  const map = new Map<string, any>()
  for (const o of orchestrations.value) {
    if (o?.id) map.set(String(o.id), o)
  }
  return map
})

const displayItems = computed(() => {
  return items.value
    .map((it) => ({
      ...it,
      cmd: it.type === 'command' ? (customCommandById.value.get(it.refId) as any) : null,
      wf: it.type === 'workflow' ? (orchestrationById.value.get(it.refId) as any) : null
    }))
    .filter((x) => (x.type === 'command' ? !!x.cmd : !!x.wf))
})

const missingItemsCount = computed(() => {
  return items.value.filter((it) => {
    if (it.type === 'workflow') return !orchestrationById.value.get(it.refId)
    return !customCommandById.value.get(it.refId)
  }).length
})

const selectedType = ref<'command' | 'workflow'>('command')
const selectedRefId = ref<string>('')

function genId() {
  return `ps_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

function addSelectedItem() {
  const id = selectedRefId.value
  if (!id) {
    ElMessage.warning(selectedType.value === 'workflow' ? t('@PSTART:请选择一个工作流') : t('@PSTART:请选择一个命令'))
    return
  }

  const exists = items.value.some((x) => x.type === selectedType.value && x.refId === id)
  if (exists) {
    ElMessage.info(t('@PSTART:该启动项已存在'))
    return
  }

  items.value.unshift({
    id: genId(),
    type: selectedType.value,
    refId: id,
    createdAt: Date.now()
  })
  persistItems()
  ElMessage.success(t('@PSTART:已添加启动项'))
}

async function removeItem(item: ProjectStartupItem) {
  try {
    await ElMessageBox.confirm(t('@PSTART:删除确认'), t('@PSTART:删除启动项'), {
      confirmButtonText: t('@PSTART:删除'),
      cancelButtonText: t('@PSTART:取消'),
      type: 'warning'
    })
    items.value = items.value.filter((x) => x.id !== item.id)
    persistItems()
    ElMessage.success(t('@PSTART:已删除启动项'))
  } catch {
    // cancel
  }
}

function cleanupMissingItems() {
  const before = items.value.length
  items.value = items.value.filter((it) => {
    if (it.type === 'workflow') return !!orchestrationById.value.get(it.refId)
    return !!customCommandById.value.get(it.refId)
  })
  const after = items.value.length
  persistItems()
  if (after !== before) {
    ElMessage.success(t('@PSTART:已清理N个失效启动项', { count: before - after }))
  } else {
    ElMessage.info(t('@PSTART:没有需要清理的启动项'))
  }
}

// 执行启动项
function executeItem(item: any) {
  if (item.type === 'command') {
    const cmd = item.cmd
    if (!cmd) {
      ElMessage.warning(t('@PSTART:命令不存在'))
      return
    }
    emit('execute-command', cmd)
    ElMessage.success(t('@PSTART:已触发命令执行'))
  } else if (item.type === 'workflow') {
    const wf = item.wf
    if (!wf) {
      ElMessage.warning(t('@PSTART:工作流不存在'))
      return
    }
    emit('execute-workflow', wf)
    ElMessage.success(t('@PSTART:已触发工作流执行'))
  }
}
</script>

<template>
  <CommonDialog
    v-model="dialogVisible"
    :title="t('@PSTART:项目启动项')"
    size="medium"
    type="flex"
    :height-mode="'max'"
    :height-offset="'140px'"
  >
    <div class="project-startup-dialog">
      <div class="startup-toolbar">
        <div class="startup-toolbar__left">
          <div class="startup-toolbar__title">{{ t('@PSTART:启动项列表') }}</div>
          <div class="startup-toolbar__meta">({{ displayItems.length }})</div>
          <div v-if="missingItemsCount > 0" class="startup-toolbar__warn">
            {{ t('@PSTART:有N项已失效', { count: missingItemsCount }) }}
          </div>
        </div>
        <div class="startup-toolbar__right">
          <div class="startup-auto-run">
            <span class="startup-auto-run__label">{{ t('@PSTART:刷新页面自动执行') }}</span>
            <el-switch v-model="autoRunEnabled" size="small" />
          </div>
          <el-tooltip :content="t('@PSTART:清理失效启动项')" placement="bottom">
            <el-button size="small" @click="cleanupMissingItems" :disabled="missingItemsCount === 0">
              <el-icon><RefreshRight /></el-icon>
              {{ t('@PSTART:清理') }}
            </el-button>
          </el-tooltip>
        </div>
      </div>

      <div v-if="displayItems.length === 0" class="startup-empty">
        {{ t('@PSTART:暂无启动项') }}
      </div>

      <div v-else class="startup-list">
        <div v-for="it in displayItems" :key="it.id" class="startup-item">
          <div class="startup-item__main">
            <div class="startup-item__name" :title="it.type === 'workflow' ? it.wf?.name : it.cmd?.name">
              <span class="startup-item__type" :class="it.type === 'workflow' ? 'is-workflow' : 'is-command'">
                {{ it.type === 'workflow' ? t('@PSTART:工作流') : t('@PSTART:命令') }}
              </span>
              {{ it.type === 'workflow' ? it.wf?.name : it.cmd?.name }}
            </div>
            <div
              v-if="it.type === 'command'"
              class="startup-item__desc"
              :title="it.cmd?.command"
            >
              {{ it.cmd?.command }}
            </div>
            <div
              v-else
              class="startup-item__desc"
              :title="it.wf?.description || it.wf?.name"
            >
              {{ it.wf?.description || t('@PSTART:工作流') }}
            </div>
            <div
              v-if="it.type === 'command'"
              class="startup-item__dir"
              :title="it.cmd?.directory"
            >
              {{ t('@PSTART:目录') }}：{{ it.cmd?.directory || '-' }}
            </div>
            <div
              v-else
              class="startup-item__dir"
              :title="String(it.wf?.steps?.length || 0)"
            >
              {{ t('@PSTART:步骤') }}：{{ it.wf?.steps?.length || 0 }}
            </div>
          </div>
          <div class="startup-item__actions">
            <el-tooltip :content="t('@PSTART:执行')" placement="top">
              <el-button text type="primary" size="small" @click="executeItem(it)">
                <el-icon><VideoPlay /></el-icon>
              </el-button>
            </el-tooltip>
            <el-tooltip :content="t('@PSTART:删除')" placement="top">
              <el-button text type="danger" size="small" @click="removeItem(it)">
                <el-icon><Delete /></el-icon>
              </el-button>
            </el-tooltip>
          </div>
        </div>
      </div>

      <div class="startup-add">
        <div class="startup-add__title">{{ t('@PSTART:添加启动项') }}</div>
        <div class="startup-add__type">
          <el-radio-group v-model="selectedType" size="small" @change="selectedRefId = ''">
            <el-radio-button label="command">{{ t('@PSTART:命令') }}</el-radio-button>
            <el-radio-button label="workflow">{{ t('@PSTART:工作流') }}</el-radio-button>
          </el-radio-group>
        </div>
        <div class="startup-add__row">
          <el-select
            v-model="selectedRefId"
            class="startup-add__select"
            :placeholder="selectedType === 'workflow' ? t('@PSTART:选择一个工作流') : t('@PSTART:选择一个自定义命令')"
            filterable
            clearable
          >
            <template v-if="selectedType === 'workflow'">
              <el-option
                v-for="wf in orchestrations"
                :key="wf.id"
                :label="wf.name"
                :value="wf.id"
              >
                <div class="startup-option">
                  <div class="startup-option__name">{{ wf.name }}</div>
                  <div class="startup-option__cmd">
                    {{ wf.description || `步骤: ${wf.steps?.length || 0}` }}
                  </div>
                </div>
              </el-option>
            </template>
            <template v-else>
              <el-option
                v-for="cmd in customCommands"
                :key="cmd.id"
                :label="cmd.name"
                :value="cmd.id"
              >
                <div class="startup-option">
                  <div class="startup-option__name">{{ cmd.name }}</div>
                  <div class="startup-option__cmd">{{ cmd.command }}</div>
                </div>
              </el-option>
            </template>
          </el-select>
          <el-button type="primary" @click="addSelectedItem">
            <el-icon><Plus /></el-icon>
            {{ t('@PSTART:添加') }}
          </el-button>
        </div>
      </div>
    </div>
  </CommonDialog>
</template>

<style scoped lang="scss">
.project-startup-dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}

.startup-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.startup-toolbar__left {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.startup-toolbar__title {
  font-weight: 700;
  color: var(--text-title);
}

.startup-toolbar__meta {
  color: var(--text-secondary);
}

.startup-toolbar__warn {
  margin-left: 6px;
  color: var(--color-warning);
  font-size: 12px;
}

.startup-auto-run {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-right: 10px;
  color: var(--text-secondary);
}

.startup-auto-run__label {
  font-size: 12px;
}

.startup-empty {
  padding: 14px;
  border: 1px dashed var(--border-component);
  border-radius: 10px;
  color: var(--text-secondary);
  background: var(--bg-panel);
}

.startup-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.startup-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border-component);
  border-radius: 10px;
  background: var(--bg-container);
}

.startup-item__main {
  flex: 1;
  min-width: 0;
}

.startup-item__name {
  font-weight: 700;
  color: var(--text-title);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.startup-item__type {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  margin-right: 6px;
  border: 1px solid transparent;

  &.is-command {
    color: var(--color-primary);
    background: rgba(64, 158, 255, 0.12);
    border-color: rgba(64, 158, 255, 0.25);
  }

  &.is-workflow {
    color: #9c27b0;
    background: rgba(156, 39, 176, 0.12);
    border-color: rgba(156, 39, 176, 0.25);
  }
}

.startup-item__desc {
  margin-top: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.startup-item__dir {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.startup-add {
  margin-top: 4px;
  padding-top: 10px;
  border-top: 1px solid var(--border-component);
}

.startup-add__title {
  font-weight: 700;
  color: var(--text-title);
  margin-bottom: 8px;
}

.startup-add__type {
  margin-bottom: 8px;
}

.startup-add__row {
  display: flex;
  gap: 10px;
  align-items: center;
}

.startup-add__select {
  flex: 1;
}

.startup-option {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.startup-option__name {
  font-weight: 700;
}

.startup-option__cmd {
  font-size: 12px;
  color: var(--text-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
