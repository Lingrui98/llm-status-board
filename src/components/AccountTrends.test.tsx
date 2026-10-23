import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AccountTrends from "./AccountTrends";
import type { BalanceSnapshot } from "../types";

vi.mock("./charts/lazy", () => ({
  LazyBalanceTrendChart: ({ snapshots, metric = "balance", window }: { snapshots: BalanceSnapshot[]; metric?: string; window: unknown }) => (
    <div data-testid={`${metric}-chart`} data-points={snapshots.length} data-window={JSON.stringify(window)} />
  ),
}));
afterEach(cleanup);
const now = new Date(2026, 9, 22, 12).getTime();
const hour = 3_600_000;
const snapshots = [now - 72 * hour, now - 2 * hour, now - 30 * 60_000, now].map((ts) => ({ accountId: "a1", ts: new Date(ts).toISOString(), balance: 10, total: 100, currency: "USD" }));
const setup = (points = snapshots) => render(<AccountTrends accountId="a1" snapshots={points} info={{ fetchedAt: "", extras: [], total: { amount: 100, currency: "USD" } }} now={now} />);

describe("账号共用趋势筛选", () => {
  it("默认显示全部，切换24小时与7天会同时更新余额和总额度", () => {
    setup();
    expect(screen.getByRole("button", { name: "全部" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("balance-chart").getAttribute("data-points")).toBe("4");
    fireEvent.click(screen.getByRole("button", { name: "24小时" }));
    for (const metric of ["balance", "total"]) expect(screen.getByTestId(`${metric}-chart`).getAttribute("data-points")).toBe("3");
    expect(screen.getByTestId("balance-chart").getAttribute("data-window")).toBe(screen.getByTestId("total-chart").getAttribute("data-window"));
    fireEvent.click(screen.getByRole("button", { name: "7天" }));
    expect(screen.getByTestId("total-chart").getAttribute("data-points")).toBe("4");
  });

  it("自定义时间倒置时显示错误，修正后两张曲线恢复", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "自定义" }));
    fireEvent.change(screen.getByLabelText("开始时间"), { target: { value: "2026-10-23T00:00:00" } });
    expect(screen.getByRole("status").textContent).toContain("开始时间必须早于结束时间");
    expect(screen.queryByTestId("balance-chart")).toBeNull();
    fireEvent.change(screen.getByLabelText("开始时间"), { target: { value: "2026-10-22T09:00:00" } });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTestId("balance-chart").getAttribute("data-points")).toBe("3");
    expect(screen.getByTestId("total-chart").getAttribute("data-points")).toBe("3");
  });

  it("近期没有数据时显示范围说明，切换全部后自动展开历史图", () => {
    setup(snapshots.slice(0, 2));
    fireEvent.click(screen.getByRole("button", { name: "1小时" }));
    expect(screen.queryByTestId("balance-chart")).toBeNull();
    expect(screen.getByText(/此时间范围暂无余额记录/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    expect(screen.getByTestId("balance-chart")).toBeTruthy();
    expect(screen.getByTestId("total-chart")).toBeTruthy();
  });
});
