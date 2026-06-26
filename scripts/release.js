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

// 跨平台 sleep:Node 原生,避免 `sleep N || ping` 的 Windows 兜底 hack
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 显式白名单:只有这些文件路径会被 git add。
// 禁止 `git add .` 防止把工作区脏文件 / 临时调试文件一起带上 release commit。
const RELEASE_FILES = ['package.json', 'CHANGELOG.md', 'package-lock.json', 'pnpm-lock.yaml']

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

// 发布到 NPM
async function publishToNpm() {
  console.log(chalk.blue('\n=== 发布到 NPM ==='))

  try {
    if (DRY_RUN) {
      console.log(chalk.yellow('[dry-run] npm publish --registry=https://registry.npmjs.org/'))
      return
    }
    execSync('npm publish --registry=https://registry.npmjs.org/', { stdio: 'inherit' })
    console.log(chalk.green('已成功发布到 NPM'))

    if (SKIP_SELF_UPDATE) {
      console.log(chalk.yellow('--skip-self-update: 不自动 `npm install -g zen-gitsync`'))
      return
    }

    // 发版后可选:把刚发布的版本装到全局(默认开启,可用 --skip-self-update 关掉)
    try {
      console.log(chalk.gray('执行 npm run update:g...'))
      execSync('npm run update:g', { stdio: 'inherit' })
      console.log(chalk.green('update:g 执行完成'))
    } catch (err) {
      console.error(chalk.red('update:g 执行失败:'), err.message)
    }
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
    await commitChanges(newVersion)
    await publishToNpm()

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
