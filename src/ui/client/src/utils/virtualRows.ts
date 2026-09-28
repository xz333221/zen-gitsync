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
 * 虚拟滚动的纯计算部分（前缀和偏移表 + 二分定位）。
 * 与具体行模型无关：列表视图的行模型在 fileListRows.ts，树状视图在 fileTreeRows.ts，
 * 两边都用固定的行高常量喂进来。**行高必须是常量**，否则偏移会累加误差。
 */

/** offsets[i] = 第 i 行的 top，offsets[n] = 总高。调用方保证 heightOf 是纯函数且恒定 */
export function buildOffsets<T>(rows: readonly T[], heightOf: (row: T) => number): Float64Array {
  const offsets = new Float64Array(rows.length + 1)
  let acc = 0
  for (let i = 0; i < rows.length; i++) {
    offsets[i] = acc
    acc += heightOf(rows[i])
  }
  offsets[rows.length] = acc
  return offsets
}

/** 找到最大的 i 使 offsets[i] <= y（即 y 落在第 i 行内）；越界收敛到首/末行 */
export function findRowAtOffset(offsets: Float64Array, y: number): number {
  const last = offsets.length - 2 // 最后一行下标
  if (last < 0) return 0
  if (y <= 0) return 0
  if (y >= offsets[last]) return last

  let lo = 0
  let hi = last
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid] <= y) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}
