<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { prefersReducedMotion } from '../composables/useReveal.js'

/**
 * 逐字打出真实命令的终端演示。
 * 只显示工具真实存在的命令(来自 package.json / README),不伪造任何输出。
 */
const props = defineProps({
  lines: { type: Array, required: true } // [{ text: 'g', note: '一键提交' }]
})

const done = ref([])
const partial = ref('')
const finished = ref(false)
let timer = null

function play(li, ci) {
  if (li >= props.lines.length) {
    finished.value = true
    return
  }
  const line = props.lines[li]
  if (ci > line.text.length) {
    done.value = [...done.value, line]
    partial.value = ''
    timer = setTimeout(() => play(li + 1, 0), 260)
    return
  }
  partial.value = line.text.slice(0, ci)
  const ch = line.text[ci - 1]
  const delay = ch === ' ' ? 26 : 52
  timer = setTimeout(() => play(li, ci + 1), delay)
}

onMounted(() => {
  if (prefersReducedMotion()) {
    done.value = [...props.lines]
    finished.value = true
    return
  }
  timer = setTimeout(() => play(0, 0), 420)
})

onUnmounted(() => clearTimeout(timer))
</script>

<template>
  <div class="term" role="img" :aria-label="lines.map((l) => l.text).join(' | ')">
    <div class="term__row" v-for="line in done" :key="line.text">
      <code class="term__cmd"><span class="term__sigil">$</span>{{ line.text }}</code>
      <span v-if="line.note" class="term__note">{{ line.note }}</span>
    </div>
    <div class="term__row" v-if="!finished">
      <code class="term__cmd"><span class="term__sigil">$</span>{{ partial }}</code>
      <span class="term__caret" aria-hidden="true"></span>
    </div>
  </div>
</template>

<style scoped>
.term {
  display: grid;
  gap: 10px;
  padding: 20px;
  border: 1px solid var(--line-2);
  border-radius: var(--r-2);
  background: var(--code-bg);
  box-shadow: var(--shadow-1);
  min-height: 168px;
  align-content: start;
}

.term__row {
  display: flex;
  align-items: baseline;
  gap: 14px;
  flex-wrap: wrap;
}

.term__cmd {
  font-family: var(--font-mono);
  font-size: 0.875rem;
  color: var(--text);
}

.term__sigil {
  color: var(--accent-soft);
  margin-right: 8px;
}

.term__note {
  font-size: 0.8125rem;
  color: var(--text-3);
}

.term__caret {
  width: 8px;
  height: 16px;
  background: var(--accent-soft);
  animation: term-blink 1.05s steps(2, start) infinite;
}

@keyframes term-blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0;
  }
}
</style>
