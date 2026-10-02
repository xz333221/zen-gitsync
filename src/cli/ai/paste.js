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
// g ai 输入层的多行粘贴支持(bracketed paste)
//
// 背景:Node 内建 readline **不支持 bracketed paste** —— 它从不发 \x1b[?2004h 去请求
// 终端包夹粘贴,也不认 \x1b[200~ / \x1b[201~。于是终端把粘贴原样发字节,粘贴里每个 \n
// 都被 readline 当成 Enter:一次粘贴 = 多次提交,而第 2 条起会撞上 agent.js 的 busy 分支
// 被丢弃 —— 用户粘的 4 行 .env 只有第一行真的发给了模型。
//
// 方案:
//   1. 自己开 bracketed paste(终端从此把整段粘贴包在 200~/201~ 之间)
//   2. 在数据进 readline **之前**把整段内容抠出来存进内存(createPasteStore)
//   3. 输入行里只放一个短占位符(如 `[粘贴 #1 · 4 行]`)
//   4. 提交时把占位符还原成原文(带真实换行)再交给模型
//
// 这样换来三件事:一次粘贴 = 一条消息;粘贴里的控制字符/转义序列根本进不了 readline
// (不会污染输入行);长粘贴不会把输入行撑成几十行。
//
// 拦截点:input.emit('data')。readline 的键位解析、回显、光标、历史全部照旧,我们只在
// 数据流上做一层"改写" —— 这也是唯一能抢在 readline 解析之前的钩子(readline 的
// keypress 是在 'data' 监听里同步派发的,光靠加监听器改不了它读到的内容)。
//
// 未启用/不支持的终端(旧 conhost、CI、管道):拿不到 200~/201~ 标记,一切照旧 ——
// 这个模块在数据流上不产生任何行为,不会把原本能用的输入搞坏。

import { StringDecoder } from 'node:string_decoder'

export const PASTE_START = '\x1b[200~'
export const PASTE_END = '\x1b[201~'

// 判定"这段数据可能含粘贴标记"的探针。取 `\x1b[20` 而不是完整的 `\x1b[200~`:
// 标记可能被切在两个 chunk 里(只剩前半截),探针短一点才能命中。
// 副作用是 F9(\x1b[20~)之类也会走改写路径 —— 解析器找不到起止标记就原样返回,无影响。
const MARKER_NEEDLE = '\x1b[20'

const DEFAULT_FLUSH_MS = 1200    // 只收到起始标记、迟迟等不到结束标记时的兜底(见 kickTimer)
const DEFAULT_MAX_ENTRIES = 200
const DEFAULT_MAX_CHARS = 4 * 1024 * 1024

/** 粘贴原文归一化:CRLF/CR → LF,并去掉复制时最常见的那个行尾换行 */
export function normalizePasteText(raw) {
  return String(raw ?? '').replace(/\r\n?/g, '\n').replace(/\n$/, '')
}

/** 默认占位符文案(agent.js 会传本地化版本进来) */
function defaultFormatToken({ index, lines }) {
  return `[paste #${index} · ${lines} lines]`
}

/**
 * 粘贴内容仓库:token ↔ 原文。
 *
 * token 直接当 Map 的 key,**不用正则解析** —— 这样占位符文案可以随语言自由变化,
 * 还原时只认"自己发出去过的那个字符串",不会误伤用户手打的普通方括号文本。
 *
 * 容量:超过 maxEntries / maxChars 时淘汰最旧的(粘贴内容常是几 KB 的配置/日志)。
 * 被淘汰的 token 记在 known 里,submit 时若又出现就报告 stale —— 场景是"很久以前从
 * 历史里召回了带旧占位符的那行",此时原文已不在内存,必须让用户知道而不是静默出错。
 */
export function createPasteStore({
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxChars = DEFAULT_MAX_CHARS,
  formatToken = defaultFormatToken,
} = {}) {
  const entries = new Map()   // token -> 原文
  const known = new Set()     // 发出去过的所有 token(含已淘汰的)
  let seq = 0
  let chars = 0

  return {
    /** 存一段粘贴原文,返回要插进输入行的占位符(内容为空则返回空串,不占位) */
    add(rawText) {
      const text = normalizePasteText(rawText)
      if (!text) return ''
      seq += 1
      const token = formatToken({ index: seq, lines: text.split('\n').length, chars: text.length })
      entries.set(token, text)
      known.add(token)
      chars += text.length
      while (entries.size > maxEntries || chars > maxChars) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        chars -= entries.get(oldest).length
        entries.delete(oldest)
      }
      return token
    },

    /**
     * 还原一行输入里的所有占位符。
     * @returns {{text:string, used:number, stale:string[]}}
     *   used  = 命中的占位符个数(>0 表示这行确实用了粘贴,调用方据此决定要不要回显)
     *   stale = 原文已不在内存的占位符(调用方应提醒用户重新粘贴)
     */
    expand(line) {
      const text = String(line ?? '')
      if (entries.size === 0) return { text, used: 0, stale: [] }
      let out = text
      let used = 0
      for (const [token, body] of entries) {
        if (!out.includes(token)) continue
        out = out.split(token).join(body)
        used += 1
      }
      const stale = []
      // 只有淘汰发生过(known 比 entries 大)才需要扫,平时零成本
      if (known.size > entries.size) {
        for (const token of known) {
          if (!entries.has(token) && out.includes(token)) stale.push(token)
        }
      }
      return { text: out, used, stale }
    },

    get size() {
      return entries.size
    },
    /** 诊断/测试用 */
    knownTokens() {
      return [...known]
    },
  }
}

/** buffer 末尾是否是 marker 的前缀(跨 chunk 被切断)→ 返回要留到下一块的字符数 */
function markerPrefixSuffix(buf, marker) {
  const max = Math.min(buf.length, marker.length - 1)
  for (let n = max; n > 0; n--) {
    if (buf.endsWith(marker.slice(0, n))) return n
  }
  return 0
}

/**
 * 粘贴数据流过滤器:把流里的 `200~…201~` 段替换成占位符。
 *
 * 跨越 chunk 的状态(半个标记、未闭合的粘贴)都存在闭包里,所以可以放心地把
 * 任意切分的 chunk 依次喂进来。
 *
 * @param {object} opts
 * @param {ReturnType<typeof createPasteStore>} opts.store
 * @param {(text:string)=>void} [opts.onFlush] - 兜底关闭粘贴时把占位符补写回流(见 kickTimer)
 * @param {number} [opts.flushDelayMs]
 */
export function createPasteFilter({ store, onFlush, flushDelayMs = DEFAULT_FLUSH_MS } = {}) {
  const decoder = new StringDecoder('utf8')
  let pending = ''      // 上块末尾可能是标记前缀的残字节
  let content = ''      // 正在收集的粘贴原文
  let inPaste = false
  let timer = null

  const clearTimer = () => {
    if (timer) { clearTimeout(timer); timer = null }
  }

  // 兜底:只收到 200~ 却一直等不到 201~ 时(终端异常/连接断了),不能无限吞输入 ——
  // 否则用户之后敲的每个字符都被当成粘贴内容吃掉,输入行彻底卡死。
  // 每收到一块数据就重置计时,所以正常粘贴(哪怕几十 MB、跨很多 chunk)不会被误伤。
  const kickTimer = () => {
    clearTimer()
    if (!Number.isFinite(flushDelayMs) || flushDelayMs <= 0) return
    timer = setTimeout(() => {
      timer = null
      if (!inPaste) return
      try {
        onFlush?.(closePaste())
      } catch { /* 兜底路径出问题也不能炸掉会话 */ }
    }, flushDelayMs)
    timer.unref?.()
  }

  // 结束一段粘贴:内容入库 → 返回占位符(空内容返回空串,等于把这段整个吞掉)
  const closePaste = () => {
    const token = store.add(content)
    content = ''
    inPaste = false
    clearTimer()
    return token
  }

  const toText = (chunk) => {
    if (typeof chunk === 'string') {
      // 正常路径下 stdin 不会设 encoding;万一设了,先把解码器里残留的半个字符吐出来
      const rest = decoder.end()
      return rest + chunk
    }
    return decoder.write(chunk)
  }

  return {
    /**
     * 这块数据要不要走改写。
     * 普通打字(不含 ESC)直接返回 false → 原样透传,Buffer 不会被转成字符串,
     * 也就完全不影响 readline 自己的多字节解码。
     */
    needsRewrite(chunk) {
      if (inPaste || pending) return true
      if (typeof chunk === 'string') return chunk.includes(MARKER_NEEDLE)
      return chunk.includes(0x1b)
    },

    /** 喂一块数据,返回要交给 readline 的文本 */
    push(chunk) {
      let buf = pending + toText(chunk)
      pending = ''
      let out = ''
      while (buf.length > 0) {
        if (!inPaste) {
          const start = buf.indexOf(PASTE_START)
          if (start < 0) {
            const keep = markerPrefixSuffix(buf, PASTE_START)
            out += buf.slice(0, buf.length - keep)
            pending = buf.slice(buf.length - keep)
            break
          }
          out += buf.slice(0, start)
          buf = buf.slice(start + PASTE_START.length)
          inPaste = true
          content = ''
          kickTimer()
          continue
        }
        const end = buf.indexOf(PASTE_END)
        if (end < 0) {
          const keep = markerPrefixSuffix(buf, PASTE_END)
          content += buf.slice(0, buf.length - keep)
          pending = buf.slice(buf.length - keep)
          kickTimer()
          break
        }
        content += buf.slice(0, end)
        buf = buf.slice(end + PASTE_END.length)
        out += closePaste()
      }
      return out
    },

    /** 结束标记一直没来时的收尾(定时器与 dispose 共用) */
    flush() {
      return inPaste ? closePaste() : ''
    },

    dispose() {
      clearTimer()
      pending = ''
      content = ''
      inPaste = false
    },

    get inPaste() {
      return inPaste
    },
  }
}

/** 终端/环境是否支持(且被允许)开 bracketed paste */
export function bracketedPasteEnabled(env = process.env, stream = process.stdout) {
  if (env.ZEN_AI_NO_BRACKETED_PASTE) return false   // 终端不兼容时的逃生开关
  if (!stream?.isTTY) return false
  if (env.TERM === 'dumb') return false
  return true
}

/** 开 bracketed paste(DECSET 2004)。重复调用无副作用 —— 幂等,可用来在被外部程序关掉后重申 */
export function enableBracketedPaste(write = (s) => process.stdout.write(s), options = {}) {
  if (!bracketedPasteEnabled(options.env, options.stream)) return false
  write('\x1b[?2004h')
  return true
}

/** 关 bracketed paste。退出前必须调用,否则终端会一直把粘贴包夹住 */
export function disableBracketedPaste(write = (s) => process.stdout.write(s), options = {}) {
  if (!bracketedPasteEnabled(options.env, options.stream)) return false
  write('\x1b[?2004l')
  return true
}

/**
 * 把粘贴捕获装到 readline 实例上。
 *
 * 做三件事:改 input.emit('data')、包一层 rl.question、开 bracketed paste。
 * rl.question 必须单独包:`question` 进行中时 readline 直接把 this.line 交给回调,
 * **不触发 'line' 事件**(实测 line 事件数为 0)—— 只拦 'data' 的话,向导里粘贴的
 * 内容会以占位符形式落到答案里。
 *
 * @param {import('node:readline').Interface} rl
 * @param {object} [options]
 * @param {ReturnType<typeof createPasteStore>} [options.store]
 * @param {(meta:{index:number,lines:number,chars:number})=>string} [options.formatToken]
 * @returns {null | {store, expand, dispose}}
 */
export function installPasteCapture(rl, options = {}) {
  const input = rl?.input
  // 拿不到可改写的输入流时给一个空实现,而不是 null —— 调用方(agent.js)可以无条件
  // 使用 expand/dispose,不必到处判空
  if (!input || typeof input.emit !== 'function') {
    return {
      store: options.store || createPasteStore({ formatToken: options.formatToken }),
      expand: (line) => ({ text: String(line ?? ''), used: 0, stale: [] }),
      dispose() {},
    }
  }

  const store = options.store || createPasteStore({ formatToken: options.formatToken })
  const hadOwnEmit = Object.prototype.hasOwnProperty.call(input, 'emit')
  const previousEmit = input.emit
  const callThrough = (...args) => previousEmit.apply(input, args)
  const filter = createPasteFilter({
    store,
    flushDelayMs: options.flushDelayMs,
    // 兜底关闭时占位符已经在数据流之后了,直接把它当一块数据补回去
    onFlush: (text) => { if (text) callThrough('data', text) },
  })

  const patchedEmit = function (event, ...args) {
    if (event !== 'data') return callThrough(event, ...args)
    const chunk = args[0]
    if (!filter.needsRewrite(chunk)) return callThrough(event, ...args)
    return callThrough(event, filter.push(chunk))
  }
  input.emit = patchedEmit

  const previousQuestion = rl.question
  if (typeof previousQuestion === 'function') {
    rl.question = function patchedQuestion(query, optsOrCb, maybeCb) {
      if (typeof optsOrCb === 'function') {
        return previousQuestion.call(this, query, (answer) => optsOrCb(store.expand(answer).text))
      }
      return previousQuestion.call(this, query, optsOrCb, (answer) => maybeCb(store.expand(answer).text))
    }
  }

  enableBracketedPaste()

  return {
    store,
    expand: (line) => store.expand(line),
    dispose() {
      filter.dispose()
      if (input.emit === patchedEmit) {
        if (hadOwnEmit) input.emit = previousEmit
        else delete input.emit
      }
      if (typeof previousQuestion === 'function') rl.question = previousQuestion
      disableBracketedPaste()
    },
  }
}

export default {
  PASTE_START,
  PASTE_END,
  normalizePasteText,
  createPasteStore,
  createPasteFilter,
  installPasteCapture,
  bracketedPasteEnabled,
  enableBracketedPaste,
  disableBracketedPaste,
}
