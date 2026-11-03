// 订阅「会话目录变了」（服务端 SSE：GET /api/agent/events）。
//
// 为什么需要它：会话文件是整机共享的 —— 远端 peer 提问、另一个 g ui 窗口、CLI、
// 定时任务都会往同一个目录里写，而这些写入方**都不会**在本窗口的 JS 里留任何痕迹。
// 没有这条订阅时，左栏只会在"本窗口自己发起的动作"之后刷新，于是另一台机器问完话，
// 这台机器的会话列表里看不到那条新会话，得切项目 / 刷新页面。
//
// 服务端只推"变了"一个字，去重、节流都在这里做：一次落盘会连发几个目录事件，
// 重拉列表（要读目录里所有会话文件）不该跟着跑几遍。
export function subscribeAgentSessionEvents(
  onChange: () => void,
  { throttleMs = 300 }: { throttleMs?: number } = {}
): () => void {
  // jsdom / 老浏览器没有 EventSource：退化成"不自动刷新"，列表照旧手动触发。
  if (typeof EventSource === 'undefined') return () => {}

  const es = new EventSource('/api/agent/events')
  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      onChange()
    }, throttleMs)
  }
  es.onmessage = (ev: MessageEvent) => {
    try {
      const data = JSON.parse(ev.data)
      if (data?.type === 'sessions_changed') schedule()
    } catch {
      /* 坏帧忽略 */
    }
  }
  // onerror 不用管：EventSource 自带重连，重连后会再收到 hello
  return () => {
    if (timer) clearTimeout(timer)
    timer = null
    es.close()
  }
}
