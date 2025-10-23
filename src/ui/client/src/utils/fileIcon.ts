import * as FileIcons from 'file-icons-js';

/**
 * 获取文件图标类名
 * 使用 file-icons-js 库
 * @param fileName 文件名
 * @returns 图标类名字符串
 */
export function getFileIconClass(fileName: string): string {
  if (!fileName) return '';
  
  try {
    // file-icons-js 使用 getClassWithColor 获取带颜色的图标
    const iconClass = (FileIcons as any).getClassWithColor(fileName);
    return iconClass || '';
  } catch (error) {
    console.warn('Failed to get file icon class:', error);
    return '';
  }
}

/**
 * 获取文件夹图标类名
 * @param folderName 文件夹名
 * @returns 图标类名字符串
 */
export function getFolderIconClass(folderName: string): string {
  if (!folderName) return '';
  
  try {
    // file-icons-js 使用 getClassWithColor 获取带颜色的文件夹图标
    const iconClass = (FileIcons as any).getClassWithColor(folderName);
    return iconClass || 'icon-file-directory';
  } catch (error) {
    console.warn('Failed to get folder icon class:', error);
    return 'icon-file-directory';
  }
}
