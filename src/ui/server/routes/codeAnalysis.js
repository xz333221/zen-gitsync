import express from 'express';
import fs from 'fs/promises';
import path from 'path';

// 代码文件扩展名
const CODE_EXTENSIONS = [
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.java', '.go', '.rs', '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp',
  '.cs', '.rb', '.php', '.swift', '.kt', '.scala',
  '.vue', '.svelte', '.html', '.css', '.scss', '.less',
  '.json', '.yml', '.yaml', '.md', '.sh', '.bash', '.sql',
];

// 忽略的目录
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '__pycache__',
  '.cache', 'coverage', '.idea', '.vscode', 'vendor', 'target', 'out',
  '.turbo', '.svelte-kit',
]);

/**
 * 递归扫描目录，返回文件路径数组（相对于 baseDir）
 */
async function scanDirectory(dirPath, baseDir, maxFiles = 2000) {
  const results = [];
  async function walk(current) {
    if (results.length >= maxFiles) return;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          await walk(path.join(current, entry.name));
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (CODE_EXTENSIONS.includes(ext)) {
          const rel = path.relative(baseDir, path.join(current, entry.name)).replace(/\\/g, '/');
          results.push(rel);
        }
      }
    }
  }
  await walk(dirPath);
  return results;
}

/**
 * 安全读取单个文件内容（最多 200KB）
 */
async function safeReadFile(filePath, maxBytes = 200000) {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > maxBytes) {
      const buf = Buffer.alloc(maxBytes);
      const fd = await fs.open(filePath, 'r');
      await fd.read(buf, 0, maxBytes, 0);
      await fd.close();
      return buf.toString('utf8').slice(0, maxBytes);
    }
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 静态 import 解析 & 模块依赖图
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 正则提取 import / require / dynamic-import 的模块路径（TypeScript/Vue 通用）
 */
function parseImportsRegex(src) {
  const results = new Set();
  // import ... from '...'  |  export ... from '...'  |  import type ... from '...'
  const importRe = /(?:^|;|\n)\s*(?:import|export)(?:\s+type)?\s+(?:[^'"`;\n]*?\bfrom\s+)?['"]([^'"` \n]+)['"]/gm;
  let m;
  while ((m = importRe.exec(src)) !== null) { if (m[1]) results.add(m[1]); }
  // require('...')
  const requireRe = /\brequire\s*\(\s*['"]([^'"` \n]+)['"]\s*\)/g;
  while ((m = requireRe.exec(src)) !== null) { if (m[1]) results.add(m[1]); }
  // dynamic import('...')
  const dynRe = /\bimport\s*\(\s*['"]([^'"` \n]+)['"]\s*\)/g;
  while ((m = dynRe.exec(src)) !== null) { if (m[1]) results.add(m[1]); }
  return [...results];
}

/**
 * 从源码中静态提取 import 路径
 * - JS/MJS/CJS/JSX：优先用 acorn AST 解析，失败则正则兜底
 * - TS/TSX/Vue：正则（import 语法与 JS 相同，acorn 不支持 TypeScript 类型语法）
 */
async function parseStaticImports(filePath, content) {
  const ext = path.extname(filePath).toLowerCase();
  let src = content || '';

  // Vue SFC：提取 <script> 块
  if (ext === '.vue') {
    const m = src.match(/<script(?:[^>]*)>([\s\S]*?)<\/script>/i);
    src = m ? m[1] : '';
  }

  // JS / MJS / CJS / JSX → 尝试 acorn AST（最准确）
  if (['.js', '.mjs', '.cjs', '.jsx'].includes(ext)) {
    try {
      const acorn = await import('acorn');
      const ast = acorn.parse(src, {
        ecmaVersion: 2022,
        sourceType: 'module',
        allowImportExportEverywhere: true,
        allowHashBang: true,
      });
      const imports = [];
      for (const node of ast.body) {
        if (node.type === 'ImportDeclaration') imports.push(node.source.value);
        if (node.type === 'ExportNamedDeclaration' && node.source) imports.push(node.source.value);
        if (node.type === 'ExportAllDeclaration' && node.source) imports.push(node.source.value);
        // CommonJS require('...')
        if (node.type === 'ExpressionStatement') {
          const expr = node.expression;
          if (expr?.type === 'CallExpression' && expr.callee?.name === 'require' &&
              expr.arguments?.[0]?.type === 'Literal') {
            imports.push(expr.arguments[0].value);
          }
        }
      }
      return imports;
    } catch { /* fallthrough to regex */ }
  }

  // TS / TSX / Vue / 其他 → 正则解析
  return parseImportsRegex(src);
}

/** 可解析的扩展名（按优先级） */
const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.mjs', '.jsx', '.vue'];

/**
 * 尝试在文件集合中找到匹配的实际文件（带扩展名推断 + index 文件）
 */
function tryResolveWithExts(base, allFilesSet) {
  if (allFilesSet.has(base)) return base;
  for (const ext of RESOLVE_EXTS) {
    if (allFilesSet.has(base + ext)) return base + ext;
    if (allFilesSet.has(base + '/index' + ext)) return base + '/index' + ext;
  }
  return null;
}

/**
 * 将 import 路径解析为项目内相对路径
 * 支持相对路径（./xxx）和路径别名（@/xxx）
 */
function resolveImportPath(fromFile, importPath, allFilesSet, aliasMap) {
  // 路径别名（如 @/ → src/ui/client/src/）
  for (const [alias, target] of Object.entries(aliasMap)) {
    if (importPath.startsWith(alias)) {
      const resolved = (target + importPath.slice(alias.length)).replace(/\\/g, '/');
      return tryResolveWithExts(resolved, allFilesSet);
    }
  }
  // 非相对路径（node_modules 包）—— 不解析
  if (!importPath.startsWith('.')) return null;

  const fromDir = path.dirname(fromFile).replace(/\\/g, '/');
  const joined = path.posix.normalize(fromDir + '/' + importPath);
  return tryResolveWithExts(joined, allFilesSet);
}

/**
 * 从 vite.config / tsconfig 启发式检测路径别名
 * 返回形如 { '@/': 'src/ui/client/src/' } 的映射
 */
async function detectAliasMap(resolvedDir, subFiles) {
  const aliasMap = {};
  const srcCandidates = ['src/ui/client/src', 'src/client/src', 'client/src', 'src'];

  for (const cfgName of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
    try {
      const content = await fs.readFile(path.join(resolvedDir, cfgName), 'utf8');
      if (content.includes("'@'") || content.includes('"@"')) {
        // 找到 @ 别名定义，推断目标目录
        for (const c of srcCandidates) {
          if (subFiles.some(f => f.startsWith(c + '/'))) {
            aliasMap['@/'] = c + '/';
            break;
          }
        }
        break;
      }
    } catch { /* ignore */ }
  }

  // 兜底：如果文件中有 @/ 用法但未检测到配置，用最深公共路径猜测
  if (!aliasMap['@/'] && subFiles.some(f => f.includes('@/'))) {
    for (const c of srcCandidates) {
      if (subFiles.some(f => f.startsWith(c + '/'))) {
        aliasMap['@/'] = c + '/';
        break;
      }
    }
  }

  return aliasMap;
}

/**
 * 构建完整模块依赖图
 * @returns {{ graph, inDegree, hubFiles, entryCandidates, totalEdges, fileSizes }}
 */
async function buildDependencyGraph(subFiles, resolvedDir) {
  const allFilesSet = new Set(subFiles);
  const aliasMap = await detectAliasMap(resolvedDir, subFiles);

  const graph = {};      // file → string[]（它 import 的项目内文件）
  const fileSizes = {};  // file → 行数

  for (const file of subFiles) {
    const content = await safeReadFile(path.resolve(resolvedDir, file), 150000);
    fileSizes[file] = content ? content.split('\n').length : 0;
    const rawImports = await parseStaticImports(file, content);
    const resolved = [];
    for (const imp of rawImports) {
      const r = resolveImportPath(file, imp, allFilesSet, aliasMap);
      if (r) resolved.push(r);
    }
    graph[file] = [...new Set(resolved)];
  }

  // 计算入度（被多少文件 import）
  const inDegree = {};
  for (const file of subFiles) inDegree[file] = 0;
  for (const deps of Object.values(graph)) {
    for (const dep of deps) { if (dep in inDegree) inDegree[dep]++; }
  }

  // Hub files = 被最多模块依赖的核心文件
  const hubFiles = Object.entries(inDegree)
    .sort((a, b) => b[1] - a[1])
    .filter(([, d]) => d > 0)
    .slice(0, 8)
    .map(([file, inDeg]) => ({ file, inDegree: inDeg, lines: fileSizes[file] || 0 }));

  // 入口候选 = 出度 > 0 且入度 = 0（项目根节点，没有被其他文件 import）
  const entryCandidates = subFiles.filter(
    f => (graph[f]?.length || 0) > 0 && (inDegree[f] || 0) === 0
  );

  const totalEdges = Object.values(graph).reduce((s, d) => s + d.length, 0);

  return { graph, inDegree, hubFiles, entryCandidates, totalEdges, fileSizes };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * 调用 OpenAI 兼容 API，返回 JSON
 */
async function callLlmJson(model, prompt) {
  const { default: fetch } = await import('node-fetch').catch(() => ({ default: globalThis.fetch }));
  const url = `${String(model.baseURL || '').replace(/\/$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (model.apiKey) headers['Authorization'] = `Bearer ${model.apiKey}`;

  const body = JSON.stringify({
    model: model.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 4096,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    stream: false,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const resp = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data?.error?.message || `HTTP ${resp.status}`);
    const content = data?.choices?.[0]?.message?.content || '{}';
    try {
      const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) || content.match(/({[\s\S]*})/);
      return JSON.parse(jsonMatch ? jsonMatch[1] : content);
    } catch {
      return {};
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * SSE 辅助函数
 */
function sendSse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function registerCodeAnalysisRoutes({ app, configManager }) {
  /**
   * GET /api/code-analysis/files?path=xxx
   * 扫描指定目录下的代码文件列表
   */
  app.get('/api/code-analysis/files', async (req, res) => {
    try {
      const reqPath = req.query.path;
      if (!reqPath || typeof reqPath !== 'string') {
        return res.status(400).json({ error: '缺少 path 参数' });
      }
      const resolved = path.resolve(reqPath);
      // 安全验证：确保路径存在且是目录
      try {
        const stat = await fs.stat(resolved);
        if (!stat.isDirectory()) {
          return res.status(400).json({ error: '路径不是目录' });
        }
      } catch {
        return res.status(400).json({ error: '路径不存在' });
      }
      const files = await scanDirectory(resolved, resolved);
      res.json({ files, basePath: resolved });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/code-analysis/file-content?path=xxx&file=yyy
   * 读取单个文件内容
   */
  app.get('/api/code-analysis/file-content', async (req, res) => {
    try {
      const basePath = req.query.path;
      const file = req.query.file;
      if (!basePath || !file) {
        return res.status(400).json({ error: '缺少 path 或 file 参数' });
      }
      const resolvedBase = path.resolve(String(basePath));
      const resolvedFile = path.resolve(resolvedBase, String(file));
      // 安全验证：文件必须在 basePath 内
      if (!resolvedFile.startsWith(resolvedBase + path.sep) && resolvedFile !== resolvedBase) {
        return res.status(403).json({ error: '禁止访问此路径' });
      }
      const content = await safeReadFile(resolvedFile);
      res.json({ content });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/code-analysis/analyze (SSE)
   * 对指定目录进行 AI 代码分析，流式推送进度和结果
   *
   * Body: { path: string, modelId?: string }
   */
  app.post('/api/code-analysis/analyze', express.json(), async (req, res) => {
    const { path: projectPath, modelId } = req.body || {};

    if (!projectPath || typeof projectPath !== 'string') {
      return res.status(400).json({ error: '缺少 path 参数' });
    }

    const resolved = path.resolve(projectPath);

    // 安全验证目录存在
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) return res.status(400).json({ error: '路径不是目录' });
    } catch {
      return res.status(400).json({ error: '路径不存在' });
    }

    // 获取 AI 模型配置
    let model;
    try {
      const rawConfig = await configManager.readRawConfigFile();
      const models = Array.isArray(rawConfig.models) ? rawConfig.models : [];
      model = (modelId ? models.find(m => m.id === modelId) : null)
        || models.find(m => m.isDefault)
        || models[0];
    } catch (err) {
      return res.status(500).json({ error: '读取配置失败: ' + err.message });
    }

    if (!model) {
      return res.status(400).json({ error: '未配置 AI 模型，请先在通用设置中添加模型' });
    }

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let stopped = false;
    req.on('close', () => { stopped = true; });

    function log(message, type = 'info') {
      if (!stopped) sendSse(res, 'log', { message, type, timestamp: Date.now() });
    }

    try {
      // Step 1: 扫描文件
      log('正在扫描项目文件...', 'info');
      const allFiles = await scanDirectory(resolved, resolved);
      const codeFiles = allFiles.filter(f => {
        const ext = path.extname(f).toLowerCase();
        return ['.js', '.mjs', '.ts', '.tsx', '.jsx', '.vue', '.py', '.java', '.go',
          '.rs', '.cpp', '.c', '.h', '.cs', '.rb', '.php', '.swift', '.kt'].includes(ext);
      });
      log(`扫描完成，共 ${allFiles.length} 个文件，${codeFiles.length} 个代码文件`, 'success');

      if (stopped) return res.end();

      sendSse(res, 'files', { files: allFiles, codeFiles });

      if (codeFiles.length === 0) {
        log('未找到代码文件，分析终止', 'error');
        sendSse(res, 'done', { error: '未找到代码文件' });
        return res.end();
      }

      // Step 2: 程序化识别子系统（扫描 package.json 位置和路径模式）
      log('正在分析项目结构...', 'info');

      /**
       * 扫描项目中所有 package.json 文件（depth <= 4，排除 node_modules）
       */
      async function findPackageJsonPaths(baseDir, maxDepth = 4) {
        const found = [];
        async function walk(dir, depth) {
          if (depth > maxDepth) return;
          let entries;
          try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            if (e.isDirectory()) {
              if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) {
                await walk(path.join(dir, e.name), depth + 1);
              }
            } else if (e.isFile() && e.name === 'package.json' && depth > 0) {
              const rel = path.relative(baseDir, path.join(dir, e.name)).replace(/\\/g, '/');
              found.push(rel);
            }
          }
        }
        await walk(baseDir, 0);
        return found;
      }

      const packageJsonPaths = await findPackageJsonPaths(resolved);

      /**
       * 已知路径模式 → 子系统定义（优先匹配）
       */
      const KNOWN_PATTERNS = [
        { pathPattern: 'src/ui/client/src', name: 'frontend', displayName: '前端', language: 'TypeScript', description: 'Vue 3 前端应用' },
        { pathPattern: 'src/ui/server',     name: 'backend',  displayName: '后端', language: 'JavaScript', description: 'Node.js/Express 后端' },
        { pathPattern: 'client/src',        name: 'frontend', displayName: '前端', language: 'TypeScript', description: '前端应用' },
        { pathPattern: 'server',            name: 'backend',  displayName: '后端', language: 'JavaScript', description: '后端服务' },
        { pathPattern: 'frontend/src',      name: 'frontend', displayName: '前端', language: 'TypeScript', description: '前端应用' },
        { pathPattern: 'backend',           name: 'backend',  displayName: '后端', language: 'JavaScript', description: '后端服务' },
      ];

      // 从 package.json 路径派生子系统 rootPath
      const pkgBaseDirs = packageJsonPaths
        .map(p => path.dirname(p).replace(/\\/g, '/'))
        .filter(d => d !== '.' && d !== '');

      let programmaticSubsystems = [];

      if (pkgBaseDirs.length >= 2) {
        // 多 package.json → 每个目录是一个子系统
        programmaticSubsystems = pkgBaseDirs.slice(0, 4).map(dir => {
          const matched = KNOWN_PATTERNS.find(p => dir.startsWith(p.pathPattern) || dir === p.pathPattern.split('/')[0]);
          return matched
            ? { ...matched, rootPath: dir }
            : { name: path.basename(dir), displayName: path.basename(dir), rootPath: dir, language: 'Unknown', description: '' };
        });
        log(`程序化检测到 ${programmaticSubsystems.length} 个子系统（基于 package.json）: ${programmaticSubsystems.map(s => s.displayName).join(' / ')}`, 'success');
      } else {
        // 无多个 package.json，尝试已知路径模式
        for (const pattern of KNOWN_PATTERNS) {
          const hasMatch = codeFiles.some(f => f.startsWith(pattern.pathPattern + '/') || f.startsWith(pattern.pathPattern));
          if (hasMatch) {
            // 避免重复添加同名模式
            if (!programmaticSubsystems.find(s => s.rootPath === pattern.pathPattern)) {
              programmaticSubsystems.push({ ...pattern, rootPath: pattern.pathPattern });
            }
          }
        }
        if (programmaticSubsystems.length >= 2) {
          log(`程序化检测到 ${programmaticSubsystems.length} 个子系统（基于路径模式）: ${programmaticSubsystems.map(s => s.displayName).join(' / ')}`, 'success');
        } else {
          programmaticSubsystems = []; // 回退到 AI
        }
      }

      const SUBSYSTEM_COLORS = ['#f59e0b', '#3b82f6', '#10b981', '#8b5cf6'];
      let rawSubsystems;

      if (programmaticSubsystems.length >= 2) {
        rawSubsystems = programmaticSubsystems;
      } else {
        // Step 2b: AI 识别子系统（程序化未能区分）
        log('AI 正在识别子系统结构...', 'thinking');
        const subsystemPrompt = `你是项目架构分析师。根据以下文件路径列表，识别项目的子系统/子模块。

文件列表：
${JSON.stringify(codeFiles.slice(0, 300))}

判断依据：独立目录结构、package.json、入口文件、client/server、frontend/backend、ui/api 等模式。

返回 JSON（必须严格是 JSON）：
{
  "isMonorepo": true,
  "subsystems": [
    {
      "name": "frontend",
      "displayName": "前端",
      "rootPath": "src/ui/client/src",
      "language": "TypeScript",
      "description": "Vue 3 前端应用"
    }
  ]
}

注意：
- 单一系统时 isMonorepo 为 false，subsystems 一个，rootPath 为空字符串
- 最多识别 4 个子系统
- rootPath 使用正斜杠，必须与文件列表路径前缀严格匹配`;

        const subsystemData = await callLlmJson(model, subsystemPrompt);
        if (stopped) return res.end();

        rawSubsystems = Array.isArray(subsystemData.subsystems) && subsystemData.subsystems.length > 0
          ? subsystemData.subsystems.slice(0, 4)
          : [{ name: 'main', displayName: '主系统', rootPath: '', language: 'Unknown', description: '' }];

        log(`识别到 ${rawSubsystems.length} 个子系统: ${rawSubsystems.map(s => s.displayName || s.name).join(' / ')}`, 'success');
      }


      // Step 3-4: 对每个子系统分别分析调用链
      const allNodes = [];
      const allEdges = [];
      const allTechStack = new Set();
      let overallSummary = '';
      let primaryLanguage = 'Unknown';
      let primaryEntryFile = '';

      for (let si = 0; si < rawSubsystems.length; si++) {
        if (stopped) break;
        const sub = rawSubsystems[si];
        const subsystemName = sub.displayName || sub.name;
        const subsystemColor = SUBSYSTEM_COLORS[si % SUBSYSTEM_COLORS.length];

        // 过滤该子系统的代码文件
        const subFiles = sub.rootPath
          ? codeFiles.filter(f => f.startsWith(sub.rootPath.replace(/\\/g, '/')))
          : codeFiles;

        if (subFiles.length === 0) {
          log(`[${subsystemName}] 未找到代码文件，跳过`, 'info');
          continue;
        }

        // ── Step 2.5: 静态 import 解析 → 构建真实模块依赖图 ───────────────
        log(`[${subsystemName}] 正在静态解析 import 依赖（${subFiles.length} 个文件）...`, 'info');
        const { graph: depGraph, inDegree, hubFiles, entryCandidates, totalEdges, fileSizes } =
          await buildDependencyGraph(subFiles, resolved);
        log(`[${subsystemName}] 依赖图完成：${totalEdges} 条 import 关系，${hubFiles.length} 个核心模块`, 'success');
        if (stopped) break;

        // 向前端推送静态依赖图数据
        sendSse(res, 'depgraph', {
          subsystem: sub.name,
          graph: depGraph,
          hubFiles,
          entryCandidates,
          inDegree,
          fileSizes,
        });

        // ── Step 3: 识别入口文件（优先静态分析结论，AI 作为兜底） ──────────
        log(`[${subsystemName}] 正在识别入口文件...`, 'thinking');

        // 静态入口候选（入度=0 且有出度的根节点）按常见命名排序
        const ENTRY_NAME_PRIORITY = ['main', 'index', 'app', 'server', 'start', 'entry'];
        const staticEntryCandidates = [...entryCandidates].sort((a, b) => {
          const aScore = ENTRY_NAME_PRIORITY.findIndex(n => path.basename(a, path.extname(a)).toLowerCase().includes(n));
          const bScore = ENTRY_NAME_PRIORITY.findIndex(n => path.basename(b, path.extname(b)).toLowerCase().includes(n));
          return (aScore === -1 ? 99 : aScore) - (bScore === -1 ? 99 : bScore);
        });

        let subLang = sub.language || 'Unknown';
        let subSummary = '';
        let subEntryFiles = staticEntryCandidates.slice(0, 3);
        let subEntryFunctions = ['main'];

        // 仅当静态分析无法确定入口时，才调用 AI
        if (subEntryFiles.length === 0) {
          const subEntryPrompt = `你是软件架构师。以下是子系统的代码文件列表，请识别语言和入口文件。

子系统: ${subsystemName}
文件列表:
${JSON.stringify(subFiles.slice(0, 150))}

返回 JSON：
{
  "language": "TypeScript",
  "potentialEntryFiles": ["src/main.ts"],
  "potentialEntryFunctions": ["main"],
  "projectSummary": "简短中文描述"
}`;
          const subEntryData = await callLlmJson(model, subEntryPrompt);
          if (stopped) break;
          subLang = String(subEntryData.language || sub.language || 'Unknown');
          subEntryFiles = Array.isArray(subEntryData.potentialEntryFiles) ? subEntryData.potentialEntryFiles.slice(0, 3) : [];
          subEntryFunctions = Array.isArray(subEntryData.potentialEntryFunctions) ? subEntryData.potentialEntryFunctions : ['main'];
          subSummary = String(subEntryData.projectSummary || '');
        } else {
          // 从文件扩展名推断语言
          const extLangMap = { '.ts': 'TypeScript', '.tsx': 'TypeScript', '.vue': 'TypeScript', '.js': 'JavaScript', '.mjs': 'JavaScript', '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java' };
          const firstExt = path.extname(subEntryFiles[0]).toLowerCase();
          subLang = extLangMap[firstExt] || sub.language || 'Unknown';
        }

        if (!primaryLanguage || primaryLanguage === 'Unknown') primaryLanguage = subLang;

        // 验证并读取入口文件
        let entryFile = '';
        let entryContent = '';
        for (const candidate of subEntryFiles) {
          if (stopped) break;
          const candidatePath = path.resolve(resolved, candidate);
          if (!candidatePath.startsWith(resolved + path.sep) && candidatePath !== resolved) continue;
          const content = await safeReadFile(candidatePath);
          if (content) { entryFile = candidate; entryContent = content; break; }
        }
        if (!entryFile && subFiles.length > 0) {
          entryFile = subFiles[0];
          entryContent = await safeReadFile(path.resolve(resolved, entryFile));
        }
        if (!primaryEntryFile) primaryEntryFile = entryFile;
        if (!overallSummary) overallSummary = subSummary;

        // ── Step 4: AI 语义分析（以静态依赖图为骨架） ──────────────────────
        log(`[${subsystemName}] AI 正在基于依赖图做语义分析...`, 'thinking');

        // 读取 Hub 文件内容（被引用最多的核心模块，每个最多 2500 字符）
        const hubContents = [];
        for (const { file: hubFile } of hubFiles.slice(0, 4)) {
          if (stopped) break;
          const hubPath = path.resolve(resolved, hubFile);
          if (!hubPath.startsWith(resolved)) continue;
          const content = await safeReadFile(hubPath, 80000);
          if (content) hubContents.push({ file: hubFile, content: content.slice(0, 2500) });
        }

        // 构建依赖图文本摘要（展示文件间 import 关系，仅展示有边的节点）
        const graphLines = Object.entries(depGraph)
          .filter(([, deps]) => deps.length > 0)
          .sort((a, b) => b[1].length - a[1].length)
          .slice(0, 60)
          .map(([f, deps]) => `  ${f} (${fileSizes[f] || '?'}行) → [${deps.join(', ')}]`);

        const hubSummary = hubFiles
          .map(h => `  ${h.file} (被引用${h.inDegree}次, ${h.lines}行)`)
          .join('\n');

        const entryFunction = subEntryFunctions[0] || 'main';
        const entrySnippet = entryContent.slice(0, 3000);

        const hubContentText = hubContents.map(h =>
          `\n--- ${h.file} ---\n${h.content}`
        ).join('\n');

        // Step 4: 分析调用链（基于真实依赖图）
        const chainPrompt = `你是代码架构分析师。以下是通过静态 import 解析得到的真实模块依赖图，请基于此输出调用图节点和语义描述。

语言: ${subLang}
子系统: ${subsystemName}
入口文件: ${entryFile}（入口函数: ${entryFunction}）

## 真实模块依赖图（静态 import 解析结果）
共 ${subFiles.length} 个文件，${totalEdges} 条 import 关系
格式：文件(行数) → [它所 import 的文件]

${graphLines.join('\n') || '（无内部 import 关系）'}

## 核心模块（按被引用次数排序）
${hubSummary || '（未检测到高频被引用模块）'}

## 入口文件内容（截取前3000字符）
${entrySnippet}

## 核心模块文件内容
${hubContentText || '（无）'}

返回 JSON（基于真实依赖图，不要凭空猜测）：
{
  "entryFunction": "函数名",
  "nodes": [
    { "id": "n1", "label": "模块/函数名", "file": "文件路径（必须来自依赖图）", "line": 1, "type": "module|function|store|component|api", "importance": "high|medium|low", "description": "职责中文描述（10-30字）" }
  ],
  "edges": [{ "source": "n1", "target": "n2" }],
  "techStack": ["Vue3", "TypeScript"],
  "summary": "子系统架构中文概要（50-100字）"
}

要求：
1. 节点必须对应依赖图中真实存在的文件，不要编造节点
2. edges 必须反映真实 import 关系（A import B → A→B 有边）
3. 最多 25 个节点，优先选择高入度的核心模块
4. importance: high（核心/hub）/ medium（普通）/ low（叶子/工具）
5. type 可选: module / function / store / component / api / util / config`;

        const chainData = await callLlmJson(model, chainPrompt);
        if (stopped) break;

        // 合并节点/边，加子系统标识，ID 加前缀避免冲突
        const rawNodes = Array.isArray(chainData.nodes) ? chainData.nodes : [];
        const rawEdges = Array.isArray(chainData.edges) ? chainData.edges : [];
        const idMap = {};
        rawNodes.forEach((n, i) => { idMap[n.id] = `sub${si}_${n.id || i}`; });

        rawNodes.forEach((n, i) => {
          allNodes.push({
            ...n,
            id: `sub${si}_${n.id || i}`,
            subsystem: sub.name,
            subsystemIndex: si,
            subsystemColor,
          });
        });
        rawEdges.forEach(e => {
          const src = idMap[e.source] || `sub${si}_${e.source}`;
          const tgt = idMap[e.target] || `sub${si}_${e.target}`;
          allEdges.push({ source: src, target: tgt });
        });

        (Array.isArray(chainData.techStack) ? chainData.techStack : []).forEach(t => allTechStack.add(t));
        log(`[${subsystemName}] 分析完成，${rawNodes.length} 个节点，${rawEdges.length} 条连接`, 'success');
      }

      if (stopped) return res.end();

      // Step 5: 发送最终结果
      sendSse(res, 'result', {
        language: primaryLanguage,
        entryFile: primaryEntryFile,
        entryFunction: '',
        nodes: allNodes,
        edges: allEdges,
        techStack: [...allTechStack],
        summary: overallSummary,
        allFiles,
        codeFiles,
        subsystems: rawSubsystems.map((s, i) => ({ ...s, color: SUBSYSTEM_COLORS[i % SUBSYSTEM_COLORS.length] })),
      });

      log('✓ 全部分析完成！', 'success');
      sendSse(res, 'done', { success: true });
    } catch (err) {
      if (!stopped) {
        log(`分析失败: ${err.message}`, 'error');
        sendSse(res, 'done', { error: err.message });
      }
    } finally {
      res.end();
    }
  });

  /**
   * POST /api/code-analysis/drill
   * 手动下钻单个函数节点
   *
   * Body: { basePath, file, functionName, language, parentChain? }
   */
  app.post('/api/code-analysis/drill', express.json(), async (req, res) => {
    const { basePath, file, functionName, language, parentChain, modelId } = req.body || {};

    if (!basePath || !file || !functionName) {
      return res.status(400).json({ error: '缺少必要参数' });
    }

    const resolvedBase = path.resolve(String(basePath));
    const resolvedFile = path.resolve(resolvedBase, String(file));
    if (!resolvedFile.startsWith(resolvedBase)) {
      return res.status(403).json({ error: '禁止访问此路径' });
    }

    // 获取 AI 模型配置
    let model;
    try {
      const rawConfig = await configManager.readRawConfigFile();
      const models = Array.isArray(rawConfig.models) ? rawConfig.models : [];
      model = (modelId ? models.find(m => m.id === modelId) : null)
        || models.find(m => m.isDefault)
        || models[0];
    } catch (err) {
      return res.status(500).json({ error: '读取配置失败: ' + err.message });
    }

    if (!model) {
      return res.status(400).json({ error: '未配置 AI 模型' });
    }

    try {
      const content = await safeReadFile(resolvedFile);
      if (!content) return res.status(404).json({ error: '无法读取文件内容' });

      const snippet = content.slice(0, 7000);
      const prompt = `你是代码调用链下钻分析器。请分析目标函数，输出其关键子调用节点。

语言: ${String(language || 'Unknown')}
文件: ${String(file)}
函数: ${String(functionName)}
${parentChain ? `调用链上下文: ${String(parentChain).slice(0, 500)}` : ''}

文件内容（截取）：
${snippet}

返回 JSON：
{
  "functionName": "${String(functionName)}",
  "description": "函数职责",
  "calls": [
    { "name": "子函数名", "type": "function", "description": "中文描述", "importance": "high", "shouldDrill": 1, "possibleFile": "推测文件路径" }
  ]
}

shouldDrill: -1（叶子/不重要）、0（不确定）、1（值得继续下钻）
最多输出 10 个子调用`;

      const result = await callLlmJson(model, prompt);
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
