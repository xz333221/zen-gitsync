<script setup>
import { PhGithubLogo } from '@phosphor-icons/vue'
import { asset, REPO } from '../data/site.js'

// page: 'home' = 落地页(锚点导航 + 文档入口);'docs' = 文档页(回首页)
defineProps({
  page: { type: String, default: 'home' }
})
</script>

<template>
  <header class="nav">
    <div class="shell nav__inner">
      <a class="brand" :href="page === 'docs' ? 'index.html' : '#top'">
        <img class="brand__mark" :src="asset('logo.svg')" alt="" width="26" height="26" />
        <span class="brand__name">zen-gitsync</span>
      </a>

      <nav class="nav__links" aria-label="页面导航">
        <template v-if="page === 'docs'">
          <a href="index.html">返回首页</a>
        </template>
        <template v-else>
          <a href="#quick">一键提交</a>
          <a href="#workbench">工作台</a>
          <a href="#agent">智能体</a>
          <a href="#install">安装</a>
          <a href="./docs.html">文档</a>
        </template>
      </nav>

      <div class="nav__actions">
        <a class="btn btn--primary btn--sm" :href="REPO.github" target="_blank" rel="noreferrer">
          <PhGithubLogo :size="17" weight="fill" />
          <span>GitHub</span>
        </a>
      </div>
    </div>
  </header>
</template>

<style scoped>
.nav {
  position: sticky;
  top: 0;
  z-index: 20;
  background: rgba(10, 12, 16, 0.78);
  backdrop-filter: blur(14px) saturate(140%);
  border-bottom: 1px solid var(--line);
}

.nav__inner {
  display: flex;
  align-items: center;
  gap: 24px;
  height: 62px;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin-right: auto;
}

.brand__mark {
  border-radius: 7px;
}

.brand__name {
  font-weight: 700;
  letter-spacing: -0.02em;
  font-size: 0.9375rem;
}

.nav__links {
  display: flex;
  align-items: center;
  gap: 4px;
}

.nav__links a {
  padding: 7px 12px;
  border-radius: var(--r-1);
  font-size: 0.875rem;
  color: var(--text-2);
  transition:
    color var(--dur-1) var(--ease-out),
    background-color var(--dur-1) var(--ease-out);
}

.nav__links a:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.05);
}

@media (max-width: 820px) {
  .nav__links {
    display: none;
  }
}
</style>
