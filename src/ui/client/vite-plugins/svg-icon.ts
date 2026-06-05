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
