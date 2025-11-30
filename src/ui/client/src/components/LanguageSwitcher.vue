<script setup lang="ts">
import { computed } from 'vue'
import { ElDropdown, ElDropdownMenu, ElDropdownItem, ElIcon } from 'element-plus'
import { SUPPORT_LOCALES, LOCALE_NAMES, type SupportLocale } from '@/locales'
import { useLocaleStore } from '@/stores/localeStore'

// 使用 locale store
const localeStore = useLocaleStore()

// 当前语言显示名称
const currentLocaleName = computed(() => LOCALE_NAMES[localeStore.currentLocale])

// 切换语言（无需刷新页面）
const handleLanguageChange = (locale: SupportLocale) => {
  localeStore.changeLocale(locale)
}
</script>

<template>
  <el-dropdown @command="handleLanguageChange" trigger="click">
    <span class="language-switcher">
      <el-icon class="language-icon">
        <!-- 地球/语言图标 -->
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="2" y1="12" x2="22" y2="12"/>
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
        </svg>
      </el-icon>
      <span class="language-text">{{ currentLocaleName }}</span>
    </span>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item
          v-for="locale in SUPPORT_LOCALES"
          :key="locale"
          :command="locale"
          :disabled="locale === localeStore.currentLocale"
        >
          {{ LOCALE_NAMES[locale] }}
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<style scoped>
.language-switcher {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: var(--spacing-sm) var(--spacing-md);
  cursor: pointer;
  border-radius: var(--radius-base);
  transition: var(--transition-all);
  color: var(--text-secondary);
}

.language-switcher:hover {
  background: var(--bg-container-hover);
  color: var(--text-primary);
}

.language-icon {
  font-size: var(--font-size-lg);
}

.language-text {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
}
</style>
