<script setup lang="ts">
import { $t } from '@/lang/static'
import { ref, computed } from 'vue'
import { useGitStore } from '@stores/gitStore'
import { Sell, Setting, InfoFilled } from '@element-plus/icons-vue'
import CommonDialog from '@components/CommonDialog.vue'
import { ElMessage } from 'element-plus'

// 定义props
interface Props {
  variant?: 'icon' | 'text'  // icon: 圆形图标按钮, text: 带文字的普通按钮
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'icon'
})

const gitStore = useGitStore()

// 标签对话框状态
const isTagDialogVisible = ref(false)
const tagName = ref('')
const tagMessage = ref('')
const tagType = ref<'lightweight' | 'annotated'>('lightweight')
const targetCommit = ref('')
const isCreating = ref(false)

// 打开标签对话框
function openTagDialog() {
  tagName.value = ''
  tagMessage.value = ''
  tagType.value = 'lightweight'
  targetCommit.value = ''
  isTagDialogVisible.value = true
}

// 创建标签
async function createTag() {
  if (!tagName.value.trim()) {
    ElMessage.warning($t('@TAG01:请输入标签名称'))
    return
  }

  // 验证标签名称格式
  const tagNamePattern = /^[a-zA-Z0-9._\/-]+$/
  if (!tagNamePattern.test(tagName.value)) {
    ElMessage.warning($t('@TAG01:标签名称只能包含字母、数字、点、下划线、斜杠和连字符'))
    return
  }

  try {
    isCreating.value = true
    const response = await fetch('/api/create-tag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tagName: tagName.value.trim(),
        message: tagMessage.value.trim(),
        type: tagType.value,
        commit: targetCommit.value.trim()
      })
    })

    const result = await response.json()

    if (result.success) {
      ElMessage.success($t('@TAG01:标签创建成功'))
      isTagDialogVisible.value = false
      // 可以触发刷新标签列表的事件
    } else {
      ElMessage.error(result.error || $t('@TAG01:创建标签失败'))
    }
  } catch (error) {
    console.error('创建标签失败:', error)
    ElMessage.error($t('@TAG01:创建标签失败'))
  } finally {
    isCreating.value = false
  }
}

// 计算标签类型说明
const tagTypeDescription = computed(() => {
  if (tagType.value === 'lightweight') {
    return $t('@TAG01:轻量标签是指向提交对象的引用，不包含额外信息')
  } else {
    return $t('@TAG01:附注标签是完整的Git对象，包含标签信息、日期、标签者和可选的签名')
  }
})
</script>

<template>
  <div class="create-tag-button">
    <!-- 创建标签按钮 -->
    <el-tooltip 
      :content="$t('@TAG01:为当前提交创建标签')" 
      placement="top"
      :show-after="200"
      :disabled="props.variant === 'text'"
    >
      <el-button 
        type="success" 
        @click="openTagDialog" 
        :disabled="!gitStore.isGitRepo"
        :circle="props.variant === 'icon'"
        :size="props.variant === 'icon' ? 'small' : 'default'"
        :class="props.variant === 'text' ? 'action-button' : ''"
      >
        <el-icon v-if="props.variant === 'icon'"><Sell /></el-icon>
        <template v-else>{{ $t('@TAG01:创建标签') }}</template>
      </el-button>
    </el-tooltip>

    <!-- 创建标签弹窗 -->
    <CommonDialog
      v-model="isTagDialogVisible"
      :title="$t('@TAG01:创建 Git 标签')"
      size="medium"
      :close-on-click-modal="false"
      show-footer
      :confirm-text="$t('@TAG01:创建')"
      :cancel-text="$t('@TAG01:取消')"
      :confirm-loading="isCreating"
      custom-class="tag-dialog"
      @confirm="createTag"
    >
      <div class="tag-dialog-content">
        <!-- 功能说明卡片 -->
        <div class="tag-info-card">
          <div class="info-icon">
            <el-icon><Sell /></el-icon>
          </div>
          <div class="info-content">
            <h4>{{ $t('@TAG01:Git 标签') }}</h4>
            <p>{{ $t('@TAG01:标签用于标记项目的重要版本点，如发布版本 v1.0.0') }}</p>
          </div>
        </div>
        
        <el-form label-position="top" class="tag-form">
          <!-- 标签名称 -->
          <el-form-item :label="$t('@TAG01:标签名称')" required>
            <el-input 
              v-model="tagName" 
              :placeholder="$t('@TAG01:例如: v1.0.0 或 release-2024')"
              clearable
              maxlength="100"
            >
              <template #prefix>
                <el-icon><Sell /></el-icon>
              </template>
            </el-input>
            <div class="form-tip">
              <el-icon><InfoFilled /></el-icon>
              <span>{{ $t('@TAG01:建议使用语义化版本号，如 v1.0.0') }}</span>
            </div>
          </el-form-item>

          <!-- 标签类型 -->
          <el-form-item :label="$t('@TAG01:标签类型')">
            <el-radio-group v-model="tagType" size="default">
              <el-radio-button label="lightweight">{{ $t('@TAG01:轻量标签') }}</el-radio-button>
              <el-radio-button label="annotated">{{ $t('@TAG01:附注标签') }}</el-radio-button>
            </el-radio-group>
            <div class="form-tip">
              <el-icon><InfoFilled /></el-icon>
              <span>{{ tagTypeDescription }}</span>
            </div>
          </el-form-item>

          <!-- 标签说明（仅附注标签） -->
          <el-form-item 
            v-if="tagType === 'annotated'" 
            :label="$t('@TAG01:标签说明')"
            :required="tagType === 'annotated'"
          >
            <el-input 
              v-model="tagMessage" 
              :placeholder="$t('@TAG01:为此标签添加说明信息')"
              clearable
              :rows="3"
              type="textarea"
              resize="none"
              maxlength="500"
              show-word-limit
            />
          </el-form-item>

          <!-- 目标提交（可选） -->
          <el-form-item :label="$t('@TAG01:目标提交（可选）')">
            <el-input 
              v-model="targetCommit" 
              :placeholder="$t('@TAG01:留空则为当前HEAD，或输入commit SHA')"
              clearable
              maxlength="40"
            >
              <template #prefix>
                <span class="commit-prefix">commit:</span>
              </template>
            </el-input>
            <div class="form-tip">
              <el-icon><InfoFilled /></el-icon>
              <span>{{ $t('@TAG01:默认为当前HEAD提交，也可以指定历史提交') }}</span>
            </div>
          </el-form-item>
        </el-form>
      </div>
    </CommonDialog>
  </div>
</template>

<style scoped lang="scss">
.create-tag-button {
  display: inline-block;
}

/* 标签弹窗样式 */
.tag-dialog-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tag-info-card {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px;
  background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%);
  border: 1px solid #86efac;
  border-radius: 12px;
  position: relative;
  overflow: hidden;
}

.tag-info-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: linear-gradient(90deg, #22c55e 0%, #16a34a 100%);
}

.tag-info-card .info-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
  border-radius: 10px;
  color: white;
  font-size: 18px;
  flex-shrink: 0;
  box-shadow: 0 4px 12px rgba(34, 197, 94, 0.3);
}

.tag-info-card .info-content {
  flex: 1;
}

.tag-info-card .info-content h4 {
  margin: 0 0 6px 0;
  font-size: 16px;
  font-weight: 600;
  color: #14532d;
  line-height: 1.2;
}

.tag-info-card .info-content p {
  margin: 0;
  font-size: 14px;
  color: #166534;
  line-height: 1.4;
}

.tag-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tag-form :deep(.el-form-item) {
  margin-bottom: 0;
}

.tag-form :deep(.el-form-item__label) {
  font-weight: 600;
  color: var(--color-text-title);
  font-size: 14px;
  margin-bottom: 8px;
}

.tag-form :deep(.el-input) {
  .el-input__inner {
    border-radius: 8px;
    border: 2px solid #e5e7eb;
    transition: all 0.3s ease;
    
    &:hover {
      border-color: #d1d5db;
    }
    
    &:focus {
      border-color: #22c55e;
      box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.1);
    }
  }
}

.tag-form :deep(.el-textarea) {
  .el-textarea__inner {
    border-radius: 8px;
    border: 2px solid #e5e7eb;
    transition: all 0.3s ease;
    font-size: 14px;
    line-height: 1.5;
    
    &:hover {
      border-color: #d1d5db;
    }
    
    &:focus {
      border-color: #22c55e;
      box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.1);
    }
  }
}

.tag-form :deep(.el-radio-group) {
  width: 100%;
  
  .el-radio-button {
    flex: 1;
    
    .el-radio-button__inner {
      width: 100%;
      border-radius: 8px;
      transition: all 0.3s ease;
    }
  }
}

.form-tip {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-top: 8px;
  font-size: 13px;
  color: #6b7280;
  line-height: 1.4;
  
  .el-icon {
    color: #9ca3af;
    font-size: 14px;
    flex-shrink: 0;
    margin-top: 1px;
  }
}

.commit-prefix {
  font-size: 12px;
  color: #6b7280;
  font-family: monospace;
}

/* 标签弹窗的CommonDialog样式定制 */
:deep(.tag-dialog) {
  .common-dialog__footer {
    .el-button {
      border-radius: 8px;
      font-weight: 500;
      transition: all 0.3s ease;
      
      &:hover {
        transform: translateY(-1px);
      }
    }
  }
}
</style>
