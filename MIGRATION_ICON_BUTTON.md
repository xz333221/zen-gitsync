# IconButton 组件迁移指南

本文档说明如何将现有的按钮替换为新的 `IconButton` 组件。

## 迁移前后对比

### 原有写法（以 CommandConsole.vue 为例）

```vue
<template>
  <!-- 原有的按钮实现 -->
  <button 
    class="toggle-console-btn"
    @click="handleClick"
  >
    <el-icon><Setting /></el-icon>
  </button>
</template>

<style scoped lang="scss">
.toggle-console-btn {
  padding: var(--spacing-sm) var(--spacing-base);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  transition: all 0.3s ease;
  
  &:hover {
    color: var(--color-primary);
    background: rgba(64, 158, 255, 0.1);
  }
  
  .el-icon {
    transition: transform 0.3s ease;
    font-size: var(--font-size-md);
  }
}
</style>
```

### 使用 IconButton（新写法）

```vue
<template>
  <!-- 使用 IconButton 组件 -->
  <IconButton 
    tooltip="设置"
    @click="handleClick"
  >
    <el-icon><Setting /></el-icon>
  </IconButton>
</template>

<script setup>
import IconButton from '@/components/IconButton.vue'
// 无需自定义样式，组件已内置统一的 hover 效果
</script>
```

## 具体迁移案例

### 案例 1：命令控制台工具栏

**迁移前：**

```vue
<template>
  <div class="console-toolbar">
    <button class="toolbar-btn refresh-btn" @click="refresh">
      <el-icon><Refresh /></el-icon>
    </button>
    
    <button class="toolbar-btn clear-btn" @click="clear">
      <el-icon><Delete /></el-icon>
    </button>
    
    <button class="toolbar-btn search-btn" @click="toggleSearch">
      <el-icon><Search /></el-icon>
    </button>
  </div>
</template>

<style scoped lang="scss">
.toolbar-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--text-secondary);
  transition: all 0.3s ease;
  
  &:hover {
    color: var(--color-primary);
    background: rgba(64, 158, 255, 0.1);
  }
}

.refresh-btn:hover { color: var(--color-primary); }
.clear-btn:hover { color: var(--color-warning); }
.search-btn:hover { color: var(--color-primary); }
</style>
```

**迁移后：**

```vue
<template>
  <div class="console-toolbar">
    <IconButton 
      tooltip="刷新"
      @click="refresh"
    >
      <el-icon><Refresh /></el-icon>
    </IconButton>
    
    <IconButton 
      tooltip="清空"
      hover-color="var(--color-warning)"
      @click="clear"
    >
      <el-icon><Delete /></el-icon>
    </IconButton>
    
    <IconButton 
      tooltip="搜索"
      :active="showSearch"
      @click="toggleSearch"
    >
      <el-icon><Search /></el-icon>
    </IconButton>
  </div>
</template>

<script setup>
import IconButton from '@/components/IconButton.vue'
// 样式大幅简化！
</script>

<style scoped lang="scss">
.console-toolbar {
  display: flex;
  gap: var(--spacing-xs);
}
</style>
```

### 案例 2：文件操作按钮

**迁移前：**

```vue
<template>
  <div class="file-actions">
    <el-button 
      text 
      circle 
      size="small"
      @click="openInExplorer"
    >
      <el-icon><FolderOpened /></el-icon>
    </el-button>
    
    <el-button 
      text 
      circle 
      size="small"
      @click="copyPath"
    >
      <el-icon><DocumentCopy /></el-icon>
    </el-button>
  </div>
</template>
```

**迁移后：**

```vue
<template>
  <div class="file-actions">
    <IconButton 
      tooltip="在资源管理器中打开"
      size="small"
      @click="openInExplorer"
    >
      <el-icon><FolderOpened /></el-icon>
    </IconButton>
    
    <IconButton 
      tooltip="复制路径"
      size="small"
      @click="copyPath"
    >
      <el-icon><DocumentCopy /></el-icon>
    </IconButton>
  </div>
</template>

<script setup>
import IconButton from '@/components/IconButton.vue'
</script>

<style scoped lang="scss">
.file-actions {
  display: flex;
  gap: var(--spacing-xs);
}
</style>
```

### 案例 3：带激活状态的按钮

**迁移前：**

```vue
<template>
  <button 
    class="view-toggle"
    :class="{ 'is-active': isGridView }"
    @click="toggleView"
  >
    <el-icon><Grid /></el-icon>
  </button>
</template>

<style scoped lang="scss">
.view-toggle {
  color: var(--text-secondary);
  
  &:hover {
    color: var(--color-primary);
    background: rgba(64, 158, 255, 0.1);
  }
  
  &.is-active {
    color: var(--color-primary);
    background: rgba(64, 158, 255, 0.15);
  }
}
</style>
```

**迁移后：**

```vue
<template>
  <IconButton 
    tooltip="网格视图"
    :active="isGridView"
    @click="toggleView"
  >
    <el-icon><Grid /></el-icon>
  </IconButton>
</template>

<script setup>
import IconButton from '@/components/IconButton.vue'
// 激活状态完全由组件处理
</script>
```

## 迁移步骤

### 1. 导入组件

在需要使用的组件中导入 `IconButton`：

```vue
<script setup>
import IconButton from '@/components/IconButton.vue'
</script>
```

### 2. 替换按钮标签

将原有的 `<button>` 或 `<el-button>` 替换为 `<IconButton>`：

```vue
<!-- 原来 -->
<button class="my-btn" @click="handleClick">
  <el-icon><Setting /></el-icon>
</button>

<!-- 替换为 -->
<IconButton @click="handleClick">
  <el-icon><Setting /></el-icon>
</IconButton>
```

### 3. 添加必要的属性

根据原有功能添加对应的属性：

```vue
<IconButton 
  tooltip="按钮说明"
  size="medium"
  :disabled="isDisabled"
  :active="isActive"
  hover-color="var(--color-primary)"
  @click="handleClick"
>
  <el-icon><Setting /></el-icon>
</IconButton>
```

### 4. 删除自定义样式

由于 `IconButton` 已经提供了统一的样式，可以删除大部分自定义样式：

```scss
// 可以删除这些样式
.my-btn {
  &:hover { ... }
  &:active { ... }
  &.is-active { ... }
  transition: ...;
}
```

### 5. 调整容器样式

只保留容器的布局样式：

```scss
// 保留这些样式
.toolbar {
  display: flex;
  gap: var(--spacing-xs);
}
```

## 批量迁移脚本

如果有大量按钮需要迁移，可以使用以下脚本辅助：

```javascript
// migrate-to-icon-button.js
const fs = require('fs');
const path = require('path');

function migrateFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  
  // 替换简单的 button 标签
  content = content.replace(
    /<button\s+class="([^"]*toolbar-btn[^"]*)"\s+@click="([^"]+)"\s*>/g,
    '<IconButton tooltip="" @click="$2">'
  );
  
  content = content.replace(
    /<\/button>/g,
    '</IconButton>'
  );
  
  // 添加导入语句（如果还没有）
  if (!content.includes('import IconButton')) {
    content = content.replace(
      /(<script setup[^>]*>)/,
      '$1\nimport IconButton from \'@/components/IconButton.vue\'\n'
    );
  }
  
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`✅ 迁移完成: ${filePath}`);
}

// 使用示例
// node migrate-to-icon-button.js path/to/your/component.vue
```

## 常见问题

### Q1: 如何自定义按钮尺寸？

使用 `size` 属性：

```vue
<IconButton size="small" /> <!-- 24px -->
<IconButton size="medium" /> <!-- 28px，默认 -->
<IconButton size="large" /> <!-- 32px -->
```

### Q2: 如何改变 hover 颜色？

使用 `hover-color` 属性：

```vue
<IconButton hover-color="var(--color-danger)" />
<IconButton hover-color="#67c23a" />
```

### Q3: 如何添加提示文本？

使用 `tooltip` 属性：

```vue
<IconButton tooltip="这是提示文本" />
```

### Q4: 原有的自定义样式怎么办？

大部分情况下不再需要自定义样式。如果确实需要，可以使用 `custom-class`：

```vue
<IconButton custom-class="my-special-style" />

<style>
.my-special-style {
  border: 1px solid red;
}
</style>
```

### Q5: 如何处理禁用状态？

使用 `disabled` 属性：

```vue
<IconButton :disabled="isLoading" />
```

### Q6: 如何处理激活/选中状态？

使用 `active` 属性：

```vue
<IconButton :active="isSelected" />
```

## 迁移清单

使用以下清单确保迁移完整：

- [ ] 导入 `IconButton` 组件
- [ ] 替换所有相关的按钮标签
- [ ] 添加必要的属性（tooltip、size 等）
- [ ] 删除冗余的自定义样式
- [ ] 测试所有交互功能
- [ ] 测试键盘导航和无障碍
- [ ] 检查不同主题下的显示效果
- [ ] 更新相关文档和注释

## 性能对比

### 迁移前
- 代码行数：~50 行（含样式）
- CSS 规则：~15 个
- 维护成本：高

### 迁移后
- 代码行数：~5 行
- CSS 规则：~2 个（仅容器布局）
- 维护成本：低

## 需要帮助？

如果在迁移过程中遇到问题：

1. 查看 `README_ICON_BUTTON.md` 了解详细用法
2. 参考 `IconButtonExample.vue` 查看示例
3. 检查组件源码 `IconButton.vue` 了解实现细节

## 迁移时间表建议

1. **第一阶段**（1-2天）：迁移核心工具栏按钮
2. **第二阶段**（2-3天）：迁移文件操作相关按钮
3. **第三阶段**（1-2天）：迁移其他零散按钮
4. **第四阶段**（1天）：清理旧样式代码，测试验证

## 总结

`IconButton` 组件的优势：

- ✅ 统一的视觉效果和交互体验
- ✅ 大幅减少重复代码
- ✅ 易于维护和扩展
- ✅ 内置无障碍支持
- ✅ 性能优化的动画效果

迁移后，代码会更加简洁、易读、易维护！
