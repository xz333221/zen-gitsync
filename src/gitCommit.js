#!/usr/bin/env node
import {
  coloredLog, errorLog, execGitCommand, execSyncGitCommand, showHelp,
  getCwd, judgePlatform, judgeLog, judgeHelp, exec_exit, judgeUnmerged, formatDuration,
  exec_push, execPull, judgeRemote, execDiff, execAddAndCommit, delay
} from './utils/index.js';
import readline from 'readline'
import ora from 'ora';
import chalk from 'chalk';
import boxen from 'boxen';
import config from './config.js';
import dateFormat from 'date-fns/format';
import logUpdate from 'log-update';

let countdownInterval = null;

function startCountdown(interval) {
  let remaining = interval;

  // 清除旧的倒计时
  if (countdownInterval) {
    clearInterval(countdownInterval);
  }

  const render = () => {
    const nextTime = Date.now() + remaining;
    const formattedTime = dateFormat(nextTime, 'yyyy-MM-dd HH:mm:ss');
    const duration = formatDuration(remaining);

    const message = [
      chalk.green.bold('🕒 倒计时'),
      chalk.cyan(`下次提交: ${formattedTime}`),
      chalk.yellow(`剩余时间: ${duration}`),
      chalk.dim('按 Ctrl+C 终止进程')
    ].join('\n');

    const box = boxen(message, {
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
      logUpdate.clear();
      return;
    }

    render();
  }, 1000);
}

const {loadConfig, saveConfig, handleConfigCommands} = config;
const {defaultCommitMessage} = config

let timer = null

async function createGitCommit(options) {
  // console.log(`自动提交流程开始=====================>`)
  try {
    let statusOutput = null
    let exit = options ? !!options.exit : true
    const config = await loadConfig()
    let commitMessage = config.defaultCommitMessage
    let {stdout} = await execGitCommand('git status')
    statusOutput = stdout
    judgeUnmerged(statusOutput)
    // 先检查本地是否有未提交的更改
    const hasLocalChanges = !statusOutput.includes('nothing to commit, working tree clean');
    if (hasLocalChanges) {
      // 检查是否有 --no-diff 参数
      await execDiff()
      await execAddAndCommit({statusOutput, commitMessage})
      statusOutput.includes('use "git pull') && await execPull()

      // 检查是否有远程更新
      await judgeRemote()  // 等待 judgeRemote 完成

      await exec_push({exit, commitMessage})
    } else {
      if (statusOutput.includes('use "git push')) {
        await exec_push({exit, commitMessage})
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
async function main() {
  judgePlatform()

  // 检查是否有 log 参数
  judgeLog()

  // 检查帮助参数
  judgeHelp()

  await handleConfigCommands();

  judgeInterval();
}

const showStartInfo = (interval) => {
  const cwd = getCwd();
  const intervalSeconds = interval / 1000;
  const startTime = new Date().toLocaleString();

  const head = `⏰ 定时提交任务已启动`;

  const message = chalk.green.bold([
    `开始时间: ${chalk.yellow(startTime)}`,
    `工作目录: ${chalk.cyan(cwd)}`,
    `提交间隔: ${chalk.magenta(formatDuration(interval))} (${intervalSeconds} 秒)`,
  ].join("\n"));

  coloredLog(head, message)
  // console.log('\n'.repeat(6));
}
const commitAndSchedule = async (interval) => {
  try {
    await createGitCommit({exit: false});
    // await delay(2000)
    startCountdown(interval); // 启动倒计时

    // 设置定时提交
    timer = setTimeout(async () => {
      await commitAndSchedule(interval);
    }, interval + 100);
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

    try {
      await commitAndSchedule(interval);
    } catch (error) {
      console.error(chalk.red.bold('定时提交致命错误:'), error.message);
      process.exit(1);
    }

    // 处理退出清理
    process.on('SIGINT', () => {
      logUpdate.clear();
      clearTimeout(timer);
      clearInterval(countdownInterval);
      console.log(chalk.yellow('\n🛑 定时任务已终止'));
      process.exit();
    });
  } else {
    createGitCommit({exit: false});
  }
};
// const judgeInterval = async () => {
//   // 判断是否有 --interval 参数
//   const intervalArg = process.argv.find(arg => arg.startsWith('--interval'));
//   if (intervalArg) {
//     // // console.log(`intervalArg ==> `, intervalArg)
//     // let interval = intervalArg.split('=')[1] || 60 * 60; // 默认间隔为1小时
//     // // console.log(`interval ==> `, interval)
//     // interval = parseInt(interval, 10) * 1000; // 将间隔时间转换为毫秒
//     // // console.log(`interval ==> `, interval)
//     // if (isNaN(interval)) {
//     //   console.log('无效的间隔时间，请使用 --interval=秒数');
//     //   process.exit(1);
//     // }
//     // if (timer) {
//     //   console.log(`清空定时器`)
//     //   clearInterval(timer);
//     //   timer = null;
//     // }
//     // showStartInfo(interval);
//     // await createGitCommit({exit: false})
//     //
//     // timer = setInterval(() => {
//     //   // console.log(`定时执行`)
//     //   createGitCommit({exit: false})
//     // }, interval)
//
//     let interval = parseInt(intervalArg.split('=')[1] || '3600', 10) * 1000;
//     // const showUpdates = () => {
//     //   showNextCommitTime(interval);
//     //   // 每小时更新一次时间显示
//     //   timer = setTimeout(() => {
//     //     showUpdates();
//     //   }, 20000); // 每小时更新一次
//     // };
//
//     const commitAndSchedule = async (interval) => {
//       try {
//         await createGitCommit({exit: false});
//         startCountdown(interval); // 启动倒计时
//
//         // 设置定时提交
//         timer = setTimeout(async () => {
//           await commitAndSchedule(interval);
//         }, interval);
//       } catch (error) {
//         console.error('提交出错:', error.message);
//       }
//     };
//
//     await commitAndSchedule();
//
//     // 设置定时提交
//     timer = setInterval(commitAndSchedule, interval);
//   } else {
//     createGitCommit({exit: false})
//   }
// };

main()
