/** 全站唯一的事实来源:链接、命令、功能文案。 */

export const asset = (p) => `${import.meta.env.BASE_URL}${String(p).replace(/^\//, '')}`

export const REPO = {
  owner: 'xz333221',
  name: 'zen-gitsync',
  slug: 'xz333221/zen-gitsync',
  github: 'https://github.com/xz333221/zen-gitsync',
  npm: 'https://www.npmjs.com/package/zen-gitsync',
  issues: 'https://github.com/xz333221/zen-gitsync/issues'
}

export const COMMANDS = {
  install: 'npm i -g zen-gitsync',
  commit: 'g',
  gui: 'g ui',
  agent: 'g ai'
}

export const SHOTS = {
  commit: asset('shots/cli-quick-commit.png'),
  workbench: asset('shots/workbench-board.png'),
  agentCli: asset('shots/agent-cli.png'),
  agentGui: asset('shots/agent-gui.png'),
  gitView: asset('shots/git-commit-view.png'),
  fileSpace: asset('shots/file-space.png'),
  mindmap: asset('shots/mindmap.png')
}

export const EXECUTORS = ['Claude Code', 'Codex', 'OpenCode']
