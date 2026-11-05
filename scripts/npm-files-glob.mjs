// npm `files` 白名单的极简匹配：目录通配（`dir/**`）、精确文件、`*` / `**` glob。
//
// **唯一实现**，两处消费方共用：
//   - test/package-files.test.mjs 的「白名单推演」
//   - scripts/release.js 的「真实 npm pack 自检」
// 别各写一份：两套语义对不上时，会出现「测试绿、发布红」或者更糟的「两边都绿、
// 包里其实缺文件」。2026-11-05 给 files 加 `!` 取反规则时，release.js 那份没跟上，
// 直接把发布拦在了最后一步。

/** `**` / `*` 的 glob → 正则。双星号后跟斜杠时必须能匹配零层目录，
 *  否则「双星号斜杠 + *.test.js」这种写法匹配不到根级同后缀文件。 */
export function globToRegExp(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2 } else { out += '.*'; i += 1 }
      } else {
        out += '[^/]*'
      }
    } else if ('\\.+^${}()|[]'.includes(c)) {
      out += '\\' + c
    } else {
      out += c
    }
  }
  return new RegExp('^' + out + '$')
}

/**
 * 单条 files 规则是否命中某个仓库相对路径。
 * 注意：传进来的 `pattern` 应当是**去掉 `!` 之后**的正向模式（取反由调用方处理）。
 */
export function matchFilesPattern(pattern, relPath) {
  const e = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '')
  if (e.endsWith('/**')) {
    const prefix = e.slice(0, -3)
    return relPath === prefix || relPath.startsWith(prefix + '/')
  }
  if (e.includes('*')) return globToRegExp(e).test(relPath)
  return relPath === e
}

/** 把 files 数组拆成「正向白名单」与「取反规则」（npm 7+ 支持 `!` 前缀）。 */
export function splitFilesEntries(entries) {
  const list = Array.isArray(entries) ? entries : []
  return {
    includes: list.filter((e) => !e.startsWith('!')),
    excludes: list.filter((e) => e.startsWith('!')).map((e) => e.slice(1)),
  }
}
