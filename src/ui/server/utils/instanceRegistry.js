// 实例注册表工具
// 维护 ~/.zen-gitsync-instances.json，记录所有正在运行的 GUI 实例
// 多进程并发写采用 atomic temp+rename + 进程内串行化 Promise 链
// stale 判定：PID 不存在 或 lastHeartbeat 超过阈值

const STALE_MS = 30_000;          // 心跳超时阈值（毫秒）
const WATCH_DEBOUNCE_MS = 100;    // fs.watch 防抖时间
const REGISTRY_VERSION = 1;

function isProcessAlive(pid) {
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

export function createInstanceRegistry({ fs: fsMod, path: pathMod, os: osMod, registryPath }) {
  if (!fsMod || !pathMod || !osMod || !registryPath) {
    throw new Error('createInstanceRegistry: 必须提供 fs/path/os/registryPath');
  }

  // 进程内写串行化：所有 mutate 操作都 await 这条链
  let writeChain = Promise.resolve();

  function enqueueWrite(task) {
    const next = writeChain.then(task, task);
    // 不让单个失败阻塞后续操作
    writeChain = next.catch(() => {});
    return next;
  }

  async function readAll() {
    try {
      const raw = await fsMod.readFile(registryPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.instances && typeof parsed.instances === 'object') {
        return parsed;
      }
      return { version: REGISTRY_VERSION, instances: {} };
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return { version: REGISTRY_VERSION, instances: {} };
      }
      console.warn(`[instanceRegistry] 读取注册表失败，按空表处理: ${err?.message || err}`);
      return { version: REGISTRY_VERSION, instances: {} };
    }
  }

  async function writeAll(obj) {
    const payload = {
      version: REGISTRY_VERSION,
      ...obj,
      instances: obj.instances || {}
    };
    const tmpPath = `${registryPath}.tmp`;
    await fsMod.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
    await fsMod.rename(tmpPath, registryPath);
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
      const obj = await readAll();
      obj.instances[String(pid)] = entry;
      await writeAll(obj);
    });
    return entry;
  }

  async function unregister(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return;
    await enqueueWrite(async () => {
      const obj = await readAll();
      if (obj.instances && obj.instances[String(pid)]) {
        delete obj.instances[String(pid)];
        await writeAll(obj);
      }
    });
  }

  async function heartbeat(pid, updates = {}) {
    if (!Number.isInteger(pid) || pid <= 0) return;
    await enqueueWrite(async () => {
      const obj = await readAll();
      const key = String(pid);
      const existing = obj.instances[key];
      if (!existing) {
        // 如果心跳时条目不存在（被裁剪或被外部清理），跳过；
        // 由调用方负责周期性 re-register
        return;
      }
      obj.instances[key] = {
        ...existing,
        ...(updates.projectPath ? { projectPath: updates.projectPath } : {}),
        ...(updates.projectName ? { projectName: updates.projectName } : {}),
        lastHeartbeat: Date.now()
      };
      await writeAll(obj);
    });
  }

  async function list({ pruneStale = true } = {}) {
    const obj = await readAll();
    let instances = obj.instances || {};
    if (pruneStale) {
      instances = pruneInPlace(instances);
      // 如果发生了裁剪，持久化回去
      const hasChange = Object.keys(instances).length !== Object.keys(obj.instances || {}).length;
      if (hasChange) {
        await enqueueWrite(async () => {
          const fresh = await readAll();
          fresh.instances = pruneInPlace(fresh.instances || {});
          await writeAll(fresh);
        });
      }
    }
    const arr = Object.values(instances);
    arr.sort((a, b) => (a.port || 0) - (b.port || 0));
    return arr;
  }

  // 监听注册表文件变化；callback 会在 debounce 后被调用，参数是最新 list
  // fsWatch 参数：node 'fs' 模块的 watch 函数（同步 + EventEmitter 形式）
  function watch(callback, fsWatch) {
    if (typeof callback !== 'function') {
      throw new Error('watch: callback 必填');
    }
    if (typeof fsWatch !== 'function') {
      console.warn('[instanceRegistry] 未提供 fs.watch，跨进程推送将不可用');
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
        console.warn(`[instanceRegistry] watch 回调失败: ${e?.message || e}`);
      }
    };

    // 周期性 prune：即便没有其他进程写入注册表，也定期清理本地失效条目
    // （例如所有 server 都强 kill 后，文件里残留的僵尸条目会被自动清理）
    pruneTimer = setInterval(() => {
      if (closed) return;
      list({ pruneStale: true }).catch(() => {});
    }, STALE_MS / 3);

    try {
      watcher = fsWatch(registryPath, { persistent: false }, () => {
        if (closed) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(fire, WATCH_DEBOUNCE_MS);
      });
      if (watcher && typeof watcher.on === 'function') {
        watcher.on('error', (err) => {
          console.warn(`[instanceRegistry] fs.watch 出错: ${err?.message || err}`);
        });
      }
    } catch (err) {
      console.warn(`[instanceRegistry] 无法启动 fs.watch (${err?.message || err})，跨进程推送将不可用，请依赖轮询`);
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
    _STALE_MS: STALE_MS
  };
}
