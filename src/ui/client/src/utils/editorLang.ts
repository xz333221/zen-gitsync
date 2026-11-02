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
/** 根据文件扩展名返回 Monaco 语言 ID */
export function getLanguageByExt(ext: string): string {
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    vue: 'html',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    json: 'json',
    jsonc: 'json',
    md: 'markdown',
    markdown: 'markdown',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'ini',
    xml: 'xml',
    svg: 'xml',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    fish: 'shell',
    ps1: 'powershell',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    rb: 'ruby',
    php: 'php',
    c: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    h: 'cpp',
    cs: 'csharp',
    sql: 'sql',
    graphql: 'graphql',
    gql: 'graphql',
    txt: 'plaintext',
    log: 'plaintext',
    ini: 'ini',
    env: 'ini',
    gitignore: 'ini',
    dockerfile: 'dockerfile',
  }
  return map[ext.toLowerCase()] ?? 'plaintext'
}

/**
 * 按完整文件路径取 Monaco 语言 ID。
 *
 * 这个函数存在的唯一理由：MonacoEditor / MonacoDiffViewer 曾各自手写一份
 * `detectLanguageFromPath`，能力比上面这张表少一半（缺 toml / svg / kt / rb /
 * php / c / sql / graphql / bash 等）—— 同一个文件在 EditorView 里有高亮、
 * 在 Monaco 预览里却退化成 plaintext。现在统一走这一份，别在组件里再抄。
 */
export function getLanguageFromPath(filePath: string): string {
  const m = (filePath || '').toLowerCase().match(/\.([a-z0-9]+)$/)
  return getLanguageByExt(m ? m[1] : '')
}
