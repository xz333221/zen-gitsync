// mount 包装:自动装 Pinia + 默认 stubs + $t mock。
// ElTable / el-table-column 必须 stub——LogList 通过 querySelector('.el-table__body-wrapper')
// 取虚拟滚动容器,jsdom 没有真实布局,stub 后透传 slot。
import { mount, type MountingOptions } from '@vue/test-utils'
import type { Component } from 'vue'
import { createTestPinia } from './createTestPinia'

export function mountWithSetup<T extends Component>(
  component: T,
  options: MountingOptions<any> = {}
) {
  createTestPinia()
  return mount(component, {
    global: {
      stubs: {
        'el-table': { template: '<div class="el-table"><slot /></div>' },
        'el-table-column': { template: '<div><slot /></div>' },
        Teleport: true,
        ...options.global?.stubs,
      },
      mocks: {
        $t: (k: string) => k,
        ...options.global?.mocks,
      },
      ...options.global,
    },
    ...options,
  })
}
