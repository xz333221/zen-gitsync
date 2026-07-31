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
// g ai 交互式模型配置向导。
//
// 当 ~/.git-commit-tool.json 顶层 models 为空时,由 agent.js 调用本模块
// 引导用户在终端中完成首个 AI 模型的配置,参照 g ui 设置里的"添加模型"
// 功能(ai-model-form 包的 AddModelForm 组件)。
//
// 交互流程:
//   1. 询问是否现在配置
//   2. 选择服务商(预设列表 / 自定义)
//   3. 确认接口地址(baseURL)
//   4. 输入 API Key(本地模型可留空)
//   5. 选择模型名称(先从 API 获取模型列表,失败则用内置列表 / 手动输入)
//   6. 输入显示名称(可选)
//   7. 测试连接
//   8. 保存到配置文件并返回模型对象
//
// 预设数据(PROVIDERS / BUILTIN_MODELS)与 ai-model-form 包的
// server/middleware.js 保持同步,确保 CLI 与 GUI 体验一致。

import readline from 'node:readline'
import chalk from 'chalk'
import config from '../../config.js'
import { startSpinner, renderSelectableListBody, parseKeyForSelectableList } from './termui.js'

// ──────────────────────────────────────────────
// 预设服务商列表
// 来源:ai-model-form 包 server/middleware.js 的 PROVIDERS
// 修改时需同步更新两边
// ──────────────────────────────────────────────
export const PROVIDERS = [
  { id: 'openai',     label: 'OpenAI',              url: 'https://api.openai.com/v1' },
  { id: 'anthropic',  label: 'Anthropic (Claude)',  url: 'https://api.anthropic.com/v1' },
  { id: 'deepseek',   label: 'DeepSeek',            url: 'https://api.deepseek.com/v1' },
  { id: 'gemini',     label: 'Google (Gemini)',     url: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'xai',        label: 'xAI (Grok)',          url: 'https://api.x.ai/v1' },
  { id: 'meta',       label: 'Meta (Llama)',        url: 'https://api.llama-api.com/v1' },
  { id: 'mistral',    label: 'Mistral AI',          url: 'https://api.mistral.ai/v1' },
  { id: 'minimax',    label: 'MiniMax',             url: 'https://api.minimaxi.com/v1' },
  { id: 'moonshot',   label: 'Moonshot (Kimi)',     url: 'https://api.moonshot.cn/v1' },
  { id: 'zhipu',      label: '智谱 (GLM)',           url: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'qwen',       label: '阿里 (Qwen)',          url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'cohere',     label: 'Cohere',              url: 'https://api.cohere.com/v2' },
  { id: 'groq',       label: 'Groq',                url: 'https://api.groq.com/openai/v1' },
  { id: 'together',   label: 'Together AI',         url: 'https://api.together.xyz/v1' },
  { id: 'openrouter', label: 'OpenRouter',          url: 'https://openrouter.ai/api/v1' },
  { id: 'ollama',     label: 'Ollama (本地)',        url: 'http://localhost:11434/v1' },
]

// ──────────────────────────────────────────────
// 内置常用模型列表
// 来源:ai-model-form 包 server/middleware.js 的 BUILTIN_MODELS
// 修改时需同步更新两边
// ──────────────────────────────────────────────
export const BUILTIN_MODELS = {
  'https://api.openai.com/v1': [
    'gpt-5.5', 'gpt-5.5-instant', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano',
    'gpt-4.1', 'gpt-4.1-mini', 'o3', 'o4-mini', 'gpt-4o',
  ],
  'https://api.anthropic.com/v1': [
    'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5',
  ],
  'https://api.deepseek.com/v1': [
    'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner',
  ],
  'https://generativelanguage.googleapis.com/v1beta/openai': [
    'gemini-3.5-flash', 'gemini-3.5-pro', 'gemini-3.1-pro', 'gemini-3-flash',
    'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
  ],
  'https://api.x.ai/v1': [
    'grok-4', 'grok-4.3', 'grok-3', 'grok-3-mini',
  ],
  'https://api.llama-api.com/v1': [
    'llama-4-maverick', 'llama-4-scout', 'llama-3.1-70b', 'llama-3.1-8b',
  ],
  'https://api.mistral.ai/v1': [
    'mistral-medium-3.5', 'mistral-large-3', 'codestral-latest', 'open-mixtral-8x22b',
  ],
  'https://api.minimaxi.com/v1': [
    'minimax-m2.7',
  ],
  'https://api.moonshot.cn/v1': [
    'kimi-k2.6', 'kimi-k2.5', 'moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k',
  ],
  'https://open.bigmodel.cn/api/paas/v4': [
    'glm-5.1', 'glm-5v-turbo', 'glm-4-plus', 'glm-4-flash',
  ],
  'https://dashscope.aliyuncs.com/compatible-mode/v1': [
    'qwen3.7-max', 'qwen3.6-max-preview', 'qwen3.6-plus', 'qwen3.6-flash',
    'qwen3.5-omni-plus', 'qwen3-vl-plus', 'qwen3-235b-a22b', 'qwen3-32b',
  ],
  'https://api.cohere.com/v2': [
    'command-r-plus-4', 'command-r-4', 'command-r', 'command-r-plus',
  ],
  'https://api.groq.com/openai/v1': [
    'llama-3.1-70b-versatile', 'llama-3.1-8b-instant',
    'llama3-70b-8192', 'mixtral-8x7b-32768', 'gemma2-9b-it',
  ],
  'https://api.together.xyz/v1': [
    'meta-llama/Llama-4-Maverick', 'Qwen/Qwen3-72B',
    'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    'deepseek-ai/DeepSeek-V3',
  ],
  'http://localhost:11434/v1': [
    'qwen2.5', 'llama3.1', 'mistral', 'deepseek-r1:7b', 'qwen3', 'llama4',
  ],
}

// ──────────────────────────────────────────────
// i18n 字符串表
// ──────────────────────────────────────────────
const STRINGS = {
  zh: {
    title: 'AI 模型配置向导',
    noModelDetected: '未检测到已配置的 AI 模型。',
    askSetup: '是否现在配置？(Y/n)',
    setupCancelled: '已取消配置。请运行 g ui 在设置中添加模型,或再次运行 g ai。',
    selectProvider: '选择 AI 服务商:',
    customOption: '自定义',
    selectPrompt: (min, max) => `请选择 (${min}-${max}): `,
    navHint: '↑↓ 切换,Enter 确认,数字直跳(0 = 上一行)',
    invalidChoice: (min, max) => `无效选择,请输入 ${min}-${max} 之间的数字`,
    endpointLabel: '接口地址',
    endpointPrompt: (def) => `接口地址 [${def}]: `,
    endpointInvalid: '接口地址格式不正确(需为 http/https URL)',
    modelLabel: '模型名称',
    builtinModels: '常用模型:',
    fetchingModels: '正在获取模型列表…',
    fetchModelsFailed: '获取模型列表失败,使用内置列表',
    manualInput: '手动输入',
    modelPrompt: '请输入模型名称: ',
    modelRequired: '模型名称不能为空',
    apiKeyLabel: 'API Key',
    apiKeyPrompt: 'API Key (本地模型可留空): ',
    displayNameLabel: '显示名称',
    displayNamePrompt: (def) => `显示名称 [${def}]: `,
    testing: '正在测试连接…',
    testOk: '连接成功',
    testFail: (msg) => `连接失败: ${msg}`,
    testSkip: '跳过测试',
    askSave: '是否保存此模型配置？(Y/n)',
    saveCancelled: '已取消保存。',
    cancelled: '已取消。',
    saved: (name) => `✓ 模型 "${name}" 已保存,正在启动 g ai…`,
    saveError: (msg) => `保存配置失败: ${msg}`,
    selectModelForUse: '请选择要使用的模型:',
    useModel: (name) => `使用模型: ${name}`,
  },
  en: {
    title: 'AI Model Setup Wizard',
    noModelDetected: 'No AI model configured.',
    askSetup: 'Set up now? (Y/n)',
    setupCancelled: 'Setup cancelled. Run `g ui` to add a model in Settings, or run `g ai` again.',
    selectProvider: 'Select an AI provider:',
    customOption: 'Custom',
    selectPrompt: (min, max) => `Choose (${min}-${max}): `,
    navHint: '↑↓ to switch, Enter to confirm, number to jump (0 = extra)',
    invalidChoice: (min, max) => `Invalid choice, enter a number between ${min} and ${max}`,
    endpointLabel: 'Endpoint URL',
    endpointPrompt: (def) => `Endpoint [${def}]: `,
    endpointInvalid: 'Invalid endpoint URL (must be http/https)',
    modelLabel: 'Model name',
    builtinModels: 'Popular models:',
    fetchingModels: 'Fetching model list…',
    fetchModelsFailed: 'Failed to fetch model list, using built-in list',
    manualInput: 'Manual input',
    modelPrompt: 'Enter model name: ',
    modelRequired: 'Model name cannot be empty',
    apiKeyLabel: 'API Key',
    apiKeyPrompt: 'API Key (leave empty for local models): ',
    displayNameLabel: 'Display name',
    displayNamePrompt: (def) => `Display name [${def}]: `,
    testing: 'Testing connection…',
    testOk: 'Connection successful',
    testFail: (msg) => `Connection failed: ${msg}`,
    testSkip: 'Skipped test',
    askSave: 'Save this model? (Y/n)',
    saveCancelled: 'Save cancelled.',
    cancelled: 'Cancelled.',
    saved: (name) => `✓ Model "${name}" saved, starting g ai…`,
    saveError: (msg) => `Failed to save: ${msg}`,
    selectModelForUse: 'Select a model to use:',
    useModel: (name) => `Using model: ${name}`,
  },
}

function makeStrings(locale) {
  return String(locale || '').startsWith('en') ? STRINGS.en : STRINGS.zh
}

// ──────────────────────────────────────────────
// 纯函数(便于单测)
// ──────────────────────────────────────────────

/**
 * 根据 baseURL 获取内置模型列表。
 * @param {string} baseURL
 * @returns {string[]} 模型名数组(可能为空)
 */
export function getBuiltinModels(baseURL) {
  if (!baseURL || typeof baseURL !== 'string') return []
  const normalized = baseURL.replace(/\/$/, '')
  return BUILTIN_MODELS[normalized] || []
}

/**
 * 根据 URL 查找匹配的预设 provider。
 * @param {string} url
 * @returns {object|null} provider 对象或 null
 */
export function findProviderByUrl(url) {
  if (!url || typeof url !== 'string') return null
  const normalized = url.replace(/\/$/, '')
  return PROVIDERS.find(p => p.url === normalized) || null
}

/**
 * 验证 endpoint URL 是否合法(http/https)。
 * @param {string} url
 * @returns {boolean}
 */
export function validateEndpoint(url) {
  if (!url || typeof url !== 'string') return false
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 构建模型配置对象(与 UI ModelInfo 结构一致)。
 * @param {object} opts
 * @param {string} opts.baseURL
 * @param {string} opts.model
 * @param {string} [opts.apiKey]
 * @param {string} [opts.name] - 显示名,默认用 model
 * @param {boolean} [opts.isDefault]
 * @returns {object} ModelInfo
 */
export function buildModelConfig({ baseURL, model, apiKey, name, isDefault }) {
  const finalName = (name && name.trim()) || model
  const id = `model-${finalName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 24)}-${Date.now().toString(36)}`
  return {
    id,
    name: finalName,
    baseURL: baseURL.replace(/\/$/, ''),
    model,
    apiKey: apiKey || '',
    isDefault: Boolean(isDefault),
  }
}

/**
 * 从 API 获取可用模型列表(OpenAI 兼容 /models 接口)。
 *
 * @param {object} opts
 * @param {string} opts.baseURL - API 基础地址
 * @param {string} [opts.apiKey] - API Key(可选)
 * @param {number} [opts.timeoutMs=5000] - 超时时间
 * @param {typeof fetch} [opts.fetchFn] - 可注入 fetch(测试用)
 * @returns {Promise<string[]>} 模型名数组,失败返回空数组
 */
export async function fetchModelsFromApi({ baseURL, apiKey, timeoutMs = 5000, fetchFn } = {}) {
  const fetch = fetchFn || globalThis.fetch
  if (!fetch) return []

  const url = `${String(baseURL || '').replace(/\/$/, '')}/models`
  const headers = {}
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    })

    if (!res.ok) return []

    const data = await res.json()
    // OpenAI 兼容接口返回 { data: [{ id: 'model-name', ... }] }
    const models = data?.data || []
    return models.map(m => m.id).filter(Boolean)
  } catch (err) {
    // 任何错误都静默返回空数组,由调用方决定是否回退
    return []
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 测试模型连接(OpenAI 兼容 /chat/completions)。
 *
 * 逻辑与 ai-model-form 包 server/middleware.js 的 POST /ai-model/test 一致:
 *   - 发送一条 max_tokens=1 的 "hi" 消息
 *   - 200 或 400 视为成功(400 可能是参数细节问题但连接是通的)
 *   - 401 = API Key 无效, 404 = 模型不存在
 *
 * @param {object} opts
 * @param {string} opts.baseURL
 * @param {string} opts.model
 * @param {string} [opts.apiKey]
 * @param {number} [opts.timeoutMs=8000]
 * @param {typeof fetch} [opts.fetchFn=globalThis.fetch] - 可注入 fetch(测试用)
 * @returns {Promise<{ok: boolean, message: string, status?: number}>}
 */
export async function testModelConnection({ baseURL, model, apiKey, timeoutMs = 8000, fetchFn } = {}) {
  const fetch = fetchFn || globalThis.fetch
  if (!fetch) throw new Error('fetch is not available')

  const url = `${String(baseURL || '').replace(/\/$/, '')}/chat/completions`
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 1,
    stream: false,
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    })
    if (res.ok || res.status === 400) {
      return { ok: true, message: 'OK', status: res.status }
    }
    if (res.status === 401) {
      return { ok: false, message: 'API Key 无效或未授权 (401)', status: 401 }
    }
    if (res.status === 404) {
      return { ok: false, message: `模型 "${model}" 不存在 (404)`, status: 404 }
    }
    return { ok: false, message: `服务器返回错误: ${res.status}`, status: res.status }
  } catch (err) {
    if (err?.name === 'AbortError') {
      return { ok: false, message: `连接超时 (>${Math.round(timeoutMs / 1000)}s)` }
    }
    return { ok: false, message: `连接失败: ${err?.message || String(err)}` }
  } finally {
    clearTimeout(timer)
  }
}

// ──────────────────────────────────────────────
// readline 交互辅助
// ──────────────────────────────────────────────

/**
 * 创建一个基于 readline 的问答辅助对象。
 * @param {import('node:readline').Interface} rl
 * @returns {{ ask: (prompt: string, defaultValue?: string) => Promise<string> }}
 */
function createAsker(rl) {
  /**
   * 提问并等待用户输入。
   * - 空输入时返回 defaultValue(如果提供了)
   * - Ctrl+C / Ctrl+D 时抛出 { cancelled: true }
   */
  function ask(prompt, defaultValue) {
    return new Promise((resolve, reject) => {
      const display = defaultValue != null && defaultValue !== ''
        ? chalk.cyan(prompt) + chalk.dim(` (${defaultValue})`)
        : chalk.cyan(prompt)
      rl.question(display + ' ', (answer) => {
        const trimmed = (answer || '').trim()
        if (trimmed === '' && defaultValue != null && defaultValue !== '') {
          resolve(defaultValue)
        } else {
          resolve(trimmed)
        }
      })
      // Ctrl+C / Ctrl+D: 用户取消
      rl.once('close', () => {
        reject({ cancelled: true })
      })
    })
  }
  return { ask }
}

/**
 * 询问 Yes/No,默认 Yes。
 * @returns {Promise<boolean>} true = yes
 */
async function askYesNo(asker, prompt) {
  const answer = await asker.ask(prompt, 'y')
  const lower = answer.toLowerCase()
  return lower === '' || lower === 'y' || lower === 'yes'
}

/**
 * 让用户从列表中选择一项。
 *
 * 两条路径:
 *   - TTY(终端)且传入了 rl → 上下键切换 + Enter 提交(类似 Codex CLI 的列表选择)
 *     - 数字键 1..9 / 0 也可直跳(0 = 额外项)
 *     - Esc / Ctrl+C 视作取消整个 wizard(调用方按 { cancelled: true } 走 catch 分支)
 *   - 其他情况 → 回退到原数字输入(由 asker.ask 提示,数字 + 回车确认;非法输入不退出,
 *     提示 t.invalidChoice 让用户重新输)
 *
 * 设计要点:
 *   - 列表用 renderSelectableListBody 渲染,选中行整行反白(可视化锚点固定,跟斜杠命令
 *     提示一样的"反白起点严格对齐"思路)
 *   - 方向键会触发 readline 默认历史浏览,我们用"清空 rl.line + 调 _refreshLine"撤销
 *     (参考 agent.js 对斜杠命令提示的处理)
 *   - 按 Enter 时 rl.question 回调自然拿到 line 字符串;空字符串 → 用当前 selectedIndex,
 *     数字 → 直接选中,非数字 → 视为无效,保持当前列表继续等待输入(不重画列表)
 *
 * @param {object} opts
 * @param {import('node:readline').Interface} [opts.rl] - 用于挂 keypress + rl.question;
 *   不传或非 TTY 时退回数字输入
 * @param {{ask:(p:string,d?:string)=>Promise<string>}} opts.asker - 数字输入回退路径的 asker;
 *   TTY 路径不需要,但参数签名上必须传(避免 collectModelInput 内部拆开两个调用)
 * @param {string} opts.title
 * @param {Array<{label: string, value: any}>} opts.items
 * @param {object} opts.t - i18n strings
 * @param {string} [opts.extraOptionLabel] - 额外项(编号 0)
 * @returns {Promise<{index: number, value: any}|null>}
 *   - { index, value }:选中标准项
 *   - null:选中额外项
 *   - 抛出 { cancelled: true }:用户取消整个 wizard(Ctrl+C / Esc / readline close)
 */
async function selectFromList({ rl, asker, title, items, t, extraOptionLabel } = {}) {
  const safeItems = Array.isArray(items) ? items : []
  const extraActive = !!extraOptionLabel
  const totalItems = safeItems.length + (extraActive ? 1 : 0)
  if (totalItems === 0) return null

  console.log()
  console.log(chalk.bold(title))

  // 判断走哪条路
  const interactive = !!(rl && rl.input && process.stdout.isTTY && process.stdin.isTTY)

  if (!interactive) {
    // 非 TTY / 没 rl:走数字输入回退(原行为,保留 CI / 管道环境的可脚本化能力)
    return selectByDigits({ asker, items: safeItems, t, extraOptionLabel })
  }

  // ── TTY 路径:方向键列表选择 ──
  let selectedIndex = 0
  let finished = false

  // 渲染初始列表
  const initialBody = renderSelectableListBody(safeItems, 0, extraOptionLabel)
  process.stdout.write(initialBody + '\n')
  const listRows = initialBody.split('\n').length

  /**
   * 重画列表:用 ANSI 把光标逐行上移 + 清行,然后重新打印,光标回到列表首行行首,
   * 不影响 readline 在 listRows+1 行的 prompt 行。
   * 用 \x1b[2K(清整行)+ \x1b[1A(上移一行)循环 N 次,等价于
   * "清掉光标以上 N 行"但不污染更下面的内容;最后 \r 回到行首方便后续输出起点对齐。
   */
  const redraw = () => {
    for (let i = 0; i < listRows; i++) {
      process.stdout.write('\x1b[1A\x1b[2K')
    }
    process.stdout.write('\r')
    process.stdout.write(renderSelectableListBody(safeItems, selectedIndex, extraOptionLabel) + '\n')
  }

  /**
   * 撤销 readline 内置行为对 rl.line 的副作用:
   *   - 方向键:readline 读 history 一条回填到 rl.line + _refreshLine 重画 prompt
   *     用户本来在 prompt 行没敲任何字符,历史回填会让用户突然看到历史的脏字符。
   *     所以清空 line buffer 让 prompt 行保持空(类似 agent.js 对斜杠命令提示的做法)。
   *   - 数字键(jump:N):用户在 prompt 行确实敲了数字,该数字已经在 rl.line 里,
   *     不能撤销(否则用户按 "8" 看不到 "8")— 但目前的 jump 路径用 rl.line.length === 0 守门,
   *     等于已经避免和 readline 的字符输入重叠,所以 prev/next 路径才需要清,数字路径不用清。
   */
  const clearLineBuffer = () => {
    if (!rl) return
    rl.line = ''
    rl.cursor = 0
    if (typeof rl._refreshLine === 'function') {
      try { rl._refreshLine() } catch { /* 兜底 — 某些 readline 版本没有 _refreshLine */ }
    }
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (finished) return
      finished = true
      if (rl && rl.input) rl.input.removeListener('keypress', keyHandler)
      if (rl) rl.removeListener('close', onClose)
    }
    const onClose = () => {
      cleanup()
      reject({ cancelled: true })
    }

    const keyHandler = (_str, key) => {
      if (finished || !key) return
      const action = parseKeyForSelectableList(key)
      const max = totalItems - 1

      if (action === 'prev' || action === 'next') {
        if (action === 'prev') {
          selectedIndex = selectedIndex > 0 ? selectedIndex - 1 : max
        } else {
          selectedIndex = selectedIndex < max ? selectedIndex + 1 : 0
        }
        clearLineBuffer()   // 撤销 readline 历史回填
        redraw()
        return
      }

      if (typeof action === 'string' && action.startsWith('jump:')) {
        // 只在用户当前没敲字符时接受 jump,避免和 readline 正常字符输入冲突
        if (rl.line && rl.line.length > 0) return
        const n = Number(action.slice(5))
        let target = -1
        if (n === 0 && extraActive) target = safeItems.length
        else if (n >= 1 && n <= safeItems.length) target = n - 1
        if (target >= 0) {
          selectedIndex = target
          redraw()   // 数字已进 rl.line,不清;用户会看到 prompt 行同步显示这个数字
        }
        return
      }

      if (action === 'cancel') {
        // Esc / Ctrl+C — 让用户取消整个 wizard
        cleanup()
        reject({ cancelled: true })
        return
      }

      // 'confirm' (Enter) 不处理,让 readline 自然触发 line 事件 → rl.question 回调拿 answer
      // 其他字符(字母/数字但 line buffer 非空)让 readline 自然处理
    }

    rl.input.on('keypress', keyHandler)
    rl.once('close', onClose)

    // 提示词:列出可选范围 + 导航提示
    const minIdx = extraActive ? 0 : 1
    const maxIdx = safeItems.length
    const navHint = t.navHint  // "↑↓ 切换,Enter 确认,数字直跳"
    const promptStr = `${chalk.cyan(t.selectPrompt(minIdx, maxIdx))}${chalk.dim(navHint ? '  ' + navHint : '')} `

    rl.question(promptStr, (answer) => {
      cleanup()
      const trimmed = (answer || '').trim()
      let idx = Number.parseInt(trimmed, 10)
      if (Number.isFinite(idx) && idx >= minIdx && idx <= maxIdx) {
        if (idx === 0) return resolve(null)
        return resolve({ index: idx - 1, value: safeItems[idx - 1].value })
      }
      if (trimmed === '') {
        // 空回答:用当前 selectedIndex
        if (selectedIndex >= safeItems.length) return resolve(null)
        return resolve({ index: selectedIndex, value: safeItems[selectedIndex].value })
      }
      // 非法输入:在当前列表下方打印提示,不重画列表(列表还在可见)
      console.log(chalk.yellow(t.invalidChoice(minIdx, maxIdx)))
      resolve('__retry__')
    })
  }).then(async (r) => {
    if (r === '__retry__') {
      // 递归重试(重新调一次)— 列表会再画一遍,实测可接受;保持 wizard 流程的简洁
      return selectFromList({ rl, asker, title, items, t, extraOptionLabel })
    }
    return r
  })
}

/**
 * 数字输入回退路径(原 selectFromList 的实现)。
 * 保留给非 TTY / 无 readline 的场景(管道、CI、测试)。
 */
async function selectByDigits({ asker, items, t, extraOptionLabel }) {
  items.forEach((item, i) => {
    console.log(`  ${chalk.cyan(String(i + 1).padStart(2))}. ${item.label}`)
  })
  if (extraOptionLabel) {
    console.log(`  ${chalk.dim('0')}. ${chalk.dim(extraOptionLabel)}`)
  }
  const min = extraOptionLabel ? 0 : 1
  const max = items.length
  while (true) {
    const answer = await asker.ask(t.selectPrompt(min, max))
    const idx = Number.parseInt(answer, 10)
    if (Number.isFinite(idx) && idx >= min && idx <= max) {
      if (idx === 0) return null
      return { index: idx - 1, value: items[idx - 1].value }
    }
    console.log(chalk.yellow(t.invalidChoice(min, max)))
  }
}

// ──────────────────────────────────────────────
// 交互式配置主流程
// ──────────────────────────────────────────────

/**
 * 交互式收集单个模型的配置(服务商 → 接口地址 → 模型名 → API Key → 显示名 → 测试连接)。
 *
 * 这是 runModelSetup(首次配置向导)与 agent.js 的 /addmodel 斜杠命令共用的核心交互逻辑。
 * 本函数只负责"收集 + 测试",不负责保存 —— 调用方拿到返回值后自行 buildModelConfig +
 * 持久化,以便在不同场景下灵活控制 isDefault / 状态更新等后续行为。
 *
 * @param {object} opts
 * @param {string} [opts.locale='zh-CN']
 * @param {import('node:readline').Interface} [opts.rl] - 可注入 readline(测试用 / REPL 复用)
 * @param {typeof fetch} [opts.fetchFn] - 可注入 fetch(测试用)
 * @param {string} [opts.cancelMessage] - 用户取消(Ctrl+C/Ctrl+D)时打印的提示文案,
 *   默认用通用的 t.cancelled;首次配置向导可传入 t.setupCancelled 以保留原有提示
 * @returns {Promise<{baseURL: string, model: string, apiKey: string, displayName: string}|null>}
 *   成功返回收集到的字段;用户取消或测试失败后选择不保存时返回 null(已打印相应提示)
 */
export async function collectModelInput({ locale = 'zh-CN', rl: injectedRl, fetchFn, cancelMessage } = {}) {
  const t = makeStrings(locale)
  const ownRl = !injectedRl
  const rl = injectedRl || readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  const asker = createAsker(rl)
  const cancelMsg = cancelMessage || t.cancelled

  try {
    // 1. 选择服务商
    const providerItems = PROVIDERS.map(p => ({
      label: `${p.label} ${chalk.dim(p.url)}`,
      value: p,
    }))
    const providerChoice = await selectFromList({
      rl, asker,
      title: t.selectProvider,
      items: providerItems,
      t,
      extraOptionLabel: t.customOption,
    })

    let baseURL
    if (providerChoice) {
      baseURL = providerChoice.value.url
    } else {
      // 自定义:手动输入 baseURL
      while (true) {
        baseURL = await asker.ask(t.endpointPrompt('https://...'))
        if (validateEndpoint(baseURL)) break
        console.log(chalk.red(t.endpointInvalid))
      }
    }

    // 2. 确认/输入接口地址(选了预设的也允许用户修改)
    const confirmedBaseURL = await asker.ask(t.endpointPrompt(baseURL), baseURL)
    if (!validateEndpoint(confirmedBaseURL)) {
      console.log(chalk.red(t.endpointInvalid))
      // 再给一次机会
      while (true) {
        const retry = await asker.ask(t.endpointPrompt('https://...'))
        if (validateEndpoint(retry)) { baseURL = retry; break }
        console.log(chalk.red(t.endpointInvalid))
      }
    } else {
      baseURL = confirmedBaseURL
    }

    // 3. 输入 API Key(在获取模型列表之前,因为大部分服务商需要 Key 才能调 /models)
    const apiKey = await asker.ask(t.apiKeyPrompt)

    // 4. 选择/输入模型名称
    // 先尝试从 API 获取模型列表(有了 apiKey 才能调通)
    const fetchSpinner = startSpinner(t.fetchingModels)
    const fetchedModels = await fetchModelsFromApi({ baseURL, apiKey, fetchFn })
    fetchSpinner.stop()

    // 使用 API 返回的模型列表,如果失败则使用内置列表
    const modelList = fetchedModels.length > 0 ? fetchedModels : getBuiltinModels(baseURL)

    if (fetchedModels.length === 0 && getBuiltinModels(baseURL).length > 0) {
      console.log(chalk.dim(`  ${t.fetchModelsFailed}`))
    }

    let model
    if (modelList.length > 0) {
      const modelItems = modelList.map(m => ({ label: m, value: m }))
      const modelChoice = await selectFromList({
        rl, asker,
        title: t.builtinModels,
        items: modelItems,
        t,
        extraOptionLabel: t.manualInput,
      })
      if (modelChoice) {
        model = modelChoice.value
      } else {
        // 手动输入
        while (true) {
          model = await asker.ask(t.modelPrompt)
          if (model) break
          console.log(chalk.yellow(t.modelRequired))
        }
      }
    } else {
      // 没有模型列表,直接手动输入
      while (true) {
        model = await asker.ask(t.modelPrompt)
        if (model) break
        console.log(chalk.yellow(t.modelRequired))
      }
    }

    // 5. 输入显示名称(默认用 model 名)
    const displayName = await asker.ask(t.displayNamePrompt(model), model)

    // 6. 测试连接
    console.log()
    const spinner = startSpinner(t.testing)
    const testResult = await testModelConnection({ baseURL, model, apiKey, fetchFn })
    spinner.stop()

    if (testResult.ok) {
      console.log(chalk.green(`✓ ${t.testOk}`))
    } else {
      console.log(chalk.yellow(`⚠ ${t.testFail(testResult.message)}`))
      const proceed = await askYesNo(asker, t.askSave)
      if (!proceed) {
        console.log(chalk.dim(t.saveCancelled))
        return null
      }
    }

    return { baseURL, model, apiKey, displayName }
  } catch (err) {
    // 用户 Ctrl+C / Ctrl+D 取消
    if (err && err.cancelled) {
      console.log(chalk.dim('\n' + cancelMsg))
      return null
    }
    throw err
  } finally {
    if (ownRl) rl.close()
  }
}

/**
 * 运行交互式模型配置向导。
 *
 * 当 models 为空时由 agent.js 调用。完成后将新模型保存到配置文件并返回,
 * 调用方可直接用返回的 models / model 启动 agent 会话。
 *
 * @param {object} opts
 * @param {string} [opts.locale='zh-CN']
 * @param {import('node:readline').Interface} [opts.rl] - 可注入 readline(测试用)
 * @param {typeof fetch} [opts.fetchFn] - 可注入 fetch(测试用)
 * @returns {Promise<{models: object[], model: object}|null>}
 *   成功返回 { models, model };用户取消返回 null
 */
export async function runModelSetup({ locale = 'zh-CN', rl: injectedRl, fetchFn } = {}) {
  const t = makeStrings(locale)
  const ownRl = !injectedRl
  const rl = injectedRl || readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  const asker = createAsker(rl)

  try {
    // 1. 询问是否配置
    console.log()
    console.log(chalk.yellow(t.noModelDetected))
    const wantSetup = await askYesNo(asker, t.askSetup)
    if (!wantSetup) {
      console.log(chalk.dim(t.setupCancelled))
      return null
    }

    // 2-6. 交互式收集模型配置(复用 collectModelInput)
    const collected = await collectModelInput({ locale, rl, fetchFn, cancelMessage: t.setupCancelled })
    if (!collected) return null

    // 7. 保存配置(测试成功直接保存;失败时 collectModelInput 内已确认过)
    // 加载现有配置,添加新模型
    const { baseURL, model, apiKey, displayName } = collected
    const cfg = await config.loadConfig()
    const models = Array.isArray(cfg.models) ? cfg.models : []
    const isFirst = models.length === 0
    const newModel = buildModelConfig({ baseURL, model, apiKey, name: displayName, isDefault: isFirst })
    models.push(newModel)
    cfg.models = models

    try {
      await config.saveConfig(cfg)
    } catch (err) {
      console.log(chalk.red(t.saveError(err.message)))
      return null
    }

    console.log(chalk.green(t.saved(displayName || model)))
    return { models, model: newModel }
  } catch (err) {
    // 用户 Ctrl+C 取消(askSetup 阶段;collectModelInput 内部的取消已自行处理)
    if (err && err.cancelled) {
      console.log(chalk.dim('\n' + t.setupCancelled))
      return null
    }
    throw err
  } finally {
    if (ownRl) rl.close()
  }
}

export default { runModelSetup, collectModelInput, fetchModelsFromApi, testModelConnection, getBuiltinModels, findProviderByUrl, validateEndpoint, buildModelConfig, PROVIDERS, BUILTIN_MODELS }
