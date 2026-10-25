import { executeTool, splitToolOutput, toolMessageContent, splitToolBatches } from './tools.js'
import { streamChatOnce } from './transport.js'
import { createThinkFilter } from './streamFilter.js'
import { imageToDataUrl } from './images.js'
import { prepareRequestMessages } from './context.js'
import { createTurnStats, addUsage, accumulateSessionStats } from './telemetry.js'
import { recordTurnTiming } from './sessionStore.js'
import * as terminal from './termui.js'

// 「等人」型工具:执行期间会接管输入行、停下来等用户作答(目前只有 ask_user)。
// 这类工具不能转工具 spinner —— ora 每 80ms 在同一行 clearLine + 重绘,会把
// readline 刚画出的提示符(「请输入序号或直接输入回答:」)连同用户正在敲的字
// 一起清掉,屏幕上只剩下一个不断跳秒数的「执行 ask_user...」,看起来就像"选不了"。
// 它自己的交互界面(问题 + 编号选项 + 提示符)就是进度提示,不需要再叠一层。
const INTERACTIVE_TOOLS = new Set(['ask_user'])

// 取消时回给模型的占位文本(串行/并发两条路径共用一份口径)
const NOT_EXECUTED = 'Cancelled by user; this tool was not executed.'

export async function runAgentTurn(state, userText, t, images = [], dependencies = {}) {
  const chat = dependencies.chat || streamChatOnce
  const baseExecute = dependencies.execute || executeTool
  // 扩展(目前是 MCP)工具按名字分流:名字属于扩展就走扩展,否则回落内置工具。
  // 必须先用 owns() 判断 —— 不能把所有调用都先喂给扩展再靠 null 回落,
  // 那样每个内置工具都会多绕一层,而且扩展端也无法假设"进来的都是自己的"。
  // 没装扩展时 owns() 恒为 false,等价于直接调内置工具,零开销。
  const extensions = dependencies.extensions || state.extensions
  const execute = extensions
    ? async (name, args, ctx) => {
        if (extensions.owns?.(name)) {
          const output = await extensions.execute(name, args, ctx)
          if (output !== null && output !== undefined) return output
        }
        return baseExecute(name, args, ctx)
      }
    : baseExecute
  const ui = { ...terminal, ...dependencies.ui }
  const stats = createTurnStats()
  const started = performance.now()
  const cancelled = () => state.cancelRequested || state.abortController?.signal.aborted
  const checkpoint = () => state.persistSession?.()
  const recordUsage = usage => {
    if (!usage) return
    stats.usageRequests++
    stats.usage = addUsage(stats.usage, usage)
  }
  // 本轮是第几轮（0 基 user 序号），供 finally 里记用时用。
  // 声明在 try 外面：finally 看不到 try 块里的 const，而 -1 正好是"这轮没轮到记"的哨兵值
  let turnIndex = -1
  try {
    let userContent = userText
    if (images.length) {
      userContent = [{ type: 'text', text: userText }]
      for (const img of images) {
        try { userContent.push({ type: 'image_url', image_url: { url: await imageToDataUrl(img.path) } }) }
        catch { ui.printWarn(t.imageBadPath(img.path)) }
      }
    }
    // 本轮用时记录要对齐到"第几条 user 消息"，序号得在这条消息入栈之前取
    // （与 Web 侧 agentRoutes.js 同一口径，见 sessionStore.js 的 recordTurnTiming）
    turnIndex = state.messages.filter(m => m?.role === 'user').length
    state.messages.push({ role: 'user', content: userContent })
    await checkpoint()

    // 兜底只在 state.maxToolIterations 缺失/非正数时生效,正常路径由 loadConfig 规范化后传入。
    // 默认值与 config.js 的 aiMaxToolIterations 保持一致(1000),别让两处悄悄分叉。
    const maxIterations = state.maxToolIterations > 0 ? state.maxToolIterations : 1000
    for (let iter = 0; iter < maxIterations; iter++) {
      if (cancelled()) { stats.status = 'cancelled'; return stats }
      const spinner = ui.startSpinner(t.waiting)
      // 一次请求可能被传输层自动重试多次（长静默 / 网关 5xx / 流中断）。
      // 每次尝试都换一套 writer + filter：终端没法把已经打出去的字擦掉，
      // 与其让两次尝试的输出拼在一起，不如把上一截收尾、重开一块新的（中间一行重试提示）。
      const makeWriter = () => ui.createAssistantWriter({
        showThinking: state.showThinking !== false,
        thinkingHeader: t.thinkingLabel,
        answerHeader: t.answerLabel,
        thinkingLimit: state.thinkingMode === 'compact' ? terminal.THINKING_PREVIEW_LINES : Infinity,
        thinkingHint: t.thinkingHint,
      })
      let writer = makeWriter()
      let filter = createThinkFilter()
      const render = seg => {
        if (seg.content) {
          if (seg.content.trim() && stats.firstAnswerMs === null) stats.firstAnswerMs = performance.now() - started
          writer.writeContent(seg.content)
        } else if (seg.thinking) writer.writeThinking(seg.thinking)
      }
      let result
      const llmStart = performance.now()
      stats.requests++
      try {
        // 统一入口(与 Web 智能体面板共用):有界化 + 旧图片降级 + 消毒,只作用于请求副本,
        // 磁盘上的完整会话记录不受影响。
        // 预算来自 state.requestBudget(agent.js 按全局配置 aiMaxRequestTokens 解析);
        // 缺失时 prepareRequestMessages 各自兜底默认值,老调用方不用改。
        const messages = prepareRequestMessages(state.messages, { locale: state.locale, ...(state.requestBudget || {}) })
        result = await chat({ model: state.model, messages, signal: state.abortController?.signal,
          sessionId: state.sessionId, extraTools: extensions?.tools,
          onRetry: info => {
            filter.flush().forEach(render)
            writer.finish()
            ui.printWarn(t.llmRetrying(info.attempt, info.maxRetries, info.error?.message || ''))
            writer = makeWriter()
            filter = createThinkFilter()
            // 重试是一次**真的**请求，计入本轮请求数（/stats 里那个"请求数"要能对得上网关账单）
            stats.requests++
            stats.retries++
          },
          onToken: token => {
            if (stats.firstTokenMs === null) stats.firstTokenMs = performance.now() - started
            if (token.content || (token.thinking && state.showThinking !== false)) spinner.stop()
            if (token.thinking) render({ thinking: token.thinking })
            if (token.content) filter.feed(token.content).forEach(render)
          } })
        recordUsage(result.usage)
      } catch (err) {
        recordUsage(err.usage)
        throw err
      } finally {
        stats.llmMs += performance.now() - llmStart
        spinner.stop()
        filter.flush().forEach(render)
        writer.finish()
      }
      if (result.aborted || cancelled()) {
        if (result.content) state.messages.push({ role: 'assistant', content: result.content })
        stats.status = 'cancelled'; return stats
      }
      const { content, toolCalls } = result
      const assistant = { role: 'assistant', content: content || null }
      if (result.reasoning) assistant.reasoning_content = result.reasoning
      if (!toolCalls.length) {
        if (!content?.trim()) throw new Error(t.emptyResponse)
        state.messages.push(assistant)
        stats.status = 'completed'; return stats
      }
      // Assign fallback IDs once, so every result references its assistant call.
      toolCalls.forEach((call, i) => { if (!call.id) call.id = `call_${iter}_${i}` })
      state.messages.push({ ...assistant, tool_calls: toolCalls })
      await checkpoint()
      // 同一轮里模型经常一次发好几个只读工具(并行读 3 个文件、同时搜两处)。
      // 串行跑等于把 IO 延迟叠 N 遍,所以按批执行:连续的只读工具并发,
      // 其余(写文件 / 跑命令 / 问用户)一律串行 —— 它们有顺序依赖或会接管终端。
      for (const batch of splitToolBatches(toolCalls)) {
        if (batch.parallel) {
          // 执行阶段并发;渲染和入栈仍按模型给的顺序,保证 tool 消息与
          // assistant.tool_calls 一一对齐(协议要求顺序一致,乱序会污染后续上下文)。
          const calls = batch.calls
          const names = calls.map(c => c.function?.name || '').filter(Boolean).join(' · ')
          const spinText = typeof t.toolRunningBatch === 'function'
            ? t.toolRunningBatch(calls.length, names)
            : t.toolRunning(names)
          // 只能开一个 spinner:ora 是单实例单行,并发起多个会互抢同一行刷屏
          const batchSpinner = ui.startSpinner(spinText)
          const batchStart = performance.now()
          let results
          try {
            results = await Promise.all(calls.map(async (tc) => {
              const name = tc.function?.name || ''
              if (cancelled()) return { tc, name, output: NOT_EXECUTED, executed: false }
              let args
              try { args = JSON.parse(tc.function?.arguments || '{}') }
              catch { return { tc, name, output: '错误: 工具参数不是合法 JSON，请修正后重试。', executed: false } }
              const toolStart = performance.now()
              let output
              // 并发路径必须自己兜住异常:一个工具抛错会让 Promise.all 整体 reject,
              // 把同一批里其他已经成功的结果一起丢掉
              try { output = await execute(name, args, { ...state.ctx, signal: state.abortController?.signal }) }
              catch (err) { output = `错误: ${name} 执行失败: ${err?.message || err}` }
              return { tc, name, args, output, executed: true, ms: performance.now() - toolStart }
            }))
          } finally {
            batchSpinner.stop()
          }
          // 工具耗时按墙钟记:并发批里各工具耗时之和会大于实际等待时间,
          // 累加会让 summary 的「工具」时长超过整轮时长
          stats.toolsMs += performance.now() - batchStart
          for (const r of results) {
            const { text: outText, images: outImages } = splitToolOutput(r.output)
            if (r.executed) {
              stats.toolCalls++
              ui.printToolHeader(r.name, ui.summarizeToolArgs(r.name, r.args, { chars: t.chars }), undefined, { locale: state.locale })
              ui.printToolResult(outText, undefined, r.ms, { full: state.fullTools, locale: state.locale })
              ui.afterTool?.(r.name, r.args, outText, { locale: state.locale })
            } else if (r.output !== NOT_EXECUTED) {
              // 取消的那几条和串行路径一样:只入历史、不渲染;参数错误要显式回显
              ui.printToolResult(r.output)
            }
            state.messages.push({ role: 'tool', tool_call_id: r.tc.id, name: r.name, content: toolMessageContent(outText, outImages) })
          }
          await checkpoint()
          continue
        }
        const tc = batch.calls[0]
        const name = tc.function?.name || ''
        let output
        let args
        let toolMs            // 只有真执行过的工具才有耗时(见下面的渲染判断)
        if (cancelled()) {
          // 与改动前一致:取消的这次调用只入历史,不渲染结果块
          output = NOT_EXECUTED
        } else {
          try { args = JSON.parse(tc.function?.arguments || '{}') }
          catch { output = '错误: 工具参数不是合法 JSON，请修正后重试。' }
          if (output === undefined) {
            ui.printToolHeader(name, ui.summarizeToolArgs(name, args, { chars: t.chars }), undefined, { locale: state.locale })
            const toolSpinner = INTERACTIVE_TOOLS.has(name) ? null : ui.startSpinner(t.toolRunning(name))
            const toolStart = performance.now()
            stats.toolCalls++
            try { output = await execute(name, args, { ...state.ctx, signal: state.abortController?.signal }) }
            finally { toolSpinner?.stop(); toolMs = performance.now() - toolStart; stats.toolsMs += toolMs }
          } else {
            ui.printToolResult(output)
          }
        }
        // 工具结果可能是多模态的(read_image)。渲染层和回灌的消息都只吃**文本部分**,
        // 图片要进 content 数组 —— 拆在最后统一做,免得上面每个分支各写一遍。
        const { text: outText, images: outImages } = splitToolOutput(output)
        if (toolMs !== undefined) {
          ui.printToolResult(outText, undefined, toolMs, { full: state.fullTools, locale: state.locale })
          // 工具级的收尾渲染(目前只有 update_plan 画计划清单)。
          // 走钩子而不是在这里写 if (name === 'x'):再加工具时这一行不用动。
          ui.afterTool?.(name, args, outText, { locale: state.locale })
        }
        state.messages.push({ role: 'tool', tool_call_id: tc.id, name, content: toolMessageContent(outText, outImages) })
        await checkpoint()
      }
    }
    stats.status = cancelled() ? 'cancelled' : 'limit'
    if (!cancelled()) ui.printWarn(t.toolIterLimit(maxIterations))
  } catch (err) {
    stats.status = cancelled() ? 'cancelled' : 'failed'
    if (!cancelled()) ui.printError(t.llmError(err.message))
  } finally {
    stats.totalMs = performance.now() - started
    stats.completedAt = new Date().toISOString()
    state.lastTurnStats = stats
    state.sessionStats = accumulateSessionStats(state.sessionStats, stats)
    // 界面读的是这条（Web 端 g ai 对话列表里也能看到 CLI 会话的每轮用时）
    recordTurnTiming(state, { turnIndex, durationMs: stats.totalMs, finishedAt: stats.completedAt })
    await checkpoint()
    ui.printTurnSummary(stats, { locale: state.locale })
  }
  return stats
}
