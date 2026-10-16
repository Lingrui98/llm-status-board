// R18 浮层交互与三态测试：mock Tauri IPC（jsdom）。
// - 三态：loading 骨架 / error 文案 / empty 文案（展示卡直注）+ 容器从 IPC 推导；
// - 交互：行点击 → summary_open_account(accountId) → hide_summary_popup；
//         指针进出 → set_summary_pointer_inside(true/false)；Escape / blur → hide_summary_popup；
// - 边界：空账号配置不崩、超长账号名不截断数据（靠 CSS 省略号 + title 全文）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import React from "react";
import SummaryPopup from "./SummaryPopup";
import SummaryCard from "./SummaryCard";
import { buildSummary } from "./summaryData";
import type { AccountConfig, RefreshOutcome } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

const mockInvoke = vi.mocked(invoke);

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined as never);
});

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

const CONFIG = {
  version: 1,
  settings: { autoRefreshSec: 0, refreshOnStart: false },
  accounts: [account("a1", "甲账号"), account("a2", "乙账号"), account("off", "停用账号", false)],
};

const OUTCOMES: RefreshOutcome[] = [
  { accountId: "a1", ok: true, info: { balance: { amount: 12.5, currency: "USD" }, extras: [], fetchedAt: new Date().toISOString() } },
  { accountId: "a2", ok: false, error: "HTTP 500：上游错误", info: null },
  { accountId: "off", ok: true, info: { balance: { amount: 999, currency: "USD" }, extras: [], fetchedAt: new Date().toISOString() } },
];

const HISTORY = {
  version: 1,
  records: [
    { accountId: "a1", date: "2026-06-14", cost: 1, currency: "USD", requests: null, inputTokens: null, outputTokens: null, tokens: null, usedTotal: null, source: "local", updatedAt: "2026-06-15T10:00:00.000Z" },
    { accountId: "a1", date: "2026-06-15", cost: 1, currency: "USD", requests: null, inputTokens: null, outputTokens: null, tokens: null, usedTotal: null, source: "local", updatedAt: "2026-06-15T10:00:00.000Z" },
  ],
};

function mockData(config: unknown = CONFIG, outcomes: unknown = OUTCOMES, history: unknown = HISTORY) {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "get_config") return Promise.resolve(config as never);
    if (cmd === "get_last_results") return Promise.resolve(outcomes as never);
    if (cmd === "get_usage_history") return Promise.resolve(history as never);
    return Promise.resolve(undefined as never);
  });
}

/** 断言某命令以指定参数被调用 */
function callsOf(cmd: string): unknown[] {
  return mockInvoke.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1]);
}

/** 按 label 找 StatTile，返回其大数字文本 */
function tileValue(label: string): string {
  const tile = [...document.querySelectorAll(".stat-tile")].find(
    (t) => t.querySelector(".stat-tile-label")?.textContent === label,
  );
  return tile?.querySelector(".stat-tile-value")?.textContent ?? "";
}

describe("SummaryCard：三态渲染", () => {
  it("加载中：两条骨架行 + 读取中文案，不渲染账号行", () => {
    render(<SummaryCard status="loading" />);
    expect(screen.getByText("用量总结")).toBeTruthy();
    expect(screen.getByText("读取中…")).toBeTruthy();
    expect(document.querySelectorAll(".summary-skeleton-row").length).toBe(2);
    expect(document.querySelectorAll(".summary-row").length).toBe(0);
  });

  it("失败：显示可执行重试提示且不抛错", () => {
    render(<SummaryCard status="error" />);
    expect(screen.getByText("读取失败，可在主窗口重试")).toBeTruthy();
    expect(document.querySelectorAll(".summary-row").length).toBe(0);
  });

  it("空：显示「尚未添加账号」纯文案（无跳转按钮）", () => {
    render(<SummaryCard status="empty" />);
    expect(screen.getByText("尚未添加账号")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("SummaryPopup：数据与总览", () => {
  it("加载后渲染总览与账号行：行数 = 启用账号数、USD/CNY 分栏、异常带原因", async () => {
    mockData();
    render(<SummaryPopup />);

    await waitFor(() => {
      expect(screen.getByText("监控账号")).toBeTruthy();
    });
    expect(document.querySelector(".summary-card")).toBeTruthy();
    expect(tileValue("监控账号")).toBe("2");
    expect(tileValue("正常 / 异常")).toBe("1 / 1");
    expect(tileValue("余额合计 · USD")).toBe("$12.50"); // 不含禁用账号的 999
    expect(tileValue("余额合计 · CNY")).toBe("¥0.00");
    // 行 = 启用账号（AC-11），禁用账号不出行
    const rows = document.querySelectorAll(".summary-row");
    expect(rows.length).toBe(2);
    expect(document.body.textContent).not.toContain("停用账号");
    // R20：成功行 = 余额规范串 `金额 币种`；失败行 = `✗ 原因`（12 字符截断）
    expect(screen.getByText("12.50 USD")).toBeTruthy();
    expect(screen.getByText("✗ HTTP 500：上游…")).toBeTruthy();
    expect(screen.getByText("本地历史 2 天")).toBeTruthy();
  });

  it("订阅账号（余额 0 USD + 7d 0%）行显示「剩余 100%（7d）」，不再显示 $0.00（R20）", async () => {
    mockData(
      { ...CONFIG, accounts: [account("ms", "etochat")] },
      [
        {
          accountId: "ms",
          ok: true,
          info: {
            balance: { amount: 0, currency: "USD" },
            quotaWindows: [{ window: "7d", usedPercent: 0 }],
            extras: [],
            fetchedAt: new Date().toISOString(),
          },
        },
      ],
      HISTORY,
    );
    render(<SummaryPopup />);
    await waitFor(() => {
      expect(screen.getByText("剩余 100%（7d）")).toBeTruthy();
    });
    const row = document.querySelector(".summary-row") as HTMLElement;
    expect(row.textContent).toContain("剩余 100%（7d）");
    expect(row.textContent).not.toContain("$0.00");
    // 总览合计仍是人民币/美元分栏口径（不受行文本影响）
    expect(tileValue("余额合计 · USD")).toBe("$0.00");
  });

  it("空配置：渲染「尚未添加账号」，不发其它命令、不崩", async () => {
    mockData({ version: 1, settings: { autoRefreshSec: 0, refreshOnStart: false }, accounts: [] });
    render(<SummaryPopup />);
    await waitFor(() => {
      expect(screen.getByText("尚未添加账号")).toBeTruthy();
    });
    expect(callsOf("hide_summary_popup")).toEqual([]);
  });

  it("IPC 失败：渲染失败文案，不抛错", async () => {
    mockInvoke.mockImplementation((cmd: string) => (cmd === "get_config" ? Promise.reject("boom") : Promise.resolve(undefined as never)));
    render(<SummaryPopup />);
    await waitFor(() => {
      expect(screen.getByText("读取失败，可在主窗口重试")).toBeTruthy();
    });
  });

  it("历史为空：显示「随刷新自动积累」而不是 0 天", async () => {
    mockData(CONFIG, OUTCOMES, { version: 1, records: [] });
    render(<SummaryPopup />);
    await waitFor(() => {
      expect(screen.getByText("本地历史随刷新自动积累")).toBeTruthy();
    });
  });
});

describe("SummaryPopup：交互接线", () => {
  it("点击账号行：先 summary_open_account(accountId)，再 hide_summary_popup", async () => {
    mockData();
    render(<SummaryPopup />);
    await waitFor(() => {
      expect(document.querySelectorAll(".summary-row").length).toBe(2);
    });

    fireEvent.click(screen.getByRole("button", { name: /甲账号/ }));

    await waitFor(() => {
      expect(callsOf("summary_open_account")).toEqual([{ accountId: "a1" }]);
    });
    await waitFor(() => {
      expect(callsOf("hide_summary_popup")).toEqual([undefined]);
    });
    // 不再额外触发主窗口以外的命令
    expect(callsOf("set_summary_pointer_inside")).toEqual([]);
  });

  it("指针进入/离开浮层：回报 inside=true / false", async () => {
    mockData();
    render(<SummaryPopup />);
    await waitFor(() => {
      expect(screen.getByText("监控账号")).toBeTruthy();
    });
    const shell = document.querySelector(".summary-shell") as HTMLElement;
    fireEvent.mouseEnter(shell);
    await waitFor(() => {
      expect(callsOf("set_summary_pointer_inside")).toEqual([{ inside: true }]);
    });
    fireEvent.mouseLeave(shell);
    await waitFor(() => {
      expect(callsOf("set_summary_pointer_inside")).toEqual([{ inside: true }, { inside: false }]);
    });
  });

  it("Escape：立即隐藏，且不触发账号跳转", async () => {
    mockData();
    render(<SummaryPopup />);
    await waitFor(() => {
      expect(screen.getByText("监控账号")).toBeTruthy();
    });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(callsOf("hide_summary_popup")).toEqual([undefined]);
    });
    expect(callsOf("summary_open_account")).toEqual([]);
    // 其它按键不触发隐藏
    fireEvent.keyDown(window, { key: "a" });
    expect(callsOf("hide_summary_popup")).toHaveLength(1);
  });

  it("窗口失焦：立即隐藏（抢焦点取舍的兜底）", async () => {
    mockData();
    render(<SummaryPopup />);
    await waitFor(() => {
      expect(screen.getByText("监控账号")).toBeTruthy();
    });
    fireEvent.blur(window);
    await waitFor(() => {
      expect(callsOf("hide_summary_popup")).toEqual([undefined]);
    });
  });

  it("窗口常驻复用不陈旧：45s 轮询会重新拉取数据", async () => {
    vi.useFakeTimers();
    try {
      mockData();
      render(<SummaryPopup />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(callsOf("get_config").length).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(45_000);
      });
      expect(callsOf("get_config").length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("超长账号名：数据不截断（全名入 DOM 与 title），靠 CSS 省略号收窄", async () => {
    const longName = "这是一个非常非常非常长的账号名称用于验证浮层行内截断表现";
    mockData({ ...CONFIG, accounts: [account("a1", longName)] }, [OUTCOMES[0]], HISTORY);
    render(<SummaryPopup />);
    const row = await screen.findByRole("button", { name: new RegExp(longName) });
    const nameEl = row.querySelector(".summary-row-name") as HTMLElement;
    expect(nameEl.textContent).toBe(longName);
    expect(nameEl.getAttribute("title")).toBe(longName);
  });

  it("键盘可达：账号行是 button，Tab 顺序在头部之后自上而下", async () => {
    mockData();
    render(<SummaryPopup />);
    await waitFor(() => {
      expect(document.querySelectorAll(".summary-row").length).toBe(2);
    });
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBe(2);
    expect(buttons[0].textContent).toContain("甲账号");
    expect(buttons[1].textContent).toContain("乙账号");
  });
});

describe("summaryData 与展示卡接线", () => {
  it("ready 状态注入视图模型后一次性渲染总览/行/底部", () => {
    const view = buildSummary({
      accounts: [account("a1", "甲账号")],
      outcomes: [{ accountId: "a1", ok: true, info: { balance: { amount: 5, currency: "USD" }, extras: [], fetchedAt: new Date().toISOString() } }],
      historyRecords: [],
      now: Date.now(),
    });
    render(<SummaryCard status="ready" data={view} />);
    // R20：总览合计仍用 $ 前缀；账号行改为统一规范串 `金额 币种`
    expect(tileValue("余额合计 · USD")).toBe("$5.00");
    expect(screen.getByText("5.00 USD")).toBeTruthy();
    expect(screen.getByText("刚刚")).toBeTruthy();
    expect(screen.getByText("本地历史随刷新自动积累")).toBeTruthy();
  });
});
