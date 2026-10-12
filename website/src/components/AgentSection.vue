<script setup>
import ShotFrame from './ShotFrame.vue'
import { SHOTS } from '../data/site.js'
</script>

<template>
  <section id="agent" class="section">
    <div class="shell">
      <div class="ag__head" v-reveal>
        <h2 class="h2">g ai:在你原来的地方顺手把活派出去</h2>
        <p class="lede">
          它同时活在终端和 g ui 里。连上 GitHub / Gitee 之后，它就知道你远端有哪些仓库，可以自己克隆下来、
          改完提交;也能装 Skill 和 MCP,派发执行器任务，或者登记定时任务到点自己跑。
        </p>
      </div>

      <div class="ag__shots">
        <div v-reveal="120">
          <ShotFrame
            :src="SHOTS.agentCli"
            alt="终端中的 g ai 智能体：会话分隔线上方是任务对话与工具调用，下方等待输入"
            caption="终端：g ai 就是一个 REPL"
          />
        </div>
        <div v-reveal="190">
          <ShotFrame
            :src="SHOTS.agentGui"
            alt="g ui 中的智能体对话面板：左侧为项目与文件，右侧为对话与指令输入框"
            caption="g ui:右侧常驻的对话与指令面板"
          />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ag__head {
  display: grid;
  gap: 14px;
  margin-bottom: 34px;
  max-width: 66ch;
}

.ag__shots {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
  gap: clamp(18px, 2.6vw, 34px);
  align-items: start;
}

@media (max-width: 900px) {
  .ag__shots {
    grid-template-columns: minmax(0, 1fr);
    gap: 24px;
  }
}
</style>
