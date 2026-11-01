// 运行角色（project | hub），来自服务端启动参数 `g ui --role=hub`。
//
// 为什么走接口而不是构建期常量：同一个前端产物要同时服务两种角色 —— 项目窗口
// （7 个板块）和跨机器常驻的 hub（只有公共 4 个板块）。构建两套产物会让
// 发版、缓存、探针全部翻倍，而这一个字段的成本只有一次 fetch。
//
// 默认值故意是 'project'：接口还没回来时先按全量渲染，避免 hub 启动瞬间闪一下
// 再收窄（也和"不知道就当项目窗口"的向后兼容口径一致）。

import { ref } from 'vue'

export type AppRole = 'project' | 'hub' | 'full'

const role = ref<AppRole>('project')
let requested = false

/**
 * 取运行角色（全局只请求一次，多个组件共用同一个 ref）。
 * @returns {{ role: import('vue').Ref<AppRole> }}
 */
export function useAppRole() {
  if (!requested) {
    requested = true
    fetch('/api/app-role')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.role === 'hub' || data?.role === 'full') role.value = data.role
      })
      .catch(() => {
        // 老版本服务端没有这个端点 / 网络抖动：按 project 处理
      })
  }
  return { role }
}

/** 仅供测试/探针：重置已请求标记并直接设定角色。 */
export function __setAppRoleForTest(next: AppRole) {
  role.value = next
  requested = true
}
