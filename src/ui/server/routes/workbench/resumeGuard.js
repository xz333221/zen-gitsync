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

// 续聊前的工作目录一致性检查（纯函数，单测见 resumeGuard.test.js）。
//
// 背景（2026-11-08 实测事故）：任务被「移动到其他项目」之后 task.projectPath 换了新目录
// （那条端点只改这一个字段，见 index.js §11 的注释），而历史轮次的会话是在旧目录下创建的。
// 五家 CLI 的会话库都按 cwd 索引，跨目录的旧 id 谁都不认：
//   · codebuddy / claude → ~/.codebuddy/projects/<转义 cwd>/<session>.jsonl（两者同构）
//   · opencode / codex / pi → 各自按项目或线程索引，同样不跨目录
// 于是续聊 spawn 到新 cwd、拿旧 session id 去 resume，CLI 只回一条
// `{"type":"error","error":"No conversation found with session ID: …"}`（退出码还是 0），
// 用户看到的就是"对话区忽然断在这里，只剩一句英文报错"。
//
// 这里只判"能不能续"，不做自动修复：跨 cwd 续聊在 CLI 层面本来就没有解，
// 猜一个 cwd 去 spawn 只会把这一轮跑进错误的仓库（那比报错更难查）。
// 明确告诉用户"重新执行开一轮新的"才是这个场景下的正确出口。

import { canonicalProjectPath } from './projectRegistry.js';

/**
 * 上一轮的 cwd 与这一轮要用的 cwd 不同 → 返回给用户看的中文提示；一致或无法判断 → null。
 *
 * "无法判断"有两种，都放行让 CLI 自己报：
 *   · `prevCwd` 为空 —— 2026-11-08 之前落库的老 job 没有这个字段；
 *   · `repoPath` 为空 —— 调用方没解析出工作目录（老任务还没绑定项目）。
 *
 * @param {string} prevCwd  上一轮 job 的 cwd（job.cwd，落库字段见 liveJobs.projectJob）
 * @param {string} repoPath 这一轮要 spawn 的工作目录（resolveTaskRepoPath 的结果）
 * @returns {string|null}
 */
export function resumeCwdConflict(prevCwd, repoPath) {
  const prev = canonicalProjectPath(prevCwd);
  const next = canonicalProjectPath(repoPath);
  if (!prev || !next || prev === next) return null;
  const from = String(prevCwd).trim();
  const to = String(repoPath).trim();
  return `无法续接：上一轮的会话是在「${from}」下创建的，这个任务现在的工作目录是「${to}」。`
    + '移动过项目的任务接不上旧会话（CLI 的会话库按工作目录分开存）—— 请重新执行任务，开一轮新的会话。';
}

/**
 * 「移动到其他项目」的成功提示（有历史轮次时由前端以 warning 样式弹出）。
 *
 * 移动本身是合法且可逆的动作，不该被拦；但它的**副作用**只有续聊时才会暴露，
 * 所以在动作完成的那一刻就把话说清楚，而不是等用户在对话区踩到英文报错。
 */
export const MOVE_BREAKS_RESUME_HINT =
  '已移动到新项目。这个任务之前的轮次是在原项目目录下跑的，工作目录变了，那些轮次不能再续接 —— 想继续就把任务重新执行一轮。';
