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
<!--
  新建任务表单 —— **内嵌在任务编辑器（全屏弹窗）里**，不是独立弹窗。

  由来（2026-10-25）：看板「新建任务」原来弹一个 600px 窄窗，问完字段再关掉，
  想接着填细节就得再点一次「创建并打开编辑器」。那个按钮本身就是割裂的证据：
  新建和编辑本该是同一件事的两步。现在点新建直接把编辑器顶起来、中栏换成这张表单，
  建完就地变成选中的任务，描述/附件/执行全在同一处。

  附件仍然先落服务端派发暂存区（`_dispatch/`）：这一刻任务还不存在，任务侧端点必然 404。
  创建请求带 stagedAttachments，服务端认领进 `_task-{id}/` —— 与主 Agent 控制台同一条链路。

  一个刻意的决定：**标题与描述至少填一个**。看板上的空任务会被 pruneBlankTasks 清掉，
  放行一个空任务只会让用户以为"建成功了"，然后它自己消失。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { $t } from '@/lang/static'
import { canonicalProjectPath } from '@/utils/path'
import AttachmentZone from '@/components/AttachmentZone.vue'
import {
  useWorkbenchAttachments,
  type AttachmentTarget
} from '@/composables/useWorkbenchAttachments'
import type { Attachment, ProjectSummary, Task } from '@/types/workbench'

const props = defineProps<{
  projects: ProjectSummary[]
  /** 默认归属项目：看板当前选中的项目，选中「全部项目」时是应用当前项目 */
  defaultProjectPath: string
  /** 创建请求里是否带上当前应用目录（没有项目清单时后端走默认） */
  currentProjectPath?: string
}>()

const emit = defineEmits<{
  created: [task: Task]
  cancel: []
}>()

const title = ref('')
const desc = ref('')
const submitting = ref(false)
const error = ref('')

/**
 * 草稿附件。**任务还不存在**，所以它们此刻躺在服务端的派发暂存区
 * （`~/.zen-gitsync/workbench-images/_dispatch/`），由创建请求触发认领 —— 见 submit()。
 */
const drafts = ref<Attachment[]>([])
const dragging = ref(false)
/** 草稿阶段附件还在暂存区，缩略图 / 预览必须走暂存端点，任务侧端点此刻一定 404 */
const DRAFT_RAW_BASE = '/api/workbench/orchestrator/attachments'

/** 本次是否已经创建成功 —— 决定卸载时该不该把暂存文件删掉（见 discardDrafts） */
let committed = false

const attachTarget = computed<AttachmentTarget>(() => ({
  kind: 'draft',
  list: drafts.value,
  // 必须换成新数组：uploadAttachment 是"先 push 再回写"，
  // 若这里赋回同一个引用，Vue 收不到变更、缩略图不会出现。
  replace: (next) => { drafts.value = next }
}))

const {
  isUploading,
  isImageAttachment,
  humanSize,
  onAttachmentPaste,
  onAttachmentDrop,
  removeAttachment,
  pickAttachmentFile
} = useWorkbenchAttachments()

const attachBusy = computed(() => isUploading('draft'))

/**
 * 粘贴统一入口，挂在表单根节点上。
 *
 * 只挂这一层：`<input>` / `<textarea>` 上的 paste **会冒泡**到根节点，
 * 所以"在标题里 / 在描述里 / 点在附件区"三种位置都能收到。
 * 反过来若在 AttachmentZone 上也挂一份，粘一张图会被处理两次 ——
 * 去重逻辑挡不住（上传是异步的，第二次进来看列表还是空的），最后多出重复附件。
 */
function onPaste(e: ClipboardEvent) {
  e.stopPropagation()
  onAttachmentPaste(e, attachTarget.value)
}
function onDrop(e: DragEvent) {
  dragging.value = false
  onAttachmentDrop(e, attachTarget.value)
}
function onPickAttachment() { pickAttachmentFile(attachTarget.value) }
function onRemoveAttachment(att: Attachment) { removeAttachment(attachTarget.value, att) }

/**
 * 放弃这次新建时清掉还没被认领的草稿附件。
 *
 * 与主 Agent 控制台的取舍**相反**：那边派发失败（超长 / 目录不存在）后刻意留着
 * 暂存文件，好让用户改一改重发；而这里是用户主动放弃新建，那些文件永远不会被认领，
 * 留着只会在 `_dispatch/` 里堆截图，等到下次进程启动才被清。
 *
 * 创建成功那一路不算放弃（服务端已把文件搬进 `_task-{id}/`，删了就是把附件删掉）。
 */
function discardDrafts() {
  const list = drafts.value
  drafts.value = []
  if (committed || list.length === 0) return
  for (const a of list) {
    // 串行无意义（不同 id，互不覆盖），失败也不必打扰用户
    fetch(`${DRAFT_RAW_BASE}/${encodeURIComponent(a.id)}`, { method: 'DELETE' }).catch(() => {})
  }
}

onBeforeUnmount(discardDrafts)

/** 表单是否有内容 —— 父组件关窗时用它决定要不要问一句「放弃新建？」 */
function hasContent(): boolean {
  return title.value.trim().length > 0 || desc.value.trim().length > 0 || drafts.value.length > 0
}
defineExpose({ hasContent, discardDrafts })

/**
 * 把「默认项目路径」映射到下拉里真正存在的那个 option 值。
 *
 * 两个口径必须分开：项目条目里 `key` 是归一化路径（Windows 形式小写 + 反斜杠），
 * `path` 是配置里首次出现的原始路径（大小写照原样保留）。
 * 看板传进来的 defaultProjectPath 取的是 key 口径，直接拿去和 `p.path` 比永远不相等 ——
 * 结果就是下拉框显示空白、下面的提示还错说成"跟随当前目录"。
 * 所以这里用归一化后的值做**相等比较**，但落回 select 的仍是 `p.path`（原始路径），
 * 因为任务真正要用的执行目录就是它。
 */
function matchOptionPath(raw: string): string {
  const target = canonicalProjectPath(raw)
  if (!target) return ''
  const hit = props.projects.find(p => canonicalProjectPath(p.path) === target)
  return hit ? hit.path : ''
}

const projectPath = ref(matchOptionPath(props.defaultProjectPath))

/** 项目下拉的候选：只列真实的项目条目（含目录已失效的，用户可能就是想建个占位） */
const projectOptions = computed(() => props.projects)

// 附件还在上传时不许提交：那一刻提交，飞在半路的那张图既进不了任务目录、
// 也不会被 discardDrafts 清掉（它还没进 drafts），只在暂存区里留个孤儿。
const canSubmit = computed(() =>
  !submitting.value && !attachBusy.value &&
  (title.value.trim().length > 0 || desc.value.trim().length > 0)
)

const projectName = computed(() => {
  const target = canonicalProjectPath(projectPath.value)
  if (!target) return ''
  const p = projectOptions.value.find(x => canonicalProjectPath(x.path) === target)
  return p ? p.name : ''
})

async function submit() {
  if (!canSubmit.value) return
  submitting.value = true
  error.value = ''
  try {
    const body: Record<string, unknown> = {
      title: title.value.trim(),
      desc: desc.value,
    }
    if (projectPath.value) body.projectPath = projectPath.value
    else if (props.currentProjectPath) body.projectPath = props.currentProjectPath
    // 只回传 id / ext / originalName：服务端按 id 回暂存区找文件，路径不由前端拼。
    // 字段名是 stagedAttachments 而不是 attachments —— 后者是任务上已挂好的附件记录
    // （编辑器整 task 体提交时带的就是它），混用会让服务端把已挂好的附件当草稿去认领。
    if (drafts.value.length > 0) {
      body.stagedAttachments = drafts.value.map(a => ({
        id: a.id,
        ext: a.ext,
        originalName: a.originalName
      }))
    }
    const res = await fetch('/api/workbench/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json()).catch(() => null)
    if (!res?.success) {
      // 失败**不清**草稿：附件还在暂存区躺着，用户改一改标题就能重试（同控制台的口径）
      error.value = res?.error || $t('@WORKBENCH:保存失败')
      return
    }
    // 置在 emit 之前：父组件收到 created 就会卸载这张表单，
    // 晚一行写就会在卸载钩子里把刚认领进任务目录的附件删掉。
    committed = true
    emit('created', res.task as Task)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div
    class="ncf"
    @paste="onPaste"
    @drop.prevent="onDrop"
    @dragover.prevent="dragging = true"
    @dragenter.prevent="dragging = true"
    @dragleave="dragging = false"
  >
    <div class="ncf__head">
      <p class="ncf__sub">{{ $t('@WORKBENCH:填完直接创建，接着就能在同一个界面里执行') }}</p>
    </div>

    <div class="ncf__field">
      <label class="ncf__label" for="ncf-project">{{ $t('@WORKBENCH:项目') }}</label>
      <select id="ncf-project" v-model="projectPath" class="ncf__select">
        <option value="">{{ $t('@WORKBENCH:跟随当前项目') }}</option>
        <option v-for="p in projectOptions" :key="p.key" :value="p.path">
          {{ p.name }}{{ p.exists === false ? ` · ${$t('@WORKBENCH:目录不存在')}` : '' }}
        </option>
      </select>
      <p class="ncf__hint" :title="projectPath">
        {{ projectName ? $t('@WORKBENCH:任务会在「{name}」目录下执行', { name: projectName }) : $t('@WORKBENCH:任务会跟随应用当前的工作目录') }}
      </p>
    </div>

    <div class="ncf__field">
      <label class="ncf__label" for="ncf-title">{{ $t('@WORKBENCH:标题') }}</label>
      <input
        id="ncf-title"
        v-model="title"
        class="ncf__input ncf__input--title"
        type="text"
        maxlength="200"
        :placeholder="$t('@WORKBENCH:一句话说清要做什么')"
        @keydown.enter.prevent="submit"
      />
    </div>

    <div class="ncf__field">
      <label class="ncf__label" for="ncf-desc">{{ $t('@WORKBENCH:描述') }}</label>
      <textarea
        id="ncf-desc"
        v-model="desc"
        class="ncf__input ncf__input--area"
        :placeholder="$t('@WORKBENCH:把背景、验收标准、相关文件路径写进来，执行时用它当上下文')"
        @keydown.ctrl.enter.prevent="submit"
        @keydown.meta.enter.prevent="submit"
      />
    </div>

    <!--
      附件：任务还不存在，所以先落暂存区，创建时由服务端认领进 `_task-{id}/`。
      刻意**常驻**渲染：表单里没有别的入口能挂"添加附件"，空态那一行
      也是唯一能让"可以粘图"这件事被看见的地方 —— 没发现这个能力等于没有。
    -->
    <div class="ncf__field">
      <AttachmentZone
        :attachments="drafts"
        :is-image="isImageAttachment"
        :human-size="humanSize"
        :is-uploading="attachBusy"
        :is-paste-hover="dragging"
        :on-pick="onPickAttachment"
        :on-remove="onRemoveAttachment"
        :raw-base="DRAFT_RAW_BASE"
        @dragover.prevent="dragging = true"
        @dragenter.prevent="dragging = true"
        @dragleave="dragging = false"
      />
      <p class="ncf__hint">{{ $t('@WORKBENCH:粘贴图片以快速添加') }}</p>
    </div>

    <p v-if="error" class="ncf__error">{{ error }}</p>

    <div class="ncf__foot">
      <button type="button" class="ncf__btn" @click="emit('cancel')">
        {{ $t('@WORKBENCH:取消') }}
      </button>
      <span class="ncf__foot-spacer" />
      <button
        type="button"
        class="ncf__btn ncf__btn--primary"
        :disabled="!canSubmit"
        @click="submit"
      >{{ submitting ? $t('@WORKBENCH:创建中…') : $t('@WORKBENCH:创建任务') }}</button>
    </div>
  </div>
</template>

<style scoped>
.ncf {
  display: flex;
  flex-direction: column;
  gap: 18px;
  /* 中栏可能是 1400px 宽 —— 表单拉满一行读起来太散，收在 760 并居中 */
  width: 100%;
  max-width: 760px;
  margin: 0 auto;
  padding: 24px 4px 24px;
  /* el-dialog__body 的 line-height 会一路继承，小字号提示会被撑开 —— 在根元素重置 */
  line-height: 1.5;
}
.ncf__head { display: flex; flex-direction: column; gap: 4px; }
.ncf__sub { margin: 0; font-size: var(--font-size-sm); color: var(--text-meta); }

.ncf__field { display: flex; flex-direction: column; gap: 6px; }
.ncf__label {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--text-secondary);
}
.ncf__input,
.ncf__select {
  width: 100%;
  padding: 8px 10px;
  font-size: var(--font-size-mid);
  font-family: inherit;
  line-height: 1.5;
  color: var(--text-primary);
  background: var(--bg-container);
  border: 1px solid var(--border-color-medium);
  border-radius: var(--radius-md);
  outline: none;
  transition: border-color var(--transition-fast) var(--ease-custom);
  box-sizing: border-box;
}
.ncf__input--title { font-size: var(--font-size-lg); font-weight: 500; }
.ncf__input:focus,
.ncf__select:focus { border-color: var(--color-primary); }
.ncf__input::placeholder { color: var(--text-meta); }
.ncf__select { cursor: pointer; }
.ncf__input--area {
  resize: vertical;
  min-height: 180px;
  max-height: 460px;
}
.ncf__hint { margin: 0; font-size: var(--font-size-xs); color: var(--text-meta); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.ncf__error {
  margin: 0;
  padding: 6px 8px;
  font-size: var(--font-size-sm);
  border-radius: var(--radius-md);
  color: var(--color-danger-light);
  background: color-mix(in srgb, var(--color-danger) 10%, transparent);
}

.ncf__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 4px;
}
.ncf__foot-spacer { flex: 1; }
.ncf__btn {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  line-height: 30px;
  padding: 0 14px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: color var(--transition-fast) var(--ease-custom), background var(--transition-fast) var(--ease-custom);
}
.ncf__btn:hover:not(:disabled) { color: var(--color-primary); background: var(--bg-container-hover); }
.ncf__btn:disabled { opacity: var(--disabled-opacity); cursor: default; }
.ncf__btn:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }
.ncf__btn--primary { background: var(--color-primary); color: #fff; }
.ncf__btn--primary:hover:not(:disabled) { background: var(--color-primary); color: #fff; opacity: 0.88; }
</style>
