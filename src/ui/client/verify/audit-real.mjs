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
// 精准审计 + 自动同步 fallback map
//
// 两个核心检查：
// 1. user tree 实际命中的 key 在 sprite 中存在吗（运行时真实渲染）
// 2. JSON 引用但 material/ 目录缺 SVG 的 key → 自动写入 materialFallbackMap.json
//
// 跑法：node verify/audit-real.mjs [port]
import { chromium } from '@playwright/test'
import fs from 'fs'
import path from 'path'

const PORT = process.argv[2] || process.env.PORT || '5526'
const URL = `http://localhost:${PORT}/`
const ROOT = process.cwd()  // src/ui/client
const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/utils/material-icons.json'), 'utf-8'))
const materialDir = path.join(ROOT, 'src/assets/icons/material')
const have = new Set(fs.readdirSync(materialDir).map(f => f.replace(/^mit-/, '').replace(/\.svg$/, '')))

// === 1. 同步 fallback map ===
// JSON 引用了但 material 目录没 SVG 的 key -> 写为通用 file/folder
const FALLBACK_MAP = {}
let fallbackChanged = false
for (const [key, def] of Object.entries(json.iconDefinitions)) {
  const fileName = def.iconPath.split('/').pop().replace(/^mit-/, '').replace(/\.svg$/, '')
  if (!have.has(fileName)) {
    FALLBACK_MAP[key] = key.startsWith('folder-') ? 'folder' : 'file'
  }
}
const fallbackPath = path.join(ROOT, 'src/utils/materialFallbackMap.json')
let existingFallback = {}
try { existingFallback = JSON.parse(fs.readFileSync(fallbackPath, 'utf-8')) } catch {}
if (JSON.stringify(existingFallback) !== JSON.stringify(FALLBACK_MAP)) {
  fs.writeFileSync(fallbackPath, JSON.stringify(FALLBACK_MAP, null, 2))
  fallbackChanged = true
  console.log(`materialFallbackMap.json 更新（${Object.keys(FALLBACK_MAP).length} 条）`)
} else {
  console.log(`materialFallbackMap.json 无变化（${Object.keys(FALLBACK_MAP).length} 条）`)
}

// === 2. 检查 user tree 中所有节点的 use href 在 sprite 里实际是否存在 ===
function resolveKey(name, isDir) {
  let key = null
  if (isDir) {
    if (json.folderNames?.[name]) key = json.folderNames[name]
    if (!key && json.rootFolderNames?.[name]) key = json.rootFolderNames[name]
    if (!key && json.folderNamesExpanded?.[name]) key = json.folderNamesExpanded[name]
  } else {
    if (json.fileNames?.[name]) key = json.fileNames[name]
    if (!key) {
      const dotIndex = name.lastIndexOf('.')
      if (dotIndex > 0) {
        const ext = name.slice(dotIndex + 1).toLowerCase()
        if (json.fileExtensions?.[ext]) key = json.fileExtensions[ext]
      }
    }
  }
  if (!key) return null
  if (json.iconDefinitions[key]) {
    return json.iconDefinitions[key].iconPath.split('/').pop().replace(/^mit-/, '').replace(/\.svg$/, '')
  }
  return null
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
const activityBtns = await page.locator('.activity-bar button, .left-rail button, [class*="activity"] button').all()
await activityBtns[1].click()
await page.waitForTimeout(2000)
for (let i = 0; i < 5; i++) {
  for (const f of await page.locator('.tree-node--folder, .tree-node--directory').all()) {
    try { await f.click({ timeout: 1000 }); await page.waitForTimeout(50) } catch {}
  }
  await page.waitForTimeout(200)
}

const broken = await page.evaluate(() => {
  const out = []
  for (const n of document.querySelectorAll('.tree-node')) {
    const name = n.querySelector('.tree-name, .node-name')?.textContent?.trim()
    if (!name) continue
    const use = n.querySelector('use')
    const href = use ? (use.getAttribute('xlink:href') || use.getAttribute('href')) : null
    if (!href) continue
    const id = href.replace('#', '')
    const exists = !!document.getElementById(id)
    if (!exists) out.push({ name, href })
  }
  return out
})

console.log('\n=== user tree 中所有 use href 在 sprite 里缺失 ===')
if (broken.length === 0) {
  console.log('  ✓ 0 个缺失（fallback 生效）')
} else {
  console.log(`  ✗ ${broken.length} 个缺失:`)
  for (const b of broken) console.log('    -', b.name, '->', b.href)
  process.exitCode = 1
}

await browser.close()
process.exit(process.exitCode || 0)
