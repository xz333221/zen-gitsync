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
// 「图片 → 文字」预处理：派发前先用**我们自己的**多模态通路把截图描述成文本，
// 再把这段描述拼进 prompt。
//
// ── 为什么需要它 ──────────────────────────────────────────────────────────
//
// 附件是"列路径 + 让 Agent 自己去读"，这条口径对能读图的执行器（Claude）是对的：
// 图片按原样进模型上下文，不丢信息。但 **codearts 执行器读不了图**（2026-10-26 实测）：
// 它的 `read` 工具明明返回了 data URL 附件，发给模型的请求体里却一个 image_url 都没有 ——
// 原因是它把"哪些模型算多模态"写死在一份 `multimodalModels` 白名单里，默认只有两个
// Qwen-VL，`deepseek-v4.1-flash` 不在其中，于是图片被替换成一行
// `ERROR: Cannot read image (this model does not support image input)`。
// 它的另一条通道 `analyzeImage` 又要 PromptCenter 的 base url（只有 IDE/企业版才下发）。
//
// 与其等它，不如在派发这一步就把图"看"掉：用我们配置里的模型（`config.json` 的
// models[]，与提交信息 / 目录解读同一口径）生成一段描述，执行器拿到的是文字 ——
// 换谁跑都能用。
//
// ── 设计取舍 ──────────────────────────────────────────────────────────────
//
//   · **失败绝不阻断**：描述不出来就退回"只有路径"的老形态（执行器若自己会读图，
//     照样读得到）。预处理是锦上添花，不能把派发卡死。
//   · **只描述图片**：PDF 已有全文提取（pdfText.js），其他附件没有可靠的"转文字"通路。
//   · **单张大小上限**：附件上限是 20MB，把它 base64 塞进一次 LLM 请求既慢又容易
//     被网关拒；超过上限的跳过并说明原因，让执行器自己想办法。
//   · **数量上限**：一次派发挂十几张截图是有的，逐张串行调用会把"点派发到真的开始跑"
//     拖到几分钟。超过上限的仍列路径，只是没有描述。

import fs from 'node:fs';
import path from 'node:path';
import { logger, readJson, CONFIG_FILE } from './shared.js';
import { isImageExt } from './attachmentUtils.js';
import { callLlmStream } from './llmClient.js';
import { buildModelFallbackChain, modelLabel, runWithModelFallback } from '../../../../utils/aiModelFallback.js';

/** 单张图片大小上限：超过就不送去描述（base64 之后还要再涨 1/3） */
export const MAX_DESCRIBE_IMAGE_BYTES = 6 * 1024 * 1024;

/** 一次派发最多描述几张图 */
export const MAX_DESCRIBE_IMAGES = 4;

/** 单张图片的描述字数上限（prompt 里还要放任务正文，别让描述把上下文吃满） */
export const MAX_DESCRIBE_CHARS = 1200;

/** 单张图片的调用超时 */
export const DESCRIBE_TIMEOUT_MS = 45_000;

const SYSTEM_PROMPT = [
  '你是一个把图片转成文字的助手。用户会给你一张截图（可能是软件界面、报错、设计稿、图表）。',
  '请用中文客观描述，只写你在图里真的看到的东西：',
  '1. 这是什么界面/画面，整体布局；',
  '2. 图上所有可见的关键文字（标题、按钮、菜单、报错原文、数值）——逐字抄，不要改写、不要补全；',
  '3. 明显的状态（红框、选中态、报错图标、进度、缺失/空白区域）；',
  '4. 如果图里有用户高亮/圈出的位置，优先描述那一块。',
  `不要猜测看不到的内容，不要评价好坏，不要写"可能"之类的推测。总长度不超过 ${MAX_DESCRIBE_CHARS} 字，用短句和列表。`,
].join('\n');

/**
 * 解析"用哪个模型来描述图片"：`config.json` 里 models[] 的默认项（isDefault 优先，
 * 否则第一个）—— 与提交信息生成 / 目录解读 / 落点判断同一口径，不另立第二份。
 *
 * @returns {Promise<object|null>} 形如 { model, apiKey, baseURL, ... }；没配就 null
 */
export async function resolveDescribeModel() {
  try {
    const raw = await readJson(CONFIG_FILE, {});
    const models = Array.isArray(raw?.models) ? raw.models : [];
    return models.find(m => m && m.isDefault) || models[0] || null;
  } catch (err) {
    logger.warn('[imageDescribe] 读取 AI 配置失败，跳过图片转文字:', err?.message || err);
    return null;
  }
}

/**
 * 图片描述用的候选模型链：默认模型打头，其余已配置模型兜底（默认模型没额度时
 * 还能用别的模型把图转成文字）。
 *
 * @returns {Promise<Array<object>>}
 */
export async function resolveDescribeModelChain() {
  try {
    const raw = await readJson(CONFIG_FILE, {});
    return buildModelFallbackChain(Array.isArray(raw?.models) ? raw.models : []);
  } catch (err) {
    logger.warn('[imageDescribe] 读取 AI 配置失败，跳过图片转文字:', err?.message || err);
    return [];
  }
}

/** 附件里的图片（按 isImageExt 判，与附件白名单同一份口径） */
export function pickImageAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments.filter(a => a && a.absolutePath && isImageExt(a.ext));
}

/**
 * 描述一张图片。
 *
 * @param {string} filePath 本机绝对路径
 * @param {object|object[]} model config.json 里的模型条目（数组 = 候选链，前一个失败换下一个）
 * @param {object} [opts]
 * @param {string} [opts.fileName] 给模型的文件名提示（不含目录，别泄漏本地路径）
 * @returns {Promise<string|null>} 描述文本；失败/超限/空回答一律 null
 */
export async function describeImage(filePath, model, opts = {}) {
  if (!model || !filePath) return null;
  let buf;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_DESCRIBE_IMAGE_BYTES) {
      logger.info(`[imageDescribe] 跳过超大图片 ${path.basename(filePath)} (${stat.size} bytes)`);
      return null;
    }
    buf = fs.readFileSync(filePath);
  } catch (err) {
    logger.warn('[imageDescribe] 读取图片失败:', err?.message || err);
    return null;
  }

  const ext = String(path.extname(filePath) || '').replace(/^\./, '').toLowerCase() || 'png';
  const dataUrl = `data:${ext === 'jpg' ? 'image/jpeg' : `image/${ext}`};base64,${buf.toString('base64')}`;
  const name = opts.fileName || path.basename(filePath);

  let text = '';
  try {
    const chain = Array.isArray(model) ? model : [model];
    // 已经吐过文字就不能换模型（会把两段描述拼在一起）；一张图重试几次都失败就
    // 由外层 anyFailed 熔断，不继续烧额度
    const { result: streamResult } = await runWithModelFallback(
      chain,
      (candidate) => {
        text = '';
        return callLlmStream(
          candidate,
          `这张图片的文件名是 ${name}，请按系统提示把它转成文字描述。`,
          (delta) => { if (delta?.content) text += delta.content; },
          {
            images: [dataUrl],
            systemPrompt: SYSTEM_PROMPT,
            maxTokens: MAX_DESCRIBE_CHARS * 2,
            timeoutMs: DESCRIBE_TIMEOUT_MS,
          },
        );
      },
      {
        isFatal: () => text.length > 0,
        onFallback: ({ from, to, error }) => logger.warn(
          `[imageDescribe] 模型 ${modelLabel(from)} 描述图片失败(${error?.message || error}),改用 ${modelLabel(to)}`
        ),
      }
    );
    if (streamResult?.aborted) return null;
    const out = String(streamResult?.content || text || '').trim();
    if (!out) return null;
    return out.length > MAX_DESCRIBE_CHARS
      ? out.slice(0, MAX_DESCRIBE_CHARS) + '…'
      : out;
  } catch (err) {
    // 模型不支持图片 / 网关拒收 / 超时都会走到这里：记一行日志，退回"只给路径"
    logger.warn(`[imageDescribe] 描述图片失败 ${name}:`, err?.message || err);
    return null;
  }
}

/**
 * 批量描述：给 buildAttachmentBlock 用的构造函数。
 *
 * 返回的 describer 每次调用返回 `{ text }` 或 null —— 不抛错（见文件头的"失败绝不阻断"）。
 * 模型只解析一次；一张图都没描述成功时后续图片直接跳过，不重复烧额度。
 *
 * @param {object} [opts]
 * @param {object} [opts.model] 不给就自己从 config.json 解析
 * @param {number} [opts.maxImages]
 * @param {(filePath: string, model: object, extra?: object) => Promise<string|null>} [opts.describe]
 *        单张描述的实现（默认 describeImage）。只在单测里替换，生产不传 ——
 *        否则一次"验熔断/去重"的测试就得真连一次网关。
 * @returns {Promise<(att: object) => Promise<string|null>>}
 */
export async function createImageDescriber(opts = {}) {
  const maxImages = Number.isFinite(opts.maxImages) ? opts.maxImages : MAX_DESCRIBE_IMAGES;
  const chain = opts.model
    ? (Array.isArray(opts.model) ? opts.model : [opts.model])
    : await resolveDescribeModelChain();
  const runDescribe = typeof opts.describe === 'function' ? opts.describe : describeImage;
  const cache = new Map();
  let done = 0;
  let anyFailed = false;

  return async function describe(att) {
    const filePath = att && att.absolutePath;
    if (!filePath || chain.length === 0) return null;
    if (cache.has(filePath)) return cache.get(filePath);
    if (done >= maxImages || anyFailed) return null;
    done++;
    const text = await runDescribe(filePath, chain.length === 1 ? chain[0] : chain, {
      fileName: att.originalName || '',
    });
    if (!text) anyFailed = true;
    cache.set(filePath, text);
    return text;
  };
}

export default { describeImage, createImageDescriber, resolveDescribeModel, resolveDescribeModelChain, pickImageAttachments };
