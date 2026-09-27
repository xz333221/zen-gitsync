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
 * 智能体对话的**非图片附件**落盘。
 *
 * 设计口径(2026-09-27 与用户确认的方案"附件当路径提示"):
 *   - 图片继续走多模态:前端转 dataURL → 请求体的 images[] → image_url part,模型直接"看"。
 *   - 非图片不进消息体,只落盘 + 把**绝对路径**写进 system 提示,模型需要时用 read / grep
 *     工具自己去读。理由:
 *       a) .log / .csv / 代码文件动辄几百 KB,内联进消息既费 token 又容易把上下文撑爆;
 *       b) 模型本来就有文件工具,给路径让它按需取,比一次全塞进去划算得多;
 *       c) 这也是唯一可行路径 —— 浏览器 <input type=file> 出于安全**不提供磁盘路径**,
 *          只有 File 对象,所以想"只给路径"就必须由服务端落盘一次。
 *
 * 落盘位置:~/.zen-gitsync/agent-attachments/<轮次目录>/<文件名>(见 src/paths.js)。
 * 按轮次分子目录,是为了同名文件在第二轮不被覆盖、第一次给过的路径一直有效。
 *
 * 安全口径:客户端传来的 name 一律当作**不可信输入** —— 只取 basename、剥掉控制字符与
 * 路径分隔符、限长;大小与数量在服务端再卡一遍(不能只信前端)。
 */
import fs from 'fs/promises'
import path from 'path'
import { AGENT_ATTACHMENTS_DIR } from '../../../paths.js'

/** 单轮最多几个附件 */
export const MAX_ATTACHMENTS = 10
/** 单个附件解密后最大字节数 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
/** 单轮附件合计最大字节数(前端 base64 后约 ×1.37,须留在 /api/agent/chat 的 50mb 之内) */
export const MAX_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024
/** 保留最近多少轮的上传目录,多余的顺手清掉 */
export const KEEP_UPLOAD_TURNS = 30
/** 文件名最长字符数(保留扩展名) */
const MAX_NAME_LEN = 80

/**
 * 把客户端给的文件名洗成安全的单段文件名。
 * 只做"文件名"该做的事:app 后面所有路径都是自己拼的,这里防的是 `../../x` 这类穿越与
 * Windows 保留字符。
 */
export function sanitizeFileName(raw, fallback = 'file') {
  let name = String(raw || '')
  // 归一化分隔符后只取最后一段 —— Windows 的 \\ 与 POSIX 的 / 都要挡
  name = name.split(/[\\/]/).pop() || ''
  // 控制字符(含 \0)与 Windows 非法字符
  name = name.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_')
  // 纯点名".."/"." 不算文件名
  name = name.replace(/^\.+$/, '')
  name = name.trim()
  if (!name) return fallback
  if (name.length <= MAX_NAME_LEN) return name
  // 超长时保留扩展名,截前半段
  const ext = path.extname(name).slice(0, 16)
  const base = name.slice(0, MAX_NAME_LEN - ext.length)
  return base + ext
}

/** `data:<mime>;base64,<payload>` → Buffer;不是 base64 dataURL 就返回 null */
export function decodeDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null
  const m = /^data:[^,]*;base64,(.+)$/s.exec(dataUrl)
  if (!m) return null
  try {
    return Buffer.from(m[1], 'base64')
  } catch {
    return null
  }
}

/** 一轮一个子目录名:时间戳 + 随机尾巴(同一毫秒内两次调用也不会撞) */
function turnDirName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  const rand = Math.random().toString(36).slice(2, 6)
  return `${stamp}-${rand}`
}

/**
 * 落盘一批附件。
 *
 * @param {Array<{name?: string, dataUrl?: string}>} list 客户端传来的原始数组(不可信)
 * @param {{ dir?: string, now?: Date, onSkip?: (info: {name: string, reason: string}) => void }} [opts]
 * @returns {Promise<Array<{ name: string, path: string, bytes: number }>>} 落盘成功的附件(路径为绝对路径)
 */
export async function saveAgentAttachments(list, opts = {}) {
  const dir = opts.dir || AGENT_ATTACHMENTS_DIR
  const onSkip = typeof opts.onSkip === 'function' ? opts.onSkip : () => {}
  const items = (Array.isArray(list) ? list : []).slice(0, MAX_ATTACHMENTS)
  if (items.length === 0) return []

  const saved = []
  const used = new Set()
  let total = 0
  // 目录按需创建:一次都没上传过附件的用户不会平白多一个目录
  let ensured = false
  let turnDir = ''

  for (const raw of items) {
    const name = sanitizeFileName(raw?.name)
    if (total >= MAX_ATTACHMENT_TOTAL_BYTES) {
      onSkip({ name, reason: 'total-too-large' })
      continue
    }
    const buf = decodeDataUrl(raw?.dataUrl)
    if (!buf || buf.length === 0) {
      onSkip({ name, reason: 'bad-payload' })
      continue
    }
    if (buf.length > MAX_ATTACHMENT_BYTES) {
      onSkip({ name, reason: 'too-large' })
      continue
    }
    if (total + buf.length > MAX_ATTACHMENT_TOTAL_BYTES) {
      onSkip({ name, reason: 'total-too-large' })
      continue
    }
    if (!ensured) {
      await fs.mkdir(dir, { recursive: true })
      turnDir = path.join(dir, turnDirName(opts.now))
      await fs.mkdir(turnDir, { recursive: true })
      ensured = true
    }
    // 同一轮里两个文件同名:加 -1 / -2 后缀,不要互相覆盖
    let finalName = name
    let n = 1
    while (used.has(finalName.toLowerCase())) {
      const ext = path.extname(name)
      finalName = `${name.slice(0, name.length - ext.length)}-${n++}${ext}`
    }
    used.add(finalName.toLowerCase())
    const target = path.join(turnDir, finalName)
    try {
      await fs.writeFile(target, buf)
    } catch (err) {
      onSkip({ name, reason: `write-failed:${err?.code || err?.message || 'unknown'}` })
      continue
    }
    total += buf.length
    saved.push({ name: finalName, path: target, bytes: buf.length })
  }

  if (saved.length > 0) {
    await pruneUploadDirs(dir, opts.now).catch(() => {})
  }
  return saved
}

/** 只保留最近 keep 轮目录(尽力而为:失败不抛,不影响本轮对话) */
export async function pruneUploadDirs(dir = AGENT_ATTACHMENTS_DIR, now = new Date(), keep = KEEP_UPLOAD_TURNS) {
  const dirs = (await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter(e => e.isDirectory()).map(e => e.name).sort()
  const extra = dirs.slice(0, Math.max(0, dirs.length - keep))
  for (const name of extra) {
    await fs.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {})
  }
  return extra.length
}
