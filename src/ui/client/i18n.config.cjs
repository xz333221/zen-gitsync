const path = require('path')

// 从单独的文件加载敏感配置（不提交到 Git）
let baiduConfig = { appid: '', key: '' }
try {
  baiduConfig = require('./i18n.secret.cjs')
} catch (e) {
  console.warn('⚠️  未找到 i18n.secret.cjs 文件，请参考 i18n.secret.example.cjs 创建')
}

module.exports = {
  // 根目录，用于计算文件路径hash
  root: path.resolve(__dirname, 'src'),
  
  // 需要处理的源码目录
  src: path.resolve(__dirname, 'src'),
  
  // 国际化文件输出目录
  i18n: path.resolve(__dirname, 'src/lang'),
  
  // 输出目录，空表示覆盖原文件（建议先测试后再覆盖）
  output: '',
  
  // 需要处理的文件后缀
  ext: ['.vue', '.js', '.ts'],
  
  // 排除的目录
  exclude: [
    '/src/locales',      // 排除现有语言文件目录
    '/src/lang',         // 排除工具生成的语言文件目录
    '/src/assets',       // 排除资源文件
    '/src/styles',       // 排除样式文件
    '/src/types',        // 排除类型声明
    '/src/plugins',      // 排除插件配置
    '/src/utils/fileIcon.ts',  // 排除文件图标工具
    'node_modules'       // 排除依赖
  ],
  
  // 百度翻译配置（从 i18n.secret.cjs 加载）
  baidu: baiduConfig,
  
  // 语句标识
  statement: {
    // 翻译函数的引入语句
    imp: `import { $t } from '@/lang/static'`,
    // 忽略标记
    disabled: 'i18n-disabled'
  },
  
  // 并发翻译数量
  threads: 8
}
