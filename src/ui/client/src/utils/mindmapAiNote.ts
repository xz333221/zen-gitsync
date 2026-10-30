/**
 * 思维导图视图的 AI 上下文说明（右下角 g ai dock 用；导图页自己那套面板 2026-10-30 已摘掉）。
 *
 * 为什么不能只靠 openFilePath：导图落在用户自选目录里（常常在项目根之外），服务端那条
 * 注入遇到项目外路径会整段丢掉 —— 模型就完全不知道自己在一个导图界面里。
 *
 * 只交代"在导图视图、当前文件是哪个"，**不**诱导模型输出 ```mindmap 代码块：
 * 现在没有任何界面会消费那个块（原来只有导图页自己的对话面板会把块转成草稿）。
 */
export function buildMindmapAiNote(
  filePath: string | null | undefined,
  locale: string,
): string {
  const file = filePath || ''
  const en = String(locale || '').toLowerCase().startsWith('en')
  const head = en
    ? [
        'The user is in the mind map view.',
        file
          ? `The mind map currently open is \`${file}\` — a flow-mindmap document (nodes are {id,text,children}).`
          : 'No mind map file is open right now.',
      ]
    : [
        '用户此刻在「思维导图」视图里。',
        file
          ? `当前打开的导图文件是 \`${file}\`（flow-mindmap 的文档，节点形如 {id,text,children}）。`
          : '当前没有打开任何导图文件。',
      ]
  return head.join('\n')
}
