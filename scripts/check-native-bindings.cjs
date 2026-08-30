#!/usr/bin/env node
/**
 * check-native-bindings.cjs — 扫描 node_modules 下所有原生 .node 文件，检测是否被下载截断/损坏。
 *
 * 背景：本机走 Clash 代理（HTTP_PROXY=127.0.0.1:10808），npm 拉 2~3MB 的原生二进制时
 * 长连接可能被掐断，文件被截断但 PE 头仍有效，运行时才报
 *   ERR_DLOPEN_FAILED: xxx.node is not a valid Win32 application
 * 极具迷惑性（架构判定正常，看不出是文件坏了）。
 *
 * 用法：
 *   node scripts/check-native-bindings.cjs [node_modules 路径]
 *   node scripts/check-native-bindings.cjs                       # 默认扫 src/ui/client/node_modules
 *
 * 退出码：0 = 全部正常，1 = 发现损坏。
 */

const fs = require('fs');
const path = require('path');

// 已知「假阳性」：这些包在原生 Windows node 下加载失败是设计使然，不算损坏。
// @rollup/rollup-win32-x64-gnu 依赖 MinGW 运行时（libgcc/libstdc++），
// rollup 运行时实际走 win32-x64-msvc，只要 msvc 版本正常即可忽略。
const KNOWN_FALSE_POSITIVE = [/rollup-win32-x64-gnu/i, /rollup-win32-arm64-gnu/i];

const target = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '../src/ui/client/node_modules');

if (!fs.existsSync(target)) {
  console.error('目录不存在: ' + target);
  process.exit(2);
}

/** 递归收集所有 .node 文件 */
function collect(dir, out, depth) {
  if (depth > 8) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '.bin' || e.name === '.cache') continue;
      collect(p, out, depth + 1);
    } else if (e.name.endsWith('.node')) {
      out.push(p);
    }
  }
  return out;
}

const files = collect(target, [], 0);
console.log('扫描目录: ' + target);
console.log('发现 .node 文件: ' + files.length);
console.log('-'.repeat(70));

const broken = [];
const falsePositives = [];

for (const f of files) {
  const rel = path.relative(target, f);
  let err = null;
  try {
    process.dlopen({ exports: {} }, f);
  } catch (e) {
    err = e.code || String(e.message).split('\n')[0];
  }

  if (!err) {
    console.log('  [正常] ' + rel);
    continue;
  }

  const size = fs.statSync(f).size;
  if (KNOWN_FALSE_POSITIVE.some((re) => re.test(rel))) {
    falsePositives.push(rel);
    console.log('  [跳过] ' + rel + '  <- 已知假阳性(需 MinGW 运行时,实际走 msvc 版)');
    continue;
  }

  broken.push({ rel, size, err });
  console.log('  [损坏] ' + rel);
  console.log('         大小 ' + size.toLocaleString() + ' B | ' + err);
}

console.log('-'.repeat(70));
console.log('损坏: ' + broken.length + ' | 假阳性跳过: ' + falsePositives.length);

if (broken.length === 0) {
  console.log('结论: 全部正常');
  process.exit(0);
}

console.log('');
console.log('修复方式（绕代理重新下载完整文件后覆盖，无需删 node_modules 重装）：');
for (const b of broken) {
  // 从路径里还原包名，例如 @tailwindcss\oxide-win32-x64-msvc\xxx.node -> @tailwindcss/oxide-win32-x64-msvc
  const parts = b.rel.split(path.sep);
  const pkg = parts[0].startsWith('@') ? parts[0] + '/' + parts[1] : parts[0];
  let ver = '';
  try {
    ver = JSON.parse(fs.readFileSync(path.join(target, pkg, 'package.json'), 'utf8')).version;
  } catch (e) {
    /* 读不到版本就留空，让用户自己补 */
  }
  console.log('');
  console.log('  # ' + pkg + (ver ? '@' + ver : '') + '（当前 ' + b.size.toLocaleString() + ' B）');
  console.log('  cd /tmp && env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \\');
  console.log('    NO_PROXY="*" npm pack ' + pkg + (ver ? '@' + ver : '') + ' --registry=https://registry.npmmirror.com');
  console.log('  tar -xzf *.tgz   # 再把 package/ 下的 .node 覆盖回 node_modules');
  console.log('  # 可先用 npm view ' + pkg + (ver ? '@' + ver : '') + ' dist.unpackedSize 确认应有大小');
}

process.exit(1);
