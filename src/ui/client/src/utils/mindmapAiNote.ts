/**
 * 思维导图视图的 AI 上下文说明（面板与右下角 dock 共用一份，别再各拼一份）。
 *
 * 为什么不能只靠 openFilePath：导图落在用户自选目录里（常常在项目根之外），服务端那条
 * 注入遇到项目外路径会整段丢掉 —— 模型就完全不知道自己在一个导图界面里。
 *
 * withConvention：
 *  - true  → 思维导图页自己的面板（EditorAgentPanel）会把 ```mindmap 块转成导图草稿、
 *            由用户一键「应用到当前导图 / 另存为新导图」，所以要交代输出约定；
 *  - false → 右下角 dock 只是普通对话，没有"应用草稿"的落点。只交代"在导图视图、
 *            当前文件是哪个"，**不**诱导模型输出没人接的代码块。
 *
 * 为什么让模型输出 ```mindmap 大纲、而不是让它直接写 JSON：导图的落盘格式是
 * {id,text,children} 的嵌套 JSON，id 还必须唯一；让模型手写这个既费 token 又容易写坏，
 * 而 markdown 大纲由前端的 markdownToMindMap 转（id 自动生成），坏不了结构。
 */
export function buildMindmapAiNote(
  filePath: string | null | undefined,
  locale: string,
  opts: { withConvention: boolean },
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
  if (!opts.withConvention) return head.join('\n')

  return head
    .concat(
      en
        ? [
            '',
            'To create or rewrite a mind map, output exactly one ```mindmap fenced block containing a markdown outline:',
            '- `#` = the central topic (exactly one line)',
            '- `##` = first-level branches, `###` = second-level, up to four levels',
            '- one node per line, no numbering, no explanation, no blank lines inside the block',
            '',
            'The panel converts that block into a mind map, and the user applies it with one click ("apply to current" / "save as new"). So:',
            '- do not emit JSON, and do not write the mind map file with write_file;',
            '- applying replaces the whole map: even for a one-branch change, emit the complete outline;',
            '- prose outside the block is fine — it is not part of the map.',
          ]
        : [
            '',
            '要新建或改写导图时，**输出且只输出一个 ```mindmap 代码块**，块内是 markdown 大纲：',
            '- `#` 写中心主题（只有一行）',
            '- `##` 一级分支、`###` 二级分支，最多四层',
            '- 一行一个节点，不写编号、不写解释、块内不留空行',
            '',
            '面板会把这个块转成导图，由用户一键「应用到当前导图」或「另存为新导图」，所以：',
            '- 不要输出 JSON，也不要用 write_file 直接改导图文件；',
            '- 应用是**整份替换**：哪怕只改一个分支，也要把完整大纲写进块里；',
            '- 块外可以正常说明你改了什么（那部分不进导图）。',
          ],
    )
    .join('\n')
}
