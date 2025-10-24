<script setup lang="ts">
import { $t } from '@/lang/static'
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'

const { t } = useI18n()

// 测试数据
const fileCount = ref(5)
const testMessage = ref('')

// 计算属性测试
const dynamicMessage = computed(() => {
  return t('git.stagedCount', { count: fileCount.value })
})

// 脚本中使用翻译
const showSuccessMessage = () => {
  ElMessage.success(t('git.commitSuccess'))
}

const showConfirmDialog = () => {
  ElMessageBox.confirm(
    t('git.revertChanges') + '?',
    t('common.warning'),
    {
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
      type: 'warning',
    }
  ).then(() => {
    ElMessage.success(t('common.success'))
  }).catch(() => {
    ElMessage.info($t('@1D6A1:已取消'))
  })
}

// 表单提交测试
const handleSubmit = () => {
  ElMessage.success(t('common.success') + '!')
}
</script>

<template>
  <div class="i18n-test-container">
    <el-card class="test-card">
      <template #header>
        <h2>{{ $t('app.title') }} {{ $t('@1D6A1:- 国际化测试') }}</h2>
      </template>

      <!-- 基础翻译测试 -->
      <el-divider content-position="left">
        <h3>{{ $t('@1D6A1:基础翻译测试') }}</h3>
      </el-divider>
      <div class="test-section">
        <el-descriptions :column="2" border>
          <el-descriptions-item :label="$t('common.confirm')">{{ $t('common.cancel') }}</el-descriptions-item>
          <el-descriptions-item :label="$t('common.save')">{{ $t('common.delete') }}</el-descriptions-item>
          <el-descriptions-item :label="$t('common.edit')">{{ $t('common.add') }}</el-descriptions-item>
          <el-descriptions-item :label="$t('common.search')">{{ $t('common.refresh') }}</el-descriptions-item>
        </el-descriptions>
      </div>

      <!-- Git 相关翻译 -->
      <el-divider content-position="left">
        <h3>Git {{ $t('@1D6A1:模块翻译') }}</h3>
      </el-divider>
      <div class="test-section">
        <el-space wrap>
          <el-tag>{{ $t('git.status') }}</el-tag>
          <el-tag type="success">{{ $t('git.commit') }}</el-tag>
          <el-tag type="warning">{{ $t('git.push') }}</el-tag>
          <el-tag type="danger">{{ $t('git.pull') }}</el-tag>
          <el-tag type="info">{{ $t('git.stash') }}</el-tag>
        </el-space>
        
        <div style="margin-top: 16px;">
          <p><strong>{{ $t('git.staged') }}:</strong> {{ $t('git.stagedCount', { count: 3 }) }}</p>
          <p><strong>{{ $t('git.unstaged') }}:</strong> {{ $t('git.unstagedCount', { count: 7 }) }}</p>
          <p><strong>{{ $t('git.untracked') }}:</strong> {{ $t('git.untrackedCount', { count: 2 }) }}</p>
        </div>
      </div>

      <!-- 动态参数测试 -->
      <el-divider content-position="left">
        <h3>{{ $t('@1D6A1:动态参数测试') }}</h3>
      </el-divider>
      <div class="test-section">
        <el-space direction="vertical" style="width: 100%">
          <div>
            <el-input-number v-model="fileCount" :min="0" :max="100" />
            <span style="margin-left: 16px;">{{ dynamicMessage }}</span>
          </div>
        </el-space>
      </div>

      <!-- 按钮测试 -->
      <el-divider content-position="left">
        <h3>Element Plus {{ $t('@1D6A1:组件国际化') }}</h3>
      </el-divider>
      <div class="test-section">
        <el-space wrap>
          <el-button type="primary" @click="showSuccessMessage">
            {{ $t('common.success') }}
          </el-button>
          <el-button type="warning" @click="showConfirmDialog">
            {{ $t('common.confirm') }}
          </el-button>
          <el-button type="danger">{{ $t('common.delete') }}</el-button>
          <el-button type="info">{{ $t('common.refresh') }}</el-button>
        </el-space>
      </div>

      <!-- 表单测试 -->
      <el-divider content-position="left">
        <h3>{{ $t('@1D6A1:表单国际化') }}</h3>
      </el-divider>
      <div class="test-section">
        <el-form :model="{ message: testMessage }" label-width="120px">
          <el-form-item :label="$t('git.commitMessage')">
            <el-input 
              v-model="testMessage" 
              :placeholder="$t('git.commitMessagePlaceholder')"
            />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="handleSubmit">
              {{ $t('common.submit') }}
            </el-button>
            <el-button @click="testMessage = ''">
              {{ $t('common.reset') }}
            </el-button>
          </el-form-item>
        </el-form>
      </div>

      <!-- 操作翻译 -->
      <el-divider content-position="left">
        <h3>Git {{ $t('@1D6A1:操作翻译') }}</h3>
      </el-divider>
      <div class="test-section">
        <el-descriptions :column="1" border>
          <el-descriptions-item :label="$t('git.stageFile')">
            {{ $t('git.unstageFile') }}
          </el-descriptions-item>
          <el-descriptions-item :label="$t('git.lockFile')">
            {{ $t('git.unlockFile') }}
          </el-descriptions-item>
          <el-descriptions-item :label="$t('git.openFile')">
            {{ $t('git.openWithVSCode') }}
          </el-descriptions-item>
          <el-descriptions-item :label="$t('git.copyPath')">
            {{ $t('git.pathCopied') }}
          </el-descriptions-item>
        </el-descriptions>
      </div>

      <!-- 提交历史 -->
      <el-divider content-position="left">
        <h3>{{ $t('@1D6A1:提交历史翻译') }}</h3>
      </el-divider>
      <div class="test-section">
        <el-descriptions :column="2" border>
          <el-descriptions-item :label="$t('commit.author')">xuze</el-descriptions-item>
          <el-descriptions-item :label="$t('commit.date')">2025-10-23</el-descriptions-item>
          <el-descriptions-item :label="$t('commit.hash')">a1b2c3d</el-descriptions-item>
          <el-descriptions-item :label="$t('commit.files')">5 files</el-descriptions-item>
        </el-descriptions>
      </div>

      <!-- 错误信息 -->
      <el-divider content-position="left">
        <h3>{{ $t('@1D6A1:错误信息翻译') }}</h3>
      </el-divider>
      <div class="test-section">
        <el-alert :title="$t('errors.networkError')" type="error" :closable="false" style="margin-bottom: 8px;" />
        <el-alert :title="$t('errors.serverError')" type="error" :closable="false" style="margin-bottom: 8px;" />
        <el-alert :title="$t('errors.notFound')" type="warning" :closable="false" style="margin-bottom: 8px;" />
        <el-alert :title="$t('errors.unauthorized')" type="warning" :closable="false" />
      </div>

      <!-- 脚本中使用测试 -->
      <el-divider content-position="left">
        <h3>{{ $t('@1D6A1:脚本中使用 t() 函数') }}</h3>
      </el-divider>
      <div class="test-section">
        <el-space direction="vertical" style="width: 100%">
          <p>{{ $t('@1D6A1:在 script 中使用: ') }}<code>const message = t('git.commitSuccess')</code></p>
          <p>{{ $t('@1D6A1:结果: ') }}<el-tag>{{ t('git.commitSuccess') }}</el-tag></p>
          <p>{{ $t('@1D6A1:带参数: ') }}<code>t('git.stagedCount', {{ '{' }} count: 10 {{ '}' }})</code></p>
          <p>{{ $t('@1D6A1:结果: ') }}<el-tag type="success">{{ t('git.stagedCount', { count: 10 }) }}</el-tag></p>
        </el-space>
      </div>

    </el-card>
  </div>
</template>

<style scoped>
.i18n-test-container {
  padding: 20px;
  max-width: 1200px;
  margin: 0 auto;
}

.test-card {
  margin-bottom: 20px;
}

.test-section {
  margin-bottom: 24px;
}

.el-divider {
  margin: 24px 0 16px;
}

code {
  background: var(--bg-panel);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: 'Courier New', monospace;
  font-size: 0.9em;
  color: var(--text-primary);
}
</style>
