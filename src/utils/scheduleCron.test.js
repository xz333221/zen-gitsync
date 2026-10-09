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
// cron 解析的单测。所有时刻都用**本地时区构造器**（与实现同口径），
// 不做 UTC 假设 —— 跑在哪个时区都不该红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, validateCron, nextFireAfter, prevFireBefore, fireKey } from './scheduleCron.js';

/** 本地时间构造的简写：d(2026, 1, 15, 9, 0) = 2026-01-15 09:00 本地 */
const d = (y, mo, day, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, day, h, mi, s);

test('parseCron:基础语法(* / 数字 / 区间 / 步长 / 逗号)', () => {
  const p = parseCron('*/15 9-18 1,15 * 1-5');
  assert.deepEqual(p.minutes, [0, 15, 30, 45]);
  assert.deepEqual(p.hours, [9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  assert.deepEqual([...p.dom].sort((a, b) => a - b), [1, 15]);
  assert.deepEqual([...p.month].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual([...p.dow].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.equal(p.domRestricted, true);
  assert.equal(p.dowRestricted, true);
});

test('parseCron:单值即精确匹配,步长区间 a-b/n 正确展开', () => {
  const p = parseCron('30 8 * * *');
  assert.deepEqual(p.minutes, [30]);
  assert.deepEqual(p.hours, [8]);
  assert.equal(p.domRestricted, false);
  assert.equal(p.dowRestricted, false);

  const q = parseCron('0 0-12/6 * * *');
  assert.deepEqual(q.hours, [0, 6, 12]);
});

test('parseCron:7 归一为周日(0)', () => {
  assert.deepEqual([...parseCron('0 9 * * 7').dow], [0]);
  assert.deepEqual([...parseCron('0 9 * * 0').dow], [0]);
  assert.deepEqual([...parseCron('0 9 * * 0,7').dow], [0]);
});

test('parseCron:坏表达式给出可展示的中文错误', () => {
  const bad = [
    ['', '不能为空'],
    ['0 9 * *', '5 个字段'],
    ['60 9 * * *', '范围'],
    ['0 24 * * *', '范围'],
    ['0 9 0 * *', '范围'],
    ['0 9 * 13 *', '范围'],
    ['0 9 * * 8', '范围'],
    ['*/0 9 * * *', '步长'],
    ['1-5-7 9 * * *', '只支持'],
    ['a 9 * * *', '只支持'],
    ['0,, 9 * * *', '逗号'],
  ];
  for (const [expr, needle] of bad) {
    const r = validateCron(expr);
    assert.equal(r.ok, false, `"${expr}" 应当校验失败`);
    assert.ok(r.error.includes(needle), `"${expr}" 的错误应包含 "${needle}"，实际: ${r.error}`);
  }
  assert.equal(validateCron('0 9 * * *').ok, true);
});

test('nextFireAfter:当前分钟不算数,严格取下一分钟之后', () => {
  // 09:00:30 时，0 9 * * * 的下一次是**明天** 09:00
  assert.equal(
    nextFireAfter('0 9 * * *', d(2026, 1, 15, 9, 0, 30)).getTime(),
    d(2026, 1, 16, 9, 0).getTime()
  );
  // 08:59:30 时是今天 09:00
  assert.equal(
    nextFireAfter('0 9 * * *', d(2026, 1, 15, 8, 59, 30)).getTime(),
    d(2026, 1, 15, 9, 0).getTime()
  );
});

test('nextFireAfter:同一天内多组时分的推进', () => {
  // 每 15 分钟
  assert.equal(nextFireAfter('*/15 * * * *', d(2026, 1, 15, 9, 7)).getTime(), d(2026, 1, 15, 9, 15).getTime());
  assert.equal(nextFireAfter('*/15 * * * *', d(2026, 1, 15, 9, 15)).getTime(), d(2026, 1, 15, 9, 30).getTime());
  // 末班车后跨到明天
  assert.equal(nextFireAfter('*/15 * * * *', d(2026, 1, 15, 23, 50)).getTime(), d(2026, 1, 16, 0, 0).getTime());
});

test('nextFireAfter:日与周的 OR 语义(标准 cron)', () => {
  // 每月 1 日 **或** 周一 的 08:00 —— 15 日是周三，下一次是 19 日(周一)
  assert.equal(
    nextFireAfter('0 8 1 * 1', d(2026, 1, 15, 12, 0)).getTime(),
    d(2026, 1, 19, 8, 0).getTime()
  );
  // 只有日受限：下个 1 日
  assert.equal(
    nextFireAfter('0 8 1 * *', d(2026, 1, 15, 12, 0)).getTime(),
    d(2026, 2, 1, 8, 0).getTime()
  );
  // 只有周受限：下一个周五（2026-01-16 是周五）
  assert.equal(
    nextFireAfter('0 8 * * 5', d(2026, 1, 15, 12, 0)).getTime(),
    d(2026, 1, 16, 8, 0).getTime()
  );
});

test('nextFireAfter:跨月与闰年边界', () => {
  // 月末 23:59 → 下月 1 日 0:00
  assert.equal(nextFireAfter('0 0 1 * *', d(2026, 1, 31, 23, 59)).getTime(), d(2026, 2, 1, 0, 0).getTime());
  // 2 月 29 日：2026 非闰年 → 2028 才是
  assert.equal(nextFireAfter('0 0 29 2 *', d(2026, 3, 1)).getTime(), d(2028, 2, 29, 0, 0).getTime());
});

test('prevFireBefore:当前分钟算数(≤ now),与 next 严格互补', () => {
  // 09:00:30 时，0 9 * * * 的 prev 是今天 09:00
  assert.equal(prevFireBefore('0 9 * * *', d(2026, 1, 15, 9, 0, 30)).getTime(), d(2026, 1, 15, 9, 0).getTime());
  // 08:59:30 时是昨天 09:00
  assert.equal(prevFireBefore('0 9 * * *', d(2026, 1, 15, 8, 59, 30)).getTime(), d(2026, 1, 14, 9, 0).getTime());
  // 精确落在触发分钟上：prev = 当前分钟，next = 明天
  assert.equal(prevFireBefore('0 9 * * *', d(2026, 1, 15, 9, 0)).getTime(), d(2026, 1, 15, 9, 0).getTime());
});

test('prevFireBefore:跨天/跨周回退', () => {
  // 00:05 的上一刻是当天 00:00（00:00 也是 */15 的触发点）
  assert.equal(prevFireBefore('*/15 * * * *', d(2026, 1, 15, 0, 5)).getTime(), d(2026, 1, 15, 0, 0).getTime());
  // 触发点落在 00:00 本身：prev 就是它（含当前分钟）
  assert.equal(prevFireBefore('*/15 * * * *', d(2026, 1, 15, 0, 0)).getTime(), d(2026, 1, 15, 0, 0).getTime());
  // 跨天回退：08:00 时，每天 09:00 的 prev 是昨天 09:00
  assert.equal(prevFireBefore('0 9 * * *', d(2026, 1, 15, 8, 0)).getTime(), d(2026, 1, 14, 9, 0).getTime());
  // 周一 08:00 或每月 1 日 —— 2026-01-15(周四) → 上一个周一是 01-12
  assert.equal(prevFireBefore('0 8 1 * 1', d(2026, 1, 15, 12, 0)).getTime(), d(2026, 1, 12, 8, 0).getTime());
});

test('prev 与 next 在任意时刻互补(不回退、不重叠)', () => {
  const expr = '*/10 8-20 * * 1-5';
  let cursor = d(2026, 1, 15, 7, 55);
  const prev = prevFireBefore(expr, cursor);
  assert.equal(prev.getTime(), d(2026, 1, 14, 20, 50).getTime());
  for (let i = 0; i < 50; i++) {
    const next = nextFireAfter(expr, cursor);
    assert.ok(next.getTime() > cursor.getTime(), 'next 必须严格大于 from');
    assert.ok(prevFireBefore(expr, next).getTime() === next.getTime(), 'next 的 prev 必须回到它自己');
    // 从 next 往后推一分钟：此刻的 prev 仍是 next（next 已进"过去"）
    cursor = new Date(next.getTime() + 60000);
    assert.equal(prevFireBefore(expr, cursor).getTime(), next.getTime());
  }
});

test('fireKey:分钟粒度的本地时间键', () => {
  assert.equal(fireKey(d(2026, 1, 5, 9, 7)), '202601050907');
  assert.equal(fireKey(d(2026, 12, 31, 23, 59)), '202612312359');
});
