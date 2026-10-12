<script setup>
import ShotFrame from './ShotFrame.vue'
import { EXECUTORS, SHOTS } from '../data/site.js'
</script>

<template>
  <section id="workbench" class="section section--alt">
    <div class="shell">
      <div class="wb__head" v-reveal>
        <h2 class="h2">现在主要用它做多项目编排</h2>
        <p class="lede">
          工作台把你所有的项目排成一列，每个项目带着分支、未提交改动和任务进度。一条任务一个独立进程，
          输出实时回落到卡片上，你可以同时盯几个仓库的进展。
        </p>
      </div>

      <div class="wb__shot" v-reveal="120">
        <ShotFrame
          bleed
          :src="SHOTS.workbench"
          alt="工作台界面：左侧项目列表，中间待处理、进行中、已完成三列任务看板，右侧主 Agent 控制台"
          caption="编程工作台：左项目列表、中任务看板、右主智能体控制台"
        />
      </div>

      <div class="wb__exec" v-reveal="180">
        <p class="wb__exec-label">任务可以派给</p>
        <ul class="wb__exec-list">
          <li v-for="name in EXECUTORS" :key="name" class="wb__chip">{{ name }}</li>
        </ul>
        <p class="wb__exec-note body-2">
          手动挑一个执行器，或者直接在主智能体控制台里说一句要做什么，它替你派、替你盯。
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.wb__head {
  display: grid;
  gap: 14px;
  margin-bottom: 34px;
}

.wb__shot {
  margin-bottom: 30px;
}

.wb__exec {
  display: grid;
  gap: 12px;
  justify-items: start;
}

.wb__exec-label {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--text-3);
}

.wb__exec-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.wb__chip {
  padding: 7px 14px;
  border: 1px solid var(--line-2);
  border-radius: var(--r-pill);
  background: rgba(255, 255, 255, 0.03);
  font-size: 0.875rem;
  font-weight: 600;
}

.wb__exec-note {
  max-width: 60ch;
}

@media (max-width: 900px) {
  .wb__head {
    margin-bottom: 26px;
  }
}
</style>
