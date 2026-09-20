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
// 回归：build 期 svgo 不能把「值等于 SVG 属性初始值」的显式 fill 删掉。
// preset-default 的 removeUnknownsAndDefaults 默认会吃掉 fill="#000000"（黑 = fill 的初始值），
// 属性一没，<path> 就转而继承 <svg class="svg-icon"> 上的 fill: currentColor
// （color: --text-secondary = #606266），纯黑图形于是在 build 产物里变成中灰。
// kimi / codex 两个图标踩过这个坑：dev 下正常黑，`npm run build` 后发灰。
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { optimize } from 'svgo'
import { svgSpriteSvgoOptions } from './svg-icon'

// vitest 的 cwd 即 client 根目录（vitest.config.ts 所在处）
const SVG_DIR = path.resolve(process.cwd(), 'src/assets/icons/svg')

// 源码里显式写死的"黑色"（含缩写与关键字形式）
const EXPLICIT_BLACK = /fill="(#000000|#000|black)"/
// 压缩后仍应看到黑色 fill（svgo 可能把 #000000 缩写成 #000）
const KEPT_BLACK = /fill="#0000{0,3}"/

describe('svg sprite 的 svgo 配置', () => {
  it('保留图标里显式写死的 fill', () => {
    const files = fs.readdirSync(SVG_DIR).filter((f) => f.endsWith('.svg'))
    expect(files).toContain('kimi.svg') // 固定住触发过该 bug 的样例，避免测试空转

    const stripped: string[] = []
    for (const file of files) {
      const source = fs.readFileSync(path.join(SVG_DIR, file), 'utf8')
      if (!EXPLICIT_BLACK.test(source)) continue
      const optimized = optimize(source, svgSpriteSvgoOptions).data
      if (!KEPT_BLACK.test(optimized)) stripped.push(file)
    }

    expect(stripped).toEqual([])
  })
})
