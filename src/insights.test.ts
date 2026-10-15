import { describe, expect, it } from "vitest";
import {
  DEFAULT_INSIGHT_WINDOW_DAYS,
  buildInsightReport,
  fastestRisk,
  fastestSummaryText,
  formatBurnRate,
  formatDaysLeft,
  normalizeCurrency,
  resolveInsightWindowDays,
  shouldSkipCurrency,
} from "./insights";
import type { AccountInsight } from "./insights";
import type { AppConfig, BalanceSnapshot, RefreshOutcome, Settings } from "./types";

const NOW = new Date("2026-06-15T12:00:00.000Z");

const NAMES: Record<string, string> = {
  "acc-usd": "美元账号",
  "acc-cny": "人民币账号",
  "acc-kimi": "Kimi 订阅",
};

function snap(accountId: string, iso: string, balance: number, currency = "USD"): BalanceSnapshot {
  return { ts: iso, accountId, balance, currency };
}

function ok(accountId: string): RefreshOutcome {
  return { accountId, ok: true, info: null, error: null };
}

/** 本地正午时间戳（YYYY-MM-DD → 本地 12:00），用于「当月 1 日 / N 日」这类本地日历断言 */
function localNoon(date: string, hour = 12): string {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`非法日期：${date}`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, 0, 0).toISOString();
}

function report(
  snapshots: BalanceSnapshot[],
  outcomes: RefreshOutcome[] = [],
  now: Date = NOW,
  windowDays?: number,
) {
  return buildInsightReport(snapshots, outcomes, { now, windowDays, names: NAMES });
}

function group(rep: ReturnType<typeof buildInsightReport>, accountId: string, currency?: string): AccountInsight {
  const found = rep.accounts.filter(
    (a) => a.accountId === accountId && (currency === undefined || a.currency === currency),
  );
  expect(found).toHaveLength(1);
  return found[0];
}

describe("insights：币种工具", () => {
  it("归一化与跳过判定（credits 大小写、空白、空值）", () => {
    expect(normalizeCurrency(" usd ")).toBe("USD");
    expect(normalizeCurrency("cny")).toBe("CNY");
    expect(normalizeCurrency(null)).toBe("UNKNOWN");
    expect(normalizeCurrency("")).toBe("UNKNOWN");
    expect(shouldSkipCurrency("credits")).toBe(true);
    expect(shouldSkipCurrency("CREDIT")).toBe(true);
    expect(shouldSkipCurrency("USD")).toBe(false);
  });

  it("窗口天数解析：缺省 14，越界与非数字回退默认", () => {
    expect(resolveInsightWindowDays(null)).toBe(DEFAULT_INSIGHT_WINDOW_DAYS);
    expect(resolveInsightWindowDays({ autoRefreshSec: 0, refreshOnStart: false })).toBe(14);
    expect(resolveInsightWindowDays({ autoRefreshSec: 0, refreshOnStart: false, insightWindowDays: 30 })).toBe(30);
    expect(resolveInsightWindowDays({ autoRefreshSec: 0, refreshOnStart: false, insightWindowDays: 2 })).toBe(14);
    expect(resolveInsightWindowDays({ autoRefreshSec: 0, refreshOnStart: false, insightWindowDays: 999 })).toBe(14);
  });
});

describe("insights：burn rate 与可支撑天数", () => {
  it("正常下降：窗口内 100→50 跨度 2 天 → 25/天，余额 50 → 2 天", () => {
    const rep = report([
      snap("acc-usd", "2026-06-10T12:00:00.000Z", 100),
      snap("acc-usd", "2026-06-12T12:00:00.000Z", 50),
    ]);
    const g = group(rep, "acc-usd");
    expect(g.burnRate).toBeCloseTo(25, 10);
    expect(g.daysLeft).toBeCloseTo(2, 10);
    expect(g.totalDrop).toBe(50);
    expect(g.spanDays).toBeCloseTo(2, 10);
    expect(g.snapshotCount).toBe(2);
    expect(g.series).toEqual([100, 50]);
    expect(g.reason).toBeNull();
    expect(Number.isFinite(g.burnRate as number)).toBe(true);
  });

  it("充值反弹（AC-3）：100→50→80→40 跨度 2 天 → 45/天，不出现负值", () => {
    const rep = report([
      snap("acc-usd", "2026-06-10T00:00:00.000Z", 100),
      snap("acc-usd", "2026-06-10T16:00:00.000Z", 50),
      snap("acc-usd", "2026-06-11T08:00:00.000Z", 80),
      snap("acc-usd", "2026-06-12T00:00:00.000Z", 40),
    ]);
    const g = group(rep, "acc-usd");
    expect(g.totalDrop).toBeCloseTo(90, 10); // 50（100→50）+ 40（80→40），充值 30 不计
    expect(g.spanDays).toBeCloseTo(2, 10);
    expect(g.burnRate).toBeCloseTo(45, 10);
    expect(g.burnRate as number).toBeGreaterThan(0);
    expect(g.daysLeft).toBeCloseTo(40 / 45, 6);
  });

  it("单快照 → burnRate/daysLeft 为 null，reason=insufficientData，无 Infinity/NaN", () => {
    const rep = report([snap("acc-usd", "2026-06-14T12:00:00.000Z", 42)]);
    const g = group(rep, "acc-usd");
    expect(g.burnRate).toBeNull();
    expect(g.daysLeft).toBeNull();
    expect(g.reason).toBe("insufficientData");
    expect(g.currentBalance).toBe(42);
    expect(g.snapshotCount).toBe(1);
    expect(Number.isFinite(g.totalDrop)).toBe(true);
    expect(Number.isFinite(g.spanDays)).toBe(true);
  });

  it("零消耗（余额不变）→ burnRate/daysLeft 为 null，reason=noSpend，不出现除零", () => {
    const rep = report([
      snap("acc-usd", "2026-06-10T12:00:00.000Z", 30),
      snap("acc-usd", "2026-06-13T12:00:00.000Z", 30),
    ]);
    const g = group(rep, "acc-usd");
    expect(g.burnRate).toBeNull();
    expect(g.daysLeft).toBeNull();
    expect(g.reason).toBe("noSpend");
    expect(g.totalDrop).toBe(0);
    expect(g.daysLeft === null || Number.isFinite(g.daysLeft)).toBe(true);
  });

  it("窗口内无快照 / 空输入 → 报告整体为空且不崩（无 NaN）", () => {
    const empty = report([]);
    expect(empty.accounts).toEqual([]);
    expect(empty.projections).toEqual([]);
    expect(empty.fastest).toEqual([]);
    expect(empty.hasData).toBe(false);
    expect(empty.generatedAt).toBe(NOW.toISOString());

    // 快照早于窗口（默认 14 天；NOW = 2026-06-15）→ 窗口内 0 条，降级为 insufficientData
    const stale = report([snap("acc-usd", "2026-05-20T12:00:00.000Z", 100)]);
    expect(stale.accounts).toHaveLength(1);
    expect(stale.accounts[0].snapshotCount).toBe(0);
    expect(stale.accounts[0].burnRate).toBeNull();
    expect(stale.accounts[0].currentBalance).toBeNull();
    expect(stale.accounts[0].reason).toBe("insufficientData");
    expect(stale.hasData).toBe(false);
  });

  it("未来时间戳的快照不计入窗口（时钟偏差防御）", () => {
    const rep = report([
      snap("acc-usd", "2026-06-20T12:00:00.000Z", 100), // 晚于注入的 now
      snap("acc-usd", "2026-06-12T12:00:00.000Z", 50),
    ]);
    expect(rep.accounts[0].snapshotCount).toBe(1);
    expect(rep.accounts[0].burnRate).toBeNull();
  });
});

describe("insights：币种分组与跳过", () => {
  it("USD 与 CNY 不混算，各自独立成组（AC 跨币种）", () => {
    const rep = report([
      snap("acc-usd", "2026-06-10T12:00:00.000Z", 100, "USD"),
      snap("acc-usd", "2026-06-12T12:00:00.000Z", 50, "USD"),
      snap("acc-cny", "2026-06-10T12:00:00.000Z", 70, "CNY"),
      snap("acc-cny", "2026-06-12T12:00:00.000Z", 40, "CNY"),
    ]);
    const usd = group(rep, "acc-usd", "USD");
    const cny = group(rep, "acc-cny", "CNY");
    expect(usd.burnRate).toBeCloseTo(25, 10);
    expect(cny.burnRate).toBeCloseTo(15, 10);
    expect(rep.accounts).toHaveLength(2);
    // 本月预计支出按币种分别出数，绝不合并（USD、CNY 各一行）
    expect(rep.projections.map((p) => p.currency)).toEqual(["CNY", "USD"]);
  });

  it("统一账号多币种 → 拆成两个独立组，不互相污染", () => {
    const rep = report([
      snap("acc-usd", "2026-06-10T12:00:00.000Z", 100, "USD"),
      snap("acc-usd", "2026-06-12T12:00:00.000Z", 90, "USD"),
      snap("acc-usd", "2026-06-10T12:00:00.000Z", 200, "CNY"),
      snap("acc-usd", "2026-06-12T12:00:00.000Z", 100, "CNY"),
    ]);
    expect(group(rep, "acc-usd", "USD").totalDrop).toBe(10);
    expect(group(rep, "acc-usd", "CNY").totalDrop).toBe(100);
  });

  it("credits 订阅账号整组跳过并给出原因（AC-4）", () => {
    const rep = report(
      [
        snap("acc-kimi", "2026-06-10T12:00:00.000Z", 1000, "credits"),
        snap("acc-kimi", "2026-06-12T12:00:00.000Z", 400, "credits"),
        snap("acc-usd", "2026-06-10T12:00:00.000Z", 100, "USD"),
        snap("acc-usd", "2026-06-12T12:00:00.000Z", 50, "USD"),
      ],
      [],
      NOW,
    );
    expect(rep.accounts.map((a) => a.accountId)).toEqual(["acc-usd"]);
    expect(rep.skipped).toEqual([{ accountId: "acc-kimi", currency: "CREDITS", reason: "nonFiat" }]);
    // 跳过组不参与本月预计支出
    expect(rep.projections.map((p) => p.currency)).toEqual(["USD"]);
  });
});

describe("insights：本月预计支出", () => {
  it("AC-11：当月 1 日 100 → 15 日 70（当月 30 天）→ monthDrop=30、burnRate=30/14、预计 ≈62.1", () => {
    const now = new Date(localNoon("2026-06-15")); // 6 月 30 天
    const rep = report(
      [snap("acc-usd", localNoon("2026-06-01"), 100), snap("acc-usd", localNoon("2026-06-15"), 70)],
      [],
      now,
    );
    const g = group(rep, "acc-usd");
    expect(g.burnRate).toBeCloseTo(30 / 14, 6);
    expect(g.burnRate).toBeCloseTo(2.142857, 6);
    const p = rep.projections[0];
    expect(p.currency).toBe("USD");
    expect(p.monthDrop).toBe(30);
    expect(p.elapsedSpend).toBe(30);
    expect(p.monthDaysElapsed).toBe(15);
    expect(p.remainingDays).toBe(15); // 6 月 30 天 − 15
    // projected = monthDrop + burnRate × remainingDays = 30 + (30/14)×15
    expect(p.projectedRemaining).toBeCloseTo((30 / 14) * 15, 6);
    expect(p.projectedTotal).toBeCloseTo(30 + (30 / 14) * 15, 6);
    expect(p.projectedTotal).toBeCloseTo(62.14, 2);
    expect(p.degraded).toBe(false);
  });

  it("当月 2 条快照 → monthDrop=下降额、remainingDays=当月剩余天数（AC-11 口径）", () => {
    const now = new Date(localNoon("2026-06-20")); // 6 月 30 天
    const rep = report(
      [snap("acc-usd", localNoon("2026-06-18"), 100), snap("acc-usd", localNoon("2026-06-20"), 80)],
      [],
      now,
    );
    const p = rep.projections[0];
    expect(p.monthDrop).toBe(20); // 当月内 100 → 80
    expect(p.monthDaysElapsed).toBe(20);
    expect(p.remainingDays).toBe(10); // 30 − 20
    expect(p.projectedRemaining).toBeCloseTo(10 * 10, 6); // 账户级 burnRate=10/天（2 天降 20）
    expect(p.projectedTotal).toBeCloseTo(20 + 100, 6);
    expect(p.degraded).toBe(false);
  });

  it("同一币种多账号：monthDrop 求和 + burnRate 求和 × remainingDays", () => {
    const now = new Date(localNoon("2026-06-15"));
    const rep = report(
      [
        // a：2 天降 20 → 10/天
        snap("acc-a", localNoon("2026-06-13"), 100),
        snap("acc-a", localNoon("2026-06-15"), 80),
        // b：2 天降 40 → 20/天
        snap("acc-b", localNoon("2026-06-13"), 200),
        snap("acc-b", localNoon("2026-06-15"), 160),
      ],
      [],
      now,
    );
    const p = rep.projections[0];
    expect(p.currency).toBe("USD");
    expect(p.accountCount).toBe(2);
    expect(p.monthDrop).toBe(60); // 20 + 40
    expect(p.projectedRemaining).toBeCloseTo(30 * 15, 6); // (10 + 20) × 15
    expect(p.projectedTotal).toBeCloseTo(60 + 450, 6);
    expect(p.degraded).toBe(false);
  });

  it("退化②：账户级 burnRate=null 但有已发生消耗 → projectedRemaining=0、degraded=true", () => {
    const now = new Date(localNoon("2026-06-15"));
    // 当月 2 条快照但只相隔 6 小时（跨度 < 12 小时）→ burnRate 降级为 null；
    // 当月仍有下降段 → monthDrop=25 > 0，因此该币种仍产出 projection 且 degraded=true
    const rep = report(
      [snap("acc-usd", localNoon("2026-06-15", 6), 100), snap("acc-usd", localNoon("2026-06-15", 12), 75)],
      [],
      now,
    );
    const g = group(rep, "acc-usd");
    expect(g.burnRate).toBeNull();
    expect(g.reason).toBe("insufficientData");
    expect(rep.projections).toHaveLength(1);
    const p = rep.projections[0];
    expect(p.monthDrop).toBe(25);
    expect(p.elapsedSpend).toBe(25);
    expect(p.degraded).toBe(true);
    expect(p.projectedRemaining).toBe(0);
    expect(p.projectedTotal).toBe(25);
  });

  it("退化②变体：当月 2 条快照但零消耗 → monthDrop=0 且 burnRate=null → 该币种不产出 projection", () => {
    const now = new Date(localNoon("2026-06-15"));
    const rep = report(
      [snap("acc-usd", localNoon("2026-06-13"), 50), snap("acc-usd", localNoon("2026-06-15"), 50)],
      [],
      now,
    );
    expect(group(rep, "acc-usd").burnRate).toBeNull(); // 无消耗
    expect(rep.projections).toEqual([]); // 无速率且无已发生 → 跳过
  });

  it("退化①：只有单条快照、无速率也无已发生 → 不产出 projection", () => {
    const now = new Date(localNoon("2026-06-15"));
    const rep = report([snap("acc-usd", localNoon("2026-06-15"), 42)], [], now);
    expect(group(rep, "acc-usd").burnRate).toBeNull();
    expect(rep.projections).toEqual([]);
  });

  it("分支③：当月仅 1 条快照但窗口内有 burnRate → 仍正常外推（degraded=false）", () => {
    const now = new Date(localNoon("2026-06-15"));
    // 两条都在窗口内的月末 → 当月 2 条，正常外推
    const inMonth = report(
      [snap("acc-usd", localNoon("2026-06-13"), 100), snap("acc-usd", localNoon("2026-06-15"), 70)],
      [],
      now,
    );
    expect(inMonth.projections[0].monthDrop).toBe(30);
    expect(inMonth.projections[0].remainingDays).toBe(15);
    expect(inMonth.projections[0].projectedRemaining).toBeCloseTo((30 / 2) * 15, 6);
    expect(inMonth.projections[0].degraded).toBe(false);

    // 另一条落在上个月（now 的 15 天前，同一时刻减法保证两侧都是本地正午）→ 当月只有 1 条快照
    const nowInstant = new Date(localNoon("2026-06-15")).getTime();
    const prevTs = new Date(nowInstant - 15 * 86_400_000).toISOString(); // 跨月且超出默认 14 天窗口
    const crossMonth = report(
      [snap("acc-usd", prevTs, 100), snap("acc-usd", localNoon("2026-06-15"), 70)],
      [],
      now,
      30, // 放宽窗口才能看到跨月那条
    );
    const g = group(crossMonth, "acc-usd");
    const spanDays = (nowInstant - new Date(prevTs).getTime()) / 86_400_000;
    expect(spanDays).toBeGreaterThan(14);
    expect(g.burnRate).not.toBeNull();
    const p = crossMonth.projections[0];
    // 当月只有 1 条 → monthDrop=0，但 burnRate 可用 → 仍按 burnRate × remainingDays 外推
    expect(p.monthDrop).toBe(0);
    expect(p.degraded).toBe(false);
    expect(p.projectedRemaining).toBeCloseTo((30 / spanDays) * 15, 1);
    expect(p.projectedRemaining as number).toBeGreaterThan(0);
  });

  it("预计支出不会因为负的外推出现负数", () => {
    const rep = report([
      snap("acc-usd", "2026-06-10T12:00:00.000Z", 100),
      snap("acc-usd", "2026-06-12T12:00:00.000Z", 50),
    ]);
    for (const p of rep.projections) {
      expect(p.projectedTotal).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(p.projectedTotal)).toBe(true);
    }
  });
});

describe("insights：消耗最快账号与风险色", () => {
  it("同币种多账号取 burnRate 最大者（AC-12）", () => {
    const rep = report([
      // 慢：100 → 50（2 天）→ 25/天，余额 50 → 2 天
      snap("acc-usd", "2026-06-10T12:00:00.000Z", 100),
      snap("acc-usd", "2026-06-12T12:00:00.000Z", 50),
      // 快：100 → 80（2 天）→ 10/天，余额 80 → 8 天
      snap("acc-cny", "2026-06-10T12:00:00.000Z", 100, "CNY"),
      snap("acc-cny", "2026-06-12T12:00:00.000Z", 80, "CNY"),
    ]);
    expect(rep.fastest).toHaveLength(2); // 每个币种各一名
    const usd = rep.fastest.find((f) => f.currency === "USD");
    expect(usd?.accountId).toBe("acc-usd");
    expect(usd?.burnRate).toBeCloseTo(25, 10);
    expect(usd?.daysLeft).toBeCloseTo(2, 10);
    expect(rep.risk).toBe("err"); // daysLeft ≤ 3
    expect(fastestRisk(usd!)).toBe("err");
  });

  it("daysLeft 7 → warn、3 → err、> 7 → ok", () => {
    const f = (daysLeft: number | null) => ({
      accountId: "a",
      accountName: "A",
      currency: "USD",
      burnRate: 10,
      daysLeft,
      currentBalance: daysLeft === null ? null : daysLeft * 10,
    });
    expect(fastestRisk(f(7))).toBe("warn");
    expect(fastestRisk(f(3))).toBe("err");
    expect(fastestRisk(f(7.1))).toBe("ok");
    expect(fastestRisk(f(null))).toBe("ok");
  });

  it("摘要文案包含账号名、日均消耗与可支撑天数", () => {
    const rep = report([
      snap("acc-usd", "2026-06-10T12:00:00.000Z", 100),
      snap("acc-usd", "2026-06-12T12:00:00.000Z", 50),
    ]);
    const text = fastestSummaryText(rep.fastest[0]);
    expect(text).toContain("「美元账号」消耗最快");
    expect(text).toContain("USD/天");
    expect(text).toContain("2.0 天");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("Infinity");
  });

  it("全部组都无法计算时 fastest 为空、hasData 仍为 true（有快照但样本不足）", () => {
    const rep = report([snap("acc-usd", "2026-06-14T12:00:00.000Z", 10)]);
    expect(rep.fastest).toEqual([]);
    expect(rep.risk).toBe("ok");
    expect(rep.hasData).toBe(true);
  });
});

describe("insights：展示格式化", () => {
  it("formatDaysLeft 按文档规则分档", () => {
    expect(formatDaysLeft(null)).toBe("—");
    expect(formatDaysLeft(0.4)).toBe("< 1 天");
    expect(formatDaysLeft(2.25)).toBe("2.3 天");
    expect(formatDaysLeft(9.96)).toBe("10.0 天");
    expect(formatDaysLeft(12.4)).toBe("12 天");
  });

  it("formatBurnRate 对 null/负数/非有限值回退占位符", () => {
    expect(formatBurnRate(null)).toBe("—");
    expect(formatBurnRate(Number.NaN)).toBe("—");
    expect(formatBurnRate(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatBurnRate(-1)).toBe("—");
    expect(formatBurnRate(45)).toBe("45.00");
    expect(formatBurnRate(0.0125)).toBe("0.0125");
  });
});

describe("insights：统计范围与刷新失败", () => {
  it("只统计传入的账号；成功与失败账号快照都不影响彼此", () => {
    const snaps = [
      snap("acc-usd", "2026-06-10T12:00:00.000Z", 100, "USD"),
      snap("acc-usd", "2026-06-12T12:00:00.000Z", 60, "USD"),
      snap("acc-cny", "2026-06-10T12:00:00.000Z", 100, "CNY"),
      snap("acc-cny", "2026-06-12T12:00:00.000Z", 100, "CNY"),
    ];
    const rep = buildInsightReport(snaps, [ok("acc-usd"), ok("acc-cny")], {
      now: NOW,
      names: NAMES,
      accountIds: ["acc-usd"],
    });
    expect(rep.accounts).toHaveLength(1);
    expect(rep.accounts[0].accountId).toBe("acc-usd");
    expect(rep.accounts[0].burnRate).toBeCloseTo(20, 10);
  });

  it("D-2/AC-5：刷新失败的账号不产生洞察、不上「消耗最快」、不进 projections", () => {
    const snaps = [
      // 失败账号：2 天降 50 → 若未被过滤会算出 25/天并抢走「最快」
      snap("bad", "2026-06-10T12:00:00.000Z", 100, "USD"),
      snap("bad", "2026-06-12T12:00:00.000Z", 50, "USD"),
      // 正常账号：2 天降 20 → 10/天
      snap("good", "2026-06-10T12:00:00.000Z", 100, "USD"),
      snap("good", "2026-06-12T12:00:00.000Z", 80, "USD"),
    ];
    const outcomes: RefreshOutcome[] = [ok("good"), { accountId: "bad", ok: false, info: null, error: "HTTP 500" }];
    const rep = buildInsightReport(snaps, outcomes, { now: NOW, names: NAMES });

    // accounts：只有 good，且速率是 good 自己的 10/天（未被 bad 的数据污染）
    expect(rep.accounts.map((a) => a.accountId)).toEqual(["good"]);
    expect(rep.accounts[0].burnRate).toBeCloseTo(10, 10);
    // fastest：不得是 bad
    expect(rep.fastest.map((f) => f.accountId)).toEqual(["good"]);
    expect(rep.fastest[0].burnRate).toBeCloseTo(10, 10);
    // projections 的门数只统计 good（accountCount=1）
    expect(rep.projections).toHaveLength(1);
    expect(rep.projections[0].accountCount).toBe(1);
    // skipped：失败账号不产生任何条目
    expect(rep.skipped.some((s) => s.accountId === "bad")).toBe(false);
    // 序列化后整体不含 bad
    expect(JSON.stringify(rep)).not.toContain('"bad"');
  });

  it("D-2 边界：未提供 outcomes（纯快照驱动）时不做失败过滤", () => {
    const snaps = [
      snap("acc-usd", "2026-06-10T12:00:00.000Z", 100, "USD"),
      snap("acc-usd", "2026-06-12T12:00:00.000Z", 80, "USD"),
    ];
    const rep = buildInsightReport(snaps, [], { now: NOW, names: NAMES });
    expect(rep.accounts.map((a) => a.accountId)).toEqual(["acc-usd"]);
    expect(rep.accounts[0].burnRate).toBeCloseTo(10, 10);
  });

  it("D-2 边界：显式 accountIds 里含失败账号时同样被排除", () => {
    const snaps = [
      snap("good", "2026-06-10T12:00:00.000Z", 100, "USD"),
      snap("good", "2026-06-12T12:00:00.000Z", 80, "USD"),
      snap("bad", "2026-06-10T12:00:00.000Z", 100, "USD"),
      snap("bad", "2026-06-12T12:00:00.000Z", 10, "USD"),
    ];
    const rep = buildInsightReport(
      snaps,
      [ok("good"), { accountId: "bad", ok: false, info: null, error: "boom" }],
      { now: NOW, names: NAMES, accountIds: ["good", "bad"] },
    );
    expect(rep.accounts.map((a) => a.accountId)).toEqual(["good"]);
    expect(rep.fastest.map((f) => f.accountId)).toEqual(["good"]);
  });

  it("注入的 now 决定窗口：窗口外快照被排除", () => {
    const snaps = [
      snap("acc-usd", "2026-05-01T12:00:00.000Z", 1000, "USD"),
      snap("acc-usd", "2026-05-31T12:00:00.000Z", 700, "USD"),
    ];
    const wide = report(snaps, [], NOW, 90);
    expect(wide.accounts[0].snapshotCount).toBe(2);
    const narrow = report(snaps, [], NOW, 14);
    expect(narrow.accounts[0].snapshotCount).toBe(0);
    expect(narrow.accounts[0].burnRate).toBeNull();
  });

  it("快照余额或时间戳非法时被丢弃，不会污染结果", () => {
    const bad = [
      { ts: "not-a-date", accountId: "acc-usd", balance: 10, currency: "USD" },
      { ts: "2026-06-10T12:00:00.000Z", accountId: "acc-usd", balance: Number.NaN, currency: "USD" },
      snap("acc-usd", "2026-06-10T12:00:00.000Z", 100, "USD"),
      snap("acc-usd", "2026-06-12T12:00:00.000Z", 50, "USD"),
    ] as BalanceSnapshot[];
    const rep = report(bad);
    expect(rep.accounts[0].burnRate).toBeCloseTo(25, 10);
    expect(rep.accounts[0].snapshotCount).toBe(2);
  });

  it("结果整体可 JSON 序列化（不残留 NaN/Infinity）", () => {
    const rep = report([
      snap("acc-usd", "2026-06-10T12:00:00.000Z", 100, "USD"),
      snap("acc-usd", "2026-06-12T12:00:00.000Z", 0, "USD"),
    ]);
    const json = JSON.stringify(rep);
    expect(json).not.toContain("null,null"); // 粗略守卫：字段未出现成对空值
    expect(json).not.toContain("NaN");
    expect(JSON.parse(json)).toEqual(rep);
    // 余额归零 → 可支撑 0 天且不产生 Infinity
    expect(rep.accounts[0].daysLeft).toBe(0);
  });
});

describe("insights：类型契约", () => {
  it("报告与设置字段类型可用（编译期契约的运行时锚点）", () => {
    const settings: Settings = {
      autoRefreshSec: 60,
      refreshOnStart: true,
      notifyEnabled: false,
      notifyLowBalanceUsd: 3,
      notifyLowBalanceCny: 20,
      notifyQuotaPercent: 90,
      insightWindowDays: 21,
    };
    const config: AppConfig = { version: 1, settings, accounts: [] };
    expect(config.settings.insightWindowDays).toBe(21);
    expect(resolveInsightWindowDays(settings)).toBe(21);
  });
});
