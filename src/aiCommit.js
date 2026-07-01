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
// CLI AI 提交信息生成器 — 独立模块,不依赖 GUI 服务器代码
// 逻辑与 GUI 的 /api/config/generate-commit-message 路由保持一致:
//   收集 diff → 压缩 diff → 构建 prompt → 调用 LLM → 解析 JSON → 返回 Conventional Commits 消息
import chalk from 'chalk';
import ora from 'ora';
import config from './config.js';
import { execGitCommand } from './utils/index.js';

// ──────────────────────────────────────────────
// 跳过的产物/资源/lock 文件(与 GUI config.js SKIP_FILE_PATTERNS 一致)
// ──────────────────────────────────────────────
const SKIP_FILE_PATTERNS = [
  /(^|[\\/])dist[\\/]/,
  /(^|[\\/])build[\\/]/,
  /(^|[\\/])\.next[\\/]/,
  /(^|[\\/])coverage[\\/]/,
  /(^|[\\/])node_modules[\\/]/,
  /\.lock$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /min\.js$/,
  /min\.css$/,
  /\.bundle\.js$/,
  /\.map$/,
  /\.(png|jpe?g|gif|webp|svg|ico|bmp|tiff)$/,
  /\.(mp4|mov|avi|mkv|webm)$/,
  /\.(mp3|wav|ogg|flac)$/,
  /\.(woff2?|ttf|otf|eot)$/,
  /\.(pdf|zip|tar|gz|7z|rar)$/
];

function isSkippedFile(filePath) {
  return SKIP_FILE_PATTERNS.some(re => re.test(filePath));
}

// 文件优先级:数字越大越重要(与 GUI 一致)
function filePriority(p) {
  if (/\.(test|spec)\.(js|ts|jsx|tsx|vue)$/i.test(p)) return 1;
  if (/^docs?\//i.test(p) || /\.md$/i.test(p)) return 2;
  if (/\.(json|ya?ml|toml|env|ini|cfg|conf)$/i.test(p)) return 3;
  if (/\.(css|scss|sass|less|html|vue|jsx|tsx)$/i.test(p)) return 4;
  if (/\.(ts|js|mjs|cjs)$/i.test(p)) return 5;
  return 3;
}

// 从 git diff 文本解析出 per-file 块(与 GUI parseDiffByFile 一致)
function parseDiffByFile(diffText) {
  if (!diffText) return [];
  const files = [];
  const parts = diffText.split(/^diff --git /m).filter(Boolean);
  for (const part of parts) {
    const headerEnd = part.indexOf('\n');
    const headerLine = (headerEnd >= 0 ? part.slice(0, headerEnd) : part).trim();
    const m = headerLine.match(/^a\/(.+?)\s+b\/(.+)$/);
    if (!m) continue;
    const bPath = m[2];
    const patch = part.slice(headerEnd + 1);
    let added = 0, removed = 0;
    for (const line of patch.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++;
      else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    files.push({ path: bPath, patch, added, removed });
  }
  return files;
}

// ──────────────────────────────────────────────
// 收集 AI 生成提交信息所需的 diff 和文件列表
// 关键: untracked 文件默认不会出现在 git diff 输出里,
//       所以先对所有 untracked 文件做 git add -N(intent to add),
//       这样它们会以 "new file" 形式出现在 diff 里
// ──────────────────────────────────────────────
async function collectDiff() {
  const opts = { log: false };

  // 1. 拿到工作区状态,识别 untracked 文件
  const { stdout: statusOut } = await execGitCommand(
    ['status', '--porcelain=1', '--untracked-files=all'], opts
  );
  const untracked = [];
  const fileList = [];
  for (const line of (statusOut || '').split('\n')) {
    if (!line || line.length < 3) continue;
    const x = line[0];
    const y = line[1];
    const filePath = line.slice(3);
    if (x === '?' && y === '?') {
      untracked.push(filePath);
      fileList.push(`? ${filePath}`);
    } else if (x !== ' ' || y !== ' ') {
      fileList.push(`${x !== ' ' ? x : ' '} ${filePath}`.trim());
    }
  }

  // 2. 对 untracked 文件做 intent to add(只在内存中,不会真的暂存内容)
  if (untracked.length > 0) {
    const batchSize = 20;
    for (let i = 0; i < untracked.length; i += batchSize) {
      const batch = untracked.slice(i, i + batchSize);
      try {
        await execGitCommand(['add', '-N', '--force', ...batch], opts);
      } catch (e) {
        // 单批失败不影响整体
      }
    }
  }

  // 3. 合并 staged + unstaged diff
  const [stagedRes, unstagedRes] = await Promise.all([
    execGitCommand(['diff', '--staged', '--no-color', '--no-ext-diff'], opts).catch(() => ({ stdout: '' })),
    execGitCommand(['diff', '--no-color', '--no-ext-diff'], opts).catch(() => ({ stdout: '' })),
  ]);
  let combined = '';
  if (stagedRes?.stdout) combined += stagedRes.stdout.trim() + '\n';
  if (unstagedRes?.stdout) combined += unstagedRes.stdout.trim() + '\n';

  return { diff: combined.trim(), fileList };
}

// 把 diff 压缩成给 LLM 的紧凑文本(与 GUI prepareDiffForPrompt 逻辑一致)
// 策略: 跳过产物/资源文件(用一行 stat 带过),源码按优先级排序,每个文件 patch 限 1500 字,总预算 6000 字
function prepareDiffForPrompt(diffText, fileList) {
  const safeFileList = Array.isArray(fileList) ? fileList : [];
  let files = parseDiffByFile(diffText);

  if (safeFileList.length > 0 && files.length > 0) {
    const selectedPaths = new Set(
      safeFileList
        .map(s => {
          if (typeof s !== 'string') return '';
          const m = s.match(/^[A-Z?\s]+\s+(.+)$/);
          return (m ? m[1] : s).replace(/\\/g, '/');
        })
        .filter(Boolean)
    );
    if (selectedPaths.size > 0) {
      files = files.filter(f => selectedPaths.has(f.path.replace(/\\/g, '/')));
    }
  }

  if (files.length === 0) {
    const list = safeFileList.slice(0, 30).map(s => {
      const m = s.match(/^[A-Z?\s]+\s+(.+)$/);
      return m ? m[1] : s;
    });
    if (list.length === 0) return '';
    return list.map(p => {
      if (isSkippedFile(p)) return `${p} [产物/资源，已跳过]`;
      return p;
    }).join('\n');
  }

  const skipped = [];
  const kept = [];
  for (const f of files) {
    if (isSkippedFile(f.path)) {
      skipped.push(f);
    } else {
      kept.push(f);
    }
  }

  kept.sort((a, b) => {
    const dp = filePriority(b.path) - filePriority(a.path);
    if (dp !== 0) return dp;
    return (b.added + b.removed) - (a.added + a.removed);
  });

  const TOTAL_BUDGET = 6000;
  const PER_FILE_LIMIT = 1500;
  const lines = [];
  let budget = TOTAL_BUDGET;

  for (const f of skipped) {
    if (budget < 80) break;
    lines.push(`${f.path} [+${f.added}/-${f.removed}, 已跳过产物/资源]`);
    budget -= 80;
  }

  for (const f of kept) {
    if (budget <= 50) break;
    let patch = f.patch;
    let truncated = false;
    if (patch.length > PER_FILE_LIMIT) {
      patch = patch.slice(0, PER_FILE_LIMIT) + '\n... (diff 已截断)';
      truncated = true;
    }
    const block = `--- ${f.path} (+${f.added}/-${f.removed})${truncated ? ' [截断]' : ''}\n${patch}`;
    if (block.length > budget) {
      const sliceLen = Math.max(0, budget - 80);
      if (sliceLen < 100) break;
      lines.push(`--- ${f.path} (+${f.added}/-${f.removed}) [预算耗尽，已截断]\n${patch.slice(0, sliceLen)}`);
      budget = 0;
      break;
    }
    lines.push(block);
    budget -= block.length;
  }

  return lines.length > 0 ? lines.join('\n\n') : '';
}

// ──────────────────────────────────────────────
// 主入口: 生成 AI 提交信息
// 返回 Conventional Commits 格式的字符串,如 "feat(auth): 添加登录按钮"
// ──────────────────────────────────────────────
export async function generateAiCommitMessage({ locale = 'zh-CN' } = {}) {
  // 1. 读取配置,获取默认模型
  const cfg = await config.loadConfig();
  const models = Array.isArray(cfg.models) ? cfg.models : [];
  const defaultModel = models.find(m => m.isDefault) || models[0];
  if (!defaultModel) {
    throw new Error('未配置 AI 模型，请先在 GUI 通用设置中添加模型（运行 g ui 打开设置）');
  }

  // 2. 收集 diff
  const spinner = ora('正在收集代码变更...').start();
  const { diff: rawDiff, fileList } = await collectDiff();
  const diffText = prepareDiffForPrompt(rawDiff, fileList);
  const filesText = fileList.slice(0, 30).join('\n');

  if (!diffText && fileList.length === 0) {
    spinner.fail('没有检测到代码变更');
    throw new Error('没有检测到代码变更');
  }

  spinner.succeed(`已收集 ${fileList.length} 个文件变更`);

  // 3. 构建 prompt(与 GUI 一致)
  const promptZh = `你是一个 Git 提交信息生成助手。根据以下 git diff 信息，生成一条符合 Conventional Commits 规范的提交信息。

要求：
1. type 只能是：feat/fix/docs/style/refactor/test/chore 之一
2. scope 可选，表示影响范围，简短英文或中文，如果改动范围明确就填
3. description 用中文简短描述本次变更（不超过50字）
4. 只返回 JSON，格式：{"type":"feat","scope":"","description":"xxx"}

变更文件：
${filesText}

git diff --staged：
${diffText || '（无 staged 内容，请根据文件列表推断）'}`;

  const promptEn = `You are a Git commit message generation assistant. Based on the following git diff, generate a commit message that follows the Conventional Commits specification.

Requirements:
1. type must be one of: feat/fix/docs/style/refactor/test/chore
2. scope is optional; use a short English word or short noun phrase to indicate the affected area. Leave empty if unclear.
3. description must be a concise English summary of the change (no more than 50 characters). Use the imperative mood (e.g. "add login button", not "added" or "adding").
4. Return ONLY a JSON object in the format: {"type":"feat","scope":"","description":"xxx"}

Changed files:
${filesText}

git diff --staged:
${diffText || '(no staged content, please infer from the file list)'}`;

  const prompt = locale.startsWith('en') ? promptEn : promptZh;

  // 4. 调用 LLM
  spinner.start('AI 正在生成提交信息...');
  const { default: fetch } = await import('node-fetch').catch(() => ({ default: globalThis.fetch }));
  const url = `${defaultModel.baseURL.replace(/\/$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (defaultModel.apiKey) headers['Authorization'] = `Bearer ${defaultModel.apiKey}`;
  const body = JSON.stringify({
    model: defaultModel.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1024,
    temperature: 0.3,
    stream: false
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = data?.error?.message || data?.message || `HTTP ${response.status}`;
    spinner.fail(`AI 请求失败: ${msg}`);
    throw new Error(`AI 请求失败: ${msg}`);
  }

  const content = data?.choices?.[0]?.message?.content || '';

  // 5. 解析 JSON 响应(与 GUI 一致的容错逻辑)
  const codeBlockMatch = content.match(/```(?:json)?\s*(\{[^`]*?\})\s*```/);
  const jsonMatch = codeBlockMatch
    ? [codeBlockMatch[1]]
    : [...content.matchAll(/\{[^{}]*\}/g)].at(-1);

  if (!jsonMatch) {
    spinner.fail('AI 未返回有效的 JSON');
    throw new Error('AI 未返回有效的 JSON');
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    // JSON.parse 失败时用正则兜底提取字段
    const typeM = jsonMatch[0].match(/"type"\s*:\s*"([^"]+)"/);
    const scopeM = jsonMatch[0].match(/"scope"\s*:\s*"([^"]*)"/);
    const descM = jsonMatch[0].match(/"description"\s*:\s*"([^"]+)"/);
    if (typeM || descM) {
      parsed = {
        type: (typeM?.[1] || 'feat').trim(),
        scope: (scopeM?.[1] || '').trim(),
        description: (descM?.[1] || '').trim()
      };
    } else {
      spinner.fail('AI 返回的 JSON 解析失败');
      throw new Error('AI 返回的 JSON 解析失败');
    }
  }

  // 6. 构建 Conventional Commits 消息
  const type = String(parsed.type || 'feat').trim();
  const scope = String(parsed.scope || '').trim();
  const description = String(parsed.description || '').trim();
  const commitMessage = scope
    ? `${type}(${scope}): ${description}`
    : `${type}: ${description}`;

  spinner.succeed(`AI 生成提交信息: ${chalk.cyan(commitMessage)}`);
  return commitMessage;
}
