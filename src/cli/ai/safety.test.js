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
// src/cli/ai/safety.js 单元测试。
// 覆盖两大类:
//   1. 系统级毁灭命令必须拦截(rm -rf / · format · shutdown · dd · fork bomb 等)
//   2. 项目内正常操作必须放行(rm -rf node_modules · git clean · del /s build 等)
//    —— 第 2 类和第 1 类同等重要,误伤正常操作会让智能体不可用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkDangerousCommand } from './safety.js'

// ========== 必须拦截:递归删除根/系统目录 ==========

const BLOCKED_RM = [
  'rm -rf /',
  'rm -rf /*',
  'rm -fr /',
  'rm -r -f /',
  'rm --recursive --force /',
  'rm -rf ~',
  'rm -rf ~/',
  'rm -rf $HOME',
  'rm -rf ${HOME}',
  'rm -rf /etc',
  'rm -rf /usr',
  'rm -rf /boot',
  'rm -rf /System',
  'rm -rf /windows',
  'rm -rf /c',
  'rm -rf /c/',
  'rm -rf /d/',
  'rm -rf C:\\',
  'rm -rf C:/',
  'rm -rf C:',
  'sudo rm -rf /',
  'rm -rf / && echo done',
  'echo start; rm -rf ~',
  'rm -rf /usr/*',
]

for (const cmd of BLOCKED_RM) {
  test(`拦截递归删除: ${cmd}`, () => {
    const r = checkDangerousCommand(cmd)
    assert.equal(r.blocked, true, `应拦截: ${cmd}`)
    assert.ok(r.reason, '应给出中文原因')
  })
}

// ========== 必须拦截:Windows 删除/格式化/系统破坏 ==========

const BLOCKED_OTHERS = [
  'del /s /q C:\\',
  'del /s C:\\*.*',
  'rd /s /q C:\\',
  'rmdir /s C:\\Windows',
  'format C:',
  'format d: /q',
  'mkfs.ext4 /dev/sda1',
  'mkfs /dev/sdb',
  'diskpart',
  'bcdedit /set {bootmgr} displaybootmenu no',
  'bootrec /fixmbr',
  'dd if=/dev/zero of=/dev/sda',
  'dd of=/dev/nvme0n1 if=./img.iso',
  'echo x > /dev/sda',
  'cat /dev/urandom > /dev/sdb',
  'shutdown /s /t 0',
  'shutdown -h now',
  'reboot',
  'sudo poweroff',
  'halt',
  'init 0',
  'Stop-Computer',
  'Restart-Computer -Force',
  ':(){ :|:& };:',
  'reg delete HKLM\\SOFTWARE\\test /f',
  'reg delete "HKEY_LOCAL_MACHINE\\SOFTWARE\\x"',
  'reg delete HKCR\\* /f',
  'chmod -R 777 /',
  'chmod -R 755 /etc',
  'chown -R user:user /',
  'Remove-Item C:\\ -Recurse -Force',
  'Remove-Item $env:SystemDrive -Recurse',
  'Remove-Item ~ -Recurse -Force',
  'shred /dev/sda',
  'wipefs -a /dev/sda',
]

for (const cmd of BLOCKED_OTHERS) {
  test(`拦截系统破坏: ${cmd}`, () => {
    const r = checkDangerousCommand(cmd)
    assert.equal(r.blocked, true, `应拦截: ${cmd}`)
    assert.ok(r.reason, '应给出中文原因')
  })
}

// ========== 必须放行:项目内正常操作(误伤=智能体残废) ==========

const ALLOWED = [
  'rm -rf node_modules',
  'rm -rf ./dist build',
  'rm -rf /tmp/my-scratch',
  'rm -rf /usr/local/bin/my-tool',
  'rm file.txt',
  'rm -f package-lock.json',
  'git clean -fdx',
  'git push --force-with-lease',
  'git reset --hard origin/main',
  'del /s /q build\\*.tmp',
  'rd /s /q dist',
  'rmdir /s /q coverage',
  'npm run shutdown',
  'echo shutdown now please',
  'npm run format',
  'prettier --write .',
  'Remove-Item ./dist -Recurse -Force',
  'Remove-Item .\\node_modules -Recurse -Force',
  'reg delete HKCU\\Software\\myapp /f',
  'chmod -R 755 ./src',
  'chown -R user:user ./project',
  'npm test',
  'dir C:\\',
  'type C:\\Windows\\system.ini',
  'ping 127.0.0.1',
  'node -e "console.log(1)"',
  'g --ai',
  'git add . && git commit -m "test" && git push',
]

for (const cmd of ALLOWED) {
  test(`放行正常操作: ${cmd}`, () => {
    const r = checkDangerousCommand(cmd)
    assert.equal(r.blocked, false, `不应拦截: ${cmd}(原因: ${r.reason})`)
    assert.equal(r.reason, null)
  })
}

// ========== 边界输入 ==========

test('非字符串/空输入不拦截也不报错', () => {
  for (const bad of [null, undefined, 123, {}, [], '', '   ']) {
    const r = checkDangerousCommand(bad)
    assert.equal(r.blocked, false)
    assert.equal(r.reason, null)
  }
})
