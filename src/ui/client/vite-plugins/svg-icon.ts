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
import * as path from 'path'
import type { OptimizeOptions } from 'svgo'
import { createSvgIconsPlugin } from 'vite-plugin-svg-icons'

/**
 * svgo 配置（仅 build 期启用，dev 保持源文件原样，方便对着 SVG 源码调试）。
 *
 * 不能直接传 `true`（= 裸 preset-default）：preset-default 里的 removeUnknownsAndDefaults
 * 会把「值等于 SVG 属性初始值」的属性删掉，`fill="#000000"` 正好命中——黑就是 fill 的初始值。
 * 属性被删后 <path> 不再自带 fill，转而继承祖先 <svg class="svg-icon"> 上的
 * `fill: currentColor`（见 components/SvgIcon/index.vue 的 scoped 样式 +
 * styles/unified-dialogs.scss 里 `.svg-icon { color: var(--text-secondary) }`），
 * 于是纯黑图形被渲染成 #606266 的中灰。
 *
 * 症状：kimi.svg / codex.svg 这种「黑色底块 + 白色图形」的图标，
 * dev 下是黑色、build 产物里却是灰色——同一份代码两种观感，很难往 svgo 上想。
 *
 * defaultAttrs: false 只关掉「删默认值属性」这一条，其余压缩照旧，体积代价可忽略。
 */
export const svgSpriteSvgoOptions: OptimizeOptions = {
  plugins: [
    {
      name: 'preset-default',
      params: {
        overrides: {
          removeUnknownsAndDefaults: { defaultAttrs: false },
        },
      },
    },
  ],
}

export default function createSvgIcon(isBuild: boolean) {
  // 单一 sprite：项目自有图标与 Material Icon Theme 一起编译
  // symbolId 用 'icon-[name]'，让两个目录的图标共享同一前缀（无 [dir]），由调用方按目录名 + 文件名自行拼接
  // Material Icon Theme 的 key 用 'mit-{key}' 前缀以避免命名冲突（与项目自有图标无重名）
  return createSvgIconsPlugin({
    iconDirs: [
      path.resolve(process.cwd(), 'src/assets/icons/svg/'),
      path.resolve(process.cwd(), 'src/assets/icons/material/'),
    ],
    symbolId: 'icon-[name]',
    svgoOptions: isBuild ? svgSpriteSvgoOptions : false,
  })
}
