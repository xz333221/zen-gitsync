#!/usr/bin/env node

import {exec, execSync} from 'child_process'
import os from 'os'
import {coloredLog} from './utils/index.js';
import readline from 'readline'

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
  constructor() {
    this.statusOutput = null
    this.init()
  }

  async init() {
    try {
      judgePlatform()

      this.statusOutput = this.execSyncGitCommand('git status')
      if (this.statusOutput.includes('nothing to commit, working tree clean')) {
        if (this.statusOutput.includes('use "git push')) {
          this.exec_push()
        } else {
          process.exit();
        }
        return
      }
      this.execSyncGitCommand('git diff')

      // 检查命令行参数，判断是否有 -y 参数
      const autoCommit = process.argv.includes('-y');
      let commitMessage = '提交'; // 默认提交信息

      if (!autoCommit) {
        // 如果没有 -y 参数，则等待用户输入提交信息
        commitMessage = await question('请输入提交信息：');
      }

      // 执行 git add .
      this.statusOutput.includes('(use "git add <file>') && this.execSyncGitCommand('git add .')

      // 执行 git commit
      if (this.statusOutput.includes('Untracked files:') || this.statusOutput.includes('Changes not staged for commit') || this.statusOutput.includes('Changes to be committed')) {
        this.execSyncGitCommand(`git commit -m "${commitMessage || '提交'}"`)
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
    this.execGitCommand('git push', {}, (error, stdout, stderr) => {
      console.log('提交完成。')
      this.execSyncGitCommand(`git log -n 1 --pretty=format:"%B%n%h %d%n%ad" --date=iso`)
      process.exit();
    })
  }

  execSyncGitCommand(command, options = {}) {
    try {
      let {encoding = 'utf-8', maxBuffer = 30 * 1024 * 1024, cwd = process.cwd()} = options
      // cwd = process.argv[2] || cwd
      const output = execSync(command, {encoding, maxBuffer, cwd})
      let result = output.trim()
      coloredLog(command, result)
      return result
    } catch (e) {
      console.log(`执行命令出错 ==> `, command, e)
      throw new Error(e)
    }
  }

  execGitCommand(command, options = {}, callback) {
    let {encoding = 'utf-8', maxBuffer = 30 * 1024 * 1024, cwd = process.cwd()} = options
    // cwd = process.argv[2] || cwd
    exec(command, {encoding, maxBuffer, cwd}, (error, stdout, stderr) => {
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
    let interval = intervalArg.split('=')[1] || 15; // 默认间隔为1小时
    interval = parseInt(interval, 10) * 1000; // 将间隔时间转换为毫秒
    if (isNaN(interval)) {
      console.error('无效的间隔时间，请使用 --interval=秒数');
      process.exit(1);
    }
    if (timer) {
      clearInterval(timer);
    }
    timer = setInterval(() => {
      new GitCommit()
    }, interval)
  } else {
    new GitCommit()
  }
};
judgeInterval()
