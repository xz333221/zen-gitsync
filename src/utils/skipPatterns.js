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
// 「哪些文件/目录不进 AI 上下文」的唯一口径。
//
// 这份清单此前有三处副本：src/aiCommit.js、src/ui/server/routes/config.js
// （两份逐字相同的 18 条正则），以及 src/ui/server/routes/npm.js 里同一个文件
// 内的两份 IGNORED_DIRS。三处各自维护的后果不是「多写几行」，而是**不对称地漏**：
// 加个 .turbo 只改了 AI 提交这边，npm 扫描那边照旧钻进去遍历几万文件。
//
// 两类规则语义不同，别混着用：
//   · SKIP_FILE_PATTERNS —— 按**完整相对路径**匹配，用于「这个文件要不要进 diff」
//   · SCAN_IGNORED_DIRS  —— 按**目录名**精确匹配，用于递归遍历时剪枝

/** 文件级：产物 / 资源 / lock 文件，命中就不打 patch、不进 AI diff。 */
export const SKIP_FILE_PATTERNS = [
  /(^|[\\/])dist[\\/]/,
  /(^|[\\/])build[\\/]/,
  /(^|[\\/])\.next[\\/]/,
  /(^|[\\/])coverage[\\/]/,
  /(^|[\\/])node_modules[\\/]/,
  /\.lock$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /min\.js$/,
  /min\.css$/,
  /\.bundle\.js$/,
  /\.map$/,
  /\.(png|jpe?g|gif|webp|svg|ico|bmp|tiff)$/,
  /\.(mp4|mov|avi|mkv|webm)$/,
  /\.(mp3|wav|ogg|flac)$/,
  /\.(woff2?|ttf|otf|eot)$/,
  /\.(pdf|zip|tar|gz|7z|rar)$/
];

/** 目录级：递归扫描 package.json 之类时整支跳过（点目录另有 startsWith('.') 兜底）。 */
export const SCAN_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'coverage',
  'out',
  'target',
  'vendor',
  '__pycache__',
  '.next',
  '.nuxt',
  '.vscode',
  '.idea',
  'tmp',
  'temp',
  'cache',
  '.cache'
]);

/** 文件是否该跳过（产物 / 资源 / lock）。 */
export function isSkippedFile(filePath) {
  return SKIP_FILE_PATTERNS.some((re) => re.test(filePath));
}
