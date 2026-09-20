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
      send({ choices: [{ delta: { reasoning_content: 'Inspect the requested file.\n' } }] })
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

test('one-shot CLI prints the same usage footer', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const output = await run(f, ['inspect'])
  assert.match(output, /Token 180/)
  assert.match(output, /One-shot done/)
})
