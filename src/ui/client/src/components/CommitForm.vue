<script setup lang="ts">
import { ref, onMounted, defineEmits, computed } from 'vue'
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

// 标准化提交相关变量
const isStandardCommit = ref(false)
const commitType = ref('feat')
const commitScope = ref('')
const commitDescription = ref('')
const commitBody = ref('')
const commitFooter = ref('')

// 提交类型选项
const commitTypeOptions = [
  { value: 'feat', label: 'feat: 新功能' },
  { value: 'fix', label: 'fix: 修复bug' },
  { value: 'docs', label: 'docs: 文档修改' },
  { value: 'style', label: 'style: 样式修改' },
  { value: 'refactor', label: 'refactor: 代码重构' },
  { value: 'test', label: 'test: 测试代码' },
  { value: 'chore', label: 'chore: 构建/工具修改' }
]

// 计算最终的提交信息
const finalCommitMessage = computed(() => {
  if (!isStandardCommit.value) {
    return commitMessage.value;
  }
  
  // 构建标准化提交信息
  let message = `${commitType.value}`;
  if (commitScope.value) {
    message += `(${commitScope.value})`;
  }
  message += `: ${commitDescription.value}`;
  
  if (commitBody.value) {
    message += `\n\n${commitBody.value}`;
  }
  
  if (commitFooter.value) {
    message += `\n\n${commitFooter.value}`;
  }
  
  return message;
})

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
  const message = finalCommitMessage.value
  if (!message && isStandardCommit.value && !commitDescription.value) {
    ElMessage({
      message: '请输入提交描述',
      type: 'warning',
    })
    return
  }
  
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
      // 清空输入
      if (isStandardCommit.value) {
        commitDescription.value = ''
        commitBody.value = ''
        commitFooter.value = ''
      } else {
        commitMessage.value = ''
      }
      
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
  const message = finalCommitMessage.value
  if (!message && isStandardCommit.value && !commitDescription.value) {
    ElMessage({
      message: '请输入提交描述',
      type: 'warning',
    })
    return
  }
  
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
    
    // 清空输入
    if (isStandardCommit.value) {
      commitDescription.value = ''
      commitBody.value = ''
      commitFooter.value = ''
    } else {
      commitMessage.value = ''
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

// 切换提交模式
function toggleCommitMode() {
  isStandardCommit.value = !isStandardCommit.value
}

onMounted(() => {
  loadConfig()
})
</script>

<template>
  <div class="card">
    <h2>提交更改</h2>
    
    <div class="commit-mode-toggle">
      <el-switch
        v-model="isStandardCommit"
        active-text="标准化提交"
        inactive-text="普通提交"
      />
    </div>
    
    <!-- 普通提交表单 -->
    <div v-if="!isStandardCommit" class="commit-form">
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
    
    <!-- 标准化提交表单 -->
    <div v-else class="standard-commit-form">
      <div class="standard-commit-header">
        <el-select v-model="commitType" placeholder="提交类型" class="type-select">
          <el-option
            v-for="item in commitTypeOptions"
            :key="item.value"
            :label="item.label"
            :value="item.value"
          />
        </el-select>
        
        <el-input 
          v-model="commitScope" 
          placeholder="作用域（可选）" 
          class="scope-input"
        />
        
        <el-input 
          v-model="commitDescription" 
          placeholder="简短描述（必填）" 
          class="description-input"
        />
      </div>
      
      <el-input 
        v-model="commitBody" 
        type="textarea" 
        :rows="4" 
        placeholder="正文（可选）：详细描述本次提交的内容和原因" 
        class="body-input"
      />
      
      <el-input 
        v-model="commitFooter" 
        placeholder="页脚（可选）：如 Closes #123" 
        class="footer-input"
      />
      
      <div class="preview-section">
        <div class="preview-title">预览：</div>
        <pre class="preview-content">{{ finalCommitMessage }}</pre>
      </div>
      
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
.commit-mode-toggle {
  margin-bottom: 15px;
}
.standard-commit-form {
  display: flex;
  flex-direction: column;
  gap: 15px;
  margin-bottom: 15px;
}
.standard-commit-header {
  display: flex;
  gap: 10px;
  width: 100%;
}
.type-select {
  width: 120px;
  flex-shrink: 0;
}
.scope-input {
  width: 200px;
  flex-shrink: 0;
  flex-grow: 0;
}
.description-input {
  flex-grow: 1;
  min-width: 250px;
}
.preview-section {
  background-color: #f5f7fa;
  padding: 10px;
  border-radius: 4px;
}
.preview-title {
  font-weight: bold;
  margin-bottom: 5px;
}
.preview-content {
  white-space: pre-wrap;
  font-family: monospace;
  margin: 0;
  padding: 10px;
  background-color: #ebeef5;
  border-radius: 4px;
}
</style>