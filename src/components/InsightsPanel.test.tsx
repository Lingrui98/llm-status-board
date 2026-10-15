// R14 洞察区组件测试：在组件层验证 UI（无 App 全局统计图表，jsdom 下确定性好）。
// 计算口径的完整覆盖在 src/insights.test.ts；导出编排在 src/exportReport.test.ts。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import InsightsPanel from "./InsightsPanel";
import type { AccountConfig, BalanceSnapshot, RefreshOutcome, Settings } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn(), confirm: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

const mockInvoke = vi.mocked(invoke);
const mockSave = vi.mocked(save);

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockReset();
});

const SETTINGS: Settings = { autoRefreshSec: 0, refreshOnStart: false };

function account(id: string, name: string, kind: AccountConfig["kind"] = "deepSeek"): AccountConfig {
  return {
    id,
    name,
    kind,
    enabled: true,
    baseUrl: "https://example.com",
    apiKey: "",
    token: "",
    userId: null,
    username: "",
    password: "",
    quotaPerUnit: null,
    custom: null,
  };
}

function snap(accountId: string, ts: string, balance: number, currency = "USD"): BalanceSnapshot {
  return { ts, accountId, balance, currency };
}

/**
 * 相对当前时刻的快照时间戳（间隔 gapDays 天，同时刻）。
 * 组件内部用真实 Date.now() 取「现在」，所以这里必须用相对时间，测试才不随日期腐坏；
 * 同一时刻减法保证跨度恰好是整数天，且与运行日期、时区都无关。
 */
function relTs(gapDays: number): string {
  return new Date(Date.now() - gapDays * 86_400_000).toISOString();
}
const S1 = relTs(2);
const S2 = relTs(0);

function okOutcome(accountId: string): RefreshOutcome {
  return { accountId, ok: true, info: null, error: null };
}

function renderPanel(props: {
  accounts: AccountConfig[];
  snapshots: BalanceSnapshot[];
  settings?: Settings;
  statuses?: Record<string, RefreshOutcome>;
}) {
  // D-2/AC-5 之后，面板内部只把「本轮刷新成功」的账号纳入洞察；本文件的用例默认关注
  // 计算与展示，因此未显式给出 statuses 时按「全部刷新成功」补全。
  // 需要验证失败场景的用例显式传 statuses: { id: { ok: false, ... } } 即可覆盖。
  const statuses: Record<string, RefreshOutcome> = props.statuses ?? {};
  const statusesWithOk: Record<string, RefreshOutcome> = {};
  for (const acc of props.accounts) {
    statusesWithOk[acc.id] = statuses[acc.id] ?? { accountId: acc.id, ok: true, info: null, error: null };
  }
  return render(
    <InsightsPanel
      accounts={props.accounts}
      statuses={statusesWithOk}
      snapshots={props.snapshots}
      settings={props.settings ?? SETTINGS}
    />,
  );
}

describe("InsightsPanel：空态与降级", () => {
  it("无任何快照：显示明确占位文案，不渲染磁贴网格，导出入口仍可用", () => {
    renderPanel({ accounts: [account("a1", "甲账号")], snapshots: [] });
    expect(screen.getByText("洞察")).toBeTruthy();
    expect(screen.getByText(/暂无历史数据/)).toBeTruthy();
    expect(document.querySelector(".insights-grid")).toBeNull();
    expect(screen.getByRole("button", { name: "导出 CSV" })).toBeTruthy();
  });

  it("单条快照：磁贴降级显示占位与原因，不出现「可支撑」单位，无 NaN/Infinity", () => {
    renderPanel({ accounts: [account("a1", "甲账号")], snapshots: [snap("a1", S2, 70)] });
    const tile = document.querySelector(".stat-tile") as HTMLElement;
    expect(tile).toBeTruthy();
    expect(tile.textContent).toContain("历史快照不足 2 条");
    expect(screen.queryByText("可支撑")).toBeNull();
    expect(document.body.textContent).not.toContain("NaN");
    expect(document.body.textContent).not.toContain("Infinity");
  });

  it("credits 订阅账号：不产生磁贴，列出跳过原因", () => {
    renderPanel({
      accounts: [account("kimi", "Kimi 订阅", "moonshot")],
      snapshots: [snap("kimi", S1, 1000, "credits"), snap("kimi", S2, 400, "credits")],
    });
    expect(document.querySelector(".stat-tile")).toBeNull();
    expect(screen.getByText(/点数\/订阅单位/)).toBeTruthy();
    expect(screen.getByText(/Kimi 订阅（CREDITS）/)).toBeTruthy();
  });

  it("刷新失败的账号不影响其他账号的洞察计算", () => {
    renderPanel({
      accounts: [account("a1", "正常账号"), account("a2", "失败账号")],
      snapshots: [snap("a1", S1, 100), snap("a1", S2, 70)],
      statuses: { a2: { accountId: "a2", ok: false, info: null, error: "HTTP 500" } },
    });
    // 账号磁贴 + 一个「本月预计支出」磁贴；失败账号（无快照）不产生磁贴
    const labels = [...document.querySelectorAll(".stat-tile-label")].map((e) => e.textContent ?? "");
    expect(labels.filter((l) => l.includes("正常账号"))).toHaveLength(1);
    expect(labels.filter((l) => l.includes("失败账号"))).toHaveLength(0);
    expect(labels.filter((l) => l.startsWith("本月预计支出"))).toHaveLength(1);
    const accountTile = [...document.querySelectorAll(".stat-tile")].find((t) =>
      t.textContent?.includes("正常账号"),
    ) as HTMLElement;
    expect(accountTile.textContent).toContain("4.7 天"); // 70 / 15 每天
  });

  it("D-2：显式 ok:false 的账号即使有快照也不出磁贴、不进最快摘要", () => {
    renderPanel({
      accounts: [account("bad", "失败但有快照")],
      snapshots: [snap("bad", S1, 100), snap("bad", S2, 10)], // 若被统计会是 45/天的最快账号
      statuses: { bad: { accountId: "bad", ok: false, info: null, error: "HTTP 500" } },
    });
    expect(document.querySelector(".stat-tile")).toBeNull();
    expect(screen.queryByText(/消耗最快/)).toBeNull();
    expect(screen.queryByText("失败但有快照")).toBeNull();
  });

  it("未刷新的启用账号（statuses 无条目）仍可展示历史快照的洞察", () => {
    // 刚启动、只读到上次结果时，不应把「还没刷新」当成「刷新失败」而清空洞察
    render(
      <InsightsPanel
        accounts={[account("a1", "历史账号")]}
        statuses={{}}
        snapshots={[snap("a1", S1, 100), snap("a1", S2, 70)]}
        settings={SETTINGS}
      />,
    );
    expect(document.querySelector(".stat-tile")).toBeTruthy();
    expect(screen.getByText("4.7 天")).toBeTruthy();
  });
});

describe("InsightsPanel：磁贴与风险色", () => {
  it("余额下降：显示可支撑天数、日均消耗与风险提示条", () => {
    renderPanel({ accounts: [account("a1", "甲账号")], snapshots: [snap("a1", S1, 100), snap("a1", S2, 70)] });
    expect(screen.getByText("4.7 天")).toBeTruthy();
    expect(screen.getByText("可支撑")).toBeTruthy();
    expect(screen.getByText(/日均 15\.00 USD\/天/)).toBeTruthy();
    // daysLeft ≈ 4.7 ≤ 7 → 风险提示条带 warn 语义色
    const notice = document.querySelector(".insights-notice");
    expect(notice?.className).toContain("warn");
    expect(notice?.textContent).toContain("消耗最快");
    expect(notice?.textContent).toContain("甲账号");
  });

  it("可支撑 ≤ 3 天时提示条升级为 err 语义色", () => {
    // 100 → 20，跨度 2 天 → 40/天，余额 20 → 0.5 天
    renderPanel({ accounts: [account("a1", "濒危账号")], snapshots: [snap("a1", S1, 100), snap("a1", S2, 20)] });
    expect(screen.getByText("< 1 天")).toBeTruthy();
    expect(document.querySelector(".insights-notice")?.className).toContain("err");
  });

  it("余额未下降（零消耗）：显示占位与原因，不做除零", () => {
    renderPanel({ accounts: [account("a1", "静止账号")], snapshots: [snap("a1", S1, 50), snap("a1", S2, 50)] });
    const tile = document.querySelector(".stat-tile") as HTMLElement;
    expect(tile.textContent).toContain("窗口内无消耗");
    expect(document.body.textContent).not.toContain("Infinity");
  });

  it("多币种分开展示：USD 与 CNY 各自成组，本月预计支出按币种分行", () => {
    renderPanel({
      accounts: [account("a1", "美元账号"), account("a2", "人民币账号")],
      snapshots: [
        snap("a1", S1, 100, "USD"),
        snap("a1", S2, 70, "USD"),
        snap("a2", S1, 700, "CNY"),
        snap("a2", S2, 600, "CNY"),
      ],
    });
    const labels = [...document.querySelectorAll(".stat-tile-label")].map((e) => e.textContent ?? "");
    expect(labels.some((l) => l.includes("美元账号") && l.includes("USD"))).toBe(true);
    expect(labels.some((l) => l.includes("人民币账号") && l.includes("CNY"))).toBe(true);
    expect(labels.filter((l) => l.includes("本月预计支出")).length).toBe(2);
    // 币种筛选（多于一个币种时出现）
    expect(screen.getByRole("radiogroup", { name: "洞察币种筛选" })).toBeTruthy();
  });

  it("币种筛选切换后只显示该币种磁贴", () => {
    renderPanel({
      accounts: [account("a1", "美元账号"), account("a2", "人民币账号")],
      snapshots: [
        snap("a1", S1, 100, "USD"),
        snap("a1", S2, 70, "USD"),
        snap("a2", S1, 700, "CNY"),
        snap("a2", S2, 600, "CNY"),
      ],
    });
    fireEvent.click(screen.getByText("CNY"));
    const labels = [...document.querySelectorAll(".stat-tile-label")].map((e) => e.textContent ?? "");
    expect(labels.some((l) => l.includes("人民币账号"))).toBe(true);
    expect(labels.some((l) => l.includes("美元账号"))).toBe(false);
  });

  it("折叠后内容整体收起，aria-expanded 同步", () => {
    renderPanel({ accounts: [account("a1", "甲账号")], snapshots: [snap("a1", S1, 100), snap("a1", S2, 70)] });
    const head = screen.getByRole("button", { name: /洞察/ });
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".insights-grid")).toBeTruthy();
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".insights-grid")).toBeNull();
    // 折叠时导出入口一并收起（面板头部由调用方保证可见）
    expect(screen.queryByRole("button", { name: "导出 CSV" })).toBeNull();
  });

  it("窗口天数取设置值并显示在副标题", () => {
    renderPanel({
      accounts: [account("a1", "甲账号")],
      snapshots: [snap("a1", S1, 100), snap("a1", S2, 70)],
      settings: { ...SETTINGS, insightWindowDays: 30 },
    });
    expect(screen.getByText(/近 30 天窗口/)).toBeTruthy();
  });
});

describe("InsightsPanel：导出入口", () => {
  it("点导出：选路径后调 export_csv，内容含 BOM/表头，成功提示显示行数", async () => {
    mockInvoke.mockImplementation((cmd: string) => (cmd === "export_csv" ? Promise.resolve(undefined) : Promise.resolve([])));
    mockSave.mockResolvedValue("C:/tmp/llm-usage.csv");

    renderPanel({ accounts: [account("a1", "甲账号")], snapshots: [snap("a1", S1, 100), snap("a1", S2, 70)] });
    fireEvent.click(screen.getByRole("button", { name: "导出 CSV" }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("export_csv", expect.objectContaining({ path: "C:/tmp/llm-usage.csv" }));
    });
    const call = mockInvoke.mock.calls.find((c) => c[0] === "export_csv");
    const content = (call?.[1] as { content: string }).content;
    expect(content.startsWith("\uFEFF")).toBe(true);
    expect(content).toContain("账号名称,账号类型,币种,日期,当日花费,当日请求数,当日Token,当日余额快照");
    expect(content).toContain("甲账号");
    await waitFor(() => {
      expect(screen.getByText(/已导出 \d+ 行到 C:\/tmp\/llm-usage\.csv/)).toBeTruthy();
    });
  });

  it("写盘失败：显示可读错误提示，不抛异常", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "export_csv") return Promise.reject("磁盘已满");
      return Promise.resolve([]);
    });
    mockSave.mockResolvedValue("C:/tmp/x.csv");

    renderPanel({ accounts: [account("a1", "甲账号")], snapshots: [snap("a1", S1, 100), snap("a1", S2, 70)] });
    fireEvent.click(screen.getByRole("button", { name: "导出 CSV" }));
    await waitFor(() => {
      expect(screen.getByText(/导出失败：磁盘已满/)).toBeTruthy();
    });
  });

  it("用户取消：不调 export_csv，也不显示错误", async () => {
    mockSave.mockResolvedValue(null);
    renderPanel({ accounts: [account("a1", "甲账号")], snapshots: [snap("a1", S1, 100), snap("a1", S2, 70)] });
    fireEvent.click(screen.getByRole("button", { name: "导出 CSV" }));
    await waitFor(() => {
      expect(mockSave).toHaveBeenCalled();
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("export_csv", expect.anything());
    expect(screen.queryByText(/导出失败/)).toBeNull();
  });
});

describe("InsightsPanel：与其他数据组合", () => {
  it("只统计启用账号，禁用账号不出现", () => {
    const disabled = { ...account("a2", "禁用账号"), enabled: false };
    renderPanel({
      accounts: [account("a1", "启用账号"), disabled],
      snapshots: [snap("a1", S1, 100), snap("a1", S2, 70), snap("a2", S1, 100), snap("a2", S2, 10)],
    });
    const labels = [...document.querySelectorAll(".stat-tile-label")].map((e) => e.textContent ?? "");
    expect(labels.some((l) => l.includes("启用账号"))).toBe(true);
    expect(labels.some((l) => l.includes("禁用账号"))).toBe(false);
  });

  it("窗口外的旧快照不计入（按设置的天数）", () => {
    renderPanel({
      accounts: [account("a1", "甲账号")],
      snapshots: [snap("a1", "2026-04-01T12:00:00.000Z", 100), snap("a1", "2026-04-02T12:00:00.000Z", 50)],
      settings: { ...SETTINGS, insightWindowDays: 14 },
    });
    const tile = document.querySelector(".stat-tile") as HTMLElement;
    expect(tile.textContent).toContain("历史快照不足 2 条");
  });

  it("提供 statuses 但无快照时走空态（不报错）", () => {
    renderPanel({
      accounts: [account("a1", "甲账号")],
      snapshots: [],
      statuses: { a1: okOutcome("a1") },
    });
    expect(screen.getByText(/暂无历史数据/)).toBeTruthy();
  });
});
