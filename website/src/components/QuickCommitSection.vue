<script setup>
import { PhTerminal } from '@phosphor-icons/vue'
import TerminalTyping from './TerminalTyping.vue'

const cmds = [
  { text: 'g', note: '看一眼 git 状态和 diff,填提交信息回车' },
  { text: 'g ui', note: '在浏览器里打开图形界面' },
  { text: 'g ai', note: '在终端里跟内置智能体说话' }
]
</script>

<template>
  <section id="quick" class="section">
    <div class="shell split">
      <div class="split__copy">
        <h2 class="h2" v-reveal>最初只是不想再敲三遍命令</h2>
        <p class="lede split__body" v-reveal="80">
          add、commit、push 三步走太啰嗦。全局装好之后，在任意仓库敲一个 g:终端列出改动和 diff,
          你写一句提交信息，提交与推送就完成了。
        </p>
        <p class="body-2 split__note" v-reveal="140">
          提交信息可以交给 AI 从 diff 里生成，也可以套用你保存的提交模板。
        </p>
      </div>

      <div class="split__visual" v-reveal="130">
        <TerminalTyping :lines="cmds" />
        <p class="term-cap">
          <PhTerminal :size="15" weight="bold" />
          <span>三个入口，同一个工具</span>
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.split {
  display: grid;
  grid-template-columns: minmax(0, 0.95fr) minmax(0, 1.15fr);
  gap: clamp(30px, 4.6vw, 72px);
  align-items: center;
}

.split__copy {
  display: grid;
  gap: 16px;
  align-content: center;
}

.split__body {
  max-width: 46ch;
}

.split__note {
  max-width: 44ch;
}

.term-cap {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 12px;
  color: var(--text-3);
  font-size: 0.8125rem;
}

@media (max-width: 900px) {
  .split {
    grid-template-columns: minmax(0, 1fr);
    gap: 30px;
  }
}
</style>
