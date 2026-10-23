import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { BalanceSnapshot } from "../../types";
import BalanceTrendChart from "./BalanceTrendChart";

// 检查送入图表的数据和悬浮提示，不依赖 jsdom 的 SVG 尺寸计算。
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ data, children }: { data: unknown; children: ReactNode }) => (
    <div data-testid="trend" data-rows={JSON.stringify(data)}>{children}</div>
  ),
  CartesianGrid: () => null,
  XAxis: ({ type, scale, dataKey, domain, ticks }: { type: string; scale: string; dataKey: string; domain: number[]; ticks: number[] }) => <div data-testid="time-axis" data-type={type} data-scale={scale} data-key={dataKey} data-domain={JSON.stringify(domain)} data-ticks={JSON.stringify(ticks)} />,
  YAxis: ({ tickFormatter }: { tickFormatter: (value: number) => string }) => (
    <div data-testid="amount-axis" data-labels={JSON.stringify([29500, 29750, 30000, 30250, 30500].map(tickFormatter))} />
  ),
  Line: ({ type, dataKey }: { type: string; dataKey: string }) => <div data-testid="line" data-type={type} data-key={dataKey} />,
  Tooltip: ({ content }: { content: React.ReactElement }) => (
    <content.type {...content.props} active payload={[{ payload: { fullTs: "时间", amount: 200, currency: "USD" } }]} />
  ),
}));

afterEach(cleanup);

const snapshots: BalanceSnapshot[] = [
  { accountId: "a1", ts: "2026-10-19T09:00:00Z", balance: 30, currency: "USD" },
  { accountId: "a1", ts: "2026-10-19T12:00:00Z", balance: 5, currency: "USD", total: 200 },
  { accountId: "a2", ts: "2026-10-19T10:00:00Z", balance: 99, currency: "USD", total: 999 },
  { accountId: "a1", ts: "2026-10-19T11:00:00Z", balance: 10, currency: "USD", total: 0 },
  { accountId: "a1", ts: "2026-10-19T13:00:00Z", balance: 4, currency: "USD", total: null },
  { accountId: "a1", ts: "2026-10-19T14:00:00Z", balance: 3, currency: "USD", total: NaN },
];

function amounts(): number[] {
  return JSON.parse(screen.getByTestId("trend").getAttribute("data-rows")!).map((row: { amount: number }) => row.amount);
}

describe("BalanceTrendChart", () => {
  it("总额度附近的金额刻度保留差异，不全部简写为同一个万单位标签", () => {
    render(<BalanceTrendChart snapshots={snapshots} accountId="a1" metric="total" />);
    expect(JSON.parse(screen.getByTestId("amount-axis").getAttribute("data-labels")!))
      .toEqual(["29,500", "29,750", "30,000", "30,250", "30,500"]);
  });

  it("总额度使用独立实测值并按时间排序，不用余额替代或补填旧数据", () => {
    render(<BalanceTrendChart snapshots={snapshots} accountId="a1" metric="total" />);
    expect(amounts()).toEqual([0, 200]);
    expect(screen.getByTestId("line").getAttribute("data-type")).toBe("stepAfter");
    expect(screen.getByText("总额度")).toBeTruthy();
    expect(screen.getByText("200.00 USD")).toBeTruthy();
  });

  it("默认仍展示余额，兼容没有总额度的历史", () => {
    render(<BalanceTrendChart snapshots={snapshots} accountId="a1" />);
    expect(amounts()).toEqual([30, 10, 5, 4, 3]);
    expect(screen.getByTestId("line").getAttribute("data-type")).toBe("linear");
    expect(screen.getByText("余额")).toBeTruthy();
  });

  it("仅一个有效总额度时展示说明，不因已有多个余额快照绘制总额度", () => {
    render(<BalanceTrendChart snapshots={snapshots.slice(0, 3)} accountId="a1" metric="total" emptyNote="需要两次额度记录" />);
    expect(screen.queryByTestId("trend")).toBeNull();
    expect(screen.getByRole("img", { name: "需要两次额度记录" })).toBeTruthy();
  });

  it("使用数值时间轴，1 分钟与 10 分钟间隔保持真实比例", () => {
    const times = ["2026-10-19T10:00:00Z", "2026-10-19T10:01:00Z", "2026-10-19T10:11:00Z"];
    render(<BalanceTrendChart snapshots={times.map((ts) => ({ accountId: "a1", ts, balance: 10, currency: "USD" }))} accountId="a1" />);
    const axis = screen.getByTestId("time-axis");
    expect(axis.getAttribute("data-type")).toBe("number");
    expect(axis.getAttribute("data-scale")).toBe("time");
    expect(axis.getAttribute("data-key")).toBe("timestamp");
    const rows = JSON.parse(screen.getByTestId("trend").getAttribute("data-rows")!);
    expect(rows[2].timestamp - rows[1].timestamp).toBe(10 * (rows[1].timestamp - rows[0].timestamp));
  });

  it("筛选时间范围，忽略无效时间，并为长采样空档断线", () => {
    const points: BalanceSnapshot[] = [
      { accountId: "a1", ts: "2026-10-19T10:00:00Z", balance: 10, currency: "USD" },
      { accountId: "a1", ts: "2026-10-19T18:00:00Z", balance: 5, currency: "USD" },
      { accountId: "a1", ts: "invalid", balance: 999, currency: "USD" },
      { accountId: "a1", ts: "2026-10-20T10:00:00Z", balance: 0, currency: "USD" },
    ];
    const window = { from: Date.parse(points[0].ts), to: Date.parse(points[1].ts) };
    render(<BalanceTrendChart snapshots={points} accountId="a1" window={window} />);
    expect(amounts()).toEqual([10, null, 5]);
    expect(JSON.parse(screen.getByTestId("time-axis").getAttribute("data-domain")!)).toEqual([window.from, window.to]);
  });

  it("余额和总额度点数不同仍使用相同刻度", () => {
    const window = { from: Date.parse(snapshots[0].ts), to: Date.parse(snapshots[5].ts) };
    const { rerender } = render(<BalanceTrendChart snapshots={snapshots} accountId="a1" window={window} />);
    const balanceTicks = screen.getByTestId("time-axis").getAttribute("data-ticks");
    rerender(<BalanceTrendChart snapshots={snapshots} accountId="a1" metric="total" window={window} />);
    expect(screen.getByTestId("time-axis").getAttribute("data-ticks")).toBe(balanceTicks);
  });
});
