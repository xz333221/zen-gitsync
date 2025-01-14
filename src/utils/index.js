// const chalk = require('chalk');
// const boxen = require('boxen');
// const message = chalk.blue('git diff') + '\n' +
//   chalk.red('- line1') + '\n' +
//   chalk.green('+ line2') + '\n' +
//   chalk.cyan('@@ line diff @@');
//
// const options = {
//   padding: 1,
//   margin: 1,
//   borderStyle: 'round',  // 可以选择 'single', 'double', 'round' 等边框样式
//   borderColor: 'yellow'
// };
//
// const boxedMessage = boxen(message, options);
// console.log(boxedMessage);
import stringWidth from 'string-width';
import Table from 'cli-table3';
import chalk from 'chalk';

const printTableWithHeaderUnderline = () => {
  // 获取终端的列数（宽度）
  const terminalWidth = process.stdout.columns;

  // 计算表格的宽度，保证至少有 2 个字符留给边框
  const tableWidth = terminalWidth - 4; // 4 是左右边框和分隔符的宽度

  // 计算每列的宽度
  const colWidths = [tableWidth]; // 只有一列，因此宽度设置为终端宽度

  const table = new Table({
    head: ['Name'],  // 只有一个表头
    colWidths,       // 使用动态计算的列宽
    style: {
      head: ['cyan'], // 表头文字颜色为cyan
      border: ['yellow'],         // 边框颜色为黄色
      compact: true,              // 启用紧凑模式，去掉不必要的空白
    },
    wordWrap: true,  // 启用自动换行
  });

  // 向表格中添加不同颜色的行
  table.push(
    [chalk.red('张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三')],
    [chalk.green('李四')],
  );

  console.log(table.toString()); // 输出表格
};

// printTableWithHeaderUnderline();

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

const coloredLog = (...args) => {
  const color = getRandomColor();
  // 获取控制台的宽度
  const terminalWidth = process.stdout.columns;

  const start_line = '┌' + '─'.repeat(terminalWidth - 2) + '┐';
  const end_line = '└' + '─'.repeat(terminalWidth - 2) + '┘';
  let _args = args.filter(arg => !!arg).map(arg => arg.split('\n')).flat().filter(arg => arg.trim() !== '');
  console.log(start_line);
  _args.map(async (arg, i) => {
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
    if (_args[0] === 'git status' && trim_arg.startsWith('deleted:')) {
      _color = '\x1b[31m';
    }
    if (_args[0] === 'git diff' && arg.startsWith('@@ ')) {
      _color = '\x1b[36m';
    }
    // 测试边框
    let fix_end = ''
    let length = stringWidth(arg);
    // if (length < terminalWidth) {
      let fix2 = 0
      if (
        _args[0] === 'git status' && trim_arg.startsWith('modified:')
        || _args[0] === 'git status' && trim_arg.startsWith('deleted:')
        || _args[0] === 'git status' && trim_arg.startsWith('new file:')
      ) {
        fix2 = 6
      }
      if (i === 0) {
        fix2 = 2
      }
      let repeatLen = terminalWidth - length - 3 - fix2
      if (repeatLen < 0) {
        // repeatLen += terminalWidth
        repeatLen = repeatLen % terminalWidth + terminalWidth
      }
      fix_end = ' '.repeat(repeatLen)
      fix_end += "│"
    // }
    // console.log(`fix_end ==> `, fix_end)
    if (i === 0) {
      console.log(`│ \x1b[1m\x1b[34m> ${arg}\x1b[22m\x1b[39m${fix_end}`);
      let mid = '├' + '─'.repeat(terminalWidth - 2) + '┤';
      console.log(mid);
    } else {
      if (arg.trim().length > 0) {
        console.log(`│${_color} ${arg}${resetColor()}${fix_end}`);
      }
    }
  });
  console.log(end_line);
}
export {coloredLog};
