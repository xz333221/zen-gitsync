#!/usr/bin/env node
/**
 * verify:atomic-write —— Windows「有读者时 rename 覆盖必然 EPERM」的回归探针。
 *
 * 为什么单测抓不到：libuv 在 Windows 上打开文件只请求 FILE_SHARE_READ|FILE_SHARE_WRITE
 * （没带 FILE_SHARE_DELETE，nodejs/node#16423），所以**只要有读句柄**，对同一路径的
 * rename 就必然失败。本仓里读句柄遍地都是：看板 5s 轮询读 jobs.json、别的实例扫
 * instances/、保留策略回写 tasks.json。结果是用户点「移动到其他项目」直接弹
 * `EPERM: operation not permitted, rename 'tasks.json.tmp' -> 'tasks.json'`。
 *
 * 探针用 PowerShell 以 FileShare.Read 打开目标文件来复刻这个占用（等价于"有人在读"），
 * 然后：
 *   A 反向对照 —— 旧写法（固定 .tmp + 裸 rename）必须红，证明探针真的复现了占用；
 *   B 新写法（fsAtomic 退避重试）必须绿，且内容真的落盘；
 *   C 不留孤儿 tmp；
 *   D 无占用时行为不变。
 *
 * 非 Windows 直接跳过（本机 tmp+rename 天然原子，没有这个坑）。
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function lockFile(file, holdMs) {
  const ps = [
    `$fs=[System.IO.File]::Open('${file.replace(/\\/g, '\\\\')}','Open','Read','Read')`,
    `Start-Sleep -Milliseconds ${holdMs}`,
    '$fs.Close()'
  ].join(';');
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
}

// 旧实现（writeJson 改造前的写法）—— 只用于反向对照
async function legacyWriteJson(file, data) {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fsp.rename(tmp, file);
}

(async () => {
  if (process.platform !== 'win32') {
    console.log('跳过：本探针只针对 Windows 的 rename/EPERM 行为');
    return;
  }

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-atomic-write-'));
  const file = path.join(sandbox, 'tasks.json');
  const results = [];

  const { writeJson } = await import('../src/ui/server/routes/workbench/shared.js');

  try {
    await fsp.writeFile(file, JSON.stringify({ ver: 'init' }), 'utf-8');

    // A. 反向对照：旧写法在「目标被读句柄占着」时必红
    {
      const locker = lockFile(file, 900);
      await wait(320);                       // PowerShell 冷启动 ~300-500ms
      let err = null;
      try { await legacyWriteJson(file, { ver: 'legacy' }); } catch (e) { err = e; }
      locker.kill();
      await wait(200);
      results.push(['A 旧写法（固定 .tmp + 裸 rename）应当失败', !!err, err ? err.code : '没报错 → 探针没造出占用，结论无效']);
      for (const n of fs.readdirSync(sandbox).filter((x) => x.endsWith('.tmp'))) {
        fs.rmSync(path.join(sandbox, n), { force: true });   // 旧写法失败时会把 tmp 留在盘上
      }
    }

    // B. 新写法：同一占用下退避重试穿透，内容真的落盘
    {
      const locker = lockFile(file, 260);
      await wait(120);
      let err = null;
      try { await writeJson(file, { ver: 'new' }); } catch (e) { err = e; }
      locker.kill();
      await wait(100);
      const onDisk = JSON.parse(await fsp.readFile(file, 'utf-8'));
      results.push(['B 新写法（fsAtomic 退避重试）应当成功', !err && onDisk.ver === 'new', err ? err.code : `ver=${onDisk.ver}`]);
    }

    // C. 成功之后不留孤儿 tmp
    {
      const leftovers = fs.readdirSync(sandbox).filter((n) => n.includes('.tmp'));
      results.push(['C 不留孤儿 tmp', leftovers.length === 0, leftovers.join(',') || 'none']);
    }

    // D. 无占用时行为不变
    {
      await writeJson(file, { ver: 'plain' });
      const onDisk = JSON.parse(await fsp.readFile(file, 'utf-8'));
      results.push(['D 无占用时正常写入', onDisk.ver === 'plain', `ver=${onDisk.ver}`]);
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }

  let bad = 0;
  for (const [name, ok, detail] of results) {
    if (!ok) bad++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
  }
  console.log(`\n用例 ${results.length} 条，失败 ${bad} 条`);
  process.exit(bad ? 1 : 0);
})();
