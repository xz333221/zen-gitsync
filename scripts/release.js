#!/usr/bin/env node

/**
 * 发布前准备工作
 * 1. 更新版本号（最后一位加1）
 * 2. 构建前端项目
 * 3. 提交更改到git
 * 4. 发布到npm
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import chalk from 'chalk';
import readline from 'readline/promises';

// 获取项目根目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// 创建readline接口函数
function createReadlineInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

// 读取package.json
const packageJsonPath = path.join(rootDir, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

// 尝试终止可能正在运行的Git进程
function terminateGitProcesses() {
  console.log(chalk.yellow('尝试终止可能正在运行的Git进程...'));
  
  try {
    // 在Windows上
    if (process.platform === 'win32') {
      try {
        execSync('taskkill /f /im git.exe /t', { stdio: 'ignore' });
        console.log(chalk.green('已终止Git进程'));
      } catch (e) {
        // 可能没有正在运行的进程，忽略错误
        console.log(chalk.gray('没有找到正在运行的Git进程'));
      }
    } 
    // 在Linux/MacOS上
    else {
      try {
        execSync("pkill -f 'git' || true", { stdio: 'ignore' });
        console.log(chalk.green('已终止Git进程'));
      } catch (e) {
        // 忽略错误
        console.log(chalk.gray('没有找到正在运行的Git进程'));
      }
    }
    
    // 等待进程终止
    console.log(chalk.gray('等待进程终止...'));
    execSync('sleep 2 || ping -n 3 127.0.0.1 > nul', { stdio: 'ignore' });
  } catch (error) {
    console.log(chalk.yellow('终止Git进程失败，但将继续尝试清理锁文件'));
  }
}

// 询问是否继续执行
async function askContinue(message) {
  const rl = createReadlineInterface();
  
  try {
    const answer = await rl.question(message);
    // 如果是空字符串(直接回车)或者是"y"，都返回true
    return answer.toLowerCase() === 'y' || answer.trim() === '';
  } finally {
    rl.close();
  }
}

// 检查并清理Git锁文件
async function checkAndCleanGitLocks() {
  console.log(chalk.gray('检查Git锁文件...'));
  
  const gitDir = path.join(rootDir, '.git');
  
  // 可能的锁文件列表
  const lockFiles = [
    path.join(gitDir, 'index.lock'),
    path.join(gitDir, 'HEAD.lock'),
    path.join(gitDir, 'config.lock'),
    path.join(gitDir, 'refs', 'heads', '*.lock'),
    path.join(gitDir, 'packed-refs.lock')
  ];
  
  // 检查并清理每个锁文件
  let foundLocks = false;
  let hasBusyLocks = false;
  
  lockFiles.forEach(lockPattern => {
    // 处理通配符模式
    if (lockPattern.includes('*')) {
      const baseDir = path.dirname(lockPattern);
      const pattern = path.basename(lockPattern);
      
      try {
        // 确保目录存在
        if (fs.existsSync(baseDir)) {
          const files = fs.readdirSync(baseDir);
          files.forEach(file => {
            if (file.endsWith('.lock')) {
              const lockPath = path.join(baseDir, file);
              foundLocks = true;
              console.log(chalk.yellow(`发现Git锁文件: ${lockPath}`));
              
              try {
                fs.unlinkSync(lockPath);
                console.log(chalk.green(`成功删除Git锁文件: ${lockPath}`));
              } catch (error) {
                hasBusyLocks = true;
                console.error(chalk.red(`无法删除Git锁文件 ${lockPath}:`), error);
                console.log(chalk.yellow('文件可能正被进程使用，尝试终止Git进程后重试'));
              }
            }
          });
        }
      } catch (error) {
        console.log(chalk.gray(`无法检查目录 ${baseDir}: ${error.message}`));
      }
    } else {
      // 直接检查具体路径
      if (fs.existsSync(lockPattern)) {
        foundLocks = true;
        console.log(chalk.yellow(`发现Git锁文件: ${lockPattern}`));
        
        try {
          fs.unlinkSync(lockPattern);
          console.log(chalk.green(`成功删除Git锁文件: ${lockPattern}`));
        } catch (error) {
          hasBusyLocks = true;
          console.error(chalk.red(`无法删除Git锁文件 ${lockPattern}:`), error);
          console.log(chalk.yellow('文件可能正被进程使用，尝试终止Git进程后重试'));
        }
      }
    }
  });
  
  if (hasBusyLocks) {
    // 尝试终止Git进程
    terminateGitProcesses();
    
    // 再次尝试删除锁文件
    let stillHasBusyLocks = false;
    
    lockFiles.forEach(lockPattern => {
      if (!lockPattern.includes('*') && fs.existsSync(lockPattern)) {
        try {
          fs.unlinkSync(lockPattern);
          console.log(chalk.green(`成功删除Git锁文件: ${lockPattern}`));
        } catch (error) {
          stillHasBusyLocks = true;
          console.error(chalk.red(`仍然无法删除Git锁文件 ${lockPattern}`));
        }
      }
    });
    
    if (stillHasBusyLocks) {
      console.log(chalk.yellow('警告：一些Git锁文件无法删除。建议：'));
      console.log(chalk.yellow('1. 关闭所有可能使用Git的应用程序'));
      console.log(chalk.yellow('2. 手动删除上述锁文件'));
      console.log(chalk.yellow('3. 重新运行发布脚本'));
      
      // 询问是否要继续
      const shouldContinue = await askContinue(chalk.yellow('是否尝试继续执行？(Y/n): '));
      
      if (!shouldContinue) {
        console.log(chalk.yellow('用户选择终止发布过程'));
        process.exit(1);
      }
      
      console.log(chalk.yellow('尝试继续执行，但可能会失败...'));
    }
  } else if (!foundLocks) {
    console.log(chalk.gray('未发现Git锁文件，继续执行...'));
  }
  
  // 等待一下，确保文件系统操作完成
  execSync('sleep 1 || ping -n 2 127.0.0.1 > nul', { stdio: 'ignore' });
}

// 检查发布环境
async function checkEnvironment() {
  console.log(chalk.blue('=== 检查发布环境 ==='));
  
  try {
    // 检查Git是否可用
    execSync('git --version', { stdio: 'ignore' });
    
    // 检查是否在Git仓库中
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
    
    // 清理可能的Git锁文件
    await checkAndCleanGitLocks();
    
    // 检查当前分支
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
    console.log(chalk.gray(`当前Git分支: ${currentBranch}`));
    
    // 如果不在主分支上，询问是否继续
    if (currentBranch !== 'main' && currentBranch !== 'master') {
      const rl = createReadlineInterface();
      
      try {
        const answer = await rl.question(chalk.yellow(`当前不在主分支上，是否继续在 ${currentBranch} 分支上发布? (Y/n): `));
        if (answer.toLowerCase() === 'n') {
          throw '用户选择取消发布';
        }
      } finally {
        rl.close();
      }
    }
    
    // 检查工作区是否干净
    try {
      execSync('git diff --quiet && git diff --staged --quiet', { stdio: 'ignore' });
      console.log(chalk.green('Git工作区干净'));
    } catch (e) {
      console.log(chalk.yellow('Git工作区有未提交的更改'));
      
      // 显示未提交的更改
      console.log(chalk.gray('\n未提交的更改:'));
      execSync('git status -s', { stdio: 'inherit' });
      console.log(''); // 空行
      
      const rl = createReadlineInterface();
      
      try {
        const answer = await rl.question(chalk.yellow('有未提交的更改，是否继续发布? (Y/n): '));
        if (answer.toLowerCase() === 'n') {
          throw '用户选择取消发布';
        }
      } finally {
        rl.close();
      }
    }
    
    console.log(chalk.green('环境检查通过'));
  } catch (error) {
    if (error === '用户选择取消发布') {
      console.log(chalk.yellow('发布已取消'));
      process.exit(0);
    }
    
    console.error(chalk.red('环境检查失败:'), error);
    process.exit(1);
  }
}

// 更新版本号
function updateVersion() {
  console.log(chalk.blue('=== 更新版本号 ==='));
  
  const currentVersion = packageJson.version;
  console.log(chalk.gray(`当前版本: ${currentVersion}`));
  
  // 拆分版本号
  const versionParts = currentVersion.split('.');
  
  // 递增最后一位版本号
  const lastPart = parseInt(versionParts[versionParts.length - 1], 10);
  versionParts[versionParts.length - 1] = (lastPart + 1).toString();
  
  // 重组版本号
  const newVersion = versionParts.join('.');
  packageJson.version = newVersion;
  
  // 写回package.json
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
  
  console.log(chalk.green(`版本号已更新: ${currentVersion} -> ${newVersion}`));
  return newVersion;
}

// 构建前端项目
async function buildFrontend() {
  console.log(chalk.blue('\n=== 构建前端项目 ==='));
  
  try {
    // 检查前端项目目录是否存在
    const frontendDir = path.join(rootDir, 'src', 'ui', 'client');
    if (!fs.existsSync(frontendDir)) {
      console.log(chalk.yellow('前端项目目录不存在，跳过构建'));
      return;
    }
    
    // 检查前端依赖是否安装
    console.log(chalk.gray('检查前端依赖...'));
    const nodeModulesPath = path.join(frontendDir, 'node_modules');
    if (!fs.existsSync(nodeModulesPath)) {
      console.log(chalk.yellow('未找到前端依赖，开始安装...'));
      execSync('cd ./src/ui/client && npm install', { stdio: 'inherit' });
      console.log(chalk.green('前端依赖安装完成'));
    }
    
    // 安装Node.js类型定义（如果需要）
    try {
      const typesNodePath = path.join(nodeModulesPath, '@types', 'node');
      if (!fs.existsSync(typesNodePath)) {
        console.log(chalk.yellow('安装Node.js类型定义...'));
        execSync('cd ./src/ui/client && npm install --save-dev @types/node', { stdio: 'inherit' });
      }
    } catch (error) {
      console.log(chalk.yellow('安装Node.js类型定义失败，继续构建...'));
    }
    
    // 更新tsconfig.app.json以包含node类型（如果需要）
    try {
      const tsconfigAppPath = path.join(frontendDir, 'tsconfig.app.json');
      if (fs.existsSync(tsconfigAppPath)) {
        const tsconfig = JSON.parse(fs.readFileSync(tsconfigAppPath, 'utf8'));
        let needsUpdate = false;
        
        if (!tsconfig.compilerOptions) {
          tsconfig.compilerOptions = {};
          needsUpdate = true;
        }
        
        if (!tsconfig.compilerOptions.types) {
          tsconfig.compilerOptions.types = ['node'];
          needsUpdate = true;
        } else if (!tsconfig.compilerOptions.types.includes('node')) {
          tsconfig.compilerOptions.types.push('node');
          needsUpdate = true;
        }
        
        if (needsUpdate) {
          console.log(chalk.yellow('更新tsconfig.app.json以包含Node.js类型...'));
          fs.writeFileSync(tsconfigAppPath, JSON.stringify(tsconfig, null, 2), 'utf8');
        }
      }
    } catch (error) {
      console.log(`error ==>`, error)
      console.log(chalk.yellow('更新tsconfig失败，继续构建...'));
    }
    
    // 执行构建命令
    console.log(chalk.gray('执行构建命令...'));
    execSync('cd ./src/ui/client && npm run build', { stdio: 'inherit' });
    console.log(chalk.green('前端项目构建完成'));
  } catch (error) {
    console.error(chalk.red('前端项目构建失败:'), error);
    
    // 询问用户是否继续发布过程
    console.log(chalk.yellow('\n前端构建失败，但您可以选择继续发布过程。'));
    const rl = createReadlineInterface();
    
    try {
      const answer = await rl.question(chalk.yellow('是否继续发布流程？(Y/n): '));
      if (answer.toLowerCase() === 'n') {
        console.log(chalk.red('发布流程已取消'));
        process.exit(1);
      }
      console.log(chalk.yellow('继续发布流程...'));
    } finally {
      rl.close();
    }
  }
}

// 提交更改到git
async function commitChanges(version) {
  console.log(chalk.blue('\n=== 提交更改到Git ==='));
  
  try {
    // 检查并清理可能的Git锁文件
    await checkAndCleanGitLocks();
    
    // 创建提交信息，包含版本号
    const commitMessage = `chore: 发布版本 v${version}`;
    
    // 禁用Git钩子以确保没有其他脚本干扰
    console.log(chalk.gray('临时禁用Git钩子...'));
    const gitHooksDir = path.join(rootDir, '.git', 'hooks');
    let renamedHooks = [];
    
    console.log(chalk.gray('添加更改文件...'));
    // 使用--force参数，避免可能的锁文件问题，但排除node_modules目录
    execSync('git add .', { stdio: 'inherit' });
    
    // 等待一下，确保文件系统同步
    console.log(chalk.gray('等待文件系统同步...'));
    execSync('sleep 1 || ping -n 2 127.0.0.1 > nul', { stdio: 'ignore' });
    
    console.log(chalk.gray('提交更改...'));
    
    // 尝试提交，如果失败则重试
    let committed = false;
    let attempts = 0;
    const maxAttempts = 3;
    
    while (!committed && attempts < maxAttempts) {
      attempts++;
      
      try {
        // 检查并清理Git锁文件
        if (attempts > 1) {
          await checkAndCleanGitLocks();
          console.log(chalk.yellow(`重试提交 (${attempts}/${maxAttempts})...`));
          // 稍等更长时间
          execSync('sleep 2 || ping -n 3 127.0.0.1 > nul', { stdio: 'ignore' });
        }
        
        // 使用--no-verify参数跳过钩子，避免可能的挂起
        execSync(`git commit --no-verify -m "${commitMessage}"`, { stdio: 'inherit' });
        committed = true;
      } catch (error) {
        if (attempts >= maxAttempts) {
          throw error; // 重试次数用完，抛出错误
        }
        console.log(chalk.yellow(`提交失败，将在2秒后重试...`));
        // 等待2秒后重试
        execSync('sleep 2 || ping -n 3 127.0.0.1 > nul', { stdio: 'ignore' });
      }
    }
    
    console.log(chalk.green(`更改已提交到Git，提交信息: "${commitMessage}"`));
    
    // 创建版本标签
    console.log(chalk.gray('创建版本标签...'));
    execSync(`git tag v${version}`, { stdio: 'inherit' });
    console.log(chalk.green(`已创建标签: v${version}`));
    
    // 询问是否推送到远程
    const rl = createReadlineInterface();
    
    try {
      const answer = await rl.question(chalk.yellow('是否推送代码和标签到远程仓库? (Y/n): '));
      
      if (answer.toLowerCase() !== 'n') {
        try {
          // 获取当前分支
          const branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
          
          console.log(chalk.gray(`推送代码到远程仓库，分支: ${branch}...`));
          execSync(`git push origin ${branch}`, { stdio: 'inherit' });
          
          console.log(chalk.gray('推送标签到远程仓库...'));
          execSync('git push origin --tags', { stdio: 'inherit' });
          
          console.log(chalk.green('代码和标签已成功推送到远程仓库'));
        } catch (pushError) {
          console.error(chalk.red('推送到远程仓库失败:'), pushError);
          // 继续发布过程，不终止
        }
      } else {
        console.log(chalk.yellow('跳过推送到远程仓库'));
      }
    } finally {
      rl.close();
      
      // 恢复Git钩子
      if (renamedHooks.length > 0) {
        console.log(chalk.gray('恢复Git钩子...'));
        for (const hook of renamedHooks) {
          try {
            fs.renameSync(hook.disabled, hook.original);
          } catch (e) {
            console.log(chalk.yellow(`无法恢复Git钩子: ${path.basename(hook.original)}`));
          }
        }
        console.log(chalk.gray(`已恢复 ${renamedHooks.length} 个Git钩子`));
      }
    }
  } catch (error) {
    console.error(chalk.red('Git提交失败:'), error);
    process.exit(1);
  }
}

// 发布到NPM
async function publishToNpm() {
  console.log(chalk.blue('\n=== 发布到NPM ==='));
  
  // 创建readline接口
  const rl = createReadlineInterface();
  
  try {
    // 等待用户确认
    const answer = await rl.question(chalk.yellow('是否发布到NPM? (Y/n): '));
    
    if (answer.toLowerCase() === 'n') {
      console.log(chalk.yellow('跳过发布到NPM'));
      return;
    }
    
    // 执行npm发布
    console.log(chalk.gray('执行npm发布...'));
    try {
      execSync('npm publish --registry=https://registry.npmjs.org/', { stdio: 'inherit' });
      console.log(chalk.green('已成功发布到NPM'));
      
      // 发布成功后执行更新和查看命令
      console.log(chalk.blue('\n=== 发布后操作 ==='));
      
      try {
        console.log(chalk.gray('执行 npm run update:g...'));
        execSync('npm run update:g', { stdio: 'inherit' });
        console.log(chalk.green('✅ update:g 执行完成'));
      } catch (error) {
        console.error(chalk.red('❌ update:g 执行失败:'), error.message);
      }
      
      try {
        console.log(chalk.gray('执行 npm run npm:ls:g...'));
        execSync('npm run npm:ls:g', { stdio: 'inherit' });
        console.log(chalk.green('✅ npm:ls:g 执行完成'));
      } catch (error) {
        console.error(chalk.red('❌ npm:ls:g 执行失败:'), error.message);
      }
      
    } catch (error) {
      console.error(chalk.red('发布到NPM失败:'), error);
      throw error;
    }
  } finally {
    rl.close();
  }
}

// 主流程
async function main() {
  console.log(chalk.cyan('\n🚀 开始发布流程...\n'));
  
  try {
    // 1. 检查环境
    await checkEnvironment();
    
    // 2. 更新版本号
    const newVersion = updateVersion();
    
    // 3. 构建前端项目
    await buildFrontend();
    
    // 4. 提交更改到Git
    await commitChanges(newVersion);
    
    // 5. 发布到NPM
    await publishToNpm();
    
    console.log(chalk.green('\n🎉 发布完成！'));
  } catch (error) {
    console.error(chalk.red('\n❌ 发布失败:'), error);
    process.exit(1);
  }
}

// 启动流程
main().catch(error => {
  console.error(chalk.red('\n❌ 未捕获的错误:'), error);
  process.exit(1);
}); 
