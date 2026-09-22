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
// workbench 子模块共享：常量 + 通用工具函数。
// 拆分自原 routes/workbench.js (3539 行) 顶层 1-46 行 + 778-805 行 + 932-944 行。
//
// 设计要点：
//   - 所有 workbench/* 子模块都从这里 import 常量路径与通用工具
//   - 不依赖任何其他 workbench 子模块（避免循环）
//   - 持久化函数（readJson / writeJson）保持原子写（tmp + rename）

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import logger from '../../utils/logger.js';
import { DATA_DIR } from '../../../../paths.js';

// ── 数据目录与持久化文件路径 ─────────────────────────────────
// 全部存在用户主目录 ~/.zen-gitsync/ 下，跨项目共享。
// 目录本身定义在 src/paths.js(全部数据路径的唯一真相源)，这里只在其下拼文件名。
export { DATA_DIR };
export const PROMPTS_FILE = path.join(DATA_DIR, 'prompts.json');
export const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
// 应用主配置（projects / recentDirectories / models …）。这里只用来把**路径**告诉 Agent，
// 让它需要时自己读 —— 服务端不在这个流程里解析配置内容。
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const IMAGES_DIR = path.join(DATA_DIR, 'workbench-images');
export const INSTRUCTION_FILE = path.join(DATA_DIR, 'ai-instruction.json');
// 执行日志持久化：jobs.json 是历史档案，jobs-config.json 是保留策略
export const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
export const JOBS_CONFIG_FILE = path.join(DATA_DIR, 'jobs-config.json');
export const JOBS_SAVE_DEBOUNCE_MS = 1500;
export const DEFAULT_JOBS_CONFIG = { maxCount: 500, maxSizeMB: 256 };

// 主 Agent 编排台：调度开关（active）+ 人类干预指令存档。
// 指令存档是「我说过什么」的流水，不参与执行逻辑，只用于控制台日志流回放。
export const ORCHESTRATOR_FILE = path.join(DATA_DIR, 'orchestrator.json');
export const MAX_ORCHESTRATOR_INSTRUCTIONS = 200;

// 派发默认提示词（全局 / 各项目级）**单条**长度上限。
// 它不是"指令"，而是一条每次派发都会被拼进 prompt 的约束 —— 4000 字足够写下一整套
// 规范，再长只会让每一次执行都白烧一遍 token。
// 之所以是 4000 而不是 8000：全局 + 项目级拼起来正好等于任务提示词字段
// （simpleOverride）的 8000 上限（见 index.js 建任务路由），两道口子对齐，
// 就不会出现"派发时写进去了、回头在编辑器里一保存又被悄悄截掉"。
export const MAX_DEFAULT_PROMPT_CHARS = 4000;

// 子项目识别 / 文件扫描时需要跳过的目录
export const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', '.next', '.nuxt', '__pycache__',
  'target', 'out', 'coverage', 'vendor', '.git', '.svn', '.hg',
  '.idea', '.vscode', '.gradle', '.terraform', '.cache', '.parcel-cache',
  '.turbo', '.svelte-kit', 'storybook-static'
]);

// 解析 manifest 文件名（按优先级）
export const MANIFEST_FILES = [
  'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json',
  'Gemfile', 'pubspec.yaml'
];

// 附件大小 / 数量限制
// 单文件 20MB：4K 屏截图（PNG）5–15MB 是常态，卡在 5MB 会让"随手截一张就超"。
// 真正需要小体积的是图片，由前端上传前压缩保证（见 useWorkbenchAttachments.ts），
// 这里只做最后一道兜底，避免超大 body 把内存吃光。
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;       // 单个附件最大 20MB
export const MAX_ATTACHMENTS_PER_TASK = 9;             // 一个任务最多挂 9 个附件

// ── 时间 / ID 工具 ─────────────────────────────────────────
export function nowIso() {
  return new Date().toISOString();
}

export function genId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── 文件持久化工具 ─────────────────────────────────────────
// 所有 workbench 数据都用这两个函数读写，确保原子写与 ENOENT 容错
export async function ensureDataDir() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
}

export async function readJson(file, fallback) {
  try {
    const buf = await fsp.readFile(file, 'utf-8');
    return JSON.parse(buf);
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// 原子写：tmp + rename。避免半写状态被读到（与 jobStore 一致）
export async function writeJson(file, data) {
  await ensureDataDir();
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fsp.rename(tmp, file);
}

// 简单 Mustache 风格变量插值：{{task.title}} / {{task.desc}} / {{repo.path}} / {{branch}}
// 用于把用户可编辑的 prompt 模板里的占位符替换成实际上下文
export function interpolate(template, ctx) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const parts = key.split('.');
    let cur = ctx;
    for (const p of parts) {
      if (cur == null) return '';
      cur = cur[p];
    }
    return cur == null ? '' : String(cur);
  });
}

// 让子模块共享 logger，避免到处 import
export { logger, fs, fsp, path, os };
