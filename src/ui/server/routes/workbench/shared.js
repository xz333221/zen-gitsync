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
export const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
// 应用主配置（projects / recentDirectories / models …）。这里只用来把**路径**告诉 Agent，
// 让它需要时自己读 —— 服务端不在这个流程里解析配置内容。
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const IMAGES_DIR = path.join(DATA_DIR, 'workbench-images');
// 执行日志持久化：jobs.json 是历史档案，jobs-config.json 是保留策略
export const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
export const JOBS_CONFIG_FILE = path.join(DATA_DIR, 'jobs-config.json');
// 落盘防抖。名字里的 jobs 指的是"执行记录"这件事本身：2026-09-28 起它只给
// **运行中**那一份(live-jobs)用，历史档案 jobs.json 改成只在终态写（见 jobStore.js）。
export const JOBS_SAVE_DEBOUNCE_MS = 1500;
export const DEFAULT_JOBS_CONFIG = { maxCount: 500, maxSizeMB: 256 };

// 「运行中」job 的跨实例广播目录：每个 g ui 进程只写自己的 <pid>.json。
// 为什么不复用 jobs.json：那份是历史档案，实测本机 48 条就有 7.5MB，而跑任务期间
// 1.5s 一次的防抖落盘要读+解析+序列化+保留策略再写一遍 —— 为了同步一条"正在跑"
// 的状态去反复搬 7.5MB 不划算（还要阻塞事件循环，反过来卡住流式输出）。
// 每进程一个文件同时也消掉了多进程 read-modify-write 的丢更新（同 instances/ 的理由）。
export const LIVE_JOBS_DIR = path.join(DATA_DIR, 'live-jobs');

// 主 Agent 编排台：调度开关（active）+ 人类干预指令存档。
// 指令存档是「我说过什么」的流水，不参与执行逻辑，只用于控制台日志流回放。
export const ORCHESTRATOR_FILE = path.join(DATA_DIR, 'orchestrator.json');
export const MAX_ORCHESTRATOR_INSTRUCTIONS = 200;

// 进度报告：**配置与历史分两个文件**。
// 报告历史（每份都带着当时的任务事实，几 KB 一份）如果塞进 orchestrator.json，
// 那个被 5s 轮询的接口每轮都要把几十上百 KB 解析一遍 —— 与 jobs.json / jobs-config.json
// 分成两个文件是同一个理由：轮询读配置，历史按需读。
export const ORCHESTRATOR_REPORTS_FILE = path.join(DATA_DIR, 'orchestrator-reports.json');
export const MAX_PROGRESS_REPORTS = 20;

/**
 * 用户从工作台项目清单里手动移除掉的那些条目（存的是归一化后的项目 key）。
 * 独立成文件而不是塞进 config.json：它一份最多几百字节，却会被 5s 轮询的项目清单
 * 接口读到 —— 走 config.json 就得让每次读项目列表都解析一遍主配置。
 * 语义与"为什么不能靠改任务达成"见 hiddenProjects.js 的文件头注释。
 */
export const HIDDEN_PROJECTS_FILE = path.join(DATA_DIR, 'hidden-projects.json');

/**
 * 自动进度报告允许的间隔（毫秒），0 = 关闭。
 *
 * 用白名单而不是"任意正整数"：这个值直接决定**每隔多久烧一次模型额度**，
 * 一个手滑输进去的 5（毫秒）会在几分钟里把额度打光，而用户不会立刻意识到。
 * 前端给的就是这几个档位，服务端再卡一道。
 */
export const PROGRESS_REPORT_INTERVALS_MS = [0, 5, 10, 15, 30, 60].map(min => min * 60 * 1000);

/** 缺省间隔：10 分钟。装完就能用，嫌频繁就在面板上改（改设置不重启服务） */
export const DEFAULT_PROGRESS_REPORT_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 「真相源文件」清单 —— 注入给模型、让它需要细节时自己去读全文的那几个文件。
 *
 * 为什么集中在这一处：有**两条**链路都要把这份清单报给模型 ——
 *   · aiContext（智能体页对话，七个板块的注入块）
 *   · envContext（多项目编排台派发任务时的运行环境块）
 * 以前是各写各的（一个写三个文件名、另一个写四个），加一个可读文件就得改两处，
 * 而漏改的那一处**不会报错**：模型只是永远不知道那个文件存在，于是回答"我看不到"。
 * 现在路径只有这一份，标签/取舍仍由各视图自己决定（那是视图的职责，不是口径）。
 */
export const TRUTH_FILES = {
  tasksFile: TASKS_FILE,
  jobsFile: JOBS_FILE,
  orchestratorFile: ORCHESTRATOR_FILE,
  configFile: CONFIG_FILE,
};

// 派发预设提示词（全局 / 各项目级）**单条**长度上限。
// 它不是"指令"，而是一条每次派发都会被拼进 prompt 的约束 —— 4000 字足够写下一整套
// 规范，再长只会让每一次执行都白烧一遍 token。
// 之所以是 4000 而不是 8000：全局 + 项目级拼起来正好等于任务提示词字段
// （simpleOverride）的 8000 上限（见 index.js 建任务路由），两道口子对齐，
// 就不会出现"派发时写进去了、回头在编辑器里一保存又被悄悄截掉"。
export const MAX_DEFAULT_PROMPT_CHARS = 4000;

// 派发指令正文长度上限。
//
// 2026-09-29 从 4000 放宽到 100000：执行侧走的是 claude / opencode / codex，
// 上下文窗口早已是百万级，而 prompt 是**经 stdin 喂进去**的（见 taskRunner 的
// launchXxxRun），不受 Windows 命令行 32K 上限约束。4000 是模型上下文还小的时候
// 定的，现在它卡住的不是模型，是"粘一份完整报错日志 / 一整段需求"这种最普通的用法。
//
// 十万字不是"随便多大都行"，它同时要落在三份存储里（见下方各自的注释）：
//   · tasks.json 的 task.desc —— 一次执行真正用的正文
//   · jobs.json 的 job.prompt —— 保留策略 500 条 / 256MB 兜底
//   · orchestrator.json 的指令流水 —— 200 条上限
// 真正会让界面卡住的不是这三份，而是**轮询下发**（INSTRUCTION_PREVIEW_CHARS 那道口子）。
export const MAX_INSTRUCTION_CHARS = 100000;

// 指令流水进 5s 轮询 / 活动流时的正文上限。
//
// 为什么单独一道：/api/workbench/orchestrator 每 5 秒把 state.instructions 与活动流
// 整份下发（MAX_ORCHESTRATOR_INSTRUCTIONS = 200 条）。指令放宽到十万字之后，
// 不截就是 200 × 100000 = 20MB 一轮 —— 界面先卡住，而"卡住"和"上限"毫无关系。
//
// 只截**下发**这一份，不截落盘：流水存在的意义就是"我说过什么"能被翻到，
// 落盘那份必须完整（Agent 侧的真相源清单也指着 orchestrator.json）。
// 任务正文本身更不截 —— 完整正文在 task.desc 里，流水这条只是同一句话的旁证。
export const INSTRUCTION_PREVIEW_CHARS = 2000;

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

// 附件大小限制（**数量不限**）
// 单文件 20MB：4K 屏截图（PNG）5–15MB 是常态，卡在 5MB 会让"随手截一张就超"。
// 真正需要小体积的是图片，由前端上传前压缩保证（见 useWorkbenchAttachments.ts），
// 这里只做最后一道兜底，避免超大 body 把内存吃光。
// 数量曾经按 9 个封顶，2026-09-29 按需求放开：一次要交十几张截图 / 一堆日志是常态，
// 封顶只会逼人分批建任务。数量放开后单文件上限成了唯一的内存关口，所以它必须留着。
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;       // 单个附件最大 20MB

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
