import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstanceRegistry } from './instanceRegistry.js'

function makeFs(initial = '{}') {
  const files = new Map()
  files.set('registry', initial)
  return {
    async readFile(p, enc) {
      if (!files.has('registry')) {
        const err = new Error('ENOENT')
        err.code = 'ENOENT'
        throw err
      }
      return files.get('registry')
    },
    async writeFile(p, data, enc) {
      files.set('registry.tmp', data)
    },
    async rename(from, to) {
      files.set('registry', files.get('registry.tmp'))
      files.delete('registry.tmp')
    }
  }
}

function makePath() {
  return {
    join(...parts) { return parts.join('/') },
    basename(p) { return p.split('/').pop() }
  }
}

function makeOs(hostname = 'test-host') {
  return { hostname: () => hostname }
}

function setup({ initial = '{"version":1,"instances":{}}' } = {}) {
  const fs = makeFs(initial)
  const path = makePath()
  const os = makeOs()
  const registryPath = 'registry'
  const registry = createInstanceRegistry({ fs, path, os, registryPath })
  return { registry, fs }
}

async function readRegistry(fs) {
  const raw = await fs.readFile('registry', 'utf-8')
  return JSON.parse(raw)
}

test('heartbeat: 条目存在时只刷新 lastHeartbeat', async () => {
  const oldTime = Date.now() - 10_000
  const initial = JSON.stringify({
    version: 1,
    instances: {
      '100': {
        pid: 100,
        port: 9876,
        projectName: 'p1',
        projectPath: '/path/1',
        startedAt: oldTime,
        lastHeartbeat: oldTime,
        hostname: 'host1'
      }
    }
  })
  const { registry, fs } = setup({ initial })

  await registry.heartbeat(100, { projectPath: '/path/1' })

  const obj = await readRegistry(fs)
  const entry = obj.instances['100']
  assert.equal(entry.pid, 100)
  assert.equal(entry.port, 9876)
  assert.equal(entry.projectName, 'p1')
  assert.ok(entry.lastHeartbeat > oldTime, 'lastHeartbeat 应该被刷新')
})

test('heartbeat: 条目不存在且信息完整时自愈重建', async () => {
  const { registry, fs } = setup()

  await registry.heartbeat(100, {
    port: 9876,
    projectPath: '/path/1',
    projectName: 'p1',
    hostname: 'host1'
  })

  const obj = await readRegistry(fs)
  const entry = obj.instances['100']
  assert.ok(entry, '条目应该被重建')
  assert.equal(entry.pid, 100)
  assert.equal(entry.port, 9876)
  assert.equal(entry.projectName, 'p1')
  assert.equal(entry.projectPath, '/path/1')
  assert.equal(entry.hostname, 'host1')
  assert.ok(entry.startedAt > 0)
  assert.ok(entry.lastHeartbeat > 0)
})

test('heartbeat: 条目不存在且信息不完整时不重建', async () => {
  const { registry, fs } = setup()

  await registry.heartbeat(100, { projectPath: '/path/1' }) // 缺少 port

  const obj = await readRegistry(fs)
  assert.deepEqual(obj.instances, {}, '不应该写入任何条目')
})
