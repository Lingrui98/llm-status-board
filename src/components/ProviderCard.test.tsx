// R19 卡片/DOM 断言：
// - AC-4：ModelServer（余额 0 + 7d 0%）主指标为「订阅剩余 100%」且卡片内无 $0；余额 12.5 → 余额主指标；raw.balance_credits → 「充值余额」
// - AC-7/8/9/10：抽屉无数据区块默认折叠（标题 + 一行说明）、有数据默认展开、点击可展开、不写 localStorage
// 图表一律替身（不引 recharts），QuotaWindowBars 走真实现。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import ProviderCard from "./ProviderCard";
import type { AccountConfig, AccountInfo, BalanceSnapshot, RefreshOutcome } from "../types";

vi.mock("./charts/lazy", () => ({
  LazyDailyUsageChart: () => <div data-testid="daily-chart" />,
  LazyModelUsageChart: () => <div data-testid="model-chart" />,
  LazyBalanceTrendChart: ({ metric = "balance" }: { metric?: "balance" | "total" }) => <div data-testid={`${metric}-chart`} />,
  LazyBalanceBreakdownChart: () => <div data-testid="breakdown-chart" />,
  LazyTokenSplitChart: () => <div data-testid="token-chart" />,
  LazyQuotaHistoryChart: () => <div data-testid="quota-history-chart" />,
}));

afterEach(cleanup);
beforeEach(() => {
  window.localStorage.clear();
});

const FUTURE = new Date(Date.now() + 3 * 3600_000).toISOString();

function account(id = "ms", kind: AccountConfig["kind"] = "modelServer", name = "ModelServer 账号"): AccountConfig {
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

function outcome(info: AccountInfo | null, id = "ms"): RefreshOutcome {
  return { accountId: id, ok: true, info, error: null };
}

function info(patch: Partial<AccountInfo> = {}): AccountInfo {
  return { extras: [], fetchedAt: "2026-10-23T04:11:36Z", ...patch };
}

function renderCard(props: { account?: AccountConfig; info?: AccountInfo | null; snapshots?: BalanceSnapshot[]; id?: string }) {
  const acc = props.account ?? account();
  const id = props.id ?? acc.id;
  return render(
    <ProviderCard
      account={acc}
      outcome={outcome(props.info === undefined ? info() : props.info, id)}
      refreshing={false}
      snapshots={props.snapshots ?? []}
      now={Date.now()}
    />,
  );
}

function tileText(selector: string): string {
  return document.querySelector(selector)?.textContent ?? "";
}

describe("ProviderCard：AiHubMix", () => {
  it("shows the USD balance, cumulative usage, and total allowance", () => {
    renderCard({
      account: account("aihubmix", "aiHubMix", "AiHubMix 账号"),
      info: info({
        balance: { amount: 150.520778, currency: "USD" },
        used: { amount: 29370.458762, currency: "USD" },
        total: { amount: 29520.97954, currency: "USD" },
      }),
    });
    expect(tileText(".kind-badge")).toBe("AiHubMix");
    expect(tileText(".balance-num")).toBe("150.52");
    expect(tileText(".balance-currency")).toBe("USD");
    expect(screen.getByText("29,370.46 USD")).toBeTruthy();
    expect(screen.getByText("29,520.98 USD")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /详情/ }));
    expect(screen.getAllByText("AiHubMix 计费接口仅提供累计用量，无按日、按模型或 Token 明细").length).toBeGreaterThan(0);
  });
});

describe("ProviderCard：订阅主指标（AC-4）", () => {
  it("weekly-only Pro shows its weekly allowance without a five-hour placeholder", () => {
    renderCard({ account: account("codex-pro-weekly", "openAiSubscription", "ChatGPT Pro"), info: info({
      balance: null, quotaWindows: [{ window: "Codex · 每周", usedPercent: 60, resetsAt: FUTURE }],
      extras: [{ key: "订阅套餐", value: "pro" }],
    }) });
    expect(tileText(".balance-num")).toBe("40");
    expect(tileText(".balance-sub")).toContain("Codex · 每周");
    expect(document.querySelectorAll(".quota-row")).toHaveLength(1);
    expect(document.body.textContent).not.toContain("5小时");
  });

  it("Codex shows the tightest subscription window, both resets, and no fabricated dollar balance", () => {
    renderCard({ account: account("codex", "openAiSubscription", "ChatGPT Pro"), info: info({
      balance: null, quotaWindows: [
        { window: "Codex · 5小时", usedPercent: 25, resetsAt: FUTURE },
        { window: "Codex · 每周", usedPercent: 60, resetsAt: FUTURE },
      ], extras: [{ key: "额外 Credits", value: "12.50" }],
    }) });
    expect(tileText(".kind-badge")).toBe("Codex 订阅");
    expect(tileText(".balance-num")).toBe("40");
    expect(tileText(".balance-sub")).toContain("Codex · 每周");
    expect(screen.getByText("Codex · 5小时")).toBeTruthy();
    expect(document.body.textContent).not.toContain("USD");
    expect(document.body.textContent).not.toContain("$0");
    fireEvent.click(screen.getByRole("button", { name: /详情/ }));
    expect(screen.getByText("额度使用历史")).toBeTruthy();
    expect(screen.queryByText("余额趋势")).toBeNull();
    expect(screen.queryByText("总额度")).toBeNull();
  });

  it("ModelServer 真实数据（余额 0 + 7d 0%）→ 订阅剩余 100%，卡片内不出现 $0", () => {
    renderCard({
      info: info({
        balance: { amount: 0, currency: "USD" },
        quotaWindows: [{ window: "7d", usedPercent: 0, resetsAt: FUTURE }],
        raw: { balance_credits: 0, max_topup: 100 },
      }),
    });

    expect(screen.getByText("订阅剩余")).toBeTruthy();
    expect(tileText(".balance-num")).toBe("100");
    expect(tileText(".balance-sub")).toContain("7d");
    expect(tileText(".balance-sub")).toContain("3小时后重置");
    // 读屏摘要给完整口径
    expect(document.querySelector(".sr-only")?.textContent).toContain("7d 已用 0%，剩余 100%");
    // 不再把误导性的 $0 当主指标
    expect(document.body.textContent).not.toContain("$0");
    expect(screen.queryByText("余额")).toBeNull();
    // 窗口进度条仍在（次级信息）
    expect(document.querySelector(".quota-bars")).toBeTruthy();
  });

  it("Kimi 数据（余额 null + 5h 26.86 / 7d 12.36）→ 最紧窗口剩余 73.14%", () => {
    renderCard({
      account: account("kimi", "moonshot", "Kimi 订阅"),
      id: "kimi",
      info: info({
        balance: null,
        quotaWindows: [
          { window: "5h", usedPercent: 26.86, resetsAt: FUTURE },
          { window: "7d", usedPercent: 12.36, resetsAt: FUTURE },
        ],
      }),
    });
    expect(screen.getByText("订阅剩余")).toBeTruthy();
    expect(tileText(".balance-num")).toBe("73.14");
    expect(tileText(".balance-sub")).toContain("5h");
  });

  it("无窗口 + 余额 12.5 → 余额仍为主指标（现状不变）", () => {
    renderCard({ info: info({ balance: { amount: 12.5, currency: "USD" } }) });
    expect(screen.getByText("余额")).toBeTruthy();
    expect(screen.queryByText("订阅剩余")).toBeNull();
    expect(document.querySelector(".sr-only")?.textContent).toBe("12.50 USD");
  });

  it("无窗口 + 余额 0 → 余额主指标 $0.00（真实信息，不误判为订阅）", () => {
    renderCard({ info: info({ balance: { amount: 0, currency: "USD" } }) });
    expect(screen.getByText("余额")).toBeTruthy();
    expect(document.body.textContent).toContain("0.00");
    expect(screen.queryByText("订阅剩余")).toBeNull();
  });

  it("余额 >0 且有窗口 → 余额主指标，窗口退居次级", () => {
    renderCard({
      info: info({ balance: { amount: 12.5, currency: "USD" }, quotaWindows: [{ window: "7d", usedPercent: 90 }] }),
    });
    expect(screen.getByText("余额")).toBeTruthy();
    expect(screen.queryByText("订阅剩余")).toBeNull();
    expect(document.querySelector(".quota-bars")).toBeTruthy();
  });

  it("raw.balance_credits > 0 → 次级行「充值余额 50」（不用「加油包」标签）", () => {
    renderCard({
      info: info({
        balance: { amount: 0, currency: "USD" },
        quotaWindows: [{ window: "7d", usedPercent: 0, resetsAt: FUTURE }],
        raw: { balance_credits: 50 },
      }),
    });
    expect(screen.getByText("充值余额")).toBeTruthy();
    expect(screen.getByText("50")).toBeTruthy();
    expect(document.body.textContent).not.toContain("加油包");
  });

  it("无余额无窗口 → 主指标「—」不崩", () => {
    renderCard({ info: info({ balance: null }) });
    expect(screen.getByText("余额")).toBeTruthy();
    expect(tileText(".balance-value")).toContain("—");
  });

  it("R19 后端对齐：extras 已下发「充值余额」时不再重复渲染同一口径", () => {
    renderCard({
      info: info({
        balance: { amount: 0, currency: "USD" },
        quotaWindows: [{ window: "7d", usedPercent: 0, resetsAt: FUTURE }],
        extras: [{ key: "充值余额", value: "50" }],
        raw: { balance_credits: 50 },
      }),
    });
    // 只有 extras 那一行，不出现第二条「充值余额」
    expect(screen.getAllByText("充值余额").length).toBe(1);
    expect(screen.getByText("订阅剩余")).toBeTruthy();
  });

  it("R19 后端对齐：窗口 usedPercent 为 null 时不崩、忽略该窗口并回落余额分支", () => {
    renderCard({
      info: info({ balance: null, quotaWindows: [{ window: "7d", usedPercent: null, resetsAt: FUTURE }] }),
    });
    expect(screen.queryByText("订阅剩余")).toBeNull();
    expect(screen.getByText("余额")).toBeTruthy();
    expect(tileText(".balance-value")).toContain("—");
  });
});

describe("ProviderCard：详情抽屉空数据默认折叠（AC-7/8/9/10）", () => {
  function openDrawer() {
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
  }

  function sectionHeads(): HTMLElement[] {
    return [...document.querySelectorAll(".chart-section-toggle")] as HTMLElement[];
  }

  function headByTitle(title: string): HTMLElement {
    const head = sectionHeads().find((h) => h.querySelector(".chart-title")?.textContent === title);
    if (!head) throw new Error(`未找到区块头：${title}`);
    return head;
  }

  it("无数据：六个区块默认折叠（aria-expanded=false），标题与一行说明可读，内容未挂载", () => {
    renderCard({ info: info({ balance: { amount: 0, currency: "USD" } }) });
    openDrawer();

    expect(sectionHeads().length).toBe(6);
    for (const head of sectionHeads()) {
      expect(head.getAttribute("aria-expanded")).toBe("false");
      expect(head.getAttribute("aria-controls")).toBeTruthy();
    }
    // 标题 + 一行说明都在（说明来自各图表现有 emptyNote）
    expect(headByTitle("近 14 天用量").textContent).toContain("该站点尚未返回用量统计");
    expect(headByTitle("余额趋势").textContent).toContain("刷新几次后会随历史快照积累出趋势线");
    // 折叠态内容不挂载 → 不进 Tab 序、图表替身不在 DOM
    expect(document.querySelector(".chart-section-body")).toBeNull();
    expect(screen.queryByTestId("daily-chart")).toBeNull();
    expect(screen.queryByTestId("balance-chart")).toBeNull();
  });

  it("有数据：默认展开（aria-expanded=true）且图表内容在 DOM；仅无数据维度折叠", () => {
    renderCard({
      info: info({
        balance: { amount: 5, currency: "USD" },
        dailyUsage: [{ date: "2026-10-20", cost: 1 }],
        modelUsage: [{ model: "gpt-4o", cost: 2 }],
      }),
      snapshots: [
        { accountId: "ms", ts: "2026-10-20T00:00:00Z", balance: 10, currency: "USD" },
        { accountId: "ms", ts: "2026-10-21T00:00:00Z", balance: 5, currency: "USD" },
      ],
    });
    openDrawer();

    expect(headByTitle("近 14 天用量").getAttribute("aria-expanded")).toBe("true");
    expect(headByTitle("模型用量 TOP 8").getAttribute("aria-expanded")).toBe("true");
    expect(headByTitle("余额趋势").getAttribute("aria-expanded")).toBe("true");
    expect(headByTitle("总额度趋势").getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("daily-chart")).toBeTruthy();
    expect(screen.getByTestId("model-chart")).toBeTruthy();
    expect(screen.getByTestId("balance-chart")).toBeTruthy();

    // token 维度：同一条 modelUsage 只有 cost 没有 token → 独立判定为无数据 → 折叠
    const tokenHead = headByTitle("Token 输入 / 输出构成");
    expect(tokenHead.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("token-chart")).toBeNull();
  });

  it("点击折叠头可展开：aria-expanded 翻转且内容出现；再点收起", () => {
    renderCard({ info: info({ balance: null }) });
    openDrawer();

    const head = headByTitle("近 14 天用量");
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("daily-chart")).toBeTruthy();
    // 展开的是空态容器（图表替身），说明文字仍可读
    expect(headByTitle("近 14 天用量").textContent).toContain("该站点尚未返回用量统计");

    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("daily-chart")).toBeNull();
  });

  it("键盘：折叠头是 button，Enter/Space 原生可切（focus 后回车）", () => {
    renderCard({ info: info({ balance: null }) });
    openDrawer();
    const head = headByTitle("模型用量 TOP 8");
    head.focus();
    expect(document.activeElement).toBe(head);
    // button 的 Enter 在 jsdom 中通过 click 事件语义等价触发
    fireEvent.keyDown(head, { key: "Enter" });
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
  });

  it("1 个快照：余额趋势折叠且说明为「已有 1 个快照」", () => {
    renderCard({
      info: info({ balance: { amount: 5, currency: "USD" } }),
      snapshots: [{ accountId: "ms", ts: "2026-10-20T00:00:00Z", balance: 10, currency: "USD" }],
    });
    openDrawer();
    expect(headByTitle("余额趋势").textContent).toContain("已有 1 个快照，再刷新一次即可成趋势");
  });

  it("AiHubMix 总额度趋势：两次真实额度记录默认展开，与余额趋势并列", () => {
    renderCard({
      account: account("aihubmix", "aiHubMix"),
      info: info({ total: { amount: 200, currency: "USD" }, balance: { amount: 10, currency: "USD" } }),
      snapshots: [
        { accountId: "aihubmix", ts: "2026-10-19T10:00:00Z", balance: 10, currency: "USD", total: 100 },
        { accountId: "aihubmix", ts: "2026-10-19T11:00:00Z", balance: 10, currency: "USD", total: 200 },
      ],
    });
    openDrawer();
    expect(headByTitle("总额度趋势").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("total-chart")).toBeTruthy();
    expect(screen.getByTestId("balance-chart")).toBeTruthy();
  });

  it("旧余额快照不计入总额度趋势，1 个新额度快照显示专属提示", () => {
    renderCard({
      info: info({ total: { amount: 100, currency: "USD" } }),
      snapshots: [
        { accountId: "ms", ts: "2026-10-19T09:00:00Z", balance: 10, currency: "USD" },
        { accountId: "ms", ts: "2026-10-19T10:00:00Z", balance: 10, currency: "USD", total: 100 },
      ],
    });
    openDrawer();
    expect(headByTitle("余额趋势").getAttribute("aria-expanded")).toBe("true");
    expect(headByTitle("总额度趋势").getAttribute("aria-expanded")).toBe("false");
    expect(headByTitle("总额度趋势").textContent).toContain("已有 1 个总额度快照，再成功刷新一次即可成趋势");
    expect(screen.queryByTestId("total-chart")).toBeNull();
  });

  it("不记忆：展开空区块后关闭并重开抽屉 → 仍默认折叠；localStorage 无新键", () => {
    renderCard({ info: info({ balance: null }) });
    const keysBefore = Object.keys(window.localStorage);
    openDrawer();
    fireEvent.click(headByTitle("近 14 天用量"));
    expect(headByTitle("近 14 天用量").getAttribute("aria-expanded")).toBe("true");
    // 关闭抽屉（ESC）
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.querySelector(".drawer-panel")).toBeNull();
    openDrawer();
    expect(headByTitle("近 14 天用量").getAttribute("aria-expanded")).toBe("false");
    expect(Object.keys(window.localStorage)).toEqual(keysBefore);
  });

  it("既有折叠不回归：附加信息 >6 行与「原始数据」默认收起仍在", () => {
    const extras = Array.from({ length: 8 }, (_, i) => ({ key: `字段${i}`, value: String(i) }));
    renderCard({ info: info({ balance: { amount: 5, currency: "USD" }, extras, raw: { ok: true } }) });
    openDrawer();
    expect(screen.getByRole("button", { name: /展开全部 8 行/ })).toBeTruthy();
    // 抽屉内的「原始数据」开关（卡片脚部还有一个同名入口，这里按容器定位）
    const rawToggle = document.querySelector(".drawer-raw .extras-toggle") as HTMLElement;
    expect(rawToggle.textContent).toContain("原始数据");
    expect(rawToggle.getAttribute("aria-expanded")).toBe("false");
  });
});
