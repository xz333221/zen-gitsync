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
// MiniMax 系模型的 <think> 标签流式过滤器。
//
// 背景:MiniMax-M2/M3 等模型不走 reasoning_content 字段,而是把思考过程
// 以 <think>...</think> 标签**内联在 content 流**里推送,且标签本身会被
// SSE 分片切碎(如 '<thi' + 'nk>')。直接透传到终端会看到裸标签。
//
// 本模块提供一个增量状态机:feed() 接收任意分片的 content 字符串,
// 返回 [{content}|{thinking}] 段数组,调用方按类型分别渲染
// (content 正常显示,thinking 置灰)。标签本身被剥离,不进显示。
//
// 注意:这里只影响**终端显示**;写回对话历史的仍是模型原始 content
// (含标签),保证上下文对模型保真。

const OPEN = '<think>'
const CLOSE = '</think>'
// 保留尾部长度:开标签 7 字符 / 闭标签 8 字符,跨分片的半个标签不能提前吐出
const KEEP_OPEN = OPEN.length - 1    // 6
const KEEP_CLOSE = CLOSE.length - 1  // 7

/**
 * 创建一个增量 think 标签过滤器。
 * @returns {{ feed: (chunk: string) => Array<object>, flush: () => Array<object> }}
 */
export function createThinkFilter() {
  let mode = 'normal'   // 'normal' | 'think'
  let pending = ''

  function feed(chunk) {
    pending += String(chunk || '')
    const out = []
    while (pending.length > 0) {
      const tag = mode === 'normal' ? OPEN : CLOSE
      const keep = mode === 'normal' ? KEEP_OPEN : KEEP_CLOSE
      const i = pending.indexOf(tag)
      if (i === -1) {
        // 没找到完整标签:吐出除"可能是半拉标签"的尾部以外的内容
        const safe = pending.length - keep
        if (safe > 0) {
          out.push({ [mode === 'normal' ? 'content' : 'thinking']: pending.slice(0, safe) })
          pending = pending.slice(safe)
        }
        break
      }
      if (i > 0) {
        // 标签前有正文,先吐出
        out.push({ [mode === 'normal' ? 'content' : 'thinking']: pending.slice(0, i) })
        pending = pending.slice(i)
        continue
      }
      // 命中完整标签:切换模式,吃掉标签
      mode = mode === 'normal' ? 'think' : 'normal'
      pending = pending.slice(tag.length)
    }
    return out
  }

  // 流结束时冲刷剩余 buffer(含未闭合的 think 块,按当前模式吐出)
  function flush() {
    if (!pending) return []
    const seg = { [mode === 'normal' ? 'content' : 'thinking']: pending }
    pending = ''
    return [seg]
  }

  return { feed, flush }
}

export default { createThinkFilter }
