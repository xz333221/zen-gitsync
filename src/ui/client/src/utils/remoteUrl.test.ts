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
import { describe, test, expect } from 'vitest'

import { toRepoKey, toSshUrl } from './remoteUrl'

describe('toSshUrl', () => {
  test('两个平台的标准仓库页地址', () => {
    expect(toSshUrl('https://github.com/xz333221/zen-gitsync')).toBe(
      'git@github.com:xz333221/zen-gitsync.git'
    )
    expect(toSshUrl('https://gitee.com/xz_web/xiangyu-sites')).toBe(
      'git@gitee.com:xz_web/xiangyu-sites.git'
    )
  })

  test('已带 .git 或尾斜杠时不会拼出 .git.git', () => {
    expect(toSshUrl('https://github.com/a/b.git')).toBe('git@github.com:a/b.git')
    expect(toSshUrl('https://github.com/a/b/')).toBe('git@github.com:a/b.git')
    expect(toSshUrl('https://github.com/a/b.git/')).toBe('git@github.com:a/b.git')
    // 大小写不敏感:/A/B.GIT 也是 git 后缀
    expect(toSshUrl('https://github.com/A/B.GIT')).toBe('git@github.com:A/B.git')
  })

  test('http 也认(自建 GitLab 常见的 http 部署)', () => {
    expect(toSshUrl('http://git.example.com/team/proj')).toBe('git@git.example.com:team/proj.git')
  })

  test('多级命名空间原样保留,host 跟着地址走不写死', () => {
    expect(toSshUrl('https://gitee.com/a/b/c')).toBe('git@gitee.com:a/b/c.git')
    expect(toSshUrl('https://gitlab.com/group/sub/proj')).toBe('git@gitlab.com:group/sub/proj.git')
  })

  test('取不出路径、或不是 http(s) → 空串(调用方据此不渲染按钮)', () => {
    expect(toSshUrl('')).toBe('')
    expect(toSshUrl('not-a-url')).toBe('')
    expect(toSshUrl('https://github.com')).toBe('')
    expect(toSshUrl('https://github.com/')).toBe('')
    // 已经是 SSH 形式,不需要再转一次
    expect(toSshUrl('git@github.com:a/b.git')).toBe('')
    expect(toSshUrl('ftp://github.com/a/b')).toBe('')
  })
})

describe('toRepoKey', () => {
  test('HTTPS 与 SSH 两种写法归一成同一个键(本地 origin 多是 SSH)', () => {
    expect(toRepoKey('https://gitee.com/xz_web/xiangqi')).toBe('gitee.com/xz_web/xiangqi')
    expect(toRepoKey('git@gitee.com:xz_web/xiangqi.git')).toBe('gitee.com/xz_web/xiangqi')
    expect(toRepoKey('ssh://git@github.com/xz333221/zen-gitsync.git')).toBe(
      'github.com/xz333221/zen-gitsync'
    )
  })

  test('.git 后缀 / 尾斜杠 / 大小写都不影响结果', () => {
    expect(toRepoKey('https://github.com/XZ333221/Zen-GitSync.git')).toBe(
      'github.com/xz333221/zen-gitsync'
    )
    expect(toRepoKey('https://github.com/xz333221/zen-gitsync/')).toBe(
      'github.com/xz333221/zen-gitsync'
    )
    expect(toRepoKey('HTTP://GitHub.com/a/b')).toBe('github.com/a/b')
  })

  test('带子路径的仓库页地址仍指向同一个仓库', () => {
    expect(toRepoKey('https://gitee.com/xz_web/xiangqi/tree/main')).toBe('gitee.com/xz_web/xiangqi')
  })

  test('host 或 owner 不同不会被误判成同一个', () => {
    // 同一个 owner/name 在两个平台上是两个仓库,不能混淆成"已克隆"
    expect(toRepoKey('https://gitee.com/a/proj')).not.toBe(toRepoKey('https://github.com/a/proj'))
    expect(toRepoKey('https://gitee.com/a/proj')).not.toBe(toRepoKey('https://gitee.com/b/proj'))
  })

  test('不是仓库地址 / 取不出 owner+repo → 空串(调用方据此判定对不上)', () => {
    expect(toRepoKey('')).toBe('')
    expect(toRepoKey('not-a-url')).toBe('')
    expect(toRepoKey('https://gitee.com')).toBe('')
    expect(toRepoKey('https://gitee.com/onlyowner')).toBe('')
    // 本地路径不是仓库地址,不能被当成 scp-like 解析出 host=C
    expect(toRepoKey('C:/Users/xuze')).toBe('')
  })
})
