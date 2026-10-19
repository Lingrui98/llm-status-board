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
  XAxis: () => null,
  YAxis: () => null,
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
    expect(screen.getByTestId("line").getAttribute("data-type")).toBe("monotone");
    expect(screen.getByText("余额")).toBeTruthy();
  });

  it("仅一个有效总额度时展示说明，不因已有多个余额快照绘制总额度", () => {
    render(<BalanceTrendChart snapshots={snapshots.slice(0, 3)} accountId="a1" metric="total" emptyNote="需要两次额度记录" />);
    expect(screen.queryByTestId("trend")).toBeNull();
    expect(screen.getByRole("img", { name: "需要两次额度记录" })).toBeTruthy();
  });
});
