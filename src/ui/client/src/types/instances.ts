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
