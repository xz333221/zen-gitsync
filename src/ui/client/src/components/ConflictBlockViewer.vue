<script setup lang="ts">
import { $t } from '@/lang/static.ts'
import { ref, computed } from 'vue';
import { ElButton, ElMessage, ElIcon } from 'element-plus';
import { Warning } from '@element-plus/icons-vue';

// 定义冲突块类型
export interface ConflictBlock {
  id: number; // 块的唯一标识
  startLine: number; // 起始行号（用于定位）
  currentLines: string[]; // 当前版本的行
  incomingLines: string[]; // 传入版本的行
  beforeLines: string[]; // 冲突前的上下文行
  afterLines: string[]; // 冲突后的上下文行
  currentLabel: string; // 当前版本标签（例如：HEAD）
  incomingLabel: string; // 传入版本标签（例如：branch-name）
}

// Props
interface Props {
  filePath: string; // 文件路径
  blocks: ConflictBlock[]; // 冲突块列表
}

const props = defineProps<Props>();

// Emits
interface Emits {
  (e: 'resolve', blockId: number, resolution: 'current' | 'incoming' | 'both'): void;
  (e: 'refresh'): void; // 刷新整个文件
}

const emit = defineEmits<Emits>();

// 每个块的解决状态
const blockResolutions = ref<Map<number, 'current' | 'incoming' | 'both' | null>>(new Map());

// 判断某个块是否已解决
function isBlockResolved(blockId: number): boolean {
  return blockResolutions.value.has(blockId) && blockResolutions.value.get(blockId) !== null;
}

// 获取块的解决方式
function getBlockResolution(blockId: number): 'current' | 'incoming' | 'both' | null {
  return blockResolutions.value.get(blockId) || null;
}

// 处理块解决
async function handleResolveBlock(blockId: number, resolution: 'current' | 'incoming' | 'both') {
  try {
    emit('resolve', blockId, resolution);
    blockResolutions.value.set(blockId, resolution);
    ElMessage.success($t('@E80AC:冲突块已标记为已解决'));
  } catch (error) {
    ElMessage.error(`${$t('@E80AC:操作失败: ')}${(error as Error).message}`);
  }
}

// 计算已解决的块数量
const resolvedCount = computed(() => {
  return Array.from(blockResolutions.value.values()).filter(v => v !== null).length;
});

// 计算总块数
const totalBlocks = computed(() => props.blocks.length);

// 是否所有块都已解决
const allResolved = computed(() => resolvedCount.value === totalBlocks.value);
</script>

<template>
  <div class="conflict-block-viewer">
    <!-- 整体进度提示 -->
    <div class="progress-bar" v-if="totalBlocks > 0">
      <div class="progress-info">
        <el-icon class="warning-icon"><Warning /></el-icon>
        <span>{{ $t('@E80AC:冲突解决进度') }}: {{ resolvedCount }} / {{ totalBlocks }}</span>
      </div>
      <div class="progress-hint" v-if="!allResolved">
        <span>{{ $t('@E80AC:请为每个冲突块选择解决方式') }}</span>
      </div>
      <div class="progress-hint success" v-else>
        <span>{{ $t('@E80AC:所有冲突块已解决，请点击下方保存按钮') }}</span>
      </div>
    </div>

    <!-- 渲染每个冲突块 -->
    <div
      v-for="block in blocks"
      :key="block.id"
      class="conflict-block"
      :class="{ resolved: isBlockResolved(block.id) }"
    >
      <div class="block-header">
        <span class="block-index">{{ $t('@E80AC:冲突块') }} #{{ block.id }}</span>
        <span v-if="isBlockResolved(block.id)" class="resolved-badge">
          ✓ {{ $t('@E80AC:已解决') }}
        </span>
      </div>

      <!-- 冲突前的上下文 -->
      <div v-if="block.beforeLines.length > 0" class="context-lines">
        <div v-for="(line, idx) in block.beforeLines" :key="'before-' + idx" class="context-line">
          <span class="line-number">{{ block.startLine - block.beforeLines.length + idx }}</span>
          <span class="line-content">{{ line }}</span>
        </div>
      </div>

      <!-- 已解决状态：显示最终选择的内容 -->
      <template v-if="isBlockResolved(block.id)">
        <div class="resolved-content">
          <div class="resolved-header">
            <span class="resolved-label">{{ $t('@E80AC:最终内容') }}</span>
            <el-button
              size="small"
              type="default"
              @click="blockResolutions.delete(block.id)"
            >
              {{ $t('@E80AC:重新选择') }}
            </el-button>
          </div>
          <div class="resolved-lines">
            <!-- 根据解决方式显示内容 -->
            <template v-if="getBlockResolution(block.id) === 'current'">
              <div
                v-for="(line, idx) in block.currentLines"
                :key="'resolved-' + idx"
                class="diff-line final-line"
              >
                <span class="line-number">{{ block.startLine + idx }}</span>
                <span class="line-content">{{ line }}</span>
              </div>
            </template>
            <template v-else-if="getBlockResolution(block.id) === 'incoming'">
              <div
                v-for="(line, idx) in block.incomingLines"
                :key="'resolved-' + idx"
                class="diff-line final-line"
              >
                <span class="line-number">{{ block.startLine + idx }}</span>
                <span class="line-content">{{ line }}</span>
              </div>
            </template>
            <template v-else-if="getBlockResolution(block.id) === 'both'">
              <div
                v-for="(line, idx) in [...block.currentLines, ...block.incomingLines]"
                :key="'resolved-' + idx"
                class="diff-line final-line"
              >
                <span class="line-number">{{ block.startLine + idx }}</span>
                <span class="line-content">{{ line }}</span>
              </div>
            </template>
          </div>
        </div>
      </template>

      <!-- 未解决状态：显示选择按钮 -->
      <template v-else>
        <!-- 当前版本区域 -->
        <div class="conflict-section current-section">
          <div class="section-header">
            <span class="section-label">{{ $t('@E80AC:当前更改') }} ({{ block.currentLabel }})</span>
            <el-button
              size="small"
              type="primary"
              @click="handleResolveBlock(block.id, 'current')"
            >
              {{ $t('@E80AC:采用当前更改') }}
            </el-button>
          </div>
          <div class="section-content">
            <div
              v-for="(line, idx) in block.currentLines"
              :key="'current-' + idx"
              class="diff-line added-line"
            >
              <span class="line-number">{{ block.startLine + idx }}</span>
              <span class="line-content">{{ line }}</span>
            </div>
          </div>
        </div>

        <!-- 分隔符 -->
        <div class="conflict-separator">
          <span>{{ $t('@E80AC:冲突分隔符') }}</span>
          <el-button
            size="small"
            type="warning"
            @click="handleResolveBlock(block.id, 'both')"
          >
            {{ $t('@E80AC:保留双方更改') }}
          </el-button>
        </div>

        <!-- 传入版本区域 -->
        <div class="conflict-section incoming-section">
          <div class="section-header">
            <span class="section-label">{{ $t('@E80AC:传入的更改') }} ({{ block.incomingLabel }})</span>
            <el-button
              size="small"
              type="success"
              @click="handleResolveBlock(block.id, 'incoming')"
            >
              {{ $t('@E80AC:采用传入更改') }}
            </el-button>
          </div>
          <div class="section-content">
            <div
              v-for="(line, idx) in block.incomingLines"
              :key="'incoming-' + idx"
              class="diff-line removed-line"
            >
              <span class="line-number">{{ block.startLine + block.currentLines.length + idx }}</span>
              <span class="line-content">{{ line }}</span>
            </div>
          </div>
        </div>
      </template>

      <!-- 冲突后的上下文 -->
      <div v-if="block.afterLines.length > 0" class="context-lines">
        <div v-for="(line, idx) in block.afterLines" :key="'after-' + idx" class="context-line">
          <span class="line-number">{{
            block.startLine + block.currentLines.length + block.incomingLines.length + idx
          }}</span>
          <span class="line-content">{{ line }}</span>
        </div>
      </div>

    </div>
  </div>
</template>

<style scoped lang="scss">
.conflict-block-viewer {
  padding: 16px;
  background-color: var(--bg-container);
  
  .progress-bar {
    background-color: var(--color-warning-bg);
    border: 1px solid var(--color-warning-border);
    border-radius: 8px;
    padding: 12px 16px;
    margin-bottom: 16px;
    
    .progress-info {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      font-weight: 500;
      color: var(--color-warning);
      
      .warning-icon {
        font-size: 18px;
      }
    }
    
    .progress-hint {
      margin-top: 8px;
      font-size: 12px;
      color: var(--text-secondary);
      
      &.success {
        color: var(--color-success);
        font-weight: 500;
      }
    }
  }
  
  .conflict-block {
    border: 2px solid var(--color-warning-border);
    border-radius: 8px;
    margin-bottom: 24px;
    overflow: hidden;
    transition: all 0.3s ease;
    
    &.resolved {
      border-color: var(--color-success-border);
      opacity: 0.8;
    }
    
    .block-header {
      background-color: var(--color-warning-bg);
      padding: 8px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--color-warning-border);
      
      .block-index {
        font-weight: 600;
        color: var(--color-warning);
      }
      
      .resolved-badge {
        background-color: var(--color-success);
        color: white;
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 500;
      }
    }
    
    .context-lines {
      background-color: var(--bg-elevated);
      
      .context-line {
        display: flex;
        padding: 2px 8px;
        font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
        font-size: 13px;
        line-height: 1.6;
        
        .line-number {
          display: inline-block;
          width: 50px;
          color: var(--text-tertiary);
          text-align: right;
          padding-right: 16px;
          user-select: none;
        }
        
        .line-content {
          flex: 1;
          white-space: pre;
          color: var(--text-primary);
        }
      }
    }
    
    .conflict-section {
      .section-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 16px;
        font-weight: 500;
        font-size: 13px;
        
        .section-label {
          display: flex;
          align-items: center;
          gap: 8px;
        }
      }
      
      &.current-section {
        background-color: rgba(var(--color-success-rgb), 0.05);
        border-top: 2px solid var(--color-success-border);
        border-bottom: 2px solid var(--color-success-border);
        
        .section-header {
          background-color: rgba(var(--color-success-rgb), 0.1);
          color: var(--color-success);
        }
      }
      
      &.incoming-section {
        background-color: rgba(var(--color-primary-rgb), 0.05);
        border-bottom: 2px solid var(--color-primary-border);
        
        .section-header {
          background-color: rgba(var(--color-primary-rgb), 0.1);
          color: var(--color-primary);
        }
      }
      
      .section-content {
        .diff-line {
          display: flex;
          padding: 2px 8px;
          font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
          font-size: 13px;
          line-height: 1.6;
          
          &.added-line {
            background-color: rgba(var(--color-success-rgb), 0.15);
          }
          
          &.removed-line {
            background-color: rgba(var(--color-danger-rgb), 0.15);
          }
          
          .line-number {
            display: inline-block;
            width: 50px;
            color: var(--text-tertiary);
            text-align: right;
            padding-right: 16px;
            user-select: none;
          }
          
          .line-content {
            flex: 1;
            white-space: pre;
            color: var(--text-primary);
          }
        }
      }
    }
    
    .conflict-separator {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 16px;
      background-color: var(--bg-elevated);
      border-top: 1px dashed var(--border-color);
      border-bottom: 1px dashed var(--border-color);
      
      span {
        font-size: 12px;
        color: var(--text-tertiary);
        font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
      }
    }
    
    .block-resolution-info {
      padding: 8px 16px;
      background-color: var(--color-success-bg);
      color: var(--color-success);
      font-size: 12px;
      font-weight: 500;
      text-align: center;
      border-top: 1px solid var(--color-success-border);
    }
    
    // 已解决内容区域
    .resolved-content {
      background-color: rgba(var(--color-success-rgb), 0.05);
      border: 2px solid var(--color-success);
      border-radius: 4px;
      overflow: hidden;
      
      .resolved-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 16px;
        background-color: rgba(var(--color-success-rgb), 0.15);
        border-bottom: 1px solid var(--color-success-border);
        
        .resolved-label {
          font-weight: 600;
          color: var(--color-success);
          font-size: 14px;
        }
      }
      
      .resolved-lines {
        .diff-line {
          display: flex;
          padding: 2px 8px;
          font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
          font-size: 13px;
          line-height: 1.6;
          
          &.final-line {
            background-color: rgba(var(--color-success-rgb), 0.12);
            border-left: 3px solid var(--color-success);
          }
          
          .line-number {
            display: inline-block;
            width: 50px;
            color: var(--text-tertiary);
            text-align: right;
            padding-right: 16px;
            user-select: none;
          }
          
          .line-content {
            flex: 1;
            white-space: pre;
            color: var(--text-primary);
          }
        }
      }
    }
  }
}

// 定义一些CSS变量（如果主题中没有定义）
:root {
  --color-success-rgb: 103, 194, 58;
  --color-primary-rgb: 64, 158, 255;
  --color-danger-rgb: 245, 108, 108;
  --color-warning-rgb: 230, 162, 60;
}
</style>
