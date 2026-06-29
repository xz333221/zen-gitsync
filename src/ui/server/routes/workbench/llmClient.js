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
// OpenAI 兼容 LLM 客户端封装。
// 拆分自原 routes/workbench.js 454-635 行。
//
// 两个核心 API：
//   - callLlmJson(model, prompt, opts)         非流式，强制 json_object 返回
//   - callLlmStream(model, input, onDelta, opts)  SSE 流式，回调推送 thinking/content delta
// 配套：
//   - callLlmJsonWithRetry  自动重试一次
//   - cloneMsgContent       深拷贝消息 content（避免外部 mutation 污染请求）

import { stripThinkingBlocks, extractFirstJsonObject } from './jsonParse.js';

// 非流式调用 LLM，要求返回 JSON 对象。
// 失败时抛错；成功时返回已 parse 的对象。
//
// 图片支持：opts.images 是 data URL 数组（如 'data:image/png;base64,...'）。
// 非多模态模型遇到 image_url 会忽略图片块，相当于退化成纯文本，不会报错。
export async function callLlmJson(model, prompt, opts = {}) {
  const { timeoutMs = 60000, images = [] } = opts;
  const { default: fetch } = await import('node-fetch').catch(() => ({ default: globalThis.fetch }));
  const url = `${String(model.baseURL || '').replace(/\/$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (model.apiKey) headers['Authorization'] = `Bearer ${model.apiKey}`;

  let userContent;
  if (Array.isArray(images) && images.length > 0) {
    userContent = [
      { type: 'text', text: prompt },
      ...images.map(img => ({ type: 'image_url', image_url: { url: img } }))
    ];
  } else {
    userContent = prompt;
  }

  const body = JSON.stringify({
    model: model.model,
    messages: [{ role: 'user', content: userContent }],
    temperature: 0.4,
    response_format: { type: 'json_object' },
    stream: false,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data?.error?.message || `HTTP ${resp.status}`);
    const content = data?.choices?.[0]?.message?.content || '';
    if (!content.trim()) {
      throw new Error('LLM 返回内容为空');
    }
    try {
      const cleaned = stripThinkingBlocks(content);
      return JSON.parse(extractFirstJsonObject(cleaned));
    } catch (err) {
      const snippet = content.length > 500 ? content.slice(0, 500) + '…' : content;
      throw new Error(`LLM 返回非 JSON 或被截断：${err.message}；原始内容片段：${snippet}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// 自动重试一次的包装。重试间隔 800ms * (i+1)。
export async function callLlmJsonWithRetry(model, prompt, opts = {}, retries = 1) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await callLlmJson(model, prompt, opts);
    } catch (err) {
      lastErr = err;
      if (i < retries) {
        await new Promise(r => setTimeout(r, 800 * (i + 1)));
      }
    }
  }
  throw lastErr;
}

// 深拷贝 message content（字符串直接返回，数组浅拷贝每个 part）
export function cloneMsgContent(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(p => ({ ...p }));
  return c;
}

/**
 * 流式调用 OpenAI 兼容 LLM。每收到一个 chunk 调 onDelta 回调。
 * onDelta 接收 { thinking?: string, content?: string }，二选一。
 *   - reasoning_content / reasoning：部分模型（如 deepseek）放在 delta.reasoning_content
 *   - reasoning / reasoning_text：openai o1 风格
 *   - content：普通输出
 * 返回 { content: string, aborted: boolean }。
 *
 * input 支持两种形态(判别 union):
 *   - string: 旧模式，拼成单条 user message，支持 opts.images 多模态
 *   - ChatMsg[]: 新模式(对话拆分)，直接作为 messages 发送；opts.images/systemPrompt 忽略
 *
 * 取消支持：opts.signal 是外部 AbortController.signal，触发后 controller.abort()，
 * 函数返回 { aborted: true }，不抛错——上层决定怎么处理。
 */
export async function callLlmStream(model, input, onDelta, opts = {}) {
  const { maxTokens = 2000, timeoutMs = 600000, signal, images = [], systemPrompt } = opts;
  const { default: fetch } = await import('node-fetch').catch(() => ({ default: globalThis.fetch }));
  const url = `${String(model.baseURL || '').replace(/\/$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (model.apiKey) headers['Authorization'] = `Bearer ${model.apiKey}`;

  // 判别 input: string(旧,直接拆分)或 messages 数组(新,对话拆分)
  let messages;
  if (Array.isArray(input)) {
    // messages 模式: 深拷贝避免外部 mutation 污染 LLM 请求
    messages = input.map(m => ({ role: m.role, content: cloneMsgContent(m.content) }));
  } else {
    // 旧模式: string prompt 拼成单条 user message,支持多模态
    const text = String(input || '');
    let userContent;
    if (Array.isArray(images) && images.length > 0) {
      userContent = [
        { type: 'text', text },
        ...images.map(img => ({ type: 'image_url', image_url: { url: img } }))
      ];
    } else {
      userContent = text;
    }
    messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: String(systemPrompt) });
    messages.push({ role: 'user', content: userContent });
  }

  const body = JSON.stringify({
    model: model.model,
    messages,
    max_tokens: maxTokens,
    temperature: 0.4,
    // 注意：stream: true 模式下不能同时使用 response_format:{type:'json_object'}，
    // 部分 provider 会在收到两个一起时报错/静默卡住。改在 prompt 里约束 JSON 输出即可。
    stream: true,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort);
  }

  let fullContent = '';
  let aborted = false;
  try {
    const resp = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => '');
      throw new Error(errText || `HTTP ${resp.status}`);
    }

    // SSE 格式：每行 "data: {...}"，最后 "data: [DONE]"
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    for await (const chunk of resp.body) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const evt = JSON.parse(payload);
          const delta = evt.choices?.[0]?.delta || {};
          // thinking 在不同 provider 字段名不同，全部尝试
          const thinkingChunk = delta.reasoning_content
            || delta.reasoning
            || delta.reasoning_text
            || '';
          const contentChunk = delta.content || '';
          if (thinkingChunk) onDelta({ thinking: thinkingChunk });
          if (contentChunk) {
            fullContent += contentChunk;
            onDelta({ content: contentChunk });
          }
        } catch { /* 跳过无法解析的行 */ }
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError' || controller.signal.aborted) {
      aborted = true;
      // 中断不算错误——上层会决定怎么处理
    } else {
      throw err;
    }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  return { content: fullContent, aborted };
}
