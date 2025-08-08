import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'

export const useConfigStore = defineStore('config', () => {
  // 配置状态
  const defaultCommitMessage = ref('')
  const descriptionTemplates = ref<string[]>([])
  const scopeTemplates = ref<string[]>([])
  const messageTemplates = ref<string[]>([])
  const lockedFiles = ref<string[]>([])
  const isLoading = ref(false)
  const isLoaded = ref(false)

  // 添加 computed 属性返回完整配置
  const config = computed(() => {
    return {
      defaultCommitMessage: defaultCommitMessage.value,
      descriptionTemplates: descriptionTemplates.value,
      scopeTemplates: scopeTemplates.value,
      messageTemplates: messageTemplates.value,
      lockedFiles: lockedFiles.value
    }
  })

  // 加载配置（可强制刷新）
  async function loadConfig(force = false) {
    // 如果已经加载过且未强制刷新，则不再重复加载
    if (!force && isLoaded.value && !isLoading.value) {
      console.log('使用缓存的配置信息')
      return config.value
    }

    try {
      isLoading.value = true
      console.log('加载配置信息...')
      const response = await fetch('/api/config/getConfig')
      const configData = await response.json()
      
      // 更新状态
      defaultCommitMessage.value = configData.defaultCommitMessage || ''
      descriptionTemplates.value = configData.descriptionTemplates || []
      scopeTemplates.value = configData.scopeTemplates || []
      messageTemplates.value = configData.messageTemplates || []
      lockedFiles.value = configData.lockedFiles || []
      
      // 标记为已加载
      isLoaded.value = true
      
      console.log('配置信息加载完成')
      return config.value
    } catch (error) {
      console.error('加载配置失败:', error)
      ElMessage.error(`加载配置失败: ${(error as Error).message}`)
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
        ElMessage.success('默认提交信息已保存')
        return true
      } else {
        ElMessage.error(`保存失败: ${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`保存失败: ${(error as Error).message}`)
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
        
        ElMessage.success('模板已保存')
        return true
      } else {
        ElMessage.error(`保存模板失败: ${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`保存模板失败: ${(error as Error).message}`)
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
        
        ElMessage.success('模板已删除')
        return true
      } else {
        ElMessage.error(`删除模板失败: ${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`删除模板失败: ${(error as Error).message}`)
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
        
        ElMessage.success('模板已更新')
        return true
      } else {
        ElMessage.error(`更新模板失败: ${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`更新模板失败: ${(error as Error).message}`)
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
        ElMessage.error(`加载锁定文件列表失败: ${result.error}`)
        return []
      }
    } catch (error) {
      console.error('加载锁定文件列表失败:', error)
      ElMessage.error(`加载锁定文件列表失败: ${(error as Error).message}`)
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
        ElMessage.success(`文件已锁定: ${filePath}`)
        return true
      } else {
        ElMessage.error(`锁定文件失败: ${result.error}`)
        return false
      }
    } catch (error) {
      console.error('锁定文件失败:', error)
      ElMessage.error(`锁定文件失败: ${(error as Error).message}`)
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
        ElMessage.success(`文件已解锁: ${filePath}`)
        return true
      } else {
        ElMessage.error(`解锁文件失败: ${result.error}`)
        return false
      }
    } catch (error) {
      console.error('解锁文件失败:', error)
      ElMessage.error(`解锁文件失败: ${(error as Error).message}`)
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

  return {
    // 状态
    defaultCommitMessage,
    descriptionTemplates,
    scopeTemplates,
    messageTemplates,
    lockedFiles,
    isLoading,
    isLoaded,
    config,

    // 方法
    loadConfig,
    saveDefaultMessage,
    saveTemplate,
    deleteTemplate,
    updateTemplate,
    loadLockedFiles,
    lockFile,
    unlockFile,
    isFileLocked
  }
}) 
