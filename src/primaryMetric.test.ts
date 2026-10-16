// R19 主指标规则测试（规格 §1/§2 + AC-1/2/3/5）：
// 覆盖 ModelServer/Kimi 真实数据形态、余额与窗口组合、越界与降级、raw.balance_credits 读取。

import { describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOW_LABEL,
  clampPercent,
  pickPrimaryMetric,
  readBalanceCredits,
  resetCountdownText,
  tightestWindow,
  trimNumberText,
  validQuotaWindows,
} from "./primaryMetric";
import type { AccountInfo } from "./types";

const FUTURE = new Date(Date.now() + 3 * 3600_000).toISOString();
const PAST = new Date(Date.now() - 3600_000).toISOString();

function info(patch: Partial<AccountInfo>): AccountInfo {
  return { extras: [], fetchedAt: "2026-10-23T04:11:36Z", ...patch };
}

describe("primaryMetric：纯工具", () => {
  it("钳制与去尾 0 文本", () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(Number.NaN)).toBe(0);
    expect(trimNumberText(100)).toBe("100");
    expect(trimNumberText(73.14)).toBe("73.14");
    expect(trimNumberText(73.1)).toBe("73.1");
    expect(trimNumberText(0)).toBe("0");
  });

  it("有效窗口过滤 null/NaN；最紧窗口取最大值", () => {
    expect(validQuotaWindows(null)).toEqual([]);
    expect(validQuotaWindows([])).toEqual([]);
    const list = validQuotaWindows([
      { window: "5h", usedPercent: 26.86 },
      { window: "7d", usedPercent: null },
      { window: "m", usedPercent: Number.NaN },
      { window: "7d", usedPercent: 12.36 },
    ]);
    expect(list.map((w) => w.usedPercent)).toEqual([26.86, 12.36]);
    expect(tightestWindow([{ window: "5h", usedPercent: 26.86 }, { window: "7d", usedPercent: 12.36 }])?.window).toBe("5h");
    expect(tightestWindow([{ window: "5h", usedPercent: null }])).toBeNull();
  });

  it("重置倒计时：缺失 → null；未来 → N 后重置；已过期 → 已到期", () => {
    expect(resetCountdownText(null)).toBeNull();
    expect(resetCountdownText(undefined)).toBeNull();
    expect(resetCountdownText(FUTURE)).toBe("3小时后重置");
    expect(resetCountdownText(PAST)).toBe("已到期");
  });

  it("readBalanceCredits：数字/字符串正数可读，0 与非法值 → null", () => {
    expect(readBalanceCredits({ balance_credits: 50 })).toBe(50);
    expect(readBalanceCredits({ balanceCredits: 3.5 })).toBe(3.5);
    expect(readBalanceCredits({ balance_credits: "12" })).toBe(12);
    expect(readBalanceCredits({ balance_credits: 0 })).toBeNull();
    expect(readBalanceCredits({ balance_credits: "abc" })).toBeNull();
    expect(readBalanceCredits(null)).toBeNull();
    expect(readBalanceCredits("x")).toBeNull();
  });
});

describe("primaryMetric：AC-1 ModelServer / AC-2 Kimi", () => {
  it("AC-1：余额 0 + 7d 0% → quota、剩余 100%、窗口名 7d、带重置倒计时", () => {
    const metric = pickPrimaryMetric(
      info({
        balance: { amount: 0, currency: "USD" },
        quotaWindows: [{ window: "7d", usedPercent: 0, resetsAt: FUTURE }],
      }),
    );
    expect(metric.kind).toBe("quota");
    if (metric.kind !== "quota") return;
    expect(metric.remainingText).toBe("100");
    expect(metric.remainingPercent).toBe(100);
    expect(metric.windowLabel).toBe("7d");
    expect(metric.resetsText).toBe("3小时后重置");
    expect(metric.summary).toContain("7d 已用 0%，剩余 100%");
  });

  it("AC-2：余额 null + 26.86/12.36 → quota、取最紧窗口、剩余 73.14%", () => {
    const metric = pickPrimaryMetric(
      info({
        balance: null,
        quotaWindows: [
          { window: "5h", usedPercent: 26.86, resetsAt: FUTURE },
          { window: "7d", usedPercent: 12.36, resetsAt: FUTURE },
        ],
      }),
    );
    expect(metric.kind).toBe("quota");
    if (metric.kind !== "quota") return;
    expect(metric.usedPercent).toBe(26.86);
    expect(metric.remainingText).toBe("73.14");
    expect(metric.windowLabel).toBe("5h");
  });
});

describe("primaryMetric：AC-3/AC-5 余额分支与降级边界", () => {
  it("无窗口 + 余额 12.5 → balance（现状不变）", () => {
    const metric = pickPrimaryMetric(info({ balance: { amount: 12.5, currency: "USD" } }));
    expect(metric).toEqual({ kind: "balance", money: { amount: 12.5, currency: "USD" } });
  });

  it("无窗口 + 余额 0 → 仍走 balance（$0.00 属真实信息）", () => {
    const metric = pickPrimaryMetric(info({ balance: { amount: 0, currency: "USD" } }));
    expect(metric.kind).toBe("balance");
  });

  it("余额 >0 且有窗口 → 余额为主（窗口退居次级）", () => {
    const metric = pickPrimaryMetric(
      info({ balance: { amount: 12.5, currency: "USD" }, quotaWindows: [{ window: "7d", usedPercent: 90 }] }),
    );
    expect(metric.kind).toBe("balance");
  });

  it("余额 null 且无有效窗口 → none", () => {
    expect(pickPrimaryMetric(info({ balance: null })).kind).toBe("none");
    expect(pickPrimaryMetric(info({ balance: null, quotaWindows: [] })).kind).toBe("none");
    expect(pickPrimaryMetric(info({ balance: null, quotaWindows: [{ window: "7d", usedPercent: null }] })).kind).toBe("none");
    expect(pickPrimaryMetric(null).kind).toBe("none");
    expect(pickPrimaryMetric(undefined).kind).toBe("none");
  });

  it("越界钳制：-5 → 剩余 100%；150 → 剩余 0%", () => {
    const low = pickPrimaryMetric(info({ balance: null, quotaWindows: [{ window: "5h", usedPercent: -5 }] }));
    expect(low.kind).toBe("quota");
    if (low.kind === "quota") expect(low.remainingText).toBe("100");

    const high = pickPrimaryMetric(info({ balance: null, quotaWindows: [{ window: "5h", usedPercent: 150 }] }));
    expect(high.kind).toBe("quota");
    if (high.kind === "quota") {
      expect(high.usedPercent).toBe(100);
      expect(high.remainingText).toBe("0");
    }
  });

  it("全部窗口被忽略（null/NaN）→ 回落到余额分支", () => {
    const metric = pickPrimaryMetric(
      info({ balance: { amount: 8, currency: "CNY" }, quotaWindows: [{ window: "7d", usedPercent: null }, { window: "5h", usedPercent: Number.NaN }] }),
    );
    expect(metric.kind).toBe("balance");
  });

  it("窗口名缺失/空白 → 「当前窗口」；resetsAt 缺失 → 无倒计时", () => {
    const metric = pickPrimaryMetric(info({ balance: null, quotaWindows: [{ window: "  ", usedPercent: 10 }] }));
    expect(metric.kind).toBe("quota");
    if (metric.kind !== "quota") return;
    expect(metric.windowLabel).toBe(DEFAULT_WINDOW_LABEL);
    expect(metric.resetsText).toBeNull();
  });

  it("同值窗口取先出现者（判定稳定）", () => {
    const metric = pickPrimaryMetric(
      info({ balance: null, quotaWindows: [{ window: "5h", usedPercent: 50 }, { window: "7d", usedPercent: 50 }] }),
    );
    if (metric.kind === "quota") expect(metric.windowLabel).toBe("5h");
  });
});
