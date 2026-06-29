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
// AI 拆分子任务 JSON 多级降级解析。
// 拆分自原 routes/workbench.js 395-776 行。
//
// 模型经常会犯几类格式错：在 desc 里用 ASCII 双引号引用术语 / 末尾留尾随逗号 /
// 输出被 token 上限截断导致代码块未闭合。直接 JSON.parse 一旦失败就会让前端的
// "确认入库" 按钮永远是 (0)，用户看不到原因。这里按"越简单越优先"的顺序尝试：
//   ① ```json``` 代码块 / ```any``` 代码块 / 第一个完整 { ... } 范围
//   ② 把候选片段去掉尾随逗号 + 块/行注释 再 parse
//   ③ 用括号深度扫描，从开头找一个语法平衡的 { ... } 子串
//   ④ 启发式转义模型夹在字符串内部的未转义 ASCII 双引号
// 任一步成功就返回 parsed，全部失败时返回最后一次 JSON.parse 的错误，
// 用 parseStage 告知前端"模型输出哪一步崩了"，并把原始 raw 一并回传。

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

// 从字符串中提取首个语法平衡的 { ... } 子串。
// 跟踪字符串字面量（含转义），避免把 desc 里的 } 当成结束。
export function extractBalancedJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return '';
  let depth = 0;
  let inStr = false;
  let strCh = '';
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === strCh) { inStr = false; }
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return '';
}

// ④ 级降级：把字符串字面量内部出现的、未转义的 ASCII 双引号自动转义。
// 实战中模型最常见的错误是 "desc": "...用户点击"保存"按钮..." 这种—
// 中间的 "保存" 把外层字符串截断成两段，后面变成裸文本，JSON.parse 必崩。
//
// 启发式判断：扫描时若处于字符串中且遇到 "，往后看第一个非空白字符：
//   - 是 , } ] : 或文本结尾 → 这是真闭合，正常退出字符串
//   - 否则 → 是模型乱写的字面量引号，改写为 \" 并继续留在字符串里
// 不依赖正则、不破坏已经转义的 \"，对嵌套 / 多行字符串都安全。
export function reescapeUnescapedQuotes(text) {
  const s = String(text || '');
  if (!s) return '';
  const out = [];
  let inStr = false;
  let strCh = '';
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inStr) {
      out.push(c);
      if (c === '"' || c === "'") { inStr = true; strCh = c; }
      continue;
    }
    // 字符串内部
    if (esc) { out.push(c); esc = false; continue; }
    if (c === '\\') { out.push(c); esc = true; continue; }
    if (c !== strCh) { out.push(c); continue; }
    // 遇到与开闭引号相同的字符——往后看下一个非空白
    let j = i + 1;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
    const next = j < s.length ? s[j] : '';
    if (next === '' || next === ',' || next === '}' || next === ']'
        || next === ':' || next === '\n' || next === '\r') {
      // 真闭合
      out.push(c);
      inStr = false;
      strCh = '';
    } else {
      // 字面量裸引号——转义
      out.push('\\', c);
    }
  }
  return out.join('');
}

// AI 拆分子任务 JSON 多级降级解析主入口。
// 返回 { parsed, parseError, parseStage }：
//   - parsed: 解析成功时的对象，失败时为 null
//   - parseError: 失败时的错误信息
//   - parseStage: 'empty' / '' (成功) / 'cleaned' / 'balanced' / 'reescaped' / 'failed'
export function parseSubtaskJson(content) {
  let src = String(content || '');
  if (!src.trim()) {
    return { parsed: null, parseError: '模型未返回任何内容', parseStage: 'empty' };
  }

  // 预处理：剥离 deepseek-r1 / QwQ 等模型在 content 前输出的 <think>...</think> 思考块
  src = src.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think\s*\/>/gi, '').trim();

  const candidates = [];
  const fenced = src.match(/```json\s*([\s\S]*?)```/i) || src.match(/```\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]);
  // 平衡花括号扫描：避免贪婪正则把多段 JSON / 散落的 { } 全包进去
  const balancedFirst = extractBalancedJson(src);
  if (balancedFirst) candidates.push(balancedFirst);
  // 兜底：整段当 JSON 试
  candidates.push(src);

  let lastErr = null;
  for (const raw of candidates) {
    const txt = String(raw || '').trim();
    if (!txt) continue;
    // ① 直 parse
    try { return { parsed: JSON.parse(txt), parseError: '', parseStage: '' }; }
    catch (e) { lastErr = e; }
    // ② 清洗：去 //…/* */ 注释 + 尾随逗号
    const cleaned = txt
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:"'\\])\/\/[^\n]*/g, '$1')
      .replace(/,(\s*[}\]])/g, '$1');
    try { return { parsed: JSON.parse(cleaned), parseError: '', parseStage: 'cleaned' }; }
    catch (e) { lastErr = e; }
    // ③ 平衡花括号扫描
    const balanced = extractBalancedJson(cleaned);
    if (balanced && balanced !== cleaned) {
      try { return { parsed: JSON.parse(balanced), parseError: '', parseStage: 'balanced' }; }
      catch (e) { lastErr = e; }
    }
    // ④ 启发式转义字符串内的未转义双引号
    const base = balanced || cleaned;
    const reescaped = reescapeUnescapedQuotes(base);
    if (reescaped && reescaped !== base) {
      try { return { parsed: JSON.parse(reescaped), parseError: '', parseStage: 'reescaped' }; }
      catch (e) { lastErr = e; }
    }
  }

  return {
    parsed: null,
    parseError: lastErr ? (lastErr.message || String(lastErr)) : '未能从模型输出中提取出 JSON',
    parseStage: 'failed'
  };
}
