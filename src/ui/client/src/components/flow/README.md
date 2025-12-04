# 可视化编排工作台

基于 vue-flow 的可视化流程编排系统，支持拖拽式创建执行流程。

## 功能特性

### 🎯 核心功能
- ✅ **可视化流程设计** - 通过拖拽和连接节点创建执行流程
- ✅ **多种节点类型** - 命令节点、等待节点、版本管理节点
- ✅ **节点配置** - 每个节点都有独立的配置面板
- ✅ **流程保存** - 保存流程图结构和配置，便于后续编辑
- ✅ **流程执行** - 自动进行拓扑排序，按正确顺序执行节点
- ✅ **节点引用** - 支持节点间的数据流和依赖关系

### 📦 节点类型

#### 1. 开始节点 (Start Node)
- 每个流程的起点
- 不可删除
- 圆形设计，紫色渐变

#### 2. 命令节点 (Command Node)
- 执行自定义命令
- 配置项：
  - 选择已创建的自定义命令
  - 执行方式（普通执行/终端执行）
  - 启用/禁用状态
- 蓝色边框

#### 3. 等待节点 (Wait Node)
- 暂停执行指定时间
- 配置项：
  - 等待秒数（1-3600秒）
  - 启用/禁用状态
- 橙色边框

#### 4. 版本管理节点 (Version Node)
- 修改 package.json 版本号或依赖
- 配置项：
  - package.json 文件路径
  - 修改目标（version字段 / 依赖包）
  - 版本递增类型（patch/minor/major）
  - 依赖包配置（名称、版本、类型）
  - 启用/禁用状态
- 绿色边框

## 组件结构

```
flow/
├── FlowOrchestrationWorkspace.vue  # 主工作台组件
├── NodeConfigPanel.vue             # 节点配置面板
├── nodes/                          # 节点组件目录
│   ├── StartNode.vue              # 开始节点
│   ├── CommandNode.vue            # 命令节点
│   ├── WaitNode.vue               # 等待节点
│   └── VersionNode.vue            # 版本管理节点
└── README.md                       # 本文档
```

## 使用方法

### 基础使用

```vue
<template>
  <div>
    <el-button @click="showWorkspace = true">
      打开可视化编排工作台
    </el-button>
    
    <FlowOrchestrationWorkspace
      v-model:visible="showWorkspace"
      @execute-orchestration="handleExecute"
    />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import FlowOrchestrationWorkspace from '@components/flow/FlowOrchestrationWorkspace.vue'
import type { OrchestrationStep } from '@stores/configStore'

const showWorkspace = ref(false)

function handleExecute(steps: OrchestrationStep[]) {
  console.log('执行流程:', steps)
  // 处理流程执行逻辑
}
</script>
```

### 创建流程

1. **打开工作台** - 点击"新建编排"按钮
2. **添加节点** - 从右侧工具箱点击节点类型添加到画布
3. **配置节点** - 点击节点打开配置面板，设置节点参数
4. **连接节点** - 拖拽节点的连接点创建节点间的连接
5. **保存流程** - 输入名称和描述，点击保存按钮

### 编辑流程

1. 从左侧列表选择已保存的编排
2. 流程图会自动加载到画布
3. 可以添加、删除、重新配置节点
4. 修改完成后保存更新

### 执行流程

- **执行整个流程** - 点击顶部的执行按钮
- **执行已保存流程** - 从左侧列表点击编排的执行按钮

## 数据流说明

### 流程数据结构

```typescript
interface FlowNode {
  id: string                          // 节点唯一ID
  type: 'start' | 'command' | 'wait' | 'version'
  position: { x: number; y: number }  // 画布位置
  data: {
    id: string
    type: string
    label: string                     // 显示标签
    config?: OrchestrationStep        // 节点配置
    enabled?: boolean                 // 启用状态
    outputs?: Record<string, any>     // 输出数据（预留）
  }
}

interface FlowEdge {
  id: string          // 边唯一ID
  source: string      // 源节点ID
  target: string      // 目标节点ID
}
```

### 拓扑排序

保存时，系统会自动将流程图转换为线性执行步骤：
- 使用深度优先搜索（DFS）进行拓扑排序
- 检测并提示循环依赖
- 按依赖关系确定执行顺序

## 高级功能

### 节点间引用（预留）

`outputs` 字段预留用于节点间数据传递：

```typescript
// 命令节点可以输出执行结果
{
  outputs: {
    stdout: "命令输出内容",
    exitCode: 0
  }
}

// 后续节点可以引用前置节点的输出
{
  config: {
    command: "echo ${node-123.outputs.stdout}"
  }
}
```

### 条件分支（未来规划）

可以添加条件节点，根据前置节点的输出结果选择执行路径。

## 样式定制

所有节点都支持通过 CSS 变量自定义样式：

```scss
:root {
  --color-primary: #409eff;
  --color-success: #67c23a;
  --color-warning: #e6a23c;
  --color-danger: #f56c6c;
}
```

## 注意事项

1. **TypeScript 警告** - 当前可能存在一些 TS 模块解析警告，这是 IDE 配置问题，不影响运行
2. **依赖安装** - 确保已安装 `@vue-flow/core`、`@vue-flow/background`、`@vue-flow/controls`、`@vue-flow/minimap`
3. **流程验证** - 保存前会检查是否有循环依赖
4. **节点配置** - 每个节点必须配置完整才能正常执行

## API 文档

### Props

| 属性名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| visible | boolean | 是 | 控制工作台显示/隐藏 |

### Events

| 事件名 | 参数 | 说明 |
|--------|------|------|
| update:visible | (value: boolean) | 工作台显示状态变化 |
| execute-orchestration | (steps: OrchestrationStep[], startIndex?: number) | 执行流程时触发 |

## 开发计划

- [x] 基础流程图编辑
- [x] 节点配置面板
- [x] 流程保存和加载
- [x] 拓扑排序执行
- [ ] 节点间数据引用
- [ ] 条件分支节点
- [ ] 循环节点
- [ ] 子流程节点
- [ ] 流程模板市场

## 技术栈

- Vue 3.5+
- TypeScript
- @vue-flow/core
- Element Plus
- Pinia (状态管理)
