import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'

export const OFFICE_EXTS = new Set([
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
])

const MAX_INPUT_BYTES = 50 * 1024 * 1024
const CONVERT_TIMEOUT_MS = 30_000
const cache = new Map()

export function getOfficeExtension(filePath = '') {
  return path.extname(String(filePath)).toLowerCase().slice(1)
}

export function isOfficeFile(filePath = '') {
  return OFFICE_EXTS.has(getOfficeExtension(filePath))
}

function findSoffice() {
  if (process.env.SOFFICE_PATH) return process.env.SOFFICE_PATH
  return process.platform === 'win32' ? 'soffice.exe' : 'soffice'
}

async function runSoffice(inputPath, outputDir) {
  const args = [
    '--headless', '--nologo', '--nodefault', '--nofirststartwizard',
    '--norestore', '--convert-to', 'pdf', '--outdir', outputDir, inputPath,
  ]
  await new Promise((resolve, reject) => {
    const child = spawn(findSoffice(), args, { windowsHide: true })
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Office 文件转换超时'))
    }, CONVERT_TIMEOUT_MS)
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `LibreOffice 转换失败 (${code})`))
    })
  })
}

/** Convert an Office buffer to PDF. Results are cached by caller-provided key. */
export async function convertOfficeToPdf({ buffer, filePath, cacheKey }) {
  if (!Buffer.isBuffer(buffer)) throw new Error('Office 内容必须是二进制 Buffer')
  if (buffer.length > MAX_INPUT_BYTES) throw new Error('Office 文件过大（最大 50 MB）')
  if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey)

  const ext = getOfficeExtension(filePath)
  if (!OFFICE_EXTS.has(ext)) throw new Error('不支持的 Office 文件类型')

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-office-'))
  const inputPath = path.join(tempRoot, `input.${ext}`)
  const outputPath = path.join(tempRoot, 'input.pdf')
  try {
    await fs.writeFile(inputPath, buffer)
    await runSoffice(inputPath, tempRoot)
    const pdf = await fs.readFile(outputPath)
    const result = { buffer: pdf, contentType: 'application/pdf' }
    if (cacheKey) {
      cache.set(cacheKey, result)
      if (cache.size > 64) cache.delete(cache.keys().next().value)
    }
    return result
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

export function clearOfficePreviewCache() {
  cache.clear()
}

export const OFFICE_PREVIEW_LIMITS = { maxInputBytes: MAX_INPUT_BYTES, timeoutMs: CONVERT_TIMEOUT_MS }
