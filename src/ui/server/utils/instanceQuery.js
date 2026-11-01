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
// 读实例注册表的一层薄封装。
//
// 为什么单独一个文件：ensureHub（要不要拉 hub）和 peerSettings（谁在持有 peer 端口）
// 都要问同一个问题——"这台机器上现在有哪些活着的 g ui"。各建一份 registry 实例
// 倒也能跑，但两处裁剪过期条目的时机不同，会得到两个答案；统一到这里只建一次。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createInstanceRegistry, getRegistryPath } from './instanceRegistry.js';

let cached = null;

function registry() {
  if (!cached) {
    cached = createInstanceRegistry({ fs, path, os, registryPath: getRegistryPath() });
  }
  return cached;
}

/**
 * 当前活着的 g ui 实例（已裁剪过期条目）。
 * @returns {Promise<Array<{pid:number,port:number,role:string,peerPort:number,projectPath:string}>>}
 */
export async function listInstances() {
  try {
    return await registry().list();
  } catch {
    return [];
  }
}

/**
 * 找出"正在提供 peer 端口"的那个实例。
 *
 * peer 端口是**整机唯一**的：谁先绑上谁持有。多个 g ui 同时开着时，只有持有者
 * 能把 5600 答起来，其余进程 listen 会 EADDRINUSE —— 所以状态必须以注册表为准，
 * 不能只看自己进程里的 handle。
 *
 * @param {number} [port] 期望的 peer 端口；给了就只认这个端口
 */
export async function findPeerOwner(port) {
  const list = await listInstances();
  return list.find((i) => Number(i.peerPort) > 0 && (!port || Number(i.peerPort) === Number(port))) || null;
}

/** 找出活着的 hub（role=hub）。 */
export async function findHubInstance() {
  const list = await listInstances();
  return list.find((i) => i.role === 'hub') || null;
}
