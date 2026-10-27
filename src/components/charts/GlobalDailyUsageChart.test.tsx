import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { AccountConfig, RefreshOutcome, UsagePoint } from "../../types";
import GlobalDailyUsageChart, { buildGlobalDailyUsageData, GlobalDailyTip } from "./GlobalDailyUsageChart";
import { siteRecordsFromOutcomes } from "../../usageHistory";

// 直接检查 Recharts 输入，避免依赖 jsdom 缺失的 SVG 尺寸计算。
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ data, children }: { data: unknown; children: ReactNode }) => (
    <div data-testid="usage-line-chart" data-rows={JSON.stringify(data)}>{children}</div>
  ),
  AreaChart: ({ data, children }: { data: unknown; children: ReactNode }) => (
    <div data-testid="usage-area-chart" data-rows={JSON.stringify(data)}>{children}</div>
  ),
  CartesianGrid: () => null,
  XAxis: ({ tickFormatter }: { tickFormatter: (value: string) => string }) => (
    <div data-testid="usage-x-axis" data-label={tickFormatter("2026-10-01")} />
  ),
  YAxis: () => null,
  Tooltip: ({ labelFormatter }: { labelFormatter: (value: unknown) => ReactNode }) => (
    <div data-testid="usage-tooltip-label">{labelFormatter("2026-10-01")}</div>
  ),
  Legend: ({ onClick }: { onClick: (event: { dataKey: string }) => void }) => (
    <button type="button" data-testid="usage-legend-bosc" onClick={() => onClick({ dataKey: "bosc" })}>
      切换 bosc
    </button>
  ),
  Line: ({ dataKey, stackId, hide, dot }: { dataKey: string; stackId?: string; hide?: boolean; dot?: unknown }) => (
    <div data-testid="usage-line" data-key={dataKey} data-stack-id={stackId} data-hidden={String(hide)} data-has-dot={String(Boolean(dot))} />
  ),
  Area: ({ dataKey, stackId, dot }: { dataKey: string; stackId?: string; dot?: unknown }) => (
    <div data-testid="usage-area" data-key={dataKey} data-stack-id={stackId} data-has-dot={String(Boolean(dot))} />
  ),
}));

afterEach(cleanup);

const account = (id: string): AccountConfig => ({
  id,
  name: id,
  enabled: true,
  kind: "aiHubMix",
  baseUrl: "",
  apiKey: "",
  token: "",
  userId: null,
  username: "",
  password: "",
  quotaPerUnit: null,
  custom: null,
});

const status = (accountId: string, dailyUsage: UsagePoint[]): RefreshOutcome => ({
  accountId,
  ok: true,
  info: { extras: [], fetchedAt: "2026-10-20T00:00:00", dailyUsage },
});

function chartRows(): Array<Record<string, string | number>> {
  const chart = screen.queryByTestId("usage-line-chart") ?? screen.getByTestId("usage-area-chart");
  return JSON.parse(chart.getAttribute("data-rows")!);
}

describe("GlobalDailyUsageChart", () => {
  it("eto 为 0、bosc 为 5430 时绘制独立非堆叠折线，数据行保留原值", () => {
    const accounts = [account("eto"), account("bosc")];
    const statuses = {
      eto: status("eto", [
        { date: "2026-10-01", requests: 0 },
        { date: "2026-10-02", requests: 0 },
      ]),
      bosc: status("bosc", [
        { date: "2026-10-01", requests: 5430 },
        { date: "2026-10-02", requests: 5430 },
      ]),
    };
    render(<GlobalDailyUsageChart accounts={accounts} statuses={statuses} />);

    expect(screen.queryByTestId("usage-area-chart")).toBeNull();
    expect(chartRows()).toEqual([
      { date: "2026-10-01", bosc: 5430, eto: 0 },
      { date: "2026-10-02", bosc: 5430, eto: 0 },
    ]);
    const lines = screen.getAllByTestId("usage-line");
    expect(lines.map((line) => line.getAttribute("data-key"))).toEqual(["bosc", "eto"]);
    for (const line of lines) expect(line.getAttribute("data-stack-id")).toBeNull();

    fireEvent.click(screen.getByTestId("usage-legend-bosc"));
    const boscLine = screen.getAllByTestId("usage-line").find((line) => line.getAttribute("data-key") === "bosc")!;
    expect(boscLine.getAttribute("data-hidden")).toBe("true");
  });

  it("先把不同原始格式归一为同一日历日，再合并同日请求数", () => {
    const localMorning = "2026-10-01T01:00:00+08:00";
    const localEvening = "2026-10-01T23:00:00+08:00";
    const result = buildGlobalDailyUsageData(
      [account("eto"), account("bosc")],
      {
        eto: status("eto", [
          { date: "2026-10-01", requests: 2 },
          { date: localMorning, requests: 3 },
          { date: "2026-10-01T12:00:00", requests: 4 },
          { date: localEvening, requests: 0 },
        ]),
        bosc: status("bosc", [{ date: "2026-10-01T08:00:00", requests: 5430 }]),
      },
      "requests",
    );

    expect(result.rows).toEqual([{ date: "2026-10-01", bosc: 5430, eto: 9 }]);
    expect(result.rows).toHaveLength(1);
  });

  it("days 默认 14，并按 7、14、30 的参数截断日期行", () => {
    const dailyUsage = Array.from({ length: 16 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 9, index + 1)).toISOString().slice(0, 10),
      requests: index + 1,
    }));
    const accounts = [account("a1"), account("a2")];
    const statuses = { a1: status("a1", dailyUsage), a2: status("a2", dailyUsage) };
    const { rerender } = render(<GlobalDailyUsageChart accounts={accounts} statuses={statuses} />);

    expect(chartRows()).toHaveLength(14);
    expect(chartRows()[0]).toEqual({ date: "2026-10-03", a1: 3, a2: 3 });
    rerender(<GlobalDailyUsageChart accounts={accounts} statuses={statuses} days={7} />);
    expect(chartRows()).toHaveLength(7);
    expect(chartRows()[0]).toEqual({ date: "2026-10-10", a1: 10, a2: 10 });
    rerender(<GlobalDailyUsageChart accounts={accounts} statuses={statuses} days={30} />);
    expect(chartRows()).toHaveLength(16);
    expect(chartRows()[0]).toEqual({ date: "2026-10-01", a1: 1, a2: 1 });
    expect(screen.getByTestId("usage-x-axis").getAttribute("data-label")).toBe("10-01");
    expect(screen.getByTestId("usage-tooltip-label").textContent).toBe("10-01");
  });

  it("保留请求和费用切换，以及前 6 加其他的系列归并", () => {
    const accounts = Array.from({ length: 8 }, (_, index) => account(`a${index + 1}`));
    const statuses = Object.fromEntries(
      accounts.map((acc, index) => [
        acc.id,
        status(acc.id, [{ date: "2026-10-01", requests: index + 1, cost: index + 0.5, costUnit: "USD" }]),
      ]),
    );
    const built = buildGlobalDailyUsageData(accounts, statuses, "requests");
    expect(built.series.map((item) => item.key)).toEqual(["a8", "a7", "a6", "a5", "a4", "a3", "__other__"]);
    expect(built.rows[0].__other__).toBe(3);

    const twoAccounts = [account("eto"), account("bosc")];
    const twoStatuses = {
      eto: status("eto", [
        { date: "2026-10-01", requests: 0, cost: 0.25, costUnit: "USD" },
        { date: "2026-10-02", requests: 0, cost: 0.5, costUnit: "USD" },
      ]),
      bosc: status("bosc", [
        { date: "2026-10-01", requests: 5430, cost: 12.5, costUnit: "USD" },
        { date: "2026-10-02", requests: 5430, cost: 20, costUnit: "USD" },
      ]),
    };
    render(<GlobalDailyUsageChart accounts={twoAccounts} statuses={twoStatuses} />);
    fireEvent.click(screen.getByRole("tab", { name: "费用" }));
    expect(chartRows()).toEqual([
      { date: "2026-10-01", bosc: 12.5, eto: 0.25 },
      { date: "2026-10-02", bosc: 20, eto: 0.5 },
    ]);
  });

  it("单个有数据日期也绘制数据点，不误报为空", () => {
    const accounts = [account("eto"), account("bosc")];
    const statuses = {
      eto: status("eto", [{ date: "2026-10-27", requests: 0 }]),
      bosc: status("bosc", [{ date: "2026-10-27", requests: 5430 }]),
    };
    render(<GlobalDailyUsageChart accounts={accounts} statuses={statuses} />);
    expect(screen.queryByText("暂无用量数据")).toBeNull();
    const lines = screen.getAllByTestId("usage-line");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.getAttribute("data-has-dot")).toBe("true");
  });

  it("前 6 排名只计算当前窗口，窗口外高总量不会挤占可见系列", () => {
    const accounts = [account("old"), ...Array.from({ length: 6 }, (_, index) => account(`a${index + 1}`))];
    const statuses = Object.fromEntries(accounts.map((acc, index) => [
      acc.id,
      status(acc.id, Array.from({ length: 8 }, (_, day) => ({
        date: `2026-10-0${day + 1}`,
        requests: acc.id === "old" ? (day === 0 ? 1000 : 0) : index,
      }))),
    ]));
    const result = buildGlobalDailyUsageData(accounts, statuses, "requests", 7);
    expect(result.series.map((item) => item.key)).toEqual(["a6", "a5", "a4", "a3", "a2", "a1", "__other__"]);
    expect(result.rows.every((row) => row.__other__ === 0)).toBe(true);
  });

  it("自定义提示框内容直接格式化完整日期标题", () => {
    render(
      <GlobalDailyTip
        active
        label="2026-10-27"
        payload={[{ dataKey: "bosc", value: 5430, color: "#000" }]}
        series={[{ key: "bosc", name: "bosc", color: "#000" }]}
        metric="requests"
        unit=""
      />,
    );
    expect(document.querySelector(".tt-title")?.textContent).toBe("10-27");
  });

  it("带时区时间戳与 usage-history 使用同一日历日", () => {
    const outcome = status("eto", [{ date: "2026-10-27T16:30:00Z", requests: 12 }]);
    const records = siteRecordsFromOutcomes([outcome], "2026-10-27T18:00:00Z");
    const chart = buildGlobalDailyUsageData([account("eto")], { eto: outcome }, "requests");
    expect(records[0].date).toBe("2026-10-27");
    expect(chart.rows[0].date).toBe(records[0].date);
  });
});
