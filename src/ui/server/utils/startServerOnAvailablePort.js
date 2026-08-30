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
import { execFileSync } from 'node:child_process'
import logger from './logger.js'

// Windows 会把成块的端口划进"排除范围"（Hyper-V / Docker / WSL 预留，或系统保留的
// 动态端口块）。落在这些段里的端口，listen() 报的是 EACCES 而不是 EADDRINUSE ——
// 端口明明没人占，系统就是不让绑。查看方式：
//   netsh int ip show excludedportrange protocol=tcp
// 这些段通常连续上百个端口，靠 +1 逐个撞过去极慢（旧实现每个端口还要 sleep 800ms，
// 撞进一段 100 端口的保留区就是 80 秒）。所以这里懒加载一次并缓存：
// 只有真撞到 EACCES 时才去查 netsh，正常启动路径零开销。
let excludedRanges = null

/**
 * 解析 `netsh int ip show excludedportrange protocol=tcp` 的输出。
 * 纯函数，单独导出以便测试（表头随系统语言变化，解析规则必须稳）。
 * @param {string} output netsh 原始输出
 * @returns {Array<[number, number]>} 保留端口段 [起始, 结束] 列表
 */
export function parseExcludedPortRanges(output) {
  const ranges = []
  if (typeof output !== 'string' || !output) return ranges

  // 表头随系统语言变化（开始端口/结束端口 vs Start Port/End Port），
  // 只认数据行：行尾跟着两个十进制数，行尾的 * 表示"管理的端口排除"
  const re = /(\d{1,5})\s+(\d{1,5})\s*\**\s*$/gm
  let match
  while ((match = re.exec(output)) !== null) {
    const start = Number(match[1])
    const end = Number(match[2])
    if (Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start && end < 65536) {
      ranges.push([start, end])
    }
  }
  return ranges
}

function getExcludedPortRanges() {
  if (excludedRanges !== null) return excludedRanges
  excludedRanges = []

  if (process.platform !== 'win32') return excludedRanges

  try {
    const output = execFileSync(
      'netsh',
      ['int', 'ip', 'show', 'excludedportrange', 'protocol=tcp'],
      { encoding: 'utf8', timeout: 3000, windowsHide: true }
    )
    excludedRanges = parseExcludedPortRanges(output)
    if (excludedRanges.length) {
      logger.info(`检测到 ${excludedRanges.length} 个系统保留端口段，启动时将自动跳过`)
    }
  } catch (err) {
    // 查不到（非 Windows / netsh 不可用 / 超时）就退化成逐个 +1 试，不影响主流程
    logger.info(`查询系统保留端口段失败，退化为逐端口探测: ${err?.message || err}`)
  }

  return excludedRanges
}

/**
 * 端口是否落在系统保留段内，是则返回该段，否则返回 null。
 * 注意：内部会触发 netsh 查询，只在确认需要时调用。
 */
function findExcludedRange(port) {
  return getExcludedPortRanges().find(([start, end]) => port >= start && port <= end) || null
}

// 监听地址：默认只绑回环地址。
// GUI 服务没有任何认证层，绑 0.0.0.0 等于把 /api/exec-stream（命令执行）、
// /api/add-npm-script（写 package.json scripts）、/api/open-file（用系统
// 关联程序打开任意文件）等接口裸奔在局域网上，同网段任何主机都可调用。
// 确有远程访问 / WSL 跨环境需求时，用 ZEN_HOST=0.0.0.0 显式放开。
const DEFAULT_HOST = '127.0.0.1'

// 浏览器访问地址不要使用 localhost：Windows 上它可能优先解析到 ::1，
// 而另一个程序恰好占用 IPv6 同端口时，页面会被打开到错误的服务。
// 默认服务明确绑定 IPv4 回环，因此浏览器也必须使用同一个地址。
function getBrowserHost(bindHost) {
  return bindHost === DEFAULT_HOST ? DEFAULT_HOST : 'localhost'
}

function normalizeHost(raw) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  return value || DEFAULT_HOST
}

export async function startServerOnAvailablePort({
  httpServer,
  startPort,
  chalk,
  open,
  noOpen,
  isGitRepo,
  savePortToFile,
  fsSync,
  maxTries = 100,
  callbackExecutedRef,
  host
}) {
  const bindHost = normalizeHost(host ?? process.env.ZEN_HOST)
  let currentPort = startPort;
  const maxPort = startPort + maxTries;
  const getCallbackExecuted = () => {
    if (callbackExecutedRef && typeof callbackExecutedRef === 'object' && 'value' in callbackExecutedRef) {
      return Boolean(callbackExecutedRef.value);
    }
    return false;
  };

  const setCallbackExecuted = (value) => {
    if (callbackExecutedRef && typeof callbackExecutedRef === 'object' && 'value' in callbackExecutedRef) {
      callbackExecutedRef.value = Boolean(value);
    }
  };

  let lastErrorCode = null;

  while (currentPort < maxPort) {
    try {
      if (currentPort > startPort) {
        // 系统保留端口（EACCES）不会随时间释放，没必要等；
        // 只有"被占用"（EADDRINUSE）才需要给端口一点时间释放
        if (lastErrorCode !== 'EACCES') {
          await new Promise(resolve => setTimeout(resolve, 800));
        }
        logger.info(`尝试端口 ${currentPort}...`);
      }

      // 本次尝试要绑的端口。回调里必须用它校验，不能用外层的 currentPort：
      // 闭包捕获的是同一个变量，重试时它的值早就变了
      const attemptPort = currentPort;

      await new Promise((resolve, reject) => {
        // 每次尝试独立的 settled。失败之后即便平台补发了 listening 回调，也不再响应
        let settled = false;

        const cleanup = () => {
          httpServer.removeListener('error', errorHandler);
          httpServer.removeListener('listening', listeningHandler);
        };

        const errorHandler = (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        };

        const listeningHandler = () => {
          // 过期回调防护。server.listen(port, host, cb) 的 cb 会被注册成
          // once('listening', cb)，而 listen 失败时只 emit 'error'，这个 cb
          // 摘不掉。等后面某次 listen 成功 emit 'listening'，历史残留的 cb
          // 会和新 cb 一起被依次触发 —— 残留 cb 抢先执行会把防重入标志置位，
          // 本次真正成功的回调就会直接 return，await 永久挂起，服务起不来。
          // 这里用"本次是否已 settle"+"实际监听端口是否为本次目标"双重拦截。
          if (settled) return;
          const addr = httpServer.address();
          if (addr && addr.port !== attemptPort) return;

          settled = true;
          cleanup();

          if (getCallbackExecuted()) return;
          setCallbackExecuted(true);

          console.log(chalk.green('======================================'));
          console.log(chalk.green(`  Zen GitSync 服务器已启动`));
          const browserHost = getBrowserHost(bindHost);
          console.log(chalk.green(`  访问地址: http://${browserHost}:${attemptPort}`));
          console.log(chalk.green(`  启动时间: ${new Date().toLocaleString()}`));
          // 非回环地址才提示，默认情况保持安静（避免每次启动都刷警告）
          if (bindHost !== DEFAULT_HOST) {
            console.log(chalk.yellow(`  监听地址: ${bindHost}（已放开非本地访问，请确认网络环境可信）`));
          }

          if (isGitRepo) {
            console.log(chalk.green(`  当前目录是Git仓库`));
          } else {
            console.log(chalk.yellow(`  当前目录不是Git仓库，文件监控未启动`));
          }

          console.log(chalk.green('======================================'));

          savePortToFile(attemptPort);

          // 自拉起重启通知：父进程 spawn 时设置了 ZEN_RESTART_NOTIFY_PATH
          // 子进程成功 bind 端口后,把端口写到该文件作为"已就绪"信号
          // （instanceRegistry 在 EPERM 环境下不可用,这是回退通道）
          const notifyPath = process.env.ZEN_RESTART_NOTIFY_PATH;
          if (notifyPath && fsSync) {
            try {
              fsSync.writeFileSync(notifyPath, String(attemptPort), 'utf8');
            } catch (_) {
              // 通知写失败不影响主流程
            }
          }

          if (!noOpen) {
            setTimeout(() => {
              open(`http://${browserHost}:${attemptPort}`);
            }, 0);
          }

          resolve();
        };

        // 不把成功回调挂在 listen() 的第三个参数上：那样它会被注册成
        // once('listening', cb)，而 listen 失败时只 emit 'error'，这个 cb
        // 摘不掉。显式注册后，失败路径的 cleanup() 能把它清理干净。
        httpServer.once('error', errorHandler);
        httpServer.once('listening', listeningHandler);
        httpServer.listen(attemptPort, bindHost);
      });

      return currentPort;
    } catch (err) {
      lastErrorCode = err?.code || null;

      if (err.code === 'EADDRINUSE') {
        logger.info(`端口 ${currentPort} 被占用，尝试下一个端口...`);
        currentPort++;
      } else if (err.code === 'EACCES') {
        // 端口不让绑：Windows 上绝大多数情况落在系统保留段里。
        // 命中整段就直接跳到段尾之后，否则逐个撞过去会非常慢。
        const range = findExcludedRange(currentPort);
        if (range) {
          logger.info(`端口 ${currentPort} 位于系统保留段 ${range[0]}-${range[1]}，跳到 ${range[1] + 1}...`);
          currentPort = range[1] + 1;
        } else {
          logger.info(`端口 ${currentPort} 无监听权限（可能被系统保留），尝试下一个端口...`);
          currentPort++;
        }
      } else {
        logger.error('启动服务器失败:', err);
        process.exit(1);
      }
    }
  }

  logger.error(`无法找到可用端口 (尝试范围: ${startPort}-${maxPort - 1})`);
  if (process.platform === 'win32' && getExcludedPortRanges().length) {
    logger.error(
      `已跳过的系统保留端口段: ${getExcludedPortRanges()
        .map(([s, e]) => `${s}-${e}`)
        .join(', ')}`
    );
    logger.error('可用 netsh int ip show excludedportrange protocol=tcp 复核；也可用 PORT 环境变量指定其它端口');
  }
  process.exit(1);
}
