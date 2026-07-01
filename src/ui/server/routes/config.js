// Copyright 2026 xz333221
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
import express from 'express';
import { asyncRoute, HttpError } from '../utils/asyncRoute.js';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import open from 'open';
import logger from '../utils/logger.js';

// 跳过的产物/资源/lock 文件(用 stat 一行带过,不打 patch)
const SKIP_FILE_PATTERNS = [
  /(^|[\\/])dist[\\/]/,
  /(^|[\\/])build[\\/]/,
  /(^|[\\/])\.next[\\/]/,
  /(^|[\\/])coverage[\\/]/,
  /(^|[\\/])node_modules[\\/]/,
  /\.lock$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /min\.js$/,
  /min\.css$/,
  /\.bundle\.js$/,
  /\.map$/,
  /\.(png|jpe?g|gif|webp|svg|ico|bmp|tiff)$/,
  /\.(mp4|mov|avi|mkv|webm)$/,
  /\.(mp3|wav|ogg|flac)$/,
  /\.(woff2?|ttf|otf|eot)$/,
  /\.(pdf|zip|tar|gz|7z|rar)$/
]

// 文件优先级:数字越大越重要
function filePriority(p) {
  if (/\.(test|spec)\.(js|ts|jsx|tsx|vue)$/i.test(p)) return 1 // 测试文件
  if (/^docs?\//i.test(p) || /\.md$/i.test(p)) return 2 // 文档
  if (/\.(json|ya?ml|toml|env|ini|cfg|conf)$/i.test(p)) return 3 // 配置
  if (/\.(css|scss|sass|less|html|vue|jsx|tsx)$/i.test(p)) return 4 // 前端
  if (/\.(ts|js|mjs|cjs)$/i.test(p)) return 5 // 后端/脚本
  return 3 // 其它(资源、未知)
}

function isSkippedFile(path) {
  return SKIP_FILE_PATTERNS.some(re => re.test(path))
}

// 从 git diff 文本解析出 per-file 块
// git diff 输出格式: "diff --git a/path b/path\n...一系列 header...\n--- a/path\n+++ b/path\n@@ ...\n<patch>"
function parseDiffByFile(diffText) {
  if (!diffText) return []
  const files = []
  // 按 "diff --git " 切分,首段可能为空(文本以这个开头则第一段空)
  const parts = diffText.split(/^diff --git /m).filter(Boolean)
  for (const part of parts) {
    const headerEnd = part.indexOf('\n')
    const headerLine = (headerEnd >= 0 ? part.slice(0, headerEnd) : part).trim()
    // 从 header 里抓路径: "a/path b/path" -> 优先 b
    const m = headerLine.match(/^a\/(.+?)\s+b\/(.+)$/)
    if (!m) continue
    const bPath = m[2]
    const patch = part.slice(headerEnd + 1)
    // 统计 +/- 行数
    let added = 0, removed = 0
    for (const line of patch.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++
      else if (line.startsWith('-') && !line.startsWith('---')) removed++
    }
    files.push({ path: bPath, patch, added, removed })
  }
  return files
}

// 收集 AI 生成提交信息所需的 diff 和文件列表
// 关键: untracked 文件默认不会出现在 git diff --staged 输出里,
//       所以先对所有 untracked 文件做 git add -N(intent to add),
//       这样它们会以 "new file" 形式出现在 diff 里
// selectedPaths: 若给定且非空,则只收集这些路径的 diff,且 git add -N 也仅作用于所选 untracked,
//                避免污染整个 index
async function collectDiffForAi({ execGitCommand, getCurrentProjectPath, selectedPaths }) {
  if (typeof execGitCommand !== 'function') {
    return { diff: '', fileList: [] }
  }
  const projectPath = typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : ''
  const cwdOpts = projectPath ? { cwd: projectPath, log: false } : { log: false }

  const selectedSet = Array.isArray(selectedPaths) && selectedPaths.length > 0
    ? new Set(selectedPaths.map(p => String(p).replace(/\\/g, '/')))
    : null

  let fileList = []
  try {
    // 1. 拿到工作区状态,识别 untracked 文件
    const { stdout: statusOut } = await execGitCommand(['status', '--porcelain=1', '--untracked-files=all'], cwdOpts)
    const untracked = []
    const trackedChanges = []
    for (const line of (statusOut || '').split('\n')) {
      if (!line || line.length < 3) continue
      // porcelain=1 格式: "XY path"  X=index状态, Y=worktree状态
      const x = line[0]
      const y = line[1]
      const path = line.slice(3)
      // 选择模式: 只保留所选路径
      if (selectedSet && !selectedSet.has(path.replace(/\\/g, '/'))) continue
      if (x === '?' && y === '?') {
        untracked.push(path)
      } else if (x !== ' ' || y !== ' ') {
        // 有改动(暂存或工作区)
        trackedChanges.push(`${x !== ' ' ? x : ' '} ${path}`.trim())
      }
    }
    fileList = [...trackedChanges, ...untracked.map(p => `? ${p}`)]

    // 2. 对 untracked 文件做 intent to add(只在内存中,不会真的暂存内容)
    //    选择模式下 untracked 已被裁剪,只会对所选的做 -N,不污染整个 index
    if (untracked.length > 0) {
      // 加上 --force 以防某些文件已经在 index 中
      // 分批处理,避免命令行过长
      const batchSize = 20
      for (let i = 0; i < untracked.length; i += batchSize) {
        const batch = untracked.slice(i, i + batchSize)
        try {
          await execGitCommand(['add', '-N', '--force', ...batch], cwdOpts)
        } catch (e) {
          // 单批失败不影响整体
          logger.warn('[generate-commit] git add -N failed for batch:', e?.message)
        }
      }
    }

    // 3. 合并 staged + unstaged diff
    //    用 --no-color 避免 ANSI 干扰, --no-ext-diff 避免外接 diff 工具
    //    选择模式下用 `-- <paths>` 限定,避免拉取无关 staged 改动
    const pathArgs = selectedSet ? [...selectedSet] : []
    const diffBase = ['diff', '--no-color', '--no-ext-diff']
    const stagedArgs = ['diff', '--staged', '--no-color', '--no-ext-diff', ...(pathArgs.length ? ['--', ...pathArgs] : [])]
    const unstagedArgs = [...diffBase, ...(pathArgs.length ? ['--', ...pathArgs] : [])]
    const [stagedRes, unstagedRes] = await Promise.all([
      execGitCommand(stagedArgs, cwdOpts).catch(() => ({ stdout: '' })),
      execGitCommand(unstagedArgs, cwdOpts).catch(() => ({ stdout: '' }))
    ])
    let combined = ''
    if (stagedRes?.stdout) combined += stagedRes.stdout.trim() + '\n'
    if (unstagedRes?.stdout) combined += unstagedRes.stdout.trim() + '\n'

    return { diff: combined.trim(), fileList }
  } catch (error) {
    logger.error('[generate-commit] collectDiffForAi error:', error?.message)
    return { diff: '', fileList }
  }
}

// 把 diff 压缩成给 LLM 的紧凑文本
// 策略: 跳过产物/资源文件(用一行 stat 带过),源码按优先级排序,每个文件 patch 限 1500 字,总预算 6000 字
function prepareDiffForPrompt(diffText, fileList) {
  const safeFileList = Array.isArray(fileList) ? fileList : []
  let files = parseDiffByFile(diffText)

  // 如果客户端明确指定了文件列表，则只保留与所选文件匹配的 diff 块
  if (safeFileList.length > 0 && files.length > 0) {
    const selectedPaths = new Set(
      safeFileList
        .map(s => {
          if (typeof s !== 'string') return ''
          // fileList 形如 "M src/foo.ts" 或 "? new-file.ts"，取最后的路径部分
          const m = s.match(/^[A-Z?\s]+\s+(.+)$/)
          return (m ? m[1] : s).replace(/\\/g, '/')
        })
        .filter(Boolean)
    )
    if (selectedPaths.size > 0) {
      files = files.filter(f => selectedPaths.has(f.path.replace(/\\/g, '/')))
    }
  }

  // 如果 parse 出来是空的(diff 可能是空或非标准格式),退回到 fileList 推断
  if (files.length === 0) {
    const list = safeFileList.slice(0, 30).map(s => {
      // fileList 形如 "M src/foo.ts" 或 "? new-file.ts"
      const m = s.match(/^[A-Z?\s]+\s+(.+)$/)
      return m ? m[1] : s
    })
    if (list.length === 0) return ''
    return list.map(p => {
      if (isSkippedFile(p)) return `${p} [产物/资源，已跳过]`
      return p
    }).join('\n')
  }

  // 拆分: 跳过的 vs 保留的
  const skipped = []
  const kept = []
  for (const f of files) {
    if (isSkippedFile(f.path)) {
      skipped.push(f)
    } else {
      kept.push(f)
    }
  }

  // 保留的文件按优先级降序,同优先级按 +/- 总数降序(改得多的优先)
  kept.sort((a, b) => {
    const dp = filePriority(b.path) - filePriority(a.path)
    if (dp !== 0) return dp
    return (b.added + b.removed) - (a.added + a.removed)
  })

  const TOTAL_BUDGET = 6000
  const PER_FILE_LIMIT = 1500
  const lines = []
  let budget = TOTAL_BUDGET

  // 先把跳过的文件用一行 stat 总结
  for (const f of skipped) {
    if (budget < 80) break
    lines.push(`${f.path} [+${f.added}/-${f.removed}, 已跳过产物/资源]`)
    budget -= 80
  }

  // 再装源码,带预算控制
  for (const f of kept) {
    if (budget <= 50) break
    let patch = f.patch
    let truncated = false
    if (patch.length > PER_FILE_LIMIT) {
      patch = patch.slice(0, PER_FILE_LIMIT) + '\n... (diff 已截断)'
      truncated = true
    }
    const block = `--- ${f.path} (+${f.added}/-${f.removed})${truncated ? ' [截断]' : ''}\n${patch}`
    if (block.length > budget) {
      // 单个文件塞不下了,截到能塞下为止
      const sliceLen = Math.max(0, budget - 80)
      if (sliceLen < 100) break
      lines.push(`--- ${f.path} (+${f.added}/-${f.removed}) [预算耗尽，已截断]\n${patch.slice(0, sliceLen)}`)
      budget = 0
      break
    }
    lines.push(block)
    budget -= block.length
  }

  if (lines.length === 0) return ''
  return lines.join('\n\n')
}

export { prepareDiffForPrompt, parseDiffByFile, isSkippedFile, filePriority, collectDiffForAi }

export function registerConfigRoutes({
  app,
  configManager,
  execGitCommand,
  getCurrentProjectPath
}) {
  // 保存最近访问的目录
  app.post('/api/save_recent_directory', asyncRoute(async (req, res) => {
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
    }));

  // 删除最近访问的目录
  app.post('/api/remove_recent_directory', asyncRoute(async (req, res) => {
      try {
        const { path: dirPath } = req.body;
        if (!dirPath) {
          throw new HttpError(400, '目录路径不能为空');
        }
        const list = await configManager.removeRecentDirectory(dirPath);
        res.json({ success: true, directories: list });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    }));
  
  // 获取配置
  app.get('/api/config/getConfig', asyncRoute(async (req, res) => {
      try {
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
      
        res.json(config)
      } catch (error) {
        const configPath = path.join(os.homedir(), '.git-commit-tool.json')
        res.status(500).json({
          success: false,
          code: 'CONFIG_LOAD_FAILED',
          error: error?.message || String(error),
          configPath
        })
      }
    }));
  
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
  app.get('/api/config/check-file-format', asyncRoute(async (req, res) => {
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
    }));

  // 使用系统默认程序打开配置文件 ~/.git-commit-tool.json
  app.post('/api/config/open-file', asyncRoute(async (req, res) => {
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
            logger.warn('创建配置文件失败(可忽略):', e?.message || e);
          }
        }
      
        await open(filePath, { wait: false });
        res.json({ success: true })
      } catch (error) {
        res.status(400).json({ success: false, error: `无法打开配置文件: ${error.message}` })
      }
    }));
  
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

  // 保存 UI 状态（视图模式/分割比例/控制台状态/布局比例/编辑器自动保存等）
  // 接受 partial body，浅合并到顶层 ui 对象。例：{ layout: {...} } / { commandConsole: {...} } / { fileListViewMode: 'tree' }
  // 例外：layoutsByProject 是"按项目 cwd → layout"的 map；多个实例并行修改不同项目时
  //   浅替换会丢失其它项目条目，因此对这个 key 做 per-project 合并。
  app.post('/api/config/save-ui-settings', express.json(), async (req, res) => {
    try {
      const partial = req.body && typeof req.body === 'object' ? req.body : {}

      const rawConfig = await configManager.readRawConfigFile()

      // 确保 ui 容器存在
      if (!rawConfig.ui || typeof rawConfig.ui !== 'object' || Array.isArray(rawConfig.ui)) {
        rawConfig.ui = {}
      }
      if (!rawConfig.ui.layoutsByProject || typeof rawConfig.ui.layoutsByProject !== 'object' || Array.isArray(rawConfig.ui.layoutsByProject)) {
        rawConfig.ui.layoutsByProject = {}
      }

      // 浅合并顶层 ui 字段（支持嵌套对象整体替换，如 commandConsole）
      for (const key of Object.keys(partial)) {
        if (key === 'layoutsByProject') {
          // 深合并 map<string, layout>：保留其它项目条目
          const incoming = partial[key]
          if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
            rawConfig.ui.layoutsByProject = {
              ...rawConfig.ui.layoutsByProject,
              ...incoming,
            }
          }
          continue
        }
        rawConfig.ui[key] = partial[key]
      }

      await configManager.writeRawConfigFile(rawConfig)
      res.json({ success: true })
    } catch (error) {
      logger.error('[save-ui-settings] failed:', error)
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
    const { selectedPaths, locale: reqLocale } = req.body || {}
    try {
      const rawConfig = await configManager.readRawConfigFile()
      const userLocale = reqLocale || rawConfig.locale || 'zh-CN'
      const models = Array.isArray(rawConfig.models) ? rawConfig.models : []
      const defaultModel = models.find(m => m.isDefault) || models[0]
      if (!defaultModel) {
        return res.json({ success: false, error: '未配置 AI 模型，请先在通用设置中添加模型', code: 'NO_MODEL' })
      }

      // 后端自己收集 diff,确保 untracked 文件也能进 prompt
      // 选择模式下传入 selectedPaths,后端在 git 层面就过滤,避免污染 index
      const { diff: rawDiff, fileList: serverFileList } = await collectDiffForAi({
        execGitCommand,
        getCurrentProjectPath,
        selectedPaths
      })
      const diffText = prepareDiffForPrompt(rawDiff, serverFileList)
      const filesText = serverFileList.slice(0, 30).join('\n')

      const promptZh = `你是一个 Git 提交信息生成助手。根据以下 git diff 信息，生成一条符合 Conventional Commits 规范的提交信息。

要求：
1. type 只能是：feat/fix/docs/style/refactor/test/chore 之一
2. scope 可选，表示影响范围，简短英文或中文，如果改动范围明确就填
3. description 用中文简短描述本次变更（不超过50字）
4. 只返回 JSON，格式：{"type":"feat","scope":"","description":"xxx"}

变更文件：
${filesText}

git diff --staged：
${diffText || '（无 staged 内容，请根据文件列表推断）'}`

      const promptEn = `You are a Git commit message generation assistant. Based on the following git diff, generate a commit message that follows the Conventional Commits specification.

Requirements:
1. type must be one of: feat/fix/docs/style/refactor/test/chore
2. scope is optional; use a short English word or short noun phrase to indicate the affected area. Leave empty if unclear.
3. description must be a concise English summary of the change (no more than 50 characters). Use the imperative mood (e.g. "add login button", not "added" or "adding").
4. Return ONLY a JSON object in the format: {"type":"feat","scope":"","description":"xxx"}

Changed files:
${filesText}

git diff --staged:
${diffText || '(no staged content, please infer from the file list)'}`

      const prompt = userLocale.startsWith('en') ? promptEn : promptZh

      // AI prompt 默认不打印,只有 DEBUG=1 / DEBUG=logger 时才落地(防 Token 泄露)
      logger.debug('[generate-commit] locale:', userLocale, '| prompt length:', prompt.length)
      logger.debug('[generate-commit] prompt:\n' + prompt)
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
      const timer = setTimeout(() => controller.abort(), 60000)
      let response
      try {
        response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal })
      } finally {
        clearTimeout(timer)
      }
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const msg = data?.error?.message || data?.message || `HTTP ${response.status}`
        return res.json({ success: false, error: msg, code: 'HTTP_ERR' })
      }
      const content = data?.choices?.[0]?.message?.content || ''
      // 响应内容只走 debug(默认关闭),前 600 字截断防 token 泄露
      logger.debug('[generate-commit] raw content length:', content.length, JSON.stringify(content).slice(0, 600))

      const codeBlockMatch = content.match(/```(?:json)?\s*(\{[^`]*?\})\s*```/)
      const jsonMatch = codeBlockMatch
        ? [codeBlockMatch[1]]
        : [...content.matchAll(/\{[^{}]*\}/g)].at(-1)

      if (!jsonMatch) {
        logger.error('[generate-commit] no JSON found, full content:', content)
        return res.json({ success: false, error: 'model returned no valid JSON', code: 'NO_JSON' })
      }
      let parsed
      try {
        parsed = JSON.parse(jsonMatch[0])
      } catch {
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
        return res.json({ success: false, error: 'JSON parse failed', code: 'PARSE_FAILED' })
      }
      res.json({
        success: true,
        type: String(parsed.type || 'feat').trim(),
        scope: String(parsed.scope || '').trim(),
        description: String(parsed.description || '').trim()
      })
    } catch (error) {
      const isTimeout = error.name === 'AbortError'
      const msg = isTimeout ? 'AI 请求超时（60s），请重试或检查模型响应速度' : error.message
      res.json({ success: false, error: msg, code: isTimeout ? 'TIMEOUT' : 'GENERATE_FAILED' })
    }
  })
}
