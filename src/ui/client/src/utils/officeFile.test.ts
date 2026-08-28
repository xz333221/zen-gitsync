import { describe, expect, it } from 'vitest'
import { getFileExtension, getOfficePreviewUrl, getOfficeRawUrl, isOfficeFile } from './officeFile'

describe('officeFile helpers', () => {
  it('recognizes Office extensions case-insensitively', () => {
    expect(isOfficeFile('docs/Report.DOCX')).toBe(true)
    expect(isOfficeFile('sheet.xlsx')).toBe(true)
    expect(isOfficeFile('src/app.ts')).toBe(false)
  })

  it('extracts extensions from Windows and POSIX paths', () => {
    expect(getFileExtension('C:\\docs\\plan.PPTX')).toBe('pptx')
    expect(getFileExtension('/tmp/readme.md')).toBe('md')
  })

  it('builds encoded preview URLs for Git sides', () => {
    const url = getOfficePreviewUrl('docs/a b.docx', { source: 'git', rev: 'abcdef1', side: 'old' })
    expect(url).toContain('source=git')
    expect(url).toContain('file=docs%2Fa+b.docx')
    expect(url).toContain('rev=abcdef1')
    expect(url).toContain('side=old')
  })

  it('builds a raw binary URL for browser-side parsers', () => {
    expect(getOfficeRawUrl('sheet.xlsx')).toBe('/api/office/raw?source=worktree&file=sheet.xlsx')
  })
})
