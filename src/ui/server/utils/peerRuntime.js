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
// peer 监听的生命周期（进程内单例）。
//
// 为什么要有这一层：设置面板上「允许其他机器提问」是个开关，如果它只在启动时读一次，
// 用户改完还得重启 g ui —— 那这个开关就等于摆设。这里把"读配置 → 起/停监听"收成
// 一个函数，启动时调一次，开关一改再调一次，行为完全一致。
//
// 单例的必要性：同一进程只能绑同一个端口。重复 apply 必须先停旧的再起新的，
// 否则改端口会留下一个"还在旧端口上回答"的幽灵实例。

import { startPeerServer } from '../../../peer/server.js';
import logger from './logger.js';

/** @type {import('node:http').Server|null} */
let handle = null;
/** 本机 g ui 的端口（peer 服务端收到提问后要环回调用它）。 */
let localPort = 0;
/** 当前真的绑在哪个端口上（0 = 没绑）。 */
let boundPort = 0;

/** g ui 真正就绪后由 index.js 注入。 */
export function setPeerLocalPort(port) {
  localPort = Number(port) || 0;
}

/** 当前是否在监听。 */
export function isPeerRunning() {
  return !!handle;
}

/** 正在提供服务的 peer 端口（没在听就是 0），用于写进实例注册表。 */
export function getPeerPort() {
  return handle ? boundPort : 0;
}

/** 停掉监听（幂等）。 */
export async function stopPeerRuntime() {
  if (!handle) return;
  const h = handle;
  handle = null;
  boundPort = 0;
  await new Promise((resolve) => {
    try {
      h.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * 按当前身份配置应用 peer 监听：enabled=true 就起，false 就停。
 *
 * @param {object} self peers.json 里的 self
 * @param {{getVersion?: () => string}} [opts]
 * @returns {Promise<{running:boolean, port:number|null}>}
 */
export async function applyPeerRuntime(self, { getVersion } = {}) {
  await stopPeerRuntime();
  if (!self?.enabled || !self.token) return { running: false, port: null };
  if (!localPort) {
    logger.warn('[peer] 本机端口未知，暂时无法开启（主服务还没 listening）');
    return { running: false, port: null };
  }

  boundPort = self.port;
  handle = await startPeerServer({
    self,
    getLocalPort: () => localPort,
    getVersion
  });
  return { running: true, port: self.port };
}
