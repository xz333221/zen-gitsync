import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchGai, registerFileOpenRoutes } from './fileOpen.js'

test('Windows g ai launcher keeps directory characters out of shell source', async () => {
  const directory = "C:\\项目 & test's %name%\\current"
  let actual
  await launchGai(directory, { platform: 'win32', spawnFn: async (...args) => { actual = args } })
  assert.equal(actual[0], 'powershell.exe')
  assert.equal(actual[2].cwd, directory)
  assert.equal(actual[2].windowsHide, true)
  const script = Buffer.from(actual[1].at(-1), 'base64').toString('utf16le')
  assert.doesNotMatch(script, /%name%|test's/)
  assert.match(script, /-WorkingDirectory \(Get-Location\).ProviderPath/)
  assert.match(script, /-WindowStyle Normal/)
  const inner = script.match(/'-EncodedCommand','([^']+)'/)[1]
  const command = Buffer.from(inner, 'base64').toString('utf16le')
  assert.ok(command.includes(process.execPath.replace(/'/g, "''")))
  assert.match(command, /gitCommit\.js' 'ai'$/)
})

test('POSIX launches the bundled CLI with structured arguments in the selected directory', async () => {
  let actual
  await launchGai('/tmp/project with spaces', { platform: 'linux', terminalFn: async (...args) => { actual = args } })
  assert.equal(actual[0], '/tmp/project with spaces')
  assert.equal(actual[1], process.execPath)
  assert.equal(actual[2][1], 'ai')
  assert.ok((await fs.stat(actual[2][0])).isFile())
})

test('g ai endpoint validates directories and reports launch failures', async t => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-g-ai-launch-'))
  const project = path.join(fixture, "项目 & test's %name%")
  await fs.mkdir(project)
  const file = path.join(fixture, 'file.txt')
  await fs.writeFile(file, 'not a directory')
  t.after(async () => {
    assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()))
    assert.ok(path.basename(fixture).startsWith('zen-g-ai-launch-'))
    await fs.rm(fixture, { recursive: true, force: true })
  })
  const routes = new Map(), launches = []
  let fail = false
  registerFileOpenRoutes({
    app: { get: () => {}, post: (url, handler) => routes.set(url, handler) },
    launchAi: async directory => { if (fail) throw new Error('terminal unavailable'); launches.push(directory) },
  })
  const handler = routes.get('/api/open-directory-with-g-ai')
  async function request(body) {
    const response = { code: 200, body: null, status(code) { this.code = code; return this }, json(value) { this.body = value; return this } }
    await handler({ method: 'POST', path: '/api/open-directory-with-g-ai', body }, response)
    return response
  }
  for (const value of [undefined, '', ' ', {}, 42, 'bad\npath', file, path.join(fixture, 'missing')]) {
    const response = await request({ path: value })
    assert.equal(response.code, 400)
    assert.equal(response.body.success, false)
  }
  assert.equal(launches.length, 0)
  const good = await request({ path: project })
  assert.equal(good.body.success, true)
  assert.deepEqual(launches, [project])
  fail = true
  const error = await request({ path: project })
  assert.equal(error.code, 400)
  assert.match(error.body.error, /terminal unavailable/)
})
