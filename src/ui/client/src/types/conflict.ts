// 冲突块类型定义
export interface ConflictBlock {
  id: number; // 块的唯一标识
  startLine: number; // 起始行号（用于定位）
  currentLines: string[]; // 当前版本的行
  incomingLines: string[]; // 传入版本的行
  beforeLines: string[]; // 冲突前的上下文行
  afterLines: string[]; // 冲突后的上下文行
  currentLabel: string; // 当前版本标签（例如：HEAD）
  incomingLabel: string; // 传入版本标签（例如：branch-name）
}