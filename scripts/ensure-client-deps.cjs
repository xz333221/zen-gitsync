#!/usr/bin/env node
// 前端依赖新鲜度守卫(dev:vue 前置步骤)。
//
// 背景:npm run dev 每次都在 vite 启动前跑一遍 `npm install`,即使 lockfile
// 没变、纯 no-op 也要花 ~8-9s(audited 756 packages),占热启动总耗时一半以上。
//
// 策略:以 npm 安装后写入的 node_modules/.package-lock.json(npm 7+ 隐藏
// lockfile,反映真实安装树)为锚点,它的 mtime 不早于 client 的 package.json
// 与 package-lock.json → 认为依赖新鲜,直接跳过;否则才真正执行 npm install。
//
// 已知取舍:若手动删了 node_modules 里某个包,锚点不会变,会错误跳过。
// 此时跑一次 `npm run install:vue` 全量安装即可恢复。

const { statSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const clientDir = path.resolve(__dirname, '../src/ui/client')
const marker = path.join(clientDir, 'node_modules/.package-lock.json')
const pkgJson = path.join(clientDir, 'package.json')
const lockJson = path.join(clientDir, 'package-lock.json')

function mtime(p) {
  try {
    return statSync(p).mtimeMs
  } catch {
    return 0 // 文件不存在按 0 处理,必然触发安装
  }
}

const t0 = Date.now()
const markerMs = mtime(marker)
const fresh =
  markerMs > 0 &&
  markerMs >= mtime(pkgJson) &&
  markerMs >= mtime(lockJson)

if (fresh) {
  console.log(`[ensure-client-deps] 依赖新鲜,跳过 npm install (检查耗时 ${Date.now() - t0}ms)`)
  process.exit(0)
}

console.log('[ensure-client-deps] 依赖有变化或 node_modules 缺失,执行 npm install…')
const r = spawnSync(
  'npm',
  ['install', '--legacy-peer-deps', '--no-audit', '--no-fund', '--prefer-offline'],
  { cwd: clientDir, stdio: 'inherit', shell: true } // shell:true 兼容 Windows 的 npm.cmd
)
process.exit(r.status == null ? 1 : r.status)
