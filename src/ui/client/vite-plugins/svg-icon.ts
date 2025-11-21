import * as path from 'path'
import { createSvgIconsPlugin } from 'vite-plugin-svg-icons'

export default function createSvgIcon(isBuild: boolean) {
  return createSvgIconsPlugin({
    // SVG 文件存放目录
    iconDirs: [path.resolve(process.cwd(), 'src/assets/icons/svg/')],
    // symbol id 格式：icon-[文件名]
    symbolId: 'icon-[name]',
    // 生产环境优化 SVG
    svgoOptions: isBuild,
  })
}
