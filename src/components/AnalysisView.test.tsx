// R15 分析视图组件测试：验证四个小节渲染、占位区分、以及图表走懒加载边界。
// 断言全部基于注入的 today，不依赖本机时区。
// R17：默认收起（localStorage 记忆用户选择）。涉及内容的用例一律「先展开再断言」，
// 数据/口径断言保持不变；折叠行为本身由「折叠与记忆」describe 覆盖。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import AnalysisView from "./AnalysisView";
import type { AccountConfig, RefreshOutcome, UsageRecord } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn(), confirm: vi.fn() }));
// 只把 recharts 图表替身掉（保持 charts/shared 真实，ChartEmpty/ChartSection 仍走真实现）。
// 这样测试既不依赖 jsdom 的 ResizeObserver，也不把 recharts 拉进测试运行时。
vi.mock("./charts/lazy", () => ({
  LazyAnalysisTrendChart: () => <div data-testid="trend-chart" />,
}));

afterEach(cleanup);
beforeEach(() => {
  // 折叠状态走 localStorage（lsb-bottom-sections）：每个用例从「无记录」开始
  window.localStorage.clear();
});

const TODAY = "2026-06-15";

function account(id: string, name: string, enabled = true): AccountConfig {
  return {
    id,
    name,
    kind: "deepSeek",
    enabled,
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

function rec(patch: Partial<UsageRecord> & { date: string }): UsageRecord {
  return {
    accountId: "a1",
    date: patch.date,
    cost: patch.cost ?? 0,
    currency: patch.currency ?? "USD",
    requests: patch.requests ?? null,
    inputTokens: null,
    outputTokens: null,
    tokens: null,
    usedTotal: null,
    source: patch.source ?? "local",
    updatedAt: "2026-06-15T10:00:00.000Z",
  };
}

function flatOutcome(accountId: string): RefreshOutcome {
  return { accountId, ok: true, info: null, error: null };
}

/** R17：默认收起——内容断言前先展开（幂等：已展开时不重复点击） */
function expandPanel(): HTMLElement {
  const head = screen.getByRole("button", { name: /用量花费分析/ });
  if (head.getAttribute("aria-expanded") !== "true") fireEvent.click(head);
  return head;
}

describe("AnalysisView：折叠与记忆（R17）", () => {
  const records: UsageRecord[] = [
    // 本周（06-09..06-15）合计 70 USD；上周（06-02..06-08）合计 50 USD → 环比 +40%
    rec({ date: "2026-06-12", cost: 30, requests: 300 }),
    rec({ date: "2026-06-14", cost: 40, requests: 100 }),
    rec({ date: "2026-06-05", cost: 50, requests: 50 }),
  ];

  it("默认收起：aria-expanded=false、内容未挂载，且挂载时不写 localStorage", () => {
    render(
      <AnalysisView records={records} statuses={{ a1: flatOutcome("a1") }} accounts={[account("a1", "甲账号")]} today={TODAY} />,
    );
    const head = screen.getByRole("button", { name: /用量花费分析/ });
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(head.getAttribute("aria-controls")).toBe("analysis-panel-body");
    expect(screen.queryByText(/周期对比/)).toBeNull();
    expect(window.localStorage.getItem("lsb-bottom-sections")).toBeNull();
  });

  it("收起态一行摘要与展开同源：近 7 天花费与展开后周期对比当期值一致", () => {
    render(
      <AnalysisView records={records} statuses={{ a1: flatOutcome("a1") }} accounts={[account("a1", "甲账号")]} today={TODAY} />,
    );
    const summary = document.querySelector(".section-summary") as HTMLElement;
    expect(summary.textContent).toContain("近 7 天花费 $70.00");
    expect(summary.textContent).toContain("环比 +40%");
    // 展开后 StatTile 的当期花费 = 摘要中的 $70.00（同一份 PeriodComparison）
    expandPanel();
    expect(screen.getByText("70.00")).toBeTruthy();
  });

  it("记住展开：用户展开后重挂载仍展开；只记 analysis 一项", () => {
    const view = render(
      <AnalysisView records={records} statuses={{ a1: flatOutcome("a1") }} accounts={[account("a1", "甲账号")]} today={TODAY} />,
    );
    expandPanel();
    view.unmount();
    render(
      <AnalysisView records={records} statuses={{ a1: flatOutcome("a1") }} accounts={[account("a1", "甲账号")]} today={TODAY} />,
    );
    const head = screen.getByRole("button", { name: /用量花费分析/ });
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/周期对比/)).toBeTruthy();
    const stored = JSON.parse(window.localStorage.getItem("lsb-bottom-sections") ?? "{}");
    expect(stored).toEqual({ analysis: true });
  });

  it("记住收起：展开后手动收起，重挂载仍收起", () => {
    const view = render(
      <AnalysisView records={records} statuses={{ a1: flatOutcome("a1") }} accounts={[account("a1", "甲账号")]} today={TODAY} />,
    );
    const head1 = expandPanel();
    fireEvent.click(head1);
    expect(head1.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/周期对比/)).toBeNull();
    view.unmount();
    render(
      <AnalysisView records={records} statuses={{ a1: flatOutcome("a1") }} accounts={[account("a1", "甲账号")]} today={TODAY} />,
    );
    expect(screen.getByRole("button", { name: /用量花费分析/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/周期对比/)).toBeNull();
  });
});

describe("AnalysisView：占位与错误提示", () => {
  it("无本地历史 → 收起态摘要说明原因；展开后显示「暂无本地用量历史」占位，且不渲染各分析小节", () => {
    render(
      <AnalysisView records={[]} statuses={{}} accounts={[account("a1", "甲")]} today={TODAY} />,
    );
    expect(screen.getByText("用量花费分析")).toBeTruthy();
    // 收起态摘要：解释为空的原因 + 可执行方向
    expect(screen.getByText(/暂无本地用量数据 · 随刷新自动积累/)).toBeTruthy();
    expandPanel();
    expect(screen.getByText(/暂无本地用量历史/)).toBeTruthy();
    expect(screen.queryByText(/周期对比/)).toBeNull();
    expect(screen.queryByText(/模型成本排行/)).toBeNull();
  });

  it("读取失败提示原样展示（可读、非阻塞，收起时也常驻可见）", () => {
    render(
      <AnalysisView
        records={[]}
        statuses={{}}
        accounts={[account("a1", "甲")]}
        today={TODAY}
        errorNote="本地用量历史读取失败：文件格式错误"
      />,
    );
    expect(screen.getByText(/本地用量历史读取失败：文件格式错误/)).toBeTruthy();
    // 展开后仍然给出占位而不是空白
    expandPanel();
    expect(screen.getByText(/暂无本地用量历史/)).toBeTruthy();
  });

  it("本地历史刚开始积累时展示 hintNote", () => {
    render(
      <AnalysisView
        records={[rec({ date: TODAY, cost: 1 })]}
        statuses={{ a1: flatOutcome("a1") }}
        accounts={[account("a1", "甲")]}
        today={TODAY}
        hintNote="本地历史刚开始积累"
      />,
    );
    expandPanel();
    expect(screen.getByText(/本地历史刚开始积累/)).toBeTruthy();
  });

  it("禁用账号的记录被排除：全部禁用时回到占位", () => {
    render(
      <AnalysisView
        records={[rec({ date: TODAY, cost: 10 })]}
        statuses={{}}
        accounts={[account("a1", "甲", false)]}
        today={TODAY}
      />,
    );
    expandPanel();
    expect(screen.getByText(/暂无本地用量历史/)).toBeTruthy();
  });
});

describe("AnalysisView：四个分析小节", () => {
  const records: UsageRecord[] = [
    // 本周（06-09..06-15）
    rec({ date: "2026-06-12", cost: 30, requests: 300 }),
    rec({ date: "2026-06-14", cost: 40, requests: 100 }),
    // 上周（06-02..06-08）
    rec({ date: "2026-06-05", cost: 50, requests: 50 }),
    // 异常日序列：13 天 10 + 1 天 40
    ...Array.from({ length: 12 }, (_, i) => rec({ date: `2026-06-${String(i + 1).padStart(2, "0")}`, cost: 10 })),
    rec({ date: "2026-06-13", cost: 40 }),
  ];

  it("有记录时渲染四个小节标题（周期对比 / 模型成本 / 账号效率 / 异常日）", () => {
    render(
      <AnalysisView
        records={records}
        statuses={{ a1: flatOutcome("a1") }}
        accounts={[account("a1", "甲账号")]}
        today={TODAY}
      />,
    );
    expandPanel();
    expect(screen.getByText(/周期对比/)).toBeTruthy();
    expect(screen.getByText(/模型成本排行/)).toBeTruthy();
    expect(screen.getByText(/账号效率对比/)).toBeTruthy();
    expect(screen.getByText(/异常日检测/)).toBeTruthy();
    // 不应再显示空态
    expect(screen.queryByText(/暂无本地用量历史/)).toBeNull();
  });

  it("账号名（而非 id）出现在效率榜里", () => {
    render(
      <AnalysisView
        records={records}
        statuses={{ a1: flatOutcome("a1") }}
        accounts={[account("a1", "甲账号")]}
        today={TODAY}
      />,
    );
    expandPanel();
    expect(screen.getAllByText("甲账号").length).toBeGreaterThan(0);
  });

  it("模型维度无数据 → 模型小节显示「未返回模型维度用量」占位（区分于无本地历史）", () => {
    render(
      <AnalysisView
        records={records}
        statuses={{ a1: flatOutcome("a1") }}
        accounts={[account("a1", "甲账号")]}
        today={TODAY}
      />,
    );
    expandPanel();
    expect(screen.getByText(/该提供商未返回模型维度用量/)).toBeTruthy();
  });

  it("模型维度有数据（results.json#modelUsage）→ 渲染排行行", () => {
    const statuses: Record<string, RefreshOutcome> = {
      a1: {
        accountId: "a1",
        ok: true,
        info: {
          balance: null,
          used: null,
          total: null,
          requests: null,
          note: null,
          extras: [],
          raw: null,
          fetchedAt: "2026-06-15T10:00:00.000Z",
          modelUsage: [
            { model: "gpt-4o", cost: 12.5, costUnit: "USD", requests: 10, tokens: 500 },
            { model: "claude", cost: 8, costUnit: "USD", requests: 5, tokens: 200 },
          ],
        },
        error: null,
      },
    };
    render(
      <AnalysisView
        records={records}
        statuses={statuses}
        accounts={[account("a1", "甲账号")]}
        today={TODAY}
      />,
    );
    expandPanel();
    expect(screen.getByText("gpt-4o")).toBeTruthy();
    expect(screen.getByText("claude")).toBeTruthy();
    expect(screen.getByText("12.50")).toBeTruthy();
    expect(screen.getByText("8.00")).toBeTruthy();
  });

  it("credits-only 记录不产生法币周期行（法币口径排除点数单位）", () => {
    render(
      <AnalysisView
        records={[rec({ date: TODAY, cost: 500, currency: "CREDITS" })]}
        statuses={{ a1: flatOutcome("a1") }}
        accounts={[account("a1", "甲账号")]}
        today={TODAY}
      />,
    );
    expandPanel();
    // 有历史（所以不是「暂无本地用量历史」占位），但法币周期无数据
    expect(screen.queryByText(/暂无本地用量历史/)).toBeNull();
    expect(screen.getByText(/本期与上期均无花费记录/)).toBeTruthy();
  });

  it("异常日样本不足时给出「样本不足」说明", () => {
    render(
      <AnalysisView
        records={[rec({ date: TODAY, cost: 10 }), rec({ date: "2026-06-14", cost: 10 })]}
        statuses={{ a1: flatOutcome("a1") }}
        accounts={[account("a1", "甲账号")]}
        today={TODAY}
      />,
    );
    expandPanel();
    expect(screen.getByText(/样本不足/)).toBeTruthy();
  });
});
