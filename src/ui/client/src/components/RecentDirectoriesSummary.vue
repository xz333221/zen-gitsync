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
// 「最近项目 / 常用目录」列表底下那段说明。
//
// 两种形态共用一块位置:
//   没配 AI 模型 → 一段**静态说明**:这批目录是什么、徽标里的数字什么意思。
//   配了 AI 模型 → 同一块位置换成模型写的**状态解读**:哪些项目该 pull、哪些有
//                  未推送的提交、哪些只是工作区脏了(见后端
//                  routes/recentDirectoriesAiSummary.js 的 prompt 契约)。
// 两处调用方(App 里的最近项目面板 / 切换工作目录弹窗的常用目录)都用这一个组件,
// 差别只有 variant 的疏密,与列表组件 RecentDirectoriesList 同一套路。
//
// 为什么必须等 ready 才能发请求:
//   「刷新全部」是逐个目录跑的,每完成一个就更新一次状态 → items 会连续变十几次。
//   父组件在刷新开始前把 ready 置 false、结束后置 true,这里只在 ready 时才解读,
//   于是整轮刷新只产生**一次**模型调用,且解读的就是刷新后的最终状态。
//
// 缓存放在**模块**作用域(整页一份):弹窗重开、面板切目录重建都不会重复解读;
// 反过来,状态真的变了(fingerprint 不同)就会重新解读一次。key 里带上模型与语言,
// 换模型/换语言不会读到上一份。
// 缓存必须放在**独立模块**里,不能写在这儿的模块级 const ——
// <script setup> 整块都编译进 setup(),那里的 Map 是每个实例一份:
// 弹窗重开(它有自己的 RecentDirectoriesSummary 实例)就会重新问一次模型。
// 详见 utils/directorySummaryCache.ts 的文件头。
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Refresh, Warning } from "@element-plus/icons-vue";
import { $t } from "@/lang/static";
import { useConfigStore } from "@stores/configStore";
import { dropDirectorySummary, pendingDirectorySummary, readDirectorySummary, trackPendingDirectorySummary, writeDirectorySummary } from "@/utils/directorySummaryCache";

/** 后端 /api/recent_directories/summary 需要的单条状态(多一个字段都不传) */
interface SummaryGitState {
  isGitRepo: boolean | null;
  branch: string | null;
  upstream: string | null;
  changed: number;
  staged: number;
  unstaged: number;
  untracked: number;
  ahead: number;
  behind: number;
}

interface SummaryItem {
  path: string;
  exists: boolean;
  git: SummaryGitState | null;
}

type SummaryStatus = "idle" | "loading" | "done" | "error";

const props = withDefaults(defineProps<{
  /** 列表里全部目录(不受搜索框过滤影响:说明描述的是这份数据,不是筛选后的视图) */
  items: SummaryItem[];
  /**
   * 状态是否已定稿 —— 「刷新全部」跑完(或弹窗首次加载完成)才置 true。
   * false 时只显示静态说明,不发请求。
   */
  ready?: boolean;
  /** panel:最近项目面板(与卡片同一列) | bare:弹窗内嵌(更紧凑) */
  variant?: "panel" | "bare";
}>(), {
  ready: false,
  variant: "panel",
});

const configStore = useConfigStore();

/** 配了模型才有"解读"这件事;没配就退回静态说明 */
const hasModel = computed(() => Array.isArray(configStore.models) && configStore.models.length > 0);
const locale = computed(() => (String(configStore.locale || "").startsWith("en") ? "en" : "zh"));
const modelKey = computed(() => {
  const models = Array.isArray(configStore.models) ? configStore.models : [];
  const model = models.find((item: any) => item?.isDefault) || models[0];
  return model ? `${model.id ?? model.name ?? ""}|${model.model ?? ""}|${model.baseURL ?? ""}` : "";
});

const state = ref<{ status: SummaryStatus; text: string; error: string }>({
  status: "idle",
  text: "",
  error: "",
});

let controller: AbortController | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
// 每次 sync 递增:等待"别人那一份"时用它判断结果是否已经过期(期间状态又变过)
let syncToken = 0;

/** 稳定的短指纹:同样内容必须得到同样的 key(对象引用每次都是新的,不能直接当 key) */
function fingerprintOf(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}:${(hash >>> 0).toString(36)}`;
}

/** 请求体里那部分条目:只挑后端认的字段,顺序即列表顺序 */
function requestItems(): SummaryItem[] {
  return props.items.map(item => ({
    path: item.path,
    exists: item.exists !== false,
    git: item.git ? {
      isGitRepo: item.git.isGitRepo,
      branch: item.git.branch ?? null,
      upstream: item.git.upstream ?? null,
      changed: item.git.changed ?? 0,
      staged: item.git.staged ?? 0,
      unstaged: item.git.unstaged ?? 0,
      untracked: item.git.untracked ?? 0,
      ahead: item.git.ahead ?? 0,
      behind: item.git.behind ?? 0,
    } : null,
  }));
}

/** 整份状态压成一行字符串:内容没变 → 指纹没变 → 不重新解读 */
function stateSignature(): string {
  return requestItems()
    .map(it => {
      const g = it.git;
      const git = g
        ? [g.isGitRepo === null ? "?" : g.isGitRepo ? "1" : "0", g.branch, g.upstream, g.changed, g.staged, g.unstaged, g.untracked, g.ahead, g.behind].join(",")
        : "-";
      return `${it.path}|${it.exists ? 1 : 0}|${git}`;
    })
    .join("\n");
}

const cacheKey = computed(() =>
  `${locale.value}|${modelKey.value}|${fingerprintOf(stateSignature())}`
);

function abort() {
  controller?.abort();
  controller = null;
}

// ── 静态说明(没配模型 / 还没解读出来时垫在这里)────────────────────────────
const staticNote = computed(() =>
  $t("@13D1C:共 {count} 个目录。徽标里的「领先/落后」是上次 fetch 时的快照，「未提交 N 项」来自本工作区的实时扫描。配置 AI 模型后，这里会自动解读各项目状态、指出需要注意的项目。", {
    count: props.items.length,
  })
);

/**
 * 模型偶尔会带着 Markdown 标记回来(prompt 里虽然要求纯文本)。
 * 这里抹掉最扎眼的几种标记按纯文本渲染 —— 这一段是"一段话",不值得为它挂一个
 * Markdown 渲染器;留着 `**` 之类的残标记反而更像出错。
 */
function toPlainText(raw: string): string {
  return String(raw || "")
    .replace(/<think[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/\*\*|__|`/g, "")
    .trim();
}

async function generate(force = false) {
  if (!hasModel.value || !props.ready || props.items.length === 0) return;

  const key = cacheKey.value;
  const cachedText = readDirectorySummary(key);
  if (!force && cachedText) {
    state.value = { status: "done", text: cachedText, error: "" };
    return;
  }

  abort();
  const requestController = new AbortController();
  controller = requestController;
  state.value = { status: "loading", text: "", error: "" };

  // 登记成"正在生成":同一份状态如果另一个实例(弹窗/面板)也在等,
  // 它会挂在这个任务上,而不是自己再问一遍模型
  const task = stream(key, requestController);
  trackPendingDirectorySummary(key, task);
  await task;
}

/** 真正读一次 SSE 流。抽出来是为了让 generate() 能把任务登记进 pending 表 */
async function stream(key: string, requestController: AbortController) {
  let content = "";
  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const raw = trimmed.slice(5).trim();
    if (!raw) return;

    let event: { type?: string; content?: string; error?: string; code?: string };
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }

    if (event.type === "delta") {
      content += event.content || "";
      state.value = { status: "loading", text: content, error: "" };
    } else if (event.type === "done") {
      state.value = { status: "done", text: toPlainText(content), error: "" };
    } else if (event.type === "error") {
      // 专属失败原因(NO_MODEL/CONFIG_ERR)是本地语义,用本地文案;
      // 其余(模型/网关报错)原样带出 —— 那句话本身就是排查线索
      const message = event.code === "NO_MODEL" || event.code === "CONFIG_ERR" || event.code === "NO_ITEMS"
        ? $t("@13D1C:无法解读项目状态")
        : event.error || $t("@13D1C:解读失败");
      state.value = { status: "error", text: "", error: message };
    }
  };

  try {
    const response = await fetch("/api/recent_directories/summary", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ items: requestItems(), locale: locale.value }),
      signal: requestController.signal,
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      lines.forEach(consumeLine);
    }
    buffer += decoder.decode();
    if (buffer) consumeLine(buffer);

    // 流提前断掉(没收到 done)也把已有正文留下,总比一个字都不显示好
    if (state.value.status === "loading") {
      state.value = { status: "done", text: toPlainText(content), error: "" };
    }
    if (state.value.status === "done" && state.value.text) writeDirectorySummary(key, state.value.text);
  } catch (error: any) {
    if (error?.name !== "AbortError" && controller === requestController) {
      state.value = { status: "error", text: "", error: error?.message || $t("@13D1C:解读失败") };
    }
  } finally {
    if (controller === requestController) controller = null;
  }
}

/**
 * 状态或就绪标志一变就来这里:能命中缓存就立刻换上,否则防抖后发起一次解读。
 * 防抖是必需的 —— 「刷新全部」过程中 items 会连着变十几次(每完成一个目录一次)。
 */
function sync() {
  abort();
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  const token = (++syncToken);

  const key = cacheKey.value;
  const cached = readDirectorySummary(key);
  if (cached) {
    state.value = { status: "done", text: cached, error: "" };
    return;
  }

  state.value = { status: "idle", text: "", error: "" };
  if (!hasModel.value || !props.ready || props.items.length === 0) return;

  // 同一份状态已经有人在生成了(典型场景:面板刚发起解读,用户就打开了切换目录弹窗):
  // 挂上去等结果,不重复问一次模型 —— 这段说明有两个入口,重复调用是真金白银。
  const pending = pendingDirectorySummary(key);
  if (pending) {
    state.value = { status: "loading", text: "", error: "" };
    void pending.then(() => {
      // 等待期间状态/配置又变了:让新的一次去处理,别用过期结果覆盖
      if (token !== syncToken) return;
      const text = readDirectorySummary(key);
      // 对方没拿到内容(失败/被中断)就退回静态说明,不自作主张再发一次
      state.value = text
        ? { status: "done", text, error: "" }
        : { status: "idle", text: "", error: "" };
    });
    return;
  }

  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void generate();
  }, 350);
}

/** 手动重新解读:丢掉这一份缓存再问一次(模型偶尔会抽风,给用户一个重来的入口) */
function regenerate() {
  dropDirectorySummary(cacheKey.value);
  // 直接 generate(true) 而不是 sync():用户点了"重新生成"就是要再问一次模型,
  // 不该被"别处正在生成"的等待分支拦下
  void generate(true);
}

watch(
  () => [props.items, props.ready, hasModel.value, locale.value, modelKey.value],
  () => sync(),
  { immediate: true }
);

onBeforeUnmount(() => {
  abort();
  if (debounceTimer) clearTimeout(debounceTimer);
});

const isBusy = computed(() => state.value.status === "loading");
// 正文优先级:已有内容(含流式中的半截) > 生成中的占位 > 静态说明
const bodyText = computed(() => {
  if (state.value.text) return toPlainText(state.value.text);
  if (isBusy.value) return "";
  return staticNote.value;
});
</script>

<template>
  <section
    class="dir-summary"
    :class="[`dir-summary--${variant}`, { 'is-ai': hasModel }]"
    :aria-busy="isBusy"
  >
    <!-- 标题行只在"有 AI 解读"时出现;没配模型时它就是一段说明文字,不需要标题 -->
    <header v-if="hasModel" class="dir-summary__head">
      <span class="dir-summary__title">{{ $t('@13D1C:AI 项目状态解读') }}</span>
      <button
        type="button"
        class="dir-summary__refresh"
        :disabled="isBusy || items.length === 0"
        :title="$t('@13D1C:重新生成解读')"
        :aria-label="$t('@13D1C:重新生成解读')"
        @click="regenerate"
      >
        <el-icon :class="{ 'is-spinning': isBusy }" aria-hidden="true"><Refresh /></el-icon>
      </button>
    </header>

    <p v-if="isBusy && !bodyText" class="dir-summary__text dir-summary__text--pending" aria-live="polite">
      {{ $t('@13D1C:AI 正在解读各项目状态...') }}
    </p>
    <p v-else-if="bodyText" class="dir-summary__text" aria-live="polite">{{ bodyText }}</p>

    <!-- 解读失败时静态说明仍在上面垫着,这里只补一行原因 + 重试,不占满整块 -->
    <div v-if="state.status === 'error' && hasModel" class="dir-summary__error">
      <el-icon aria-hidden="true"><Warning /></el-icon>
      <span class="dir-summary__error-msg">{{ $t('@13D1C:解读失败：{error}', { error: state.error }) }}</span>
      <button
        type="button"
        class="dir-summary__retry"
        :disabled="isBusy"
        :title="$t('@13D1C:重试')"
        @click="regenerate"
      >{{ $t('@13D1C:重试') }}</button>
    </div>
  </section>
</template>

<style scoped>
/* 说明块:列表下方一块"抬头可见、不抢焦点"的浅色条 ——
   靠浅色底与四周同宽的细边和上面的卡片区分开,不用左侧色条抢注意力。 */
.dir-summary {
  flex-shrink: 0;
  margin-top: var(--spacing-base);
  padding: var(--spacing-base) var(--spacing-md);
  border: 1px solid var(--border-color-light);
  border-radius: var(--radius-lg);
  background: var(--bg-subtle);
  /* 与列表根一致:截断 Element Plus 表单控件的行高继承(见 RecentDirectoriesList) */
  line-height: var(--line-height-relaxed);
  font-size: 13px;
  text-align: left;
}
/* 有 AI 解读时换成品牌色系:同一块地方,内容从"说明"升级成"解读" */
.dir-summary.is-ai {
  border-color: var(--tint-primary-22);
  background: var(--tint-primary-06);
}
.dir-summary--bare {
  margin-top: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-base);
}
.dir-summary__head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: var(--spacing-xs);
}
.dir-summary__title {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  letter-spacing: -0.1px;
}
.dir-summary__refresh {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: 13px;
  transition: color var(--transition-fast);
}
.dir-summary__refresh:hover:not(:disabled) {
  color: var(--color-primary);
}
.dir-summary__refresh:disabled {
  cursor: default;
  opacity: 0.5;
}
.dir-summary__refresh:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 1px;
}
.dir-summary__refresh .el-icon.is-spinning {
  animation: dir-summary-spin 0.9s linear infinite;
}
@keyframes dir-summary-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .dir-summary__refresh .el-icon.is-spinning { animation: none; }
}
.dir-summary__text {
  margin: 0;
  color: var(--text-primary);
  /* 模型可能给换行(或手动重试拼出的多段),按原样保留,别把段落挤成一行 */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dir-summary__text--pending {
  color: var(--text-secondary);
}
.dir-summary__error {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-top: var(--spacing-sm);
  font-size: var(--font-size-sm);
  color: var(--text-danger);
}
.dir-summary__error-msg {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dir-summary__retry {
  flex-shrink: 0;
  margin-left: auto;
  padding: 0 var(--spacing-base);
  height: 22px;
  border: 1px solid currentColor;
  border-radius: var(--radius-base);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: var(--font-size-sm);
  line-height: 1;
  cursor: pointer;
}
.dir-summary__retry:hover:not(:disabled) {
  background: var(--tint-danger-08);
}
.dir-summary__retry:disabled {
  cursor: default;
  opacity: 0.5;
}
</style>
