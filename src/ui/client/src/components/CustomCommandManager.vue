<script setup lang="ts">
import { $t } from '@/lang/static'
import { ref, computed, watch, h } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Edit, Delete, VideoPlay, Folder } from '@element-plus/icons-vue'
import { useConfigStore } from '@stores/configStore'
import CommonDialog from '@components/CommonDialog.vue'

export interface CustomCommand {
  id?: string
  name: string
  description?: string
  directory: string
  command: string
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

// 组件内部状态
const newCommand = ref<CustomCommand>({
  name: '',
  description: '',
  directory: '',
  command: ''
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
    command: ''
  }
  isEditing.value = false
  editingId.value = ''
}

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
      // 新增命令
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
    command: command.command
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
function executeCommand(command: CustomCommand) {
  emit('execute-command', command)
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
                      style: { fill: "#E6A23C" },
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
                    style: { fill: "#409EFF" },
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
            <el-input 
              v-model="newCommand.command" 
              :placeholder="$t('@CMD01:输入要执行的命令，例如: npm run build')"
              clearable
              size="default"
              @keyup.enter="saveCommand"
            />
          </div>
        </div>
        <!-- 按钮 -->
        <div class="form-buttons">
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
        </el-collapse-item>
      </el-collapse>

      <!-- 命令列表 -->
      <div class="command-list">
        <h3>{{ $t('@CMD01:已保存的命令') }}</h3>
        <el-empty v-if="commands.length === 0" :description="$t('@CMD01:暂无保存的命令')" />
        <div v-else class="command-list-scroll">
          <el-table :data="commands" style="width: 100%" stripe>
            <el-table-column prop="name" :label="$t('@CMD01:命令名称')" min-width="120">
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
            <el-table-column prop="directory" :label="$t('@CMD01:执行目录')" min-width="150">
              <template #default="scope">
                <span class="directory-text">{{ scope.row.directory || $t('@CMD01:当前目录') }}</span>
              </template>
            </el-table-column>
            <el-table-column :label="$t('@CMD01:操作')" width="180" fixed="right">
              <template #default="scope">
                <div class="action-buttons">
                  <el-tooltip :content="$t('@CMD01:执行命令')" placement="top">
                    <el-button 
                      type="success" 
                      size="small" 
                      :icon="VideoPlay"
                      @click="executeCommand(scope.row)"
                      circle
                    />
                  </el-tooltip>
                  <el-tooltip :content="$t('@CMD01:编辑')" placement="top">
                    <el-button 
                      type="primary" 
                      size="small" 
                      :icon="Edit"
                      @click="startEditCommand(scope.row)"
                      circle
                    />
                  </el-tooltip>
                  <el-tooltip :content="$t('@CMD01:删除')" placement="top">
                    <el-button 
                      type="danger" 
                      size="small" 
                      :icon="Delete"
                      @click="deleteCommand(scope.row.id)"
                      circle
                    />
                  </el-tooltip>
                </div>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>
    </div>
  </CommonDialog>
</template>

<style scoped lang="scss">
.command-container {
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-height: 400px;
}

.command-form {
  background: var(--bg-panel);
  border: 1px solid var(--border-component);
  border-radius: 8px;
  padding: 14px 16px;
}

.form-row {
  margin-bottom: 10px;

  &:last-of-type {
    margin-bottom: 0;
  }
  
  &.form-row-compact {
    display: flex;
    gap: 12px;
  }
}

.form-field {
  display: flex;
  align-items: center;

  label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-title);
    flex-shrink: 0;
    padding-right: 8px;
    
    &.required::after {
      content: '*';
      color: #f56c6c;
      margin-left: 4px;
    }
  }
  
  &.form-field-half {
    flex: 1;
    min-width: 0;
  }
}

.directory-input-group {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-grow: 1;
}

.form-buttons {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.command-list {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;

  h3 {
    margin: 0 0 16px 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--text-title);
    border-bottom: 1px solid var(--border-component);
    padding-bottom: 8px;
  }
}

.command-list-scroll {
  flex: 1;
  overflow-y: auto;

  &::-webkit-scrollbar {
    width: 6px;
  }

  &::-webkit-scrollbar-thumb {
    background-color: #c0c4cc;
    border-radius: 3px;
  }

  &::-webkit-scrollbar-track {
    background-color: var(--bg-panel);
  }
}

.name-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.name-text {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-title);
}

.description-text {
  font-size: 12px;
  color: var(--text-secondary);
  font-style: italic;
}

.directory-text {
  font-size: 12px;
  color: var(--text-secondary);
  word-break: break-all;
}

.command-text {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-title);
  background: var(--bg-code);
  padding: 4px 8px;
  border-radius: 4px;
  display: inline-block;
  word-break: break-all;
}

.action-buttons {
  display: flex;
  gap: 6px;
  justify-content: center;
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
    border-radius: 4px;
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
    padding: 5px 8px;
    border-radius: 3px;
    border: 1px solid var(--border-card);
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.05);
    width: 100%;
  }

  .directory-list {
    list-style: none !important;
    padding: 0;
    margin: 0;
    border: 1px solid var(--border-card);
    border-radius: 4px;
    max-height: 300px;
    overflow-y: auto;
    background-color: var(--bg-container);
    display: flex;
    flex-direction: column;
    width: 100%;
    box-sizing: border-box;
  }

  .directory-item {
    padding: 10px 12px;
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
      margin-right: 12px;
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
      font-size: 14px;
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
</style>
