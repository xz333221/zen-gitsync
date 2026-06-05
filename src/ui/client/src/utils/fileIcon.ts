import { resolveMaterialIcon, toSpriteId } from './materialFileIcons'

export interface FileIconInfo {
  /** sprite id 完整字符串（含 mit- 前缀），如 'mit-folder-git'，可配合 <use :xlink:href> 使用 */
  spriteId: string
  /** 原始 key（不含前缀），调试用 */
  key: string
}

/**
 * 获取节点对应的 Material Icon Theme 图标信息
 * @param name 节点名称
 * @param isDirectory 是否为目录
 * @param expanded 目录是否处于展开状态
 */
export function getNodeIcon(name: string, isDirectory: boolean, expanded = false): FileIconInfo {
  const key = resolveMaterialIcon(name, isDirectory, expanded)
  return {
    spriteId: toSpriteId(key),
    key,
  }
}

/* ── 旧 API 兼容（仅供尚未迁移到 inline SVG 的位置使用） ──────────── */

/**
 * 旧 API：返回与 file-icons-js 兼容的 CSS class 名（已废弃，文件树用 getNodeIcon）
 * 现将解析为 mit- 前缀的类名，便于内嵌到 .icon 选择器中
 */
export function getFileIconClass(fileName: string): string {
  return toSpriteId(resolveMaterialIcon(fileName, false, false))
}

export function getFolderIconClass(folderName: string): string {
  return toSpriteId(resolveMaterialIcon(folderName, true, false))
}
