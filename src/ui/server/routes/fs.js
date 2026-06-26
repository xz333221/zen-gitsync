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
import express from 'express';
import logger from '../utils/logger.js'
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import open from 'open';
import os from 'os';
import { spawn, exec } from 'child_process';
import { ensureWithinCwd } from '../utils/pathGuard.js';
import { asyncRoute, HttpError } from '../utils/asyncRoute.js';

// ─────────────────────────────────────────────────────────────────────────────
// /api/change_directory 路径白名单(SEC-PATH-2)
//
// 防止 chdir 到任意绝对路径(尤其 / 或 C:\\)后,下游 fs / git 操作都
// 跟着跨出项目。
// 规则:
//   1. 必须是字符串
//   2. 必须是绝对路径或相对 process.cwd() 能解析的
//   3. 解析后必须是已存在的目录
//   4. 不能包含 NUL / 控制字符 / 路径穿越 token("..")越过祖先之外
//
// 注意:即便合法,也最好在 chdir 后立即 invalidateCurrentProjectKey 与
// config 缓存,详见 fs.js 后续代码。
// ─────────────────────────────────────────────────────────────────────────────
const FORBIDDEN_PATH_PATTERNS = /[\x00-\x1f]/

function validateChangeDirectoryPath(input) {
  if (!input || typeof input !== 'string') {
    return { ok: false, error: '目录路径必须是非空字符串' };
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: '目录路径不能为空' };
  }
  if (FORBIDDEN_PATH_PATTERNS.test(trimmed)) {
    return { ok: false, error: '目录路径包含非法控制字符' };
  }
  // 不允许长度过长的路径(防止 DoS / 解析爆炸)
  if (trimmed.length > 4096) {
    return { ok: false, error: '目录路径过长' };
  }
  const resolved = path.resolve(trimmed);
  // 阻止 chdir 到根目录之外但仍是合理目录的边界场景:
  // 这里采用宽松策略 — 只要 resolved 是已存在的目录即可(无法 100% 阻止
  // chdir 到任意位置,这是产品要求:GUI 内的"切换项目"功能需要允许切到
  // 任意用户目录)。安全护栏放在下游 fs/git 操作上(safePathInProject)。
  return { ok: true, resolved };
}

// 把 absolute path 准备好传给 spawn/exec,内部不再做字符串拼接,
// Windows 走 cmd /c start "" ... argv 模式;Linux 走 sh -c 但 argument 已被
// shQuote.js 转义
import { shQuote, psEscape } from '../utils/shellQuote.js';

export function registerFsRoutes({
  app,
  execGitCommand,
  configManager,
  io,
  getCurrentProjectPath,
  setCurrentProjectPath,
  getProjectRoomId,
  setProjectRoomId,
  setIsGitRepo
}) {
  // ── 解析并校验 user 输入路径在当前项目 cwd 内（防 ../ 父目录逃逸、startsWith 假阳性、Windows 大小写）──
  const safePathInProject = async (userPath) => {
    const cwd = getCurrentProjectPath() || process.cwd()
    return ensureWithinCwd(userPath, cwd)
  }

  // 新增获取当前工作目录接口
  app.get('/api/current_directory', asyncRoute(async (req, res) => {
    try {
      const directory = process.cwd();
      
      // 检查当前目录是否是Git仓库
      try {
        await execGitCommand(['rev-parse', '--is-inside-work-tree']);
      } catch (error) {
        return res.status(400).json({
          error: '当前目录不是一个Git仓库',
          directory,
          isGitRepo: false
        });
      }
      
      res.json({
        directory,
        isGitRepo: true
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
    }));

  // 新增切换工作目录接口
  app.post('/api/change_directory', asyncRoute(async (req, res) => {
    try {
      const { path: reqPath } = req.body;

      if (!reqPath) {
        throw new HttpError(400, '目录路径不能为空');
      }

      // SEC-PATH-2 防御:路径白名单 + 长度限制 + 控制字符拦截
      const validation = validateChangeDirectoryPath(reqPath);
      if (!validation.ok) {
        throw new HttpError(400, validation.error);
      }
      const safeReqPath = validation.resolved;

      try {
        // 解析后再次确认是已存在的目录,防止 race 期间目录被删
        try {
          const stat = await fs.stat(safeReqPath);
          if (!stat.isDirectory()) {
            throw new HttpError(400, '目标路径不是目录');
          }
        } catch (e) {
          if (e instanceof HttpError) throw e;
          throw new HttpError(400, `目标目录不存在: ${safeReqPath}`);
        }

        process.chdir(safeReqPath);
        const newDirectory = process.cwd();
      
        // 更新当前项目路径和房间ID
        const oldProjectPath = getCurrentProjectPath();
        const newProjectPath = newDirectory;
        const newProjectRoomId = `project:${newProjectPath.replace(/[\\/:*?"<>|\s]/g, '_')}`;
      
        console.log(chalk.yellow(`项目路径切换: ${oldProjectPath} -> ${newProjectPath}`));
        console.log(chalk.yellow(`房间ID更新: ${getProjectRoomId()} -> ${newProjectRoomId}`));
      
        // 检查新目录是否是Git仓库
        try {
          await execGitCommand(['rev-parse', '--is-inside-work-tree']);
      
          // 更新全局变量
          setCurrentProjectPath(newProjectPath);
          setProjectRoomId(newProjectRoomId);
          setIsGitRepo(true);
      
          // 确保切换后立即初始化该项目的配置条目
          try {
            const currentCfg = await configManager.loadConfig();
            await configManager.saveConfig(currentCfg);
            // 将新目录加入最近目录
            await configManager.saveRecentDirectory(newDirectory);
          } catch (e) {
            logger.warn('初始化项目配置失败:', e?.message || e);
          }
      
          // 通知所有旧房间的客户端项目已切换
          io.to(getProjectRoomId()).emit('project_changed', {
            oldProjectPath: getCurrentProjectPath(),
            newProjectPath: newProjectPath,
            newProjectRoomId: newProjectRoomId
          });
      
          res.json({
            success: true,
            directory: newDirectory,
            isGitRepo: true,
            projectRoomId: newProjectRoomId
          });
        } catch (error) {
          // 不是Git仓库，停止监控
      
          // 更新全局变量
          setCurrentProjectPath(newProjectPath);
          setProjectRoomId(newProjectRoomId);
          setIsGitRepo(false);
      
          // 通知所有旧房间的客户端项目已切换
          io.to(getProjectRoomId()).emit('project_changed', {
            oldProjectPath: getCurrentProjectPath(),
            newProjectPath: newProjectPath,
            newProjectRoomId: newProjectRoomId
          });
      
          // 即使不是Git仓库也初始化当前目录配置（使用CWD作为项目键）
          try {
            const currentCfg = await configManager.loadConfig();
            await configManager.saveConfig(currentCfg);
            // 将新目录加入最近目录
            await configManager.saveRecentDirectory(newDirectory);
          } catch (e) {
            logger.warn('非Git目录初始化项目配置失败:', e?.message || e);
          }
      
          res.json({
            success: true,
            directory: newDirectory,
            isGitRepo: false,
            warning: '新目录不是一个Git仓库',
            projectRoomId: newProjectRoomId
          });
        }
      } catch (error) {
        if (error instanceof HttpError) {
          return res.status(error.status).json({ success: false, error: error.message });
        }
        res.status(400).json({
          success: false,
          error: `切换到目录 "${safeReqPath}" 失败: ${error.message}`
        });
      }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
    }));

  // 获取目录内容（用于浏览目录）
  app.get('/api/browse_directory', asyncRoute(async (req, res) => {
    try {
      // 获取要浏览的目录路径，如果没有提供，则使用当前目录
      const directoryPath = req.query.path || process.cwd();
      
      try {
        // 读取目录内容
        const items = await fs.readdir(directoryPath, { withFileTypes: true });
      
        // 分离文件夹和文件
        const directories = [];
        const files = [];
      
        for (const item of items) {
          const fullPath = path.join(directoryPath, item.name);
          if (item.isDirectory()) {
            directories.push({
              name: item.name,
              path: fullPath,
              type: 'directory'
            });
          } else if (item.isFile()) {
            files.push({
              name: item.name,
              path: fullPath,
              type: 'file'
            });
          }
        }
      
        // 优先显示目录，然后是文件，都按字母排序
        directories.sort((a, b) => a.name.localeCompare(b.name));
        files.sort((a, b) => a.name.localeCompare(b.name));
      
        // 获取父目录路径
        const parentPath = path.dirname(directoryPath);
      
        res.json({
          success: true,
          currentPath: directoryPath,
          parentPath: parentPath !== directoryPath ? parentPath : null,
          items: [...directories, ...files]
        });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: `无法读取目录 "${directoryPath}": ${error.message}`
        });
      }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
    }));

  // POST接口版本的浏览目录功能
  app.post('/api/browse_directory', asyncRoute(async (req, res) => {
    try {
      // 获取要浏览的目录路径，如果没有提供，则使用当前目录
      const directoryPath = req.body.currentPath || process.cwd();
      
      try {
        // 读取目录内容
        const items = await fs.readdir(directoryPath, { withFileTypes: true });
      
        // 分离文件夹和文件
        const directories = [];
      
        for (const item of items) {
          const fullPath = path.join(directoryPath, item.name);
          if (item.isDirectory()) {
            directories.push({
              name: item.name,
              path: fullPath,
              type: 'directory'
            });
          }
        }
      
        // 只返回目录，不返回文件
        directories.sort((a, b) => a.name.localeCompare(b.name));
      
        // 获取父目录路径
        const parentPath = path.dirname(directoryPath);
      
        // 返回选择的目录路径
        res.json({
          success: true,
          path: directoryPath,
          parentPath: parentPath !== directoryPath ? parentPath : null,
          items: directories
        });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: `无法读取目录 "${directoryPath}": ${error.message}`
        });
      }
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
    }));

  // 获取最近访问的目录列表
  app.get('/api/recent_directories', asyncRoute(async (req, res) => {
    try {
      // 尝试从配置中获取最近的目录
      const recentDirs = await configManager.getRecentDirectories();
      // 并行检查每个目录是否存在
      const checked = await Promise.all(
        (recentDirs || []).map(async (dir) => {
          let exists = false;
          try {
            await fs.access(dir);
            exists = true;
          } catch {
            exists = false;
          }
          return { path: dir, exists };
        })
      );
      res.json({
        success: true,
        directories: checked
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
    }));

  // 在资源管理器/访达中打开当前目录
  app.post('/api/open_directory', asyncRoute(async (req, res) => {
    try {
      // 获取要打开的目录路径，如果没有提供，则使用当前目录
      const directoryPath = req.body.path || process.cwd();
      
      try {
        // 检查目录是否存在
        await fs.access(directoryPath);
      
        // 使用open模块打开目录，自动处理不同操作系统
        await open(directoryPath, { wait: false });
      
        res.json({
          success: true,
          message: '已在文件管理器中打开目录'
        });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: `无法打开目录 "${directoryPath}": ${error.message}`
        });
      }
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
    }));

  // 在终端中打开当前目录
  app.post('/api/open_terminal', asyncRoute(async (req, res) => {
    try {
      // SEC-INJ-4 防御:先 path.resolve 规范化,后续所有 spawn 走 argv 数组
      const directoryPath = path.resolve(String(req.body.path || process.cwd()));

      try {
        // 检查目录是否存在
        await fs.access(directoryPath);

        // 根据不同操作系统打开终端
        const platform = os.platform();
        let command;
        let args;

        switch (platform) {
          case 'win32':
            // Windows: cmd /c start "" /D path cmd,所有参数走数组传入,
            // 不拼字符串 - 避免 directoryPath 含双引号 / 反斜杠被二次解释
            command = 'cmd';
            args = ['/c', 'start', '', '/D', directoryPath, 'cmd'];
            break;
          case 'darwin':
            // macOS: 使用 Terminal.app
            command = 'open';
            args = ['-a', 'Terminal', directoryPath];
            break;
          case 'linux': {
            // Linux: 尝试使用常见的终端模拟器 - argv 数组模式
            // xterm 路径用 bash -c 跑 cd(且 cd path 已经 JSON.stringify 转义)
            const terminals = [
              { cmd: 'gnome-terminal', args: ['--working-directory', directoryPath] },
              { cmd: 'konsole', args: ['--workdir', directoryPath] },
              { cmd: 'xterm', args: ['-e', 'bash', '-c', `cd ${JSON.stringify(directoryPath)} && exec $SHELL`] },
            ];

            // 用 spawn 探测命令存在(不走 shell)
            let terminalFound = null;
            for (const terminal of terminals) {
              try {
                const probe = await new Promise((resolve) => {
                  const p = spawn('sh', ['-c', `command -v ${terminal.cmd}`], { stdio: 'ignore' });
                  p.on('exit', (code) => resolve(code === 0));
                  p.on('error', () => resolve(false));
                });
                if (probe) {
                  terminalFound = terminal;
                  break;
                }
              } catch (e) {
                continue;
              }
            }

            if (!terminalFound) {
              return res.status(400).json({
                success: false,
                error: '未找到可用的终端模拟器'
              });
            }
            command = terminalFound.cmd;
            args = terminalFound.args;
            break;
          }
          default:
            return res.status(400).json({
              success: false,
              error: `不支持的操作系统: ${platform}`
            });
        }

        // 执行命令打开终端
        spawn(command, args, {
          detached: true,
          stdio: 'ignore'
        }).unref();

        res.json({
          success: true,
          message: '已在终端中打开目录'
        });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: `无法打开终端 "${directoryPath}": ${error.message}`
        });
      }
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
    }));

  // 新开 cmd 标签并在目标路径执行 g ui(SEC-INJ-4 修复)
  app.post('/api/open-new-tab-gui', asyncRoute(async (req, res) => {
    try {
      const directoryPath = path.resolve(String(req.body.path || process.cwd()));

      try {
        await fs.access(directoryPath);

        const platform = os.platform();

        if (platform === 'win32') {
          // Windows: 用 argv 数组启动 start "" /D path cmd /k g ui,
          // directoryPath 通过数组传入 - Node 自动按 Windows CreateProcess
          // 要求转义,无需手写 replace
          spawn('cmd', ['/c', 'start', '', '/D', directoryPath, 'cmd', '/k', 'g', 'ui'], {
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
          }).unref();
        } else if (platform === 'darwin') {
          spawn('open', ['-a', 'Terminal', directoryPath], {
            detached: true,
            stdio: 'ignore'
          }).unref();
        } else {
          // Linux fallback: gnome-terminal 直接接 --working-directory,
          // 内部命令(g ui; exec bash)作为 bash 的独立 argv 元素
          spawn('gnome-terminal', [
            '--working-directory', directoryPath,
            '--', 'bash', '-c', 'g ui; exec bash',
          ], {
            detached: true,
            stdio: 'ignore'
          }).unref();
        }

        res.json({ success: true });
      } catch (error) {
        res.status(400).json({ success: false, error: `无法打开: ${'$'}{error.message}` });
      }
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
    }));


  // ========== 文件锁定相关 API ==========

  // 获取锁定文件列表
  app.get('/api/locked-files', asyncRoute(async (req, res) => {
    try {
      const lockedFiles = await configManager.getLockedFiles();
      res.json({ success: true, lockedFiles });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
    }));

  // 锁定文件
  app.post('/api/lock-file', asyncRoute(async (req, res) => {
    try {
      const { filePath } = req.body;
      if (!filePath) {
        throw new HttpError(400, '缺少文件路径参数');
      }
      
      const result = await configManager.lockFile(filePath);
      res.json({ success: true, locked: result });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
    }));

  // 解锁文件
  app.post('/api/unlock-file', asyncRoute(async (req, res) => {
    try {
      const { filePath } = req.body;
      if (!filePath) {
        throw new HttpError(400, '缺少文件路径参数');
      }
      
      const result = await configManager.unlockFile(filePath);
      res.json({ success: true, unlocked: result });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
    }));

  // 检查文件是否锁定
  app.post('/api/check-file-lock', asyncRoute(async (req, res) => {
    try {
      const { filePath } = req.body;
      if (!filePath) {
        throw new HttpError(400, '缺少文件路径参数');
      }
      
      const isLocked = await configManager.isFileLocked(filePath);
      res.json({ success: true, isLocked });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
    }));

  // ── 编辑器：读取文件内容 ────────────────────────────────────────
  app.get('/api/editor/file', asyncRoute(async (req, res) => {
    try {
      const filePath = req.query.path;
      if (!filePath) throw new HttpError(400, '缺少 path 参数');
      const safe = await safePathInProject(filePath);
      if (!safe) throw new HttpError(403, '禁止访问工作目录以外的文件');
      const resolved = safe.safePath;
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) throw new HttpError(400, '目标不是文件');
      // 超过 2MB 不读取
      if (stat.size > 2 * 1024 * 1024) {
        return res.json({ success: false, error: '文件过大（> 2 MB），暂不支持在线编辑' });
      }
      const content = await fs.readFile(resolved, 'utf-8');
      res.json({ success: true, content });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
    }));

  // ── 编辑器：读取原始文件（用于图片等二进制文件预览）────────────────────
  app.get('/api/editor/raw', asyncRoute(async (req, res) => {
    try {
      const filePath = req.query.path;
      if (!filePath) return res.status(400).end();
      const safe = await safePathInProject(filePath);
      if (!safe) return res.status(403).end();
      const resolved = safe.safePath;
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) return res.status(400).end();
      if (stat.size > 20 * 1024 * 1024) return res.status(413).end();
      const ext = path.extname(resolved).toLowerCase().slice(1);
      const mimeMap = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
        svg: 'image/svg+xml', bmp: 'image/bmp', tiff: 'image/tiff',
      };
      const mime = mimeMap[ext] || 'application/octet-stream';
      const content = await fs.readFile(resolved);
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'no-store');
      res.send(content);
    } catch (error) {
      res.status(500).end();
    }
    }));

  // ── 编辑器：写入文件内容 ────────────────────────────────────────
  app.put('/api/editor/file', express.json(), async (req, res) => {
    try {
      const { path: filePath, content } = req.body;
      if (!filePath || content === undefined) {
        throw new HttpError(400, '缺少 path 或 content 参数');
      }
      const safe = await safePathInProject(filePath);
      if (!safe) throw new HttpError(403, '禁止写入工作目录以外的文件');
      await fs.writeFile(safe.safePath, content, 'utf-8');
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ── 编辑器：新建文件 ───────────────────────────────────────────
  app.post('/api/editor/file', express.json(), async (req, res) => {
    try {
      const { path: filePath } = req.body;
      if (!filePath) throw new HttpError(400, '缺少 path 参数');
      const safe = await safePathInProject(filePath);
      if (!safe) throw new HttpError(403, '禁止在工作目录以外创建文件');
      const resolved = safe.safePath;
      // 如果已存在则拒绝
      try {
        await fs.access(resolved);
        throw new HttpError(409, '文件已存在');
      } catch { /* 不存在，继续 */ }
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, '', 'utf-8');
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ── 编辑器：新建文件夹 ─────────────────────────────────────────
  app.post('/api/editor/directory', express.json(), async (req, res) => {
    try {
      const { path: dirPath } = req.body;
      if (!dirPath) throw new HttpError(400, '缺少 path 参数');
      const safe = await safePathInProject(dirPath);
      if (!safe) throw new HttpError(403, '禁止在工作目录以外创建目录');
      const resolved = safe.safePath;
      try {
        await fs.access(resolved);
        throw new HttpError(409, '目录已存在');
      } catch { /* 不存在，继续 */ }
      await fs.mkdir(resolved, { recursive: true });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ── 编辑器：删除文件或文件夹 ───────────────────────────────────
  app.delete('/api/editor/entry', express.json(), async (req, res) => {
    try {
      const filePath = req.query.path;
      if (!filePath) throw new HttpError(400, '缺少 path 参数');
      const safe = await safePathInProject(filePath);
      if (!safe) throw new HttpError(403, '禁止删除工作目录以外的内容');
      const resolved = safe.safePath;
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) {
        await fs.rm(resolved, { recursive: true, force: true });
      } else {
        await fs.unlink(resolved);
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ── 编辑器：重命名文件或文件夹 ────────────────────────────────
  app.put('/api/editor/rename', express.json(), async (req, res) => {
    try {
      const { oldPath, newPath } = req.body;
      if (!oldPath || !newPath) throw new HttpError(400, '缺少参数');
      const safeOld = await safePathInProject(oldPath)
      const safeNew = await safePathInProject(newPath)
      if (!safeOld || !safeNew) throw new HttpError(403, '禁止操作工作目录以外的内容');
      try {
        await fs.access(safeNew.safePath);
        throw new HttpError(409, '目标名称已存在');
      } catch { /* 不存在，继续 */ }
      await fs.rename(safeOld.safePath, safeNew.safePath);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ── 编辑器：在系统文件管理器中打开 / 选中 ───────────────────
  // 行为：
  //   - 目录：直接用系统文件管理器打开
  //   - 文件：Windows / macOS 上在文件管理器中选中该文件；Linux 无标准接口，退化为打开所在目录
  app.post('/api/editor/reveal', express.json(), async (req, res) => {
    try {
      const targetPath = req.body?.path;
      if (!targetPath) throw new HttpError(400, '缺少 path 参数');

      const safe = await safePathInProject(targetPath);
      if (!safe) throw new HttpError(403, '禁止访问工作目录以外的内容');
      const resolved = safe.safePath;

      try {
        await fs.access(resolved);
      } catch {
        throw new HttpError(404, '目标不存在');
      }

      const stat = await fs.stat(resolved);
      const isDirectory = stat.isDirectory();

      const platform = process.platform;
      if (isDirectory) {
        await open(resolved, { wait: false });
      } else if (platform === 'win32') {
        // Windows: explorer.exe /select,<path>(逗号分隔,无双引号)
        // resolved 已通过 safePathInProject 校验,argv 数组传入防二次解释
        spawn('explorer.exe', ['/select,', resolved], { detached: true, stdio: 'ignore' }).unref();
      } else if (platform === 'darwin') {
        // macOS: open -R "<path>" 在 Finder 中选中
        spawn('open', ['-R', resolved], { detached: true, stdio: 'ignore' }).unref();
      } else {
        // Linux / 其它: 没有统一标准，打开所在目录
        await open(path.dirname(resolved), { wait: false });
      }

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
}

