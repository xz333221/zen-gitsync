// 系统证书库补齐。
//
// 背景:Node 的 fetch/undici 默认只认 **内置的 Mozilla 根证书**
// (tls.getCACertificates('bundled')),不读 Windows 系统信任库。于是会出现:
//   浏览器 / curl 访问某站点一切正常,Node 却因为服务端只发叶证书、没发中间证书,
//   或中间证书只在本机系统库里,报 UNABLE_TO_VERIFY_LEAF_SIGNATURE。
// 这正是本项目远程 MCP(todo.flowdash.cn)连不上、而浏览器能打开的原因。
//
// 官方给的修法是启动前加 `--use-system-ca` / `NODE_EXTRA_CA_CERTS`,但那要用户改环境、
// 且对已经跑起来的进程无效。Node ≥ 24 提供 tls.getCACertificates / setDefaultCACertificates,
// 可以在运行时把「内置 + 系统」两份合并后写回默认信任库 —— 等价于 --use-system-ca,
// 但对整个进程(含 undici 的 global fetch)一次生效,且不碰用户环境。
import tls from 'node:tls';

let applied = false;

/**
 * 把操作系统信任库里的证书并入 Node 默认 CA(幂等,只做一次)。
 * 在不支持该 API 的 Node(< 24)上静默跳过,由调用方沿用原有的 env var 提示。
 *
 * @returns {{applied: boolean, added?: number, reason?: string}}
 */
export function enableSystemCAs() {
  if (applied) return { applied: true, added: 0 };
  applied = true;

  if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') {
    return { applied: false, reason: 'unsupported-node' };
  }

  try {
    // 'default' 是当前生效的默认集合(已含 --use-system-ca / NODE_EXTRA_CA_CERTS 的效果),
    // 'system' 单独取系统库;两者求并集去重后再写回,只会增加信任、不会移除内置根。
    const current = tls.getCACertificates('default');
    const system = tls.getCACertificates('system');
    const merged = [...new Set([...current, ...system])];
    if (merged.length !== current.length) tls.setDefaultCACertificates(merged);
    return { applied: true, added: merged.length - current.length };
  } catch (err) {
    return { applied: false, reason: err?.message || String(err) };
  }
}

/** 仅测试用:重置「已应用」标记。 */
export function __resetForTest() {
  applied = false;
}

export default { enableSystemCAs };
