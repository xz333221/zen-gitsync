// Copyright 2026 xz333221
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
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