<script setup>
import CopyChip from './CopyChip.vue'
import { COMMANDS } from '../data/site.js'

const rows = [
  { cmd: COMMANDS.install, note: '全局安装，Node.js 20.19 及以上' },
  { cmd: COMMANDS.commit, note: '在任意 Git 仓库里提交并推送' },
  { cmd: COMMANDS.gui, note: '打开浏览器里的图形界面' },
  { cmd: COMMANDS.agent, note: '终端里直接和 g ai 对话' }
]
</script>

<template>
  <section id="install" class="section">
    <div class="shell">
      <div class="ins__head" v-reveal>
        <h2 class="h2">装完就能用</h2>
        <p class="lede">一条安装命令，四个入口。Windows、macOS、Linux 都一样。</p>
      </div>

      <ul class="ins__list">
        <li v-for="(row, i) in rows" :key="row.cmd" v-reveal="80 + i * 60">
          <CopyChip :command="row.cmd" :note="row.note" wide />
        </li>
      </ul>

      <p class="ins__meta" v-reveal="320">
        Apache-2.0 许可 · 源码在
        <a href="https://github.com/xz333221/zen-gitsync" target="_blank" rel="noreferrer"
          >github.com/xz333221/zen-gitsync</a
        >
      </p>
    </div>
  </section>
</template>

<style scoped>
.ins__head {
  display: grid;
  gap: 14px;
  margin-bottom: 32px;
  max-width: 58ch;
}

.ins__list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.ins__meta {
  margin-top: 26px;
  color: var(--text-3);
  font-size: 0.8125rem;
}

.ins__meta a {
  color: var(--text-2);
  border-bottom: 1px solid var(--line-2);
}

.ins__meta a:hover {
  color: var(--text);
  border-bottom-color: var(--line-3);
}

@media (max-width: 760px) {
  .ins__list {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
