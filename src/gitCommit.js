/**
 *  fileName:gitCommit.js
 *  time:2024/1/20
 *  todo:$END$
 */
const {exec, execSync} = require('child_process')
const os = require('os');

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
const readline = require('readline')
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

const colors = [
  '\x1b[31m',  // 红色
  '\x1b[32m',  // 绿色
  '\x1b[33m',  // 黄色
  '\x1b[34m',  // 蓝色
  '\x1b[35m',  // 紫色
  '\x1b[36m',  // 青色
];

function getRandomColor() {
  return `\x1b[0m`;
  // const randomIndex = Math.floor(Math.random() * colors.length);
  // return colors[randomIndex];
}

function resetColor() {
  return '\x1b[0m';
}

function coloredLog(...args) {
  const color = getRandomColor();
  // 获取控制台的宽度
  const terminalWidth = process.stdout.columns;

  // 创建与控制台宽度相同的横线
  const line = '-'.repeat(terminalWidth);
  let _args = args.map(arg => arg.split('\n')).flat().filter(arg => arg.trim() !== '');
  console.log(line);
  _args.map((arg, i) => {
    let _color = color;
    let trim_arg = arg.trim();
    if (_args[0] === 'git diff' && arg.startsWith('-')) {
      _color = '\x1b[31m';
    }
    if (_args[0] === 'git status' && trim_arg.startsWith('new file:')) {
      _color = '\x1b[31m';
    }
    if (_args[0] === 'git diff' && arg.startsWith('+')) {
      _color = '\x1b[32m';
    }
    if (_args[0] === 'git status' && trim_arg.startsWith('modified:')) {
      _color = '\x1b[32m';
    }
    if (_args[0] === 'git diff' && arg.startsWith('@@ ')) {
      _color = '\x1b[36m';
    }
    if (i === 0) {
      console.log(`|\x1b[1m\x1b[34m ${arg}⬇️\x1b[22m\x1b[39m`);
    } else {
      console.log(`|${_color} ${arg}`, resetColor());
    }
  });
  console.log(line);
}


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
        process.exit();
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

  execSyncGitCommand(command, options = {}) {
    try {
      let {encoding = 'utf-8', maxBuffer = 30 * 1024 * 1024, cwd = process.cwd()} = options
      cwd = process.argv[2] || cwd
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
    cwd = process.argv[2] || cwd
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

new GitCommit()
