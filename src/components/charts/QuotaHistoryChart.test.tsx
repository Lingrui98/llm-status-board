import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { QuotaSample } from "../../types";
import QuotaHistoryChart from "./QuotaHistoryChart";

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ data, children }: { data: unknown; children: ReactNode }) => <div data-testid="chart" data-rows={JSON.stringify(data)}>{children}</div>,
  CartesianGrid: () => null,
  XAxis: ({ type, scale, domain }: { type: string; scale: string; domain: number[] }) => <div data-testid="x" data-type={type} data-scale={scale} data-domain={JSON.stringify(domain)} />,
  YAxis: ({ domain }: { domain: number[] }) => <div data-testid="y" data-domain={JSON.stringify(domain)} />,
  Tooltip: () => null,
  ReferenceLine: ({ x }: { x: number }) => <div data-testid="boundary" data-time={x} />,
  Line: ({ type, connectNulls, dot }: { type: string; connectNulls: boolean; dot: unknown }) =>
    <div data-testid="line" data-type={type} data-connect={String(connectNulls)} data-dot={typeof dot} />,
}));
afterEach(cleanup);
const samples: QuotaSample[] = [70, 0, 110].map((usedPercent, i) => ({ ts: `2026-10-01T00:0${i}:00Z`, scope: "a", windows: [{
  key: "codex:604800", label: "Codex · 每周", usedPercent, resetsAt: null, windowSeconds: 604800, segment: i ? 2 : 1, boundary: i === 1 ? "usageDecreased" : null,
}] }));
const window = { from: Date.parse(samples[0].ts), to: Date.parse(samples[2].ts) };

describe("quota chart reset rendering", () => {
  it("uses actual time, steps, explicit gaps and observation markers without hiding over-limit values", () => {
    render(<QuotaHistoryChart samples={samples} windowKey="codex:604800" window={window} />);
    expect(screen.getByTestId("x").getAttribute("data-type")).toBe("number");
    expect(screen.getByTestId("x").getAttribute("data-scale")).toBe("time");
    expect(screen.getByTestId("line").getAttribute("data-type")).toBe("stepAfter");
    expect(screen.getByTestId("line").getAttribute("data-connect")).toBe("false");
    expect(screen.getByTestId("line").getAttribute("data-dot")).toBe("function");
    expect(JSON.parse(screen.getByTestId("chart").getAttribute("data-rows")!).map((r: { value: number | null }) => r.value)).toEqual([70, null, 0, 110]);
    expect(JSON.parse(screen.getByTestId("y").getAttribute("data-domain")!)).toEqual([0, 110]);
    expect(Number(screen.getByTestId("boundary").getAttribute("data-time"))).toBe(Date.parse(samples[1].ts));
  });

  it("shows a single-sample explanation rather than drawing a made-up period", () => {
    render(<QuotaHistoryChart samples={samples.slice(0, 1)} windowKey="codex:604800" window={window} />);
    expect(screen.queryByTestId("chart")).toBeNull();
    expect(screen.getByText("已有 1 个采样，再成功刷新一次即可形成趋势")).toBeTruthy();
  });
});
