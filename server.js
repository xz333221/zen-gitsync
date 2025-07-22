#!/usr/bin/env node

// 专门的服务器启动文件
import startUIServer from './src/ui/server/index.js';

// 解析命令行参数
const args = process.argv.slice(2);
const noOpen = args.includes('--no-open');

console.log(`启动Zen GitSync服务器${noOpen ? '（不打开浏览器）' : '（自动打开浏览器）'}...`);

// 启动服务器
startUIServer(noOpen, true);
