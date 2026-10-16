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
  「添加项目」弹窗：把磁盘上的一个目录加进项目清单。

  两条入口，同一个提交口：
    · 目录选择器（复用仓库已有的 FilePickerModal，与顶栏「切换工作目录」是同一个弹窗）——
      这是主要路径，用户不需要记路径；
    · 手输 / 粘贴一个绝对路径 —— 从终端、README、聊天记录里拷来的路径直接贴进来更快。

  校验分两层：这里只拦「空」，其余（绝对路径 / 存在 / 是目录）由服务端判 ——
  前端复刻一份判定，等于把同一条规则实现两遍（两侧一变一不变时，报错就会自相矛盾）。

  弹窗的开关与"提交中"都由调用方控制（本组件是纯输入件）：失败时不关窗是**父组件**的
  决定（把 addVisible 留成 true），这样用户不用重新输入一遍路径。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { FolderOpened } from '@element-plus/icons-vue'
import CommonDialog from '@components/CommonDialog.vue'
import { FilePickerModal as FilePicker } from 'local-file-picker/client'
import { storeToRefs } from 'pinia'
import { $t } from '@/lang/static'
import { useConfigStore } from '@/stores/configStore'
import { useLocaleStore } from '@/stores/localeStore'

const props = defineProps<{
  visible: boolean
  submitting?: boolean
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
  submit: [path: string]
}>()

const configStore = useConfigStore()
const { currentLocale } = storeToRefs(useLocaleStore())

const isDark = computed(() => {
  const t = configStore.theme
  if (t === 'dark') return true
  if (t === 'light') return false
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
})

const inputPath = ref('')
const pickerVisible = ref(false)

// 每次打开都从空白开始：上一次失败留下的路径留着只会让人分不清"这是我要加的那个吗"
watch(() => props.visible, (v) => {
  if (v) inputPath.value = ''
})

function onPick(paths: string[]) {
  const picked = (paths && paths[0]) || ''
  pickerVisible.value = false
  if (!picked) return
  // 选完直接提交：选择器本身就点了一次"确定"，再让用户点一次「添加」是多余动作
  inputPath.value = picked
  submit()
}

function submit() {
  const value = inputPath.value.trim()
  if (!value) return
  emit('submit', value)
}
</script>

<template>
  <CommonDialog
    :model-value="visible"
    :title="$t('@PROJM:添加项目')"
    size="medium"
    :close-on-click-modal="false"
    show-footer
    :confirm-text="$t('@PROJM:添加')"
    :cancel-text="$t('@WORKBENCH:取消')"
    :confirm-loading="!!submitting"
    custom-class="pm-add-dialog"
    @update:model-value="(v: boolean) => emit('update:visible', v)"
    @confirm="submit"
  >
    <div class="pm-add">
      <p class="pm-add__hint">{{ $t('@PROJM:选择或粘贴一个项目目录（绝对路径），它会加进项目列表与常用目录') }}</p>

      <div class="pm-add__row">
        <el-input
          v-model="inputPath"
          class="pm-add__input"
          :placeholder="$t('@PROJM:粘贴项目目录的绝对路径')"
          clearable
          @keydown.enter="submit"
        />
        <button
          type="button"
          class="pm-add__browse"
          :title="$t('@PROJM:浏览目录')"
          :aria-label="$t('@PROJM:浏览目录')"
          @click="pickerVisible = true"
        >
          <el-icon aria-hidden="true"><FolderOpened /></el-icon>
          <span>{{ $t('@PROJM:浏览') }}</span>
        </button>
      </div>

      <p class="pm-add__note">{{ $t('@PROJM:目录必须已经存在（克隆、创建完之后再来添加）') }}</p>
    </div>

    <FilePicker
      :visible="pickerVisible"
      mode="directory"
      :theme="isDark ? 'dark' : 'light'"
      :locale="currentLocale"
      @close="pickerVisible = false"
      @confirm="onPick"
    />
  </CommonDialog>
</template>

<style scoped>
.pm-add {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pm-add__hint {
  margin: 0;
  font-size: var(--font-size-sm);
  line-height: 1.6;
  color: var(--text-secondary);
}
.pm-add__row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pm-add__input { flex: 1; min-width: 0; }
.pm-add__browse {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--border-input);
  border-radius: var(--radius-md);
  background: var(--bg-input);
  color: var(--text-secondary);
  font-family: inherit;
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition:
    color var(--transition-fast) var(--ease-custom),
    border-color var(--transition-fast) var(--ease-custom),
    background var(--transition-fast) var(--ease-custom);
}
.pm-add__browse:hover {
  color: var(--color-primary);
  border-color: var(--color-primary);
  background: var(--tint-primary-12);
}
.pm-add__browse:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }
.pm-add__note {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-meta);
}
</style>
