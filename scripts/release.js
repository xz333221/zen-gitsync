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
 *   npm run release -- --skip-push        # 只发布到 npm,不 push git
 *   npm run release -- --dry-run          # 只打印计划,不真正改 package.json / commit / publish
 *   npm run release -- --poll-interval=20 --poll-timeout=600  # 调自更新重试节奏(秒)
 *
 * 发布后自更新:反复尝试 `npm install -g zen-gitsync@<版本>` 并校验全局版本;
 * 精确版本号解析不到(ETARGET)时改用 tarball URL 直连兜底。
 * 原因见 tarballUrl() / selfUpdateGlobal() 处注释 —— publish 成功不等于 packument 立即可见。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync, spawn } from 'node:child_process'
import chalk from 'chalk'
import readline from 'node:readline/promises'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

const argv = process.argv.slice(2)
const DRY_RUN = argv.includes('--dry-run')
const SKIP_SELF_UPDATE = argv.includes('--skip-self-update')
const SKIP_PUSH = argv.includes('--skip-push')

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
// 兜底:tarball URL 是不可变资源,发布完成即可取,且不经过 packument 的那层缓存
// (见 tarballUrl 注释)。所以自更新不再把安装卡在 dist-tags 后面,而是
// "反复尝试安装 + 校验全局版本",精确版本号解析不到时自动改用 tarball 直连。
// 默认 15s 一轮、上限 600s;可用 `--poll-interval=<秒>` / `--poll-timeout=<秒>` 调。
const POLL_INTERVAL_MS = readNumberArg('--poll-interval', 15) * 1000
const POLL_TIMEOUT_MS = readNumberArg('--poll-timeout', 600) * 1000

// 发布物 tarball 的地址。npm publish 是先把 tarball 推进 registry、再更新 packument;
// tarball 按 URL 寻址、内容不可变,所以它比 packument 更早对外可用,也不会被
// max-age 那层缓存挂在旧内容上 —— "新版本已发布、但 packument 还是旧的"时,
// 这是唯一能立刻装上的路径。
function tarballUrl(version) {
  return `${NPM_REGISTRY.replace(/\/$/, '')}/${PKG_NAME}/-/${PKG_NAME}-${version}.tgz`
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

// 读本地全局已安装的版本,读不到返回 null。
// 不走 `npm ls -g <pkg> --json`:该包不存在时它退出码为 1 且输出里没有 dependencies
// 字段(实测只返回 {"name":"<node 版本目录名>"}),字段结构还随 npm 版本变;
// 直接读"当前 npm 的全局根"下该包的 package.json 更确定,也和 `npm install -g` 落点一致。
function readGlobalInstalledVersion() {
  let globalRoot
  try {
    globalRoot = execSync('npm root -g', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    }).trim()
  } catch {
    // npm 不可用 / 超时:按 Node 安装目录兜底(Windows 下 npm 默认全局根就在这里)
    globalRoot = path.join(path.dirname(process.execPath), 'node_modules')
  }
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
// 只有整轮尝试全部失败时,调用方才回放最后一份输出。
function tryInstallGlobal(spec) {
  console.log(chalk.gray(`  → npm install -g ${spec}`))
  try {
    execSync(`npm install -g ${spec} --registry=${NPM_REGISTRY} --prefer-online`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
      timeout: 300000,
    })
    return { ok: true }
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim()
    return { ok: false, output: out || String(err.message || err) }
  }
}

// 自更新全局版本:反复尝试安装,直到全局版本校验通过或超时。
//
// 为什么不是"先等 dist-tags 翻牌,再安装"(v2.17.4 之前的老写法):
// `npm view dist-tags.latest` 和 `npm install -g pkg@ver` 读的是同一份 packument。
// packument 被 CDN 缓存(max-age=300,实测还能更久)时两边一起滞后 ——
// 等待阶段白等 600s,超时后再装照样 ETARGET,等于什么都没解决。
//
// 所以顺序反过来:先"尝试装",装不上才等。每轮按两条路试,任一条装上且校验通过就结束:
//   ① `pkg@<version>`  —— 常规路径,packument 已同步时一次命中;
//   ② tarball URL 直连 —— packument 还是旧的时候的唯一出路(见 tarballUrl 注释)。
async function selfUpdateGlobal(version) {
  console.log(chalk.blue('\n=== 发布后自更新全局版本 ==='))
  console.log(chalk.gray('publish 成功 ≠ packument 立即可见(registry 处理 + CDN 缓存)。'))
  console.log(chalk.gray('不空等 dist-tags,直接反复尝试安装;精确版本解析不到就 tarball 直连兜底。'))
  console.log(chalk.gray(
    `间隔 ${POLL_INTERVAL_MS / 1000}s,上限 ${POLL_TIMEOUT_MS / 1000}s`
    + '(可用 --poll-interval / --poll-timeout 调)。'
  ))

  const startedAt = Date.now()
  const deadline = startedAt + POLL_TIMEOUT_MS
  const tarball = tarballUrl(version)
  let attempt = 0
  let lastOutput = ''

  for (;;) {
    attempt += 1
    const packumentSynced = readLatestDistTag() === version
    // packument 已同步 → 先走常规精确版本;还没同步 → tarball 优先,争取一轮命中
    const targets = packumentSynced
      ? [`${PKG_NAME}@${version}`, tarball]
      : [tarball, `${PKG_NAME}@${version}`]

    console.log(chalk.gray(
      `第 ${attempt} 次尝试(dist-tags.latest${packumentSynced ? '已同步' : '仍是旧版本'})...`
    ))

    for (const spec of targets) {
      const res = tryInstallGlobal(spec)
      if (!res.ok) {
        lastOutput = res.output
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

    const remain = deadline - Date.now()
    if (remain <= 0) {
      console.error(chalk.red(`已尝试 ${attempt} 次,仍未装上 ${PKG_NAME}@${version}`))
      if (lastOutput) console.error(chalk.gray(lastOutput))
      console.error(chalk.gray(
        '可稍后手动重试:\n'
        + `  npm install -g ${PKG_NAME}@${version}\n`
        + '若仍报 ETARGET(packument 缓存滞后),直连 tarball:\n'
        + `  npm install -g ${tarball}`
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
        `[dry-run] 轮询 registry 直到 ${version} 可见,再 npm install -g ${PKG_NAME}@${version}`
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
  if (SKIP_PUSH) console.log(chalk.yellow('--skip-push: 不 push git'))

  try {
    await checkEnvironment()
    await runTypeCheck()
    const newVersion = updateVersion()
    await buildFrontend()
    await verifyPackageContents()
    await commitChanges(newVersion)
    await publishToNpm(newVersion)

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
