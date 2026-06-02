// 随机起点端口选择
// 默认：避免与系统保留 / 常见服务端口重叠，在较宽的"用户态"范围里随机挑一个起点
// 然后由 startServerOnAvailablePort 在该起点基础上顺序往上扫描 EADDRINUSE
// 覆盖：环境变量 PORT 强制使用固定端口（向后兼容 + 便于书签/调试）

const DEFAULT_MIN = 4000;
const DEFAULT_MAX = 6000; // 2000 端口的池子；配合 maxTries 100 实际能覆盖 (max - min) 区间

function pickRandomInt(min, max) {
  // 含 min，不含 max（与 Math.random 习惯一致）
  return Math.floor(Math.random() * (max - min)) + min;
}

/**
 * 解析本次启动应使用的起始端口
 * @param {object} [opts]
 * @param {number} [opts.min] 随机范围下界（默认 4000）
 * @param {number} [opts.max] 随机范围上界（默认 6000）
 * @returns {{ startPort: number, source: 'env'|'random', min: number, max: number }}
 */
export function resolveStartPort({ min = DEFAULT_MIN, max = DEFAULT_MAX } = {}) {
  // 1) 环境变量优先：用户显式指定 > 一切
  const envPort = Number(process.env.PORT);
  if (Number.isInteger(envPort) && envPort > 0 && envPort < 65536) {
    return { startPort: envPort, source: 'env', min, max };
  }

  // 2) 兜底：参数范围非法就回退到 [4000, 6000)
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 65535 || min >= max) {
    min = DEFAULT_MIN;
    max = DEFAULT_MAX;
  }

  // 3) 随机挑一个起点
  const startPort = pickRandomInt(min, max);
  return { startPort, source: 'random', min, max };
}
