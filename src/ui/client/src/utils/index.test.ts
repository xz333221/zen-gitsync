import { describe, it, expect } from 'vitest';
import { formatDiff, escapeHtml, formatCommitMessage, extractPureMessage } from '../src/utils/index.ts';

describe('Utils', () => {
  describe('escapeHtml', () => {
    it('should escape HTML characters', () => {
      expect(escapeHtml('<div>test & "quotes"</div>')).toBe('&lt;div&gt;test &amp; &quot;quotes&quot;&lt;/div&gt;');
    });
  });

  describe('formatDiff', () => {
    it('should format diff content with correct CSS classes', () => {
      const diffText = `diff --git a/test.js b/test.js
--- a/test.js
+++ b/test.js
@@ -1,3 +1,4 @@
 context line
-removed line
+added line
 another context`;

      const result = formatDiff(diffText);
      expect(result).toContain('class="diff-header"');
      expect(result).toContain('class="diff-old-file"');
      expect(result).toContain('class="diff-new-file"');
      expect(result).toContain('class="diff-hunk-header"');
      expect(result).toContain('class="diff-added"');
      expect(result).toContain('class="diff-removed"');
      expect(result).toContain('class="diff-context"');
    });

    it('should return empty string for empty input', () => {
      expect(formatDiff('')).toBe('');
    });
  });

  describe('formatCommitMessage', () => {
    it('should return formatted message', () => {
      expect(formatCommitMessage('  test message  ')).toBe('test message');
    });

    it('should return default message for empty input', () => {
      expect(formatCommitMessage('')).toBe('(无提交信息)');
    });
  });

  describe('extractPureMessage', () => {
    it('should extract pure message from conventional commit', () => {
      expect(extractPureMessage('feat(ui): add new button')).toBe('add new button');
      expect(extractPureMessage('fix: resolve bug in login')).toBe('resolve bug in login');
    });

    it('should return original message for non-conventional format', () => {
      expect(extractPureMessage('regular commit message')).toBe('regular commit message');
    });

    it('should return empty string for empty input', () => {
      expect(extractPureMessage('')).toBe('');
    });
  });
});