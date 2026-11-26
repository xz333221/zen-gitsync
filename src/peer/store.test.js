import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ensureSelf,
  updateSelf,
  readState,
  writeState,
  findPeer,
  upsertPeer,
  removePeer,
  listPeers,
  getSessionId,
  setSessionId,
  clearSessionId,
  maskToken,
  tokenEquals,
  PEER_DEFAULT_PORT
} from './store.js';

async function tmpFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-peer-'));
  return path.join(dir, 'peers.json');
}

test('ensureSelf 首次生成 id 与令牌，二次调用不改动', async () => {
  const file = await tmpFile();
  const a = await ensureSelf(file);
  assert.match(a.self.id, /^node-[0-9a-f]{8}$/);
  assert.equal(a.self.token.length, 64);
  assert.equal(a.self.enabled, false);
  assert.equal(a.self.port, PEER_DEFAULT_PORT);

  const b = await ensureSelf(file);
  assert.equal(b.self.id, a.self.id);
  assert.equal(b.self.token, a.self.token);
});

test('updateSelf 只认白名单字段，脏端口被忽略', async () => {
  const file = await tmpFile();
  await ensureSelf(file);
  const next = await updateSelf({ name: '服务器', port: 6001, enabled: true, evil: 'x' }, file);
  assert.equal(next.self.name, '服务器');
  assert.equal(next.self.port, 6001);
  assert.equal(next.self.enabled, true);
  assert.equal(next.self.evil, undefined);

  const bad = await updateSelf({ port: 99999 }, file);
  assert.equal(bad.self.port, 6001, '非法端口应被忽略而不是写成 99999');
});

test('坏文件 / 缺文件都退回空状态，不抛异常', async () => {
  const file = await tmpFile();
  assert.deepEqual(await readState(file), { version: 1, self: null, peers: [], sessions: {} });

  await fs.writeFile(file, '{ 这不是 json', 'utf-8');
  assert.deepEqual(await readState(file), { version: 1, self: null, peers: [], sessions: {} });
});

test('upsertPeer 按 url 去重，findPeer 认 id / 昵称 / 地址', async () => {
  const file = await tmpFile();
  await ensureSelf(file);

  await upsertPeer({ name: '服务器', url: 'http://192.168.1.20:5599/', token: 't1' }, file);
  await upsertPeer({ name: '服务器改名', url: 'http://192.168.1.20:5599', token: 't2' }, file);

  const state = await readState(file);
  assert.equal(state.peers.length, 1, '同一地址不应登记两条');
  assert.equal(state.peers[0].token, 't2');
  assert.equal(state.peers[0].name, '服务器改名');

  assert.ok(await findPeer('服务器改名', file));
  assert.ok(await findPeer('http://192.168.1.20:5599', file));
  assert.equal(await findPeer('不存在', file), null);
});

test('removePeer 连带清掉该对端的会话 id（in: / out: / 老版裸 id 三种键）', async () => {
  const file = await tmpFile();
  await ensureSelf(file);
  await upsertPeer({ id: 'node-aaaa1111', name: 'A', url: 'http://10.0.0.2:5599', token: 'x' }, file);
  // 实际写入的三处：它来问我（in:）、我去问它（out:）、更早版本的裸 id。
  // 2026-11-26 之前 removePeer 只删裸 id，于是删掉再加回来照样续上旧会话。
  await setSessionId('in:node-aaaa1111', 'sess-in', file);
  await setSessionId('out:node-aaaa1111', 'sess-out', file);
  await setSessionId('node-aaaa1111', 'sess-legacy', file);

  const { removed } = await removePeer('A', file);
  assert.equal(removed, true);
  assert.equal(await getSessionId('in:node-aaaa1111', file), '');
  assert.equal(await getSessionId('out:node-aaaa1111', file), '');
  assert.equal(await getSessionId('node-aaaa1111', file), '');
  assert.deepEqual(await listPeers(file), []);
});

test('clearSessionId 只清指定键，空值不再被 setSessionId 静默吞掉', async () => {
  const file = await tmpFile();
  await ensureSelf(file);
  await upsertPeer({ id: 'node-bbbb2222', name: 'B', url: 'http://10.0.0.3:5599', token: 'x' }, file);
  await setSessionId('in:node-bbbb2222', 'sess-in', file);
  await setSessionId('out:node-bbbb2222', 'sess-out', file);

  await clearSessionId('in:node-bbbb2222', file);
  assert.equal(await getSessionId('in:node-bbbb2222', file), '', '被清的键必须真的没了');
  assert.equal(await getSessionId('out:node-bbbb2222', file), 'sess-out', '别的键不许连带清掉');
});

test('listPeers 不带令牌明文', async () => {
  const file = await tmpFile();
  await ensureSelf(file);
  await upsertPeer({ name: 'A', url: 'http://10.0.0.2:5599', token: 'secret-token' }, file);
  const peers = await listPeers(file);
  assert.equal(peers.length, 1);
  assert.equal(peers[0].token, undefined);
  assert.equal(peers[0].hasToken, true);
  assert.ok(!JSON.stringify(peers).includes('secret-token'));
});

test('maskToken 只留末四位', () => {
  assert.equal(maskToken(''), '(未设置)');
  assert.equal(maskToken('short'), '****');
  const masked = maskToken('0123456789abcdef');
  assert.ok(masked.endsWith('cdef'));
  assert.ok(!masked.includes('0123'));
});

test('tokenEquals 常量时间比较：长度不同也不抛', () => {
  assert.equal(tokenEquals('abc', 'abc'), true);
  assert.equal(tokenEquals('abc', 'abd'), false);
  assert.equal(tokenEquals('', 'abc'), false);
  assert.equal(tokenEquals('a'.repeat(200), 'a'), false);
});

test('writeState 会归一掉脏条目（缺 url 的对端被丢弃）', async () => {
  const file = await tmpFile();
  await writeState({
    version: 1,
    self: { id: 'node-11112222', name: 'X', port: -1, token: 'k' },
    peers: [{ name: '没有地址' }, { name: 'ok', url: 'http://h:1', token: 't' }],
    sessions: {}
  }, file);
  const state = await readState(file);
  assert.equal(state.peers.length, 1);
  assert.equal(state.self.port, PEER_DEFAULT_PORT, '非法端口回落到默认值');
});
