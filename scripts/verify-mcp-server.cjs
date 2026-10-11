/**
 * MCP 服务端（src/mcp/）的真跑验证。
 *
 * 分三段，各验一件不同的事：
 *   A. 协议内核（in-process）——initialize / tools/list / tools/call 的形状与错误码；
 *   B. 各板块工具（in-process）——用一份**沙箱造出来的**数据目录，断言每个工具真的
 *      读到了它该读的东西（而不是"没报错就算过"）；
 *   C. stdio 端到端（spawn 真进程）——握手 → tools/list → tools/call 全链路，
 *      外加一条**最关键的守卫：stdout 必须只有协议帧**。
 *
 * 为什么 C 段那条守卫必须存在：stdio 传输里 stdout 就是协议通道。任何一个多余的
 * console.log（包括被动 import 进来的模块打的横幅）都会让客户端收到畸形消息，
 * 表现为"连不上 / 握手超时"，而错误信息指向别处 —— 这类问题只能靠探针提前钉住。
 *
 * 沙箱隔离：USERPROFILE / HOME 必须在 import src/paths.js **之前**改 ——
 * paths.js 在模块加载时求值 os.homedir()（Windows 还要删 HOMEDRIVE/HOMEPATH）。
 * 子进程靠 env 传同样的值。
 *
 * 用法：node scripts/verify-mcp-server.cjs
 * 退出码：0 全通过；1 有失败项；2 前置不足。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-mcp-'))

// ── 沙箱数据目录 ────────────────────────────────────────────────
const DATA = path.join(SANDBOX, '.zen-gitsync')
const NOW = Date.now()
/** 用探针自己的 pid 造"活实例"，这样 isPidAlive 一定为真 */
const SELF_PID = process.pid
/** 一个一定没人监听的端口，用来验"实例在但 HTTP 打不通"时的降级 */
const DEAD_PORT = 9
const MINDMAP_DIR = path.join(SANDBOX, 'mindmaps')

function write(rel, content) {
  const full = path.join(DATA, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8')
}

write('tasks.json', {
  tasks: [
    {
      id: 't1', title: '加个按钮', desc: '在卡片上加打开文件夹按钮', projectPath: 'C:\\proj',
      status: 'todo', type: 'simple', attachments: [], subtasks: [],
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
    },
    {
      id: 't2', title: '没跑过的任务', desc: '', projectPath: 'C:\\proj',
      status: 'todo', attachments: [], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    },
  ],
})
write('jobs.json', {
  version: 1,
  jobs: [{
    id: 'j1', taskId: 't1', title: '加个按钮', status: 'done', agent: 'claude',
    startedAt: '2026-10-02T00:00:00.000Z', endedAt: '2026-10-02T00:05:00.000Z',
    exitCode: 0, output: 'DONE_MARKER_OUTPUT', toolCalls: [{ name: 'run_command' }], taskTitle: '加个按钮',
  }],
})
write('orchestrator.json', {
  version: 1, active: true, updatedAt: '2026-10-02T00:00:00.000Z',
  instructions: [{ at: '2026-10-02T00:00:00.000Z', text: '把编码统一成 utf-8' }],
  defaultPrompt: 'DEFAULT_PROMPT_MARKER', projectPrompts: {}, reportIntervalMs: 0, lastReportAt: null,
})
write('orchestrator-reports.json', { version: 1, reports: [{ id: 'r1', text: 'REPORT_MARKER' }] })
write('schedules.json', {
  version: 1,
  tasks: [{
    id: 's1', name: '每日拉代码', enabled: true, schedule: '0 9 * * *', cwd: 'C:\\proj',
    prompt: '拉取最新代码', onMissed: 'run', onBusy: 'skip', lastFire: null, lastRun: null,
  }],
})
write('local-repos.json', {
  scannedAt: NOW, scannedDirs: 3, roots: ['C:\\'], repos: { 'C:\\ws\\r1': 'git@github.com:a/b.git' },
})
write('ai-context/INDEX.md', '# 工作区状态快照 · INDEX\n\n- 本次汇总: SNAPSHOT_INDEX_MARKER\n')
write('ai-context/remote-github.md', '# GitHub 仓库\n\n- SNAPSHOT_GITHUB_MARKER 70 个仓库\n')
write('ai-context/mindmap.md', `# 思维导图\n\n## ${MINDMAP_DIR}（1 个）\n\n- 测试导图 | 2026-10-01 00:00 | 1KB\n`)
write('ai/ai-probe.txt', 'not a json file, should be ignored')
write('ai/mcp.json', {
  mcpServers: {
    'flowdash-todo': { type: 'http', url: 'https://example.com/api/mcp', headers: { Authorization: 'Bearer SECRET_TOKEN_VALUE' } },
    localdemo: { command: 'npx', args: ['-y', 'some-server'] },
  },
})
write('ai/skills/demo-skill/SKILL.md', '---\nname: demo-skill\ndescription: SKILL_DESC_MARKER\n---\n\n# Demo\n')
write('agent-sessions/ag-probe-1.json', {
  version: 1, sessionId: 'ag-probe-1', title: '测试会话', source: 'web', cwd: 'C:\\proj',
  model: 'probe-model', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  messages: [
    { role: 'system', content: 'SYSTEM_MARKER' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: 'ASSISTANT_MARKER' },
  ],
})
write('memory/INDEX.md', '# 记忆索引\n\n- MEMORY_INDEX_MARKER\n')
write('memory/projects/proj-x/INDEX.md', '# proj-x\n\n- LESSON_MARKER\n')
write('memory/projects/proj-x/lessons/pit.md', '坑：LESSON_BODY_MARKER\n')
write(`instances/${SELF_PID}.json`, {
  pid: SELF_PID, port: DEAD_PORT, projectName: 'proj', projectPath: 'C:\\proj',
  startedAt: NOW - 60_000, lastHeartbeat: NOW, hostname: 'probe-host',
})
write('instances/99999.json.tmp', '{ half-written')
write(`live-jobs/${SELF_PID}.json`, {
  version: 1, ownerPid: SELF_PID, updatedAt: NOW,
  jobs: [{
    id: 'lj1', taskId: 't1', title: '正在跑的任务', status: 'running', agent: 'claude',
    startedAt: '2026-10-02T00:00:00.000Z', lastActivityAt: '2026-10-02T00:00:01.000Z',
    output: 'LIVE_OUTPUT_MARKER', thinking: '', toolCalls: [{ id: 'c1', name: 'run_command', status: 'ok', argsPreview: 'echo hi' }],
  }],
})
write('live-jobs/88888.json', { version: 1, ownerPid: 88888, updatedAt: NOW - 10_000, jobs: [{ id: 'dead', title: '死者', status: 'running' }] })
write('live-jobs/77777.json.tmp', '{ half-written')

// 思维导图（不在 DATA_DIR 下）
fs.mkdirSync(MINDMAP_DIR, { recursive: true })
fs.writeFileSync(
  path.join(MINDMAP_DIR, 'probe.mindmap.json'),
  JSON.stringify({ id: 'root', text: 'MINDMAP_ROOT_MARKER', children: [{ id: 'a', text: '子节点A', children: [] }] }),
  'utf8',
)

// paths.js 在加载时求值 os.homedir()，必须先改环境
for (const k of ['HOMEDRIVE', 'HOMEPATH']) delete process.env[k]
process.env.USERPROFILE = SANDBOX
process.env.HOME = SANDBOX

const results = []
/** ⚠️ 必须同时认同步与异步用例 —— 纯同步版会把 async 用例的失败记成 PASS（踩过） */
const t = async (name, fn) => {
  try {
    const msg = await fn()
    results.push({ ok: true, name, msg: typeof msg === 'string' ? msg : '' })
  } catch (err) {
    results.push({ ok: false, name, msg: err?.message || String(err) })
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
/** 断言某个工具返回里带/不带某个标记（把"读到了"和"读错了"分开） */
function mustInclude(haystack, needle, label) {
  const text = typeof haystack === 'string' ? haystack : JSON.stringify(haystack)
  assert(text.includes(needle), `${label || '结果'}里应该包含 ${needle}，实际没找到`)
}
function mustExclude(haystack, needle, label) {
  const text = typeof haystack === 'string' ? haystack : JSON.stringify(haystack)
  assert(!text.includes(needle), `${label || '结果'}里不该出现 ${needle}`)
}

// ── Phase A + B：in-process ─────────────────────────────────────
async function inProcess() {
  const { createMcpServer } = await import(pathToFileURL(path.join(ROOT, 'src/mcp/server.js')).href)
  const { ALL_TOOLS, findTool } = await import(pathToFileURL(path.join(ROOT, 'src/mcp/tools/index.js')).href)

  const server = createMcpServer({ tools: ALL_TOOLS, ctx: { cwd: 'C:\\proj', locale: 'zh' } })
  /** 直接调工具 handler —— 绕开协议层，专测读取逻辑 */
  const call = async (name, args, ctx) => {
    const tool = findTool(name)
    assert(tool, `工具 ${name} 不存在`)
    return tool.handler(args || {}, ctx || { cwd: 'C:\\proj', locale: 'zh' })
  }

  // ── A. 协议 ──────────────────────────────────────────────
  await t('A1 initialize 回协议版本 + tools 能力 + serverInfo', async () => {
    const res = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'probe' } } })
    assert(res.result, 'result 缺失')
    assert(res.result.protocolVersion === '2025-03-26', `协议版本没回客户端那个：${res.result.protocolVersion}`)
    assert(res.result.capabilities?.tools, '没声明 tools 能力')
    assert(res.result.serverInfo?.name === 'zen-gitsync', 'serverInfo.name 不对')
    assert(typeof res.result.serverInfo.version === 'string' && res.result.serverInfo.version !== '0.0.0', 'version 没读到 package.json')
    return `协议 ${res.result.protocolVersion} · v${res.result.serverInfo.version}`
  })

  await t('A2 initialize 遇到未知协议版本时回落到我们支持的版本', async () => {
    const res = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
    assert(res.result.protocolVersion !== '1999-01-01', '不该原样回一个我们不支持的版本')
    return `回落到 ${res.result.protocolVersion}`
  })

  await t('A3 通知（无 id）不回响应', async () => {
    const res = await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })
    assert(res === null, `通知不该有响应，实际拿到 ${JSON.stringify(res)}`)
  })

  await t('A4 tools/list 形状：每个工具都有 name/description/inputSchema', async () => {
    const res = await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const tools = res.result?.tools
    assert(Array.isArray(tools) && tools.length >= 12, `工具太少：${tools?.length}`)
    for (const tool of tools) {
      assert(typeof tool.name === 'string' && tool.name, '工具缺 name')
      assert(typeof tool.description === 'string' && tool.description.length > 10, `${tool.name} 的 description 太短`)
      assert(tool.inputSchema?.type === 'object', `${tool.name} 的 inputSchema.type 不是 object`)
    }
    const names = tools.map(x => x.name)
    assert(new Set(names).size === names.length, '有重名工具')
    return `${tools.length} 个工具：${names.join(', ')}`
  })

  await t('A5 未知方法回 -32601', async () => {
    const res = await server.handleMessage({ jsonrpc: '2.0', id: 3, method: 'no/such/method' })
    assert(res.error?.code === -32601, `错误码应该是 -32601，实际 ${res.error?.code}`)
  })

  await t('A6 调用不存在的工具 → isError 而不是协议错误', async () => {
    const res = await server.handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } })
    assert(!res.error, '不该是 JSON-RPC error')
    assert(res.result?.isError === true, 'isError 应该是 true')
    mustInclude(res.result.content[0].text, '可用工具', '未知工具的提示')
  })

  await t('A7 工具内部抛异常 → isError + 原因，不中断协议', async () => {
    const boom = createMcpServer({ tools: [{ name: 'boom', description: 'b', inputSchema: { type: 'object' }, handler: () => { throw new Error('BOOM_MARKER') } }] })
    const res = await boom.handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'boom', arguments: {} } })
    assert(!res.error && res.result?.isError === true, '异常应转成 isError')
    mustInclude(res.result.content[0].text, 'BOOM_MARKER', '异常信息')
  })

  // ── B. 各板块 ────────────────────────────────────────────
  await t('B1 workspace_overview 读到快照索引', async () => {
    const r = await call('workspace_overview')
    mustInclude(r, 'SNAPSHOT_INDEX_MARKER', '索引正文')
    assert(r.boards === undefined, '默认不该带各板块全文')
    const full = await call('workspace_overview', { include_boards: true })
    mustInclude(full.boards, 'SNAPSHOT_GITHUB_MARKER', 'include_boards 时的板块正文')
    return '索引 + 按需板块正文'
  })

  await t('B2 workbench_projects：项目统计 + 编排台状态', async () => {
    const r = await call('workbench_projects')
    assert(r.project_count === 1, `项目数应该是 1，实际 ${r.project_count}`)
    const proj = r.projects[0]
    assert(proj.tasks.total === 2, `任务数应该是 2，实际 ${proj.tasks.total}`)
    assert(proj.tasks.done === 1, `已完成应该是 1，实际 ${proj.tasks.done}`)
    assert(proj.tasks.todo === 1, `待处理应该是 1，实际 ${proj.tasks.todo}`)
    assert(r.orchestrator.active === true, '编排台应该是开启的')
    mustInclude(r.orchestrator, 'DEFAULT_PROMPT_MARKER', '默认提示词')
    mustInclude(r.orchestrator.recent_instructions, '把编码统一成 utf-8', '最近指令')
    return `1 个项目 · 2 个任务（1 done / 1 todo）· 编排台 active`
  })

  await t('B3 看板列推导：跑过且 done 的任务算 done，没跑过的算 todo', async () => {
    const r = await call('workbench_tasks')
    const byId = Object.fromEntries(r.tasks.map(x => [x.id, x]))
    assert(byId.t1.column === 'done', `t1 应该是 done，实际 ${byId.t1.column}`)
    assert(byId.t2.column === 'todo', `t2 应该是 todo，实际 ${byId.t2.column}`)
    const onlyTodo = await call('workbench_tasks', { column: 'todo' })
    assert(onlyTodo.total === 1 && onlyTodo.tasks[0].id === 't2', 'column 过滤没生效')
    return 'done/todo 推导正确，column 过滤生效'
  })

  await t('B4 workbench_task_detail：带出执行记录与输出尾部', async () => {
    const r = await call('workbench_task_detail', { task_id: 't1' })
    assert(r.run_count === 1, `应该有 1 次执行，实际 ${r.run_count}`)
    mustInclude(r.runs[0].output_tail, 'DONE_MARKER_OUTPUT', '输出尾部')
    assert(r.runs[0].duration_ms === 5 * 60 * 1000, `耗时应为 5 分钟，实际 ${r.runs[0].duration_ms}`)
    const missing = await call('workbench_task_detail', { task_id: 'nope' })
    mustInclude(missing, '找不到任务', '不存在的任务 id')
    return '执行记录 + 耗时 + 输出尾部'
  })

  await t('B5 runtime_status：只认活着的 owner，忽略 .tmp 与死进程', async () => {
    const r = await call('runtime_status')
    assert(r.g_ui_running === true, '应该认为有活实例')
    assert(r.instances.length === 1, `活实例应该只有 1 个，实际 ${r.instances.length}`)
    assert(r.running_job_count === 1, `运行中任务应该只有 1 个，实际 ${r.running_job_count}`)
    assert(r.running_jobs[0].id === 'lj1', `跑着的应该是 lj1，实际 ${r.running_jobs[0].id}`)
    mustInclude(r.running_jobs[0].outputTail, 'LIVE_OUTPUT_MARKER', '运行中输出')
    assert(r.running_jobs[0].toolCalls[0].name === 'run_command', '工具流水没带出来')
    // 88888 的主人进程不存在 → 必须被当成残留
    mustExclude(r.running_jobs, 'dead', '死进程的 job')
    assert((r.stale_broadcast_files || []).some(f => f.owner_pid === 88888), '应该把死进程的广播文件列进 stale')
    mustExclude(r, '77777', '半写的 .tmp 文件')
    mustExclude(r, '99999', '.tmp 实例文件')
    return '1 活实例 · 1 运行中任务 · 死进程/半写文件已忽略'
  })

  await t('B6 repos_local_clones 读本机克隆清单', async () => {
    const r = await call('repos_local_clones')
    assert(r.count === 1, `应该 1 个仓库，实际 ${r.count}`)
    mustInclude(r.repos[0].origin, 'git@github.com:a/b.git', 'origin')
    assert(typeof r.age_minutes === 'number', '应该给出缓存年龄')
    return '1 个本地克隆 · 带 origin 与缓存年龄'
  })

  await t('B7 agent_sessions_list / agent_session_read', async () => {
    const list = await call('agent_sessions_list')
    assert(list.total === 1, `应该 1 条会话，实际 ${list.total}`)
    assert(list.sessions[0].session_id === 'ag-probe-1', '会话 id 不对')
    assert(list.sessions[0].message_count === 3, `消息数应该是 3，实际 ${list.sessions[0].message_count}`)

    const read = await call('agent_session_read', { session_id: 'ag-probe-1' })
    mustInclude(read, 'ASSISTANT_MARKER', '助手消息')
    mustExclude(read, 'SYSTEM_MARKER', '默认应剥掉 system 提示词')
    const withSystem = await call('agent_session_read', { session_id: 'ag-probe-1', include_system: true })
    mustInclude(withSystem, 'SYSTEM_MARKER', 'include_system 时应带上 system')
    return '会话列表 + 默认剥 system、可按需带出'
  })

  await t('B8 agent_skills_list：frontmatter 解析 + 两级作用域', async () => {
    const r = await call('agent_skills_list', { cwd: path.join(SANDBOX, 'empty-project') })
    assert(r.global_count === 1, `全局应有 1 个 skill，实际 ${r.global_count}`)
    assert(r.project_count === 0, `项目级应为 0，实际 ${r.project_count}`)
    assert(r.skills[0].name === 'demo-skill', 'frontmatter 的 name 没解析出来')
    mustInclude(r.skills[0].description, 'SKILL_DESC_MARKER', 'frontmatter 的 description')
    return '全局 1 · 项目级 0 · frontmatter 解析正确'
  })

  await t('B9 agent_mcp_servers：认两种传输且**不泄露 header 值**', async () => {
    const r = await call('agent_mcp_servers')
    const byId = Object.fromEntries(r.global.servers.map(s => [s.id, s]))
    assert(byId['flowdash-todo'].transport === 'http', 'http 型判错了')
    assert(byId.localdemo.transport === 'stdio', 'stdio 型判错了')
    assert(byId['flowdash-todo'].header_names.includes('Authorization'), '应该列出 header 名')
    mustExclude(r, 'SECRET_TOKEN_VALUE', '工具结果')
    // ai/ 目录下的非 mcp 文件不该被当成配置
    assert(r.global.servers.length === 2, `应该恰好 2 个 server，实际 ${r.global.servers.length}`)
    return '2 个 server · 传输判定正确 · token 未泄露'
  })

  await t('B10 mindmap_list 从快照取目录 + mindmap_read 出大纲', async () => {
    const list = await call('mindmap_list')
    assert(list.file_count === 1, `应该 1 张导图，实际 ${list.file_count}`)
    const file = list.directories[0].files[0]
    assert(file.title === 'MINDMAP_ROOT_MARKER', `标题应该是根节点文本，实际 ${file.title}`)

    const read = await call('mindmap_read', { path: file.path })
    mustInclude(read.outline, 'MINDMAP_ROOT_MARKER', '大纲根节点')
    mustInclude(read.outline, '子节点A', '大纲子节点')
    assert(read.node_count === 2, `节点数应该是 2，实际 ${read.node_count}`)
    assert(/^-\s/.test(read.outline.split('\n')[0]), '大纲首行应该是根节点')
    assert(read.outline.split('\n')[1].startsWith('  - '), '子节点应该有缩进')

    const rejected = await call('mindmap_read', { path: path.join(SANDBOX, 'evil.txt') })
    mustInclude(rejected, '思维导图文件', '非 .mindmap.json 的路径')
    return '1 张导图 · 大纲层级正确 · 非导图扩展名被拒'
  })

  await t('B11 memory_index / memory_read，且越界路径被拒', async () => {
    const idx = await call('memory_index')
    mustInclude(idx.index, 'MEMORY_INDEX_MARKER', '全局索引')
    assert(idx.project_count === 1, `应该 1 个项目 scope，实际 ${idx.project_count}`)
    assert(idx.projects[0].scope === 'proj-x', 'scope 名不对')
    // 关键：子目录（lessons/）里的正文必须被列出来 —— 否则调用方根本发现不了它存在
    const files = idx.projects[0].files.map(f => f.file)
    assert(files.includes('lessons/pit.md'), `应该递归列出子目录里的正文，实际只有 ${JSON.stringify(files)}`)

    const read = await call('memory_read', { scope: 'proj-x', file: 'lessons/pit.md' })
    mustInclude(read.content, 'LESSON_BODY_MARKER', '正文')

    const escape = await call('memory_read', { scope: 'global', file: '../../../../etc/passwd' })
    mustInclude(escape, '拒绝', '路径穿越')
    return '索引 + 正文 + 路径穿越被拦'
  })

  await t('B12 schedules_list 算出下次触发时间', async () => {
    const r = await call('schedules_list')
    assert(r.count === 1, `应该 1 个定时任务，实际 ${r.count}`)
    assert(r.tasks[0].schedule === '0 9 * * *', 'cron 没读出来')
    assert(typeof r.tasks[0].next_fire_at === 'string' && r.tasks[0].next_fire_at, '没算出下次触发时间')
    const next = new Date(r.tasks[0].next_fire_at)
    assert(!Number.isNaN(next.getTime()) && next.getTime() > Date.now(), '下次触发时间应该在将来')
    return `下次触发 ${r.tasks[0].next_fire_at}`
  })

  await t('B13 workbench_reports 读进度报告', async () => {
    const r = await call('workbench_reports')
    assert(r.total === 1, `应该 1 条报告，实际 ${r.total}`)
    mustInclude(r.reports[0], 'REPORT_MARKER', '报告正文')
  })

  // ── B14/B15：写操作在没有真 g ui 时必须**明确失败**，不能假装成功 ──
  await t('B14 workbench_dispatch 在 HTTP 打不通时不得声称已派发', async () => {
    const r = await call('workbench_dispatch', { text: '干点活' })
    assert(r.dispatched !== true, '绝不能返回 dispatched:true —— 它其实没派出去')
    assert(r.error || r.available === false, '应该给出失败原因')
    return `如实失败：${r.error || r.reason}`
  })

  await t('B15 agent_ask 在 HTTP 打不通时不得返回假回答', async () => {
    const r = await call('agent_ask', { message: '你好' })
    assert(r.ran !== true, '绝不能假装跑过了')
    assert(r.error || r.stream_error || r.available === false, '应该给出失败原因')
    return `如实失败：${r.error || r.stream_error || r.reason}`
  })

  await t('B16 repos_list 在直连失败时退回首屏快照并标注来源', async () => {
    const r = await call('repos_list', { provider: 'github' })
    assert(r.source === 'file' || r.source === 'live', '应该标注数据来源')
    if (r.source === 'file') mustInclude(r, 'SNAPSHOT_GITHUB_MARKER', '快照正文')
    return `source=${r.source}`
  })

  // ── E. `g mcp install`（把自己登记成别人的 MCP 服务）──────────
  const { install, uninstall, listTargets } = await import(pathToFileURL(path.join(ROOT, 'src/mcp/install.js')).href)
  const { AI_MCP_FILE } = await import(pathToFileURL(path.join(ROOT, 'src/mcp/paths.js')).href)
  const readTxt = async f => fs.readFileSync(f, 'utf8')

  await t('E1 install 到自家全局：写入 { command: "g", args: ["mcp"] }', async () => {
    const r = await install('zen')
    assert(r.ok === true, `应该成功：${r.error}`)
    assert(r.changed === true, '首次登记应该是 changed')
    const parsed = JSON.parse(await readTxt(AI_MCP_FILE))
    assert(parsed.mcpServers['zen-gitsync'].command === 'g', 'command 不对')
    assert(JSON.stringify(parsed.mcpServers['zen-gitsync'].args) === '["mcp"]', 'args 不对')
    return '已写入 sandbox ai/mcp.json'
  })

  await t('E2 幂等：再装一次报告"已存在"，不重复写', async () => {
    const before = await readTxt(AI_MCP_FILE)
    const r = await install('zen')
    assert(r.ok === true, '第二次也该成功')
    assert(r.changed === false, `第二次不该再改动，changed=${r.changed}`)
    assert(await readTxt(AI_MCP_FILE) === before, '文件内容不该变')
    return '重复安装无副作用'
  })

  await t('E3 覆盖写入时保留原有的其它 server 与顶层字段', async () => {
    fs.writeFileSync(AI_MCP_FILE, JSON.stringify({
      version: 9,
      mcpServers: { keepme: { command: 'other', args: ['x'] } },
    }, null, 2), 'utf8')
    await install('zen')
    const parsed = JSON.parse(await readTxt(AI_MCP_FILE))
    assert(parsed.version === 9, '顶层其它字段被丢了')
    assert(parsed.mcpServers.keepme.command === 'other', '原有 server 被丢了')
    assert(parsed.mcpServers['zen-gitsync'], '新的没写进去')
    return '合并式写入，原有内容完好'
  })

  await t('E4 配置是坏 JSON 时**拒绝覆盖**（除非 --force）', async () => {
    fs.writeFileSync(AI_MCP_FILE, '{ 这不是 json', 'utf8')
    const blocked = await install('zen')
    assert(blocked.ok === false, '坏文件必须拒绝，不能悄悄覆盖')
    mustInclude(blocked.error, '--force', '提示里该告诉用户怎么解')
    assert(await readTxt(AI_MCP_FILE) === '{ 这不是 json', '拒绝时文件不该被动过')

    const forced = await install('zen', { force: true })
    assert(forced.ok === true, '--force 时应该能覆盖')
    assert(JSON.parse(await readTxt(AI_MCP_FILE)).mcpServers['zen-gitsync'], '覆盖后应该有 zen-gitsync')
    return '默认拒绝 · --force 覆盖'
  })

  await t('E5 uninstall 只摘掉自己那一段，保留其它 server', async () => {
    fs.writeFileSync(AI_MCP_FILE, JSON.stringify({
      mcpServers: { keepme: { command: 'other' }, 'zen-gitsync': { command: 'g', args: ['mcp'] } },
    }, null, 2), 'utf8')
    const r = await uninstall('zen')
    assert(r.ok === true && r.changed === true, '应该真的删了')
    const parsed = JSON.parse(await readTxt(AI_MCP_FILE))
    assert(!parsed.mcpServers['zen-gitsync'], 'zen-gitsync 应该没了')
    assert(parsed.mcpServers.keepme, '别的 server 不该被牵连')
    assert(fs.existsSync(`${AI_MCP_FILE}.bak`), '删除前应该备份 .bak')
    const again = await uninstall('zen')
    assert(again.skipped === true, '再删一次应该是"本来就没登记"')
    return '只摘自己 · 有备份 · 幂等'
  })

  await t('E6 listTargets 能识别出"已登记"状态', async () => {
    await install('zen')
    const targets = await listTargets()
    const zen = targets.find(x => x.id === 'zen')
    assert(zen.installed === true, '装完应该报 installed')
    return `${targets.length} 个目标 · zen 已登记`
  })

  await t('E7 未检测到的目标默认跳过，不凭空造配置文件', async () => {
    // sandbox 里 .cursor 目录不存在 —— 不加 --force 就该跳过
    const r = await install('cursor')
    assert(r.ok === true, '跳过不是失败')
    assert(r.skipped === true, `应该跳过，实际 ${JSON.stringify(r)}`)
    mustInclude(r.reason, '--force', '提示里该说怎么强制')
    assert(!fs.existsSync(path.join(SANDBOX, '.cursor', 'mcp.json')), '不该无中生有造文件')
    return '未检测到的目标已跳过'
  })

  await t('E8 未知目标 → ok:false 而不是静默成功', async () => {
    const r = await install('no-such-product')
    assert(r.ok === false, '未知目标必须失败')
    mustInclude(r.error, '未知目标', '错误信息')
  })

  await t('E9 TOML 目标（Codex）：追加段 / 二次调用替换而不是重复', async () => {
    const codexFile = path.join(SANDBOX, '.codex', 'config.toml')
    fs.mkdirSync(path.dirname(codexFile), { recursive: true })
    fs.writeFileSync(codexFile, 'model = "gpt-5"\n\n[some_other]\nx = 1\n', 'utf8')

    const first = await install('codex', { force: true })
    assert(first.ok === true, `第一次应该成功：${first.error}`)
    let text = await readTxt(codexFile)
    mustInclude(text, 'model = "gpt-5"', '原有 TOML 内容')
    mustInclude(text, '[mcp_servers.zen-gitsync]', '新增段')
    mustInclude(text, 'command = "g"', '命令')
    assert(text.includes('some_other'), '原有段不该被吃掉')

    const second = await install('codex', { force: true })
    assert(second.ok === true, '第二次应该成功')
    const occurrences = (await readTxt(codexFile)).split('[mcp_servers.zen-gitsync]').length - 1
    assert(occurrences === 1, `段只该有一份，实际 ${occurrences} 份`)

    const removed = await uninstall('codex')
    assert(removed.ok === true && removed.changed === true, '应该能删掉')
    mustExclude(await readTxt(codexFile), 'mcp_servers.zen-gitsync', '删除后的 TOML')
    mustInclude(await readTxt(codexFile), 'model = "gpt-5"', '删除后原有内容')
    return '追加 / 替换 / 删除 都正确'
  })

  // ── F. 定时任务增删改 ─────────────────────────────────────
  const scheduleCwd = SANDBOX // 必须是真实存在的目录（createTask 会校验）

  await t('F1 schedule_add：建任务并算出下次触发', async () => {
    const r = await call('schedule_add', { name: '探针任务', schedule: '0 9 * * *', prompt: '跑点东西', cwd: scheduleCwd })
    assert(r.created === true, `应该创建成功：${r.error}`)
    assert(r.task.schedule === '0 9 * * *', 'cron 没落进去')
    assert(typeof r.task.next_fire_at === 'string' && r.task.next_fire_at, '没算出下次触发')
    mustInclude(r.note, 'g ui', '结果里必须提醒调度器需要 g ui')
    const list = await call('schedules_list')
    assert(list.count === 2, `应该有 2 个任务，实际 ${list.count}`)
    global.__probeTaskId = r.task.id
    return `已建 ${r.task.id} · 下次 ${r.task.next_fire_at}`
  })

  await t('F2 schedule_add 拒绝非法 cron，且不落盘', async () => {
    const before = (await call('schedules_list')).count
    const r = await call('schedule_add', { name: '坏 cron', schedule: '不是 cron', prompt: 'x', cwd: scheduleCwd })
    assert(r.created === false, '非法 cron 必须失败')
    mustInclude(r.error, 'cron', '错误信息里该点名 cron')
    assert((await call('schedules_list')).count === before, '失败时不该留下任务')
    return '非法 cron 被拒且无副作用'
  })

  await t('F3 schedule_update：只改传了的字段，没传的保持原样', async () => {
    const r = await call('schedule_update', { id: global.__probeTaskId, name: '改过的名字' })
    assert(r.updated === true, `应该改成功：${r.error}`)
    assert(r.task.name === '改过的名字', '名字没改')
    assert(r.task.prompt === '跑点东西', '没传的 prompt 被改了 —— 不该')
    assert(r.task.schedule === '0 9 * * *', '没传的 cron 被改了 —— 不该')
    assert(JSON.stringify(r.changed) === '["name"]', `changed 应该是 ["name"]，实际 ${JSON.stringify(r.changed)}`)
    return '只改了 name'
  })

  await t('F4 schedule_update 也校验 cron', async () => {
    const r = await call('schedule_update', { id: global.__probeTaskId, schedule: '*/abc * * * *' })
    assert(r.updated === false, '非法 cron 必须失败')
    const now = await call('schedules_list')
    const task = now.tasks.find(x => x.id === global.__probeTaskId)
    assert(task.schedule === '0 9 * * *', '失败时原值不该被破坏')
    return '拒绝非法 cron 且原值完好'
  })

  await t('F5 schedule_set_enabled：停用后不再算下次触发', async () => {
    const off = await call('schedule_set_enabled', { id: global.__probeTaskId, enabled: false })
    assert(off.updated === true && off.enabled === false, '应该停用了')
    assert(off.task.next_fire_at === null, '停用的任务不该给下次触发时间')
    const on = await call('schedule_set_enabled', { id: global.__probeTaskId, enabled: true })
    assert(on.enabled === true && on.task.next_fire_at, '重新启用后该有下次触发')
    return '停用 / 启用 都正确'
  })

  await t('F6 schedule_remove：不带 confirm 只预告，带 confirm 才真删', async () => {
    const dry = await call('schedule_remove', { id: global.__probeTaskId })
    assert(dry.confirm_required === true, '应该要求显式确认')
    assert(dry.would_remove.id === global.__probeTaskId, '预告里该带上会被删的是哪条')
    assert((await call('schedules_list')).count === 2, '没确认时不该删')

    const done = await call('schedule_remove', { id: global.__probeTaskId, confirm: true })
    assert(done.removed === true, '确认后应该真删')
    const list = await call('schedules_list')
    assert(list.count === 1, `删完应该只剩 1 条，实际 ${list.count}`)
    assert(list.tasks[0].id === 's1', '删错的应该是新建那条')
    return '确认门生效 · 只删了目标那条'
  })

  await t('F7 schedule_* 对不存在的 id 给明确错误，不静默成功', async () => {
    for (const [name, args] of [
      ['schedule_update', { id: 'nope', name: 'x' }],
      ['schedule_remove', { id: 'nope', confirm: true }],
      ['schedule_set_enabled', { id: 'nope', enabled: true }],
    ]) {
      const r = await call(name, args)
      assert(r.error, `${name} 应该报错`)
      mustInclude(r.error, '找不到', `${name} 的错误信息`)
    }
    const run = await call('schedule_run_now', { id: 'nope' })
    assert(run.error && !run.started, 'run_now 也不该假装成功')
    return '不存在的 id 一律明确报错'
  })

  // ── G. 内存态注入（挂在 g ui 进程内时拿完整输出）───────────
  const FULL_OUTPUT = 'F'.repeat(5000) // 比 live-jobs 的截尾长度小，但远超默认返回预算
  const fakeJobs = () => ([
    { id: 'mem1', taskId: 't1', title: '内存里正在跑', status: 'running', agent: 'claude', output: FULL_OUTPUT, toolCalls: [{ name: 'run_command' }], startedAt: '2026-10-02T00:00:00.000Z', lastActivityAt: '2026-10-02T00:00:01.000Z' },
    { id: 'mem2', taskId: 't1', title: '内存里已结束', status: 'done', agent: 'claude', output: 'MEM_DONE_OUTPUT', endedAt: '2026-10-02T01:00:00.000Z', startedAt: '2026-10-02T00:50:00.000Z' },
  ])
  const withJobs = { cwd: 'C:\\proj', locale: 'zh', getLiveJobs: async () => fakeJobs() }

  await t('G1 注入 getLiveJobs 后：source=process、output_complete=true、不再读盘', async () => {
    const r = await call('runtime_status', {}, withJobs)
    assert(r.source === 'process', `source 应该是 process，实际 ${r.source}`)
    assert(r.output_complete === true, 'output_complete 应该是 true')
    assert(r.running_job_count === 1, `应该有 1 个在跑，实际 ${r.running_job_count}`)
    assert(r.running_jobs[0].id === 'mem1', '应该是内存里那条')
    // 完整态会给出原文总长度 —— 读盘的截尾快照给不出这个
    assert(r.running_jobs[0].outputLength === FULL_OUTPUT.length, `应该报出完整长度 ${FULL_OUTPUT.length}，实际 ${r.running_jobs[0].outputLength}`)
    assert(r.output_note === undefined, '完整态时不该再挂"截尾"提示')
    return `source=process · 输出全文 ${FULL_OUTPUT.length} 字符`
  })

  await t('G2 没注入时退回读盘，并如实标注 output_complete=false', async () => {
    const r = await call('runtime_status', {})
    assert(r.source === 'file', `没注入时应该读盘，实际 ${r.source}`)
    assert(r.output_complete === false, '读盘时 output_complete 应该是 false')
    mustInclude(r.output_note, '截尾', '必须告诉调用方输出是截尾的')
    assert(r.running_jobs[0].outputLength === undefined, '截尾态不该谎报原文长度')
    return '已退回读盘并如实标注'
  })

  await t('G3 内存态也让 workbench_task_detail 拿到"还在跑"的那一次', async () => {
    const r = await call('workbench_task_detail', { task_id: 't1' }, withJobs)
    assert(r.source === 'process', `source 应该是 process，实际 ${r.source}`)
    assert(r.output_complete === true, 'output_complete 应该是 true')
    assert(r.run_count === 2, `内存态里 t1 应该有 2 次执行，实际 ${r.run_count}`)
    const ids = r.runs.map(x => x.id)
    assert(ids.includes('mem1'), `应该包含正在跑的 mem1，实际 ${JSON.stringify(ids)}`)
    const detail = await call('workbench_task_detail', { task_id: 't1' })
    assert(detail.output_complete === false, '读盘时应该是 false')
    mustInclude(detail.note, 'runtime_status', '读盘时该指引去看运行中的')
    return '内存态含在跑那次 · 读盘时如实标注并指引'
  })
}

// ── Phase C：stdio 端到端 ───────────────────────────────────────
/**
 * 注意这里**发完就把 stdin 关了**（不等响应）—— 这是命令行客户端的常规写法，
 * 也正好压住 stdio.js 里那个坑：stdin 一关就退出的话，在飞的工具调用连同响应一起丢。
 * 所以断言不是"收到了响应"，而是"关掉 stdin 之后响应仍然到齐"。
 */
function stdioE2E() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src/gitCommit.js'), 'mcp'], {
      cwd: ROOT,
      env: { ...process.env, USERPROFILE: SANDBOX, HOME: SANDBOX },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let exited = false
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', d => { stdout += d })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', d => { stderr += d })

    const send = obj => child.stdin.write(`${JSON.stringify(obj)}\n`)
    const deadline = setTimeout(() => {
      child.kill()
      reject(new Error(`stdio 端到端超时。stdout=${stdout.slice(0, 600)} stderr=${stderr.slice(0, 600)}`))
    }, 30_000)

    const settle = () => {
      clearTimeout(deadline)
      resolve({ stdout, stderr, exited })
    }

    // 收到 4 条响应、且进程已退出 → 收工
    const maybeDone = () => {
      const ids = stdout.split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l).id } catch { return undefined } })
        .filter(x => x !== undefined)
      if (exited && ids.length >= 4) settle()
    }
    child.stdout.on('data', maybeDone)
    child.on('exit', () => { exited = true; setTimeout(maybeDone, 50) })

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'probe', version: '0' } } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'workbench_task_detail', arguments: { task_id: 't1' } } })
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'workbench_dispatch', arguments: { text: '不应成功的派发' } } })
    // 立刻关 stdin —— 不等任何响应
    child.stdin.end()
  })
}

// ── Phase D：HTTP 传输（挂在 express 上那条路）────────────────────
/**
 * 起一个最小 express app + 挂真路由，打真 HTTP。
 * 与 verify-memory-panel.cjs 同一个思路：验的是**路由层**，不需要拉起整个 server.js
 * （那会连带 configManager / local-file-picker / aiContext 一堆依赖）。
 */
function httpPhase() {
  return new Promise((resolve, reject) => {
    ;(async () => {
      const express = (await import('express')).default
      const { createMcpRouter } = await import(pathToFileURL(path.join(ROOT, 'src/mcp/http.js')).href)

      const app = express()
      app.use(express.json())
      app.use('/api/mcp', createMcpRouter({ getCwd: () => 'C:\\proj' }))
      const server = app.listen(0, '127.0.0.1', async () => {
        const port = server.address().port
        const url = `http://127.0.0.1:${port}/api/mcp`
        try {
          const post = async (body, headers) => {
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(headers || {}) },
              body: JSON.stringify(body),
            })
            const text = await res.text()
            let json = null
            try { json = text.trim() ? JSON.parse(text) : null } catch { /* 非 JSON */ }
            return { status: res.status, json, text }
          }

          await t('D1 GET /api/mcp 是发现入口（不是一条永远没消息的 SSE）', async () => {
            const res = await fetch(url, { headers: { Accept: 'application/json, text/event-stream' } })
            const body = await res.json()
            assert(res.status === 200, `状态码应该是 200，实际 ${res.status}`)
            assert(body.transport.includes('streamable-http'), `transport 不对：${body.transport}`)
            assert(body.tool_count >= 12, `工具数不对：${body.tool_count}`)
            assert(body.cwd === 'C:\\proj', `cwd 应该来自 getCwd()，实际 ${body.cwd}`)
            return `200 · ${body.tool_count} 个工具 · cwd=${body.cwd}`
          })

          await t('D2 POST initialize / tools/list 与 stdio 侧行为一致', async () => {
            const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'probe' } } })
            assert(init.status === 200, `initialize 状态码 ${init.status}`)
            assert(init.json.result?.protocolVersion === '2024-11-05', '应该回客户端报的版本')
            assert(init.json.result?.serverInfo?.name === 'zen-gitsync', 'serverInfo 不对')

            const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
            assert(list.json.result.tools.length >= 12, 'tools/list 工具数不对')
            return `协议 ${init.json.result.protocolVersion} · ${list.json.result.tools.length} 个工具`
          })

          await t('D3 通知类请求回 202 且无响应体（不能被当成响应）', async () => {
            const res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
            assert(res.status === 202, `通知应该回 202，实际 ${res.status}`)
            assert(!res.text.trim(), `通知不该有响应体，实际 ${res.text.slice(0, 120)}`)
            return '202 Accepted · 空 body'
          })

          await t('D4 POST tools/call 真读到沙箱数据', async () => {
            const res = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'workbench_projects', arguments: {} } })
            assert(res.status === 200, `状态码 ${res.status}`)
            const payload = JSON.parse(res.json.result.content[0].text)
            assert(payload.project_count === 1, `项目数应该是 1，实际 ${payload.project_count}`)
            return `200 · 1 个项目 · 编排台 active=${payload.orchestrator.active}`
          })

          await t('D5 无状态：不带 Mcp-Session-Id 连发多次结果一致，且响应不回会话头', async () => {
            // ⚠️ 别用 schedules_list 比对 —— 它每次都现算 next_fire_at，两次响应天然不等。
            // 拿纯文件读取的工具才比得出"有没有会话漂移"。
            const a = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'agent_mcp_servers', arguments: {} } })
            const b = await post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'agent_mcp_servers', arguments: {} } })
            assert(a.status === 200 && b.status === 200, '两次都应该 200')
            // 只比 result —— 响应的 id 本来就该不同（那是回显），比整串会永远是红的
            assert(
              JSON.stringify(a.json.result) === JSON.stringify(b.json.result),
              `同一请求两次的 result 应该一致（说明确实无状态、没有会话漂移）\nA=${a.text.slice(0, 200)}\nB=${b.text.slice(0, 200)}`,
            )

            const raw = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list' }),
            })
            assert(!raw.headers.get('mcp-session-id'), '无状态实现不该回 Mcp-Session-Id')
            return '连发两次结果一致 · 无会话头'
          })

          await t('D6 DELETE 会话结束回 200（无状态服务端也不该报错）', async () => {
            const res = await fetch(url, { method: 'DELETE' })
            assert(res.status === 200, `DELETE 应该回 200，实际 ${res.status}`)
            return '200'
          })

          server.close(() => resolve())
        } catch (err) {
          server.close(() => reject(err))
        }
      })
      server.on('error', reject)
    })().catch(reject)
  })
}

async function main() {
  await inProcess()

  await t('C1 stdio 端到端：发完即关 stdin，握手 / tools/list / tools/call 仍全部答齐', async () => {
    const { stdout, stderr, exited } = await stdioE2E()
    const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean)

    // ── 最关键的守卫：stdout 只能有协议帧 ──
    for (const line of lines) {
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        throw new Error(`stdout 被污染了 —— 这一行不是合法 JSON：${line.slice(0, 200)}\n（stdio 传输里 stdout 就是协议通道，任何多余输出都会让客户端解析失败）`)
      }
      assert(msg.jsonrpc === '2.0', `stdout 里的 JSON 不是 JSON-RPC：${line.slice(0, 200)}`)
    }

    const byId = {}
    for (const line of lines) {
      const msg = JSON.parse(line)
      if (msg.id !== undefined) byId[msg.id] = msg
    }

    assert(exited, '进程应该在 stdin 关闭后自己退出（不该挂在那儿）')
    assert(byId[1]?.result?.serverInfo?.name === 'zen-gitsync', 'id=1 不是 initialize 的响应')
    assert(Array.isArray(byId[2]?.result?.tools) && byId[2].result.tools.length >= 12, 'id=2 的 tools/list 不对')
    mustInclude(byId[3]?.result?.content?.[0]?.text || '', 'DONE_MARKER_OUTPUT', 'id=3 的工具结果（stdin 关掉后仍须回来）')
    // 通知不该产生响应：4 条请求 → 恰好 4 条响应
    assert(Object.keys(byId).length === 4, `应该恰好 4 条响应，实际 ${Object.keys(byId).length}（通知被回成响应了？或者有响应丢了？）`)
    // 写工具在目标不可达时必须如实失败
    const dispatchText = JSON.stringify(byId[4]?.result || {})
    assert(!dispatchText.includes('"dispatched":true'), 'stdio 侧也不得声称派发成功')

    return `4 条响应全到齐 · stdout ${lines.length} 行全是合法 JSON-RPC · 进程自行退出 · stderr ${stderr.split('\n').length} 行日志`
  })

  await httpPhase()

  const failed = results.filter(r => !r.ok)
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.msg ? `\n      ${r.msg}` : ''}`)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  fs.rmSync(SANDBOX, { recursive: true, force: true })
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => {
  console.error('探针自身崩了：', err)
  fs.rmSync(SANDBOX, { recursive: true, force: true })
  process.exit(2)
})
