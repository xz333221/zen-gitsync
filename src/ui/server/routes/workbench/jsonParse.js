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
// 从 LLM 输出里抠 JSON 的两个纯函数。
//
// 模型经常把 JSON 包在 思考块、代码块或总结：{...}这类散文里，直接 JSON.parse 必崩。
// 这里提供两级：
//   ① stripThinkingBlocks —— 先剥掉 思考块 与代码块围栏
//   ② extractFirstJsonObject —— 在剩下的文本里定位第一个「平衡花括号对象」
// 上层的 llmClient 用它俩抠 JSON；抠不出来时由调用方决定怎么降级。
// 剥离 LLM 输出的 思考块、```json``` 代码块围栏，以及首尾说明文字。
// 原贪婪正则 /({[\s\S]*})/ 会把 思考块（内含未配对花括号或字符串）一起吞进 JSON.parse，
// 在 DeepSeek 等会输出 推理链的模型上偶发 "Unterminated string in JSON"。
export function stripThinkingBlocks(content) {
  let s = String(content || '');
  // 1) 显式 思考块（成对标签）
  s = s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  // 2) 某些 provider 流式结尾会留下裸 <think>...</think> 之外的残段（无结束标签时被截断）
  s = s.replace(/<think(?:ing)?>[\s\S]*$/gi, '');
  // 3) ```json ... ``` 代码块围栏（保留内部 JSON）
  s = s.replace(/```json\s*/gi, '').replace(/```/g, '');
  return s;
}

// 在剥离 思考块 的文本里定位第一个「平衡花括号对象」的起点/终点。
// 跳过字符串内的 {/}（含转义）以及 Jinja {{ }} 模板占位符；
// 同时只在「JSON 特征显著」的 { 处起算 —— 即该 { 之后不远处出现 " 字符串。
// 这能避免把 LLM 思考文本里的裸 { ... }（如 "see { views, stores }"）误当 JSON 起点。
export function extractFirstJsonObject(content) {
  const s = String(content || '');
  let depth = 0;
  let inStr = false;
  let escape = false;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    // 跳过 Jinja {{ }} 占位符（提示词模板常用，勿当 JSON）
    if (ch === '{' && s[i + 1] === '{') { i++; continue; }
    if (ch === '}' && s[i - 1] === '}') { continue; }
    if (ch === '{') {
      if (depth === 0) {
        // 启发式判断「这看起来像 JSON 起点」：
        // 1. { 之前紧邻「真正的语义字符」(字母/数字/中文/下划线) → 不是 JSON 起点（散文里的花括号）
        //    但接受 . , ; : 等句末标点（LLM 经常以「总结：{...}」直接开头 JSON）
        // 2. { 之后跳过空白第一个字符必须是 " 或 }（空对象）
        const before = i > 0 ? s[i - 1] : '';
        if (/[A-Za-z0-9_一-龥]/.test(before)) continue;
        let j = i + 1;
        while (j < s.length && /\s/.test(s[j])) j++;
        const firstNonWs = s[j];
        if (firstNonWs !== '"' && firstNonWs !== '}') continue;
        start = i;
      }
      depth++;
    } else if (ch === '}') {
      if (depth > 0) depth--;
      if (depth === 0 && start !== -1) {
        return s.slice(start, i + 1);
      }
    }
  }
  // 兜底：找不到平衡对象时返回原文（让上层 JSON.parse 报清晰错误）
  return s;
}
