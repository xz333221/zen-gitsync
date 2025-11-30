/**
 * 将项目中的 padding、margin、gap 中的 px 值转换为标准的 CSS 变量
 * 
 * 标准间距映射：
 * 1px => 1px (保持原样，边框等特殊用途)
 * 2px => var(--spacing-xs)
 * 3px => 3px (保持原样，特殊值)
 * 4px => var(--spacing-sm)
 * 5px => 5px (保持原样，特殊值)
 * 6px => 6px (保持原样，常用于紧凑布局)
 * 8px => var(--spacing-base)
 * 10px => 10px (保持原样，特殊值)
 * 12px => var(--spacing-md)
 * 16px => var(--spacing-lg)
 * 18px => 18px (保持原样，字体相关)
 * 20px => var(--spacing-xl)
 * 24px => var(--spacing-2xl)
 * 32px => var(--spacing-3xl)
 * 40px => 40px (保持原样，大间距特殊值)
 * 
 * 使用方式：
 * node scripts/convert-spacing-to-vars.js [--strict]
 * 
 * --strict: 严格模式，只替换精确匹配的值（2px, 4px, 8px, 12px, 16px, 20px, 24px, 32px）
 * 默认模式：只替换标准间距值，保留特殊值（如 1px, 3px, 5px, 6px, 10px, 18px 等）
 */

const fs = require('fs');
const path = require('path');

// 获取命令行参数
const args = process.argv.slice(2);
const isStrictMode = args.includes('--strict');

// 间距映射表（精确匹配标准间距）
const SPACING_MAP = {
  '2px': 'var(--spacing-xs)',      // 2px
  '4px': 'var(--spacing-sm)',      // 4px
  '8px': 'var(--spacing-base)',    // 8px
  '12px': 'var(--spacing-md)',     // 12px
  '16px': 'var(--spacing-lg)',     // 16px
  '20px': 'var(--spacing-xl)',     // 20px
  '24px': 'var(--spacing-2xl)',    // 24px
  '32px': 'var(--spacing-3xl)',    // 32px
};

console.log(`\n运行模式: ${isStrictMode ? '严格模式（只替换标准间距）' : '默认模式（只替换标准间距）'}\n`);

// 需要处理的文件扩展名
const TARGET_EXTENSIONS = ['.vue', '.scss', '.css'];

// 需要处理的 CSS 属性
const TARGET_PROPERTIES = ['padding', 'margin', 'gap'];

// 统计信息
let stats = {
  totalFiles: 0,
  modifiedFiles: 0,
  totalReplacements: 0,
  replacementDetails: {},
};

/**
 * 递归扫描目录
 */
function scanDirectory(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  
  files.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      // 跳过 node_modules 和 .git 目录
      if (file !== 'node_modules' && file !== '.git' && file !== 'dist') {
        scanDirectory(filePath, fileList);
      }
    } else {
      const ext = path.extname(file);
      if (TARGET_EXTENSIONS.includes(ext)) {
        fileList.push(filePath);
      }
    }
  });
  
  return fileList;
}

/**
 * 替换单个 px 值为变量
 */
function replacePxValue(value) {
  if (SPACING_MAP[value]) {
    const varName = SPACING_MAP[value];
    // 记录替换详情
    stats.replacementDetails[value] = (stats.replacementDetails[value] || 0) + 1;
    stats.totalReplacements++;
    return varName;
  }
  return value;
}

/**
 * 处理文件内容
 */
function processFileContent(content) {
  let modified = false;
  let newContent = content;
  
  // 构建正则表达式，匹配 padding、margin、gap 属性
  // 支持的格式：
  // 1. padding: 12px;
  // 2. padding: 12px 16px;
  // 3. padding: 12px 16px 12px 16px;
  // 4. padding: 12px var(--spacing-md);
  TARGET_PROPERTIES.forEach(property => {
    // 匹配属性及其值（包括多个值的情况）
    const regex = new RegExp(
      `(${property}\\s*:\\s*)([^;{}]+)(;)`,
      'g'
    );
    
    newContent = newContent.replace(regex, (match, prefix, values, suffix) => {
      // 分割多个值
      const parts = values.trim().split(/\s+/);
      let hasChange = false;
      
      // 处理每个值
      const newParts = parts.map(part => {
        // 检查是否是 px 值
        if (/^\d+px$/.test(part)) {
          const replaced = replacePxValue(part);
          if (replaced !== part) {
            hasChange = true;
            return replaced;
          }
        }
        return part;
      });
      
      if (hasChange) {
        modified = true;
        return prefix + newParts.join(' ') + suffix;
      }
      
      return match;
    });
  });
  
  return { content: newContent, modified };
}

/**
 * 处理单个文件
 */
function processFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const { content: newContent, modified } = processFileContent(content);
    
    if (modified) {
      fs.writeFileSync(filePath, newContent, 'utf8');
      stats.modifiedFiles++;
      console.log(`✅ 已修改: ${filePath}`);
      return true;
    }
    
    return false;
  } catch (error) {
    console.error(`❌ 处理文件失败: ${filePath}`, error.message);
    return false;
  }
}

/**
 * 主函数
 */
function main() {
  const projectRoot = path.join(__dirname, '..');
  const srcDir = path.join(projectRoot, 'src');
  
  console.log('🚀 开始扫描项目文件...\n');
  console.log(`📁 项目根目录: ${projectRoot}`);
  console.log(`📁 扫描目录: ${srcDir}\n`);
  
  // 扫描所有目标文件
  const files = scanDirectory(srcDir);
  stats.totalFiles = files.length;
  
  console.log(`📊 找到 ${files.length} 个文件需要检查\n`);
  console.log('🔄 开始处理文件...\n');
  
  // 处理每个文件
  files.forEach(file => {
    processFile(file);
  });
  
  // 输出统计信息
  console.log('\n' + '='.repeat(60));
  console.log('📊 转换统计报告');
  console.log('='.repeat(60));
  console.log(`总文件数: ${stats.totalFiles}`);
  console.log(`修改文件数: ${stats.modifiedFiles}`);
  console.log(`总替换次数: ${stats.totalReplacements}`);
  console.log('\n📋 替换详情:');
  
  Object.entries(stats.replacementDetails)
    .sort((a, b) => b[1] - a[1])
    .forEach(([px, count]) => {
      console.log(`  ${px} => ${SPACING_MAP[px]}: ${count} 次`);
    });
  
  console.log('\n✨ 转换完成！');
}

// 运行主函数
if (require.main === module) {
  main();
}

module.exports = { processFileContent, replacePxValue };
