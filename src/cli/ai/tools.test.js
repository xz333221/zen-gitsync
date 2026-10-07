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
// src/cli/ai/tools.js 单元测试 — 在系统临时目录里做真实的文件读写,
// 覆盖 write/read/edit/list/search 的往返与 run_command 的安全守卫联动。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TOOL_DEFINITIONS, executeTool, resolveCommandTimeout, normalizePlanSteps, isPlanToolName, splitToolOutput, toolMessageContent } from './tools.js'

// 1×1 红色 PNG。用真字节而不是造一个空文件:checkImageFile 只校验扩展名与体积,
// 但"读出来能还原成原图"这件事值得顺手钉一下(imageToDataUrl 会把内容 base64)。
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let tmpDir
const ctx = { cwd: null, onChild: null }

test('ask_user schema and arguments support options plus free text', async () => {
  const definition = TOOL_DEFINITIONS.find(tool => tool.function.name === 'ask_user')
  assert.ok(definition)
  assert.deepEqual(definition.function.parameters.required, ['question'])
  assert.ok(definition.function.parameters.properties.options)
  assert.ok(definition.function.parameters.properties.allow_free_text)
  assert.ok(definition.function.parameters.properties.multiple)

  let received
  const result = await executeTool('ask_user', {
    question: '  Which path should I take?  ',
    options: ['  Fast  ', '', 42, null],
    allow_free_text: false,
  }, {
    ...ctx,
    askUser: async value => {
      received = value
      return 'Fast'
    },
  })
  assert.equal(result, 'Fast')
  assert.deepEqual(received, {
    question: 'Which path should I take?',
    options: ['Fast', '42'],
    allowFreeText: false,
    multiple: false,
  })
})

test('ask_user 把 multiple 透传给交互回调,没有选项时强制单选', async () => {
  const seen = []
  const askUser = async value => { seen.push(value); return 'x' }
  await executeTool('ask_user', { question: '选几个?', options: ['A', 'B'], multiple: true }, { ...ctx, askUser })
  await executeTool('ask_user', { question: '随便说', multiple: true }, { ...ctx, askUser })
  assert.equal(seen[0].multiple, true)
  assert.equal(seen[1].multiple, false, '没有选项时多选无意义')
})

test('ask_user returns a useful error when no interactive callback exists', async () => {
  const result = await executeTool('ask_user', { question: 'Continue?' }, ctx)
  assert.match(result, /ask_user is unavailable/)
  assert.match(await executeTool('ask_user', {}, { ...ctx, askUser: async () => 'x' }), /requires a non-empty question/)
})

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'g-ai-tools-'))
  ctx.cwd = tmpDir
})

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

// ========== schema 基本形态 ==========

test('edit_file preserves literal replacement tokens', async () => {
  await executeTool('write_file', { path: 'literal.txt', content: 'before' }, ctx)
  const replacement = '$& $$ $` $\x27'
  await executeTool('edit_file', { path: 'literal.txt', old_string: 'before', new_string: replacement }, ctx)
  assert.equal(await fs.readFile(path.join(tmpDir, 'literal.txt'), 'utf8'), replacement)
})

test('run_command cancellation terminates a running command promptly', async () => {
  const controller = new AbortController()
  const started = performance.now()
  const result = await executeTool('run_command', { command: 'node -e "setInterval(()=>{},1000)"' }, {
    ...ctx, signal: controller.signal, onChild: () => setTimeout(() => controller.abort(), 80),
  })
  assert.match(result, /用户停止/)
  assert.ok(performance.now() - started < 5000)
})

test('an already cancelled tool does not write files', async () => {
  const result = await executeTool('write_file', { path: 'cancelled.txt', content: 'no' }, { ...ctx, signal: AbortSignal.abort() })
  assert.match(result, /not executed/)
  await assert.rejects(fs.stat(path.join(tmpDir, 'cancelled.txt')), { code: 'ENOENT' })
})

test('TOOL_DEFINITIONS 符合 OpenAI function calling 格式', () => {
  assert.ok(Array.isArray(TOOL_DEFINITIONS))
  assert.ok(TOOL_DEFINITIONS.length >= 5)
  for (const t of TOOL_DEFINITIONS) {
    assert.equal(t.type, 'function')
    assert.ok(t.function.name, '工具要有名字')
    assert.ok(t.function.description, '工具要有描述')
    assert.equal(t.function.parameters.type, 'object')
  }
})

// ========== write_file / read_file 往返 ==========

test('write_file 创建嵌套文件,read_file 带行号读回', async () => {
  const w = await executeTool('write_file', { path: 'src/deep/hello.txt', content: 'line1\nline2\nline3' }, ctx)
  assert.match(w, /已写入/)

  const r = await executeTool('read_file', { path: 'src/deep/hello.txt' }, ctx)
  assert.match(r, /1→line1/)
  assert.match(r, /3→line3/)
  assert.match(r, /共 3 行/)
})

test('read_file 支持 offset/limit 分段', async () => {
  const r = await executeTool('read_file', { path: 'src/deep/hello.txt', offset: 2, limit: 1 }, ctx)
  assert.match(r, /2→line2/)
  assert.doesNotMatch(r, /1→line1/)
})

test('read_file 不存在的文件返回错误字符串(不抛异常)', async () => {
  const r = await executeTool('read_file', { path: 'no-such-file.txt' }, ctx)
  assert.match(r, /^错误:/)
})

// ========== edit_file ==========

test('edit_file 唯一匹配替换成功', async () => {
  const r = await executeTool('edit_file', { path: 'src/deep/hello.txt', old_string: 'line2', new_string: 'LINE-2' }, ctx)
  assert.match(r, /已修改/)
  const content = await fs.readFile(path.join(tmpDir, 'src/deep/hello.txt'), 'utf-8')
  assert.ok(content.includes('LINE-2'))
})

test('edit_file 找不到 old_string 时报错并提示先 read_file', async () => {
  const r = await executeTool('edit_file', { path: 'src/deep/hello.txt', old_string: 'not-exist', new_string: 'x' }, ctx)
  assert.match(r, /找不到 old_string/)
})

test('edit_file 多处匹配默认拒绝,replace_all 放行', async () => {
  await executeTool('write_file', { path: 'multi.txt', content: 'a=a\nb=a' }, ctx)
  const dup = await executeTool('edit_file', { path: 'multi.txt', old_string: 'a', new_string: 'z' }, ctx)
  assert.match(dup, /不唯一/)

  const all = await executeTool('edit_file', { path: 'multi.txt', old_string: 'a', new_string: 'z', replace_all: true }, ctx)
  assert.match(all, /替换 3 处/)
})

// ========== list_files ==========

test('list_files 列出结构并跳过 node_modules', async () => {
  await fs.mkdir(path.join(tmpDir, 'node_modules/pkg'), { recursive: true })
  await fs.writeFile(path.join(tmpDir, 'node_modules/pkg/x.js'), 'x')
  const r = await executeTool('list_files', { depth: 3 }, ctx)
  assert.match(r, /src\//)
  assert.match(r, /hello\.txt/)
  assert.doesNotMatch(r, /node_modules/)
})

// ========== search_text ==========

test('search_text 能找到匹配行并带行号', async () => {
  const r = await executeTool('search_text', { pattern: 'LINE-2' }, ctx)
  assert.match(r, /hello\.txt:2:/)
})

test('search_text 支持 ext 过滤与 ignore_case', async () => {
  const miss = await executeTool('search_text', { pattern: 'LINE-2', ext: 'md' }, ctx)
  assert.match(miss, /未找到/)
  const hit = await executeTool('search_text', { pattern: 'line-2', ignore_case: true }, ctx)
  assert.match(hit, /hello\.txt/)
})

test('search_text 非法正则不抛异常', async () => {
  const r = await executeTool('search_text', { pattern: '([' }, ctx)
  assert.match(r, /正则无效/)
})

// ========== run_command ==========

test('run_command 执行成功并返回输出与退出码', async () => {
  const r = await executeTool('run_command', { command: 'echo hello-g-ai' }, ctx)
  assert.match(r, /\(exit 0\)/)
  assert.match(r, /hello-g-ai/)
})

test('run_command 非零退出也正常返回(不抛异常)', async () => {
  const r = await executeTool('run_command', { command: 'exit 3' }, ctx)
  assert.match(r, /\(exit 3\)/)
})

test('run_command 被安全守卫拦截系统级毁灭命令', async () => {
  const r = await executeTool('run_command', { command: 'rm -rf /' }, ctx)
  assert.match(r, /已拒绝执行/)
})

test('run_command 放行项目内删除操作(不被守卫拦截)', async () => {
  await fs.mkdir(path.join(tmpDir, 'junk'), { recursive: true })
  // 注意不断言 exit 0:Windows 默认 cmd.exe 没有 rm 命令,删不删得掉是 shell 的事,
  // 这里只验证安全守卫**不拦截**项目内删除(那是模型的正常工作流)
  const r = await executeTool('run_command', { command: 'rm -rf junk' }, ctx)
  assert.doesNotMatch(r, /已拒绝执行/)
})

test('run_command 不存在的 cwd 返回错误', async () => {
  const r = await executeTool('run_command', { command: 'echo x', cwd: 'no-such-dir-xyz' }, ctx)
  assert.match(r, /目录不存在/)
})

test('run_command: 命令找不到时如实报错(补 PATH 的兜底不许吞掉错误、也不许重试到卡死)', async () => {
  // 这条守的是 shellPath 那套「补 PATH + 找不到就强刷缓存重试一次」的边界：
  // 重试的触发条件是 isCommandNotFound，重试前提是"确实多出了新目录"。
  // 一个真实不存在的命令，两条都不满足 —— 必须原样把 shell 的报错交回给模型，
  // 而不是吞成空输出、更不能循环重试。
  const r = await executeTool('run_command', { command: 'definitely-not-a-real-cli-xyz --version' }, ctx)
  assert.match(r, /definitely-not-a-real-cli-xyz/, '应回显执行的命令')
  assert.match(r, /\(exit [1-9]/, '应有非 0 退出码')
  assert.match(
    r,
    /不是内部或外部命令|is not recognized|command not found|ENOENT/,
    '应保留 shell 的"命令找不到"原文，供模型判断',
  )
})

// ========== 未知工具 ==========

test('未知工具返回错误字符串并列出可用工具', async () => {
  const r = await executeTool('nope_tool', {}, ctx)
  assert.match(r, /未知工具/)
  assert.match(r, /run_command/)
})

// ========== search_text: 文件路径直接搜索 ==========

test('search_text 支持 path 直接指向单个文件', async () => {
  const r = await executeTool('search_text', { pattern: 'LINE-2', path: 'src/deep/hello.txt' }, ctx)
  assert.match(r, /hello\.txt:2:/)
  const miss = await executeTool('search_text', { pattern: 'not-in-file-xyz', path: 'src/deep/hello.txt' }, ctx)
  assert.match(miss, /未找到/)
})

// ========== run_command: 输出编码(GBK 乱码回归) ==========

test('run_command UTF-8 中文输出不乱码', async () => {
  // node 自身 stdout 是 UTF-8,跨平台一致
  const r = await executeTool('run_command', { command: 'node -e "console.log(\'中文输出测试\')"' }, ctx)
  assert.match(r, /中文输出测试/)
})

test('run_command 本地化错误消息解码正确(Windows GBK 回归)', async () => {
  const r = await executeTool('run_command', { command: 'nonexistent-cmd-xyz-123' }, ctx)
  if (process.platform === 'win32') {
    // cmd.exe 的"不是内部或外部命令"是 GBK 字节流,修复前会显示为 '����' 乱码
    assert.match(r, /不是内部或外部命令/)
    assert.doesNotMatch(r, /�/)
  } else {
    assert.match(r, /not found|未找到/)
  }
})

// ========== run_command: 实时输出 + 超时选择 ==========

test('run_command 执行期间通过 onOutput 增量回传输出(命令结束前就能拿到)', async () => {
  const chunks = []
  let returned = false
  const pending = executeTool('run_command', {
    command: 'node -e "console.log(\'live-1\'); setTimeout(()=>console.log(\'live-2\'), 600)"',
  }, { ...ctx, onOutput: text => chunks.push(text) }).then(r => { returned = true; return r })

  const deadline = Date.now() + 5000
  while (!chunks.join('').includes('live-1') && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 20))
  }
  assert.match(chunks.join(''), /live-1/, '命令还在跑时就该收到第一行输出')
  assert.equal(returned, false, '此时 run_command 不应已返回')

  const result = await pending
  assert.match(result, /live-1/)
  assert.match(result, /live-2/)
})

test('resolveCommandTimeout: 长耗时命令抬到上限,普通命令保持默认 / 模型给的值', () => {
  // 安装 / 构建 / clone 这类命令:模型不给够超时容易被 120s 杀掉再重试
  assert.equal(resolveCommandTimeout('npm install', undefined), 600)
  assert.equal(resolveCommandTimeout('npm i --save-dev vite', undefined), 600)
  assert.equal(resolveCommandTimeout('pnpm install && npm run build', 60), 600)
  assert.equal(resolveCommandTimeout('git clone git@github.com:a/b.git', undefined), 600)
  // 普通命令不动
  assert.equal(resolveCommandTimeout('echo hi', undefined), 120)
  assert.equal(resolveCommandTimeout('echo hi', 30), 30)
  // 起服务这类命令不抬:它本来就不该等到超时
  assert.equal(resolveCommandTimeout('npm run dev', 60), 60)
})

// ========== list_projects: 只在 GUI 里有实现,CLI 下要给一句能照着做的话 ==========

test('list_projects 把参数透传给注入的实现', async () => {
  const definition = TOOL_DEFINITIONS.find(tool => tool.function.name === 'list_projects')
  assert.ok(definition, 'TOOL_DEFINITIONS 里必须有 list_projects')
  assert.deepEqual(definition.function.parameters.required, [])

  const seen = []
  const out = await executeTool('list_projects', { refresh: true }, {
    ...ctx,
    listProjects: async args => {
      seen.push(args)
      return '清单文本'
    },
  })
  assert.equal(out, '清单文本')
  assert.deepEqual(seen, [{ refresh: true }])
})

test('list_projects 默认不刷新(只读本地快照)', async () => {
  const seen = []
  await executeTool('list_projects', {}, { ...ctx, listProjects: async args => { seen.push(args); return 'x' } })
  assert.deepEqual(seen, [{ refresh: false }])
  // 非布尔值一律按"不刷新"处理,不能被字符串 "true"/1 之类的脏参数带跑
  await executeTool('list_projects', { refresh: 'true' }, { ...ctx, listProjects: async args => { seen.push(args); return 'x' } })
  assert.deepEqual(seen[1], { refresh: false })
})

test('list_projects 没有注入实现时(CLI 下)给出可执行的替代做法', async () => {
  const r = await executeTool('list_projects', {}, ctx)
  assert.match(r, /只在 g ui/)
  assert.match(r, /git -C/)
})

test('dispatch_task schema 要求 text，并声明三条可选口径', async () => {
  const definition = TOOL_DEFINITIONS.find(tool => tool.function.name === 'dispatch_task')
  assert.ok(definition, '工具表里必须有 dispatch_task —— 主 Agent 控制台的派发就靠它')
  assert.deepEqual(definition.function.parameters.required, ['text'])
  assert.deepEqual(definition.function.parameters.properties.executor.enum, ['claude', 'opencode', 'codex'])
  assert.ok(definition.function.parameters.properties.project_path)
  assert.ok(definition.function.parameters.properties.auto_run)
  assert.ok(definition.function.parameters.properties.use_default_prompt)
})

test('dispatch_task 把参数映射成派发 payload：省略 = 保持服务端默认', async () => {
  const seen = []
  const withDispatch = { ...ctx, dispatchTask: async payload => { seen.push(payload); return '已派发' } }

  assert.equal(await executeTool('dispatch_task', {
    text: '  重构登录模块  ',
    project_path: ' D:/proj ',
    executor: 'opencode',
    auto_run: false,
    use_default_prompt: false,
  }, withDispatch), '已派发')
  assert.deepEqual(seen[0], {
    text: '重构登录模块',
    projectPath: 'D:/proj',
    executor: 'opencode',
    autoRun: false,
    useDefaultPrompt: false,
  })

  // 只给正文：其余三个键**一律不出现**，由服务端按控制台当前的选择决定
  // （带上 undefined 或 true 都会把"跟随界面"变成"硬编码默认值"）
  await executeTool('dispatch_task', { text: '只给正文' }, withDispatch)
  assert.deepEqual(seen[1], { text: '只给正文' })

  // 显式写默认值等价于省略
  await executeTool('dispatch_task', { text: 'x', auto_run: true, use_default_prompt: true }, withDispatch)
  assert.deepEqual(seen[2], { text: 'x' })
})

test('dispatch_task 在没有注入实现的入口给一句可照做的说明，并禁止模型假装已派', async () => {
  const result = await executeTool('dispatch_task', { text: '派出去' }, ctx)
  assert.match(result, /只在 g ui 的「主 Agent 控制台」/)
  assert.match(result, /不要重试/)
  assert.match(result, /不要假装/)
  assert.match(await executeTool('dispatch_task', {}, ctx), /需要非空的 text/)
})

// ── update_plan ────────────────────────────────────────────
// 它是纯展示工具，但字段归一化有真实坑（模型会给 content/text/title、
// 状态会给 in_progress/inProgress/done），归一化错了终端清单会静默少一格，
// 所以这里把边界全钉住。
test('update_plan schema：steps 必填，状态枚举只有三态', () => {
  const definition = TOOL_DEFINITIONS.find(tool => tool.function.name === 'update_plan')
  assert.ok(definition)
  assert.deepEqual(definition.function.parameters.required, ['steps'])
  const step = definition.function.parameters.properties.steps.items
  assert.deepEqual(step.properties.status.enum, ['pending', 'in_progress', 'completed'])
  assert.ok(definition.function.parameters.properties.explanation)
})

test('normalizePlanSteps：状态词与文案字段都收敛，脏数据丢弃', () => {
  assert.deepEqual(normalizePlanSteps([
    { content: '  A  ', status: 'done' },
    { text: 'B', state: 'in-progress' },
    { title: 'C' },
    { content: 'D', status: 'weird-status' },
    'E',
    { content: '   ' },
    null,
    42
  ]), [
    { content: 'A', status: 'completed' },
    { content: 'B', status: 'in_progress' },
    { content: 'C', status: 'pending' },
    { content: 'D', status: 'pending' },
    { content: 'E', status: 'pending' }
  ])
  // 步数上限：模型跑偏时不至于把界面撑爆
  assert.equal(normalizePlanSteps(Array.from({ length: 30 }, (_, i) => ({ content: `s${i}` }))).length, 20)
  assert.deepEqual(normalizePlanSteps('不是数组'), [])
})

test('update_plan 回执带上进度摘要与说明', async () => {
  const out = await executeTool('update_plan', {
    steps: [
      { content: '读代码', status: 'completed' },
      { content: '改代码', status: 'in_progress' },
      { content: '验证', status: 'pending' }
    ],
    explanation: '先改库再改宿主'
  }, ctx)
  assert.match(out, /计划已更新/)
  assert.match(out, /3 步\(1 完成 \/ 1 进行中 \/ 1 待办\)/)
  assert.match(out, /先改库再改宿主/)
  // 收尾：空 steps = 计划清空，不该报"没有 content"
  assert.match(await executeTool('update_plan', { steps: [] }, ctx), /计划已清空/)
  // 脏参数要能被模型看懂错在哪
  assert.match(await executeTool('update_plan', { steps: 'x' }, ctx), /必须是数组/)
  assert.match(await executeTool('update_plan', { steps: [{ foo: 1 }] }, ctx), /都要有 content/)
  // 没有步骤就不该带出"0 步"这种没意义的摘要
  assert.doesNotMatch(await executeTool('update_plan', {}, ctx), /0 步/)
})

test('isPlanToolName：归一化后判定，update_plan 与 updatePlan 同义', () => {
  assert.equal(isPlanToolName('update_plan'), true)
  assert.equal(isPlanToolName('updatePlan'), true)
  assert.equal(isPlanToolName('TodoWrite'), true)
  assert.equal(isPlanToolName('read_file'), false)
  assert.equal(isPlanToolName(''), false)
})

// ========== read_image：本仓唯一返回非字符串的工具 ==========
// 真实场景:用户在消息里写了一个图片路径。过去模型只能拿 read_file 硬读,
// 拿到乱码后回一句"我这个模型没有视觉能力"(它其实有)。这三个测试钉住新分工。

test('read_image 返回 { text, images }，图片以 data URL 附在结果里', async () => {
  await fs.writeFile(path.join(tmpDir, 'shot.png'), Buffer.from(PNG_1PX, 'base64'))
  const out = await executeTool('read_image', { path: 'shot.png' }, ctx)

  assert.equal(typeof out, 'object', 'read_image 必须返回对象，不能是字符串')
  assert.match(out.text, /已读取图片/)
  assert.equal(out.images.length, 1)
  assert.match(out.images[0], /^data:image\/png;base64,/)
  // data URL 里的 base64 必须能还原成原始字节(不是把路径当内容编码了)
  assert.equal(Buffer.from(out.images[0].split(',')[1], 'base64').toString('base64'), PNG_1PX)
})

test('read_image 对非图片 / 不存在的文件都返回可照做的错误字符串', async () => {
  await fs.writeFile(path.join(tmpDir, 'note.txt'), 'hello')
  const notImage = await executeTool('read_image', { path: 'note.txt' }, ctx)
  assert.equal(typeof notImage, 'string', '错误也要是字符串，否则调用方会去读 .images')
  assert.match(notImage, /不是支持的图片格式/)

  assert.match(await executeTool('read_image', { path: 'nope.png' }, ctx), /无法读取图片/)
})

test('read_file 遇到图片时把模型推给 read_image，而不是吐乱码', async () => {
  await fs.writeFile(path.join(tmpDir, 'shot2.png'), Buffer.from(PNG_1PX, 'base64'))
  const out = await executeTool('read_file', { path: 'shot2.png' }, ctx)
  assert.match(out, /read_image/)
  assert.ok(!out.includes('�'), '不该把二进制按 UTF-8 解出来给模型看')
})

test('splitToolOutput / toolMessageContent：字符串工具结果原样通过，不引入多模态', () => {
  // 老链路一个字都不能变 —— tool 消息仍是纯字符串，厂商兼容性不受影响
  assert.deepEqual(splitToolOutput('plain'), { text: 'plain', images: [] })
  assert.equal(toolMessageContent('plain', []), 'plain')
  assert.deepEqual(splitToolOutput({ text: 'x', images: ['u'] }), { text: 'x', images: ['u'] })

  const multimodal = toolMessageContent('see image', ['data:image/png;base64,AAA'])
  assert.equal(multimodal[0].type, 'text')
  assert.equal(multimodal[1].type, 'image_url')
  assert.equal(multimodal[1].image_url.url, 'data:image/png;base64,AAA')
})

test('read_image 与 read_file 的描述互指 —— 模型选错工具时能自己纠正', () => {
  const readFile = TOOL_DEFINITIONS.find(t => t.function.name === 'read_file')
  const readImage = TOOL_DEFINITIONS.find(t => t.function.name === 'read_image')
  assert.ok(readImage, 'TOOL_DEFINITIONS 里必须有 read_image')
  assert.match(readFile.function.description, /read_image/)
  assert.match(readImage.function.description, /read_file/)
})
