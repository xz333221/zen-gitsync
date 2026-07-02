// 测试用 Pinia 工厂。每个测试在 mount 前调用一次。
import { createPinia, setActivePinia } from 'pinia'

export function createTestPinia() {
  const pinia = createPinia()
  setActivePinia(pinia)
  return pinia
}
