<script setup lang="ts">
import { $t } from '@/lang/static'
import { ref, computed, watch, h, reactive, defineComponent } from 'vue'
import { ElInput, ElMessage, ElMessageBox } from 'element-plus'
import { Edit, Delete, VideoPlay, Folder } from '@element-plus/icons-vue'
import { useConfigStore } from '@stores/configStore'
import CommonDialog from '@components/CommonDialog.vue'
import IconButton from '@components/IconButton.vue'
import TemplateManager from '@components/TemplateManager.vue'

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

export interface CustomCommandManagerEmits {
  (e: 'update:visible', value: boolean): void
  (e: 'execute-command', command: CustomCommand): void
}

const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<CustomCommandManagerEmits>()

const configStore = useConfigStore()

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
const activeCollapse = ref<string[]>([])

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
      }
    )
    await configStore.deleteCustomCommand(id)
  } catch (error) {
    // 用户取消删除
  }
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

// 使用当前目录
function useCurrentDirectory() {
  newCommand.value.directory = configStore.currentDirectory || ''
}

// 浏览目录
async function browseDirectory() {
  try {
    const response = await fetch("/api/browse_directory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPath: newCommand.value.directory || configStore.currentDirectory,
      }),
    });
    const result = await response.json();
    if (result.success) {
      selectDirectoryDialog(result);
    } else if (result.error) {
      ElMessage.error(result.error);
    }
  } catch (error) {
    ElMessage.error(`${$t('@CMD01:浏览目录失败: ')}${(error as Error).message}`);
  }
}

// 打开目录选择弹窗
function selectDirectoryDialog(directoryData: any) {
  if (!directoryData || !directoryData.items) return;
  ElMessageBox.alert(
    h("div", { class: "directory-browser" }, [
      h("div", { class: "current-path" }, [
        h("span", { class: "path-label" }, $t('@CMD01:当前路径: ')),
        h("span", { class: "path-value" }, directoryData.path),
      ]),
      h("div", { class: "directory-list" }, [
        directoryData.parentPath
          ? h(
              "div",
              {
                class: "directory-item parent-dir",
                onClick: () => selectDirectory(directoryData.parentPath),
              },
              [
                h(
                  "span",
                  { class: "dir-icon" },
                  h(
                    "svg",
                    {
                      class: "folder-icon",
                      viewBox: "0 0 24 24",
                      width: "20",
                      height: "20",
                      style: { fill: "var(--color-warning)" },
                    },
                    [
                      h("path", {
                        d: "M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z",
                      }),
                    ]
                  )
                ),
                h("span", { class: "dir-name" }, $t('@CMD01:返回上级目录')),
              ]
            )
          : null,
        ...directoryData.items.map((item: any) =>
          h(
            "div",
            {
              class: "directory-item",
              onClick: () => selectDirectory(item.path),
            },
            [
              h(
                "span",
                { class: "dir-icon" },
                h(
                  "svg",
                  {
                    class: "folder-icon",
                    viewBox: "0 0 24 24",
                    width: "20",
                    height: "20",
                    style: { fill: "var(--color-primary)" },
                  },
                  [
                    h("path", {
                      d: "M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z",
                    }),
                  ]
                )
              ),
              h("span", { class: "dir-name" }, item.name),
            ]
          )
        ),
      ]),
    ]),
    $t('@CMD01:浏览并选择目录'),
    {
      confirmButtonText: $t('@CMD01:确定'),
      customClass: "directory-browser-dialog",
      callback: (action: string) => {
        if (action === "confirm") {
          newCommand.value.directory = directoryData.path;
        }
      },
    }
  );
}

// 选择目录后刷新对话框
async function selectDirectory(dirPath: string) {
  try {
    ElMessageBox.close();
    setTimeout(async () => {
      try {
        const response = await fetch("/api/browse_directory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ currentPath: dirPath }),
        });
        const result = await response.json();
        if (result.success) {
          selectDirectoryDialog(result);
        } else if (result.error) {
          ElMessage.error(result.error);
        }
      } catch (error) {
        ElMessage.error(`${$t('@CMD01:浏览目录失败: ')}${(error as Error).message}`);
      }
    }, 100);
  } catch (error) {
    ElMessage.error(`${$t('@CMD01:处理目录选择时出错: ')}${(error as Error).message}`);
  }
}

// 暴露方法给父组件
defineExpose({
  resetForm
})
</script>

<template>
  <CommonDialog
    v-model="dialogVisible"
    :title="$t('@CMD01:自定义命令管理')"
    :close-on-click-modal="false"
    :append-to-body="true"
    custom-class="custom-command-dialog"
    size="extra-large"
  >
    <div class="command-container">
      <!-- 添加/编辑表单 -->
      <el-collapse v-model="activeCollapse" class="command-form-collapse">
        <el-collapse-item :title="isEditing ? $t('@CMD01:编辑命令') : $t('@CMD01:添加命令')" name="addCommand">
          <div class="command-form">
            <!-- 第一行：命令名称和描述 -->
        <div class="form-row form-row-compact">
          <div class="form-field form-field-half">
            <label class="required">{{ $t('@CMD01:命令名称') }}</label>
            <el-input 
              v-model="newCommand.name" 
              :placeholder="$t('@CMD01:输入命令名称，例如: 拉取代码')"
              clearable
              size="default"
            />
          </div>
          <div class="form-field form-field-half">
            <label>{{ $t('@CMD01:描述') }}</label>
            <el-input 
              v-model="newCommand.description" 
              :placeholder="$t('@CMD01:可选，简要描述命令用途')"
              clearable
              size="default"
            />
          </div>
        </div>
        <!-- 第二行：执行目录 -->
        <div class="form-row">
          <div class="form-field">
            <label>{{ $t('@CMD01:执行目录') }}</label>
            <div class="directory-input-group">
              <el-input 
                v-model="newCommand.directory" 
                :placeholder="$t('@CMD01:留空使用当前目录')"
                clearable
                size="default"
              />
              <el-button @click="useCurrentDirectory" type="primary" plain size="small">
                {{ $t('@CMD01:使用当前目录') }}
              </el-button>
              <el-button @click="browseDirectory" type="info" plain size="small">
                <el-icon><Folder /></el-icon>
                {{ $t('@CMD01:选择目录') }}
              </el-button>
            </div>
          </div>
        </div>
        <!-- 第三行：命令 -->
        <div class="form-row">
          <div class="form-field">
            <label class="required">{{ $t('@CMD01:命令') }}</label>
            <div class="command-input-group">
              <el-autocomplete
                v-model="newCommand.command"
                :fetch-suggestions="queryCommandTemplates"
                :placeholder="$t('@CMD01:输入要执行的命令，例如: npm run build')"
                clearable
                size="default"
                trigger-on-focus
                @select="handleCommandSelect"
                @keyup.enter="saveCommand"
              />
              <div class="command-action-buttons">
                <el-button v-if="isEditing" @click="cancelEdit" size="default">{{ $t('@CMD01:取消') }}</el-button>
                <el-button
                  type="primary"
                  @click="saveCommand"
                  :disabled="!newCommand.name.trim() || !newCommand.command.trim() || isSaving"
                  :loading="isSaving"
                  size="default"
                >
                  {{ isEditing ? $t('@CMD01:更新命令') : $t('@CMD01:添加命令') }}
                </el-button>
              </div>
            </div>

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
          </div>
        </el-collapse-item>
      </el-collapse>

      <!-- 命令列表 -->
      <div class="command-list">
        <h3>{{ $t('@CMD01:已保存的命令') }}</h3>
        <el-empty v-if="commands.length === 0" :description="$t('@CMD01:暂无保存的命令')" />
        <div v-else class="command-list-scroll">
          <el-table :data="commands" style="width: 100%" stripe>
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
                <span class="directory-text">{{ scope.row.directory || $t('@CMD01:当前目录') }}</span>
              </template>
            </el-table-column>
            <el-table-column :label="$t('@CMD01:操作')" width="100" fixed="right">
              <template #default="scope">
                <div class="action-buttons">
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
  </CommonDialog>

  <TemplateManager
    v-model:visible="commandTemplateDialogVisible"
    type="command"
    :title="$t('@CMD01:命令模板管理')"
    :placeholder="$t('@CMD01:输入命令模板，例如: npm run build')"
    :edit-placeholder="$t('@CMD01:编辑命令模板')"
    :empty-description="$t('@CMD01:暂无保存的命令模板')"
  />
</template>

<style scoped lang="scss">
.command-container {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xl);
  min-height: 440px;
}

.command-form {
  background: var(--bg-panel);
  border: 1px solid var(--border-component);
  border-radius: var(--radius-lg);
  padding: var(--spacing-lg);
  box-shadow: var(--shadow-sm);
}

.form-row {
  margin-bottom: var(--spacing-lg);

  &:last-of-type {
    margin-bottom: 0;
  }
  
  &.form-row-compact {
    display: flex;
    gap: var(--spacing-md);
  }
}

.form-field {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--spacing-sm);

  label {
    display: block;
    font-size: var(--font-size-sm);
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

.command-input-group {
  display: flex;
  gap: var(--spacing-base);
  align-items: center;
  flex-grow: 1;
  flex-wrap: wrap;
}

.command-input-group :deep(.el-autocomplete) {
  flex: 1;
  min-width: 260px;
}

.command-action-buttons {
  display: flex;
  gap: var(--spacing-md);
  justify-content: flex-end;
  flex: 0 0 auto;
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

.command-list {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
  background: var(--bg-panel);
  border: 1px solid var(--border-component);
  border-radius: var(--radius-lg);
  padding: var(--spacing-lg);
  box-shadow: var(--shadow-sm);

  h3 {
    margin: 0 0 var(--spacing-lg) 0;
    font-size: var(--font-size-md);
    font-weight: 600;
    color: var(--text-title);
    padding-bottom: var(--spacing-sm);
  }
}

.command-list-scroll {
  flex: 1;
  overflow-y: auto;
  border-radius: var(--radius-lg);

  &::-webkit-scrollbar {
    width: 6px;
  }

  &::-webkit-scrollbar-thumb {
    background-color: var(--text-placeholder);
    border-radius: var(--radius-sm);
  }

  &::-webkit-scrollbar-track {
    background-color: var(--bg-panel);
  }
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

:deep(.command-form-collapse) {
  .el-collapse-item__header {
    border-radius: var(--radius-lg);
    background: var(--bg-panel);
    border: 1px solid var(--border-component);
    padding: 0 var(--spacing-lg);
    height: 44px;
    line-height: 44px;
  }

  .el-collapse-item__wrap {
    border: none;
  }
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

<!-- 添加全局样式支持目录浏览器对话框 -->
<style lang="scss">
/* 确保弹窗在全屏模式下显示在最上层 */
.custom-command-dialog {
  z-index: 3000 !important;
}

/* 目录浏览器全局样式 */
.directory-browser-dialog {
  z-index: 3001 !important;
  .directory-browser {
    width: 100%;
    height: 400px;
    overflow: auto;
  }

  .current-path {
    padding: 10px;
    background-color: var(--bg-panel);
    border-radius: var(--radius-base);
    margin-bottom: 10px;
    border: 1px solid var(--border-card);
    display: flex;
    align-items: center;
    width: 100%;
    box-sizing: border-box;
  }

  .path-label {
    font-weight: bold;
    margin-right: 5px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .path-value {
    font-family: monospace;
    word-break: break-all;
    flex: 1;
    min-width: 0;
    background-color: var(--bg-container);
    padding: 5px var(--spacing-base);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-card);
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.05);
    width: 100%;
  }

  .directory-list {
    list-style: none !important;
    padding: 0;
    margin: 0;
    border: 1px solid var(--border-card);
    border-radius: var(--radius-base);
    max-height: 300px;
    overflow-y: auto;
    background-color: var(--bg-container);
    display: flex;
    flex-direction: column;
    width: 100%;
    box-sizing: border-box;
  }

  .directory-item {
    padding: 10px var(--spacing-md);
    border-bottom: 1px solid var(--border-card);
    cursor: pointer;
    display: flex;
    align-items: center;
    transition: all 0.2s ease;
    position: relative;
    width: 100%;
    box-sizing: border-box;
    list-style: none !important;

    &:hover {
      background-color: #ecf5ff;
    }

    &:last-child {
      border-bottom: none;
    }

    .dir-icon {
      margin-right: var(--spacing-md);
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      flex-shrink: 0;
    }

    .dir-name {
      display: flex;
      align-items: center;
      
      line-height: 1.4;
    }

    .folder-icon {
      filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.1));
      transition: all 0.2s ease;
    }

    &:hover .folder-icon {
      transform: scale(1.1);
    }
  }

  .parent-dir {
    background-color: var(--bg-panel);
    font-weight: 500;
  }
}

/* 命令执行参数弹窗 */
.cmd-param-message-box {
  z-index: 3002 !important;

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
