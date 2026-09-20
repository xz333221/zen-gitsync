import { executeTool } from './tools.js'
import { streamChatOnce } from './transport.js'
import { createThinkFilter } from './streamFilter.js'
import { imageToDataUrl } from './images.js'
import { buildRequestMessages } from './context.js'
import { createTurnStats, addUsage, accumulateSessionStats } from './telemetry.js'
import * as terminal from './termui.js'

export async function runAgentTurn(state, userText, t, images = [], dependencies = {}) {
  const chat = dependencies.chat || streamChatOnce
  const execute = dependencies.execute || executeTool
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
    const maxIterations = state.maxToolIterations > 0 ? state.maxToolIterations : 200
    for (let iter = 0; iter < maxIterations; iter++) {
      if (cancelled()) { stats.status = 'cancelled'; return stats }
      const spinner = ui.startSpinner(t.waiting)
      const writer = ui.createAssistantWriter({
        showThinking: state.showThinking !== false,
        thinkingHeader: t.thinkingLabel,
        answerHeader: t.answerLabel,
        thinkingLimit: state.thinkingMode === 'full' ? Infinity : terminal.THINKING_PREVIEW_LINES,
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
        const messages = buildRequestMessages(state.messages)
        state.prepareMessages?.(messages)
        result = await chat({ model: state.model, messages, signal: state.abortController?.signal,
          sessionId: state.sessionId, onToken: token => {
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
        if (cancelled()) output = 'Cancelled by user; this tool was not executed.'
        else {
          let args
          try { args = JSON.parse(tc.function?.arguments || '{}') }
          catch { output = '错误: 工具参数不是合法 JSON，请修正后重试。' }
          if (output === undefined) {
            ui.printToolHeader(name, ui.summarizeToolArgs(name, args, { chars: t.chars }), undefined, { locale: state.locale })
            const toolSpinner = ui.startSpinner(t.toolRunning(name))
            const toolStart = performance.now()
            stats.toolCalls++
            try { output = await execute(name, args, { ...state.ctx, signal: state.abortController?.signal }) }
            finally { toolSpinner.stop(); stats.toolsMs += performance.now() - toolStart }
            ui.printToolResult(output, undefined, performance.now() - toolStart, { full: state.fullTools, locale: state.locale })
          } else ui.printToolResult(output)
        }
        state.messages.push({ role: 'tool', tool_call_id: tc.id, name, content: output })
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
