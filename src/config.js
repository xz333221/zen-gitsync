import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

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

export default {
  loadConfig,
  saveConfig
};
