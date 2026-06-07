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
import { createSvgIconsPlugin } from 'vite-plugin-svg-icons'

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
    svgoOptions: isBuild,
  })
}
