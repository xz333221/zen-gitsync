<script setup lang="ts">
import { ref } from 'vue'
import IconButton from '../IconButton.vue'
import { 
  Refresh, 
  Setting, 
  Delete, 
  Plus, 
  FolderOpened,
  Search,
  More,
  Download,
  Upload,
  Edit,
  View,
  Document,
  Files,
  Clock
} from '@element-plus/icons-vue'

// 状态管理
const activeButtons = ref<Set<string>>(new Set())
const isRefreshing = ref(false)

// 切换激活状态
const toggleActive = (id: string) => {
  if (activeButtons.value.has(id)) {
    activeButtons.value.delete(id)
  } else {
    activeButtons.value.add(id)
  }
}

// 刷新操作
const handleRefresh = async () => {
  isRefreshing.value = true
  // 模拟异步操作
  await new Promise(resolve => setTimeout(resolve, 1000))
  isRefreshing.value = false
  console.log('刷新完成')
}

// 其他操作
const handleSettings = () => console.log('打开设置')
const handleDelete = () => console.log('删除')
const handleAdd = () => console.log('添加')
</script>

<template>
  <div class="icon-button-examples">
    <h2>IconButton 组件示例</h2>
    
    <!-- 基础用法 -->
    <section class="example-section">
      <h3>基础用法</h3>
      <div class="button-group">
        <IconButton 
          tooltip="刷新"
          :disabled="isRefreshing"
          @click="handleRefresh"
        >
          <el-icon><Refresh /></el-icon>
        </IconButton>
        
        <IconButton 
          tooltip="设置"
          @click="handleSettings"
        >
          <el-icon><Setting /></el-icon>
        </IconButton>
        
        <IconButton 
          tooltip="删除"
          hover-color="var(--color-danger)"
          @click="handleDelete"
        >
          <el-icon><Delete /></el-icon>
        </IconButton>
        
        <IconButton 
          tooltip="添加"
          hover-color="var(--color-success)"
          @click="handleAdd"
        >
          <el-icon><Plus /></el-icon>
        </IconButton>
      </div>
    </section>

    <!-- 不同尺寸 -->
    <section class="example-section">
      <h3>尺寸变体</h3>
      <div class="button-group">
        <div class="size-demo">
          <label>Small</label>
          <IconButton size="small" tooltip="小尺寸">
            <el-icon><View /></el-icon>
          </IconButton>
        </div>
        
        <div class="size-demo">
          <label>Medium (默认)</label>
          <IconButton size="medium" tooltip="中等尺寸">
            <el-icon><View /></el-icon>
          </IconButton>
        </div>
        
        <div class="size-demo">
          <label>Large</label>
          <IconButton size="large" tooltip="大尺寸">
            <el-icon><View /></el-icon>
          </IconButton>
        </div>
      </div>
    </section>

    <!-- 激活状态 -->
    <section class="example-section">
      <h3>激活状态</h3>
      <div class="button-group">
        <IconButton 
          tooltip="文件"
          :active="activeButtons.has('files')"
          @click="toggleActive('files')"
        >
          <el-icon><Files /></el-icon>
        </IconButton>
        
        <IconButton 
          tooltip="文档"
          :active="activeButtons.has('document')"
          @click="toggleActive('document')"
        >
          <el-icon><Document /></el-icon>
        </IconButton>
        
        <IconButton 
          tooltip="历史"
          :active="activeButtons.has('clock')"
          @click="toggleActive('clock')"
        >
          <el-icon><Clock /></el-icon>
        </IconButton>
      </div>
    </section>

    <!-- 禁用状态 -->
    <section class="example-section">
      <h3>禁用状态</h3>
      <div class="button-group">
        <IconButton 
          tooltip="已禁用"
          disabled
        >
          <el-icon><Setting /></el-icon>
        </IconButton>
        
        <IconButton 
          tooltip="已禁用"
          disabled
          :active="true"
        >
          <el-icon><View /></el-icon>
        </IconButton>
      </div>
    </section>

    <!-- 工具栏示例 -->
    <section class="example-section">
      <h3>工具栏示例</h3>
      <div class="toolbar">
        <div class="toolbar-group">
          <IconButton tooltip="打开文件夹">
            <el-icon><FolderOpened /></el-icon>
          </IconButton>
          
          <IconButton tooltip="搜索">
            <el-icon><Search /></el-icon>
          </IconButton>
        </div>
        
        <div class="toolbar-divider"></div>
        
        <div class="toolbar-group">
          <IconButton tooltip="下载">
            <el-icon><Download /></el-icon>
          </IconButton>
          
          <IconButton tooltip="上传">
            <el-icon><Upload /></el-icon>
          </IconButton>
        </div>
        
        <div class="toolbar-divider"></div>
        
        <div class="toolbar-group">
          <IconButton tooltip="编辑">
            <el-icon><Edit /></el-icon>
          </IconButton>
          
          <IconButton tooltip="更多">
            <el-icon><More /></el-icon>
          </IconButton>
        </div>
      </div>
    </section>

    <!-- 自定义颜色 -->
    <section class="example-section">
      <h3>自定义颜色</h3>
      <div class="button-group">
        <IconButton 
          tooltip="成功操作"
          hover-color="var(--color-success)"
        >
          <el-icon><Plus /></el-icon>
        </IconButton>
        
        <IconButton 
          tooltip="警告操作"
          hover-color="var(--color-warning)"
        >
          <el-icon><Setting /></el-icon>
        </IconButton>
        
        <IconButton 
          tooltip="危险操作"
          hover-color="var(--color-danger)"
        >
          <el-icon><Delete /></el-icon>
        </IconButton>
      </div>
    </section>

    <!-- 实际应用场景：命令控制台按钮组 -->
    <section class="example-section">
      <h3>实际应用：命令控制台</h3>
      <div class="console-toolbar">
        <IconButton 
          tooltip="刷新"
          size="small"
          @click="handleRefresh"
        >
          <el-icon><Refresh /></el-icon>
        </IconButton>
        
        <IconButton 
          tooltip="清空"
          size="small"
          hover-color="var(--color-warning)"
        >
          <el-icon><Delete /></el-icon>
        </IconButton>
        
        <IconButton 
          tooltip="搜索"
          size="small"
          :active="activeButtons.has('console-search')"
          @click="toggleActive('console-search')"
        >
          <el-icon><Search /></el-icon>
        </IconButton>
        
        <IconButton 
          tooltip="设置"
          size="small"
        >
          <el-icon><Setting /></el-icon>
        </IconButton>
      </div>
    </section>
  </div>
</template>

<style scoped lang="scss">
.icon-button-examples {
  padding: var(--spacing-2xl);
  max-width: 1200px;
  margin: 0 auto;

  h2 {
    margin-bottom: var(--spacing-2xl);
    color: var(--text-title);
    font-size: var(--font-size-2xl);
  }
}

.example-section {
  margin-bottom: var(--spacing-3xl);
  padding: var(--spacing-xl);
  background: var(--bg-container);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);

  h3 {
    margin: 0 0 var(--spacing-lg) 0;
    color: var(--text-title);
    font-size: var(--font-size-lg);
    padding-bottom: var(--spacing-base);
    border-bottom: 1px solid var(--border-card);
  }
}

.button-group {
  display: flex;
  gap: var(--spacing-lg);
  align-items: center;
  flex-wrap: wrap;
}

.size-demo {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-sm);

  label {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
}

.toolbar {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  padding: var(--spacing-base);
  background: var(--bg-panel);
  border-radius: var(--radius-base);
  border: 1px solid var(--border-card);
}

.toolbar-group {
  display: flex;
  gap: var(--spacing-xs);
}

.toolbar-divider {
  width: 1px;
  height: 20px;
  background: var(--border-card);
}

.console-toolbar {
  display: flex;
  gap: var(--spacing-xs);
  padding: var(--spacing-sm);
  background: var(--bg-panel);
  border-radius: var(--radius-base);
  width: fit-content;
}
</style>
