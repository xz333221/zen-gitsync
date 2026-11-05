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
// SVG sprite 生成插件（替代 vite-plugin-svg-icons@2.0.1）。
//
// 为什么不用现成的：那个版本的 `load(id)` 在 build 下**对每个模块**都会执行
// `createModuleCode()` —— 先判断 isRegister/isClient、再无条件编译全部图标，
// 只有最后两个 if 才决定返回什么。项目有 1206 个 svg，每次调用即使命中 mtime 缓存
// 也要重新 fast-glob 一遍两个目录（实测 16ms），5337 个模块 → 85s 起；
// 实测构建里 `vite:svg-icons load` 占 198s / 209s。
//
// 本实现只在 `virtual:svg-icons-register` 这一次 load 时编译，symbol 的生成仍交给
// svg-baker（viewBox 从 width/height 推导、渐变 id 加前缀去冲突、属性重排都由它处理），
// 所以产物与旧插件逐字一致；换掉的只是"谁来扫目录、扫几次"。
import * as fs from 'node:fs'
import fg from 'fast-glob'
// @ts-expect-error svg-baker 1.7.0 没有类型声明
import SVGCompiler from 'svg-baker'
import { optimize } from 'svgo'
import type { OptimizeOptions } from 'svgo'
import type { Plugin } from 'vite'

export const SVG_ICONS_REGISTER = 'virtual:svg-icons-register'

const XMLNS = 'http://www.w3.org/2000/svg'
const XMLNS_LINK = 'http://www.w3.org/1999/xlink'
const SVG_DOM_ID = '__svg__icons__dom__'

export interface SvgSpriteOptions {
  /** 参与编译的图标目录（递归扫 `**\/*.svg`） */
  iconDirs: string[]
  /** 只支持 `[name]`：本项目两个目录共用同一前缀，由调用方按目录名 + 文件名拼接 */
  symbolId: string
  /** build 期 svgo 配置；false = 保留源文件原样（dev 默认，方便对着源码调试） */
  svgoOptions?: OptimizeOptions | false
}

export interface SvgSprite {
  html: string
  ids: string[]
}

/** 扫描目录并生成 sprite。与旧插件的 compilerIcons 同序同格式，便于逐字对比。 */
export async function buildSprite(options: SvgSpriteOptions): Promise<SvgSprite> {
  const { iconDirs, symbolId, svgoOptions } = options
  const ids: string[] = []
  let html = ''

  for (const dir of iconDirs) {
    const normalizedDir = dir.replace(/\\/g, '/').replace(/\/$/, '')
    const files = fg.sync('**/*.svg', { cwd: dir, absolute: true })

    for (const file of files) {
      const relativeName = file.replace(/\\/g, '/').replace(normalizedDir + '/', '')
      // 与上游 createSymbolId 等价：先替换 [name]，再砍掉扩展名
      const id = symbolId.replace(/\[name\]/g, relativeName).replace(/\.svg$/i, '')

      let content = fs.readFileSync(file, 'utf8')
      if (svgoOptions) {
        const optimized = optimize(content, svgoOptions)
        content = 'data' in optimized ? optimized.data : content
      }
      // 与上游一致：只把**第一处** stroke 换成 currentColor（不是全局替换）。
      // 注意是在 svgo 之后执行，顺序反了会得到不同的属性值。
      content = content.replace(/stroke="[a-zA-Z#0-9]*"/, 'stroke="currentColor"')

      const symbol = await new SVGCompiler().addSymbol({ id, content, path: file })
      ids.push(id)
      html += symbol.render()
    }
  }

  return { html, ids }
}

/** 浏览器侧注入代码（与旧插件同结构，注入位置 body-last）。 */
function registerCode(sprite: SvgSprite): string {
  // 与上游一致：外层 <svg> 已经声明了 xmlns/xmlns:link，逐个 symbol 再带一份纯属重复。
  // 1206 个图标 × 40 字节 ≈ 48 KB，别小看。
  const html = sprite.html
    .replace(new RegExp(`xmlns="${XMLNS}"`, 'g'), '')
    .replace(new RegExp(`xmlns:xlink="${XMLNS_LINK}"`, 'g'), '')

  return `if (typeof window !== 'undefined') {
  function loadSvg() {
    var body = document.body
    var svgDom = document.getElementById('${SVG_DOM_ID}')
    if (!svgDom) {
      svgDom = document.createElementNS('${XMLNS}', 'svg')
      svgDom.style.position = 'absolute'
      svgDom.style.width = '0'
      svgDom.style.height = '0'
      svgDom.id = '${SVG_DOM_ID}'
      svgDom.setAttribute('xmlns', '${XMLNS}')
      svgDom.setAttribute('xmlns:link', '${XMLNS_LINK}')
    }
    svgDom.innerHTML = ${JSON.stringify(html)}
    body.insertBefore(svgDom, body.lastChild)
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadSvg)
  } else {
    loadSvg()
  }
}
export default {}`
}

export default function createSvgSprite(options: SvgSpriteOptions): Plugin {
  let cached: SvgSprite | null = null

  return {
    name: 'zen:svg-sprite',
    resolveId(id) {
      return id === SVG_ICONS_REGISTER ? id : null
    },
    async load(id) {
      // 关键：build 下 load 会对**所有**模块触发，非本虚拟模块必须立刻返回。
      if (id !== SVG_ICONS_REGISTER) return null
      if (!cached) cached = await buildSprite(options)
      return registerCode(cached)
    },
    configureServer(server) {
      // dev：改图标文件后让虚拟模块失效并整页刷新（原插件每次请求都重扫，反而不会陈旧）
      server.watcher.on('change', (file) => {
        if (!file.endsWith('.svg')) return
        const normalized = file.replace(/\\/g, '/')
        if (!options.iconDirs.some((dir) => normalized.startsWith(dir.replace(/\\/g, '/')))) return
        cached = null
        const mod = server.moduleGraph.getModuleById(SVG_ICONS_REGISTER)
        if (mod) server.moduleGraph.invalidateModule(mod)
        server.ws.send({ type: 'full-reload' })
      })
    },
  }
}
