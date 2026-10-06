<!--
  面板级空态：图标 + 标题 + 说明，三档固定，全应用同一套。

  为什么要有：同一个"这里还没有东西"的角色，此前在四处长成了四个样子 ——
  编辑器主区是 48px 图标 + 两行同样灰度的说明（没有标题）、
  思维导图主区是 56px 图标 + 16px 粗体标题 + 13px 说明、
  控制台终端区干脆只有一行 13px 灰字（面板 700×580 全空）、
  侧栏空态又是 padding 24px 的一行居中文字。
  用户每一屏都要重新认一次"这是空态还是加载失败"。

  不吃的两类空态（刻意不同形状，别往这里收）：
  · 智能体首页 —— 那是**引导**（标题 + 建议卡），不是"暂无内容"；
  · 看板空列 —— 那是**放置目标 / 动作**（虚线框 + 新建任务），
    它和同列的"＋新建任务"幽灵项本来就是一族的。
-->

<template>
  <div class="empty-state" :class="`empty-state--${size}`">
    <span v-if="$slots.icon" class="empty-state__icon" aria-hidden="true">
      <slot name="icon" />
    </span>
    <p v-if="title" class="empty-state__title">{{ title }}</p>
    <p v-if="hint" class="empty-state__hint">{{ hint }}</p>
    <div v-if="$slots.default" class="empty-state__actions">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
interface Props {
  /** 主句：「这里是什么」（如「思维导图编辑器」） */
  title?: string
  /** 从句：用户接下来该做什么（如「从左侧选择一个文件」） */
  hint?: string
  /** panel = 主工作区（图标 48px、标题 13px/600）；inline = 侧栏 / 表格内（图标 28px、单行） */
  size?: 'panel' | 'inline'
}
withDefaults(defineProps<Props>(), {
  title: '',
  hint: '',
  size: 'panel',
})
</script>

<style scoped lang="scss">
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: var(--spacing-sm);
  color: var(--text-meta);
  user-select: none;
}

.empty-state__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* 图标是氛围，不是内容：统一压到 35% 不透明度，
     比在每处各写一个 opacity 数值（.3 / .4 / 无）好对齐 */
  opacity: 0.35;
}

.empty-state__icon :deep(svg) {
  width: 48px;
  height: 48px;
}

.empty-state__title {
  margin: 0;
  /* 14px 是全应用正文字号的天花板（见 docs/ui-audit 的 P2-17）：
     空态标题停在这里，不再各写各的 13 / 16px */
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--text-secondary);
}

.empty-state__hint {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-meta);
}

.empty-state__actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  margin-top: var(--spacing-sm);
}

/* 侧栏 / 表格内：一行放得下，不摆大图标 */
.empty-state--inline {
  gap: 2px;
}

.empty-state--inline .empty-state__icon :deep(svg) {
  width: 28px;
  height: 28px;
}

.empty-state--inline .empty-state__title {
  font-size: var(--font-size-sm);
  font-weight: 500;
}

.empty-state--inline .empty-state__hint {
  font-size: var(--font-size-xs);
}
</style>
