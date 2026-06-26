#!/usr/bin/env node
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

import {
  coloredLog, errorLog, execGitCommand, showHelp,
  getCwd, judgePlatform, judgeLog, judgeHelp, exec_exit, judgeUnmerged, formatDuration,
  exec_push, execPull, judgeRemote, execDiff, execAddAndCommit, delay, addScriptToPackageJson, addResetScriptToPackageJson
} from './utils/index.js';
import readline from 'readline'
import ora from 'ora';
import chalk from 'chalk';
import config from './config.js';
import {
  registerCleanup, setupSigintHandler,
} from './cli/cleanup.js';
import { validateCustomCommand, isCmdStrictMode, runCustomCommand } from './cli/customCommand.js';

// 延迟加载的重模块 — 这些只在特定子命令路径才需要,启动时加载会无谓拖慢
// CLI 冷启动(其中 startUIServer 还会拉起 Express + Socket.IO + 全部 routes,
// 一次约几十到上百 KB 依赖链)。
//   - startUIServer:仅 `g ui` 子命令使用
//   - boxen / boxenAdaptive / logUpdate / date-fns:仅定时/倒计时 UI 使用
let startUIServerPromise = null;
let boxenImportsPromise = null;

async function loadStartUIServer() {
  if (!startUIServerPromise) {
    startUIServerPromise = import('./ui/server/index.js').then(m => m.default);
  }
  return startUIServerPromise;
}

async function loadBoxenImports() {
  if (!boxenImportsPromise) {
    boxenImportsPromise = (async () => {
      const [boxenMod, uiMod, logUpdateMod, dateFnsMod] = await Promise.all([
        import('boxen'),
        import('./cli/ui.js'),
        import('log-update'),
        import('date-fns/format')
      ]);
      return {
        boxen: boxenMod.default,
        boxenAdaptive: uiMod.boxenAdaptive,
        logUpdate: logUpdateMod.default,
        dateFormat: dateFnsMod.format
      };
    })();
  }
  return boxenImportsPromise;
}

let countdownInterval = null;

async function startCountdown(interval) {
  let remaining = interval;

  // 清除旧的倒计时(同一时刻只允许一个倒计时可见)
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }

  // 懒加载 boxen/logUpdate/date-fns/boxenAdaptive — 这些只在倒计时 UI 用,
  // 单次 `g` 提交不触发,避免冷启动时无谓加载 ~150KB 依赖链。
  const { dateFormat, logUpdate, boxenAdaptive } = await loadBoxenImports();

  const render = () => {
    const nextTime = Date.now() + remaining;
    const formattedTime = dateFormat(nextTime, 'yyyy-MM-dd HH:mm:ss');
    const duration = formatDuration(remaining);

    const message = [
      `🕒 ${chalk.green.bold('倒计时')}`,
      `工作目录: ${chalk.green(getCwd())}`,
      `下次提交: ${chalk.blue(formattedTime)}`,
      `剩余时间: ${chalk.yellow(duration)}`,
      chalk.dim('按 Ctrl+C 终止进程')
    ].join('\n');

    const box = boxenAdaptive(message, {
      padding: 1,
      margin: 1,
      borderColor: 'cyan',
      borderStyle: 'round'
    });

    setTimeout(() => {
      logUpdate(box);
    }, 200);
    // logUpdate(box);
  };

  // 立即渲染一次
  render();

  // 每秒更新
  countdownInterval = setInterval(() => {
    remaining -= 1000;

    if (remaining <= 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
      logUpdate.clear();
      return;
    }

    render();
  }, 1000);
  // 注册到 SIGINT cleanup 表,Ctrl+C 时一并清掉,避免倒计时残影
  registerCleanup('countdown', () => {
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    try { logUpdate.clear(); } catch (_) {}
  });
}

const {loadConfig, saveConfig, handleConfigCommands} = config;
const {defaultCommitMessage} = config

let timer = null

async function createGitCommit(options) {
  try {
    let statusOutput = null
    let exit = options ? !!options.exit : true
    const config = await loadConfig()
    let commitMessage = config.defaultCommitMessage
    let {stdout} = await execGitCommand(['status'])
    statusOutput = stdout
    judgeUnmerged(statusOutput)
    // 先检查本地是否有未提交的更改
    const hasLocalChanges = !statusOutput.includes('nothing to commit, working tree clean');
    if (hasLocalChanges) {
      // 检查是否有 --no-diff 参数
      await execDiff()
      // 获取实际使用的提交信息（可能是用户交互输入的）
      commitMessage = await execAddAndCommit({statusOutput, commitMessage, exit})
      statusOutput.includes('use "git pull') && await execPull()

      // 检查是否有远程更新
      await judgeRemote()  // 等待 judgeRemote 完成

      await exec_push({exit, commitMessage})
    } else {
      if (statusOutput.includes('use "git push')) {
        // 获取最近一次提交的实际信息
        const lastCommitResult = await execGitCommand(['log', '-1', '--pretty=%B'], {log: false});
        const actualCommitMessage = lastCommitResult.stdout.trim();
        await exec_push({exit, commitMessage: actualCommitMessage || commitMessage})
      } else if (statusOutput.includes('use "git pull')) {
        await execPull()
      } else {
        await judgeRemote()  // 等待 judgeRemote 完成
        exec_exit(exit);
      }
    }
  } catch (e) {
    console.error(chalk.red.bold('提交流程错误:'));
    console.error(chalk.dim(e.stack)); // 打印完整错误堆栈
    throw e; // 继续向上抛出错误
  }
}
// 处理文件锁定相关命令
async function handleFileLockCommands() {
  // 锁定文件命令
  const lockFileArg = process.argv.find(arg => arg.startsWith('--lock-file='));
  if (lockFileArg) {
    const filePath = lockFileArg.split('=')[1];
    if (filePath) {
      await config.lockFile(filePath);
    } else {
      console.log(chalk.red('❌ 请指定要锁定的文件路径'));
    }
    process.exit();
  }

  // 解锁文件命令
  const unlockFileArg = process.argv.find(arg => arg.startsWith('--unlock-file='));
  if (unlockFileArg) {
    const filePath = unlockFileArg.split('=')[1];
    if (filePath) {
      await config.unlockFile(filePath);
    } else {
      console.log(chalk.red('❌ 请指定要解锁的文件路径'));
    }
    process.exit();
  }

  // 列出锁定文件命令
  if (process.argv.includes('--list-locked')) {
    await config.listLockedFiles();
    process.exit();
  }

  // 检查文件是否锁定命令
  const checkLockArg = process.argv.find(arg => arg.startsWith('--check-lock='));
  if (checkLockArg) {
    const filePath = checkLockArg.split('=')[1];
    if (filePath) {
      const isLocked = await config.isFileLocked(filePath);
      if (isLocked) {
        console.log(chalk.yellow(`🔒 文件已锁定: ${filePath}`));
      } else {
        console.log(chalk.green(`🔓 文件未锁定: ${filePath}`));
      }
    } else {
      console.log(chalk.red('❌ 请指定要检查的文件路径'));
    }
    process.exit();
  }
}

async function main() {
  judgePlatform()

  // 一次性注册 SIGINT 处理器 — 所有长跑流程(定时 commit / 自定义命令循环 /
  // 倒计时)都通过 registerCleanup 上报,SIGINT 时由统一处理器 drain。
  setupSigintHandler({
    onBeforeCleanup: () => {
      try { logUpdate.clear(); } catch (_) {}
      console.log(chalk.yellow('\n🛑 收到终止信号,清理中...'))
    },
    onAfterCleanup: () => {
      console.log(chalk.yellow('🛑 已清理,退出'))
    }
  })

  // 检查是否是UI命令
  if (process.argv.includes('ui')) {
    const startUIServer = await loadStartUIServer();
    await startUIServer(false, false); // 传入noOpen=false, savePort=false
    return;
  }

  // 检查是否是添加脚本命令
  if (process.argv.includes('addScript')) {
    await addScriptToPackageJson();
    return;
  }

  // 检查是否是添加重置脚本命令
  if (process.argv.includes('addResetScript')) {
    await addResetScriptToPackageJson();
    return;
  }

  // 检查是否有 log 参数
  judgeLog()

  // 检查帮助参数
  judgeHelp()

  await handleConfigCommands();

  // ========== 文件锁定功能 ==========
  await handleFileLockCommands();

  // ========== 新增：自定义cmd定时/定点执行功能 ==========
  const cmdArg = process.argv.find(arg => arg.startsWith('--cmd='));
  if (cmdArg) {
    // 使用正则表达式提取参数值，确保等号不会截断命令内容
    const cmdMatch = cmdArg.match(/^--cmd=(['"]?)(.*)\1$/);
    let cmd = cmdMatch ? cmdMatch[2] : '';
    cmd = cmd.replace(/%%/g, '%'); // 关键修复

    // 输入校验(SEC-CLI-1) — 本地 CLI,用户明确输入,所以检测而非阻止:
    // 拒绝对抗性输入(空 / - 开头 / 超长);危险模式打 warning。
    const cmdValidation = validateCustomCommand(cmd);
    if (!cmdValidation.ok) {
      console.error(chalk.red(`❌ --cmd 校验失败: ${cmdValidation.rejectReason}`));
      process.exit(2); // 2 = 命令行参数错误(Bash 惯例)
    }
    for (const w of cmdValidation.warnings) {
      console.warn(chalk.yellow(`⚠️ ${w}`));
    }
    // 显式 --cmd-strict 时打一条提示,让用户知道 shell 特性被禁用
    if (isCmdStrictMode(process.argv)) {
      console.log(chalk.dim('ℹ️ --cmd-strict 模式:将通过 execFile 拆 argv 执行,管道/重定向/通配符将不可用'));
    }

    const atArg = process.argv.find(arg => arg.startsWith('--at='));
    const intervalArg = process.argv.find(arg => arg.startsWith('--cmd-interval='));
    
    if (atArg) {
      const atMatch = atArg.match(/^--at=(['"]?)(.*)\1$/);
      const atTime = atMatch ? atMatch[2] : '';
      const repeatDaily = process.argv.includes('--daily') || process.argv.includes('--repeat=daily') || process.argv.includes('--at-repeat=daily');

      const runOnce = () => runCustomCommand(cmd);

      const getNextTarget = (now) => {
        if (/^\d{2}:\d{2}$/.test(atTime)) {
          const [h, m] = atTime.split(':').map((v) => parseInt(v, 10));
          if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
          const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
          if (base.getTime() > now.getTime()) return base;
          return new Date(base.getTime() + 24 * 60 * 60 * 1000);
        }

        const parsed = new Date(atTime);
        if (!Number.isFinite(parsed.getTime())) return null;

        if (!repeatDaily) return parsed;

        const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parsed.getHours(), parsed.getMinutes(), parsed.getSeconds(), 0);
        if (base.getTime() > now.getTime()) return base;
        return new Date(base.getTime() + 24 * 60 * 60 * 1000);
      };

      let atTimer = null;
      const scheduleNext = () => {
        const now = new Date();
        const target = getNextTarget(now);
        if (!target) {
          console.error('无效的时间参数');
          return;
        }

        let delay = target.getTime() - now.getTime();
        if (!Number.isFinite(delay)) {
          console.error('无效的时间参数');
          return;
        }

        if (!repeatDaily && delay <= 0) {
          console.log('指定时间已过，不执行自定义命令');
          return;
        }

        if (delay < 0) delay = 0;
        console.log(`将在 ${target.toLocaleString()} 执行: ${cmd}${repeatDaily ? '（每日循环）' : ''}`);
        atTimer = setTimeout(() => {
          runOnce();
          if (repeatDaily) scheduleNext();
        }, delay);
        // 注册到 SIGINT cleanup 表 — Ctrl+C 时由统一处理器清理
        registerCleanup('atTimer', () => {
          if (atTimer) {
            clearTimeout(atTimer);
            atTimer = null;
          }
        });
      };

      scheduleNext();
      // 旧的内联 SIGINT handler 已被 setupSigintHandler 替代,这里不再重复注册
    } else if (intervalArg) {
      // 定时循环执行
      const intervalMatch = intervalArg.match(/^--cmd-interval=(['"]?)(.*)\1$/);
      const interval = intervalMatch ? parseInt(intervalMatch[2], 10) * 1000 : 0;
      if (interval > 0) {
        console.log(`每隔 ${interval/1000} 秒执行: ${cmd}`);
        const cmdIntervalId = setInterval(() => runCustomCommand(cmd, { silent: true }), interval);
        // 注册 cleanup,Ctrl+C 时清掉这个 interval(否则进程不退)
        registerCleanup('cmdInterval', () => clearInterval(cmdIntervalId));
      } else {
        console.error('无效的时间间隔参数');
      }
    } else {
      // 立即执行一次
      runCustomCommand(cmd);
    }
  }
  // ========== 新增功能结束 ==========

  // 判断是否需要执行git自动提交
  const hasGitTask = process.argv.some(arg =>
    arg.startsWith('--interval') ||
    arg === '-y' ||
    arg.startsWith('-m')
  );
  if (hasGitTask || !cmdArg) {
    judgeInterval();
  }
}

const showStartInfo = (interval) => {
  const cwd = getCwd();
  const intervalSeconds = interval / 1000;
  const startTime = new Date().toLocaleString();

  const head = `⏰ 定时提交任务已启动`;

  const message = chalk.green.bold([
    `开始时间: ${chalk.yellow(startTime)}`,
    `工作目录: ${chalk.cyan(cwd)}`,
    `提交间隔: ${chalk.magenta(formatDuration(interval))}`,
  ].join("\n"));

  coloredLog(head, message)
}
// 漂移自由调度的基线时间(由 judgeInterval 在启动时初始化一次)。
// commitAndSchedule 每次循环 nextRunAt += interval,实际 setTimeout 延迟
// = nextRunAt - Date.now()。
let nextRunAt = 0;

const commitAndSchedule = async (interval) => {
  try {
    await createGitCommit({exit: false});
    // await delay(2000)
    await startCountdown(interval); // 启动倒计时(内部已注册 cleanup)

    // 漂移自由的调度 — 每次循环把 nextRunAt 加上 interval,
    // 实际 setTimeout 延迟 = nextRunAt - now:
    //   - 执行时间 < interval:延后到 nextRunAt,自然追平,不累积漂移
    //   - 执行时间 > interval:延迟 = 0(可能 = -X,被 Math.max 钳到 0),立即跑下一轮
    // 之前 setTimeout(..., interval + 100) 在执行时间波动时会持续累积漂移,
    // 长时间运行后周期显著偏离用户配置的 interval。
    nextRunAt += interval;
    const delay = Math.max(0, nextRunAt - Date.now());
    timer = setTimeout(() => commitAndSchedule(interval), delay);
    // 注册到 SIGINT cleanup 表 — Ctrl+C 时统一清掉
    // 注意:cleanup 命名 'commitTimer',每次递归都覆盖上一次的 handler
    // (cleanupTasks.set 同名覆盖语义),保证只清当前 pending 那个 setTimeout
    registerCleanup('commitTimer', () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    });
  } catch (error) {
    console.error('提交出错:', error.message);
    clearTimeout(timer);
    clearInterval(countdownInterval);
    process.exit(1);
  }
};
const judgeInterval = async () => {
  const intervalArg = process.argv.find(arg => arg.startsWith('--interval'));
  if (intervalArg) {
    let interval = parseInt(intervalArg.split('=')[1] || '3600', 10) * 1000;

    showStartInfo(interval);

    // 漂移自由调度的基线 — 首次 commit 立即跑(与之前行为一致),
    // 之后 nextRunAt = startAt + N*interval, 每次循环 nextRunAt += interval
    nextRunAt = Date.now();

    try {
      await commitAndSchedule(interval);
    } catch (error) {
      console.error(chalk.red.bold('定时提交致命错误:'), error.message);
      process.exit(1);
    }
    // 旧的 inline SIGINT handler 已移除,改由 setupSigintHandler 统一处理
  } else {
    createGitCommit({exit: false});
  }
};

main()
