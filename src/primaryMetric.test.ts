// R19 主指标规则测试（规格 §1/§2 + AC-1/2/3/5）：
// 覆盖 ModelServer/Kimi 真实数据形态、余额与窗口组合、越界与降级、raw.balance_credits 读取。

import { describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOW_LABEL,
  clampPercent,
  pickPrimaryMetric,
  quotaLevel,
  readBalanceCredits,
  resetCountdownText,
  tightestWindow,
  trimNumberText,
  validQuotaWindows,
  windowLabel,
  windowUsageText,
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

// ---------- R23：限额窗口明细（浮层/菜单共用口径） ----------

describe("R23：windowLabel / quotaLevel / windowUsageText", () => {
  it("窗口名解析：缺失/空白 → 「当前窗口」", () => {
    expect(windowLabel({ window: "5h" })).toBe("5h");
    expect(windowLabel({ window: "  " })).toBe("当前窗口");
    expect(windowLabel(null)).toBe("当前窗口");
    expect(windowLabel(undefined)).toBe("当前窗口");
  });

  it("色级阈值与主卡一致：>80 红 / 60–80 琥珀 / 其余绿", () => {
    expect(quotaLevel(100.9)).toBe("err"); // 超限也算红
    expect(quotaLevel(81)).toBe("err");
    expect(quotaLevel(80)).toBe("warn");
    expect(quotaLevel(60)).toBe("warn");
    expect(quotaLevel(59.9)).toBe("ok");
  });

  it("percent 模式：已用真实值（超限 >100 不被钳制吃掉）", () => {
    const w = { window: "1d", usedPercent: 101 };
    expect(windowUsageText(w, "percent")).toBe("已用 101%");
    expect(windowUsageText({ window: "5h", usedPercent: 26.86 }, "percent")).toBe("已用 26.86%");
  });

  it("raw 模式：有金额 → 数字行；无金额 → 诚实回落 percent", () => {
    const bosc = {
      window: "1d",
      usedPercent: 101,
      usedAmount: { amount: 202, currency: "USD" },
      limitAmount: { amount: 200, currency: "USD" },
    };
    expect(windowUsageText(bosc, "raw")).toBe("已用 202.00 / 上限 200.00 USD");
    // 无金额字段（Kimi 纯百分比窗口）→ 回落
    expect(windowUsageText({ window: "5h", usedPercent: 26.86 }, "raw")).toBe("已用 26.86%");
    // 只有半个金额对 → 也回落（不产出残缺的数字行）
    expect(
      windowUsageText(
        { window: "1d", usedPercent: 50, usedAmount: { amount: 5, currency: "USD" } },
        "raw",
      ),
    ).toBe("已用 50%");
  });
});
