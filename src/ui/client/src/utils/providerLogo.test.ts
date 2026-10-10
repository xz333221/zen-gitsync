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
import { describe, test, expect } from 'vitest'

import { providerIconName, providerLogoUrl, providerLogoUrlForBaseURL } from './providerLogo'

describe('providerIconName', () => {
  test('按域名认服务商，与 ai-model-form 表单里的名单一致', () => {
    expect(providerIconName('https://api.commandcode.ai/provider/v1')).toBe('commandcode')
    expect(providerIconName('https://ark.cn-beijing.volces.com/api/coding/v3')).toBe('volcengine-color')
    expect(providerIconName('https://api.deepseek.com/v1')).toBe('deepseek-color')
    expect(providerIconName('https://api.minimaxi.com/v1')).toBe('minimax-color')
    expect(providerIconName('http://localhost:11434/v1')).toBe('ollama')
  })

  test('同一域名下的不同路径都认（火山两套套餐）', () => {
    expect(providerIconName('https://ark.cn-beijing.volces.com/api/plan/v3')).toBe('volcengine-color')
    expect(providerIconName('https://ark.cn-beijing.volces.com/api/v3')).toBe('volcengine-color')
  })

  test('尾斜杠 / 大小写不影响；认不出的返回空串', () => {
    expect(providerIconName('https://API.DeepSeek.com/v1/')).toBe('deepseek-color')
    expect(providerIconName('https://example.com/v1')).toBe('')
    expect(providerIconName('not a url')).toBe('')
    expect(providerIconName('')).toBe('')
    expect(providerIconName(undefined)).toBe('')
  })
})

describe('providerLogoUrl', () => {
  test('彩色图标固定用 dark/ 目录，不随主题变', () => {
    const dark = providerLogoUrl('volcengine-color', 'dark')
    const light = providerLogoUrl('volcengine-color', 'light')
    expect(dark).toBe(light)
    expect(dark).toContain('/dark/volcengine-color.png')
  })

  test('单色图标按主题切换目录', () => {
    expect(providerLogoUrl('openai', 'light')).toContain('/light/openai.png')
    expect(providerLogoUrl('openai', 'dark')).toContain('/dark/openai.png')
  })

  test('图标名为空返回空串', () => {
    expect(providerLogoUrl('', 'dark')).toBe('')
    expect(providerLogoUrl(undefined, 'dark')).toBe('')
  })
})

describe('providerLogoUrlForBaseURL', () => {
  test('一步到位：baseURL + 主题 → 图片地址', () => {
    expect(providerLogoUrlForBaseURL('https://api.commandcode.ai/provider/v1', 'dark')).toContain(
      '/dark/commandcode.png'
    )
    expect(providerLogoUrlForBaseURL('https://example.com/v1', 'dark')).toBe('')
  })
})
