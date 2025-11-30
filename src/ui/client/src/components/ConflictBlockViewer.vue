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

// 缩短commit hash（只保留前7位）
function shortenHash(label: string): string {
  // 匹配40位的commit hash
  const hashMatch = label.match(/[0-9a-f]{40}/);
  if (hashMatch) {
    return label.replace(hashMatch[0], hashMatch[0].substring(0, 7));
  }
  return label;
}

// 字符级diff对比 - 使用最长公共子序列算法
interface DiffPart {
  type: 'common' | 'added' | 'removed';
  text: string;
}

function computeCharDiff(oldText: string, newText: string): { old: DiffPart[], new: DiffPart[] } {
  // 使用字符级别的LCS算法进行精确对比
  const m = oldText.length;
  const n = newText.length;
  
  // 动态规划矩阵
  const dp: number[][] = Array(m + 1).fill(0).map(() => Array(n + 1).fill(0));
  
  // 填充DP矩阵
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldText[i - 1] === newText[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  
  // 回溯构建diff序列
  let i = m, j = n;
  const oldDiff: Array<{ char: string; type: 'common' | 'removed' }> = [];
  const newDiff: Array<{ char: string; type: 'common' | 'added' }> = [];
  
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldText[i - 1] === newText[j - 1]) {
      oldDiff.unshift({ char: oldText[i - 1], type: 'common' });
      newDiff.unshift({ char: newText[j - 1], type: 'common' });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      newDiff.unshift({ char: newText[j - 1], type: 'added' });
      j--;
    } else if (i > 0) {
      oldDiff.unshift({ char: oldText[i - 1], type: 'removed' });
      i--;
    }
  }
  
  // 合并连续的相同类型字符为文本块
  const mergeOld: DiffPart[] = [];
  for (const item of oldDiff) {
    if (mergeOld.length > 0 && mergeOld[mergeOld.length - 1].type === item.type) {
      mergeOld[mergeOld.length - 1].text += item.char;
    } else {
      mergeOld.push({ type: item.type, text: item.char });
    }
  }
  
  const mergeNew: DiffPart[] = [];
  for (const item of newDiff) {
    if (mergeNew.length > 0 && mergeNew[mergeNew.length - 1].type === item.type) {
      mergeNew[mergeNew.length - 1].text += item.char;
    } else {
      mergeNew.push({ type: item.type, text: item.char });
    }
  }
  
  return { old: mergeOld, new: mergeNew };
}
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

      <!-- 未解决状态：三栏对比视图 -->
      <template v-else>
        <div class="three-way-merge">
          <!-- 左栏：当前更改 -->
          <div class="merge-column current-column">
            <div class="column-header">
              <span class="column-title">{{ $t('@E80AC:当前更改') }} ({{ block.currentLabel }})</span>
            </div>
            <div class="column-content">
              <div
                v-for="(line, idx) in block.currentLines"
                :key="'current-' + idx"
                class="merge-line current-line"
              >
                <span class="line-number">{{ block.startLine + idx }}</span>
                <span class="line-content">
                  <template v-if="block.incomingLines[idx]">
                    <template v-for="(part, _pIdx) in computeCharDiff(line, block.incomingLines[idx]).old" :key="_pIdx">
                      <span :class="{'diff-removed-text': part.type === 'removed', 'diff-common-text': part.type === 'common'}">{{ part.text }}</span>
                    </template>
                  </template>
                  <template v-else>{{ line }}</template>
                </span>
                <button 
                  class="accept-btn left-accept" 
                  @click="handleResolveBlock(block.id, 'current')"
                  title="采用当前更改"
                >
                  &gt;&gt;
                </button>
              </div>
            </div>
          </div>

          <!-- 中栏：合并结果 -->
          <div class="merge-column result-column">
            <div class="column-header">
              <span class="column-title">{{ $t('@E80AC:合并结果') }}</span>
              <el-button
                size="small"
                type="warning"
                @click="handleResolveBlock(block.id, 'both')"
              >
                {{ $t('@E80AC:保留双方') }}
              </el-button>
            </div>
            <div class="column-content result-content">
              <div class="merge-hint">
                <p>{{ $t('@E80AC:点击左右两侧的') }} <strong>&gt;&gt;</strong> {{ $t('@E80AC:或') }} <strong>&lt;&lt;</strong> {{ $t('@E80AC:按钮') }}</p>
                <p>{{ $t('@E80AC:选择要保留的内容') }}</p>
              </div>
            </div>
          </div>

          <!-- 右栏：传入更改 -->
          <div class="merge-column incoming-column">
            <div class="column-header">
              <span class="column-title">{{ $t('@E80AC:传入的更改') }} ({{ shortenHash(block.incomingLabel) }})</span>
            </div>
            <div class="column-content">
              <div
                v-for="(line, idx) in block.incomingLines"
                :key="'incoming-' + idx"
                class="merge-line incoming-line"
              >
                <button 
                  class="accept-btn right-accept" 
                  @click="handleResolveBlock(block.id, 'incoming')"
                  title="采用传入更改"
                >
                  &lt;&lt;
                </button>
                <span class="line-number">{{ block.startLine + idx }}</span>
                <span class="line-content">
                  <template v-if="block.currentLines[idx]">
                    <template v-for="(part, _pIdx) in computeCharDiff(block.currentLines[idx], line).new" :key="_pIdx">
                      <span :class="{'diff-added-text': part.type === 'added', 'diff-common-text': part.type === 'common'}">{{ part.text }}</span>
                    </template>
                  </template>
                  <template v-else>{{ line }}</template>
                </span>
              </div>
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
  padding: var(--spacing-lg);
  background-color: var(--bg-container);
  
  .progress-bar {
    background-color: var(--color-warning-bg);
    border: 1px solid var(--color-warning-border);
    border-radius: var(--radius-lg);
    padding: var(--spacing-md) var(--spacing-lg);
    margin-bottom: 16px;
    
    .progress-info {
      display: flex;
      align-items: center;
      gap: var(--spacing-base);
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
    border-radius: var(--radius-lg);
    margin-bottom: 24px;
    overflow: hidden;
    transition: all 0.3s ease;
    
    &.resolved {
      border-color: var(--color-success-border);
      opacity: 0.8;
    }
    
    .block-header {
      background-color: var(--color-warning-bg);
      padding: var(--spacing-base) var(--spacing-lg);
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
        padding: var(--spacing-xs) var(--spacing-base);
        border-radius: var(--radius-base);
        font-size: 12px;
        font-weight: 500;
      }
    }
    
    .context-lines {
      background-color: var(--bg-elevated);
      
      .context-line {
        display: flex;
        padding: var(--spacing-xs) var(--spacing-base);
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
    
    // 三栏合并视图样式
    .three-way-merge {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 1px;
      background-color: var(--border-color);
      border: 1px solid var(--border-color);
      min-height: 200px;
      
      .merge-column {
        background-color: var(--bg-container);
        display: flex;
        flex-direction: column;
        
        .column-header {
          padding: var(--spacing-base) var(--spacing-md);
          font-weight: 600;
          font-size: 13px;
          background-color: var(--bg-elevated);
          border-bottom: 1px solid var(--border-color);
          display: flex;
          justify-content: space-between;
          align-items: center;
          
          .column-title {
            color: var(--text-primary);
          }
        }
        
        .column-content {
          flex: 1;
          overflow-y: auto;
          
          .merge-line {
            display: flex;
            align-items: center;
            padding: var(--spacing-xs) var(--spacing-sm);
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            font-size: 13px;
            line-height: 1.6;
            position: relative;
            transition: background-color 0.2s;
            
            &:hover {
              background-color: rgba(100, 100, 100, 0.05);
              
              .accept-btn {
                opacity: 1;
              }
            }
            
            .line-number {
              display: inline-block;
              width: 40px;
              color: var(--text-tertiary);
              text-align: right;
              padding-right: 12px;
              user-select: none;
              font-size: 12px;
            }
            
            .line-content {
              flex: 1;
              white-space: pre;
              color: var(--text-primary);
              padding: 0 var(--spacing-sm);
              
              // Diff 高亮样式
              .diff-removed-text {
                background-color: rgba(248, 81, 73, 0.25);
                color: #f85149;
                padding: 0 var(--spacing-xs);
                border-radius: var(--radius-xs);
              }
              
              .diff-added-text {
                background-color: rgba(34, 134, 58, 0.25);
                color: #22863a;
                padding: 0 var(--spacing-xs);
                border-radius: var(--radius-xs);
              }
            }
            
            .accept-btn {
              border: none;
              background-color: rgba(64, 158, 255, 0.8);
              color: white;
              padding: var(--spacing-xs) 6px;
              cursor: pointer;
              font-size: 11px;
              font-weight: bold;
              border-radius: var(--radius-sm);
              opacity: 0;
              transition: all 0.2s;
              
              &:hover {
                background-color: rgba(64, 158, 255, 1);
                transform: scale(1.1);
              }
              
              &:active {
                transform: scale(0.95);
              }
              
              &.left-accept {
                margin-left: 8px;
              }
              
              &.right-accept {
                margin-right: 8px;
              }
            }
          }
        }
        
        &.current-column {
          .column-header {
            background-color: rgba(64, 200, 174, 0.15);
            color: #2d6a5d;
          }
          
          .merge-line {
            background-color: rgba(64, 200, 174, 0.08);
          }
        }
        
        &.incoming-column {
          .column-header {
            background-color: rgba(64, 158, 255, 0.15);
            color: #2d4a6d;
          }
          
          .merge-line {
            background-color: rgba(64, 158, 255, 0.08);
          }
        }
        
        &.result-column {
          .column-header {
            background-color: var(--bg-elevated);
          }
          
          .result-content {
            display: flex;
            align-items: center;
            justify-content: center;
            
            .merge-hint {
              text-align: center;
              color: var(--text-secondary);
              padding: var(--spacing-xl);
              
              p {
                margin: var(--spacing-base) 0;
                font-size: 13px;
                line-height: 1.6;
                
                strong {
                  color: var(--color-primary);
                  font-family: 'Consolas', 'Monaco', monospace;
                  background-color: rgba(64, 158, 255, 0.1);
                  padding: var(--spacing-xs) 6px;
                  border-radius: var(--radius-sm);
                }
              }
            }
          }
        }
      }
    }
    
    .block-resolution-info {
      padding: var(--spacing-base) var(--spacing-lg);
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
      border-radius: var(--radius-base);
      overflow: hidden;
      
      .resolved-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: var(--spacing-base) var(--spacing-lg);
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
          padding: var(--spacing-xs) var(--spacing-base);
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
