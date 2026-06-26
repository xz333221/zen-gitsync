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
// 长跑 CLI 任务的资源清理工具(SIGINT 时统一 drain 定时器 + 子进程)。
// 抽到独立模块是为了便于单元测试 + 跨多个 CLI 入口(gitCommit.js /
// future scheduled 命令面板)复用。
//
// 用法:
//   import { registerCleanup, trackChild, setupSigintHandler } from './cli/cleanup.js'
//   registerCleanup('mytimer', () => clearInterval(t))
//   const child = trackChild(exec('npm run build'))
//   setupSigintHandler()  // 只调一次,SIGINT 时按顺序 drain
//
// 设计原则:
//   - 单次注册:setupSigintHandler 内部用 sigintRegistered 守防止重复挂监听
//   - 幂等触发:多次 SIGINT 只生效第一次,避免 drain 中再次进入 cleanupTasks
//   - 优雅退出:子进程先 SIGTERM 给 500ms 窗口,SIGKILL 兜底
//   - 错误隔离:cleanup fn 抛错不影响后续 fn 与 killChildren

import process from 'node:process'

/**
 * @typedef {Object} CleanupRegistry
 * @property {() => Promise<void> | void} [fn] - cleanup 函数
 */

/** @type {Map<string, () => void | Promise<void>>} */
const cleanupTasks = new Map()

/** @type {Set<import('node:child_process').ChildProcess>} */
const activeChildren = new Set()

let sigintRegistered = false
let sigintFired = false

/**
 * 注册一个 cleanup 任务。同名注册会覆盖前一次(常用于"最近一次 setTimeout"
 * 这种语义:递归 commit 时,新 timer 替换旧 timer,旧 timer 自然过期)。
 *
 * @param {string} name - 任务唯一标识
 * @param {() => void | Promise<void>} fn - 清理函数,可异步
 */
export function registerCleanup(name, fn) {
  if (typeof name !== 'string' || !name) {
    throw new TypeError('registerCleanup: name 必须是非空字符串')
  }
  if (typeof fn !== 'function') {
    throw new TypeError('registerCleanup: fn 必须是函数')
  }
  cleanupTasks.set(name, fn)
}

/**
 * 注销一个已注册的 cleanup 任务。
 *
 * @param {string} name
 */
export function unregisterCleanup(name) {
  cleanupTasks.delete(name)
}

/**
 * 清空所有已注册任务(测试 / 重置场景用)。
 */
export function clearAllCleanup() {
  cleanupTasks.clear()
}

/**
 * 跟踪 child_process 子进程,SIGINT 时统一 kill。
 * 子进程 exit 时自动从集合移除,避免内存泄漏。
 *
 * @template {import('node:child_process').ChildProcess} T
 * @param {T} child
 * @returns {T} 原 child(便于链式调用)
 */
export function trackChild(child) {
  if (!child || typeof child.kill !== 'function') return child
  activeChildren.add(child)
  child.once('exit', () => activeChildren.delete(child))
  return child
}

/**
 * 杀掉所有跟踪中的子进程。先 SIGTERM 给 graceMs 优雅退出,再 SIGKILL 兜底。
 *
 * @param {number} [graceMs=500] - SIGTERM 后等多久升级到 SIGKILL
 */
export async function killAllTrackedChildren(graceMs = 500) {
  const children = [...activeChildren]
  if (children.length === 0) return { terminated: 0 }
  for (const child of children) {
    try { child.kill('SIGTERM') } catch (_) {}
  }
  await new Promise((r) => setTimeout(r, graceMs))
  for (const child of children) {
    try { child.kill('SIGKILL') } catch (_) {}
  }
  return { terminated: children.length }
}

/**
 * 同步执行所有注册任务(支持 async fn)。任何 fn 抛错都被吞掉,不影响后续。
 */
export async function runCleanupTasks() {
  const tasks = [...cleanupTasks.values()]
  cleanupTasks.clear()
  for (const fn of tasks) {
    try {
      await fn()
    } catch (_) {
      // 隔离错误 — 单个 cleanup 失败不能阻断其它资源释放
    }
  }
}

/**
 * 当前跟踪中的子进程数(测试 / 调试用)。
 */
export function getTrackedChildCount() {
  return activeChildren.size
}

/**
 * 全程序注册一次 SIGINT 处理器。
 * 顺序:logUpdate.clear → runCleanupTasks → killAllTrackedChildren → exit 130。
 * 多次调用安全(幂等 — sigintRegistered 守卫)。
 *
 * @param {object} [options]
 * @param {() => void} [options.onBeforeCleanup] - 清理前钩子(用于 logUpdate.clear 等)
 * @param {() => void} [options.onAfterCleanup] - 清理后钩子
 * @returns {() => void} dispose — 注销函数(测试场景用来清理)
 */
export function setupSigintHandler(options = {}) {
  if (sigintRegistered) return () => {}
  sigintRegistered = true
  const handler = async () => {
    if (sigintFired) return
    sigintFired = true
    try {
      try { options.onBeforeCleanup?.() } catch (_) {}
      await runCleanupTasks()
      await killAllTrackedChildren()
      try { options.onAfterCleanup?.() } catch (_) {}
    } finally {
      // 128 + SIGINT(2) = 130,符合 shell 惯例
      process.exit(130)
    }
  }
  process.on('SIGINT', handler)
  // 返回 dispose 用于测试清理 — removeListener + 重置标志
  return () => {
    process.removeListener('SIGINT', handler)
    sigintRegistered = false
    sigintFired = false
  }
}

/**
 * 重置内部状态 — 仅用于测试场景,生产代码不要调。
 * 注意:不主动移除 SIGINT listener(由调用方通过 setupSigintHandler 返回的 dispose 处理)。
 */
export function _resetForTests() {
  cleanupTasks.clear()
  activeChildren.clear()
  sigintRegistered = false
  sigintFired = false
}