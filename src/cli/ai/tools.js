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
// g ai 智能体的工具层 — OpenAI function calling 格式的工具定义 + 执行器。
//
// 权限模型(用户在需求里明确授权):
//   - 文件读写 / 命令执行不设目录白名单,工作目录与其他目录都可以操作
//   - 唯一限制来自 safety.js 的系统级红线(格式化、删根目录、关机等)
//
// 输出约束:
//   - 工具结果默认是字符串,直接作为 role:'tool' 消息回喂给模型
//   - 唯一例外是 read_image:它返回 { text, images[] },images 是 data URL。
//     agent 循环用 toolMessageContent() 把它拼成**多模态 tool 消息**
//     (content 数组里同时有 text 部件和 image_url 部件),模型才真的能看见图。
//     这是本仓唯一"工具结果不是字符串"的地方 —— 新增工具请沿用字符串,
//     否则 turn.js / agentChat.js / context.js / termui.js 四处都要跟着改。
//   - 大输出在源头截断(头 + 尾保留),避免撑爆上下文窗口
//   - 工具内部异常一律 catch 成字符串返回,不抛给 agent 循环 ——
//     让模型看到错误信息自己修正,而不是中断整轮对话

import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import iconv from 'iconv-lite'
import { trackChild } from '../cleanup.js'
import { checkDangerousCommand } from './safety.js'
import { guardCommand } from './platformGuard.js'
import { augmentEnvPath, isCommandNotFound, pathValueOf } from '../../utils/shellPath.js'
import { checkImageFile, imageToDataUrl, formatBytes, isImagePath, SUPPORTED_IMAGE_EXTS } from './images.js'
// 定时任务库：CLI 与 GUI 共享同一份文件（~/.zen-gitsync/schedules.json）。
// 本工具只负责登记/管理，真正的到点执行由 g ui 服务端的调度器完成。
import { createTask, loadTasks, deleteTask, updateTask } from '../../utils/scheduleStore.js'
import { nextFireAfter } from '../../utils/scheduleCron.js'

// ──────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────
const MAX_CMD_OUTPUT = 8000        // run_command 输出截断预算(字符)
const MAX_READ_LINES = 2000        // read_file 单次最多返回行数
const MAX_LINE_WIDTH = 2000        // 单行截断宽度
const MAX_LIST_ENTRIES = 400       // list_files 最多条目
const MAX_SEARCH_HITS = 100        // search_text 最多命中
const MAX_SEARCH_FILE_SIZE = 1024 * 1024  // search_text 跳过大文件(1MB)
const MAX_IMAGE_BYTES = 4 * 1024 * 1024   // read_image 单张上限(原始字节)
// 为什么要有上限:图片要以 base64 进请求体,体积膨胀 4/3,而且**每一轮都要重发**。
// 一张 10MB 的截图能直接把上下文和账单顶穿。4MB 覆盖绝大多数截图/设计稿,
// 超了让模型自己先压缩(它手上有 run_command),比我们默默截断成半张图好。
const CMD_TIMEOUT_DEFAULT = 120    // run_command 默认超时(秒)
const CMD_TIMEOUT_MAX = 600        // run_command 超时上限(秒)

// 已知的长耗时命令(装依赖 / 构建 / 测试 / clone …)。模型不给 timeout_seconds 时
// 默认只有 120s,这类命令经常跑不完就被终止,模型再换个写法重试 —— 白等好几轮。
// 命中即直接给到上限,不再依赖模型自己判断。
const LONG_CMD_RE = /(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)\s+(?:i\b|install\b|ci\b|add\b|create\b)|(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|test|lint|e2e|typecheck)\b|(?:^|[\s;&|(])git\s+clone\b|(?:^|[\s;&|(])pip3?\s+install\b/i

// run_command 本次执行的超时(秒)。长耗时命令即使模型给了更小的值也抬到上限 ——
// 它填小值基本都是照抄默认值,而不是"想快速失败"。
export function resolveCommandTimeout(command, requestedSeconds) {
  const n = Number(requestedSeconds) || CMD_TIMEOUT_DEFAULT
  const clamped = Math.max(1, Math.min(CMD_TIMEOUT_MAX, n))
  return LONG_CMD_RE.test(String(command || '')) ? CMD_TIMEOUT_MAX : clamped
}

// 目录遍历时跳过的目录名(产物/依赖/VCS)
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
  'coverage', '.next', '.nuxt', '.cache', 'target', 'vendor',
  '__pycache__', '.idea', '.vscode',
])

// search_text 跳过的二进制/资源扩展名
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.tiff',
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.mp3', '.wav', '.ogg', '.flac',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.pdf', '.zip', '.tar', '.gz',
  '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.bin', '.lock', '.min.js',
  '.map', '.jar', '.class', '.pyc',
])

// ──────────────────────────────────────────────
// 工具 schema(OpenAI function calling 格式)
// ──────────────────────────────────────────────
export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在系统默认 shell 执行一条命令(Windows 为 cmd.exe,POSIX 为 /bin/sh)。可用于构建、测试、安装依赖、git 操作(add/commit/push)、查看系统信息等。命令以当前用户权限运行;会把系统搞崩的命令(格式化、删根目录、关机等)会被安全守卫拒绝。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的完整命令行' },
          cwd: { type: 'string', description: '执行目录,默认是智能体启动目录;可传任意绝对/相对路径' },
          timeout_seconds: { type: 'number', description: `超时秒数,默认 ${CMD_TIMEOUT_DEFAULT},最大 ${CMD_TIMEOUT_MAX}` },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取**文本**文件内容,带行号返回。大文件用 offset/limit 分段读取。看图片请用 read_image —— 本工具按 UTF-8 解码,读图片只会得到乱码。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径(相对智能体启动目录或绝对路径)' },
          offset: { type: 'number', description: '起始行(1 起始),默认 1' },
          limit: { type: 'number', description: `最多读取行数,默认 ${MAX_READ_LINES}` },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_image',
      description: '读取本地图片并**真的看到它**(PNG/JPG/GIF/WebP/BMP),用于看截图、设计稿、示意图、报错弹窗、图表。'
        + '用户给你一个图片路径、"看看这张图""照这个设计做"时用它,不要用 read_file(read_file 只按文本解码,图片会是乱码)。'
        + '单张上限 4MB,超了先用 run_command 压缩再读。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '图片路径(相对智能体启动目录或绝对路径)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '创建或整体覆盖写入一个文件(父目录不存在会自动创建)。适合新建文件或小文件整体改写;大文件局部修改请用 edit_file。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '对文件做精确字符串替换:old_string 必须与文件内容完全一致(含缩进/换行)且默认要求唯一匹配。修改前先 read_file 确认原文。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          old_string: { type: 'string', description: '要被替换的原始文本(精确匹配)' },
          new_string: { type: 'string', description: '替换后的新文本' },
          replace_all: { type: 'boolean', description: '为 true 时替换所有出现位置;默认 false,要求 old_string 唯一' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '递归列出目录内容(跳过 node_modules/.git/dist 等产物目录),返回带缩进的树状列表。用于快速了解项目结构。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径,默认智能体启动目录' },
          depth: { type: 'number', description: '递归深度,默认 2,最大 6' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_text',
      description: '搜索正则匹配的行,返回 文件:行号: 内容。path 可以是目录(递归搜全部文本文件)或单个文件。用于定位符号、关键字、调用点。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式(JavaScript 语法)' },
          path: { type: 'string', description: '搜索目录或单个文件路径,默认智能体启动目录' },
          ext: { type: 'string', description: '限定扩展名过滤,如 "js" 或 "js,ts,vue";不传则搜全部文本文件' },
          ignore_case: { type: 'boolean', description: '忽略大小写,默认 false' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_projects',
      description: '列出用户本机的「最近项目」——就是 g ui 里最近项目面板的同一份清单(最近目录 ∪ 建过任务的目录),每条带 Git 状态(分支/领先/落后/未提交数)与任务进度。'
        + '被问到"我有哪些项目""哪个项目该 pull / 该推了"时必须用它,不要靠 list_files 扫盘或猜目录名(扫盘会把 node_modules 里的嵌套仓库也算进来,口径与界面不一致)。'
        + '注意:领先/落后读的是本地 remote-tracking 引用 = "上次 fetch 时的快照";用户问的是否需要 pull/推送且要真实状态时,传 refresh=true 先联网 fetch 一轮。',
      parameters: {
        type: 'object',
        properties: {
          refresh: {
            type: 'boolean',
            description: `true = 先对每个项目执行一次 git fetch 再统计(联网,较慢,需要认证的仓库若无凭据会快速失败);默认 false 只读本地快照,不联网`,
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_plan',
      description: '维护当前任务的执行计划(任务清单):把复杂任务拆成 3-8 个可核对的步骤,并随进展实时更新状态。'
        + '什么时候用:任务需要多步(改代码/排查/调研)时**先调用一次**把步骤列出来,让用户在你动手前就知道你要做什么、怎么验收;'
        + '之后每完成一步、或发现计划不对就再调一次更新状态。'
        + '规则:① steps 是**完整**的当前计划(不是增量),每次都把没做完的步骤一起带上,顺序即执行顺序;'
        + '② 同一时刻最多一个 in_progress —— 真正并行的事拆成先后两步写;'
        + '③ 状态只能 pending → in_progress → completed,别跳回;'
        + '④ 做完一步就更新一次,别攒到最后一次性刷;步骤完成后再把计划删空(传空 steps)表示收尾。'
        + '这个工具只是给人看的进度板,不承担任何副作用:它不会改文件、不会执行命令。',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: '完整计划步骤列表(覆盖上一版)。顺序即执行顺序,3-8 条为宜,上限 20 条。',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '这一步要做什么(祈使句、可核对,别写"处理相关问题"这种空话)' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed'],
                  description: '状态:已完成 / 进行中 / 待办。同一时刻最多一个 in_progress',
                },
              },
              required: ['content'],
            },
          },
          explanation: {
            type: 'string',
            description: '这次调整的一句话说明(如"库侧已完成,现在切宿主")。会显示在计划清单上方;首次列计划时写清整体思路。',
          },
        },
        required: ['steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Pause the current task and ask the user for a decision or missing information. Use this when the next step depends on the user. Prefer options for a small fixed set of choices; allow free text when an open answer is useful.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to show the user.' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of choices. Keep it short and make each item self-contained.',
          },
          allow_free_text: {
            type: 'boolean',
            description: 'Whether the user may type an answer that is not one of the listed options. Defaults to true.',
          },
          multiple: {
            type: 'boolean',
            description: 'Allow selecting several options at once. Only meaningful when options are provided. Defaults to false.',
          },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dispatch_task',
      description: '把一条任务派发到本机某个项目，由本地 CLI 执行器（claude / opencode / codex）去跑。'
        + '这是"让别的 agent 替我干活"的唯一入口：工作台里的一条任务 = 一次独立会话，派出去之后它在自己的进程里跑，'
        + '不占本次对话，也不阻塞你继续回答用户。'
        + '只在 g ui 的多项目编排台（主 Agent 控制台）里可用；其它入口调用会拿到一句 unavailable，那时直接回答用户即可。'
        + '落点：不传 project_path 时由服务端按指令内容判断（指令里点名的项目 > 语义判断 > 应用当前项目），'
        + '判断依据会如实记进指令流水；不确定有哪些项目时先用 list_projects 看清楚，不要猜目录名。'
        + '粒度：一次调用只建**一条**任务。要分成几件事就分几次调用 —— 每次调用都会真的建一个任务、'
        + '默认还可能立刻起一个 CLI 进程，不要把一堆不相关的事塞进同一个 text。'
        + '想先征得用户同意再派，就先调 ask_user 问清楚（auto_run 传 false 也能只建任务不执行）。',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: '完整任务指令，会**原样**成为那条任务的 prompt（不是标题）。写清目标、范围与验收标准；'
              + '可粘整段报错日志 / 需求原文（上限 10 万字），但一次只讲一件事 —— 拆成多条各自更清楚。',
          },
          project_path: {
            type: 'string',
            description: '目标项目目录的绝对路径。不传则由服务端按指令内容判断落点。',
          },
          executor: {
            type: 'string',
            enum: ['claude', 'opencode', 'codex'],
            description: '用哪个本地 CLI 执行这条任务。不传则用控制台当前选中的执行器，再退到配置里的全局默认。',
          },
          auto_run: {
            type: 'boolean',
            description: 'true（默认）= 建了任务立刻执行；false = 只建任务留在看板，等用户自己点执行。',
          },
          use_default_prompt: {
            type: 'boolean',
            description: '默认 true = 附加编排台配置的预设提示词（全局 + 落点项目级）；false = 这条任务不带。',
          },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_task',
      description: '创建和管理**定时任务**：到点自动发起一轮对话（等价于用户那时对你说下面那段话）。'
        + '用户说"每天/每周/到点帮我做某事"就用它，不要用别的方式承诺"我会定时做" —— 你不能自己定时，'
        + '只有登记成定时任务才会真的执行。'
        + '执行者是 zen-gitsync GUI（g ui）服务端的调度器：本工具只登记任务；**g ui 没运行的时间段任务不会执行**，'
        + '重新运行后是否补跑由任务的 on_missed 决定。每轮执行结果落在该任务的专属会话里，用户随时可回看。'
        + '动作：create（默认，新建任务）| list（列出全部任务与 id）| remove（删除）| enable / disable（启停）。'
        + 'remove / enable / disable 要先从 list 拿到任务的 id。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'list', 'remove', 'enable', 'disable'],
            description: '要执行的动作，默认 create。',
          },
          name: {
            type: 'string',
            description: '任务名（create 必填），如「每日拉代码」。要短、能一眼看出做什么。',
          },
          schedule: {
            type: 'string',
            description: 'cron 表达式（create 必填）：5 个字段 = 分 时 日 月 周，本地时间。'
              + '如 "0 9 * * *" 每天 09:00；"*/30 * * * *" 每 30 分钟；"0 10 * * 1" 每周一 10:00；"30 18 * * 1-5" 工作日 18:30。',
          },
          prompt: {
            type: 'string',
            description: '到点后发给你的完整指令（create 必填）。写成一次独立、自足的请求 —— '
              + '未来那一轮没有现在的对话上下文，要说清目标、范围与验收标准。',
          },
          cwd: {
            type: 'string',
            description: '任务落在哪个项目目录（绝对路径），不传用当前目录。定时拉代码这类任务要绑定到具体仓库目录。',
          },
          id: {
            type: 'string',
            description: '任务 id（remove / enable / disable 必填），从 list 的结果里拿。',
          },
          on_missed: {
            type: 'string',
            enum: ['run', 'skip'],
            description: '错过补偿：g ui 没运行导致错过触发点时，run（默认）= 重新运行后补跑一次；skip = 直接跳过。',
          },
        },
        required: ['action'],
      },
    },
  },
]

// ──────────────────────────────────────────────
// 内部工具函数
// ──────────────────────────────────────────────

// 相对 ctx.cwd 解析路径;绝对路径原样保留(用户授权了任意目录访问)
function resolvePath(ctx, p) {
  if (!p || typeof p !== 'string') return ctx.cwd
  return path.resolve(ctx.cwd, p)
}

// 头 + 尾截断:超过 budget 时保留前 head 字符 + 后 tail 字符
function truncateMiddle(text, budget) {
  if (!text || text.length <= budget) return text || ''
  const head = Math.floor(budget * 0.4)
  const tail = budget - head
  const omitted = text.length - head - tail
  return `${text.slice(0, head)}\n\n... [中间省略 ${omitted} 字符] ...\n\n${text.slice(text.length - tail)}`
}

// 子进程输出解码:Windows cmd/PowerShell 的本地化消息(错误提示等)是
// GBK(CP936) 字节流,直接按 UTF-8 解会变成 '����' 乱码(实测踩坑)。
// 策略:先严格 UTF-8 解码(node/git 等现代工具的输出都能过),
// 失败(含非法字节序列,GBK 中文几乎必挂)再按 GBK 兜底。
function decodeOutput(buf) {
  if (!buf || buf.length === 0) return ''
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return iconv.decode(buf, 'gbk')
  }
}

// 子进程执行封装:stdout/stderr 原始字节累计到结束再整体解码
// (由 decodeOutput 决定真实编码,GBK 兜底);执行中若有 onOutput 回调,
// 每来一块就推一块已解码文本 —— Web 端据此把命令输出实时推给界面。
export function terminateCommand(child) {
  if (!child?.pid || child.exitCode !== null) return Promise.resolve()
  if (process.platform === 'win32') {
    return new Promise(resolve => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()))
  }
  try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch {} }
  return Promise.resolve()
}

function execCommand(command, options) {
  return new Promise((resolve) => {
    const { signal, timeout, onChild, onOutput, ...spawnOptions } = options
    let timedOut = false
    let spawnError = null
    const child = spawn(command, {
      ...spawnOptions,
      shell: true,
      detached: process.platform !== 'win32',
      windowsHide: true,
      // stdin 直接给 EOF:命令等输入时尽快失败,不再挂在永不关闭的 stdin 管道上干等超时
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    // 原始字节缓冲上限(对应 exec 时代的 maxBuffer);超限丢最老的块,保留尾部
    const MAX_BUFFER_BYTES = 32 * 1024 * 1024
    const chunks = { stdout: [], stderr: [] }
    const bytes = { stdout: 0, stderr: 0 }
    // 实时预览用增量 UTF-8 解码。GBK 输出在预览里可能显示成乱码,
    // 但最终结果仍走 decodeOutput(UTF-8 严格解码失败 → GBK 兜底),不影响回喂模型。
    const decoders = { stdout: new TextDecoder('utf-8'), stderr: new TextDecoder('utf-8') }

    const onChunk = (stream, buf) => {
      chunks[stream].push(buf)
      bytes[stream] += buf.length
      while (bytes[stream] > MAX_BUFFER_BYTES && chunks[stream].length > 1) {
        bytes[stream] -= chunks[stream].shift().length
      }
      if (typeof onOutput === 'function') {
        const text = decoders[stream].decode(buf, { stream: true })
        if (text) onOutput(text)
      }
    }
    child.stdout?.on('data', (buf) => onChunk('stdout', buf))
    child.stderr?.on('data', (buf) => onChunk('stderr', buf))
    child.on('error', (err) => { spawnError = err })

    const abort = () => { void terminateCommand(child) }
    const finish = (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve({
        code: typeof code === 'number' ? code : 1,
        killed: timedOut,
        cancelled: !!signal?.aborted,
        stdout: decodeOutput(Buffer.concat(chunks.stdout)),
        stderr: decodeOutput(Buffer.concat(chunks.stderr)),
        errorMessage: spawnError ? spawnError.message : null,
      })
    }
    child.on('close', finish)

    const timer = setTimeout(() => { timedOut = true; void terminateCommand(child) }, timeout)
    timer.unref()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    trackChild(child)
    // 把 child 暴露给 agent 循环,支持用户 Ctrl+C 时立即中止当前命令
    if (typeof onChild === 'function') onChild(child)
  })
}

// ──────────────────────────────────────────────
// 各工具实现
// ──────────────────────────────────────────────

async function toolRunCommand(args, ctx) {
  const command = String(args.command || '').trim()
  if (!command) return '错误: command 不能为空'

  // 红线检查 — 唯一硬性限制
  const danger = checkDangerousCommand(command)
  if (danger.blocked) {
    return `已拒绝执行(安全守卫): ${danger.reason}\n命令: ${command}\n如果你确认需要类似效果,请换一种不破坏系统的方式,或明确告知用户需要他手动执行。`
  }

  // 平台兼容性守卫 — 拦截"在当前 shell 里注定失败"的命令
  // (如 Windows cmd 上跑 tail/grep/ls 等 Unix-only 命令)
  const platform = await guardCommand(command)
  if (platform.blocked) {
    return `已拒绝执行(平台守卫): ${platform.reason}`
  }

  const cwd = resolvePath(ctx, args.cwd)
  const timeoutSec = resolveCommandTimeout(command, args.timeout_seconds)

  // 验证 cwd 存在,避免 exec 抛模糊错误
  try {
    const st = await fs.stat(cwd)
    if (!st.isDirectory()) return `错误: 执行目录不是目录: ${cwd}`
  } catch {
    return `错误: 执行目录不存在: ${cwd}`
  }

  // 子进程的 PATH 每次补一次注册表最新值。
  // 为什么不能直接 {...process.env}：服务端/GUI 进程的环境块是**启动快照**，
  // 用户在这个进程活着期间装的 CLI（gh 就是这么被坑的）不在里面 —— 探测侧能找到，
  // 真去执行却报"不是内部或外部命令"。详见 utils/shellPath.js 顶部。
  const baseEnv = { ...process.env, FORCE_COLOR: '0' }
  const execOptions = {
    cwd,
    timeout: timeoutSec * 1000,
    windowsHide: true,
    onChild: ctx.onChild,
    signal: ctx.signal,
    // 执行中的增量输出(Web 端推 SSE 给界面;CLI 不传,等于没有副作用)
    onOutput: ctx.onOutput,
  }
  const firstEnv = await augmentEnvPath(baseEnv)
  let result = await execCommand(command, { ...execOptions, env: firstEnv })

  // 仍然"命令找不到"时的最后一搏：大概率是上面那个补丁命中了 15s TTL 缓存
  // （缓存读取发生在这个 CLI 被装上之前）。强刷一次注册表，且**只有真的多出新目录**
  // 才重跑，避免白跑一遍命令。重跑的判据是 isCommandNotFound ——
  // 它只认"整条命令没被执行过"的说法（不含 POSIX 的 No such file or directory，
  // 那条可能只是参数文件缺失，重跑有副作用的命令是不安全的）。
  if (isCommandNotFound(result.stderr, result.errorMessage)) {
    const retryEnv = await augmentEnvPath(baseEnv, { force: true })
    if (pathValueOf(retryEnv) !== pathValueOf(firstEnv)) {
      const retry = await execCommand(command, { ...execOptions, env: retryEnv })
      if (!isCommandNotFound(retry.stderr, retry.errorMessage)) result = retry
    }
  }

  const parts = []
  if (result.cancelled) parts.push('[命令已由用户停止]')
  if (result.killed) parts.push(`[命令超时被终止(>${timeoutSec}s)]`)
  if (result.stdout) parts.push(result.stdout.trimEnd())
  if (result.stderr) parts.push(`[stderr]\n${result.stderr.trimEnd()}`)
  if (result.errorMessage) parts.push(`[执行错误] ${result.errorMessage}`)
  const output = parts.join('\n').trim()

  return [
    `$ ${command}`,
    `(exit ${result.code})`,
    output ? truncateMiddle(output, MAX_CMD_OUTPUT) : '(无输出)',
  ].join('\n')
}

async function toolReadFile(args, ctx) {
  const filePath = resolvePath(ctx, args.path)
  // 图片用 read_file 只会拿到乱码。与其让模型对着乱码猜"我看不到内容",不如当场
  // 把它推到正确的工具上 —— 这是"用户把图片路径写进普通消息"最常见的翻车点。
  if (isImagePath(filePath)) {
    return `错误: ${filePath} 是图片,read_file 按 UTF-8 解码只能得到乱码。请改用 read_image 工具读取它。`
  }
  let raw
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    return `错误: 无法读取 ${filePath}: ${err.message}`
  }
  const lines = raw.split('\n')
  const total = lines.length
  const offset = Math.max(1, Number(args.offset) || 1)
  const limit = Math.max(1, Math.min(MAX_READ_LINES, Number(args.limit) || MAX_READ_LINES))
  const slice = lines.slice(offset - 1, offset - 1 + limit)
  const numbered = slice.map((line, i) => {
    const text = line.length > MAX_LINE_WIDTH ? line.slice(0, MAX_LINE_WIDTH) + ' ...[行截断]' : line
    return `${offset + i}→${text}`
  })
  const header = total > limit
    ? `# ${filePath} (共 ${total} 行, 显示 ${offset}-${offset + slice.length - 1})`
    : `# ${filePath} (共 ${total} 行)`
  return `${header}\n${numbered.join('\n')}`
}

/**
 * read_image —— 本仓唯一返回**非字符串**的处理器。
 *
 * 返回 { text, images },由 agent 循环(turn.js / agentChat.js)用 toolMessageContent()
 * 拼成多模态 tool 消息。这里只管校验 + 转 data URL,不发请求。
 */
async function toolReadImage(args, ctx) {
  const filePath = resolvePath(ctx, args.path)
  if (!isImagePath(filePath)) {
    return `错误: ${filePath} 不是支持的图片格式(仅 ${SUPPORTED_IMAGE_EXTS})。文本文件请用 read_file。`
  }
  const img = await checkImageFile(filePath)
  if (!img) {
    return `错误: 无法读取图片 ${filePath}:文件不存在、不是普通文件,或内容为空。`
  }
  if (img.bytes > MAX_IMAGE_BYTES) {
    return `错误: 图片 ${filePath} 有 ${formatBytes(img.bytes)},超过单张上限 ${formatBytes(MAX_IMAGE_BYTES)}。`
      + '(图片会以 base64 每轮重发,过大会顶穿上下文。)请先用 run_command 压缩后再读。'
  }
  let url
  try {
    url = await imageToDataUrl(filePath)
  } catch (err) {
    return `错误: 读取图片 ${filePath} 失败: ${err.message}`
  }
  return {
    text: `已读取图片 ${filePath}(${formatBytes(img.bytes)})。`
      + '图片已附在本条工具结果里 —— 直接基于你实际看到的内容回答,不要再 read_file 它。',
    images: [url],
  }
}

async function toolWriteFile(args, ctx) {
  const filePath = resolvePath(ctx, args.path)
  const content = String(args.content ?? '')
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content, 'utf-8')
    return `已写入 ${filePath} (${content.length} 字符)`
  } catch (err) {
    return `错误: 写入 ${filePath} 失败: ${err.message}`
  }
}

async function toolEditFile(args, ctx) {
  const filePath = resolvePath(ctx, args.path)
  const oldStr = String(args.old_string ?? '')
  const newStr = String(args.new_string ?? '')
  if (!oldStr) return '错误: old_string 不能为空'
  if (oldStr === newStr) return '错误: old_string 与 new_string 相同,无需修改'

  let raw
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    return `错误: 无法读取 ${filePath}: ${err.message}`
  }

  // 统计出现次数(手写 indexOf 循环,避免正则转义问题)
  let count = 0
  let idx = raw.indexOf(oldStr)
  while (idx !== -1) {
    count++
    idx = raw.indexOf(oldStr, idx + oldStr.length)
  }

  if (count === 0) {
    return `错误: 在 ${filePath} 中找不到 old_string。请先用 read_file 确认文件的精确内容(注意缩进/换行/空白必须完全一致)。`
  }
  if (count > 1 && !args.replace_all) {
    return `错误: old_string 在 ${filePath} 中出现 ${count} 次,不唯一。请提供更多上下文让它唯一,或显式传 replace_all=true 全部替换。`
  }

  const updated = args.replace_all ? raw.split(oldStr).join(newStr) : raw.replace(oldStr, () => newStr)
  try {
    await fs.writeFile(filePath, updated, 'utf-8')
    return `已修改 ${filePath} (替换 ${args.replace_all ? count : 1} 处)`
  } catch (err) {
    return `错误: 写入 ${filePath} 失败: ${err.message}`
  }
}

async function toolListFiles(args, ctx) {
  const dir = resolvePath(ctx, args.path)
  const maxDepth = Math.max(1, Math.min(6, Number(args.depth) || 2))
  const entries = []
  let overflow = false

  async function walk(current, depth, prefix) {
    if (entries.length >= MAX_LIST_ENTRIES) { overflow = true; return }
    let items
    try {
      items = await fs.readdir(current, { withFileTypes: true })
    } catch (err) {
      entries.push(`${prefix}[无法读取: ${err.message}]`)
      return
    }
    // 目录在前,文件在后,各自按名字排序
    items.sort((a, b) => (Number(b.isDirectory()) - Number(a.isDirectory())) || a.name.localeCompare(b.name))
    for (const item of items) {
      if (entries.length >= MAX_LIST_ENTRIES) { overflow = true; return }
      if (item.isDirectory()) {
        // 跳过产物/依赖/隐藏目录,避免列表被 node_modules 之类淹没
        if (SKIP_DIRS.has(item.name) || item.name.startsWith('.')) continue
        entries.push(`${prefix}${item.name}/`)
        if (depth < maxDepth) await walk(path.join(current, item.name), depth + 1, `${prefix}  `)
      } else {
        entries.push(`${prefix}${item.name}`)
      }
    }
  }

  try {
    const st = await fs.stat(dir)
    if (!st.isDirectory()) return `错误: 不是目录: ${dir}`
  } catch {
    return `错误: 目录不存在: ${dir}`
  }

  await walk(dir, 1, '')
  const suffix = overflow ? `\n... [超过 ${MAX_LIST_ENTRIES} 条,已截断,请缩小 depth 或指定子目录]` : ''
  return `# ${dir}\n${entries.join('\n')}${suffix}`
}

async function toolSearchText(args, ctx) {
  const dir = resolvePath(ctx, args.path)
  let regex
  try {
    regex = new RegExp(String(args.pattern), args.ignore_case ? 'i' : '')
  } catch (err) {
    return `错误: 正则无效: ${err.message}`
  }
  const extFilter = args.ext
    ? new Set(String(args.ext).split(',').map(e => e.trim().replace(/^\./, '').toLowerCase()).filter(Boolean))
    : null

  const hits = []
  let scanned = 0
  let overflow = false

  // 在单个文件内匹配各行(path 直接指向文件时走这个分支 ——
  // 模型经常拿文件路径来搜,兼容掉,别让它吃"不是目录"的错)
  async function searchOneFile(full) {
    let text
    try { text = await fs.readFile(full, 'utf-8') } catch { return }
    scanned++
    const lines = text.split('\n')
    for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i++) {
      regex.lastIndex = 0
      if (regex.test(lines[i])) {
        hits.push(`${path.relative(ctx.cwd, full) || full}:${i + 1}: ${lines[i].trim().slice(0, 300)}`)
      }
    }
  }

  async function walk(current, depth) {
    if (hits.length >= MAX_SEARCH_HITS || depth > 12) { if (depth > 12) return; overflow = true; return }
    let items
    try { items = await fs.readdir(current, { withFileTypes: true }) } catch { return }
    for (const item of items) {
      if (hits.length >= MAX_SEARCH_HITS) { overflow = true; return }
      const full = path.join(current, item.name)
      if (item.isDirectory()) {
        if (SKIP_DIRS.has(item.name) || item.name.startsWith('.')) continue
        await walk(full, depth + 1)
      } else {
        const ext = path.extname(item.name).toLowerCase()
        if (BINARY_EXTS.has(ext) || BINARY_EXTS.has(item.name.toLowerCase())) continue
        if (extFilter && !extFilter.has(ext.replace('.', ''))) continue
        let st
        try { st = await fs.stat(full) } catch { continue }
        if (st.size > MAX_SEARCH_FILE_SIZE) continue
        await searchOneFile(full)
      }
    }
  }

  let st
  try {
    st = await fs.stat(dir)
  } catch {
    return `错误: 路径不存在: ${dir}`
  }
  // 文件:直接搜它自己(忽略 ext 过滤 — 用户/模型明确指名了这个文件)
  if (!st.isDirectory()) {
    if (st.size > MAX_SEARCH_FILE_SIZE) return `错误: 文件过大(${(st.size / 1024 / 1024).toFixed(1)}MB),请用 read_file 分段查看`
    await searchOneFile(dir)
    if (hits.length === 0) return `未找到匹配 "${args.pattern}" 的内容(已扫描 1 个文件)`
    return hits.join('\n')
  }

  await walk(dir, 1)
  if (hits.length === 0) return `未找到匹配 "${args.pattern}" 的内容(已扫描 ${scanned} 个文件)`
  const suffix = overflow ? `\n... [超过 ${MAX_SEARCH_HITS} 条命中,已截断,请缩小范围或加 ext 过滤]` : ''
  return `${hits.join('\n')}${suffix}`
}

// list_projects 的数据源刻意不在本文件里:最近目录 / tasks.json / 看板统计都是
// GUI 侧的东西,CLI 与 Web 共用的这个模块只该知道"有这么个工具"。
// 由 GUI 侧(workbench/agentRoutes.js)把实现注入 ctx.listProjects ——
// 与 ask_user 依赖 ctx.askUser 同一手法:没有实现时给一句能照着做的话,而不是崩掉。
async function toolListProjects(args, ctx) {
  if (typeof ctx.listProjects !== 'function') {
    return '错误: list_projects 只在 g ui(GUI 界面)的内置智能体里可用。'
      + '命令行 g ai 下请改用 run_command 直接跑 git 命令,例如 '
      + 'git -C <项目路径> status -sb 与 git -C <项目路径> log --oneline @{u}..'
  }
  return ctx.listProjects({ refresh: args.refresh === true })
}

async function toolAskUser(args, ctx) {
  const question = String(args.question || '').trim()
  if (!question) return 'Error: ask_user requires a non-empty question.'
  if (typeof ctx.askUser !== 'function') {
    return 'Error: ask_user is unavailable in one-shot mode; continue without asking the user.'
  }

  const options = Array.isArray(args.options)
    ? args.options.map(option => String(option || '').trim()).filter(Boolean).slice(0, 20)
    : []
  const allowFreeText = options.length === 0 || args.allow_free_text !== false
  // 多选只在真的给了选项时才有意义
  const multiple = args.multiple === true && options.length > 0
  return ctx.askUser({ question, options, allowFreeText, multiple })
}

// update_plan 是个**纯展示**工具:它不改文件、不执行命令,只回一句确认。
// 归一化在这里做完(而不是散给各端):CLI / 控制台 / Web 面板三处都拿同一份
// 计划,谁渲染都别再自己解析一遍模型给的原始 JSON。
const MAX_PLAN_STEPS = 20
const MAX_PLAN_EXPLANATION = 600

const PLAN_STATUS_ALIASES = new Map([
  ['completed', 'completed'], ['complete', 'completed'], ['done', 'completed'], ['finished', 'completed'],
  ['in_progress', 'in_progress'], ['inprogress', 'in_progress'], ['in-progress', 'in_progress'],
  ['active', 'in_progress'], ['doing', 'in_progress'], ['running', 'in_progress'],
  ['pending', 'pending'], ['todo', 'pending'], ['not_started', 'pending'],
])

// 归一化后的计划类工具名。归一化 = 小写 + 去掉分隔符,于是 update_plan /
// updatePlan / update-plan 落到同一个键上。
// 前端组件库(zen-ai-chat-ui)里另有一份同名判定 —— 浏览器端不能反过来依赖
// 这个 Node 模块,两边各留一份是刻意的边界,不是重复代码。
const PLAN_TOOL_NAMES = new Set([
  'updateplan', 'writetodos', 'todowrite', 'todotrite', 'todorewrite', 'createplan', 'setplan', 'plan'
])

/** 这个工具名是不是计划类 */
export function isPlanToolName(name) {
  return PLAN_TOOL_NAMES.has(String(name || '').toLowerCase().replace(/[^a-z]/g, ''))
}

/** 计划步骤归一化:接受 content/text/title/task,状态词收敛成 pending/in_progress/completed */
export function normalizePlanSteps(raw) {
  const list = Array.isArray(raw) ? raw : []
  const steps = []
  for (const item of list.slice(0, MAX_PLAN_STEPS)) {
    const obj = typeof item === 'string' ? { content: item } : item
    if (!obj || typeof obj !== 'object') continue
    const content = String(obj.content ?? obj.text ?? obj.title ?? obj.task ?? '').replace(/\s+/g, ' ').trim()
    if (!content) continue
    const rawStatus = String(obj.status ?? obj.state ?? '').trim().toLowerCase()
    steps.push({
      content: content.slice(0, 200),
      status: PLAN_STATUS_ALIASES.get(rawStatus) || 'pending'
    })
  }
  return steps
}

/** 计划状态摘要:`3 步(1 完成 / 1 进行中 / 1 待办)` */
export function summarizePlan(steps) {
  const list = Array.isArray(steps) ? steps : []
  if (!list.length) return '0 步'
  const done = list.filter(s => s.status === 'completed').length
  const active = list.filter(s => s.status === 'in_progress').length
  const pending = list.length - done - active
  const parts = [`${done} 完成`]
  if (active) parts.push(`${active} 进行中`)
  if (pending) parts.push(`${pending} 待办`)
  return `${list.length} 步(${parts.join(' / ')})`
}

async function toolUpdatePlan(args) {
  const rawSteps = args.steps ?? args.todos ?? args.plan
  if (rawSteps !== undefined && !Array.isArray(rawSteps)) {
    return '错误: update_plan 的 steps 必须是数组，形如 [{"content":"做 X","status":"pending"}]。'
  }
  const steps = normalizePlanSteps(rawSteps)
  const explanation = String(args.explanation ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_PLAN_EXPLANATION)
  if (Array.isArray(rawSteps) && rawSteps.length && !steps.length) {
    return '错误: 每一步都要有 content(一句话说明这一步做什么);请重发完整 steps。'
  }
  // 不存任何全局状态:计划是**当前快照**,天然能从这轮 tool_call 的参数复原。
  // 终端画清单(Web 面板渲染清单)都直接读参数,谁都不用维护第二份真相。
  if (!steps.length) return '计划已清空(任务收尾)。'
  return `计划已更新:${summarizePlan(steps)}${explanation ? ` —— ${explanation}` : ''}`
}

// dispatch_task 与 list_projects 同一条边界：工具的**定义**在这里（CLI 与 Web 共用
// 这份表），而"派到哪儿、怎么建任务、用哪个执行器"全是 GUI 侧的事。
// 由 GUI 侧(workbench/agentRoutes.js)把实现注入 ctx.dispatchTask —— 注入的时机还带
// 一层开关：只有主 Agent 控制台发起的对话才注入（见 agentRoutes 里 allowDispatch 的注释）。
// 没有实现时给一句能照着做的话，而不是崩掉、也不是让模型反复重试。
async function toolDispatchTask(args, ctx) {
  const text = String(args.text || '').trim()
  if (!text) return '错误: dispatch_task 需要非空的 text —— 要派给那个 agent 的完整指令。'
  if (typeof ctx.dispatchTask !== 'function') {
    return '错误: dispatch_task 只在 g ui 的「主 Agent 控制台」（工作台右栏）里可用，当前入口没有派发能力。'
      + '不要重试这个工具，也不要假装已经派出去：直接回答用户；'
      + '如果用户确实想派活，告诉他到主 Agent 控制台里说这句话。'
  }

  const payload = { text }
  if (typeof args.project_path === 'string' && args.project_path.trim()) {
    payload.projectPath = args.project_path.trim()
  }
  if (typeof args.executor === 'string' && args.executor.trim()) {
    payload.executor = args.executor.trim()
  }
  // 只有显式 false 才改变默认：省略 = 跟随控制台的默认行为
  if (args.auto_run === false) payload.autoRun = false
  if (args.use_default_prompt === false) payload.useDefaultPrompt = false
  return ctx.dispatchTask(payload)
}

// schedule_task：定时任务的登记与管理。
//
// 与 dispatch_task 的注入模式不同：它不依赖 GUI 层的 configManager / 任务系统，
// 实现就落在 CLI 与 GUI 共享的任务库（utils/scheduleStore.js）上，所以两个入口
// 直接可用、无需 ctx 注入。但**谁执行**必须说清楚：CLI 是即用即走的进程，
// 不做调度；真正到点跑的是 g ui 服务端的调度器。工具结果里要把这个边界讲明白
// —— 否则模型会向用户承诺"到点我会自动跑"，而 g ui 不开时那句话就是错的。
async function toolScheduleTask(args, ctx) {
  const action = String(args.action || 'create').trim().toLowerCase()
  try {
    switch (action) {
      case 'create': {
        const name = String(args.name || '').trim()
        if (!name) return '错误: create 需要 name（任务名，如「每日拉代码」）。'
        const schedule = String(args.schedule || '').trim()
        if (!schedule) return '错误: create 需要 schedule（cron 表达式，如 "0 9 * * *"）。'
        const prompt = String(args.prompt || '').trim()
        if (!prompt) return '错误: create 需要 prompt（到点后要执行什么）。'
        const cwd = String(args.cwd || ctx.cwd || '').trim()
        if (!cwd) return '错误: 无法确定项目目录，请显式传 cwd。'
        const task = await createTask({
          name,
          schedule,
          prompt,
          cwd,
          onMissed: args.on_missed === 'skip' ? 'skip' : 'run',
          locale: String(ctx?.locale || 'zh').startsWith('en') ? 'en' : 'zh',
        })
        const next = nextFireAfter(task.schedule, new Date())
        return `已创建定时任务「${task.name}」（id: ${task.id}，目录: ${task.cwd}）。`
          + `计划: ${task.schedule}；下次执行: ${next ? next.toLocaleString() : '无法计算'}。`
          + '注意：任务由 g ui 服务端的调度器执行 —— 如果那一刻 g ui 没在运行，这一轮不会跑'
          + `（on_missed=${task.onMissed}：${task.onMissed === 'run' ? 'g ui 重新运行后会补跑一次' : 'g ui 重新运行后直接跳过'}）。`
          + '每轮执行结果都会落进该任务的专属会话，用户随时可以回看。'
      }
      case 'list': {
        const tasks = await loadTasks()
        if (tasks.length === 0) return '当前没有任何定时任务。'
        const lines = tasks.map((t) => {
          const state = t.enabled ? '启用' : '停用'
          const last = t.lastRun ? `；上次 ${t.lastRun.status} @ ${t.lastRun.at}` : '；还没跑过'
          const next = t.enabled ? nextFireAfter(t.schedule, new Date()) : null
          const nextStr = next ? `；下次 ${next.toLocaleString()}` : ''
          return `- [${state}] ${t.name} | ${t.schedule} | 目录 ${t.cwd} | 提示词: ${t.prompt.slice(0, 60)}${t.prompt.length > 60 ? '…' : ''} | id=${t.id}${last}${nextStr}`
        })
        return `共 ${tasks.length} 个定时任务：\n${lines.join('\n')}`
      }
      case 'remove': {
        const id = String(args.id || '').trim()
        if (!id) return '错误: remove 需要 id（先用 list 查看）。'
        await deleteTask(id)
        return `已删除定时任务 ${id}。`
      }
      case 'enable':
      case 'disable': {
        const id = String(args.id || '').trim()
        if (!id) return `错误: ${action} 需要 id（先用 list 查看）。`
        const task = await updateTask(id, { enabled: action === 'enable' })
        return `已${action === 'enable' ? '启用' : '停用'}定时任务「${task.name}」(${task.id})。`
      }
      default:
        return `错误: 未知的 action "${action}"，支持 create / list / remove / enable / disable。`
    }
  } catch (err) {
    return `错误: ${err?.message || String(err)}`
  }
}

// ──────────────────────────────────────────────
// 工具分发
// ──────────────────────────────────────────────
const TOOL_HANDLERS = {
  run_command: toolRunCommand,
  read_file: toolReadFile,
  read_image: toolReadImage,
  write_file: toolWriteFile,
  edit_file: toolEditFile,
  list_files: toolListFiles,
  search_text: toolSearchText,
  list_projects: toolListProjects,
  update_plan: toolUpdatePlan,
  ask_user: toolAskUser,
  dispatch_task: toolDispatchTask,
  schedule_task: toolScheduleTask,
}

/**
 * 执行一个工具调用,返回字符串结果(直接作为 role:'tool' 消息内容)。
 * 所有异常都在内部消化成字符串,不向外抛。
 *
 * **唯一例外**:read_image 返回 { text, images }。调用方必须先过 splitToolOutput()
 * 再决定怎么用 —— 直接把返回值当字符串会得到 "[object Object]"。
 *
 * @param {string} name - 工具名
 * @param {object} args - 已解析的参数对象
 * @param {{ cwd: string, onChild?: (child: object) => void }} ctx
 * @returns {Promise<string | { text: string, images: string[] }>}
 */
export async function executeTool(name, args, ctx) {
  if (ctx.signal?.aborted) return 'Cancelled by user; this tool was not executed.'
  const handler = TOOL_HANDLERS[name]
  if (!handler) return `错误: 未知工具 "${name}",可用工具: ${Object.keys(TOOL_HANDLERS).join(', ')}`
  try {
    return await handler(args || {}, ctx)
  } catch (err) {
    return `错误: 工具 ${name} 执行异常: ${err.message}`
  }
}

/**
 * 把 executeTool 的返回值归一化成 { text, images }。
 * 字符串(绝大多数工具)→ images 为空;对象(read_image)→ 取出 text 与 data URL 列表。
 * 两个 agent 循环(turn.js / agentChat.js)必须都走这里,否则又会长出第二套口径。
 *
 * @param {unknown} output
 * @returns {{ text: string, images: string[] }}
 */
export function splitToolOutput(output) {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    return {
      text: typeof output.text === 'string' ? output.text : String(output.text ?? ''),
      images: Array.isArray(output.images) ? output.images.filter(u => typeof u === 'string') : [],
    }
  }
  return { text: typeof output === 'string' ? output : String(output ?? ''), images: [] }
}

/**
 * 构造 role:'tool' 消息的 content。
 * 没有图片时返回纯字符串 —— 老链路的序列化、截断、厂商兼容性一个字都不用改;
 * 有图片时才升级成多模态数组(OpenAI 兼容格式里 tool 消息的 content 部件)。
 *
 * @param {string} text
 * @param {string[]} images - data URL 列表
 * @returns {string | Array<{type: string, text?: string, image_url?: {url: string}}>}
 */
export function toolMessageContent(text, images) {
  if (!Array.isArray(images) || images.length === 0) return text
  return [
    { type: 'text', text },
    ...images.map(url => ({ type: 'image_url', image_url: { url } })),
  ]
}

export default { TOOL_DEFINITIONS, executeTool, splitToolOutput, toolMessageContent }
