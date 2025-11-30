# 间距值转换工具使用说明

## 功能说明

该脚本将项目中 `padding`、`margin`、`gap` 属性中的 px 值转换为标准的 CSS 变量引用。

## 标准间距映射规则

根据项目中的 CSS 变量定义（`src/ui/client/src/styles/variables.scss`）：

| 原始值 | 转换后 | CSS变量定义 |
|--------|--------|-------------|
| 2px    | var(--spacing-xs) | 2px |
| 4px    | var(--spacing-sm) | 4px |
| 8px    | var(--spacing-base) | 8px |
| 12px   | var(--spacing-md) | 12px |
| 16px   | var(--spacing-lg) | 16px |
| 20px   | var(--spacing-xl) | 20px |
| 24px   | var(--spacing-2xl) | 24px |
| 32px   | var(--spacing-3xl) | 32px |

### 保留的特殊值

以下值不会被转换，保持原样：
- **1px** - 通常用于边框
- **3px, 5px** - 特殊设计值
- **6px, 10px** - 常用于紧凑布局
- **18px** - 通常与字体相关
- **40px 及其他** - 特殊大间距值

## 使用方法

### 基本用法

```bash
# 在项目根目录执行
node scripts/convert-spacing-to-vars.js
```

### 转换示例

**转换前：**
```css
.example {
  padding: 12px 16px;
  margin: 8px;
  gap: 16px;
}
```

**转换后：**
```css
.example {
  padding: var(--spacing-md) var(--spacing-lg);
  margin: var(--spacing-base);
  gap: var(--spacing-lg);
}
```

**保留特殊值示例：**
```css
.example {
  padding: 6px var(--spacing-md);  /* 6px 保持不变 */
  margin: 1px;                      /* 1px 保持不变（边框用途）*/
  gap: var(--spacing-base);        /* 8px 被转换 */
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

执行完成后会显示统计报告：

```
📊 转换统计报告
============================================================
总文件数: 150
修改文件数: 45
总替换次数: 234

📋 替换详情:
  12px => var(--spacing-md): 89 次
  16px => var(--spacing-lg): 67 次
  8px => var(--spacing-base): 45 次
  ...
```

## 注意事项

1. **备份建议**：运行脚本前建议先提交或备份当前代码
2. **检查结果**：转换完成后请检查 Git diff，确认转换符合预期
3. **测试验证**：转换后请运行项目测试，确保样式显示正常
4. **混合值处理**：脚本能正确处理混合值，如 `padding: 6px var(--spacing-md)`

## 优势

使用 CSS 变量的好处：

1. **统一管理**：所有间距在 `variables.scss` 中统一定义
2. **易于维护**：修改变量值即可全局更新
3. **主题支持**：方便实现深色主题等样式变体
4. **语义化**：变量名更具可读性（如 `--spacing-md` vs `12px`）

## 回滚方法

如果需要回滚更改：

```bash
# 如果还未提交
git checkout -- src/

# 如果已提交
git revert <commit-hash>
```
