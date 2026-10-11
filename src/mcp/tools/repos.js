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
// 板块一:GitHub / Gitee 仓库 + 本机已克隆仓库。
//
// ⚠️ 一个刻意的设计选择:远程仓库**不自己调 gh/gitee CLI**。
// 原因在 src/ui/server/routes/remoteRepos.js:560-566 的注释里写着 ——
// 那份判断里全是踩过的坑(CLI 不在 PATH 时的三处兜底路径、gitee 未登录时
// **退出码仍是 0**、CLICOLOR_FORCE 让 --json 输出带色码、超时只回空列表不抛),
// "抄成第二份迟早分叉 —— 而分叉的表现是'界面说未登录、模型说你有 65 个仓库'"。
//
// 所以这里两条路,都不重复实现:
//   1) 有活着的 g ui → GET /api/remote-repos?provider=X(与界面**完全同源**)
//   2) 没有 → 读 ai-context/remote-<provider>.md 快照,并明确标注"这是快照"
// 本机已克隆仓库那份 `local-repos.json` 就是纯 JSON,直读没有分叉风险。
import path from 'node:path';

import { AI_CONTEXT_DIR, LOCAL_REPOS_FILE } from '../paths.js';
import { findLiveInstance, liveFetch, describeInstance, NO_LIVE_INSTANCE_HINT } from '../live.js';
import { readJsonFile, readTextFile, truncate, asString } from '../util.js';

const PROVIDERS = ['github', 'gitee'];
const DEFAULT_REPO_LIMIT = 30;

/** 统一把 repo 列表收敛成"够模型读"的字段,别把 200 个仓库的全部字段原样塞出去。 */
function projectRepo(repo) {
  if (!repo || typeof repo !== 'object') return null;
  return {
    name: repo.fullName || repo.nameWithOwner || repo.full_name || repo.name || '',
    description: repo.description || '',
    private: repo.private === true || repo.isPrivate === true,
    language: repo.language || repo.primaryLanguage?.name || repo.primaryLanguage || null,
    stars: Number(repo.stars ?? repo.stargazerCount ?? repo.stargazers_count ?? 0) || 0,
    forks: Number(repo.forks ?? repo.forkCount ?? repo.forks_count ?? 0) || 0,
    defaultBranch: repo.defaultBranch || repo.default_branch || null,
    updatedAt: repo.updatedAt || repo.updated_at || null,
    url: repo.url || repo.html_url || '',
  };
}

export const repoTools = [
  {
    name: 'repos_list',
    description:
      '列出用户在 GitHub 或 Gitee 账号下托管的所有仓库(名称、描述、可见性、语言、star、默认分支、最近更新时间)。'
      + '数据来自正在运行的 g ui(与界面同源);若 g ui 没开,退回工作区快照(可能滞后,结果里会标注)。'
      + '只看本机已经克隆下来的仓库请用 repos_local_clones。',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: PROVIDERS, description: 'github 或 gitee,默认 github' },
        query: { type: 'string', description: '可选,按仓库名/描述做不区分大小写的子串过滤' },
        limit: { type: 'integer', description: `最多返回多少条,默认 ${DEFAULT_REPO_LIMIT}` },
        cwd: { type: 'string', description: '可选,用于挑选项目匹配的 g ui 实例' },
      },
    },
    async handler(args, ctx) {
      const provider = PROVIDERS.includes(String(args?.provider || '').toLowerCase())
        ? String(args.provider).toLowerCase()
        : 'github';
      const limit = Math.min(Math.max(Number(args?.limit) || DEFAULT_REPO_LIMIT, 1), 300);
      const query = asString(args?.query).toLowerCase();
      const cwd = asString(args?.cwd, ctx?.cwd || '');

      const filter = repos => {
        const list = Array.isArray(repos) ? repos.map(projectRepo).filter(Boolean) : [];
        const hit = query
          ? list.filter(r => `${r.name} ${r.description}`.toLowerCase().includes(query))
          : list;
        return { matched: hit.length, list: hit.slice(0, limit) };
      };

      // 路线 1:活实例(与界面同源)
      const instance = await findLiveInstance({ cwd });
      if (instance) {
        const res = await liveFetch(instance.url, `/api/remote-repos?provider=${encodeURIComponent(provider)}`, { timeoutMs: 40_000 });
        if (res.ok && res.payload) {
          const p = res.payload;
          const { matched, list } = filter(p.repos);
          return {
            source: 'live',
            from: describeInstance(instance),
            provider,
            cli: p.cli,
            installed: p.installed !== false,
            authenticated: p.authenticated === true,
            user: p.user || null,
            version: p.version || null,
            total: Array.isArray(p.repos) ? p.repos.length : 0,
            matched,
            truncated: p.truncated === true || matched > list.length,
            repos: list,
            error: p.error || null,
          };
        }
        // 活实例在但这次没答上来 —— 退回快照,并把这个失败记在结果里
        const fallback = await snapshotFor(provider, { limit, query, filter });
        return {
          ...fallback,
          live_attempt_error: res.error || `HTTP ${res.status}`,
          note: `尝试从 ${describeInstance(instance)} 取实时数据失败,已退回快照。`,
        };
      }

      // 路线 2:没有活实例 → 快照
      return snapshotFor(provider, { limit, query, filter });
    },
  },

  {
    name: 'repos_local_clones',
    description:
      '列出本机全盘扫描到的、已克隆的 Git 仓库(路径 → origin 远端地址),用于判断"某个远程仓库我本地有没有"。'
      + '直读缓存文件,不需要 g ui 在跑;缓存有 10 分钟 TTL,结果里会给出扫描时间。',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      const data = await readJsonFile(LOCAL_REPOS_FILE, null);
      if (!data || typeof data !== 'object') {
        return {
          source: 'file',
          available: false,
          note: `还没有本地仓库扫描结果(${LOCAL_REPOS_FILE} 不存在)。g ui 启动后会后台扫一次,或让用户在界面上点一次刷新扫描。`,
        };
      }
      const repos = data.repos && typeof data.repos === 'object' ? data.repos : {};
      const entries = Object.entries(repos).map(([dir, originUrl]) => ({
        name: path.basename(dir),
        path: dir,
        origin: originUrl || null,
      }));
      const scannedAt = Number(data.scannedAt) || 0;
      return {
        source: 'file',
        file: LOCAL_REPOS_FILE,
        scanned_at: scannedAt ? new Date(scannedAt).toISOString() : null,
        age_minutes: scannedAt ? Math.round((Date.now() - scannedAt) / 60_000) : null,
        count: entries.length,
        roots: Array.isArray(data.roots) ? data.roots : [],
        repos: entries,
        note: 'origin 为 null 表示那个目录是个 git 仓库但没有配置远端。',
      };
    },
  },
];

/** 没有活实例时的降级:读 ai-context 的 remote-<provider>.md 快照。 */
async function snapshotFor(provider, { limit, query, filter }) {
  const file = path.join(AI_CONTEXT_DIR, `remote-${provider}.md`);
  const md = await readTextFile(file, '');
  if (!md.trim()) {
    return {
      source: 'file',
      available: false,
      provider,
      note: '没有活着的 g ui,也没有工作区快照,因此拿不到远程仓库列表。' + NO_LIVE_INSTANCE_HINT,
    };
  }
  return {
    source: 'file',
    available: true,
    provider,
    snapshot_file: file,
    note: '这是 g ui 渲染的工作区快照(不是实时值)。要看某个仓库的实时详情,'
      + '让用户跑 `gh repo view <owner/repo>` 或启动 g ui 后重调本工具。',
    query: query || null,
    limit,
    // 快照是 markdown,不做结构化过滤 —— 但把 query 交回给模型,让它自己读时留意
    snapshot: truncate(md, 12_000),
    _filter_used: typeof filter === 'function',
  };
}
