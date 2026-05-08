import express from 'express';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import open from 'open';

export function registerConfigRoutes({
  app,
  configManager
}) {
  // 保存最近访问的目录
  app.post('/api/save_recent_directory', async (req, res) => {
      try {
          const { path } = req.body;
          
          if (!path) {
              return res.status(400).json({ 
                  success: false, 
                  error: '目录路径不能为空' 
              });
          }
          
          // 保存到配置
          await configManager.saveRecentDirectory(path);
          
          res.json({
              success: true
          });
      } catch (error) {
          res.status(500).json({ 
              success: false,
              error: error.message 
          });
      }
  });

  // 删除最近访问的目录
  app.post('/api/remove_recent_directory', async (req, res) => {
    try {
      const { path: dirPath } = req.body;
      if (!dirPath) {
        return res.status(400).json({ success: false, error: '目录路径不能为空' });
      }
      const list = await configManager.removeRecentDirectory(dirPath);
      res.json({ success: true, directories: list });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // 获取配置
  app.get('/api/config/getConfig', async (req, res) => {
    try {
      // console.log('获取配置中。。。')
      const config = await configManager.loadConfig()

      // 兼容旧数据：补齐自定义命令 id，避免前端编辑/删除/编排引用异常
      if (Array.isArray(config.customCommands)) {
        let changed = false
        config.customCommands = config.customCommands.map((cmd) => {
          if (cmd && typeof cmd === 'object' && !cmd.id) {
            changed = true
            return {
              ...cmd,
              id: `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
            }
          }
          return cmd
        })
        if (changed) {
          await configManager.saveConfig(config)
        }
      }

      // 初始化命令模板（首次安装/旧配置兼容）
      if (!Array.isArray(config.commandTemplates)) {
        config.commandTemplates = []
      }

      if (config.commandTemplates.length === 0) {
        config.commandTemplates = [
          'echo "{{cmd}}"',
          'npm run dev',
          'npm run build',
          'git status',
          'git add .',
          'git commit -m "{{message}}" --no-verify',
          'git push',
        ]
        await configManager.saveConfig(config)
      }

      // console.log('获取配置成功')
      res.json(config)
    } catch (error) {
      // console.log('获取配置失败')
      const configPath = path.join(os.homedir(), '.git-commit-tool.json')
      res.status(500).json({
        success: false,
        code: 'CONFIG_LOAD_FAILED',
        error: error?.message || String(error),
        configPath
      })
    }
  })
  
  // 保存默认提交信息
  app.post('/api/config/saveDefaultMessage', express.json(), async (req, res) => {
    try {
      const { defaultCommitMessage } = req.body
      
      if (!defaultCommitMessage) {
        return res.status(400).json({ success: false, error: '缺少必要参数' })
      }
      
      const config = await configManager.loadConfig()
      
      // 更新默认提交信息
      config.defaultCommitMessage = defaultCommitMessage
      await configManager.saveConfig(config)
      
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 保存所有配置
  app.post('/api/config/saveAll', express.json(), async (req, res) => {
    try {
      const { config } = req.body
      
      if (!config) {
        return res.status(400).json({ success: false, error: '缺少必要参数' })
      }
      
      await configManager.saveConfig(config)
      
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })

  // 检查系统配置文件格式
  app.get('/api/config/check-file-format', async (req, res) => {
    try {
      const configPath = path.join(os.homedir(), '.git-commit-tool.json');
      
      try {
        const data = await fs.readFile(configPath, 'utf-8');
        try {
          JSON.parse(data);
          res.json({ success: true, isValidJson: true, exists: true });
        } catch (parseError) {
          res.json({ 
            success: true, 
            isValidJson: false, 
            exists: true, 
            error: `JSON解析失败: ${parseError.message}` 
          });
        }
      } catch (fileError) {
        if (fileError.code === 'ENOENT') {
          res.json({ success: true, isValidJson: true, exists: false });
        } else {
          res.json({ 
            success: true, 
            isValidJson: false, 
            exists: true, 
            error: `文件读取失败: ${fileError.message}` 
          });
        }
      }
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  })

  // 使用系统默认程序打开配置文件 ~/.git-commit-tool.json
  app.post('/api/config/open-file', async (req, res) => {
    try {
      const filePath = path.join(os.homedir(), '.git-commit-tool.json');
      try {
        // 检查文件是否存在，不存在也尝试让系统创建（可能会打开空文件）
        await fs.access(filePath);
      } catch (_) {
        // 如果文件不存在，先创建一个最小结构，避免某些系统无法打开不存在的路径
        try {
          await fs.writeFile(filePath, '{}', 'utf-8');
        } catch (e) {
          // 创建失败不阻断打开尝试
          console.warn('创建配置文件失败(可忽略):', e?.message || e);
        }
      }

      await open(filePath, { wait: false });
      res.json({ success: true })
    } catch (error) {
      res.status(400).json({ success: false, error: `无法打开配置文件: ${error.message}` })
    }
  })
  
  // 保存模板
  app.post('/api/config/save-template', express.json(), async (req, res) => {
    try {
      const { template, type } = req.body
      
      if (!template || !type) {
        return res.status(400).json({ success: false, error: '缺少必要参数' })
      }
      
      const config = await configManager.loadConfig()
      
      if (type === 'description') {
        // 确保描述模板数组存在
        if (!config.descriptionTemplates) {
          config.descriptionTemplates = []
        }
        
        // 检查是否已存在相同模板
        if (!config.descriptionTemplates.includes(template)) {
          config.descriptionTemplates.push(template)
          await configManager.saveConfig(config)
        }
      } else if (type === 'scope') {
        // 确保作用域模板数组存在
        if (!config.scopeTemplates) {
          config.scopeTemplates = []
        }
        
        // 检查是否已存在相同模板
        if (!config.scopeTemplates.includes(template)) {
          config.scopeTemplates.push(template)
          await configManager.saveConfig(config)
        }
      } else if (type === 'message') {
        // 确保提交信息模板数组存在
        if (!config.messageTemplates) {
          config.messageTemplates = []
        }
        
        // 检查是否已存在相同模板
        if (!config.messageTemplates.includes(template)) {
          config.messageTemplates.push(template)
          await configManager.saveConfig(config)
        }
      } else if (type === 'command') {
        if (!config.commandTemplates) {
          config.commandTemplates = []
        }
        if (!config.commandTemplates.includes(template)) {
          config.commandTemplates.push(template)
          await configManager.saveConfig(config)
        }
      } else {
        return res.status(400).json({ success: false, error: '不支持的模板类型' })
      }
      
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 删除模板
  app.post('/api/config/delete-template', express.json(), async (req, res) => {
    try {
      const { template, type } = req.body
      
      if (!template || !type) {
        return res.status(400).json({ success: false, error: '缺少必要参数' })
      }
      
      const config = await configManager.loadConfig()
      
      if (type === 'description') {
        // 确保描述模板数组存在
        if (config.descriptionTemplates) {
          const index = config.descriptionTemplates.indexOf(template)
          if (index !== -1) {
            config.descriptionTemplates.splice(index, 1)
            await configManager.saveConfig(config)
          }
        }
      } else if (type === 'scope') {
        // 确保作用域模板数组存在
        if (config.scopeTemplates) {
          const index = config.scopeTemplates.indexOf(template)
          if (index !== -1) {
            config.scopeTemplates.splice(index, 1)
            await configManager.saveConfig(config)
          }
        }
      } else if (type === 'message') {
        // 确保提交信息模板数组存在
        if (config.messageTemplates) {
          const index = config.messageTemplates.indexOf(template)
          if (index !== -1) {
            config.messageTemplates.splice(index, 1)
            await configManager.saveConfig(config)
          }
        }
      } else if (type === 'command') {
        if (config.commandTemplates) {
          const index = config.commandTemplates.indexOf(template)
          if (index !== -1) {
            config.commandTemplates.splice(index, 1)
            await configManager.saveConfig(config)
          }
        }
      } else {
        return res.status(400).json({ success: false, error: '不支持的模板类型' })
      }
      
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 更新模板
  app.post('/api/config/update-template', express.json(), async (req, res) => {
    try {
      const { oldTemplate, newTemplate, type } = req.body
      
      if (!oldTemplate || !newTemplate || !type) {
        return res.status(400).json({ success: false, error: '缺少必要参数' })
      }
      
      const config = await configManager.loadConfig()
      
      if (type === 'description') {
        // 确保描述模板数组存在
        if (config.descriptionTemplates) {
          const index = config.descriptionTemplates.indexOf(oldTemplate)
          if (index !== -1) {
            config.descriptionTemplates[index] = newTemplate
            await configManager.saveConfig(config)
          } else {
            return res.status(404).json({ success: false, error: '未找到原模板' })
          }
        } else {
          return res.status(404).json({ success: false, error: '模板列表不存在' })
        }
      } else if (type === 'scope') {
        // 确保作用域模板数组存在
        if (config.scopeTemplates) {
          const index = config.scopeTemplates.indexOf(oldTemplate)
          if (index !== -1) {
            config.scopeTemplates[index] = newTemplate
            await configManager.saveConfig(config)
          } else {
            return res.status(404).json({ success: false, error: '未找到原模板' })
          }
        } else {
          return res.status(404).json({ success: false, error: '模板列表不存在' })
        }
      } else if (type === 'message') {
        // 确保提交信息模板数组存在
        if (config.messageTemplates) {
          const index = config.messageTemplates.indexOf(oldTemplate)
          if (index !== -1) {
            config.messageTemplates[index] = newTemplate
            await configManager.saveConfig(config)
          } else {
            return res.status(404).json({ success: false, error: '未找到原模板' })
          }
        } else {
          return res.status(404).json({ success: false, error: '模板列表不存在' })
        }
      } else if (type === 'command') {
        if (config.commandTemplates) {
          const index = config.commandTemplates.indexOf(oldTemplate)
          if (index !== -1) {
            config.commandTemplates[index] = newTemplate
            await configManager.saveConfig(config)
          } else {
            return res.status(404).json({ success: false, error: '未找到原模板' })
          }
        } else {
          return res.status(404).json({ success: false, error: '模板列表不存在' })
        }
      } else {
        return res.status(400).json({ success: false, error: '不支持的模板类型' })
      }
      
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 置顶模板
  app.post('/api/config/pin-template', express.json(), async (req, res) => {
    try {
      const { template, type } = req.body
      
      if (!template || !type) {
        return res.status(400).json({ success: false, error: '缺少必要参数' })
      }
      
      const config = await configManager.loadConfig()
      
      if (type === 'description') {
        if (config.descriptionTemplates) {
          // 删除原位置的模板
          config.descriptionTemplates = config.descriptionTemplates.filter(t => t !== template)
          // 添加到第一位
          config.descriptionTemplates.unshift(template)
          await configManager.saveConfig(config)
        } else {
          return res.status(404).json({ success: false, error: '模板列表不存在' })
        }
      } else if (type === 'scope') {
        if (config.scopeTemplates) {
          config.scopeTemplates = config.scopeTemplates.filter(t => t !== template)
          config.scopeTemplates.unshift(template)
          await configManager.saveConfig(config)
        } else {
          return res.status(404).json({ success: false, error: '模板列表不存在' })
        }
      } else if (type === 'message') {
        if (config.messageTemplates) {
          config.messageTemplates = config.messageTemplates.filter(t => t !== template)
          config.messageTemplates.unshift(template)
          await configManager.saveConfig(config)
        } else {
          return res.status(404).json({ success: false, error: '模板列表不存在' })
        }
      } else if (type === 'command') {
        if (config.commandTemplates) {
          config.commandTemplates = config.commandTemplates.filter(t => t !== template)
          config.commandTemplates.unshift(template)
          await configManager.saveConfig(config)
        } else {
          return res.status(404).json({ success: false, error: '模板列表不存在' })
        }
      } else {
        return res.status(400).json({ success: false, error: '不支持的模板类型' })
      }
      
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 保存自定义命令
  app.post('/api/config/save-custom-command', express.json(), async (req, res) => {
    try {
      const { command } = req.body
      
      if (!command || !command.name || !command.command) {
        return res.status(400).json({ success: false, error: '缺少必要参数' })
      }
      
      const config = await configManager.loadConfig()
      
      // 确保自定义命令数组存在
      if (!Array.isArray(config.customCommands)) {
        config.customCommands = []
      }
      
      // 生成唯一ID
      const id = `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      const newCommand = {
        id,
        name: command.name,
        description: command.description || '',
        directory: command.directory || '',
        command: command.command,
        params: Array.isArray(command.params) ? command.params : []
      }
      
      config.customCommands.push(newCommand)
      await configManager.saveConfig(config)
      
      res.json({ success: true, command: newCommand })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 删除自定义命令
  app.post('/api/config/delete-custom-command', express.json(), async (req, res) => {
    try {
      const { id } = req.body
      
      if (!id) {
        return res.status(400).json({ success: false, error: '缺少命令ID参数' })
      }
      
      const config = await configManager.loadConfig()
      
      if (Array.isArray(config.customCommands)) {
        const index = config.customCommands.findIndex(cmd => cmd.id === id)
        if (index !== -1) {
          config.customCommands.splice(index, 1)
          await configManager.saveConfig(config)
        }
      }
      
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 置顶自定义命令（移到数组首位）
  app.post('/api/config/pin-custom-command', express.json(), async (req, res) => {
    try {
      const { id } = req.body

      if (!id) {
        return res.status(400).json({ success: false, error: '缺少命令ID参数' })
      }

      const config = await configManager.loadConfig()

      if (Array.isArray(config.customCommands)) {
        const index = config.customCommands.findIndex(cmd => cmd.id === id)
        if (index > 0) {
          const [cmd] = config.customCommands.splice(index, 1)
          config.customCommands.unshift(cmd)
          await configManager.saveConfig(config)
        }
      }

      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })

  // 更新自定义命令
  app.post('/api/config/update-custom-command', express.json(), async (req, res) => {
    try {
      const { id, command } = req.body
      
      if (!id || !command || !command.name || !command.command) {
        return res.status(400).json({ success: false, error: '缺少必要参数' })
      }
      
      const config = await configManager.loadConfig()
      
      if (Array.isArray(config.customCommands)) {
        const index = config.customCommands.findIndex(cmd => cmd.id === id)
        if (index !== -1) {
          config.customCommands[index] = {
            id,
            name: command.name,
            description: command.description || '',
            directory: command.directory || '',
            command: command.command,
            params: Array.isArray(command.params) ? command.params : []
          }
          await configManager.saveConfig(config)
        } else {
          return res.status(404).json({ success: false, error: '未找到指定命令' })
        }
      } else {
        return res.status(404).json({ success: false, error: '命令列表不存在' })
      }
      
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 保存指令编排
  app.post('/api/config/save-orchestration', express.json(), async (req, res) => {
    try {
      const { orchestration } = req.body
      
    if (!orchestration || !orchestration.name) {
        return res.status(400).json({ success: false, error: '缺少必要参数' })
      }
      
      const config = await configManager.loadConfig()
      
      // 确保编排数组存在
      if (!Array.isArray(config.orchestrations)) {
        config.orchestrations = []
      }
      
      // 生成唯一ID
      const id = `orch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const newOrchestration = {
      id,
      name: orchestration.name,
      description: orchestration.description || '',
      flowData: orchestration.flowData || null
    }
      
      config.orchestrations.push(newOrchestration)
      await configManager.saveConfig(config)
      
      res.json({ success: true, orchestration: newOrchestration })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 删除指令编排
  app.post('/api/config/delete-orchestration', express.json(), async (req, res) => {
    try {
      const { id } = req.body
      
      if (!id) {
        return res.status(400).json({ success: false, error: '缺少编排ID参数' })
      }
      
      const config = await configManager.loadConfig()
      
      if (Array.isArray(config.orchestrations)) {
        const index = config.orchestrations.findIndex(orch => orch.id === id)
        if (index !== -1) {
          config.orchestrations.splice(index, 1)
          await configManager.saveConfig(config)
        }
      }
      
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 更新指令编排
  app.post('/api/config/update-orchestration', express.json(), async (req, res) => {
    try {
      const { id, orchestration } = req.body
      
    if (!id || !orchestration || !orchestration.name) {
        return res.status(400).json({ success: false, error: '缺少必要参数' })
      }
      
      const config = await configManager.loadConfig()
      
      if (Array.isArray(config.orchestrations)) {
        const index = config.orchestrations.findIndex(orch => orch.id === id)
        if (index !== -1) {
        config.orchestrations[index] = {
          id,
          name: orchestration.name,
          description: orchestration.description || '',
          flowData: orchestration.flowData || null
        }
          await configManager.saveConfig(config)
        } else {
          return res.status(404).json({ success: false, error: '未找到指定编排' })
        }
      } else {
        return res.status(404).json({ success: false, error: '编排列表不存在' })
      }
      
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 保存项目启动项
  app.post('/api/config/save-startup-items', express.json(), async (req, res) => {
    try {
      const { startupItems, startupAutoRun } = req.body
      
      if (!Array.isArray(startupItems)) {
        return res.status(400).json({ success: false, error: '启动项必须是数组' })
      }
      
      const config = await configManager.loadConfig()
      config.startupItems = startupItems
      if (typeof startupAutoRun === 'boolean') {
        config.startupAutoRun = startupAutoRun
      }
      await configManager.saveConfig(config)
      
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })

  // 保存提交设置
  app.post('/api/config/save-commit-settings', express.json(), async (req, res) => {
    try {
      const { isStandardCommit, skipHooks, autoQuickPushOnEnter, autoSetDefaultMessage, autoClosePushModal, pullBeforePush } = req.body
      const config = await configManager.loadConfig()
      if (isStandardCommit !== undefined) config.isStandardCommit = Boolean(isStandardCommit)
      if (skipHooks !== undefined) config.skipHooks = Boolean(skipHooks)
      if (autoQuickPushOnEnter !== undefined) config.autoQuickPushOnEnter = Boolean(autoQuickPushOnEnter)
      if (autoSetDefaultMessage !== undefined) config.autoSetDefaultMessage = Boolean(autoSetDefaultMessage)
      if (autoClosePushModal !== undefined) config.autoClosePushModal = Boolean(autoClosePushModal)
      if (pullBeforePush !== undefined) config.pullBeforePush = Boolean(pullBeforePush)
      await configManager.saveConfig(config)
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })

  // 保存"一键推送成功后启动项"
  app.post('/api/config/save-after-quick-push-action', express.json(), async (req, res) => {
    try {
      const { afterQuickPushAction } = req.body

      if (!afterQuickPushAction || typeof afterQuickPushAction !== 'object') {
        return res.status(400).json({ success: false, error: '缺少必要参数' })
      }

      const enabled = Boolean(afterQuickPushAction.enabled)
      const type = afterQuickPushAction.type === 'workflow' ? 'workflow' : 'command'
      const refId = String(afterQuickPushAction.refId || '').trim()

      const config = await configManager.loadConfig()
      config.afterQuickPushAction = {
        enabled,
        type,
        refId
      }
      await configManager.saveConfig(config)

      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })

  // 保存通用设置（主题和语言）
  app.post('/api/config/save-general-settings', express.json(), async (req, res) => {
    try {
      const { theme, locale } = req.body

      // 读取原始配置以保留项目设置
      const rawConfig = await configManager.readRawConfigFile()
      
      // 更新全局设置
      if (theme && ['light', 'dark', 'auto'].includes(theme)) {
        rawConfig.theme = theme
      }
      if (locale && ['zh-CN', 'en-US'].includes(locale)) {
        rawConfig.locale = locale
      }
      
      // 直接写入原始配置，避免覆盖项目设置
      await configManager.writeRawConfigFile(rawConfig)
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })

  // 保存 AI 模型配置（models 是全局配置，存在配置文件顶层，跨项目共享）
  app.post('/api/config/save-models', express.json(), async (req, res) => {
    try {
      const { models } = req.body
      if (!Array.isArray(models)) {
        return res.status(400).json({ success: false, error: '缺少 models 参数' })
      }
      const rawConfig = await configManager.readRawConfigFile()
      rawConfig.models = models
      await configManager.writeRawConfigFile(rawConfig)
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })

  // 测试 AI 模型是否可用
  app.post('/api/config/test-model', express.json(), async (req, res) => {
    const { baseURL, model, apiKey } = req.body || {}
    if (!baseURL || !model) {
      return res.status(400).json({ success: false, error: '缺少 baseURL 或 model 参数' })
    }
    try {
      const { default: fetch } = await import('node-fetch').catch(() => ({ default: globalThis.fetch }))
      const url = `${baseURL.replace(/\/$/, '')}/chat/completions`
      const headers = { 'Content-Type': 'application/json' }
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
      const body = JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Hello, reply with just "ok".' }],
        max_tokens: 16,
        stream: false
      })
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000)
      let response
      try {
        response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal })
      } finally {
        clearTimeout(timer)
      }
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const msg = data?.error?.message || data?.message || `HTTP ${response.status}`
        return res.json({ success: false, error: msg })
      }
      const reply = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || '✅'
      res.json({ success: true, reply: reply.trim().slice(0, 100) })
    } catch (error) {
      const msg = error.name === 'AbortError' ? '请求超时（15s）' : error.message
      res.json({ success: false, error: msg })
    }
  })

  // AI 生成提交信息
  app.post('/api/config/generate-commit-message', express.json(), async (req, res) => {
    const { diff, fileList } = req.body || {}
    try {
      const rawConfig = await configManager.readRawConfigFile()
      const models = Array.isArray(rawConfig.models) ? rawConfig.models : []
      const defaultModel = models.find(m => m.isDefault) || models[0]
      if (!defaultModel) {
        return res.json({ success: false, error: '未配置 AI 模型，请先在通用设置中添加模型' })
      }

      const diffText = (diff || '').trim().slice(0, 8000)
      const filesText = Array.isArray(fileList) ? fileList.slice(0, 30).join('\n') : ''
      const prompt = `你是一个 Git 提交信息生成助手。根据以下 git diff 信息，生成一条符合 Conventional Commits 规范的提交信息。

要求：
1. type 只能是：feat/fix/docs/style/refactor/test/chore 之一
2. scope 可选，表示影响范围，简短英文或中文，如果改动范围明确就填
3. description 用中文简短描述本次变更（不超过50字）
4. 只返回 JSON，格式：{"type":"feat","scope":"","description":"xxx"}

变更文件：
${filesText}

git diff --staged：
${diffText || '（无 staged 内容，请根据文件列表推断）'}`

      const { default: fetch } = await import('node-fetch').catch(() => ({ default: globalThis.fetch }))
      const url = `${defaultModel.baseURL.replace(/\/$/, '')}/chat/completions`
      const headers = { 'Content-Type': 'application/json' }
      if (defaultModel.apiKey) headers['Authorization'] = `Bearer ${defaultModel.apiKey}`
      const body = JSON.stringify({
        model: defaultModel.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1024,
        temperature: 0.3,
        stream: false
      })
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30000)
      let response
      try {
        response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal })
      } finally {
        clearTimeout(timer)
      }
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const msg = data?.error?.message || data?.message || `HTTP ${response.status}`
        return res.json({ success: false, error: msg })
      }
      const content = data?.choices?.[0]?.message?.content || ''
      console.log('[generate-commit] raw content length:', content.length, JSON.stringify(content).slice(0, 600))

      // 在整个原始内容里找 JSON（包括 think 块内部），取最后一个不含嵌套 {} 的对象
      // 优先匹配代码块，再取最后一个裸 {}
      const codeBlockMatch = content.match(/```(?:json)?\s*(\{[^`]*?\})\s*```/)
      const jsonMatch = codeBlockMatch
        ? [codeBlockMatch[1]]
        : [...content.matchAll(/\{[^{}]*\}/g)].at(-1)

      if (!jsonMatch) {
        console.error('[generate-commit] no JSON found, full content:', content)
        return res.json({ success: false, error: `模型未返回有效 JSON，请检查模型是否支持（原始内容前300字）: ${content.slice(0, 300)}` })
      }
      let parsed
      try {
        parsed = JSON.parse(jsonMatch[0])
      } catch {
        // JSON 不合法时用正则手动提取字段
        const typeM = jsonMatch[0].match(/"type"\s*:\s*"([^"]+)"/)
        const scopeM = jsonMatch[0].match(/"scope"\s*:\s*"([^"]*)"/)
        const descM = jsonMatch[0].match(/"description"\s*:\s*"([^"]+)"/)
        if (typeM || descM) {
          return res.json({
            success: true,
            type: (typeM?.[1] || 'feat').trim(),
            scope: (scopeM?.[1] || '').trim(),
            description: (descM?.[1] || '').trim()
          })
        }
        return res.json({ success: false, error: `JSON 解析失败: ${jsonMatch[0].slice(0, 200)}` })
      }
      res.json({
        success: true,
        type: String(parsed.type || 'feat').trim(),
        scope: String(parsed.scope || '').trim(),
        description: String(parsed.description || '').trim()
      })
    } catch (error) {
      const msg = error.name === 'AbortError' ? '请求超时（30s）' : error.message
      res.json({ success: false, error: msg })
    }
  })
}
