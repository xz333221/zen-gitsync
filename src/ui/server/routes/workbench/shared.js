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

// ── 数据目录与持久化文件路径 ─────────────────────────────────
// 全部存在用户主目录 ~/.zen-gitsync/ 下，跨项目共享
export const DATA_DIR = path.join(os.homedir(), '.zen-gitsync');
export const PROMPTS_FILE = path.join(DATA_DIR, 'prompts.json');
export const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
export const IMAGES_DIR = path.join(DATA_DIR, 'workbench-images');
export const INSTRUCTION_FILE = path.join(DATA_DIR, 'ai-instruction.json');
export const SUBTASK_INSTRUCTION_FILE = path.join(DATA_DIR, 'ai-subtask-instruction.json');
// AI 对话拆分会话存档：每个 sessionId 一个文件，重启可恢复多轮上下文
export const SESSIONS_DIR = path.join(DATA_DIR, 'ai-split-sessions');
export const MAX_SESSIONS = 100;     // 软上限，触发清理
export const SESSIONS_KEEP = 50;     // 超过上限时保留最新 N 个
// 执行日志持久化：jobs.json 是历史档案，jobs-config.json 是保留策略
export const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
export const JOBS_CONFIG_FILE = path.join(DATA_DIR, 'jobs-config.json');
export const JOBS_SAVE_DEBOUNCE_MS = 1500;
export const DEFAULT_JOBS_CONFIG = { maxCount: 500, maxSizeMB: 256 };

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
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;        // 单个附件最大 5MB
export const MAX_ATTACHMENTS_PER_SUBTASK = 9;          // 一个子任务最多挂 9 个附件

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

// 原子写：tmp + rename。避免半写状态被读到（与 sessionStore 一致）
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
