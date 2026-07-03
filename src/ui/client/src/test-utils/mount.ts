// mount 包装:自动装 Pinia + 默认 stubs + $t mock。
// ElTable / el-table-column 必须 stub——LogList 通过 querySelector('.el-table__body-wrapper')
// 取虚拟滚动容器,jsdom 没有真实布局,stub 后透传 slot。
import { mount, type MountingOptions, type VueWrapper } from '@vue/test-utils'
import { createTestPinia } from './createTestPinia'

export function mountWithSetup<T extends Parameters<typeof mount>[0]>(
  component: T,
  options: MountingOptions<any> = {}
): VueWrapper<any> {
  createTestPinia()
  const { global: passedGlobal, ...rest } = options
  // vue-test-utils 2.4 在 generic Component 下 GlobalMountOptions 与
  // MountingOptions<any> 的 slots 类型不再互通(TS2345),所以构造后整体 cast 一次。
  return mount(component, {
    global: {
      stubs: {
        'el-table': { template: '<div class="el-table"><slot /></div>' },
        'el-table-column': { template: '<div><slot /></div>' },
        Teleport: true,
        ...passedGlobal?.stubs,
      },
      mocks: {
        $t: (k: string) => k,
        ...passedGlobal?.mocks,
      },
      ...passedGlobal,
    },
    ...rest,
  } as any)
}
