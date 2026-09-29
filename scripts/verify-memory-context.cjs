/**
 * 「派发任务时 Agent 真的会去查记忆」这件事的验证。
 *
 * 为什么要有这个：这个能力是**纯 prompt 注入**的 —— 没有按钮、没有状态、没有
 * 任何可观测物。改 taskRunner.js 的人（哪怕只是把两段代码换个位置）会无声地
 * 把它弄掉，而界面上什么都看不出来。这类"不报错就没了"的特性只能靠探针钉。
 *
 * 验收契约（改这块时别破坏）：
 *   A 注入点还在：runSingleSubtask 里仍会调 buildMemoryPointerBlock
 *   B **顺序**：记忆块拼在**任务正文之前**。放末尾等于把"背景"讲成了"当前任务"，
 *     Agent 会以为这轮用户要求它去整理记忆库 —— 这是最容易被改坏的一条
 *   C 开关有效：task.memoryContext === false 时整块不注入
 *   D 续接轮不重复讲捕获纪律（capture 跟着 resumeSessionId 走）
 *   E 体积：块本身有上限（这正是"用索引替代全文进 prompt"的前提）
 *   F 内容硬约束：懒加载、索引缺一不可、"以后怎么做"
 *   G 铺种子：注册路由时会调 ensureMemoryStore，且失败不抛
 *   H 打包：src/memory/** 在 package.json#files 里（漏了装完第一次开工作台就崩）
 *   I 注入**只写** MEMORY_DIR 下的路径，一个字节都不碰用户工作区或第三方
 *     配置目录（~/.claude、~/.codex 等）—— 这是"不替用户改别人家的配置"的保证
 *
 * 用法：node scripts/verify-memory-context.cjs
 *       node scripts/verify-memory-context.cjs --reverse   （把 A~D 逐条打回去，必须翻红）
 * 退出码：0 全通过；1 有失败项；2 前置不足。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const REVERSE = process.argv.includes('--reverse')

const RUNNER = path.join(ROOT, 'src/ui/server/routes/workbench/taskRunner.js')
const MEMCTX = path.join(ROOT, 'src/ui/server/routes/workbench/memoryContext.js')
const WB_INDEX = path.join(ROOT, 'src/ui/server/routes/workbench/index.js')
const STORE = path.join(ROOT, 'src/memory/store.js')
const LIBRARY = path.join(ROOT, 'src/memory/library.js')
const MEMROUTE = path.join(ROOT, 'src/ui/server/routes/memory.js')
const SETTINGS_DIALOG = path.join(ROOT, 'src/ui/client/src/components/GitGlobalSettingsDialog.vue')
const PKG = path.join(ROOT, 'package.json')

const results = []
const t = (name, fn) => {
  try {
    const msg = fn()
    results.push({ ok: true, name, msg: msg || '' })
  } catch (err) {
    results.push({ ok: false, name, msg: err.message })
  }
}
const must = (cond, why) => { if (!cond) throw new Error(why) }

for (const f of [RUNNER, MEMCTX, WB_INDEX, STORE, LIBRARY, MEMROUTE, SETTINGS_DIALOG, PKG]) {
  if (!fs.existsSync(f)) {
    console.error(`前置不足：缺少 ${path.relative(ROOT, f)}`)
    process.exit(2)
  }
}

/** 去掉注释再匹配：文件头注释里会写到这些符号名，匹配到注释等于没验。 */
function codeOnly(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

const read = { runner: codeOnly(RUNNER), memctx: codeOnly(MEMCTX), wb: codeOnly(WB_INDEX), store: codeOnly(STORE) }

for (const f of [RUNNER, MEMCTX, WB_INDEX, STORE, LIBRARY, MEMROUTE]) {
  t(`语法：${path.relative(ROOT, f)}`, () => {
    const { execFileSync } = require('node:child_process')
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' })
  })
}

// ── A 注入点还在 ──────────────────────────────────────────────────────
t('A 注入点：runSingleSubtask 里仍调 buildMemoryPointerBlock', () => {
  must(/import\s*\{[^}]*buildMemoryPointerBlock[^}]*\}\s*from\s*['"]\.\/memoryContext\.js['"]/.test(read.runner),
    'taskRunner.js 不再 import buildMemoryPointerBlock —— 记忆注入被拆掉了')
  must(/buildMemoryPointerBlock\(\s*\{/.test(read.runner),
    'taskRunner.js 里找不到 buildMemoryPointerBlock 的调用点')
})

// ── B 顺序：必须在正文之前 ────────────────────────────────────────────
t('B 顺序：记忆块拼在任务正文之前（不是追加到末尾）', () => {
  must(/prefixBlocks/.test(read.runner), 'runSingleSubtask 不再有 prefixBlocks 聚合变量')
  must(/prompt\s*=\s*`\$\{prefixBlocks\.join\([^)]*\)\}[\s\S]{0,40}\$\{prompt\}`/.test(read.runner),
    'prefixBlocks 没有被拼在 ${prompt} **之前** —— 记忆块可能被改成了追加到末尾，' +
    '那样 Agent 会把它当成本轮任务而不是背景')
  // 反向禁令：不允许出现 "prompt + memBlock" 这种追加形状
  must(!/prompt\s*=\s*`\$\{prompt\}[\s\S]{0,80}memBlock/.test(read.runner),
    '检测到把记忆块追加到 prompt 末尾的写法 —— 顺序反了')
})

// ── C 开关 ────────────────────────────────────────────────────────────
t('C 开关：task.memoryContext === false 时整块不注入', () => {
  must(/task\.memoryContext\s*!==\s*false/.test(read.runner),
    '找不到 task.memoryContext !== false 的总开关 —— 用户将无法为单任务关掉记忆注入')
})

// ── D 续接轮 ──────────────────────────────────────────────────────────
t('D 续接：capture 跟着 resumeSessionId 走（续聊不重复讲捕获纪律）', () => {
  must(/capture:\s*!\s*resumeSessionId/.test(read.runner),
    'capture 没有跟 resumeSessionId 绑定 —— 续接轮会重复注入整段捕获纪律，纯烧 token')
})

// ── E/F 体积与内容（真跑一遍纯函数）──────────────────────────────────
async function runtimeChecks() {
  // ⚠️ Windows 上绝对路径必须转 file:// URL，否则 dynamic import 报
  // "Only URLs with a scheme in: file, data, and node are supported"（踩过一次）
  const { pathToFileURL } = require('node:url')
  const mod = await import(pathToFileURL(path.join(ROOT, 'src/ui/server/routes/workbench/memoryContext.js')).href)
  const { buildMemoryPointerBlock, MEMORY_BLOCK_MAX_BYTES, MEMORY_BLOCK_LEVEL } = mod

  t('E 体积：块不超过 MEMORY_BLOCK_MAX_BYTES', () => {
    const { block } = buildMemoryPointerBlock({
      memoryDir: '/home/u/.zen-gitsync/memory',
      projectIndexFile: '/home/u/.zen-gitsync/memory/projects/repo-abc123/INDEX.md',
    })
    const bytes = Buffer.byteLength(block, 'utf8')
    must(bytes > 0, '块是空的')
    must(bytes <= MEMORY_BLOCK_MAX_BYTES, `块 ${bytes}B 超过预算 ${MEMORY_BLOCK_MAX_BYTES}B`)
  })

  t('E 体积：capture 关掉后必须更小（续接轮在省 token）', () => {
    const withCap = buildMemoryPointerBlock({ memoryDir: '/m', projectIndexFile: '/m/p/INDEX.md', capture: true })
    const noCap = buildMemoryPointerBlock({ memoryDir: '/m', projectIndexFile: '/m/p/INDEX.md', capture: false })
    must(Buffer.byteLength(noCap.block, 'utf8') < Buffer.byteLength(withCap.block, 'utf8'),
      'capture=false 没有减小体积 —— 捕获段没被真正砍掉')
  })

  t('F 内容：懒加载 + 索引缺一不可 + 以后怎么做 三条硬约束都在', () => {
    const { block } = buildMemoryPointerBlock({ memoryDir: '/m', projectIndexFile: '/m/p/INDEX.md' })
    must(/不要预加载全部 lessons/.test(block), '缺「不要预加载全部 lessons」')
    must(/archive/.test(block), '缺「archive 永不读」')
    must(/没索引的记忆等于不存在/.test(block), '缺「没索引的记忆等于不存在」')
    must(/以后怎么做/.test(block), '缺「写以后怎么做」')
  })

  t('F 内容：没有项目索引时不谎报项目层', () => {
    const { block, level } = buildMemoryPointerBlock({ memoryDir: '/m' })
    must(level === MEMORY_BLOCK_LEVEL.GLOBAL_ONLY, `level 应为 GLOBAL_ONLY，实际 ${level}`)
    must(!block.includes('/m/projects/'), '没有项目索引时不该给出项目路径')
  })

  t('F 内容：memoryDir 为空则完全不注入', () => {
    const { block, level } = buildMemoryPointerBlock({})
    must(block === '', '空 memoryDir 仍产出了内容')
    must(level === MEMORY_BLOCK_LEVEL.NONE, '空 memoryDir 的 level 应为 NONE')
  })
  // ⚠️ 这一条是被真实事故逼出来的：注入点写完 `node --check` 全绿、源码断言也全绿，
  // 真 import taskRunner.js 才报 "does not provide an export named 'MEMORY_DIR'"。
  // 原因：MEMORY_DIR 住在 paths.js、projectIndexFile 住在 store.js，我把两个名字
  // 都从 store.js 导入了。**node --check 只查语法，查不出链接期少导出**（本仓库
  // 早就吃过一次，见 MEMORY.md 的「服务端起不来但 node --check 全绿」）。
  // 所以这里必须真 import 一次，而不是只 grep 源码。
  // 同样的道理对"路由注册"成立：只 import 不调用，接口其实压根没挂上，
  // 界面点下去会是 404 —— 而 404 在开发期很容易被误当成"后端没重启"。
  const { pathToFileURL: p2f } = require('node:url')
  try {
    await import(p2f(path.join(ROOT, 'src/ui/server/routes/workbench/taskRunner.js')).href)
    results.push({ ok: true, name: 'J 链接期：taskRunner.js 能真 import（node --check 查不出这一类）' })
  } catch (err) {
    results.push({
      ok: false,
      name: 'J 链接期：taskRunner.js 能真 import（node --check 查不出这一类）',
      msg: `${err.name}: ${err.message}`,
    })
  }

  // 链接期再叠一层：library.js 被路由 import，少一个具名导出就是整页起不来
  try {
    const lib = await import(p2f(path.join(ROOT, 'src/memory/library.js')).href)
    for (const fn of ['listScopes', 'listEntries', 'readEntry', 'deleteEntry', 'memoryDirExists', 'isValidScope', 'isValidFile', 'SCOPE_GLOBAL', 'SCOPE_GLOBAL_INDEX']) {
      if (lib[fn] === undefined) throw new Error(`library.js 缺导出 ${fn}`);
    }
    results.push({ ok: true, name: 'J2 链接期：library.js 导出齐全（路由依赖它）' })
  } catch (err) {
    results.push({ ok: false, name: 'J2 链接期：library.js 导出齐全（路由依赖它）', msg: err.message })
  }
}

// ── G 铺种子 ──────────────────────────────────────────────────────────
t('G 铺种子：注册路由时调 ensureMemoryStore，且失败不抛', () => {
  must(/import\s*\{[^}]*ensureMemoryStore[^}]*\}\s*from\s*['"][^'"]*memory\/store\.js['"]/.test(read.wb),
    'workbench/index.js 不再 import ensureMemoryStore —— 记忆库不会被铺出来')
  must(/ensureMemoryStore\(\)[\s\S]{0,400}?\.catch\(/.test(read.wb),
    'ensureMemoryStore 没有 .catch —— 铺种子失败会把整个工作台带崩')
})

// ── H 打包 ────────────────────────────────────────────────────────────
t('H 打包：src/memory/** 在 package.json#files 里', () => {
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'))
  const files = Array.isArray(pkg.files) ? pkg.files : []
  must(files.some((f) => f.replace(/\\/g, '/') === 'src/memory/**'),
    'files 白名单里没有 src/memory/** —— 装完第一次开工作台会 ERR_MODULE_NOT_FOUND')
})

t('H2 打包：记忆库路由已注册到 app（只 import 不调用 = 接口没挂上）', () => {
  const code = codeOnly(path.join(ROOT, 'src/ui/server/index.js'))
  must(/import\s*\{[^}]*registerMemoryRoutes[^}]*\}/.test(code), 'server/index.js 没 import registerMemoryRoutes')
  must(/registerMemoryRoutes\(\s*\{\s*app\s*\}\s*\)/.test(code), 'registerMemoryRoutes 没被调用 —— 接口会 404')
  // 必须排在全局 errorHandler 之前，否则 asyncRoute 抛的 HttpError 没人接
  const call = code.indexOf('registerMemoryRoutes({')
  const handler = code.indexOf('createErrorHandler()')
  must(call > -1 && handler > -1 && call < handler, 'registerMemoryRoutes 排在 createErrorHandler 之后了')
})

// ── I 不碰用户工作区 / 第三方配置目录 ─────────────────────────────────
t('I 边界：注入链路只写 MEMORY_DIR，不碰用户工作区与第三方配置目录', () => {
  const files = [RUNNER, MEMCTX, WB_INDEX, STORE, LIBRARY, MEMROUTE]
  const FORBIDDEN = [
    { re: /\.claude[\\/]/, why: '写了 ~/.claude/（那是 Claude Code 自己的配置）' },
    { re: /\.codex[\\/]/, why: '写了 ~/.codex/' },
    { re: /\.config[\\/]opencode/, why: '写了 ~/.config/opencode/' },
  ]
  for (const f of files) {
    const code = codeOnly(f)
    for (const { re, why } of FORBIDDEN) {
      const hit = code.match(new RegExp(`(writeFile|appendFile|mkdir|rename|copyFile|rm|unlink)[^\\n]{0,80}${re.source}`, 'i'))
      must(!hit, `${path.relative(ROOT, f)} ${why} —— 记忆功能不该替用户改第三方工具的配置`)
    }
  }
})

// ── K 记忆库面板：浏览/删除接口的安全边界 ───────────────────────────
t('K 面板接口：只按 scope+file 定位，不开"传任意路径"的洞', () => {
  const code = codeOnly(MEMROUTE)
  must(!/req\.(body|query|params)\.(path|filePath|abs|dir)\b/.test(code),
    '记忆库接口不接受前端传的路径 —— 路径由服务端从 scope 重拼（见 routes/memory.js 头注释）')
  must(/requireScope/.test(code) && /requireFile/.test(code),
    '删/读的入参没有过 requireScope/requireFile 校验')
  must(/req\.body\?\.confirm !== true/.test(code),
    '删除接口没有 require confirm: true —— 误触一次就是永久删除')
  must(/SCOPE_GLOBAL/.test(code) && /不可删除|protected/.test(code),
    '全局索引/规范文件没被保护起来 —— 删了整套记忆就失去记账口径')
  must(/single|单条/.test(code) || /entry/.test(code), '缺少单条读/删入口')
  must(/batch-delete/.test(code), '缺少批量删除入口')
})

t('K 面板接口：删条目要连带清 INDEX.md 那一行（不留死链）', () => {
  const code = codeOnly(LIBRARY)
  must(/removeIndexLine/.test(code), 'deleteEntry 没有联动清理索引行')
  must(/lessons\/\$\{file\}/.test(code), '索引行的匹配口径变了 —— 确认没漏改')
  // 逐行过滤而不是 replace：replace 会误伤正文里提到同一路径的段落
  must(/split\(\/\\r\?\\n\/\)[\s\S]{0,80}?filter\(/.test(code),
    '索引行清理改成了字符串 replace —— 会误伤正文里恰好提到同一路径的行')
})

t('K 面板：设置弹窗里挂上了 memory tab 且懒加载', () => {
  const dlg = fs.readFileSync(SETTINGS_DIALOG, 'utf8')
  must(/'memory'/.test(dlg), 'SettingsTab 联合类型里没有 memory')
  must(/onClickMemoryTab/.test(dlg), 'memory tab 不是懒加载的 —— 打开设置弹窗就会多打一次接口')
  must(/<MemoryPanel/.test(dlg), '模板里没有挂 MemoryPanel')
  must(/import MemoryPanel/.test(dlg), 'MemoryPanel 没 import')
  // hasChanges 刻意**不加** memory 分支（面板没有待保存设置）——
  // 加了反而会让 footer 冒出永远不生效的「保存设置」
  const hasChanges = /const hasChanges = computed\(\(\) => \{[\s\S]*?\n\}\)/.exec(codeOnly(SETTINGS_DIALOG))
  must(hasChanges && !/activeTab\.value === 'memory'/.test(hasChanges[1]),
    'hasChanges 里有 memory 分支 —— 记忆库面板没有待保存设置，加了会让「保存设置」永远不生效')
})

// ── reverse：把 A~D 打回去，必须翻红 ──────────────────────────────────
function reverseChecks() {
  const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-memctx-reverse-'))
  try {
    const src = fs.readFileSync(RUNNER, 'utf8')

    // R1：把"拼在正文之前"改回"追加到末尾"（B 必须翻红）
    const appended = src
      .replace(
        /prompt = `\$\{prefixBlocks\.join\(([^)]*)\)\}[\s\S]{0,40}\$\{prompt\}`/,
        'prompt = `${prompt}\\n\\n---\\n\\n${prefixBlocks.join($1)}`'
      )
    fs.writeFileSync(path.join(SANDBOX, 'R1-appended.js'), appended, 'utf8')
    // R2：摘掉总开关（C 必须翻红）
    fs.writeFileSync(path.join(SANDBOX, 'R2-no-gate.js'), src.replace('task.memoryContext !== false', 'true'), 'utf8')
    // R3：把 capture 写死成 true（D 必须翻红）
    fs.writeFileSync(path.join(SANDBOX, 'R3-capture-always.js'), src.replace(/capture:\s*!\s*resumeSessionId/, 'capture: true'), 'utf8')
    // R4：摘掉 import（A 必须翻红）
    fs.writeFileSync(path.join(SANDBOX, 'R4-no-import.js'), src.replace(/import \{ buildMemoryPointerBlock \} from '\.\/memoryContext\.js';/, ''), 'utf8')

    const cases = [
      ['R1 顺序改成追加', 'R1-appended.js', /prompt\s*=\s*`\$\{prefixBlocks\.join\([^)]*\)\}[\s\S]{0,40}\$\{prompt\}`/],
      ['R2 摘掉总开关', 'R2-no-gate.js', /task\.memoryContext\s*!==\s*false/],
      ['R3 capture 写死 true', 'R3-capture-always.js', /capture:\s*!\s*resumeSessionId/],
      ['R4 摘掉 import', 'R4-no-import.js', /import\s*\{[^}]*buildMemoryPointerBlock[^}]*\}/],
    ]

    for (const [label, file, re] of cases) {
      t(`reverse ${label}：断言必须翻红`, () => {
        const mutated = codeOnly(path.join(SANDBOX, file))
        must(!re.test(mutated),
          `把「${label}」打回去之后断言居然还通过 —— 这条断言恒真，等于没验（量错了匹配对象）`)
      })
    }
  } finally {
    fs.rmSync(SANDBOX, { recursive: true, force: true })
  }
}

function report() {
  const failed = results.filter((r) => !r.ok)
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.msg ? `\n      ${r.msg}` : ''}`)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (REVERSE) {
    const rev = results.filter((r) => r.name.startsWith('reverse '))
    const revFailed = rev.filter((r) => !r.ok)
    if (revFailed.length) {
      console.log(`\n反证失败：${revFailed.length} 条 reverse 断言没翻红 —— 上面的 PASS 不可信`)
      process.exit(1)
    }
    console.log('反证通过：所有 reverse 断言都如期翻红')
  }
  process.exit(failed.length ? 1 : 0)
}

;(async () => {
  try {
    await runtimeChecks()
  } catch (err) {
    results.push({ ok: false, name: 'E/F 运行时（导入 memoryContext.js）', msg: err.message })
  }
  if (REVERSE) reverseChecks()
  report()
})()

