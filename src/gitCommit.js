#!/usr/bin/env node
import {
  coloredLog, errorLog, execGitCommand, execSyncGitCommand, showHelp,
  getCwd, judgePlatform, judgeLog, judgeHelp, exec_exit, judgeUnmerged, formatDuration,
  exec_push, execPull, judgeRemote, execDiff, execAddAndCommit, delay, addScriptToPackageJson, addResetScriptToPackageJson
} from './utils/index.js';
import readline from 'readline'
import ora from 'ora';
import chalk from 'chalk';
import boxen from 'boxen';
import config from './config.js';
import dateFormat from 'date-fns/format';
import logUpdate from 'log-update';
import startUIServer from './ui/server/index.js';
import { exec } from 'child_process';

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
      `🕒 ${chalk.green.bold('倒计时')}`,
      `工作目录: ${chalk.green(getCwd())}`,
      `下次提交: ${chalk.blue(formattedTime)}`,
      `剩余时间: ${chalk.yellow(duration)}`,
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
      await execAddAndCommit({statusOutput, commitMessage, exit})
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

  // 检查是否是UI命令
  if (process.argv.includes('ui')) {
    await startUIServer();
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

  // ========== 新增：自定义cmd定时/定点执行功能 ==========
  const cmdArg = process.argv.find(arg => arg.startsWith('--cmd='));
  if (cmdArg) {
    // 使用正则表达式提取参数值，确保等号不会截断命令内容
    const cmdMatch = cmdArg.match(/^--cmd=(['"]?)(.*)\1$/);
    let cmd = cmdMatch ? cmdMatch[2] : '';
    cmd = cmd.replace(/%%/g, '%'); // 关键修复
    
    const atArg = process.argv.find(arg => arg.startsWith('--at='));
    const intervalArg = process.argv.find(arg => arg.startsWith('--cmd-interval='));
    
    if (atArg) {
      // 定点执行
      const atMatch = atArg.match(/^--at=(['"]?)(.*)\1$/);
      const atTime = atMatch ? atMatch[2] : '';
      const now = new Date();
      let target;
      if (/^\d{2}:\d{2}$/.test(atTime)) {
        // 只给了时:分，今天的
        const [h, m] = atTime.split(':');
        target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
      } else {
        target = new Date(atTime);
      }
      const delay = target - now;
      if (delay > 0) {
        console.log(`将在 ${target.toLocaleString()} 执行: ${cmd}`);
        setTimeout(() => {
          console.log(`\n[自定义命令执行] ${new Date().toLocaleString()}\n> ${cmd}`);
          exec(cmd, (err, stdout, stderr) => {
            if (err) {
              console.error(`[自定义命令错误]`, err.message);
            }
            if (stdout) console.log(`[自定义命令输出]\n${stdout}`);
            if (stderr) console.error(`[自定义命令错误输出]\n${stderr}`);
          });
        }, delay);
      } else {
        console.log('指定时间已过，不执行自定义命令');
      }
    } else if (intervalArg) {
      // 定时循环执行
      const intervalMatch = intervalArg.match(/^--cmd-interval=(['"]?)(.*)\1$/);
      const interval = intervalMatch ? parseInt(intervalMatch[2], 10) * 1000 : 0;
      if (interval > 0) {
        console.log(`每隔 ${interval/1000} 秒执行: ${cmd}`);
        setInterval(() => {
          console.log(`\n[自定义命令执行] ${new Date().toLocaleString()}\n> ${cmd}`);
          exec(cmd, (err, stdout, stderr) => {
            if (err) {
              console.error(`[自定义命令错误]`, err.message);
            }
            if (stdout) console.log(`[自定义命令输出]\n${stdout}`);
            if (stderr) console.error(`[自定义命令错误输出]\n${stderr}`);
          });
        }, interval);
      } else {
        console.error('无效的时间间隔参数');
      }
    } else {
      // 立即执行一次
      console.log(`[自定义命令立即执行] > ${cmd}`);
      exec(cmd, (err, stdout, stderr) => {
        if (err) {
          console.error(`[自定义命令错误]`, err.message);
        }
        if (stdout) console.log(`[自定义命令输出]\n${stdout}`);
        if (stderr) console.error(`[自定义命令错误输出]\n${stderr}`);
      });
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
