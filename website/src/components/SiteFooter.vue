<script setup>
import { PhGithubLogo } from '@phosphor-icons/vue'
import { asset, REPO } from '../data/site.js'

// 构建时由 vite define 注入，与主包 package.json 的版本保持同步
const APP_VERSION = typeof __APP_VERSION__ === 'undefined' ? 'dev' : __APP_VERSION__
</script>

<template>
  <footer class="foot">
    <div class="shell foot__inner">
      <div class="foot__brand">
        <img :src="asset('logo.svg')" alt="" width="24" height="24" />
        <span class="foot__name">zen-gitsync</span>
      </div>

      <nav class="foot__links" aria-label="外部链接">
        <a :href="REPO.github" target="_blank" rel="noreferrer">
          <PhGithubLogo :size="16" weight="fill" />
          <span>GitHub</span>
        </a>
        <a :href="REPO.npm" target="_blank" rel="noreferrer"><span>npm</span></a>
        <a :href="REPO.issues" target="_blank" rel="noreferrer"><span>问题反馈</span></a>
      </nav>
    </div>

    <div class="shell foot__meta">
      <span>v{{ APP_VERSION }}</span>
      <span>Apache-2.0</span>
    </div>
  </footer>
</template>

<style scoped>
.foot {
  border-top: 1px solid var(--line);
  background: var(--bg-alt);
  padding-block: 40px 28px;
}

.foot__inner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 18px 28px;
}

.foot__brand {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  margin-right: auto;
}

.foot__name {
  font-weight: 700;
  letter-spacing: -0.02em;
  font-size: 0.9rem;
}

.foot__links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
}

.foot__links a {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--text-2);
  font-size: 0.875rem;
  transition: color var(--dur-1) var(--ease-out);
}

.foot__links a:hover {
  color: var(--text);
}

.foot__meta {
  display: flex;
  gap: 16px;
  margin-top: 26px;
  color: var(--text-3);
  font-family: var(--font-mono);
  font-size: 0.75rem;
}
</style>
