// R18 浮层纯视图模型测试：行/状态/合计/截断/历史天数/相对时间阶梯，全部注水、不依赖时区。

import { describe, expect, it } from "vitest";
import {
  REASON_MAX_CHARS,
  balanceText,
  buildSummary,
  countHistoryDays,
  formatLastRefresh,
  tightestQuotaPercent,
  truncateText,
} from "./summaryData";
import type { AccountConfig, RefreshOutcome, UsageRecord } from "../types";

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

function rec(date: string): UsageRecord {
  return {
    accountId: "a1",
    date,
    cost: 1,
    currency: "USD",
    requests: null,
    inputTokens: null,
    outputTokens: null,
    tokens: null,
    usedTotal: null,
    source: "local",
    updatedAt: "2026-06-15T10:00:00.000Z",
  };
}

const NOW = new Date("2026-06-15T12:00:00.000Z").getTime();

describe("summaryData：格式化与截断", () => {
  it("余额文本带币种前缀；未知币种退化为代码后缀", () => {
    expect(balanceText({ amount: 12.5, currency: "USD" })).toBe("$12.50");
    expect(balanceText({ amount: 56.75, currency: "CNY" })).toBe("¥56.75");
    expect(balanceText({ amount: 3, currency: "EUR" })).toBe("3.00 EUR");
    expect(balanceText(null)).toBeNull();
  });

  it("最紧配额窗口取最大值并 clamp 到 0–100；无有效窗口 → null", () => {
    expect(tightestQuotaPercent([{ window: "5h", usedPercent: 40 }, { window: "7d", usedPercent: 88.4 }])).toBe(88.4);
    expect(tightestQuotaPercent([{ window: "5h", usedPercent: 140 }])).toBe(100);
    expect(tightestQuotaPercent([{ window: "5h", usedPercent: -5 }])).toBe(0);
    expect(tightestQuotaPercent([{ window: "5h", usedPercent: null }])).toBeNull();
    expect(tightestQuotaPercent([])).toBeNull();
    expect(tightestQuotaPercent(undefined)).toBeNull();
  });

  it("异常原因按 24 字符截断（含省略号），短文本原样", () => {
    expect(REASON_MAX_CHARS).toBe(24);
    expect(truncateText("HTTP 500")).toBe("HTTP 500");
    const long = "a".repeat(40);
    expect(truncateText(long)).toBe(`${"a".repeat(24)}…`);
    expect(truncateText(long).length).toBe(25);
  });

  it("最后刷新相对时间阶梯：<1min 刚刚 / <60min 分钟 / <48h 小时 / 否则日期", () => {
    const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
    expect(formatLastRefresh(at(30_000), NOW)).toBe("刚刚");
    expect(formatLastRefresh(at(5 * 60_000), NOW)).toBe("5 分钟前");
    expect(formatLastRefresh(at(59 * 60_000), NOW)).toBe("59 分钟前");
    expect(formatLastRefresh(at(3 * 3_600_000), NOW)).toBe("3 小时前");
    expect(formatLastRefresh(at(47 * 3_600_000), NOW)).toBe("47 小时前");
    // ≥48h → 本地日期（用本地日期拼期望值，不依赖运行时时区）
    const old = new Date(NOW - 72 * 3_600_000);
    const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
    expect(formatLastRefresh(old.toISOString(), NOW)).toBe(
      `${old.getFullYear()}-${pad(old.getMonth() + 1)}-${pad(old.getDate())}`,
    );
    expect(formatLastRefresh(null, NOW)).toBe("—");
  });

  it("本地历史天数按日期去重", () => {
    expect(countHistoryDays([])).toBe(0);
    expect(countHistoryDays([rec("2026-06-14"), rec("2026-06-14"), rec("2026-06-15")])).toBe(2);
  });
});

describe("summaryData：视图模型", () => {
  const accounts = [account("a1", "甲账号"), account("a2", "乙账号"), account("off", "停用账号", false)];
  const outcomes: RefreshOutcome[] = [
    { accountId: "a1", ok: true, info: { balance: { amount: 12.5, currency: "USD" }, extras: [], fetchedAt: "2026-06-15T11:57:00.000Z" } },
    { accountId: "a2", ok: false, error: "HTTP 500: 服务端返回了非常长的错误说明文字用于验证截断", info: null },
    { accountId: "off", ok: true, info: { balance: { amount: 999, currency: "USD" }, extras: [], fetchedAt: "2026-06-15T11:00:00.000Z" } },
  ];

  it("行 = 启用账号（禁用不出行），状态计数与「监控账号数」一致", () => {
    const view = buildSummary({ accounts, outcomes, historyRecords: [], now: NOW });
    expect(view.total).toBe(2);
    expect(view.rows.map((r) => r.accountId)).toEqual(["a1", "a2"]);
    expect(view.okCount).toBe(1);
    expect(view.failCount).toBe(1);
    expect(view.idleCount).toBe(0);
  });

  it("合计只统计启用账号且 USD/CNY 分栏（绝不跨币种相加）", () => {
    const view = buildSummary({
      accounts,
      outcomes: [
        { accountId: "a1", ok: true, info: { balance: { amount: 12.5, currency: "USD" }, extras: [], fetchedAt: "2026-06-15T11:57:00.000Z" } },
        { accountId: "a2", ok: true, info: { balance: { amount: 56.75, currency: "CNY" }, extras: [], fetchedAt: "2026-06-15T11:58:00.000Z" } },
        { accountId: "off", ok: true, info: { balance: { amount: 999, currency: "USD" }, extras: [], fetchedAt: "2026-06-15T11:00:00.000Z" } },
      ],
      historyRecords: [],
      now: NOW,
    });
    expect(view.usdText).toBe("$12.50");
    expect(view.cnyText).toBe("¥56.75");
    // 禁用账号的 999 USD 不进入合计
    expect(view.usdText).not.toContain("1011");
  });

  it("无刷新结果 → 未刷新状态、数值占位、刷新时间占位", () => {
    const view = buildSummary({ accounts: [account("a1", "甲账号")], outcomes: [], historyRecords: [], now: NOW });
    expect(view.rows[0].status).toBe("idle");
    expect(view.rows[0].valueText).toBe("—");
    expect(view.rows[0].detailText).toBeNull();
    expect(view.idleCount).toBe(1);
    expect(view.lastRefreshText).toBe("—");
  });

  it("异常行带截断原因；成功行无原因", () => {
    const view = buildSummary({ accounts, outcomes, historyRecords: [], now: NOW });
    const longErr = "HTTP 500: 服务端返回了非常长的错误说明文字用于验证截断";
    const errRow = view.rows.find((r) => r.accountId === "a2");
    expect(errRow?.status).toBe("err");
    expect(errRow?.detailText).toBe(truncateText(longErr));
    expect(errRow?.detailText).toBe(`${longErr.slice(0, REASON_MAX_CHARS)}…`);
    expect((errRow?.detailText ?? "").length).toBe(REASON_MAX_CHARS + 1);
    expect(view.rows.find((r) => r.accountId === "a1")?.detailText).toBeNull();
  });

  it("无余额时退化为最紧配额窗口百分比", () => {
    const view = buildSummary({
      accounts: [account("a1", "配额账号")],
      outcomes: [
        {
          accountId: "a1",
          ok: true,
          info: { balance: null, quotaWindows: [{ window: "5h", usedPercent: 88.4 }], extras: [], fetchedAt: "2026-06-15T11:58:00.000Z" },
        },
      ],
      historyRecords: [],
      now: NOW,
    });
    expect(view.rows[0].valueText).toBe("88%");
  });

  it("最后刷新取启用账号里最新的 fetchedAt；历史天数来自记录去重", () => {
    const view = buildSummary({
      accounts,
      outcomes,
      historyRecords: [rec("2026-06-14"), rec("2026-06-15"), rec("2026-06-15")],
      now: NOW,
    });
    expect(view.lastRefreshText).toBe("3 分钟前"); // 11:57 vs now 12:00
    expect(view.historyDays).toBe(2);
  });

  it("空配置不崩：行空、合计 $0.00 / ¥0.00、历史 0 天", () => {
    const view = buildSummary({ accounts: [], outcomes: [], historyRecords: [], now: NOW });
    expect(view.total).toBe(0);
    expect(view.rows).toEqual([]);
    expect(view.usdText).toBe("$0.00");
    expect(view.cnyText).toBe("¥0.00");
    expect(view.historyDays).toBe(0);
  });
});
