<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { ElTable, ElTableColumn, ElTag, ElButton, ElSlider } from 'element-plus'
import { RefreshRight, ZoomIn, ZoomOut } from '@element-plus/icons-vue'
import 'element-plus/dist/index.css'
import { createGitgraph } from '@gitgraph/js'
import { useGitLogStore } from '../stores/gitLogStore'
import { useGitStore } from '../stores/gitStore'

interface LogItem {
  hash: string
  date: string
  author: string
  email: string
  message: string
  branch?: string
  parents?: string[]
}

// 使用Git状态和日志Store
const gitLogStore = useGitLogStore()
const gitStore = useGitStore()

// 获取日志数据
const logs = ref<LogItem[]>([])
const errorMessage = ref('')
const isLoading = computed(() => gitLogStore.isLoadingLog)
const showAllCommits = ref(false)
const totalCommits = ref(0)
const showGraphView = ref(true)
const graphContainer = ref<HTMLElement | null>(null)

// 添加图表缩放控制
const graphScale = ref(1)
const minScale = 0.5
const maxScale = 1.5
const scaleStep = 0.1

// 加载提交历史
async function loadLog(all = false) {
  // 从gitStore获取仓库状态
  const gitStore = useGitStore()
  
  // 检查是否是Git仓库
  if (!gitStore.isGitRepo) {
    errorMessage.value = '当前目录不是Git仓库'
    return
  }
  
  try {
    showAllCommits.value = all
    // 修改API调用，获取更详细的提交信息，包括父提交
    const url = all ? '/api/log?all=true&graph=true' : '/api/log?graph=true'
    const response = await fetch(url)
    const data = await response.json()
    
    // 如果返回的是数组，说明服务器直接返回了日志数据
    if (Array.isArray(data)) {
      if (gitLogStore.log.length === 0) {
        // 主存储区还没有数据，也填充一下
        gitLogStore.log = data
      }
      // 确保本地组件状态的日志数据是最新的
      logs.value = data
      totalCommits.value = data.length
    } else if (data.log && Array.isArray(data.log)) {
      // 旧版API格式
      if (gitLogStore.log.length === 0) {
        gitLogStore.log = data.log
      }
      logs.value = data.log
      totalCommits.value = data.log.length
    }
    
    errorMessage.value = ''
    
    // 加载完数据后渲染图表
    if (showGraphView.value) {
      setTimeout(renderGraph, 0)
    }
  } catch (error) {
    errorMessage.value = '加载提交历史失败: ' + (error as Error).message
  }
}

// 渲染Git图表
async function renderGraph() {
  if (!graphContainer.value || logs.value.length === 0) return
  
  // 清空容器
  graphContainer.value.innerHTML = ''
  
  // 创建gitgraph实例
  const gitgraph = createGitgraph(graphContainer.value, {
    // 自定义选项
    // @ts-ignore: true
    orientation: 'vertical-reverse', // 从上到下的方向
    // @ts-ignore: true
    template: 'metro', // 使用metro模板
    author: '提交者 <committer@example.com>'
  })
  
  // 处理分支和提交数据
  const branches: Record<string, any> = {}
  const mainBranch = gitgraph.branch(gitStore.currentBranch || 'main')
  branches[gitStore.currentBranch || 'main'] = mainBranch
  
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
  
  // 确保渲染完成后调用自适应缩放
  setTimeout(() => {
    fitGraphToContainer()
  }, 100)
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

// 格式化分支名（实现该函数，因为在模板中调用了）
function formatBranchName(ref: string) {
  // 处理HEAD、远程分支等情况
  if (ref.includes('HEAD -> ')) {
    return ref.replace('HEAD -> ', '')
  }
  if (ref.includes('origin/')) {
    return ref
  }
  return ref.trim()
}

// 获取分支标签类型（实现该函数，因为在模板中调用了）
function getBranchTagType(ref: string) {
  if (ref.includes('HEAD')) return 'success'
  if (ref.includes('origin/')) return 'warning'
  return 'info'
}

onMounted(() => {
  // 直接使用gitStore.isGitRepo
  if (gitStore.isGitRepo) {
    // App.vue 已经通过 fetchLog 加载了基本日志
    // 这里只需加载带图表参数的日志即可
    loadLog()
  } else {
    errorMessage.value = '当前目录不是Git仓库'
  }
})

const refreshLog = () => {
  if (gitStore.isGitRepo) {
    gitLogStore.fetchLog()
    loadLog(showAllCommits.value)
  } else {
    errorMessage.value = '当前目录不是Git仓库'
  }
}

// 监听store中的日志变化
watch(() => gitLogStore.log, (newLogs) => {
  logs.value = newLogs
  if (showGraphView.value && newLogs.length > 0) {
    setTimeout(renderGraph, 0)
  }
})

// 暴露方法给父组件
defineExpose({
  refreshLog
})

// 增加/减少缩放比例
function zoomIn() {
  if (graphScale.value < maxScale) {
    graphScale.value = Math.min(maxScale, graphScale.value + scaleStep)
    applyScale()
  }
}

function zoomOut() {
  if (graphScale.value > minScale) {
    graphScale.value = Math.max(minScale, graphScale.value - scaleStep)
    applyScale()
  }
}

// 应用缩放比例
function applyScale() {
  if (!graphContainer.value) return
  
  const svgElement = graphContainer.value.querySelector('svg')
  if (svgElement) {
    svgElement.style.transform = `scale(${graphScale.value})`
    svgElement.style.transformOrigin = 'top left'
  }
}

// 自适应图表大小
function fitGraphToContainer() {
  if (!graphContainer.value) return
  
  const svgElement = graphContainer.value.querySelector('svg')
  if (!svgElement) return
  
  // 获取SVG和容器的宽度
  const svgWidth = svgElement.getBoundingClientRect().width / graphScale.value
  const containerWidth = graphContainer.value.clientWidth
  
  // 计算合适的缩放比例
  if (svgWidth > containerWidth) {
    // 如果SVG宽度大于容器，需要缩小
    graphScale.value = Math.max(minScale, containerWidth / svgWidth)
  } else {
    // 否则恢复到默认比例
    graphScale.value = 1
  }
  
  applyScale()
}
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
          {{ showAllCommits ? '显示最近30条' : '显示所有提交' }}
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
          显示 {{ logs.length }} 条提交记录 {{ showAllCommits ? '(全部)' : '(最近30条)' }}
        </div>
        
        <!-- 添加缩放控制 -->
        <div class="graph-controls">
          <div class="zoom-controls">
            <el-button
              type="primary"
              :icon="ZoomOut"
              circle
              size="small"
              @click="zoomOut"
              :disabled="graphScale <= minScale"
            />
            
            <el-slider
              v-model="graphScale"
              :min="minScale"
              :max="maxScale"
              :step="scaleStep"
              @change="applyScale"
              class="zoom-slider"
            />
            
            <el-button
              type="primary"
              :icon="ZoomIn"
              circle
              size="small"
              @click="zoomIn"
              :disabled="graphScale >= maxScale"
            />
            
            <el-button
              type="primary"
              size="small"
              @click="fitGraphToContainer"
            >
              自适应大小
            </el-button>
          </div>
          
          <div class="scale-info">
            缩放: {{ Math.round(graphScale * 100) }}%
          </div>
        </div>
        
        <div ref="graphContainer" class="graph-container"></div>
      </div>
      
      <!-- 表格视图 -->
      <div v-else>
        <div class="commit-count" v-if="logs.length > 0">
          显示 {{ logs.length }} 条提交记录 {{ showAllCommits ? '(全部)' : '(最近30条)' }}
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
  position: relative;
}

.graph-container svg {
  transform-origin: top left;
  transition: transform 0.2s ease;
}

.graph-view {
  width: 100%;
}

.graph-controls {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.zoom-controls {
  display: flex;
  gap: 8px;
}

.zoom-slider {
  width: 200px;
}

.scale-info {
  font-size: 14px;
  color: #606266;
}
</style>

/* 添加表格列调整样式 */
.el-table .el-table__cell .cell {
  word-break: break-all;
}