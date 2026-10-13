// 图标加载失败的记忆（项目 favicon）。
//
// 两处画项目图标的地方共用（左栏项目列表 / 常用目录卡片）：图标加载失败要记一笔，
// 否则每次重渲染都会再发一次注定失败的请求，界面上还一直挂着个破图 ——
// 而"退回文件夹图标"才是这两处约定的兜底形态。
//
// **按地址记，不按项目路径记**：地址里带着服务端的图标 mtime，项目换了图标地址就跟着变，
// 新地址会自动重试一次；按路径记的话，用户换完图标得重启界面才能看见。

import { ref } from 'vue'

export function useIconFallback() {
  const failedUrls = ref<Set<string>>(new Set())

  /** 这个地址是不是已经确认加载不出来了（空地址不算"坏"，那是"没有图标"） */
  function isIconBroken(url?: string | null): boolean {
    return !!url && failedUrls.value.has(url)
  }

  function markIconFailed(url?: string | null) {
    if (!url || failedUrls.value.has(url)) return
    const next = new Set(failedUrls.value)
    next.add(url)
    // 换一个新 Set 才会触发依赖它的模板重渲染（Set 的原地 add 不是响应式的）
    failedUrls.value = next
  }

  return { failedUrls, isIconBroken, markIconFailed }
}
