<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { Sunny, Moon } from '@element-plus/icons-vue'
import { $t } from '@/lang/static'
import IconButton from '@components/IconButton.vue'
import { useConfigStore } from '@/stores/configStore'

const configStore = useConfigStore()

// 主题状态
const isDarkTheme = ref(false)

// 同步 configStore 的主题状态
watch(() => configStore.theme, (newTheme) => {
  if (newTheme === 'dark') {
    isDarkTheme.value = true
  } else if (newTheme === 'light') {
    isDarkTheme.value = false
  } else {
    // auto: 跟随系统
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    isDarkTheme.value = prefersDark
  }
}, { immediate: true })

// 切换主题
async function toggleTheme() {
  isDarkTheme.value = !isDarkTheme.value
  const newTheme = isDarkTheme.value ? 'dark' : 'light'
  // 更新 configStore 并保存到服务器
  configStore.theme = newTheme
  await configStore.saveGeneralSettings({ theme: newTheme })
}

// 初始化主题
function initTheme() {
  // 优先使用 configStore 的主题（已经从 localStorage 或服务器加载）
  const currentTheme = configStore.theme
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  
  if (currentTheme === 'dark' || (currentTheme === 'auto' && prefersDark)) {
    isDarkTheme.value = true
    document.documentElement.setAttribute('data-theme', 'dark')
  } else {
    isDarkTheme.value = false
    document.documentElement.removeAttribute('data-theme')
  }
}

// 组件挂载时初始化主题
onMounted(() => {
  initTheme()
})
</script>

<template>
  <IconButton
    :tooltip="isDarkTheme ? $t('@F13B4:切换到浅色主题') : $t('@F13B4:切换到深色主题')"
    size="large"
    @click="toggleTheme"
  >
    <el-icon>
      <Sunny v-if="isDarkTheme" />
      <Moon v-else />
    </el-icon>
  </IconButton>
</template>

<style scoped>
/* 按钮样式继承自全局样式 */
</style>
