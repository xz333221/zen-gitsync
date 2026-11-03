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
// 派发预设提示词弹窗的草稿同步。
//
// 守的是 2026-11-02 那次真实丢数据：弹窗在编排状态到货**之前**被打开时，
// 草稿先按空串建出来；等 `defaultPrompt` / `projectPrompt` 送到 props，
// 草稿没跟着变 —— `dirty` 变 true、保存按钮亮着、两个框却是空的，点一下保存
// 就把磁盘上写好的两级提示词一起覆盖成空串。
// 所以这里断言的不是"能编辑"，而是"props 晚到必须补进草稿，用户改过的不能被覆盖"。

import { describe, it, expect } from 'vitest'
import { nextTick } from 'vue'
import { mountWithSetup } from '@/test-utils/mount'
import WorkbenchDefaultPromptDialog from './WorkbenchDefaultPromptDialog.vue'

async function mountDialog(over: Record<string, any> = {}) {
  const wrapper = mountWithSetup(WorkbenchDefaultPromptDialog, {
    props: {
      modelValue: true,
      defaultPrompt: '',
      projectPath: 'd:\\ws\\alpha',
      projectName: 'alpha',
      projectPrompt: '',
      saving: false,
      ...over,
    },
    attachTo: document.body,
  })
  // el-dialog 的 body 是打开后才挂上的，第一帧读不到 #pd-*
  await nextTick()
  return wrapper
}

const valueOf = (w: any, sel: string) => (w.find(sel).element as HTMLTextAreaElement).value

describe('WorkbenchDefaultPromptDialog 草稿同步', () => {
  it('弹窗打开后 props 才到货：两栏都要补上服务端值，不能留空', async () => {
    const wrapper = await mountDialog()
    expect(valueOf(wrapper, '#pd-global')).toBe('')

    await wrapper.setProps({ defaultPrompt: '全局规矩', projectPrompt: '本项目用 pnpm' })
    await nextTick()

    expect(valueOf(wrapper, '#pd-global')).toBe('全局规矩')
    expect(valueOf(wrapper, '#pd-project')).toBe('本项目用 pnpm')
  })

  it('props 晚到后不再"空草稿也能保存"；真改了，提交里仍带着服务端那一份', async () => {
    const wrapper = await mountDialog()
    await wrapper.setProps({ defaultPrompt: '全局规矩', projectPrompt: '本项目用 pnpm' })
    await nextTick()

    // 关键：草稿已经跟服务端对齐 → 没有可保存的改动，那个"把两级写成空串"的入口就关着
    const btn = wrapper.find('.pd__btn--primary')
    expect(btn.attributes('disabled')).toBeDefined()

    await wrapper.find('#pd-global').setValue('全局规矩 + 补一句')
    await btn.trigger('click')

    expect(wrapper.emitted('save')?.[0]?.[0]).toEqual({
      globalPrompt: '全局规矩 + 补一句',
      projectPrompt: '本项目用 pnpm',
    })
  })

  it('用户已经改过的那一栏不被 props 覆盖，没改过的那栏照常跟随', async () => {
    const wrapper = await mountDialog({ defaultPrompt: '旧全局', projectPrompt: '旧项目' })
    await nextTick()

    await wrapper.find('#pd-project').setValue('用户正在改的项目提示词')
    await wrapper.setProps({ defaultPrompt: '服务端新全局', projectPrompt: '服务端新项目' })
    await nextTick()

    expect(valueOf(wrapper, '#pd-global')).toBe('服务端新全局')
    expect(valueOf(wrapper, '#pd-project')).toBe('用户正在改的项目提示词')
  })

  it('关掉再打开：草稿回到服务端值（半途改了一半不留存）', async () => {
    const wrapper = await mountDialog({ defaultPrompt: '全局规矩' })
    await nextTick()
    await wrapper.find('#pd-global').setValue('改了一半就关掉')

    await wrapper.setProps({ modelValue: false })
    await wrapper.setProps({ modelValue: true })
    await nextTick()

    expect(valueOf(wrapper, '#pd-global')).toBe('全局规矩')
  })
})
