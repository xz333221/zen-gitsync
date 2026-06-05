import icons from './material-icons.json'

interface IconDefinition {
  iconPath: string
}

interface MaterialIconManifest {
  iconDefinitions: Record<string, IconDefinition>
  fileNames?: Record<string, string>
  fileExtensions?: Record<string, string>
  folderNames?: Record<string, string>
  folderNamesExpanded?: Record<string, string>
  rootFolderNames?: Record<string, string>
  rootFolderNamesExpanded?: Record<string, string>
  languageIds?: Record<string, string>
}

const manifest = icons as MaterialIconManifest
const DEFINITIONS = manifest.iconDefinitions || {}

// 项目内自有的 AI IDE 工具 dotfolder，官方未收录，复用官方现有 SVG
// 注意：这里返回的是 Vite sprite 真实 id（带 mit- 前缀），与 src/assets/icons/material/*.svg 文件名一致
const CUSTOM_FOLDER_OVERRIDES: Record<string, string> = {
  '.qoder': 'mit-folder-config',
  '.codebuddy': 'mit-folder-config',
  '.windsurf': 'mit-folder-config',
  '.workbuddy': 'mit-folder-config',
  '.trae': 'mit-folder-config',
  '.iflow': 'mit-folder-config',
}

/**
 * 从 iconPath 提取最终用于 sprite id 的 key
 * 例如 './../icons/mit-folder-claude.svg' -> 'mit-folder-claude'
 */
function pathToKey(iconPath: string | undefined): string | null {
  if (!iconPath) return null
  const fileName = iconPath.split('/').pop() || ''
  return fileName.replace(/\.svg$/i, '') || null
}

/**
 * 把 iconDefinitions 中的引用（key 或 iconPath）解析为最终 sprite id key（不含 icon- 前缀）
 */
function extractKey(def: string | undefined): string | null {
  if (!def) return null
  // 先看是否为 iconDefinitions 中的 key（直接以文件名作为 key 也合法）
  if (DEFINITIONS[def]) return pathToKey(DEFINITIONS[def].iconPath) || def
  return pathToKey(def)
}

const FALLBACK_FOLDER = 'folder'
const FALLBACK_FILE = 'file'

// 把 manifest 中的 'file' / 'folder' 引用解析为 Vite sprite 真正注册的 id（'mit-file' / 'mit-folder'）。
// 若解析失败则用字面量 'mit-file' / 'mit-folder' 作为兜底，确保 <use href="#icon-mit-file"> 一定命中。
const FALLBACK_FOLDER_KEY: string =
  extractKey(DEFINITIONS[FALLBACK_FOLDER]?.iconPath) || 'mit-folder'
const FALLBACK_FILE_KEY: string =
  extractKey(DEFINITIONS[FALLBACK_FILE]?.iconPath) || 'mit-file'
// 万一默认 sprite 也没找到，再用通用默认图标（mit-folder-open / mit-text 等也已收录）
const ULTIMATE_FALLBACK_FILE = 'mit-file'
const ULTIMATE_FALLBACK_FOLDER = 'mit-folder'

const cache = new Map<string, string>()

function resolveFolder(name: string, expanded: boolean): string {
  const cacheKey = `${expanded ? '1' : '0'}|${name}`
  const cached = cache.get(cacheKey)
  if (cached) return cached

  const lower = name.toLowerCase()
  const custom = CUSTOM_FOLDER_OVERRIDES[lower]
  if (custom) {
    cache.set(cacheKey, custom)
    return custom
  }

  const map = expanded ? manifest.folderNamesExpanded : manifest.folderNames
  const fromMap = map?.[name]
  if (fromMap) {
    const key = extractKey(fromMap)
    if (key) {
      cache.set(cacheKey, key)
      return key
    }
  }

  const rootMap = expanded ? manifest.rootFolderNamesExpanded : manifest.rootFolderNames
  const fromRoot = rootMap?.[name]
  if (fromRoot) {
    const key = extractKey(fromRoot)
    if (key) {
      cache.set(cacheKey, key)
      return key
    }
  }

  if (DEFINITIONS[FALLBACK_FOLDER]) {
    cache.set(cacheKey, FALLBACK_FOLDER_KEY)
    return FALLBACK_FOLDER_KEY
  }
  cache.set(cacheKey, ULTIMATE_FALLBACK_FOLDER)
  return ULTIMATE_FALLBACK_FOLDER
}

function resolveFile(name: string): string {
  const cached = cache.get(name)
  if (cached) return cached

  if (manifest.fileNames?.[name]) {
    const key = extractKey(manifest.fileNames[name])
    if (key) {
      cache.set(name, key)
      return key
    }
  }
  const lower = name.toLowerCase()
  if (manifest.fileNames?.[lower]) {
    const key = extractKey(manifest.fileNames[lower])
    if (key) {
      cache.set(name, key)
      return key
    }
  }

  const dotIndex = lower.lastIndexOf('.')
  if (dotIndex > 0 && dotIndex < lower.length - 1) {
    const ext = lower.slice(dotIndex + 1)
    if (manifest.fileExtensions?.[ext]) {
      const key = extractKey(manifest.fileExtensions[ext])
      if (key) {
        cache.set(name, key)
        return key
      }
    }
  }

  if (DEFINITIONS[FALLBACK_FILE]) {
    cache.set(name, FALLBACK_FILE_KEY)
    return FALLBACK_FILE_KEY
  }
  cache.set(name, ULTIMATE_FALLBACK_FILE)
  return ULTIMATE_FALLBACK_FILE
}

/**
 * 解析给定节点名称对应的 sprite id（不含 icon- 前缀），如 'mit-folder-git-open' / 'mit-typescript'
 */
export function resolveMaterialIcon(name: string, isDirectory: boolean, expanded: boolean): string {
  return isDirectory ? resolveFolder(name, expanded) : resolveFile(name)
}

/** 构造完整的 sprite id（带 icon- 前缀），配合 <use :xlink:href> 使用 */
export function toSpriteId(key: string): string {
  return `icon-${key}`
}
