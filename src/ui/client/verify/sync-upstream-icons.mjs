// 从上游仓库批量下载缺失的 SVG，并把"基础已存在但 -open 变体缺失"的 SVG 本地复用
// 用法: node verify/sync-upstream-icons.mjs
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const MATERIAL_DIR = path.join(ROOT, 'src/assets/icons/material')
const MANIFEST = path.join(ROOT, 'src/utils/material-icons.json')

const json = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'))
const have = new Set(
  fs.readdirSync(MATERIAL_DIR).map((f) => f.replace(/^mit-/, '').replace(/\.svg$/, '')),
)

// 文件名即 manifest 中 iconPath 的 basename（去前缀/后缀），key 与 fileName 一一对应
const fileNames = new Set()
const keyToFile = new Map()
for (const [key, def] of Object.entries(json.iconDefinitions)) {
  const fileName = def.iconPath.split('/').pop().replace(/^mit-/, '').replace(/\.svg$/, '')
  keyToFile.set(key, fileName)
  fileNames.add(fileName)
}

// 本地复用：folder-xxx-open 但基础 folder-xxx 已存在 → 复制一份
let clonedOpen = 0
const toClone = []
for (const fileName of fileNames) {
  if (have.has(fileName)) continue
  if (!fileName.startsWith('folder-')) continue
  if (!fileName.endsWith('-open')) continue
  const base = fileName.replace(/-open$/, '')
  if (have.has(base)) {
    toClone.push({ variant: fileName, base })
  }
}
for (const { variant, base } of toClone) {
  const src = path.join(MATERIAL_DIR, `mit-${base}.svg`)
  const dst = path.join(MATERIAL_DIR, `mit-${variant}.svg`)
  fs.copyFileSync(src, dst)
  have.add(variant)
  clonedOpen++
}
console.log(`[sync] 本地复用 -open 变体 ${clonedOpen} 个`)

// 本地复用：xxx.clone.svg 是占位符，iconPath 指向 xxx.svg 本身，但 .clone 是别名
let clonedRef = 0
const toCloneRef = []
for (const fileName of fileNames) {
  if (have.has(fileName)) continue
  if (!fileName.endsWith('.clone')) continue
  const base = fileName.replace(/\.clone$/, '')
  if (have.has(base)) {
    toCloneRef.push({ variant: fileName, base })
  }
}
for (const { variant, base } of toCloneRef) {
  const src = path.join(MATERIAL_DIR, `mit-${base}.svg`)
  const dst = path.join(MATERIAL_DIR, `mit-${variant}.svg`)
  fs.copyFileSync(src, dst)
  have.add(variant)
  clonedRef++
}
console.log(`[sync] 本地复用 .clone 占位 ${clonedRef} 个`)

// 本地复用：xxx_light 但基础 xxx 已存在
let clonedLight = 0
const toCloneLight = []
for (const fileName of fileNames) {
  if (have.has(fileName)) continue
  if (!fileName.endsWith('_light')) continue
  const base = fileName.replace(/_light$/, '')
  if (have.has(base)) {
    toCloneLight.push({ variant: fileName, base })
  }
}
for (const { variant, base } of toCloneLight) {
  const src = path.join(MATERIAL_DIR, `mit-${base}.svg`)
  const dst = path.join(MATERIAL_DIR, `mit-${variant}.svg`)
  fs.copyFileSync(src, dst)
  have.add(variant)
  clonedLight++
}
console.log(`[sync] 本地复用 _light 变体 ${clonedLight} 个`)

// folder-root / folder-root-open 单独处理：根目录图标用通用 folder 替代
if (!have.has('folder-root')) {
  fs.copyFileSync(path.join(MATERIAL_DIR, 'mit-folder.svg'), path.join(MATERIAL_DIR, 'mit-folder-root.svg'))
  have.add('folder-root')
  console.log('[sync] folder-root <- folder')
}
if (!have.has('folder-root-open')) {
  fs.copyFileSync(path.join(MATERIAL_DIR, 'mit-folder-open.svg'), path.join(MATERIAL_DIR, 'mit-folder-root-open.svg'))
  have.add('folder-root-open')
  console.log('[sync] folder-root-open <- folder-open')
}

// 剩下的去上游拉
// 注意：xxx.clone 在上游不存在（运行时由 icon registry 动态生成），
// 所以要拉的是去掉 .clone 后的基础名
const realMissing = new Set()
for (const fileName of fileNames) {
  if (have.has(fileName)) continue
  if (fileName.endsWith('.clone')) {
    realMissing.add(fileName.replace(/\.clone$/, ''))
  } else {
    realMissing.add(fileName)
  }
}

console.log(`[sync] 上游 ${fileNames.size} 个文件，本地 ${have.size} 个，需下载 ${realMissing.length} 个`)

const BASE = 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/main/icons/'
const CONCURRENCY = 8
let downloaded = 0
let failed = 0
const failedNames = []

async function downloadWithRetry(name, retries = 2) {
  const url = `${BASE}${name}.svg`
  const dest = path.join(MATERIAL_DIR, `mit-${name}.svg`)
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      const head = buf.subarray(0, 20).toString('utf-8').trim()
      if (!head.startsWith('<')) throw new Error('not SVG')
      fs.writeFileSync(dest, buf)
      return true
    } catch (e) {
      if (i === retries) {
        failed++
        failedNames.push(`${name} (${e.message})`)
        return false
      }
      await new Promise((r) => setTimeout(r, 500 * (i + 1)))
    }
  }
}

const queue = [...realMissing]
const workers = Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) {
    const name = queue.shift()
    if (!name) return
    await downloadWithRetry(name)
    downloaded++
    if (downloaded % 10 === 0 || queue.length === 0) {
      console.log(`[sync] 进度 ${downloaded}/${realMissing.size} (失败 ${failed})`)
    }
  }
})
await Promise.all(workers)

console.log(`[sync] 下载: 成功 ${realMissing.size - failed}, 失败 ${failed}`)
if (failedNames.length) {
  console.log('[sync] 失败列表（这些将走 fallback）:')
  for (const f of failedNames) console.log('  -', f)
}

// 下载完后，本地复用 .clone 变体
for (const fileName of fileNames) {
  if (have.has(fileName)) continue
  if (!fileName.endsWith('.clone')) continue
  const base = fileName.replace(/\.clone$/, '')
  if (have.has(base)) {
    fs.copyFileSync(path.join(MATERIAL_DIR, `mit-${base}.svg`), path.join(MATERIAL_DIR, `mit-${fileName}.svg`))
    have.add(fileName)
    clonedRef++
  }
}
console.log(`[sync] 下载后本地复用 .clone 占位 ${clonedRef} 个`)
