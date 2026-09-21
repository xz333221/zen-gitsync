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
// zen-gitsync 全部本地数据路径的**唯一真相源**。
//
// 背景(2026-09-18):此前数据散在用户主目录下的三套命名前缀里 ——
//   ~/.git-commit-tool.json          主配置(项目改名前 commit-tool 的遗留名)
//   ~/.git-commit-tool.json.bak      写盘前的全量备份
//   ~/.git-commit-tool/ai-images/    CLI 贴图(注意:又是个不带 .json 的名字)
//   ~/.zen-gitsync-instances/        实例心跳目录
//   ~/.zen-gitsync-instances.json    心跳的旧版单文件(本机被误建成了目录,见 dataDirMigration)
//   ~/.zen-gitsync/                  工作台数据(唯一收敛好的)
// 用户视角就是"不知道哪个是哪个的文件",而且同一个路径被 6 个模块各自拼了一遍。
// 现在统一:所有数据都收进 DATA_DIR,历史路径只保留"一次性迁移 + 只读回退"用途。
//
// ⚠️ 这里的常量在模块加载时由 os.homedir() 求值(与原有各模块一致)。
// 测试靠"import 之前改写 USERPROFILE/HOME"来沙箱隔离,所以不要在调用期重新求值 ——
// 那会让沙箱逻辑在部分模块失效。
import os from 'node:os';
import path from 'node:path';

// 数据根目录:所有持久化数据都在这个目录下,不再往主目录散落文件
export const DATA_DIR = path.join(os.homedir(), '.zen-gitsync');

// ── 主配置 ────────────────────────────────────────────────────
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const CONFIG_BACKUP_FILE = path.join(DATA_DIR, 'config.json.bak');
// 旧路径(改名前的 g / commit-tool):仅用于一次性迁移与迁移失败时的只读回退
export const LEGACY_CONFIG_FILE = path.join(os.homedir(), '.git-commit-tool.json');
export const LEGACY_CONFIG_BACKUP_FILE = path.join(os.homedir(), '.git-commit-tool.json.bak');

// ── 配置分文件存储(2026-09-18 第二轮) ─────────────────────────
// config.json 里的 projects 占全文件 93%(605KB 中的 563KB),而其中 82% 是画布
// flowData。任何一次琐碎写入(改主题 / 拖布局比例 / 记最近目录)都要重写整份
// 605KB 并全量复制一份 .bak,于是拆成:
//   config.json                        全局(theme/locale/models/ui/recentDirectories)
//   projects/<fileId>.json             单项目配置(不含 orchestrations)
//   orchestration/<fileId>/<orchId>.json   每条画布一个文件
// 读写仍由 src/config.js + src/configSplit.js 包成"旧的单对象形状",调用点无感。
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
export const ORCHESTRATION_DIR = path.join(DATA_DIR, 'orchestration');
// 分文件迁移标记:存在且 config.json 里没有内联 projects 才算已拆分。
// 两者都要看 —— 用户可能从备份恢复了旧的内联版本,那时需要重新拆一遍。
export const SPLIT_MIGRATION_MARKER = path.join(DATA_DIR, '.split-migrated');

// ── 实例注册表(每进程一个心跳文件) ────────────────────────────
export const INSTANCES_DIR = path.join(DATA_DIR, 'instances');
export const LEGACY_INSTANCES_DIR = path.join(os.homedir(), '.zen-gitsync-instances');
// 更早的单文件注册表。**它的内容迁移归 instanceRegistry.migrateLegacy() 所有**,
// 这里只登记路径,不参与搬迁。
export const LEGACY_INSTANCES_FILE = path.join(os.homedir(), '.zen-gitsync-instances.json');

// ── CLI 贴图 ─────────────────────────────────────────────────
export const AI_IMAGES_DIR = path.join(DATA_DIR, 'ai-images');
// 旧的是 ~/.git-commit-tool/ai-images(父目录名与主配置不同,少了个 .json)
export const LEGACY_HOME_DIR = path.join(os.homedir(), '.git-commit-tool');
export const LEGACY_AI_IMAGES_DIR = path.join(LEGACY_HOME_DIR, 'ai-images');

// ── g ai 智能体的全局扩展(2026-09-21 新增) ────────────────────
// 智能体页面的「Skill 广场 / MCP 广场」有两个安装目标:
//   1) 当前项目 → <cwd>/.claude/skills/<id>/ 与 <cwd>/.mcp.json(生态既有约定,别的工具也认)
//   2) g ai 智能体(全局) → 下面这两个路径,对**所有**项目生效
// 目录形状刻意与 .claude/skills 保持一致(每个 skill 一个子目录,内含 SKILL.md),
// 这样 src/cli/ai/skills.js 可以用同一套解析逻辑读两处。
export const AI_SKILLS_DIR = path.join(DATA_DIR, 'ai', 'skills');
// MCP 服务定义。键名与内容沿用 Claude 的 mcpServers 形状,
// 与项目里的 <cwd>/.mcp.json 可以直接合并(项目级覆盖全局同名 server)。
export const AI_MCP_FILE = path.join(DATA_DIR, 'ai', 'mcp.json');

// ── 工作台 / 会话 / 缓存 ──────────────────────────────────────
export const WORKBENCH_IMAGES_DIR = path.join(DATA_DIR, 'workbench-images');
export const AGENT_SESSIONS_DIR = path.join(DATA_DIR, 'agent-sessions');
export const SPLIT_SESSIONS_DIR = path.join(DATA_DIR, 'ai-split-sessions');
export const AI_DIFF_SUMMARIES_DIR = path.join(DATA_DIR, 'ai-diff-summaries');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');

// 布局迁移标记 + 迁移期发现的垃圾的留档目录(不直接删,便于回溯)
export const LAYOUT_MIGRATION_MARKER = path.join(DATA_DIR, '.layout-migrated');
export const MIGRATION_BACKUP_DIR = path.join(DATA_DIR, '_legacy-cleanup');
