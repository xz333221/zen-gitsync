/**
 * 文件树相关工具函数
 */

export interface FileItem {
  path: string;
  name?: string;
  type?: string;
  locked?: boolean;
  [key: string]: any;
}

export interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: TreeNode[];
  file?: FileItem;
  type?: string;
  locked?: boolean;
  expanded?: boolean; // 是否展开
}

/**
 * 将文件列表转换为树状结构
 * @param files 文件列表
 * @returns 树状结构根节点数组
 */
export function buildFileTree(files: FileItem[]): TreeNode[] {
  const root: TreeNode[] = [];
  const nodeMap = new Map<string, TreeNode>();

  // 对文件按路径排序，确保父目录在子文件之前处理
  const sortedFiles = [...files].sort((a, b) => a.path.localeCompare(b.path));

  sortedFiles.forEach(file => {
    const parts = file.path.split('/').filter(p => p);
    let currentPath = '';
    let currentLevel = root;

    parts.forEach((part, index) => {
      const isLastPart = index === parts.length - 1;
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      // 检查该节点是否已存在
      let node = nodeMap.get(currentPath);

      if (!node) {
        // 创建新节点
        node = {
          name: part,
          path: currentPath,
          isDirectory: !isLastPart,
          expanded: true, // 默认展开
        };

        if (isLastPart) {
          // 这是文件节点，保存文件信息
          node.file = file;
          node.type = file.type;
          node.locked = file.locked;
        } else {
          // 这是目录节点
          node.children = [];
        }

        nodeMap.set(currentPath, node);
        currentLevel.push(node);
      }

      // 移动到下一层
      if (!isLastPart && node.children) {
        currentLevel = node.children;
      }
    });
  });

  return root;
}

/**
 * 展开所有节点
 * @param nodes 树节点数组
 */
export function expandAllNodes(nodes: TreeNode[]): void {
  nodes.forEach(node => {
    node.expanded = true;
    if (node.children) {
      expandAllNodes(node.children);
    }
  });
}

/**
 * 折叠所有节点
 * @param nodes 树节点数组
 */
export function collapseAllNodes(nodes: TreeNode[]): void {
  nodes.forEach(node => {
    node.expanded = false;
    if (node.children) {
      collapseAllNodes(node.children);
    }
  });
}

/**
 * 获取树的所有文件节点（不包括目录）
 * @param nodes 树节点数组
 * @returns 文件节点数组
 */
export function getAllFileNodes(nodes: TreeNode[]): TreeNode[] {
  const files: TreeNode[] = [];
  
  const traverse = (nodes: TreeNode[]) => {
    nodes.forEach(node => {
      if (!node.isDirectory && node.file) {
        files.push(node);
      }
      if (node.children) {
        traverse(node.children);
      }
    });
  };
  
  traverse(nodes);
  return files;
}

/**
 * 在树中查找指定路径的节点
 * @param nodes 树节点数组
 * @param path 文件路径
 * @returns 找到的节点或undefined
 */
export function findNodeByPath(nodes: TreeNode[], path: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.path === path) {
      return node;
    }
    if (node.children) {
      const found = findNodeByPath(node.children, path);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * 切换节点的展开状态
 * @param node 要切换的节点
 */
export function toggleNodeExpanded(node: TreeNode): void {
  node.expanded = !node.expanded;
}

/**
 * 合并新旧树的展开状态
 * @param newTree 新构建的树
 * @param oldTree 旧的树（包含用户的展开状态）
 */
export function mergeTreeExpandState(newTree: TreeNode[], oldTree: TreeNode[]): void {
  const oldStateMap = new Map<string, boolean>();
  
  // 收集旧树的展开状态
  const collectState = (nodes: TreeNode[]) => {
    nodes.forEach(node => {
      if (node.isDirectory) {
        oldStateMap.set(node.path, node.expanded || false);
        if (node.children) {
          collectState(node.children);
        }
      }
    });
  };
  
  // 应用到新树
  const applyState = (nodes: TreeNode[]) => {
    nodes.forEach(node => {
      if (node.isDirectory) {
        const oldState = oldStateMap.get(node.path);
        if (oldState !== undefined) {
          node.expanded = oldState;
        }
        if (node.children) {
          applyState(node.children);
        }
      }
    });
  };
  
  collectState(oldTree);
  applyState(newTree);
}
