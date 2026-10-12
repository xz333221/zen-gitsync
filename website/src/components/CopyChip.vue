<script setup>
import { ref, onUnmounted } from 'vue'
import { PhCopy, PhCheck, PhWarningCircle } from '@phosphor-icons/vue'

const props = defineProps({
  command: { type: String, required: true },
  note: { type: String, default: '' },
  wide: { type: Boolean, default: false }
})

const state = ref('idle')
let timer = null

async function copy() {
  try {
    await navigator.clipboard.writeText(props.command)
    state.value = 'done'
  } catch {
    state.value = 'failed'
  }
  clearTimeout(timer)
  timer = setTimeout(() => (state.value = 'idle'), 2000)
}

onUnmounted(() => clearTimeout(timer))
</script>

<template>
  <div class="chip" :class="{ 'chip--wide': wide }">
    <code class="chip__cmd">
      <span class="chip__sigil" aria-hidden="true">$</span>{{ command }}
    </code>
    <button
      class="chip__btn"
      type="button"
      :aria-label="state === 'done' ? '已复制' : `复制命令 ${command}`"
      @click="copy"
    >
      <PhCheck v-if="state === 'done'" :size="16" weight="bold" />
      <PhWarningCircle v-else-if="state === 'failed'" :size="16" weight="bold" />
      <PhCopy v-else :size="16" weight="bold" />
      <span class="chip__btn-label">{{
        state === 'done' ? '已复制' : state === 'failed' ? '请手动选中' : ''
      }}</span>
    </button>
    <p v-if="note" class="chip__note">{{ note }}</p>
  </div>
</template>

<style scoped>
.chip {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px 12px;
  padding: 10px 10px 10px 14px;
  border: 1px solid var(--line-2);
  border-radius: var(--r-1);
  background: var(--code-bg);
}

.chip__cmd {
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  color: var(--text);
  white-space: nowrap;
  overflow-x: auto;
  scrollbar-width: none;
}

.chip__cmd::-webkit-scrollbar {
  display: none;
}

.chip__sigil {
  color: var(--text-3);
  margin-right: 8px;
}

.chip__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: var(--r-1);
  border: 1px solid var(--line);
  color: var(--text-2);
  transition:
    color var(--dur-1) var(--ease-out),
    border-color var(--dur-1) var(--ease-out),
    background-color var(--dur-1) var(--ease-out);
}

.chip__btn:hover {
  color: var(--text);
  border-color: var(--line-3);
  background: rgba(255, 255, 255, 0.04);
}

.chip__btn-label {
  font-size: 0.75rem;
  white-space: nowrap;
}

.chip__note {
  grid-column: 1 / -1;
  color: var(--text-3);
  font-size: 0.8125rem;
  line-height: 1.5;
}
</style>
