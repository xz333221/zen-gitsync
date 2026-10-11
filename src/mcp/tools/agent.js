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
// 板块三:g ai 的对话会话 / Skill / MCP 配置 / 调用智能体。
//
// 三件事的真相边界完全不同,这里必须说清楚:
//   · 会话历史  → 文件即真相(agent-sessions/<id>.json,CLI 与 Web 共用)。但**不是实时刷的**:
//                一轮对话正在流式进行时,磁盘上可能还是上一轮的状态。
//   · Skill / MCP → 文件即真相,两级作用域(全局 ~/.zen-gitsync/ai/ 与项目 <cwd>/.zen-gitsync/ai/)。
//   · 让 g ai 跑一轮 → **必须**转发给活着的 g ui(runAgentTurn 在 GUI 进程里)。
import path from 'node:path';

import {
  AI_SKILLS_DIR,
  AI_MCP_FILE,
  AGENT_SESSIONS_DIR,
  projectSkillsDir,
  projectMcpFile,
} from '../paths.js';
import { findLiveInstance, liveFetch, liveSse, describeInstance, NO_LIVE_INSTANCE_HINT } from '../live.js';
import { listDataFiles, readJsonFile, readTextFile, truncate, asString, asInt } from '../util.js';

/** 从 SKILL.md 的 frontmatter 里抠 name / description(不引 yaml 依赖)。 */
function parseSkillFrontmatter(text) {
  const out = { name: '', description: '' };
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(name|description)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    let value = kv[2].trim();
    value = value.replace(/^["']|["']$/g, '');
    out[kv[1]] = value;
  }
  return out;
}

/** 扫一个 skills 根目录,返回 skill 清单。目录不存在就是空的,不是错误。 */
async function listSkillsIn(rootDir, scope) {
  const dirs = [];
  try {
    const { promises: fs } = await import('node:fs');
    const names = await fs.readdir(rootDir);
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const dir = path.join(rootDir, name);
      const stat = await fs.stat(dir).catch(() => null);
      if (!stat?.isDirectory()) continue;
      dirs.push({ id: name, dir });
    }
  } catch {
    return [];
  }

  const out = [];
  for (const { id, dir } of dirs) {
    const skillFile = path.join(dir, 'SKILL.md');
    const text = await readTextFile(skillFile, '');
    if (!text.trim()) {
      out.push({ scope, id, path: dir, skill_file: skillFile, has_skill_md: false, name: id, description: '' });
      continue;
    }
    const meta = parseSkillFrontmatter(text);
    out.push({
      scope,
      id,
      name: meta.name || id,
      description: meta.description || '',
      path: dir,
      skill_file: skillFile,
    });
  }
  return out;
}

/** 读一处 mcp.json(形状 { mcpServers: {...} }),只回摘要不回 env/headers 里的密钥。 */
async function readMcpConfig(file, scope) {
  const raw = await readTextFile(file, '');
  if (!raw.trim()) return { scope, file, exists: false, servers: [] };
  let parsed;
  try { parsed = JSON.parse(raw) } catch {
    return { scope, file, exists: true, broken: true, servers: [], note: '这个 mcp.json 不是合法 JSON,已被忽略(与 g ai 的读取口径一致)。' };
  }
  const servers = parsed?.mcpServers;
  if (!servers || typeof servers !== 'object') return { scope, file, exists: true, servers: [] };

  return {
    scope,
    file,
    exists: true,
    servers: Object.entries(servers).map(([id, cfg]) => {
      const c = cfg && typeof cfg === 'object' ? cfg : {};
      const url = typeof c.url === 'string' ? c.url : '';
      return {
        id,
        transport: typeof c.command === 'string' && c.command.trim() ? 'stdio' : (url ? 'http' : 'unknown'),
        // 只回命令名与 URL,不回 env/headers —— 那里面通常有 token
        command: typeof c.command === 'string' ? c.command : null,
        args: Array.isArray(c.args) ? c.args.map(String) : [],
        url: url || null,
        disabled: c.disabled === true,
        header_names: c.headers && typeof c.headers === 'object' ? Object.keys(c.headers) : [],
      };
    }),
  };
}

export const agentTools = [
  {
    name: 'agent_sessions_list',
    description:
      '列出 g ai 智能体的历史对话会话(标题、所属项目目录、模型、消息数、更新时间)。'
      + '可以按项目目录过滤。会话是 CLI 与 Web 界面共用的一份,直读磁盘。',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '只看属于这个项目目录的会话(不区分大小写)' },
        query: { type: 'string', description: '按标题做子串过滤' },
        limit: { type: 'integer', description: '最多返回多少条,默认 30' },
      },
    },
    async handler(args) {
      const wantCwd = asString(args?.cwd).toLowerCase();
      const query = asString(args?.query).toLowerCase();
      const limit = asInt(args?.limit, 30, { min: 1, max: 200 });

      const files = await listDataFiles(AGENT_SESSIONS_DIR, { withStat: true });
      const sessions = [];
      for (const entry of files) {
        const data = await readJsonFile(entry.path, null);
        if (!data || typeof data !== 'object') continue;
        const cwd = String(data.cwd || '');
        if (wantCwd && !cwd.toLowerCase().includes(wantCwd)) continue;
        const title = String(data.title || '');
        if (query && !title.toLowerCase().includes(query)) continue;
        const messages = Array.isArray(data.messages) ? data.messages : [];
        sessions.push({
          session_id: data.sessionId || path.basename(entry.path, '.json'),
          title,
          cwd,
          source: data.source || null,
          engine: data.engine || null,
          model: data.model || null,
          message_count: messages.length,
          user_turns: messages.filter(m => m?.role === 'user').length,
          created_at: data.createdAt || null,
          updated_at: data.updatedAt || null,
          size: entry.size,
        });
      }
      sessions.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
      return {
        source: 'file',
        dir: AGENT_SESSIONS_DIR,
        total: sessions.length,
        returned: Math.min(sessions.length, limit),
        sessions: sessions.slice(0, limit),
        note: '会话在对话进行中可能还没刷到磁盘 —— 正在流式输出的那一轮这里可能看不到。',
      };
    },
  },

  {
    name: 'agent_session_read',
    description:
      '读一条 g ai 会话的完整消息历史(user / assistant / 工具调用)。'
      + '消息是 OpenAI chat completions 格式。默认不带 system 提示词(很长且无信息量),需要时显式开。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '会话 id(从 agent_sessions_list 拿)' },
        limit: { type: 'integer', description: '最多返回多少条消息(从最后往前取),默认 40' },
        include_system: { type: 'boolean', description: '是否带上 system 提示词,默认 false' },
      },
      required: ['session_id'],
    },
    async handler(args) {
      const sessionId = asString(args?.session_id);
      if (!sessionId) return { error: '需要 session_id。先用 agent_sessions_list 拿到会话 id。' };
      const limit = asInt(args?.limit, 40, { min: 1, max: 400 });

      const file = path.join(AGENT_SESSIONS_DIR, `${sessionId}.json`);
      const data = await readJsonFile(file, null);
      if (!data) return { error: `找不到会话 ${sessionId}(已查 ${file})。` };

      let messages = Array.isArray(data.messages) ? data.messages : [];
      if (asString(args?.include_system) !== '' && args?.include_system === false) messages = messages.filter(m => m?.role !== 'system');
      if (args?.include_system !== true) messages = messages.filter(m => m?.role !== 'system');
      const sliced = messages.slice(-limit);

      return {
        source: 'file',
        file,
        session_id: data.sessionId || sessionId,
        title: data.title || '',
        cwd: data.cwd || '',
        engine: data.engine || null,
        model: data.model || null,
        total_messages: Array.isArray(data.messages) ? data.messages.length : 0,
        returned: sliced.length,
        omitted_older: Math.max(0, messages.length - sliced.length),
        messages: sliced.map(m => ({
          role: m?.role || '',
          content: truncate(typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''), 4000),
          tool_calls: Array.isArray(m?.tool_calls)
            ? m.tool_calls.map(c => ({ name: c?.function?.name || '', arguments: truncate(c?.function?.arguments || '', 600) }))
            : undefined,
          tool_call_id: m?.tool_call_id,
          name: m?.name,
        })),
      };
    },
  },

  {
    name: 'agent_skills_list',
    description:
      '列出 g ai 已安装的 Skill(技能包)。两级作用域:全局对所有项目生效,项目级只对那个目录生效,'
      + '同名时项目级覆盖全局。每项给出 SKILL.md 的绝对路径 —— 想看正文自己读那个文件。',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '同时列出这个项目的项目级 Skill(不传则只看全局)' },
      },
    },
    async handler(args) {
      const cwd = asString(args?.cwd);
      const globalSkills = await listSkillsIn(AI_SKILLS_DIR, 'global');
      const projectSkills = cwd ? await listSkillsIn(projectSkillsDir(cwd), 'project') : [];

      const projectIds = new Set(projectSkills.map(s => s.id));
      return {
        source: 'file',
        global_dir: AI_SKILLS_DIR,
        project_dir: cwd ? projectSkillsDir(cwd) : null,
        global_count: globalSkills.length,
        project_count: projectSkills.length,
        // 覆盖关系直接算好给模型,省得它自己比对
        shadowed_global_ids: globalSkills.filter(s => projectIds.has(s.id)).map(s => s.id),
        skills: [...projectSkills, ...globalSkills],
        note: 'g ai 只有终端入口(src/cli/ai/agent.js)会加载 Skill;Web 面板目前不加载(见项目记忆)。',
      };
    },
  },

  {
    name: 'agent_mcp_servers',
    description:
      '列出 g ai 配置的 MCP 服务(两级:全局与项目级,同名时项目级覆盖全局)。'
      + '只回命令名 / URL / 头部字段名,不回 env 与 headers 的值(那里通常有 token)。',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '同时列出这个项目的项目级配置(不传则只看全局)' },
      },
    },
    async handler(args) {
      const cwd = asString(args?.cwd);
      const globalCfg = await readMcpConfig(AI_MCP_FILE, 'global');
      const projectCfg = cwd ? await readMcpConfig(projectMcpFile(cwd), 'project') : null;

      const globalIds = new Set(globalCfg.servers.map(s => s.id));
      return {
        source: 'file',
        global_file: AI_MCP_FILE,
        project_file: cwd ? projectMcpFile(cwd) : null,
        global: globalCfg,
        project: projectCfg,
        overridden_global_ids: projectCfg
          ? projectCfg.servers.filter(s => globalIds.has(s.id)).map(s => s.id)
          : [],
      };
    },
  },

  {
    name: 'agent_ask',
    description:
      '让用户的 g ai 智能体在某个项目目录下真跑一轮对话,并把最终回答带回来。'
      + '适用场景:需要"用户自己的智能体"用它的工具链去查/改东西,而不是你自己一步步来。'
      + '⚠️ 需要 g ui 正在运行(真正跑 agent 的是它)。给 session_id 可以续接已有会话,不传则新开一条。',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '要问 / 要它做的事,完整的一句指令' },
        cwd: { type: 'string', description: '在哪个项目目录下跑,默认用调用方的当前目录' },
        session_id: { type: 'string', description: '可选,续接已有会话的 id' },
        timeout_seconds: { type: 'integer', description: '最长等多久,默认 300 秒' },
      },
      required: ['message'],
    },
    async handler(args, ctx) {
      const message = asString(args?.message);
      if (!message) return { error: '需要 message(要智能体做什么)。' };
      const cwd = asString(args?.cwd, ctx?.cwd || '');
      const sessionId = asString(args?.session_id);
      const timeoutSeconds = asInt(args?.timeout_seconds, 300, { min: 10, max: 1800 });

      const instance = await findLiveInstance({ cwd });
      if (!instance) {
        return { available: false, reason: '没有活着的 g ui 实例。' + NO_LIVE_INSTANCE_HINT };
      }

      let finalText = '';
      let thinking = '';
      let error = null;
      const toolCalls = [];

      const res = await liveSse(instance.url, '/api/agent/chat', {
        body: {
          userMessage: message,
          sessionId: sessionId || undefined,
          cwd: cwd || undefined,
          locale: String(ctx?.locale || 'zh'),
        },
        timeoutMs: timeoutSeconds * 1000,
        onEvent(payload) {
          switch (payload?.type) {
            case 'content': finalText += payload.delta || ''; break;
            case 'thinking': thinking += payload.delta || ''; break;
            case 'tool_call_start':
              toolCalls.push({ name: payload.name || '', args: String(payload.argsPreview || '').slice(0, 300) });
              break;
            case 'error': error = payload.error || '未知错误'; break;
            case 'done':
              if (typeof payload.content === 'string' && payload.content) finalText = payload.content;
              return false; // 拿到 done 立刻停,不要等流自己关
            default: break;
          }
          return true;
        },
      });

      // ⚠️ `ran` 必须反映"这一轮真的跑完了",不能无条件为 true。
      // 流建立失败(实例在但端口打不通 / 超时)时,如果把 ran 写成 true,模型会以为
      // 拿到了回答并据此继续 —— 那是最坏的一种失败:静默地编。所以这里只有在
      // 流正常消费完**且**没有 agent 级错误时才算跑过。
      const completed = res.ok && !error;

      return {
        source: 'live',
        from: describeInstance(instance),
        ran: completed,
        cwd: cwd || null,
        session_id: sessionId || null,
        stream_ok: res.ok,
        stream_error: res.error || null,
        agent_error: error,
        tool_calls: toolCalls.slice(0, 30),
        thinking_tail: thinking ? truncate(thinking.slice(-2000), 2000, 2000) : undefined,
        answer: finalText.trim() || '',
        note: completed
          ? undefined
          : '⚠️ 这一轮**没有正常跑完**,上面的 answer 不完整,不要当成已回答。'
            + '让用户确认 g ui 还活着(它可能刚退出),再重试。',
      };
    },
  },
];
