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
let logsData: LogItem[] = []
const logs = ref<LogItem[]>(logsData)
const errorMessage = ref('')
// 定义本地加载状态，而不是依赖于computed
const localLoading = ref(false)
const isLoading = computed(() => gitLogStore.isLoadingLog || localLoading.value)
const showAllCommits = ref(false)
const totalCommits = ref(0)
const showGraphView = ref(true)
const graphContainer = ref<HTMLElement | null>(null)

// 添加图表缩放控制
const graphScale = ref(1)
const minScale = 0.5
const maxScale = 1.5
const scaleStep = 0.1

// 添加日志被刷新的提示状态
const logRefreshed = ref(false)

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
    
    // 设置本地加载状态
    localLoading.value = true
    
    // 保留graph参数，但服务器端其实不做特殊处理
    // 这样可以兼容之前的代码，避免大量修改
    const url = all ? '/api/log?all=true&graph=true' : '/api/log?graph=true'
    console.log(`加载日志数据: ${url}`)
    
    const response = await fetch(url)
    const data = await response.json()
    
    // 清空现有数据
    logsData.length = 0
    
    // 更新本地数据
    if (Array.isArray(data)) {
      // 新的API格式，直接返回数组
      console.log(`日志加载完成: 共${data.length}条记录`)
      
      // 填充logsData
      data.forEach((item: LogItem) => logsData.push(item))
      
      totalCommits.value = data.length
    } else if (data.log && Array.isArray(data.log)) {
      // 旧版API格式，兼容处理
      console.log(`日志加载完成: 共${data.log.length}条记录`)
      
      // 填充logsData
      data.log.forEach((item: LogItem) => logsData.push(item))
      
      totalCommits.value = data.log.length
    } else {
      console.error('未知的日志数据格式:', data)
      errorMessage.value = '日志数据格式错误'
      return
    }
    
    // 确保logs.value也更新
    logs.value = [...logsData]
    
    console.log(`logsData长度: ${logsData.length}`) // 添加调试日志
    
    // 设置刷新提示状态
    logRefreshed.value = true
    // 2秒后隐藏提示
    setTimeout(() => { logRefreshed.value = false }, 2000)
    
    // 加载完数据后渲染图表
    if (showGraphView.value) {
      setTimeout(renderGraph, 0)
    }
    
    errorMessage.value = ''
  } catch (error) {
    errorMessage.value = '加载提交历史失败: ' + (error instanceof Error ? error.message : String(error))
    console.error('加载日志失败:', error)
  } finally {
    // 重置本地加载状态
    localLoading.value = false
  }
}

// 渲染Git图表
async function renderGraph() {
  console.log(`开始渲染图表...数据长度: ${logsData.length}`)
  
  if (!graphContainer.value) {
    console.error('图表容器未找到')
    return
  }
  
  if (logsData.length === 0) {
    console.error('没有日志数据可渲染')
    return
  }
  
  try {
    // 清空容器
    graphContainer.value.innerHTML = ''
    
    console.log(`创建gitgraph实例，分支: ${gitStore.currentBranch || 'main'}`)
    
    // 创建gitgraph实例
    const gitgraph = createGitgraph(graphContainer.value, {
      // 自定义选项
      orientation: 'vertical-reverse' as any, // 使用类型断言解决类型错误
      template: 'metro' as any, // 使用类型断言解决类型错误
      author: '提交者 <committer@example.com>'
    })
    
    // 处理分支和提交数据
    const branches: Record<string, any> = {}
    const mainBranch = gitgraph.branch(gitStore.currentBranch || 'main')
    branches[gitStore.currentBranch || 'main'] = mainBranch
    
    console.log(`开始创建提交图...共${logsData.length}条提交`)
    
    // 简化示例 - 实际实现需要根据API返回的数据结构调整
    logsData.forEach((commit, index) => {
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
      
      if (index % 10 === 0) {
        console.log(`已渲染 ${index + 1}/${logsData.length} 个提交`)
      }
    })
    
    console.log('图表渲染完成')
    
    // 确保渲染完成后调用自适应缩放
    setTimeout(() => {
      fitGraphToContainer()
    }, 100)
  } catch (error) {
    console.error('渲染图表失败:', error)
    errorMessage.value = '渲染图表失败: ' + (error instanceof Error ? error.message : String(error))
  }
}

// 切换视图模式
function toggleViewMode() {
  showGraphView.value = !showGraphView.value
  if (showGraphView.value && logsData.length > 0) {
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
  // 检查gitLogStore中是否已有数据
  if (gitStore.isGitRepo) {
    if (gitLogStore.log.length > 0) {
      // 如果已经有数据，直接使用现有数据
      console.log('使用已加载的日志数据')
      
      // 清空并填充logsData
      logsData.length = 0
      gitLogStore.log.forEach(item => logsData.push(item))
      
      // 由于TypeScript类型错误，我们直接设置totalCommits而不是使用logs.value.length
      totalCommits.value = gitLogStore.log.length
      
      // 确保视图被渲染
      if (showGraphView.value) {
        setTimeout(() => {
          console.log(`准备渲染图表，数据长度: ${logsData.length}`)
          renderGraph()
        }, 100)
      }
    } else {
      // 否则加载数据
      console.log('初始加载日志数据')
      loadLog()
    }
  } else {
    errorMessage.value = '当前目录不是Git仓库'
  }
})

// 简化刷新函数，只需调用loadLog即可
const refreshLog = () => {
  if (!gitStore.isGitRepo) {
    errorMessage.value = '当前目录不是Git仓库'
    return
  }
  loadLog(showAllCommits.value)
}

// 监听store中的日志变化
watch(() => gitLogStore.log, (newLogs) => {
  console.log('监听到gitLogStore.log变化，更新图表数据')
  
  // 清空logsData
  logsData.length = 0
  
  // 重新填充数据
  newLogs.forEach((item: LogItem) => logsData.push(item))
  
  // 更新计数器
  totalCommits.value = newLogs.length
  
  // 尝试解决logs.value赋值问题
  try {
    // @ts-ignore - 忽略TypeScript错误
    logs.value = [...logsData]
  } catch (error) {
    console.warn('无法更新logs.value:', error)
  }
  
  console.log(`数据更新完成，准备渲染图表(${logsData.length}条记录)`)
  
  if (showGraphView.value && logsData.length > 0) {
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
          :class="{ 'refresh-button-animated': logRefreshed }"
        />
      </div>
    </div>
    <div v-if="errorMessage">{{ errorMessage }}</div>
    <div v-else>
      <!-- 添加刷新提示 -->
      <div v-if="logRefreshed" class="refresh-notification">
        提交历史已刷新
      </div>
      
      <!-- 图表视图 -->
      <div v-if="showGraphView" class="graph-view">
        <div class="commit-count" v-if="logsData.length > 0">
          显示 {{ logsData.length }} 条提交记录 {{ showAllCommits ? '(全部)' : '(最近30条)' }}
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

.refresh-button-animated {
  animation: pulse 1s;
}

.refresh-notification {
  background-color: #f0f9eb;
  color: #67c23a;
  padding: 8px;
  border-radius: 4px;
  margin-bottom: 10px;
  text-align: center;
  font-size: 14px;
  border-left: 4px solid #67c23a;
  animation: fadeOut 2s forwards;
}

@keyframes pulse {
  0% { transform: scale(1); }
  50% { transform: scale(1.2); }
  100% { transform: scale(1); }
}

@keyframes fadeOut {
  0% { opacity: 1; }
  70% { opacity: 1; }
  100% { opacity: 0; }
}
</style>

/* 添加表格列调整样式 */
.el-table .el-table__cell .cell {
  word-break: break-all;
}