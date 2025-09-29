<script setup lang="ts">
import { computed, useSlots } from 'vue'

// Unified InlineCard: single style for all instances
const slots = useSlots()
const hasIcon = computed(() => {
  const s = slots.icon?.()
  return Array.isArray(s) ? s.length > 0 : !!s
})
</script>

<template>
  <div class="inline-card">
    <div class="inline-card__icon" v-if="hasIcon">
      <slot name="icon" />
    </div>
    <div class="inline-card__content">
      <!-- Prefer named content slot; fallback to default slot -->
      <slot name="content"><slot /></slot>
    </div>
    <div class="inline-card__actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped lang="scss">
.inline-card {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border-radius: 8px;
  background: var(--bg-container);
  border: 1px solid var(--border-component);
  box-shadow: 0 2px 4px rgba(0,0,0,0.05);
  transition: all 0.2s ease;
  max-width: 100%;
  height: 40px; /* unify card height */
  box-sizing: border-box;
}

/* Unified hover for all cards */
.inline-card:hover {
  transform: translateY(-1px);
  box-shadow: 0 3px 8px rgba(0,0,0,0.1);
  border-color: var(--border-color-dark);
}

.inline-card:not(.is-bordered) { /* keep as neutral; class not used, left for compatibility */
  border-color: transparent;
}

.inline-card__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-title);
}

.inline-card__content {
  display: inline-flex;
  align-items: center;
  height: 100%;
  gap: 6px;
  min-width: 0;
  flex: 1 1 auto;
}

.inline-card__actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* Text truncation helper for long content */
.inline-card__content > .truncate {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Dark theme polish */
:global([data-theme="dark"]) .inline-card {
  background: var(--bg-container-dark);
  border-color: var(--border-color-dark);
  box-shadow: 0 1px 3px rgba(0,0,0,0.35);
}
:global([data-theme="dark"]) .inline-card:hover {
  transform: translateY(-1px);
  box-shadow: 0 3px 10px rgba(0,0,0,0.45);
  border-color: var(--border-color-dark);
}
</style>
