import { ref } from 'vue'

/**
 * 读取仓库真实 star 数(公开 GitHub API,无需 token)。
 * 离线 / 限流 / 接口异常时保持 null,页面就不渲染这个数字,
 * 不编造任何指标。
 */
export function useGithubStars(repo) {
  const stars = ref(null)

  async function load() {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}`, {
        headers: { Accept: 'application/vnd.github+json' }
      })
      if (!res.ok) return
      const data = await res.json()
      if (typeof data.stargazers_count === 'number') {
        stars.value = formatCount(data.stargazers_count)
      }
    } catch {
      /* 静默:没有数字比假数字好 */
    }
  }

  load()
  return { stars }
}

function formatCount(n) {
  if (n < 1000) return String(n)
  const k = n / 1000
  return `${k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`
}
