# CSS 样式变量标准化工具

## 功能说明

该脚本将项目中的 `border-radius` 和 `box-shadow` 值转换为标准的 CSS 变量引用。

## 转换规则

### border-radius 映射

| 原始值 | 转换后 | CSS变量定义 |
|--------|--------|-------------|
| 2px    | var(--radius-xs) | 2px |
| 3px    | var(--radius-sm) | 3px |
| 4px    | var(--radius-base) | 4px |
| 6px    | var(--radius-md) | 6px |
| 8px    | var(--radius-lg) | 8px |
| 12px   | var(--radius-xl) | 12px |

### box-shadow 映射

| 原始值 | 转换后 | 用途 |
|--------|--------|------|
| 0 1px 3px rgba(0, 0, 0, 0.04) | var(--shadow-sm) | 小阴影 |
| 0 1px 4px rgba(0, 0, 0, 0.04) | var(--shadow-base) | 基础阴影 |
| 0 2px 8px rgba(0, 0, 0, 0.08) | var(--shadow-md) | 中等阴影 |
| 0 4px 12px rgba(0, 0, 0, 0.08) | var(--shadow-lg) | 大阴影 |
| 0 8px 24px rgba(0, 0, 0, 0.12) | var(--shadow-xl) | 超大阴影 |

#### 模糊匹配规则

对于未精确匹配的 box-shadow 值，脚本会根据偏移量和模糊度智能选择：

- **小阴影** (--shadow-sm): offset ≤ 2px, blur ≤ 4px
- **中等阴影** (--shadow-md): offset 2-4px, blur 6-12px
- **大阴影** (--shadow-lg): offset 4-8px, blur 12-24px

## 使用方法

### 预览模式（推荐先运行）

```bash
# 预览将要进行的更改，不修改文件
node scripts/convert-to-standard-vars.js --dry-run
```

### 实际应用

```bash
# 应用更改到文件
node scripts/convert-to-standard-vars.js
```

## 转换示例

### border-radius 转换

**转换前：**
```css
.card {
  border-radius: 8px;
}

.button {
  border-radius: 6px;
}
```

**转换后：**
```css
.card {
  border-radius: var(--radius-lg);
}

.button {
  border-radius: var(--radius-md);
}
```

### box-shadow 转换

**转换前：**
```css
.card {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.modal {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}
```

**转换后：**
```css
.card {
  box-shadow: var(--shadow-md);
}

.modal {
  box-shadow: var(--shadow-lg);
}
```

## 支持的文件类型

- `.vue` - Vue 单文件组件
- `.scss` - Sass 样式文件
- `.css` - 纯 CSS 文件

## 扫描范围

脚本会扫描 `src` 目录下的所有目标文件，自动跳过：
- `node_modules` 目录
- `.git` 目录
- `dist` 目录

## 输出报告

执行完成后会显示详细的统计报告：

```
📊 转换统计报告
============================================================
总文件数: 150
修改文件数: 38
border-radius 替换次数: 67
box-shadow 替换次数: 42

📋 border-radius 替换详情:
  8px => var(--radius-lg): 28 次
  6px => var(--radius-md): 19 次
  4px => var(--radius-base): 12 次
  ...

📋 box-shadow 替换详情:
  0 2px 8px rgba(0, 0, 0, 0.08) => var(--shadow-md): 23 次
  0 4px 12px rgba(0, 0, 0, 0.08) => var(--shadow-lg): 15 次
  ...
```

## 注意事项

1. **备份建议**：运行脚本前建议先使用 `--dry-run` 参数预览更改
2. **Git 提交**：建议在运行前提交当前代码，方便回滚
3. **检查结果**：转换完成后请检查 Git diff，确认转换符合预期
4. **测试验证**：转换后请运行项目测试，确保样式显示正常

## 优势

使用 CSS 变量的好处：

1. **统一管理**：所有样式值在 `variables.scss` 中统一定义
2. **易于维护**：修改变量值即可全局更新
3. **主题支持**：方便实现深色主题等样式变体
4. **语义化**：变量名更具可读性
5. **一致性**：确保整个项目使用统一的设计规范

## 回滚方法

如果需要回滚更改：

```bash
# 如果还未提交
git checkout -- src/

# 如果已提交
git revert <commit-hash>
```

## 组合使用

该脚本可以与间距转换脚本配合使用，实现完整的样式标准化：

```bash
# 1. 转换间距值
node scripts/convert-spacing-to-vars.js

# 2. 转换圆角和阴影
node scripts/convert-to-standard-vars.js
```
