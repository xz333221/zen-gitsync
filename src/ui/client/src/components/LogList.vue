<script setup lang="ts">
import { ref, onMounted, defineExpose } from 'vue'
import { ElTable, ElTableColumn, ElTag, ElButton } from 'element-plus'
import { RefreshRight } from '@element-plus/icons-vue'
import 'element-plus/dist/index.css'

interface LogItem {
  hash: string
  date: string
  author: string
  message: string
  branch?: string // 添加分支信息字段
}

const logs = ref<LogItem[]>([])
const errorMessage = ref('')
const isLoading = ref(false)
const showAllCommits = ref(false)
const totalCommits = ref(0)

// 加载提交历史
async function loadLog(all = false) {
  try {
    isLoading.value = true
    showAllCommits.value = all
    const url = all ? '/api/log?all=true' : '/api/log'
    const response = await fetch(url)
    logs.value = await response.json()
    totalCommits.value = logs.value.length
    errorMessage.value = ''
  } catch (error) {
    errorMessage.value = '加载提交历史失败: ' + (error as Error).message
  } finally {
    isLoading.value = false
  }
}

// 切换显示所有提交
function toggleAllCommits() {
  loadLog(!showAllCommits.value)
}

onMounted(() => {
  loadLog()
})

// 暴露方法给父组件
defineExpose({
  refreshLog: () => loadLog(showAllCommits.value)
})
</script>

<template>
  <div class="card">
    <div class="log-header">
      <h2>提交历史</h2>
      <div class="log-actions">
        <el-button 
          type="primary" 
          size="small" 
          @click="toggleAllCommits" 
          :loading="isLoading"
        >
          {{ showAllCommits ? '显示最近100条' : '显示所有提交' }}
        </el-button>
        <el-button 
          :icon="RefreshRight" 
          circle 
          size="small" 
          @click="refreshLog()" 
          :loading="isLoading"
        />
      </div>
    </div>
    <div v-if="errorMessage">{{ errorMessage }}</div>
    <div v-else>
      <div class="commit-count" v-if="logs.length > 0">
        显示 {{ logs.length }} 条提交记录 {{ showAllCommits ? '(全部)' : '(最近100条)' }}
      </div>
      <el-table :data="logs" style="width: 100%" stripe border v-loading="isLoading">
        <el-table-column prop="hash" label="提交哈希" width="100" resizable />
        <el-table-column prop="date" label="日期" width="180" resizable />
        <el-table-column prop="author" label="作者" width="150" resizable />
        <el-table-column label="分支" width="180" resizable>
          <template #default="scope">
            <div v-if="scope.row.branch" class="branch-container">
              <el-tag 
                v-for="(ref, index) in scope.row.branch.split(',')" 
                :key="index"
                size="small"
                :type="getBranchTagType(ref)"
                class="branch-tag"
              >
                {{ formatBranchName(ref) }}
              </el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="message" label="提交信息" min-width="250" />
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.log-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.log-actions {
  display: flex;
  gap: 8px;
}

.branch-container {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.branch-tag {
  margin-right: 4px;
}

.commit-count {
  margin-bottom: 10px;
  font-size: 14px;
  color: #606266;
  text-align: right;
}
</style>

<script lang="ts">
// 辅助函数：格式化分支名称
function formatBranchName(ref: string) {
  // 移除 "HEAD -> " 前缀
  ref = ref.trim().replace(/^HEAD\s*->\s*/, '')
  
  // 移除 "origin/" 前缀
  ref = ref.replace(/^origin\//, '')
  
  // 移除 "tag: " 前缀，但保留标签名
  ref = ref.replace(/^tag:\s*/, '')
  
  return ref.trim()
}

// 辅助函数：根据分支类型返回不同的标签类型
function getBranchTagType(ref: string) {
  if (ref.includes('HEAD')) return 'success'
  if (ref.includes('tag:')) return 'warning'
  if (ref.includes('origin/')) return 'info'
  return ''
}
</script>

/* 添加表格列调整样式 */
.el-table .el-table__cell .cell {
  word-break: break-all;
}