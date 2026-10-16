// R20 黄金用例表（docs/round-20-plan.md §3）——**逐字嵌入**规格表，供跨语言机械比对。
// 期望字符串必须与规格 §3 完全一致；Rust 侧（src-tauri/src/primary_metric.rs 测试）用同一张表的同样期望值。
// 本文件断言前端浮层的**唯一出口** `summaryRowText()`（失败 → pickPrimaryMetric 规范串 → 无数据）。

import { describe, expect, it } from "vitest";
import type { AccountInfo, Money, QuotaWindow, RefreshOutcome } from "../types";
import { formatFailureLine, formatPrimaryMetricLine, pickPrimaryMetric, truncateFailureReason } from "../primaryMetric";
import { summaryRowText } from "./summaryData";

interface GoldenCase {
  id: string;
  /** 规格 §3「输入」列（balance / quotaWindows / 结果态） */
  balance: Money | null;
  quotaWindows: QuotaWindow[] | null;
  /** 结果态：默认 ok=true；G10 为 false */
  ok?: boolean;
  error?: string | null;
  /** 规格 §3「期望规范串」列（逐字） */
  expected: string;
}

function makeInfo(c: GoldenCase): AccountInfo | null {
  // G11：info 为 null（未刷新 / 无数据）
  if (c.balance === null && c.quotaWindows === null) return null;
  return {
    balance: c.balance,
    quotaWindows: c.quotaWindows,
    extras: [],
    fetchedAt: "2026-10-23T04:11:36Z",
  };
}

/**
 * R20 黄金表（G1..G12）—— **逐字**取自 docs/round-20-plan.md §3，勿手改期望值。
 */
export const R20_GOLDEN_TABLE: GoldenCase[] = [
  { id: "G1", balance: { amount: 0, currency: "USD" }, quotaWindows: [{ window: "7d", usedPercent: 0 }], expected: "剩余 100%（7d）" },
  {
    id: "G2",
    balance: null,
    quotaWindows: [
      { window: "5h", usedPercent: 26.86 },
      { window: "7d", usedPercent: 12.36 },
    ],
    expected: "剩余 73.14%（5h）",
  },
  { id: "G3", balance: { amount: 12.5, currency: "USD" }, quotaWindows: [{ window: "7d", usedPercent: 90 }], expected: "12.50 USD" },
  { id: "G4", balance: { amount: 0, currency: "USD" }, quotaWindows: [], expected: "0.00 USD" },
  { id: "G5", balance: null, quotaWindows: [], expected: "—" },
  {
    id: "G6",
    balance: { amount: 0, currency: "USD" },
    quotaWindows: [
      { window: "7d", usedPercent: null },
      { window: "5h", usedPercent: Number.NaN },
    ],
    expected: "0.00 USD",
  },
  { id: "G7", balance: null, quotaWindows: [{ window: "", usedPercent: 20 }], expected: "剩余 80%（当前窗口）" },
  { id: "G8", balance: null, quotaWindows: [{ window: "7d", usedPercent: -5 }], expected: "剩余 100%（7d）" },
  { id: "G9", balance: null, quotaWindows: [{ window: "7d", usedPercent: 150 }], expected: "剩余 0%（7d）" },
  {
    id: "G10",
    balance: null,
    quotaWindows: null,
    ok: false,
    error: "连接超时：无法访问上游中转站（TLS 握手失败）",
    expected: "✗ 连接超时：无法访问上游…",
  },
  { id: "G11", balance: null, quotaWindows: null, expected: "—" },
  { id: "G12", balance: { amount: 0.5, currency: "USD" }, quotaWindows: [], expected: "0.5000 USD" },
];

function outcomeOf(c: GoldenCase, accountId = "acc"): RefreshOutcome {
  if (c.ok === false) {
    return { accountId, ok: false, info: null, error: c.error ?? null };
  }
  return { accountId, ok: true, info: makeInfo(c), error: null };
}

describe("R20 黄金表（前端出口 summaryRowText，逐字对齐规格 §3）", () => {
  it("表本身包含 G1..G12 且 id 连续（防止漏抄）", () => {
    expect(R20_GOLDEN_TABLE.map((c) => c.id)).toEqual([
      "G1",
      "G2",
      "G3",
      "G4",
      "G5",
      "G6",
      "G7",
      "G8",
      "G9",
      "G10",
      "G11",
      "G12",
    ]);
  });

  for (const c of R20_GOLDEN_TABLE) {
    it(`${c.id} → ${c.expected}`, () => {
      expect(summaryRowText(outcomeOf(c))).toBe(c.expected);
    });
  }

  it("ModelServer 真实形态（balance 0 USD + [7d 0%]）产出「剩余 100%（7d）」，不是 $0.00", () => {
    const c = R20_GOLDEN_TABLE[0];
    const text = summaryRowText({ accountId: "etochat", ok: true, info: makeInfo(c), error: null });
    expect(text).toBe("剩余 100%（7d）");
    expect(text).not.toContain("$");
  });

  it("失败优先级高于余额/窗口（结果层 ok=false 时忽略 info）", () => {
    const withInfo: RefreshOutcome = {
      accountId: "a",
      ok: false,
      info: { balance: { amount: 12.5, currency: "USD" }, quotaWindows: [{ window: "7d", usedPercent: 90 }], extras: [], fetchedAt: "2026-10-23T04:11:36Z" },
      error: "连接超时：无法访问上游中转站（TLS 握手失败）",
    };
    expect(summaryRowText(withInfo)).toBe("✗ 连接超时：无法访问上游…");
  });

  it("AC-8 主卡片 token 与规范串同名 token 逐字一致（G1/G2）", () => {
    for (const c of R20_GOLDEN_TABLE.filter((x) => x.id === "G1" || x.id === "G2")) {
      const metric = pickPrimaryMetric(makeInfo(c));
      expect(metric.kind).toBe("quota");
      if (metric.kind !== "quota") continue;
      const line = formatPrimaryMetricLine(metric);
      expect(line).toBe(`剩余 ${metric.remainingText}%（${metric.windowLabel}）`);
      expect(line).toBe(c.expected);
    }
  });
});

// §3 附注（PM 已与 Rust 双侧核对，作为**独立断言**，不扩 12 行黄金主表）
describe("R20 §3 附注：失败原因边界与码点截断规则", () => {
  const err = (reason: string | null | undefined) => formatFailureLine(reason);

  it("原因缺失/空白 → `刷新失败`（对齐 Rust：unwrap_or + trim 后空判）", () => {
    expect(err(null)).toBe("✗ 刷新失败");
    expect(err(undefined)).toBe("✗ 刷新失败");
    expect(err("")).toBe("✗ 刷新失败");
    expect(err("   ")).toBe("✗ 刷新失败");
    expect(err("\t\n")).toBe("✗ 刷新失败");
  });

  it("先 trim 再截断（首尾空白不进入规范串）", () => {
    expect(err("  连接超时  ")).toBe("✗ 连接超时");
    expect(err("  连接超时：无法访问上游中转站（TLS 握手失败）  ")).toBe("✗ 连接超时：无法访问上游…");
  });

  it("12 字符边界：≤12 原样、13 起按 11 码点 + `…`", () => {
    expect(err("123456789012")).toBe("✗ 123456789012");
    expect(err("1234567890123")).toBe("✗ 12345678901…");
    expect(Array.from(truncateFailureReason("1234567890123")).length).toBe(12);
  });

  it("码点计数：非 BMP 字符按 1 个字符算（对齐 Rust chars()）", () => {
    const emoji = "😀".repeat(13); // 26 个 UTF-16 码元，但是 13 个码点
    expect(truncateFailureReason(emoji)).toBe(`${"😀".repeat(11)}…`);
    expect(Array.from(truncateFailureReason(emoji)).length).toBe(12);
  });
});
