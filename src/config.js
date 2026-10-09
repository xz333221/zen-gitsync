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
import { promises as fs } from 'fs';
import path from 'path';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { CONFIG_FILE } from './paths.js';
import { migrateDataDir } from './dataDirMigration.js';
import { atomicWriteText } from './fsAtomic.js';
// 请求预算的口径（默认值 / 规范化 / 解析公式）住在 cli/ai/context.js —— 那里是
// "每轮请求怎么裁剪"的唯一实现，config.js 只负责把它接到配置项上，不复制公式。
import { normalizeAiRequestTokens, migrateLegacyCharsToTokens, REQUEST_DEFAULT_MAX_TOKENS } from './cli/ai/context.js';
import {
  ensureSplitStore,
  readSplitProjects,
  writeSplitStore,
  deleteProjectConfig,
  isSplitActive,
  splitMarkerExists,
} from './configSplit.js';

// 当前生效的配置文件路径。默认是统一数据目录下的 ~/.zen-gitsync/config.json;
// 只有历史文件搬迁失败(被占用/无权限)时才回退到旧的 ~/.git-commit-tool.json,
// 让应用至少还能以只读方式跑起来,下次启动再试迁移。
let configPath = CONFIG_FILE;
let _configPathReady = null;

/**
 * 确保配置文件已就位(必要时执行一次性数据目录迁移),返回实际使用的路径。
 * 惰性执行且只跑一次;迁移内部不抛错,这里的 catch 只是最后一道保险。
 */
function resolveConfigPath() {
  if (!_configPathReady) {
    _configPathReady = migrateDataDir()
      .then((report) => {
        if (report?.configPath) configPath = report.configPath;
        return configPath;
      })
      .catch(() => configPath);
  }
  return _configPathReady;
}

// AI 智能体单轮工具调用上限的可调范围。
// 下限 1 是为了保留"防失控"语义 —— 0 会让智能体一动手就停,没人是这个意图;
// 上限 10000 只防"手改配置写成天文数字"这种明显笔误,不再当成额度保护 ——
// 真要烧光额度,单轮本来就该由用户自己在设置里选的大小负责(2026-10-03: 2000 → 10000)。
const AI_MAX_TOOL_ITERATIONS_MIN = 1;
const AI_MAX_TOOL_ITERATIONS_MAX = 10000;

/**
 * 规范化单轮最大工具调用次数。
 *
 * 非法值(非数字 / NaN / 越界)一律**夹取**到合法区间而不是回退默认值 ——
 * 用户手改成 50000 的意图明显是"想更大",夹到上限比悄悄退回默认小值更贴近意图。
 * 完全无法解析(undefined / 'abc')才返回 null,交给调用方取默认值。
 */
function normalizeAiMaxToolIterations(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const int = Math.floor(n);
  if (int < AI_MAX_TOOL_ITERATIONS_MIN) return AI_MAX_TOOL_ITERATIONS_MIN;
  if (int > AI_MAX_TOOL_ITERATIONS_MAX) return AI_MAX_TOOL_ITERATIONS_MAX;
  return int;
}

// 工作台任务执行器白名单。'claude' 是历史默认；'opencode' / 'codex' 为可选执行器
// （opencode run --format json / codex exec --json，模型都跟随各自 CLI 的配置）。
export const TASK_EXECUTORS = ['claude', 'opencode', 'codex'];

/**
 * 规范化任务执行器。非法值返回 null（交给调用方取默认），不抛错 ——
 * 与 normalizeAiMaxToolIterations 同一套"夹取/兜底"语义。
 */
export function normalizeTaskExecutor(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return TASK_EXECUTORS.includes(v) ? v : null;
}

/**
 * 解析请求上下文预算的 token 值（2026-10-07 字符口径 → token 口径）。
 *
 * 新字段 `aiMaxRequestTokens` 优先；读不到才从**旧字段** `aiMaxRequestChars`
 * 迁移。为什么必须迁移而不是直接回落默认：用户磁盘上的 config.json 已经存着
 * 旧值（本机是 80,000 字符），改字段名后它读不到 → 静默变成 1,000,000 token，
 * 等于把用户的设置清了一轮。迁移是有损的（估算换算），但只发生一次，
 * 且落在用户原意附近。
 *
 * ⚠️ 旧字段**故意不清除**：清了就等于给不出迁移（用户下次读配置时新字段还没写，
 * 旧值已经没了）。代价是"删掉 aiMaxRequestTokens 想回默认"的人会拿到迁移值
 * 而不是默认值 —— 这是**一次性**的错位（保存一次全局设置就会把新字段写上），
 * 比静默清空用户设置好得多。
 */
function resolveRequestTokens(raw) {
  const direct = normalizeAiRequestTokens(raw?.aiMaxRequestTokens);
  if (direct !== null) return direct;
  const migrated = migrateLegacyCharsToTokens(raw?.aiMaxRequestChars);
  if (migrated !== null) return normalizeAiRequestTokens(migrated);
  return defaultConfig.aiMaxRequestTokens;
}

/**
 * 规范化「任务/对话结束提示」的通道开关（页面提示 / 浏览器通知 / 提示音共用）。
 * 只接受布尔值，其它类型返回 null（交给调用方取默认），不抛错 —— 与
 * normalizeTaskExecutor 同一套语义。
 *
 * 为什么不做 `!!value`：这个值控制是否弹提示条、是否弹浏览器系统通知，
 * `'false'` 这种字符串被强转成 true 之后用户会在设置里明明关着却照样被弹，
 * 且落盘后一直错下去。
 */
export function normalizeNotifySwitch(value) {
  return typeof value === 'boolean' ? value : null;
}

// 「预设提示词」（智能体视图欢迎页的快捷卡片）的上限。
// 只防"手改配置把 UI/请求写爆"，不是产品硬约束：卡片区是自适应网格，
// 12 条在常见窗口里已经铺满；label 上限覆盖"一句话标题"，prompt 上限
// 覆盖"一段能把要求说全的指令"。
const AGENT_PRESET_PROMPTS_MAX = 12;
const AGENT_PRESET_LABEL_MAX = 60;
const AGENT_PRESET_PROMPT_MAX = 4000;

/**
 * 规范化「预设提示词」数组（全局配置，跨项目共享）。
 *
 * 语义约定（2026-10-09 新增）：
 *   · undefined / null  → null（没配过，调用方回落 defaultConfig，即内置 5 条）
 *   · []                → []（**合法值**：显式"恢复内置默认"就是这个表达）
 *   · 非数组 / 任一条目结构坏 → null（整体拒绝：宁可整组回落内置，也不生成
 *     "点了没反应"的半截卡片。UI 保存前会防呆，这条主要兜手改 config.json）
 *   · 正常数组 → 清洗后的副本：trim、去重/补 id、超长截断、超条数截断
 *     （超量与超长属于"手笔太大"，夹取比整组丢掉更贴近用户意图，
 *     与 normalizeAiMaxToolIterations 的越界夹取同一套语义）
 */
export function normalizeAgentPresetPrompts(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return null;
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : '';
    if (!label || !prompt) return null;
    let id = typeof item.id === 'string' ? item.id.trim() : '';
    // id 缺失或重复都无伤大雅（前端只拿它当 v-for key），补一个稳定且唯一的即可；
    // 真正需要拒绝的是 label/prompt 缺失 —— 那会让卡片点了没反应。
    if (!id || seen.has(id)) {
      let n = out.length + 1;
      id = `preset-${n}`;
      while (seen.has(id)) id = `preset-${++n}-${Math.random().toString(36).slice(2, 5)}`;
    }
    seen.add(id);
    out.push({
      id,
      label: label.slice(0, AGENT_PRESET_LABEL_MAX),
      prompt: prompt.slice(0, AGENT_PRESET_PROMPT_MAX),
    });
    // 超出上限的部分直接放弃检查（反正要截断），避免为"手滑粘贴 500 条"做无谓校验
    if (out.length >= AGENT_PRESET_PROMPTS_MAX) break;
  }
  return out;
}

/**
 * 三个提示通道（页面提示 / 浏览器通知 / 提示音）的最终取值。
 *
 * 2026-10-05 之前只有「总开关 notifyOnTaskDone + 从属的提示音 notifySoundOnTaskDone」，
 * 浏览器通知没有自己的开关 —— 前台弹 toast、后台发系统通知是自动二选一，而且页面内
 * 首次点击会自动申请通知权限。用户反馈"每次开 GUI 都弹授权框"（默认开 + 自动申请 =
 * 一个从没要过系统通知的人被反复打扰），且想要的三件事本来就该分开配。
 *
 * 现在三个键平级、各自独立，默认值：页面提示开、提示音开、**浏览器通知关**。
 * 权限只在用户把浏览器通知拨开的那一刻申请（见设置页的 onBrowserNotifyToggleChange）。
 *
 * 旧键 notifyOnTaskDone 只作为**迁移输入**读一次：磁盘上显式 false 且新键都没写过
 * → 三个通道全关（尊重"我以前就是关掉的"，别让老用户升级后被突然弹一脸）。
 * 它不再被写入，也不再是任何东西的前置条件 —— 三通道之间没有从属关系。
 */
function resolveNotifySwitches(raw) {
  const page = normalizeNotifySwitch(raw?.notifyPageOnTaskDone);
  const browser = normalizeNotifySwitch(raw?.notifyBrowserOnTaskDone);
  const sound = normalizeNotifySwitch(raw?.notifySoundOnTaskDone);
  const legacyAllOff = raw?.notifyOnTaskDone === false;
  return {
    notifyPageOnTaskDone: page ?? (legacyAllOff ? false : defaultConfig.notifyPageOnTaskDone),
    notifyBrowserOnTaskDone: browser ?? (legacyAllOff ? false : defaultConfig.notifyBrowserOnTaskDone),
    notifySoundOnTaskDone: sound ?? (legacyAllOff ? false : defaultConfig.notifySoundOnTaskDone),
  };
}

// 默认配置
const defaultConfig = {
  defaultCommitMessage: "submit",
  descriptionTemplates: [],  // 添加描述模板数组
  scopeTemplates: [],
  messageTemplates: [],
  commandTemplates: [
    'echo "{{cmd}}"',
    'npm run dev',
    'npm run build',
    'git status',
    'git add .',
    'git commit -m "{{message}}" --no-verify',
    'git push',
  ],
  lockedFiles: [],  // 添加锁定文件数组
  customCommands: [],  // 添加自定义命令数组
  orchestrations: [],
  startupItems: [],  // 添加项目启动项数组
  startupAutoRun: false,  // 添加启动项自动执行开关
  afterQuickPushAction: {
    enabled: false,
    type: 'command',
    refId: ''
  },
  currentDirectory: '',
  // 提交设置
  isStandardCommit: true,
  skipHooks: false,
  autoQuickPushOnEnter: false,
  autoSetDefaultMessage: false,
  // 默认开启：推送成功后进度弹窗自动关闭，2 秒后消失。
  // 用户可在 设置 → 提交设置 → "Push 完成自动关闭" 单独关闭。
  autoClosePushModal: true,
  pullBeforePush: true,
  // 通用设置
  theme: 'light',  // 主题: light | dark | auto
  locale: 'zh-CN',  // 语言: zh-CN | en-US
  // AI 模型配置
  models: [],
  // AI 智能体单轮最大工具调用次数(防失控)。CLI `g ai` 与 Web 智能体共用,全局生效。
  // 2026-09-20: 40 → 200。40 轮在"读多个文件 → 逐个验证 → 再改"这类任务里很容易触顶,
  // 触顶后本轮被强制结束,用户必须再发一条消息才能接着跑,体感像被截断。
  // 2026-10-03: 200 → 1000。实测"边探边改"的长任务(读多个文件 + 逐个验证 + 提交)200 轮
  // 依然会被顶掉,而顶掉后重发消息要重新把上下文喂一遍,远比多跑几轮贵。
  // 想调小/调大改这个值即可(GUI: 设置 → AI 模型配置)。
  aiMaxToolIterations: 1000,
  // AI 智能体单轮请求的上下文预算（**token**，全局配置，CLI `g ai` 与 Web 智能体共用）。
  //
  // 2026-10-07 一天内调了三次：80,000 字符 → 400,000 字符 → 1,000,000 token。
  // 最终定在 token 口径 + 1M 的理由（详见 cli/ai/context.js 的预算一节）：
  //   · 用户的模型都是 1M 档 —— MiniMax-M3 官方写"up to 1M tokens"，
  //     DeepSeek V4 Flash 官方 API 文档 CONTEXT LENGTH 1M 且默认就是 1M；
  //   · provider 只认 token，用字符当闸门在纯中文内容上会超窗口；
  //   · 成本不是障碍：DeepSeek V4 Flash 输入 ¥1/1M token，**缓存命中只 ¥0.02/1M**
  //     （50 倍差价），而工具循环每轮重发的前缀完全相同，缓存命中率极高。
  //
  // 越界值夹取到 [20,000, 1,000,000]。解析公式见 cli/ai/context.js 的 resolveRequestBudget。
  // 旧字段 aiMaxRequestChars（字符口径）由 resolveRequestTokens 迁移读取。
  aiMaxRequestTokens: REQUEST_DEFAULT_MAX_TOKENS,
  // 智能体视图欢迎页的「预设提示词」快捷卡片（全局配置，CLI 不消费、只有 Web 端用）。
  // 空数组 = 使用前端内置的 5 条默认（zh/en 文案随界面语言走，见 utils/agentPresets.ts）；
  // 非空 = 用户自定义全量（每条 {id, label, prompt}）。归一化见 normalizeAgentPresetPrompts。
  agentPresetPrompts: [],
  // 工作台任务执行器（claude | opencode | codex）。全局配置，跨项目共享。
  // 决定「执行任务 / 执行子任务 / 从此处开始 / 简单任务续聊」这条链路
  // 默认 spawn 哪个本地 CLI；执行入口可以按次覆盖（见 workbench 执行路由）。
  taskExecutor: 'claude',
  // 任务 / 对话执行结束提示的三个通道（全局）。三者**平级且互相独立**，
  // 见 resolveNotifySwitches 的注释（2026-10-05 从"总开关 + 提示音子开关"拆过来）。
  //
  // 页面提示（默认开）：结束时在页面内弹一条 ElMessage。
  // 浏览器通知（默认关）：页面在后台/别的窗口时发系统通知。默认关是因为它要申请
  //   浏览器通知权限 —— 默认开 + 自动申请 = 用户每次开 GUI 都被弹一个授权框。
  //   想用的人自己去设置里拨开，那一刻才申请。
  // 提示音（默认开）：跑完 / 出错误各响一声，主动停止不响。
  //   音源是 CC0 资源（src/ui/client/public/sounds/），见同目录 CREDITS.txt。
  notifyPageOnTaskDone: true,
  notifyBrowserOnTaskDone: false,
  notifySoundOnTaskDone: true,
  // UI 状态（跨项目共享，存到顶层 ui 对象）
  // 之前散落在 localStorage，因随机端口启动而失效，迁到文件持久化
  ui: {
    layout: { leftRatio: 0.25, midRatio: 0.375, rightRatio: 0.375, topRatio: 0.5 },
    fileListViewMode: 'list',          // 'list' | 'tree'
    fileDiffSplitPercent: 35,          // 15-85
    commandConsole: {
      expanded: true,
      useTerminal: true,
      showTerminalSessions: true,
      splitPercent: 25,                // 15-85
    },
    editorAutoSave: false,
    // 文件空间的文件树是否定时静默刷新（捕获编辑器/外部工具产生的改动）。
    // 关掉后只能手动点「刷新」按钮，适合大目录/网络盘（见 EditorView 的轮询注释）。
    fileTreeAutoRefresh: true,
    // 顶栏工具图标（VSCode / Claude Code / Codex / …）中**隐藏**的那几个。
    // 白名单式的默认空数组：以后新增工具默认就固定显示，不需要回头改默认值。
    // 未勾选（= 落在本数组里）的工具连同未安装的一起收进顶栏右侧「更多」菜单。
    headerToolsHidden: [],
    // 工作台任务执行器「上次用过/选过的那个」（claude | opencode | codex），null = 还没选过，
    // 回落顶层 taskExecutor（设置里配的默认值）。两者**故意分开**：后者是"配置的默认"，
    // 前者是"上次用的"，语义不同，合并就再也分不清哪个是用户主动配的。
    // 2026-09-30: 原先记在 localStorage（键 zen-gitsync-task-executor），而 GUI 每次启动都换一个
    // 随机端口（见 utils/startServerOnAvailablePort.js —— 端口被占就往后找），
    // 浏览器按 origin（协议+主机+**端口**）隔离 localStorage，所以每开一次就是一个新桶，
    // "记住上次"从来没生效过。跟本对象其它字段一样落文件。
    lastTaskExecutor: null,
  }
};

// 规范化项目路径作为配置键
function normalizeProjectPath(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// 缓存当前项目的唯一键。git 根目录在一个进程生命周期内通常不变
// (用户极少在 CLI 运行中 cd 出去),缓存命中后省掉一次同步 git 子进程
// (Windows 上 ~30-100ms,是 CLI 冷启动最大的单点延迟来源)。
// invalidateCurrentProjectKey() 在 process.chdir / fs.js 的 /api/change_directory
// 之类"cwd 改变"的场景下被调用,保证缓存不变成 stale。
let _currentProjectKeyCache = null;
let _currentProjectKeyCwd = null;

function getCurrentProjectKey() {
  const cwd = process.cwd();
  // cwd 没变 + 已有缓存:直接返回
  if (_currentProjectKeyCache && _currentProjectKeyCwd === cwd) {
    return _currentProjectKeyCache;
  }
  let key = null;
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, windowsHide: true,
    }).trim();
    if (gitRoot) key = normalizeProjectPath(gitRoot);
  } catch (_) {
    // 非 Git 项目或 git 不可用，降级到 CWD
  }
  if (!key) key = normalizeProjectPath(cwd);
  _currentProjectKeyCache = key;
  _currentProjectKeyCwd = cwd;
  return key;
}

/**
 * 主动让项目键缓存失效。fs.js /api/change_directory 等修改 process.cwd
 * 的代码必须在 chdir 之后调一次,否则下一次 loadConfig/saveConfig 还会
 * 命中旧 key,写到错误项目的配置容器里。
 */
function invalidateCurrentProjectKey() {
  _currentProjectKeyCache = null;
  _currentProjectKeyCwd = null;
}

// 注意:Node.js 的 process 对象**不会**因为 process.chdir(path) 自动派发
// 'chdir' 事件(只有 cwd 包装器才会,API 文档明确标注不可靠)。所以这里
// 不挂 process.on('chdir', ...) —— 任何修改 cwd 的代码路径
// (fs.js 的 /api/change_directory 等)必须显式 import 并调用
// invalidateCurrentProjectKey(),否则下一次 loadConfig/saveConfig 还会
// 命中旧 key,写到错误项目的配置容器里。

// 从磁盘读取原始配置对象
//
// 缓存策略:单进程内 safeLoadRaw 的结果缓存,所有 loadConfig / saveConfig /
// saveRecentDirectory 等路径共享,避免每次都重新打开文件 + JSON.parse。
// 写盘( writeRawConfigFile )时主动失效缓存,保证下一次读看到最新值。
//
// 多进程一致性(2026-08-07):之前缓存不感知外部进程修改 —— 一个 g ui 实例
// 改了模型配置,另一个实例要重启才能看到。现在缓存命中时先 fs.stat 比对
// mtimeMs + size(一次 stat 系统调用,远低于 open+read+parse 的开销),
// 签名不一致则自动重读,等价于"懒加载版 fs.watch",且无 watcher 生命周期 /
// CLI 进程退出阻塞的问题。
let _rawConfigCache = null; // { value, existed, mtimeMs, size } | null(null = 失效/未缓存)

// 取配置文件签名(mtimeMs + size);文件不存在返回 null,stat 异常返回 undefined(表示"未知")
async function statConfigSignature() {
  try {
    const st = await fs.stat(configPath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    return undefined;
  }
}

// 判断缓存是否仍新鲜。
//
// ⚠️ 必须通过参数接收快照,不能在函数内直接闭包引用模块级 _rawConfigCache:
// 本函数第一个 await(fs.stat)会让出事件循环,并发路径(writeRawConfigFile 尾部、
// fs.js 的 chdir)可能在这个窗口内调用 invalidateRawConfigCache() 把它置 null,
// 恢复执行后再解引用就抛 "Cannot read properties of null (reading 'existed')"。
// 该 await 在 safeLoadRaw 的 try 之外,错误会一路冒到 loadConfig 并被包成
// "系统配置文件JSON格式错误" —— 报错信息完全误导(磁盘上的文件其实是合法 JSON)。
async function isRawConfigCacheFresh(cache) {
  if (!cache) return false;
  const sig = await statConfigSignature();
  if (sig === undefined) {
    // stat 异常(权限等):保守沿用缓存,避免把本来可读的状态打成错误
    return true;
  }
  if (sig === null) {
    // 文件当前不存在:缓存也说"不存在"才算新鲜;缓存有值但文件被外部删了 → 需重走读取路径
    return !cache.existed;
  }
  if (!cache.existed) return false; // 外部进程新建了配置文件 → 需重读
  return sig.mtimeMs === cache.mtimeMs && sig.size === cache.size;
}

async function readRawConfigFile() {
  // 缓存的新鲜性校验统一收敛在 safeLoadRaw,这里不另开快速通道,
  // 否则外部进程写盘会被这条捷径挡住。
  const state = await safeLoadRaw();
  if (!state.ok) {
    throw state.error;
  }
  return state.obj;
}

/**
 * 主动让 raw config 缓存失效。测试 / 跨进程场景可手动调。
 */
function invalidateRawConfigCache() {
  _rawConfigCache = null;
}

// 将原始配置对象写回磁盘
//
// 串行化(2026-09-18):同一进程内多个请求(锁定文件、布局比例、主题、最近目录、
// 模型配置…)都可能并发触发写盘。旧实现的 tmpPath 只带 `pid.毫秒时间戳` ——
// 同一毫秒内的两次写会**共用同一个 tmp 文件**:
//   ① 先完成的 rename 把 tmp 搬走,后者的 rename 拿到 ENOENT/EPERM;
//   ② 于是降级成"直接覆盖写",原子性丢失;
//   ③ 两次 writeFile 交错写同一个 tmp 时,读者能 parse 到半截 JSON
//      (实测报 "Unexpected non-whitespace character after JSON at position N")。
// 现在:进程内写队列串行 + tmp 名加自增序号(序号在 fsAtomic 里,多进程间 pid 天然不同)。
let _writeQueue = Promise.resolve();

/**
 * 串行写入口。返回的 Promise 与本次写入的真实结果一致(失败也如实抛出),
 * 但队列本身会吞掉失败继续跑 —— 一次写失败不能把后续写全部卡死。
 */
function writeRawConfigFile(obj) {
  const run = () => writeRawConfigFileInner(obj);
  // then(run, run):前一个写 reject 时也要继续执行本次写
  const p = _writeQueue.then(run, run);
  _writeQueue = p.then(() => {}, () => {});
  return p;
}

// 当前该按哪种模式落盘。原子写与"占用类错误重试"都收敛在 src/fsAtomic.js ——
// 分文件后写入点变成 1 + N + M 个,重试逻辑必须有唯一实现,否则迟早有一边漏掉
// EPERM/EACCES/EBUSY(那正是"并发读写偶发 500"的成因)。
//
// 模式判定优先用读路径已经定好的结论;_splitActive 还是 null(本进程还没读过
// 任何配置)时退化成看标记文件 —— 标记存在 = 拆分成功过 = 按分文件写。
async function resolveWriteMode() {
  const active = isSplitActive();
  if (active !== null) return active;
  return splitMarkerExists();
}

// 用 tmp + rename 原子写：避免拖拽高频触发 + 防抖期间 beforeunload 同时写入时
// 两次 fs.writeFile 直接覆盖产生的"先 truncate 再写"的中间态空文件,
// 触发 readRawConfigFile 在 race 时 JSON.parse 失败 → 500。
async function writeRawConfigFileInner(obj) {
  await resolveConfigPath();
  if (await resolveWriteMode()) {
    // 分文件模式:项目/画布各自成文件,只有变更过的才重写;config.json 只留全局
    // 设置(但每次都会写,它是别的实例判断"磁盘变了没"的唯一签名来源)。
    const res = await writeSplitStore(obj);
    if (res.errors.length) {
      console.warn(chalk.yellow(
        `[config] 分文件写盘有 ${res.errors.length} 个错误: ${res.errors.slice(0, 3).join('; ')}`
      ));
    }
    invalidateRawConfigCache();
    return;
  }
  await atomicWriteText(configPath, JSON.stringify(obj, null, 2));
  // 写盘成功后让缓存失效 — 下次 readRawConfigFile 走实盘,保证拿到最新值
  invalidateRawConfigCache();
}

async function backupConfigFileIfExists() {
  try {
    await fs.access(configPath);
  } catch (_) {
    return;
  }

  try {
    await fs.copyFile(configPath, `${configPath}.bak`);
  } catch (_) {
    // 备份失败不阻断主流程
  }
}

// 把 config.json 读出来的"内联对象"转成对外使用的 raw。
//
// 分文件模式(configSplit)下 config.json 只留全局设置,projects 是这里从
// projects/ + orchestration/ 组装回来的 —— 于是 loadConfig / readRawConfigFile /
// saveConfig 看到的形状与拆分前**完全一致**,调用点一行都不用改。
//
// ⚠️ 返回值的 `projects` 必须是对象,**哪怕是空的**。loadConfig 靠 `raw.projects`
// 是否存在来区分新旧两种结构(见下面的兼容分支),给出 undefined 会让它掉进
// "旧扁平格式"分支、把项目配置当顶层字段读 —— 表现为所有项目设置静默失效。
async function materializeRaw(inline) {
  try {
    const mode = await ensureSplitStore(inline, { configPath });
    if (!mode.active) return mode.raw ?? inline;
    const read = await readSplitProjects();
    if (read.errors.length) {
      // 单个项目/画布文件坏掉不阻断:其余照常可用,如实报告让用户知道少了什么
      console.warn(chalk.yellow(
        `[config] 读取分文件配置有 ${read.errors.length} 个问题(已跳过): ${read.errors.slice(0, 3).join('; ')}`
      ));
    }
    return { ...inline, projects: read.ok ? read.projects : {} };
  } catch (err) {
    console.warn(chalk.yellow(
      `[config] 分文件存储不可用,按内联模式处理: ${err?.code || err?.message}`
    ));
    return inline;
  }
}

// 更安全的读取，区分“文件不存在”和“解析失败”
async function safeLoadRaw() {
  await resolveConfigPath();
  // 命中缓存且签名未变(无外部进程写入)才直接返回,跳过 readFile + JSON.parse
  //
  // 先取快照再判新鲜:判新鲜期间会让出事件循环,缓存可能被并发路径失效。
  // 收尾再比对一次引用 —— 引用变了说明期间确实发生了写盘,此时不能返回旧快照
  // (会读到"写之前的旧值"),直接落到下面重读实盘。
  const cached = _rawConfigCache;
  if (cached && await isRawConfigCacheFresh(cached) && _rawConfigCache === cached) {
    return { ok: true, obj: cached.value, existed: cached.existed };
  }
  try {
    const data = await fs.readFile(configPath, 'utf-8');
    const inline = JSON.parse(data);
    // 组装(必要时含一次性拆分)必须在取签名之前 —— 拆分本身会重写 config.json,
    // 先取签名会缓存到一个已经失效的 mtime,导致下一次读误判为"外部没改"。
    const obj = await materializeRaw(inline);
    // 读完后立刻取签名。取不到(stat 异常)则签名字段置 undefined ——
    // 之后若 stat 恢复可用,签名比对必然不命中 → 自动重读兜底;
    // 若 stat 持续异常,isRawConfigCacheFresh 会保守沿用缓存。
    const sig = await statConfigSignature();
    _rawConfigCache = {
      value: obj,
      existed: true,
      mtimeMs: sig ? sig.mtimeMs : undefined,
      size: sig ? sig.size : undefined
    };
    return { ok: true, obj, existed: true };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // 文件不存在：当作空对象，但可继续写入。
      // 缓存签名 mtimeMs:null —— 命中缓存时仍会 stat 一次以感知外部新建,
      // 比旧的"每次都 readFile 抛 ENOENT"便宜,比"永久信任缓存"及时。
      //
      // 仍然走一次 materializeRaw:config.json 没了不代表数据没了 ——
      // 分文件模式下项目配置在 projects/ 里,直接返回 `{}` 会让用户看到
      // "项目全消失了",而磁盘上其实一份不少。
      const empty = await materializeRaw({});
      _rawConfigCache = { value: empty, existed: false, mtimeMs: null, size: null };
      return { ok: true, obj: empty, existed: false };
    }
    // 其他错误（例如解析失败）：不写入，提示用户
    // 不缓存错误状态 — 修复后下次读还能成功
    return { ok: false, error: err };
  }
}

/**
 * 判断错误是否**真的**是 JSON 解析失败。
 *
 * 非解析类错误(IO 异常、内部竞态)如果也套上"JSON 格式错误"的帽子,会把排查
 * 方向彻底带偏 —— 2026-09-18 那次缓存竞态就是这样伪装成
 * "系统配置文件JSON格式错误…原因: Cannot read properties of null",而磁盘上的
 * 文件其实是合法 JSON,用户照着提示去修文件只能白忙。
 */
function isJsonParseError(err) {
  return err instanceof SyntaxError || err?.name === 'SyntaxError';
}

// 异步读取配置文件
async function loadConfig() {
  const key = getCurrentProjectKey();
  let raw = null;
  try {
    raw = await readRawConfigFile();
  } catch (err) {
    const msg = err?.message ? String(err.message) : String(err);
    const head = isJsonParseError(err)
      ? '系统配置文件JSON格式错误，请修复后重试。'
      : '读取系统配置文件失败。';
    throw new Error(`${head}\n文件: ${configPath}\n原因: ${msg}`);
  }
  // 兼容旧版（全局扁平结构）
  if (raw && !raw.projects) {
    return {
      ...defaultConfig,
      ...raw,
      aiMaxToolIterations: normalizeAiMaxToolIterations(raw.aiMaxToolIterations)
        ?? defaultConfig.aiMaxToolIterations,
      aiMaxRequestTokens: resolveRequestTokens(raw),
      taskExecutor: normalizeTaskExecutor(raw.taskExecutor) ?? defaultConfig.taskExecutor,
      agentPresetPrompts: normalizeAgentPresetPrompts(raw.agentPresetPrompts)
        ?? defaultConfig.agentPresetPrompts,
      ...resolveNotifySwitches(raw)
    };
  }

  // 新版结构：{ projects: { [key]: projectConfig }, theme?, locale?, ui?, recentDirectories? }
  const projectConfig = raw?.projects?.[key];
  // 合并：默认配置 + 项目配置 + 全局通用设置（theme, locale, models, ui）
  // models / ui 是全局配置（跨项目共享），始终取顶层，不使用项目级的（防止旧数据覆盖）
  return {
    ...defaultConfig,
    ...(projectConfig || {}),
    theme: raw?.theme ?? defaultConfig.theme,
    locale: raw?.locale ?? defaultConfig.locale,
    models: raw?.models ?? defaultConfig.models,
    ui: raw?.ui ?? defaultConfig.ui,
    // 同 models：全局配置，始终取顶层，防止被项目配置里的旧值覆盖
    aiMaxToolIterations: normalizeAiMaxToolIterations(raw?.aiMaxToolIterations)
      ?? defaultConfig.aiMaxToolIterations,
    aiMaxRequestTokens: resolveRequestTokens(raw),
    taskExecutor: normalizeTaskExecutor(raw?.taskExecutor) ?? defaultConfig.taskExecutor,
    // 同 taskExecutor：全局配置，始终取顶层，防止被项目配置里的旧值覆盖
    agentPresetPrompts: normalizeAgentPresetPrompts(raw?.agentPresetPrompts)
      ?? defaultConfig.agentPresetPrompts,
    ...resolveNotifySwitches(raw)
  };
}

// 配置写入失败的错误类型,让上层 catch 后能区分是参数错误还是 IO 错误
class ConfigWriteError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ConfigWriteError';
    if (cause) this.cause = cause;
  }
}

// 异步保存配置
// 契约变更(2026-06-26):之前在错误分支仅 console.warn + return undefined,
// 调用方按成功处理 → 用户看到 ✓ / 200 OK 但其实没写盘(MAINT-4)。
// 现在改为:参数非法 → 抛 ConfigWriteError;IO/解析失败 → 抛 ConfigWriteError(wrapped)。
// 成功路径仍然返回 undefined,保持与大多数 fs.writeFile 风格一致。
async function saveConfig(config) {
  if(!config || typeof config !== 'object' || Array.isArray(config)){
    throw new ConfigWriteError(`saveConfig: 入参必须是普通对象,实际收到 ${Array.isArray(config) ? 'array' : typeof config}`);
  }
  if (Object.keys(config).length === 0) {
    throw new ConfigWriteError('saveConfig: 配置对象为空,已取消写入以避免覆盖');
  }
  const key = getCurrentProjectKey();
  const state = await safeLoadRaw();
  if (!state.ok) {
    const cause = state.error;
    const detail = cause?.message ? String(cause.message) : String(cause);
    const head = isJsonParseError(cause)
      ? '解析配置文件失败,已取消写入以避免覆盖。'
      : '读取配置文件失败,已取消写入以避免覆盖。';
    throw new ConfigWriteError(
      `${head}\n文件: ${configPath}\n原因: ${detail}`,
      cause
    );
  }

  const raw = state.obj; // 保留现有顶层键

  // 确保 projects 容器存在
  if (!raw.projects || typeof raw.projects !== 'object') {
    raw.projects = {};
  }

  // 分离全局设置和项目设置
  // models / ui 也是全局配置（跨项目共享），和 theme/locale 一样存到顶层
  // ⚠️ notifyOnTaskDone 是**旧键**（2026-10-05 拆成下面三个通道键）：这里仍要显式
  // 解构出来，否则它会跟着 ...projectConfig 被写进**项目配置**里 —— 全局设置漏进
  // 项目级是这一族键最容易踩的坑。解构出来本身不写回顶层（它已不再被任何地方读取）。
  const {
    theme, locale, models, ui, aiMaxToolIterations, aiMaxRequestTokens, taskExecutor,
    agentPresetPrompts,
    notifyOnTaskDone: legacyNotifyOnTaskDone,
    notifyPageOnTaskDone, notifyBrowserOnTaskDone, notifySoundOnTaskDone,
    ...projectConfig
  } = config;
  void legacyNotifyOnTaskDone;

  // 保存全局设置到根级别
  if (theme !== undefined) {
    raw.theme = theme;
  }
  if (locale !== undefined) {
    raw.locale = locale;
  }
  if (models !== undefined) {
    raw.models = models;
  }
  if (ui !== undefined) {
    raw.ui = ui;
  }
  // 工具调用上限同属全局设置：非法值不落盘(保留磁盘上的旧值),避免把手改坏的值固化
  const normalizedIterations = normalizeAiMaxToolIterations(aiMaxToolIterations);
  if (normalizedIterations !== null) {
    raw.aiMaxToolIterations = normalizedIterations;
  }
  // 请求上下文预算同属全局设置：同一套夹取语义
  const normalizedTokens = normalizeAiRequestTokens(aiMaxRequestTokens);
  if (normalizedTokens !== null) {
    raw.aiMaxRequestTokens = normalizedTokens;
  }
  // 任务执行器同属全局设置：白名单外的值不落盘
  const normalizedExecutor = normalizeTaskExecutor(taskExecutor);
  if (normalizedExecutor !== null) {
    raw.taskExecutor = normalizedExecutor;
  }
  // 三个提示通道开关同属全局设置：非布尔值不落盘(保留磁盘旧值)。
  // 各自独立 —— 写其中一个绝不顺带改动另外两个。
  const notifySwitches = {
    notifyPageOnTaskDone,
    notifyBrowserOnTaskDone,
    notifySoundOnTaskDone,
  };
  for (const [key, value] of Object.entries(notifySwitches)) {
    const normalized = normalizeNotifySwitch(value);
    if (normalized !== null) {
      raw[key] = normalized;
    }
  }
  // 预设提示词同属全局设置：空数组是**合法值**（= 恢复内置默认），照写；
  // 非法值（结构坏）不落盘，保留磁盘旧值 —— 与上面各键同一套语义。
  const normalizedPresets = normalizeAgentPresetPrompts(agentPresetPrompts);
  if (normalizedPresets !== null) {
    raw.agentPresetPrompts = normalizedPresets;
  }

  // 写入当前项目配置（在 defaultConfig 基础上合并，但不清空顶层其它键）
  const existingProjectConfig = (raw.projects[key] && typeof raw.projects[key] === 'object') ? raw.projects[key] : {};
  raw.projects[key] = { ...defaultConfig, ...existingProjectConfig, ...projectConfig };
  await backupConfigFileIfExists();
  await writeRawConfigFile(raw);
  // writeRawConfigFile 内部已 invalidateRawConfigCache,这里不再重复
}
// 文件锁定管理函数
async function lockFile(filePath) {
  const config = await loadConfig();
  const normalizedPath = path.normalize(filePath);

  if (!config.lockedFiles.includes(normalizedPath)) {
    config.lockedFiles.push(normalizedPath);
    try {
      await saveConfig(config);
    } catch (err) {
      // 写入失败时回滚内存变更,避免"以为锁了实际没锁"
      const idx = config.lockedFiles.lastIndexOf(normalizedPath);
      if (idx > -1) config.lockedFiles.splice(idx, 1);
      console.error(chalk.red(`❌ 锁定失败: "${normalizedPath}"`));
      console.error(chalk.gray(err.message));
      throw err;
    }
    console.log(chalk.green(`✓ 文件已锁定: "${normalizedPath}"`));
    return true;
  } else {
    console.log(chalk.yellow(`⚠️ 文件已经被锁定: "${normalizedPath}"`));
    return false;
  }
}

async function unlockFile(filePath) {
  const config = await loadConfig();
  const normalizedPath = path.normalize(filePath);
  const index = config.lockedFiles.indexOf(normalizedPath);

  if (index > -1) {
    config.lockedFiles.splice(index, 1);
    try {
      await saveConfig(config);
    } catch (err) {
      // 写入失败时回滚(把刚 splice 掉的项加回去)
      config.lockedFiles.splice(index, 0, normalizedPath);
      console.error(chalk.red(`❌ 解锁失败: "${normalizedPath}"`));
      console.error(chalk.gray(err.message));
      throw err;
    }
    console.log(chalk.green(`✓ 文件已解锁: "${normalizedPath}"`));
    return true;
  } else {
    console.log(chalk.yellow(`⚠️ 文件未被锁定: "${normalizedPath}"`));
    return false;
  }
}

async function isFileLocked(filePath) {
  const config = await loadConfig();
  const normalizedPath = path.normalize(filePath);
  return config.lockedFiles.includes(normalizedPath);
}

async function listLockedFiles() {
  const config = await loadConfig();
  if (config.lockedFiles.length === 0) {
    console.log(chalk.blue('📝 当前没有锁定的文件'));
  } else {
    console.log(chalk.blue('🔒 已锁定的文件:'));
    config.lockedFiles.forEach((file, index) => {
      console.log(chalk.gray(`  ${index + 1}. ${file}`));
    });
  }
  return config.lockedFiles;
}

async function getLockedFiles() {
  const config = await loadConfig();
  return config.lockedFiles || [];
}

// 全局“最近访问的目录”管理（保存在原始配置的顶层）
const MAX_RECENT_DIRS = 50;

async function getRecentDirectories() {
  const raw = await readRawConfigFile();
  const list = raw?.recentDirectories;
  return Array.isArray(list) ? list : [];
}

async function saveRecentDirectory(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return;
  const state = await safeLoadRaw();
  if (!state.ok) {
    const cause = state.error;
    const detail = cause?.message ? String(cause.message) : String(cause);
    const head = isJsonParseError(cause)
      ? '解析配置文件失败,已取消写入最近目录以避免覆盖。'
      : '读取配置文件失败,已取消写入最近目录以避免覆盖。';
    throw new ConfigWriteError(
      `${head}\n文件: ${configPath}\n原因: ${detail}`,
      cause
    );
  }
  const raw = state.obj; // 保留现有顶层键
  let list = Array.isArray(raw.recentDirectories) ? raw.recentDirectories.slice() : [];

  // 规范化:Windows 下统一为小写,去掉重复,保持最新在前
  // 修复(MAINT-5):unshift 用原始大小写,Windows 下 C:\Project 与 C:\PROJECT
  // 会产生两条"看起来一样"的项;现在 unshift 前先 normalize,dup 检测自然合并。
  // 注意:存的字符串是 normalized 形式,在 Windows 下显示为小写路径,
  // 这是有意为之 — 用 OS 标准大小写形式消除歧义,GUI 层可选择单独保留原始形式。
  const normalized = normalizeProjectPath(dirPath);
  list = list.filter(p => normalizeProjectPath(p) !== normalized);
  list.unshift(normalized);
  if (list.length > MAX_RECENT_DIRS) list = list.slice(0, MAX_RECENT_DIRS);

  raw.recentDirectories = list;
  await writeRawConfigFile(raw);
  return list;
}

async function removeRecentDirectory(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return;
  const state = await safeLoadRaw();
  if (!state.ok) return [];
  const raw = state.obj;
  let list = Array.isArray(raw.recentDirectories) ? raw.recentDirectories.slice() : [];
  const normalized = normalizeProjectPath(dirPath);
  list = list.filter(p => normalizeProjectPath(p) !== normalized);
  raw.recentDirectories = list;
  await writeRawConfigFile(raw);
  return list;
}

// 添加配置管理函数
async function handleConfigCommands() {
  if (process.argv.includes('get-config')) {
    const currentConfig = await loadConfig();
    console.log('Current configuration:');
    console.log(currentConfig);
    process.exit();
  }

  const setMsgArg = process.argv.find(arg => arg.startsWith('--set-default-message='));
  if (setMsgArg) {
    const newMessage = setMsgArg.split('=')[1];
    const currentConfig = await loadConfig();
    currentConfig.defaultCommitMessage = newMessage;
    try {
      await saveConfig(currentConfig);
    } catch (err) {
      console.error(chalk.red('❌ 默认提交信息写入失败'));
      console.error(chalk.gray(err.message));
      process.exit(1);
    }
    console.log(chalk.green(`✓ 默认提交信息已设置为: "${newMessage}"`));
    process.exit();
  }
}
/**
 * 显式删除某个项目的全部分文件。
 *
 * ⚠️ 必须顺带失效读缓存 —— 删的是 projects/ 下的文件,config.json 本身没动,
 * 而缓存新鲜度只看 config.json 的 mtime+size。不失效的话删完再读会把刚删掉的项目
 * 从旧快照里"读回来",用户看到"删了没反应"。
 */
async function deleteProjectConfigAndInvalidate(key) {
  const res = await deleteProjectConfig(key);
  invalidateRawConfigCache();
  return res;
}

export default {
  loadConfig,
  saveConfig,
  handleConfigCommands,
  lockFile,
  unlockFile,
  isFileLocked,
  listLockedFiles,
  getLockedFiles,
  getRecentDirectories,
  saveRecentDirectory,
  removeRecentDirectory,
  readRawConfigFile,
  writeRawConfigFile,
  // 显式删除某个项目的全部分文件。写路径刻意不做删除(防"只加载了一个项目就写回"
  // 连带清空其它项目),清理失效项目只能走这里。
  deleteProjectConfig: deleteProjectConfigAndInvalidate,
  // AI 智能体单轮工具调用上限的规范化/区间(GUI 保存前也要用,见 /api/config/save-ai-settings)
  normalizeAiMaxToolIterations,
  // 请求上下文预算的规范化/区间(同一路由保存时用;公式本体在 cli/ai/context.js)
  normalizeAiRequestTokens,
  migrateLegacyCharsToTokens,
  AI_MAX_TOOL_ITERATIONS_MIN,
  AI_MAX_TOOL_ITERATIONS_MAX,
  // 工作台任务执行器规范化(GUI 保存前也要用,见 /api/config/save-general-settings)
  normalizeTaskExecutor,
  TASK_EXECUTORS,
  // 任务/对话结束提示三个通道的开关规范化(同上)。
  // ⚠️ 新增规范化函数务必同步加进这个对象字面量 —— server 侧
  // `import config from '../../config.js'` 拿的是**这个默认导出对象**，
  // 只在 `export function` 里命名导出是不够的：漏加会变成 undefined 调用 → 路由 500，
  // 而且因为有 try/catch 兜底，前端只会看到"保存失败"，不知道是哪个函数缺了。
  normalizeNotifySwitch,
  // 智能体视图「预设提示词」的规范化(GUI 保存前也要用,见 /api/config/save-ai-settings)
  normalizeAgentPresetPrompts,
};

// 命名导出 — 用于测试与外部复用
export {
  ConfigWriteError,
  normalizeProjectPath,
  invalidateCurrentProjectKey,
  invalidateRawConfigCache,
  normalizeAiMaxToolIterations,
  // 请求上下文预算的规范化（2026-10-07 字符口径 → token 口径）。
  // 命名导出与 configManager 上的方法并存：路由层两种都要用 ——
  // save-ai-settings 走 configManager.*，而 context.js 之外的地方按需import。
  normalizeAiRequestTokens,
  migrateLegacyCharsToTokens,
  REQUEST_DEFAULT_MAX_TOKENS,
  AI_MAX_TOOL_ITERATIONS_MIN,
  AI_MAX_TOOL_ITERATIONS_MAX,
};
