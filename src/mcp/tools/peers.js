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
// 板块九:跨机器对端(peer)—— 登记了哪些机器、在不在线、让对端那台机器的 g ai 去查/干活。
//
// 真相边界与别的板块不同,这里**不经过本机 g ui**:
//   · 对端清单 → 文件即真相(<DATA_DIR>/peers.json,CLI 与设置面板共用一份);
//   · 在不在线 → 只能现探(对端可能十天半个月不开机,没有常驻心跳);
//   · 提问     → 直连对端自己的 peer 端口(默认 5600),所以本机 g ui 没开也能用。
//
// ⚠️ 令牌纪律:peers.json 里存着对端令牌明文,`askPeerByRef` 回来的 `peer` 也是**完整条目**
//    (含 token)。工具结果里一个字节都不能出去 —— 只投影 id/name/url,与 agent_mcp_servers
//    不回 headers 值是同一条规矩。
import { PEERS_FILE } from '../paths.js';
import { listPeerStatus, askPeerByRef } from '../../peer/client.js';
import { readState } from '../../peer/store.js';
import { asString, asInt, asBool, truncate } from '../util.js';

/** 没有对端时给的那句话(与 client.askPeerByRef 的口径一致:先在对端开,再在本机登记)。 */
const NO_PEER_HINT = '还没有登记任何对端。在**对端机器**上执行 `g peer on`(会打印地址与令牌),'
  + '再回到这台机器执行 `g peer add <昵称> <地址> --token <令牌>`。';

export const peerTools = [
  {
    name: 'peers_list',
    description:
      '列出本机登记的**其他电脑**(跨机器对端):昵称、地址、此刻在不在线、对端的 zen-gitsync 版本,'
      + '以及本机自己的 peer 身份与开关状态。'
      + '什么时候用:用户问的是"另一台机器上的事"(那台服务器上有哪些项目、某个部署做完没有),'
      + '先用这个看清能问谁,再用 peer_ask 去问。'
      + '在线状态是**现探**的(并发,每台 2 秒超时),不是缓存;不回令牌。',
    inputSchema: {
      type: 'object',
      properties: {
        probe: {
          type: 'boolean',
          description: '是否现探在线状态,默认 true。false = 只读清单不联网(此时 online 一律 false,不代表离线)',
        },
      },
    },
    async handler(args) {
      const probe = asBool(args?.probe, true);
      const state = await readState();
      const status = await listPeerStatus({ probe });

      // listPeerStatus 在线时回的是**对端自报的 id**,离线时回本地登记的 id ——
      // 两边不一定相同,所以 has_token 按 url 对齐(url 在两种分支里都是本地那条)。
      const tokenByUrl = new Map(state.peers.map(p => [p.url, !!p.token]));
      const peers = status.map(p => ({
        id: p.id || '',
        name: p.name || '',
        url: p.url,
        online: p.online === true,
        version: p.label || null,
        has_token: tokenByUrl.get(p.url) === true,
        error: p.error || null,
      }));
      const self = state.self;

      return {
        source: probe ? 'live' : 'file',
        file: PEERS_FILE,
        self: self
          ? { id: self.id, name: self.name, port: self.port, host: self.host, enabled: self.enabled, has_token: !!self.token }
          : null,
        total: peers.length,
        online_count: peers.filter(p => p.online).length,
        peers,
        note: probe
          ? '在线状态是这一刻探出来的。离线原因看 error:令牌不匹配(对端重生成过令牌)与地址写错/没开端口是两回事。'
          : '⚠️ probe=false:**没有探活**,online 一律 false,不代表对端离线。',
        hint: peers.length === 0
          ? NO_PEER_HINT
          : (self && !self.enabled ? '本机 peer 服务没开(别的机器问不到你),但你仍然可以问别人。开:`g peer on`。' : undefined),
      };
    },
  },

  {
    name: 'peer_ask',
    description:
      '向**另一台电脑**上的 g ai 提问,把它的回答原样带回来(跨机器通信)。'
      + '什么时候用:要查/要做的事在那台机器上 —— 它的目录、项目、任务、日志、部署状态,'
      + '这些本机工具看不到,别猜,直接问它。'
      + '⚠️ 对端是另一个正在跑的智能体,一次问答可能几十秒到几分钟:同一件事别反复问,'
      + '也不要拿它当跑命令的通道(本机的活自己干)。问题上限 4000 字。'
      + '会话自动续接:同一台对端的第二问还记得第一问。先用 peers_list 看清谁在线。',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '要问的话。写得像对人说话:把你已知的上下文一起给它("X 项目今天推了 3 个提交,部署了吗"),它看不到你这边的会话',
        },
        peer: { type: 'string', description: '对端的 id 或昵称(从 peers_list 拿)。只有一台对端时可以省略' },
        timeout_seconds: { type: 'integer', description: '最长等多久,默认 300 秒(上限 1800)' },
      },
      required: ['question'],
    },
    async handler(args) {
      const question = asString(args?.question);
      if (!question) return { error: '需要 question(要问对端的那句话)。' };
      const ref = asString(args?.peer);
      const timeoutSeconds = asInt(args?.timeout_seconds, 300, { min: 10, max: 1800 });
      const startedAt = Date.now();

      try {
        const result = await askPeerByRef(ref, question, { timeoutMs: timeoutSeconds * 1000 });
        // ⚠️ result.peer 是 peers.json 里的完整条目(带 token),只投影这三个字段
        const peer = result?.peer || {};
        return {
          source: 'live',
          // callPeer 对 401 / 超时 / ok:false 一律抛,所以能走到这里就是真拿到了回答
          ran: true,
          peer: { id: peer.id || '', name: peer.name || ref || '', url: peer.url || '' },
          session_id: result?.sessionId || null,
          elapsed_ms: typeof result?.ms === 'number' ? result.ms : Date.now() - startedAt,
          answer: truncate(String(result?.answer || '').trim(), 12000, 10000),
        };
      } catch (err) {
        return {
          source: 'live',
          ran: false,
          peer: ref || null,
          elapsed_ms: Date.now() - startedAt,
          answer: '',
          error: String(err?.message || err),
          note: '⚠️ 这一问**没有拿到回答**,不要当成对端已经答复,也不要向用户承诺那台机器上的事已经做了。'
            + '先用 peers_list 看谁在线、error 是什么原因(令牌不匹配 / 地址写错 / 对端没开 peer),再决定要不要重试。',
        };
      }
    },
  },
];