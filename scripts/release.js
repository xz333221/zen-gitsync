#!/usr/bin/env node
// Copyright 2026 xz333221
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//

/**
 * 发布前准备工作
 * 1. 更新版本号(最后一位加 1)
 * 2. 构建前端项目
 * 3. 提交更改到 git
 * 4. 发布到 npm
 *
 * 用法:
 *   npm run release                      # 全流程,自伤护栏全部开启
 *   npm run release -- --skip-self-update # 发布后不自动 npm install -g zen-gitsync
 *   npm run release -- --keep-instances   # 装全局前不停掉运行中的 UI 实例(默认会停)
 *   npm run release -- --skip-push        # 只发布到 npm,不 push git
 *   npm run release -- --dry-run          # 只打印计划,不真正改 package.json / commit / publish
 *   npm run release -- --poll-interval=20 --poll-timeout=600  # 调自更新重试节奏(秒)
 *   npm run release -- --install-timeout=900               # 单次 npm install 上限(秒),0 = 不限时(默认)
 *
 * 发布后自更新:每轮先探 tarball 能不能取,能取到才调 npm;两条路(`pkg@<版本>` /
 * tarball URL 直连)都试,装上后校验全局版本,失败把原因打出来。
 * 原因见 tarballUrl() / selfUpdateGlobal() 处注释 —— publish 成功不等于
 * packument 立即可见,也不等于 tarball 立即可取(两种先后顺序都实测出现过)。
 *
 * 自更新前置步骤:先把运行中的 UI 实例停掉(见 stopRunningInstances 处注释)——
 * Windows 上全局包目录被实例占着时,npm 删旧目录会 EPERM,装不上或装出半成品。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync, spawn } from 'node:child_process'
import chalk from 'chalk'
import readline from 'node:readline/promises'
import { createInstanceRegistry, getRegistryPath } from '../src/ui/server/utils/instanceRegistry.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

const argv = process.argv.slice(2)
const DRY_RUN = argv.includes('--dry-run')
const SKIP_SELF_UPDATE = argv.includes('--skip-self-update')
const SKIP_PUSH = argv.includes('--skip-push')
const KEEP_INSTANCES = argv.includes('--keep-instances')

const NPM_REGISTRY = 'https://registry.npmjs.org/'
const PKG_NAME = 'zen-gitsync'

// 读 `--xxx=<数字>` 形式的数值参数,非法/缺失时回落默认值
function readNumberArg(name, fallback) {
  const prefix = `${name}=`
  const hit = argv.find((a) => a.startsWith(prefix))
  if (!hit) return fallback
  const parsed = Number(hit.slice(prefix.length))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

// `npm publish` 返回成功 ≠ registry 立即对外可见:新版本要经过 registry 后台处理
// ("Your package is being processed" 不是客套话) + CDN 缓存刷新。
// 实测(2026-09-18, v2.17.3):publish 成功后 5 分钟,registry 上 dist-tags.latest
// 仍是 2.17.2,versions 里没有 2.17.3;packument 响应头
// `Cache-Control: public, max-age=300` —— 光 CDN 层就可能滞后 5 分钟。
// 所以"publish 完立刻 npm install -g"必然装回旧版(实测 `npm ls -g` 停在 2.17.2)。
//
// 再实测(2026-09-20, v2.17.4):滞后不止 600s。那次脚本"先等 dist-tags 翻牌"一直等到
// 超时(600s 里 latest 全程是 2.17.3),超时后再 install 依旧 ETARGET —— 因为
// `npm view dist-tags` 和 `npm install pkg@ver` 读的是**同一份 packument**:
// 等它、用它,走的是同一条被缓存的路。只把超时 600s 往上加,只是把失败往后推。
//
// 兜底:tarball URL 是不可变资源,且不经过 packument 那层缓存(见 tarballUrl 注释)。
// 所以自更新不再把安装卡在 dist-tags 后面,而是"反复尝试安装 + 校验全局版本",
// 精确版本号解析不到时自动改用 tarball 直连。
//
// 又实测(2026-09-20, v2.17.6):tarball 也可能**晚于** packument 就绪 ——
// dist-tags.latest 已经是 2.17.6,而那个 tarball 的 Last-Modified 晚了 2 分钟,
// 这 2 分钟里两条路一起失败(对象还不存在),之后又有几分钟边缘缓存回 404。
// 于是 600s 眼看要耗尽、终端上 25 轮只有"→ npm install"没有任何原因。
// 对策两条:① 每轮先自己探一次 tarball(isTarballFetchable,GET 而非 HEAD),
// 取不到就跳过这一轮的 npm 调用并把状态打出来;② 失败原因压一行打出来。
// 单次 npm 调用不再硬性截断(见 INSTALL_TIMEOUT_MS):曾经给 180s 是为了"快速失败、
// 把重试交给外层循环",但实测更常见的是 180s 不够 —— 每轮装到一半被杀、下轮从零重来,
// 进度永远清零(2026-09-24 v2.17.14 卡了 27 轮)。要收紧可用 `--install-timeout=<秒>`。
//
// 默认 15s 一轮、上限 600s;可用 `--poll-interval=<秒>` / `--poll-timeout=<秒>` 调。
const POLL_INTERVAL_MS = readNumberArg('--poll-interval', 15) * 1000
const POLL_TIMEOUT_MS = readNumberArg('--poll-timeout', 600) * 1000

// 发布物 tarball 的地址。
//
// 为什么值得单独走这条路:tarball 按 URL 寻址、内容不可变,不像 packument 那样被
// max-age 挂在旧内容上 —— "新版本已发布、但 packument 还是旧的"时,它是唯一能立刻装上的路径。
//
// 但**两种先后顺序都实测出现过**,别押任何一边:
//   - v2.17.4:packument 滞后 >600s,tarball 早就可取;
//   - v2.17.6:反过来 —— dist-tags 已经是 2.17.6 了,tarball 的 Last-Modified 却晚 2 分钟,
//     那 2 分钟里 `npm install -g pkg@2.17.6` 和直连 tarball 一起失败(取不到那个对象)。
// 所以自更新每轮**两条路都试**,并且用 isTarballFetchable() 自己先探一次。
//
// `cacheBust=true` 时带一个时间戳查询串:目标 URL 在被发布出来的头几分钟里,
// CDN 边缘可能还挂着"这个路径 404"的负缓存(实测同一分钟内 HEAD 404 / GET 200),
// 换一个 URL 就等于绕开那份缓存。
function tarballUrl(version, cacheBust = false) {
  const base = `${NPM_REGISTRY.replace(/\/$/, '')}/${PKG_NAME}/-/${PKG_NAME}-${version}.tgz`
  return cacheBust ? `${base}?t=${Date.now()}` : base
}

// 探一次 tarball 到底能不能取到 —— 这比"packument 里有没有这个版本"更接近真相。
//
// 三个刻意的选择:
//   ① 用 GET 而不是 HEAD:实测同一个 URL 在同一分钟内 HEAD 返回 404、GET 返回 200,
//      npm 真正下载用的是 GET,所以只认 GET 的结果。
//   ② 带 `Range: bytes=0-0`,只取 1 个字节(服务端支持 Accept-Ranges);万一服务端忽略 Range
//      回了整包,读完后 cancel() 掉,不会真把 7MB 拖下来。
//   ③ 探不到不算致命:调用方据此跳过这一轮的 npm 调用(省下一次注定失败的 10~40s),
//      但拿不到 fetch(老 Node)时返回 unknown,让调用方照旧去试。
async function isTarballFetchable(version, cacheBust) {
  if (typeof fetch !== 'function') return { ok: true, unknown: true }
  try {
    const res = await fetch(tarballUrl(version, cacheBust), {
      headers: { Range: 'bytes=0-0' },
      redirect: 'follow',
    })
    const status = res.status
    try {
      await res.body?.cancel()
    } catch {
      /* 流已结束,忽略 */
    }
    return { ok: status === 200 || status === 206, status }
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.message || err) }
  }
}

// 把 npm 的一大坨输出压成一行,用来在每次失败时给出"为什么",而不是只报"重试中"。
// 例:`E404 Not Found - GET https://... - Not found`
function summarizeInstallError(output) {
  if (!output) return '未知错误'
  const lines = String(output)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('npm error') || l.startsWith('npm ERR!'))
    .map((l) => l.replace(/^npm (error|ERR!)\s*/, ''))
  if (lines.length === 0) return String(output).split(/\r?\n/)[0].slice(0, 160)
  return lines.slice(0, 2).join(' / ').slice(0, 200)
}

// 跨平台 sleep:Node 原生,避免 `sleep N || ping` 的 Windows 兜底 hack
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 显式白名单:只有这些文件路径会被 git add。
// 禁止 `git add .` 防止把工作区脏文件 / 临时调试文件一起带上 release commit。
// lockfile (package-lock.json) 在 .gitignore 里,
// 即便列在白名单也会被 git 拒绝 add,所以这里不列。
// 实际入 release commit 的只有 package.json(版本号)。
const RELEASE_FILES = ['package.json']

function createReadlineInterface() {
  return readline.createInterface({ input: process.stdin, output: process.stdout })
}

async function askContinue(message) {
  const rl = createReadlineInterface()
  try {
    const answer = await rl.question(message)
    return answer.toLowerCase() === 'y' || answer.trim() === ''
  } finally {
    rl.close()
  }
}

// 拿到本脚本派生出的 git 进程 PID 集合(用于精准 kill,避免误杀用户其他 git 进程)
const spawnedGitPids = new Set()
function runGit(args, opts = {}) {
  const proc = spawn('git', args, { stdio: opts.stdio ?? 'inherit', cwd: opts.cwd ?? rootDir })
  spawnedGitPids.add(proc.pid)
  return proc
}

// 精准终止本脚本派生出的 git 进程(不再 `pkill -f git` 一锅端用户机器上其他 git 进程)
function terminateSpawnedGitProcesses() {
  if (spawnedGitPids.size === 0) return
  for (const pid of spawnedGitPids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* 已退出,忽略 */
    }
  }
}

// 检查并清理 Git 锁文件
async function checkAndCleanGitLocks() {
  console.log(chalk.gray('检查 Git 锁文件...'))

  const gitDir = path.join(rootDir, '.git')

  // 具体的锁文件路径(不要通配符,避免误删)
  const lockFiles = [
    path.join(gitDir, 'index.lock'),
    path.join(gitDir, 'HEAD.lock'),
    path.join(gitDir, 'config.lock'),
    path.join(gitDir, 'packed-refs.lock'),
  ]
  // 扫描 refs/heads/*.lock 与 refs/remotes/*.lock
  const lockDirs = [path.join(gitDir, 'refs', 'heads'), path.join(gitDir, 'refs', 'remotes')]

  let hasBusyLocks = false
  const busyLocks = []

  for (const lockPath of lockFiles) {
    if (!fs.existsSync(lockPath)) continue
    try {
      await fsp.unlink(lockPath)
      console.log(chalk.green(`已删除锁文件: ${lockPath}`))
    } catch (err) {
      hasBusyLocks = true
      busyLocks.push({ path: lockPath, err })
      console.error(chalk.red(`无法删除锁文件 ${lockPath}:`), err.message)
    }
  }
  for (const dir of lockDirs) {
    if (!fs.existsSync(dir)) continue
    let entries
    try {
      entries = await fsp.readdir(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!name.endsWith('.lock')) continue
      const p = path.join(dir, name)
      try {
        await fsp.unlink(p)
        console.log(chalk.green(`已删除锁文件: ${p}`))
      } catch (err) {
        hasBusyLocks = true
        busyLocks.push({ path: p, err })
        console.error(chalk.red(`无法删除锁文件 ${p}:`), err.message)
      }
    }
  }

  if (hasBusyLocks) {
    // 仅终止本脚本派生出的 git 进程(不再 `pkill -f git`)
    console.log(chalk.yellow('锁文件被占用,尝试终止本脚本启动的 git 进程...'))
    terminateSpawnedGitProcesses()
    await sleep(2000)

    // 重试一次
    for (const item of busyLocks) {
      try {
        await fsp.unlink(item.path)
        console.log(chalk.green(`重试后已删除: ${item.path}`))
      } catch (err) {
        console.error(chalk.red(`重试仍无法删除 ${item.path}:`), err.message)
        const shouldContinue = await askContinue(
          chalk.yellow(`是否继续发布(可能导致失败)? (Y/n): `)
        )
        if (!shouldContinue) {
          throw new Error('用户选择终止发布')
        }
      }
    }
  } else {
    console.log(chalk.gray('未发现 Git 锁文件'))
  }
}

// 检查发布环境
async function checkEnvironment() {
  console.log(chalk.blue('=== 检查发布环境 ==='))

  try {
    execSync('git --version', { stdio: 'ignore' })
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' })
    await checkAndCleanGitLocks()

    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim()
    console.log(chalk.gray(`当前 Git 分支: ${currentBranch}`))

    if (currentBranch !== 'main' && currentBranch !== 'master') {
      const rl = createReadlineInterface()
      try {
        const answer = await rl.question(
          chalk.yellow(`当前不在主分支上,是否继续在 ${currentBranch} 分支上发布? (Y/n): `)
        )
        if (answer.toLowerCase() === 'n') throw new Error('用户选择取消发布')
      } finally {
        rl.close()
      }
    }

    // 工作区是否干净
    try {
      execSync('git diff --quiet && git diff --staged --quiet', { stdio: 'ignore' })
      console.log(chalk.green('Git 工作区干净'))
    } catch {
      console.log(chalk.yellow('Git 工作区有未提交的更改:'))
      execSync('git status -s', { stdio: 'inherit' })
      console.log('')
      const shouldContinue = await askContinue(
        chalk.yellow('有未提交的更改,是否继续发布? (Y/n): ')
      )
      if (!shouldContinue) throw new Error('用户选择取消发布')
    }

    console.log(chalk.green('环境检查通过'))
  } catch (err) {
    if (err.message === '用户选择取消发布') {
      console.log(chalk.yellow('发布已取消'))
      process.exit(0)
    }
    console.error(chalk.red('环境检查失败:'), err.message || err)
    process.exit(1)
  }
}

// TSC / vue-tsc 类型检查 — 走 vue-tsc(覆盖 .vue),与 dev 链路一致
async function runTypeCheck() {
  console.log(chalk.blue('\n=== TypeScript 类型检查 ==='))

  const frontendDir = path.join(rootDir, 'src', 'ui', 'client')
  if (!fs.existsSync(frontendDir)) {
    console.log(chalk.yellow('前端项目目录不存在,跳过 TSC 检查'))
    return
  }

  // tsconfig.app.json 已永久包含 "types": ["node"](无需本脚本再 mutate)
  try {
    console.log(chalk.gray('执行 vue-tsc -b --noEmit...'))
    execSync('npx vue-tsc -b --noEmit', { cwd: frontendDir, stdio: 'inherit' })
    console.log(chalk.green('vue-tsc 类型检查通过'))
  } catch (err) {
    console.error(chalk.red('vue-tsc 类型检查失败,请修复以上错误后重新发布'))
    process.exit(1)
  }
}

// 更新版本号(只动 package.json,不动 lockfile——lockfile 由发版后第一次 install 同步)
function updateVersion() {
  console.log(chalk.blue('\n=== 更新版本号 ==='))

  const packageJsonPath = path.join(rootDir, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
  const currentVersion = pkg.version
  const parts = currentVersion.split('.')
  const last = parseInt(parts[parts.length - 1], 10)
  parts[parts.length - 1] = String(last + 1)
  const newVersion = parts.join('.')
  pkg.version = newVersion

  if (DRY_RUN) {
    console.log(chalk.yellow(`[dry-run] 跳过写入: ${currentVersion} -> ${newVersion}`))
  } else {
    fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
    console.log(chalk.green(`版本号已更新: ${currentVersion} -> ${newVersion}`))
  }
  return newVersion
}

// 构建前端项目
async function buildFrontend() {
  console.log(chalk.blue('\n=== 构建前端项目 ==='))

  const frontendDir = path.join(rootDir, 'src', 'ui', 'client')
  if (!fs.existsSync(frontendDir)) {
    console.log(chalk.yellow('前端项目目录不存在,跳过构建'))
    return
  }

  try {
    const nodeModulesPath = path.join(frontendDir, 'node_modules')
    if (!fs.existsSync(nodeModulesPath)) {
      console.log(chalk.yellow('未找到前端依赖,开始安装...'))
      if (!DRY_RUN) {
        execSync('npm install', { cwd: frontendDir, stdio: 'inherit' })
        console.log(chalk.green('前端依赖安装完成'))
      }
    }

    console.log(chalk.gray('执行构建...'))
    if (!DRY_RUN) {
      execSync('npm run build', { cwd: frontendDir, stdio: 'inherit' })
    }
    console.log(chalk.green('前端项目构建完成'))
  } catch (err) {
    console.error(chalk.red('前端项目构建失败:'), err.message || err)
    const shouldContinue = await askContinue(chalk.yellow('前端构建失败,是否继续发布? (Y/n): '))
    if (!shouldContinue) {
      console.log(chalk.red('发布流程已取消'))
      process.exit(1)
    }
  }
}

// 发布物自检
//
// 为什么必须在发布前跑(2026-09-18 事故):`files` 是**逐条列举**的白名单,新加的
// `src/paths.js` / `src/fsAtomic.js` / `src/configSplit.js` / `src/dataDirMigration.js`
// 没被补进去 → 2.17.1 打出的 tarball 缺文件 → 全局 `g ui` 一起手就
// `ERR_MODULE_NOT_FOUND: .../src/paths.js imported from .../src/config.js`。
// 本地永远复现不了(本地有全部文件),只能靠"发布前证明发布物自洽"来守。
//
// 两道网,故意不合并:
//   ① 白名单语义正确性 —— 复用 `test/package-files.test.mjs`(唯一实现,别再抄一份):
//      展开 files → 逐个文件抽相对 import → 要求被 import 的也在发布物里。
//   ② 真实 `npm pack` —— 防"我以为 files 会带上它,但 .npmignore/.gitignore 反手排除了"。
async function verifyPackageContents() {
  console.log(chalk.blue('\n=== 发布物自检 ==='))

  // ① 白名单 vs 相对 import
  try {
    execSync(`"${process.execPath}" --test test/package-files.test.mjs`, { cwd: rootDir, stdio: 'inherit' })
  } catch {
    console.error(chalk.red(
      '发布物自检失败:package.json#files 覆盖不全(上面哪几条 not ok 就补哪几个文件)。\n'
      + '继续发布会打出缺文件的包 —— 用户装上就是 ERR_MODULE_NOT_FOUND。'
    ))
    process.exit(1)
  }
  console.log(chalk.green('① files 覆盖所有被 import 的本地模块'))

  // ② 真实 npm pack(只看清单,不落盘、不联网)
  let packJson
  try {
    const out = execSync('npm pack --dry-run --json', { cwd: rootDir, encoding: 'utf8' })
    // npm 可能在前/后混入提示行,这里取第一个 '[' 到最后一个 ']' 之间
    packJson = JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1))
  } catch (err) {
    console.error(chalk.red('npm pack --dry-run 失败:'), err.message || err)
    process.exit(1)
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'))
  const packed = new Set((packJson[0]?.files || []).map((f) => f.path))
  if (packed.size === 0) {
    console.error(chalk.red('npm pack 打出了空包,绝对有问题'))
    process.exit(1)
  }

  const notPacked = (pkg.files || []).filter((entry) => {
    if (entry.endsWith('/**')) {
      const prefix = entry.slice(0, -3)
      return ![...packed].some((p) => p === prefix || p.startsWith(prefix + '/'))
    }
    return !packed.has(entry)
  })

  if (notPacked.length) {
    console.error(chalk.red(
      `npm pack 里有 ${notPacked.length} 条 files 白名单没真正进包(大概率是 .npmignore / .gitignore 排除了):\n`
      + notPacked.map((e) => `  - ${e}`).join('\n')
    ))
    process.exit(1)
  }
  console.log(chalk.green(`② 真实打包 ${packed.size} 个文件,白名单逐条命中`))
}

// 仅把显式白名单文件 stage,并 sanity check
function stageReleaseFiles() {
  console.log(chalk.gray('stage 白名单文件(避免 `git add .` 误带脏文件)...'))
  for (const f of RELEASE_FILES) {
    const abs = path.join(rootDir, f)
    if (!fs.existsSync(abs)) continue
    if (DRY_RUN) {
      console.log(chalk.yellow(`[dry-run] git add ${f}`))
    } else {
      execSync(`git add ${JSON.stringify(f)}`, { stdio: 'inherit' })
    }
  }

  if (DRY_RUN) return

  // sanity check:staged 范围不能超出白名单
  const stagedOut = execSync('git diff --cached --name-only', { stdio: ['ignore', 'pipe', 'inherit'] })
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)
  const unexpected = stagedOut.filter((f) => !RELEASE_FILES.includes(f))
  if (unexpected.length) {
    console.error(chalk.red('staged 范围超出白名单,中止提交:'))
    for (const f of unexpected) console.error('  - ' + f)
    process.exit(1)
  }
}

// 提交更改到 git
async function commitChanges(version) {
  console.log(chalk.blue('\n=== 提交更改到 Git ==='))

  try {
    await checkAndCleanGitLocks()
    stageReleaseFiles()

    const commitMessage = `chore: 发布版本 v${version}`

    let committed = false
    let attempts = 0
    const maxAttempts = 3

    while (!committed && attempts < maxAttempts) {
      attempts++
      if (attempts > 1) {
        await checkAndCleanGitLocks()
        console.log(chalk.yellow(`重试提交 (${attempts}/${maxAttempts})...`))
        await sleep(2000)
      }

      try {
        if (DRY_RUN) {
          console.log(chalk.yellow(`[dry-run] git commit --no-verify -m "${commitMessage}"`))
          committed = true
        } else {
          execSync(`git commit --no-verify -m "${commitMessage}"`, { stdio: 'inherit' })
          committed = true
        }
      } catch (err) {
        if (attempts >= maxAttempts) throw err
        console.log(chalk.yellow(`提交失败,2 秒后重试...`))
        await sleep(2000)
      }
    }

    console.log(chalk.green(`已提交: "${commitMessage}"`))

    // tag
    if (DRY_RUN) {
      console.log(chalk.yellow(`[dry-run] git tag v${version}`))
    } else {
      execSync(`git tag v${version}`, { stdio: 'inherit' })
      console.log(chalk.green(`已创建标签: v${version}`))
    }

    if (SKIP_PUSH) {
      console.log(chalk.yellow('--skip-push: 跳过 git push'))
      return
    }

    const branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim()
    if (DRY_RUN) {
      console.log(chalk.yellow(`[dry-run] git push origin ${branch}`))
      console.log(chalk.yellow(`[dry-run] git push origin --tags`))
    } else {
      try {
        console.log(chalk.gray(`推送代码到远程仓库,分支: ${branch}...`))
        execSync(`git push origin ${branch}`, { stdio: 'inherit' })
        console.log(chalk.gray('推送标签到远程仓库...'))
        execSync('git push origin --tags', { stdio: 'inherit' })
        console.log(chalk.green('代码和标签已成功推送到远程仓库'))
      } catch (err) {
        console.error(chalk.red('推送到远程仓库失败:'), err.message)
        // 推送失败不阻塞 npm 发布
      }
    }
  } catch (err) {
    console.error(chalk.red('Git 提交失败:'), err.message || err)
    process.exit(1)
  }
}

// 查询 registry 上 dist-tags.latest。查询失败(网络抖动 / registry 波动)返回 null,
// 不视为致命错误 —— 交给轮询循环重试。
function readLatestDistTag() {
  try {
    const out = execSync(
      `npm view ${PKG_NAME} dist-tags.latest --json --registry=${NPM_REGISTRY} --prefer-online`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }
    )
    const parsed = JSON.parse(out.trim())
    return typeof parsed === 'string' ? parsed.replace(/^v/, '') : null
  } catch {
    return null
  }
}

// 当前 npm 的全局根(即 `npm install -g` 的落点)。
// `npm root -g` 不可用 / 超时:按 Node 安装目录兜底(Windows 下 npm 默认全局根就在这里)。
function readGlobalRoot() {
  try {
    const out = execSync('npm root -g', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    }).trim()
    if (out) return out
  } catch {
    /* npm 不可用,走兜底 */
  }
  return path.join(path.dirname(process.execPath), 'node_modules')
}

// 读本地全局已安装的版本,读不到返回 null。
// 不走 `npm ls -g <pkg> --json`:该包不存在时它退出码为 1 且输出里没有 dependencies
// 字段(实测只返回 {"name":"<node 版本目录名>"}),字段结构还随 npm 版本变;
// 直接读"当前 npm 的全局根"下该包的 package.json 更确定,也和 `npm install -g` 落点一致。
function readGlobalInstalledVersion() {
  const globalRoot = readGlobalRoot()
  if (!globalRoot) return null

  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(globalRoot, PKG_NAME, 'package.json'), 'utf8')
    )
    return pkg.version ?? null
  } catch {
    return null
  }
}

// 执行一次全局安装。退出码 0 才返回 ok。
// 输出先兜住不打印:重试期间每失败一次就刷一屏 `npm error` 太吵,
// 失败时由调用方压成一行打出来(summarizeInstallError),整轮失败才回放全文。
//
// 单次安装要不要设上限:**默认不设**(--install-timeout=0)。
//
// 早期这里硬写 180s,理由是"npm 自己的 fetch-timeout 是 5 分钟、还要重试 2 次,
// 网络卡住时单次 install 能吃掉十几分钟";但实测发现更常见的是反过来的坑 ——
// 首次装一个大包 + 冷缓存 + 国内直连 registry.npmjs.org,180s 根本不够,
// 于是每一轮都是"装到一半被杀 → 下一轮从零重来",27 轮全卡在同一处,
// 永远装不上(2026-09-24 v2.17.14)。**杀掉重来 ≠ 快速失败**,它只是把进度清零。
//
// 现在把上限交给调用方:INSTALL_TIMEOUT_MS > 0 时才给 execSync 传 timeout;
// 为 0 时不传该选项 —— 单次 install 跑到自然结束(npm 自身的 fetch-timeout 仍在,
// 所以不会真的无限挂住)。
const INSTALL_TIMEOUT_MS = readNumberArg('--install-timeout', 0) * 1000
function tryInstallGlobal(spec) {
  const limit = INSTALL_TIMEOUT_MS
  console.log(chalk.gray(`  → npm install -g ${spec}${limit > 0 ? `(上限 ${limit / 1000}s)` : '(不限时)'}`))
  try {
    const opts = {
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    }
    if (limit > 0) opts.timeout = limit
    execSync(
      `npm install -g ${spec} --registry=${NPM_REGISTRY} --prefer-online`
      + ' --fetch-retries=1 --fetch-retry-mintimeout=3000 --fetch-retry-maxtimeout=10000',
      opts
    )
    return { ok: true }
  } catch (err) {
    // 超时会被 execSync 杀掉(带 SIGTERM),stderr 可能是空的 —— 补一句可读的原因
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim()
    if (!out && (err.killed || err.signal)) {
      return {
        ok: false,
        output: limit > 0
          ? `安装超时(${limit / 1000}s 到点被终止,可用 --install-timeout=<秒> 放宽或 =0 不限时)`
          : '安装被中断(信号终止)',
      }
    }
    return { ok: false, output: out || String(err.message || err) }
  }
}

// ===========================================================================
// 安装前停止运行中的实例
// ===========================================================================
//
// 为什么必须做:全局包在 Windows 上"装不上/装不干净",根因通常不是权限,是**文件被占**。
// `g ui` 起的每个实例都是 `node <globalRoot>/zen-gitsync/src/gitCommit.js ui`,进程握着
// 全局包目录下的一堆模块句柄;npm 装新版前要先删掉旧的全局包目录 → rmdir EPERM →
// 一屏 `npm warn cleanup Failed to remove some directories: ... EPERM ...`,安装失败
// (2026-09-22 v2.17.12 实测:发布成功、全局停在 2.17.11)。
//
// 实例清单不靠猜:每个 UI 实例都把自己的 pid/port/projectPath 写进实例注册表
// (`~/.zen-gitsync/instances/<pid>.json`)—— 那份数据就是 UI 右上角"运行中的实例",
// 也是 `/api/instances` 的数据源。这里读同一份注册表,按 PID 发 SIGTERM 再摘条目,
// 与 UI 的"关闭全部"(routes/instances.js close-all)走同一条链路。
//
// 注:注册表的旧路径(~/.zen-gitsync-instances 目录、~/.zen-gitsync-instances.json 文件)
// 由 app 侧 dataDirMigration / instanceRegistry.migrateLegacy 在启动时收进当前目录,
// 这里不单独兼容。
const STOP_WAIT_MS = 8000        // 等实例退出的上限
const LOCK_SETTLE_MS = 1200      // 实例退出后留给 Windows 释放句柄 / 杀软松手的缓冲

// 本轮被停掉的实例数(结尾提示用户重新起)。--skip-self-update / --dry-run / --keep-instances 时为 0。
let stoppedInstanceCount = 0

// 存活性检查:信号 0 只做检查不发信号。EPERM = 进程存在但没权限,按存活处理
// (与 instanceRegistry.defaultIsProcessAlive 同一判定)。
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    if (err && (err.code === 'ESRCH' || err.code === 'ENOENT')) return false
    return true
  }
}

// 列出注册表里仍存活的实例(pruneStale 会顺手清掉 PID 已死 / 心跳超时的条目,不会误杀)。
// 注册表本身是 app 的模块,直接复用,避免在这里重写一遍 stale 判定 / 损坏文件自愈。
async function listRunningInstances() {
  try {
    const registry = createInstanceRegistry({
      fs: fsp,
      path,
      os,
      registryPath: getRegistryPath(),
    })
    const all = await registry.list({ pruneStale: true })
    // 别把自己写进 kill 名单:release 脚本不是 UI 实例,理论上不会出现在表里,
    // 但"自杀"这种事不该有理论上的可能。
    return { registry, instances: all.filter((i) => i.pid !== process.pid && i.pid !== process.ppid) }
  } catch (err) {
    console.log(chalk.yellow(`  读实例注册表失败(${err?.message || err}),按"没有运行实例"继续`))
    return { registry: null, instances: [] }
  }
}

// 停掉所有已注册实例,返回真正停掉的条目(供结尾提示用户重新起)。
async function stopRunningInstances({ quiet = false } = {}) {
  if (!quiet) {
    console.log(chalk.blue('\n=== 安装前停止运行中的实例 ==='))
    console.log(chalk.gray('数据来源:实例注册表(与 UI 右上角"运行中的实例"同一份)'))
  }

  const { registry, instances } = await listRunningInstances()
  if (instances.length === 0) {
    if (!quiet) console.log(chalk.gray('没有运行中的实例,跳过'))
    return []
  }

  for (const ins of instances) {
    const label = `${ins.projectName || '(未命名)'} pid=${ins.pid} port=${ins.port}`
    try {
      process.kill(ins.pid, 'SIGTERM')
      console.log(chalk.gray(`  → SIGTERM ${label}`))
    } catch (err) {
      if (err?.code === 'ESRCH' || err?.code === 'ENOENT') {
        console.log(chalk.gray(`  · 已自行退出 ${label}`))
      } else {
        console.log(chalk.yellow(`  ✗ 停止失败 ${label}: ${err?.message || err}`))
      }
    }
    // Windows 的 process.kill 直接终止目标,目标来不及执行自己的 unregister,
    // 由发起侧立即摘条目(与 routes/instances.js 的 close 同一策略);
    // 目标自己也会 unregister 的情况重复删同一个文件,幂等(deleteEntry 容忍 ENOENT)。
    try {
      await registry?.unregister(ins.pid)
    } catch (err) {
      console.log(chalk.yellow(`  · 摘除注册条目失败 pid=${ins.pid}: ${err?.message || err}`))
    }
  }

  // 必须确认真的退出了再往下走 —— 没退出就等于没停,文件照样被占
  const alivePids = new Set(instances.map((i) => i.pid).filter(isPidAlive))
  const deadline = Date.now() + STOP_WAIT_MS
  while (alivePids.size > 0 && Date.now() < deadline) {
    await sleep(200)
    for (const pid of [...alivePids]) {
      if (!isPidAlive(pid)) alivePids.delete(pid)
    }
  }

  const stopped = instances.filter((i) => !alivePids.has(i.pid))
  if (alivePids.size > 0) {
    console.log(chalk.yellow(
      `  ⚠ ${alivePids.size} 个实例 ${STOP_WAIT_MS / 1000}s 内没退出`
      + `(pid: ${[...alivePids].join(', ')}),安装仍可能因文件占用失败`
    ))
  }
  if (stopped.length > 0) {
    console.log(chalk.green(`已停止 ${stopped.length} 个实例`))
    // 进程没了 ≠ 目录马上能删:Windows 上杀软 / 索引器可能还捏着句柄一小会儿
    await sleep(LOCK_SETTLE_MS)
    stoppedInstanceCount += stopped.length
  }
  return stopped
}

// npm 的失败输出里出现这些字样 = Windows 文件占用,不是"registry 还没同步"。
// 这两类失败的处理方式相反:文件占用要"再杀一轮 + 强删旧目录",registry 滞后只能等。
const LOCKED_FILE_PATTERN = /EPERM|EBUSY|ENOTEMPTY|operation not permitted|Failed to remove/i

function looksLikeFileLock(output) {
  return LOCKED_FILE_PATTERN.test(String(output || ''))
}

// 手动强删旧的全局包目录。fs.rm 自带 Windows 重试(EBUSY/EPERM/ENOTEMPTY 退避重试),
// 比 npm 自己那层浅清理更能啃下被占的目录。
//
// 只在真撞上文件占用时才调:提前删掉会让"还得等 tarball 就绪"的那几分钟里
// 用户的全局命令彻底不可用 —— 宁可先让 npm 自己去删,失败了再补刀。
async function forceRemoveGlobalPackage() {
  const target = path.join(readGlobalRoot(), PKG_NAME)
  try {
    await fsp.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 400 })
    console.log(chalk.gray(`  已清掉被占用的旧全局目录: ${target}`))
  } catch (err) {
    console.log(chalk.yellow(`  ✗ 清旧全局目录失败: ${err?.message || err}`))
  }
}

// 自更新全局版本:反复尝试安装,直到全局版本校验通过或超时。
//
// 为什么不是"先等 dist-tags 翻牌,再安装"(v2.17.4 之前的老写法):
// `npm view dist-tags.latest` 和 `npm install -g pkg@ver` 读的是同一份 packument。
// packument 被 CDN 缓存(max-age=300,实测还能更久)时两边一起滞后 ——
// 等待阶段白等 600s,超时后再装照样 ETARGET,等于什么都没解决。
//
// 所以顺序反过来:先"尝试装",装不上才等。每轮:
//   ① 先探 tarball 能不能取(isTarballFetchable)—— 取不到就别浪费一次 npm 调用,
//      并且把"还取不到 HTTP 404"如实打出来:这是"到底卡在哪"的唯一线索;
//   ② 取得到就按两条路试,任一条装上且校验通过即结束:
//      `pkg@<version>`(packument 已同步时的常规路径)/ tarball URL 直连;
//   ③ 失败原因压成一行打出来(summarizeInstallError)。**别再默默重试**——
//      v2.17.6 那次用户看到的就是"一直在执行安装命令"、25 轮里一句原因都没有,
//      而真实原因是那几分钟 tarball 还没对外可取(见 tarballUrl 注释)。
async function selfUpdateGlobal(version) {
  console.log(chalk.blue('\n=== 发布后自更新全局版本 ==='))
  console.log(chalk.gray('publish 成功 ≠ packument 立即可见、也 ≠ tarball 立即可取(两者先后顺序随机)。'))
  console.log(chalk.gray('不空等 dist-tags:每轮先探 tarball,能取到才调 npm,失败会打印原因。'))
  console.log(chalk.gray(
    `间隔 ${POLL_INTERVAL_MS / 1000}s,上限 ${POLL_TIMEOUT_MS / 1000}s`
    + '(可用 --poll-interval / --poll-timeout 调);'
    + `单次安装${INSTALL_TIMEOUT_MS > 0 ? `上限 ${INSTALL_TIMEOUT_MS / 1000}s` : '不限时'}`
    + '(可用 --install-timeout=<秒> 调,0 = 不限时)。'
  ))

  const startedAt = Date.now()
  const deadline = startedAt + POLL_TIMEOUT_MS
  let attempt = 0
  let lastOutput = ''
  // 实例只在"第一次真要装"之前停一次,不在进循环时就停:前面的探测阶段可能还要等好几分钟
  // (tarball 还没对外可取),提前停等于白白占掉用户几分钟的 UI。
  let stopDone = false

  for (;;) {
    attempt += 1
    const packumentSynced = readLatestDistTag() === version
    // 第 2 轮起给 tarball 地址加时间戳,绕开 CDN 可能挂着的"这条路径 404"负缓存
    const bust = attempt > 1
    const tarball = tarballUrl(version, bust)
    const probe = await isTarballFetchable(version, bust)

    console.log(chalk.gray(
      `第 ${attempt} 次尝试(dist-tags.latest${packumentSynced ? '已同步' : '仍是旧版本'},`
      + ` tarball ${probe.ok ? '已可取' : `还取不到${probe.status ? ` HTTP ${probe.status}` : ''}`})...`
    ))

    if (probe.ok) {
      // 真要装之前,先把运行中的实例停掉:tarball 已可取,接下来就是 npm 删旧目录 →
      // 目录被实例占着会 EPERM(见 stopRunningInstances 处注释)。只做一次。
      if (!stopDone) {
        stopDone = true
        if (KEEP_INSTANCES) {
          console.log(chalk.yellow('--keep-instances: 不停运行中的实例,若安装报 EPERM / 文件占用属预期'))
        } else {
          await stopRunningInstances()
        }
      }

      // packument 已同步 → 先走常规精确版本;还没同步 → tarball 优先,争取一轮命中
      const targets = packumentSynced
        ? [`${PKG_NAME}@${version}`, tarball]
        : [tarball, `${PKG_NAME}@${version}`]

      for (const spec of targets) {
        const res = tryInstallGlobal(spec)
        if (!res.ok) {
          lastOutput = res.output
          console.log(chalk.yellow(`  ✗ ${summarizeInstallError(res.output)}`))
          // 文件占用和"registry 还没同步"是两类失败:前者要再杀一轮 + 强删旧目录,
          // 后者只能等。混在一起会让前者白等满 600s。
          if (looksLikeFileLock(res.output)) {
            console.log(chalk.yellow('  检测到文件占用(Windows 常见):再停一轮实例 + 强制清旧全局目录'))
            if (!KEEP_INSTANCES) await stopRunningInstances({ quiet: true })
            await forceRemoveGlobalPackage()
          }
          continue
        }
        const installed = readGlobalInstalledVersion()
        if (installed === version) {
          const cost = ((Date.now() - startedAt) / 1000).toFixed(1)
          console.log(chalk.green(
            `全局已更新到 ${PKG_NAME}@${version}(第 ${attempt} 次尝试,耗时 ${cost}s)`
          ))
          return
        }
        // 退出码 0 但版本不对(极少见):按失败处理,继续下一轮
        lastOutput = `安装命令退出码 0,但全局版本读到 ${installed ?? '未知'}`
        console.log(chalk.yellow(`  安装命令成功,但全局版本是 ${installed ?? '未知'},继续重试`))
      }
    }

    const remain = deadline - Date.now()
    if (remain <= 0) {
      console.error(chalk.red(`已尝试 ${attempt} 次,仍未装上 ${PKG_NAME}@${version}`))
      if (lastOutput) console.error(chalk.gray(lastOutput))
      if (looksLikeFileLock(lastOutput)) {
        console.error(chalk.yellow(
          '看起来是文件被占(不是 registry 滞后):关掉所有 UI 实例 / 编辑器后重试,\n'
          + '必要时手动删掉全局包目录再装(注意会短暂失去全局命令)。'
        ))
      }
      console.error(chalk.gray(
        '可稍后手动重试:\n'
        + `  npm install -g ${PKG_NAME}@${version}\n`
        + '若报 ETARGET / E404(registry 元数据与 tarball 还没对齐),直连 tarball:\n'
        + `  npm install -g ${tarballUrl(version)}`
      ))
      return
    }
    console.log(chalk.gray(`  ${Math.ceil(remain / 1000)}s 后重试`))
    await sleep(Math.min(POLL_INTERVAL_MS, remain))
  }
}

// 发布到 NPM
async function publishToNpm(version) {
  console.log(chalk.blue('\n=== 发布到 NPM ==='))

  try {
    if (DRY_RUN) {
      console.log(chalk.yellow(`[dry-run] npm publish --registry=${NPM_REGISTRY}`))
      console.log(chalk.yellow(
        `[dry-run] 反复探测并安装,直到全局 ${PKG_NAME}@${version} 校验通过(见 selfUpdateGlobal)`
      ))
      console.log(chalk.yellow(
        '[dry-run] 安装前先停掉实例注册表里的所有运行实例(见 stopRunningInstances)'
      ))
      return
    }
    execSync(`npm publish --registry=${NPM_REGISTRY}`, { stdio: 'inherit' })
    console.log(chalk.green('已成功发布到 NPM'))

    if (SKIP_SELF_UPDATE) {
      console.log(chalk.yellow('--skip-self-update: 不自动 `npm install -g zen-gitsync`'))
      return
    }

    // 发版后可选:把刚发布的版本装到全局(默认开启,可用 --skip-self-update 关掉)
    await selfUpdateGlobal(version)
  } catch (err) {
    console.error(chalk.red('发布到 NPM 失败:'), err.message || err)
    process.exit(1)
  }
}

// 主流程
async function main() {
  console.log(chalk.cyan(`\n🚀 开始发布流程${DRY_RUN ? '(DRY RUN)' : ''}...\n`))

  if (DRY_RUN) {
    console.log(chalk.yellow('--dry-run: 所有写操作会跳过,只打印计划'))
    console.log(chalk.yellow('--dry-run: type-check / vue-tsc / npm run build 仍会真跑(可在失败前中止)'))
  }
  if (SKIP_SELF_UPDATE) console.log(chalk.yellow('--skip-self-update: 发版后不自动 npm install -g'))
  if (KEEP_INSTANCES) console.log(chalk.yellow('--keep-instances: 装全局前不停运行中的实例'))
  if (SKIP_PUSH) console.log(chalk.yellow('--skip-push: 不 push git'))

  try {
    await checkEnvironment()
    await runTypeCheck()
    const newVersion = updateVersion()
    await buildFrontend()
    await verifyPackageContents()
    await commitChanges(newVersion)
    await publishToNpm(newVersion)

    if (stoppedInstanceCount > 0) {
      console.log(chalk.yellow(
        `提示:刚才停掉的 ${stoppedInstanceCount} 个实例不会自动恢复,`
        + '需要时到对应目录重新执行 `g ui`。'
      ))
    }

    console.log(chalk.green('\n🎉 发布完成!'))
  } catch (err) {
    console.error(chalk.red('\n❌ 发布失败:'), err.message || err)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(chalk.red('\n❌ 未捕获的错误:'), err)
  process.exit(1)
})
