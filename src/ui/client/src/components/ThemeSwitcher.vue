<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Sunny, Moon } from '@element-plus/icons-vue'
import { $t } from '@/lang/static'
import IconButton from '@components/IconButton.vue'

// 主题状态
const isDarkTheme = ref(false)

// 切换主题
function toggleTheme() {
  isDarkTheme.value = !isDarkTheme.value
  const html = document.documentElement
  if (isDarkTheme.value) {
    html.setAttribute('data-theme', 'dark')
    localStorage.setItem('theme', 'dark')
  } else {
    html.removeAttribute('data-theme')
    localStorage.setItem('theme', 'light')
  }
}

// 初始化主题
function initTheme() {
  const savedTheme = localStorage.getItem('theme')
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  
  if (savedTheme === 'dark' || (!savedTheme && prefersDark)) {
    isDarkTheme.value = true
    document.documentElement.setAttribute('data-theme', 'dark')
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
