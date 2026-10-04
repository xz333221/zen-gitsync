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
// 回归测试:共享遮罩组件的可见性与 {name} 插值。
// 该组件同时被 InstanceSwitcher(关闭当前实例)与 App.vue(服务端退出)使用，
// class 名是与既有 InstanceSwitcher 用例(ISSW-13/14 查 document)的契约。
import { afterEach, describe, expect, test, vi } from 'vitest'

// 组件的 $t 是静态 import(不是注入的全局 $t)，只能 mock 模块本身。
// 这里把 params 一起渲染出来，才能验证 name 被透传。
vi.mock('@/lang/static', () => ({
  $t: (k: string, params?: Record<string, unknown>) =>
    params ? `${k} ${Object.values(params).join(',')}` : k,
}))

import { mountWithSetup } from '@/test-utils/mount'
import ServerClosedOverlay from './ServerClosedOverlay.vue'

describe('ServerClosedOverlay.vue', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  // mountWithSetup 默认把 Teleport stub 成内联渲染，所以这里查 wrapper 而不是 document。
  test('visible=false 时不渲染遮罩', () => {
    const wrapper = mountWithSetup(ServerClosedOverlay, { props: { visible: false } })
    expect(wrapper.find('.self-closed-overlay').exists()).toBe(false)
  })

  test('visible=true 时渲染遮罩，并透出 name 插值', () => {
    const wrapper = mountWithSetup(ServerClosedOverlay, {
      props: { visible: true, name: 'zen-gitsync' },
    })

    const overlay = wrapper.find('.self-closed-overlay')
    expect(overlay.exists()).toBe(true)
    expect(overlay.attributes('role')).toBe('alert')
    expect(wrapper.find('.self-closed-card').exists()).toBe(true)
    expect(wrapper.find('.self-closed-title').exists()).toBe(true)
    // mountWithSetup 把 $t mock 成回显 key，params 会成为占位符名渲染出来 —— 用于确认
    // 组件确实把 name 传给了 $t(精确文案由 zh/en 语言文件负责)。
    expect(wrapper.find('.self-closed-desc').text()).toContain('zen-gitsync')
    expect(wrapper.find('.self-closed-hint').exists()).toBe(true)
  })
})
