import { describe, expect, it } from "vitest";
import { filterTrendSnapshots, historyBounds, localDateTimeInput, resolveTrendWindow, sampleTrendRows, trendTick, trendTicks } from "./trendHistory";
import type { BalanceSnapshot } from "./types";

const now = Date.parse("2026-10-22T12:00:00Z");
const hour = 3_600_000;
const snap = (ts: number): BalanceSnapshot => ({ ts: new Date(ts).toISOString(), accountId: "a1", balance: 10, currency: "USD" });

describe("趋势时间范围", () => {
  it("默认全部覆盖真实记录范围，忽略异常时间并容纳单个采样点", () => {
    const bounds = historyBounds([snap(now), snap(now - 72 * hour), { ...snap(now), ts: "invalid" }]);
    expect(bounds).toEqual([now - 72 * hour, now]);
    expect(resolveTrendWindow({ preset: "all", from: "", to: "" }, bounds, now)).toEqual({ from: now - 72 * hour, to: now });
    const single = resolveTrendWindow({ preset: "all", from: "", to: "" }, [now, now], now);
    expect(single.from).toBeLessThan(now);
    expect(single.to).toBeGreaterThan(now);
    expect(historyBounds([])).toBeNull();
  });

  it.each([["1h", 1], ["24h", 24], ["7d", 168], ["30d", 720]] as const)("%s 以当前时间为终点，不以旧记录冒充近期数据", (preset, hours) => {
    const window = resolveTrendWindow({ preset, from: "", to: "" }, [now - 900 * hour, now - 800 * hour], now);
    expect(window).toEqual({ from: now - hours * hour, to: now });
    expect(filterTrendSnapshots([snap(window.from - 1), snap(window.from), snap(window.to), snap(window.to + 1)], window).map((s) => s.ts))
      .toEqual([new Date(window.from).toISOString(), new Date(window.to).toISOString()]);
  });

  it("自定义按本地时间解析，拒绝缺失、倒置和零长度范围", () => {
    const from = new Date(2026, 9, 21, 8, 30, 10).getTime();
    const to = from + hour;
    const selection = { preset: "custom" as const, from: localDateTimeInput(from), to: localDateTimeInput(to) };
    expect(resolveTrendWindow(selection, null, now)).toEqual({ from, to });
    for (const invalid of [{ ...selection, from: "" }, { ...selection, from: selection.to }, { ...selection, from: localDateTimeInput(to + 1_000) }]) {
      const window = resolveTrendWindow(invalid, null, now);
      expect(window.error).toBeTruthy();
      expect(filterTrendSnapshots([snap(from)], window)).toEqual([]);
    }
  });

  it("同日刻度只显示时分，跨日显示日期", () => {
    const start = new Date(2026, 9, 22, 8, 30).getTime();
    expect(trendTick(start, { from: start, to: start + hour })).toBe("08:30");
    expect(trendTick(start, { from: start, to: start + 24 * hour })).toBe("10-22 08:30");
  });

  it("共用刻度只由时间范围决定，与每张图的数据点数量无关", () => {
    const window = { from: now - hour, to: now };
    const ticks = trendTicks(window);
    expect(ticks.length).toBeGreaterThanOrEqual(4);
    expect(ticks.every((ts) => ts >= window.from && ts <= window.to)).toBe(true);
    expect(new Set(ticks.slice(1).map((ts, i) => ts - ticks[i])).size).toBe(1);
    expect(trendTicks({ ...window, error: "invalid" })).toEqual([]);
    expect(trendTicks({ from: now - 45 * 24 * hour, to: now }).length).toBeGreaterThanOrEqual(3);
  });
});

describe("大量历史的绘图取点", () => {
  it("保留首末点、各序列尖峰与谷值，只减少绘制点且不修改原记录", () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => ({ i, balance: i === 4321 ? -100 : 10, total: i === 6789 ? 1000 : 100 }));
    const sampled = sampleTrendRows(rows, (r) => [r.balance, r.total], 600);
    expect(sampled.length).toBeLessThanOrEqual(600);
    expect(sampled[0]).toBe(rows[0]);
    expect(sampled[sampled.length - 1]).toBe(rows[rows.length - 1]);
    expect(sampled).toContain(rows[4321]);
    expect(sampled).toContain(rows[6789]);
    expect(rows.length).toBe(10_000);
    expect(sampled.every((r) => rows.includes(r))).toBe(true);
  });

  it("保留断线标记及两侧真实采样点，避免取点后跨空档连线", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ i, amount: i === 2222 ? null : 10 }));
    const sampled = sampleTrendRows(rows, (r) => [r.amount], 100);
    for (const i of [2221, 2222, 2223]) expect(sampled).toContain(rows[i]);
  });
});
