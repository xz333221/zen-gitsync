export function registerNpmRoutes({
  app,
  express,
  fs,
  fsSync,
  path,
  exec,
  getCurrentProjectPath
}) {
  // 读取 package.json 文件内容
  app.post('/api/read-package-json', express.json(), async (req, res) => {
    try {
      const { packageJsonPath } = req.body
      
      // 确定 package.json 的路径
      let pkgPath
      if (packageJsonPath && packageJsonPath.trim()) {
        pkgPath = path.isAbsolute(packageJsonPath) 
          ? packageJsonPath 
          : path.join(getCurrentProjectPath(), packageJsonPath)
      } else {
        pkgPath = path.join(getCurrentProjectPath(), 'package.json')
      }
      
      // 检查文件是否存在
      try {
        await fs.access(pkgPath)
      } catch (err) {
        return res.status(404).json({ 
          success: false, 
          error: `未找到 package.json 文件: ${pkgPath}` 
        })
      }
      
      // 读取 package.json
      const pkgContent = await fs.readFile(pkgPath, 'utf8')
      const pkg = JSON.parse(pkgContent)
      
      res.json({ 
        success: true, 
        dependencies: pkg.dependencies || {},
        devDependencies: pkg.devDependencies || {},
        version: pkg.version
      })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 版本号递增或依赖版本修改
  app.post('/api/version-bump', express.json(), async (req, res) => {
    try {
      const { bumpType, packageJsonPath, versionTarget, dependencyName, dependencyVersion, dependencyVersionBump, dependencyType } = req.body
      
      // 确定 package.json 的路径
      let pkgPath
      if (packageJsonPath && packageJsonPath.trim()) {
        pkgPath = path.isAbsolute(packageJsonPath) 
          ? packageJsonPath 
          : path.join(getCurrentProjectPath(), packageJsonPath)
      } else {
        pkgPath = path.join(getCurrentProjectPath(), 'package.json')
      }
      
      // 检查文件是否存在（使用 Node.js 原生方法）
      try {
        await fs.access(pkgPath)
      } catch (err) {
        return res.status(404).json({ 
          success: false, 
          error: `未找到 package.json 文件: ${pkgPath}` 
        })
      }
      
      // 读取 package.json
      const pkgContent = await fs.readFile(pkgPath, 'utf8')
      const pkg = JSON.parse(pkgContent)
      
      // 判断是修改 version 还是 dependency
      if (versionTarget === 'dependency') {
        // 修改依赖版本
        const depType = dependencyType || 'dependencies'
        
        if (!pkg[depType]) {
          return res.status(400).json({ 
            success: false, 
            error: `package.json 中未找到 ${depType} 字段` 
          })
        }
        
        if (!pkg[depType][dependencyName]) {
          return res.status(400).json({ 
            success: false, 
            error: `在 ${depType} 中未找到依赖包: ${dependencyName}` 
          })
        }
        
        const oldVersion = pkg[depType][dependencyName]
        let newVersion
        
        // 判断是自动递增还是手动输入
        if (dependencyVersionBump) {
          // 自动递增模式：解析当前版本号并递增
          // 提取版本号中的数字部分（去除 ^, ~, >=, 等前缀）
          const versionMatch = oldVersion.match(/(\^|~|>=|>|<=|<)?(\d+\.\d+\.\d+)/)
          if (!versionMatch) {
            return res.status(400).json({ 
              success: false, 
              error: `无法解析版本号: ${oldVersion}，应为 x.y.z 格式（可带 ^, ~ 等前缀）` 
            })
          }
          
          const prefix = versionMatch[1] || ''
          const versionNumber = versionMatch[2]
          const versionParts = versionNumber.split('.').map(Number)
          
          if (versionParts.length !== 3 || versionParts.some(isNaN)) {
            return res.status(400).json({ 
              success: false, 
              error: `无效的版本号格式: ${versionNumber}` 
            })
          }
          
          // 根据类型递增版本号
          let [major, minor, patch] = versionParts
          if (dependencyVersionBump === 'major') {
            major += 1
            minor = 0
            patch = 0
          } else if (dependencyVersionBump === 'minor') {
            minor += 1
            patch = 0
          } else { // patch
            patch += 1
          }
          
          newVersion = `${prefix}${major}.${minor}.${patch}`
        } else {
          // 手动输入模式
          newVersion = dependencyVersion
        }
        
        pkg[depType][dependencyName] = newVersion
        
        // 写回 package.json（保持格式化）
        await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
        
        res.json({ 
          success: true, 
          oldVersion, 
          newVersion,
          filePath: pkgPath,
          dependencyName,
          dependencyType: depType
        })
      } else {
        // 修改 version 字段（原有逻辑）
        if (!pkg.version) {
          return res.status(400).json({ 
            success: false, 
            error: 'package.json 中未找到 version 字段' 
          })
        }
        
        const oldVersion = pkg.version
        
        // 解析版本号
        const versionParts = oldVersion.split('.').map(Number)
        if (versionParts.length !== 3 || versionParts.some(isNaN)) {
          return res.status(400).json({ 
            success: false, 
            error: `无效的版本号格式: ${oldVersion}，应为 x.y.z 格式` 
          })
        }
        
        // 根据类型递增版本号
        let [major, minor, patch] = versionParts
        if (bumpType === 'major') {
          major += 1
          minor = 0
          patch = 0
        } else if (bumpType === 'minor') {
          minor += 1
          patch = 0
        } else { // patch
          patch += 1
        }
        
        const newVersion = `${major}.${minor}.${patch}`
        pkg.version = newVersion
        
        // 写回 package.json（保持格式化）
        await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
        
        res.json({ 
          success: true, 
          oldVersion, 
          newVersion,
          filePath: pkgPath
        })
      }
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })

  // ========== NPM 脚本管理相关 API ==========
  
  // 存储正在进行的扫描任务
  let currentScanAbortController = null;
  
  // 扫描项目目录及子目录下的所有package.json，并提取scripts
  app.get('/api/scan-npm-scripts', async (req, res) => {
    // 取消之前的扫描
    if (currentScanAbortController) {
      currentScanAbortController.aborted = true;
    }
    
    // 创建新的abort controller
    currentScanAbortController = { 
      aborted: false,
      abort() { this.aborted = true; }
    };
    const scanController = currentScanAbortController;
    try {
      const projectRoot = process.cwd();
      const packageJsons = [];
      const startTime = Date.now();
      
      // console.log(`[NPM扫描-后端] 开始扫描项目: ${projectRoot}`);
      
      // 需要忽略的目录列表（更全面）
      const IGNORED_DIRS = new Set([
        'node_modules',
        '.git',
        '.svn',
        '.hg',
        'dist',
        'build',
        'coverage',
        'out',
        'target',
        'vendor',
        '__pycache__',
        '.next',
        '.nuxt',
        '.vscode',
        '.idea',
        'tmp',
        'temp',
        'cache',
        '.cache'
      ]);
      
      // 优先扫描的子目录（monorepo常见结构）
      const PRIORITY_DIRS = ['packages', 'apps', 'libs', 'services', 'modules'];
      
      let scannedCount = 0;
      let skippedCount = 0;
      let fileReadCount = 0; // 统计实际读取的文件数量
      
      // 检查指定目录下是否有package.json
      async function checkPackageJson(dir) {
        if (scanController.aborted) return false;
        
        try {
          const packagePath = path.join(dir, 'package.json');
          
          // 先检查文件是否存在，避免不必要的读取
          try {
            await fs.access(packagePath);
          } catch {
            // 文件不存在，直接返回
            return false;
          }
          
          // 检查文件大小，避免读取异常大的文件
          const stats = await fs.stat(packagePath);
          const fileSizeMB = stats.size / (1024 * 1024);
          if (fileSizeMB > 1) {
            // package.json超过1MB是异常情况，跳过
            console.log(`[NPM扫描] 跳过超大文件 (${fileSizeMB.toFixed(2)}MB): ${packagePath}`);
            return false;
          }
          
          fileReadCount++; // 只有文件存在且大小合理时才计数
          const content = await fs.readFile(packagePath, 'utf8');
          const packageData = JSON.parse(content);
          
          // 只有当scripts存在且至少有一个脚本时才添加
          if (packageData.scripts && Object.keys(packageData.scripts).length > 0) {
            const relativePath = path.relative(projectRoot, dir);
            packageJsons.push({
              path: dir,
              relativePath: relativePath || '.',
              name: packageData.name || path.basename(dir),
              scripts: packageData.scripts,
              version: packageData.version || '0.0.0',
              repository: packageData.repository
            });
            return true;
          }
        } catch (error) {
          // 文件不存在或解析失败，忽略
        }
        return false;
      }
      
      // 递归扫描目录，最大深度4层
      const MAX_DEPTH = 4;
      const MAX_DIRS_PER_LEVEL = 50; // 每层最多扫描50个子目录
      
      // 统计每层深度的扫描数量
      const depthStats = Array(MAX_DEPTH + 1).fill(0).map(() => ({ count: 0, time: 0 }));
      
      async function scanDirectory(dir, depth = 0) {
        if (scanController.aborted) return;
        if (depth > MAX_DEPTH) return;
        
        const depthStart = Date.now();
        scannedCount++;
        depthStats[depth].count++;
        
        // 检查当前目录的package.json
        await checkPackageJson(dir);
        
        // 如果已经达到最大深度，不再继续
        if (depth >= MAX_DEPTH) return;
        
        // 读取子目录
        try {
          if (scanController.aborted) return;
          
          const items = await fs.readdir(dir, { withFileTypes: true });
          const subDirs = [];
          
          // 收集所有子目录
          for (const item of items) {
            if (scanController.aborted) return;
            if (!item.isDirectory()) continue;
            
            const dirName = item.name;
            
            // 跳过忽略的目录
            if (IGNORED_DIRS.has(dirName) || dirName.startsWith('.')) {
              skippedCount++;
              continue;
            }
            
            subDirs.push(item);
          }
          
          // 限制每层扫描的子目录数量
          const dirsToScan = subDirs.slice(0, MAX_DIRS_PER_LEVEL);
          if (subDirs.length > MAX_DIRS_PER_LEVEL) {
            skippedCount += subDirs.length - MAX_DIRS_PER_LEVEL;
          }
          
          // 优先处理优先目录
          const priorityDirs = dirsToScan.filter(item => PRIORITY_DIRS.includes(item.name));
          const normalDirs = dirsToScan.filter(item => !PRIORITY_DIRS.includes(item.name));
          
          // 先扫描优先目录
          for (const item of priorityDirs) {
            if (scanController.aborted) return;
            const subDirPath = path.join(dir, item.name);
            await scanDirectory(subDirPath, depth + 1);
          }
          
          // 再扫描普通目录
          for (const item of normalDirs) {
            if (scanController.aborted) return;
            const subDirPath = path.join(dir, item.name);
            await scanDirectory(subDirPath, depth + 1);
          }
          
        } catch (error) {
          // 忽略无法访问的目录
        }
        
        // 记录该深度的耗时
        depthStats[depth].time += Date.now() - depthStart;
      }
      
      // 执行递归扫描
      // console.log(`[NPM扫描-后端] 开始递归扫描（最大深度${MAX_DEPTH}层）`);
      const scanStart = Date.now();
      await scanDirectory(projectRoot, 0);
      // console.log(`[NPM扫描-后端] 递归扫描完成，耗时${Date.now() - scanStart}ms`);
      
      // 扫描完成，清除abort controller
      if (currentScanAbortController === scanController) {
        currentScanAbortController = null;
      }
      
      const scanTime = Date.now() - startTime;
      
      if (scanController.aborted) {
        console.log(`npm脚本扫描被取消，耗时${scanTime}ms`);
        return res.json({ 
          success: true, 
          packages: [],
          totalScripts: 0,
          cancelled: true
        });
      }
      
      // 输出每层深度的统计
      const depthInfo = depthStats
        .map((stat, depth) => stat.count > 0 ? `深度${depth}:${stat.count}个(${stat.time}ms)` : null)
        .filter(Boolean)
        .join(', ');
      
      // console.log(`npm脚本扫描完成，耗时${scanTime}ms，扫描了${scannedCount}个目录，读取了${fileReadCount}个package.json文件，跳过${skippedCount}个目录，找到${packageJsons.length}个有效的package.json`);
      // console.log(`[NPM扫描-后端] 深度分布: ${depthInfo}`);
      
      res.json({ 
        success: true, 
        packages: packageJsons,
        totalScripts: packageJsons.reduce((sum, pkg) => sum + Object.keys(pkg.scripts).length, 0)
      });
    } catch (error) {
      console.error('扫描npm脚本失败:', error);
      res.status(500).json({ 
        success: false, 
        error: `扫描npm脚本失败: ${error.message}` 
      });
    }
  });
  
  // 扫描项目目录下的所有package.json文件（用于版本管理）
  app.get('/api/scan-package-files', async (req, res) => {
    try {
      // 支持通过查询参数指定扫描目录，如果没有指定则使用当前工作目录
      const customDirectory = req.query.directory;
      const projectRoot = customDirectory || process.cwd();
      
      // 验证目录是否存在且可访问
      try {
        const stats = await fs.stat(projectRoot);
        if (!stats.isDirectory()) {
          return res.status(400).json({ 
            success: false, 
            error: '指定的路径不是一个有效的目录' 
          });
        }
      } catch (error) {
        return res.status(400).json({ 
          success: false, 
          error: `无法访问指定的目录: ${error.message}` 
        });
      }
      
      const packageFiles = [];
      const startTime = Date.now();
      
      // 需要忽略的目录列表
      const IGNORED_DIRS = new Set([
        'node_modules',
        '.git',
        '.svn',
        '.hg',
        'dist',
        'build',
        'coverage',
        'out',
        'target',
        'vendor',
        '__pycache__',
        '.next',
        '.nuxt',
        '.vscode',
        '.idea',
        'tmp',
        'temp',
        'cache',
        '.cache'
      ]);
      
      let scannedCount = 0;
      let fileReadCount = 0;
      
      // 检查指定目录下是否有package.json
      async function checkPackageJson(dir) {
        try {
          const packagePath = path.join(dir, 'package.json');
          
          // 先检查文件是否存在
          try {
            await fs.access(packagePath);
          } catch {
            return false;
          }
          
          // 检查文件大小
          const stats = await fs.stat(packagePath);
          const fileSizeMB = stats.size / (1024 * 1024);
          if (fileSizeMB > 1) {
            return false;
          }
          
          fileReadCount++;
          const content = await fs.readFile(packagePath, 'utf8');
          const packageData = JSON.parse(content);
          
          // 添加所有有效的package.json文件（不仅仅是有scripts的）
          if (packageData.name || packageData.version) {
            const relativePath = path.relative(projectRoot, dir);
            packageFiles.push({
              path: dir,
              relativePath: relativePath || '.',
              name: packageData.name || path.basename(dir),
              version: packageData.version || '0.0.0',
              displayName: packageData.name ? `${packageData.name} (${packageData.version || '0.0.0'})` : `${path.basename(dir)} (${packageData.version || '0.0.0'})`,
              fullPath: packagePath
            });
            return true;
          }
        } catch (error) {
          // 文件不存在或解析失败，忽略
        }
        return false;
      }
      
      // 递归扫描目录，最大深度4层
      const MAX_DEPTH = 4;
      const MAX_DIRS_PER_LEVEL = 50;
      
      async function scanDirectory(dir, depth = 0) {
        if (depth > MAX_DEPTH) return;
        
        scannedCount++;
        
        // 检查当前目录的package.json
        await checkPackageJson(dir);
        
        // 如果已经达到最大深度，不再继续
        if (depth >= MAX_DEPTH) return;
        
        // 读取子目录
        try {
          const items = await fs.readdir(dir, { withFileTypes: true });
          const subDirs = [];
          
          // 收集所有子目录
          for (const item of items) {
            if (!item.isDirectory()) continue;
            
            const dirName = item.name;
            
            // 跳过忽略的目录
            if (IGNORED_DIRS.has(dirName) || dirName.startsWith('.')) {
              continue;
            }
            
            subDirs.push(item);
          }
          
          // 限制每层扫描的子目录数量
          const dirsToScan = subDirs.slice(0, MAX_DIRS_PER_LEVEL);
          
          // 递归扫描子目录
          for (const item of dirsToScan) {
            const subDirPath = path.join(dir, item.name);
            await scanDirectory(subDirPath, depth + 1);
          }
        } catch (error) {
          // 忽略无法读取的目录
        }
      }
      
      // 开始扫描
      await scanDirectory(projectRoot);
      
      const scanTime = Date.now() - startTime;
      
      res.json({ 
        success: true, 
        packages: packageFiles,
        scanTime,
        scannedCount,
        fileReadCount
      });
    } catch (error) {
      console.error('扫描package.json文件失败:', error);
      res.status(500).json({ 
        success: false, 
        error: `扫描package.json文件失败: ${error.message}` 
      });
    }
  });
  
  // 在新终端中执行npm脚本
  app.post('/api/run-npm-script', async (req, res) => {
    try {
      const { packagePath, scriptName } = req.body;
      
      if (!packagePath || !scriptName) {
        return res.status(400).json({
          success: false,
          error: '缺少必要参数：packagePath 和 scriptName'
        });
      }
      
      console.log(`执行npm脚本: ${scriptName} in ${packagePath}`);
      
      // 根据操作系统选择合适的终端命令
      let terminalCommand;
      const npmCommand = `npm run ${scriptName}`;
      
      if (process.platform === 'win32') {
        // Windows: 使用 start 命令打开新的 cmd 窗口
        // /K 参数表示执行命令后保持窗口打开
        terminalCommand = `start cmd /K "cd /d ${packagePath} && ${npmCommand}"`;
      } else if (process.platform === 'darwin') {
        // macOS: 使用 osascript 打开 Terminal.app
        const script = `tell application "Terminal" to do script "cd ${packagePath} && ${npmCommand}"`;
        terminalCommand = `osascript -e '${script}'`;
      } else {
        // Linux: 尝试常见的终端模拟器
        // 优先使用 gnome-terminal, 然后是 xterm
        terminalCommand = `gnome-terminal -- bash -c "cd ${packagePath} && ${npmCommand}; exec bash" || xterm -e "cd ${packagePath} && ${npmCommand}; bash"`;
      }
      
      // 执行命令打开新终端（使用已导入的 exec）
      exec(terminalCommand, (error, stdout, stderr) => {
        if (error) {
          console.error('打开终端失败:', error);
        }
      });
      
      res.json({ 
        success: true, 
        message: `已在新终端中执行: ${scriptName}`,
        command: npmCommand,
        path: packagePath
      });
    } catch (error) {
      console.error('执行npm脚本失败:', error);
      res.status(500).json({ 
        success: false, 
        error: `执行npm脚本失败: ${error.message}` 
      });
    }
  });

  // API: 更新npm版本号
  app.post('/api/update-npm-version', async (req, res) => {
    try {
      const { packagePath, versionType } = req.body;
      
      if (!packagePath || !versionType) {
        return res.status(400).json({
          success: false,
          error: '缺少必要参数: packagePath, versionType'
        });
      }

      // 确保路径指向package.json文件
      let packageJsonPath = path.resolve(packagePath);
      if (fsSync.existsSync(packageJsonPath) && fsSync.statSync(packageJsonPath).isDirectory()) {
        packageJsonPath = path.join(packageJsonPath, 'package.json');
      }
      
      // 检查文件是否存在
      if (!fsSync.existsSync(packageJsonPath)) {
        return res.status(404).json({
          success: false,
          error: '找不到package.json文件'
        });
      }

      // 读取package.json
      const packageJson = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf8'));
      
      if (!packageJson.version) {
        return res.status(400).json({
          success: false,
          error: 'package.json中没有version字段'
        });
      }

      const oldVersion = packageJson.version;
      const versionParts = oldVersion.split('.').map(Number);
      
      // 根据类型增加版本号
      switch (versionType) {
        case 'major':
          versionParts[0]++;
          versionParts[1] = 0;
          versionParts[2] = 0;
          break;
        case 'minor':
          versionParts[1]++;
          versionParts[2] = 0;
          break;
        case 'patch':
          versionParts[2]++;
          break;
        default:
          return res.status(400).json({
            success: false,
            error: '无效的版本类型，必须是 major, minor 或 patch'
          });
      }

      const newVersion = versionParts.join('.');
      packageJson.version = newVersion;
      
      // 写回文件
      fsSync.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
      
      console.log(`已更新npm版本号: ${oldVersion} → ${newVersion} (${packagePath})`);
      
      res.json({
        success: true,
        oldVersion,
        newVersion
      });
    } catch (error) {
      console.error('更新版本号失败:', error);
      res.status(500).json({
        success: false,
        error: `更新版本号失败: ${error.message}`
      });
    }
  });

  // API: 添加npm脚本
  app.post('/api/add-npm-script', async (req, res) => {
    try {
      const { packagePath, scriptName, scriptCommand } = req.body;
      
      if (!packagePath || !scriptName || !scriptCommand) {
        return res.status(400).json({
          success: false,
          error: '缺少必要参数: packagePath, scriptName, scriptCommand'
        });
      }

      // 确保路径指向package.json文件
      let packageJsonPath = path.resolve(packagePath);
      if (fsSync.existsSync(packageJsonPath) && fsSync.statSync(packageJsonPath).isDirectory()) {
        packageJsonPath = path.join(packageJsonPath, 'package.json');
      }
      
      // 检查文件是否存在
      if (!fsSync.existsSync(packageJsonPath)) {
        return res.status(404).json({
          success: false,
          error: '找不到package.json文件'
        });
      }
      
      // 读取package.json
      const packageJson = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf8'));
      
      // 确保scripts对象存在
      if (!packageJson.scripts) {
        packageJson.scripts = {};
      }
      
      // 检查脚本是否已存在
      if (packageJson.scripts[scriptName]) {
        return res.status(400).json({
          success: false,
          error: `脚本 "${scriptName}" 已存在`
        });
      }
      
      // 添加脚本
      packageJson.scripts[scriptName] = scriptCommand;
      
      // 写回文件（保持格式化）
      fsSync.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
      
      console.log(`已添加npm脚本: ${scriptName} = ${scriptCommand} (${packagePath})`);
      
      res.json({
        success: true,
        scriptName,
        scriptCommand
      });
    } catch (error) {
      console.error('添加npm脚本失败:', error);
      res.status(500).json({
        success: false,
        error: `添加npm脚本失败: ${error.message}`
      });
    }
  });

  // API: 更新npm脚本
  app.post('/api/update-npm-script', async (req, res) => {
    try {
      const { packagePath, scriptName, scriptCommand, oldScriptName } = req.body;
      
      if (!packagePath || !scriptName || !scriptCommand) {
        return res.status(400).json({
          success: false,
          error: '缺少必要参数: packagePath, scriptName, scriptCommand'
        });
      }

      // 确保路径指向package.json文件
      let packageJsonPath = path.resolve(packagePath);
      if (fsSync.existsSync(packageJsonPath) && fsSync.statSync(packageJsonPath).isDirectory()) {
        packageJsonPath = path.join(packageJsonPath, 'package.json');
      }
      
      // 检查文件是否存在
      if (!fsSync.existsSync(packageJsonPath)) {
        return res.status(404).json({
          success: false,
          error: '找不到package.json文件'
        });
      }

      // 读取package.json
      const packageJson = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf8'));
      
      // 确保scripts对象存在
      if (!packageJson.scripts) {
        packageJson.scripts = {};
      }

      // 如果改了脚本名称，删除旧的
      if (oldScriptName && oldScriptName !== scriptName) {
        delete packageJson.scripts[oldScriptName];
      }

      // 更新脚本
      packageJson.scripts[scriptName] = scriptCommand;
      
      // 写回文件
      fsSync.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
      
      console.log(`已更新npm脚本: ${scriptName} = ${scriptCommand} (${packagePath})`);
      
      res.json({
        success: true,
        scriptName,
        scriptCommand
      });
    } catch (error) {
      console.error('更新npm脚本失败:', error);
      res.status(500).json({
        success: false,
        error: `更新npm脚本失败: ${error.message}`
      });
    }
  });

  // API: 删除npm脚本
  app.post('/api/delete-npm-script', async (req, res) => {
    try {
      const { packagePath, scriptName } = req.body;
      
      if (!packagePath || !scriptName) {
        return res.status(400).json({
          success: false,
          error: '缺少必要参数: packagePath, scriptName'
        });
      }

      // 确保路径指向package.json文件
      let packageJsonPath = path.resolve(packagePath);
      if (fsSync.existsSync(packageJsonPath) && fsSync.statSync(packageJsonPath).isDirectory()) {
        packageJsonPath = path.join(packageJsonPath, 'package.json');
      }
      
      // 检查文件是否存在
      if (!fsSync.existsSync(packageJsonPath)) {
        return res.status(404).json({
          success: false,
          error: '找不到package.json文件'
        });
      }

      // 读取package.json
      const packageJson = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf8'));
      
      // 检查scripts对象和脚本是否存在
      if (!packageJson.scripts || !packageJson.scripts[scriptName]) {
        return res.status(404).json({
          success: false,
          error: `脚本 "${scriptName}" 不存在`
        });
      }

      // 删除脚本
      delete packageJson.scripts[scriptName];
      
      // 写回文件
      fsSync.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
      
      console.log(`已删除npm脚本: ${scriptName} (${packagePath})`);
      
      res.json({
        success: true,
        scriptName
      });
    } catch (error) {
      console.error('删除npm脚本失败:', error);
      res.status(500).json({
        success: false,
        error: `删除npm脚本失败: ${error.message}`
      });
    }
  });

  // API: 置顶npm脚本
  app.post('/api/pin-npm-script', async (req, res) => {
    try {
      const { packagePath, scriptName } = req.body;
      
      if (!packagePath || !scriptName) {
        return res.status(400).json({
          success: false,
          error: '缺少必要参数: packagePath, scriptName'
        });
      }

      // 确保路径指向package.json文件
      let packageJsonPath = path.resolve(packagePath);
      if (fsSync.existsSync(packageJsonPath) && fsSync.statSync(packageJsonPath).isDirectory()) {
        packageJsonPath = path.join(packageJsonPath, 'package.json');
      }
      
      // 检查文件是否存在
      if (!fsSync.existsSync(packageJsonPath)) {
        return res.status(404).json({
          success: false,
          error: '找不到package.json文件'
        });
      }

      // 读取package.json
      const packageJson = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf8'));
      
      // 检查scripts对象和脚本是否存在
      if (!packageJson.scripts || !packageJson.scripts[scriptName]) {
        return res.status(404).json({
          success: false,
          error: `脚本 "${scriptName}" 不存在`
        });
      }

      // 保存要置顶的脚本内容
      const scriptCommand = packageJson.scripts[scriptName];
      
      // 删除该脚本
      delete packageJson.scripts[scriptName];
      
      // 创建新的scripts对象，将置顶脚本放在最前面
      const newScripts = {
        [scriptName]: scriptCommand,
        ...packageJson.scripts
      };
      
      packageJson.scripts = newScripts;
      
      // 写回文件
      fsSync.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
      
      console.log(`已置顶npm脚本: ${scriptName} (${packagePath})`);
      
      res.json({
        success: true,
        scriptName
      });
    } catch (error) {
      console.error('置顶npm脚本失败:', error);
      res.status(500).json({
        success: false,
        error: `置顶npm脚本失败: ${error.message}`
      });
    }
  });
}
