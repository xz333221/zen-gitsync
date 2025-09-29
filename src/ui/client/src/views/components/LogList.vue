<script setup lang="ts">
import {
  ref,
  onMounted,
  computed,
  watch,
  onBeforeUnmount,
  nextTick,
} from "vue";
import {
  ElTable,
  ElTableColumn,
  ElTag,
  ElButton,
  ElSlider,
  ElSelect,
  ElOption,
  ElDatePicker,
  ElInput,
  ElMessage,
  ElMessageBox,
} from "element-plus";
import {
  RefreshRight,
  Loading,
  ZoomIn,
  ZoomOut,
  Filter,
  Document,
  TrendCharts,
  List,
  More,
  FullScreen,
  Close,
  CopyDocument,
} from "@element-plus/icons-vue";
import "element-plus/dist/index.css";
import { createGitgraph } from "@gitgraph/js";
import { useGitStore } from "@stores/gitStore";
import { formatCommitMessage, extractPureMessage } from "@utils/index.ts";
import FileDiffViewer from "@components/FileDiffViewer.vue";
import CommonDialog from "@components/CommonDialog.vue";

// const COLORS = [
//   "#2196f3", // 蓝色
//   "#e91e63", // 粉色
//   "#4caf50", // 绿色
//   "#ff9800", // 橙色
//   "#9c27b0", // 紫色
//   "#00bcd4", // 青色
//   "#ff5722", // 深橙色
//   "#607d8b", // 蓝灰色
// ];

interface LogItem {
  hash: string;
  date: string;
  author: string;
  email: string;
  message: string;
  branch?: string;
  parents?: string[];
}

// 使用Git状态和日志Store
const gitStore = useGitStore();

// 获取日志数据
let logsData: LogItem[] = [];
const logs = ref<LogItem[]>(logsData);
const errorMessage = ref("");
// 定义本地加载状态，而不是依赖于computed
const localLoading = ref(false);
const isLoading = computed(() => gitStore.isLoadingLog || localLoading.value);
const showAllCommits = ref(false);
const totalCommits = ref(0);
const showGraphView = ref(false);
const graphContainer = ref<HTMLElement | null>(null);

// 添加分页相关变量
const currentPage = ref(1);
const hasMoreData = ref(true); // 默认为true，确保初始化时能尝试加载更多
const isLoadingMore = ref(false);
const loadTimerInterval = ref<number | null>(null);

// 添加提交详情弹窗相关变量
const commitDetailVisible = ref(false);
const selectedCommit = ref<LogItem | null>(null);
const commitFiles = ref<string[]>([]);
const commitDiff = ref("");
const isLoadingCommitDetail = ref(false);
const selectedCommitFile = ref("");



// 添加图表缩放控制
const graphScale = ref(1);
const minScale = 0.5;
const maxScale = 1.5;
const scaleStep = 0.1;

// 添加日志被刷新的提示状态
const logRefreshed = ref(false);

// 添加筛选相关变量
const filterVisible = ref(false);
const authorFilter = ref<string[]>([]);
const messageFilter = ref("");
const dateRangeFilter = ref<any>(null);
const availableAuthors = ref<string[]>([]);
// 添加分支筛选
const branchFilter = ref<string[]>([]);
const availableBranches = ref<string[]>([]);

// 添加右键菜单相关变量
const contextMenuVisible = ref(false);
const contextMenuTop = ref(0);
const contextMenuLeft = ref(0);
const selectedContextCommit = ref<LogItem | null>(null);



// 应用筛选后的日志
const filteredLogs = computed(() => {
  // 不再在前端进行筛选，直接使用加载的日志
  return logs.value;
});

// 为提交组件准备文件列表
const commitFilesForViewer = computed(() => {
  return commitFiles.value.map(file => ({
    path: file,
    name: file.split('/').pop() || file
  }));
});

// 加载提交历史
async function loadLog(all = false, page = 1) {
  // 从gitStore获取仓库状态
  const gitStore = useGitStore();

  // 检查是否是Git仓库
  if (!gitStore.isGitRepo) {
    errorMessage.value = "当前目录不是Git仓库";
    return;
  }

  try {
    // 设置加载状态
    if (page > 1) {
      isLoadingMore.value = true;
    } else {
      localLoading.value = true;
    }

    // 构建查询参数
    const queryParams = new URLSearchParams();
    queryParams.append("page", page.toString());
    queryParams.append("all", all.toString());
    queryParams.append("with_parents", "true"); // 添加参数请求父提交信息

    // 添加筛选参数
    if (authorFilter.value.length > 0) {
      queryParams.append("author", authorFilter.value.join(","));
    }

    // 添加分支筛选参数
    if (branchFilter.value.length > 0) {
      queryParams.append("branch", branchFilter.value.join(","));
    }

    if (messageFilter.value) {
      queryParams.append("message", messageFilter.value);
    }

    if (
      dateRangeFilter.value &&
      Array.isArray(dateRangeFilter.value) &&
      dateRangeFilter.value.length === 2
    ) {
      queryParams.append("dateFrom", dateRangeFilter.value[0]);
      queryParams.append("dateTo", dateRangeFilter.value[1]);
    }

    // 添加时间戳防止缓存
    queryParams.append("_t", Date.now().toString());

    const response = await fetch(`/api/log?${queryParams.toString()}`);
    const result = await response.json();

    // 确保result有正确的数据结构
    if (!result || !result.data || !Array.isArray(result.data)) {
      errorMessage.value = "加载提交历史失败: 服务器返回数据格式不正确";
      return;
    }

    const isLoadMore = page > 1;

    // 处理结果
    // 如果是加载更多，追加数据，否则替换数据
    if (isLoadMore) {
      result.data.forEach((item: LogItem) => logsData.push(item));
    } else {
      logsData.length = 0;
      result.data.forEach((item: LogItem) => logsData.push(item));
    }

    // 强制重新渲染列表
    logs.value = [...logsData];

    // 更新当前页码
    currentPage.value = page;

    // 更新总数和分页标记
    totalCommits.value = result.total || logsData.length;
    hasMoreData.value = result.hasMore === true;

    // 设置刷新提示状态（仅在初次加载时）
    if (!isLoadMore) {
      logRefreshed.value = true;
      // 2秒后隐藏提示
      setTimeout(() => {
        logRefreshed.value = false;
      }, 2000);
    }

    // 加载完数据后渲染图表（仅在初次加载时）
    if (!isLoadMore && showGraphView.value) {
      setTimeout(renderGraph, 0);
    } else if (!isLoadMore && !showGraphView.value && !all) {
      // 如果是表格视图且是分页模式，设置滚动监听并检查是否需要加载更多
      nextTick(() => {
        setupTableScrollListener();
        setTimeout(checkAndLoadMore, 200);
      });
    }

    errorMessage.value = "";
  } catch (error) {
    errorMessage.value =
      "加载提交历史失败: " +
      (error instanceof Error ? error.message : String(error));

    // 如果加载更多失败，标记没有更多数据
    if (page > 1) {
      hasMoreData.value = false;
    }
  } finally {
    // 重置加载状态
    if (page > 1) {
      isLoadingMore.value = false;
    } else {
      localLoading.value = false;
    }
  }
}

// 渲染Git图表
async function renderGraph() {
  if (!graphContainer.value) {
    return;
  }

  if (logsData.length === 0) {
    return;
  }

  try {
    // 清空容器
    graphContainer.value.innerHTML = "";

    // 创建gitgraph实例
    const gitgraph = createGitgraph(graphContainer.value, {
      // 自定义选项
      orientation: "vertical-reverse" as any, // 使用类型断言解决类型错误
      template: "metro" as any, // 使用类型断言解决类型错误
      author: "提交者 <committer@example.com>",
    });

    // 处理分支和提交数据
    const branches: Record<string, any> = {};
    const mainBranch = gitgraph.branch(gitStore.currentBranch || "main");
    branches[gitStore.currentBranch || "main"] = mainBranch;

    // 简化示例 - 实际实现需要根据API返回的数据结构调整
    logsData.forEach((commit) => {
      // 这里需要根据实际数据结构构建分支图
      let currentBranch = mainBranch;

      // 如果有分支信息，使用对应的分支
      if (commit.branch) {
        const branchName = formatBranchName(commit.branch.split(",")[0]);
        if (!branches[branchName]) {
          branches[branchName] = gitgraph.branch(branchName);
        }
        currentBranch = branches[branchName];
      }

      // 创建提交，添加邮箱信息
      currentBranch.commit({
        hash: commit.hash,
        subject: commit.message,
        author: `${commit.author} <${commit.email}>`,
      });
    });

    // 确保渲染完成后调用自适应缩放
    setTimeout(() => {
      fitGraphToContainer();
    }, 100);
  } catch (error) {
    errorMessage.value =
      "渲染图表失败: " +
      (error instanceof Error ? error.message : String(error));
  }
}

// 切换视图模式
function toggleViewMode() {
  showGraphView.value = !showGraphView.value;
  if (showGraphView.value && logsData.length > 0) {
    // 延迟执行以确保DOM已更新
    setTimeout(renderGraph, 0);
  }
}

// 切换显示所有提交
function toggleAllCommits() {
  showAllCommits.value = !showAllCommits.value;
  
  // 如果切换到分页模式，重置hasMoreData为true
  if (!showAllCommits.value) {
    hasMoreData.value = true;
  }
  
  // 重置当前页码
  currentPage.value = 1;
  
  // 加载日志
  loadLog(showAllCommits.value);
  
  // 确保在下一个渲染周期重新设置滚动监听
  nextTick(() => {
    setTimeout(() => {
      if (!showGraphView.value && !showAllCommits.value) {
        setupTableScrollListener();
        checkAndLoadMore(); // 检查是否需要加载更多
      }
    }, 300);
  });
}

// 格式化分支名（实现该函数，因为在模板中调用了）
function formatBranchName(ref: string) {
  // 处理HEAD、远程分支等情况
  if (ref.includes("HEAD -> ")) {
    return ref.replace("HEAD -> ", "");
  }
  if (ref.includes("origin/")) {
    return ref;
  }
  return ref.trim();
}

// 获取分支标签类型（实现该函数，因为在模板中调用了）
function getBranchTagType(ref: string) {
  if (ref.includes("HEAD")) return "success";
  if (ref.includes("origin/")) return "warning";
  return "info";
}

// 添加对表格实例的引用
const tableRef = ref<InstanceType<typeof ElTable> | null>(null);
const tableBodyWrapper = ref<HTMLElement | null>(null);

// 监听表格滚动事件的处理函数
function handleTableScroll(event: Event) {
  if (
    showGraphView.value ||
    !hasMoreData.value ||
    isLoadingMore.value ||
    isLoading.value
  ) {
    return;
  }

  const target = event.target as HTMLElement;
  const { scrollTop, scrollHeight, clientHeight } = target;
  const scrollDistance = scrollHeight - scrollTop - clientHeight;

  // 当滚动到距离底部20px时触发加载
  if (scrollDistance <= 20) {
    loadMoreLogs();
  }
}

// 设置表格滚动监听
function setupTableScrollListener() {
  if (!tableRef.value) {
    return;
  }

  // 获取表格的body-wrapper
  const bodyWrapper = tableRef.value.$el.querySelector(".el-table__body-wrapper");

  if (!bodyWrapper) {
    return;
  }

  tableBodyWrapper.value = bodyWrapper;

  // 先移除旧的监听器，避免重复
  if (tableBodyWrapper.value) {
    tableBodyWrapper.value.removeEventListener("scroll", handleTableScroll, true);
    tableBodyWrapper.value.addEventListener("scroll", handleTableScroll, true);
  }
}

// 移除表格滚动监听
function removeTableScrollListener() {
  if (tableBodyWrapper.value) {
    tableBodyWrapper.value.removeEventListener("scroll", handleTableScroll, true);
    tableBodyWrapper.value = null;
  }
}

// 添加键盘事件处理函数
function handleKeyDown(event: KeyboardEvent) {
  // 按ESC键退出全屏模式
  if (event.key === 'Escape' && isFullscreen.value) {
    isFullscreen.value = false;
  }
}

// 在组件挂载时添加键盘事件监听
onMounted(() => {
  // 检查gitStore中是否已有数据
  if (gitStore.isGitRepo) {
    if (gitStore.log.length > 0) {
      // 如果已经有数据，直接使用现有数据
      // 清空并填充logsData
      logsData.length = 0;
      gitStore.log.forEach((item) => logsData.push(item));

      // 由于TypeScript类型错误，我们直接设置totalCommits而不是使用logs.value.length
      totalCommits.value = gitStore.log.length;

      // 确保视图被渲染
      if (showGraphView.value) {
        setTimeout(() => {
          renderGraph();
        }, 100);
      }
    } else {
      // 否则加载数据
      loadLog();
    }

    // 加载所有可能的作者列表
    fetchAllAuthors();

    // 不再在这里直接设置 availableBranches，改为通过 watch 监听 gitStore.allBranches 的变化
  } else {
    errorMessage.value = "当前目录不是Git仓库";
  }

  // 在下一个tick中设置表格滚动监听
  nextTick(() => {
    setTimeout(() => {
      setupTableScrollListener();
    }, 500); // 给表格足够的时间来渲染
  });



  // 添加对表格的监听，确保表格创建后设置滚动监听
  watch(() => tableRef.value, (newTableRef) => {
    if (newTableRef && !showGraphView.value && !showAllCommits.value) {
      nextTick(() => {
        setupTableScrollListener();
      });
    }
  });

  // 添加键盘事件监听
  window.addEventListener('keydown', handleKeyDown);
});

// 添加对 gitStore.allBranches 的监听
watch(
  () => gitStore.allBranches,
  (newBranches) => {
    if (newBranches && newBranches.length > 0) {
      availableBranches.value = [...newBranches].sort();
    } else {
      availableBranches.value = [];
    }
  },
  { immediate: true }
); // immediate: true 确保组件创建时立即执行一次

onBeforeUnmount(() => {
  // 清除表格滚动监听
  removeTableScrollListener();

  // 清除定时器
  if (loadTimerInterval.value !== null) {
    window.clearInterval(loadTimerInterval.value);
    loadTimerInterval.value = null;
  }

  // 移除键盘事件监听
  window.removeEventListener('keydown', handleKeyDown);
});



// 修改refreshLog函数
async function refreshLog() {
  // 简单调用gitStore的fetchLog方法
  await gitStore.fetchLog(true);

  // 重新填充本地数据
  logsData.length = 0;
  gitStore.log.forEach((item) => logsData.push(item));

  // 触发视图更新
  logs.value = [...logsData];

  // 设置总条数
  totalCommits.value = gitStore.log.length;

  // 重置分页状态
  currentPage.value = 1;
  hasMoreData.value = false; // 使用API直接加载全部日志时，没有更多数据

  // 设置刷新提示
  logRefreshed.value = true;
  // 2秒后隐藏提示
  setTimeout(() => {
    logRefreshed.value = false;
  }, 2000);

  // 如果当前是图表视图，刷新图表
  if (showGraphView.value) {
    await nextTick();
    renderGraph();
  }
}

// 监听store中的日志变化
watch(
  () => gitStore.log,
  (newLogs) => {
    try {
      // 清空logsData
      logsData.length = 0;

      // 重新填充数据，使用类型断言
      if (Array.isArray(newLogs)) {
        // @ts-ignore - 忽略类型校验
        newLogs.forEach((item) => item && logsData.push(item));
      }

      // 更新计数器
      totalCommits.value = logsData.length;

      // 重置当前页为第1页
      currentPage.value = 1;

      // 确保引用更新，触发UI重渲染
      // @ts-ignore - 忽略类型校验
      logs.value = [...logsData];

      // 设置刷新提示
      logRefreshed.value = true;
      setTimeout(() => {
        logRefreshed.value = false;
      }, 2000);

      if (showGraphView.value && logsData.length > 0) {
        setTimeout(renderGraph, 0);
      }
    } catch (error) {
      // 静默处理错误
    }
  },
  { immediate: true }
);

// 暴露方法给父组件
defineExpose({
  refreshLog,
});

// 增加/减少缩放比例
function zoomIn() {
  if (graphScale.value < maxScale) {
    graphScale.value = Math.min(maxScale, graphScale.value + scaleStep);
    applyScale();
  }
}

function zoomOut() {
  if (graphScale.value > minScale) {
    graphScale.value = Math.max(minScale, graphScale.value - scaleStep);
    applyScale();
  }
}

// 应用缩放比例
function applyScale() {
  if (!graphContainer.value) return;

  const svgElement = graphContainer.value.querySelector("svg");
  if (svgElement) {
    svgElement.style.transform = `scale(${graphScale.value})`;
    svgElement.style.transformOrigin = "top left";
  }
}

// 自适应图表大小
function fitGraphToContainer() {
  if (!graphContainer.value) return;

  const svgElement = graphContainer.value.querySelector("svg");
  if (!svgElement) return;

  // 获取SVG和容器的宽度
  const svgWidth = svgElement.getBoundingClientRect().width / graphScale.value;
  const containerWidth = graphContainer.value.clientWidth;

  // 计算合适的缩放比例
  if (svgWidth > containerWidth) {
    // 如果SVG宽度大于容器，需要缩小
    graphScale.value = Math.max(minScale, containerWidth / svgWidth);
  } else {
    // 否则恢复到默认比例
    graphScale.value = 1;
  }

  applyScale();
}





// 查看提交详情
async function viewCommitDetail(commit: LogItem | null) {
  if (!commit) return;

  selectedCommit.value = commit;
  commitDetailVisible.value = true;
  isLoadingCommitDetail.value = true;
  commitFiles.value = [];
  commitDiff.value = "";
  selectedCommitFile.value = "";

  try {
    // 确保哈希值有效
    if (!commit.hash || commit.hash.length < 7) {
      commitDiff.value = "无效的提交哈希值";
      isLoadingCommitDetail.value = false;
      return;
    }

    // 获取提交的变更文件列表
    const filesResponse = await fetch(`/api/commit-files?hash=${commit.hash}`);
    const filesData = await filesResponse.json();

    if (filesData.success && Array.isArray(filesData.files)) {
      commitFiles.value = filesData.files;

      // 如果有文件，自动加载第一个文件的差异
      if (commitFiles.value.length > 0) {
        await getCommitFileDiff(commit.hash, commitFiles.value[0]);
      } else {
        commitDiff.value = "该提交没有变更文件";
      }
    } else {
      commitDiff.value = `获取文件列表失败: ${filesData.error || "未知错误"}`;
    }
  } catch (error) {
    commitDiff.value = `获取提交详情失败: ${(error as Error).message}`;
  } finally {
    isLoadingCommitDetail.value = false;
  }
}

// 获取提交中特定文件的差异
async function getCommitFileDiff(hash: string, filePath: string) {
  isLoadingCommitDetail.value = true;
  selectedCommitFile.value = filePath;

  try {
    const diffResponse = await fetch(
      `/api/commit-file-diff?hash=${hash}&file=${encodeURIComponent(filePath)}`
    );
    const diffData = await diffResponse.json();

    if (diffData.success) {
      commitDiff.value = diffData.diff || "没有变更内容";
    } else {
      commitDiff.value = `获取差异失败: ${diffData.error || "未知错误"}`;
    }
  } catch (error) {
    commitDiff.value = `获取差异失败: ${(error as Error).message}`;
  } finally {
    isLoadingCommitDetail.value = false;
  }
}

// 处理提交文件选择
function handleCommitFileSelect(filePath: string) {
  if (selectedCommit.value) {
    getCommitFileDiff(selectedCommit.value.hash, filePath);
  }
}

// 处理打开文件
async function handleOpenFile(filePath: string, context: string) {
  try {
    const response = await fetch('/api/open-file', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filePath,
        context
      })
    });
    
    const result = await response.json();
    
    if (result.success) {
      ElMessage.success(result.message);
    } else {
      ElMessage.error(result.error || '打开文件失败');
    }
  } catch (error) {
    ElMessage.error(`打开文件失败: ${(error as Error).message}`);
  }
}

// 处理用VSCode打开文件
async function handleOpenWithVSCode(filePath: string, context: string) {
  try {
    const response = await fetch('/api/open-with-vscode', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filePath,
        context
      })
    });
    
    const result = await response.json();
    
    if (result.success) {
      ElMessage.success(result.message);
    } else {
      ElMessage.error(result.error || '用VSCode打开文件失败');
    }
  } catch (error) {
    ElMessage.error(`用VSCode打开文件失败: ${(error as Error).message}`);
  }
}





// 复制纯净的提交信息
async function copyPureMessage(message: string) {
  try {
    const pureMessage = extractPureMessage(message);
    await navigator.clipboard.writeText(pureMessage);
    ElMessage.success('提交信息已复制到剪贴板');
  } catch (error) {
    ElMessage.error('复制失败');
  }
}

// 加载更多日志
function loadMoreLogs() {
  if (!hasMoreData.value || isLoadingMore.value || isLoading.value) {
    return;
  }

  loadLog(showAllCommits.value, currentPage.value + 1);
}

// 重置筛选条件并重新加载数据
function resetFilters() {
  authorFilter.value = [];
  branchFilter.value = [];
  messageFilter.value = "";
  dateRangeFilter.value = null;

  // 重置筛选后重新加载数据
  currentPage.value = 1;
  loadLog(showAllCommits.value, 1);
}

// 应用筛选条件
function applyFilters() {
  // 应用筛选时重置到第一页
  currentPage.value = 1;
  loadLog(showAllCommits.value, 1);
}

// 添加获取所有作者的函数
async function fetchAllAuthors() {
  try {
    const response = await fetch("/api/authors");
    const result = await response.json();

    if (result.success && Array.isArray(result.authors)) {
      // 更新可用作者列表
      availableAuthors.value = result.authors.sort();
    } else {
      // 如果获取作者列表失败，但正常获取了日志
      // 从当前加载的日志中提取作者列表作为备选
      extractAuthorsFromLogs();
    }
  } catch (error) {
    // 从当前加载的日志中提取作者列表作为备选
    extractAuthorsFromLogs();
  }
}

// 从已加载的日志中提取作者列表
function extractAuthorsFromLogs() {
  const authors = new Set<string>();
  logs.value.forEach((log) => {
    if (log.author) {
      authors.add(log.author);
    }
  });
  availableAuthors.value = Array.from(authors).sort();
}






// 监听logs.value的变化
watch(
  () => logs.value,
  () => {
    // 图表视图相关逻辑已移除
  },
  { deep: true } // 添加deep选项以确保检测到数组内部元素的变化
);

// 处理右键菜单事件
function handleContextMenu(row: LogItem, _column: any, event: MouseEvent) {
  // 阻止默认右键菜单
  event.preventDefault();

  // 设置右键菜单位置
  contextMenuTop.value = event.clientY;
  contextMenuLeft.value = event.clientX;

  // 设置选中的提交
  selectedContextCommit.value = row;

  // 显示右键菜单
  contextMenuVisible.value = true;

  // 点击其他地方时隐藏菜单
  const hideContextMenu = () => {
    contextMenuVisible.value = false;
    document.removeEventListener("click", hideContextMenu);
  };

  // 添加点击监听器
  setTimeout(() => {
    document.addEventListener("click", hideContextMenu);
  }, 0);
}

// 撤销提交 (Revert)
async function revertCommit(commit: LogItem | null) {
  if (!commit) return;

  try {
    // 询问确认
    await ElMessageBox.confirm(
      `确定要撤销提交 ${commit.hash.substring(
        0,
        7
      )} 吗？这将创建一个新的提交来撤销这次提交的更改。`,
      "撤销提交确认",
      {
        confirmButtonText: "确认",
        cancelButtonText: "取消",
        type: "warning",
      }
    );

    // 发送请求
    const response = await fetch("/api/revert-commit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ hash: commit.hash }),
    });

    const result = await response.json();

    if (result.success) {
      ElMessage.success(result.message || "已成功撤销提交");
      // 刷新日志
      refreshLog();
      // 刷新Git状态
      gitStore.fetchStatus();
      // 添加: 刷新分支状态
      gitStore.getBranchStatus();
    } else {
      ElMessage.error(result.error || "撤销提交失败");
    }
  } catch (error: any) {
    if (error !== "cancel") {
      ElMessage.error("撤销提交失败: " + (error.message || error));
    }
  }
}

// Cherry-pick提交
async function cherryPickCommit(commit: LogItem | null) {
  if (!commit) return;

  try {
    // 询问确认
    await ElMessageBox.confirm(
      `确定要将提交 ${commit.hash.substring(0, 7)} Cherry-Pick 到当前分支吗？`,
      "Cherry-Pick确认",
      {
        confirmButtonText: "确认",
        cancelButtonText: "取消",
        type: "warning",
      }
    );

    // 发送请求
    const response = await fetch("/api/cherry-pick-commit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ hash: commit.hash }),
    });

    const result = await response.json();

    if (result.success) {
      ElMessage.success(result.message || "已成功Cherry-Pick提交");
      // 刷新日志
      refreshLog();
      // 刷新Git状态
      gitStore.fetchStatus();
      // 添加: 刷新分支状态
      gitStore.getBranchStatus();
    } else {
      ElMessage.error(result.error || "Cherry-Pick提交失败");
    }
  } catch (error: any) {
    if (error !== "cancel") {
      ElMessage.error("Cherry-Pick提交失败: " + (error.message || error));
    }
  }
}

// 复制提交哈希
async function copyCommitHash(commit: LogItem | null) {
  if (!commit) return;
  
  try {
    await navigator.clipboard.writeText(commit.hash);
    ElMessage.success(`已复制提交哈希: ${commit.hash.substring(0, 7)}`);
  } catch (error) {
    ElMessage.error(`复制提交哈希失败: ${(error as Error).message}`);
  }
}

// 重置到指定提交(hard)
async function resetToCommit(commit: LogItem | null) {
  if (!commit) return;

  try {
    // 询问确认
    await ElMessageBox.confirm(
      `确定要将当前分支重置(hard)到提交 ${commit.hash.substring(0, 7)} 吗？
      
      警告：这将丢失该提交之后的所有更改！`,
      "重置确认",
      {
        confirmButtonText: "确认重置",
        cancelButtonText: "取消",
        type: "warning",
        dangerouslyUseHTMLString: true
      }
    );

    // 发送请求 - 创建一个API接口用于重置到指定提交
    const response = await fetch("/api/reset-to-commit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ hash: commit.hash }),
    });

    const result = await response.json();

    if (result.success) {
      ElMessage.success(result.message || "已成功重置到指定提交");
      // 刷新日志
      refreshLog();
      // 刷新Git状态
      gitStore.fetchStatus();
      // 刷新分支状态
      gitStore.getBranchStatus();
    } else {
      ElMessage.error(result.error || "重置到指定提交失败");
    }
  } catch (error: any) {
    if (error !== "cancel") {
      ElMessage.error("重置到指定提交失败: " + (error.message || error));
    }
  }
}

// 检查表格是否滚动到底部并加载更多数据
function checkAndLoadMore() {
  if (
    showGraphView.value ||
    !hasMoreData.value ||
    isLoadingMore.value ||
    isLoading.value ||
    showAllCommits.value
  ) {
    return;
  }

  if (!tableBodyWrapper.value) {
    setupTableScrollListener();
    return;
  }

  const { scrollTop, scrollHeight, clientHeight } = tableBodyWrapper.value;
  const scrollDistance = scrollHeight - scrollTop - clientHeight;

  if (scrollDistance <= 50) {
    loadMoreLogs();
  }
}

// 在表格视图显示时添加定时检查
watch(() => showGraphView.value, (isGraphView) => {
  if (!isGraphView && !showAllCommits.value) {
    nextTick(() => {
      setupTableScrollListener();

      // 延迟200ms后检查一次，处理初始渲染时可能需要加载更多数据的情况
      setTimeout(checkAndLoadMore, 200);
    });
  }
});

// 添加全屏状态变量
const isFullscreen = ref(false);

// 切换全屏模式
function toggleFullscreen() {
  isFullscreen.value = !isFullscreen.value;
  
  // 使用nextTick确保DOM更新后执行后续操作
  nextTick(() => {
    // 如果是图表视图，需要重新计算图表大小
    if (showGraphView.value && graphContainer.value) {
      renderGraph();
    }
  });
}
</script>

<template>
  <div class="card" :class="{ 'fullscreen-mode': isFullscreen }">
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
            分页加载 (每页20条)
          </el-tag>
          <el-tag v-else type="success" size="small" effect="plain" style="margin-left: 5px">
            全部
          </el-tag>
        </el-tag> -->
      </div>

      <div class="log-actions">
        <!-- 筛选按钮 - 只显示图标 -->
        <el-button
          v-if="!showGraphView"
          :type="filterVisible ? 'primary' : 'default'"
          size="small"
          @click="filterVisible = !filterVisible"
          class="action-button filter-button icon-only-button"
          :class="{ 'active-filter': filterVisible }"
        >
          <template #icon>
            <el-icon><Filter /></el-icon>
          </template>
        </el-button>

        <!-- 视图切换按钮 - 只显示图标 -->
        <el-button
          type="primary"
          size="small"
          @click="toggleViewMode"
          class="action-button view-mode-button icon-only-button"
          :class="{ 'active-view': showGraphView }"
        >
          <template #icon>
            <el-icon
              ><component :is="showGraphView ? Document : TrendCharts"
            /></el-icon>
          </template>
        </el-button>
        
        <!-- 显示所有提交按钮 - 隐藏 -->
        <el-button
          v-show="false"
          type="success"
          size="small"
          @click="toggleAllCommits"
          :loading="isLoading"
          class="action-button commit-display-button"
          :class="{ 'active-commits': showAllCommits }"
        >
          <template #icon>
            <el-icon><component :is="showAllCommits ? List : More" /></el-icon>
          </template>
          {{ showAllCommits ? "显示分页加载" : "显示所有提交" }}
        </el-button>
        
        <!-- 全屏按钮 - 只显示图标 -->
        <el-button
          type="info"
          size="small"
          @click="toggleFullscreen"
          class="action-button fullscreen-button icon-only-button"
          :class="{ 'active-fullscreen': isFullscreen }"
        >
          <template #icon>
            <el-icon><component :is="isFullscreen ? Close : FullScreen" /></el-icon>
          </template>
        </el-button>
        
        <el-button
          circle
          size="small"
          @click="refreshLog()"
          :class="{ 'refresh-button-animated': logRefreshed }"
          class="action-button refresh-button"
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
          <el-select
            v-model="authorFilter"
            placeholder="选择作者"
            multiple
            clearable
            filterable
            class="filter-input"
            size="small"
          >
            <template #prefix>
              <span class="compact-label">作者</span>
            </template>
            <el-option
              v-for="author in availableAuthors"
              :key="author"
              :label="author"
              :value="author"
            />
          </el-select>
        </div>

        <div class="filter-item">
          <el-select
            v-model="branchFilter"
            placeholder="选择分支"
            multiple
            clearable
            filterable
            class="filter-input"
            size="small"
          >
            <template #prefix>
              <span class="compact-label">分支</span>
            </template>
            <el-option
              v-for="branch in availableBranches"
              :key="branch"
              :label="branch"
              :value="branch"
            />
          </el-select>
        </div>

        <div class="filter-item">
          <el-input
            v-model="messageFilter"
            placeholder="提交信息关键词"
            clearable
            class="filter-input"
            size="small"
          >
            <template #prefix>
              <span class="compact-label">信息</span>
            </template>
          </el-input>
        </div>

        <div class="filter-item">
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
          >
            <template #prefix>
              <span class="compact-label">日期</span>
            </template>
          </el-date-picker>
        </div>

        <div class="filter-actions">
          <el-button
            type="primary"
            size="small"
            @click="applyFilters"
            class="filter-action-button"
            >应用</el-button
          >
          <el-button
            type="info"
            size="small"
            @click="resetFilters"
            class="filter-action-button"
            >重置</el-button
          >
        </div>
      </div>
    </div>

    <!-- 内容区域，添加上边距以避免被固定头部遮挡 -->
    <div
      class="content-area"
      :class="{ 'with-filter': filterVisible && !showGraphView }"
    >
      <div v-if="errorMessage">{{ errorMessage }}</div>
      <div class="content-area-content" v-else>
        <!-- 图表视图 -->
        <div v-if="showGraphView" class="graph-view">
          <div class="commit-count" v-if="logsData.length > 0">
            显示 {{ logsData.length }} 条提交记录
            {{ showAllCommits ? "(全部)" : "(分页加载，每页20条)" }}
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
          <el-table
            ref="tableRef"
            :data="filteredLogs"
            stripe
            border
            v-loading="isLoading"
            class="log-table"
            :empty-text="isLoading ? '加载中...' : '没有匹配的提交记录'"
            height="450"
            @row-contextmenu="handleContextMenu"
            @row-click="(row) => viewCommitDetail(row)"
          >

            <el-table-column label="哈希" width="80" resizable>
              <template #default="scope">
                <span
                  class="commit-hash"
                  @click="viewCommitDetail(scope.row)"
                  >{{ scope.row.hash.substring(0, 6) }}</span
                >
              </template>
            </el-table-column>
            <el-table-column label="提交信息" min-width="300">
              <template #default="scope">
                <div class="commit-message-cell">
                  <!-- 分支信息和提交信息水平排列 -->
                  <div class="message-content">
                    <!-- 分支信息 -->
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
                    <!-- 提交信息 -->
                    <span class="message-text">{{ scope.row.message }}</span>
                    <el-button
                      type="text"
                      :icon="CopyDocument"
                      size="small"
                      @click.stop="copyPureMessage(scope.row.message)"
                      class="copy-message-btn"
                      title="复制纯净提交信息（不含类型前缀）"
                    />
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="date" label="日期" width="150" resizable />
            <el-table-column label="作者" width="100" resizable>
              <template #default="scope">
                <el-tooltip
                  :content="scope.row.email"
                  placement="top"
                  :hide-after="1000"
                  :show-after="200"
                >
                  <span class="author-name">{{ scope.row.author }}</span>
                </el-tooltip>
              </template>
            </el-table-column>
          </el-table>

          <!-- 添加底部加载状态和加载更多按钮 -->
          <div v-if="!showAllCommits && false" class="load-more-container">
            <!-- 显示加载状态和页码信息 -->
            <div class="pagination-info">
              <span>第 {{ currentPage }} 页
                {{ totalCommits > 0 ? `/ 共 ${Math.ceil(totalCommits / 20) || 1} 页` : "" }}
                (总计 {{ totalCommits }} 条记录)</span>
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
    <CommonDialog
      v-model="commitDetailVisible"
      :title="`提交详情: ${
        selectedCommit?.hash ? selectedCommit.hash.substring(0, 7) : '未知'
      }`"
      size="extra-large"
      type="flex"
      destroy-on-close
      custom-class="commit-detail-dialog"
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
              <span class="item-value"
                >{{ selectedCommit.author }} &lt;{{
                  selectedCommit.email
                }}&gt;</span
              >
            </div>
            <div class="info-item">
              <span class="item-label">日期:</span>
              <span class="item-value">{{ selectedCommit.date }}</span>
            </div>
          </div>
          <div class="commit-message-container">
            <div class="message-label">提交信息:</div>
            <div
              class="message-content"
              v-html="
                formatCommitMessage(selectedCommit.message).replace(
                  /\n/g,
                  '<br>'
                )
              "
            ></div>
          </div>
        </div>

        <!-- 变更文件列表和差异 -->
        <FileDiffViewer
          :files="commitFilesForViewer"
          :loading="isLoadingCommitDetail"
          :diffContent="commitDiff"
          :selectedFile="selectedCommitFile"
          context="commit-detail"
          emptyText="没有找到变更文件"
          @file-select="handleCommitFileSelect"
          @open-file="handleOpenFile"
          @open-with-vscode="handleOpenWithVSCode"
        />
      </div>
    </CommonDialog>
  </div>
  <!-- 添加右键菜单 -->
  <div
    v-show="contextMenuVisible"
    class="context-menu"
    :class="{ 'fullscreen-context-menu': isFullscreen }"
    :style="{ top: contextMenuTop + 'px', left: contextMenuLeft + 'px' }"
  >
    <div
      class="context-menu-item"
      @click="viewCommitDetail(selectedContextCommit)"
    >
      <i class="el-icon-view"></i> 查看详情
    </div>
    <div class="context-menu-item" @click="copyCommitHash(selectedContextCommit)">
      <i class="el-icon-document-copy"></i> 复制提交哈希
    </div>
    <div class="context-menu-item" @click="resetToCommit(selectedContextCommit)">
      <i class="el-icon-refresh-right"></i> 重置到该提交(hard)
    </div>
    <div class="context-menu-item" @click="revertCommit(selectedContextCommit)">
      <i class="el-icon-delete"></i> 撤销提交 (Revert)
    </div>
    <div
      class="context-menu-item"
      @click="cherryPickCommit(selectedContextCommit)"
    >
      <i class="el-icon-edit"></i> Cherry-Pick 到当前分支
    </div>
  </div>
</template>
<style scoped>
.card {
  background-color: var(--bg-container);
  border-radius: 8px;
  box-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.1);
  margin-bottom: 8px;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  position: relative;
}

.log-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid #ebeef5;
  position: sticky;
  top: 0;
  background-color: var(--bg-container);
  z-index: 100;
}

.fullscreen-mode .log-header {
  margin-bottom: 10px;
  /* AI start Copilot */
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
  /* AI end Copilot */
}

.header-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.header-left h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  
}

.log-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 优化按钮样式 */
.action-button {
  transition: all 0.3s ease;
  border-radius: 8px;
  border: 1px solid transparent;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  font-weight: 500;
  padding: 4px 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.action-button:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
}

/* 筛选按钮样式 */
.filter-button {
  background: linear-gradient(135deg, #e6a23c 0%, #f0c78a 100%);
  color: white;
  min-width: 90px;
}

.filter-button.active-filter {
  background: linear-gradient(135deg, #d48806 0%, #e6a23c 100%);
}

.filter-button .filter-badge :deep(.el-badge__content) {
  background-color: #f56c6c;
  color: white;
  border: 2px solid white;
  box-shadow: 0 0 0 1px #e6a23c;
}

/* 视图切换按钮样式 */
.view-mode-button {
  background: linear-gradient(135deg, #409eff 0%, #53a8ff 100%);
  color: white;
}

.view-mode-button.active-view {
  background: linear-gradient(135deg, #1890ff 0%, #096dd9 100%);
}

/* 提交显示按钮样式 */
.commit-display-button {
  background: linear-gradient(135deg, #67c23a 0%, #85ce61 100%);
  color: white;
}

.commit-display-button.active-commits {
  background: linear-gradient(135deg, #52c41a 0%, #389e0d 100%);
}

/* 刷新按钮样式 */
.refresh-button {
  background: linear-gradient(135deg, #909399 0%, #c0c4cc 100%);
  color: white;
  min-width: unset;
  padding: 6px;
  border-radius: 50%;
  width: 28px;
  height: 28px;
}

.refresh-button:hover {
  background: linear-gradient(135deg, #606266 0%, #909399 100%);
}

/* 图标按钮专用的更小尺寸 */
.icon-only-button {
  min-width: unset !important;
  padding: 4px !important;
  width: 28px !important;
  height: 28px !important;
  border-radius: 6px !important;
}

.refresh-button-animated {
  animation: spin 1s linear;
}

@keyframes spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

.content-area {
  flex: 1;
  min-height: 100px;
  height: calc(100% - 52px);
  display: flex;
  flex-direction: column;
  overflow: auto;
}

.content-area-content {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.content-area.with-filter {
  height: calc(100% - 52px - 60px); /* 减去header高度和filter高度 */
  padding-top: 0;
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
  border-radius: 8px;
  overflow: hidden;
}

:deep(.el-table__header-wrapper) {
  background-color: #f8f9fa;
}

:deep(.el-table__header) th {
  background-color: #f8f9fa;
  color: #606266;
  font-weight: 600;
  height: 36px;
  font-size: 13px;
}

:deep(.el-table__row) {
  transition: all 0.2s ease;
  cursor: pointer;
}

:deep(.el-table__row:hover) {
  background-color: #ecf5ff !important;
}

:deep(.el-table--striped .el-table__row--striped) {
  background-color: #fafafa;
}

:deep(.el-table__cell) {
  padding: 0;
  font-size: 12px;
}

.branch-container {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-right: 8px;
  flex-shrink: 0;
}

.branch-tag {
  margin-right: 0;
  border-radius: 3px;
  transition: all 0.2s ease;
  font-size: 10px;
  padding: 0 4px;
  height: 14px;
  line-height: 14px;
}

.branch-tag:hover {
  transform: translateY(-1px);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.commit-count {
  margin-bottom: 12px;
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
  padding: 0 8px;
}

.graph-container {
  width: 100%;
  flex: 1;
  min-height: 500px;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  padding: 16px;
  position: relative;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.03);
}

.graph-container svg {
  transform-origin: top left;
  transition: transform 0.2s ease;
}

.graph-controls {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  background-color: #f8f9fa;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid #ebeef5;
}

.zoom-controls {
  display: flex;
  gap: 12px;
  align-items: center;
}

.zoom-slider {
  width: 200px;
}

.scale-info {
  font-size: 14px;
  color: #606266;
  padding: 4px 10px;
  border-radius: 4px;
  border: 1px solid #ebeef5;
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

@keyframes fadeOut {
  0% {
    opacity: 0;
    transform: translateY(-20px);
  }
  20% {
    opacity: 1;
    transform: translateY(0);
  }
  80% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

.author-name {
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: inline-block;
  max-width: 100%;
  font-weight: 500;
  font-size: 12px;
}

.commit-hash {
  cursor: pointer;
  color: #409eff;
  font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
  font-weight: 500;
  border-radius: 3px;
  padding: 1px 3px;
  background-color: #ecf5ff;
  transition: all 0.2s ease;
  font-size: 11px;
}

.commit-hash:hover {
  text-decoration: none;
  background-color: #d9ecff;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
}

.commit-detail-container {
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex: 1; /* 关键：允许在flex父容器中伸缩 */
  min-height: 0; /* 关键：允许flex子元素收缩 */
  overflow: hidden; /* 防止内容超出 */
}

.commit-info {
  padding: 12px;
  background-color: #f5f7fa;
  border-radius: 8px;
  font-size: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex-shrink: 0; /* 防止信息区域被压缩 */
  max-height: 200px; /* 限制最大高度 */
}

.commit-info-header {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid #e4e7ed;
}

.info-item {
  display: flex;
  align-items: center;
  gap: 8px;
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
  gap: 8px;
}

.message-label {
  font-weight: bold;
  color: #606266;
}

/* 提交详情弹窗样式 */
:deep(.commit-detail-dialog .el-dialog__body) {
  padding: 12px;
  height: calc(100vh - 200px); /* 给对话框体设置明确高度 */
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 滚动条样式 */
.diff-content::-webkit-scrollbar,
.files-list::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.diff-content::-webkit-scrollbar-thumb,
.files-list::-webkit-scrollbar-thumb {
  background-color: rgba(144, 147, 153, 0.3);
  border-radius: 4px;
}

.diff-content::-webkit-scrollbar-thumb:hover,
.files-list::-webkit-scrollbar-thumb:hover {
  background-color: rgba(144, 147, 153, 0.5);
}

.diff-content::-webkit-scrollbar-track,
.files-list::-webkit-scrollbar-track {
  background-color: transparent;
}

/* Firefox滚动条样式 */
.diff-content,
.files-list {
  scrollbar-width: thin;
  scrollbar-color: rgba(144, 147, 153, 0.3) transparent;
}

.filter-panel-header {
  background-color: #f5f7fa;
  padding: 8px;
  margin-bottom: 8px;
  border-radius: 8px;
  box-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.05);
  transition: all 0.3s ease;
  width: 100%;
  position: sticky;
  top: 36px; /* 紧贴log-header下方 */
  z-index: 99;
}

.fullscreen-mode .filter-panel-header {
  position: sticky;
  top: 60px;
  z-index: 9;
  background-color: var(--bg-container);
  width: 100%;
  border-radius: 0;
  border-bottom: 1px solid #ebeef5;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
}

.filter-form {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}

.filter-item {
  flex: 1;
  min-width: 200px;
}

.filter-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  white-space: nowrap;
  flex-shrink: 0;
}

.filter-input {
  width: 100%;
}

.filter-input.date-range {
  width: 100%;
  max-width: 280px;
}

.compact-label {
  color: #909399;
  font-size: 12px;
  margin-right: 6px;
  white-space: nowrap;
  font-weight: bold;
  border-right: 1px solid #dcdfe6;
  padding-right: 8px;
}

.filter-action-button {
  padding: 8px 16px;
  border-radius: 6px;
  transition: all 0.3s;
  min-width: 70px;
  font-weight: 500;
}

.filter-action-button:hover {
  transform: translateY(-2px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

/* 表格视图容器简化 */
.table-view-container {
  height: 100%;
  display: flex;
  flex-direction: column;
  flex: 1;
}

.log-table {
  flex: 1;
  width: 100%;
}

/* 提交信息单元格样式 */
.commit-message-cell {
  display: flex;
  align-items: center;
  min-height: 26px;
}

.message-content {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.message-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-base);
  line-height: var(--line-height-tight);
}

.copy-message-btn {
  opacity: 0;
  transition: opacity 0.2s ease;
  padding: 4px;
  min-width: auto;
  height: auto;
}

.commit-message-cell:hover .copy-message-btn {
  opacity: 1;
}

.copy-message-btn:hover {
  color: #409eff;
}

.fullscreen-mode .table-view-container {
  height: calc(100vh - 160px); /* 减去头部和可能的筛选面板高度 */
}

.fullscreen-mode .log-table {
  height: 100%;
}

/* 添加底部加载更多相关样式 */
.load-more-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
  border-top: 1px dashed #ebeef5;
  gap: 8px;
}

.pagination-info {
  font-size: 13px;
  color: #909399;
  margin-bottom: 4px;
}

.loading-more {
  display: flex;
  align-items: center;
  color: #909399;
  font-size: 13px;
  gap: 8px;
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid #dcdfe6;
  border-top-color: #409eff;
  border-radius: 50%;
  animation: spinner 1s linear infinite;
}

@keyframes spinner {
  to {
    transform: rotate(360deg);
  }
}

.load-more-button {
  cursor: pointer;
  color: #409eff;
  font-size: 13px;
  padding: 6px 16px;
  border: 1px solid #d9ecff;
  background-color: #ecf5ff;
  border-radius: 4px;
  transition: all 0.3s;
  font-weight: 500;
}

.no-more-data {
  color: #909399;
  font-size: 13px;
  font-style: italic;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.total-loaded {
  font-size: 12px;
  margin-top: 4px;
  color: #c0c4cc;
}

/* 右键菜单样式 */
.context-menu {
  position: fixed;
  background: var(--bg-container);
  border: 1px solid #dcdfe6;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
  padding: 6px 0;
  z-index: 3000;
  min-width: 200px;
  animation: fadeIn 0.15s ease-out;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(5px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.context-menu-item {
  padding: 10px 16px;
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: center;
  transition: all 0.2s ease;
  color: #606266;
}

.context-menu-item:hover {
  background-color: #f5f7fa;
  color: #409eff;
}

.context-menu-item i {
  margin-right: 10px;
  font-size: 16px;
}



/* 去掉表格行边框 */
:deep(.el-table--border .el-table__inner-wrapper tr) {
  border: none !important;
}

:deep(.el-table--border .el-table__inner-wrapper td) {
  border-right: none !important;
  border-bottom: none !important;
}

:deep(.el-table--border .el-table__inner-wrapper th) {
  border-right: none !important;
}

:deep(.el-table--border) {
  border: none !important;
}

:deep(.el-table--border .el-table__inner-wrapper) {
  border: none !important;
}

:deep(.el-table--border::after),
:deep(.el-table--border::before),
:deep(.el-table__inner-wrapper::after),
:deep(.el-table__inner-wrapper::before) {
  display: none !important;
}

/* 表格背景设置 */
:deep(.el-table tr) {
  background-color: transparent !important;
}

:deep(.el-table--striped .el-table__body tr.el-table__row--striped td) {
  background-color: rgba(0, 0, 0, 0.02) !important;
}

/* 添加全屏模式样式 */
.fullscreen-mode {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 9999;
  margin: 0;
  border-radius: 0;
  border: none;
  box-shadow: none;
  background-color: var(--bg-container);
  display: flex;
  flex-direction: column;
  overflow: auto;
}

/* 全屏模式下的头部区域 */
.fullscreen-mode .log-header {
  position: sticky;
  top: 0;
  z-index: 10;
  background-color: var(--bg-container);
  padding: 16px;
  margin-bottom: 10px;
  width: 100%;
}

/* 全屏模式下的筛选面板 */
.fullscreen-mode .filter-panel-header {
  position: sticky;
  top: 60px;
  z-index: 9;
  background-color: var(--bg-container);
  width: 100%;
}

/* 全屏模式下的内容区域调整 */
.fullscreen-mode .content-area {
  height: calc(100vh); /* 减去头部高度和padding */
  max-height: none;
  flex: 1;
  overflow: auto;
}

/* 全屏模式下表格视图调整 */
.fullscreen-mode .el-table {
  height: calc(100vh - 60px); /* 减去头部和可能的筛选面板高度 */
}

/* 全屏模式下图表视图调整 */
.fullscreen-mode .graph-view {
  height: calc(100vh - 140px); /* 减去头部和控制区域高度 */
}

/* 全屏按钮样式 */
.fullscreen-button {
  background: linear-gradient(135deg, #909399 0%, #c0c4cc 100%);
  color: white;
}

.fullscreen-button.active-fullscreen {
  background: linear-gradient(135deg, #606266 0%, #909399 100%);
}

/* 右键菜单样式 */
.context-menu {
  position: fixed;
  background: var(--bg-container);
  border: 1px solid #dcdfe6;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
  padding: 6px 0;
  z-index: 3000;
  min-width: 200px;
  animation: fadeIn 0.15s ease-out;
}

/* 全屏模式下的右键菜单需要更高的z-index */
.fullscreen-context-menu {
  z-index: 999999; /* 增加z-index，确保在全屏模式下显示在最上层 */
}

/* 新增只显示图标的按钮样式 */
.icon-only-button {
  min-width: unset;
  width: 36px;
  height: 36px;
  padding: 8px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.icon-only-button .el-icon {
  margin-right: 0;
}
</style>

<!-- 添加表格列调整样式 -->
<style>
.el-table .el-table__cell .cell {
  word-break: break-all;
}

/* 优化diff显示样式 */
.diff-header {
  font-weight: bold;
  background-color: #e6f1fc;
  padding: 10px 16px;
  margin: 12px 0;
  border-radius: 6px;
  color: #0366d6;
  border-bottom: 1px solid #c8e1ff;
}

.diff-old-file, .diff-new-file {
  color: #586069;
  padding: 4px 8px;
  font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
}

.diff-old-file {
  color: #cb2431;
}

.diff-new-file {
  color: #22863a;
}

.diff-hunk-header {
  color: #6f42c1;
  background-color: #f1f8ff;
  padding: 4px 8px;
  margin: 8px 0;
  border-radius: 4px;
  font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
}

.diff-added {
  background-color: #e6ffed;
  color: #22863a;
  padding: 2px 8px;
  border-left: 4px solid #22863a;
  font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
  display: block;
  margin: 2px 0;
}

.diff-removed {
  background-color: #ffeef0;
  color: #cb2431;
  padding: 2px 8px;
  border-left: 4px solid #cb2431;
  font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
  display: block;
  margin: 2px 0;
}

.diff-context {
  color: #444;
  padding: 2px 8px;
  font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
  display: block;
  margin: 2px 0;
  background-color: #fafbfc;
}
</style>

<!-- 底部加载更多按钮悬停效果 -->
<style>
.load-more-button:hover {
  background-color: #d9ecff;
  box-shadow: 0 2px 6px rgba(64, 158, 255, 0.15);
  transform: translateY(-1px);
}
</style>

