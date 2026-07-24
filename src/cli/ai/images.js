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
// g ai 图片附件 — 剪贴板图片读取 + 本地图片转 data URL。
//
// 触发方式:REPL 里按 Alt+V(或 /image <路径> 附加本地文件)。
// 图片保存到 ~/.git-commit-tool/ai-images/,发送时编码为 base64 data URL,
// 以 OpenAI 多模态格式(image_url)拼进 user 消息。
//
// 平台实现:
//   - Windows: powershell.exe -STA 调 System.Windows.Forms.Clipboard.GetImage()
//     (Win10+ 自带 PowerShell 5.1,-STA 是剪贴板访问的必要条件)
//   - macOS:   osascript 读 «class PNGf» 剪贴板数据
//   - Linux:   Wayland 用 wl-paste,X11 用 xclip(都没有则报不支持)
//
// 注意:读的是**本机**剪贴板 — ssh/远程终端里剪贴板通常没有图片,
// 此时返回空,由调用方提示用户改用 /image <路径>。

import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const IMAGE_DIR = path.join(os.homedir(), '.git-commit-tool', 'ai-images')
const MAX_KEEP = 20          // 目录里最多保留的历史图片数(超出按时间最旧先删)
const CLIP_TIMEOUT_MS = 15000 // 剪贴板读取超时(PowerShell 冷启动可能要几秒)

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

// ──────────────────────────────────────────────
// 小工具
// ──────────────────────────────────────────────

/** execFile 的 Promise 包装;stdout/stderr 给 Buffer,调用方自行解码 */
function execFileP(cmd, args, options = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: CLIP_TIMEOUT_MS, windowsHide: true, ...options },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: typeof err?.code === 'number' ? err.code : (err ? -1 : 0),
          stdout: stdout ?? Buffer.alloc(0),
          stderr: stderr ?? Buffer.alloc(0),
          error: err ? String(err.message || err) : null,
        })
      })
  })
}

export function formatBytes(n) {
  n = Number(n) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 清理历史图片:按修改时间保留最新 MAX_KEEP 张(尽力而为,失败不阻塞) */
async function pruneOldImages() {
  try {
    const names = await fsp.readdir(IMAGE_DIR)
    const files = []
    for (const name of names) {
      if (!name.startsWith('clip-') || !name.endsWith('.png')) continue
      const full = path.join(IMAGE_DIR, name)
      try {
        const st = await fsp.stat(full)
        files.push({ full, mtime: st.mtimeMs })
      } catch { /* 单个文件失败忽略 */ }
    }
    files.sort((a, b) => b.mtime - a.mtime)
    for (const f of files.slice(MAX_KEEP)) {
      await fsp.unlink(f.full).catch(() => {})
    }
  } catch { /* 目录不存在等情况直接跳过 */ }
}

// ──────────────────────────────────────────────
// 各平台剪贴板读取:成功把图片写入 file,失败返回 false
// ──────────────────────────────────────────────

async function saveClipboardWindows(file) {
  // -STA:Clipboard 必须运行在单线程单元
  // 输出路径走环境变量传递 — 实测 -Command 后的位置参数会被**拼进命令串**再解析,
  // 路径里的反斜杠直接变成语法错误(ParserError: UnexpectedToken)
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
    '$img = [System.Windows.Forms.Clipboard]::GetImage();',
    'if ($null -eq $img) { exit 3 }',
    '$img.Save($env:G_AI_CLIP_OUT, [System.Drawing.Imaging.ImageFormat]::Png);',
    '$img.Dispose(); exit 0',
  ].join(' ')
  const r = await execFileP('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-STA', '-Command', script,
  ], { env: { ...process.env, G_AI_CLIP_OUT: file } })
  return r.ok && r.code === 0
}

async function saveClipboardMac(file) {
  // «class PNGf» 是 AppleScript 的 PNG 剪贴板类型;剪贴板无图片时 osascript 非零退出
  // 输出路径走 system attribute 读环境变量,避免路径拼进脚本字符串的引号问题
  const script = [
    'set outPath to system attribute "G_AI_CLIP_OUT"',
    'set pngData to the clipboard as «class PNGf»',
    'set fp to open for access (POSIX file outPath) with write permission',
    'set eof fp to 0',
    'write pngData to fp',
    'close access fp',
  ].join('\n')
  const r = await execFileP('osascript', ['-e', script], { env: { ...process.env, G_AI_CLIP_OUT: file } })
  return r.ok && r.code === 0
}

async function saveClipboardLinux(file) {
  // 优先 Wayland 的 wl-paste;失败再试 X11 的 xclip
  const wayland = await execFileP('wl-paste', ['--no-newline', '--type', 'image/png'])
  if (wayland.ok && wayland.stdout.length > 0) {
    await fsp.writeFile(file, wayland.stdout)
    return true
  }
  const x11 = await execFileP('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'])
  if (x11.ok && x11.stdout.length > 0) {
    await fsp.writeFile(file, x11.stdout)
    return true
  }
  return false
}

// ──────────────────────────────────────────────
// 对外 API
// ──────────────────────────────────────────────

/**
 * 读取剪贴板图片,保存为 PNG。
 * @returns {Promise<{path: string, bytes: number} | null>}
 *   成功返回文件路径与字节数;剪贴板无图片 / 平台不支持 / 超时返回 null
 */
export async function readClipboardImage() {
  await fsp.mkdir(IMAGE_DIR, { recursive: true })
  const file = path.join(IMAGE_DIR, `clip-${Date.now()}.png`)

  let saved = false
  try {
    if (process.platform === 'win32') saved = await saveClipboardWindows(file)
    else if (process.platform === 'darwin') saved = await saveClipboardMac(file)
    else saved = await saveClipboardLinux(file)
  } catch {
    saved = false
  }

  if (!saved) {
    await fsp.unlink(file).catch(() => {})
    return null
  }

  try {
    const st = await fsp.stat(file)
    if (st.size === 0) {
      await fsp.unlink(file).catch(() => {})
      return null
    }
    pruneOldImages() // 不 await,后台清理
    return { path: file, bytes: st.size }
  } catch {
    return null
  }
}

/**
 * 校验本地图片文件,返回 {path, bytes};不存在/不是支持的格式返回 null
 */
export async function checkImageFile(filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase()
    if (!MIME_BY_EXT[ext]) return null
    const st = await fsp.stat(filePath)
    if (!st.isFile() || st.size === 0) return null
    return { path: filePath, bytes: st.size }
  } catch {
    return null
  }
}

/**
 * 图片文件 → OpenAI 多模态格式需要的 base64 data URL
 */
export async function imageToDataUrl(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const mime = MIME_BY_EXT[ext] || 'image/png'
  const buf = await fsp.readFile(filePath)
  return `data:${mime};base64,${buf.toString('base64')}`
}

export default { readClipboardImage, checkImageFile, imageToDataUrl, formatBytes }
