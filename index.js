import config from './src/config.js'
import startUIServer from './src/ui/server/index.js'

// 导出配置
export { config as default }

// 导出启动服务器函数
export async function startServer(noOpen = false) {
  // 当通过 npm script 启动服务器时，应该保存端口信息
  return startUIServer(noOpen, true) // 传递 savePort=true
}
