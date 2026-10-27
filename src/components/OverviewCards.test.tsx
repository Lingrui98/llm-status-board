import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import OverviewCards from "./OverviewCards";
import type { AccountConfig, RefreshOutcome } from "../types";

afterEach(cleanup);

function account(id: string, enabled = true): AccountConfig {
  return {
    id,
    name: id,
    kind: "newApi",
    enabled,
    baseUrl: "",
    apiKey: "",
    token: "",
    username: "",
    password: "",
  };
}

function success(id: string, currency: "USD" | "CNY", balance: number, cost: number): RefreshOutcome {
  return {
    accountId: id,
    ok: true,
    info: {
      balance: { amount: balance, currency },
      extras: [],
      fetchedAt: "2026-10-27T12:00:00+08:00",
      dailyUsage: [{ date: "2026-10-27", cost, costUnit: currency }],
    },
  };
}

describe("OverviewCards", () => {
  it("按启用账号汇总状态、今日费用，并提供异常与刷新入口", () => {
    const accounts = [account("a"), account("b"), account("c"), account("disabled", false)];
    const statuses: Record<string, RefreshOutcome> = {
      a: success("a", "USD", 20, 2.87),
      b: success("b", "CNY", 100.5, 3.21),
      c: { accountId: "c", ok: false, error: "超时" },
      disabled: { accountId: "disabled", ok: false, error: "不应计入" },
    };
    statuses.b.info!.dailyUsage!.push({ date: "2026-10-27", cost: 4.6, costUnit: "CNY" });
    const onOpenNotifications = vi.fn();
    const onRefresh = vi.fn();
    render(
      <OverviewCards
        accounts={accounts.filter((a) => a.enabled)}
        statuses={statuses}
        totals={{ usd: 20, cny: 100.5 }}
        refreshing={false}
        lastRefreshAt="2026-10-27T14:01:33+08:00"
        lastRefreshMs={1200}
        autoRefreshSec={300}
        todayKey="2026-10-27"
        onOpenNotifications={onOpenNotifications}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByText("2 正常")).toBeTruthy();
    expect(screen.getByText("$20.00")).toBeTruthy();
    expect(screen.getByText("¥100.50")).toBeTruthy();
    expect(screen.getByText(/今日 −\$2\.87/)).toBeTruthy();
    expect(screen.getByText(/今日 −¥7\.81/)).toBeTruthy();
    expect(screen.getByText(/每 300s 自动/)).toBeTruthy();
    expect(screen.getByText(/耗时 1\.2s/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "1 异常" }));
    fireEvent.click(screen.getByTitle("立即刷新全部账号"));
    expect(onOpenNotifications).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
