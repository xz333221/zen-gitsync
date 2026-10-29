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
// 模型服务商 logo：把模型的 baseURL 换成一张 logo 图。
//
// 这套映射跟 `ai-model-form` 表单里「接口地址」输入框左侧那颗图标是同一份名单
// （那个包的 providers 列表在组件内部、没导出，只能在这里再列一次）。底栏的
// 「默认模型」想跟表单里长一个样，就靠它。
//
// 为什么按 host 匹配而不是整串 URL 相等：表单里是静态下拉、URL 一字不差；
// 底栏拿到的是用户配置里存的地址，可能带/不带结尾斜杠、可能换条路径
// （火山同一个域名下有 /api/plan/v3 与 /api/coding/v3 两套），按域名认更稳。

/** 图片 CDN。与 ai-model-form 保持一致，换 CDN 时两处一起改。 */
const LOGO_CDN = 'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-png'

export type ProviderTheme = 'light' | 'dark'

/**
 * host（全小写）→ @lobehub/icons-static-png 里的图标名。
 *
 * 名字带 `-color` 的是彩色图标（任何背景下都用 dark/ 目录，不随主题变）；
 * 其余是单色图标，按主题挑 dark/ 或 light/ 目录，否则浅色主题下会白底白字。
 */
const HOST_TO_ICON: Record<string, string> = {
  'api.openai.com': 'openai',
  'api.anthropic.com': 'claude-color',
  'api.deepseek.com': 'deepseek-color',
  'generativelanguage.googleapis.com': 'gemini-color',
  'api.x.ai': 'grok',
  'api.llama-api.com': 'meta-color',
  'integrate.api.nvidia.com': 'nvidia-color',
  'api.mistral.ai': 'mistral-color',
  'api.minimaxi.com': 'minimax-color',
  'api.minimax.chat': 'minimax-color',
  'api.moonshot.cn': 'kimi-color',
  'open.bigmodel.cn': 'zhipu-color',
  'dashscope.aliyuncs.com': 'qwen-color',
  'api.cohere.com': 'cohere-color',
  'api.groq.com': 'groq',
  'api.together.xyz': 'together-color',
  'openrouter.ai': 'openrouter',
  'opencode.ai': 'opencode',
  'api.commandcode.ai': 'commandcode',
  'amr-link.open-design.ai': 'opendesign',
  'ark.cn-beijing.volces.com': 'volcengine-color',
  'localhost': 'ollama',
  '127.0.0.1': 'ollama',
}

/**
 * 图标包里没有的品牌（实测 CDN 404），用内联 SVG。
 *
 * 这些标都是单色路径，fill 必须跟主题走 —— 固定深色会让图标融进深色背景，
 * 跟 `-color` 那批「任何背景都能用」的彩色图标不是一回事。
 */
const INLINE_LOGOS: Record<string, (theme: ProviderTheme) => string> = {
  // OpenDesign 官方标（取自 open-design.ai/favicon.svg，82×82）
  opendesign: (theme) => {
    const fill = theme === 'light' ? '#26251E' : '#E8E6E1'
    const path = 'M41 0.726562C76.5753 0.726562 82 6.15121 82 41.7266C82 77.3019 76.5753 82.7266 41 82.7266C5.42465 82.7266 0 77.3019 0 41.7266C0 6.15121 5.42465 0.726562 41 0.726562ZM40.8906 16.4258C26.9164 16.4258 15.5879 27.7543 15.5879 41.7285C15.5879 46.7757 15.5879 58.0219 15.5879 63.665C15.588 65.5281 17.091 67.0312 18.9541 67.0312H40.8906C54.8647 67.0311 66.1932 55.7026 66.1934 41.7285C66.1934 27.7544 54.8647 16.4259 40.8906 16.4258ZM40.8906 21.4863C52.0699 21.4864 61.1328 30.5492 61.1328 41.7285C61.1327 52.9078 52.0699 61.9706 40.8906 61.9707C29.7113 61.9707 20.6485 52.9078 20.6484 41.7285C20.6484 30.5491 29.7113 21.4863 40.8906 21.4863ZM32.6445 32.2549C31.9921 32.0027 31.3503 32.6469 31.5996 33.3037L39.3145 53.6045C39.6345 54.4468 40.877 54.2162 40.877 53.3145V41.6836H52.665C53.5605 41.6836 53.7908 40.4368 52.9551 40.1133L32.6445 32.2549Z'
    const svg = '<svg width="82" height="82" viewBox="0 0.726562 82 82" fill="none" xmlns="http://www.w3.org/2000/svg">'
      + `<path d="${path}" fill="${fill}"/></svg>`
    return `data:image/svg+xml,${encodeURIComponent(svg)}`
  },
}

/** baseURL → 图标名；认不出返回空串（调用方据此不渲染图）。 */
export function providerIconName(baseURL: string | undefined | null): string {
  const raw = typeof baseURL === 'string' ? baseURL.trim() : ''
  if (!raw) return ''
  let host = ''
  try {
    host = new URL(raw).hostname.toLowerCase()
  } catch {
    return ''
  }
  return HOST_TO_ICON[host] ?? ''
}

/** 图标名 + 主题 → 完整图片地址；图标名为空返回空串。 */
export function providerLogoUrl(icon: string | undefined | null, theme: ProviderTheme = 'light'): string {
  if (!icon) return ''
  const inline = INLINE_LOGOS[icon]
  if (inline) return inline(theme)
  // 彩色图标只用 dark/ 目录；单色图标按主题切换
  const folder = icon.endsWith('-color') ? 'dark' : theme
  return `${LOGO_CDN}/${folder}/${icon}.png`
}

/** 一步到位：baseURL + 主题 → 图片地址（认不出返回空串）。 */
export function providerLogoUrlForBaseURL(baseURL: string | undefined | null, theme: ProviderTheme = 'light'): string {
  return providerLogoUrl(providerIconName(baseURL), theme)
}
