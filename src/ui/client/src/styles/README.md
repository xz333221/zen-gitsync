# CSS变量使用指南

## 概述

项目中已统一创建了全局CSS变量系统，位于 `src/ui/client/src/styles/variables.scss`。该文件定义了完整的设计令牌（Design Tokens），包括颜色、尺寸、动画等，确保整个项目的视觉一致性。

## 文件结构

```
src/ui/client/src/styles/
├── variables.scss    # 全局CSS变量定义（主文件）
└── common.scss       # 公共样式（Git差异、滚动条等）
```

## 主要变量分类

### 1. 颜色系统

#### 基础颜色
```scss
--color-primary: #409eff;           // 主色调
--color-success: #67c23a;           // 成功色
--color-warning: #e6a23c;           // 警告色  
--color-danger: #f56c6c;            // 危险色
--color-info: #909399;              // 信息色
```

#### Git文件状态颜色
```scss
--git-status-added: #10b981;        // 新增文件 - 绿色
--git-status-modified: #f59e0b;     // 修改文件 - 橙色
--git-status-deleted: #ef4444;      // 删除文件 - 红色
--git-status-untracked: #8b5cf6;    // 未跟踪文件 - 紫色
--git-status-locked: #dc2626;       // 锁定文件 - 深红色
```

#### 中性颜色
```scss
--color-gray-50: #f9fafb;           // 最浅灰色
--color-gray-100: #f3f4f6;          // 浅灰色
--color-gray-400: #9ca3af;          // 中灰色
--color-gray-800: #1f2937;          // 深灰色
```

### 2. 语义化颜色

#### 背景颜色
```scss
--bg-page: #f5f5f5;                 // 页面背景
--bg-container: var(--color-white); // 容器背景
--bg-container-hover: #f8fafc;      // 容器悬浮背景
```

#### 文字颜色
```scss
--text-primary: #1f2937;            // 主要文字
--text-secondary: #606266;          // 次要文字
--text-tertiary: #9ca3af;           // 辅助文字
--text-link: var(--color-primary);  // 链接文字
```

#### 边框颜色
```scss
--border-color: rgba(0, 0, 0, 0.06);      // 基础边框
--border-hover: rgba(102, 126, 234, 0.15); // 悬浮边框
--border-focus: var(--color-primary);      // 聚焦边框
```

### 3. 尺寸系统

#### 圆角
```scss
--radius-xs: 2px;                   // 最小圆角
--radius-sm: 3px;                   // 小圆角
--radius-base: 4px;                 // 基础圆角
--radius-md: 6px;                   // 中等圆角
--radius-lg: 8px;                   // 大圆角
```

#### 间距
```scss
--spacing-xs: 2px;                  // 最小间距
--spacing-sm: 4px;                  // 小间距
--spacing-base: 8px;                // 基础间距
--spacing-md: 12px;                 // 中等间距
--spacing-lg: 16px;                 // 大间距
```

#### 字体大小
```scss
--font-size-xs: 10px;               // 最小字体
--font-size-sm: 12px;               // 小字体
--font-size-base: 13px;             // 基础字体
--font-size-md: 14px;               // 中等字体
--font-size-lg: 16px;               // 大字体
```

### 4. 阴影系统
```scss
--shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.04);     // 小阴影
--shadow-base: 0 1px 4px rgba(0, 0, 0, 0.04);   // 基础阴影
--shadow-md: 0 2px 8px rgba(0, 0, 0, 0.08);     // 中等阴影
--shadow-lg: 0 4px 12px rgba(0, 0, 0, 0.08);    // 大阴影
--shadow-hover: 0 4px 12px rgba(0, 0, 0, 0.08); // 悬浮阴影
```

### 5. 动画系统
```scss
--transition-fast: 0.1s;                        // 快速过渡
--transition-base: 0.2s;                        // 基础过渡
--transition-slow: 0.3s;                        // 慢速过渡
--transition-all: all var(--transition-base) var(--ease-custom);
```

## 使用方法

### 1. 在Vue组件中使用

```vue
<template>
  <div class="my-component">
    <div class="status-indicator added"></div>
    <span class="file-name">文件名.vue</span>
  </div>
</template>

<style scoped>
/* 导入全局变量 */
@import '../styles/variables.scss';

.my-component {
  padding: var(--spacing-md);
  background: var(--bg-container);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-base);
  transition: var(--transition-all);
}

.my-component:hover {
  box-shadow: var(--shadow-hover);
}

.status-indicator {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  
  &.added {
    background: var(--git-status-added);
  }
}

.file-name {
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
}
</style>
```

### 2. 使用便捷工具类

已预定义的工具类，可直接在模板中使用：

```vue
<template>
  <!-- 使用渐变背景 -->
  <div class="bg-gradient-primary">主要渐变背景</div>
  
  <!-- 使用Git状态颜色 -->
  <span class="text-git-added">新增文件</span>
  <span class="text-git-modified">修改文件</span>
  
  <!-- 使用阴影 -->
  <div class="shadow-base">基础阴影</div>
  <div class="shadow-lg">大阴影</div>
  
  <!-- 使用过渡效果 -->
  <button class="transition-all">按钮</button>
</template>
```

### 3. 在原生CSS中使用

```css
.custom-button {
  background: var(--btn-primary-bg);
  color: var(--btn-primary-color);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-base);
  padding: var(--spacing-sm) var(--spacing-md);
  transition: var(--transition-all);
}

.custom-button:hover {
  background: var(--btn-primary-hover-bg);
  box-shadow: var(--shadow-hover);
}
```

## 深色主题支持

系统已预备深色主题变量，通过 `[data-theme="dark"]` 选择器自动切换：

```scss
[data-theme="dark"] {
  --bg-page: var(--bg-page-dark);
  --text-primary: var(--text-primary-dark);
  // ... 其他深色主题变量
}
```

## 最佳实践

### 1. 优先使用语义化变量
```scss
/* ✅ 推荐 - 使用语义化变量 */
color: var(--text-primary);
background: var(--bg-container);

/* ❌ 避免 - 直接使用基础颜色变量 */
color: var(--color-gray-800);
background: var(--color-white);
```

### 2. 按钮样式统一
```scss
/* ✅ 推荐 - 使用按钮变量 */
.custom-btn {
  background: var(--btn-primary-bg);
  color: var(--btn-primary-color);
}

.custom-btn:hover {
  background: var(--btn-primary-hover-bg);
}
```

### 3. Git状态一致性
```scss
/* ✅ 推荐 - 使用Git状态变量 */
.file-status.added { color: var(--git-status-added); }
.file-status.modified { color: var(--git-status-modified); }
.file-status.deleted { color: var(--git-status-deleted); }
```

### 4. 过渡动画统一
```scss
/* ✅ 推荐 - 使用预定义过渡 */
transition: var(--transition-all);
transition: var(--transition-color);

/* ❌ 避免 - 自定义过渡时间 */
transition: all 0.15s ease;
```

## 扩展指南

如需添加新的设计变量，请在 `variables.scss` 中相应分类下添加：

```scss
/* 添加新的语义颜色 */
:root {
  --color-accent: #ff6b6b;           // 新的强调色
  --text-accent: var(--color-accent); // 对应的文字颜色
}

/* 添加新的组件变量 */
:root {
  --component-header-bg: var(--bg-container);
  --component-header-height: 48px;
}
```

## 注意事项

1. **导入顺序**：确保在组件样式中正确导入 `variables.scss`
2. **命名规范**：遵循 `--类别-用途-状态` 的命名规则
3. **向下兼容**：新增变量不应破坏现有组件样式
4. **性能考虑**：CSS变量有良好的浏览器支持和性能表现
5. **团队协作**：新增变量应在团队内讨论确认

通过统一的CSS变量系统，我们可以：
- 🎨 确保设计一致性
- 🔧 简化主题切换
- 🚀 提高开发效率
- 📱 支持响应式设计
- 🌙 轻松实现深色模式