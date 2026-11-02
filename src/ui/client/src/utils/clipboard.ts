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
/**
 * 复制纯文本到剪贴板，失败时降级到 textarea + execCommand。
 *
 * 为什么必须留兜底：局域网 IP 访问（`http://192.168.x.x:5544`）不是安全上下文，
 * 这时 `navigator.clipboard` 在部分浏览器里**存在但写入静默失败**，只有 execCommand
 * 那条老路能成。此前这段逻辑在 CopySessionButton / JobLogDetails / EditorView /
 * WorkbenchView 里各有一份，四份的条件判断还不太一样，收敛到这里只维护一处。
 *
 * 富文本复制（带选区、带样式）不走这里，见 EditorView 的 copyRichTextBySelection。
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* 权限拒绝 / 非安全上下文 → 走 textarea 兜底 */ }

  try {
    const ta = document.createElement('textarea')
    ta.value = text
    // 放到视口外并隐藏：不能只靠 left 负值，移动端会把它滚进视野
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    ta.style.left = '-9999px'
    ta.setAttribute('readonly', '')
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
