/**
 * 将项目中硬编码的 font-size 值转换为 CSS 变量
 * 
 * 根据 variables.scss 中定义的字体大小变量进行映射
 * 
 * 使用方式：
 * node scripts/convert-fontsize-to-vars.cjs [--dry-run]
 * 
 * --dry-run: 预览模式，不实际修改文件
 */

const fs = require('fs');
const path = require('path');

// 获取命令行参数
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');

// 字体大小映射表（基于 variables.scss）
const FONT_SIZE_MAP = {
  '10px': 'var(--font-size-xs)',
  '12px': 'var(--font-size-sm)',
  '13px': 'var(--font-size-sm)', // 13px 映射到 sm (12px)
  '14px': 'var(--font-size-base)',
  '15px': 'var(--font-size-base)', // 15px 映射到 base (14px)
  '16px': 'var(--font-size-md)',
  '18px': 'var(--font-size-lg)',
  '20px': 'var(--font-size-xl)',
  '22px': 'var(--font-size-2xl)',
  '24px': 'var(--font-size-3xl)',
  
  // rem 单位映射
  '0.625rem': 'var(--font-size-xs)',    // 10px
  '0.75rem': 'var(--font-size-sm)',     // 12px
  '0.875rem': 'var(--font-size-base)',  // 14px
  '1rem': 'var(--font-size-md)',        // 16px
  '1.125rem': 'var(--font-size-lg)',    // 18px
  '1.25rem': 'var(--font-size-xl)',     // 20px
  '1.375rem': 'var(--font-size-2xl)',   // 22px
  '1.5rem': 'var(--font-size-3xl)',     // 24px
};

// 需要处理的文件扩展名
const TARGET_EXTENSIONS = ['.vue', '.scss', '.css'];

// 需要跳过的文件
const SKIP_FILES = ['variables.scss', 'dark-theme.scss'];

// 统计信息
let stats = {
  totalFiles: 0,
  modifiedFiles: 0,
  totalReplacements: 0,
  replacementDetails: {},
  skippedSizes: new Set(),
};

console.log(`\n运行模式: ${isDryRun ? '预览模式（不会修改文件）' : '修改模式'}\n`);

/**
 * 递归扫描目录
 */
function scanDirectory(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  
  files.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      if (file !== 'node_modules' && file !== '.git' && file !== 'dist') {
        scanDirectory(filePath, fileList);
      }
    } else {
      const ext = path.extname(file);
      if (TARGET_EXTENSIONS.includes(ext) && !SKIP_FILES.includes(file)) {
        fileList.push(filePath);
      }
    }
  });
  
  return fileList;
}

/**
 * 处理文件内容
 */
function processFileContent(content, filePath) {
  let modified = false;
  let newContent = content;
  
  // 匹配 font-size 属性
  // 支持 px 和 rem 单位
  const fontSizeRegex = /(\bfont-size\s*:\s*)(\d+(?:\.\d+)?(?:px|rem))\b/g;
  
  newContent = newContent.replace(fontSizeRegex, (match, prefix, value) => {
    const mappedVar = FONT_SIZE_MAP[value];
    
    if (mappedVar && mappedVar !== value) {
      // 记录替换
      stats.replacementDetails[value] = (stats.replacementDetails[value] || 0) + 1;
      stats.totalReplacements++;
      modified = true;
      return prefix + mappedVar;
    } else if (!mappedVar) {
      // 记录未映射的字体大小
      stats.skippedSizes.add(value);
    }
    
    return match;
  });
  
  return { content: newContent, modified };
}

/**
 * 处理单个文件
 */
function processFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const { content: newContent, modified } = processFileContent(content, filePath);
    
    if (modified) {
      if (!isDryRun) {
        fs.writeFileSync(filePath, newContent, 'utf8');
      }
      stats.modifiedFiles++;
      console.log(`${isDryRun ? '📋 [预览]' : '✅'} ${filePath}`);
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
  
  console.log('🚀 开始扫描并转换 font-size 值...\n');
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
  
  if (Object.keys(stats.replacementDetails).length > 0) {
    console.log('\n📋 替换详情:');
    Object.entries(stats.replacementDetails)
      .sort((a, b) => b[1] - a[1])
      .forEach(([size, count]) => {
        const varName = FONT_SIZE_MAP[size];
        console.log(`  font-size: ${size} => ${varName}: ${count} 次`);
      });
  }
  
  if (stats.skippedSizes.size > 0) {
    console.log('\n⚠️  未映射的字体大小（需要手动检查）:');
    Array.from(stats.skippedSizes)
      .sort()
      .forEach(size => {
        console.log(`  ${size}`);
      });
    console.log('\n💡 建议：');
    console.log('   1. 检查这些值是否是特殊尺寸，需要保留');
    console.log('   2. 如果需要映射，可以将其添加到 FONT_SIZE_MAP 中');
    console.log('   3. 或考虑调整为最接近的标准尺寸');
  }
  
  if (isDryRun) {
    console.log('\n💡 提示: 这是预览模式，文件未被修改');
    console.log('   移除 --dry-run 参数以实际应用更改');
  } else {
    console.log('\n✨ 转换完成！');
  }
}

// 运行主函数
if (require.main === module) {
  main();
}

module.exports = { processFileContent };
