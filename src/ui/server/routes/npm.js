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
import express from 'express';
import logger from '../utils/logger.js'
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { exec, spawn } from 'child_process';
import https from 'https';
import { fileURLToPath } from 'url';
import { getRegistryPath } from '../utils/instanceRegistry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function registerNpmRoutes({
  app,
  getCurrentProjectPath
}) {
  // 标记是否有升级任务在跑（防并发）
  let activeUpgrade = false;
  // 标记是否有重启任务在跑（防并发）
  let activeRestart = false;
  // 自拉起重启相关常量
  const RESTART_TIMEOUT_MS = 8000;   // 子进程必须在此时间内注册到 instanceRegistry
  const REGISTRY_POLL_MS = 250;      // 轮询注册表文件间隔
  const EXIT_DELAY_MS = 100;         // 子进程就绪后给前端的最后缓冲时间

  // ========== 应用自升级相关 API ==========

  // 解析"自拉起"要 spawn 的入口绝对路径。
  // 优先 process.argv[1](开发态 server.js / 生产态 src/gitCommit.js 都是绝对路径),
  // 但 launch.json 的 backend 是 `node -e "...process.argv = [...]; require('./server.js')"`,
  // 这种篡改出来的 argv[1] 是相对路径 "server.js",不能直接 spawn。
  // 回退: 用 __dirname 推导 src/ui/server/index.js 的同级 server.js(仓库根)
  function resolveRestartEntry() {
    const arg = process.argv[1]
    if (arg && path.isAbsolute(arg) && fsSync.existsSync(arg)) {
      return { entry: arg, args: process.argv.slice(2) }
    }
    // 回退到仓库根的 server.js(开发态入口),保留原 PORT 等环境变量
    const fallback = path.resolve(__dirname, '../../../..', 'server.js')
    if (fsSync.existsSync(fallback)) {
      // 透传用户原始 argv[2..](--no-open 等);如果原 argv[1] 是 "server.js" 这类相对路径,
      // 用户大概率没传任何 args,所以空数组也合理
      const originalArgs = (arg && !path.isAbsolute(arg)) ? process.argv.slice(2) : []
      return { entry: fallback, args: originalArgs }
    }
    return null
  }

  // 当前安装的版本（从外层 package.json 读取）
  function getCurrentVersion() {
    try {
      // src/ui/server/routes/npm.js -> ../../../../package.json
      const pkgPath = path.resolve(__dirname, '../../../..', 'package.json')
      if (fsSync.existsSync(pkgPath)) {
        const pkg = JSON.parse(fsSync.readFileSync(pkgPath, 'utf8'))
        return pkg.version || '0.0.0'
      }
    } catch (err) {
      logger.error('读取本地 package.json 版本失败:', err)
    }
    return '0.0.0'
  }

  // 简单的 semver 比较：a > b 返回 1, a < b 返回 -1, 相等返回 0
  function compareSemver(a, b) {
    const pa = a.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
    const pb = b.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) > (pb[i] || 0)) return 1
      if ((pa[i] || 0) < (pb[i] || 0)) return -1
    }
    return 0
  }

  // 缓存 npm registry latest 结果 10 分钟
  let latestVersionCache = { value: null, at: 0 }
  const LATEST_TTL_MS = 10 * 60 * 1000

  function fetchLatestFromRegistry() {
    return new Promise((resolve, reject) => {
      const req = https.get(
        'https://registry.npmjs.org/zen-gitsync/latest',
        { timeout: 5000, headers: { 'User-Agent': 'zen-gitsync-app' } },
        (res) => {
          let data = ''
          res.on('data', chunk => { data += chunk })
          res.on('end', () => {
            if (res.statusCode !== 200) {
              return reject(new Error(`registry 返回状态 ${res.statusCode}`))
            }
            try {
              const pkg = JSON.parse(data)
              resolve(pkg.version || null)
            } catch (e) {
              reject(new Error('解析 registry 响应失败'))
            }
          })
        }
      )
      req.on('timeout', () => {
        req.destroy(new Error('registry 请求超时'))
      })
      req.on('error', err => reject(err))
    })
  }

  async function getLatestVersion() {
    const now = Date.now()
    if (latestVersionCache.value && now - latestVersionCache.at < LATEST_TTL_MS) {
      return latestVersionCache.value
    }
    const v = await fetchLatestFromRegistry()
    latestVersionCache = { value: v, at: now }
    return v
  }

  // GET /api/app-version
  app.get('/api/app-version', async (_req, res) => {
    const current = getCurrentVersion()
    try {
      const latest = await getLatestVersion()
      const hasUpdate = !!latest && compareSemver(latest, current) > 0
      res.json({ success: true, current, latest, hasUpdate })
    } catch (err) {
      // 拉取失败时仍返回当前版本，前端据此决定是否显示升级按钮
      res.json({
        success: false,
        current,
        latest: null,
        hasUpdate: false,
        error: err.message
      })
    }
  })

  // POST /api/app-upgrade  - 流式 NDJSON: { type: 'stdout'|'stderr'|'done'|'error', ... }
  app.post('/api/app-upgrade', (req, res) => {
    // 防并发：同一时刻只允许一个升级任务
    if (activeUpgrade) {
      res.status(409).json({ success: false, error: '已有升级任务在进行中' })
      return
    }

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()

    const send = (obj) => {
      res.write(JSON.stringify(obj) + '\n')
    }

    // Windows 上 npm install -g 通常不需要管理员；*nix 需要 sudo。
    // 用 sudo -n（非交互式）检测是否可免密，失败时让用户用 sudo 重启 GUI
    const isWin = process.platform === 'win32'
    const npmCmd = isWin ? 'npm.cmd' : 'npm'
    const args = ['install', '-g', 'zen-gitsync', '--registry', 'https://registry.npmjs.org/']
    const cmd = isWin ? npmCmd : 'sudo'
    const finalArgs = isWin ? args : ['-n', npmCmd, ...args]

    activeUpgrade = send
    const cleanup = () => { activeUpgrade = null }

    let child
    try {
      child = spawn(cmd, finalArgs, {
        env: { ...process.env, FORCE_COLOR: '0' },
        windowsHide: true,
        // Windows 下调用 .cmd 必须 shell:true
        shell: isWin
      })
    } catch (err) {
      send({ type: 'error', message: `启动升级进程失败: ${err.message}` })
      send({ type: 'done', code: -1 })
      res.end()
      cleanup()
      return
    }

    send({ type: 'stdout', message: `$ ${cmd} ${finalArgs.join(' ')}\n` })

    child.stdout.on('data', (buf) => send({ type: 'stdout', message: buf.toString() }))
    child.stderr.on('data', (buf) => send({ type: 'stderr', message: buf.toString() }))

    child.on('error', (err) => {
      send({ type: 'error', message: `升级进程错误: ${err.message}` })
    })

    child.on('close', (code) => {
      if (code === 0) {
        send({ type: 'stdout', message: '\n✅ 升级完成，新版本已全局安装。\n' })
        // 清理缓存，强制下次重新拉 latest
        latestVersionCache = { value: null, at: 0 }
      } else {
        let hint = ''
        if (!isWin) {
          hint = '（提示：在 macOS/Linux 上全局安装需要 sudo，请用管理员权限重启 GUI 后再试）'
        }
        send({ type: 'error', message: `\n升级失败，退出码 ${code}${hint ? ' ' + hint : ''}\n` })
      }
      send({ type: 'done', code })
      res.end()
      cleanup()
    })
  })


  // 同步读取 instanceRegistry 文件并返回 Map<pid, entry>
  // npm.js 在自拉起重启场景下需要轮询此文件判断子进程是否已绑定端口
  function readRegistrySync(p) {
    const m = new Map();
    try {
      const raw = fsSync.readFileSync(p, 'utf-8');
      const obj = JSON.parse(raw);
      const instances = (obj && obj.instances) || {};
      for (const [pidStr, entry] of Object.entries(instances)) {
        const pid = Number(pidStr);
        if (Number.isFinite(pid) && entry && typeof entry === 'object') {
          m.set(pid, entry);
        }
      }
    } catch (_) {
      // 文件不存在或 JSON 损坏 → 返回空 Map，调用方按"还没注册"处理
    }
    return m;
  }

  // POST /api/app-restart  - 自拉起重启：spawn 当前进程入口 + 轮询 instanceRegistry
  //                           拿到子进程端口后通过 NDJSON 流告知前端；旧进程再退出
  app.post('/api/app-restart', (_req, res) => {
    if (activeRestart) {
      res.status(409).json({ success: false, error: '已有重启任务在进行中' });
      return;
    }
    activeRestart = true;

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (obj) => { try { res.write(JSON.stringify(obj) + '\n') } catch (_) {} };
    const finish = () => { try { res.end() } catch (_) {} };
    const release = () => { activeRestart = false };

    // 1. 记录当前所有 instance,后续用"出现的新 pid"判定子进程
    const registryPath = getRegistryPath();
    const before = readRegistrySync(registryPath);
    const start = Date.now();
    const spawnAt = Date.now();

    // 2. 准备子进程 ready 信号文件 —— startServerOnAvailablePort 在 listen 成功后会写入
    //    （instanceRegistry 在 EPERM 环境下不可用,这是回退通道）
    const notifyPath = path.join(
      os.tmpdir(),
      `zen-gitsync-restart-${process.pid}-${Date.now()}.port`
    );
    try { fsSync.unlinkSync(notifyPath) } catch (_) {}  // 清掉旧同名文件

    const entryInfo = resolveRestartEntry();
    if (!entryInfo) {
      send({ type: 'error', message: '无法解析重启入口（process.argv[1] 既不是绝对路径,仓库根也没有 server.js）' });
      finish();
      release();
      return;
    }

    let child;
    try {
      // spawn 当前进程当时是怎么被 node 启的同一个入口（开发态 server.js / 生产态 gitCommit.js）
      // detached: true + stdio: 'ignore' + child.unref() → Windows 上父进程 exit 不会带走子进程
      child = spawn(process.execPath, [entryInfo.entry, ...entryInfo.args], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ZEN_RESTART_NOTIFY_PATH: notifyPath }
      });
      child.unref();
    } catch (err) {
      send({ type: 'error', message: `拉起子进程失败: ${err?.message || err}` });
      try { fsSync.unlinkSync(notifyPath) } catch (_) {}
      finish();
      release();
      return;
    }

    send({ type: 'stdout', message: `[restart] 已在 PID ${child.pid} 拉起子进程 (${entryInfo.entry})，等待端口就绪…\n` });

    const poll = setInterval(() => {
      if (Date.now() - start > RESTART_TIMEOUT_MS) {
        clearInterval(poll);
        try { child.kill('SIGTERM') } catch (_) {}
        send({ type: 'error', message: `子进程 ${RESTART_TIMEOUT_MS / 1000}s 内未就绪（未读到 ${notifyPath}），已 kill` });
        send({ type: 'timeout' });
        finish();
        try { fsSync.unlinkSync(notifyPath) } catch (_) {}
        // 关键：超时分支旧进程不退出，用户仍可继续手动刷新页面
        release();
        return;
      }

      // 优先判定：子进程是否写了 notify 文件（最可靠,不走 instanceRegistry）
      let notifiedPort = null;
      try {
        const raw = fsSync.readFileSync(notifyPath, 'utf8').trim();
        const p = Number(raw);
        if (Number.isInteger(p) && p > 0 && p < 65536) notifiedPort = p;
      } catch (_) {}

      // 兜底：instanceRegistry 里出现的新 pid + port（用于没有 savePort 的环境）
      let registryPort = null;
      if (!notifiedPort) {
        const after = readRegistrySync(registryPath);
        for (const [pid, entry] of after) {
          if (
            !before.has(pid) &&
            Number.isInteger(entry.port) && entry.port > 0 &&
            (entry.lastHeartbeat ?? entry.startedAt ?? 0) >= spawnAt
          ) {
            registryPort = entry.port;
            break;
          }
        }
      }

      const newPort = notifiedPort ?? registryPort;
      if (newPort) {
        clearInterval(poll);
        // 给 EXIT_DELAY_MS 让新进程稳定，再通知前端 + 旧进程退出
        setTimeout(() => {
          send({ type: 'ready', port: newPort });
          finish();
          try { fsSync.unlinkSync(notifyPath) } catch (_) {}
          logger.info('[app-restart] 子进程已就绪，退出当前进程');
          process.exit(0);
        }, EXIT_DELAY_MS);
        return;
      }
    }, REGISTRY_POLL_MS);
  });


  // 读取 package.json 文件内容
  app.post('/api/read-package-json', express.json(), async (req, res) => {
    try {
      const { packageJsonPath } = req.body
      
      // 确定 package.json 的路径
      let pkgPath
      if (packageJsonPath && packageJsonPath.trim()) {
        pkgPath = path.isAbsolute(packageJsonPath) 
          ? packageJsonPath 
          : path.join(getCurrentProjectPath(), packageJsonPath)
      } else {
        pkgPath = path.join(getCurrentProjectPath(), 'package.json')
      }
      
      // 检查文件是否存在
      try {
        const stats = await fs.stat(pkgPath)
        if (stats.isDirectory()) {
          pkgPath = path.join(pkgPath, 'package.json')
        }
        await fs.access(pkgPath)
      } catch (err) {
        return res.status(404).json({ 
          success: false, 
          error: `未找到 package.json 文件: ${pkgPath}` 
        })
      }
      
      // 读取 package.json
      const pkgContent = await fs.readFile(pkgPath, 'utf8')
      const pkg = JSON.parse(pkgContent)
      
      res.json({ 
        success: true, 
        dependencies: pkg.dependencies || {},
        devDependencies: pkg.devDependencies || {},
        peerDependencies: pkg.peerDependencies || {},
        peerDependenciesMeta: pkg.peerDependenciesMeta || {},
        version: pkg.version
      })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 版本号递增或依赖版本修改
  app.post('/api/version-bump', express.json(), async (req, res) => {
    try {
      const { bumpType, packageJsonPath, versionTarget, dependencyName, dependencyVersion, dependencyVersionBump, dependencyType, versionValue } = req.body
      
      // 确定 package.json 的路径
      let pkgPath
      if (packageJsonPath && packageJsonPath.trim()) {
        pkgPath = path.isAbsolute(packageJsonPath) 
          ? packageJsonPath 
          : path.join(getCurrentProjectPath(), packageJsonPath)
      } else {
        pkgPath = path.join(getCurrentProjectPath(), 'package.json')
      }
      
      // 检查文件是否存在（使用 Node.js 原生方法）
      try {
        await fs.access(pkgPath)
      } catch (err) {
        return res.status(404).json({ 
          success: false, 
          error: `未找到 package.json 文件: ${pkgPath}` 
        })
      }
      
      // 读取 package.json
      const pkgContent = await fs.readFile(pkgPath, 'utf8')
      const pkg = JSON.parse(pkgContent)
      
      // 判断是修改 version 还是 dependency
      if (versionTarget === 'dependency') {
        // 修改依赖版本
        const depType = dependencyType || 'dependencies'
        
        if (!pkg[depType]) {
          return res.status(400).json({ 
            success: false, 
            error: `package.json 中未找到 ${depType} 字段` 
          })
        }
        
        if (!pkg[depType][dependencyName]) {
          return res.status(400).json({ 
            success: false, 
            error: `在 ${depType} 中未找到依赖包: ${dependencyName}` 
          })
        }
        
        const oldVersion = pkg[depType][dependencyName]
        let newVersion
        
        // 判断是自动递增还是手动输入
        if (dependencyVersionBump) {
          // 自动递增模式：解析当前版本号并递增
          // 提取版本号中的数字部分（去除 ^, ~, >=, 等前缀）
          const versionMatch = oldVersion.match(/(\^|~|>=|>|<=|<)?(\d+\.\d+\.\d+)/)
          if (!versionMatch) {
            return res.status(400).json({ 
              success: false, 
              error: `无法解析版本号: ${oldVersion}，应为 x.y.z 格式（可带 ^, ~ 等前缀）` 
            })
          }
          
          const prefix = versionMatch[1] || ''
          const versionNumber = versionMatch[2]
          const versionParts = versionNumber.split('.').map(Number)
          
          if (versionParts.length !== 3 || versionParts.some(isNaN)) {
            return res.status(400).json({ 
              success: false, 
              error: `无效的版本号格式: ${versionNumber}` 
            })
          }
          
          // 根据类型递增版本号
          let [major, minor, patch] = versionParts
          if (dependencyVersionBump === 'major') {
            major += 1
            minor = 0
            patch = 0
          } else if (dependencyVersionBump === 'minor') {
            minor += 1
            patch = 0
          } else { // patch
            patch += 1
          }
          
          newVersion = `${prefix}${major}.${minor}.${patch}`
        } else {
          // 手动输入模式
          newVersion = dependencyVersion
        }
        
        pkg[depType][dependencyName] = newVersion
        
        // 写回 package.json（保持格式化）
        await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
        
        res.json({ 
          success: true, 
          oldVersion, 
          newVersion,
          filePath: pkgPath,
          dependencyName,
          dependencyType: depType
        })
      } else {
        // 修改 version 字段
        if (!pkg.version) {
          return res.status(400).json({ 
            success: false, 
            error: 'package.json 中未找到 version 字段' 
          })
        }
        
        const oldVersion = pkg.version

        // 直接设置版本号（来自版本节点输入配置）
        const direct = typeof versionValue === 'string' ? versionValue.trim() : ''
        if (direct) {
          const versionParts = direct.split('.').map(Number)
          if (versionParts.length !== 3 || versionParts.some(isNaN)) {
            return res.status(400).json({
              success: false,
              error: `无效的版本号格式: ${direct}，应为 x.y.z 格式`
            })
          }

          pkg.version = direct
          await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

          return res.json({
            success: true,
            oldVersion,
            newVersion: direct,
            filePath: pkgPath
          })
        }
        
        // 解析版本号
        const versionParts = oldVersion.split('.').map(Number)
        if (versionParts.length !== 3 || versionParts.some(isNaN)) {
          return res.status(400).json({ 
            success: false, 
            error: `无效的版本号格式: ${oldVersion}，应为 x.y.z 格式` 
          })
        }
        
        // 根据类型递增版本号
        let [major, minor, patch] = versionParts
        if (bumpType === 'major') {
          major += 1
          minor = 0
          patch = 0
        } else if (bumpType === 'minor') {
          minor += 1
          patch = 0
        } else { // patch
          patch += 1
        }
        
        const newVersion = `${major}.${minor}.${patch}`
        pkg.version = newVersion
        
        // 写回 package.json（保持格式化）
        await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
        
        res.json({ 
          success: true, 
          oldVersion, 
          newVersion,
          filePath: pkgPath
        })
      }
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })

  // ========== NPM 脚本管理相关 API ==========
  
  // 存储正在进行的扫描任务
  let currentScanAbortController = null;
  
  // 扫描项目目录及子目录下的所有package.json，并提取scripts
  app.get('/api/scan-npm-scripts', async (req, res) => {
    // 取消之前的扫描
    if (currentScanAbortController) {
      currentScanAbortController.aborted = true;
    }
    
    // 创建新的abort controller
    currentScanAbortController = { 
      aborted: false,
      abort() { this.aborted = true; }
    };
    const scanController = currentScanAbortController;
    try {
      const projectRoot = process.cwd();
      const packageJsons = [];
      const startTime = Date.now();
      
      
      // 需要忽略的目录列表（更全面）
      const IGNORED_DIRS = new Set([
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
      
      // 优先扫描的子目录（monorepo常见结构）
      const PRIORITY_DIRS = ['packages', 'apps', 'libs', 'services', 'modules'];
      
      let scannedCount = 0;
      let skippedCount = 0;
      let fileReadCount = 0; // 统计实际读取的文件数量
      
      // 检查指定目录下是否有package.json
      async function checkPackageJson(dir) {
        if (scanController.aborted) return false;
        
        try {
          const packagePath = path.join(dir, 'package.json');
          
          // 先检查文件是否存在，避免不必要的读取
          try {
            await fs.access(packagePath);
          } catch {
            // 文件不存在，直接返回
            return false;
          }
          
          // 检查文件大小，避免读取异常大的文件
          const stats = await fs.stat(packagePath);
          const fileSizeMB = stats.size / (1024 * 1024);
          if (fileSizeMB > 1) {
            // package.json超过1MB是异常情况，跳过
            logger.info(`[NPM扫描] 跳过超大文件 (${fileSizeMB.toFixed(2)}MB): ${packagePath}`);
            return false;
          }
          
          fileReadCount++; // 只有文件存在且大小合理时才计数
          const content = await fs.readFile(packagePath, 'utf8');
          const packageData = JSON.parse(content);
          
          // 只有当scripts存在且至少有一个脚本时才添加
          if (packageData.scripts && Object.keys(packageData.scripts).length > 0) {
            const relativePath = path.relative(projectRoot, dir);
            packageJsons.push({
              path: dir,
              relativePath: relativePath || '.',
              name: packageData.name || path.basename(dir),
              scripts: packageData.scripts,
              version: packageData.version || '0.0.0',
              repository: packageData.repository
            });
            return true;
          }
        } catch (error) {
          // 文件不存在或解析失败，忽略
        }
        return false;
      }
      
      // 递归扫描目录，最大深度4层
      const MAX_DEPTH = 4;
      const MAX_DIRS_PER_LEVEL = 50; // 每层最多扫描50个子目录
      
      // 统计每层深度的扫描数量
      const depthStats = Array(MAX_DEPTH + 1).fill(0).map(() => ({ count: 0, time: 0 }));
      
      async function scanDirectory(dir, depth = 0) {
        if (scanController.aborted) return;
        if (depth > MAX_DEPTH) return;
        
        const depthStart = Date.now();
        scannedCount++;
        depthStats[depth].count++;
        
        // 检查当前目录的package.json
        await checkPackageJson(dir);
        
        // 如果已经达到最大深度，不再继续
        if (depth >= MAX_DEPTH) return;
        
        // 读取子目录
        try {
          if (scanController.aborted) return;
          
          const items = await fs.readdir(dir, { withFileTypes: true });
          const subDirs = [];
          
          // 收集所有子目录
          for (const item of items) {
            if (scanController.aborted) return;
            if (!item.isDirectory()) continue;
            
            const dirName = item.name;
            
            // 跳过忽略的目录
            if (IGNORED_DIRS.has(dirName) || dirName.startsWith('.')) {
              skippedCount++;
              continue;
            }
            
            subDirs.push(item);
          }
          
          // 限制每层扫描的子目录数量
          const dirsToScan = subDirs.slice(0, MAX_DIRS_PER_LEVEL);
          if (subDirs.length > MAX_DIRS_PER_LEVEL) {
            skippedCount += subDirs.length - MAX_DIRS_PER_LEVEL;
          }
          
          // 优先处理优先目录
          const priorityDirs = dirsToScan.filter(item => PRIORITY_DIRS.includes(item.name));
          const normalDirs = dirsToScan.filter(item => !PRIORITY_DIRS.includes(item.name));
          
          // 先扫描优先目录
          for (const item of priorityDirs) {
            if (scanController.aborted) return;
            const subDirPath = path.join(dir, item.name);
            await scanDirectory(subDirPath, depth + 1);
          }
          
          // 再扫描普通目录
          for (const item of normalDirs) {
            if (scanController.aborted) return;
            const subDirPath = path.join(dir, item.name);
            await scanDirectory(subDirPath, depth + 1);
          }
          
        } catch (error) {
          // 忽略无法访问的目录
        }
        
        // 记录该深度的耗时
        depthStats[depth].time += Date.now() - depthStart;
      }
      
      // 执行递归扫描
      const scanStart = Date.now();
      await scanDirectory(projectRoot, 0);
      
      // 扫描完成，清除abort controller
      if (currentScanAbortController === scanController) {
        currentScanAbortController = null;
      }
      
      const scanTime = Date.now() - startTime;
      
      if (scanController.aborted) {
        logger.info(`npm脚本扫描被取消，耗时${scanTime}ms`);
        return res.json({ 
          success: true, 
          packages: [],
          totalScripts: 0,
          cancelled: true
        });
      }
      
      // 输出每层深度的统计
      const depthInfo = depthStats
        .map((stat, depth) => stat.count > 0 ? `深度${depth}:${stat.count}个(${stat.time}ms)` : null)
        .filter(Boolean)
        .join(', ');
      
      
      res.json({ 
        success: true, 
        packages: packageJsons,
        totalScripts: packageJsons.reduce((sum, pkg) => sum + Object.keys(pkg.scripts).length, 0)
      });
    } catch (error) {
      logger.error('扫描npm脚本失败:', error);
      res.status(500).json({ 
        success: false, 
        error: `扫描npm脚本失败: ${error.message}` 
      });
    }
  });
  
  // 扫描项目目录下的所有package.json文件（用于版本管理）
  app.get('/api/scan-package-files', async (req, res) => {
    try {
      // 支持通过查询参数指定扫描目录，如果没有指定则使用当前工作目录
      const customDirectory = req.query.directory;
      const projectRoot = customDirectory || process.cwd();
      
      // 验证目录是否存在且可访问
      try {
        const stats = await fs.stat(projectRoot);
        if (!stats.isDirectory()) {
          return res.status(400).json({ 
            success: false, 
            error: '指定的路径不是一个有效的目录' 
          });
        }
      } catch (error) {
        return res.status(400).json({ 
          success: false, 
          error: `无法访问指定的目录: ${error.message}` 
        });
      }
      
      const packageFiles = [];
      const startTime = Date.now();
      
      // 需要忽略的目录列表
      const IGNORED_DIRS = new Set([
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
      
      let scannedCount = 0;
      let fileReadCount = 0;
      
      // 检查指定目录下是否有package.json
      async function checkPackageJson(dir) {
        try {
          const packagePath = path.join(dir, 'package.json');
          
          // 先检查文件是否存在
          try {
            await fs.access(packagePath);
          } catch {
            return false;
          }
          
          // 检查文件大小
          const stats = await fs.stat(packagePath);
          const fileSizeMB = stats.size / (1024 * 1024);
          if (fileSizeMB > 1) {
            return false;
          }
          
          fileReadCount++;
          const content = await fs.readFile(packagePath, 'utf8');
          const packageData = JSON.parse(content);
          
          // 添加所有有效的package.json文件（不仅仅是有scripts的）
          if (packageData.name || packageData.version) {
            const relativePath = path.relative(projectRoot, dir);
            packageFiles.push({
              path: dir,
              relativePath: relativePath || '.',
              name: packageData.name || path.basename(dir),
              version: packageData.version || '0.0.0',
              displayName: packageData.name ? `${packageData.name} (${packageData.version || '0.0.0'})` : `${path.basename(dir)} (${packageData.version || '0.0.0'})`,
              fullPath: packagePath
            });
            return true;
          }
        } catch (error) {
          // 文件不存在或解析失败，忽略
        }
        return false;
      }
      
      // 递归扫描目录，最大深度4层
      const MAX_DEPTH = 4;
      const MAX_DIRS_PER_LEVEL = 50;
      
      async function scanDirectory(dir, depth = 0) {
        if (depth > MAX_DEPTH) return;
        
        scannedCount++;
        
        // 检查当前目录的package.json
        await checkPackageJson(dir);
        
        // 如果已经达到最大深度，不再继续
        if (depth >= MAX_DEPTH) return;
        
        // 读取子目录
        try {
          const items = await fs.readdir(dir, { withFileTypes: true });
          const subDirs = [];
          
          // 收集所有子目录
          for (const item of items) {
            if (!item.isDirectory()) continue;
            
            const dirName = item.name;
            
            // 跳过忽略的目录
            if (IGNORED_DIRS.has(dirName) || dirName.startsWith('.')) {
              continue;
            }
            
            subDirs.push(item);
          }
          
          // 限制每层扫描的子目录数量
          const dirsToScan = subDirs.slice(0, MAX_DIRS_PER_LEVEL);
          
          // 递归扫描子目录
          for (const item of dirsToScan) {
            const subDirPath = path.join(dir, item.name);
            await scanDirectory(subDirPath, depth + 1);
          }
        } catch (error) {
          // 忽略无法读取的目录
        }
      }
      
      // 开始扫描
      await scanDirectory(projectRoot);
      
      const scanTime = Date.now() - startTime;
      
      res.json({ 
        success: true, 
        packages: packageFiles,
        scanTime,
        scannedCount,
        fileReadCount
      });
    } catch (error) {
      logger.error('扫描package.json文件失败:', error);
      res.status(500).json({ 
        success: false, 
        error: `扫描package.json文件失败: ${error.message}` 
      });
    }
  });
  
  // 在新终端中执行npm脚本
  app.post('/api/run-npm-script', async (req, res) => {
    try {
      const { packagePath, scriptName } = req.body;
      
      if (!packagePath || !scriptName) {
        return res.status(400).json({
          success: false,
          error: '缺少必要参数：packagePath 和 scriptName'
        });
      }
      
      logger.info(`执行npm脚本: ${scriptName} in ${packagePath}`);
      
      // 根据操作系统选择合适的终端命令
      let terminalCommand;
      const npmCommand = `npm run ${scriptName}`;
      
      if (process.platform === 'win32') {
        // Windows: 使用 start 命令打开新的 cmd 窗口
        // /K 参数表示执行命令后保持窗口打开
        terminalCommand = `start cmd /K "cd /d ${packagePath} && ${npmCommand}"`;
      } else if (process.platform === 'darwin') {
        // macOS: 使用 osascript 打开 Terminal.app
        const script = `tell application "Terminal" to do script "cd ${packagePath} && ${npmCommand}"`;
        terminalCommand = `osascript -e '${script}'`;
      } else {
        // Linux: 尝试常见的终端模拟器
        // 优先使用 gnome-terminal, 然后是 xterm
        terminalCommand = `gnome-terminal -- bash -c "cd ${packagePath} && ${npmCommand}; exec bash" || xterm -e "cd ${packagePath} && ${npmCommand}; bash"`;
      }
      
      // 执行命令打开新终端（使用已导入的 exec）
      exec(terminalCommand, (error, stdout, stderr) => {
        if (error) {
          logger.error('打开终端失败:', error);
        }
      });
      
      res.json({ 
        success: true, 
        message: `已在新终端中执行: ${scriptName}`,
        command: npmCommand,
        path: packagePath
      });
    } catch (error) {
      logger.error('执行npm脚本失败:', error);
      res.status(500).json({ 
        success: false, 
        error: `执行npm脚本失败: ${error.message}` 
      });
    }
  });

  // API: 更新npm版本号
  app.post('/api/update-npm-version', async (req, res) => {
    try {
      const { packagePath, versionType } = req.body;
      
      if (!packagePath || !versionType) {
        return res.status(400).json({
          success: false,
          error: '缺少必要参数: packagePath, versionType'
        });
      }

      // 确保路径指向package.json文件
      let packageJsonPath = path.resolve(packagePath);
      if (fsSync.existsSync(packageJsonPath) && fsSync.statSync(packageJsonPath).isDirectory()) {
        packageJsonPath = path.join(packageJsonPath, 'package.json');
      }
      
      // 检查文件是否存在
      if (!fsSync.existsSync(packageJsonPath)) {
        return res.status(404).json({
          success: false,
          error: '找不到package.json文件'
        });
      }

      // 读取package.json
      const packageJson = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf8'));
      
      if (!packageJson.version) {
        return res.status(400).json({
          success: false,
          error: 'package.json中没有version字段'
        });
      }

      const oldVersion = packageJson.version;
      const versionParts = oldVersion.split('.').map(Number);
      
      // 根据类型增加版本号
      switch (versionType) {
        case 'major':
          versionParts[0]++;
          versionParts[1] = 0;
          versionParts[2] = 0;
          break;
        case 'minor':
          versionParts[1]++;
          versionParts[2] = 0;
          break;
        case 'patch':
          versionParts[2]++;
          break;
        default:
          return res.status(400).json({
            success: false,
            error: '无效的版本类型，必须是 major, minor 或 patch'
          });
      }

      const newVersion = versionParts.join('.');
      packageJson.version = newVersion;
      
      // 写回文件
      fsSync.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
      
      logger.info(`已更新npm版本号: ${oldVersion} → ${newVersion} (${packagePath})`);
      
      res.json({
        success: true,
        oldVersion,
        newVersion
      });
    } catch (error) {
      logger.error('更新版本号失败:', error);
      res.status(500).json({
        success: false,
        error: `更新版本号失败: ${error.message}`
      });
    }
  });

  // API: 添加npm脚本
  app.post('/api/add-npm-script', async (req, res) => {
    try {
      const { packagePath, scriptName, scriptCommand } = req.body;
      
      if (!packagePath || !scriptName || !scriptCommand) {
        return res.status(400).json({
          success: false,
          error: '缺少必要参数: packagePath, scriptName, scriptCommand'
        });
      }

      // 确保路径指向package.json文件
      let packageJsonPath = path.resolve(packagePath);
      if (fsSync.existsSync(packageJsonPath) && fsSync.statSync(packageJsonPath).isDirectory()) {
        packageJsonPath = path.join(packageJsonPath, 'package.json');
      }
      
      // 检查文件是否存在
      if (!fsSync.existsSync(packageJsonPath)) {
        return res.status(404).json({
          success: false,
          error: '找不到package.json文件'
        });
      }
      
      // 读取package.json
      const packageJson = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf8'));
      
      // 确保scripts对象存在
      if (!packageJson.scripts) {
        packageJson.scripts = {};
      }
      
      // 检查脚本是否已存在
      if (packageJson.scripts[scriptName]) {
        return res.status(400).json({
          success: false,
          error: `脚本 "${scriptName}" 已存在`
        });
      }
      
      // 添加脚本
      packageJson.scripts[scriptName] = scriptCommand;
      
      // 写回文件（保持格式化）
      fsSync.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
      
      logger.info(`已添加npm脚本: ${scriptName} = ${scriptCommand} (${packagePath})`);
      
      res.json({
        success: true,
        scriptName,
        scriptCommand
      });
    } catch (error) {
      logger.error('添加npm脚本失败:', error);
      res.status(500).json({
        success: false,
        error: `添加npm脚本失败: ${error.message}`
      });
    }
  });

  // API: 更新npm脚本
  app.post('/api/update-npm-script', async (req, res) => {
    try {
      const { packagePath, scriptName, scriptCommand, oldScriptName } = req.body;
      
      if (!packagePath || !scriptName || !scriptCommand) {
        return res.status(400).json({
          success: false,
          error: '缺少必要参数: packagePath, scriptName, scriptCommand'
        });
      }

      // 确保路径指向package.json文件
      let packageJsonPath = path.resolve(packagePath);
      if (fsSync.existsSync(packageJsonPath) && fsSync.statSync(packageJsonPath).isDirectory()) {
        packageJsonPath = path.join(packageJsonPath, 'package.json');
      }
      
      // 检查文件是否存在
      if (!fsSync.existsSync(packageJsonPath)) {
        return res.status(404).json({
          success: false,
          error: '找不到package.json文件'
        });
      }

      // 读取package.json
      const packageJson = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf8'));
      
      // 确保scripts对象存在
      if (!packageJson.scripts) {
        packageJson.scripts = {};
      }

      // 如果改了脚本名称，删除旧的
      if (oldScriptName && oldScriptName !== scriptName) {
        delete packageJson.scripts[oldScriptName];
      }

      // 更新脚本
      packageJson.scripts[scriptName] = scriptCommand;
      
      // 写回文件
      fsSync.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
      
      logger.info(`已更新npm脚本: ${scriptName} = ${scriptCommand} (${packagePath})`);
      
      res.json({
        success: true,
        scriptName,
        scriptCommand
      });
    } catch (error) {
      logger.error('更新npm脚本失败:', error);
      res.status(500).json({
        success: false,
        error: `更新npm脚本失败: ${error.message}`
      });
    }
  });

  // API: 删除npm脚本
  app.post('/api/delete-npm-script', async (req, res) => {
    try {
      const { packagePath, scriptName } = req.body;
      
      if (!packagePath || !scriptName) {
        return res.status(400).json({
          success: false,
          error: '缺少必要参数: packagePath, scriptName'
        });
      }

      // 确保路径指向package.json文件
      let packageJsonPath = path.resolve(packagePath);
      if (fsSync.existsSync(packageJsonPath) && fsSync.statSync(packageJsonPath).isDirectory()) {
        packageJsonPath = path.join(packageJsonPath, 'package.json');
      }
      
      // 检查文件是否存在
      if (!fsSync.existsSync(packageJsonPath)) {
        return res.status(404).json({
          success: false,
          error: '找不到package.json文件'
        });
      }

      // 读取package.json
      const packageJson = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf8'));
      
      // 检查scripts对象和脚本是否存在
      if (!packageJson.scripts || !packageJson.scripts[scriptName]) {
        return res.status(404).json({
          success: false,
          error: `脚本 "${scriptName}" 不存在`
        });
      }

      // 删除脚本
      delete packageJson.scripts[scriptName];
      
      // 写回文件
      fsSync.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
      
      logger.info(`已删除npm脚本: ${scriptName} (${packagePath})`);
      
      res.json({
        success: true,
        scriptName
      });
    } catch (error) {
      logger.error('删除npm脚本失败:', error);
      res.status(500).json({
        success: false,
        error: `删除npm脚本失败: ${error.message}`
      });
    }
  });

  // API: 置顶npm脚本
  app.post('/api/pin-npm-script', async (req, res) => {
    try {
      const { packagePath, scriptName } = req.body;
      
      if (!packagePath || !scriptName) {
        return res.status(400).json({
          success: false,
          error: '缺少必要参数: packagePath, scriptName'
        });
      }

      // 确保路径指向package.json文件
      let packageJsonPath = path.resolve(packagePath);
      if (fsSync.existsSync(packageJsonPath) && fsSync.statSync(packageJsonPath).isDirectory()) {
        packageJsonPath = path.join(packageJsonPath, 'package.json');
      }
      
      // 检查文件是否存在
      if (!fsSync.existsSync(packageJsonPath)) {
        return res.status(404).json({
          success: false,
          error: '找不到package.json文件'
        });
      }

      // 读取package.json
      const packageJson = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf8'));
      
      // 检查scripts对象和脚本是否存在
      if (!packageJson.scripts || !packageJson.scripts[scriptName]) {
        return res.status(404).json({
          success: false,
          error: `脚本 "${scriptName}" 不存在`
        });
      }

      // 保存要置顶的脚本内容
      const scriptCommand = packageJson.scripts[scriptName];
      
      // 删除该脚本
      delete packageJson.scripts[scriptName];
      
      // 创建新的scripts对象，将置顶脚本放在最前面
      const newScripts = {
        [scriptName]: scriptCommand,
        ...packageJson.scripts
      };
      
      packageJson.scripts = newScripts;
      
      // 写回文件
      fsSync.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
      
      logger.info(`已置顶npm脚本: ${scriptName} (${packagePath})`);
      
      res.json({
        success: true,
        scriptName
      });
    } catch (error) {
      logger.error('置顶npm脚本失败:', error);
      res.status(500).json({
        success: false,
        error: `置顶npm脚本失败: ${error.message}`
      });
    }
  });
}
