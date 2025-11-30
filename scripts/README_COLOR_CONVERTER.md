# 颜色值转换工具使用说明

## 功能说明

该脚本将项目中硬编码的十六进制颜色值转换为标准的 CSS 变量引用。

## 颜色映射规则

基于项目中的 `src/ui/client/src/styles/variables.scss` 定义：

### 主色调
- `#409eff` → `var(--color-primary)`
- `#5a67d8`, `#66b1ff` → `var(--color-primary-light)`
- `#337ecc` → `var(--color-primary-dark)`

### 成功色
- `#67c23a` → `var(--color-success)`
- `#10b981` → `var(--color-success-light)`

### 警告色
- `#e6a23c` → `var(--color-warning)`
- `#f59e0b` → `var(--color-warning-light)`

### 危险色
- `#f56c6c` → `var(--color-danger)`
- `#ef4444` → `var(--color-danger-light)`
- `#dc2626` → `var(--color-danger-dark)`

### 信息色
- `#909399` → `var(--color-info)`
- `#8b5cf6` → `var(--color-info-light)`

### 文字颜色
- `#303133` → `var(--text-primary)`
- `#606266` → `var(--text-secondary)`
- `#909399` → `var(--text-tertiary)`
- `#c0c4cc`, `#a8abb2` → `var(--text-placeholder)`

### Git 状态颜色
- `#10b981` → `var(--git-status-added)`
- `#f59e0b` → `var(--git-status-modified)`
- `#ef4444` → `var(--git-status-deleted)`
- `#8b5cf6` → `var(--git-status-untracked)`

## 使用方法

### 预览模式（推荐先运行）

```bash
# 预览将要进行的更改，不修改文件
node scripts/convert-colors-to-vars.cjs --dry-run
```

### 实际应用

```bash
# 应用更改到文件
node scripts/convert-colors-to-vars.cjs
```

## 转换示例

**转换前：**
```vue
<style>
.button {
  background: #409eff;
  color: #ffffff;
  border: 1px solid #66b1ff;
}

.success-button {
  background: #67c23a;
}

.text {
  color: #303133;
}
</style>
```

**转换后：**
```vue
<style>
.button {
  background: var(--color-primary);
  color: var(--color-white);
  border: 1px solid var(--color-primary-light);
}

.success-button {
  background: var(--color-success);
}

.text {
  color: var(--text-primary);
}
</style>
```

## 支持的文件类型

- `.vue` - Vue 单文件组件
- `.scss` - Sass 样式文件
- `.css` - 纯 CSS 文件

## 跳过的文件

脚本会自动跳过以下文件（这些文件定义了变量本身）：
- `variables.scss`
- `dark-theme.scss`

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
修改文件数: 42
总替换次数: 289

📋 替换详情:
  #409eff => var(--color-primary): 78 次
  #67c23a => var(--color-success): 45 次
  #f56c6c => var(--color-danger): 32 次
  ...

⚠️  未映射的颜色（需要手动检查）:
  #f8faff
  #eef4ff
  ...
```

## 注意事项

1. **备份建议**：运行脚本前建议先使用 `--dry-run` 参数预览更改
2. **Git 提交**：建议在运行前提交当前代码，方便回滚
3. **未映射颜色**：脚本会列出未映射的颜色，需要手动检查这些颜色是否需要添加到映射表
4. **特殊颜色**：某些渐变色或特殊效果的颜色可能需要保留原值
5. **rgba 颜色**：当前脚本仅处理十六进制颜色值，rgba 格式需要手动处理

## 优势

使用 CSS 变量替代硬编码颜色的好处：

1. **统一管理**：所有颜色在 `variables.scss` 中统一定义
2. **主题切换**：轻松实现深色主题等样式变体
3. **易于维护**：修改变量值即可全局更新
4. **语义化**：变量名更具可读性（如 `--color-success` vs `#67c23a`）
5. **一致性**：确保整个项目使用统一的配色方案

## 扩展映射表

如果发现新的颜色值需要映射，编辑脚本中的 `COLOR_MAP` 对象：

```javascript
const COLOR_MAP = {
  // 添加新的映射
  '#your-color': 'var(--your-variable)',
  // ...
};
```

## 回滚方法

如果需要回滚更改：

```bash
# 如果还未提交
git checkout -- src/

# 如果已提交
git revert <commit-hash>
```

## 与其他脚本配合

该脚本可以与其他样式标准化脚本配合使用：

```bash
# 1. 转换间距值
node scripts/convert-spacing-to-vars.cjs

# 2. 转换圆角和阴影
node scripts/convert-to-standard-vars.js

# 3. 转换颜色值
node scripts/convert-colors-to-vars.cjs
```
