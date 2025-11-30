# 字体大小转换工具使用说明

## 功能说明

该脚本将项目中硬编码的 `font-size` 值转换为标准的 CSS 变量引用。

## 字体大小映射规则

基于项目中的 `src/ui/client/src/styles/variables.scss` 定义：

### 标准字体大小

| 原值 | 映射变量 | 说明 |
|------|---------|------|
| `10px` | `var(--font-size-xs)` | 超小字体 |
| `12px` | `var(--font-size-sm)` | 小字体 |
| `13px` | `var(--font-size-sm)` | 映射到小字体 |
| `14px` | `var(--font-size-base)` | 基础字体 |
| `15px` | `var(--font-size-base)` | 映射到基础字体 |
| `16px` | `var(--font-size-md)` | 中等字体 |
| `18px` | `var(--font-size-lg)` | 大字体 |
| `20px` | `var(--font-size-xl)` | 超大字体 |
| `22px` | `var(--font-size-2xl)` | 2倍大字体 |
| `24px` | `var(--font-size-3xl)` | 3倍大字体 |

### rem 单位支持

| 原值 | 映射变量 | 等效 px |
|------|---------|---------|
| `0.625rem` | `var(--font-size-xs)` | 10px |
| `0.75rem` | `var(--font-size-sm)` | 12px |
| `0.875rem` | `var(--font-size-base)` | 14px |
| `1rem` | `var(--font-size-md)` | 16px |
| `1.125rem` | `var(--font-size-lg)` | 18px |
| `1.25rem` | `var(--font-size-xl)` | 20px |
| `1.375rem` | `var(--font-size-2xl)` | 22px |
| `1.5rem` | `var(--font-size-3xl)` | 24px |

## 使用方法

### 预览模式（推荐先运行）

```bash
# 预览将要进行的更改，不修改文件
node scripts/convert-fontsize-to-vars.cjs --dry-run
```

### 实际应用

```bash
# 应用更改到文件
node scripts/convert-fontsize-to-vars.cjs
```

## 转换示例

**转换前：**
```vue
<style>
.title {
  font-size: 20px;
}

.subtitle {
  font-size: 16px;
}

.body-text {
  font-size: 14px;
}

.small-text {
  font-size: 12px;
}

.code {
  font-size: 13px;
}
</style>
```

**转换后：**
```vue
<style>
.title {
  font-size: var(--font-size-xl);
}

.subtitle {
  font-size: var(--font-size-md);
}

.body-text {
  
}

.small-text {
  font-size: var(--font-size-sm);
}

.code {
  font-size: var(--font-size-sm);
}
</style>
```

## 特殊说明

### 近似值映射

脚本会将接近标准尺寸的值映射到最接近的标准尺寸：

- `13px` → `var(--font-size-sm)` (12px)
- `15px` → `var(--font-size-base)` (14px)

这样做的目的是统一项目中的字体大小，减少碎片化。

### 保留特殊值

以下情况的字体大小会被保留（不会转换）：

1. **非标准尺寸**：如 `11px`、`17px`、`19px` 等
2. **计算值**：如 `calc(14px + 2px)`
3. **变量值**：已经使用 CSS 变量的值

## 支持的文件类型

- `.vue` - Vue 单文件组件
- `.scss` - Sass 样式文件
- `.css` - 纯 CSS 文件

## 跳过的文件

脚本会自动跳过以下文件：
- `variables.scss` - 变量定义文件
- `dark-theme.scss` - 主题文件

同时自动跳过以下目录：
- `node_modules`
- `.git`
- `dist`

## 输出报告

执行完成后会显示详细的统计报告：

```
📊 转换统计报告
============================================================
总文件数: 150
修改文件数: 38
总替换次数: 156

📋 替换详情:
  font-size: 14px => var(--font-size-base): 42 次
  font-size: 16px => var(--font-size-md): 35 次
  font-size: 12px => var(--font-size-sm): 28 次
  font-size: 13px => var(--font-size-sm): 18 次
  ...

⚠️  未映射的字体大小（需要手动检查）:
  11px
  17px
  ...

💡 建议：
   1. 检查这些值是否是特殊尺寸，需要保留
   2. 如果需要映射，可以将其添加到 FONT_SIZE_MAP 中
   3. 或考虑调整为最接近的标准尺寸
```

## 优势

使用 CSS 变量替代硬编码字体大小的好处：

1. **统一管理**：所有字体大小在 `variables.scss` 中统一定义
2. **响应式设计**：可以基于视口大小动态调整所有字体
3. **易于维护**：修改变量值即可全局更新字体大小
4. **语义化**：变量名更具可读性（如 `--font-size-base` vs `14px`）
5. **一致性**：确保整个项目使用统一的字体大小体系
6. **可访问性**：便于实现字体缩放功能

## 与其他脚本配合

该脚本可以与其他样式标准化脚本配合使用：

```bash
# 1. 转换间距值
node scripts/convert-spacing-to-vars.cjs

# 2. 转换圆角和阴影
node scripts/convert-to-standard-vars.js

# 3. 转换颜色值
node scripts/convert-colors-to-vars.cjs

# 4. 转换字体大小
node scripts/convert-fontsize-to-vars.cjs
```

## 注意事项

1. **备份建议**：运行脚本前建议先使用 `--dry-run` 参数预览更改
2. **Git 提交**：建议在运行前提交当前代码，方便回滚
3. **视觉检查**：转换后应检查页面显示，确保视觉效果符合预期
4. **响应式考虑**：某些特殊场景可能需要保留精确的像素值
5. **行内样式**：脚本仅处理 CSS 样式，不处理内联样式中的 font-size

## 扩展映射表

如果发现新的字体大小需要映射，编辑脚本中的 `FONT_SIZE_MAP` 对象：

```javascript
const FONT_SIZE_MAP = {
  // 添加新的映射
  '26px': 'var(--font-size-4xl)',
  // ...
};
```

同时需要在 `variables.scss` 中定义对应的变量。

## 回滚方法

如果需要回滚更改：

```bash
# 如果还未提交
git checkout -- src/

# 如果已提交
git revert <commit-hash>
```

## 实际案例

### 案例 1：CommandConsole.vue

**转换前：**
```scss
.prompt {
  font-size: 13px;
  font-weight: 500;
}
```

**转换后：**
```scss
.prompt {
  font-size: var(--font-size-sm);
  font-weight: 500;
}
```

### 案例 2：CommitForm.vue

**转换前：**
```scss
.commit-message-input {
  font-size: 15px;
  font-weight: 500;
}
```

**转换后：**
```scss
.commit-message-input {
  
  font-weight: 500;
}
```

## 最佳实践

1. **优先使用标准尺寸**：尽量使用预定义的 8 个标准尺寸
2. **语义化命名**：根据用途选择合适的变量名
3. **保持一致**：相同级别的元素使用相同的字体大小变量
4. **文档化**：在团队中明确各个字体大小变量的使用场景
