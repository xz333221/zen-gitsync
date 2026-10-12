// 验证工作台 / AgentView 的 codebuddy 执行器在「WorkBuddy 桌面版污染环境」下
// 仍以独立身份运行 —— 环境剥离生效 + （--live 时）真实认证链通。
//
// 用法：
//   node scripts/verify-wb-codebuddy-env.mjs          env 卫生检查（不需要登录态，秒回）
//   node scripts/verify-wb-codebuddy-env.mjs --live   额外真跑一次 CLI（需要 ~/.codebuddy
//                                                     登录态；发一条真实模型调用，极低成本）
//
// 背景（2026-10-12 实测 + CLI 日志取证）：桌面版给子进程注入 50+ 个环境变量，
// 其中两个是**认证杀手** ——
//   · CODEBUDDY_HOST=workbuddy-desktop      → CLI 冒充桌面版引擎子进程，找桌面版凭据
//                                              （解密密钥只在桌面版手里）→ Authentication required
//   · CODEBUDDY_FORCE_LITE_WB_BUNDLE=1      → 命中桌面版专属 lite-wb bundle 分流通道
//                                              （bin/codebuddy 源码注释明说是给 workbuddy-server
//                                              起 sidecar 用的）→ 同款认证失败
// taskRunner.buildCodebuddyEnv() 用「前缀级剥离 + 认证白名单」处理；本脚本在**真实环境**
// 里验证剥离结果（单测只验证模拟污染），--live 再验证端到端链路。
//
// 与单测的分工：taskRunner.codebuddy.test.js 钉实现细节（哪族键剥、白名单放行）；
// 这里做独立守卫（宽正则扫残留）+ 活体端到端。改剥离规则时两边都要过。

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const { buildCodebuddyEnv, launchCodebuddyPrint, createCodebuddyEventHandler } = await import(
  pathToFileURL(path.join(projectRoot, 'src/ui/server/routes/workbench/taskRunner.js')).href
);

const LIVE = process.argv.includes('--live');

// 宽正则（独立于实现的第二道防线）：桌面版注入族的前缀特征
const SUSPECT_RE = /^(CODEBUDDY_|WORKBUDDY_|CLIENT_INFO_|ACC_|TENCENT_DOCS_LOCAL_|GALILEO_|SANDBOX_CENTER_IPC)/;
// 认证白名单：用户在终端里显式设置属于正当配置，剥离时放行
const KEEP = new Set(['CODEBUDDY_API_KEY', 'CODEBUDDY_BASE_URL']);
// 代码在剥离**之后故意设置**的行为变量（taskRunner.buildCodebuddyEnv 写入），
// 不算"漏剥的注入键" —— 若算进去这里会永远是假红
const OWN = new Set(['CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS']);

let failed = false;

// ── 1. env 卫生检查 ────────────────────────────────────────────────────────
const presentInEnv = Object.keys(process.env).filter((k) => SUSPECT_RE.test(k));
const cleaned = buildCodebuddyEnv();
const leftovers = Object.keys(cleaned).filter((k) => SUSPECT_RE.test(k) && !KEEP.has(k) && !OWN.has(k));

console.log(`[env] 当前环境检测到桌面版注入族变量 ${presentInEnv.length} 个`);
if (presentInEnv.length === 0) {
  console.log('[env] 提示：当前不在桌面版污染环境里（例如从普通终端启动），本项检查力较弱；');
  console.log('[env]       可从 WorkBuddy 终端里复跑以覆盖真实污染场景。');
}
console.log(`[env] 剥离后残留可疑键 ${leftovers.length} 个${leftovers.length ? '：' + leftovers.join(', ') : ''}`);
if (leftovers.length) {
  console.log('[env] FAIL — 剥离规则漏键（见 taskRunner.js 的 CODEBUDDY_DESKTOP_ENV_PREFIXES）');
  failed = true;
} else {
  console.log('[env] PASS — 剥离规则无残留');
}

// ── 2. --live：真实链路（需要登录态） ─────────────────────────────────────
if (LIVE) {
  console.log('[live] 启动真实 CLI（用 ~/.codebuddy 的登录态，发一条真实模型调用）…');
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'zen-cb-live-'));
  const { pid, child } = await launchCodebuddyPrint(cwd, '用一句话回答：1+1 等于几？', '');
  console.log('[live] spawned pid =', pid);
  child.ref?.();

  const job = { toolCalls: [] };
  let text = '';
  const handle = createCodebuddyEventHandler(job, (t) => { text += t; }, () => {});
  let buf = '';
  child.stdout.on('data', (b) => {
    buf += b.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const l of lines) {
      const s = l.trim();
      if (s.startsWith('{')) { try { handle(JSON.parse(s)); } catch { /* 非 JSON 行忽略 */ } }
    }
  });
  child.stderr.on('data', (b) => process.stderr.write('[stderr] ' + b.toString()));

  const code = await new Promise((res) => child.on('close', res));
  if (buf.trim().startsWith('{')) { try { handle(JSON.parse(buf.trim())); } catch { /* 同上 */ } }

  const ok = !!job.claudeSessionId && text.length > 0 && !/Authentication required/.test(text);
  console.log(`[live] exit=${code} session=${job.claudeSessionId || '(未捕获)'} assistant=${JSON.stringify(text.slice(0, 120))}`);
  console.log(ok ? '[live] PASS — 认证成功，链路通' : '[live] FAIL — 未过认证或链路异常');
  if (!ok) failed = true;
}

console.log(failed ? '\n[result] FAIL' : '\n[result] PASS');
process.exit(failed ? 1 : 0);
