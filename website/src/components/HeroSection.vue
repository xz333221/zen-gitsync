<script setup>
import { PhGithubLogo, PhStar } from '@phosphor-icons/vue'
import ShotFrame from './ShotFrame.vue'
import CopyChip from './CopyChip.vue'
import { COMMANDS, REPO, SHOTS } from '../data/site.js'
import { useGithubStars } from '../composables/useGithubStars.js'

const { stars } = useGithubStars(REPO.slug)
</script>

<template>
  <section id="top" class="hero">
    <div class="shell hero__inner" style="--shell: 1400px">
      <div class="hero__copy">
        <h1 class="h1" v-reveal>
          <span class="h1__line">敲一个 <code class="h1__cmd">g</code>,</span
          ><span class="h1__line">剩下的交给工作台</span>
        </h1>
        <p class="lede" v-reveal="90">
          从终端的一键提交开始，长成 Git 总览界面、多项目并行的工作台，以及一个能替你派活的内置智能体。
        </p>
        <div class="hero__cta" v-reveal="170">
          <CopyChip :command="COMMANDS.install" />
          <a class="btn btn--ghost" :href="REPO.github" target="_blank" rel="noreferrer">
            <PhGithubLogo :size="18" weight="fill" />
            <span>在 GitHub 上看源码</span>
            <span class="hero__stars" aria-label="GitHub star 数">
              <PhStar :size="13" weight="fill" />
              <span class="hero__stars-num">{{ stars ?? '' }}</span>
            </span>
          </a>
        </div>
      </div>

      <div class="hero__visual" v-reveal="240">
        <ShotFrame
          eager
          :src="SHOTS.commit"
          alt="终端中输入 g 后展示 Git 状态、diff,填入提交信息回车即完成提交与推送"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.h1__line {
  display: block;
}

.h1__cmd {
  font-family: var(--font-mono);
  font-size: 0.92em;
  font-weight: 500;
  letter-spacing: -0.02em;
}

.hero__inner {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.24fr);
  gap: clamp(32px, 4.5vw, 68px);
  align-items: center;
  padding-block: clamp(52px, 6.5vw, 92px);
}

.hero__copy {
  display: grid;
  gap: 20px;
  justify-items: start;
}

.hero__cta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  margin-top: 6px;
}

.hero__stars {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding-left: 9px;
  margin-left: 2px;
  border-left: 1px solid var(--line-2);
  color: var(--text-2);
  font-family: var(--font-mono);
  font-size: 0.78rem;
}

.hero__stars-num {
  display: inline-block;
  min-width: 3.2ch;
}

@media (max-width: 940px) {
  .hero__inner {
    grid-template-columns: minmax(0, 1fr);
    gap: 36px;
  }
}
</style>
