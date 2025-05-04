<script setup lang="ts">
import { ref, onMounted, defineEmits } from 'vue'
import { ElMessage } from 'element-plus'

const emit = defineEmits(['commit-success', 'push-success'])
const commitMessage = ref('')
const commitBtnText = ref('提交')
const pushBtnText = ref('推送到远程')
const isCommitting = ref(false)
const isPushing = ref(false)
// 添加提交并推送的状态变量
const isCommitAndPushing = ref(false)
const commitAndPushBtnText = ref('提交并推送')
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

// 提交并推送更改
async function commitAndPush() {
  const message = commitMessage.value
  try {
    isCommitAndPushing.value = true
    commitAndPushBtnText.value = '处理中...'
    
    // 先提交
    const commitResponse = await fetch('/api/commit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ message })
    })
    
    const commitResult = await commitResponse.json()
    if (!commitResult.success) {
      ElMessage({
        message: '提交失败: ' + commitResult.error,
        type: 'error',
      })
      return
    }
    
    // 再推送
    const pushResponse = await fetch('/api/push', {
      method: 'POST'
    })
    
    const pushResult = await pushResponse.json()
    if (pushResult.success) {
      commitMessage.value = ''
      ElMessage({
        message: '提交并推送成功!',
        type: 'success',
      })
      // 发出提交和推送成功事件
      emit('commit-success')
      emit('push-success')
    } else {
      ElMessage({
        message: '推送失败: ' + pushResult.error,
        type: 'error',
      })
    }
  } catch (error) {
    ElMessage({
      message: '操作失败: ' + (error as Error).message,
      type: 'error',
    })
  } finally {
    isCommitAndPushing.value = false
    commitAndPushBtnText.value = '提交并推送'
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
      <el-input 
        v-model="commitMessage" 
        :placeholder="placeholder"
      />
      <el-button 
        type="primary" 
        @click="commitChanges" 
        :loading="isCommitting"
      >{{ commitBtnText }}</el-button>
    </div>
    <div class="button-group">
      <el-button 
        type="success" 
        @click="pushChanges" 
        :loading="isPushing"
      >{{ pushBtnText }}</el-button>
      <el-button 
        type="warning" 
        @click="commitAndPush" 
        :loading="isCommitAndPushing"
      >{{ commitAndPushBtnText }}</el-button>
    </div>
  </div>
</template>

<style scoped>
.commit-form {
  display: flex;
  margin-bottom: 15px;
  gap: 10px;
}
.button-group {
  display: flex;
  gap: 10px;
}
</style>