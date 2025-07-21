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
  ElDialog,
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
import { useGitStore } from "../stores/gitStore";

// 添加分支图绘制相关接口和常量
interface CommitNode {
  hash: string;
  parents: string[];
  column: number;
  row: number;
  branch?: string; // 分支名称
}

interface BranchInfo {
  name: string;
  color: string;
  column: number;
}

interface BranchLine {
  fromRow: number;
  fromColumn: number;
  toRow: number;
  toColumn: number;
  color: string;
}

// 添加新的接口定义，用于处理绘图时的线条类型
interface ThroughLine extends BranchLine {
  type: 'through';
  x: number;
}

interface FromLine extends BranchLine {
  type: 'from';
  fromX: number;
  toX: number;
}

interface ToLine extends BranchLine {
  type: 'to';
  fromX: number;
  toX: number;
}

// 联合类型表示所有可能的线条类型
type GraphLine = ThroughLine | FromLine | ToLine;

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

// 添加分支图相关变量
const commitNodes = ref<Map<string, CommitNode>>(new Map());
const branchLines = ref<BranchLine[]>([]);
const columnCount = ref(1);
const branchInfo = ref<Map<string, BranchInfo>>(new Map());

// 应用筛选后的日志
const filteredLogs = computed(() => {
  // 不再在前端进行筛选，直接使用加载的日志
  return logs.value;
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

    console.log(`加载提交历史: page=${page}, all=${all}`);

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
      console.error("API返回的数据格式不正确:", result);
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

    console.log(`加载完成: 当前页=${currentPage.value}, 是否有更多=${hasMoreData.value}, 总条数=${totalCommits.value}`);

    if (!hasMoreData.value) {
      console.log("已加载所有提交记录");
    }

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
    console.error("加载日志失败:", error);

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
  console.log(`开始渲染图表...数据长度: ${logsData.length}`);

  if (!graphContainer.value) {
    console.error("图表容器未找到");
    return;
  }

  if (logsData.length === 0) {
    console.error("没有日志数据可渲染");
    return;
  }

  try {
    // 清空容器
    graphContainer.value.innerHTML = "";

    console.log(`创建gitgraph实例，分支: ${gitStore.currentBranch || "main"}`);

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

    console.log(`开始创建提交图...共${logsData.length}条提交`);

    // 简化示例 - 实际实现需要根据API返回的数据结构调整
    logsData.forEach((commit, index) => {
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

      if (index % 10 === 0) {
        console.log(`已渲染 ${index + 1}/${logsData.length} 个提交`);
      }
    });

    console.log("图表渲染完成");

    // 确保渲染完成后调用自适应缩放
    setTimeout(() => {
      fitGraphToContainer();
    }, 100);
  } catch (error) {
    console.error("渲染图表失败:", error);
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

  // 调试信息
  console.log("表格滚动:", {
    scrollTop,
    scrollHeight,
    clientHeight,
    scrollDistance,
    hasMoreData: hasMoreData.value,
    isLoadingMore: isLoadingMore.value,
    isLoading: isLoading.value
  });

  // 当滚动到距离底部20px时触发加载
  if (scrollDistance <= 20) {
    console.log("已滚动到底部，加载更多数据");
    loadMoreLogs();
  }
}

// 设置表格滚动监听
function setupTableScrollListener() {
  console.log("设置表格滚动监听 - 开始");
  if (!tableRef.value) {
    console.error("tableRef.value 不存在");
    return;
  }

  // 获取表格的body-wrapper
  const bodyWrapper = tableRef.value.$el.querySelector(".el-table__body-wrapper");
  
  if (!bodyWrapper) {
    console.error("未找到表格的body-wrapper元素");
    return;
  }
  
  console.log("找到表格的body-wrapper元素");
  tableBodyWrapper.value = bodyWrapper;

  // 先移除旧的监听器，避免重复
  if (tableBodyWrapper.value) {
    tableBodyWrapper.value.removeEventListener("scroll", handleTableScroll, true);
    tableBodyWrapper.value.addEventListener("scroll", handleTableScroll, true);
    console.log("成功添加表格滚动监听");
  }
}

// 移除表格滚动监听
function removeTableScrollListener() {
  console.log("移除表格滚动监听 - 开始");
  if (tableBodyWrapper.value) {
    tableBodyWrapper.value.removeEventListener("scroll", handleTableScroll, true);
    console.log("成功移除表格滚动监听");
    tableBodyWrapper.value = null;
  } else {
    console.log("tableBodyWrapper.value 不存在，无需移除监听");
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
      console.log("使用已加载的日志数据");

      // 清空并填充logsData
      logsData.length = 0;
      gitStore.log.forEach((item) => logsData.push(item));

      // 由于TypeScript类型错误，我们直接设置totalCommits而不是使用logs.value.length
      totalCommits.value = gitStore.log.length;

      // 确保视图被渲染
      if (showGraphView.value) {
        setTimeout(() => {
          console.log(`准备渲染图表，数据长度: ${logsData.length}`);
          renderGraph();
        }, 100);
      } else {
        // 如果是表格视图，渲染分支图
        setTimeout(() => {
          renderTableBranchGraph();
        }, 100);
      }
    } else {
      // 否则加载数据
      console.log("初始加载日志数据");
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

  // 表格数据加载完成后绘制分支图
  nextTick(() => {
    setTimeout(() => {
      if (!showGraphView.value) {
        renderTableBranchGraph();
      }
    }, 500);
  });

  // 添加对表格的监听，确保表格创建后设置滚动监听
  watch(() => tableRef.value, (newTableRef) => {
    if (newTableRef && !showGraphView.value && !showAllCommits.value) {
      console.log("表格引用已创建，设置滚动监听");
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
      console.log(`分支数据更新，共 ${availableBranches.value.length} 个分支`);
    } else {
      availableBranches.value = [];
      console.warn("gitStore 中没有分支数据");
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

// 添加一个简单的防抖函数
function debounce(fn: Function, delay: number) {
  let timer: number | null = null;
  return function(...args: any[]) {
    if (timer) clearTimeout(timer);
    timer = window.setTimeout(() => {
      fn(...args);
      timer = null;
    }, delay);
  };
}

// 对renderTableBranchGraph进行防抖处理
const debouncedRenderTableBranchGraph = debounce(renderTableBranchGraph, 200);

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
  } else {
    // 如果是表格视图，清空并重新计算分支图
    commitNodes.value.clear();
    branchLines.value = [];
    columnCount.value = 1;
    await nextTick();
    // 使用防抖版本
    debouncedRenderTableBranchGraph();
  }
}

// 监听store中的日志变化
watch(
  () => gitStore.log,
  (newLogs) => {
    console.log("监听到gitStore.log变化，更新图表数据");

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

      console.log(`数据更新完成，共${logs.value.length}条记录，准备渲染图表`);

      if (showGraphView.value && logsData.length > 0) {
        setTimeout(renderGraph, 0);
      }
    } catch (error) {
      console.error("更新日志数据失败:", error);
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

  // 调试输出当前提交对象的所有属性
  console.log("提交详情对象:", JSON.stringify(commit, null, 2));
  console.log(
    "哈希值类型和长度:",
    typeof commit.hash,
    commit.hash ? commit.hash.length : 0
  );
  console.log(
    "提交信息类型和长度:",
    typeof commit.message,
    commit.message ? commit.message.length : 0
  );
  console.log("提交分支:", commit.branch);

  try {
    console.log(`获取提交详情: ${commit.hash}`);

    // 确保哈希值有效
    if (!commit.hash || commit.hash.length < 7) {
      console.error("无效的提交哈希值:", commit.hash);
      commitDiff.value = "无效的提交哈希值";
      isLoadingCommitDetail.value = false;
      return;
    }

    // 获取提交的变更文件列表
    const filesResponse = await fetch(`/api/commit-files?hash=${commit.hash}`);
    console.log("API响应状态: ", filesResponse.status);
    const filesData = await filesResponse.json();
    console.log("文件列表数据: ", filesData);

    if (filesData.success && Array.isArray(filesData.files)) {
      commitFiles.value = filesData.files;

      // 如果有文件，自动加载第一个文件的差异
      if (commitFiles.value.length > 0) {
        await getCommitFileDiff(commit.hash, commitFiles.value[0]);
      } else {
        console.log("没有找到变更文件");
        commitDiff.value = "该提交没有变更文件";
      }
    } else {
      console.error("获取提交文件列表失败:", filesData.error || "未知错误");
      commitDiff.value = `获取文件列表失败: ${filesData.error || "未知错误"}`;
    }
  } catch (error) {
    console.error("获取提交详情失败:", error);
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
    console.log(`获取文件差异: hash=${hash}, file=${filePath}`);
    const diffResponse = await fetch(
      `/api/commit-file-diff?hash=${hash}&file=${encodeURIComponent(filePath)}`
    );
    console.log("差异API响应状态: ", diffResponse.status);
    const diffData = await diffResponse.json();
    console.log("差异数据: ", diffData.success, typeof diffData.diff);

    if (diffData.success) {
      commitDiff.value = diffData.diff || "没有变更内容";
    } else {
      console.error("获取差异失败: ", diffData.error);
      commitDiff.value = `获取差异失败: ${diffData.error || "未知错误"}`;
    }
  } catch (error) {
    console.error("获取文件差异失败:", error);
    commitDiff.value = `获取差异失败: ${(error as Error).message}`;
  } finally {
    isLoadingCommitDetail.value = false;
  }
}

// 格式化差异内容，添加颜色
function formatDiff(diffText: string) {
  if (!diffText) return "";

  // 将差异内容按行分割
  const lines = diffText.split("\n");

  // 转义 HTML 标签的函数
  function escapeHtml(text: string) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // 为每行添加适当的 CSS 类
  return lines
    .map((line) => {
      // 先转义 HTML 标签，再添加样式
      const escapedLine = escapeHtml(line);

      if (line.startsWith("diff --git")) {
        return `<div class="diff-header">${escapedLine}</div>`;
      } else if (line.startsWith("---")) {
        return `<div class="diff-old-file">${escapedLine}</div>`;
      } else if (line.startsWith("+++")) {
        return `<div class="diff-new-file">${escapedLine}</div>`;
      } else if (line.startsWith("@@")) {
        return `<div class="diff-hunk-header">${escapedLine}</div>`;
      } else if (line.startsWith("+")) {
        return `<div class="diff-added">${escapedLine}</div>`;
      } else if (line.startsWith("-")) {
        return `<div class="diff-removed">${escapedLine}</div>`;
      } else {
        return `<div class="diff-context">${escapedLine}</div>`;
      }
    })
    .join("");
}

// 格式化提交信息，支持多行显示
function formatCommitMessage(message: string) {
  if (!message) return "(无提交信息)";

  // 调试输出
  console.log("格式化前的提交信息:", message);
  console.log("提交信息中的换行符数量:", (message.match(/\n/g) || []).length);

  // 返回格式化后的提交信息，保留换行符
  return message.trim();
}

// 提取纯净的提交信息（去除类型前缀）
function extractPureMessage(message: string): string {
  if (!message) return "";

  // 匹配常见的提交信息格式：type(scope): description 或 type: description
  // 使用 dotAll 标志来匹配多行内容
  const conventionalCommitRegex = /^(feat|fix|docs|style|refactor|perf|test|chore|build|ci|revert)(\([^)]+\))?\s*:\s*(.+)$/s;
  const match = message.match(conventionalCommitRegex);

  if (match) {
    // 如果匹配到标准格式，返回描述部分（保留多行结构）
    return match[3].trim();
  }

  // 如果不是标准格式，返回原始信息
  return message.trim();
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
    console.log("不满足加载更多条件:", {
      hasMoreData: hasMoreData.value,
      isLoadingMore: isLoadingMore.value,
      isLoading: isLoading.value
    });
    return;
  }

  console.log(`加载更多日志，当前页码: ${currentPage.value}，下一页: ${currentPage.value + 1}`);
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
    console.log("获取所有可用作者...");
    const response = await fetch("/api/authors");
    const result = await response.json();

    if (result.success && Array.isArray(result.authors)) {
      // 更新可用作者列表
      availableAuthors.value = result.authors.sort();
      console.log(`获取到${availableAuthors.value.length}位作者`);
    } else {
      // 如果获取作者列表失败，但正常获取了日志
      // 从当前加载的日志中提取作者列表作为备选
      console.warn("从API获取作者列表失败，将从现有日志中提取作者列表");
      extractAuthorsFromLogs();
    }
  } catch (error) {
    console.error("获取作者列表失败:", error);
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
  console.log(`从现有日志中提取了${availableAuthors.value.length}位作者`);
}

// 渲染表格中的分支图
function renderTableBranchGraph() {
  if (!tableRef.value || showGraphView.value) return;
  
  // 清空之前的计算结果
  commitNodes.value.clear();
  branchLines.value = [];
  columnCount.value = 1;
  
  // 第一步：为每个提交分配列位置
  assignColumnsToCommits();
  
  // 第二步：绘制图形
  nextTick(() => {
    drawBranchGraphs();
  });
}

// 为每个提交分配列位置
function assignColumnsToCommits() {
  // 重置数据
  commitNodes.value.clear();
  branchLines.value = [];
  branchInfo.value.clear();
  
  // 创建提交图
  const commitGraph = new Map<string, string[]>(); // hash -> [parent hashes]
  const childrenMap = new Map<string, string[]>(); // hash -> [child hashes]
  
  // 第一步：构建提交图和子提交映射
  logs.value.forEach(commit => {
    if (!commit.hash) return;
    
    // 记录提交的父提交
    if (commit.parents && commit.parents.length > 0) {
      commitGraph.set(commit.hash, [...commit.parents]);
      
      // 记录每个父提交的子提交
      commit.parents.forEach(parentHash => {
        if (!childrenMap.has(parentHash)) {
          childrenMap.set(parentHash, []);
        }
        childrenMap.get(parentHash)?.push(commit.hash);
      });
    } else {
      commitGraph.set(commit.hash, []);
    }
  });
  
  // 第二步：分配分支和列
  // 使用固定的主分支列和颜色
  const mainColumn = 0;
  const mainBranchColor = "#2196f3"; // 蓝色
  
  // 其他分支的颜色
  const branchColors = [
    "#e91e63", // 粉色
    "#4caf50", // 绿色
    "#ff9800", // 橙色
    "#9c27b0", // 紫色
    "#00bcd4", // 青色
    "#ff5722", // 深橙色
    "#607d8b", // 蓝灰色
  ];
  
  // 创建分支映射，用于跟踪每个提交所属的分支
  const branchByCommit = new Map<string, string>();
  
  // 从提交信息中提取分支名称
  logs.value.forEach(commit => {
    if (!commit.hash || !commit.branch) return;
    
    // 尝试从分支信息中提取分支名
    const branchMatches = commit.branch.match(/(HEAD -> |origin\/)?([^\s,]+)/g);
    if (branchMatches && branchMatches.length > 0) {
      // 优先使用HEAD指向的分支
      const headBranch = branchMatches.find(b => b.includes("HEAD -> "));
      if (headBranch) {
        const branchName = headBranch.replace("HEAD -> ", "").trim();
        branchByCommit.set(commit.hash, branchName);
      } else {
        // 否则使用第一个分支名
        const branchName = branchMatches[0].replace("origin/", "").trim();
        branchByCommit.set(commit.hash, branchName);
      }
    }
  });
  
  // 为每个分支分配一个唯一的列
  const branchColumns = new Map<string, number>();
  let nextColumn = 0;
  
  // 确保主分支在第一列
  branchColumns.set("main", mainColumn);
  branchColumns.set("master", mainColumn);
  nextColumn++;
  
  // 为分支分配颜色
  const branchColorMap = new Map<string, string>();
  branchColorMap.set("main", mainBranchColor);
  branchColorMap.set("master", mainBranchColor);
  
  // 为每个提交分配列
  const columns = new Map<string, number>();
  
  // 首先处理有明确分支名的提交
  logs.value.forEach((commit, index) => {
    if (!commit.hash) return;
    
    const hash = commit.hash;
    const branchName = branchByCommit.get(hash) || "main";
    
    // 为分支分配列
    if (!branchColumns.has(branchName)) {
      branchColumns.set(branchName, nextColumn++);
      
      // 为分支分配颜色
      const colorIndex = (branchColumns.get(branchName) || 0) % branchColors.length;
      branchColorMap.set(branchName, branchColors[colorIndex]);
    }
    
    // 记录提交的列
    const column = branchColumns.get(branchName) || 0;
    columns.set(hash, column);
    
    // 记录提交节点
    commitNodes.value.set(hash, {
      hash,
      parents: commit.parents || [],
      column,
      row: index,
      branch: branchName
    });
    
    // 记录分支信息
    if (!branchInfo.value.has(branchName)) {
      branchInfo.value.set(branchName, {
        name: branchName,
        color: branchColorMap.get(branchName) || mainBranchColor,
        column
      });
    }
  });
  
  // 处理合并提交和分支线
  logs.value.forEach((commit, rowIndex) => {
    if (!commit.hash || !commit.parents || commit.parents.length === 0) return;
    
    const currentNode = commitNodes.value.get(commit.hash);
    if (!currentNode) return;
    
    const currentColumn = currentNode.column;
    const currentBranchName = currentNode.branch || "main";
    const currentColor = branchColorMap.get(currentBranchName) || mainBranchColor;
    
    // 处理每个父提交
    commit.parents.forEach((parentHash, parentIndex) => {
      const parentRow = logs.value.findIndex(c => c.hash === parentHash);
      if (parentRow < 0) return; // 父提交不在当前日志中
      
      const parentNode = commitNodes.value.get(parentHash);
      if (!parentNode) return;
      
      const parentColumn = parentNode.column;
      const parentBranchName = parentNode.branch || "main";
      const parentColor = branchColorMap.get(parentBranchName) || mainBranchColor;
      
      // 确定连接线的颜色
      let lineColor = currentColor;
      
      // 如果是合并提交，第一个父提交使用当前分支颜色，其他父提交使用各自分支颜色
      if (commit.parents && commit.parents.length > 1 && parentIndex > 0) {
        lineColor = parentColor;
      }
      
      // 添加分支线
      branchLines.value.push({
        fromRow: rowIndex,
        fromColumn: currentColumn,
        toRow: parentRow,
        toColumn: parentColumn,
        color: lineColor
      });
    });
  });
  
  // 更新最大列数
  columnCount.value = nextColumn;
  
  // 导出变量以供其他函数使用
  return { mainBranchColor, branchColorMap };
}

// 添加一个变量来控制绘制状态，防止重复渲染
let isDrawingBranchGraph = false;

// 绘制分支图
function drawBranchGraphs() {
  // 检查是否正在进行渲染
  if (isDrawingBranchGraph) {
    console.log("已有渲染进行中，跳过");
    return;
  }
  
  try {
    isDrawingBranchGraph = true;
    
    // 获取分支颜色映射，但防止递归调用
    const branchColorMap = new Map<string, string>();
    branchColorMap.set("main", "#2196f3"); // 蓝色
    branchColorMap.set("master", "#2196f3"); // 蓝色
    const mainBranchColor = "#2196f3";
    
    // 仅当branchLines为空时才重新计算
    if (branchLines.value.length === 0) {
      console.log("branchLines为空，重新计算");
      // 重新分配列位置
      assignColumnsToCommits();
      
      // 如果还是为空，创建一些默认线条
      if (branchLines.value.length === 0 && logs.value.length > 1) {
        console.log("创建默认分支线");
        // 为连续的提交创建简单的垂直线
        for (let i = 0; i < logs.value.length - 1; i++) {
          if (logs.value[i].hash && logs.value[i+1].hash) {
            branchLines.value.push({
              fromRow: i,
              fromColumn: 0, // 主分支列
              toRow: i+1,
              toColumn: 0, // 主分支列
              color: mainBranchColor
            });
          }
        }
      }
    } else {
      console.log(`使用现有分支线，数量: ${branchLines.value.length}`);
    }
    
    // 为每个提交绘制图形
    logs.value.forEach((commit, rowIndex) => {
      if (!commit.hash) return;
      
      const cellId = `commit-graph-${commit.hash.substring(0, 7)}`;
      const cell = document.getElementById(cellId);
      if (!cell) return;
      
      // 如果单元格已经有SVG，跳过
      if (cell.querySelector('svg')) {
        return;
      }
      
      // 创建SVG元素
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      // 使用标准viewBox，但确保overflow是visible
      svg.setAttribute("viewBox", "0 0 100 100");
      svg.style.display = "block";
      svg.style.overflow = "visible";
      
      // 清空单元格
      cell.innerHTML = "";
      cell.appendChild(svg);
      
      // 获取当前提交节点
      const node = commitNodes.value.get(commit.hash);
      if (!node) return;
      
      // 调整坐标系统，使用百分比布局
      const columnWidth = 20;
      const x = 10 + node.column * columnWidth;
      const y = 50; // 中点是50%的位置
      
      // 查找与当前行相关的所有分支线
      const relevantLines: GraphLine[] = [];
      
      // 1. 通过当前行的线
      for (const line of branchLines.value) {
        if (line.fromRow < rowIndex && line.toRow > rowIndex) {
          relevantLines.push({
            ...line,
            type: 'through',
            x: 10 + line.fromColumn * columnWidth
          });
        }
      }
      
      // 2. 从当前行出发的线
      for (const line of branchLines.value) {
        if (line.fromRow === rowIndex) {
          relevantLines.push({
            ...line,
            type: 'from',
            fromX: 10 + line.fromColumn * columnWidth,
            toX: 10 + line.toColumn * columnWidth
          });
        }
      }
      
      // 3. 到当前行的线
      for (const line of branchLines.value) {
        if (line.toRow === rowIndex) {
          relevantLines.push({
            ...line,
            type: 'to',
            fromX: 10 + line.fromColumn * columnWidth,
            toX: 10 + line.toColumn * columnWidth
          });
        }
      }
      
      // 如果relevantLines为空且不是最后一行，添加默认线条
      if (relevantLines.length === 0 && rowIndex < logs.value.length - 1) {
        // 向下的线
        if (branchLines.value.length > 0) {
          relevantLines.push({
            ...branchLines.value[0],
            type: 'from',
            fromX: x,
            toX: x
          });
        } else {
          // 创建默认线条
          relevantLines.push({
            type: 'from',
            fromX: x,
            toX: x,
            fromRow: rowIndex,
            fromColumn: 0,
            toRow: rowIndex + 1,
            toColumn: 0,
            color: mainBranchColor
          });
        }
      }
      
      // 先绘制通过的线 - 从-20高度到120高度，远超出viewBox范围
      relevantLines.filter((line): line is ThroughLine => line.type === 'through').forEach(line => {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "line");
        path.setAttribute("x1", line.x.toString());
        path.setAttribute("y1", "-20"); // 远超出viewBox顶部
        path.setAttribute("x2", line.x.toString());
        path.setAttribute("y2", "120"); // 远超出viewBox底部
        path.setAttribute("stroke", line.color);
        path.setAttribute("stroke-width", "2");
        svg.appendChild(path);
      });
      
      // 绘制到当前节点的线 - 从-20高度到50%高度(中点)
      relevantLines.filter((line): line is ToLine => line.type === 'to').forEach(line => {
        if (line.fromColumn === line.toColumn) {
          // 垂直线
          const path = document.createElementNS("http://www.w3.org/2000/svg", "line");
          path.setAttribute("x1", line.toX.toString());
          path.setAttribute("y1", "-20"); // 远超出viewBox顶部
          path.setAttribute("x2", line.toX.toString());
          path.setAttribute("y2", y.toString()); // 到达中点
          path.setAttribute("stroke", line.color);
          path.setAttribute("stroke-width", "2");
          svg.appendChild(path);
        } else {
          // 斜线或弯曲线
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          
          if (line.fromColumn < line.toColumn) {
            // 从左到右
            path.setAttribute("d", `M${line.fromX},-20 C${line.fromX},15 ${line.toX},30 ${line.toX},${y}`);
          } else {
            // 从右到左
            path.setAttribute("d", `M${line.fromX},-20 C${line.fromX},15 ${line.toX},30 ${line.toX},${y}`);
          }
          
          path.setAttribute("stroke", line.color);
          path.setAttribute("stroke-width", "2");
          path.setAttribute("fill", "none");
          svg.appendChild(path);
        }
      });
      
      // 绘制从当前节点出发的线 - 从50%高度(中点)到120高度
      relevantLines.filter((line): line is FromLine => line.type === 'from').forEach(line => {
        if (line.fromColumn === line.toColumn) {
          // 垂直线
          const path = document.createElementNS("http://www.w3.org/2000/svg", "line");
          path.setAttribute("x1", line.fromX.toString());
          path.setAttribute("y1", y.toString()); // 从中点开始
          path.setAttribute("x2", line.fromX.toString());
          path.setAttribute("y2", "120"); // 远超出viewBox底部
          path.setAttribute("stroke", line.color);
          path.setAttribute("stroke-width", "2");
          svg.appendChild(path);
        } else {
          // 斜线或弯曲线
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          
          if (line.fromColumn < line.toColumn) {
            // 向右弯曲
            path.setAttribute("d", `M${line.fromX},${y} C${line.fromX},70 ${line.toX},85 ${line.toX},120`);
          } else {
            // 向左弯曲
            path.setAttribute("d", `M${line.fromX},${y} C${line.fromX},70 ${line.toX},85 ${line.toX},120`);
          }
          
          path.setAttribute("stroke", line.color);
          path.setAttribute("stroke-width", "2");
          path.setAttribute("fill", "none");
          svg.appendChild(path);
        }
      });
      
      // 绘制当前提交的点
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", x.toString());
      circle.setAttribute("cy", y.toString());
      circle.setAttribute("r", "6"); // 稍微增大点的大小
      
      // 获取分支颜色
      const branchName = node.branch || "";
      const branchColor = branchColorMap.get(branchName) || mainBranchColor;
      
      circle.setAttribute("fill", branchColor);
      circle.setAttribute("stroke", "#fff");
      circle.setAttribute("stroke-width", "2");
      svg.appendChild(circle);
    });
  } catch (error) {
    console.error("渲染分支图失败:", error);
    errorMessage.value = "渲染分支图失败: " + (error instanceof Error ? error.message : String(error));
  } finally {
    isDrawingBranchGraph = false;
  }
}

// 监听logs.value的变化
watch(
  () => logs.value,
  () => {
    nextTick(() => {
      if (!showGraphView.value) {
        // 使用防抖版本
        debouncedRenderTableBranchGraph();
      }
    });
  },
  { deep: true } // 添加deep选项以确保检测到数组内部元素的变化
);

// 处理右键菜单事件
function handleContextMenu(row: LogItem, column: any, event: MouseEvent) {
  console.log("handleContextMenu", row, column, event);
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
      console.error("撤销提交出错:", error);
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
      console.error("Cherry-Pick提交出错:", error);
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
    console.error("复制提交哈希失败:", error);
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
      console.error("重置到指定提交出错:", error);
      ElMessage.error("重置到指定提交失败: " + (error.message || error));
    }
  }
}

// 检查表格是否滚动到底部并加载更多数据
function checkAndLoadMore() {
  console.log("检查是否需要加载更多数据");
  
  if (
    showGraphView.value ||
    !hasMoreData.value ||
    isLoadingMore.value ||
    isLoading.value ||
    showAllCommits.value
  ) {
    console.log("不满足加载条件:", {
      showGraphView: showGraphView.value,
      hasMoreData: hasMoreData.value,
      isLoadingMore: isLoadingMore.value,
      isLoading: isLoading.value,
      showAllCommits: showAllCommits.value
    });
    return;
  }
  
  if (!tableBodyWrapper.value) {
    console.log("表格容器不存在，重新设置滚动监听");
    setupTableScrollListener();
    return;
  }
  
  const { scrollTop, scrollHeight, clientHeight } = tableBodyWrapper.value;
  const scrollDistance = scrollHeight - scrollTop - clientHeight;
  
  console.log("表格滚动位置:", {
    scrollTop,
    scrollHeight,
    clientHeight,
    scrollDistance
  });
  
  if (scrollDistance <= 50) {
    console.log("表格已滚动到底部，加载更多数据");
    loadMoreLogs();
  }
}

// 在表格视图显示时添加定时检查
watch(() => showGraphView.value, (isGraphView) => {
  if (!isGraphView && !showAllCommits.value) {
    console.log("切换到表格视图，设置滚动监听和定时检查");
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
            分页加载 (每页100条)
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
            {{ showAllCommits ? "(全部)" : "(分页加载，每页100条)" }}
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
            height="500"
            @row-contextmenu="handleContextMenu"
          >
            <el-table-column width="60" class-name="branch-graph-column">
              <template #default="scope">
                <div class="branch-graph-cell" :id="`commit-graph-${scope.row.hash.substring(0, 7)}`"></div>
              </template>
            </el-table-column>
            <el-table-column label="提交哈希" width="100" resizable>
              <template #default="scope">
                <span
                  class="commit-hash"
                  @click="viewCommitDetail(scope.row)"
                  >{{ scope.row.hash.substring(0, 7) }}</span
                >
              </template>
            </el-table-column>
            <el-table-column prop="date" label="日期" width="120" resizable />
            <el-table-column label="作者" width="120" resizable>
              <template #default="scope">
                <el-tooltip
                  :content="scope.row.email"
                  placement="top"
                  :hide-after="1000"
                >
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
            <el-table-column label="提交信息" min-width="250">
              <template #default="scope">
                <div class="commit-message-cell">
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
              </template>
            </el-table-column>
          </el-table>

          <!-- 添加底部加载状态和加载更多按钮 -->
          <div v-if="!showAllCommits && false" class="load-more-container">
            <!-- 显示加载状态和页码信息 -->
            <div class="pagination-info">
              <span>第 {{ currentPage }} 页
                {{ totalCommits > 0 ? `/ 共 ${Math.ceil(totalCommits / 100) || 1} 页` : "" }}
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
    <el-dialog
      v-model="commitDetailVisible"
      :title="`提交详情: ${
        selectedCommit?.hash ? selectedCommit.hash.substring(0, 7) : '未知'
      }`"
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
        <div class="commit-files-diff">
          <div class="files-list">
            <h3>变更文件</h3>
            <el-empty
              v-if="commitFiles.length === 0"
              description="没有找到变更文件"
            ></el-empty>
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
            <h3 v-if="selectedCommitFile">
              文件差异: {{ selectedCommitFile }}
            </h3>
            <h3 v-else>文件差异</h3>
            <el-empty
              v-if="!commitDiff && !isLoadingCommitDetail"
              description="选择文件查看差异"
            ></el-empty>
            <div
              v-else-if="commitDiff"
              v-html="formatDiff(commitDiff)"
              class="diff-content"
            ></div>
          </div>
        </div>
      </div>
    </el-dialog>
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
  background-color: white;
  border-radius: 8px;
  box-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.1);
  margin-bottom: 20px;
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
  padding:16px;
  border-bottom: 1px solid #ebeef5;
  position: sticky;
  top: 0;
  background-color: white;
  z-index: 100;
}

.fullscreen-mode .log-header {
  margin-bottom: 10px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.header-left h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: #303133;
}

.log-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 优化按钮样式 */
.action-button {
  transition: all 0.3s ease;
  border-radius: 8px;
  border: 1px solid transparent;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  font-weight: 500;
  padding: 8px 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
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
  padding: 8px;
  border-radius: 50%;
  width: 36px;
  height: 36px;
}

.refresh-button:hover {
  background: linear-gradient(135deg, #606266 0%, #909399 100%);
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
  padding: 10px 16px;
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
  height: 48px;
}

:deep(.el-table__row) {
  transition: all 0.2s ease;
}

:deep(.el-table__row:hover) {
  background-color: #ecf5ff !important;
}

:deep(.el-table--striped .el-table__row--striped) {
  background-color: #fafafa;
}

:deep(.el-table__cell) {
  padding: 8px 0;
}

.branch-container {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.branch-tag {
  margin-right: 0;
  border-radius: 4px;
  transition: all 0.2s ease;
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
  background-color: #fff;
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
  background-color: #fff;
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
}

.commit-hash {
  cursor: pointer;
  color: #409eff;
  font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
  font-weight: 500;
  border-radius: 4px;
  padding: 2px 4px;
  background-color: #ecf5ff;
  transition: all 0.2s ease;
}

.commit-hash:hover {
  text-decoration: none;
  background-color: #d9ecff;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
}

.commit-detail-container {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.commit-info {
  padding: 16px;
  background-color: #f5f7fa;
  border-radius: 8px;
  font-size: 14px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.commit-info-header {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: center;
  background-color: #fff;
  padding: 16px;
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

.message-content {
  background-color: #fff;
  padding: 16px;
  border-radius: 8px;
  font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
  white-space: pre-wrap;
  line-height: 1.6;
  border: 1px solid #e4e7ed;
  border-left: 4px solid #409eff;
}

.commit-files-diff {
  margin-top: 8px;
  display: flex;
  gap: 20px;
  height: 60vh;
}

.files-list {
  width: 25%;
  overflow-y: auto;
  background-color: #f5f7fa;
  border-radius: 8px;
  padding: 16px;
}

.files-list h3 {
  margin-top: 0;
  padding-bottom: 12px;
  border-bottom: 1px solid #dcdfe6;
  font-size: 16px;
  font-weight: 500;
}

.files-list ul {
  list-style: none;
  padding: 0;
  margin: 0;
}

.files-list li {
  padding: 10px 12px;
  cursor: pointer;
  border-radius: 4px;
  margin-bottom: 6px;
  font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
  transition: all 0.2s ease;
  border: 1px solid transparent;
}

.files-list li:hover {
  background-color: #ecf5ff;
  border-color: #d9ecff;
}

.files-list li.active-file {
  background-color: #409eff;
  color: white;
  box-shadow: 0 2px 6px rgba(64, 158, 255, 0.3);
}

.file-diff {
  flex: 1;
  display: flex;
  flex-direction: column;
  background-color: #f5f7fa;
  border-radius: 8px;
  padding: 16px;
  overflow: hidden;
}

.file-diff h3 {
  margin-top: 0;
  padding-bottom: 12px;
  border-bottom: 1px solid #dcdfe6;
  font-size: 16px;
  font-weight: 500;
}

.diff-content {
  flex: 1;
  overflow-y: auto;
  background-color: #fff;
  padding: 16px;
  border-radius: 8px;
  font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 13px;
  line-height: 1.6;
  border: 1px solid #ebeef5;
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

/* 减小对话框的顶部边距 */
:deep(.commit-detail-dialog) {
  --el-dialog-margin-top: 7vh;
}

:deep(.commit-detail-dialog .el-dialog__body) {
  padding: 16px;
}

.filter-panel-header {
  background-color: #f5f7fa;
  padding: 16px;
  margin-bottom: 16px;
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
  background-color: white;
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
  gap: 8px;
  min-height: 32px;
}

.message-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  background: white;
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

/* 分支图样式 */
.branch-graph-column {
  padding: 0 !important;
  overflow: visible;
}

.branch-graph-cell {
  height: 40px;
  width: 100%;
  position: relative;
  padding: 0;
  margin: 0;
}

/* 分支图列样式 */
.branch-graph-column .cell {
  padding: 0 !important;
  height: 100%;
  margin: 0;
  overflow: visible;
}

.el-table .branch-graph-column {
  width: 60px !important;
  padding: 0 !important;
}

:deep(.el-table .el-table__cell) {
  padding: 0 !important;
}

/* 确保SVG元素完全填充单元格 */
:deep(.branch-graph-cell svg) {
  display: block !important;
  width: 100% !important;
  height: 100% !important;
  overflow: visible !important;
  z-index: 10 !important;
}

/* 增强SVG线条和节点的可见性 */
:deep(.branch-graph-cell svg line),
:deep(.branch-graph-cell svg path) {
  stroke-width: 2 !important;
}

:deep(.branch-graph-cell svg circle) {
  r: 6 !important;
  stroke-width: 2 !important;
}

/* 增加分支图单元格的宽度 */
.branch-graph-column {
  min-width: 60px !important;
  width: 60px !important;
}

/* 确保分支图单元格内容可见 */
.branch-graph-cell {
  position: relative !important;
  overflow: visible !important;
  z-index: 1 !important;
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
  background-color: white;
  display: flex;
  flex-direction: column;
  overflow: auto;
}

/* 全屏模式下的头部区域 */
.fullscreen-mode .log-header {
  position: sticky;
  top: 0;
  z-index: 10;
  background-color: white;
  padding: 16px;
  margin-bottom: 10px;
  width: 100%;
}

/* 全屏模式下的筛选面板 */
.fullscreen-mode .filter-panel-header {
  position: sticky;
  top: 60px;
  z-index: 9;
  background-color: white;
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
  background: white;
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

