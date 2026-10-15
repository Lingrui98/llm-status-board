// R15 分析模块单测。口径见 docs/round-15-plan.md §3；断言全部基于注入的 today（"YYYY-MM-DD"），
// 不依赖本机时区（AC-14）。

import { describe, expect, it } from "vitest";
import {
  ANOMALY_WINDOW_DAYS,
  MIN_EFFICIENCY_REQUESTS,
  PERIOD_DAYS,
  buildAnalysis,
  compareEfficiency,
  comparePeriods,
  dateRange,
  detectAnomalies,
  inRange,
  median,
  rankModelCosts,
  shiftDateKey,
} from "./analysis";
import type { UsagePoint, UsageRecord } from "./types";

const TODAY = "2026-06-15";

function rec(patch: Partial<UsageRecord> & { date: string; accountId?: string }): UsageRecord {
  return {
    accountId: patch.accountId ?? "a1",
    date: patch.date,
    cost: patch.cost ?? null,
    currency: patch.currency ?? "USD",
    requests: patch.requests ?? null,
    inputTokens: patch.inputTokens ?? null,
    outputTokens: patch.outputTokens ?? null,
    tokens: patch.tokens ?? null,
    usedTotal: patch.usedTotal ?? null,
    source: patch.source ?? "local",
    updatedAt: patch.updatedAt ?? "2026-06-15T10:00:00.000Z",
  };
}

describe("analysis：日期工具（时区无关）", () => {
  it("shiftDateKey 跨月/跨年正确", () => {
    expect(shiftDateKey("2026-06-15", -13)).toBe("2026-06-02");
    expect(shiftDateKey("2026-06-15", -6)).toBe("2026-06-09");
    expect(shiftDateKey("2026-06-15", -7)).toBe("2026-06-08");
    expect(shiftDateKey("2026-01-05", -10)).toBe("2025-12-26");
    expect(shiftDateKey("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDateKey("2024-03-01", -1)).toBe("2024-02-29"); // 闰年
    expect(shiftDateKey("非法", -1)).toBe("非法");
  });

  it("dateRange 含首尾，长度 = 天数", () => {
    expect(dateRange("2026-06-09", "2026-06-15")).toHaveLength(7);
    expect(dateRange("2026-06-09", "2026-06-15")[0]).toBe("2026-06-09");
    expect(dateRange("2026-06-09", "2026-06-15")[6]).toBe("2026-06-15");
    expect(dateRange("2026-06-15", "2026-06-09")).toEqual([]);
  });

  it("inRange 闭区间", () => {
    expect(inRange("2026-06-09", "2026-06-09", "2026-06-15")).toBe(true);
    expect(inRange("2026-06-15", "2026-06-09", "2026-06-15")).toBe(true);
    expect(inRange("2026-06-08", "2026-06-09", "2026-06-15")).toBe(false);
    expect(inRange("2026-06-16", "2026-06-09", "2026-06-15")).toBe(false);
  });
});

describe("analysis：§3.1 周期对比", () => {
  it("AC-10：USD 近 7 天 70、前 7 天 50 → delta +20、+40.0%、日均 10.00 vs 7.14", () => {
    const records = [
      rec({ date: "2026-06-10", cost: 30 }), // 本周窗口内
      rec({ date: "2026-06-14", cost: 40 }), // 本周窗口内
      rec({ date: "2026-06-03", cost: 20 }), // 上周窗口内
      rec({ date: "2026-06-07", cost: 30 }), // 上周窗口内（6-07 = today-8? 见下）
    ];
    const p = comparePeriods(records, TODAY);
    expect(p.thisFrom).toBe("2026-06-09");
    expect(p.thisTo).toBe("2026-06-15");
    expect(p.prevFrom).toBe("2026-06-02");
    expect(p.prevTo).toBe("2026-06-08");
    expect(p.byCurrency).toHaveLength(1);
    const usd = p.byCurrency[0];
    expect(usd.currency).toBe("USD");
    // 本窗口：06-10(30) + 06-14(40) = 70；对比窗口：06-03(20) + 06-07(30)=50
    expect(usd.costThis).toBe(70);
    expect(usd.costPrev).toBe(50);
    expect(usd.delta).toBe(20);
    expect(usd.deltaPct).toBeCloseTo(40, 10);
    expect(usd.dailyAvgThis).toBeCloseTo(10, 10); // 70/7 固定分母
    expect(usd.dailyAvgPrev).toBeCloseTo(50 / 7, 10);
    expect(Number(usd.dailyAvgPrev.toFixed(2))).toBe(7.14);
    expect(usd.label).toBeNull();
  });

  it("AC-10 降级：前 7 天 0 而本周 20 → deltaPct=null 且标签「新增」", () => {
    const p = comparePeriods([rec({ date: "2026-06-12", cost: 20 })], TODAY);
    const usd = p.byCurrency[0];
    expect(usd.costPrev).toBe(0);
    expect(usd.delta).toBe(20);
    expect(usd.deltaPct).toBeNull();
    expect(usd.label).toBe("新增");
  });

  it("降级：两周皆 0 → deltaPct=null、标签「—」", () => {
    const p = comparePeriods([rec({ date: "2026-06-12", cost: 0 })], TODAY);
    expect(p.byCurrency[0].costThis).toBe(0);
    expect(p.byCurrency[0].deltaPct).toBeNull();
    expect(p.byCurrency[0].label).toBe("—");
  });

  it("空数据 → 无币种行，请求合计为 0、标签「—」，不崩", () => {
    const p = comparePeriods([], TODAY);
    expect(p.byCurrency).toEqual([]);
    expect(p.requests.thisTotal).toBe(0);
    expect(p.requests.prevTotal).toBe(0);
    expect(p.requests.deltaPct).toBeNull();
    expect(p.requests.label).toBe("—");
  });

  it("跨币种不合并：USD 与 CNY 各自成行", () => {
    const records = [
      rec({ date: "2026-06-12", cost: 10, currency: "USD" }),
      rec({ date: "2026-06-12", cost: 100, currency: "CNY" }),
    ];
    const p = comparePeriods(records, TODAY);
    expect(p.byCurrency.map((c) => c.currency)).toEqual(["CNY", "USD"]);
    expect(p.byCurrency.find((c) => c.currency === "USD")?.costThis).toBe(10);
    expect(p.byCurrency.find((c) => c.currency === "CNY")?.costThis).toBe(100);
  });

  it("credits 不参与花费与请求口径（§1.6）", () => {
    const records = [
      rec({ date: "2026-06-12", cost: 10, currency: "USD", requests: 5 }),
      rec({ date: "2026-06-12", cost: 999, currency: "CREDITS", requests: 500 }),
    ];
    const p = comparePeriods(records, TODAY);
    expect(p.byCurrency.map((c) => c.currency)).toEqual(["USD"]);
    expect(p.byCurrency[0].costThis).toBe(10);
    expect(p.requests.thisTotal).toBe(5); // credits 请求数不计入
  });

  it("cost=null 的行按 0 计（不产生 NaN）", () => {
    const p = comparePeriods([rec({ date: "2026-06-12", cost: null })], TODAY);
    expect(p.byCurrency[0].costThis).toBe(0);
    expect(Number.isNaN(p.byCurrency[0].dailyAvgThis)).toBe(false);
  });

  it("窗口边界：today−6 与 today−13 含、today−7 属对比窗口", () => {
    const records = [
      rec({ date: "2026-06-09", cost: 1 }), // 本窗口第一天
      rec({ date: "2026-06-08", cost: 2 }), // 对比窗口最后一天
      rec({ date: "2026-06-02", cost: 4 }), // 对比窗口第一天
      rec({ date: "2026-06-01", cost: 8 }), // 窗口外
    ];
    const usd = comparePeriods(records, TODAY).byCurrency[0];
    expect(usd.costThis).toBe(1);
    expect(usd.costPrev).toBe(6); // 2 + 4
  });

  it("PERIOD_DAYS 常量与固定分母一致", () => {
    expect(PERIOD_DAYS).toBe(7);
  });
});

describe("analysis：§3.2 模型成本排行", () => {
  function usage(patch: Partial<UsagePoint> & { model: string }): UsagePoint {
    return { ...patch } as UsagePoint;
  }

  it("AC-11：同名模型跨 2 账号合并（5 + 7.5 = 12.5）> B(8)", () => {
    const map = new Map<string, UsagePoint[]>([
      ["a1", [usage({ model: "gpt-4o", cost: 5, costUnit: "USD", tokens: 100 }), usage({ model: "B", cost: 8, costUnit: "USD" })]],
      ["a2", [usage({ model: "GPT-4O", cost: 7.5, costUnit: "USD", tokens: 50 })]],
    ]);
    const r = rankModelCosts(map);
    expect(r.byCurrency).toHaveLength(1);
    const usd = r.byCurrency[0];
    expect(usd.currency).toBe("USD");
    expect(usd.entries.map((e) => e.model)).toEqual(["gpt-4o", "B"]); // 显示名取首次出现的原拼写
    expect(usd.entries[0].cost).toBeCloseTo(12.5, 10);
    expect(usd.entries[0].totalTokens).toBe(150);
    expect(usd.entries[1].cost).toBe(8);
  });

  it("AC-11：两个模型 costUnit 不同 → 分成两个榜，不合并", () => {
    const map = new Map<string, UsagePoint[]>([
      [
        "a1",
        [
          usage({ model: "M", cost: 5, costUnit: "USD" }),
          usage({ model: "M", cost: 7, costUnit: "CNY" }),
        ],
      ],
    ]);
    const r = rankModelCosts(map);
    expect(r.byCurrency.map((b) => b.currency)).toEqual(["CNY", "USD"]);
    expect(r.byCurrency.find((b) => b.currency === "USD")?.entries[0].cost).toBe(5);
    expect(r.byCurrency.find((b) => b.currency === "CNY")?.entries[0].cost).toBe(7);
  });

  it("排序：cost 降序 → totalTokens 降序 → 名称升序；取 Top 5", () => {
    const map = new Map<string, UsagePoint[]>([
      [
        "a1",
        [
          usage({ model: "same-cost-big", cost: 10, costUnit: "USD", tokens: 900 }),
          usage({ model: "same-cost-small", cost: 10, costUnit: "USD", tokens: 100 }),
          usage({ model: "alpha", cost: 20, costUnit: "USD" }),
          usage({ model: "b2", cost: 5, costUnit: "USD" }),
          usage({ model: "b3", cost: 4, costUnit: "USD" }),
          usage({ model: "b4", cost: 3, costUnit: "USD" }),
          usage({ model: "b5", cost: 2, costUnit: "USD" }),
        ],
      ],
    ]);
    const entries = rankModelCosts(map).byCurrency[0].entries;
    expect(entries).toHaveLength(5); // Top 5
    expect(entries[0].model).toBe("alpha"); // 20
    expect(entries[1].model).toBe("same-cost-big"); // 10，tokens 更多
    expect(entries[2].model).toBe("same-cost-small");
    expect(entries[3].model).toBe("b2");
    expect(entries[4].model).toBe("b3"); // 4 > 3 > 2
  });

  it("cost=null 的模型不进成本榜，另列「无成本数据」榜（按 tokens 降序）", () => {
    const map = new Map<string, UsagePoint[]>([
      [
        "a1",
        [
          usage({ model: "priced", cost: 1, costUnit: "USD" }),
          usage({ model: "unpriced", cost: null, tokens: 500, costUnit: "USD" }),
          usage({ model: "unpriced2", cost: null, inputTokens: 10, outputTokens: 5 }),
        ],
      ],
    ]);
    const r = rankModelCosts(map);
    expect(r.byCurrency[0].entries.map((e) => e.model)).toEqual(["priced"]);
    expect(r.noCost.map((e) => e.model)).toEqual(["unpriced", "unpriced2"]);
    expect(r.noCost[0].totalTokens).toBe(500);
    expect(r.noCost[1].totalTokens).toBe(15);
    expect(r.empty).toBe(false);
  });

  it("不得把 undefined 当 0 参与排序（cost 缺失只在 noCost 榜）", () => {
    const map = new Map<string, UsagePoint[]>([
      ["a1", [usage({ model: "缺失cost", cost: undefined, tokens: 10 })]],
    ]);
    const r = rankModelCosts(map);
    expect(r.byCurrency).toEqual([]);
    expect(r.noCost).toHaveLength(1);
  });

  it("空输入 / 空模型名 / 全空白 → empty", () => {
    expect(rankModelCosts(new Map()).empty).toBe(true);
    const map = new Map<string, UsagePoint[]>([["a1", [usage({ model: "   " }), usage({ model: "" })]]]);
    expect(rankModelCosts(map).empty).toBe(true);
  });

  it("同名不同大小写与空白归并到同一键，显示名保留首次拼写", () => {
    const map = new Map<string, UsagePoint[]>([
      ["a1", [usage({ model: " Claude-3 ", cost: 1, costUnit: "USD" })]],
      ["a2", [usage({ model: "claude-3", cost: 2, costUnit: "USD" })]],
    ]);
    const entries = rankModelCosts(map).byCurrency[0].entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].model).toBe("Claude-3");
    expect(entries[0].cost).toBe(3);
  });
});

describe("analysis：§3.3 账号效率对比", () => {
  it("AC-12：X 花费 30/请求 300 → 0.1；Y 花费 20/请求 100 → 0.2 → 最差为 Y", () => {
    const records = [
      rec({ accountId: "X", date: "2026-06-12", cost: 30, requests: 300, currency: "USD" }),
      rec({ accountId: "Y", date: "2026-06-12", cost: 20, requests: 100, currency: "USD" }),
    ];
    const r = compareEfficiency(records, TODAY);
    expect(r.byCurrency).toHaveLength(1);
    const usd = r.byCurrency[0];
    expect(usd.currency).toBe("USD");
    const x = usd.entries.find((e) => e.accountId === "X")!;
    const y = usd.entries.find((e) => e.accountId === "Y")!;
    expect(x.costPerRequest).toBeCloseTo(0.1, 10);
    expect(x.requestsPerUnit).toBeCloseTo(10, 10);
    expect(y.costPerRequest).toBeCloseTo(0.2, 10);
    expect(usd.worstAccountId).toBe("Y");
    expect(y.worst).toBe(true);
    expect(x.worst).toBe(false);
  });

  it("AC-12：请求 0 → costPerRequest=null 且不参与「最差」排名（仍在榜）", () => {
    const records = [
      rec({ accountId: "zero-req", date: "2026-06-12", cost: 50, requests: 0, currency: "USD" }),
      rec({ accountId: "ok", date: "2026-06-12", cost: 10, requests: 100, currency: "USD" }),
    ];
    const r = compareEfficiency(records, TODAY);
    const usd = r.byCurrency[0];
    const zero = usd.entries.find((e) => e.accountId === "zero-req")!;
    expect(zero.costPerRequest).toBeNull();
    expect(zero.worst).toBe(false);
    expect(usd.worstAccountId).toBe("ok");
    // null 置后排序
    expect(usd.entries[usd.entries.length - 1].accountId).toBe("zero-req");
  });

  it("请求数 < 10 的账号参与展示但不标「最差」（§3.3 下限）", () => {
    const records = [
      rec({ accountId: "tiny", date: "2026-06-12", cost: 100, requests: 5, currency: "USD" }),
      rec({ accountId: "normal", date: "2026-06-12", cost: 10, requests: 20, currency: "USD" }),
    ];
    const r = compareEfficiency(records, TODAY);
    const usd = r.byCurrency[0];
    expect(usd.worstAccountId).toBe("normal"); // tiny 的 20.0 虽然更大，但请求数 <10 不参评
    expect(usd.entries.find((e) => e.accountId === "tiny")!.worst).toBe(false);
    expect(MIN_EFFICIENCY_REQUESTS).toBe(10);
  });

  it("无合格账号（全都请求不足）→ worstAccountId=null，无人标红", () => {
    const records = [rec({ accountId: "a", date: "2026-06-12", cost: 10, requests: 3, currency: "USD" })];
    const r = compareEfficiency(records, TODAY);
    expect(r.byCurrency[0].worstAccountId).toBeNull();
    expect(r.byCurrency[0].entries[0].worst).toBe(false);
  });

  it("AC-12：USD 与 CNY 分列两榜，不比较", () => {
    const records = [
      rec({ accountId: "u", date: "2026-06-12", cost: 30, requests: 300, currency: "USD" }),
      rec({ accountId: "c", date: "2026-06-12", cost: 20, requests: 100, currency: "CNY" }),
    ];
    const r = compareEfficiency(records, TODAY);
    expect(r.byCurrency.map((b) => b.currency)).toEqual(["CNY", "USD"]);
    expect(r.byCurrency.find((b) => b.currency === "CNY")!.worstAccountId).toBe("c");
    expect(r.byCurrency.find((b) => b.currency === "USD")!.worstAccountId).toBe("u");
  });

  it("credits 单独成组且不与法币比较", () => {
    const records = [
      rec({ accountId: "kimi", date: "2026-06-12", cost: 100, requests: 10, currency: "CREDITS" }),
      rec({ accountId: "u", date: "2026-06-12", cost: 1, requests: 100, currency: "USD" }),
    ];
    const r = compareEfficiency(records, TODAY);
    expect(r.byCurrency.map((b) => b.currency)).toEqual(["CREDITS", "USD"]);
    expect(r.byCurrency.find((b) => b.currency === "CREDITS")!.worstAccountId).toBe("kimi");
  });

  it("花费 0 → requestsPerUnit=null（除零降级，不产生 Infinity）", () => {
    const records = [rec({ accountId: "free", date: "2026-06-12", cost: 0, requests: 50, currency: "USD" })];
    const e = compareEfficiency(records, TODAY).byCurrency[0].entries[0];
    expect(e.requestsPerUnit).toBeNull();
    expect(e.costPerRequest).toBe(0);
    expect(Number.isFinite(e.costPerRequest as number)).toBe(true);
  });

  it("窗口外记录不计入", () => {
    const records = [
      rec({ accountId: "a", date: "2026-05-01", cost: 999, requests: 999, currency: "USD" }),
      rec({ accountId: "a", date: "2026-06-12", cost: 10, requests: 20, currency: "USD" }),
    ];
    const e = compareEfficiency(records, TODAY).byCurrency[0].entries[0];
    expect(e.cost).toBe(10);
    expect(e.requests).toBe(20);
  });

  it("空数据 → empty=true", () => {
    expect(compareEfficiency([], TODAY).empty).toBe(true);
  });
});

describe("analysis：§3.4 异常日检测", () => {
  it("median：奇数取中位、偶数取中间两值平均、空数组 null", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
  });

  it("AC-13：近 14 天 13×10 + 1×40 → med=10、阈值 25 → 40 判为异常（倍数 4.0×）", () => {
    const records: UsageRecord[] = [];
    // 14 天窗口内 13 天 cost=10、1 天 cost=40
    for (let i = 0; i < 13; i++) records.push(rec({ date: shiftDateKey(TODAY, -i), cost: 10 }));
    records.push(rec({ date: shiftDateKey(TODAY, -13), cost: 40 }));

    const r = detectAnomalies(records, TODAY);
    expect(r.evaluated).toBe(1);
    expect(r.days).toHaveLength(1);
    const d = r.days[0];
    expect(d.cost).toBe(40);
    expect(d.median).toBe(10);
    expect(d.multiple).toBe(4);
    expect(d.currency).toBe("USD");
    expect(ANOMALY_WINDOW_DAYS).toBe(14);
  });

  it("AC-13：只有 3 天有记录 → 样本不足，不判定", () => {
    const records = [
      rec({ date: shiftDateKey(TODAY, 0), cost: 100 }),
      rec({ date: shiftDateKey(TODAY, -1), cost: 10 }),
      rec({ date: shiftDateKey(TODAY, -2), cost: 10 }),
    ];
    const r = detectAnomalies(records, TODAY);
    expect(r.days).toEqual([]);
    expect(r.insufficient).toBe(1);
    expect(r.evaluated).toBe(0);
  });

  it("5 天有记录（恰好达下限）且含异常 → 判定", () => {
    const records = [
      rec({ date: shiftDateKey(TODAY, 0), cost: 10 }),
      rec({ date: shiftDateKey(TODAY, -1), cost: 10 }),
      rec({ date: shiftDateKey(TODAY, -2), cost: 10 }),
      rec({ date: shiftDateKey(TODAY, -3), cost: 10 }),
      rec({ date: shiftDateKey(TODAY, -4), cost: 100 }),
    ];
    const r = detectAnomalies(records, TODAY);
    expect(r.evaluated).toBe(1);
    expect(r.days).toHaveLength(1);
    expect(r.days[0].cost).toBe(100);
  });

  it("中位数为 0（大量 0 值日）→ 不判定，避免把任何花费都当异常", () => {
    const records = [
      rec({ date: shiftDateKey(TODAY, 0), cost: 0 }),
      rec({ date: shiftDateKey(TODAY, -1), cost: 0 }),
      rec({ date: shiftDateKey(TODAY, -2), cost: 0 }),
      rec({ date: shiftDateKey(TODAY, -3), cost: 0 }),
      rec({ date: shiftDateKey(TODAY, -4), cost: 100 }),
    ];
    const r = detectAnomalies(records, TODAY);
    expect(r.days).toEqual([]);
    expect(r.insufficient).toBe(1);
  });

  it("输出按花费降序、最多 3 条", () => {
    const records: UsageRecord[] = [];
    for (let i = 0; i < 6; i++) records.push(rec({ date: shiftDateKey(TODAY, -i), cost: 10 }));
    records.push(rec({ date: shiftDateKey(TODAY, -7), cost: 100 }));
    records.push(rec({ date: shiftDateKey(TODAY, -8), cost: 90 }));
    records.push(rec({ date: shiftDateKey(TODAY, -9), cost: 80 }));
    records.push(rec({ date: shiftDateKey(TODAY, -10), cost: 70 }));
    const r = detectAnomalies(records, TODAY);
    expect(r.days).toHaveLength(3);
    expect(r.days.map((d) => d.cost)).toEqual([100, 90, 80]); // 降序 Top 3
  });

  it("(账号,币种) 分组独立判定：CNY 的异常不影响 USD，credits 被排除", () => {
    const records: UsageRecord[] = [];
    for (let i = 0; i < 5; i++) {
      records.push(rec({ accountId: "u", date: shiftDateKey(TODAY, -i), cost: 10, currency: "USD" }));
      records.push(rec({ accountId: "c", date: shiftDateKey(TODAY, -i), cost: 100, currency: "CREDITS" }));
    }
    records.push(rec({ accountId: "c", date: shiftDateKey(TODAY, -5), cost: 900, currency: "CREDITS" }));
    const r = detectAnomalies(records, TODAY);
    expect(r.days.every((d) => d.currency !== "CREDITS")).toBe(true);
    expect(r.evaluated).toBe(1); // 只有 USD 组参与
  });

  it("空数据 → 不崩，无判定", () => {
    const r = detectAnomalies([], TODAY);
    expect(r.days).toEqual([]);
    expect(r.evaluated).toBe(0);
  });
});

describe("analysis：汇总入口 buildAnalysis", () => {
  it("一次算出四个指标，hasUsageHistory 反映是否有记录", () => {
    const records = [
      rec({ date: "2026-06-12", cost: 10, requests: 20 }),
      rec({ date: "2026-06-05", cost: 5, requests: 10 }),
    ];
    const modelUsageByAccount = new Map<string, UsagePoint[]>([
      ["a1", [{ model: "m", cost: 3, costUnit: "USD" } as UsagePoint]],
    ]);
    const report = buildAnalysis({ records, modelUsageByAccount, today: TODAY });
    expect(report.today).toBe(TODAY);
    expect(report.period.byCurrency[0].costThis).toBe(10);
    expect(report.models.byCurrency[0].entries[0].model).toBe("m");
    expect(report.efficiency.byCurrency[0].entries[0].costPerRequest).toBeCloseTo(0.5, 10);
    expect(report.anomalies.days).toEqual([]);
    expect(report.hasUsageHistory).toBe(true);
  });

  it("空记录 → hasUsageHistory=false，各指标走空态且不崩", () => {
    const report = buildAnalysis({ records: [], today: TODAY });
    expect(report.hasUsageHistory).toBe(false);
    expect(report.period.byCurrency).toEqual([]);
    expect(report.models.empty).toBe(true);
    expect(report.efficiency.empty).toBe(true);
    expect(report.anomalies.days).toEqual([]);
  });

  it("AC-14：结果只由 today 字符串决定，与运行时时区无关（同一输入两次调用全等）", () => {
    const records = [
      rec({ date: "2026-06-12", cost: 10 }),
      rec({ date: "2026-06-05", cost: 5 }),
      rec({ date: "2026-06-14", cost: 0 }),
    ];
    const a = buildAnalysis({ records, today: TODAY });
    const b = buildAnalysis({ records, today: TODAY });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
