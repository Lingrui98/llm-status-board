import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import GlobalStatsCard from "./GlobalStatsCard";

vi.mock("./charts/lazy", () => ({
  LazyGlobalDailyUsageChart: ({ days }: { days?: number }) => <div data-testid="global-usage" data-days={days} />,
  LazyGlobalModelUsageChart: () => <div data-testid="global-models" />,
  LazyGlobalBalanceTrendChart: () => <div data-testid="global-balance" />,
  LazyCostBreakdownChart: () => <div data-testid="global-cost" />,
}));

afterEach(cleanup);

describe("GlobalStatsCard", () => {
  it("默认只展示用量趋势，并在同一卡片内切换四类图表和时间范围", () => {
    render(<GlobalStatsCard accounts={[]} statuses={{}} snapshots={[]} />);
    expect(screen.getByTestId("global-usage").getAttribute("data-days")).toBe("14");
    expect(screen.queryByTestId("global-models")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "30 天" }));
    expect(screen.getByTestId("global-usage").getAttribute("data-days")).toBe("30");

    fireEvent.click(screen.getByRole("radio", { name: "模型用量" }));
    expect(screen.queryByTestId("global-usage")).toBeNull();
    expect(screen.getByTestId("global-models")).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "30 天" })).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "余额趋势" }));
    expect(screen.getByTestId("global-balance")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "费用构成" }));
    expect(screen.getByTestId("global-cost")).toBeTruthy();
  });
});
