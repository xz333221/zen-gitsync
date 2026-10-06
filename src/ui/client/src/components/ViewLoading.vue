<!--
  视图懒加载占位组件:defineAsyncComponent 的 loadingComponent 用。
  首次切换到某视图时,chunk 还在下载,这里显示占位;
  chunk 加载完成 / KeepAlive 缓存命中后秒切,不再显示。

  原来是「一个 36px 转圈 + 居中一行『加载中…』」—— 在 1600×900 的面板里
  那行字周围全是空的,看不出正在加载的是什么,加载完还会整体跳一下。
  现在改成**版面骨架**:侧栏一列短行 + 主区三块卡片,形状与所有视图
  (git / console / editor / workbench / monitor / mindmap 都是「栏 + 内容」)
  一致,先撑出版面、再被真实内容原地替换。
  样式复用 common.scss 的 `.skeleton`(此前全仓 0 消费)。
-->
<template>
  <div class="view-loading" role="status" aria-live="polite" :aria-label="text">
    <!-- 状态行:保留「加载中…」文案(读屏 + 等了 3 秒以上时用户需要知道在等什么) -->
    <div class="view-loading__status">
      <svg viewBox="0 0 24 24" class="view-loading__icon" aria-hidden="true">
        <circle class="view-loading__track" cx="12" cy="12" r="9" fill="none" stroke-width="3" />
        <circle class="view-loading__arc" cx="12" cy="12" r="9" fill="none" stroke-width="3" stroke-linecap="round" />
      </svg>
      <span class="view-loading__text">{{ text }}</span>
    </div>

    <div class="view-loading__body">
      <div class="view-loading__side">
        <span class="skeleton skeleton--title view-loading__side-title" />
        <span
          v-for="n in 7"
          :key="n"
          class="skeleton skeleton--text view-loading__side-row"
        />
      </div>
      <div class="view-loading__main">
        <span class="skeleton skeleton--title view-loading__main-title" />
        <div class="view-loading__cards">
          <span
            v-for="n in 4"
            :key="n"
            class="skeleton view-loading__card"
          />
        </div>
        <span class="skeleton view-loading__table" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { $t } from '@/lang/static'
interface Props {
  text?: string
}
withDefaults(defineProps<Props>(), {
  text: $t('@2AEBA:加载中...')
})
</script>

<style scoped lang="scss">
.view-loading {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 240px;
  padding: var(--spacing-lg, 16px);
  gap: var(--spacing-lg, 16px);
  background: var(--bg-page, transparent);
  overflow: hidden;
}

/* ── 状态行 ── */
.view-loading__status {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.view-loading__icon {
  width: 16px;
  height: 16px;
  animation: view-loading-spin 0.9s linear infinite;
}

.view-loading__track {
  stroke: var(--border-color, rgba(0, 0, 0, 0.1));
  opacity: 0.5;
}

.view-loading__arc {
  stroke: var(--color-primary);
  stroke-dasharray: 42 60;
}

.view-loading__text {
  font-size: var(--font-size-sm, 13px);
  color: var(--text-meta, rgba(0, 0, 0, 0.55));
}

/* ── 骨架 ── */
.view-loading__body {
  display: flex;
  gap: var(--spacing-lg, 16px);
  flex: 1;
  min-height: 0;
}

.view-loading__side {
  flex: 0 0 240px;
  display: flex;
  flex-direction: column;
  padding: 12px;
  gap: 2px;
  background: var(--bg-container);
  border: 1px solid var(--border-color-light);
  border-radius: var(--radius-lg);
}

.view-loading__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 12px;
  gap: 12px;
  background: var(--bg-container);
  border: 1px solid var(--border-color-light);
  border-radius: var(--radius-lg);
}

.view-loading__side-title {
  width: 56%;
}

.view-loading__side-row {
  width: 100%;
}

/* 行宽错落:等宽的一摞横条看起来像表格,错落的一摞像列表 */
.view-loading__side-row:nth-child(3n) { width: 82%; }
.view-loading__side-row:nth-child(4n) { width: 68%; }

.view-loading__main-title {
  width: 26%;
}

.view-loading__cards {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  flex: 0 0 auto;
}

/* 卡片有固定高度，剩下的高度全给「表格 / 列表」那块 ——
   四张等高卡 + 一块大块，才像这个应用任何一屏真实的样子
   （监控是 4 张 KPI + 端口表，工作台是工具条 + 看板）。 */
.view-loading__card {
  height: 84px;
}

.view-loading__table {
  flex: 1;
  min-height: 120px;
}

@keyframes view-loading-spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

/* 窄屏:侧栏骨架收窄，避免把主区挤没 */
@media (max-width: 1280px) {
  .view-loading__side {
    flex-basis: 180px;
  }
  .view-loading__cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
