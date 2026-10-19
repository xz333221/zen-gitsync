import { onBeforeUnmount, onMounted, ref } from 'vue'

/** 侧栏高亮:哪个 section 进了视口上沿一带,就点亮哪条。 */
export function useScrollSpy(ids) {
  const activeId = ref(ids[0] ?? '')
  let observer = null

  onMounted(() => {
    const els = ids.map((id) => document.getElementById(id)).filter(Boolean)
    if (!els.length || typeof IntersectionObserver === 'undefined') return
    observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible.length) activeId.value = visible[0].target.id
      },
      { rootMargin: '-84px 0px -65% 0px', threshold: 0 }
    )
    els.forEach((el) => observer.observe(el))
  })

  onBeforeUnmount(() => observer && observer.disconnect())
  return activeId
}
