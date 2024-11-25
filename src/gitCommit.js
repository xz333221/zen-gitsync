#!/usr/bin/env node

const { exec, execSync } = require('child_process')

// 有时候有乱码呢123神奇
const readline = require('readline')
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

function rlPromisify (fn) {
  return async (...args) => {
    return new Promise((resolve,reject) => fn(...args, resolve, reject))
  }
}

const question = rlPromisify(rl.question.bind(rl))

const colors = [
  '\x1b[31m',  // 红色
  '\x1b[32m',  // 绿色
  '\x1b[33m',  // 黄色
  '\x1b[34m',  // 蓝色
  '\x1b[35m',  // 紫色
  '\x1b[36m',  // 青色
];

function getRandomColor() {
  const randomIndex = Math.floor(Math.random() * colors.length);
  return colors[randomIndex];
}

function resetColor() {
  return '\x1b[0m';
}

function coloredLog(...args) {
  const color = getRandomColor();
  console.log(color, ...args.map(arg => `\n${arg}`), resetColor());
}


class GitCommit {
  constructor () {
    this.statusOutput = null
    this.init()
  }

  async init () {
    try {
      // 设置终端字符编码为UTF-8
      execSync('chcp 65001')

      this.statusOutput = this.execSyncGitCommand('git status')
      if (this.statusOutput.includes('nothing to commit, working tree clean')) {
        return
      }
      this.execSyncGitCommand('git diff')

      // 等待用户输入提交信息
      const commitMessage = await question('请输入提交信息：')

      // 执行 git add .
      this.statusOutput.includes('(use "git add <file>') && this.execSyncGitCommand('git add .')

      // 执行 git commit
      if (this.statusOutput.includes('Untracked files:') || this.statusOutput.includes('Changes not staged for commit') || this.statusOutput.includes('Changes to be committed')) {
        this.execSyncGitCommand(`git commit -m "${commitMessage || '提交'}"`)
      }


      // 检查是否需要拉取更新
      this.statusOutput.includes('use "git pull') && this.execSyncGitCommand('git pull')

      // 执行 git push
      // this.execSyncGitCommand(`git push`);
      this.execGitCommand('git push', {}, (error, stdout, stderr) => {
        console.log('提交完成。')
        this.execSyncGitCommand(`git log -n 1 --pretty=format:"%H %d %ad%n%B" --date=iso`)
        process.exit();
      })
    } catch (e) {
      console.log(`e ==> `, e)
    }
  }

  execSyncGitCommand (command, options = {}) {
    try {
      let { encoding = 'utf-8', maxBuffer = 30 * 1024 * 1024, cwd = process.cwd() } = options
      cwd = process.argv[2] || cwd
      const output = execSync(command, { encoding, maxBuffer, cwd })
      let result = output.trim()
      coloredLog(command, result)
      return result
    } catch (e) {
      console.log(`执行命令出错 ==> `, command, e)
      throw new Error(e)
    }
  }

  execGitCommand (command, options = {}, callback) {
    let { encoding = 'utf-8', maxBuffer = 30 * 1024 * 1024, cwd = process.cwd() } = options
    cwd = process.argv[2] || cwd
    exec(command, { encoding, maxBuffer, cwd }, (error, stdout, stderr) => {
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

new GitCommit()
