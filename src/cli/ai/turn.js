import { executeTool, splitToolOutput, toolMessageContent } from './tools.js'
import { streamChatOnce } from './transport.js'
import { createThinkFilter } from './streamFilter.js'
import { imageToDataUrl } from './images.js'
import { prepareRequestMessages } from './context.js'
import { createTurnStats, addUsage, accumulateSessionStats } from './telemetry.js'
import * as terminal from './termui.js'

// 「等人」型工具:执行期间会接管输入行、停下来等用户作答(目前只有 ask_user)。
// 这类工具不能转工具 spinner —— ora 每 80ms 在同一行 clearLine + 重绘,会把
// readline 刚画出的提示符(「请输入序号或直接输入回答:」)连同用户正在敲的字
// 一起清掉,屏幕上只剩下一个不断跳秒数的「执行 ask_user...」,看起来就像"选不了"。
// 它自己的交互界面(问题 + 编号选项 + 提示符)就是进度提示,不需要再叠一层。
const INTERACTIVE_TOOLS = new Set(['ask_user'])

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
  try {
    let userContent = userText
    if (images.length) {
      userContent = [{ type: 'text', text: userText }]
      for (const img of images) {
        try { userContent.push({ type: 'image_url', image_url: { url: await imageToDataUrl(img.path) } }) }
        catch { ui.printWarn(t.imageBadPath(img.path)) }
      }
    }
    state.messages.push({ role: 'user', content: userContent })
    await checkpoint()
    // 兜底只在 state.maxToolIterations 缺失/非正数时生效,正常路径由 loadConfig 规范化后传入。
    // 默认值与 config.js 的 aiMaxToolIterations 保持一致(1000),别让两处悄悄分叉。
    const maxIterations = state.maxToolIterations > 0 ? state.maxToolIterations : 1000
    for (let iter = 0; iter < maxIterations; iter++) {
      if (cancelled()) { stats.status = 'cancelled'; return stats }
      const spinner = ui.startSpinner(t.waiting)
      const writer = ui.createAssistantWriter({
        showThinking: state.showThinking !== false,
        thinkingHeader: t.thinkingLabel,
        answerHeader: t.answerLabel,
        thinkingLimit: state.thinkingMode === 'compact' ? terminal.THINKING_PREVIEW_LINES : Infinity,
        thinkingHint: t.thinkingHint,
      })
      const filter = createThinkFilter()
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
      for (const tc of toolCalls) {
        const name = tc.function?.name || ''
        let output
        let args
        let toolMs            // 只有真执行过的工具才有耗时(见下面的渲染判断)
        if (cancelled()) {
          // 与改动前一致:取消的这次调用只入历史,不渲染结果块
          output = 'Cancelled by user; this tool was not executed.'
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
    await checkpoint()
    ui.printTurnSummary(stats, { locale: state.locale })
  }
  return stats
}
