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
const coloredLog = (...args) =>{
  const color = getRandomColor();
  // 获取控制台的宽度
  const terminalWidth = process.stdout.columns;

  // 创建与控制台宽度相同的横线
  // const line = '-'.repeat(terminalWidth);
  const start_line = '┌' + '——'.repeat(terminalWidth / 2 - 1) + '┐';
  const end_line = '└' + '——'.repeat(terminalWidth / 2 - 1) + '┘';
  let _args = args.map(arg => arg.split('\n')).flat().filter(arg => arg.trim() !== '');
  console.log(start_line);
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
  console.log(end_line);
}
module.exports = {
  coloredLog
};
