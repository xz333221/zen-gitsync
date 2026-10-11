import { test } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { enableSystemCAs, __resetForTest } from './systemCa.js';

const supported = typeof tls.getCACertificates === 'function'
  && typeof tls.setDefaultCACertificates === 'function';

// 注意:setDefaultCACertificates 会把证书重新规范化,PEM 字符串比对无效,
// 只能按证书指纹集合比较。
function fingerprints(certs) {
  return new Set(certs.map(pem => {
    try { return new X509Certificate(pem).fingerprint256 } catch { return `bad:${pem.slice(0, 40)}` }
  }));
}

test('enableSystemCAs: 不支持的 Node 上静默跳过,不抛异常', () => {
  __resetForTest();
  if (supported) return; // 本机支持就由下一条覆盖
  const r = enableSystemCAs();
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'unsupported-node');
});

test('enableSystemCAs: 把系统 CA 并入默认库,且不丢内置根;重复调用是空操作', () => {
  if (!supported) return;
  __resetForTest();

  const beforeFp = fingerprints(tls.getCACertificates('default'));
  const systemFp = fingerprints(tls.getCACertificates('system'));

  const first = enableSystemCAs();
  assert.equal(first.applied, true);

  const after = tls.getCACertificates('default');
  const afterFp = fingerprints(after);
  for (const fp of beforeFp) assert.ok(afterFp.has(fp), '内置根证书被弄丢了');
  for (const fp of systemFp) assert.ok(afterFp.has(fp), '系统 CA 未并入默认库');

  // 幂等:第二次不再改动,默认库内容保持一致
  const second = enableSystemCAs();
  assert.deepEqual(second, { applied: true, added: 0 });
  assert.deepEqual(fingerprints(tls.getCACertificates('default')), afterFp);
});
