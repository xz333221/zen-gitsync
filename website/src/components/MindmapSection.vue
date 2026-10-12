<script setup>
import { PhArrowUpRight } from '@phosphor-icons/vue'
import ShotFrame from './ShotFrame.vue'
import { SHOTS } from '../data/site.js'

const FLOW_MINDMAP = 'https://www.npmjs.com/package/flow-mindmap'
</script>

<template>
  <section id="mindmap" class="section section--alt">
    <div class="shell">
      <div class="mm__head" v-reveal>
        <h2 class="h2">思维导图：把想法摊开来看</h2>
        <p class="lede">
          用来梳理逻辑的板块，节点随手拖、随手折，边写边理。下面这张导图就是用它画的：
          zen-gitsync 自己的一份功能总览。底层的 flow-mindmap 是我开源的 npm 包。
        </p>
      </div>

      <div class="mm__shot" v-reveal="120">
        <ShotFrame
          bleed
          paper
          :src="SHOTS.mindmap"
          alt="思维导图板块里画出的 zen-gitsync 功能总览：根节点下有六个分支，分别是一键提交、图形界面、编程工作台、内置智能体、其它板块与安装"
          caption="这张导图就是用这个板块画的：zen-gitsync 功能总览"
        />
      </div>

      <a class="mm__link" :href="FLOW_MINDMAP" target="_blank" rel="noreferrer" v-reveal="180">
        <span>flow-mindmap</span>
        <PhArrowUpRight :size="15" weight="bold" />
      </a>
    </div>
  </section>
</template>

<style scoped>
.mm__head {
  display: grid;
  gap: 14px;
  margin-bottom: 34px;
  max-width: 62ch;
}

.mm__shot {
  margin-bottom: 22px;
}

.mm__link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--accent-soft);
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  border-bottom: 1px solid transparent;
  padding-bottom: 2px;
  transition: border-color var(--dur-1) var(--ease-out);
}

.mm__link:hover {
  border-bottom-color: var(--accent-soft);
}
</style>
