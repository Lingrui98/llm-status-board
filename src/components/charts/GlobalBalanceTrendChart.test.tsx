import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { AccountConfig, BalanceSnapshot } from "../../types";
import GlobalBalanceTrendChart from "./GlobalBalanceTrendChart";

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ data, children }: { data: unknown; children: ReactNode }) => <div data-testid="global-trend" data-rows={JSON.stringify(data)}>{children}</div>,
  CartesianGrid: () => null, YAxis: () => null, Tooltip: () => null, Legend: () => null,
  XAxis: ({ type, scale }: { type: string; scale: string }) => <div data-testid="global-axis" data-type={type} data-scale={scale} />,
  Line: ({ dataKey, type, connectNulls, data }: { dataKey: string; type: string; connectNulls: boolean; data: unknown }) => <div data-testid="global-line" data-key={dataKey} data-type={type} data-connect={String(connectNulls)} data-points={JSON.stringify(data)} />,
}));
const now = Date.parse("2026-10-22T12:00:00Z");
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const account = (id: string, enabled = true): AccountConfig => ({ id, name: id, enabled, kind: "aiHubMix", baseUrl: "", apiKey: "", token: "", userId: null, username: "", password: "", quotaPerUnit: null, custom: null });
const snap = (accountId: string, ts: string, balance = 10): BalanceSnapshot => ({ accountId, ts, balance, currency: "USD" });
const rows = () => JSON.parse(screen.getByTestId("global-trend").getAttribute("data-rows")!);

describe("全局余额趋势", () => {
  it("按真实时间合并等价时区，排除禁用账号与异常日期", () => {
    render(<GlobalBalanceTrendChart accounts={[account("a1"), account("a2"), account("disabled", false)]} snapshots={[
      snap("a1", "2026-10-22T11:00:00Z"), snap("a1", "2026-10-22T12:00:00Z"),
      snap("a2", "2026-10-22T19:00:00+08:00"), snap("a2", "2026-10-22T12:00:00Z"),
      snap("disabled", "2026-10-22T12:00:00Z", 999), snap("a1", "invalid"),
    ]} />);
    expect(rows().length).toBe(2);
    expect(rows()[0]).toMatchObject({ timestamp: Date.parse("2026-10-22T11:00:00Z"), a1: 10, a2: 10 });
    expect(screen.getAllByTestId("global-line").map((e) => e.getAttribute("data-key"))).toEqual(["a1", "a2"]);
    expect(screen.getByTestId("global-axis").getAttribute("data-type")).toBe("number");
    expect(screen.getByTestId("global-axis").getAttribute("data-scale")).toBe("time");
  });

  it("切换近期范围会筛选数据，缺失记录保持断线", () => {
    render(<GlobalBalanceTrendChart accounts={[account("a1")]} snapshots={[
      snap("a1", "2026-10-19T12:00:00Z"), snap("a1", "2026-10-22T11:00:00Z"), snap("a1", "2026-10-22T12:00:00Z"),
    ]} />);
    expect(rows().length).toBe(4); // 三个观测点与一个空档标记。
    expect(screen.getByTestId("global-line").getAttribute("data-connect")).toBe("false");
    expect(screen.getByTestId("global-line").getAttribute("data-type")).toBe("linear");
    fireEvent.click(screen.getByRole("button", { name: "24小时" }));
    expect(rows().map((r: { timestamp: number }) => r.timestamp)).toEqual([now - 3_600_000, now]);
  });

  it("账号按各自的采样时间绘制，其他账号的点不会把它的线切断", () => {
    render(<GlobalBalanceTrendChart accounts={[account("a1"), account("a2")]} snapshots={[
      snap("a1", "2026-10-22T10:00:00Z"), snap("a2", "2026-10-22T10:30:00Z"),
      snap("a1", "2026-10-22T11:00:00Z"), snap("a2", "2026-10-22T11:30:00Z"),
    ]} />);
    const lines = screen.getAllByTestId("global-line");
    for (const line of lines) {
      const key = line.getAttribute("data-key")!;
      const points = JSON.parse(line.getAttribute("data-points")!);
      expect(points.length).toBe(2);
      expect(points.every((p: Record<string, unknown>) => p[key] === 10)).toBe(true);
    }
  });
});
