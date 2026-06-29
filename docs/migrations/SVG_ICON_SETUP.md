# SVG Icon 组件配置说明

## ✅ 已完成的配置

### 1. Vite 插件配置
- ✅ 创建 `vite-plugins/svg-icon.ts`
- ✅ 在 `vite.config.ts` 中引入并配置插件
- ✅ 添加 TypeScript 类型声明 `vite-env.d.ts`

### 2. 组件注册
- ✅ 复制 `SvgIcon` 组件到 `src/components/SvgIcon/`
- ✅ 在 `main.ts` 中全局注册组件

### 3. 图标文件
- ✅ 创建 SVG 存放目录：`src/assets/icons/svg/`
- ✅ 移动 `pin.svg` 到该目录

### 4. 组件使用
- ✅ 更新 `TemplateManager.vue` 使用 `<svg-icon>` 组件
- ✅ 更新 `NpmSettingsDialog.vue` 使用 `<svg-icon>` 组件

## 🔧 需要手动操作

### 安装依赖
在项目根目录运行：
```bash
cd src/ui/client
npm install vite-plugin-svg-icons --save-dev
```

### 确认 pin.svg 文件位置
确保 `pin.svg` 文件在以下位置：
```
src/ui/client/src/assets/icons/svg/pin.svg
```

如果不在，请手动移动文件：
```bash
move src\assets\svg\pin.svg src\assets\icons\svg\pin.svg
```

### 重启开发服务器
安装依赖后，重启 Vite 开发服务器：
```bash
npm run dev
```

## 📖 使用方法

### 添加新图标
1. 将 SVG 文件放入 `src/assets/icons/svg/` 目录
2. 文件名即为图标名，例如 `pin.svg`

### 在组件中使用
```vue
<template>
  <svg-icon icon-class="pin" class-name="custom-class" />
</template>
```

参数说明：
- `icon-class`: SVG 文件名（不含 .svg 扩展名）
- `class-name`: 自定义 CSS 类名（可选）

### 样式控制
SVG 图标使用 `fill: currentColor`，会自动继承父元素的 `color` 属性：

```css
.pin-button {
  color: #909399;
}

.pin-button:hover {
  color: #409eff;
}
```

## 🎨 优势

1. **颜色可控**：通过 CSS `color` 属性控制图标颜色
2. **性能优化**：所有 SVG 合并为 sprite，减少 HTTP 请求
3. **按需加载**：只打包使用到的 SVG 文件
4. **易于使用**：只需传入文件名即可使用图标

## 🔍 故障排查

### TypeScript 报错
如果仍然提示找不到 `virtual:svg-icons-register`，尝试：
1. 重启 VSCode/IDE
2. 删除 `node_modules` 重新安装
3. 检查 `vite-env.d.ts` 类型声明是否正确

### 图标不显示
1. 确认 SVG 文件在正确的目录
2. 确认 `icon-class` 与文件名匹配
3. 检查浏览器控制台是否有错误
4. 查看 HTML 中是否有 `__svg__icons__dom__` 元素注入
