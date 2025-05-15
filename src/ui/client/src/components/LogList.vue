<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { ElTable, ElTableColumn, ElTag, ElButton, ElSlider, ElDialog, ElSelect, ElOption, ElDatePicker, ElInput, ElBadge } from 'element-plus'
import { RefreshRight, ZoomIn, ZoomOut, ArrowDown, ArrowUp, Search, Filter, Document, TrendCharts, List, More } from '@element-plus/icons-vue'
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
const showGraphView = ref(false)
const graphContainer = ref<HTMLElement | null>(null)

// 添加提交详情弹窗相关变量
const commitDetailVisible = ref(false)
const selectedCommit = ref<LogItem | null>(null)
const commitFiles = ref<string[]>([])
const commitDiff = ref('')
const isLoadingCommitDetail = ref(false)
const selectedCommitFile = ref('')

// 添加图表缩放控制
const graphScale = ref(1)
const minScale = 0.5
const maxScale = 1.5
const scaleStep = 0.1

// 添加日志被刷新的提示状态
const logRefreshed = ref(false)

// 添加筛选相关变量
const filterVisible = ref(false)
const authorFilter = ref('')
const messageFilter = ref('')
const dateRangeFilter = ref<any>(null)
const availableAuthors = computed(() => {
  // 从日志中提取不重复的作者列表
  const authors = new Set<string>()
  logs.value.forEach(log => {
    if (log.author) {
      authors.add(log.author)
    }
  })
  return Array.from(authors).sort()
})

// 应用筛选后的日志
const filteredLogs = computed(() => {
  if (!authorFilter.value && !messageFilter.value && !dateRangeFilter.value) {
    return logs.value
  }
  
  return logs.value.filter(log => {
    // 作者筛选
    if (authorFilter.value && log.author !== authorFilter.value) {
      return false
    }
    
    // 提交信息关键词筛选
    if (messageFilter.value && !log.message.toLowerCase().includes(messageFilter.value.toLowerCase())) {
      return false
    }
    
    // 日期范围筛选
    if (dateRangeFilter.value && dateRangeFilter.value.length === 2) {
      const logDate = new Date(log.date)
      const [startDateStr, endDateStr] = dateRangeFilter.value
      
      // 转换日期字符串为Date对象
      const startDate = new Date(startDateStr)
      const endDate = new Date(endDateStr)
      
      // 设置时间为一天的开始和结束，确保包含完整日期
      startDate.setHours(0, 0, 0, 0)
      endDate.setHours(23, 59, 59, 999)
      
      if (logDate < startDate || logDate > endDate) {
        return false
      }
    }
    
    return true
  })
})

// 重置筛选条件
function resetFilters() {
  authorFilter.value = ''
  messageFilter.value = ''
  dateRangeFilter.value = null
}

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

// 查看提交详情
async function viewCommitDetail(commit: LogItem) {
  selectedCommit.value = commit
  commitDetailVisible.value = true
  isLoadingCommitDetail.value = true
  commitFiles.value = []
  commitDiff.value = ''
  selectedCommitFile.value = ''
  
  // 调试输出当前提交对象的所有属性
  console.log('提交详情对象:', JSON.stringify(commit, null, 2))
  console.log('哈希值类型和长度:', typeof commit.hash, commit.hash ? commit.hash.length : 0)
  console.log('提交信息类型和长度:', typeof commit.message, commit.message ? commit.message.length : 0)
  console.log('提交分支:', commit.branch)
  
  try {
    console.log(`获取提交详情: ${commit.hash}`)
    
    // 确保哈希值有效
    if (!commit.hash || commit.hash.length < 7) {
      console.error('无效的提交哈希值:', commit.hash)
      commitDiff.value = '无效的提交哈希值'
      isLoadingCommitDetail.value = false
      return
    }
    
    // 获取提交的变更文件列表
    const filesResponse = await fetch(`/api/commit-files?hash=${commit.hash}`)
    console.log('API响应状态: ', filesResponse.status)
    const filesData = await filesResponse.json()
    console.log('文件列表数据: ', filesData)
    
    if (filesData.success && Array.isArray(filesData.files)) {
      commitFiles.value = filesData.files
      
      // 如果有文件，自动加载第一个文件的差异
      if (commitFiles.value.length > 0) {
        await getCommitFileDiff(commit.hash, commitFiles.value[0])
      } else {
        console.log('没有找到变更文件')
        commitDiff.value = '该提交没有变更文件'
      }
    } else {
      console.error('获取提交文件列表失败:', filesData.error || '未知错误')
      commitDiff.value = `获取文件列表失败: ${filesData.error || '未知错误'}`
    }
  } catch (error) {
    console.error('获取提交详情失败:', error)
    commitDiff.value = `获取提交详情失败: ${(error as Error).message}`
  } finally {
    isLoadingCommitDetail.value = false
  }
}

// 获取提交中特定文件的差异
async function getCommitFileDiff(hash: string, filePath: string) {
  isLoadingCommitDetail.value = true
  selectedCommitFile.value = filePath
  
  try {
    console.log(`获取文件差异: hash=${hash}, file=${filePath}`)
    const diffResponse = await fetch(`/api/commit-file-diff?hash=${hash}&file=${encodeURIComponent(filePath)}`)
    console.log('差异API响应状态: ', diffResponse.status)
    const diffData = await diffResponse.json()
    console.log('差异数据: ', diffData.success, typeof diffData.diff)
    
    if (diffData.success) {
      commitDiff.value = diffData.diff || '没有变更内容'
    } else {
      console.error('获取差异失败: ', diffData.error)
      commitDiff.value = `获取差异失败: ${diffData.error || '未知错误'}`
    }
  } catch (error) {
    console.error('获取文件差异失败:', error)
    commitDiff.value = `获取差异失败: ${(error as Error).message}`
  } finally {
    isLoadingCommitDetail.value = false
  }
}

// 格式化差异内容，添加颜色
function formatDiff(diffText: string) {
  if (!diffText) return '';
  
  // 将差异内容按行分割
  const lines = diffText.split('\n');
  
  // 转义 HTML 标签的函数
  function escapeHtml(text: string) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
  
  // 为每行添加适当的 CSS 类
  return lines.map(line => {
    // 先转义 HTML 标签，再添加样式
    const escapedLine = escapeHtml(line);
    
    if (line.startsWith('diff --git')) {
      return `<div class="diff-header">${escapedLine}</div>`;
    } else if (line.startsWith('---')) {
      return `<div class="diff-old-file">${escapedLine}</div>`;
    } else if (line.startsWith('+++')) {
      return `<div class="diff-new-file">${escapedLine}</div>`;
    } else if (line.startsWith('@@')) {
      return `<div class="diff-hunk-header">${escapedLine}</div>`;
    } else if (line.startsWith('+')) {
      return `<div class="diff-added">${escapedLine}</div>`;
    } else if (line.startsWith('-')) {
      return `<div class="diff-removed">${escapedLine}</div>`;
    } else {
      return `<div class="diff-context">${escapedLine}</div>`;
    }
  }).join('');
}

// 格式化提交信息，支持多行显示
function formatCommitMessage(message: string) {
  if (!message) return '(无提交信息)';
  
  // 调试输出
  console.log('格式化前的提交信息:', message)
  console.log('提交信息中的换行符数量:', (message.match(/\n/g) || []).length)
  
  // 返回格式化后的提交信息，保留换行符
  return message.trim();
}
</script>

<template>
  <div class="card">
    <!-- 添加刷新提示，移到最外层 -->
    <div v-if="logRefreshed" class="refresh-notification">
      提交历史已刷新
    </div>
    
    <!-- 固定头部区域 -->
    <div class="log-header">
      <h2>提交历史</h2>
      <div class="log-actions">
        <el-button 
          type="primary" 
          size="small"
          @click="toggleViewMode"
        >
          <template #icon>
            <el-icon><component :is="showGraphView ? Document : TrendCharts" /></el-icon>
          </template>
          {{ showGraphView ? '表格视图' : '图表视图' }}
        </el-button>
        <el-button 
          type="primary" 
          size="small" 
          @click="toggleAllCommits" 
          :loading="isLoading"
        >
          <template #icon>
            <el-icon><component :is="showAllCommits ? List : More" /></el-icon>
          </template>
          {{ showAllCommits ? '显示最近30条' : '显示所有提交' }}
        </el-button>
        <el-button 
          circle 
          size="small" 
          @click="refreshLog()" 
          :loading="isLoading"
          :class="{ 'refresh-button-animated': logRefreshed }"
        >
          <el-icon><RefreshRight /></el-icon>
        </el-button>
      </div>
    </div>
    
    <!-- 内容区域，添加上边距以避免被固定头部遮挡 -->
    <div class="content-area">
      <div v-if="errorMessage">{{ errorMessage }}</div>
      <div v-else>
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
                circle
                size="small"
                @click="zoomOut"
                :disabled="graphScale <= minScale"
              >
                <el-icon><ZoomOut /></el-icon>
              </el-button>
              
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
                circle
                size="small"
                @click="zoomIn"
                :disabled="graphScale >= maxScale"
              >
                <el-icon><ZoomIn /></el-icon>
              </el-button>
              
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
          <div class="history-controls">
            <div class="history-stats">
              <el-tag type="info" effect="plain" size="large" class="record-count">
                <template #icon>
                  <el-icon><Document /></el-icon>
                </template>
                显示 {{ filteredLogs.length }}/{{ logs.length }} 条记录 
                <el-tag v-if="!showAllCommits" type="warning" size="small" effect="plain" style="margin-left: 5px">
                  最近30条
                </el-tag>
                <el-tag v-else type="success" size="small" effect="plain" style="margin-left: 5px">
                  全部
                </el-tag>
              </el-tag>
            </div>
            
            <div class="filter-actions">
              <el-button 
                :type="filterVisible ? 'primary' : 'default'"
                size="default" 
                @click="filterVisible = !filterVisible"
              >
                <template #icon>
                  <el-icon>
                    <Filter />
                  </el-icon>
                </template>
                筛选
                <el-badge v-if="filteredLogs.length !== logs.length" :value="filteredLogs.length" class="filter-badge" />
              </el-button>
            </div>
          </div>
          
          <!-- 筛选条件面板 -->
          <div v-if="filterVisible" class="filter-panel">
            <div class="filter-form">
              <div class="filter-item">
                <div class="filter-label">作者:</div>
                <el-select 
                  v-model="authorFilter" 
                  placeholder="选择作者" 
                  clearable 
                  filterable
                  class="filter-input"
                >
                  <el-option 
                    v-for="author in availableAuthors" 
                    :key="author" 
                    :label="author" 
                    :value="author"
                  />
                </el-select>
              </div>
              
              <div class="filter-item">
                <div class="filter-label">提交信息包含:</div>
                <el-input 
                  v-model="messageFilter" 
                  placeholder="关键词" 
                  clearable 
                  class="filter-input"
                />
              </div>
              
              <div class="filter-item">
                <div class="filter-label">日期范围:</div>
                <el-date-picker
                  v-model="dateRangeFilter"
                  type="daterange"
                  range-separator="至"
                  start-placeholder="开始日期"
                  end-placeholder="结束日期"
                  format="YYYY-MM-DD"
                  value-format="YYYY-MM-DD"
                  class="filter-input date-range"
                />
              </div>
              
              <div class="filter-actions">
                <el-button type="info" size="small" @click="resetFilters">重置</el-button>
              </div>
            </div>
          </div>
          
          <el-table :data="filteredLogs" style="width: 100%" stripe border v-loading="isLoading">
            <el-table-column label="提交哈希" width="100" resizable>
              <template #default="scope">
                <span class="commit-hash" @click="viewCommitDetail(scope.row)">{{ scope.row.hash.substring(0, 7) }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="date" label="日期" width="120" resizable />
            <el-table-column label="作者" width="120" resizable>
              <template #default="scope">
                <el-tooltip :content="scope.row.email" placement="top" :hide-after="1000">
                  <span class="author-name">{{ scope.row.author }}</span>
                </el-tooltip>
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

    <!-- 提交详情弹窗 -->
    <el-dialog
      v-model="commitDetailVisible"
      :title="`提交详情: ${selectedCommit?.hash ? selectedCommit.hash.substring(0, 7) : '未知'}`"
      width="80%"
      destroy-on-close
      class="commit-detail-dialog"
    >
      <div v-loading="isLoadingCommitDetail" class="commit-detail-container">
        <!-- 提交基本信息 -->
        <div v-if="selectedCommit" class="commit-info">
          <div class="commit-info-header">
            <div class="info-item">
              <span class="item-label">哈希:</span>
              <span class="item-value">{{ selectedCommit.hash }}</span>
            </div>
            <div class="info-item">
              <span class="item-label">作者:</span>
              <span class="item-value">{{ selectedCommit.author }} &lt;{{ selectedCommit.email }}&gt;</span>
            </div>
            <div class="info-item">
              <span class="item-label">日期:</span>
              <span class="item-value">{{ selectedCommit.date }}</span>
            </div>
          </div>
          <div class="commit-message-container">
            <div class="message-label">提交信息:</div>
            <div class="message-content" v-html="formatCommitMessage(selectedCommit.message).replace(/\n/g, '<br>')"></div>
          </div>
        </div>

        <!-- 变更文件列表和差异 -->
        <div class="commit-files-diff">
          <div class="files-list">
            <h3>变更文件</h3>
            <el-empty v-if="commitFiles.length === 0" description="没有找到变更文件"></el-empty>
            <ul v-else>
              <li 
                v-for="file in commitFiles" 
                :key="file"
                :class="{ 'active-file': file === selectedCommitFile }"
                @click="getCommitFileDiff(selectedCommit!.hash, file)"
              >
                {{ file }}
              </li>
            </ul>
          </div>
          <div class="file-diff">
            <h3 v-if="selectedCommitFile">文件差异: {{ selectedCommitFile }}</h3>
            <h3 v-else>文件差异</h3>
            <el-empty v-if="!commitDiff && !isLoadingCommitDetail" description="选择文件查看差异"></el-empty>
            <div v-else-if="commitDiff" v-html="formatDiff(commitDiff)" class="diff-content"></div>
          </div>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.card {
  background-color: white;
  border-radius: 8px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.03);
  height: 100%;
  display: flex;
  flex-direction: column;
  border: 1px solid rgba(0, 0, 0, 0.03);
  overflow: hidden;
}

.log-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0;
  padding: 16px 20px;
  background-color: white;
  border-bottom: 1px solid #f0f0f0;
  position: sticky;
  top: 0;
  z-index: 100;
}

.content-area {
  padding: 0 20px 20px 20px;
  overflow-y: auto;
  flex: 1;
}

/* 优化表格区域 */
.el-table {
  --el-table-border-color: #f0f0f0;
  --el-table-header-bg-color: #f8f9fa;
  border-radius: 4px;
  overflow: hidden;
}

/* 统一按钮间距 */
.log-actions {
  display: flex;
  gap: 12px;
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
  padding: 10px 15px;
  border-radius: 8px;
  font-size: 14px;
  border-left: 4px solid #67c23a;
  animation: fadeOut 2s forwards;
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 9999;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  max-width: 300px;
  text-align: center;
}

@keyframes pulse {
  0% { transform: scale(1); }
  50% { transform: scale(1.2); }
  100% { transform: scale(1); }
}

@keyframes fadeOut {
  0% { opacity: 0; transform: translateY(-20px); }
  20% { opacity: 1; transform: translateY(0); }
  80% { opacity: 1; }
  100% { opacity: 0; }
}

.author-name {
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: inline-block;
  max-width: 100%;
}

.commit-hash {
  cursor: pointer;
  color: #409EFF;
  font-family: monospace;
}

.commit-hash:hover {
  text-decoration: underline;
}

.commit-detail-container {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.commit-info {
  padding: 12px;
  background-color: #f5f7fa;
  border-radius: 8px;
  font-size: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.commit-info-header {
  display: flex;
  flex-wrap: wrap;
  gap: 15px;
  align-items: center;
  background-color: #fff;
  padding: 10px;
  border-radius: 4px;
  border: 1px solid #e4e7ed;
}

.info-item {
  display: flex;
  align-items: center;
  gap: 5px;
}

.item-label {
  font-weight: bold;
  color: #606266;
  white-space: nowrap;
}

.item-value {
  color: #333;
  word-break: break-all;
}

.commit-message-container {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.message-label {
  font-weight: bold;
  color: #606266;
}

.message-content {
  background-color: #fff;
  padding: 12px;
  border-radius: 4px;
  font-family: monospace;
  white-space: pre-wrap;
  border-left: 4px solid #409EFF;
  line-height: 1.5;
  border: 1px solid #e4e7ed;
  border-left: 4px solid #409EFF;
}

.commit-files-diff {
  margin-top: 5px;
  display: flex;
  gap: 20px;
  height: 60vh;
}

.files-list {
  width: 25%;
  overflow-y: auto;
  background-color: #f5f7fa;
  border-radius: 8px;
  padding: 10px;
}

.files-list h3 {
  margin-top: 0;
  padding-bottom: 10px;
  border-bottom: 1px solid #dcdfe6;
  font-size: 16px;
}

.files-list ul {
  list-style: none;
  padding: 0;
  margin: 0;
}

.files-list li {
  padding: 8px 10px;
  cursor: pointer;
  border-radius: 4px;
  margin-bottom: 5px;
  font-family: monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
}

.files-list li:hover {
  background-color: #ecf5ff;
}

.files-list li.active-file {
  background-color: #409eff;
  color: white;
}

.file-diff {
  flex: 1;
  display: flex;
  flex-direction: column;
  background-color: #f5f7fa;
  border-radius: 8px;
  padding: 10px;
  overflow: hidden;
}

.file-diff h3 {
  margin-top: 0;
  padding-bottom: 10px;
  border-bottom: 1px solid #dcdfe6;
  font-size: 16px;
}

.diff-content {
  flex: 1;
  overflow-y: auto;
  background-color: #fff;
  padding: 10px;
  border-radius: 4px;
  font-family: monospace;
  font-size: 13px;
  line-height: 1.5;
}

.diff-header {
  font-weight: bold;
  color: #409EFF;
}

.diff-old-file {
  color: #E6A23C;
}

.diff-new-file {
  color: #67C23A;
}

.diff-hunk-header {
  font-weight: bold;
  color: #409EFF;
}

.diff-added {
  background-color: #f0f9eb;
  color: #67C23A;
}

.diff-removed {
  background-color: #fef2f2;
  color: #F56C6C;
}

.diff-context {
  background-color: #f5f7fa;
}

/* 减小对话框的顶部边距 */
:deep(.commit-detail-dialog) {
  --el-dialog-margin-top: 5vh;
}

.history-controls {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 15px;
  padding: 0;
}

.history-stats {
  display: flex;
  align-items: center;
}

.record-count {
  display: flex;
  align-items: center;
  height: 36px;
  padding-left: 15px;
  padding-right: 15px;
}

.record-count :deep(.el-icon) {
  margin-right: 6px;
}

.filter-badge :deep(.el-badge__content) {
  background-color: #409EFF;
}

.filter-panel {
  background-color: #f5f7fa;
  border-radius: 8px;
  padding: 15px;
  margin-bottom: 15px;
  border: 1px solid #e4e7ed;
  box-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.05);
}

.filter-form {
  display: flex;
  flex-wrap: wrap;
  gap: 15px;
  align-items: flex-end;
}

.filter-item {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.filter-label {
  font-size: 13px;
  color: #606266;
  font-weight: bold;
}

.filter-input {
  width: 200px;
}

.filter-input.date-range {
  width: 350px;
}

.filter-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
</style>

/* 添加表格列调整样式 */
.el-table .el-table__cell .cell {
  word-break: break-all;
}