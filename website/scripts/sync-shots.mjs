// 从主仓库 docs/ 同步官网用到的真实截图 / 字体 / 品牌资源到 website/public
// 用法: node website/scripts/sync-shots.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const pub = path.join(root, 'website', 'public')

const shots = {
  'cli-quick-commit.png': '01-cli-quick-commit.png',
  'workbench-board.png': '02-workbench-board.png',
  'agent-cli.png': '03-agent-cli-terminal.png',
  'agent-gui.png': '04-agent-assistant-gui.png',
  'git-commit-view.png': '05-git-commit-view.png',
  'file-space.png': '06-file-space-preview.png',
  'mindmap.png': '07-mindmap.png',
}

// 文档页用图:来源不止「手写版介绍文章图片」一个目录,按 (目标, 源目录, 源文件) 写全
// 浅色画布的截图(console / monitor / flow)在页面上走 ShotFrame 的 paper 属性
const docShots = [
  ['settings-dialog-dark.png', 'screenshots', '12-user-settings-dialog-dark.png'],
  ['console.png', 'screenshots/article', '07-console.png'],
  ['monitor.png', 'screenshots/article', '11-monitor.png'],
  ['flow.png', 'screenshots/article', '08-flow.png'],
  ['repo-browser-dark.png', 'screenshots', '16-repo-browser-dark.png'],
  ['remote-manage-dark.png', 'screenshots', '17-remote-manager-dark.png'],
  ['branch-selector-dark.png', 'screenshots', '18-branch-selector-dark.png'],
  ['projects-view-dark.png', 'screenshots', '15-projects-view-dark.png']
]

// 首屏主视觉的产品演示录屏(与 cli-quick-commit.png 同画面)
const videos = {
  'cli-quick-commit.mp4': '01-cli-quick-commit.mp4',
}

const fonts = [
  'plus-jakarta-sans-latin.woff2',
  'plus-jakarta-sans-latin-ext.woff2',
  'plus-jakarta-sans-latin-italic.woff2',
  'jetbrains-mono-latin.woff2',
]

let total = 0
for (const [dest, src] of Object.entries(shots)) {
  const from = path.join(root, 'docs', 'screenshots', '手写版介绍文章图片', src)
  const to = path.join(pub, 'shots', dest)
  fs.copyFileSync(from, to)
  total += fs.statSync(to).size
  console.log('shot  ', dest, (fs.statSync(to).size / 1024).toFixed(0) + 'KB')
}
for (const [dest, src] of Object.entries(videos)) {
  const from = path.join(root, 'docs', 'screenshots', '手写版介绍文章图片', src)
  const to = path.join(pub, 'shots', dest)
  fs.copyFileSync(from, to)
  total += fs.statSync(to).size
  console.log('video ', dest, (fs.statSync(to).size / 1024).toFixed(0) + 'KB')
}
for (const [dest, dir, src] of docShots) {
  const from = path.join(root, 'docs', dir, src)
  const to = path.join(pub, 'shots', dest)
  fs.copyFileSync(from, to)
  total += fs.statSync(to).size
  console.log('docshot', dest, (fs.statSync(to).size / 1024).toFixed(0) + 'KB')
}
for (const f of fonts) {
  const from = path.join(root, 'src', 'ui', 'client', 'public', 'fonts', f)
  const to = path.join(pub, 'fonts', f)
  fs.copyFileSync(from, to)
  console.log('font  ', f)
}
for (const f of ['src/ui/client/public/favicon.svg']) {
  fs.copyFileSync(path.join(root, f), path.join(pub, path.basename(f)))
  console.log('brand ', path.basename(f))
}
// 顶栏 / 页脚用的品牌图形取产品界面在用的那份(src/assets/logo.svg),
// 不用 src/ui/client/public/logo.svg:那个文件的注释里混了坏字节(非法 UTF-8),
// 浏览器按 XML 解析 SVG 时会直接判失败,表现是顶栏 logo 破图。
fs.copyFileSync(
  path.join(root, 'src', 'ui', 'client', 'src', 'assets', 'logo.svg'),
  path.join(pub, 'logo.svg')
)
console.log('brand  logo.svg ← src/ui/client/src/assets/logo.svg')
console.log('shots total', (total / 1048576).toFixed(2) + 'MB')
