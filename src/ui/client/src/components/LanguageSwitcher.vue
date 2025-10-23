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
        <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
          <path fill="currentColor" d="M478.08 601.6a111.68 111.68 0 0 0 67.84 0l-33.92-78.08-33.92 78.08zM512 0C229.248 0 0 229.248 0 512s229.248 512 512 512 512-229.248 512-512S794.752 0 512 0zm94.208 454.4l-94.208 243.2-94.208-243.2H307.2v-51.2h102.4v-51.2H307.2v-51.2h128l-25.6-76.8h51.2l25.6 76.8h25.6l25.6-76.8h51.2l-25.6 76.8h128v51.2H588.8v51.2h102.4v51.2H588.8z"/>
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
  padding: 4px 12px;
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
  font-size: 18px;
}

.language-text {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
}
</style>
