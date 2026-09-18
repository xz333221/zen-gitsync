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
// 配置分文件存储(2026-09-18 第二轮)。
//
// 为什么拆:config.json 里 projects 占全文件 93%(605KB 中的 563KB),而 projects 里
// 又有 82% 是画布 flowData。于是任何一次琐碎写入 —— 改主题、拖一次布局比例、记一条
// 最近目录 —— 都要重写整份 605KB,并全量复制一份同样大小的 .bak(实测 save 耗时
// 45~66ms,其中大头就是这个 .bak 复制)。而单条画布数据其实只有 10~20KB。
//
// 拆成:
//   config.json                              全局 theme/locale/models/ui/recentDirectories
//   projects/<fileId>.json                   单项目配置 + 画布顺序(id 列表)
//   orchestration/<fileId>/<orchId>.json     每条画布一个文件
//
// 对外仍然暴露"旧的单对象形状":config.js 读的时候组装回去、写的时候拆开落盘,
// 所以所有调用点(loadConfig / saveConfig / readRawConfigFile / writeRawConfigFile)
// 一行都不用改。这一点很重要 —— 全仓只有 config.js 一个模块碰 raw.projects。
//
// 三条铁律(与 dataDirMigration 一致):
//   1. **幂等**:`.split-migrated` 标记 + 每次校验 config.json 是否又出现内联 projects
//      (用户可能从备份恢复了旧文件)。
//   2. **永不抛错**:拆分失败就整体退回内联模式,应用照常能读写配置。
//   3. **只搬不删**:拆分**全部成功并回读校验通过**之前,绝不从 config.json 摘掉
//      projects;旧文件先整份复制进 `_migration-backup-<ts>/` 留档。
//
// ⚠️ 多进程一致性靠 config.json 的 mtime+size(见 config.js 的 isRawConfigCacheFresh)。
// 所以任何一次写入都**必须**重写 config.json,否则别的实例改了某个项目文件、
// 本实例的缓存签名不变 → 一直读到旧值。这是拆分带来的新约束,别优化掉。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import logger from './ui/server/utils/logger.js';
import {
  DATA_DIR,
  CONFIG_FILE,
  PROJECTS_DIR,
  ORCHESTRATION_DIR,
  SPLIT_MIGRATION_MARKER,
} from './paths.js';
import { atomicWriteText, ensureDir, unlinkIfExists, fileExists, dirExists } from './fsAtomic.js';

const SPLIT_VERSION = 1;

// ── 文件名映射 ────────────────────────────────────────────────

/**
 * 项目键(归一化过的绝对路径)→ 项目文件名(不含扩展名)。
 *
 * 形状:`<basename 的可读 slug>-<key 的 8 位 sha1>`
 *   d:\xz_workspace\github_workspace\zen-gitsync → zen-gitsync-4f3a91bc
 *
 * slug 只是为了"人在目录里一眼认出是哪个项目"(可读性),**唯一性完全由哈希保证** ——
 * slug 会撞车(比如 `...\a\zen-gitsync` 与 `...\b\zen-gitsync` 的 basename 一样),
 * 而且 Windows 路径里 `\ / : * ? " < > |` 都不能进文件名,直接拿路径当文件名不可行。
 * 哈希取自**完整归一化键**,所以不同路径一定不同名。
 */
export function projectFileId(key) {
  const norm = String(key ?? '');
  const hash = crypto.createHash('sha1').update(norm, 'utf8').digest('hex').slice(0, 8);
  // 手写切分而不是 path.basename:测试里可能用 Windows 风格键跑在 POSIX 上,
  // 那时 path.basename 认不出 `\` 分隔符。
  const parts = norm.split(/[\\/]+/).filter(Boolean);
  const base = parts[parts.length - 1] || 'root';
  const slug = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'root';
  return `${slug}-${hash}`;
}

export function projectFilePath(key) {
  return path.join(PROJECTS_DIR, `${projectFileId(key)}.json`);
}

export function orchestrationDir(key) {
  return path.join(ORCHESTRATION_DIR, projectFileId(key));
}

/**
 * 画布文件名。实测 id 形状是 `orch_<毫秒>_<随机>` 全安全字符,但仍然兜一层:
 * 非法字符换成 `-`,并附 8 位哈希防撞(替换本身是可能撞的)。
 */
export function orchestrationFileId(orchId) {
  const raw = String(orchId ?? '');
  if (/^[A-Za-z0-9._-]+$/.test(raw) && raw.length <= 80) return raw;
  const hash = crypto.createHash('sha1').update(raw, 'utf8').digest('hex').slice(0, 8);
  const slug = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'orch';
  return `${slug}-${hash}`;
}

export function orchestrationFilePath(key, orchId) {
  return path.join(orchestrationDir(key), `${orchestrationFileId(orchId)}.json`);
}

// ── 差分基线 ──────────────────────────────────────────────────
//
// "上次读/写到磁盘的原文",用来跳过未变更的文件。键:
//   project : `p:<fileId>`        值:项目文件原文
//   orch    : `o:<fileId>/<id>`   值:画布文件原文
// 读路径在**重新读实盘**时刷新(所以基线永远反映"我们最近一次看到的磁盘状态"),
// 写路径写成功后更新。缓存失效不清空 —— 清空只会让下一次写退化成全量重写。
const _baselines = new Map();

// 画布**顺序表**的上次已知值:`fileId → JSON.stringify(有序 id 数组)`。
//
// 为什么单独存:清理已删除画布要先 readdir 才知道磁盘上有什么,而 readdir 是每个
// 项目一次 —— Windows 上 30 个项目光这一项 + mkdir 就要 40ms 上下(实测),把拆分
// 本该公司省下的写放大又吃回去了。而"顺序表没变"就等价于"没有新增/删除画布",
// 那磁盘上不可能多出孤儿文件,这次 readdir 纯属白跑。于是用它把 readdir 变成
// "只在顺序真的变了时才做"。
const _orderBaselines = new Map();

/** 仅供测试:清空差分基线 */
export function resetSplitCaches() {
  _baselines.clear();
  _orderBaselines.clear();
  _splitActive = null;
}

let _splitActive = null;

/** 当前是否处于分文件模式。null = 未知(还没判断过) */
export function isSplitActive() {
  return _splitActive;
}

async function markerExists() {
  try {
    await fs.access(SPLIT_MIGRATION_MARKER);
    return true;
  } catch {
    return false;
  }
}

/**
 * 标记文件是否存在。
 *
 * 给写路径做"还没读过任何配置就要写"时的兜底判定:标记存在说明分文件模式已经
 * 成功建立过,可以放心按分文件落盘;不存在则按内联写 —— 反正下一次读会把它拆开
 * (幂等),不会丢数据。
 */
export async function splitMarkerExists() {
  return markerExists();
}

/**
 * 判定"分文件模式是否生效"。
 *
 * 两个条件都要满足:标记存在 **且** config.json 里没有内联 projects。
 * 只看标记不够 —— 用户可能从备份恢复了旧的内联版本,那时必须重新拆一遍,
 * 否则新数据写进分文件、读的时候又优先看内联 → 表现为"改了没生效"。
 */
export async function resolveSplitMode(inlineObj) {
  const hasInline = inlineObj
    && typeof inlineObj.projects === 'object'
    && inlineObj.projects !== null
    && Object.keys(inlineObj.projects).length > 0;
  if (hasInline) return false;
  if (!(await markerExists())) return false;
  return true;
}

// ── 读 ────────────────────────────────────────────────────────

/**
 * 一次性读出所有项目的画布文件名:`项目 fileId → [文件名]`。
 *
 * 用 `readdir(recursive)` 一次拿全,而不是"每个项目 readdir 一次" —— Windows 上
 * 单次 readdir 约 1ms,30 个项目就是 30ms,比真正解析数据的开销还大(实测)。
 * 这是纯 I/O 批量化,不改变任何语义。
 */
async function listOrchestrationFiles() {
  const byFileId = new Map();
  let entries = [];
  try {
    entries = await fs.readdir(ORCHESTRATION_DIR, { recursive: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return byFileId;
    throw err;
  }
  for (const entry of entries) {
    const sep = entry.includes('/') ? '/' : (entry.includes('\\') ? '\\' : null);
    if (!sep) continue;                          // 顶层的散文件,不属于任何项目
    const idx = entry.indexOf(sep);
    const dirId = entry.slice(0, idx);
    const name = entry.slice(idx + 1);
    if (name.includes(sep)) continue;             // 更深一层,不是本项目的直接子文件
    if (!name.endsWith('.json')) continue;
    if (!byFileId.has(dirId)) byFileId.set(dirId, []);
    byFileId.get(dirId).push(name);
  }
  return byFileId;
}

/**
 * 组装某个项目的 orchestrations 数组。
 *
 * 顺序取自项目文件里的 `orchestrationOrder`(id 列表),不靠 readdir 的字母序 ——
 * `orch_<毫秒>_<随机>` 虽然按名字排恰好接近创建顺序,但用户拖拽排序后就对不上了。
 * 磁盘上存在但不在 id 列表里的画布(异常残渣)按名字序**追加到末尾**,宁可顺序丑
 * 一点也不能让用户的画布凭空消失。
 *
 * `names` 由 `listOrchestrationFiles()` 批量提供,避免每个项目各 readdir 一次。
 */
async function readOrchestrations(key, fileId, order, errors, names) {
  const dir = orchestrationDir(key);
  if (!names) return [];

  const byId = new Map();
  for (const name of names) {
    const filePath = path.join(dir, name);
    let text;
    let parsed;
    try {
      text = await fs.readFile(filePath, 'utf-8');
      parsed = JSON.parse(text);
    } catch (err) {
      // 单条画布坏掉不该拖垮整个配置读取:如实报告并跳过,其余画布照常可用
      errors.push(`画布文件损坏 ${name}: ${err?.code || err?.message}`);
      continue;
    }
    const id = parsed && typeof parsed.id === 'string' ? parsed.id : null;
    if (!id) {
      errors.push(`画布文件缺少 id,已跳过: ${name}`);
      continue;
    }
    byId.set(id, parsed);
    _baselines.set(`o:${fileId}/${id}`, text);
  }

  const ordered = [];
  const taken = new Set();
  if (Array.isArray(order)) {
    for (const id of order) {
      if (typeof id !== 'string' || taken.has(id)) continue;
      const orch = byId.get(id);
      if (!orch) continue;         // 顺序表里有、文件没有 → 跳过,不是错误
      ordered.push(orch);
      taken.add(id);
    }
  }
  const leftovers = [...byId.keys()].filter((id) => !taken.has(id));
  if (leftovers.length) {
    leftovers.sort();
    for (const id of leftovers) ordered.push(byId.get(id));
  }
  return ordered;
}

/**
 * 读取整个分文件存储,组装成与旧单文件格式**完全同形**的对象。
 *
 * 返回 `{ ok, projects, errors }`。`ok:false` 表示分文件存储不可用(目录建不出来等),
 * 调用方应退回内联模式 —— 但注意"某个项目文件坏了"不算不可用,那种情况跳过单项、
 * 其余照常返回(与单文件时代"一个字段坏不该丢全部"的取向一致)。
 */
export async function readSplitProjects() {
  const projects = {};
  const errors = [];
  let names;
  try {
    names = await fs.readdir(PROJECTS_DIR);
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, projects, errors };
    return { ok: false, projects, errors: [`读取项目目录失败: ${err?.code || err?.message}`] };
  }

  // 画布文件名一次读全(见 listOrchestrationFiles 的注释:省掉每个项目一次 readdir)
  let orchFiles;
  try {
    orchFiles = await listOrchestrationFiles();
  } catch (err) {
    errors.push(`读取画布目录失败: ${err?.code || err?.message}`);
    orchFiles = new Map();
  }

  for (const name of names) {
    if (!name.endsWith('.json')) continue;   // 跳过 .tmp / .bak
    const filePath = path.join(PROJECTS_DIR, name);
    let text;
    let parsed;
    try {
      text = await fs.readFile(filePath, 'utf-8');
      parsed = JSON.parse(text);
    } catch (err) {
      errors.push(`项目文件损坏 ${name}: ${err?.code || err?.message}`);
      continue;
    }
    const key = parsed && typeof parsed.key === 'string' && parsed.key ? parsed.key : null;
    if (!key) {
      errors.push(`项目文件缺少 key,已跳过: ${name}`);
      continue;
    }
    const fileId = projectFileId(key);
    if (`${fileId}.json` !== name) {
      // 只可能是手工改名/外部工具写进来的。仍按 key 收下(数据比命名重要),
      // 但记一条 —— 下一次写会落到规范名,旧名文件会变成重复项。
      logger.warn(`[configSplit] 项目文件名与键不匹配: ${name} (期望 ${fileId}.json)`);
    }
    const cfg = parsed.config && typeof parsed.config === 'object' && !Array.isArray(parsed.config)
      ? { ...parsed.config }
      : {};
    cfg.orchestrations = await readOrchestrations(
      key, fileId, parsed.orchestrationOrder, errors, orchFiles.get(fileId) || []
    );
    projects[key] = cfg;
    _baselines.set(`p:${fileId}`, text);
    // 顺序基线取"组装出来的有效顺序",而不是文件里存的那份 —— 顺序表里列了但文件
    // 缺失的 id 会被组装丢弃,拿组装结果当基线,下次写才不会被误判成"顺序变了"。
    _orderBaselines.set(fileId, JSON.stringify(cfg.orchestrations.map((o) => o.id)));
  }

  return { ok: true, projects, errors };
}

// ── 写 ────────────────────────────────────────────────────────

/**
 * 把 `raw`(旧的单对象形状)拆开落盘。
 *
 * 契约:
 *   - `raw.projects` 里**出现的**项目 →
 *     ① 项目文件按需重写(内容与上次一致则跳过);
 *     ② 画布数组视为**权威**:磁盘上多出来的画布文件会被删掉(否则被删的画布会复活)。
 *   - `raw.projects` 里**没出现的**项目 → 一概不动(写路径不做项目删除,删除走
 *     deleteProjectConfig 显式接口)。这条是为了防"某个调用方只加载了一个项目就写回"
 *     把其它项目连带清空 —— 单文件时代这么写会直接丢数据,现在退一步也不会。
 *   - 任何一次写入都重写 config.json(见文件头关于多进程一致性的说明)。
 *
 * `stripInlineProjects`(默认 false)是给**迁移**用的开关,含义是"本次写完要顺手把
 * config.json 里的内联 projects 精简掉"。这时内联副本就是唯一数据源,所以只在
 * **每个项目都确实安全落盘**的前提下才允许精简;只要有任何一个项目没写全,就在动
 * config.json 之前刹车并如实报错。不这么做的话,"拆分写了一半失败 → 仍然精简了
 * config.json" = 分文件没写全 + 内联副本被摘掉 = 直接丢数据。
 *
 * 返回统计 `{ projectWrites, projectSkips, orchWrites, orchSkips, orchDeletes, stripped }`。
 */
export async function writeSplitStore(raw, { stripInlineProjects = false } = {}) {
  const projects = raw && typeof raw.projects === 'object' && raw.projects !== null ? raw.projects : {};
  const stats = {
    projectWrites: 0,
    projectSkips: 0,
    // 因为"本项目本次有落盘失败"而刻意没写的项目数(不是为了省 IO,是为了不留残缺快照)
    projectSkippedUnsafe: 0,
    orchWrites: 0,
    orchSkips: 0,
    orchDeletes: 0,
    stripped: false,
  };
  const errors = [];
  // 没能安全落盘的项目键。只要非空,就绝不能摘掉 config.json 的内联副本。
  const failedProjects = new Set();

  try {
    await ensureDir(PROJECTS_DIR);
  } catch (err) {
    errors.push(`项目目录不可用 ${PROJECTS_DIR}: ${err?.code || err?.message}`);
    return { stats, errors };
  }

  for (const [key, cfgRaw] of Object.entries(projects)) {
    const cfg = cfgRaw && typeof cfgRaw === 'object' && !Array.isArray(cfgRaw) ? cfgRaw : {};
    const fileId = projectFileId(key);
    const { orchestrations, ...rest } = cfg;

    // 1) 画布:先落画布文件,再写项目文件(项目文件里的顺序表要反映"真的写成功了"的集合)
    let order = null;
    if (Array.isArray(orchestrations)) {
      order = [];
      const dir = orchestrationDir(key);
      const desiredIds = orchestrations
        .map((o) => (o && typeof o.id === 'string' && o.id ? o.id : null))
        .filter(Boolean);
      // 顺序表没变 ⇒ 没有新增/删除画布 ⇒ 磁盘上不可能有孤儿文件,这次 readdir 纯属白跑。
      // 这是热路径上最值钱的优化(见 _orderBaselines 的注释)。
      const orderChanged = _orderBaselines.get(fileId) !== JSON.stringify(desiredIds);

      // 只写内容变了的画布;**目录按需创建** —— mkdir 在 Windows 上约 1ms/次,
      // 30 个项目无脑建目录就吃掉整个写入预算(实测 42ms,比旧实现 605KB 全量重写还亏)。
      let dirReady = false;
      for (const orch of orchestrations) {
        const id = orch && typeof orch.id === 'string' ? orch.id : null;
        if (!id) {
          // 落不了盘的画布:精简内联副本就会把它弄丢 → 该项目整体判为不安全
          errors.push(`画布缺少 id,无法落盘: ${key}`);
          failedProjects.add(key);
          continue;
        }
        order.push(id);
        const bkey = `o:${fileId}/${id}`;
        const text = JSON.stringify(orch, null, 2);
        if (_baselines.get(bkey) === text) {
          stats.orchSkips++;
          continue;
        }
        if (!dirReady) {
          try {
            await ensureDir(dir);
            dirReady = true;
          } catch (err) {
            errors.push(`画布目录不可用 ${fileId}: ${err?.code || err?.message}`);
            failedProjects.add(key);
            break;   // 后面每条画布都要写进这个目录,再试也是同样结果
          }
        }
        try {
          await atomicWriteText(orchestrationFilePath(key, id), text);
          _baselines.set(bkey, text);
          stats.orchWrites++;
        } catch (err) {
          // 写失败就把 id 从顺序表里摘掉,免得"顺序表说有、文件没有"造成
          // 项目文件比画布文件更新,重启后顺序对不上
          order.pop();
          errors.push(`写画布失败 ${orchestrationFileId(id)}: ${err?.code || err?.message}`);
          failedProjects.add(key);
        }
      }

      // 清理已删除的画布。两个条件同时满足才做:
      //   ① 顺序表真的变了 —— 否则磁盘上不会有孤儿(省掉每个项目一次 readdir);
      //   ② 本项目没失败 —— 失败时不会写项目文件,磁盘上的顺序表还是旧的,
      //      此刻按新顺序删文件会把旧顺序表还引用着的画布删掉 = 丢数据。
      if (orderChanged && !failedProjects.has(key)) {
        let existing = [];
        try {
          existing = await fs.readdir(dir);
        } catch (_) { /* 目录不存在 = 没有可清理的 */ }
        const keep = new Set(desiredIds.map((id) => `${orchestrationFileId(id)}.json`));
        for (const name of existing) {
          if (!name.endsWith('.json') || keep.has(name)) continue;
          try {
            await unlinkIfExists(path.join(dir, name));
            stats.orchDeletes++;
          } catch (err) {
            // 没删掉 = 下次读会把它复活成一条已删画布,也算没落全
            errors.push(`删除画布失败 ${name}: ${err?.code || err?.message}`);
            failedProjects.add(key);
          }
        }
      }
    }

    // 2) 项目文件。
    //
    // **本项目本次有失败就整个不写**:此时 envelope 里的 orchestrationOrder 是残缺的
    // (落盘失败的画布已被 pop 掉),写出去等于留一份"明知不全"的快照 —— 下次读会
    // 照它把画布显示少了。错误已经如实上报,等下一次写成功时自然修正。
    if (failedProjects.has(key)) {
      stats.projectSkippedUnsafe++;
    } else {
      const envelope = {
        version: SPLIT_VERSION,
        key,
        ...(order ? { orchestrationOrder: order } : {}),
        config: rest,
      };
      const text = JSON.stringify(envelope, null, 2);
      const bkey = `p:${fileId}`;
      if (_baselines.get(bkey) === text) {
        stats.projectSkips++;
      } else {
        try {
          await atomicWriteText(projectFilePath(key), text);
          _baselines.set(bkey, text);
          stats.projectWrites++;
        } catch (err) {
          errors.push(`写项目配置失败 ${fileId}: ${err?.code || err?.message}`);
          failedProjects.add(key);
        }
      }
      // 顺序基线只在这一步之后推进:它必须描述"磁盘上的顺序表现在是什么",
      // 而顺序表正是随项目文件一起落盘的。写失败/跳过了就不动,下次仍会重算。
      if (!failedProjects.has(key) && order) {
        _orderBaselines.set(fileId, JSON.stringify(order));
      }
    }
  }

  // 3) 全局文件。**必须每次都写**,不只是为了全局字段 —— 它是别的实例判断
  //    "磁盘变了没"的唯一签名来源(config.js 只 stat 这一个文件)。
  //    但迁移场景(stripInlineProjects)下,这一步会摘掉唯一的内联副本,必须先确认安全。
  if (stripInlineProjects && failedProjects.size > 0) {
    const detail = [...failedProjects].slice(0, 3).join(', ');
    errors.push(
      `有 ${failedProjects.size} 个项目未安全落盘(${detail}),已放弃精简 config.json 以保住内联副本`
    );
    return { stats, errors };
  }

  const global = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (k === 'projects') continue;
    global[k] = v;
  }
  await atomicWriteText(CONFIG_FILE, JSON.stringify(global, null, 2));
  stats.stripped = true;

  _splitActive = true;
  return { stats, errors };
}

// ── 一次性拆分迁移 ─────────────────────────────────────────────

async function writeMarker(report) {
  try {
    await fs.writeFile(
      SPLIT_MIGRATION_MARKER,
      JSON.stringify({ version: SPLIT_VERSION, at: new Date().toISOString(), report }, null, 2),
      'utf-8'
    );
  } catch (err) {
    logger.warn(`[configSplit] 写拆分标记失败: ${err?.code || err?.message}`);
  }
}

/**
 * 把 config.json 里的内联 projects 拆到 projects/ + orchestration/。
 *
 * 流程刻意做成"先写分文件 → 回读校验 → 再精简 config.json":
 *   - 分文件写完后**回读计数**,对不上就整体放弃(不精简 config.json),退回内联模式;
 *   - 精简前把原始 config.json 整份复制进 `_migration-backup-<ts>/` 留档;
 *   - 只有全部成功才写 `.split-migrated` 标记。
 * 永不抛错:任何一步失败都返回 `{ok:false}`,调用方继续用内联的 raw。
 */
export async function splitInlineConfig(inlineObj, { configPath = CONFIG_FILE } = {}) {
  const inlineProjects = inlineObj?.projects;
  if (!inlineProjects || typeof inlineProjects !== 'object' || Object.keys(inlineProjects).length === 0) {
    // 没有可拆的项目:只补标记,让后续判定能走分文件模式
    await writeMarker({ projects: 0, note: '无内联 projects' });
    return { ok: true, migrated: false, projects: 0 };
  }

  const keys = Object.keys(inlineProjects);

  // 留档:整份复制原始 config.json。这是唯一的"拆分前"完整快照,不能省。
  let backupDir = null;
  try {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    backupDir = path.join(DATA_DIR, `_migration-backup-split-${stamp}`);
    await ensureDir(backupDir);
    if (await fileExists(configPath)) {
      await fs.copyFile(configPath, path.join(backupDir, 'config.json'));
    }
  } catch (err) {
    logger.warn(`[configSplit] 拆分前留档失败,继续(不阻断): ${err?.code || err?.message}`);
    backupDir = null;
  }

  try {
    const res = await writeSplitStore({ ...inlineObj }, { stripInlineProjects: true });
    if (res.errors.length || !res.stats.stripped) {
      const detail = res.errors.slice(0, 3).join('; ') || 'config.json 未被精简';
      logger.warn(`[configSplit] 拆分写盘未完成(${res.errors.length} 个错误),放弃拆分并退回内联模式: ${detail}`);
      reportSplitFailure(inlineObj, res.errors, backupDir);
      return { ok: false, migrated: false, errors: res.errors };
    }

    // 回读校验:每个 key 都必须能从分文件里读回来。少一个就整体回退 ——
    // 宁可不拆,也不能让用户的项目配置凭空消失。
    const readBack = await readSplitProjects();
    if (!readBack.ok) {
      reportSplitFailure(inlineObj, readBack.errors, backupDir);
      return { ok: false, migrated: false, errors: readBack.errors };
    }
    const missing = keys.filter((k) => !(k in readBack.projects));
    if (missing.length) {
      const errors = [`回读校验丢失 ${missing.length} 个项目: ${missing.slice(0, 3).join(', ')}`];
      logger.warn(`[configSplit] ${errors[0]} —— 放弃拆分,退回内联模式`);
      reportSplitFailure(inlineObj, errors, backupDir);
      return { ok: false, migrated: false, errors };
    }

    // 到这里才精简 config.json(由 writeSplitStore 的第 3 步完成,它写的 global
    // 已经不含 projects)。标记最后写,失败也只是下次重跑一遍(幂等)。
    await writeMarker({
      projects: keys.length,
      backup: backupDir ? path.basename(backupDir) : null,
    });
    logger.info(
      `[configSplit] 已把 ${keys.length} 个项目拆到 ${path.basename(PROJECTS_DIR)}/`
      + `(画布 ${res.stats.orchWrites} 个),config.json 只保留全局设置`
    );
    return { ok: true, migrated: true, projects: keys.length };
  } catch (err) {
    const errors = [`拆分异常: ${err?.code || err?.message}`];
    logger.warn(`[configSplit] ${errors[0]} —— 退回内联模式`);
    reportSplitFailure(inlineObj, errors, backupDir);
    return { ok: false, migrated: false, errors };
  }
}

// 回退时只记录,不改任何文件:此时 config.json 还是完整的内联版本,应用照常能用。
// (splitInlineConfig 内部已经把分文件写了一半,那些文件会留在磁盘上;下次重试
//  会因为内容一致而全部跳过,不会重复写。)
let _lastFailure = null;
function reportSplitFailure(inlineObj, errors, backupDir) {
  _lastFailure = { errors, at: Date.now(), backupDir };
  try {
    logger.warn(
      `[configSplit] 本次退回内联模式(projects=${Object.keys(inlineObj?.projects || {}).length}),`
      + `备份: ${backupDir || '(无)'}`
    );
  } catch (_) { /* ignore */ }
}

/** 供测试/诊断:上一次拆分失败的信息 */
export function lastSplitFailure() {
  return _lastFailure;
}

/**
 * config.js 的统一入口:给定刚读出来的内联对象,返回"应该用哪个 raw"。
 *
 *   { active: true,  raw: null }  → 分文件模式生效,调用方改用 readSplitProjects 的结果
 *   { active: false, raw: obj }   → 内联模式,直接用传来的 obj
 *
 * 永不抛错。
 */
export async function ensureSplitStore(inlineObj, { configPath = CONFIG_FILE } = {}) {
  try {
    if (await resolveSplitMode(inlineObj)) {
      _splitActive = true;
      return { active: true, raw: null };
    }
    // 标记在但 config.json 又变成内联了(用户恢复备份) → 重新拆;首次启动同理。
    const res = await splitInlineConfig(inlineObj, { configPath });
    if (res.ok) {
      _splitActive = true;
      return { active: true, raw: null };
    }
    _splitActive = false;
    return { active: false, raw: inlineObj };
  } catch (err) {
    logger.warn(`[configSplit] 分文件存储初始化失败,退回内联模式: ${err?.code || err?.message}`);
    _splitActive = false;
    return { active: false, raw: inlineObj };
  }
}

/** 显式删除一个项目的全部分文件(写路径刻意不做删除,删除只走这里) */
export async function deleteProjectConfig(key) {
  const fileId = projectFileId(key);
  const removed = [];
  const errors = [];
  const projFile = projectFilePath(key);
  if (await fileExists(projFile)) {
    try {
      await unlinkIfExists(projFile);
      removed.push(path.basename(projFile));
    } catch (err) {
      errors.push(`删除 ${path.basename(projFile)} 失败: ${err?.code || err?.message}`);
    }
  }
  const dir = orchestrationDir(key);
  if (await dirExists(dir)) {
    try {
      const names = await fs.readdir(dir);
      for (const name of names) {
        try {
          await unlinkIfExists(path.join(dir, name));
          removed.push(`${fileId}/${name}`);
        } catch (err) {
          errors.push(`删除画布 ${name} 失败: ${err?.code || err?.message}`);
        }
      }
      await fs.rmdir(dir).catch(() => {});
    } catch (err) {
      errors.push(`清理画布目录失败: ${err?.code || err?.message}`);
    }
  }
  _baselines.delete(`p:${fileId}`);
  _orderBaselines.delete(fileId);
  for (const k of [..._baselines.keys()]) {
    if (k.startsWith(`o:${fileId}/`)) _baselines.delete(k);
  }
  if (removed.length) {
    logger.info(`[configSplit] 已删除项目 ${fileId} 的 ${removed.length} 个配置文件`);
  }
  return { fileId, removed, errors };
}

export default {
  projectFileId,
  projectFilePath,
  orchestrationFileId,
  orchestrationFilePath,
  orchestrationDir,
  readSplitProjects,
  writeSplitStore,
  splitInlineConfig,
  ensureSplitStore,
  resolveSplitMode,
  splitMarkerExists,
  deleteProjectConfig,
  isSplitActive,
  resetSplitCaches,
  lastSplitFailure,
};
