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
import { prepareDiffForPrompt } from '/sessions/clever-upbeat-wright/mnt/zen-gitsync/src/ui/server/routes/config.js'

function makeFileDiff(p, added, removed) {
  const removedLines = removed.map(l => '-' + l).join('\n')
  const addedLines = added.map(l => '+' + l).join('\n')
  return `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n${removedLines}\n${addedLines}`
}

const diff = [
  makeFileDiff('src/components/Button.tsx', ['export const Button = () => {', '  return <button>click</button>', '}'], []),
  makeFileDiff('dist/bundle.js', Array.from({length: 3000}, (_, i) => 'var x' + i + '=1'), []),
  makeFileDiff('package-lock.json', ['# updated'], ['# old']),
  makeFileDiff('README.md', ['# My App', '', '## 新功能介绍'], []),
  makeFileDiff('src/server/api.ts', ['import express from "express"', 'export const app = express()', 'app.get("/health", (req, res) => res.send("ok"))'], [])
].join('\n')

const out = prepareDiffForPrompt(diff, [])
console.log('===== OUTPUT (length: ' + out.length + ') =====')
console.log(out)
