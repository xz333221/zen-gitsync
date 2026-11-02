// 头像值的解析：一套值要同时支持「内置动物图」「上传的 data URL」「老版本存的 emoji」。
//
// 落库格式（与 xiangqi 同一套思路，但这里没有服务端静态目录，只存标识符）：
//   builtin:avatar5.webp  —— 内置头像，存**源文件名**而不是打包地址
//   data:image/...        —— 本地图片上传后裁好的小图
//   http(s)://...         —— 外链
//   🦊 / 首字             —— 早先版本的 emoji，继续认，别让人头像突然没了
//
// 为什么不存打包地址：Vite 产物的文件名带内容哈希（avatar5-Bx3k.webp），
// 换图或升级构建工具哈希就变，存下去的头像会集体 404。源文件名是稳定的。
//
// 资源说明：assets/avatars/*.webp 由 xiangqi 项目的头像集统一压成 128×128 webp
// （单张 2~3KB，合计 ~73KB）。换图时保持「avatarN.webp」的命名，否则已存的值会认不出。
//
// 跨机器提示：对方拿到的只是这串值。`builtin:` 要靠对面自己那份资源还原 ——
// 双方跑同一个包时名字一致；名字对不上时**不猜**（宁可空着），免得张冠李戴。
const modules = import.meta.glob('../assets/avatars/*.webp', {
  eager: true,
  import: 'default'
}) as Record<string, string>

export const PEER_AVATAR_PREFIX = 'builtin:'

/** 源文件名里的序号：avatar2 排在 avatar10 前面（纯字典序会把 10 排到 2 前）。 */
function orderOf(name: string): number {
  const m = /(\d+)/.exec(name)
  return m ? Number(m[1]) : Number.NaN
}

/** 内置头像：name 落库用，url 展示用。顺序由**源文件名**决定，不受构建哈希影响。 */
export const PEER_AVATARS: Array<{ name: string; url: string }> = Object.entries(modules)
  .map(([filePath, url]) => ({ name: filePath.split('/').pop() || '', url }))
  .filter((item) => item.name && item.url)
  .sort((a, b) => {
    const na = orderOf(a.name)
    const nb = orderOf(b.name)
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
    return a.name.localeCompare(b.name)
  })

const byName = new Map(PEER_AVATARS.map((item) => [item.name, item.url]))

export type ResolvedAvatar =
  | { kind: 'image'; src: string }
  | { kind: 'text'; text: string }
  | { kind: 'none' }

/** 把 peers.json 里的 avatar 值解析成"该怎么画"。 */
export function resolveAvatar(value?: string | null): ResolvedAvatar {
  const v = String(value || '').trim()
  if (!v) return { kind: 'none' }

  if (v.startsWith(PEER_AVATAR_PREFIX)) {
    const url = byName.get(v.slice(PEER_AVATAR_PREFIX.length))
    // 认不出就空着：显示成默认动物等于给错人贴了张脸
    return url ? { kind: 'image', src: url } : { kind: 'none' }
  }
  if (/^data:image\//i.test(v) || /^https?:\/\//i.test(v)) return { kind: 'image', src: v }
  return { kind: 'text', text: v.slice(0, 2) }
}

/** 内置头像的落库值。 */
export function toStoredAvatar(sourceName: string): string {
  return `${PEER_AVATAR_PREFIX}${sourceName}`
}

