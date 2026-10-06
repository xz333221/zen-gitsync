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

function install(extraArgs) {
  const args = ['install', '--legacy-peer-deps', '--no-audit', '--no-fund', ...extraArgs]
  console.log(`[ensure-client-deps] npm ${args.join(' ')}`)
  const r = spawnSync('npm', args, {
    cwd: clientDir,
    stdio: 'inherit',
    shell: true // shell:true 兼容 Windows 的 npm.cmd
  })
  return r.status == null ? 1 : r.status
}

// 第一枪沿用 --prefer-offline（命中本地缓存，快）。
let status = install(['--prefer-offline'])

if (status !== 0) {
  // 失败里最常见的一类是 **缓存里的 packument 过期**：依赖刚发了新版本，而本地缓存的
  // 元数据还停在上一版，于是 `^x.y.z` 直接报
  //   npm error code ETARGET
  //   npm error notarget No matching version found for <pkg>@^x.y.z
  // 看着像"这个版本不存在"，其实 registry 上早就有。
  // 实测 2026-10-06：flow-mindmap 从 0.6.3 升到 ^0.6.4 后 dev:vue 直接 exit 1，
  // 而官方源上 0.6.4 就是 latest —— `--prefer-offline` 用的是缓存里的旧 packument。
  // 这类事故不该让人去清缓存 / 换 registry / 手改版本号：--prefer-online 重试一枪就好。
  console.log('[ensure-client-deps] 上面这一步失败，改走 --prefer-online 重试一次（多半是缓存的 packument 过期）…')
  status = install(['--prefer-online'])
}

process.exit(status)
