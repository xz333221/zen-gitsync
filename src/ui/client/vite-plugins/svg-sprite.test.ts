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
// 回归：sprite 生成器必须把**每个**图标都编进 symbol，且 id 唯一。
//
// 历史：这里原本用 vite-plugin-svg-icons@2.0.1，它的 load 在 build 下会对每个模块
// 重编译一遍全部图标（构建里占 198s / 209s），已换成 vite-plugins/svg-sprite.ts。
// 换实现时用「新旧输出逐字对比」验证过（955683 字节完全一致）；本测试守的是
// 那次对比里最容易在后续重构中丢掉的几条性质。
import { describe, expect, it } from 'vitest'
import * as path from 'node:path'
import fg from 'fast-glob'
import { buildSprite } from './svg-sprite'

const ICON_DIRS = [
  path.resolve(process.cwd(), 'src/assets/icons/svg'),
  path.resolve(process.cwd(), 'src/assets/icons/material'),
]

const svgCount = ICON_DIRS.reduce(
  (n, dir) => n + fg.sync('**/*.svg', { cwd: dir }).length,
  0,
)

describe('svg sprite 生成', () => {
  it('每个 svg 都生成 symbol，id 唯一且带 icon- 前缀', async () => {
    const { html, ids } = await buildSprite({ iconDirs: ICON_DIRS, symbolId: 'icon-[name]' })

    expect(ids.length).toBe(svgCount)
    expect(new Set(ids).size).toBe(svgCount) // 两个目录共用前缀，重名会静默丢图标
    expect(ids.every((id) => id.startsWith('icon-'))).toBe(true)
    expect(html.match(/<symbol /g)?.length ?? 0).toBe(svgCount)
  })

  it('缺少 viewBox 的图标从 width/height 推导（svg-baker 行为，别在换实现时丢掉）', async () => {
    const { html, ids } = await buildSprite({ iconDirs: ICON_DIRS, symbolId: 'icon-[name]' })

    // codearts.svg / codebuddy.svg 只写了 width/height，没有 viewBox
    for (const id of ['icon-codearts', 'icon-codebuddy']) {
      expect(ids).toContain(id)
      const start = html.indexOf(`id="${id}"`)
      expect(start).toBeGreaterThan(-1)
      const symbolTag = html.slice(html.lastIndexOf('<symbol', start), start)
      expect(symbolTag).toMatch(/viewBox="0 0 \d+ \d+"/)
    }
  })

  it('第一处 stroke 换成 currentColor，写死的 fill 保持原值', async () => {
    const { html } = await buildSprite({ iconDirs: ICON_DIRS, symbolId: 'icon-[name]' })
    // zcode.svg：深色圆角底 + 白色 Z，只有一处 stroke（跟随主题），fill 是品牌色不能动
    const start = html.indexOf('id="icon-zcode"')
    const symbol = html.slice(html.lastIndexOf('<symbol', start), html.indexOf('</symbol>', start))
    expect(symbol).toContain('stroke="currentColor"')
    expect(symbol).toContain('fill="#2D2D2D"')
  })
})
