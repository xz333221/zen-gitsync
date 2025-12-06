import { $t } from '@/lang/static'
import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'

// 节点输出引用类型
export interface NodeOutputRef {
  nodeId: string      // 引用的节点 ID
  outputKey: string   // 输出键名（如 'stdout', 'version' 等）
}

// 编排步骤类型
export interface OrchestrationStep {
  id: string
  type: 'command' | 'wait' | 'version'
  enabled?: boolean  // 是否启用该步骤（默认 true），禁用的步骤不会执行
  useTerminal?: boolean  // 是否在新终端窗口中执行（仅对 command 类型有效）
  // 对于 command 类型
  commandId?: string  // 引用的自定义命令 ID
  commandName?: string  // 命令名称（用于显示）
  // 对于 wait 类型
  waitSeconds?: number  // 等待的秒数
  // 对于 version 类型
  versionBump?: 'patch' | 'minor' | 'major'  // 版本号增量类型
  packageJsonPath?: string  // package.json 文件路径（可选，默认当前目录）
  versionTarget?: 'version' | 'dependency'  // 修改目标：version字段还是dependency
  dependencyName?: string  // 要修改的依赖包名称
  dependencyVersion?: string  // 依赖包的新版本号（手动输入模式）
  dependencyVersionBump?: 'patch' | 'minor' | 'major'  // 依赖版本号增量类型（自动递增模式）
  dependencyType?: 'dependencies' | 'devDependencies'  // 依赖类型
  // 节点输入输出功能
  outputKey?: string  // 输出键名（用于其他节点引用此节点的输出）
  inputRef?: NodeOutputRef  // 引用其他节点的输出（当版本号模式为 'reference' 时使用）
  versionSource?: 'bump' | 'manual' | 'reference'  // 版本号来源：自动递增 / 手动输入 / 引用其他节点输出
}

export const useConfigStore = defineStore('config', () => {
  // 配置状态
  const defaultCommitMessage = ref('')
  const descriptionTemplates = ref<string[]>([])
  const scopeTemplates = ref<string[]>([])
  const messageTemplates = ref<string[]>([])
  const lockedFiles = ref<string[]>([])
  const customCommands = ref<Array<{id: string, name: string, description?: string, directory: string, command: string}>>([])
  const orchestrations = ref<Array<{id: string, name: string, description?: string, steps: OrchestrationStep[]}>>([])
  const isLoading = ref(false)
  const isLoaded = ref(false)
  // 当前工作目录
  const currentDirectory = ref('')
  // Push完成后自动关闭进度弹窗（从localStorage加载，默认true）
  const autoClosePushModal = ref(true)
  // 自动设置默认提交信息（从localStorage加载，默认false）
  const autoSetDefaultMessage = ref(false)

  // 设置当前目录
  function setCurrentDirectory(dir: string) {
    currentDirectory.value = dir || ''
  }

  // 初始化：从localStorage加载autoClosePushModal配置
  const savedAutoClosePushModal = localStorage.getItem('zen-gitsync-auto-close-push-modal')
  if (savedAutoClosePushModal !== null) {
    autoClosePushModal.value = savedAutoClosePushModal === 'true'
  }

  // 监听autoClosePushModal变化，自动保存到localStorage
  watch(autoClosePushModal, (newValue) => {
    localStorage.setItem('zen-gitsync-auto-close-push-modal', newValue.toString())
  })

  // 初始化：从localStorage加载autoSetDefaultMessage配置
  const savedAutoSetDefaultMessage = localStorage.getItem('zen-gitsync-auto-set-default-message')
  if (savedAutoSetDefaultMessage !== null) {
    autoSetDefaultMessage.value = savedAutoSetDefaultMessage === 'true'
  }

  // 监听autoSetDefaultMessage变化，自动保存到localStorage
  watch(autoSetDefaultMessage, (newValue) => {
    localStorage.setItem('zen-gitsync-auto-set-default-message', newValue.toString())
  })

  // 添加 computed 属性返回完整配置
  const config = computed(() => {
    return {
      defaultCommitMessage: defaultCommitMessage.value,
      descriptionTemplates: descriptionTemplates.value,
      scopeTemplates: scopeTemplates.value,
      messageTemplates: messageTemplates.value,
      lockedFiles: lockedFiles.value,
      customCommands: customCommands.value,
      orchestrations: orchestrations.value,
      currentDirectory: currentDirectory.value
    }
  })

  // 加载配置（可强制刷新）
  async function loadConfig(force = false) {
    // 如果已经加载过且未强制刷新，则不再重复加载
    if (!force && isLoaded.value && !isLoading.value) {
      console.log($t('@D50BB:使用缓存的配置信息'))
      return config.value
    }

    isLoading.value = true
    try {
      isLoading.value = true
      console.log($t('@D50BB:加载配置信息...'))
      const response = await fetch('/api/config/getConfig')
      const configData = await response.json()
      
      // 更新状态
      defaultCommitMessage.value = configData.defaultCommitMessage || ''
      descriptionTemplates.value = configData.descriptionTemplates || []
      scopeTemplates.value = configData.scopeTemplates || []
      messageTemplates.value = configData.messageTemplates || []
      lockedFiles.value = configData.lockedFiles || []
      customCommands.value = configData.customCommands || []
      orchestrations.value = configData.orchestrations || []
      // 若后端返回当前目录，更新
      if (configData.currentDirectory) {
        currentDirectory.value = configData.currentDirectory
      }
      
      // 标记为已加载
      isLoaded.value = true
      
      console.log($t('@D50BB:配置信息加载完成'))
      return config.value
    } catch (error) {
      console.error('加载配置失败:', error)
      ElMessage.error(`${$t('@D50BB:加载配置失败: ')}${(error as Error).message}`)
      return null
    } finally {
      isLoading.value = false
    }
  }

  // 保存默认提交信息
  async function saveDefaultMessage(message: string) {
    try {
      const response = await fetch('/api/config/saveDefaultMessage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ defaultCommitMessage: message })
      })
      
      const result = await response.json()
      if (result.success) {
        defaultCommitMessage.value = message
        ElMessage.success($t('@D50BB:默认提交信息已保存'))
        return true
      } else {
        ElMessage.error(`${$t('@D50BB:保存失败: ')}${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`${$t('@D50BB:保存失败: ')}${(error as Error).message}`)
      return false
    }
  }

  // 保存模板
  async function saveTemplate(template: string, type: 'description' | 'scope' | 'message') {
    try {
      const response = await fetch('/api/config/save-template', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ template, type })
      })
      
      const result = await response.json()
      if (result.success) {
        // 更新本地模板列表
        if (type === 'description') {
          if (!descriptionTemplates.value.includes(template)) {
            descriptionTemplates.value.push(template)
          }
        } else if (type === 'scope') {
          if (!scopeTemplates.value.includes(template)) {
            scopeTemplates.value.push(template)
          }
        } else if (type === 'message') {
          if (!messageTemplates.value.includes(template)) {
            messageTemplates.value.push(template)
          }
        }
        
        ElMessage.success($t('@D50BB:模板已保存'))
        return true
      } else {
        ElMessage.error(`${$t('@D50BB:保存模板失败: ')}${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`${$t('@D50BB:保存模板失败: ')}${(error as Error).message}`)
      return false
    }
  }

  // 删除模板
  async function deleteTemplate(template: string, type: 'description' | 'scope' | 'message') {
    try {
      const response = await fetch('/api/config/delete-template', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ template, type })
      })
      
      const result = await response.json()
      if (result.success) {
        // 更新本地模板列表
        if (type === 'description') {
          descriptionTemplates.value = descriptionTemplates.value.filter(t => t !== template)
        } else if (type === 'scope') {
          scopeTemplates.value = scopeTemplates.value.filter(t => t !== template)
        } else if (type === 'message') {
          messageTemplates.value = messageTemplates.value.filter(t => t !== template)
        }
        
        ElMessage.success($t('@D50BB:模板已删除'))
        return true
      } else {
        ElMessage.error(`${$t('@D50BB:删除模板失败: ')}${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`${$t('@D50BB:删除模板失败: ')}${(error as Error).message}`)
      return false
    }
  }

  // 更新模板
  async function updateTemplate(oldTemplate: string, newTemplate: string, type: 'description' | 'scope' | 'message') {
    try {
      const response = await fetch('/api/config/update-template', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ oldTemplate, newTemplate, type })
      })
      
      const result = await response.json()
      if (result.success) {
        // 更新本地模板列表
        if (type === 'description') {
          const index = descriptionTemplates.value.indexOf(oldTemplate)
          if (index !== -1) {
            descriptionTemplates.value[index] = newTemplate
          }
        } else if (type === 'scope') {
          const index = scopeTemplates.value.indexOf(oldTemplate)
          if (index !== -1) {
            scopeTemplates.value[index] = newTemplate
          }
        } else if (type === 'message') {
          const index = messageTemplates.value.indexOf(oldTemplate)
          if (index !== -1) {
            messageTemplates.value[index] = newTemplate
          }
        }
        
        ElMessage.success($t('@D50BB:模板已更新'))
        return true
      } else {
        ElMessage.error(`${$t('@D50BB:更新模板失败: ')}${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`${$t('@D50BB:更新模板失败: ')}${(error as Error).message}`)
      return false
    }
  }

  // 置顶模板
  async function pinTemplate(template: string, type: 'description' | 'scope' | 'message') {
    try {
      const response = await fetch('/api/config/pin-template', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ template, type })
      })
      
      const result = await response.json()
      if (result.success) {
        // 更新本地模板列表，将置顶的模板移到第一位
        if (type === 'description') {
          descriptionTemplates.value = descriptionTemplates.value.filter(t => t !== template)
          descriptionTemplates.value.unshift(template)
        } else if (type === 'scope') {
          scopeTemplates.value = scopeTemplates.value.filter(t => t !== template)
          scopeTemplates.value.unshift(template)
        } else if (type === 'message') {
          messageTemplates.value = messageTemplates.value.filter(t => t !== template)
          messageTemplates.value.unshift(template)
        }
        
        ElMessage.success($t('@D50BB:模板已置顶'))
        return true
      } else {
        ElMessage.error(`${$t('@D50BB:置顶模板失败: ')}${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`${$t('@D50BB:置顶模板失败: ')}${(error as Error).message}`)
      return false
    }
  }

  // 锁定文件相关函数
  async function loadLockedFiles() {
    try {
      const response = await fetch('/api/locked-files')
      const result = await response.json()

      if (result.success) {
        lockedFiles.value = result.lockedFiles || []
        return result.lockedFiles
      } else {
        ElMessage.error(`${$t('@D50BB:加载锁定文件列表失败: ')}${result.error}`)
        return []
      }
    } catch (error) {
      console.error('加载锁定文件列表失败:', error)
      ElMessage.error(`${$t('@D50BB:加载锁定文件列表失败: ')}${(error as Error).message}`)
      return []
    }
  }

  async function lockFile(filePath: string) {
    try {
      const response = await fetch('/api/lock-file', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ filePath })
      })

      const result = await response.json()

      if (result.success) {
        // 重新加载锁定文件列表
        await loadLockedFiles()
        ElMessage.success(`${$t('@D50BB:文件已锁定: ')}${filePath}`)
        return true
      } else {
        ElMessage.error(`${$t('@D50BB:锁定文件失败: ')}${result.error}`)
        return false
      }
    } catch (error) {
      console.error('锁定文件失败:', error)
      ElMessage.error(`${$t('@D50BB:锁定文件失败: ')}${(error as Error).message}`)
      return false
    }
  }

  async function unlockFile(filePath: string) {
    try {
      const response = await fetch('/api/unlock-file', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ filePath })
      })

      const result = await response.json()

      if (result.success) {
        // 重新加载锁定文件列表
        await loadLockedFiles()
        ElMessage.success(`${$t('@D50BB:文件已解锁: ')}${filePath}`)
        return true
      } else {
        ElMessage.error(`${$t('@D50BB:解锁文件失败: ')}${result.error}`)
        return false
      }
    } catch (error) {
      console.error('解锁文件失败:', error)
      ElMessage.error(`${$t('@D50BB:解锁文件失败: ')}${(error as Error).message}`)
      return false
    }
  }

  async function isFileLocked(filePath: string) {
    try {
      const response = await fetch('/api/check-file-lock', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ filePath })
      })

      const result = await response.json()

      if (result.success) {
        return result.isLocked
      } else {
        console.error('检查文件锁定状态失败:', result.error)
        return false
      }
    } catch (error) {
      console.error('检查文件锁定状态失败:', error)
      return false
    }
  }

  // 自定义命令管理函数
  async function saveCustomCommand(command: { name: string; description?: string; directory: string; command: string }) {
    try {
      const response = await fetch('/api/config/save-custom-command', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ command })
      })
      
      const result = await response.json()
      if (result.success) {
        // 重新加载配置获取最新的命令列表
        await loadConfig(true)
        ElMessage.success($t('@CMD01:命令已保存'))
        return true
      } else {
        ElMessage.error(`${$t('@CMD01:保存命令失败: ')}${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`${$t('@CMD01:保存命令失败: ')}${(error as Error).message}`)
      return false
    }
  }

  async function deleteCustomCommand(id: string) {
    try {
      const response = await fetch('/api/config/delete-custom-command', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ id })
      })
      
      const result = await response.json()
      if (result.success) {
        // 重新加载配置以确保数据同步
        await loadConfig(true)
        ElMessage.success($t('@CMD01:命令已删除'))
        return true
      } else {
        ElMessage.error(`${$t('@CMD01:删除命令失败: ')}${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`${$t('@CMD01:删除命令失败: ')}${(error as Error).message}`)
      return false
    }
  }

  async function updateCustomCommand(id: string, command: { name: string; description?: string; directory: string; command: string }) {
    try {
      const response = await fetch('/api/config/update-custom-command', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ id, command })
      })
      
      const result = await response.json()
      if (result.success) {
        // 重新加载配置以确保数据同步
        await loadConfig(true)
        ElMessage.success($t('@CMD01:命令已更新'))
        return true
      } else {
        ElMessage.error(`${$t('@CMD01:更新命令失败: ')}${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`${$t('@CMD01:更新命令失败: ')}${(error as Error).message}`)
      return false
    }
  }

  // 指令编排管理函数
  async function saveOrchestration(orchestration: { name: string; description?: string; steps: OrchestrationStep[] }) {
    try {
      const response = await fetch('/api/config/save-orchestration', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ orchestration })
      })
      
      const result = await response.json()
      if (result.success) {
        await loadConfig(true)
        ElMessage.success($t('@ORCH:编排已保存'))
        return true
      } else {
        ElMessage.error(`${$t('@ORCH:保存编排失败: ')}${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`${$t('@ORCH:保存编排失败: ')}${(error as Error).message}`)
      return false
    }
  }

  async function deleteOrchestration(id: string) {
    try {
      const response = await fetch('/api/config/delete-orchestration', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ id })
      })
      
      const result = await response.json()
      if (result.success) {
        await loadConfig(true)
        ElMessage.success($t('@ORCH:编排已删除'))
        return true
      } else {
        ElMessage.error(`${$t('@ORCH:删除编排失败: ')}${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`${$t('@ORCH:删除编排失败: ')}${(error as Error).message}`)
      return false
    }
  }

  async function updateOrchestration(id: string, orchestration: { name: string; description?: string; steps: OrchestrationStep[] }) {
    try {
      const response = await fetch('/api/config/update-orchestration', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ id, orchestration })
      })
      
      const result = await response.json()
      if (result.success) {
        await loadConfig(true)
        ElMessage.success($t('@ORCH:编排已更新'))
        return true
      } else {
        ElMessage.error(`${$t('@ORCH:更新编排失败: ')}${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`${$t('@ORCH:更新编排失败: ')}${(error as Error).message}`)
      return false
    }
  }

  return {
    // 状态
    defaultCommitMessage,
    descriptionTemplates,
    scopeTemplates,
    messageTemplates,
    lockedFiles,
    customCommands,
    orchestrations,
    isLoading,
    isLoaded,
    currentDirectory,
    config,
    autoClosePushModal,
    autoSetDefaultMessage,

    // 方法
    loadConfig,
    setCurrentDirectory,
    saveTemplate,
    saveDefaultMessage,
    deleteTemplate,
    updateTemplate,
    pinTemplate,
    loadLockedFiles,
    lockFile,
    unlockFile,
    isFileLocked,
    saveCustomCommand,
    deleteCustomCommand,
    updateCustomCommand,
    saveOrchestration,
    deleteOrchestration,
    updateOrchestration
  }
}) 
