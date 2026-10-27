import { describe, expect, it } from "vitest";
import { accountCostForDate, accountCostsForDate, dashboardCurrency } from "./dashboardData";
import type { AccountInfo } from "./types";

function info(patch: Partial<AccountInfo> = {}): AccountInfo {
  return { extras: [], fetchedAt: "2026-10-27T12:00:00+08:00", ...patch };
}

describe("看板今日费用", () => {
  it("统一美元和人民币的常见符号与代码", () => {
    expect(dashboardCurrency("$")).toBe("USD");
    expect(dashboardCurrency("us$")).toBe("USD");
    expect(dashboardCurrency("¥")).toBe("CNY");
    expect(dashboardCurrency("rmb")).toBe("CNY");
    expect(dashboardCurrency(" credits ")).toBe("CREDITS");
  });

  it("只汇总指定日期，并按币种分别合并", () => {
    const result = accountCostsForDate(info({
      dailyUsage: [
        { date: "2026-10-27", cost: 1.2, costUnit: "USD" },
        { date: "2026-10-27", cost: 2.3, costUnit: "$" },
        { date: "2026-10-27", cost: 4.6, costUnit: "CNY" },
        { date: "2026-10-26", cost: 99, costUnit: "USD" },
        { date: "2026-10-27", cost: null, costUnit: "USD" },
      ],
    }), "2026-10-27");
    expect(result).toEqual({ USD: 3.5, CNY: 4.6 });
  });

  it("带时区时间戳与用量历史保留同一源日历日", () => {
    const result = accountCostsForDate(info({
      balance: { amount: 8, currency: "USD" },
      dailyUsage: [{ date: "2026-10-27T16:30:00Z", cost: 1.5, costUnit: "USD" }],
    }), "2026-10-27");
    expect(result).toEqual({ USD: 1.5 });
  });

  it("卡片优先展示主余额币种，不跨币种相加", () => {
    const result = accountCostForDate(info({
      balance: { amount: 8, currency: "CNY" },
      dailyUsage: [
        { date: "2026-10-27", cost: 2.87, costUnit: "USD" },
        { date: "2026-10-27", cost: 3.21, costUnit: "CNY" },
      ],
    }), "2026-10-27");
    expect(result).toEqual({ amount: 3.21, currency: "CNY" });
  });
});
