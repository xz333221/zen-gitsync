/**
 * ts-demo.test.ts
 * 说明：示例 TypeScript 测试文件（不依赖 Jest，可直接被 ts/ts-node 使用）。
 * 注意：本文件仅作为示例与占位，可按需替换为实际测试框架（如 Jest、Vitest 等）。
 */

// 基础类型与接口示例
interface AddOptions {
  a: number;
  b: number;
}

function add(opts?: AddOptions): number {
  // 使用可选链与空值合并，增强健壮性
  const a = opts?.a ?? 0;
  const b = opts?.b ?? 0;
  return a + b;
}

// 简单断言工具（避免引入额外依赖）
function assertEqual(actual: unknown, expected: unknown, message?: string) {
  if (actual !== expected) {
    const hint = message ? ` - ${message}` : "";
    throw new Error(`断言失败: actual=${String(actual)}, expected=${String(expected)}${hint}`);
  }
}

// AI start Copilot
// 说明：独立的大块测试执行方法
function runBasicTests() {
  const results: Array<{ name: string; ok: boolean; error?: Error }> = [];

  const cases: Array<{ name: string; run: () => void }> = [
    {
      name: "add 基础测试",
      run: () => {
        assertEqual(add({ a: 1, b: 2 }), 3, "1+2 应为 3");
      },
    },
    {
      name: "add 可选链与默认值",
      run: () => {
        assertEqual(add(), 0, "未传参数时应为 0");
        assertEqual(add({ a: 5 } as any), 5, "仅传 a 时应为 5");
        assertEqual(add({ b: 7 } as any), 7, "仅传 b 时应为 7");
      },
    },
    {
      name: "add 较大数值",
      run: () => {
        assertEqual(add({ a: 1000, b: 2345 }), 3345, "1000+2345 应为 3345");
      },
    },
  ];

  for (const c of cases) {
    try {
      c.run();
      results.push({ name: c.name, ok: true });
    } catch (err) {
      results.push({ name: c.name, ok: false, error: err instanceof Error ? err : new Error(String(err)) });
    }
  }

  // 简单输出
  const okCount = results.filter(r => r.ok).length;
  const failCount = results.length - okCount;
  console.log(`TS 基础测试完成: 通过 ${okCount} / ${results.length}, 失败 ${failCount}`);
  if (failCount > 0) {
    for (const r of results) {
      if (!r.ok) {
        console.error(`失败用例: ${r.name}\n原因: ${r.error?.message ?? "未知错误"}`);
      }
    }
  }

  return { okCount, failCount, results };
}
// AI end Copilot

// 当以 ts-node 或类似方式执行时，自动运行示例测试
if (typeof require !== "undefined" && require.main === module) {
  try {
    const summary = runBasicTests();
    // 输出概要，避免无提示
    console.log("测试概要:", JSON.stringify({ ok: summary.okCount, fail: summary.failCount }));
    // 失败时以非零码退出（在 node 环境有用）
    if (summary.failCount > 0 && typeof process !== "undefined") {
      process.exitCode = 1;
    }
  } catch (e) {
    console.error("运行测试时发生异常:", (e as Error)?.message ?? e);
    if (typeof process !== "undefined") {
      process.exitCode = 1;
    }
  }
}
