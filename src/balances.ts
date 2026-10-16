// 余额合计（按币种分开，**绝不跨币种相加**）。
// R18：从 Dashboard 内联实现提为共享纯函数，主窗口总览条与悬停浮层共用同一口径。

import type { Money, RefreshOutcome } from "./types";

export interface BalanceTotals {
  usd: number;
  cny: number;
}

/** 汇总一批刷新结果里的余额：USD、CNY 各一栏，其余币种不参与（与看板总览条一致） */
export function aggregateBalances(outcomes: Iterable<RefreshOutcome>): BalanceTotals {
  let usd = 0;
  let cny = 0;
  for (const o of outcomes) {
    const b: Money | null | undefined = o.info?.balance;
    if (!b) continue;
    if (b.currency === "USD") usd += b.amount;
    else if (b.currency === "CNY") cny += b.amount;
  }
  return { usd, cny };
}
