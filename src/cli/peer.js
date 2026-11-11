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
// `g peer` —— 跨机器通信的配置入口（g ai 与另一台机器上的 g ai 对话）。
//
// 三条命令构成最小闭环：
//   A 上 `g peer on`          → 打印本机地址与令牌
//   B 上 `g peer add 服务器 <地址> --token <令牌>`  → 校验一次 /info 并把对端 id 记下来
//   B 上 `g peer ask 服务器 "你那边有哪些项目"`      → 直接跑通一轮跨机器问答
//
// 为什么不把这些塞进 config.json / 界面：peer 身份只跟机器有关、且是"一次配好长期用"，
// 命令行更快，也便于在两台机器上照抄同一套步骤。

import os from 'node:os';
import chalk from 'chalk';

import {
  ensureSelf,
  updateSelf,
  readState,
  listPeers,
  removePeer,
  upsertPeer,
  PEER_DEFAULT_PORT,
  maskToken
} from '../peer/store.js';
import { fetchPeerInfo, askPeer } from '../peer/client.js';

const USAGE = `
用法:
  g peer                          查看本机节点身份与已登记的对端
  g peer on [--name 昵称] [--port 5600] [--host 0.0.0.0]
                                  开启本机的 peer 端口(重启 g ui 后生效)
  g peer off                      关闭本机的 peer 端口
  g peer add <昵称> <地址> --token <令牌>
                                  登记一台对端,例如:
                                  g peer add 服务器 http://192.168.1.20:5600 --token <令牌>
  g peer rm <昵称|id>             移除一台对端
  g peer ask <昵称|id> <问题>     向对端提一个问题(端到端自检)
  g peer help                     显示本帮助

说明:
  · peer 端口是**独立端口**,与 g ui 的随机端口无关;只有 g ui 在跑时才监听。
  · 令牌在「g peer on」时自动生成,对端要填的就是这串;它等价于"允许对方问我"的钥匙,
    不要贴到聊天/仓库里。
  · 地址用对端在局域网内的 IP(下面会列出本机可作为地址的网卡)。
`.trim();

/** 列出本机可能对外的 IPv4 地址（给用户抄地址用，跳过回环与虚拟网卡）。 */
function localAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' && item.family !== 4) continue;
      if (item.internal) continue;
      out.push({ name, address: item.address });
    }
  }
  return out;
}

/** 从 argv 里取 `--key value` / `--flag`。 */
function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags[key] = next; i += 1; } else { flags[key] = true; }
    } else {
      rest.push(a);
    }
  }
  return { flags, rest };
}

async function cmdStatus() {
  const state = await ensureSelf();
  const self = state.self;
  console.log(chalk.bold('本机节点'));
  console.log(`  昵称   ${self.name}`);
  console.log(`  节点 id ${self.id}`);
  console.log(`  端口   ${self.host}:${self.port}  ${self.enabled ? chalk.green('已开启') : chalk.gray('未开启（g peer on 开启）')}`);
  console.log(`  令牌   ${self.enabled ? self.token : maskToken(self.token)}`);

  // 探活要带对端令牌：listPeers() 是**脱敏视图**（不含 token），拿它去请求会
  // 让 Bearer 为空 → 对端一律 401 → 在线的对端被误判成「离线·令牌无效」。
  // 与 src/peer/client.js 的 listPeerStatus 保持同一口径：内部读数据用 readState()。
  const { peers } = await readState();
  console.log('');
  console.log(chalk.bold(`对端（${peers.length}）`));
  if (!peers.length) {
    console.log(chalk.gray('  还没有。在另一台机器上 `g peer on`，然后 `g peer add <昵称> <地址> --token <令牌>`。'));
    return;
  }
  for (const p of peers) {
    let tag = chalk.gray('[离线]');
    try {
      const info = await fetchPeerInfo(p, { timeoutMs: 2000 });
      tag = chalk.green('[在线]') + chalk.gray(` ${info.name} ${info.version || ''}`.trimEnd());
    } catch (e) {
      tag = chalk.gray(`[离线] ${e.message}`);
    }
    console.log(`  ${p.name.padEnd(12)} ${p.url}  ${tag}`);
  }
}

async function cmdOn(flags) {
  const port = flags.port ? Number(flags.port) : PEER_DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(chalk.red(`端口不合法: ${flags.port}`));
    process.exitCode = 1;
    return;
  }
  const before = await ensureSelf();
  const after = await updateSelf({
    enabled: true,
    port,
    name: typeof flags.name === 'string' ? flags.name : undefined,
    host: typeof flags.host === 'string' ? flags.host : undefined
  });
  const self = after.self;

  console.log(chalk.green(`已开启 peer：${self.host}:${self.port}（节点 ${self.id}「${self.name}」）`));
  if (before.self.enabled !== true) {
    console.log(chalk.yellow('重启 g ui 后才会真正开始监听（端口在服务启动时绑定）。'));
  }
  console.log('');
  console.log(chalk.bold('给另一台机器用的信息'));
  console.log(`  地址: http://<本机局域网 IP>:${self.port}`);
  const addrs = localAddresses();
  if (addrs.length) {
    console.log(chalk.gray('  本机可用的局域网地址:'));
    for (const a of addrs) console.log(chalk.gray(`    ${a.address}  (${a.name})`));
  } else {
    console.log(chalk.gray('  没探到局域网地址（可能没连网络）。'));
  }
  console.log(`  令牌: ${self.token}`);
  console.log('');
  console.log(chalk.gray('在另一台机器上执行：'));
  console.log(chalk.gray(`  g peer add ${self.name} http://${addrs[0]?.address || '<本机IP>'}:${self.port} --token ${self.token}`));
}

async function cmdOff() {
  await ensureSelf();
  await updateSelf({ enabled: false });
  console.log(chalk.green('已关闭本机的 peer 端口（重启 g ui 后不再监听）。'));
}

async function cmdAdd(rest, flags) {
  const [name, url] = rest;
  const token = typeof flags.token === 'string' ? flags.token.trim() : '';
  if (!name || !url) {
    console.error(chalk.red('用法: g peer add <昵称> <地址> --token <令牌>'));
    process.exitCode = 1;
    return;
  }
  if (!token) {
    console.error(chalk.red('缺少 --token。<令牌> 在对端机器执行 `g peer on` 时会打印。'));
    process.exitCode = 1;
    return;
  }
  const normalized = url.startsWith('http') ? url : `http://${url}`;

  // 先探一次：能连上 + 令牌对 + 拿到对方的真实 id（之后按 id 寻址，改 IP 也不会认错人）
  let info;
  try {
    info = await fetchPeerInfo({ url: normalized.replace(/\/+$/, ''), token }, { timeoutMs: 5000 });
  } catch (e) {
    console.error(chalk.red(`登记失败：${e.message}`));
    console.error(chalk.gray('排查顺序：对端 g ui 是否在跑 → 对端是否 `g peer on` → 局域网是否互通（防火墙）→ 令牌是否正确。'));
    process.exitCode = 1;
    return;
  }

  await upsertPeer({ id: info.id || '', name, url: normalized, token });
  console.log(chalk.green(`已登记对端「${name}」→ ${normalized}（对方节点 ${info.id || '未知'}「${info.name}」）`));
  console.log(chalk.gray(`自检：g peer ask ${name} "你那边现在有哪些项目？"`));
}

async function cmdRm(rest) {
  const ref = rest[0];
  if (!ref) {
    console.error(chalk.red('用法: g peer rm <昵称|id>'));
    process.exitCode = 1;
    return;
  }
  const { removed, peer } = await removePeer(ref);
  console.log(removed ? chalk.green(`已移除对端「${peer.name}」`) : chalk.yellow(`没有找到「${ref}」`));
}

async function cmdAsk(rest) {
  const ref = rest[0];
  const question = rest.slice(1).join(' ').trim();
  if (!ref || !question) {
    console.error(chalk.red('用法: g peer ask <昵称|id> <问题>'));
    process.exitCode = 1;
    return;
  }
  const state = await ensureSelf();
  const peers = await listPeers();
  const peer = peers.find((p) => p.id.toLowerCase() === ref.toLowerCase() || p.name.toLowerCase() === ref.toLowerCase());
  if (!peer) {
    console.error(chalk.red(`没有找到对端「${ref}」。现有：${peers.map((p) => p.name).join(' / ') || '（空）'}`));
    process.exitCode = 1;
    return;
  }
  const full = (await readState()).peers.find((p) => p.url === peer.url);
  console.log(chalk.gray(`→ 正在问「${peer.name}」（对方是另一个智能体，可能需要一会儿）…`));
  try {
    const result = await askPeer(full, state.self, question);
    console.log('');
    console.log(chalk.bold(`【${peer.name}】`));
    console.log(result.answer || chalk.yellow('（对方没有给出正文）'));
    console.log('');
    console.log(chalk.gray(`用时 ${(result.ms / 1000).toFixed(1)}s，会话 ${result.sessionId || '新会话'}`));
  } catch (e) {
    console.error(chalk.red(`提问失败：${e.message}`));
    process.exitCode = 1;
  }
}

/**
 * `g peer` 入口。
 * @param {string[]} argv 已经去掉 `peer` 之后的参数
 */
export async function runPeerCli(argv = []) {
  const sub = argv[0] || 'status';
  const { flags, rest } = parseFlags(argv.slice(1));

  switch (sub) {
    case 'status':
    case 'ls':
      await cmdStatus();
      return;
    case 'on':
      await cmdOn(flags);
      return;
    case 'off':
      await cmdOff();
      return;
    case 'add':
      await cmdAdd(rest, flags);
      return;
    case 'rm':
    case 'remove':
      await cmdRm(rest);
      return;
    case 'ask':
      await cmdAsk(rest);
      return;
    case 'help':
    case '-h':
    case '--help':
      console.log(USAGE);
      return;
    default:
      console.error(chalk.red(`未知子命令: ${sub}`));
      console.log(USAGE);
      process.exitCode = 1;
  }
}
