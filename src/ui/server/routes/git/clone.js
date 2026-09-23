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
// 把远程仓库克隆到用户指定的文件夹(远程仓库列表卡片上的「克隆到文件夹」)。
//
// 与同目录其它 git 路由的关键差别:clone 的 cwd **不是当前工作目录**,而是用户
// 刚在文件选择器里选的那个父目录。所以这里不能复用 execGitCommand —— 它固定用
// getCwd(),而且会把命令塞进"当前项目"的命令历史里,那条记录里的 cwd 是错的,
// 事后回看会误导。这里自己 spawn,也不碰命令历史。
//
// 用哪个协议(SSH / HTTPS)由调用方决定:前端传什么就 clone 什么,服务端只做
// 地址合法性校验。推导逻辑只留一份在前端(utils/remoteUrl.ts),免得两边各写
// 一套规则、哪天规则变了只改了一边。

import path from 'path'
import fs from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'

import logger from '../../utils/logger.js'
import { HttpError } from '../../utils/asyncRoute.js'
import { assertGitRemoteUrl } from '../../utils/gitArgs.js'
import { rememberRepo } from '../../utils/localRepoScan.js'
import { augmentEnvPath } from '../../../../utils/shellPath.js'

const execFileAsync = promisify(execFile)

/** 大仓库 clone 可能好几分钟;与 agentMarketplace 的 CLONE_TIMEOUT_MS 取齐 */
const CLONE_TIMEOUT_MS = 180_000
const MAX_BUFFER = 10 * 1024 * 1024

/**
 * 从远程地址里取出仓库目录名(clone 出来的子目录就用它)。
 *   git@github.com:owner/repo.git     → repo
 *   https://gitee.com/owner/repo.git  → repo
 *   https://github.com/owner/repo/    → repo
 * 取不出来返回空串,调用方兜底成 repository。
 */
export function repoNameFromUrl(url) {
  const s = String(url || '').trim().replace(/\/+$/, '')
  if (!s) return ''
  const tail = s.split(/[/:]/).filter(Boolean).pop() || ''
  return tail.replace(/\.git$/i, '')
}

/**
 * 校验父目录:必须是**已存在的目录**的绝对路径。
 *
 * 这里刻意不用 assertGitPath —— 那个函数要求"仓库内的相对路径",而用户在文件
 * 选择器里选出来的必然是绝对路径。反过来也不能拿它当安全边界:clone 的落点
 * 本来就允许在工作区之外(用户装项目的盘符通常不是当前项目所在盘)。
 */
async function assertCloneParentDir(value) {
  const s = String(value ?? '').trim()
  if (!s) throw new HttpError(400, '缺少目标文件夹')
  if (/[\x00-\x1f\x7f]/.test(s)) throw new HttpError(400, '目标文件夹含有非法字符')
  if (!path.isAbsolute(s)) throw new HttpError(400, '目标文件夹必须是绝对路径')

  let stat
  try {
    stat = await fs.stat(s)
  } catch {
    throw new HttpError(400, `目标文件夹不存在：${s}`)
  }
  if (!stat.isDirectory()) throw new HttpError(400, `目标不是文件夹：${s}`)
  return path.resolve(s)
}

async function pathExists(target) {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

/** 取 stderr / message 里最后一行非空文本 —— git 把结论放在最后一行(fatal: ...) */
function lastErrorLine(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return lines[lines.length - 1] || ''
}

/** 把子进程错误压成一句能直接给用户看的话 */
export function describeCloneError(error, timeoutMs = CLONE_TIMEOUT_MS) {
  if (error?.killed || error?.signal) {
    return `克隆超时（超过 ${Math.round(timeoutMs / 1000)} 秒），仓库可能过大或网络不通`
  }
  return lastErrorLine(error?.stderr) || lastErrorLine(error?.message) || '克隆失败'
}

/** 真正跑一次 git clone。抽出来是为了让路由能被单测注入替身(不联网)。 */
async function runClone({ url, parentDir, target }) {
  const env = await augmentEnvPath({
    ...process.env,
    GIT_CONFIG_PARAMETERS: "'core.quotepath=false'",
    // 子进程没有 TTY,交互式提示只会把 clone 挂到超时。让它在需要凭据时
    // 立刻失败并把原因写在 stderr 里(与 directoryFetch.js 同一取舍)。
    GIT_TERMINAL_PROMPT: '0'
  })
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) env.GIT_SSH_COMMAND = 'ssh -oBatchMode=yes'

  try {
    await execFileAsync('git', ['clone', url, target], {
      cwd: parentDir,
      timeout: CLONE_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      env
    })
  } catch (error) {
    logger.error('克隆仓库失败:', error?.stderr || error?.message || error)
    throw new HttpError(500, describeCloneError(error))
  }
}

/**
 * 注册克隆路由。
 *
 * @param {object} deps
 * @param {import('express').Express} deps.app
 * @param {typeof runClone} [deps.runCloneImpl] 单测注入点:默认实现会真跑 git clone
 */
export function registerGitCloneRoutes({ app, runCloneImpl = runClone }) {
  app.post('/api/clone', async (req, res) => {
    try {
      const url = assertGitRemoteUrl(req.body?.url)
      const parentDir = await assertCloneParentDir(req.body?.parentDir)
      const target = path.join(parentDir, repoNameFromUrl(url) || 'repository')

      // 目标已存在就先拦下:git 自己也会拒绝,但它那句
      // "destination path already exists and is not an empty directory"
      // 既没说是哪个目录,也没给下一步怎么办
      if (await pathExists(target)) {
        return res.json({ success: false, error: `目标文件夹已存在：${target}` })
      }

      await runCloneImpl({ url, parentDir, target })
      // 就地登记到本机仓库清单：远程仓库列表的「已克隆」徽标要立刻亮起来，
      // 不能等下一次全盘重扫（十几秒）。登记用的是服务端刚算出的**真实落点**，
      // 不依赖前端回传 —— 前端只知道"选了哪个父目录"，仓库名是服务端推的。
      await rememberRepo(target, url)
      res.json({ success: true, path: target })
    } catch (error) {
      logger.error('克隆仓库失败:', error?.message || error)
      res.status(error?.statusCode || 200).json({
        success: false,
        error: error?.message || '克隆仓库失败'
      })
    }
  })
}
