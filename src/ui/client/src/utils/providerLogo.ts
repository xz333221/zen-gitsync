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
  'ark.cn-beijing.volces.com': 'volcengine-color',
  'localhost': 'ollama',
  '127.0.0.1': 'ollama',
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
  // 彩色图标只用 dark/ 目录；单色图标按主题切换
  const folder = icon.endsWith('-color') ? 'dark' : theme
  return `${LOGO_CDN}/${folder}/${icon}.png`
}

/** 一步到位：baseURL + 主题 → 图片地址（认不出返回空串）。 */
export function providerLogoUrlForBaseURL(baseURL: string | undefined | null, theme: ProviderTheme = 'light'): string {
  return providerLogoUrl(providerIconName(baseURL), theme)
}
