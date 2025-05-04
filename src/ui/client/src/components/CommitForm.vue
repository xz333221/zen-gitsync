<script setup lang="ts">
import { ref, onMounted } from 'vue'

const commitMessage = ref('')
const commitBtnText = ref('提交')
const pushBtnText = ref('推送到远程')
const isCommitting = ref(false)
const isPushing = ref(false)
const placeholder = ref('输入提交信息...')

// 加载配置
async function loadConfig() {
  try {
    const response = await fetch('/api/config')
    const config = await response.json()
    placeholder.value = `输入提交信息 (默认: ${config.defaultCommitMessage})`
  } catch (error) {
    console.error('加载配置失败:', error)
  }
}

// 提交更改
async function commitChanges() {
  const message = commitMessage.value
  try {
    isCommitting.value = true
    commitBtnText.value = '提交中...'
    
    const response = await fetch('/api/commit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ message })
    })
    
    const result = await response.json()
    if (result.success) {
      commitMessage.value = ''
      alert('提交成功!')
    } else {
      alert('提交失败: ' + result.error)
    }
  } catch (error) {
    alert('提交失败: ' + (error as Error).message)
  } finally {
    isCommitting.value = false
    commitBtnText.value = '提交'
  }
}

// 推送更改
async function pushChanges() {
  try {
    isPushing.value = true
    pushBtnText.value = '推送中...'
    
    const response = await fetch('/api/push', {
      method: 'POST'
    })
    
    const result = await response.json()
    if (result.success) {
      alert('推送成功!')
    } else {
      alert('推送失败: ' + result.error)
    }
  } catch (error) {
    alert('推送失败: ' + (error as Error).message)
  } finally {
    isPushing.value = false
    pushBtnText.value = '推送到远程'
  }
}

onMounted(() => {
  loadConfig()
})
</script>

<template>
  <div class="card">
    <h2>提交更改</h2>
    <div class="commit-form">
      <input 
        type="text" 
        v-model="commitMessage" 
        :placeholder="placeholder"
      >
      <button 
        @click="commitChanges" 
        :disabled="isCommitting"
      >{{ commitBtnText }}</button>
    </div>
    <button 
      @click="pushChanges" 
      :disabled="isPushing"
    >{{ pushBtnText }}</button>
  </div>
</template>