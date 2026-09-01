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
// 实例注册表工具
// 每个 GUI 实例在自己的 <registryPath>/<pid>.json 文件中维护自身条目，
// 跨进程并发启动时不再因为 read-modify-write 互相覆盖而丢条目。
//
// 旧版本是单文件 `~/.zen-gitsync-instances.json`，多进程 register/heartbeat
// 并发时 read-modify-write 整体不原子，后写会覆盖先写，启动时一同拉起的 N
// 个实例最终只会有少数几个幸运的 PID 留在表里。改成目录后，写操作天然独
// 立：register 只动自己的 entry 文件，unregister 只删自己的，readAll 是
// 遍历目录做合并。
//
// stale 判定：PID 不存在 或 lastHeartbeat 超过 STALE_MS。
// 启动时会自动从旧主文件（~/.zen-gitsync-instances.json）迁移到目录。

import nodePath from 'node:path';
import logger from './logger.js';
import nodeOs from 'node:os';

const STALE_MS = 30_000;              // 心跳超时阈值（毫秒）
const WATCH_DEBOUNCE_MS = 100;        // fs.watch 防抖时间
const REGISTRY_VERSION = 1;
const REGISTRY_DIR_NAME = '.zen-gitsync-instances';
const REGISTRY_LEGACY_FILE_NAME = '.zen-gitsync-instances.json';
const MIGRATION_MARKER = '.migrated';

/**
 * 新注册表目录路径（每进程一个文件）
 */
export function getRegistryPath() {
  return nodePath.join(nodeOs.homedir(), REGISTRY_DIR_NAME);
}

/**
 * 旧版单文件注册表路径（仅用于一次性迁移）
 */
export function getLegacyRegistryPath() {
  return nodePath.join(nodeOs.homedir(), REGISTRY_LEGACY_FILE_NAME);
}

function defaultIsProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // 信号 0 仅做存活检查，不真正发送信号
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && (err.code === 'ESRCH' || err.code === 'ENOENT')) {
      return false;
    }
    // EPERM 等情况：进程存在但权限不足，按 alive 处理
    return true;
  }
}

// 解析项目名：优先 package.json.name，兜底为目录 basename
async function resolveProjectName(projectPath, fsMod, pathMod) {
  if (!projectPath) return '';
  try {
    const pkgPath = pathMod.join(projectPath, 'package.json');
    const raw = await fsMod.readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw);
    if (pkg && typeof pkg.name === 'string' && pkg.name.trim()) {
      return pkg.name.trim();
    }
  } catch (_) {
    // 读失败或解析失败，兜底
  }
  return pathMod.basename(projectPath);
}

// entry 文件名匹配：<pid>.json（pid 是正整数）
function isEntryFileName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.startsWith('.')) return false;     // 跳过 .migrated 等
  if (name.endsWith('.tmp')) return false;    // 跳过写入中的临时文件
  if (!name.endsWith('.json')) return false;
  const base = name.slice(0, -'.json'.length);
  return /^\d+$/.test(base);
}

function pidFromFileName(name) {
  return Number(name.slice(0, -'.json'.length));
}

export function createInstanceRegistry({
  fs: fsMod,
  path: pathMod,
  os: osMod,
  registryPath,
  isProcessAlive: isProcessAliveOverride,
}) {
  if (!fsMod || !pathMod || !osMod || !registryPath) {
    throw new Error('createInstanceRegistry: 必须提供 fs/path/os/registryPath');
  }

  // entry / legacy / marker 路径用注入的 pathMod 而非模块级的 nodePath,
  // 这样测试里可以传跨平台的 mock path,避免 Windows 上 nodePath.join 生成
  // 反斜杠路径而 mock fs 用的 '/' 路径读不到
  const entryFilePath = (pid) => pathMod.join(registryPath, `${pid}.json`);
  const legacyPath = () => pathMod.join(osMod.homedir(), REGISTRY_LEGACY_FILE_NAME);
  const migrationMarkerPath = () => pathMod.join(registryPath, MIGRATION_MARKER);

  // 进程内写串行化：所有 mutate 操作都 await 这条链
  let writeChain = Promise.resolve();

  function enqueueWrite(task) {
    const next = writeChain.then(task, task);
    // 不让单个失败阻塞后续操作
    writeChain = next.catch(() => {});
    return next;
  }

  // 是否启用测试桩:若传入了 isProcessAlive,就用它(避免测试里 process.kill
  // 误杀/找不到 PID 把所有 entry 都 prune 掉);否则用真实 process.kill。
  const isProcessAlive = typeof isProcessAliveOverride === 'function'
    ? isProcessAliveOverride
    : defaultIsProcessAlive;

  // 确保注册表目录存在
  async function ensureDir() {
    try {
      await fsMod.mkdir(registryPath, { recursive: true });
    } catch (err) {
      if (err && err.code === 'EEXIST') return;
      throw err;
    }
  }

  // 读单个 entry 文件。失败/不存在时返回 null。
  async function readEntry(pid) {
    const fp = entryFilePath(pid);
    try {
      const raw = await fsMod.readFile(fp, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
      return null;
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
      logger.warn(`[instanceRegistry] 读 entry pid=${pid} 失败: ${err?.message || err}`);
      return null;
    }
  }

  // 原子写单个 entry 文件：tmp + rename
  async function writeEntry(entry) {
    const fp = entryFilePath(entry.pid);
    const tmpFp = `${fp}.tmp`;
    await fsMod.writeFile(tmpFp, JSON.stringify(entry, null, 2), 'utf-8');
    await fsMod.rename(tmpFp, fp);
  }

  // 删除单个 entry 文件
  async function deleteEntry(pid) {
    const fp = entryFilePath(pid);
    try {
      await fsMod.unlink(fp);
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      throw err;
    }
  }

  // 遍历目录读取所有 entry，合并成单张表
  async function readAll() {
    await ensureDir();
    let names;
    try {
      names = await fsMod.readdir(registryPath);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return { version: REGISTRY_VERSION, instances: {} };
      }
      throw err;
    }
    const instances = {};
    for (const name of names) {
      if (!isEntryFileName(name)) continue;
      const pid = pidFromFileName(name);
      const entry = await readEntry(pid);
      if (entry && Number.isInteger(entry.pid)) {
        instances[String(entry.pid)] = entry;
      }
    }
    return { version: REGISTRY_VERSION, instances };
  }

  // 一次性迁移：从旧主文件 ~/.zen-gitsync-instances.json 把每个 entry
  // 写到新目录里。已迁移过（存在 .migrated 标记）则跳过。
  async function migrateLegacy() {
    await ensureDir();
    const markerPath = migrationMarkerPath();
    try {
      await fsMod.access(markerPath);
      return false; // 已迁移
    } catch (_) {
      // 标记不存在，需要迁移
    }

    // legacy path 走注入的 osMod,这样测试里可以把 homedir 指向 mock 路径
    const legacyPath_ = legacyPath();
    let legacy = null;
    try {
      const raw = await fsMod.readFile(legacyPath_, 'utf-8');
      legacy = JSON.parse(raw);
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        logger.warn(`[instanceRegistry] 读旧主文件失败: ${err?.message || err}`);
      }
    }

    if (!legacy || typeof legacy !== 'object' || !legacy.instances) {
      // 没有旧数据,只写标记
      try {
        await fsMod.writeFile(markerPath, new Date().toISOString(), 'utf-8');
      } catch (_) {}
      return false;
    }

    let count = 0;
    for (const [pidStr, entry] of Object.entries(legacy.instances)) {
      if (!entry || !Number.isInteger(entry.pid)) continue;
      try {
        await writeEntry(entry);
        count++;
      } catch (e) {
        logger.warn(`[instanceRegistry] 迁移 entry pid=${pidStr} 失败: ${e?.message || e}`);
      }
    }

    try {
      await fsMod.writeFile(markerPath, new Date().toISOString(), 'utf-8');
    } catch (e) {
      logger.warn(`[instanceRegistry] 写迁移标记失败: ${e?.message || e}`);
    }
    try {
      await fsMod.unlink(legacyPath_);
    } catch (e) {
      // 旧文件删不掉不阻塞,只是留个垃圾,下回再删
      logger.warn(`[instanceRegistry] 删旧主文件失败: ${e?.message || e}`);
    }
    logger.info(`[instanceRegistry] 已从旧主文件迁移 ${count} 个 entry 到目录格式`);
    return true;
  }

  // 同步裁剪：传入当前内存中的 instances 字典，返回裁剪后的新字典
  function pruneInPlace(instances) {
    const now = Date.now();
    const result = {};
    for (const [pidStr, entry] of Object.entries(instances)) {
      if (!entry || typeof entry !== 'object') continue;
      const pid = Number(entry.pid ?? Number(pidStr));
      if (!isProcessAlive(pid)) continue;
      if (typeof entry.lastHeartbeat === 'number' && now - entry.lastHeartbeat > STALE_MS) continue;
      result[pidStr] = entry;
    }
    return result;
  }

  // 公开 API
  //
  // 关键点:register / heartbeat / unregister 都只读写 *自己* 的 entry 文件,
  // 跨进程并发时不同 PID 的写入互不干扰,从根本上消除 read-modify-write 覆盖。
  async function register({ pid, port, projectPath, projectName, hostname } = {}) {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('register: pid 必填');
    if (!Number.isInteger(port) || port <= 0) throw new Error('register: port 必填');
    if (!projectPath) throw new Error('register: projectPath 必填');

    const resolvedName = projectName && String(projectName).trim()
      ? String(projectName).trim()
      : await resolveProjectName(projectPath, fsMod, pathMod);

    const entry = {
      pid,
      port,
      projectName: resolvedName,
      projectPath,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      hostname: hostname || osMod.hostname()
    };

    await enqueueWrite(async () => {
      await ensureDir();
      await migrateLegacy();
      await writeEntry(entry);
    });
    return entry;
  }

  async function unregister(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return;
    await enqueueWrite(async () => {
      await ensureDir();
      await deleteEntry(pid);
    });
  }

  // 心跳。updates 可携带完整注册信息（port/projectPath/projectName/hostname）：
  //   条目存在 → 刷新 lastHeartbeat
  //   条目不存在 → 用完整信息自愈重建
  //
  // 这里只读 *自己* 的 entry 文件，不遍历全表。即使全表被同时写，
  // 也只影响这一个文件，自己的 lastHeartbeat 一定能更新到。
  async function heartbeat(pid, updates = {}) {
    if (!Number.isInteger(pid) || pid <= 0) return;
    await enqueueWrite(async () => {
      await ensureDir();
      await migrateLegacy();

      const existing = await readEntry(pid);
      let entry;
      if (!existing) {
        const canRebuild =
          Number.isInteger(updates.port) && updates.port > 0 && !!updates.projectPath;
        if (!canRebuild) return;

        entry = {
          pid,
          port: updates.port,
          projectName: updates.projectName || '',
          projectPath: updates.projectPath,
          startedAt: Date.now(),
          lastHeartbeat: Date.now(),
          hostname: updates.hostname || osMod.hostname()
        };
        logger.info(
          `[instanceRegistry] 心跳检测到本实例条目丢失，已自愈重建 pid=${pid} port=${updates.port}`
        );
      } else {
        entry = {
          ...existing,
          ...(updates.projectPath ? { projectPath: updates.projectPath } : {}),
          ...(updates.projectName ? { projectName: updates.projectName } : {}),
          ...(Number.isInteger(updates.port) && updates.port > 0 ? { port: updates.port } : {}),
          lastHeartbeat: Date.now()
        };
      }
      await writeEntry(entry);
    });
  }

  async function list({ pruneStale = true } = {}) {
    const obj = await readAll();
    let instances = obj.instances || {};
    if (pruneStale) {
      const originalKeys = Object.keys(instances);
      instances = pruneInPlace(instances);
      const newKeys = Object.keys(instances);
      if (originalKeys.length !== newKeys.length) {
        // 失效条目的文件也要删,避免堆积
        const removed = originalKeys.filter((k) => !newKeys.includes(k));
        for (const pidStr of removed) {
          await deleteEntry(Number(pidStr));
        }
      }
    }
    const arr = Object.values(instances);
    arr.sort((a, b) => (a.port || 0) - (b.port || 0));
    return arr;
  }

  // 监听注册表目录变化；callback 会在 debounce 后被调用，参数是最新 list
  // fsWatch 参数：node 'fs' 模块的 watch 函数（同步 + EventEmitter 形式）
  function watch(callback, fsWatch) {
    if (typeof callback !== 'function') {
      throw new Error('watch: callback 必填');
    }
    if (typeof fsWatch !== 'function') {
      logger.warn('[instanceRegistry] 未提供 fs.watch，跨进程推送将不可用');
      return function noop() {};
    }
    let debounceTimer = null;
    let watcher = null;
    let pruneTimer = null;
    let closed = false;

    const fire = async () => {
      if (closed) return;
      try {
        const fresh = await list({ pruneStale: true });
        callback(fresh);
      } catch (e) {
        logger.warn(`[instanceRegistry] watch 回调失败: ${e?.message || e}`);
      }
    };

    // 周期性 prune：即便没有其他进程写入注册表，也定期清理本地失效条目
    // （例如所有 server 都强 kill 后，目录里残留的僵尸 entry 会被自动清理）
    pruneTimer = setInterval(() => {
      if (closed) return;
      list({ pruneStale: true }).catch(() => {});
    }, STALE_MS / 3);

    try {
      // 监听整个目录：任何一个 entry 文件增/删/改都会触发回调
      watcher = fsWatch(registryPath, { persistent: false }, () => {
        if (closed) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(fire, WATCH_DEBOUNCE_MS);
      });
      if (watcher && typeof watcher.on === 'function') {
        watcher.on('error', (err) => {
          logger.warn(`[instanceRegistry] fs.watch 出错: ${err?.message || err}`);
        });
      }
    } catch (err) {
      logger.warn(`[instanceRegistry] 无法启动 fs.watch (${err?.message || err})，跨进程推送将不可用，请依赖轮询`);
    }

    return function closeWatcher() {
      closed = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (pruneTimer) {
        clearInterval(pruneTimer);
        pruneTimer = null;
      }
      if (watcher) {
        try { watcher.close(); } catch (_) {}
        watcher = null;
      }
    };
  }

  function close() {
    // 工厂内部无 timer，仅为 API 对称
  }

  return {
    register,
    unregister,
    heartbeat,
    list,
    watch,
    close,
    _resolveProjectName: (p) => resolveProjectName(p, fsMod, pathMod),
    _STALE_MS: STALE_MS,
    _migrateLegacy: migrateLegacy,
    _isEntryFileName: isEntryFileName
  };
}
