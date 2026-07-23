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
// g ai 智能体的危险命令守卫 — 这是智能体的**唯一硬性限制**。
//
// 设计原则(用户明确授权的权限模型):
//   - 工作目录内:所有操作直接放行
//   - 其他目录:同样可读写、可修改
//   - 唯一红线:不得执行"会把系统搞崩"的命令 —— 本模块负责拦截
//
// 拦截清单刻意保持克制,只覆盖不可逆的系统级破坏:
//   1. 递归删除根目录/系统目录/用户 home(rm -rf / · rd /s C:\ · Remove-Item C:\ -Recurse)
//   2. 格式化/抹盘(format · mkfs · diskpart · dd of=/dev/* · 重定向写块设备)
//   3. 关机/重启(shutdown · reboot · poweroff · halt · Stop-Computer)
//   4. fork bomb
//   5. 删除注册表主键(reg delete HKLM 等)
//   6. 引导配置破坏(bcdedit · bootrec)
//   7. 递归改根目录权限/属主(chmod -R / · chown -R /)
//
// 像 `rm -rf node_modules`、`git clean -fdx`、`del /s /q build` 这类项目内
// 破坏性操作**不拦截** —— 那是用户的正常工作流,模型自己会判断。
//
// 纯函数,不依赖 fs / child_process,便于单测。

// rm / del / rd 等命令的"危险目标"判定:
// 递归删除时,目标落在这个集合里才算系统级破坏
const ROOT_TARGETS_UNIX = new Set([
  '/', '/*', '~', '~/', '$HOME', '${HOME}',
  '/etc', '/usr', '/bin', '/sbin', '/boot', '/lib', '/lib64',
  '/var', '/opt', '/root', '/System', '/Library', '/Applications',
  '/windows', '/Windows', '/WINDOWS',
  '%SystemDrive%', '%systemroot%', '%SystemRoot%', '%windir%',
])

// 判断一个 token 是否是"盘符根"(C:\ C:/ C: \  /c  /c/  D:\ 等)
// Git Bash 下盘符挂载为 /c /d 形式,cmd/PowerShell 下是 C:\ 形式
function isDriveRootToken(token) {
  const t = token.replace(/["']/g, '')
  // C:\  C:/  C:\*  C:/  C:
  if (/^[a-zA-Z]:[\\/]?\*?(\.\*)?$/.test(t)) return true
  // Git Bash 挂载点: /c  /c/  /d  /d/ ...(仅单字母)
  if (/^\/[a-zA-Z]\/?\*?$/.test(t)) return true
  // 反斜杠根
  if (t === '\\' || t === '\\*') return true
  return false
}

// 判断 token 是否是 Unix 根/系统目录目标
function isRootTargetToken(token) {
  const t = token.replace(/["']/g, '')
  if (ROOT_TARGETS_UNIX.has(t)) return true
  // 带尾通配:/usr/* /etc/* 之类
  if (t.endsWith('/*') && ROOT_TARGETS_UNIX.has(t.slice(0, -2))) return true
  return false
}

// 从命令串中抽出所有 "命令段"(按 ; && || | 切分),返回小写化前的原文段
function splitCommandSegments(cmd) {
  return String(cmd).split(/&&|\|\||[;|]/).map(s => s.trim()).filter(Boolean)
}

// 解析命令段:返回小写命令名(跳过 sudo / doas 前缀) + 原始参数串
// 注意:args 必须用匹配到的原始串长度切片,不能用 indexOf(小写名) —
// 混合大小写命令(Remove-Item 等)会 indexOf 失败导致切片错位
function parseSegment(seg) {
  const m = seg.match(/^(?:sudo|doas)\s+(\S+)|^(\S+)/)
  const name = (m?.[1] || m?.[2] || '')
  const args = m ? seg.slice(m[0].length) : seg
  return { head: name.toLowerCase(), args }
}

// 段是否有递归/强制类 flag(-r -R -f -rf -fr --recursive /s 等)
function hasRecursiveFlag(args, style) {
  if (style === 'unix') {
    return /(^|\s)-[a-zA-Z]*(r|R)[a-zA-Z]*(?=\s|$)/.test(args) || /--recursive\b/.test(args)
  }
  // cmd 风格: /s
  return /(^|\s)\/s(?=\s|$)/i.test(args)
}

/**
 * 检查一条 shell 命令是否属于"会把系统搞崩"的红线操作。
 *
 * @param {unknown} cmd - 待检查的命令字符串
 * @returns {{ blocked: boolean, reason: string|null }}
 *   blocked=true 时 reason 给出中文原因(会回喂给模型,让它换方案)
 */
export function checkDangerousCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) {
    return { blocked: false, reason: null }
  }
  const text = cmd

  // ── 1. fork bomb(经典 :(){ :|:& };: 及变体)──
  if (/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:[^}]*&[^}]*\}/.test(text)) {
    return { blocked: true, reason: '检测到 fork bomb(:(){ :|:& };:),会耗尽系统进程资源' }
  }

  // ── 2. dd / 重定向直接写块设备 ──
  if (/\bdd\b[^;&|]*\bof=["']?\/dev\//i.test(text)) {
    return { blocked: true, reason: '检测到 dd 直接写块设备(of=/dev/*),会物理抹掉磁盘数据' }
  }
  if (/>\s*\/dev\/(sd|hd|nvme|mmcblk|disk)/i.test(text)) {
    return { blocked: true, reason: '检测到重定向写块设备(/dev/sd* 等),会物理抹掉磁盘数据' }
  }

  // ── 3. 注册表主键删除 ──
  if (/\breg\s+delete\s+"?(HKLM|HKCR|HKEY_LOCAL_MACHINE|HKEY_CLASSES_ROOT)\b/i.test(text)) {
    return { blocked: true, reason: '检测到删除注册表主键(HKLM/HKCR),会破坏系统配置' }
  }

  // ── 4. 逐段检查命令名级红线 ──
  for (const seg of splitCommandSegments(text)) {
    const { head, args } = parseSegment(seg)

    // 关机/重启/停机
    if (/^(shutdown|reboot|poweroff|halt|init|telinit|stop-computer|restart-computer)$/i.test(head)) {
      // init 只有 0/6 才是关机/重启
      if (/^(init|telinit)$/i.test(head) && !/\b[06]\b/.test(args)) continue
      return { blocked: true, reason: `检测到关机/重启命令(${head}),会中断整台机器` }
    }

    // 格式化/分区/引导破坏
    if (/^(format|format\.com|mkfs(\.\w+)?|diskpart|bcdedit|bootrec|wipefs|fdisk|parted)$/i.test(head)) {
      return { blocked: true, reason: `检测到磁盘格式化/分区/引导操作(${head}),会造成不可逆数据丢失` }
    }

    // rm 递归删除系统目标
    if (head === 'rm') {
      if (hasRecursiveFlag(args, 'unix')) {
        const tokens = args.split(/\s+/).filter(t => t && !t.startsWith('-'))
        for (const tok of tokens) {
          if (isDriveRootToken(tok) || isRootTargetToken(tok)) {
            return { blocked: true, reason: `检测到 rm 递归删除系统根目录/盘符根(${tok}),会摧毁整个文件系统` }
          }
        }
      }
      continue
    }

    // shred 直接抹设备
    if (head === 'shred' && /\/dev\//.test(args)) {
      return { blocked: true, reason: '检测到 shred 抹除块设备,会物理摧毁磁盘数据' }
    }

    // rd / rmdir /s 删盘符根或系统目录(cmd)
    if (/^(rd|rmdir)$/i.test(head)) {
      if (hasRecursiveFlag(args, 'cmd')) {
        const tokens = args.split(/\s+/).filter(t => t && !t.startsWith('/'))
        for (const tok of tokens) {
          const clean = tok.replace(/["']/g, '').replace(/\\\*$/, '').replace(/\\\.\*$/, '')
          if (isDriveRootToken(clean) || /^%system|^%win/i.test(clean) || /^[a-zA-Z]:[\\/]+(windows|program files)/i.test(clean)) {
            return { blocked: true, reason: `检测到 rd /s 删除盘符根/系统目录(${tok}),会摧毁整个磁盘内容` }
          }
        }
      }
      continue
    }

    // del /s 清盘符根(cmd)
    if (head === 'del' || head === 'erase') {
      if (hasRecursiveFlag(args, 'cmd')) {
        const tokens = args.split(/\s+/).filter(t => t && !t.startsWith('/'))
        for (const tok of tokens) {
          const clean = tok.replace(/["']/g, '')
          // C:\* C:\*.* C:\ C:/
          if (isDriveRootToken(clean) || /^[a-zA-Z]:[\\/]\*(\.\*)?$/.test(clean)) {
            return { blocked: true, reason: `检测到 del /s 清空盘符根(${tok}),会删除整个磁盘文件` }
          }
        }
      }
      continue
    }

    // chmod / chown 递归动根目录
    if (head === 'chmod' || head === 'chown' || head === 'chgrp') {
      if (hasRecursiveFlag(args, 'unix')) {
        const tokens = args.split(/\s+/).filter(t => t && !t.startsWith('-'))
        for (const tok of tokens) {
          if (isRootTargetToken(tok) || tok === '/') {
            return { blocked: true, reason: `检测到 ${head} -R 递归改根目录权限/属主(${tok}),会让系统无法正常运行` }
          }
        }
      }
      continue
    }

    // PowerShell Remove-Item -Recurse 删根
    if (head === 'remove-item' || head === 'ri') {
      if (/\-r(ecurse)?\b/i.test(args)) {
        if (/\$env:(SystemDrive|windir|SystemRoot)/i.test(args)
          || /(^|\s)["']?[a-zA-Z]:[\\/]\*?["']?(\s|$)/.test(args)
          || /(^|\s)["']?~["']?(\s|$)/.test(args)) {
          return { blocked: true, reason: '检测到 Remove-Item -Recurse 删除盘符根/系统目录/home,会摧毁大量数据' }
        }
      }
      continue
    }
  }

  return { blocked: false, reason: null }
}

export default { checkDangerousCommand }
