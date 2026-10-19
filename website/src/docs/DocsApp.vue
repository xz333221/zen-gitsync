<script setup>
import SiteHeader from '../components/SiteHeader.vue'
import SiteFooter from '../components/SiteFooter.vue'
import CopyChip from '../components/CopyChip.vue'
import ShotFrame from '../components/ShotFrame.vue'
import InlineCode from './InlineCode.vue'
import { DOCS } from '../data/docs.js'
import { useScrollSpy } from '../composables/useScrollSpy.js'

const activeId = useScrollSpy(DOCS.map((m) => m.id))
</script>

<template>
  <SiteHeader page="docs" />

  <main class="docs">
    <div class="shell docs__inner">
      <aside class="docs__nav">
        <p class="docs__nav-title">文档目录</p>
        <nav class="docs__nav-list" aria-label="文档目录">
          <a
            v-for="m in DOCS"
            :key="m.id"
            :href="`#${m.id}`"
            :class="{ 'is-active': activeId === m.id }"
            >{{ m.title }}</a
          >
        </nav>
        <p class="docs__nav-foot">
          完整参考见
          <a :href="'https://github.com/xz333221/zen-gitsync#readme'" target="_blank" rel="noreferrer"
            >README</a
          >
        </p>
      </aside>

      <div class="docs__body">
        <header class="docs__head" v-reveal>
          <p class="eyebrow">DOCS</p>
          <h1 class="h1 docs__title">zen-gitsync 功能文档</h1>
          <p class="lede">
            按界面上的板块逐篇介绍:每个视图是干什么的、里面都有什么。
            装好之后敲 <code class="mono">g ui</code> 就能逐块对上手感。
          </p>
        </header>

        <section v-for="m in DOCS" :id="m.id" class="doc" :key="m.id">
          <h2 class="doc__title">{{ m.title }}</h2>
          <p v-if="m.lede" class="doc__lede">
            <InlineCode :text="m.lede" />
          </p>

          <div v-if="m.shots && m.shots.length" class="doc__shots">
            <ShotFrame
              v-for="s in m.shots"
              :key="s.src"
              :src="s.src"
              :alt="s.alt"
              :caption="s.caption"
              :paper="s.paper"
            />
          </div>

          <template v-for="(b, i) in m.blocks" :key="i">
            <p v-if="b.type === 'text'" class="doc__text">
              <InlineCode :text="b.text" />
            </p>

            <ul v-else-if="b.type === 'list'" class="doc__list">
              <li v-for="item in b.items" :key="item.term">
                <p class="doc__term">{{ item.term }}</p>
                <p class="doc__desc">
                  <InlineCode :text="item.desc" />
                </p>
              </li>
            </ul>

            <div v-else-if="b.type === 'cmds'" class="doc__cmds">
              <CopyChip v-for="row in b.rows" :key="row.cmd" :command="row.cmd" :note="row.note" wide />
            </div>

            <table v-else-if="b.type === 'table'" class="doc__table">
              <thead>
                <tr>
                  <th v-for="h in b.head" :key="h">{{ h }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, ri) in b.rows" :key="ri">
                  <td v-for="(cell, ci) in row" :key="ci">
                    <code v-if="ci === 0" class="mono">{{ cell }}</code>
                    <template v-else>{{ cell }}</template>
                  </td>
                </tr>
              </tbody>
            </table>

            <p v-else-if="b.type === 'note'" class="doc__note">
              <InlineCode :text="b.text" />
            </p>
          </template>
        </section>

        <footer class="docs__end">
          <p>文档与产品同版本迭代;发现对不上的地方,欢迎去 GitHub Issues 指出来。</p>
          <a class="btn btn--ghost btn--sm" href="index.html">回到首页</a>
        </footer>
      </div>
    </div>
  </main>

  <SiteFooter />
</template>

<style scoped>
.docs {
  padding-block: clamp(36px, 5vw, 64px);
}

.docs__inner {
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  gap: clamp(28px, 4vw, 56px);
  align-items: start;
}

/* --- 侧栏 --- */
.docs__nav {
  position: sticky;
  top: 86px;
  display: grid;
  gap: 14px;
}

.docs__nav-title {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-3);
}

.docs__nav-list {
  display: grid;
  gap: 2px;
  border-left: 1px solid var(--line);
}

.docs__nav-list a {
  position: relative;
  padding: 7px 12px;
  margin-left: -1px;
  border-left: 2px solid transparent;
  font-size: 0.875rem;
  color: var(--text-2);
  transition:
    color var(--dur-1) var(--ease-out),
    border-color var(--dur-1) var(--ease-out);
}

.docs__nav-list a:hover {
  color: var(--text);
}

.docs__nav-list a.is-active {
  color: var(--text);
  border-left-color: var(--accent);
}

.docs__nav-foot {
  font-size: 0.75rem;
  color: var(--text-3);
  line-height: 1.6;
}

.docs__nav-foot a {
  color: var(--text-2);
  border-bottom: 1px solid var(--line-2);
}

.docs__nav-foot a:hover {
  color: var(--text);
}

/* --- 正文 --- */
.docs__body {
  min-width: 0;
  max-width: 860px;
}

.docs__head {
  display: grid;
  gap: 14px;
  padding-bottom: 36px;
  border-bottom: 1px solid var(--line);
}

.docs__title {
  font-size: clamp(1.9rem, 3.6vw, 2.7rem);
}

.doc {
  padding-block: clamp(34px, 4.4vw, 56px);
  border-bottom: 1px solid var(--line);
  scroll-margin-top: 86px;
}

.doc:last-of-type {
  border-bottom: 0;
}

.doc__title {
  font-size: clamp(1.3rem, 2.2vw, 1.6rem);
  line-height: 1.25;
  letter-spacing: -0.02em;
  font-weight: 700;
  margin-bottom: 12px;
}

.doc__lede {
  color: var(--text-2);
  font-size: 0.9375rem;
  line-height: 1.75;
  max-width: var(--measure);
  margin-bottom: 22px;
}

.doc__shots {
  display: grid;
  gap: 18px;
  margin-bottom: 24px;
}

.doc__text {
  color: var(--text-2);
  font-size: 0.9375rem;
  line-height: 1.75;
  margin-bottom: 18px;
  max-width: var(--measure);
}

.doc__list {
  display: grid;
  gap: 0;
}

.doc__list li {
  display: grid;
  grid-template-columns: 148px minmax(0, 1fr);
  gap: 6px 18px;
  padding: 13px 0;
  border-top: 1px solid var(--line);
}

.doc__list li:first-child {
  border-top: 0;
}

.doc__term {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text);
  line-height: 1.55;
}

.doc__desc {
  font-size: 0.875rem;
  color: var(--text-2);
  line-height: 1.7;
}

.doc__desc code,
.doc__text code,
.doc__lede code,
.doc__note code {
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  color: var(--text);
}

.doc__cmds {
  display: grid;
  gap: 10px;
  margin-block: 4px;
}

.doc__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}

.doc__table th {
  text-align: left;
  font-size: 0.75rem;
  font-family: var(--font-mono);
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-3);
  font-weight: 500;
  padding: 8px 12px 8px 0;
  border-bottom: 1px solid var(--line-2);
}

.doc__table td {
  padding: 10px 12px 10px 0;
  border-bottom: 1px solid var(--line);
  color: var(--text-2);
  line-height: 1.6;
  vertical-align: top;
}

.doc__table td:first-child {
  white-space: nowrap;
  color: var(--text);
}

.doc__note {
  margin-top: 16px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-left: 2px solid var(--accent);
  border-radius: var(--r-1);
  background: var(--panel);
  color: var(--text-2);
  font-size: 0.8125rem;
  line-height: 1.7;
}

.docs__end {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-top: 28px;
}

.docs__end p {
  color: var(--text-3);
  font-size: 0.8125rem;
}

/* --- 窄屏:侧栏变成横向 chips --- */
@media (max-width: 900px) {
  .docs__inner {
    grid-template-columns: minmax(0, 1fr);
  }

  .docs__nav {
    position: sticky;
    top: 78px;
    z-index: 10;
    margin: 0 calc(-1 * var(--pad-x));
    padding: 10px var(--pad-x);
    background: rgba(10, 12, 16, 0.9);
    backdrop-filter: blur(14px);
    border-bottom: 1px solid var(--line);
  }

  .docs__nav-title,
  .docs__nav-foot {
    display: none;
  }

  .docs__nav-list {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    border-left: 0;
    scrollbar-width: none;
  }

  .docs__nav-list::-webkit-scrollbar {
    display: none;
  }

  .docs__nav-list a {
    flex: 0 0 auto;
    margin-left: 0;
    padding: 6px 12px;
    border-left: 0;
    border: 1px solid var(--line-2);
    border-radius: var(--r-pill);
    white-space: nowrap;
  }

  .docs__nav-list a.is-active {
    border-left: 0;
    border-color: var(--accent);
    color: var(--accent-soft);
    background: var(--accent-tint);
  }
}

@media (max-width: 640px) {
  .doc__list li {
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
  }
}
</style>
