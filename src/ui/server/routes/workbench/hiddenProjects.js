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
// 「用户从工作台清单里移除掉的死项目」——一份很小的落盘名单。
//
// 为什么需要它（而不是只从常用目录里删掉那一条就完事）：
//   项目清单是**两份来源的并集**（projectRegistry.buildProjectEntries）——
//   config.json 的 recentDirectories，加上 tasks.json 里任务自带的 projectPath。
//   一个目录被删/被移走之后，只删常用目录那一份通常**根本不会让这行消失**：
//   只要还有任务记着这个路径，它照样从任务那半边被重新生成（实测用户点完删除，
//   那行原地不动 —— 看起来就像按钮坏了）。想让它真正从清单里走掉，
//   就必须有一份"用户明确表示不要看见它"的记录。
//
// 为什么不改任务（把 projectPath 清空）来达到同样效果：
//   那是把**一条会失败的事实改成一条会静默成功的事实**。任务带着一个不存在的目录时，
//   执行会当场报「项目目录不存在」；清空之后 resolveTaskRepoPath 会回退到当前项目，
//   于是"点执行 → 代码改到了另一个仓库里"，而界面上没有任何提示。
//   projectRegistry.js 开头那段注释把这个回退称为"比直接报错危险得多"，这里不能自己破它。
//   隐藏只动"看不看得见"，一条任务、一个 job、一份历史都不碰。
//
// 为什么只在目录**仍然不存在**期间隐藏（filterHiddenProjects 的第二个条件）：
//   目录哪天被重新克隆回来了，这一行就该自己回来 —— 用户没有永久放弃这个项目，
//   只是清掉了一条死条目。没有这条自愈，用户就得手动把隐藏名单清一次才能再见它。

import { HIDDEN_PROJECTS_FILE, readJson, writeJson } from './shared.js';

/** 上限：只可能积累"被删掉的死目录"，几十条足够。满了丢最旧的（下面 unshift 的顺序即新旧） */
export const MAX_HIDDEN_PROJECTS = 200;

/**
 * 读隐藏名单。文件不存在 / 读失败 / 结构不对，一律当"没藏过任何项目"——
 * 这是纯展示层的偏好，坏了最多回到"死目录又出现在清单里"的原状，
 * 绝不能因此让 /api/workbench/projects 整个 500（它是 5s 轮询的）。
 *
 * @returns {Promise<string[]>} canonicalProjectPath 之后的项目 key
 */
export async function readHiddenProjects() {
  try {
    const data = await readJson(HIDDEN_PROJECTS_FILE, { projects: [] });
    const list = Array.isArray(data?.projects) ? data.projects : [];
    return list.filter(k => typeof k === 'string' && k);
  } catch {
    return [];
  }
}

/**
 * 记下一个被移除的项目（幂等）。
 * @returns {Promise<string[]>} 落盘后的名单
 */
export async function hideProject(key) {
  if (typeof key !== 'string' || !key) return readHiddenProjects();
  const current = await readHiddenProjects();
  const next = [key, ...current.filter(k => k !== key)].slice(0, MAX_HIDDEN_PROJECTS);
  await writeJson(HIDDEN_PROJECTS_FILE, { projects: next });
  return next;
}

/**
 * 从项目清单里滤掉"藏起来且目录仍然不存在"的那几条。纯函数，单测覆盖。
 *
 * @param {Array<{key: string, exists: boolean|null}>} projects listProjects 的产物
 * @param {Iterable<string>} hidden readHiddenProjects 的结果
 * @returns {Array} 原样返回入参里的条目（不复制、不改字段），只调整顺序与数量
 *
 * `exists === null`（没探到）**不隐藏**：那是"不知道"，不是"用户不要看"。
 * 按 `=== false` 判，与 projectRegistry 输出的三态口径一致。
 */
export function filterHiddenProjects(projects, hidden) {
  const set = hidden instanceof Set ? hidden : new Set(Array.isArray(hidden) ? hidden : []);
  if (set.size === 0) return Array.isArray(projects) ? projects : [];
  return (Array.isArray(projects) ? projects : []).filter(
    p => !(p && set.has(p.key) && p.exists === false),
  );
}

