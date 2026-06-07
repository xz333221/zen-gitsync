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
// 运行中的 GUI 实例信息
// 与后端 src/ui/server/utils/instanceRegistry.js 的 InstanceInfo 形状保持一致

export interface InstanceInfo {
  pid: number
  port: number
  projectName: string
  projectPath: string
  startedAt: number
  lastHeartbeat: number
  hostname: string
}

export interface InstancesResponse {
  success: true
  instances: InstanceInfo[]
  currentInstanceId: number
}
