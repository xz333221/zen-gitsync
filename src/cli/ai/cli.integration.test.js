import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('../../gitCommit.js', import.meta.url))

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-ai-cli-'))
  // Every subprocess gets an isolated home/config and only a local fake provider.
  const profile = path.join(directory, 'profile'), project = path.join(directory, 'project')
  await fs.mkdir(path.join(profile, '.zen-gitsync'), { recursive: true })
  await fs.mkdir(project)
  await fs.writeFile(path.join(project, 'demo.txt'), 'fixture text')
  await fs.writeFile(path.join(project, 'AGENTS.md'), '@CLAUDE.md')
  await fs.writeFile(path.join(project, 'CLAUDE.md'), 'Fixture project rule: verify before editing.')
  const requests = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    requests.push(body)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`)
    if (requests.length === 1) {
      for (let i = 1; i <= 15; i++) {
        for (const chunk of [`Inspection step ${i}: `, 'check the requested file.\n\n']) {
          send({ choices: [{ delta: { reasoning_content: chunk } }] })
        }
      }
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read1', type: 'function', function: { name: 'read_file', arguments: '{"path":"demo.txt"}' } }] }, finish_reason: 'tool_calls' }] })
      send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
    } else {
      send({ choices: [{ delta: { content: 'Fixture answer.\n' }, finish_reason: 'stop' }] })
      send({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } })
    }
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`
  await fs.writeFile(path.join(profile, '.zen-gitsync', 'config.json'), JSON.stringify({
    locale: 'en-US', models: [{ name: 'fixture', model: 'fixture', baseURL, apiKey: 'test-only', isDefault: true }],
  }))
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()))
    assert.ok(path.basename(directory).startsWith('zen-ai-cli-'))
    await fs.rm(directory, { recursive: true, force: true })
  })
  return { directory, profile, project, requests }
}

async function run(f, args, onOutput) {
  const child = spawn(process.execPath, [entry, 'ai', ...args], {
    cwd: f.directory, windowsHide: true,
    env: { ...process.env, USERPROFILE: f.profile, HOME: f.profile, NO_COLOR: '1', FORCE_COLOR: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data; onOutput?.(stdout, child) })
  child.stderr.on('data', data => { stderr += data })
  const timer = setTimeout(() => child.kill(), 12000)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  clearTimeout(timer)
  assert.equal(code, 0, stdout + stderr)
  assert.doesNotMatch(stderr, /fatal: not a git repository/)
  return stdout
}

test('CLI uses switched directory, saves metrics and loads local project instructions', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  let stage = 0
  const output = await run(f, [], (stdout, child) => {
    if (stage === 0 && stdout.includes('Zen GitSync')) { stage++; child.stdin.write(`/cd ${f.project}\n`) }
    else if (stage === 1 && stdout.includes('Working directory changed:')) { stage++; child.stdin.write('Read demo.txt\n') }
    else if (stage === 2 && stdout.includes('Token 180')) { stage++; child.stdin.write('/exit\n') }
  })
  assert.match(output, /first token/)
  assert.match(output, /first answer/)
  assert.match(output, /Token 180/)
  assert.match(output, /Inspection step 15:/)
  assert.doesNotMatch(output, /first 12 lines shown/)
  assert.equal(f.requests.length, 2)
  assert.match(f.requests[0].messages[0].content, /Fixture project rule/)
  assert.ok(f.requests[1].messages.some(m => m.role === 'tool' && m.content.includes('fixture text')))
  const dir = path.join(f.profile, '.zen-gitsync', 'agent-sessions')
  const files = (await fs.readdir(dir)).filter(file => file.endsWith('.json'))
  assert.equal(files.length, 1)
  const saved = JSON.parse(await fs.readFile(path.join(dir, files[0]), 'utf8'))
  assert.equal(saved.cwd, f.project)
  assert.equal(saved.lastTurnStats.usage.totalTokens, 180)
  assert.equal(saved.sessionStats.turns, 1)
  assert.equal(saved.messages.at(-1).content, 'Fixture answer.\n')
})

test('one-shot CLI shows full thinking by default and prints the usage footer', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const output = await run(f, ['inspect'])
  assert.match(output, /Token 180/)
  assert.match(output, /One-shot done/)
  assert.match(output, /Inspection step 15:/)
  assert.doesNotMatch(output, /first 12 lines shown/)
})

test('CLI help lists thinking modes and /think full shows reasoning beyond the preview', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  let stage = 0
  const output = await run(f, [], (stdout, child) => {
    if (stage === 0 && stdout.includes('Zen GitSync')) { stage++; child.stdin.write('/help\n') }
    else if (stage === 1 && stdout.includes('/think compact')) { stage++; child.stdin.write('/think full\n') }
    else if (stage === 2 && stdout.includes('Thinking for future requests: full')) { stage++; child.stdin.write('Read demo.txt\n') }
    else if (stage === 3 && stdout.includes('Token 180')) { stage++; child.stdin.write('/exit\n') }
  })
  assert.equal(stage, 4)
  assert.match(output, /\/think full/)
  assert.match(output, /\/think off/)
  assert.match(output, /Inspection step 15: check the requested file\./)
  assert.doesNotMatch(output, /first 12 lines shown/)
  assert.equal(f.requests.length, 2, 'display commands must not call the model')
})

// 多行粘贴:终端开了 bracketed paste 之后,一次粘贴是 `\x1b[200~…\x1b[201~` 包起来的一整段。
// 这里用真进程验证最关键的那条契约 —— 里面 3 个换行**不会**被当成 3 次回车,
// 模型收到的是一条消息,内容是带真实换行的原文。
test('multi-line paste is sent as one message with real newlines', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  let stage = 0
  const output = await run(f, [], (stdout, child) => {
    if (stage === 0 && stdout.includes('Zen GitSync')) {
      stage++
      child.stdin.write('\x1b[200~RADAR_BASE_URL=https://example.test/v1\nRADAR_API_KEY=sk-secret\nRADAR_MODEL=deepseek\x1b[201~\n')
    } else if (stage === 1 && stdout.includes('Token 180')) {
      stage++
      child.stdin.write('/exit\n')
    }
  })
  assert.equal(stage, 2)

  // 管道模式下 readline 不回显输入行,所以这里看不到 [paste #N] 占位符(TTY 里由
  // readline 自己回显);占位符的生成/还原与 TTY 回显在 paste.test.js / termui.test.js 里单测覆盖。
  // 这里只钉住真进程链路上最关键的两条:没有第 2、3 次提交,以及模型拿到的是带换行的原文。
  assert.doesNotMatch(output, /Agent is working/)

  const userMessage = f.requests[0].messages.at(-1)
  assert.equal(userMessage.role, 'user')
  assert.equal(
    userMessage.content,
    'RADAR_BASE_URL=https://example.test/v1\nRADAR_API_KEY=sk-secret\nRADAR_MODEL=deepseek'
  )
})
