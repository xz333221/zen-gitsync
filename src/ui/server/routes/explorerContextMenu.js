// Copyright 2026 xz333221
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// 「把 g ui 加到资源管理器右键菜单」—— 设置 → 通用设置 → 系统集成 的按钮后端。
//
//   GET  /api/explorer-context-menu           查询状态（是否已添加，供按钮显示"添加/移除"）
//   POST /api/explorer-context-menu/install   添加（幂等，重复点等于覆盖）
//   POST /api/explorer-context-menu/uninstall 移除
//
// 只写 HKCU（当前用户），不碰 HKLM：
//   - 用户级注册表不需要管理员权限 —— 弹 UAC 的右键菜单项没人愿意装；
//   - 同一台机器上其他用户不受影响，卸载也只影响自己。
//
// 两个落点（与 VS Code / Git for Windows 的做法一致）：
//   HKCU\Software\Classes\Directory\shell\ZenGitSync             ← 右键点「文件夹」本身
//   HKCU\Software\Classes\Directory\Background\shell\ZenGitSync  ← 右键点文件夹里的空白处
// Windows 11 上这两处都出现在「显示更多选项」（旧版菜单）里 —— 这是注册表方案的固有限制：
// 新版一级菜单只认 MSIX + IExplorerCommand 打包的应用，本功能不覆盖。
//
// 命令刻意用 `node <entry> ui --path="%V"` 直接拉起，不套 cmd.exe：
//   - %V 是 Explorer 自己展开的"被右键的目录"，交给 CLI 的 --path 处理，
//     少一层 cmd 词法 —— 路径里的 & % 空格都不会被二次解释（对比 `cmd /c start /d "%V"`）；
//   - 用 process.execPath 而不是 `g`：Explorer 的 PATH 与终端不同，全局 shim 未必能找到，
//     而当前正在跑的这个 node + 本包自带的 gitCommit.js 一定存在。
//
// 安全口径：注册表值只来自服务端自己的常量 + 按钮传进来的菜单标题（sanitize 后截断），
// 不接受任何路径参数 —— 右键菜单打开哪个目录由 Explorer 的 %V 决定，客户端说了不算。

import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { asyncRoute, HttpError } from '../utils/asyncRoute.js';

const execFileAsync = promisify(execFile);

/** 菜单项注册表键名（两个落点共用），改它就是"换一个菜单项" */
export const MENU_KEY_NAME = 'ZenGitSync';

/** 两个落点：右键文件夹 / 右键文件夹空白处 */
export const MENU_REGISTRY_ROOTS = Object.freeze([
  `HKCU\\Software\\Classes\\Directory\\shell\\${MENU_KEY_NAME}`,
  `HKCU\\Software\\Classes\\Directory\\Background\\shell\\${MENU_KEY_NAME}`,
]);

/** 中文默认菜单标题（前端会按当前界面语言传 label，这里只是兜底） */
export const DEFAULT_MENU_LABEL = '用 g UI 打开';

/** 标题最长 64 字符：注册表项显示名，长了会被菜单截断，也没必要 */
const MAX_LABEL_LENGTH = 64;

/** 本包自带的 CLI 入口（与 fileOpen.js 里 launchGai 用同一个） */
export const CLI_ENTRY_PATH = fileURLToPath(new URL('../../../gitCommit.js', import.meta.url));

/**
 * 菜单标题的清洗：控制字符换空格、去首尾空白、超长截断。
 * 空值（或全是控制字符）退回默认标题 —— 保证菜单项永远有个能看的名字。
 *
 * @param {unknown} label
 * @returns {string}
 */
export function sanitizeMenuLabel(label) {
  if (typeof label !== 'string') return DEFAULT_MENU_LABEL;
  const cleaned = label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!cleaned) return DEFAULT_MENU_LABEL;
  return cleaned.slice(0, MAX_LABEL_LENGTH);
}

/**
 * 右键菜单要执行的命令行。`%V` 由 Explorer 展开成被右键的目录。
 * 引号是给 CreateProcess 的（路径可能带空格），不是给 shell 的。
 *
 * @param {{ nodePath?: string, entryPath?: string }} [options]
 * @returns {string}
 */
export function buildMenuCommand({ nodePath = process.execPath, entryPath = CLI_ENTRY_PATH } = {}) {
  return `"${nodePath}" "${entryPath}" ui --path="%V"`;
}

/**
 * 把整块菜单项（含 command 子键）写进注册表。reg add 自带 /f 覆盖语义，天然幂等。
 *
 * @param {{ label?: unknown, execFileFn?: Function, nodePath?: string, entryPath?: string }} [options]
 */
export async function installExplorerContextMenu({
  label,
  execFileFn = execFileAsync,
  nodePath = process.execPath,
  entryPath = CLI_ENTRY_PATH,
} = {}) {
  const menuLabel = sanitizeMenuLabel(label);
  const command = buildMenuCommand({ nodePath, entryPath });
  for (const key of MENU_REGISTRY_ROOTS) {
    await execFileFn('reg.exe', ['add', key, '/ve', '/t', 'REG_SZ', '/d', menuLabel, '/f']);
    // 图标借 node.exe 的（注册表菜单项只认 exe/dll/ico 资源，本包没有 .ico）
    await execFileFn('reg.exe', ['add', key, '/v', 'Icon', '/t', 'REG_SZ', '/d', nodePath, '/f']);
    await execFileFn('reg.exe', ['add', `${key}\\command`, '/ve', '/t', 'REG_SZ', '/d', command, '/f']);
  }
  return { label: menuLabel, command };
}

/**
 * 移除两个落点。/f 会连同 command 子键一起删；键不存在时 reg.exe 返回非 0，
 * 这里当成功处理（"本来就没了"和"刚删掉"对用户是同一件事）。
 *
 * @param {{ execFileFn?: Function }} [options]
 */
export async function uninstallExplorerContextMenu({ execFileFn = execFileAsync } = {}) {
  const errors = [];
  for (const key of MENU_REGISTRY_ROOTS) {
    try {
      await execFileFn('reg.exe', ['delete', key, '/f']);
    } catch (error) {
      if (!isMissingRegistryKeyError(error)) errors.push(error);
    }
  }
  if (errors.length) throw errors[0];
}

/**
 * 判断"删除失败"是不是"键本来就不存在"。reg.exe 对不存在的键返回退出码 1，
 * stderr 形如 `错误: 系统找不到指定的注册表项或值。`（英文系统同义）。
 * 按退出码判断即可 —— 其它失败（EPERM / reg.exe 缺失）不该被吞掉。
 *
 * @param {any} error
 */
function isMissingRegistryKeyError(error) {
  return error?.code === 1 || error?.status === 1;
}

/**
 * 当前用户下是否已安装（两个落点都在才算"已添加"）。
 * 键存在即可 —— 不解析标题，菜单标题只用于安装时写入。
 *
 * @param {{ execFileFn?: Function }} [options]
 * @returns {Promise<{ installed: boolean, keys: Record<string, boolean> }>}
 */
export async function getExplorerContextMenuStatus({ execFileFn = execFileAsync } = {}) {
  const keys = {};
  await Promise.all(MENU_REGISTRY_ROOTS.map(async (key) => {
    try {
      await execFileFn('reg.exe', ['query', key, '/ve']);
      keys[key] = true;
    } catch {
      keys[key] = false;
    }
  }));
  return { installed: MENU_REGISTRY_ROOTS.every((key) => keys[key] === true), keys };
}

/**
 * 注册路由。
 *
 * 注入口（与 registerLocalReposRoutes 同一套做法）：单测传假的 execFileFn，
 * 就不会往真实注册表里写东西。
 */
export function registerExplorerContextMenuRoutes({
  app,
  platform = process.platform,
  execFileFn = execFileAsync,
  nodePath = process.execPath,
  entryPath = CLI_ENTRY_PATH,
} = {}) {
  const supported = platform === 'win32';

  app.get('/api/explorer-context-menu', asyncRoute(async (req, res) => {
    if (!supported) {
      return res.json({ success: true, supported: false, installed: false });
    }
    const { installed } = await getExplorerContextMenuStatus({ execFileFn });
    res.json({ success: true, supported: true, installed });
  }));

  app.post('/api/explorer-context-menu/install', asyncRoute(async (req, res) => {
    if (!supported) throw new HttpError(400, '仅支持 Windows 资源管理器右键菜单');
    try {
      const { label } = await installExplorerContextMenu({
        label: req.body?.label,
        execFileFn,
        nodePath,
        entryPath,
      });
      res.json({ success: true, message: `已添加「${label}」到资源管理器右键菜单` });
    } catch (error) {
      throw new HttpError(400, `无法写入右键菜单注册表项: ${error.message}`);
    }
  }));

  app.post('/api/explorer-context-menu/uninstall', asyncRoute(async (req, res) => {
    if (!supported) throw new HttpError(400, '仅支持 Windows 资源管理器右键菜单');
    try {
      await uninstallExplorerContextMenu({ execFileFn });
      res.json({ success: true, message: '已从资源管理器右键菜单移除' });
    } catch (error) {
      throw new HttpError(400, `无法删除右键菜单注册表项: ${error.message}`);
    }
  }));
}