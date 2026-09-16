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
// 远程仓库管理:列表 / 重命名 / 删除 / 改地址 / 多 push URL / 一键推送全部。
//
// 背景:GUI 历史上只认单个 origin(底部状态栏只读 remote.origin.url,
// push/pull 全部隐式走上游)。多远程场景(GitHub + Gitee 双备份、
// fork 后的 upstream)需要完整的管理入口。

import logger from '../../utils/logger.js'
import { asyncRoute, HttpError } from '../../utils/asyncRoute.js';
import { assertGitRef, assertGitRemoteUrl } from '../../utils/gitArgs.js';

// push URL 数量上限,防止客户端传一个超大数组让后端逐条执行 git 写命令
const MAX_PUSH_URLS = 10

/**
 * 解析 `git remote -v` 输出。
 * 行格式: <name>\t<url> (fetch|push)
 * 注意点:
 *  - 分隔符是制表符(已实测),按 \t 切第一刀,URL 本身允许含空格(本地路径 remote)
 *  - 同一 remote 的 push 行可有多条(配置了多个 pushurl),全部收集并去重
 */
function parseRemoteVerbose(stdout) {
  const remotes = new Map()
  for (const line of String(stdout || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const tabIdx = trimmed.indexOf('\t')
    if (tabIdx <= 0) continue
    const name = trimmed.slice(0, tabIdx)
    const rest = trimmed.slice(tabIdx + 1)
    let url
    let kind
    if (rest.endsWith(' (fetch)')) {
      url = rest.slice(0, -' (fetch)'.length)
      kind = 'fetch'
    } else if (rest.endsWith(' (push)')) {
      url = rest.slice(0, -' (push)'.length)
      kind = 'push'
    } else {
      continue
    }
    if (!remotes.has(name)) {
      remotes.set(name, { name, fetchUrl: '', pushUrls: [] })
    }
    const entry = remotes.get(name)
    if (kind === 'fetch') {
      entry.fetchUrl = url
    } else if (!entry.pushUrls.includes(url)) {
      entry.pushUrls.push(url)
    }
  }
  return [...remotes.values()]
}

/**
 * 计算 push 的 refspec 参数(拼在 ['push'] 后面)。
 *  - 不传 remote:裸 `git push`,走当前分支上游(完全兼容历史行为)
 *  - 上游存在且上游 remote 就是目标:同样裸 push,让 git 按实际上游映射推
 *    (覆盖本地分支名 ≠ 上游分支名的场景)
 *  - 否则:`git push <remote> HEAD:<currentBranch>` 推到同名分支。
 *    不自动加 -u,避免静默改上游;要建上游走 /api/git/push-with-upstream
 */
function buildPushRefs({ remote, currentBranch, upstreamBranch }) {
  if (!remote) return []
  if (!currentBranch) {
    throw new HttpError(400, '当前处于 detached HEAD 状态，无法按分支推送，请先切换到一个本地分支')
  }
  const upstreamRemote = (upstreamBranch || '').split('/')[0] || ''
  if (upstreamRemote && upstreamRemote === remote) return []
  return [remote, `HEAD:${currentBranch}`]
}

/**
 * 汇总远程上下文:remote 列表 + 当前分支 + 上游 + pushDefault。
 * 列表/变更类路由共用。除 `git remote -v` 外所有命令都允许失败(未配置时退出码非零)。
 */
async function getRemoteContext(execGitCommand) {
  const [verbose, pushDefaultRes, upstreamRes, branchRes] = await Promise.all([
    execGitCommand(['remote', '-v'], { log: false }),
    execGitCommand(['config', '--get', 'remote.pushDefault'], { ignoreError: true, log: false }),
    execGitCommand(['rev-parse', '--abbrev-ref', '@{u}'], { ignoreError: true, log: false }),
    execGitCommand(['symbolic-ref', '--short', 'HEAD'], { ignoreError: true, log: false })
  ])

  const remotes = parseRemoteVerbose(verbose.stdout)
  const upstreamBranch = (upstreamRes.stdout || '').trim()
  const currentBranch = (branchRes.stdout || '').trim()
  const pushDefault = (pushDefaultRes.stdout || '').trim()

  // 逐 remote 查显式 pushurl:未配置时 `git remote -v` 会把 url 同时显示为 push 行,
  // 与"显式配了相同 pushurl"无法区分,必须直接读 config(未配置退出码 1,吞掉)
  await Promise.all(remotes.map(async (r) => {
    const { stdout } = await execGitCommand(
      ['config', '--get-all', `remote.${r.name}.pushurl`],
      { ignoreError: true, log: false }
    )
    const explicit = stdout.split('\n').map(s => s.trim()).filter(Boolean)
    r.hasExplicitPushUrls = explicit.length > 0
    if (explicit.length > 0) r.pushUrls = explicit
  }))

  // 上游首段必须出现在 remote 列表里才标记(上游也可能指向本地分支)
  const upstreamRemote = upstreamBranch.split('/')[0] || ''
  const names = new Set(remotes.map(r => r.name))
  for (const r of remotes) {
    r.isPushDefault = !!pushDefault && r.name === pushDefault
    r.isUpstream = !!upstreamRemote && names.has(upstreamRemote) && r.name === upstreamRemote
  }

  return { remotes, currentBranch, upstreamBranch, pushDefault }
}

export function registerGitRemoteRoutes({ app, execGitCommand, setRecentPushStatus }) {
  // 远程仓库列表(含 fetch/push URL、上游与默认推送标记)
  app.get('/api/remotes', asyncRoute(async (req, res) => {
    const ctx = await getRemoteContext(execGitCommand)
    res.json({ success: true, ...ctx })
  }));

  // 重命名远程仓库。git remote rename 会自动改写 branch.*.remote / branch.*.merge
  // 和 remote-tracking refs,上游跟踪不会丢。
  app.post('/api/remote/rename', asyncRoute(async (req, res) => {
    const { oldName, newName } = req.body || {};
    const safeOld = assertGitRef(oldName, '远程仓库名');
    const safeNew = assertGitRef(newName, '新远程仓库名');

    const ctx = await getRemoteContext(execGitCommand)
    const target = ctx.remotes.find(r => r.name === safeOld)
    if (!target) throw new HttpError(400, `远程仓库 "${safeOld}" 不存在`)
    if (ctx.remotes.some(r => r.name === safeNew)) {
      throw new HttpError(400, `远程仓库名 "${safeNew}" 已存在`)
    }

    await execGitCommand(['remote', 'rename', safeOld, safeNew])
    logger.info(`远程仓库已重命名: ${safeOld} → ${safeNew}`)
    res.json({
      success: true,
      wasUpstream: !!target.isUpstream,
      wasPushDefault: !!target.isPushDefault
    });
  }));

  // 删除远程仓库。若删的是当前分支上游指向的 remote,顺手 unset-upstream,
  // 避免 dangling 的 branch.<name>.merge 配置让后续 git pull 报怪错。
  app.post('/api/remote/remove', asyncRoute(async (req, res) => {
    const { name } = req.body || {};
    const safeName = assertGitRef(name, '远程仓库名');

    const ctx = await getRemoteContext(execGitCommand)
    const target = ctx.remotes.find(r => r.name === safeName)
    if (!target) throw new HttpError(400, `远程仓库 "${safeName}" 不存在`)

    await execGitCommand(['remote', 'remove', safeName])
    if (target.isUpstream && ctx.currentBranch) {
      await execGitCommand(['branch', '--unset-upstream', ctx.currentBranch], { ignoreError: true, log: false })
    }
    logger.info(`远程仓库已删除: ${safeName}`)
    res.json({
      success: true,
      wasUpstream: !!target.isUpstream,
      wasPushDefault: !!target.isPushDefault
    });
  }));

  // 修改远程地址(git remote set-url,同时改 fetch 与默认 push)。
  // 显式配置的 pushurl 不受影响,响应里带 hasExplicitPushUrls 供前端提示。
  app.post('/api/remote/set-url', asyncRoute(async (req, res) => {
    const { name, url } = req.body || {};
    const safeName = assertGitRef(name, '远程仓库名');
    const safeUrl = assertGitRemoteUrl(url);

    const ctx = await getRemoteContext(execGitCommand)
    const target = ctx.remotes.find(r => r.name === safeName)
    if (!target) throw new HttpError(400, `远程仓库 "${safeName}" 不存在`)

    await execGitCommand(['remote', 'set-url', safeName, safeUrl])
    logger.info(`远程仓库地址已更新: ${safeName} → ${safeUrl}`)
    res.json({ success: true, hasExplicitPushUrls: !!target.hasExplicitPushUrls });
  }));

  // 幂等设置某个 remote 的 push URL 列表(多 push URL 管理)。
  // git 没有"清空 pushurl"的直接命令,采用 unset-all + 逐条 --add:
  //   git config --unset-all remote.<name>.pushurl   (无 pushurl 时退出码 5,预期失败)
  //   git remote set-url --push --add <name> <url_i>
  // 传空数组 = 清空显式 pushurl,push 回落到 fetch URL。
  app.post('/api/remote/push-urls', asyncRoute(async (req, res) => {
    const { name, pushUrls } = req.body || {};
    const safeName = assertGitRef(name, '远程仓库名');
    if (!Array.isArray(pushUrls) || pushUrls.length > MAX_PUSH_URLS) {
      throw new HttpError(400, `推送地址必须是 0-${MAX_PUSH_URLS} 个的数组`)
    }
    // 先校验全部 URL 再动手,避免改到一半才 400 留下半截配置
    const safeUrls = pushUrls.map(u => assertGitRemoteUrl(u, '推送地址'));

    const ctx = await getRemoteContext(execGitCommand)
    if (!ctx.remotes.some(r => r.name === safeName)) {
      throw new HttpError(400, `远程仓库 "${safeName}" 不存在`)
    }

    await execGitCommand(['config', '--unset-all', `remote.${safeName}.pushurl`], { ignoreError: true, log: false })
    for (const u of safeUrls) {
      await execGitCommand(['remote', 'set-url', '--push', '--add', safeName, u])
    }

    // 回读确认实际生效值
    const { stdout } = await execGitCommand(
      ['config', '--get-all', `remote.${safeName}.pushurl`],
      { ignoreError: true, log: false }
    )
    const actual = stdout.split('\n').map(s => s.trim()).filter(Boolean)
    logger.info(`远程仓库 push URL 已更新: ${safeName} → [${actual.join(', ')}]`)
    res.json({ success: true, pushUrls: actual });
  }));

  // 一键推送全部远程:逐个 push,单个失败不中断,结果逐条聚合。
  // 全部成功才设置推送状态标记(部分失败前端应提示重试,不能标"已同步")。
  app.post('/api/push-all-remotes', asyncRoute(async (req, res) => {
    const ctx = await getRemoteContext(execGitCommand)
    if (ctx.remotes.length === 0) {
      return res.status(400).json({
        success: false,
        error: '当前仓库没有配置任何远程仓库',
        errorCode: 'NO_REMOTES'
      })
    }
    // 空仓库防御(与 /api/push 同一模式):没有任何提交时 git push 会报
    // "src refspec master does not match any",直接返回明确错误
    const headCheck = await execGitCommand(
      ['rev-parse', '--verify', 'HEAD'],
      { ignoreError: true, log: false }
    )
    if (!headCheck.stdout || !headCheck.stdout.trim()) {
      return res.status(400).json({
        success: false,
        error: '当前仓库没有任何提交，请先在左侧暂存并提交至少一个文件后再推送。',
        errorCode: 'EMPTY_REPO'
      })
    }

    const results = []
    for (const r of ctx.remotes) {
      try {
        const refs = buildPushRefs({
          remote: r.name,
          currentBranch: ctx.currentBranch,
          upstreamBranch: ctx.upstreamBranch
        })
        await execGitCommand(['push', ...refs])
        results.push({ name: r.name, ok: true })
      } catch (e) {
        results.push({ name: r.name, ok: false, error: e?.message || String(e) })
      }
    }

    const allOk = results.every(r => r.ok)
    if (allOk) {
      setRecentPushStatus?.({
        justPushed: true,
        pushTime: Date.now(),
        validDuration: 10000
      })
    }
    logger.info(`一键推送全部远程完成: ${results.filter(r => r.ok).length}/${results.length} 成功`)
    res.json({ success: allOk, results })
  }));
}

export const __testables = {
  parseRemoteVerbose,
  buildPushRefs
}
