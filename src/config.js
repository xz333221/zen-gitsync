import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';

const configPath = path.join(os.homedir(), '.git-commit-tool.json');

// 默认配置
const defaultConfig = {
  defaultCommitMessage: "submit"
};

// 异步读取配置文件
async function loadConfig() {
  try {
    const data = await fs.readFile(configPath, 'utf-8');
    return { ...defaultConfig, ...JSON.parse(data) };
  } catch (error) {
    return defaultConfig;
  }
}

// 异步保存配置
async function saveConfig(config) {
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
}
// 添加配置管理函数
async function handleConfigCommands() {
  if (process.argv.includes('get-config')) {
    const currentConfig = await loadConfig();
    console.log('Current configuration:');
    console.log(currentConfig);
    process.exit();
  }

  const setMsgArg = process.argv.find(arg => arg.startsWith('--set-default-message='));
  if (setMsgArg) {
    const newMessage = setMsgArg.split('=')[1];
    const currentConfig = await loadConfig();
    currentConfig.defaultCommitMessage = newMessage;
    await saveConfig(currentConfig);
    console.log(chalk.green(`✓ 默认提交信息已设置为: "${newMessage}"`));
    process.exit();
  }
}
export default {
  loadConfig,
  saveConfig,
  handleConfigCommands
};
