<script setup lang="ts">
import { ref, onMounted, computed, watch, onBeforeUnmount, nextTick } from 'vue'
import { 
  ElTable, 
  ElTableColumn, 
  ElTag, 
  ElButton, 
  ElSlider, 
  ElDialog, 
  ElSelect, 
  ElOption, 
  ElDatePicker, 
  ElInput, 
  ElBadge,
  ElMessage,
  ElMessageBox
} from 'element-plus'
import { RefreshRight, Loading, ZoomIn, ZoomOut, Filter, Document, TrendCharts, List, More } from '@element-plus/icons-vue'
import 'element-plus/dist/index.css'
import { createGitgraph } from '@gitgraph/js'
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
const gitStore = useGitStore()

// 获取日志数据
let logsData: LogItem[] = []
const logs = ref<LogItem[]>(logsData)
const errorMessage = ref('')
// 定义本地加载状态，而不是依赖于computed
const localLoading = ref(false)
const isLoading = computed(() => gitStore.isLoadingLog || localLoading.value)
const showAllCommits = ref(false)
const totalCommits = ref(0)
const showGraphView = ref(false)
const graphContainer = ref<HTMLElement | null>(null)

// 添加分页相关变量
const currentPage = ref(1)
const hasMoreData = ref(true)
const isLoadingMore = ref(false)
const loadTimerInterval = ref<number | null>(null)

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
const authorFilter = ref<string[]>([])
const messageFilter = ref('')
const dateRangeFilter = ref<any>(null)
const availableAuthors = ref<string[]>([])
// 添加分支筛选
const branchFilter = ref<string[]>([])
const availableBranches = ref<string[]>([])

// 添加右键菜单相关变量
const contextMenuVisible = ref(false)
const contextMenuTop = ref(0)
const contextMenuLeft = ref(0)
const selectedContextCommit = ref<LogItem | null>(null)

// 应用筛选后的日志
const filteredLogs = computed(() => {
  // 不再在前端进行筛选，直接使用加载的日志
  return logs.value;
})

// 加载提交历史
async function loadLog(all = false, page = 1) {
  // 从gitStore获取仓库状态
  const gitStore = useGitStore()
  
  // 检查是否是Git仓库
  if (!gitStore.isGitRepo) {
    errorMessage.value = '当前目录不是Git仓库'
    return
  }
  
  try {
    // 设置加载状态
    if (page > 1) {
      isLoadingMore.value = true
    } else {
      localLoading.value = true
    }
    
    console.log(`加载提交历史: page=${page}, all=${all}`)
    
    // 构建查询参数
    const queryParams = new URLSearchParams()
    queryParams.append('page', page.toString())
    queryParams.append('all', all.toString())
    
    // 添加筛选参数
    if (authorFilter.value.length > 0) {
      queryParams.append('author', authorFilter.value.join(','))
    }
    
    // 添加分支筛选参数
    if (branchFilter.value.length > 0) {
      queryParams.append('branch', branchFilter.value.join(','))
    }
    
    if (messageFilter.value) {
      queryParams.append('message', messageFilter.value)
    }
    
    if (dateRangeFilter.value && Array.isArray(dateRangeFilter.value) && dateRangeFilter.value.length === 2) {
      queryParams.append('dateFrom', dateRangeFilter.value[0])
      queryParams.append('dateTo', dateRangeFilter.value[1])
    }
    
    // 添加时间戳防止缓存
    queryParams.append('_t', Date.now().toString())
    
    const response = await fetch(`/api/log?${queryParams.toString()}`)
    const result = await response.json()
    
    // 确保result有正确的数据结构
    if (!result || !result.data || !Array.isArray(result.data)) {
      console.error('API返回的数据格式不正确:', result)
      errorMessage.value = '加载提交历史失败: 服务器返回数据格式不正确'
      return
    }
    
    const isLoadMore = page > 1
    
    // 处理结果
    // 如果是加载更多，追加数据，否则替换数据
    if (isLoadMore) {
      result.data.forEach((item: LogItem) => logsData.push(item))
    } else {
      logsData.length = 0
      result.data.forEach((item: LogItem) => logsData.push(item))
    }
    
    // 强制重新渲染列表
    logs.value = [...logsData]
    
    // 更新当前页码
    currentPage.value = page
    
    // 更新总数和分页标记
    totalCommits.value = result.total || logsData.length
    hasMoreData.value = result.hasMore === true
    
    if (!hasMoreData.value) {
      console.log('已加载所有提交记录')
    }
    
    // 设置刷新提示状态（仅在初次加载时）
    if (!isLoadMore) {
      logRefreshed.value = true
      // 2秒后隐藏提示
      setTimeout(() => { logRefreshed.value = false }, 2000)
    }
    
    // 加载完数据后渲染图表（仅在初次加载时）
    if (!isLoadMore && showGraphView.value) {
      setTimeout(renderGraph, 0)
    }
    
    errorMessage.value = ''
  } catch (error) {
    errorMessage.value = '加载提交历史失败: ' + (error instanceof Error ? error.message : String(error))
    console.error('加载日志失败:', error)
    
    // 如果加载更多失败，标记没有更多数据
    if (page > 1) {
      hasMoreData.value = false
    }
  } finally {
    // 重置加载状态
    if (page > 1) {
      isLoadingMore.value = false
    } else {
      localLoading.value = false
    }
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

// 添加对表格实例的引用
const tableRef = ref<InstanceType<typeof ElTable> | null>(null)
const tableBodyWrapper = ref<HTMLElement | null>(null)

// 监听表格滚动事件的处理函数
function handleTableScroll(event: Event) {
  if (showGraphView.value || !hasMoreData.value || isLoadingMore.value || isLoading.value) {
    return
  }
  
  const target = event.target as HTMLElement
  const { scrollTop, scrollHeight, clientHeight } = target
  const scrollDistance = scrollHeight - scrollTop - clientHeight
  
  // 调试信息
  console.log('表格滚动:', {
    scrollTop,
    scrollHeight,
    clientHeight,
    scrollDistance
  })
  
  // 当滚动到距离底部20px时触发加载
  if (scrollDistance <= 20) {
    console.log('已滚动到底部，加载更多数据')
    loadMoreLogs()
  }
}

// 设置表格滚动监听
function setupTableScrollListener() {
  if (!tableRef.value) return
  
  // 获取表格的body-wrapper
  tableBodyWrapper.value = tableRef.value.$el.querySelector('.el-table__body-wrapper')
  
  if (tableBodyWrapper.value) {
    console.log('添加表格滚动监听')
    tableBodyWrapper.value.addEventListener('scroll', handleTableScroll, true)
  } else {
    console.error('未找到表格的body-wrapper元素')
  }
}

// 移除表格滚动监听
function removeTableScrollListener() {
  if (tableBodyWrapper.value) {
    console.log('移除表格滚动监听')
    tableBodyWrapper.value.removeEventListener('scroll', handleTableScroll, true)
    tableBodyWrapper.value = null
  }
}

onMounted(() => {
  // 检查gitStore中是否已有数据
  if (gitStore.isGitRepo) {
    if (gitStore.log.length > 0) {
      // 如果已经有数据，直接使用现有数据
      console.log('使用已加载的日志数据')
      
      // 清空并填充logsData
      logsData.length = 0
      gitStore.log.forEach(item => logsData.push(item))
      
      // 由于TypeScript类型错误，我们直接设置totalCommits而不是使用logs.value.length
      totalCommits.value = gitStore.log.length
      
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
    
    // 加载所有可能的作者列表
    fetchAllAuthors()
    
    // 不再在这里直接设置 availableBranches，改为通过 watch 监听 gitStore.allBranches 的变化
  } else {
    errorMessage.value = '当前目录不是Git仓库'
  }
  
  // 在下一个tick中设置表格滚动监听
  nextTick(() => {
    setTimeout(() => {
      setupTableScrollListener()
    }, 500) // 给表格足够的时间来渲染
  })
})

// 添加对 gitStore.allBranches 的监听
watch(() => gitStore.allBranches, (newBranches) => {
  if (newBranches && newBranches.length > 0) {
    availableBranches.value = [...newBranches].sort()
    console.log(`分支数据更新，共 ${availableBranches.value.length} 个分支`)
  } else {
    availableBranches.value = []
    console.warn('gitStore 中没有分支数据')
  }
}, { immediate: true }) // immediate: true 确保组件创建时立即执行一次

onBeforeUnmount(() => {
  // 清除表格滚动监听
  removeTableScrollListener()
  
  // 清除定时器
  if (loadTimerInterval.value !== null) {
    window.clearInterval(loadTimerInterval.value)
    loadTimerInterval.value = null
  }
})

// 刷新日志的方法
async function refreshLog(loadAll = false) {
  // 简单调用gitStore的fetchLog方法
  await gitStore.fetchLog(true)
  
  // 重新填充本地数据
  logsData.length = 0
  gitStore.log.forEach(item => logsData.push(item))
  
  // 触发视图更新
  logs.value = [...logsData]
  
  // 设置总条数
  totalCommits.value = gitStore.log.length
  
  // 重置分页状态
  currentPage.value = 1
  hasMoreData.value = false // 使用API直接加载全部日志时，没有更多数据
  
  // 设置刷新提示
  logRefreshed.value = true
  // 2秒后隐藏提示
  setTimeout(() => { logRefreshed.value = false }, 2000)
  
  // 如果当前是图表视图，刷新图表
  if (showGraphView.value) {
    await nextTick()
    renderGraph()
  }
}

// 监听store中的日志变化
watch(() => gitStore.log, (newLogs) => {
  console.log('监听到gitStore.log变化，更新图表数据')
  
  try {
    // 清空logsData
    logsData.length = 0
    
    // 重新填充数据，使用类型断言
    if (Array.isArray(newLogs)) {
      // @ts-ignore - 忽略类型校验
      newLogs.forEach(item => item && logsData.push(item))
    }
    
    // 更新计数器
    totalCommits.value = logsData.length
    
    // 重置当前页为第1页
    currentPage.value = 1
    
    // 确保引用更新，触发UI重渲染
    // @ts-ignore - 忽略类型校验
    logs.value = [...logsData]
    
    // 设置刷新提示
    logRefreshed.value = true
    setTimeout(() => { logRefreshed.value = false }, 2000)
    
    console.log(`数据更新完成，共${logs.value.length}条记录，准备渲染图表`)
    
    if (showGraphView.value && logsData.length > 0) {
      setTimeout(renderGraph, 0)
    }
  } catch (error) {
    console.error('更新日志数据失败:', error)
  }
}, { immediate: true })

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
async function viewCommitDetail(commit: LogItem | null) {
  if (!commit) return
  
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

// 加载更多日志
function loadMoreLogs() {
  if (!hasMoreData.value || isLoadingMore.value || isLoading.value) return
  
  console.log(`加载更多日志，页码: ${currentPage.value + 1}`)
  loadLog(showAllCommits.value, currentPage.value + 1)
}

// 重置筛选条件并重新加载数据
function resetFilters() {
  authorFilter.value = []
  branchFilter.value = []
  messageFilter.value = ''
  dateRangeFilter.value = null
  
  // 重置筛选后重新加载数据
  currentPage.value = 1
  loadLog(showAllCommits.value, 1)
}

// 应用筛选条件
function applyFilters() {
  // 应用筛选时重置到第一页
  currentPage.value = 1
  loadLog(showAllCommits.value, 1)
}

// 添加获取所有作者的函数
async function fetchAllAuthors() {
  try {
    console.log('获取所有可用作者...')
    const response = await fetch('/api/authors')
    const result = await response.json()
    
    if (result.success && Array.isArray(result.authors)) {
      // 更新可用作者列表
      availableAuthors.value = result.authors.sort()
      console.log(`获取到${availableAuthors.value.length}位作者`)
    } else {
      // 如果获取作者列表失败，但正常获取了日志
      // 从当前加载的日志中提取作者列表作为备选
      console.warn('从API获取作者列表失败，将从现有日志中提取作者列表')
      extractAuthorsFromLogs()
    }
  } catch (error) {
    console.error('获取作者列表失败:', error)
    // 从当前加载的日志中提取作者列表作为备选
    extractAuthorsFromLogs()
  }
}

// 从已加载的日志中提取作者列表
function extractAuthorsFromLogs() {
  const authors = new Set<string>()
  logs.value.forEach(log => {
    if (log.author) {
      authors.add(log.author)
    }
  })
  availableAuthors.value = Array.from(authors).sort()
  console.log(`从现有日志中提取了${availableAuthors.value.length}位作者`)
}

// // 添加获取所有分支的函数
// async function fetchAllBranches() {
//   try {
//     console.log('获取所有可用分支...')
    
//     // 直接调用 gitStore 中的方法获取分支列表
//     await gitStore.getAllBranches()
    
//     // 从 gitStore 中获取分支列表
//     if (gitStore.allBranches.length > 0) {
//       // 更新可用分支列表
//       availableBranches.value = [...gitStore.allBranches].sort()
//       console.log(`获取到${availableBranches.value.length}个分支`)
//     } else {
//       console.warn('gitStore中没有分支数据')
//     }
//   } catch (error) {
//     console.error('获取分支列表失败:', error)
//     extractBranchesFromLogs()
//   }
// }



// 处理右键菜单事件
function handleContextMenu(row: LogItem, column: any, event: MouseEvent) {
  console.log('handleContextMenu', row, column, event)
  // 阻止默认右键菜单
  event.preventDefault()
  
  // 设置右键菜单位置
  contextMenuTop.value = event.clientY
  contextMenuLeft.value = event.clientX
  
  // 设置选中的提交
  selectedContextCommit.value = row
  
  // 显示右键菜单
  contextMenuVisible.value = true
  
  // 点击其他地方时隐藏菜单
  const hideContextMenu = () => {
    contextMenuVisible.value = false
    document.removeEventListener('click', hideContextMenu)
  }
  
  // 添加点击监听器
  setTimeout(() => {
    document.addEventListener('click', hideContextMenu)
  }, 0)
}

// 撤销提交 (Revert)
async function revertCommit(commit: LogItem | null) {
  if (!commit) return
  
  try {
    // 询问确认
    await ElMessageBox.confirm(
      `确定要撤销提交 ${commit.hash.substring(0, 7)} 吗？这将创建一个新的提交来撤销这次提交的更改。`,
      '撤销提交确认',
      {
        confirmButtonText: '确认',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
    
    // 发送请求
    const response = await fetch('/api/revert-commit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ hash: commit.hash })
    })
    
    const result = await response.json()
    
    if (result.success) {
      ElMessage.success(result.message || '已成功撤销提交')
      // 刷新日志
      refreshLog()
      // 刷新Git状态
      gitStore.fetchStatus()
      // 添加: 刷新分支状态
      gitStore.getBranchStatus()
    } else {
      ElMessage.error(result.error || '撤销提交失败')
    }
  } catch (error: any) {
    if (error !== 'cancel') {
      console.error('撤销提交出错:', error)
      ElMessage.error('撤销提交失败: ' + (error.message || error))
    }
  }
}

// Cherry-pick提交
async function cherryPickCommit(commit: LogItem | null) {
  if (!commit) return
  
  try {
    // 询问确认
    await ElMessageBox.confirm(
      `确定要将提交 ${commit.hash.substring(0, 7)} Cherry-Pick 到当前分支吗？`,
      'Cherry-Pick确认',
      {
        confirmButtonText: '确认',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
    
    // 发送请求
    const response = await fetch('/api/cherry-pick-commit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ hash: commit.hash })
    })
    
    const result = await response.json()
    
    if (result.success) {
      ElMessage.success(result.message || '已成功Cherry-Pick提交')
      // 刷新日志
      refreshLog()
      // 刷新Git状态
      gitStore.fetchStatus()
      // 添加: 刷新分支状态
      gitStore.getBranchStatus()
    } else {
      ElMessage.error(result.error || 'Cherry-Pick提交失败')
    }
  } catch (error: any) {
    if (error !== 'cancel') {
      console.error('Cherry-Pick提交出错:', error)
      ElMessage.error('Cherry-Pick提交失败: ' + (error.message || error))
    }
  }
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
      <div class="header-left">
        <h2>提交历史</h2>
        <!-- <el-tag type="info" effect="plain" size="small" class="record-count" v-if="!showGraphView">
          <template #icon>
            <el-icon><Document /></el-icon>
          </template>
          {{ filteredLogs.length }}/{{ logs.length }}
          <el-tag v-if="!showAllCommits" type="warning" size="small" effect="plain" style="margin-left: 5px">
            分页加载 (每页100条)
          </el-tag>
          <el-tag v-else type="success" size="small" effect="plain" style="margin-left: 5px">
            全部
          </el-tag>
        </el-tag> -->
      </div>
      
      <div class="log-actions">
        <!-- 筛选按钮移到这里 -->
        <el-button
          v-if="!showGraphView" 
          :type="filterVisible ? 'primary' : 'default'"
          size="small" 
          @click="filterVisible = !filterVisible"
        >
          <template #icon>
            <el-icon><Filter /></el-icon>
          </template>
          筛选
          <el-badge v-if="filteredLogs.length !== logs.length" :value="filteredLogs.length" class="filter-badge" />
        </el-button>
        
        <!-- 原有的按钮 -->
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
          {{ showAllCommits ? '显示分页加载 (每页100条)' : '显示所有提交' }}
        </el-button>
        <el-button 
          circle 
          size="small" 
          @click="refreshLog()" 
          :class="{ 'refresh-button-animated': logRefreshed }"
        >
          <template v-if="!isLoading">
            <el-icon><RefreshRight /></el-icon>
          </template>
          <template v-else>
            <el-icon><Loading /></el-icon>
          </template>
        </el-button>
      </div>
    </div>
    
    <!-- 筛选面板放在头部下方，但在内容区域之前 -->
    <div v-if="filterVisible && !showGraphView" class="filter-panel-header">
      <div class="filter-form">
        <div class="filter-item">
          <div class="filter-label">作者:</div>
          <el-select 
            v-model="authorFilter" 
            placeholder="选择作者" 
            multiple
            clearable 
            filterable
            class="filter-input"
            size="small"
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
          <div class="filter-label">分支:</div>
          <el-select 
            v-model="branchFilter" 
            placeholder="选择分支" 
            multiple
            clearable 
            filterable
            class="filter-input"
            size="small"
          >
            <el-option 
              v-for="branch in availableBranches" 
              :key="branch" 
              :label="branch" 
              :value="branch"
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
            size="small"
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
            size="small"
          />
        </div>
        
        <div class="filter-actions">
          <el-button type="primary" size="small" @click="applyFilters">应用筛选</el-button>
          <el-button type="info" size="small" @click="resetFilters">重置</el-button>
        </div>
      </div>
    </div>
    
    <!-- 内容区域，添加上边距以避免被固定头部遮挡 -->
    <div class="content-area" :class="{'with-filter': filterVisible && !showGraphView}">
      <div v-if="errorMessage">{{ errorMessage }}</div>
      <div v-else>
        <!-- 图表视图 -->
        <div v-if="showGraphView" class="graph-view">
          <div class="commit-count" v-if="logsData.length > 0">
            显示 {{ logsData.length }} 条提交记录 {{ showAllCommits ? '(全部)' : '(分页加载，每页100条)' }}
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
        <div v-else class="table-view-container">
                              <el-table             ref="tableRef"            :data="filteredLogs"             stripe             border             v-loading="isLoading"            class="log-table"            :empty-text="isLoading ? '加载中...' : '没有匹配的提交记录'"            height="500"            @row-contextmenu="handleContextMenu"          >
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
          
          <!-- 添加底部加载状态和加载更多按钮 -->
          <div v-if="!showAllCommits" class="load-more-container">
            <!-- 显示加载状态和页码信息 -->
            <div class="pagination-info">
              <span>第 {{ currentPage }} 页 {{ totalCommits > 0 ? `/ 共 ${Math.ceil(totalCommits / 100) || 1} 页` : '' }} (总计 {{ totalCommits }} 条记录)</span>
            </div>
            
            <div v-if="isLoadingMore" class="loading-more">
              <div class="loading-spinner"></div>
              <span>加载更多...</span>
            </div>
            <div v-else-if="hasMoreData" class="load-more-button" @click="loadMoreLogs">
              <span>加载更多</span>
            </div>
            <div v-else class="no-more-data">
              <span>没有更多数据了</span>
              <span v-if="logs.length > 0" class="total-loaded">（已加载 {{ logs.length }} 条记录）</span>
            </div>
          </div>
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
          </el-dialog>    </div>        <!-- 添加右键菜单 -->    <div       v-show="contextMenuVisible"       class="context-menu"       :style="{ top: contextMenuTop + 'px', left: contextMenuLeft + 'px' }"    >      <div class="context-menu-item" @click="viewCommitDetail(selectedContextCommit)">        <i class="el-icon-view"></i> 查看详情      </div>      <div class="context-menu-item" @click="revertCommit(selectedContextCommit)">        <i class="el-icon-delete"></i> 撤销提交 (Revert)      </div>      <div class="context-menu-item" @click="cherryPickCommit(selectedContextCommit)">        <i class="el-icon-edit"></i> Cherry-Pick 到当前分支      </div>    </div></template><style scoped>
.card {
  background-color: white;
  border-radius: 8px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.03);
  height: 100%;
  width: 100%;
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
  padding: 8px 16px;
  background-color: white;
  border-bottom: 1px solid #f0f0f0;
  position: sticky;
  top: 0;
  z-index: 100;
  height: 36px;
  flex-shrink: 0; /* 防止头部被压缩 */
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.log-header h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 500;
}

.log-actions {
  display: flex;
  gap: 8px;
}

.content-area {
  padding: 10px 0;
  flex: 1;
  min-height: 100px;
  height: calc(100% - 52px);
  display: flex;
  flex-direction: column;
}

.content-area.with-filter {
  height: calc(100% - 52px - 60px); /* 减去header高度和filter高度 */
}

/* 确保内容区域内的直接子元素占满高度 */
.content-area > div {
  flex: 1;
  display: flex;
  flex-direction: column;
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

.graph-view {
  width: 100%;
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.graph-container {
  width: 100%;
  flex: 1;
  min-height: 500px;
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
  --el-dialog-margin-top: 7vh;
}

.history-controls {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 15px;
  padding: 0;
  position: sticky;
  top: 52px; /* 与 log-header 的高度匹配 */
  z-index: 90;
  background-color: white;
  padding: 5px 0;
  transition: box-shadow 0.3s ease, background-color 0.3s ease, padding 0.2s ease;
}

/* 当滚动时添加微妙的阴影效果 */
.content-area:not(:hover) .history-controls:not(:hover) {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
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
  position: sticky;
  top: 98px; /* history-controls的高度(36px) + padding(10px) + log-header的高度(52px) */
  z-index: 89; /* 比history-controls低一点 */
  transition: box-shadow 0.3s ease, background-color 0.3s ease, transform 0.2s ease;
}

/* 当滚动时增强视觉效果 */
.content-area:not(:hover) .filter-panel:not(:hover) {
  box-shadow: 0 3px 16px rgba(0, 0, 0, 0.1);
}

.filter-panel:hover {
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
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

/* 表格样式 */
.log-table {
  transition: margin-top 0.3s ease;
  min-height: 200px; /* 确保表格有最小高度 */
  height: 100%; /* 填充可用空间 */
}

/* 为带筛选面板的表格添加顶部边距 */
.log-table.has-filter {
  margin-top: 10px;
}

/* 当控件固定时增加表格上边距 */
.log-table.has-sticky-controls {
  margin-top: 52px !important; /* controls 高度 + 一些额外空间 */
}

/* 当筛选面板固定时再增加表格上边距 */
.log-table.has-sticky-filter {
  margin-top: 140px !important; /* 筛选面板高度 + controls 高度 + 一些额外空间 */
}

/* 表格为空时的样式 */
.el-table__empty-block {
  min-height: 200px;
  justify-content: center;
  align-items: center;
}

/* 确保表格容器占满可用空间 */
.content-area > div:not(.graph-view) {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* 表格视图容器 */
.table-view-container {
  display: flex;
  flex-direction: column;
  flex: 1;
  height: 100%;
  overflow-y: auto;
}

.log-table {
  width: 100%;
  flex: 1;
}

/* 表格容器样式 */
.table-view-container .el-table {
  flex: 1;
  width: 100%;
}

.table-view-container .el-table__inner-wrapper {
  width: 100%;
}

.table-view-container .el-table__body-wrapper {
  width: 100%;
}

.filter-panel.filter-sticky {
  background-color: rgba(245, 247, 250, 0.97);
  backdrop-filter: blur(4px);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.12);
  border-top: none;
}

.history-controls.controls-sticky {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  background-color: rgba(255, 255, 255, 0.98);
  backdrop-filter: blur(4px);
  padding: 8px 0;
  border-bottom: 1px solid rgba(0, 0, 0, 0.05);
}

/* 筛选面板头部样式 */
.filter-panel-header {
  background-color: #f5f7fa;
  padding: 10px 16px;
  border-bottom: 1px solid #e4e7ed;
  position: sticky;
  top: 36px; /* 紧贴log-header下方 */
  z-index: 99;
  transition: all 0.3s ease;
  flex-shrink: 0;
  margin-bottom: 0; /* 移除底部边距 */
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
}

.filter-panel-header .filter-form {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-end;
  justify-content: flex-start;
}

.filter-panel-header .filter-item {
  margin-right: 12px;
}

.filter-panel-header .filter-label {
  font-size: 12px;
  color: #606266;
  margin-bottom: 4px;
}

.filter-panel-header .filter-input {
  width: 180px;
}

.filter-panel-header .filter-input.date-range {
  width: 320px;
}

.content-area.with-filter {
  height: calc(100% - 52px - 60px); /* 减去header高度和filter高度 */
}

/* 记录计数标签 */
.record-count {
  display: flex;
  align-items: center;
  height: 24px;
  padding-left: 8px;
  padding-right: 8px;
  margin-left: 8px;
}

.record-count :deep(.el-icon) {
  margin-right: 4px;
  font-size: 12px;
}

/* 表格视图容器简化 */
.table-view-container {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 400px; /* 确保至少有一定高度 */
}

.log-table {
  width: 100%;
  height: 100%;
  min-height: 300px;
  flex: 1;
}

/* 重置或移除不再需要的样式 */
.history-controls,
.filter-panel {
  display: none; /* 隐藏原来的筛选组件 */
}

.log-table.has-filter,
.log-table.has-sticky-controls,
.log-table.has-sticky-filter {
  margin-top: 0 !important; /* 重置原来的边距 */
}

/* 添加底部加载更多相关样式 */
.load-more-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 15px 0;
  border-top: 1px dashed #ebeef5;
  gap: 10px;
  display: none;
}

.pagination-info {
  font-size: 13px;
  color: #909399;
  margin-bottom: 5px;
}

.loading-more {
  display: flex;
  align-items: center;
  color: #909399;
  font-size: 14px;
}

.loading-spinner {
  width: 20px;
  height: 20px;
  margin-right: 10px;
  border: 2px solid #dcdfe6;
  border-top-color: #409eff;
  border-radius: 50%;
  animation: spinner 1s linear infinite;
}

@keyframes spinner {
  to {transform: rotate(360deg);}
}

.load-more-button {
  cursor: pointer;
  color: #409eff;
  font-size: 14px;
  padding: 6px 16px;
  border: 1px solid #d9ecff;
  background-color: #ecf5ff;
  border-radius: 4px;
  transition: all 0.3s;
}

.load-more-button:hover {
  background-color: #d9ecff;
}

.no-more-data {
  color: #909399;
  font-size: 14px;
  font-style: italic;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.total-loaded {
  font-size: 12px;
  margin-top: 5px;
  color: #c0c4cc;
}

/* 右键菜单样式 */
.context-menu {
  position: fixed;
  background: white;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  box-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.1);
  padding: 8px 0;
  z-index: 3000;
  min-width: 180px;
}

.context-menu-item {
  padding: 8px 16px;
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: center;
}

.context-menu-item:hover {
  background-color: #f5f7fa;
}

.context-menu-item i {
  margin-right: 8px;
}
</style>

/* 添加表格列调整样式 */
<style>
.el-table .el-table__cell .cell {
  word-break: break-all;
}
</style>