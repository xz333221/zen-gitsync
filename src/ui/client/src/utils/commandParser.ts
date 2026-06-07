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
 * 从命令字符串中提取变量
 * 变量格式: {{variableName}}
 * @param command 命令字符串
 * @returns 变量名数组
 */
export function extractVariables(command: string): string[] {
  if (!command) return []
  
  const regex = /\{\{(\w+)\}\}/g
  const variables: string[] = []
  let match: RegExpExecArray | null
  
  while ((match = regex.exec(command)) !== null) {
    const varName = match[1]
    if (!variables.includes(varName)) {
      variables.push(varName)
    }
  }
  
  return variables
}

/**
 * 替换命令中的变量为实际值
 * @param command 命令字符串
 * @param values 变量值映射 { variableName: value }
 * @returns 替换后的命令
 */
export function replaceVariables(command: string, values: Record<string, string>): string {
  if (!command) return ''
  
  let result = command
  for (const [key, value] of Object.entries(values)) {
    const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g')
    result = result.replace(regex, value || '')
  }
  
  return result
}

/**
 * 验证命令中的所有变量是否都有值
 * @param command 命令字符串
 * @param values 变量值映射
 * @returns 是否所有变量都有值
 */
export function validateVariables(command: string, values: Record<string, string>): boolean {
  const variables = extractVariables(command)
  return variables.every(varName => values[varName] && values[varName].trim() !== '')
}
