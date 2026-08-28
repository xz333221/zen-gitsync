import test from 'node:test'
import assert from 'node:assert/strict'
import { getOfficeExtension, isOfficeFile, OFFICE_PREVIEW_LIMITS } from './officePreview.js'

test('officePreview: recognizes supported Office formats', () => {
  assert.equal(isOfficeFile('docs/Report.DOCX'), true)
  assert.equal(isOfficeFile('sheet.xls'), true)
  assert.equal(isOfficeFile('slides.pptx'), true)
  assert.equal(isOfficeFile('slides.ppt'), true)
  assert.equal(isOfficeFile('src/index.ts'), false)
})

test('officePreview: extracts extension safely', () => {
  assert.equal(getOfficeExtension('C:\\docs\\plan.XLSX'), 'xlsx')
  assert.equal(getOfficeExtension('/tmp/no-extension'), '')
})

test('officePreview: exposes conservative conversion limits', () => {
  assert.equal(OFFICE_PREVIEW_LIMITS.maxInputBytes, 50 * 1024 * 1024)
  assert.equal(OFFICE_PREVIEW_LIMITS.timeoutMs, 30_000)
})
