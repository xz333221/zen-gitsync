// fetch mock helper。字符串 substring 匹配;RegExp 全匹配。
import { vi } from 'vitest'

export function mockFetchResponse(url: string | RegExp, body: any, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    const u = typeof input === 'string' ? input : input.url
    const match = typeof url === 'string' ? u.includes(url) : url.test(u)
    return new Response(JSON.stringify(match ? body : {}), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  })
}

export function resetFetch() {
  vi.restoreAllMocks()
}
