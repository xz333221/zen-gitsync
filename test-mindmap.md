# Zen GitSync 编辑器导图验证

整篇 markdown 都会被解析成一张大导图,正文每段也作为子节点。

## 第一阶段

调研与设计阶段,下面是子任务列表:

- 调研现有方案
- 输出对比文档
- 确认技术选型

调研中常用代码示例:

```ts
import { markdownToRichMindMap } from 'flow-mindmap'
const tree = markdownToRichMindMap(md)
```

## 第二阶段

实现阶段,涉及多种内容,比如表格:

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| 标题 | heading | 自动成为父节点 |
| 段落 | paragraph | 自动成为子节点 |
| 列表 | list | 每项一个子节点 |
| 代码 | code | 单子节点保留原文 |

也支持嵌套层级:

### 二级子节点

下面是嵌套段落实例,验证深层次级:

外层段落说明。

#### 三级子节点

更深的层级也照样展开。
