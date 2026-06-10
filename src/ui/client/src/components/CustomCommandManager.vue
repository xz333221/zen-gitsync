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
import { $t } from '@/lang/static'
import { ref, computed, watch, h, reactive, defineComponent } from 'vue'
import { ElInput, ElMessage, ElMessageBox } from 'element-plus'
import { Edit, Delete, VideoPlay, Folder, CopyDocument, Top } from '@element-plus/icons-vue'
import { useConfigStore } from '@stores/configStore'
import { useLocaleStore } from '@stores/localeStore'
import { storeToRefs } from 'pinia'
import IconButton from '@components/IconButton.vue'
import TemplateManager from '@components/TemplateManager.vue'
import { FilePickerModal as FilePicker } from 'local-file-picker/client'

export interface CustomCommand {
  id?: string
  name: string
  description?: string
  directory: string
  command: string
  params?: Array<{
    name: string
    defaultValue?: string
    required?: boolean
    description?: string
  }>
}

function buildDuplicateName(originalName: string) {
  const base = `${originalName}(copy)`
  const list = Array.isArray(commands.value) ? commands.value : []
  const exists = (name: string) => list.some((c: any) => String(c?.name || '') === name)
  if (!exists(base)) return base

  let i = 2
  while (i < 1000) {
    const next = `${originalName}(copy${i})`
    if (!exists(next)) return next
    i++
  }
  return `${base}-${Date.now()}`
}

async function duplicateCommand(command: CustomCommand) {
  try {
    const copiedParams = normalizeCommandParams(command)
    const payload: CustomCommand = {
      name: buildDuplicateName(String(command?.name || '').trim() || $t('@CMD01:命令名称')),
      description: String(command?.description || ''),
      directory: String(command?.directory || ''),
      command: String(command?.command || ''),
      params: JSON.parse(JSON.stringify(copiedParams || []))
    }

    if (!payload.directory || !payload.directory.trim()) {
      payload.directory = configStore.currentDirectory || ''
    }

    const ok = await configStore.saveCustomCommand(payload)
    if (ok) {
      // 保存成功提示由 store 统一处理
    }
  } catch (error) {
    ElMessage.error(`${$t('@CMD01:保存命令失败: ')}${(error as Error).message}`)
  }
}

export interface CustomCommandManagerEmits {
  (e: 'update:visible', value: boolean): void
  (e: 'execute-command', command: CustomCommand): void
}

const props = defineProps<{
  visible: boolean
  fullscreen?: boolean
}>()

const emit = defineEmits<CustomCommandManagerEmits>()

const configStore = useConfigStore()
const { currentLocale } = storeToRefs(useLocaleStore())

const commandTemplates = computed(() => (configStore as any).commandTemplates || [])
const commandTemplateDialogVisible = ref(false)

function queryCommandTemplates(queryString: string, callback: (suggestions: any[]) => void) {
  const list = Array.isArray(commandTemplates.value) ? commandTemplates.value : []

  const templateResults = queryString
    ? list
        .filter((template: string) => template.toLowerCase().includes(queryString.toLowerCase()))
        .map((template: string) => ({ value: template }))
    : list.map((template: string) => ({ value: template }))

  const results = [...templateResults, { value: '⚙️ 管理模板...', isSettings: true }]
  callback(results)
}

function handleCommandSelect(item: { value: string; isSettings?: boolean }) {
  if (item.isSettings) {
    commandTemplateDialogVisible.value = true
    newCommand.value.command = ''
    return
  }
  newCommand.value.command = item.value
}

function extractTemplateVariables(command: string): string[] {
  const vars: string[] = []
  const re = /{{\s*([a-zA-Z0-9_]+)\s*}}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(command))) {
    const key = String(m[1] || '').trim()
    if (key && !vars.includes(key)) vars.push(key)
  }
  return vars
}

function applyTemplateVariables(command: string, values: Record<string, string>): string {
  return command.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, p1) => {
    const key = String(p1 || '').trim()
    return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key] ?? '') : ''
  })
}

const CmdParamForm = defineComponent({
  name: 'CmdParamForm',
  props: {
    vars: { type: Array as any, required: true },
    values: { type: Object as any, required: true },
    params: { type: Array as any, required: false }
  },
  setup(props) {
    function getParamDesc(name: string) {
      const arr = Array.isArray((props as any).params) ? ((props as any).params as any[]) : []
      const found = arr.find((p) => String(p?.name || '') === name)
      return found ? String(found?.description || '').trim() : ''
    }

    return () =>
      h(
        'div',
        { class: 'cmd-param-form' },
        (props.vars as string[]).map((v) =>
          h('div', { class: 'cmd-param-row' }, [
            h('div', { class: 'cmd-param-label' }, v),
            h(ElInput, {
              modelValue: (props.values as any)[v],
              'onUpdate:modelValue': (val: any) => {
                ;(props.values as any)[v] = String(val ?? '')
              },
              placeholder: $t('@CMD01:请输入变量值', { var: v }),
              clearable: true
            }),
            getParamDesc(v) ? h('div', { class: 'cmd-param-desc' }, getParamDesc(v)) : null
          ])
        )
      )
  }
})

function normalizeCommandParams(command: CustomCommand) {
  const raw = String(command?.command || '')
  const vars = extractTemplateVariables(raw)
  const existing = Array.isArray(command?.params) ? command.params : []
  const map = new Map<string, any>()
  for (const p of existing) {
    const key = String((p as any)?.name || '').trim()
    if (!key) continue
    map.set(key, {
      name: key,
      defaultValue: String((p as any)?.defaultValue ?? ''),
      required: Boolean((p as any)?.required),
      description: String((p as any)?.description ?? '')
    })
  }

  return vars.map((v) => {
    if (map.has(v)) return map.get(v)
    return {
      name: v,
      defaultValue: '',
      required: false,
      description: ''
    }
  })
}

// 组件内部状态
const newCommand = ref<CustomCommand>({
  name: '',
  description: '',
  directory: '',
  command: '',
  params: []
})
const isEditing = ref(false)
const editingId = ref<string>('')
const isSaving = ref(false)

// 计算属性：获取自定义命令列表
const commands = computed(() => configStore.customCommands || [])

// 显示/隐藏弹窗
const dialogVisible = computed({
  get: () => props.visible,
  set: (value) => emit('update:visible', value)
})

// 监听弹窗关闭，重置状态
watch(dialogVisible, (newVal) => {
  if (!newVal) {
    resetForm()
  }
})

// 重置表单
function resetForm() {
  newCommand.value = {
    name: '',
    description: '',
    directory: '',
    command: '',
    params: []
  }
  isEditing.value = false
  editingId.value = ''
}

watch(
  () => newCommand.value.command,
  (cmd) => {
    const raw = String(cmd || '')
    const vars = extractTemplateVariables(raw)
    if (!vars.length) {
      newCommand.value.params = []
      return
    }
    const cur = Array.isArray(newCommand.value.params) ? newCommand.value.params : []
    const map = new Map(cur.map((p) => [String((p as any)?.name || ''), p]))
    newCommand.value.params = vars.map((v) => {
      const old = map.get(v)
      return {
        name: v,
        defaultValue: old ? String((old as any).defaultValue ?? '') : '',
        required: old ? Boolean((old as any).required) : false,
        description: old ? String((old as any).description ?? '') : ''
      }
    })
  },
  { immediate: true }
)

// 保存命令
async function saveCommand() {
  if (!newCommand.value.name.trim()) {
    ElMessage.warning($t('@CMD01:命令名称不能为空'))
    return
  }
  if (!newCommand.value.command.trim()) {
    ElMessage.warning($t('@CMD01:命令内容不能为空'))
    return
  }

  try {
    isSaving.value = true
    if (isEditing.value) {
      // 更新命令
      const success = await configStore.updateCustomCommand(editingId.value, newCommand.value)
      if (success) {
        resetForm()
      }
    } else {
      // 新增命令 - 如果执行目录为空，自动填充当前目录
      if (!newCommand.value.directory || !newCommand.value.directory.trim()) {
        newCommand.value.directory = configStore.currentDirectory || ''
      }
      const success = await configStore.saveCustomCommand(newCommand.value)
      if (success) {
        resetForm()
      }
    }
  } catch (error) {
    ElMessage.error(`${$t('@CMD01:命令保存失败: ')}${(error as Error).message}`)
  } finally {
    isSaving.value = false
  }
}

// 开始编辑命令
function startEditCommand(command: CustomCommand) {
  isEditing.value = true
  editingId.value = command.id || ''
  newCommand.value = {
    name: command.name,
    description: command.description || '',
    directory: command.directory,
    command: command.command,
    params: normalizeCommandParams(command)
  }
}

// 取消编辑
function cancelEdit() {
  resetForm()
}

// 删除命令
async function deleteCommand(id: string) {
  try {
    await ElMessageBox.confirm(
      $t('@CMD01:确定要删除这个自定义命令吗？'),
      $t('@CMD01:删除确认'),
      {
        confirmButtonText: $t('@CMD01:确定'),
        cancelButtonText: $t('@CMD01:取消'),
        type: 'warning',
        customClass: 'cmd-confirm-box'
      }
    )
    await configStore.deleteCustomCommand(id)
  } catch (error) {
    // 用户取消删除
  }
}

// 置顶命令
async function pinCommandToTop(id: string) {
  await configStore.pinCustomCommand(id)
}

// 执行命令
async function executeCommand(command: CustomCommand) {
  const raw = String(command?.command || '')
  const vars = extractTemplateVariables(raw)

  if (!vars.length) {
    emit('execute-command', command)
    return
  }

  const values = reactive<Record<string, string>>({})
  try {
    const params = normalizeCommandParams(command)
    const map = new Map(params.map((p) => [String(p.name), p]))
    for (const v of vars) {
      const p = map.get(v)
      values[v] = p ? String((p as any).defaultValue ?? '') : ''
    }

    await ElMessageBox({
      title: $t('@CMD01:执行参数'),
      message: h(CmdParamForm, { vars, values, params }),
      showCancelButton: true,
      confirmButtonText: $t('@CMD01:确定'),
      cancelButtonText: $t('@CMD01:取消'),
      closeOnClickModal: false,
      customClass: 'cmd-param-message-box'
    })

    const requiredList = (Array.isArray(command?.params) ? command.params : [])
      .map((p) => ({
        name: String((p as any)?.name || '').trim(),
        required: Boolean((p as any)?.required)
      }))
      .filter((p) => p.name)

    for (const p of requiredList) {
      if (!p.required) continue
      const v = values[p.name]
      if (v === undefined || v === null || String(v).trim() === '') {
        ElMessage.warning($t('@CMD01:请输入必填变量: ', { var: p.name }))
        return
      }
    }

    const resolved = applyTemplateVariables(raw, values)
    emit('execute-command', { ...command, command: resolved })
  } catch {
    // 用户取消
  }
}

// 浏览目录弹窗状态
const isBrowserDialogVisible = ref(false)

// 打开目录浏览器
function browseDirectory() {
  isBrowserDialogVisible.value = true
}

// 目录浏览器选定回调
function onBrowserSelect(path: string) {
  newCommand.value.directory = path
}

// 使用当前目录
function useCurrentDirectory() {
  newCommand.value.directory = configStore.currentDirectory || ''
}

// ── 多选 & 批量删除 ──────────────────────────────────────────
const commandTableRef = ref<any>(null)
const selectedCommands = ref<CustomCommand[]>([])

function onSelectionChange(selection: CustomCommand[]) {
  selectedCommands.value = selection
}

async function batchDeleteCommands() {
  const toDelete = [...selectedCommands.value]
  const count = toDelete.length
  if (!count) return
  try {
    await ElMessageBox.confirm(
      $t('@CMD01:确定要删除所选命令吗', { count }),
      $t('@CMD01:删除确认'),
      {
        confirmButtonText: $t('@CMD01:确定'),
        cancelButtonText: $t('@CMD01:取消'),
        type: 'warning',
        customClass: 'cmd-confirm-box'
      }
    )
    let deletedCount = 0
    for (const cmd of toDelete) {
      if (!cmd.id) continue
      const response = await fetch('/api/config/delete-custom-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: cmd.id })
      })
      const result = await response.json()
      if (result.success) deletedCount++
    }
    await configStore.loadConfig(true)
    selectedCommands.value = []
    ElMessage.success($t('@CMD01:批量删除成功', { count: deletedCount }))
  } catch {
    // 用户取消
  }
}

// ── 同步NPM命令（带选择弹窗）───────────────────────────────────
interface NpmScriptItem {
  key: string
  label: string
  packageName: string
  packagePath: string
  scriptName: string
  isDuplicate: boolean
}

const npmDialogVisible = ref(false)
const npmScriptItems = ref<NpmScriptItem[]>([])
const npmSelected = ref<NpmScriptItem[]>([])
const npmTableRef = ref<any>(null)
const isLoadingNpm = ref(false)
const isDoingSyncNpm = ref(false)

async function syncNpmCommands() {
  try {
    isLoadingNpm.value = true
    npmDialogVisible.value = true
    npmScriptItems.value = []
    npmSelected.value = []

    const response = await fetch('/api/scan-npm-scripts')
    const result = await response.json()

    if (!result.success) {
      ElMessage.error(`${$t('@CMD01:NPM命令同步失败: ')}${result.error || ''}`)
      npmDialogVisible.value = false
      return
    }

    const packages = result.packages || []
    if (packages.length === 0) {
      ElMessage.warning($t('@CMD01:未找到任何NPM脚本'))
      npmDialogVisible.value = false
      return
    }

    const existingNames = new Set(
      (Array.isArray(commands.value) ? commands.value : []).map((c: any) =>
        String(c?.name || '').trim()
      )
    )

    const items: NpmScriptItem[] = []
    for (const pkg of packages) {
      const scripts: Record<string, string> = pkg.scripts || {}
      for (const scriptName of Object.keys(scripts)) {
        const cmdName = `${pkg.name}: ${scriptName}`
        items.push({
          key: cmdName,
          label: cmdName,
          packageName: pkg.name,
          packagePath: pkg.path,
          scriptName,
          isDuplicate: existingNames.has(cmdName)
        })
      }
    }
    npmScriptItems.value = items
  } catch (error) {
    ElMessage.error(`${$t('@CMD01:NPM命令同步失败: ')}${(error as Error).message}`)
    npmDialogVisible.value = false
  } finally {
    isLoadingNpm.value = false
  }
}

function onNpmSelectionChange(selection: NpmScriptItem[]) {
  npmSelected.value = selection
}

async function doSyncSelectedNpm() {
  if (!npmSelected.value.length) {
    ElMessage.warning($t('@CMD01:请至少选择一项'))
    return
  }
  try {
    isDoingSyncNpm.value = true
    const existingNames = new Set(
      (Array.isArray(commands.value) ? commands.value : []).map((c: any) =>
        String(c?.name || '').trim()
      )
    )
    let addedCount = 0
    let skippedCount = 0
    for (const item of npmSelected.value) {
      if (existingNames.has(item.key)) {
        skippedCount++
        continue
      }
      const ok = await configStore.saveCustomCommand({
        name: item.key,
        description: `npm run ${item.scriptName}`,
        directory: item.packagePath,
        command: `npm run ${item.scriptName}`
      })
      if (ok) {
        existingNames.add(item.key)
        addedCount++
      }
    }
    ElMessage.success($t('@CMD01:NPM命令同步完成2', { count: addedCount, skip: skippedCount }))
    npmDialogVisible.value = false
    npmSelected.value = []
  } catch (error) {
    ElMessage.error(`${$t('@CMD01:NPM命令同步失败: ')}${(error as Error).message}`)
  } finally {
    isDoingSyncNpm.value = false
  }
}

// 暴露方法给父组件
defineExpose({
  resetForm
})
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    :title="$t('@CMD01:自定义命令管理')"
    :close-on-click-modal="false"
    :append-to-body="true"
    :modal-append-to-body="true"
    :fullscreen="!!fullscreen"
    :width="fullscreen ? '100vw' : '90%'"
    :top="fullscreen ? '0' : '50px'"
    :z-index="3000000"
    modal-class="custom-command-overlay"
    class="custom-command-dialog"
  >
    <div class="command-container">
      <div class="left-panel">
        <div class="command-form">
          <div class="form-header">
            <div class="left-title">
              {{ isEditing ? $t('@CMD01:编辑命令') : $t('@CMD01:添加命令') }}
            </div>
          </div>
          <div class="form-content">
              <!-- 命令名称 -->
              <div class="form-row">
                <div class="form-field">
                  <label class="required">{{ $t('@CMD01:命令名称') }}</label>
                  <el-input 
                    v-model="newCommand.name" 
                    :placeholder="$t('@CMD01:输入命令名称，例如: 拉取代码')"
                    clearable
                    size="large"
                  />
                </div>
              </div>
              
              <!-- 描述 -->
              <div class="form-row">
                  <div class="form-field">
                  <label>{{ $t('@CMD01:描述') }}</label>
                  <el-input 
                    v-model="newCommand.description" 
                    :placeholder="$t('@CMD01:可选，简要描述命令用途')"
                    clearable
                    size="large"
                  />
                </div>
              </div>

              <!-- 执行目录 -->
              <div class="form-row">
                <div class="form-field">
                  <label>{{ $t('@CMD01:执行目录') }}</label>
                  <div class="directory-input-group">
                    <el-input 
                      v-model="newCommand.directory" 
                      :placeholder="$t('@CMD01:留空使用当前目录')"
                      clearable
                      size="large"
                    />
                    <el-button @click="useCurrentDirectory" type="primary" plain size="default">
                      {{ $t('@CMD01:使用当前目录') }}
                    </el-button>
                    <el-button @click="browseDirectory" type="info" plain size="default">
                      <el-icon><Folder /></el-icon>
                      {{ $t('@CMD01:选择目录') }}
                    </el-button>
                  </div>
                </div>
              </div>
              <!-- 命令 -->
              <div class="form-row">
                <div class="form-field">
                  <label class="required">{{ $t('@CMD01:命令') }}</label>
                  <el-autocomplete
                    v-model="newCommand.command"
                    :fetch-suggestions="queryCommandTemplates"
                    :placeholder="$t('@CMD01:输入要执行的命令，例如: npm run build')"
                    clearable
                    size="large"
                    trigger-on-focus
                    popper-class="custom-command-popper"
                    @select="handleCommandSelect"
                    @keyup.enter="saveCommand"
                    style="width: 100%"
                  />

                  <div v-if="newCommand.params && newCommand.params.length > 0" class="command-params">
                    <div class="params-title">{{ $t('@CMD01:变量配置') }}</div>
                    <el-table :data="newCommand.params" style="width: 100%" size="small" stripe>
                      <el-table-column prop="name" :label="$t('@CMD01:变量名')" width="160" />
                      <el-table-column :label="$t('@CMD01:默认值')" min-width="180">
                        <template #default="scope">
                          <el-input
                            v-model="scope.row.defaultValue"
                            size="small"
                            clearable
                            :placeholder="$t('@CMD01:默认值')"
                          />
                        </template>
                      </el-table-column>
                      <el-table-column :label="$t('@CMD01:必填')" width="90" align="center">
                        <template #default="scope">
                          <el-switch v-model="scope.row.required" />
                        </template>
                      </el-table-column>
                      <el-table-column :label="$t('@CMD01:描述')" min-width="220">
                        <template #default="scope">
                          <el-input
                            v-model="scope.row.description"
                            size="small"
                            clearable
                            :placeholder="$t('@CMD01:描述')"
                          />
                        </template>
                      </el-table-column>
                    </el-table>
                  </div>
                </div>
              </div>

              <!-- 按钮区域 -->
              <div class="form-actions">
                <el-button v-if="isEditing" @click="cancelEdit" size="large">{{ $t('@CMD01:取消') }}</el-button>
                <el-button
                  type="primary"
                  @click="saveCommand"
                  :disabled="!newCommand.name.trim() || !newCommand.command.trim() || isSaving"
                  :loading="isSaving"
                  size="large"
                  class="save-btn"
                >
                  {{ isEditing ? $t('@CMD01:更新命令') : $t('@CMD01:添加命令') }}
                </el-button>
              </div>
          </div>
        </div>
      </div>

      <div class="right-panel">
        <!-- 命令列表 -->
        <div class="command-list">
          <div class="list-header">
            <div class="list-header-left">
              <h3 class="list-title">{{ $t('@CMD01:已保存的命令') }}</h3>
              <span v-if="selectedCommands.length > 0" class="selection-count">
                {{ $t('@CMD01:已选择', { count: selectedCommands.length }) }}
              </span>
            </div>
            <div class="list-header-actions">
              <el-button
                v-if="selectedCommands.length > 0"
                type="danger"
                plain
                size="small"
                @click="batchDeleteCommands"
              >
                {{ $t('@CMD01:批量删除') }}
              </el-button>
              <el-button
                type="primary"
                plain
                size="small"
                :loading="isLoadingNpm"
                @click="syncNpmCommands"
              >
                {{ $t('@CMD01:同步NPM命令') }}
              </el-button>
            </div>
          </div>
          <div class="list-content">
            <el-empty v-if="commands.length === 0" :description="$t('@CMD01:暂无保存的命令')" />
            <div v-else class="command-list-scroll">
            <el-table
              ref="commandTableRef"
              :data="commands"
              style="width: 100%;height: 100%;"
              stripe
              @selection-change="onSelectionChange"
            >
              <el-table-column type="selection" width="40" />
              <el-table-column prop="name" :label="$t('@CMD01:命令名称')" min-width="80">
                <template #default="scope">
                  <div class="name-cell">
                    <span class="name-text">{{ scope.row.name }}</span>
                    <span v-if="scope.row.description" class="description-text">{{ scope.row.description }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column prop="command" :label="$t('@CMD01:命令')" min-width="200">
                <template #default="scope">
                  <code class="command-text">{{ scope.row.command }}</code>
                </template>
              </el-table-column>
              <el-table-column prop="directory" :label="$t('@CMD01:执行目录')" min-width="200">
                <template #default="scope">
                  <span class="directory-text">{{ scope.row.directory }}</span>
                </template>
              </el-table-column>
              <el-table-column :label="$t('@CMD01:操作')" width="138" fixed="right">
                <template #default="scope">
                  <div class="action-buttons">
                    <IconButton
                      :tooltip="$t('@CMD01:置顶')"
                      size="small"
                      hover-color="var(--color-info)"
                      @click="pinCommandToTop(scope.row.id)"
                    >
                      <el-icon><Top /></el-icon>
                    </IconButton>
                    <IconButton
                      :tooltip="$t('@CMD01:执行命令')"
                      size="small"
                      hover-color="var(--color-success)"
                      @click="executeCommand(scope.row)"
                    >
                      <el-icon><VideoPlay /></el-icon>
                    </IconButton>
                    <IconButton
                      :tooltip="$t('@CMD01:编辑')"
                      size="small"
                      hover-color="var(--color-primary)"
                      @click="startEditCommand(scope.row)"
                    >
                      <el-icon><Edit /></el-icon>
                    </IconButton>
                    <IconButton
                      :tooltip="$t('@CMD01:复制命令')"
                      size="small"
                      hover-color="var(--color-warning)"
                      @click="duplicateCommand(scope.row)"
                    >
                      <el-icon><CopyDocument /></el-icon>
                    </IconButton>
                    <IconButton
                      :tooltip="$t('@CMD01:删除')"
                      size="small"
                      hover-color="var(--color-danger)"
                      @click="deleteCommand(scope.row.id)"
                    >
                      <el-icon><Delete /></el-icon>
                    </IconButton>
                  </div>
                </template>
              </el-table-column>
            </el-table>
          </div>
          </div>
        </div>
      </div>
    </div>
  </el-dialog>

  <TemplateManager
    v-model:visible="commandTemplateDialogVisible"
    type="command"
    :title="$t('@CMD01:命令模板管理')"
    :placeholder="$t('@CMD01:输入命令模板，例如: npm run build')"
    :edit-placeholder="$t('@CMD01:编辑命令模板')"
    :empty-description="$t('@CMD01:暂无保存的命令模板')"
  />

  <!-- 目录浏览器弹窗 -->
  <FilePicker
    :visible="isBrowserDialogVisible"
    :locale="currentLocale"
    @close="isBrowserDialogVisible = false"
    @confirm="(paths: string[]) => { onBrowserSelect(paths[0]); isBrowserDialogVisible = false }"
  />

  <!-- NPM 命令选择弹窗 -->
  <el-dialog
    v-model="npmDialogVisible"
    :title="$t('@CMD01:选择NPM命令')"
    :close-on-click-modal="false"
    :append-to-body="true"
    :modal-append-to-body="true"
    width="680px"
    :z-index="3000010"
    modal-class="npm-sync-overlay"
    class="npm-sync-dialog"
  >
    <div v-loading="isLoadingNpm" class="npm-dialog-body">
      <el-table
        ref="npmTableRef"
        :data="npmScriptItems"
        style="width: 100%"
        max-height="420"
        stripe
        @selection-change="onNpmSelectionChange"
      >
        <el-table-column type="selection" width="44" :selectable="() => true" />
        <el-table-column prop="packageName" :label="$t('@CMD01:包名')" min-width="140" />
        <el-table-column prop="scriptName" :label="$t('@CMD01:脚本名')" min-width="120" />
        <el-table-column prop="scriptName" :label="$t('@CMD01:命令')" min-width="160">
          <template #default="scope">
            <code class="command-text">npm run {{ scope.row.scriptName }}</code>
          </template>
        </el-table-column>
        <el-table-column :label="$t('@CMD01:状态')" width="80" align="center">
          <template #default="scope">
            <el-tag v-if="scope.row.isDuplicate" type="warning" size="small">{{ $t('@CMD01:已存在') }}</el-tag>
            <el-tag v-else type="success" size="small">{{ $t('@CMD01:新增') }}</el-tag>
          </template>
        </el-table-column>
      </el-table>
    </div>
    <template #footer>
      <div class="npm-dialog-footer">
        <span class="npm-selected-count">{{ $t('@CMD01:已选择', { count: npmSelected.length }) }}</span>
        <el-button @click="npmDialogVisible = false">{{ $t('@CMD01:取消') }}</el-button>
        <el-button
          type="primary"
          :loading="isDoingSyncNpm"
          :disabled="npmSelected.length === 0"
          @click="doSyncSelectedNpm"
        >
          {{ $t('@CMD01:开始同步') }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped lang="scss">
.command-container {
  display: flex;
  flex-direction: row;
  gap: var(--spacing-lg);
  height: 100%;
  min-height: 0;
}

:deep(.custom-command-dialog .el-dialog__body) {
  overflow: hidden;
}

.left-panel,
.right-panel {
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.left-panel {
  flex: 0 0 460px;
  overflow-y: auto;
}

.right-panel {
  flex: 1 1 auto;
  overflow: hidden;
}

.command-form {
  background: var(--bg-panel);
  border: 1px solid var(--border-component);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.command-list {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
  background: var(--bg-panel);
  border: 1px solid var(--border-component);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
}

.form-header,
.list-header {
  padding: var(--spacing-md) var(--spacing-lg);
  background: var(--bg-component-area);
  border-bottom: 1px solid var(--border-component);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.list-header-left {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
}

.list-header-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
}

.selection-count {
  font-size: var(--font-size-sm);
  color: var(--color-primary);
  font-weight: 500;
}

.form-content {
  padding: var(--spacing-lg);
  flex: 1;
  overflow-y: auto;
}

.list-content {
  padding: var(--spacing-lg); // 保持原有内边距
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}

.command-list h3 {
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: 600;
  color: var(--text-title);
}

.left-title {
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: 600;
  color: var(--text-title);
}

.form-row {
  margin-bottom: 32px;

  &:last-of-type {
    margin-bottom: 0;
  }
  
  &.form-row-compact {
    display: flex;
    gap: var(--spacing-lg); // 增加列间距
  }
}

.form-field {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 10px; // 增加标签和输入框的间距

  label {
    display: block;
    font-size: var(--font-size-sm); // 从 md 改为 sm
    font-weight: 600;
    color: var(--text-title);
    line-height: 1.2;
    
    &.required::after {
      content: '*';
      color: var(--color-danger);
      margin-left: var(--spacing-sm);
    }
  }
  
  &.form-field-half {
    flex: 1;
    min-width: 0;
  }
}

.directory-input-group {
  display: flex;
  gap: var(--spacing-base);
  align-items: center;
  flex-grow: 1;
  flex-wrap: wrap;
}

/* 按钮区域样式 */
.form-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: auto;
  padding-top: var(--spacing-lg);
  gap: var(--spacing-md);
}

.save-btn {
  width: 100%; // 如果是 isEditing 可能会有取消按钮，这里如果是单按钮则全宽
}

/* 如果有多个按钮，让主按钮占据剩余空间 */
.form-actions .el-button.save-btn {
  flex: 1;
}


.command-params {
  margin-top: var(--spacing-base);
  padding: var(--spacing-base);
  border-radius: var(--radius-lg);
  background: var(--bg-component-area);
  border: 1px solid var(--border-component);
}

.params-title {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-title);
  margin-bottom: var(--spacing-base);
}

.command-list-scroll {
  flex: 1;
  overflow-y: auto;
  border-radius: var(--radius-lg);
}

.name-cell {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.name-text {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-title);
}

.description-text {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  font-style: italic;
}

.directory-text {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  word-break: break-all;
}

.command-text {
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  color: var(--text-title);
  background: var(--bg-code);
  padding: var(--spacing-sm) var(--spacing-base);
  border-radius: var(--radius-base);
  display: inline-block;
  word-break: break-all;
}

.action-buttons {
  display: flex;
  gap: 6px;
  justify-content: center;
}

:deep(.el-table) {
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--bg-panel);
}

:deep(.el-table thead th) {
  background: var(--bg-component-area);
  color: var(--text-title);
  font-weight: 600;
}

:deep(.el-table__row:hover td) {
  background: var(--bg-component-area);
}
</style>

<!-- 全局样式：层级控制 -->
<style lang="scss">
.el-overlay.custom-command-overlay {
  z-index: 3000000 !important;
}

.el-overlay.custom-command-overlay .el-overlay-dialog {
  z-index: 3000001 !important;
}

.el-overlay.custom-command-overlay .el-dialog {
  z-index: 3000002 !important;
}

.el-popper.custom-command-popper {
  z-index: 3000003 !important;
}

.el-overlay.npm-sync-overlay {
  z-index: 3000010 !important;
}

.npm-sync-dialog .npm-dialog-body {
  min-height: 100px;
}

.npm-sync-dialog .npm-dialog-footer {
  display: flex;
  align-items: center;
  gap: 12px;
}

.npm-sync-dialog .npm-selected-count {
  flex: 1;
  font-size: 13px;
  color: var(--color-primary);
}

/* 删除确认框层级：高于主弹窗 */
.el-overlay:has(.cmd-confirm-box) {
  z-index: 3100000 !important;
}

.cmd-confirm-box {
  z-index: 3100001 !important;
}

/* 执行参数弹窗 */
.cmd-param-message-box {
  z-index: 3100001 !important;
  width: 620px;
  max-width: calc(100vw - 48px);

  .cmd-param-form {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding-top: 6px;
  }

  .cmd-param-row {
    display: grid;
    grid-template-columns: minmax(80px, 140px) 1fr;
    gap: 14px;
    align-items: center;
  }

  .cmd-param-label {
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    word-break: break-all;
  }

  .el-input__wrapper {
    min-height: 40px;
  }
}
</style>
