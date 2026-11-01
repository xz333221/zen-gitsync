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
// 「开机就有 hub」：项目窗口起来时，发现这台机器上没有活着的 hub，就顺手拉一个。
//
// 为什么不要求用户手动先起 hub：拆成两个角色之后，工作台 / 项目管理 / 系统监控 /
// 思维导图只存在于 hub 进程里。如果每次都得先记得「先开 hub 再开项目窗口」，
// 这套拆分就是个负担而不是改进。
//
// 三段式（顺序很重要）：
//   1. 查实例注册表 —— 有 role=hub 且心跳新鲜的，直接复用（不重复拉进程）；
//   2. 没有才 spawn 一个 detached 的 `g ui --role=hub --port=<固定端口>`；
//   3. 无论哪种结果都把「hub 在哪个端口」返回给调用方打日志。
//
// 为什么端口固定：它要长期被别的窗口/脚本按固定地址访问。hub 那边 maxTries=1，
// 被占就直接失败 —— 所以两个窗口同时启动时，后起那个只是抢不到端口并退出，
// 不会出现"hub 悄悄跑到 5601 而没人知道"。

import { spawn } from 'node:child_process';
import { openSync, closeSync, promises as fsPromises } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

import { createInstanceRegistry, getRegistryPath } from './instanceRegistry.js';
import { DATA_DIR } from '../../../paths.js';

/** hub 的默认固定端口。peer 默认用 5600（见 src/peer/store.js），两者不重叠。 */
export const HUB_DEFAULT_PORT = 5599;

/** 自动拉起的 hub 的日志（stdio 走 ignore 的话，端口冲突这类失败会彻底静默）。 */
export const HUB_LOG_FILE = path.join(DATA_DIR, 'hub.log');

/** 从模块位置定位 CLI 入口，不依赖调用方怎么被启动（g ui / node server.js / nodemon）。 */
function resolveCliEntry() {
  return fileURLToPath(new URL('../../../gitCommit.js', import.meta.url));
}

/**
 * 确保本机有活着的 hub。
 *
 * @param {object} [opts]
 * @param {number} [opts.port] 期望的 hub 端口（默认 HUB_DEFAULT_PORT）
 * @param {string} [opts.cwd]  hub 进程的工作目录（默认继承当前进程）
 * @returns {Promise<{reused:boolean, port:number, pid:number|null}>}
 */
export async function ensureHubRunning({ port = HUB_DEFAULT_PORT, cwd } = {}) {
  const registry = createInstanceRegistry({
    fs: fsPromises,
    path,
    os,
    registryPath: getRegistryPath()
  });

  // ① 已经有一个活着的 hub（心跳新鲜 + pid 存活由 list() 统一裁剪）
  try {
    const instances = await registry.list();
    const live = instances.find((i) => i.role === 'hub');
    if (live) return { reused: true, port: live.port, pid: live.pid };
  } catch {
    // 注册表读挂了不该挡住主流程，继续往下走去 spawn
  }

  // ② 拉一个新的
  let fd = null;
  try {
    fd = openSync(HUB_LOG_FILE, 'a');
  } catch {
    // 日志都开不了就退化成 ignore —— hub 照起，只是失败信息看不到
  }

  const child = spawn(process.execPath, [
    resolveCliEntry(),
    'ui',
    '--role=hub',
    `--port=${port}`,
    '--no-open'
  ], {
    detached: true,
    // 关键：不继承 stdout，否则父窗口退出时管道断开会把 hub 一起带走
    stdio: fd === null ? 'ignore' : ['ignore', fd, fd],
    cwd: cwd || process.cwd(),
    windowsHide: true,
    env: { ...process.env, ZEN_HUB_AUTOSTART: '1' }
  });
  child.unref();
  if (fd !== null) { try { closeSync(fd); } catch {} }

  return { reused: false, port, pid: child.pid ?? null };
}
