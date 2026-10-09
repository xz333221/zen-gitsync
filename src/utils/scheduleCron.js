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
// 定时任务的 5 字段 cron 解析（分 时 日 月 周）。
//
// 为什么自写而不是引依赖：整个项目没有 cron 库，而这个场景只需要
// 「校验 + 算下一次/上一次触发时刻」三件事，逐日扫描的实现不到 200 行。
// 引一个依赖反而要跟它的边界语法（L/W/#、秒级字段、时区）对齐。
//
// 语义取标准 cron（Vixie cron）：
//   - 字段：`*` / `a` / `a-b` / `a-b/n` / `*/n` / `a,b,c`（逗号内任意组合）
//   - 日 vs 周：两者都受限时是 **OR**（满足其一即触发）；只有一边受限用那一边；
//     都 `*` 则每天。`*/n` 等以 `*` 开头的写法算「受限」，与主流实现一致。
//   - 周：0 或 7 都表示周日。
//   - 时间基准：**本地时区**（用户在 Windows 上看到的时间就是出发时间）。
//
// 纯函数、零 Node API —— 前端未来若要复用同一个模块也没有障碍（目前前端只用
// 服务端算好的 nextRunAt，不自己算）。

const FIELD_COUNT = 5;
/** 逐年扫描的上限：覆盖 2 月 29 日这种 4 年一遇的表达式 */
const MAX_SCAN_DAYS = 366 * 4 + 8;

const RANGES = [
  { name: '分', min: 0, max: 59 },
  { name: '时', min: 0, max: 23 },
  { name: '日', min: 1, max: 31 },
  { name: '月', min: 1, max: 12 },
  { name: '周', min: 0, max: 7 },
];

/**
 * 解析单个字段。
 * @returns {Set<number>} 命中的取值集合
 */
function parseField(spec, range) {
  const { name, min, max } = range;
  const values = new Set();
  const deny = (why) => {
    throw new Error(`cron ${name}字段无效: "${spec}" (${why})`);
  };
  if (typeof spec !== 'string' || spec === '') deny('字段为空');

  for (const part of spec.split(',')) {
    if (part === '') deny('逗号后为空');

    let rangePart = part;
    let step = 1;
    const slash = part.indexOf('/');
    if (slash >= 0) {
      rangePart = part.slice(0, slash);
      const stepRaw = part.slice(slash + 1);
      if (!/^\d+$/.test(stepRaw)) deny('步长必须是正整数');
      step = Number(stepRaw);
      if (step < 1 || step > max) deny('步长超出范围');
    }

    let lo;
    let hi;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (/^\d+$/.test(rangePart)) {
      lo = Number(rangePart);
      hi = slash >= 0 ? max : lo;
    } else if (/^\d+-\d+$/.test(rangePart)) {
      const [a, b] = rangePart.split('-').map(Number);
      lo = a;
      hi = b;
    } else {
      deny('只支持 * / 数字 / a-b / */n / a-b/n 与逗号组合');
    }

    if (lo < min || hi > max || lo > hi) deny(`超出 ${min}-${max} 范围`);

    for (let v = lo; v <= hi; v += step) values.add(v);
  }

  // 周字段：7 归一为 0（周日）
  if (name === '周') {
    if (values.has(7)) {
      values.delete(7);
      values.add(0);
    }
  }
  return values;
}

/**
 * 解析 cron 表达式为内部结构。
 * @param {string} expr
 * @returns {{ minutes:number[], hours:number[], dom:Set<number>, month:Set<number>, dow:Set<number>, domRestricted:boolean, dowRestricted:boolean }}
 * @throws {Error} 表达式非法时抛错（消息为中文，可直接展示给用户）
 */
export function parseCron(expr) {
  const raw = String(expr ?? '').trim();
  if (!raw) throw new Error('cron 表达式不能为空');
  const parts = raw.split(/\s+/);
  if (parts.length !== FIELD_COUNT) {
    throw new Error(`cron 表达式需要 5 个字段(分 时 日 月 周),当前 ${parts.length} 个`);
  }

  const minutes = [...parseField(parts[0], RANGES[0])].sort((a, b) => a - b);
  const hours = [...parseField(parts[1], RANGES[1])].sort((a, b) => a - b);
  const dom = parseField(parts[2], RANGES[2]);
  const month = parseField(parts[3], RANGES[3]);
  const dow = parseField(parts[4], RANGES[4]);

  return {
    minutes,
    hours,
    dom,
    month,
    dow,
    // "受限"判据：字段原文不是纯 `*`（`*/1` 等按主流实现也算受限）
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  };
}

/**
 * 校验表达式合法性。
 * @returns {{ ok:true } | { ok:false, error:string }}
 */
export function validateCron(expr) {
  try {
    parseCron(expr);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/** 日期是否满足「日/月/周」约束（不含时分）。 */
function dayMatches(parsed, day) {
  if (!parsed.month.has(day.getMonth() + 1)) return false;
  const domMatch = parsed.dom.has(day.getDate());
  const dowMatch = parsed.dow.has(day.getDay());
  if (parsed.domRestricted && parsed.dowRestricted) return domMatch || dowMatch;
  if (parsed.domRestricted) return domMatch;
  if (parsed.dowRestricted) return dowMatch;
  return true;
}

function asParsed(cron) {
  return typeof cron === 'string' ? parseCron(cron) : cron;
}

/** 本地时间的 y-m-d h:m 构造（避开夏令时歧义：中国无 DST，直接用本地构造器） */
function at(day, h, m) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
}

/**
 * 严格大于 `from` 的下一次触发时刻。
 *
 * 语义与 cron 惯例一致：`0 9 * * *` 在 09:00:30 时的 next 是**明天** 09:00
 *（当前分钟不算数），在 08:59:30 时是今天 09:00。
 *
 * @param {string|object} cron 表达式或 parseCron 的结果
 * @param {Date} [from] 缺省为现在
 * @returns {Date|null} 无解（理论不可达）返回 null
 */
export function nextFireAfter(cron, from = new Date()) {
  const parsed = asParsed(cron);
  // 从"下一分钟"开始：把当前分钟截掉，再 +60s
  const floorMs = Math.floor(from.getTime() / 60000) * 60000;
  const baseMs = floorMs + 60000;
  const start = new Date(baseMs);
  const dayStart = new Date(start.getFullYear(), start.getMonth(), start.getDate());

  for (let i = 0; i <= MAX_SCAN_DAYS; i++) {
    const day = new Date(dayStart.getTime() + i * 86400000);
    if (!dayMatches(parsed, day)) continue;
    for (const h of parsed.hours) {
      for (const m of parsed.minutes) {
        const t = at(day, h, m).getTime();
        if (t >= baseMs) return at(day, h, m);
      }
    }
  }
  return null;
}

/**
 * 小于等于 `to` 的最近一次触发时刻（调度器判定"该不该跑"用）。
 *
 * `0 9 * * *` 在 09:00:30 时的 prev 是**今天** 09:00（当前分钟算数），
 * 在 08:59:30 时是昨天 09:00。
 *
 * @param {string|object} cron
 * @param {Date} [to] 缺省为现在
 * @returns {Date|null}
 */
export function prevFireBefore(cron, to = new Date()) {
  const parsed = asParsed(cron);
  const baseMs = Math.floor(to.getTime() / 60000) * 60000;
  const base = new Date(baseMs);
  const dayStart = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const hoursDesc = [...parsed.hours].sort((a, b) => b - a);
  const minutesDesc = [...parsed.minutes].sort((a, b) => b - a);

  for (let i = 0; i <= MAX_SCAN_DAYS; i++) {
    const day = new Date(dayStart.getTime() - i * 86400000);
    if (!dayMatches(parsed, day)) continue;
    for (const h of hoursDesc) {
      for (const m of minutesDesc) {
        const t = at(day, h, m).getTime();
        if (t <= baseMs) return at(day, h, m);
      }
    }
  }
  return null;
}

/** 触发时刻 → 认领文件的键（分钟粒度，本地时间的 YYYYMMDDHHmm） */
export function fireKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}
