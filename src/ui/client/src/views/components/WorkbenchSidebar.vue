<script setup lang="ts">
import { computed } from 'vue'
import { $t } from '@/lang/static'
import { Plus, Close, List, Picture as PictureIcon, DocumentAdd, Memo, Folder, ArrowDown, ArrowRight, CopyDocument } from '@element-plus/icons-vue'
import type { Task, Prompt } from '@/types/workbench'
import { useWorkbenchProjectGroups } from '@/composables/useWorkbenchProjectGroups'

const props = defineProps<{
  tasks: Task[]
  prompts: Prompt[]
  selectedTaskId: string | null
  currentProject: { path: string; name: string }
  creatingTask: boolean
}>()

const emit = defineEmits<{
  'select-task': [task: Task]
  'delete-task': [task: Task]
  'copy-task': [task: Task]
  'set-task-type': [task: Task, type: 'simple' | 'complex']
  'create-task': []
  'open-create-prompt': []
  'open-edit-prompt': [prompt: Prompt]
  'delete-prompt': [prompt: Prompt]
}>()

const currentProjectRef = computed(() => props.currentProject)
const tasksRef = computed(() => props.tasks)
const { groupedTasksList, isGroupCollapsed, toggleGroupCollapsed, shortProjectLabel } = useWorkbenchProjectGroups(tasksRef as any, currentProjectRef as any)

const availablePrompts = computed<Prompt[]>(() => {
  const cur = (props.currentProject.path || '').trim()
  return props.prompts.filter(p => !p.projectPath || p.projectPath === cur)
})

function attachmentCount(t: Task): number {
  return Array.isArray(t.attachments) ? t.attachments.length : 0
}
function subtaskCount(t: Task): number {
  return Array.isArray(t.subtasks) ? t.subtasks.length : 0
}
function subtaskDoneCount(t: Task): number {
  if (!Array.isArray(t.subtasks)) return 0
  return t.subtasks.filter(s => s && s.status === 'done').length
}
function taskIsRunning(t: Task): boolean {
  if (Array.isArray(t.subtasks) && t.subtasks.some(s => s && s.status === 'running')) return true
  return false // jobs not available here; handled via parent
}
</script>

<template>
  <aside class="wb-sidebar">
    <section class="wb-section">
      <header class="wb-section__head">
        <span class="wb-section__tag">{{ $t('@WORKBENCH:任务') }}</span>
        <h3 class="wb-section__title">{{ $t('@WORKBENCH:任务列表') }}</h3>
        <span class="wb-pill wb-section__count">{{ tasks.length }}</span>
      </header>

      <button class="wb-new-btn" :disabled="creatingTask" @click="emit('create-task')">
        <el-icon class="wb-new-btn__icon"><Plus /></el-icon>
        <span>{{ $t('@WORKBENCH:新建任务') }}</span>
        <span class="wb-new-btn__shortcut">N</span>
      </button>

      <ul class="wb-task-list">
        <template v-for="group in groupedTasksList.groups" :key="group.path">
          <li
            v-if="groupedTasksList.hasMultiple"
            class="wb-task-group__head"
            :class="{
              'is-current': group.path === currentProject.path,
              'is-collapsed': isGroupCollapsed(group.path)
            }"
            role="button"
            tabindex="0"
            :aria-expanded="!isGroupCollapsed(group.path)"
            :title="isGroupCollapsed(group.path) ? $t('@WORKBENCH:展开') : $t('@WORKBENCH:收起')"
            @click="toggleGroupCollapsed(group.path)"
            @keydown.enter.prevent="toggleGroupCollapsed(group.path)"
            @keydown.space.prevent="toggleGroupCollapsed(group.path)"
          >
            <el-icon class="wb-task-group__caret">
              <component :is="isGroupCollapsed(group.path) ? ArrowRight : ArrowDown" />
            </el-icon>
            <el-icon class="wb-task-group__icon"><Folder /></el-icon>
            <span class="wb-task-group__name" :title="group.path === currentProject.path ? currentProject.path : group.label">
              {{ group.path === currentProject.path ? currentProject.name : shortProjectLabel(group.label) }}
            </span>
            <span class="wb-pill wb-task-group__count">{{ group.tasks.length }}</span>
          </li>
          <template v-if="!isGroupCollapsed(group.path)">
            <li
              v-for="t in group.tasks"
              :key="t.id"
              class="wb-task-item"
              :class="{
                active: t.id === selectedTaskId,
                'has-attachment': attachmentCount(t) > 0,
                'is-other-project': t.projectPath && t.projectPath !== currentProject.path,
                'is-running': taskIsRunning(t)
              }"
              @click="emit('select-task', t)"
            >
              <div class="wb-task-item__body">
                <div class="wb-task-item__title" :title="t.title">{{ t.title || $t('@WORKBENCH:未命名任务') }}</div>
                <div class="wb-task-item__meta">
                  <span
                    v-if="subtaskCount(t) > 0"
                    class="wb-task-item__meta-item"
                    :class="{ 'wb-task-item__meta-item--running': taskIsRunning(t) }"
                    :title="$t('@WORKBENCH:个子任务')"
                  >
                    <el-icon class="wb-task-item__meta-icon"><List /></el-icon>
                    <span class="wb-pill wb-task-item__num">
                      {{ subtaskDoneCount(t) }}/{{ subtaskCount(t) }}
                    </span>
                  </span>
                  <span
                    v-if="attachmentCount(t) > 0"
                    class="wb-task-item__meta-item"
                    :title="$t('@WORKBENCH:附件')"
                  >
                    <el-icon class="wb-task-item__meta-icon"><PictureIcon /></el-icon>
                    <span class="wb-pill wb-task-item__num">{{ attachmentCount(t) }}</span>
                  </span>
                  <span
                    v-if="t.promptId"
                    class="wb-task-item__meta-item wb-task-item__meta-item--accent"
                    :title="$t('@WORKBENCH:已绑定预置提示词')"
                  >
                    <el-icon class="wb-task-item__meta-icon"><Memo /></el-icon>
                  </span>
                  <button
                    type="button"
                    class="wb-task-item__meta-item wb-task-item__type-toggle"
                    :class="t.type === 'simple' ? 'wb-task-item__meta-item--simple' : 'wb-task-item__meta-item--complex'"
                    :title="t.type === 'simple' ? $t('@WORKBENCH:简单任务 - 点击切换为复杂任务') : $t('@WORKBENCH:复杂任务 - 点击切换为简单任务')"
                    :aria-label="t.type === 'simple' ? $t('@WORKBENCH:切换为复杂任务') : $t('@WORKBENCH:切换为简单任务')"
                    @click.stop="emit('set-task-type', t, t.type === 'simple' ? 'complex' : 'simple')"
                  >
                    {{ t.type === 'simple' ? $t('@WORKBENCH:简单') : $t('@WORKBENCH:复杂') }}
                  </button>
                  <span
                    v-if="t.projectPath && t.projectPath !== currentProject.path"
                    class="wb-task-item__meta-item wb-task-item__meta-item--project"
                    :title="t.projectPath"
                  >
                    {{ shortProjectLabel(t.projectPath) }}
                  </span>
                </div>
              </div>
              <span
                v-if="taskIsRunning(t)"
                class="wb-task-item__running-dot"
                :title="$t('@WORKBENCH:执行中')"
                aria-hidden="true"
              />
              <div class="wb-task-item__action-group">
                <button
                  class="wb-task-item__copy"
                  :title="$t('@WORKBENCH:复制任务')"
                  :aria-label="$t('@WORKBENCH:复制任务')"
                  @click.stop="emit('copy-task', t)"
                >
                  <el-icon><CopyDocument /></el-icon>
                </button>
                <button
                  class="wb-task-item__del"
                  @click.stop="emit('delete-task', t)"
                  :title="$t('@WORKBENCH:删除')"
                  :aria-label="$t('@WORKBENCH:删除')"
                >
                  <el-icon><Close /></el-icon>
                </button>
              </div>
            </li>
          </template>
        </template>
        <li v-if="tasks.length === 0" class="wb-empty wb-empty--rich">
          <div class="wb-empty__art" aria-hidden="true">
            <el-icon><DocumentAdd /></el-icon>
          </div>
          <div class="wb-empty__title">{{ $t('@WORKBENCH:暂无任务') }}</div>
          <div class="wb-empty__hint">{{ $t('@WORKBENCH:点击上方按钮新建') }}</div>
          <div class="wb-empty__cta">
            <el-button type="primary" size="small" :icon="Plus" :loading="creatingTask" @click="emit('create-task')">
              {{ $t('@WORKBENCH:新建任务') }}
            </el-button>
          </div>
        </li>
      </ul>
    </section>

    <section class="wb-section">
      <header class="wb-section__head">
        <span class="wb-section__tag wb-section__tag--accent">{{ $t('@WORKBENCH:提示') }}</span>
        <h3 class="wb-section__title">{{ $t('@WORKBENCH:预置提示词') }}</h3>
        <span class="wb-pill wb-section__count">{{ availablePrompts.length }}</span>
        <button
          class="wb-section__action"
          @click="emit('open-create-prompt')"
          :title="$t('@WORKBENCH:新建提示词')"
          :aria-label="$t('@WORKBENCH:新建提示词')"
        >
          <el-icon><Plus /></el-icon>
        </button>
      </header>
      <ul class="wb-prompt-list">
        <li v-for="p in availablePrompts" :key="p.id" class="wb-prompt-item">
          <div class="wb-prompt-item__icon">
            <el-icon><Memo /></el-icon>
          </div>
          <span class="wb-prompt-item__name" @click="emit('open-edit-prompt', p)" :title="p.content">
            {{ p.name }}
          </span>
          <span
            v-if="!p.projectPath"
            class="wb-prompt-item__tag"
            :title="$t('@WORKBENCH:全局（所有项目可用）')"
          >{{ $t('@WORKBENCH:全局（所有项目可用）') }}</span>
          <span
            v-else
            class="wb-prompt-item__tag wb-prompt-item__tag--project"
            :title="p.projectPath"
          >{{ shortProjectLabel(p.projectPath) }}</span>
          <button
            class="wb-prompt-item__del"
            @click="emit('delete-prompt', p)"
            :title="$t('@WORKBENCH:删除')"
            :aria-label="$t('@WORKBENCH:删除')"
          >
            <el-icon><Close /></el-icon>
          </button>
        </li>
        <li v-if="availablePrompts.length === 0" class="wb-empty wb-empty--compact">
          {{ $t('@WORKBENCH:暂无提示词') }}
        </li>
      </ul>
    </section>
  </aside>
</template>

<style scoped>
.wb-sidebar {
  width: 268px;
  flex-shrink: 0;
  padding: 14px 12px 18px;
  overflow-y: auto;
  background: var(--bg-panel);
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.wb-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  flex-shrink: 0;
}
.wb-section + .wb-section {
  padding-top: 16px;
}
.wb-section__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 4px;
}
.wb-section__tag {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.4px;
  color: var(--text-tertiary);
  background: var(--bg-subtle);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  text-transform: uppercase;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.wb-section__tag--accent {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 9%, transparent);
  border-color: var(--tint-primary-22);
}
.wb-section__title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  letter-spacing: 0.2px;
  flex: 1;
  min-width: 0;
}
.wb-section__action {
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 13px;
  flex-shrink: 0;
  transition: background var(--transition-fast) var(--ease-custom), color var(--transition-fast) var(--ease-custom);
}
.wb-section__action:hover {
  background: var(--tint-primary-12);
  color: var(--color-primary);
}
.wb-new-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 32px;
  padding: 0 12px;
  border: 1px dashed var(--tint-primary-35, color-mix(in srgb, var(--color-primary) 35%, transparent));
  border-radius: 10px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 4%, transparent) 0%, color-mix(in srgb, var(--color-primary) 2%, transparent) 100%);
  color: var(--color-primary);
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.05px;
  cursor: pointer;
  transition:
    background var(--transition-fast) var(--ease-custom),
    color var(--transition-fast) var(--ease-custom),
    border-color var(--transition-fast) var(--ease-custom),
    transform var(--transition-fast) var(--ease-custom);
}
.wb-new-btn__icon { font-size: 13px; flex-shrink: 0; transition: transform var(--transition-fast) var(--ease-custom); }
.wb-new-btn__shortcut { display: none; }
.wb-new-btn:hover {
  background: linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 10%, transparent) 0%, color-mix(in srgb, var(--color-primary) 6%, transparent) 100%);
  color: var(--color-primary);
  border-style: solid;
  border-color: var(--tint-primary-50);
}
.wb-new-btn:hover .wb-new-btn__icon { transform: rotate(90deg); }
.wb-new-btn:active { transform: scale(0.99); }
.wb-new-btn:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 1px; }
.wb-task-list, .wb-prompt-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.wb-task-item {
  position: relative; display: flex; align-items: center; gap: 8px;
  padding: 7px 10px; border: none; border-radius: 10px; background: transparent;
  cursor: pointer;
  transition:
    background var(--transition-fast) var(--ease-custom),
    color var(--transition-fast) var(--ease-custom),
    transform var(--transition-fast) var(--ease-custom);
}
.wb-task-item.is-running { background: color-mix(in srgb, var(--color-warning) 8%, transparent); }
.wb-task-item.is-running:hover { background: color-mix(in srgb, var(--color-warning) 14%, transparent); }
.wb-task-item:hover {
  background: var(--bg-container-hover); border-color: transparent;
  transform: translateY(-0.5px);
}
.wb-task-item:hover .wb-task-item__action-group { opacity: 1; transform: translateX(0); }
.wb-task-item.active { background: color-mix(in srgb, var(--color-primary) 10%, var(--bg-container)); border-color: transparent; box-shadow: 0 1px 3px color-mix(in srgb, var(--color-primary) 12%, transparent), 0 0 0 1px color-mix(in srgb, var(--color-primary) 18%, transparent); }
.wb-task-item.active::after {
  content: ''; position: absolute; left: -1px; top: 5px; bottom: 5px;
  width: 3px; border-radius: 3px; background: linear-gradient(180deg, var(--color-primary) 0%, color-mix(in srgb, var(--color-primary) 70%, #fff) 100%);
  box-shadow: 0 0 8px color-mix(in srgb, var(--color-primary) 50%, transparent), 0 1px 3px color-mix(in srgb, var(--color-primary) 25%, transparent);
}
.wb-task-item.active .wb-task-item__title { color: var(--color-primary); }
.wb-task-item.active .wb-task-item__action-group { opacity: 1; }
.wb-task-item.active .wb-task-item__del { color: var(--color-primary); }
.wb-task-item__running-dot {
  flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%;
  background: var(--color-warning);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-warning) 60%, transparent);
  animation: wb-running-pulse 1.4s ease-in-out infinite;
  margin-left: auto;
}
@keyframes wb-running-pulse {
  0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-warning) 60%, transparent); opacity: 1; }
  50% { transform: scale(1.35); box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-warning) 0%, transparent); opacity: 0.75; }
}
.wb-task-item__body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
/* 任务标题：略小于 section header，作为分组下的内容项，
   用 secondary 颜色 + medium 字重让位给项目名(11px/600/secondary)。
   选中态由 .wb-task-item.active 切到 primary 蓝。 */
.wb-task-item__title {
  font-size: 12px; font-weight: 500; color: var(--text-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  letter-spacing: -0.05px; line-height: 1.3;
}
.wb-task-item__meta { display: flex; align-items: center; gap: 5px; font-size: 10px; color: var(--text-tertiary); line-height: 1; }
.wb-task-item__meta-item { display: inline-flex; align-items: center; gap: 3px; font-variant-numeric: tabular-nums; font-weight: 500; }
.wb-task-item__meta-item--accent { color: var(--color-primary); }
.wb-task-item__type-toggle {
  height: 15px; padding: 0 6px; border-radius: 7px; font-size: 10px; font-weight: 600;
  letter-spacing: 0.2px; white-space: nowrap; border: none; cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease, transform 0.1s ease;
  font-family: inherit;
}
.wb-task-item__type-toggle:active { transform: scale(0.96); }
.wb-task-item__type-toggle:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 1px; }
.wb-task-item__meta-item--simple {
  display: inline-flex; align-items: center; height: 15px; padding: 0 6px;
  border-radius: 7px; background: var(--tint-success-14); color: var(--color-success-dark, #047857);
  font-size: 10px; font-weight: 600; letter-spacing: 0.2px; white-space: nowrap;
}
.wb-task-item__meta-item--complex {
  background: var(--tint-think-14); color: var(--color-think-darker, #4338ca);
}
.wb-task-item__type-toggle:hover { filter: brightness(0.95); }
.wb-task-item__meta-item--project {
  display: inline-flex; align-items: center; height: 15px; padding: 0 5px; border-radius: 7px;
  background: color-mix(in srgb, var(--color-warning, #f59e0b) 14%, transparent);
  color: color-mix(in srgb, var(--color-warning, #f59e0b) 80%, var(--text-primary));
  font-size: 10px; font-weight: 600; letter-spacing: 0.2px; white-space: nowrap;
  max-width: 110px; overflow: hidden; text-overflow: ellipsis;
}
.wb-task-item.is-other-project { opacity: 0.78; }
.wb-task-item.is-other-project:hover { opacity: 1; }
.wb-task-item__meta-icon { font-size: 11px; opacity: 0.85; }
.wb-task-item__num { min-width: 14px; padding: 0 4px; color: var(--text-secondary); transition: background var(--transition-fast) var(--ease-custom), color var(--transition-fast) var(--ease-custom); }
.wb-task-item.active .wb-task-item__num { color: var(--color-primary); background: var(--tint-primary-14); }
.wb-task-item__meta-item--running .wb-task-item__num { color: color-mix(in srgb, var(--color-warning, #f59e0b) 85%, var(--text-primary)); background: color-mix(in srgb, var(--color-warning, #f59e0b) 18%, transparent); font-weight: 600; }
.wb-task-item.is-running .wb-task-item__meta-icon { color: color-mix(in srgb, var(--color-warning, #f59e0b) 80%, var(--text-primary)); animation: wb-task-running-icon 1.4s ease-in-out infinite; }
@keyframes wb-task-running-icon { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }

/* 任务操作按钮组：复制 + 删除，hover/active 时浮现 */
.wb-task-item__action-group {
  display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0;
  opacity: 0; transform: translateX(-2px);
  transition: opacity var(--transition-fast) var(--ease-custom), transform var(--transition-fast) var(--ease-custom);
}
.wb-task-item:hover .wb-task-item__action-group,
.wb-task-item.active .wb-task-item__action-group { opacity: 1; transform: translateX(0); }
.wb-task-item__copy {
  border: none; background: transparent; color: var(--text-tertiary); width: 22px; height: 22px;
  border-radius: 6px; display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; font-size: 12px; flex-shrink: 0;
  transition: background var(--transition-fast) var(--ease-custom), color var(--transition-fast) var(--ease-custom), transform var(--transition-fast) var(--ease-custom);
}
.wb-task-item__copy:hover { background: color-mix(in srgb, var(--color-primary) 12%, transparent); color: var(--color-primary); }
.wb-task-item__copy:focus-visible { outline: var(--focus-outline); outline-offset: var(--focus-outline-offset); }
.wb-task-item__copy:active { transform: scale(0.9); }
.wb-task-item__del {
  border: none; background: transparent; color: var(--text-tertiary); width: 22px; height: 22px;
  border-radius: 6px; display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; font-size: 12px; flex-shrink: 0;
  transition: background var(--transition-fast) var(--ease-custom), color var(--transition-fast) var(--ease-custom), transform var(--transition-fast) var(--ease-custom);
}
.wb-task-item__del:hover { background: color-mix(in srgb, var(--color-danger) 14%, transparent); color: var(--color-danger); }
.wb-task-item__del:focus-visible { outline: var(--focus-outline); outline-offset: var(--focus-outline-offset); opacity: 1; }
.wb-task-item__del, .wb-prompt-item__del, .wb-sub-item__del { font-size: 13px; }
.wb-prompt-item {
  display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: var(--radius-md);
  font-size: var(--font-size-125); color: var(--text-primary);
  transition: background var(--transition-fast) var(--ease-custom); position: relative;
}
.wb-prompt-item:hover { background: var(--bg-container-hover); }
.wb-prompt-item:hover .wb-prompt-item__del { opacity: 1; }
.wb-prompt-item__icon { width: 22px; height: 22px; border-radius: var(--radius-sm); background: var(--tint-primary-08); color: var(--color-primary); display: inline-flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0; }
.wb-prompt-item__name { flex: 1; min-width: 0; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-primary); font-weight: 500; letter-spacing: -0.05px; }
.wb-prompt-item__tag { flex-shrink: 0; max-width: 96px; padding: 1px 6px; border-radius: var(--radius-xs); font-size: 10px; line-height: 16px; letter-spacing: 0.1px; background: var(--tint-primary-08); color: var(--color-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wb-prompt-item__tag--project { background: var(--bg-subtle); color: var(--text-secondary); border: 1px solid var(--border-color-light); }
.wb-prompt-item__del {
  border: none; background: transparent; color: var(--text-tertiary); width: 20px; height: 20px;
  border-radius: var(--radius-xs); display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; font-size: 12px; flex-shrink: 0; opacity: 0;
  transition: opacity var(--transition-fast) var(--ease-custom), background var(--transition-fast) var(--ease-custom), color var(--transition-fast) var(--ease-custom);
}
.wb-prompt-item__del:hover { background: color-mix(in srgb, var(--color-danger) 14%, transparent); color: var(--color-danger); }
.wb-prompt-item__del:focus-visible { outline: var(--focus-outline); outline-offset: var(--focus-outline-offset); opacity: 1; }
.wb-empty { padding: 24px 14px 20px; text-align: center; color: var(--text-tertiary); display: flex; flex-direction: column; align-items: center; gap: 8px; border-radius: var(--radius-md); background: linear-gradient(135deg, var(--bg-subtle) 0%, color-mix(in srgb, var(--tint-primary-05) 50%, transparent) 100%); border: 1px dashed var(--border-color-light, color-mix(in srgb, var(--border-color) 60%, transparent)); position: relative; overflow: hidden; }
.wb-empty::before {
  content: '';
  position: absolute;
  top: -25px;
  right: -25px;
  width: 100px;
  height: 100px;
  border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--color-primary) 5%, transparent) 0%, transparent 70%);
  pointer-events: none;
}
.wb-empty--compact { padding: 10px 12px; flex-direction: row; justify-content: center; gap: 0; background: var(--bg-subtle); border-style: solid; }
.wb-empty--compact::before { display: none; }
.wb-empty__art { width: 52px; height: 52px; border-radius: 14px; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, var(--tint-primary-12) 0%, var(--tint-primary-08) 100%); color: var(--color-primary); font-size: 24px; margin-bottom: 4px; box-shadow: 0 4px 12px color-mix(in srgb, var(--color-primary) 10%, transparent); position: relative; z-index: 1; }
.wb-empty__title { font-size: 15px; font-weight: 600; letter-spacing: var(--letter-spacing-heading, -0.25px); color: var(--text-secondary); line-height: 1.45; position: relative; z-index: 1; }
.wb-empty--rich .wb-empty__hint { font-size: 12px; line-height: 1.6; color: var(--text-tertiary); max-width: 280px; position: relative; z-index: 1; }
.wb-empty__cta { display: flex; align-items: center; gap: 14px; margin-top: 8px; flex-wrap: wrap; justify-content: center; position: relative; z-index: 1; }
.wb-pill { display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; padding: 0 5px; border-radius: 8px; font-size: 10px; font-weight: 600; color: var(--text-tertiary); background: var(--bg-subtle); font-variant-numeric: tabular-nums; flex-shrink: 0; }
.wb-section__count { background: var(--tint-primary-12); color: var(--color-primary); }
/* 分组头：作为 section header，比组内任务标题(.wb-task-item__title 12px/500/secondary)
   字号略小但字重更重、颜色更深,承担"这是什么项目"的语义。
   当前项目用 .is-current 切到 primary 蓝。 */
.wb-task-group__head {
  display: flex; align-items: center; gap: 6px; padding: 5px 6px; margin-bottom: 2px;
  border-radius: 6px; cursor: pointer; user-select: none; font-size: 11px; font-weight: 600;
  color: var(--text-secondary); transition: background var(--transition-fast) var(--ease-custom),
    color var(--transition-fast) var(--ease-custom);
}
.wb-task-group__head:hover { background: var(--bg-container-hover); color: var(--text-primary); }
.wb-task-group__head.is-current { color: var(--color-primary); font-weight: 600; }
.wb-task-group__caret { font-size: 11px; flex-shrink: 0; transition: transform 0.15s; }
.wb-task-group__icon { font-size: 13px; flex-shrink: 0; opacity: 0.7; }
.wb-task-group__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-task-group__count { min-width: 14px; height: 14px; padding: 0 4px; font-size: 9px; background: var(--bg-subtle); }
</style>
