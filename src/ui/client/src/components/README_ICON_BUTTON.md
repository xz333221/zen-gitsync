# IconButton 图标按钮组件

一个通用的图标按钮组件，支持 SVG 图标和图片，提供统一的 hover 效果和交互体验。

## 功能特性

- ✅ 支持 SVG 图标（通过 `svg-icon` 组件）
- ✅ 支持图片图标（通过 URL）
- ✅ 支持插槽自定义内容
- ✅ **增强的 hover 效果**：上浮动画 + 阴影 + 背景色变化
- ✅ 三种尺寸：small (32px)、medium (36px)、large (40px)
- ✅ 激活状态支持
- ✅ 禁用状态支持
- ✅ 提示文本（Tooltip）
- ✅ 自定义颜色
- ✅ 无障碍支持

## 基础用法

### 使用 SVG 图标

```vue
<template>
  <IconButton 
    icon-class="git"
    tooltip="Git 操作"
    @click="handleClick"
  />
</template>

<script setup>
import IconButton from '@/components/IconButton.vue'

const handleClick = () => {
  console.log('按钮被点击')
}
</script>
```

### 使用图片

```vue
<template>
  <IconButton 
    image-url="/path/to/image.png"
    tooltip="操作按钮"
    @click="handleClick"
  />
</template>
```

### 使用插槽

```vue
<template>
  <IconButton tooltip="自定义内容" @click="handleClick">
    <el-icon><Setting /></el-icon>
  </IconButton>
</template>
```

## Props 参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `icon-class` | `string` | - | SVG 图标类名（来自 assets/icons/svg/） |
| `image-url` | `string` | - | 图片 URL |
| `size` | `'small' \| 'medium' \| 'large'` | `'medium'` | 按钮尺寸 |
| `disabled` | `boolean` | `false` | 是否禁用 |
| `active` | `boolean` | `false` | 是否激活状态 |
| `tooltip` | `string` | `''` | 提示文本 |
| `custom-class` | `string` | `''` | 自定义类名 |
| `color` | `string` | - | 图标颜色（仅对 SVG 有效） |
| `hover-color` | `string` | `'var(--color-primary)'` | hover 时的颜色 |

## Events 事件

| 事件名 | 参数 | 说明 |
|--------|------|------|
| `click` | `(event: MouseEvent)` | 按钮点击事件 |

## 尺寸说明

### Small (32x32px)
- 按钮尺寸：32px × 32px
- 图标尺寸：18px × 18px
- **font-size: 18px** (SVG 图标根据 font-size 显示大小)

```vue
<IconButton icon-class="git" size="small" />
```

### Medium (36x36px) - 默认
- 按钮尺寸：36px × 36px
- 图标尺寸：20px × 20px
- **font-size: 20px** (SVG 图标根据 font-size 显示大小)

```vue
<IconButton icon-class="git" size="medium" />
```

### Large (40x40px)
- 按钮尺寸：40px × 40px
- 图标尺寸：22px × 22px
- **font-size: 22px** (SVG 图标根据 font-size 显示大小)

```vue
<IconButton icon-class="git" size="large" />
```

> **注意：** SVG 图标（特别是 `<el-icon>`）的显示大小主要由 `font-size` 控制。组件会自动为不同尺寸设置相应的 `font-size`，确保图标正确显示。

## 状态示例

### 激活状态

```vue
<IconButton 
  icon-class="git"
  :active="isActive"
  @click="toggleActive"
/>
```

### 禁用状态

```vue
<IconButton 
  icon-class="git"
  disabled
  tooltip="此功能暂不可用"
/>
```

## 自定义颜色

### 自定义默认颜色

```vue
<IconButton 
  icon-class="git"
  color="#67c23a"
/>
```

### 自定义 Hover 颜色

```vue
<IconButton 
  icon-class="git"
  hover-color="#f56c6c"
/>
```

## 完整示例

### 工具栏按钮组

```vue
<template>
  <div class="toolbar">
    <IconButton 
      icon-class="refresh"
      tooltip="刷新"
      size="medium"
      @click="handleRefresh"
    />
    
    <IconButton 
      icon-class="settings"
      tooltip="设置"
      size="medium"
      :active="showSettings"
      @click="toggleSettings"
    />
    
    <IconButton 
      icon-class="delete"
      tooltip="删除"
      size="medium"
      hover-color="var(--color-danger)"
      :disabled="!canDelete"
      @click="handleDelete"
    />
  </div>
</template>

<script setup>
import { ref } from 'vue'
import IconButton from '@/components/IconButton.vue'

const showSettings = ref(false)
const canDelete = ref(true)

const handleRefresh = () => {
  console.log('刷新')
}

const toggleSettings = () => {
  showSettings.value = !showSettings.value
}

const handleDelete = () => {
  console.log('删除')
}
</script>

<style scoped>
.toolbar {
  display: flex;
  gap: 4px;
  align-items: center;
}
</style>
```

### 文件操作按钮

```vue
<template>
  <div class="file-actions">
    <IconButton 
      icon-class="folder-open"
      tooltip="在资源管理器中打开"
      @click="openInExplorer"
    />
    
    <IconButton 
      icon-class="copy"
      tooltip="复制路径"
      @click="copyPath"
    />
    
    <IconButton 
      icon-class="terminal"
      tooltip="在终端中打开"
      @click="openInTerminal"
    />
  </div>
</template>
```

### Git 操作按钮

```vue
<template>
  <div class="git-actions">
    <IconButton 
      icon-class="git-commit"
      tooltip="提交"
      hover-color="var(--color-success)"
      @click="commit"
    />
    
    <IconButton 
      icon-class="git-pull"
      tooltip="拉取"
      hover-color="var(--color-primary)"
      @click="pull"
    />
    
    <IconButton 
      icon-class="git-push"
      tooltip="推送"
      hover-color="var(--color-warning)"
      @click="push"
    />
  </div>
</template>
```

## 样式定制

### 自定义样式类

```vue
<template>
  <IconButton 
    icon-class="git"
    custom-class="my-custom-button"
  />
</template>

<style scoped>
.my-custom-button {
  border: 1px solid var(--border-card);
  background: var(--bg-container);
}

.my-custom-button:hover {
  border-color: var(--color-primary);
  box-shadow: var(--shadow-sm);
}
</style>
```

### 覆盖默认样式

```vue
<style scoped>
:deep(.icon-button) {
  border-radius: var(--radius-lg);
}

:deep(.icon-button:hover) {
  transform: scale(1.1);
}
</style>
```

## 最佳实践

### 1. 语义化命名

```vue
<!-- 好的做法 -->
<IconButton icon-class="refresh" tooltip="刷新数据" />
<IconButton icon-class="settings" tooltip="打开设置" />

<!-- 不好的做法 -->
<IconButton icon-class="icon1" tooltip="按钮1" />
```

### 2. 提供清晰的提示文本

```vue
<!-- 好的做法 -->
<IconButton 
  icon-class="delete"
  tooltip="删除此项（不可恢复）"
/>

<!-- 不好的做法 -->
<IconButton icon-class="delete" />
```

### 3. 合理使用颜色

```vue
<!-- 危险操作使用红色 -->
<IconButton 
  icon-class="delete"
  hover-color="var(--color-danger)"
/>

<!-- 成功操作使用绿色 -->
<IconButton 
  icon-class="check"
  hover-color="var(--color-success)"
/>

<!-- 警告操作使用黄色 -->
<IconButton 
  icon-class="warning"
  hover-color="var(--color-warning)"
/>
```

### 4. 响应式按钮组

```vue
<template>
  <div class="responsive-toolbar">
    <IconButton 
      v-for="action in actions"
      :key="action.id"
      :icon-class="action.icon"
      :tooltip="action.tooltip"
      :disabled="action.disabled"
      @click="action.handler"
    />
  </div>
</template>

<script setup>
const actions = [
  { 
    id: 'refresh', 
    icon: 'refresh', 
    tooltip: '刷新', 
    disabled: false,
    handler: () => console.log('refresh') 
  },
  // ...
]
</script>

<style scoped>
.responsive-toolbar {
  display: flex;
  gap: var(--spacing-sm);
  flex-wrap: wrap;
}
</style>
```

## 无障碍支持

组件已内置无障碍支持：

- ✅ 键盘焦点样式（`:focus-visible`）
- ✅ 禁用状态的正确处理
- ✅ Tooltip 提供额外信息
- ✅ 按钮语义正确

## 性能优化

- 使用 CSS 变量实现动画，性能更好
- 事件处理使用防抖或节流（根据需要）
- 懒加载图片（如使用图片 URL）

```vue
<script setup>
import { useDebounceFn } from '@vueuse/core'

const debouncedClick = useDebounceFn(() => {
  console.log('处理点击')
}, 300)
</script>

<template>
  <IconButton 
    icon-class="search"
    @click="debouncedClick"
  />
</template>
```

## 与其他组件配合

### 配合下拉菜单

```vue
<template>
  <el-dropdown>
    <IconButton icon-class="more" />
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item>操作 1</el-dropdown-item>
        <el-dropdown-item>操作 2</el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>
```

### 配合气泡确认

```vue
<template>
  <el-popconfirm
    title="确定要删除吗？"
    @confirm="handleDelete"
  >
    <template #reference>
      <IconButton 
        icon-class="delete"
        hover-color="var(--color-danger)"
      />
    </template>
  </el-popconfirm>
</template>
```

## 注意事项

1. **图标优先级**：`icon-class` > `image-url` > 默认插槽
2. **颜色变量**：`color` 属性仅对 SVG 图标有效
3. **禁用状态**：禁用时不会触发点击事件
4. **尺寸一致性**：同一工具栏中的按钮应使用相同尺寸
5. **提示文本**：重要操作建议添加 tooltip

## 相关组件

- `SvgIcon.vue` - SVG 图标组件
- `CommonDialog.vue` - 通用对话框组件
- `OptionSwitchCard.vue` - 选项开关卡片组件
