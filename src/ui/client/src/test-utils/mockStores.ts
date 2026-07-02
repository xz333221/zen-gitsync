// 预制 mock store。每个 test 文件用 vi.mock 覆盖 import 解析,组件拿到的是这些对象。
// 字段值保持与真实 store 一致的形状;方法是 vi.fn() 默认返回 undefined(可被单测覆盖)。
import { vi } from 'vitest'

export const mockGitStore: any = {
  isGitRepo: true,
  isLoadingStatus: false,
  isLoadingLog: false,
  fileList: [],
  branch: 'main',
  selectedFiles: new Set<string>(),
  isSelectionMode: false,
  hasConflictedFiles: false,
  isCommiting: false,
  isPushing: false,
  isAddingFiles: false,
  hasUpstream: true,
  pendingMergeMessage: '',
  log: [],
  totalCommits: 0,
  currentPage: 1,
  hasMoreData: true,
  allBranches: [] as Array<{ name: string }>,
  fetchStatus: vi.fn().mockResolvedValue(undefined),
  stage: vi.fn().mockResolvedValue(undefined),
  unstage: vi.fn().mockResolvedValue(undefined),
  toggleSelectionMode: vi.fn(),
  toggleFileSelection: vi.fn(),
  clearSelection: vi.fn(),
  selectAllFiles: vi.fn(),
  refreshLog: vi.fn().mockResolvedValue(undefined),
}

export const mockConfigStore: any = {
  config: null,
  lockedFiles: [] as string[],
  ui: { fileListViewMode: 'tree' },
  defaultCommitMessage: '',
  autoSetDefaultMessage: false,
  autoQuickPushOnEnter: false,
  descriptionTemplates: [] as Array<{ value: string }>,
  scopeTemplates: [] as Array<{ value: string }>,
  loadConfig: vi.fn().mockResolvedValue(undefined),
  loadLockedFiles: vi.fn().mockResolvedValue(undefined),
  unlockFile: vi.fn().mockResolvedValue(undefined),
  generateCommitMessage: vi.fn(),
  saveDefaultMessage: vi.fn(),
}

export const mockLocaleStore: any = {
  locale: 'zh-CN',
  t: (k: string) => k,
}
