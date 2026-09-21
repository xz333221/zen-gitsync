<!--
  ~ Copyright 2026 xz333221
  ~
  ~ Licensed under the Apache License, Version 2.0 (the "License");
  ~ you may not use this file except in compliance with the License.
  ~ You may obtain a copy of the License at
  ~
  ~     http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing, software
  ~ distributed under the License is distributed on an "AS IS" BASIS,
  ~ WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  ~ See the License for the specific language governing permissions and
  ~ limitations under the License.
  -->
<script setup lang="ts">
// 最近项目 / 常用目录的统一列表组件(同一份数据源 + 同一套卡片外观)。
//
// 两个调用方,差异只有两点,全部由 props 表达:
//   1. 点击语义  mode='open'(App.vue 非 Git 仓库空态)   → 点击即在新的 cmd 标签页打开该目录
//               mode='pick'(切换工作目录弹窗的常用目录) → 点击把路径回填到输入框,
//                                                       Ctrl/Cmd + 点击才在新标签页打开
//   2. 外壳形态  variant='panel' → 自带标题行 + 搜索框 + 卡片容器,撑满父级高度(右侧整列空态)
//               variant='bare'  → 无外壳直接铺在弹窗表单里,列表自身限高滚动
//
// 拉取 / 搜索 / 加载态 / 空态 / 复制路径 / 移除 都收在这里,调用方不再各写一份。
// 数据源:GET /api/recent_directories(只读) + POST /api/remove_recent_directory(移除)
//        + POST /api/recent_directories/git-state(批量探测每个目录的 Git 状态)
//
// i18n 复用 @13D1C 命名空间:该分组原本就是 GitStatus.vue 定义、被目录相关组件沿用的
// 目录家族文案(原 RecentProjectsList.vue 同样复用),不为此新建命名空间。
import { computed, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Delete, DocumentCopy, Folder, Loading, Refresh, Search } from "@element-plus/icons-vue";
import { $t } from "@/lang/static";
import { getFolderNameFromPath } from "@/utils/path";

/** 后端 /api/recent_directories/git-state 的单条结果 */
interface DirectoryGitState {
  exists: boolean;
  /** true=仓库 / false=不是仓库 / null=没探到(超时等)。null 时不显示任何 Git 标记,不谎报 */
  isGitRepo: boolean | null;
  changed: number;
  staged: number;
  unstaged: number;
  untracked: number;
  /** 当前分支(分离 HEAD 时 null) */
  branch: string | null;
  /** 上游引用,如 origin/develop;没设上游时为 null */
  upstream: string | null;
  /** 本地领先上游的提交数 = 有未推送的提交 */
  ahead: number;
  /** 本地落后上游的提交数 = 远端有新提交,该 pull 了 */
  behind: number;
  error?: string;
}

/** 列表项(带 basename 与 Git 状态) */
interface DirectoryItem {
  path: string;
  exists: boolean;
  base: string;
  git: DirectoryGitState | null;
}

/** 后端 /api/recent_directories/fetch 的结果 */
interface DirectoryFetchResult {
  /** ok=已 fetch 并带回最新状态 | skipped=不需要联网(非仓库/无 remote) | failed=fetch 没成功 */
  status: "ok" | "skipped" | "failed";
  reason?: string;
  error?: string;
  timeout?: boolean;
  timeoutSeconds?: number;
  /** fetch 成功后重探的状态,直接覆盖卡片徽标 */
  state?: DirectoryGitState | null;
}

/**
 * 「刷新全部」的并发数。
 * 串行要等十几个网络往返（每个几秒），并发全开又会互相抢网络、更容易撞出
 * 一堆凭据提示；3 是"总时长压到 1/3"与"别把出口打满"之间的折中。
 */
const REFRESH_CONCURRENCY = 3;

const props = withDefaults(defineProps<{
  /** open:点击即新标签页打开 | pick:点击上抛 select 事件,由父组件决定(弹窗里是回填输入框) */
  mode?: "open" | "pick";
  /** panel:带外框/标题/搜索的空态面板 | bare:裸列表,用于弹窗内嵌 */
  variant?: "panel" | "bare";
  /** missing:只允许移除已失效目录(避免误删还能打开的有效项目) | always:任意条目都可移除 */
  removable?: "missing" | "always";
  /** 挂载时自动拉取;弹窗场景传 false,由父组件在打开时调 reload() */
  autoLoad?: boolean;
  /** 卡片网格每列最小宽度,窄容器下自动降为单列 */
  minCardWidth?: string;
  /** 移除按钮的提示文案(两处语境不同,由调用方传) */
  removeLabel?: string;
  /** 空态文案 */
  emptyText?: string;
  /** 列表的无障碍标签 */
  ariaLabel?: string;
}>(), {
  mode: "open",
  variant: "panel",
  removable: "missing",
  autoLoad: true,
  minCardWidth: "380px",
});

const emit = defineEmits<{ select: [path: string]; loaded: [count: number] }>();

const directories = ref<Array<{ path: string; exists: boolean }>>([]);
const isLoading = ref(false);
// 目录路径 → Git 状态。探测是异步补充的,所以单独存一份,不阻塞列表渲染
const gitStates = ref<Record<string, DirectoryGitState>>({});
// 搜索关键词:只在 panel 形态渲染输入框,bare 形态下始终为空
const searchQuery = ref("");

// ── 「刷新全部」────────────────────────────────────────────────────────────
// 卡片上的「领先/落后」读的是**本地 remote-tracking 引用**——也就是"上次 fetch 时
// 的快照"(见后端 directoryGitState.js 的文件头)。远端别人推了新提交时,列表会一直
// 显示它已同步,只有 fetch 才更新那份引用。这个按钮就是把快照刷新一遍。
// 「未提交 N 项」是本地工作区实时扫描的结果,本来就不受 fetch 影响。
const isRefreshingAll = ref(false);
const refreshProgress = ref({ done: 0, total: 0 });
// 路径 → 失败原因。只进卡片 tooltip,不逐个弹窗:一次刷十几个,弹窗会连成一串。
const fetchErrors = ref<Record<string, string>>({});
// 按钮文案:刷新中直接显示进度,让"还剩几个没刷"一眼可见(图标同时在转)
const refreshLabel = computed(() =>
  isRefreshingAll.value
    ? $t("@13D1C:刷新中 {done}/{total}", {
        done: refreshProgress.value.done,
        total: refreshProgress.value.total,
      })
    : $t("@13D1C:刷新全部")
);

// 平台差异只影响"Ctrl + 点击"的提示文案(⌘ / Ctrl)
const isMac = computed(() => {
  if (typeof navigator === "undefined") return false;
  const uaData = (navigator as any).userAgentData;
  if (uaData?.platform) return /mac/i.test(uaData.platform);
  return /mac/i.test(navigator.platform || "");
});

const ctrlHint = computed(() =>
  isMac.value
    ? $t("@13D1C:按住 ⌘ 点击用新标签打开")
    : $t("@13D1C:按住 Ctrl 点击用新标签打开")
);

const removeLabelText = computed(() => props.removeLabel ?? $t("@13D1C:从最近项目中移除"));
const resolvedEmptyText = computed(() => props.emptyText ?? $t("@13D1C:暂无最近项目"));
const resolvedAriaLabel = computed(() => props.ariaLabel ?? $t("@13D1C:最近项目列表"));

// 列表项:补一个 basename 做第一行,完整路径放第二行(同名目录靠完整路径区分)
// 顺手把该目录的 Git 状态挂上去,模板里直接读 item.git,避免在模板里反复查表
const items = computed<DirectoryItem[]>(() => {
  const q = searchQuery.value.trim().toLowerCase();
  const list = q
    ? directories.value.filter(item => item.path.toLowerCase().includes(q))
    : directories.value;
  return list.map(item => {
    const state = gitStates.value[item.path];
    return {
      ...item,
      base: getFolderNameFromPath(item.path),
      // isGitRepo=null 表示没探到:当作"无状态"处理,界面上不显示 Git 标记
      git: state && state.isGitRepo !== null ? state : null,
    };
  });
});

// 悬浮提示里的 Git 附加信息:按"需要动作"的顺序排 —— 落后(要拉) → 领先(要推) → 工作区明细。
// 非仓库/未知不补充(徽标已表达);一切正常时明确说一句干净,避免"没内容"看起来像没探测。
function gitSummaryLines(item: DirectoryItem): string[] {
  const g = item.git;
  if (!g || g.isGitRepo !== true) return [];

  const lines: string[] = [];
  if (g.upstream && g.behind > 0) {
    lines.push($t("@13D1C:落后 {upstream} {count} 个提交", { upstream: g.upstream, count: g.behind }));
  }
  if (g.upstream && g.ahead > 0) {
    lines.push($t("@13D1C:领先 {upstream} {count} 个提交", { upstream: g.upstream, count: g.ahead }));
  }
  if (g.changed > 0) {
    lines.push($t("@13D1C:已暂存 {staged} · 未暂存 {unstaged} · 未跟踪 {untracked}", {
      staged: g.staged,
      unstaged: g.unstaged,
      untracked: g.untracked,
    }));
  }
  if (lines.length === 0) lines.push($t("@13D1C:Git 仓库,工作区干净"));
  return lines;
}

// 仓库"有话说"吗?有的话就用具体信息(未提交/领先/落后)替代那个中性的 Git 标签 ——
// 否则满屏 "Git" 徽标会白占宽度,把长路径挤成省略号。
function hasGitSignal(item: DirectoryItem) {
  const g = item.git;
  if (!g || g.isGitRepo !== true) return false;
  return g.changed > 0 || g.ahead > 0 || g.behind > 0;
}

// 整张卡片的悬浮提示:pick 形态下把"Ctrl+点击"的用法讲在这里
function itemTitle(item: DirectoryItem) {
  const lines: string[] = [];
  if (props.mode === "pick") lines.push(ctrlHint.value);
  lines.push(item.exists ? item.path : $t("@13D1C:目录不存在"));
  lines.push(...gitSummaryLines(item));
  // 刷新失败的原因排在最后:它是"这一次操作"的结果,不是仓库的常态
  const fetchError = fetchErrors.value[item.path];
  if (fetchError) lines.push($t("@13D1C:刷新失败：{error}", { error: fetchError }));
  return lines.join("\n");
}

function itemAriaLabel(item: { path: string; exists: boolean }) {
  if (!item.exists) return $t("@13D1C:{path} (目录不存在)", { path: item.path });
  return props.mode === "pick"
    ? $t("@13D1C:选择 {path}", { path: item.path })
    : $t("@13D1C:在新标签页打开 {path}", { path: item.path });
}

/** 移除按钮是否渲染:always 形态下任意条目都能清理 */
function canRemove(item: { exists: boolean }) {
  return props.removable === "always" || !item.exists;
}

// 批量探测 Git 状态。故意不 await:十几个目录要起十几个 git 进程,
// 让列表先渲染出来、徽标随后补上,别让"是不是仓库"拖慢首屏。
async function loadGitStates(paths: string[]) {
  const targets = paths.filter(p => typeof p === "string" && p.trim());
  if (targets.length === 0) return;
  try {
    const res = await fetch("/api/recent_directories/git-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: targets }),
    });
    const data = await res.json();
    if (data?.success && data.results) {
      // 合并而不是覆盖:某次探测超时的目录保留上一次已探到的结果
      gitStates.value = { ...gitStates.value, ...data.results };
    }
  } catch {
    // 探测失败只是没有徽标,不该打扰用户,也不影响列表本身
  }
}

async function load() {
  isLoading.value = true;
  try {
    const res = await fetch("/api/recent_directories", { cache: "no-store" });
    const data = await res.json();
    directories.value = Array.isArray(data?.directories) ? data.directories : [];
    // 不存在的目录没有探测意义(后端也会跳过),这里先过滤掉省一次请求
    void loadGitStates(directories.value.filter(d => d.exists !== false).map(d => d.path));
  } catch {
    directories.value = [];
  } finally {
    isLoading.value = false;
    // 上抛总数:调用方(bare 形态的弹窗)在 label 上标"共 N 个",列表滚动时也能看出总量
    emit("loaded", directories.value.length);
  }
}

/** 固定并发的极简任务池:完成一个补一个(客户端只此一处需要,不引第三方依赖) */
async function mapWithLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  const queue = items.slice();
  const size = Math.max(1, Math.min(limit, queue.length));
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (queue.length > 0) await worker(queue.shift() as T);
    })
  );
}

/**
 * 刷新全部:对每个项目执行一次 git fetch,每完成一个就更新那张卡片的徽标。
 *
 * 逐个请求(而不是让后端一把全刷)的理由:单个项目失败/超时都不牵连其余项目;
 * 进度是真的、能看见的;也不会出现一个挂两分钟还不返回的大请求。
 *
 * 失败原因只写进卡片 tooltip,不逐个弹窗 —— 刷十几个项目时弹窗会连成一串;
 * 结尾只留一条 toast 汇总三态计数。
 */
async function refreshAllGitStates() {
  if (isRefreshingAll.value) return;
  // 不存在的目录没有 fetch 的意义(后端也会跳过),先剔除省一轮请求
  const targets = directories.value.filter(d => d.exists !== false).map(d => d.path);
  if (targets.length === 0) return;

  isRefreshingAll.value = true;
  refreshProgress.value = { done: 0, total: targets.length };
  const errors: Record<string, string> = {};
  let ok = 0;
  let skipped = 0;
  let failed = 0;

  try {
    await mapWithLimit(targets, REFRESH_CONCURRENCY, async (path) => {
      try {
        const res = await fetch("/api/recent_directories/fetch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        });
        const data: DirectoryFetchResult | null = await res.json();
        if (data?.status === "ok") {
          ok += 1;
          // fetch 后的最新状态由后端一并带回,直接覆盖这张卡片的徽标
          if (data.state) gitStates.value = { ...gitStates.value, [path]: data.state };
        } else if (data?.status === "failed") {
          failed += 1;
          errors[path] = data.timeout
            ? $t("@13D1C:刷新超时（超过 {seconds} 秒）", { seconds: data.timeoutSeconds ?? 30 })
            : data.error || $t("@13D1C:刷新失败");
        } else {
          skipped += 1; // 非仓库 / 没配 remote / 已在刷新中:都不算错误
        }
      } catch (err) {
        failed += 1;
        errors[path] = (err as Error).message;
      } finally {
        refreshProgress.value = {
          done: refreshProgress.value.done + 1,
          total: refreshProgress.value.total,
        };
      }
    });
  } finally {
    isRefreshingAll.value = false;
    // 本轮刷过的路径,旧错误先清掉再挂新错误 —— 否则修好的项目会一直背着上次那条报错
    const stale: Record<string, string> = {};
    for (const [p, msg] of Object.entries(fetchErrors.value)) {
      if (!targets.includes(p)) stale[p] = msg;
    }
    fetchErrors.value = { ...stale, ...errors };
  }

  ElMessage({
    message: $t("@13D1C:刷新完成：成功 {ok} · 跳过 {skipped} · 失败 {failed}", { ok, skipped, failed }),
    type: failed > 0 ? "warning" : "success",
  });
}

async function openInNewTab(dirPath: string) {
  if (!dirPath) return;
  try {
    const res = await fetch("/api/open-new-tab-gui", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: dirPath }),
    });
    const data = await res.json();
    if (!data?.success) {
      ElMessage.error(data?.error || $t("@13D1C:打开失败"));
    }
  } catch (err) {
    ElMessage.error(`${$t("@13D1C:打开失败")}: ${(err as Error).message}`);
  }
}

// 卡片点击:open 形态直接开新标签页;pick 形态普通点击回抛给父组件,Ctrl/Cmd 点击仍开新标签页
function onItemClick(item: { path: string; exists: boolean }, event: MouseEvent) {
  const wantNewTab = props.mode === "open" || event.ctrlKey || event.metaKey;
  if (!wantNewTab) {
    emit("select", item.path);
    return;
  }
  if (!item.exists) {
    ElMessage.warning($t("@13D1C:目录不存在,无法打开"));
    return;
  }
  openInNewTab(item.path);
}

// 复制路径到剪贴板。失败降级提示,避免"静默成功"的假象。
async function copyPath(dirPath: string) {
  if (!dirPath) return;
  try {
    await navigator.clipboard.writeText(dirPath);
    ElMessage.success($t("@13D1C:路径已复制到剪贴板"));
  } catch (err) {
    ElMessage.error(`${$t("@13D1C:复制失败")}: ${(err as Error).message}`);
  }
}

// 从列表中移除:两处统一为"确认后移除",确认文案用通用措辞,
// 避免最近项目/常用目录各自一套(具体含义由 removeLabel 提示)。
async function removeDirectory(dirPath: string) {
  if (!dirPath) return;
  try {
    await ElMessageBox.confirm(
      $t("@13D1C:确定要移除以下目录吗？", { path: dirPath }),
      $t("@13D1C:移除目录"),
      {
        confirmButtonText: $t("@13D1C:移除"),
        cancelButtonText: $t("@13D1C:取消"),
        type: "warning",
      }
    );
  } catch {
    return; // 用户取消
  }
  try {
    const res = await fetch("/api/remove_recent_directory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: dirPath }),
    });
    const data = await res.json();
    if (data?.success) {
      directories.value = directories.value.filter(d => d.path !== dirPath);
      ElMessage.success($t("@13D1C:已从目录列表中移除"));
    } else {
      ElMessage.error(data?.error || $t("@13D1C:移除失败"));
    }
  } catch (err) {
    ElMessage.error(`${$t("@13D1C:移除失败")}: ${(err as Error).message}`);
  }
}

onMounted(() => {
  if (props.autoLoad) load();
});

// 弹窗在每次打开时都需要最新数据(用户可能刚在别处切过目录)
defineExpose({ reload: load });
</script>

<template>
  <div class="dir-list" :class="`dir-list--${variant}`">
    <!-- 外壳:仅 panel 形态自带标题行 + 搜索框;bare 形态由调用方(弹窗表单 label)提供标题 -->
    <template v-if="variant === 'panel'">
      <div class="dir-list__head">
        <span class="dir-list__title">{{ $t('@13D1C:最近项目') }}</span>
        <div class="dir-list__head-actions">
          <span class="dir-list__hint">{{ $t('@13D1C:点击在新标签页打开') }}</span>
          <!-- 徽标里的「领先/落后」读的是本地 remote-tracking 引用 = "上次 fetch 时的
               快照",只有 fetch 才会更新它。「未提交 N 项」是本地实时扫描,不需要刷。
               这是个显式的联网动作(十几个项目),所以按钮上带图标+进度、并写明代价。 -->
          <button
            type="button"
            class="dir-list__refresh"
            :disabled="isRefreshingAll || directories.length === 0"
            :title="$t('@13D1C:对所有项目执行 git fetch --all，让「领先/落后」显示真实状态（需联网，较慢）')"
            :aria-label="$t('@13D1C:刷新全部')"
            @click="refreshAllGitStates"
          >
            <el-icon :class="{ 'is-spinning': isRefreshingAll }" aria-hidden="true"><Refresh /></el-icon>
            <span>{{ refreshLabel }}</span>
          </button>
        </div>
      </div>
      <div class="dir-list__search">
        <el-icon class="dir-list__search-icon" aria-hidden="true"><Search /></el-icon>
        <input
          v-model="searchQuery"
          type="text"
          class="dir-list__search-input"
          :placeholder="$t('@13D1C:搜索最近项目...')"
          :aria-label="$t('@13D1C:搜索最近项目')"
        />
        <button
          v-if="searchQuery"
          type="button"
          class="dir-list__search-clear"
          :aria-label="$t('@13D1C:清空搜索')"
          @click="searchQuery = ''"
        >×</button>
      </div>
    </template>

    <div v-if="isLoading && directories.length === 0" class="dir-list__empty">
      <el-icon><Loading /></el-icon>
      <span>{{ $t('@13D1C:加载中...') }}</span>
    </div>
    <div v-else-if="directories.length === 0" class="dir-list__empty">
      {{ resolvedEmptyText }}
    </div>
    <div v-else-if="items.length === 0" class="dir-list__empty">
      {{ $t('@13D1C:没有匹配 "{q}" 的项目', { q: searchQuery }) }}
    </div>
    <ul
      v-else
      class="dir-list__items"
      :aria-label="resolvedAriaLabel"
      :style="{ '--dir-card-min': minCardWidth }"
    >
      <li
        v-for="item in items"
        :key="item.path"
        class="dir-card"
        :class="{ 'is-missing': !item.exists }"
        :title="itemTitle(item)"
      >
        <button
          type="button"
          class="dir-card__btn"
          :aria-label="itemAriaLabel(item)"
          @click="onItemClick(item, $event)"
        >
          <el-icon class="dir-card__icon" aria-hidden="true"><Folder /></el-icon>
          <span class="dir-card__name">
            <span class="dir-card__name-base">{{ item.base }}</span>
            <span class="dir-card__name-path">{{ item.path }}</span>
          </span>
          <!-- 状态徽标:只表达"需要你做事"的信号,外加没信号时的一个中性 Git 标签。
               探测未返回前不占位,避免"检测中"闪烁 -->
          <span class="dir-card__tags">
            <span v-if="!item.exists" class="dir-card__tag dir-card__tag--missing">
              {{ $t('@13D1C:不存在') }}
            </span>
            <span v-else-if="item.git && !item.git.isGitRepo" class="dir-card__tag dir-card__tag--plain">
              {{ $t('@13D1C:非 Git 仓库') }}
            </span>
            <template v-else-if="item.git">
              <span
                v-if="item.git.changed > 0"
                class="dir-card__tag dir-card__tag--dirty"
              >{{ $t('@13D1C:未提交 {count} 项', { count: item.git.changed }) }}</span>
              <span
                v-if="item.git.ahead > 0"
                class="dir-card__tag dir-card__tag--ahead"
              >{{ $t('@13D1C:领先 {count}', { count: item.git.ahead }) }}</span>
              <span
                v-if="item.git.behind > 0"
                class="dir-card__tag dir-card__tag--behind"
              >{{ $t('@13D1C:落后 {count}', { count: item.git.behind }) }}</span>
              <!-- "是仓库"这个中性事实在没有任何待办时才标出来:
                   一旦有未提交/领先/落后,它们本身就说明了这是仓库 -->
              <span v-if="!hasGitSignal(item)" class="dir-card__tag dir-card__tag--git">
                {{ $t('@13D1C:Git') }}
              </span>
            </template>
          </span>
        </button>
        <!-- 操作按钮与卡片按钮平级(不能嵌套 button),.stop 阻止冒泡到卡片点击。
             绝对定位在卡片右端:hover 卡片时与徽标在同一锚点交叉淡入淡出 ——
             既不叠字,也不会在静止时用一条空条把徽标顶到左边。 -->
        <div class="dir-card__actions">
          <!-- 目录都不存在了,复制路径没有意义,不渲染 -->
          <button
            v-if="item.exists"
            type="button"
            class="dir-card__action dir-card__copy"
            :title="$t('@13D1C:复制路径')"
            :aria-label="$t('@13D1C:复制路径 {path}', { path: item.path })"
            @click.stop="copyPath(item.path)"
          >
            <el-icon aria-hidden="true"><DocumentCopy /></el-icon>
          </button>
          <!-- 失效目录的移除按钮常驻显形(方便一键清理);有效目录 hover 才出现 -->
          <button
            v-if="canRemove(item)"
            type="button"
            class="dir-card__action dir-card__remove"
            :title="removeLabelText"
            :aria-label="`${removeLabelText} ${item.path}`"
            @click.stop="removeDirectory(item.path)"
          >
            <el-icon aria-hidden="true"><Delete /></el-icon>
          </button>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
/* ── 外壳 ─────────────────────────────────────────────────────────── */
.dir-list {
  text-align: left;
  /* 组件被塞进 el-form-item__content 时(弹窗的 bare 形态),EP 那个
     `line-height: 32px` 会一路继承到徽标、空态文案上,把 10px 的徽标撑成 34px。
     这里在根上截断,不让表单控件的行高漏进列表内容。
     (同一类坑还有 `.el-form-item__content` 默认横向 flex,见 DirectorySelector.vue) */
  line-height: var(--line-height-normal);
}
/* panel:撑满父级(右侧整列空态),卡片化外壳 + 内部滚动 */
.dir-list--panel {
  margin-top: 0;
  /* min-height:0 让 flex 子项可被父级 grid-template-rows 高度约束,
     否则 height:100% + flex 链会被子项自然高度撑爆 */
  min-height: 0;
  height: 100%;
  padding: var(--spacing-xl);
  border: 1px solid var(--border-card);
  border-radius: var(--radius-xl);
  background: var(--bg-container);
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-base);
  /* 不设 overflow:hidden,滚动交给 .dir-list__items */
}
/* bare:弹窗内嵌,无外框;自身参与父级 flex 高度链,吃掉剩余高度后内部滚动,
   避免弹窗被长列表撑高、把输入框/按钮挤出视口。
   max-height 是"父级不是高度链"时的兜底,防止列表无限长。 */
.dir-list--bare {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  max-height: 68vh;
}
.dir-list--bare .dir-list__items {
  flex: 1 1 auto;
  min-height: 0;
  max-height: none;
  overflow-y: auto;
}
.dir-list__head {
  display: flex;
  /* 右侧多了一个按钮:窄容器下整组换到下一行,而不是把按钮挤扁或让标题折行 */
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm) var(--spacing-base);
  margin-bottom: var(--spacing-base);
}
.dir-list__title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-bold);
  letter-spacing: -0.2px;
  color: var(--text-primary);
}
.dir-list__hint {
  font-size: 13px;
  color: var(--text-secondary);
}
.dir-list__head-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-base);
}
/* 「刷新全部」:一个要花几秒联网的显式动作,所以不做成无边框图标 ——
   有边框才有"这里可以点"的暗示。卡片上那些 icon-only 操作用的是另一套语汇
   (hover 才出现、无边框),两者语义不同,不强行统一。 */
.dir-list__refresh {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 var(--spacing-md);
  border: 1px solid var(--border-color-light);
  border-radius: var(--radius-base);
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 13px;
  /* 显式行高:按钮高度只由 height 决定,不受外部继承的行高影响 */
  line-height: 1;
  cursor: pointer;
  transition: color var(--transition-fast), border-color var(--transition-fast), background var(--transition-fast);
}
.dir-list__refresh:hover:not(:disabled) {
  color: var(--color-primary);
  border-color: var(--color-primary);
  background: var(--tint-primary-08);
}
.dir-list__refresh:disabled {
  opacity: 0.55;
  cursor: default;
}
.dir-list__refresh:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}
.dir-list__refresh .el-icon {
  font-size: 14px;
}
.dir-list__refresh .el-icon.is-spinning {
  animation: dir-list-spin 0.9s linear infinite;
}
@keyframes dir-list-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .dir-list__refresh .el-icon.is-spinning { animation: none; }
}

/* 搜索框:panel 形态独占 */
.dir-list__search {
  position: relative;
  display: flex;
  align-items: center;
  margin-top: var(--spacing-sm);
  border: 1px solid var(--border-color-light);
  border-radius: 10px;
  background: var(--bg-panel);
  padding: 0 var(--spacing-md);
  height: 40px;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}
.dir-list__search:focus-within {
  border-color: var(--color-primary);
  box-shadow: var(--focus-ring);
}
.dir-list__search-icon {
  flex-shrink: 0;
  color: var(--text-secondary);
  font-size: var(--font-size-md);
  margin-right: var(--spacing-base);
}
.dir-list__search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  outline: none;
  font: inherit;
  font-size: var(--font-size-base);
  color: var(--text-primary);
  padding: 0;
  height: 100%;
}
.dir-list__search-input::placeholder {
  color: var(--text-tertiary);
}
.dir-list__search-clear {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-left: var(--spacing-sm);
  border: none;
  background: var(--bg-component-hover);
  color: var(--text-secondary);
  border-radius: var(--radius-full);
  font-size: var(--font-size-md);
  line-height: 1;
  cursor: pointer;
  padding: 0;
  transition: background var(--transition-fast), color var(--transition-fast);
}
.dir-list__search-clear:hover {
  background: var(--tint-primary-12);
  color: var(--color-primary);
}
.dir-list__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-md);
  color: var(--text-secondary);
  font-size: 13px;
}

/* ── 卡片网格 ─────────────────────────────────────────────────────── */
.dir-list__items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(var(--dir-card-min, 380px), 100%), 1fr));
  gap: var(--spacing-md);
  margin-top: var(--spacing-sm);
  /* panel 形态下占满父 flex 容器剩余空间,多出时内部滚动而不是撑爆外层 */
  align-content: start;
  /* 给卡片 focus-visible 的外描边留出空间,避免被自身 overflow 切掉 */
  padding: var(--spacing-xs);
  margin: calc(-1 * var(--spacing-xs));
}
.dir-list--panel .dir-list__items {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.dir-card {
  /* 操作按钮绝对定位的参照物 */
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  padding: var(--spacing-sm) var(--spacing-base);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color-light);
  background: var(--bg-panel);
  font-size: var(--font-size-md);
  color: var(--text-primary);
  /* 不做 transform/阴影/位移动画:状态变化只用背景与描边表达 */
  transition: background var(--transition-fast), border-color var(--transition-fast);
}
.dir-card:hover {
  background: var(--bg-component-hover);
  border-color: var(--border-color);
}
.dir-card:active {
  background: var(--tint-primary-08);
}
.dir-card.is-missing {
  color: var(--text-secondary);
}
.dir-card.is-missing:hover {
  border-color: var(--tint-danger-50);
  background: var(--tint-danger-06);
}
.dir-card__btn {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  padding: 0;
  margin: 0;
  text-align: left;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.dir-card__btn:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
  border-radius: var(--radius-base);
}
/* 图标做成 tinted 色块,与卡片层级匹配 */
.dir-card__icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  font-size: 20px;
  border-radius: var(--radius-lg);
  background: var(--tint-primary-08);
  color: var(--color-primary);
}
/* 失效目录:图标色块退成中性灰,与"不存在"语义一致 */
.dir-card.is-missing .dir-card__icon {
  background: var(--bg-component-hover);
  color: var(--text-secondary);
}
.dir-card__name {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.dir-card__name-base {
  font-family: ui-monospace, monospace;
  font-size: var(--font-size-15);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.3;
  letter-spacing: -0.1px;
}
.dir-card.is-missing .dir-card__name-base {
  color: var(--text-secondary);
}
.dir-card__name-path {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.3;
  /* 弱化到项目名之后 */
  opacity: 0.85;
}
/* 状态徽标区:可能同时出现「Git」+「未提交 N 项」两个,右对齐排一行 */
.dir-card__tags {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  transition: opacity var(--transition-fast);
}
/* hover 时徽标主动让位给操作按钮:两者锚在同一个右端点,做交叉淡入淡出,
   而不是让按钮盖在徽标上压字。失效目录的移除按钮本来就是常驻的,徽标不用让。
   ⚠️ 这里用 `:has(操作按钮:focus-visible)` 而不是 `.dir-card:focus-within`:
   点击卡片主体按钮后 Chrome 会把焦点留在它上面,用 :focus-within 会让徽标
   在点击之后一直隐身;只有键盘 Tab 真正落到操作按钮上才需要让位。 */
.dir-card:not(.is-missing):hover .dir-card__tags,
.dir-card:not(.is-missing):has(.dir-card__action:focus-visible) .dir-card__tags {
  opacity: 0;
}
.dir-card__tag {
  flex-shrink: 0;
  /* 显式行高:徽标高度只由字号 + padding 决定,不受外部继承的行高影响 */
  line-height: 1.4;
  padding: 2px var(--spacing-sm);
  font-size: var(--font-size-xs);
  border-radius: var(--radius-sm);
  white-space: nowrap;
}
/* 目录不存在:危险色,与卡片 is-missing 状态一致 */
.dir-card__tag--missing {
  background: var(--tint-danger-14);
  color: var(--color-danger-light);
}
/* 是 Git 仓库:弱化的品牌色标签,不抢"未提交"的注意力 */
.dir-card__tag--git {
  background: var(--tint-primary-12);
  color: var(--color-primary);
}
/* 有未提交改动:警示色(用户扫列表时主要找这个)。
   不加描边 —— 描边会让它比同排的 Git 徽标高 2px,一眼看出没对齐;
   而且底色 + 字色已经足够区分,不需要边框重复强调。 */
.dir-card__tag--dirty {
  background: var(--tint-warning-14);
  color: var(--text-warning);
}
/* 领先上游:有未推送的提交。与"未提交"同属"本地还有东西没同步出去",
   沿用 App 里「你的分支领先」的 warning 配色 */
.dir-card__tag--ahead {
  background: var(--tint-warning-14);
  color: var(--text-warning);
}
/* 落后上游:远端有新提交,该 pull 了。
   用品牌蓝而不是警示色 —— 这是"别人动了"的信息,不是本地出错,醒目但不报警 */
.dir-card__tag--behind {
  background: var(--tint-primary-12);
  color: var(--color-primary);
}
/* 不是仓库:中性灰,说明"这里没有 Git 可看" */
.dir-card__tag--plain {
  background: var(--bg-component-hover);
  color: var(--text-secondary);
}

/* ── 卡片上的操作按钮 ─────────────────────────────────────────────── */
/* 绝对定位:空闲时不占宽度,徽标才能贴到卡片右边缘(否则右边永远空出一条)。
   整组按钮一起淡入淡出,避免两个图标各自闪现。 */
.dir-card__actions {
  position: absolute;
  right: var(--spacing-base);
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  /* 隐藏时不可点,否则会在徽标位置吞掉本该落到卡片的点击 */
  pointer-events: none;
  transition: opacity var(--transition-fast);
}
.dir-card:hover .dir-card__actions,
.dir-card:has(.dir-card__action:focus-visible) .dir-card__actions {
  opacity: 1;
  pointer-events: auto;
}
/* 扁平化:不给按钮加边框/底色,只靠图标颜色表达状态与 hover ——
   在 "圆角方块 + 色块" 已经被否掉的前提下,图标本身才是最轻的载体。 */
.dir-card__action {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  padding: 0;
  font-size: 14px;
  transition: color var(--transition-fast);
}
.dir-card__copy:hover {
  color: var(--color-primary);
}
/* 破坏性操作只靠图标字色区分(危险色),不再用红边框红底重复强调 */
.dir-card__remove:hover {
  color: var(--color-danger-light);
}
.dir-card__action:active {
  color: var(--color-primary);
}
.dir-card__remove:active {
  color: var(--color-danger);
}
.dir-card__action:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 1px;
}
.dir-card__remove:focus-visible {
  outline-color: var(--color-danger-light);
}
/* 失效目录:移除按钮常驻,此时它在流内正常占位(不是在"空占"),徽标排在它左边 */
.dir-card.is-missing .dir-card__actions {
  position: static;
  transform: none;
  opacity: 1;
  pointer-events: auto;
}
</style>
