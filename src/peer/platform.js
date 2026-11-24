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
// 本机系统标识：跨机器问答时**由这台机器自报**自己是什么系统。
//
// 为什么必须自报：进程看到的世界只有它自己那份 os 模块 —— 谁也没有办法隔着一根
// 网线去读对端的 /etc/os-release。提问方猜出来的"你应该是 Linux"就是错的来源：
// 本机是 Windows，对端可能也是 Windows，写 `ls` / `tail` / 单引号路径必然报错。
// 所以这里只做"我这边是什么"，由 server.js 附在 /api/peer/info 里让对端拿走；
// 提问时同理，client.js 把自己的 label 一起发过去，让对端 agent 知道该用哪种写法。

import { readFileSync } from 'node:fs';
import os from 'node:os';

/** 进程内缓存：系统在进程生命周期里不会变，没必要每个请求都读一遍文件。 */
let cached = null;

/** Windows 版本号到产品名：build ≥ 22000 是 11，≥ 10240 是 10。 */
function windowsLabel(arch) {
  const build = Number(String(os.release()).split('.')[2] || 0);
  if (build >= 22000) return `Windows 11 (win32/${arch})`;
  if (build >= 10240) return `Windows 10 (win32/${arch})`;
  return `Windows (win32/${arch})`;
}

/** Linux 优先用发行版自报的名字（Ubuntu 22.04 / Debian 12 …），读不到退回内核信息。 */
function linuxLabel(arch) {
  try {
    const raw = readFileSync('/etc/os-release', 'utf8');
    const m = raw.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
    if (m && m[1].trim()) return `${m[1].trim()} (linux/${arch})`;
  } catch {
    // 容器/精简系统里可能没有这个文件 —— 不是错误，退回内核版本即可
  }
  return `Linux ${os.release()} (${arch})`;
}

/**
 * 描述本机系统。
 * @returns {{platform:string, arch:string, release:string, label:string}}
 */
export function describePlatform() {
  if (cached) return cached;
  const platform = process.platform;
  const arch = process.arch;
  const release = os.release();
  let label;
  if (platform === 'win32') label = windowsLabel(arch);
  else if (platform === 'darwin') label = `macOS ${release} (${arch})`;
  else if (platform === 'linux') label = linuxLabel(arch);
  else label = `${platform} ${release} (${arch})`;
  cached = { platform, arch, release, label };
  return cached;
}

/**
 * 描述本机默认的 shell —— 让对端知道该按哪种语法写命令。
 * Windows 上 g ui 自己就能跑 cmd/PowerShell，所以直接给这两种；
 * 其它系统跟随用户环境变量。
 */
export function describeShell() {
  if (process.platform === 'win32') return 'cmd.exe / PowerShell';
  return process.env.SHELL || '/bin/sh';
}
