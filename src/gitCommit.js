#!/usr/bin/env node

import {exec, execSync} from 'child_process'
import os from 'os'
import {coloredLog} from './utils/index.js';
import readline from 'readline'
import ora from 'ora';
import chalk from 'chalk';
import boxen from 'boxen';

let timer = null

const judgePlatform = () => {
  // 判断是否是 Windows 系统
  if (os.platform() === 'win32') {
    try {
      // 设置终端字符编码为 UTF-8
      execSync('chcp 65001');
    } catch (e) {
      console.error('设置字符编码失败:', e.message);
    }
  }
};
const getCwd = () => {
  const cwdArg = process.argv.find(arg => arg.startsWith('--path')) || process.argv.find(arg => arg.startsWith('--cwd'));
  if (cwdArg) {
    // console.log(`cwdArg ==> `, cwdArg)
    const [, value] = cwdArg.split('=')
    // console.log(`value ==> `, value)
    return value || process.cwd()
  }
  return process.cwd()
}

// 有时候有乱码呢123神奇

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

function rlPromisify(fn) {
  return async (...args) => {
    return new Promise((resolve, reject) => fn(...args, resolve, reject))
  }
}

const question = rlPromisify(rl.question.bind(rl))

class GitCommit {
  constructor(options) {
    this.statusOutput = null
    this.exit = options.exit
    this.commitMessage = `提交`
    this.init()
  }

  exec_exit() {
    if (this.exit) {
      process.exit()
    }
  }

  async init() {
    try {
      judgePlatform()

      this.statusOutput = this.execSyncGitCommand('git status')
      if (this.statusOutput.includes('nothing to commit, working tree clean')) {
        if (this.statusOutput.includes('use "git push')) {
          this.exec_push()
        } else {
          this.exec_exit();
        }
        return
      }
      this.execSyncGitCommand('git diff')

      // 检查命令行参数，判断是否有 -y 参数
      const autoCommit = process.argv.includes('-y');

      if (!autoCommit) {
        // 如果没有 -y 参数，则等待用户输入提交信息
        this.commitMessage = await question('请输入提交信息：');
      }

      // 执行 git add .
      this.statusOutput.includes('(use "git add') && this.execSyncGitCommand('git add .')

      // 执行 git commit
      if (this.statusOutput.includes('Untracked files:') || this.statusOutput.includes('Changes not staged for commit') || this.statusOutput.includes('Changes to be committed')) {
        this.execSyncGitCommand(`git commit -m "${this.commitMessage || '提交'}"`)
      }

      // 检查是否需要拉取更新
      this.statusOutput.includes('use "git pull') && this.execSyncGitCommand('git pull')

      this.exec_push()


    } catch (e) {
      console.log(`e ==> `, e)
    }
  }

  exec_push() {
    // 执行 git push
    // this.execSyncGitCommand(`git push`);
    const spinner = ora('正在推送代码...').start();
    this.execGitCommand('git push', {
      spinner
    }, (error, stdout, stderr) => {

      // 使用 boxen 绘制带边框的消息
      let msg = ` SUCCESS: 提交完成 
 message: ${this.commitMessage || '提交'} 
 time: ${new Date().toLocaleString()} `
      const message = chalk.green.bold(msg);
      const box = boxen(message, {
        // borderStyle: 'round', // 方框的样式
        // borderColor: 'whiteBright', // 边框颜色
        // backgroundColor: 'black', // 背景颜色
      });

      console.log(box); // 打印带有边框的消息
      // this.execSyncGitCommand(`git log -n 1 --pretty=format:"%B%n%h %d%n%ad" --date=iso`)
      this.exec_exit();
    })
  }

  execSyncGitCommand(command, options = {}) {
    try {
      let {encoding = 'utf-8', maxBuffer = 30 * 1024 * 1024} = options
      let cwd = getCwd()
      const output = execSync(command, {encoding, maxBuffer, cwd})
      if(options.spinner){
        options.spinner.stop();
      }
      let result = output.trim()
      coloredLog(command, result)
      return result
    } catch (e) {
      console.log(`执行命令出错 ==> `, command, e)
      throw new Error(e)
    }
  }

  execGitCommand(command, options = {}, callback) {
    let {encoding = 'utf-8', maxBuffer = 30 * 1024 * 1024} = options
    let cwd = getCwd()
    exec(command, {encoding, maxBuffer, cwd}, (error, stdout, stderr) => {
      if(options.spinner){
        options.spinner.stop();
      }
      if (error) {
        coloredLog(command, error)
        return
      }
      if (stdout) {
        coloredLog(command, stdout)
      }
      if (stderr) {
        coloredLog(command, stderr)
      }
      callback && callback(error, stdout, stderr)
    })
  }
}

const judgeInterval = () => {
  // 判断是否有 --interval 参数
  const intervalArg = process.argv.find(arg => arg.startsWith('--interval'));
  if (intervalArg) {
    // console.log(`intervalArg ==> `, intervalArg)
    let interval = intervalArg.split('=')[1] || 60 * 60; // 默认间隔为1小时
    // console.log(`interval ==> `, interval)
    interval = parseInt(interval, 10) * 1000; // 将间隔时间转换为毫秒
    // console.log(`interval ==> `, interval)
    if (isNaN(interval)) {
      console.log('无效的间隔时间，请使用 --interval=秒数');
      process.exit(1);
    }
    if (timer) {
      console.log(`清空定时器`)
      clearInterval(timer);
      timer = null;
    }
    new GitCommit({
      exit: false
    })
    timer = setInterval(() => {
      // console.log(`定时执行`)
      new GitCommit({
        exit: false
      })
    }, interval)
  } else {
    new GitCommit({
      exit: true
    })
  }
};

judgeInterval()
