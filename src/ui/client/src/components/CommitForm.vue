<script setup lang="ts">
import { ref, onMounted, defineEmits } from 'vue'
import { ElMessage } from 'element-plus'

const emit = defineEmits(['commit-success', 'push-success'])
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
      ElMessage({
        message: '提交成功!',
        type: 'success',
      })
      // 发出提交成功事件
      emit('commit-success')
    } else {
      ElMessage({
        message: '提交失败: ' + result.error,
        type: 'error',
      })
    }
  } catch (error) {
    ElMessage({
      message: '提交失败: ' + (error as Error).message,
      type: 'error',
    })
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
      ElMessage({
        message: '推送成功!',
        type: 'success',
      })
      // 发出推送成功事件
      emit('push-success')
    } else {
      ElMessage({
        message: '推送失败: ' + result.error,
        type: 'error',
      })
    }
  } catch (error) {
    ElMessage({
      message: '推送失败: ' + (error as Error).message,
      type: 'error',
    })
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