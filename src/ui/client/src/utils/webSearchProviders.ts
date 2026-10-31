// 联网搜索的 provider 元数据（**只做展示 & Key 申请入口**）。
//
// 权威白名单在 src/config.js 的 WEB_SEARCH_PROVIDERS —— 两边要一起改。
// 申请入口/价格整理自用户调研（https://blog.flowdash.cn/post/32，实测 2026-10-25），
// 价格与额度会变，仅供填 Key 时参考。

export interface WebSearchProviderMeta {
  id: string
  label: string
  /** true = 无 key 也能用（按 IP 限流），key 只是提额度 */
  keyless: boolean
  /** Key 申请入口（设置面板里「去申请 Key」外链的目标） */
  applyUrl: string
  /** true = 这个 provider 需要填实例地址，而不是 API Key */
  needsBaseUrl?: boolean
  /** 实例地址输入框的 placeholder */
  baseUrlPlaceholder?: string
}

export const WEB_SEARCH_PROVIDERS: WebSearchProviderMeta[] = [
  { id: 'firecrawl', label: 'Firecrawl', keyless: true, applyUrl: 'https://www.firecrawl.dev/' },
  { id: 'tavily', label: 'Tavily', keyless: false, applyUrl: 'https://app.tavily.com/' },
  { id: 'exa', label: 'Exa', keyless: false, applyUrl: 'https://exa.ai/' },
  {
    id: 'searxng',
    label: 'SearXNG',
    keyless: true,
    applyUrl: 'https://docs.searxng.org/',
    needsBaseUrl: true,
    baseUrlPlaceholder: 'http://127.0.0.1:8899/',
  },
]

export function webSearchProviderMeta(id: string): WebSearchProviderMeta | undefined {
  return WEB_SEARCH_PROVIDERS.find((p) => p.id === id)
}