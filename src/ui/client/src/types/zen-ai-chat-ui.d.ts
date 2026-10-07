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
import 'zen-ai-chat-ui'

/**
 * 给 zen-ai-chat-ui 的 `ChatMessage` 补两个思考计时字段。
 *
 * `reasoningStartedAt` / `reasoningEndedAt` 是 zen-ai-chat-ui **0.1.0-beta.16** 起
 * 的公开字段（思考段耗时，见其 README「思考过程」）：组件靠它们算出思考块标题右侧
 * 那个「思考中 3.2s」。本机 node_modules 里还是 beta.15，`.d.ts` 里没有这两项，
 * `useAgentChat` 的 `case 'thinking'` 就报 TS2551 / TS2339。
 *
 * **删掉这个文件的时机**：package.json 把 zen-ai-chat-ui 升到 `>= 0.1.0-beta.16`
 * 并 `npm i` 装好之后。真实类型那时自带这两个字段，本文件纯属多余 —— 留着不会报错，
 * 但会掩盖「版本没升上去」这件事（字段声明在、运行时组件却是旧版，计时永远不显示）。
 */
declare module 'zen-ai-chat-ui' {
  interface ChatMessage {
    /** 第一个思考分片到达的时间戳（毫秒） */
    reasoningStartedAt?: number
    /** 最近一个思考分片的时间戳（毫秒）；流停了它就是思考结束时刻 */
    reasoningEndedAt?: number
  }
}
