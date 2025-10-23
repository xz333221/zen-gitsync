export default {
  common: {
    confirm: '确认',
    cancel: '取消',
    save: '保存',
    delete: '删除',
    edit: '编辑',
    add: '添加',
    search: '搜索',
    refresh: '刷新',
    close: '关闭',
    back: '返回',
    submit: '提交',
    reset: '重置',
    loading: '加载中...',
    success: '成功',
    error: '错误',
    warning: '警告',
    info: '信息',
    yes: '是',
    no: '否',
  },

  app: {
    title: 'Zen GitSync',
    selectDirectory: '选择Git仓库目录',
    recentDirectories: '最近使用的仓库',
    noRecentDirectories: '暂无最近使用的仓库',
  },

  git: {
    status: 'Git状态',
    commit: '提交',
    push: '推送',
    pull: '拉取',
    stash: '暂存',
    branch: '分支',
    remote: '远程',
    history: '提交历史',
    diff: '差异',
    
    staged: '已暂存的更改',
    unstaged: '未暂存的更改',
    untracked: '未跟踪的文件',
    
    stagedCount: '已暂存 {count} 个文件',
    unstagedCount: '未暂存 {count} 个文件',
    untrackedCount: '未跟踪 {count} 个文件',
    
    noChanges: '没有更改',
    selectFileToView: '请选择文件查看差异',
    noDiffContent: '该文件没有差异内容',
    
    commitMessage: '提交信息',
    commitMessagePlaceholder: '请输入提交信息...',
    commitSuccess: '提交成功',
    commitFailed: '提交失败',
    
    stageFile: '暂存文件',
    unstageFile: '取消暂存',
    revertChanges: '撤回修改',
    
    lockFile: '锁定文件',
    unlockFile: '解锁文件',
    lockedFiles: '锁定的文件',
    
    openFile: '打开文件',
    openWithVSCode: '用VSCode打开',
    copyPath: '复制文件路径',
    pathCopied: '路径已复制到剪贴板',
  },

  commit: {
    author: '作者',
    date: '日期',
    message: '提交信息',
    hash: '哈希值',
    files: '文件',
    viewDetails: '查看详情',
  },

  settings: {
    title: '设置',
    language: '语言',
    theme: '主题',
    autoUpdate: '自动更新状态',
    autoUpdateDesc: '自动刷新Git状态',
  },

  errors: {
    networkError: '网络错误',
    serverError: '服务器错误',
    notFound: '未找到',
    unauthorized: '未授权',
    forbidden: '禁止访问',
    unknown: '未知错误',
  },
}
