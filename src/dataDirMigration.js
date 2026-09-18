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
// 把散落在用户主目录里的历史数据搬进统一数据目录 ~/.zen-gitsync/(见 src/paths.js)。
//
// 设计要点:
//  1. **幂等**:靠 DATA_DIR/.layout-migrated 标记跳过已完成的目录搬迁;主配置那一步
//     每次启动都跑一次(便宜,且要能应对"用户手动从备份恢复了旧文件")。
//  2. **永不抛错**:迁移是启动路径上的副作用,失败绝不能挡住应用启动 ——
//     旧配置读不到就回退到旧路径只读模式(configFallbackPath),下一轮再试。
//  3. **不直接删**:搬迁期间发现的纯垃圾(空目录、*.tmp 残渣)一律 rename 进
//     DATA_DIR/_legacy-cleanup/<名字>.<时间戳>,留档可回溯,不做不可逆删除。
//  4. **不抢别人的活**:更早那版单文件心跳注册表(~/.zen-gitsync-instances.json)
//     的内容迁移归 instanceRegistry.migrateLegacy() 所有,这里只在它是"被误建成的
//     空目录"时顺手收走垃圾。
import fs from 'node:fs/promises';
import path from 'node:path';
import logger from './ui/server/utils/logger.js';
import {
  DATA_DIR,
  CONFIG_FILE,
  CONFIG_BACKUP_FILE,
  LEGACY_CONFIG_FILE,
  LEGACY_CONFIG_BACKUP_FILE,
  INSTANCES_DIR,
  LEGACY_INSTANCES_DIR,
  LEGACY_INSTANCES_FILE,
  AI_IMAGES_DIR,
  LEGACY_AI_IMAGES_DIR,
  LEGACY_HOME_DIR,
  LAYOUT_MIGRATION_MARKER,
  MIGRATION_BACKUP_DIR,
} from './paths.js';

const LAYOUT_VERSION = 1;

// Windows 上 rename 会撞"目标被占用"(杀毒软件扫描、索引器、并发进程):毫秒级,重试即可
const BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
async function renameWithRetry(src, dest, attempts = 6) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.rename(src, dest);
      return;
    } catch (err) {
      lastErr = err;
      if (!BUSY_CODES.has(err?.code)) throw err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 15 * (i + 1)));
    }
  }
  throw lastErr;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 'file' | 'dir' | null(不存在) */
async function statKind(p) {
  try {
    const st = await fs.lstat(p);
    if (st.isDirectory()) return 'dir';
    if (st.isFile()) return 'file';
    return null;
  } catch {
    return null;
  }
}

async function ensureDir(p) {
  try {
    await fs.mkdir(p, { recursive: true });
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }
}

/** 移动文件:优先 rename(同盘原子),失败降级为 copy + unlink */
async function moveFile(src, dest, report) {
  try {
    await renameWithRetry(src, dest);
    return true;
  } catch (err) {
    try {
      await fs.copyFile(src, dest);
      await fs.unlink(src);
      return true;
    } catch (err2) {
      report.errors.push(`搬移失败 ${src} → ${dest}: ${err?.code || err?.message} / ${err2?.code || err2?.message}`);
      return false;
    }
  }
}

/** 把垃圾搬进留档目录(不删)。名字冲突时加时间戳后缀 */
async function moveAside(target, report) {
  try {
    await ensureDir(MIGRATION_BACKUP_DIR);
    const base = path.basename(target);
    let dest = path.join(MIGRATION_BACKUP_DIR, base);
    if (await exists(dest)) dest = path.join(MIGRATION_BACKUP_DIR, `${base}.${Date.now()}`);
    await renameWithRetry(target, dest);
    report.cleaned.push(`${target} → ${dest}`);
  } catch (err) {
    report.errors.push(`清理失败 ${target}: ${err?.code || err?.message}`);
  }
}

/** 空目录/空文件才收走;非空则原样保留并记 skipped(可能还装着别人的数据) */
async function cleanIfEmptyDir(dir, report, note = '') {
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    report.errors.push(`读取目录失败 ${dir}: ${err?.code || err?.message}`);
    return;
  }
  if (entries.length > 0) {
    report.skipped.push(`非空的旧目录,保留不动: ${dir}(${entries.length} 项)${note ? ' ' + note : ''}`);
    return;
  }
  await moveAside(dir, report);
}

async function writeMarker(report) {
  try {
    await fs.writeFile(
      LAYOUT_MIGRATION_MARKER,
      JSON.stringify({ version: LAYOUT_VERSION, at: new Date().toISOString(), report }, null, 2),
      'utf-8'
    );
  } catch (err) {
    report.errors.push(`写迁移标记失败: ${err?.code || err?.message}`);
  }
}

/**
 * 主配置落位。返回"本次实际应该读写的配置文件路径"。
 * 正常情况下就是 CONFIG_FILE;只有搬迁彻底失败(旧文件被占用/无权限)时才回退旧路径,
 * 保证应用至少还能以只读方式跑起来。
 */
async function relocateConfig(report) {
  const legacyKind = await statKind(LEGACY_CONFIG_FILE);
  const targetKind = await statKind(CONFIG_FILE);

  if (legacyKind === 'file') {
    if (targetKind === 'file') {
      // 两个都在:新路径是权威,旧文件原样留着(可能还有旧版本实例在读它),不删
      report.skipped.push(`新旧配置同时存在,保留旧文件不处理: ${LEGACY_CONFIG_FILE}`);
    } else {
      if (targetKind === 'dir') {
        // 配置路径被一个目录占着(与 .zen-gitsync-instances.json 同类的脏状态):
        // 空的收走留档后继续落位,非空的只能回退(绝不贸然动别人的数据)
        await cleanIfEmptyDir(CONFIG_FILE, report, '(占用配置路径的目录)');
        if (await statKind(CONFIG_FILE) === 'dir') {
          report.skipped.push(`配置路径被非空目录占用,无法落位: ${CONFIG_FILE}`);
          return LEGACY_CONFIG_FILE;
        }
      }
      const ok = await moveFile(LEGACY_CONFIG_FILE, CONFIG_FILE, report);
      if (ok) report.moved.push(`${LEGACY_CONFIG_FILE} → ${CONFIG_FILE}`);
      else if (await exists(LEGACY_CONFIG_FILE)) return LEGACY_CONFIG_FILE; // 只读回退
    }
  }

  // 旧备份也一并收进来(仅当新备份还没有,避免覆盖用户更近的备份)
  if (await exists(LEGACY_CONFIG_BACKUP_FILE) && !(await exists(CONFIG_BACKUP_FILE))) {
    const ok = await moveFile(LEGACY_CONFIG_BACKUP_FILE, CONFIG_BACKUP_FILE, report);
    if (ok) report.moved.push(`${LEGACY_CONFIG_BACKUP_FILE} → ${CONFIG_BACKUP_FILE}`);
  }

  return CONFIG_FILE;
}

/** 心跳注册表目录:逐文件合并(保留新目录里已有的 pid 文件),残渣留档 */
async function relocateInstances(report) {
  if (!(await exists(LEGACY_INSTANCES_DIR))) return;
  await ensureDir(INSTANCES_DIR);

  let names = [];
  try {
    names = await fs.readdir(LEGACY_INSTANCES_DIR);
  } catch (err) {
    report.errors.push(`读取旧心跳目录失败: ${err?.code || err?.message}`);
    return;
  }

  for (const name of names) {
    const src = path.join(LEGACY_INSTANCES_DIR, name);
    if (name.endsWith('.tmp')) {
      await moveAside(src, report);
      continue;
    }
    if (name === '.migrated') {
      // 心跳注册表自己的迁移标记:新目录里没有就带过去,否则它下次启动会重跑一遍旧文件迁移
      const dest = path.join(INSTANCES_DIR, name);
      if (!(await exists(dest))) await moveFile(src, dest, report);
      else await moveAside(src, report);
      continue;
    }
    const dest = path.join(INSTANCES_DIR, name);
    if (await exists(dest)) {
      report.skipped.push(`新心跳目录已有同名文件,旧文件留档: ${name}`);
      await moveAside(src, report);
      continue;
    }
    const ok = await moveFile(src, dest, report);
    if (ok) report.moved.push(`${src} → ${dest}`);
  }

  await cleanIfEmptyDir(LEGACY_INSTANCES_DIR, report);

  // 更早的单文件注册表:内容迁移归 instanceRegistry,这里只处理"被误建成目录"的垃圾。
  // 本机就是这么个状态 —— 旧代码在 .zen-gitsync-instances.json 位置留下了空目录,
  // instanceRegistry 对它 readFile 得 EISDIR、unlink 得 EPERM,两头静默失败 →
  // 垃圾一直留着。空目录直接收走(非空则保留,见 cleanIfEmptyDir)。
  if (await statKind(LEGACY_INSTANCES_FILE) === 'dir') {
    await cleanIfEmptyDir(LEGACY_INSTANCES_FILE, report, '(旧单文件注册表被误建成的目录)');
  }
}

/** CLI 贴图目录;顺手把腾空的旧父目录 ~/.git-commit-tool/ 收走 */
async function relocateAiImages(report) {
  if (await exists(LEGACY_AI_IMAGES_DIR)) {
    await ensureDir(AI_IMAGES_DIR);
    let names = [];
    try {
      names = await fs.readdir(LEGACY_AI_IMAGES_DIR);
    } catch (err) {
      report.errors.push(`读取旧贴图目录失败: ${err?.code || err?.message}`);
      names = [];
    }
    for (const name of names) {
      const src = path.join(LEGACY_AI_IMAGES_DIR, name);
      const dest = path.join(AI_IMAGES_DIR, name);
      if (await exists(dest)) {
        await moveAside(src, report);
        continue;
      }
      const ok = await moveFile(src, dest, report);
      if (ok) report.moved.push(`${src} → ${dest}`);
    }
    await cleanIfEmptyDir(LEGACY_AI_IMAGES_DIR, report);
  }
  // 贴图搬空后,旧的 ~/.git-commit-tool/ 父目录通常也就空了(cleanIfEmptyDir 自带"非空不动"保护)
  if (await exists(LEGACY_HOME_DIR)) {
    await cleanIfEmptyDir(LEGACY_HOME_DIR, report, '(贴图迁走后腾空的旧目录)');
  }
}

/** 主目录下散落的、我们写出来的临时文件残渣 */
async function cleanLegacyTmpResidue(report) {
  const home = path.dirname(LEGACY_CONFIG_FILE);
  let names = [];
  try {
    names = await fs.readdir(home);
  } catch (err) {
    report.errors.push(`扫描主目录失败: ${err?.code || err?.message}`);
    return;
  }
  // 只认我们自己的命名模式,绝不碰用户其它 .tmp 文件
  const mine = names.filter((n) => /^\.git-commit-tool\.json\..*\.tmp$/.test(n) || n === '.zen-gitsync-instances.json.tmp');
  for (const n of mine) await moveAside(path.join(home, n), report);
}

export function emptyReport() {
  return { moved: [], cleaned: [], skipped: [], errors: [], alreadyMigrated: false, configPath: CONFIG_FILE };
}

/**
 * 执行(或跳过)数据目录布局迁移。永不抛错。
 * 调用点:server 启动、CLI 入口、以及 src/config.js 首次读配置时(惰性兜底)。
 */
export async function migrateDataDir({ force = false } = {}) {
  const report = emptyReport();

  try {
    await ensureDir(DATA_DIR);
  } catch (err) {
    report.errors.push(`创建数据目录失败 ${DATA_DIR}: ${err?.code || err?.message}`);
    return report; // 连目录都建不出来,后面的事都别做了(读配置会各自报错)
  }

  // 主配置每次校验:便宜(2 次 stat),且能兜住"用户手动恢复了旧文件"
  try {
    report.configPath = await relocateConfig(report);
  } catch (err) {
    report.errors.push(`主配置搬迁异常: ${err?.code || err?.message}`);
  }

  const migratedBefore = !force && (await exists(LAYOUT_MIGRATION_MARKER));
  if (migratedBefore) {
    report.alreadyMigrated = true;
    return report;
  }

  try {
    await relocateInstances(report);
  } catch (err) {
    report.errors.push(`心跳目录搬迁异常: ${err?.code || err?.message}`);
  }
  try {
    await relocateAiImages(report);
  } catch (err) {
    report.errors.push(`贴图目录搬迁异常: ${err?.code || err?.message}`);
  }
  try {
    await cleanLegacyTmpResidue(report);
  } catch (err) {
    report.errors.push(`临时文件清理异常: ${err?.code || err?.message}`);
  }

  // 有错就不写标记 → 下次启动重试;没错则标记,后续启动只做主配置校验
  if (report.errors.length === 0) await writeMarker(report);
  else logger.warn(`[dataDirMigration] 迁移存在 ${report.errors.length} 个错误,下次启动重试`);

  if (report.moved.length || report.cleaned.length) {
    logger.info(
      `[dataDirMigration] 已搬移 ${report.moved.length} 项、留档 ${report.cleaned.length} 项到 ${DATA_DIR}`
    );
  }
  return report;
}

export default { migrateDataDir };
