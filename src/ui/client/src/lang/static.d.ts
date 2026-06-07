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
/**
 * 静态翻译函数类型声明
 */

/**
 * 翻译函数
 * @param key - 翻译键名
 * @param params - 翻译参数
 * @returns 翻译后的文本
 */
export declare function $t(key: string, params?: Record<string, any>): string

/**
 * 检查翻译键是否存在
 * @param key - 翻译键名
 * @returns 是否存在该键
 */
export declare function $te(key: string): boolean


export default $t
