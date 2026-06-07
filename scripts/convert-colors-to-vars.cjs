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
 * 将项目中硬编码的颜色值转换为 CSS 变量
 * 
 * 根据 variables.scss 中定义的颜色变量进行映射
 * 
 * 使用方式：
 * node scripts/convert-colors-to-vars.cjs [--dry-run]
 * 
 * --dry-run: 预览模式，不实际修改文件
 */

const fs = require('fs');
const path = require('path');

// 获取命令行参数
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');

// 颜色映射表（基于 variables.scss）
const COLOR_MAP = {
  // 主色调
  '#409eff': 'var(--color-primary)',
  '#5a67d8': 'var(--color-primary-light)',
  '#337ecc': 'var(--color-primary-dark)',
  '#66b1ff': 'var(--color-primary-light)',
  '#a0cfff': 'var(--color-primary-light)',
  
  // 成功色
  '#67c23a': 'var(--color-success)',
  '#10b981': 'var(--color-success-light)',
  '#85ce61': 'var(--color-success)',
  '#b3e19d': 'var(--color-success)',
  
  // 警告色
  '#e6a23c': 'var(--color-warning)',
  '#f59e0b': 'var(--color-warning-light)',
  '#ebb563': 'var(--color-warning)',
  '#f3d19e': 'var(--color-warning)',
  
  // 危险色
  '#f56c6c': 'var(--color-danger)',
  '#ef4444': 'var(--color-danger-light)',
  '#dc2626': 'var(--color-danger-dark)',
  '#f78989': 'var(--color-danger)',
  
  // 信息色
  '#909399': 'var(--color-info)',
  '#8b5cf6': 'var(--color-info-light)',
  
  // 基础颜色
  '#ffffff': 'var(--color-white)',
  '#fff': 'var(--color-white)',
  '#000000': 'var(--color-black)',
  '#000': 'var(--color-black)',
  
  // 灰色系列
  '#f9fafb': 'var(--color-gray-50)',
  '#f3f4f6': 'var(--color-gray-100)',
  '#e5e7eb': 'var(--color-gray-200)',
  '#d1d5db': 'var(--color-gray-300)',
  '#9ca3af': 'var(--color-gray-400)',
  '#6b7280': 'var(--color-gray-500)',
  '#4b5563': 'var(--color-gray-600)',
  '#374151': 'var(--color-gray-700)',
  '#1f2937': 'var(--color-gray-800)',
  '#111827': 'var(--color-gray-900)',
  
  // 文字颜色
  '#303133': 'var(--text-primary)',
  '#606266': 'var(--text-secondary)',
  '#909399': 'var(--text-tertiary)',
  '#c0c4cc': 'var(--text-placeholder)',
  '#a8abb2': 'var(--text-placeholder)',
  
  // Git 状态颜色
  '#10b981': 'var(--git-status-added)',
  '#f59e0b': 'var(--git-status-modified)',
  '#ef4444': 'var(--git-status-deleted)',
  '#8b5cf6': 'var(--git-status-untracked)',
  '#f97316': 'var(--git-status-conflicted)',
  
  // 背景色（特殊）
  '#f5f5f5': 'var(--bg-page)',
  '#f8fafc': 'var(--bg-container-hover)',
  '#2d2d2d': 'var(--bg-code-dark)',
  '#f6f8fa': 'var(--bg-code)',
  
  // 其他常见颜色
  '#f8faff': '#f8faff', // 特殊渐变色，暂时保留
  '#eef4ff': '#eef4ff',
  '#fff2e6': '#fff2e6',
  '#f8f8f2': '#f8f8f2',
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
  skippedColors: new Set(),
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
 * 规范化颜色值（统一为小写）
 */
function normalizeColor(color) {
  return color.toLowerCase();
}

/**
 * 处理文件内容
 */
function processFileContent(content, filePath) {
  let modified = false;
  let newContent = content;
  
  // 匹配 6位 和 3位 十六进制颜色
  const colorRegex = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
  
  newContent = newContent.replace(colorRegex, (match) => {
    const normalizedColor = normalizeColor(match);
    
    // 如果是3位颜色，展开为6位
    let expandedColor = normalizedColor;
    if (normalizedColor.length === 4) {
      expandedColor = '#' + normalizedColor[1] + normalizedColor[1] +
                           normalizedColor[2] + normalizedColor[2] +
                           normalizedColor[3] + normalizedColor[3];
    }
    
    // 查找映射
    const mappedVar = COLOR_MAP[normalizedColor] || COLOR_MAP[expandedColor];
    
    if (mappedVar && mappedVar !== match) {
      // 记录替换
      stats.replacementDetails[match] = (stats.replacementDetails[match] || 0) + 1;
      stats.totalReplacements++;
      modified = true;
      return mappedVar;
    } else if (!mappedVar) {
      // 记录未映射的颜色
      stats.skippedColors.add(match);
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
  
  console.log('🚀 开始扫描并转换颜色值...\n');
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
      .forEach(([color, count]) => {
        const varName = COLOR_MAP[color.toLowerCase()];
        console.log(`  ${color} => ${varName}: ${count} 次`);
      });
  }
  
  if (stats.skippedColors.size > 0) {
    console.log('\n⚠️  未映射的颜色（需要手动检查）:');
    Array.from(stats.skippedColors)
      .sort()
      .forEach(color => {
        console.log(`  ${color}`);
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
