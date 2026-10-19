<script setup>
/** 把文本里的 `代码` 片段渲染成 <code>。只做反引号切分,不走 v-html。 */
const props = defineProps({ text: { type: String, default: '' } })

const parts = props.text.split('`').map((seg, i) => ({ seg, code: i % 2 === 1 }))
</script>

<template>
  <span>
    <template v-for="(p, i) in parts" :key="i">
      <code v-if="p.code" class="mono">{{ p.seg }}</code>
      <template v-else>{{ p.seg }}</template>
    </template>
  </span>
</template>
