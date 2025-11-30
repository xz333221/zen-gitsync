/**
 * 将项目中的 border-radius 和 box-shadow 值转换为标准的 CSS 变量
 * 
 * 标准映射规则：
 * 
 * border-radius:
 * 2px => var(--radius-xs)
 * 3px => var(--radius-sm)
 * 4px => var(--radius-base)
 * 6px => var(--radius-md)
 * 8px => var(--radius-lg)
 * 12px => var(--radius-xl)
 * 
 * box-shadow:
 * 0 1px 3px rgba(0, 0, 0, 0.04) => var(--shadow-sm)
 * 0 1px 4px rgba(0, 0, 0, 0.04) => var(--shadow-base)
 * 0 2px 8px rgba(0, 0, 0, 0.08) => var(--shadow-md)
 * 0 4px 12px rgba(0, 0, 0, 0.08) => var(--shadow-lg)
 * 0 8px 24px rgba(0, 0, 0, 0.12) => var(--shadow-xl)
 * 
 * 使用方式：
 * node scripts/convert-to-standard-vars.js [--dry-run]
 * 
 * --dry-run: 仅预览更改，不实际修改文件
 */

const fs = require('fs');
const path = require('path');

// 获取命令行参数
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');

// border-radius 映射表
const RADIUS_MAP = {
  '2px': 'var(--radius-xs)',
  '3px': 'var(--radius-sm)',
  '4px': 'var(--radius-base)',
  '6px': 'var(--radius-md)',
  '8px': 'var(--radius-lg)',
  '12px': 'var(--radius-xl)',
};

// box-shadow 映射表（精确匹配）
const SHADOW_MAP = {
  // 基础阴影
  '0 1px 3px rgba(0, 0, 0, 0.04)': 'var(--shadow-sm)',
  '0 1px 4px rgba(0, 0, 0, 0.04)': 'var(--shadow-base)',
  '0 2px 8px rgba(0, 0, 0, 0.08)': 'var(--shadow-md)',
  '0 4px 12px rgba(0, 0, 0, 0.08)': 'var(--shadow-lg)',
  '0 8px 24px rgba(0, 0, 0, 0.12)': 'var(--shadow-xl)',
  
  // 常见变体（不同透明度）
  '0 2px 8px rgba(0, 0, 0, 0.1)': 'var(--shadow-md)',
  '0 4px 12px rgba(0, 0, 0, 0.1)': 'var(--shadow-lg)',
  '0 2px 6px rgba(0, 0, 0, 0.1)': 'var(--shadow-sm)',
  '0 2px 12px rgba(0, 0, 0, 0.08)': 'var(--shadow-md)',
  '0 4px 16px rgba(0, 0, 0, 0.12)': 'var(--shadow-lg)',
  
  // 交互阴影
  '0 4px 12px rgba(0, 0, 0, 0.08)': 'var(--shadow-hover)',
  '0 2px 6px rgba(0, 0, 0, 0.12)': 'var(--shadow-active)',
};

// 需要处理的文件扩展名
const TARGET_EXTENSIONS = ['.vue', '.scss', '.css'];

// 统计信息
let stats = {
  totalFiles: 0,
  modifiedFiles: 0,
  radiusReplacements: 0,
  shadowReplacements: 0,
  radiusDetails: {},
  shadowDetails: {},
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
 * 处理文件内容
 */
function processFileContent(content) {
  let modified = false;
  let newContent = content;
  
  // 1. 处理 border-radius
  const radiusRegex = /(border-radius\s*:\s*)(\d+px)(;)/g;
  newContent = newContent.replace(radiusRegex, (match, prefix, value, suffix) => {
    if (RADIUS_MAP[value]) {
      stats.radiusDetails[value] = (stats.radiusDetails[value] || 0) + 1;
      stats.radiusReplacements++;
      modified = true;
      return prefix + RADIUS_MAP[value] + suffix;
    }
    return match;
  });
  
  // 2. 处理 box-shadow（精确匹配）
  Object.keys(SHADOW_MAP).forEach(shadowValue => {
    const escapedValue = shadowValue.replace(/[()]/g, '\\$&');
    const shadowRegex = new RegExp(`(box-shadow\\s*:\\s*)(${escapedValue})(;)`, 'g');
    
    if (newContent.match(shadowRegex)) {
      stats.shadowDetails[shadowValue] = (stats.shadowDetails[shadowValue] || 0) + 1;
      stats.shadowReplacements++;
      modified = true;
    }
    
    newContent = newContent.replace(shadowRegex, (match, prefix, value, suffix) => {
      return prefix + SHADOW_MAP[shadowValue] + suffix;
    });
  });
  
  // 3. 处理 box-shadow 的模糊匹配（针对未精确匹配的常见模式）
  const generalShadowRegex = /(box-shadow\s*:\s*)(0\s+\d+px\s+\d+px\s+rgba\([^)]+\))(;)/g;
  newContent = newContent.replace(generalShadowRegex, (match, prefix, value, suffix) => {
    // 如果已经被精确匹配处理过，跳过
    if (SHADOW_MAP[value]) {
      return match;
    }
    
    // 根据模糊程度和偏移量选择合适的阴影
    const normalized = value.replace(/\s+/g, ' ').trim();
    
    // 小阴影：offset <= 2px, blur <= 4px
    if (normalized.match(/0\s+[12]px\s+[234]px/)) {
      stats.shadowDetails[value] = (stats.shadowDetails[value] || 0) + 1;
      stats.shadowReplacements++;
      modified = true;
      return prefix + 'var(--shadow-sm)' + suffix;
    }
    
    // 中等阴影：offset 2-4px, blur 6-12px
    if (normalized.match(/0\s+[234]px\s+(6|8|10|12)px/)) {
      stats.shadowDetails[value] = (stats.shadowDetails[value] || 0) + 1;
      stats.shadowReplacements++;
      modified = true;
      return prefix + 'var(--shadow-md)' + suffix;
    }
    
    // 大阴影：offset 4-8px, blur 12-24px
    if (normalized.match(/0\s+[4-8]px\s+(12|16|20|24)px/)) {
      stats.shadowDetails[value] = (stats.shadowDetails[value] || 0) + 1;
      stats.shadowReplacements++;
      modified = true;
      return prefix + 'var(--shadow-lg)' + suffix;
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
    const { content: newContent, modified } = processFileContent(content);
    
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
  
  console.log('🚀 开始标准化 CSS 样式变量...\n');
  console.log(`📁 项目根目录: ${projectRoot}`);
  console.log(`📁 扫描目录: ${srcDir}`);
  console.log(`模式: ${isDryRun ? '预览模式（不会修改文件）' : '修改模式'}\n`);
  
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
  console.log(`border-radius 替换次数: ${stats.radiusReplacements}`);
  console.log(`box-shadow 替换次数: ${stats.shadowReplacements}`);
  
  if (Object.keys(stats.radiusDetails).length > 0) {
    console.log('\n📋 border-radius 替换详情:');
    Object.entries(stats.radiusDetails)
      .sort((a, b) => b[1] - a[1])
      .forEach(([px, count]) => {
        console.log(`  ${px} => ${RADIUS_MAP[px]}: ${count} 次`);
      });
  }
  
  if (Object.keys(stats.shadowDetails).length > 0) {
    console.log('\n📋 box-shadow 替换详情:');
    Object.entries(stats.shadowDetails)
      .sort((a, b) => b[1] - a[1])
      .forEach(([shadow, count]) => {
        const mapped = SHADOW_MAP[shadow] || '(模糊匹配)';
        console.log(`  ${shadow} => ${mapped}: ${count} 次`);
      });
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
