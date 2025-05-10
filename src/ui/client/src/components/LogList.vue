<script setup lang="ts">
import { ref, onMounted, defineExpose } from 'vue'
import { ElTable, ElTableColumn, ElTag, ElButton } from 'element-plus'
import { RefreshRight } from '@element-plus/icons-vue'
import 'element-plus/dist/index.css'
import { createGitgraph } from '@gitgraph/js'

interface LogItem {
  hash: string
  date: string
  author: string
  email: string  // 添加邮箱字段
  message: string
  branch?: string // 添加分支信息字段
  parents?: string[] // 添加父提交信息
}

const logs = ref<LogItem[]>([])
const errorMessage = ref('')
const isLoading = ref(false)
const showAllCommits = ref(false)
const totalCommits = ref(0)
const showGraphView = ref(true) // 控制是否显示图表视图
const graphContainer = ref<HTMLElement | null>(null)

// 加载提交历史
async function loadLog(all = false) {
  try {
    isLoading.value = true
    showAllCommits.value = all
    // 修改API调用，获取更详细的提交信息，包括父提交
    const url = all ? '/api/log?all=true&graph=true' : '/api/log?graph=true'
    const response = await fetch(url)
    logs.value = await response.json()
    totalCommits.value = logs.value.length
    errorMessage.value = ''
    
    // 加载完数据后渲染图表
    if (showGraphView.value) {
      setTimeout(renderGraph, 0)
    }
  } catch (error) {
    errorMessage.value = '加载提交历史失败: ' + (error as Error).message
  } finally {
    isLoading.value = false
  }
}

// 渲染Git图表
async function renderGraph() {
  if (!graphContainer.value || logs.value.length === 0) return
  
  // 清空容器
  graphContainer.value.innerHTML = ''
  
  // 获取当前分支
  const branchResponse = await fetch('/api/branch')
  const { branch: currentBranch } = await branchResponse.json()

  // 创建gitgraph实例
  const gitgraph = createGitgraph(graphContainer.value, {
    // 自定义选项
    orientation: 'vertical-reverse', // 从上到下的方向
    template: 'metro', // 使用metro模板
    author: '提交者 <committer@example.com>'
  })
  
  // 处理分支和提交数据
  // 注意：这里的实现是简化的，实际需要根据API返回的数据结构调整
  const branches: Record<string, any> = {}
  const mainBranch = gitgraph.branch(currentBranch || 'main')  // 使用API获取的分支或默认main
  branches[currentBranch || 'main'] = mainBranch
  
  // 简化示例 - 实际实现需要根据API返回的数据结构调整
  logs.value.forEach(commit => {
    // 这里需要根据实际数据结构构建分支图
    let currentBranch = mainBranch
    
    // 如果有分支信息，使用对应的分支
    if (commit.branch) {
      const branchName = formatBranchName(commit.branch.split(',')[0])
      if (!branches[branchName]) {
        branches[branchName] = gitgraph.branch(branchName)
      }
      currentBranch = branches[branchName]
    }
    
    // 创建提交，添加邮箱信息
    currentBranch.commit({
      hash: commit.hash,
      subject: commit.message,
      author: `${commit.author} <${commit.email}>`
    })
  })
}

// 切换视图模式
function toggleViewMode() {
  showGraphView.value = !showGraphView.value
  if (showGraphView.value && logs.value.length > 0) {
    // 延迟执行以确保DOM已更新
    setTimeout(renderGraph, 0)
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
          @click="toggleViewMode"
        >
          {{ showGraphView ? '表格视图' : '图表视图' }}
        </el-button>
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
      <!-- 图表视图 -->
      <div v-if="showGraphView" class="graph-view">
        <div class="commit-count" v-if="logs.length > 0">
          显示 {{ logs.length }} 条提交记录 {{ showAllCommits ? '(全部)' : '(最近100条)' }}
        </div>
        <div ref="graphContainer" class="graph-container"></div>
      </div>
      
      <!-- 表格视图 -->
      <div v-else>
        <div class="commit-count" v-if="logs.length > 0">
          显示 {{ logs.length }} 条提交记录 {{ showAllCommits ? '(全部)' : '(最近100条)' }}
        </div>
        <el-table :data="logs" style="width: 100%" stripe border v-loading="isLoading">
          <el-table-column prop="hash" label="提交哈希" width="100" resizable />
          <el-table-column prop="date" label="日期" width="180" resizable />
          <el-table-column label="作者" width="200" resizable>
            <template #default="scope">
              {{ scope.row.author }} &lt;{{ scope.row.email }}&gt;
            </template>
          </el-table-column>
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

.graph-container {
  width: 100%;
  height: 600px;
  overflow: auto;
  border: 1px solid #ebeef5;
  border-radius: 4px;
  padding: 10px;
  background-color: #fff;
  /* transform: scale(0.8); */
}

.graph-view {
  width: 100%;
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
  return 'primary' // 修改空字符串为有效的type值
}
</script>

/* 添加表格列调整样式 */
.el-table .el-table__cell .cell {
  word-break: break-all;
}