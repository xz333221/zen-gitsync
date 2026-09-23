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
// 仓库地址的形态换算。两个方向,都是"把地址换个说法":
//   toSshUrl  —— 仓库页地址(HTTPS) → SSH 克隆地址,给「复制 SSH 地址」与
//                「克隆到文件夹」用;
//   toRepoKey —— 任意写法(HTTPS / ssh:// / scp-like) → 归一化标识
//                `host/owner/repo`,用来回答"这两处说的是不是同一个仓库"
//                (远程仓库列表的「已克隆」徽标)。
//
// 为什么在前端算而不是向后端要:`gh repo list --json` 有 sshUrl 字段,但 gitee
// 的 --json 字段集不一定有,靠它会让两个平台的行为不一致;而仓库页地址的形态
// 在两处都是固定的 `https://<host>/<owner>/<repo>`,规则足够简单。
// 另外把它单独放一个模块是为了只有一份实现 —— 之前它写在组件里,
// 克隆那条链路要用就只能复制一遍。

/**
 * `https://<host>/<owner>/<repo>` → `git@<host>:<owner>/<repo>.git`
 *
 * 解析不出来(非 http(s)、路径为空)返回空串,调用方据此不渲染按钮 ——
 * 宁可少给一个入口,也不给一个错的地址。
 */
export function toSshUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";

  const repoPath = parsed.pathname
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  if (!repoPath) return "";

  return `git@${parsed.host}:${repoPath}.git`;
}

/**
 * 仓库地址 → 归一化标识 `host/owner/repo`（全小写）。
 *
 * 用来回答"这两个地址说的是不是同一个仓库"：远程仓库列表拿到的是仓库页地址
 * （`https://gitee.com/xz_web/xiangqi`），而本地仓库的 origin 可能是 SSH
 * （`git@gitee.com:xz_web/xiangqi.git`）、也可能带 `.git` 后缀或结尾斜杠。
 * 三种写法要能对上，同一个仓库的地址在不同平台/协议下才不会各算一份。
 *
 * 比的是 host + 前两段路径：`https://gitee.com/owner/repo/tree/main` 这种带
 * 子路径的地址，指的仍然是同一个仓库。解析不出来返回空串 —— 调用方据此判定
 * "对不上"，不会拿半个地址去误配。
 */
export function toRepoKey(url: string): string {
  const raw = typeof url === "string" ? url.trim() : "";
  if (!raw) return "";

  let host = "";
  let repoPath = "";

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    // 带协议头：交给 URL 解析，`https://host/a/b` 与 `ssh://git@host/a/b`
    // 都会落到 hostname + pathname
    try {
      const parsed = new URL(raw);
      host = parsed.hostname;
      repoPath = parsed.pathname;
    } catch {
      return "";
    }
  } else {
    // scp-like：`[user@]host:path`。冒号后必须不是 `/`，否则 `host://…`
    // 会被当成路径开头
    const scp = raw.match(/^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/);
    if (!scp) return "";
    host = scp[1];
    repoPath = scp[2];
  }

  const segments = repoPath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);
  if (!host || segments.length < 2) return "";

  return `${host.toLowerCase()}/${segments[0].toLowerCase()}/${segments[1].toLowerCase()}`;
}
