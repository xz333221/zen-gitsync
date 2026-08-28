export const OFFICE_EXTS = new Set([
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
])

export function getFileExtension(filePath: string): string {
  return filePath.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() || ''
}

export function isOfficeFile(filePath: string): boolean {
  return OFFICE_EXTS.has(getFileExtension(filePath))
}

export function getOfficePreviewUrl(filePath: string, options: { source?: 'worktree' | 'git'; rev?: string; side?: 'old' | 'new' } = {}): string {
  const params = new URLSearchParams({
    source: options.source || 'worktree',
    file: filePath,
  })
  if (options.rev) params.set('rev', options.rev)
  if (options.side) params.set('side', options.side)
  return `/api/office/preview?${params.toString()}`
}

/** URL for raw Office bytes, consumed by vue-office in the browser. */
export function getOfficeRawUrl(filePath: string, options: { source?: 'worktree' | 'git'; rev?: string; side?: 'old' | 'new' } = {}): string {
  const params = new URLSearchParams({
    source: options.source || 'worktree',
    file: filePath,
  })
  if (options.rev) params.set('rev', options.rev)
  if (options.side) params.set('side', options.side)
  return `/api/office/raw?${params.toString()}`
}
