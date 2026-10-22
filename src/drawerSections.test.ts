// R19 抽屉维度级 hasData 判定测试（规格 §3 + AC-6）：四维度（+额度构成扩展）各自独立。

import { describe, expect, it } from "vitest";
import {
  balanceSnapshotCount,
  totalSnapshotCount,
  drawerDataFlags,
  hasBreakdownData,
  hasBalanceTrendData,
  hasDailyUsageData,
  hasModelUsageData,
  hasTokenSplitData,
} from "./drawerSections";
import type { AccountInfo, BalanceSnapshot } from "./types";

function info(patch: Partial<AccountInfo> = {}): AccountInfo {
  return { extras: [], fetchedAt: "2026-10-23T04:11:36Z", ...patch };
}

function snap(accountId: string, ts: string): BalanceSnapshot {
  return { accountId, ts, balance: 10, currency: "USD" };
}

describe("drawerSections：各维度 hasData", () => {
  it("daily：空数组/全 null → false；任一指标有值 → true", () => {
    expect(hasDailyUsageData(null)).toBe(false);
    expect(hasDailyUsageData([])).toBe(false);
    expect(hasDailyUsageData([{}, { requests: null, tokens: null, cost: null }])).toBe(false);
    expect(hasDailyUsageData([{ cost: 0 }])).toBe(true); // 0 也是有效值
    expect(hasDailyUsageData([{ requests: 1 }])).toBe(true);
    expect(hasDailyUsageData([{ tokens: 5 }])).toBe(true);
    expect(hasDailyUsageData([{ inputTokens: 5 }])).toBe(true);
    expect(hasDailyUsageData([{ outputTokens: 5 }])).toBe(true);
  });

  it("model：与 daily 同口径，但看 modelUsage", () => {
    expect(hasModelUsageData([])).toBe(false);
    expect(hasModelUsageData([{ model: "gpt", cost: null, tokens: null, requests: null }])).toBe(false);
    expect(hasModelUsageData([{ model: "gpt", cost: 1.5 }])).toBe(true);
  });

  it("token：只有 token 字段非 null 才算有数据（仅 requests 不算）", () => {
    expect(hasTokenSplitData([])).toBe(false);
    expect(hasTokenSplitData([{ model: "gpt", requests: 10 }])).toBe(false);
    expect(hasTokenSplitData([{ model: "gpt", cost: 3 }])).toBe(false);
    expect(hasTokenSplitData([{ model: "gpt", tokens: 100 }])).toBe(true);
    expect(hasTokenSplitData([{ model: "gpt", inputTokens: 10, outputTokens: 5 }])).toBe(true);
  });

  it("balance：该账号快照数 1 → false；2 → true；别的账号不计入", () => {
    expect(hasBalanceTrendData([], "a1")).toBe(false);
    expect(hasBalanceTrendData([snap("a1", "2026-10-01T00:00:00Z")], "a1")).toBe(false);
    expect(hasBalanceTrendData([snap("a1", "t1"), snap("a1", "t2")], "a1")).toBe(true);
    expect(hasBalanceTrendData([snap("a2", "t1"), snap("a2", "t2")], "a1")).toBe(false);
    expect(balanceSnapshotCount([snap("a1", "t1"), snap("a2", "t2")], "a1")).toBe(1);
  });

  it("breakdown（扩展）：无总额度也无窗口 → false；有构成或有效窗口 → true", () => {
    expect(hasBreakdownData(null)).toBe(false);
    expect(hasBreakdownData(info({ balance: { amount: 0, currency: "USD" } }))).toBe(false);
    expect(hasBreakdownData(info({ total: { amount: 100, currency: "USD" }, balance: { amount: 40, currency: "USD" } }))).toBe(true);
    expect(hasBreakdownData(info({ total: { amount: 100, currency: "USD" }, used: { amount: 60, currency: "USD" } }))).toBe(true);
    expect(hasBreakdownData(info({ quotaWindows: [{ window: "7d", usedPercent: 0 }] }))).toBe(true);
    // 窗口 usedPercent 无效 → 不能算有数据
    expect(hasBreakdownData(info({ quotaWindows: [{ window: "7d", usedPercent: null }] }))).toBe(false);
  });

  it("total：只统计本账号有效总额度，兼容缺失字段，零额度有效", () => {
    const snapshots: BalanceSnapshot[] = [
      snap("a1", "t1"),
      { ...snap("a1", "t2"), total: null },
      { ...snap("a1", "t3"), total: NaN },
      { ...snap("a1", "t4"), total: Infinity },
      { ...snap("a2", "t5"), total: 100 },
      { ...snap("a1", "t6"), total: 0 },
    ];
    expect(totalSnapshotCount(snapshots, "a1")).toBe(1);
    expect(drawerDataFlags(null, snapshots, "a1").total).toBe(false);
    snapshots.push({ ...snap("a1", "t7"), total: 200 });
    expect(totalSnapshotCount(snapshots, "a1")).toBe(2);
    expect(drawerDataFlags(null, snapshots, "a1").total).toBe(true);
  });

  it("drawerDataFlags：维度互相独立，不因某一维有数据而全部为真", () => {
    const flags = drawerDataFlags(
      info({ dailyUsage: [{ date: "2026-10-01", cost: 1 }], modelUsage: null }),
      [snap("a1", "t1")],
      "a1",
    );
    expect(flags.daily).toBe(true);
    expect(flags.model).toBe(false);
    expect(flags.token).toBe(false);
    expect(flags.balance).toBe(false);
    expect(flags.breakdown).toBe(false);

    const all = drawerDataFlags(
      info({
        dailyUsage: [{ date: "2026-10-01", cost: 1 }],
        modelUsage: [{ model: "gpt", tokens: 10 }],
        total: { amount: 100, currency: "USD" },
        balance: { amount: 90, currency: "USD" },
      }),
      [snap("a1", "t1"), snap("a1", "t2")],
      "a1",
    );
    expect(all).toEqual({ breakdown: true, daily: true, model: true, token: true, balance: true, total: false });
  });

  it("info 为 null 时不崩：四维全 false", () => {
    expect(drawerDataFlags(null, [], "a1")).toEqual({
      breakdown: false,
      daily: false,
      model: false,
      token: false,
      balance: false,
      total: false,
    });
  });
});
