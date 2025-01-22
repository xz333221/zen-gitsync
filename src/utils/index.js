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
import boxen from "boxen";

const printTableWithHeaderUnderline = (head, content, style) => {
  // 获取终端的列数（宽度）
  const terminalWidth = process.stdout.columns;

  // 计算表格的宽度，保证至少有 2 个字符留给边框
  const tableWidth = terminalWidth - 2; // 左右边框和分隔符的宽度

  // 计算每列的宽度
  const colWidths = [tableWidth]; // 只有一列，因此宽度设置为终端宽度

  if (!style) {
    style = {
      // head: ['cyan'], // 表头文字颜色为cyan
      border: [chalk.reset()],         // 边框颜色
      compact: true,              // 启用紧凑模式，去掉不必要的空白
    }
  }
  // 创建表格实例
  const table = new Table({
    head: [head],  // 只有一个表头
    colWidths,       // 使用动态计算的列宽
    style: style,
    wordWrap: true,  // 启用自动换行
    // chars: {
    //   'top': '═',       // 顶部边框使用长横线
    //   'top-mid': '╤',   // 顶部连接符
    //   'top-left': '╔',   // 左上角
    //   'top-right': '╗',  // 右上角
    //   'bottom': '═',    // 底部边框
    //   'bottom-mid': '╧', // 底部连接符
    //   'bottom-left': '╚',// 左下角
    //   'bottom-right': '╝',// 右下角
    //   'left': '║',      // 左边框
    //   'left-mid': '╟',  // 左连接符
    //   'mid': '═',       // 中间分隔符
    //   'mid-mid': '╪',   // 中间连接符
    //   'right': '║',     // 右边框
    //   'right-mid': '╢', // 右连接符
    //   'middle': '│'     // 中间内容的边界
    // }
  });

  // 向表格中添加不同颜色的行
  // eg:
  // table.push(
  //   [chalk.red('张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三')],
  //   [chalk.green('李四')],
  // );
  content.forEach(item => {
    table.push([item]);
  })

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
const calcColor = (commandLine, str) => {
  let color = 'reset'
  switch (commandLine) {
    case 'git status':
      if (str.startsWith('\t')) {
        color = 'red'
        if (str.startsWith('new file:')) {
          color = 'red'
        }
        if (str.startsWith('modified:')) {
          color = 'green'
        }
        if (str.startsWith('deleted:')) {
          color = 'red'
        }
      }
      break;
    case 'git diff':
      // if (str.startsWith('---')) {
      //   color = 'red'
      // }
      // if (str.startsWith('+++')) {
      //   color = 'green'
      // }
      // if (str.startsWith('@@ ')) {
      //   color = 'cyan'
      // }
      break;
  }
  return color
}
const tableLog = (commandLine, content, type) => {
  let handle_commandLine = `> ${commandLine}`
  let head = chalk.bold.blue(handle_commandLine)
  let style = {
    // head: ['cyan'], // 表头文字颜色为cyan
    border: [chalk.reset()],         // 边框颜色
    compact: true,              // 启用紧凑模式，去掉不必要的空白
  }
  switch (type) {
    case 'error':
      style.head = ['red'];
      content = content.toString().split('\n')
      head = chalk.bold.red(handle_commandLine)
      break;
    case 'common':
      style.head = ['blue'];
      content = content.split('\n')
      break;
    default:
      break;
  }
  content = content.map(item => {
    let fontColor = calcColor(commandLine, item)
    let row = item.replaceAll('\t', '      ')
    return chalk[fontColor](row)
  })

  printTableWithHeaderUnderline(head, content, style)
}
const coloredLog = (...args) => {
  // 获取参数内容
  const commandLine = args[0];
  const content = args[1];
  const type = args[2] || 'common';
  tableLog(commandLine, content, type);
}
const errorLog = (commandLine, content) => {
  // 使用 boxen 绘制带边框的消息
  let msg = ` FAIL ${commandLine}
 content: ${content} `
  const message = chalk.red.bold(msg);
  const box = boxen(message);
  console.log(box); // 打印带有边框的消息
}
export {coloredLog, errorLog};
