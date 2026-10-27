import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import QuotaHistory from "./QuotaHistory";
import type { AccountInfo, QuotaSample } from "../types";

vi.mock("./charts/lazy", () => ({ LazyQuotaHistoryChart: ({ samples, window, metric }: { samples: QuotaSample[]; window: unknown; metric: string }) =>
  <div data-testid="quota-chart" data-samples={JSON.stringify(samples)} data-window={JSON.stringify(window)} data-metric={metric} /> }));
afterEach(cleanup);
const ts = (hour: number) => `2026-10-01T0${hour}:00:00Z`;
const samples: QuotaSample[] = [80, 0, 20].map((usedPercent, i) => ({ ts: ts(i), scope: "workspace", windows: [{ key: "codex:604800", label: "Codex · 每周",
  usedPercent, resetsAt: "2026-10-04T11:17:00Z", windowSeconds: 604800, segment: i === 0 ? 1 : 2, boundary: i === 1 ? "usageDecreased" : null }] }));
const info: AccountInfo = { fetchedAt: ts(2), extras: [], quotaScope: "workspace", quotaWindows: [{ window: "Codex · 每周", historyKey: "codex:604800", usedPercent: 20 }] };

describe("subscription quota history layout", () => {
  it("defaults to the actual latest segment, including an early ad-hoc reset", () => {
    render(<QuotaHistory samples={samples} info={info} now={Date.parse(ts(3))} />);
    const chart = screen.getByTestId("quota-chart");
    expect(JSON.parse(chart.getAttribute("data-samples")!)).toHaveLength(2);
    expect(JSON.parse(chart.getAttribute("data-window")!).from).toBe(Date.parse(ts(1)));
    expect(screen.getByText(/周期长度不固定/)).toBeTruthy();
    expect(screen.queryByText("余额趋势")).toBeNull();
    expect(screen.queryByText("近 14 天用量")).toBeNull();
  });

  it("allows full history, 90-day/custom ranges and remaining-percent display", () => {
    render(<QuotaHistory samples={samples} info={info} now={Date.parse(ts(3))} />);
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    expect(JSON.parse(screen.getByTestId("quota-chart").getAttribute("data-samples")!)).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "90天" }));
    const range = JSON.parse(screen.getByTestId("quota-chart").getAttribute("data-window")!);
    expect(range.to - range.from).toBe(90 * 86400000);
    fireEvent.change(screen.getByLabelText("展示口径"), { target: { value: "remaining" } });
    expect(screen.getByTestId("quota-chart").getAttribute("data-metric")).toBe("remaining");
    fireEvent.click(screen.getByRole("button", { name: "自定义" }));
    fireEvent.change(screen.getByLabelText("开始时间"), { target: { value: "2026-10-03T00:00" } });
    fireEvent.change(screen.getByLabelText("结束时间"), { target: { value: "2026-10-01T00:00" } });
    expect(screen.getByText("开始时间必须早于结束时间")).toBeTruthy();
  });

  it("shows local-history errors without inventing an empty allowance", () => {
    render(<QuotaHistory samples={samples} info={{ ...info, quotaHistoryError: "保存订阅额度历史失败" }} />);
    expect(screen.getByRole("status").textContent).toContain("保存订阅额度历史失败");
    expect(screen.getByTestId("quota-chart")).toBeTruthy();
  });
});
