// R15 本地用量历史批次生成单测。口径见 docs/round-15-plan.md §1.2（A/B1/B2）与 §1.3（键与覆盖）。
// 时区纪律：日期键断言一律基于「带显式偏移的 ISO 串」或纯 "YYYY-MM-DD"，与本机时区无关。

import { describe, expect, it } from "vitest";
import {
  buildUsageBatch,
  emptyUsageHistory,
  fiatRecords,
  hasUsageChanges,
  isEmptyUsageRow,
  isValidDateKey,
  localDateKey,
  localRecordsFromUsedCounter,
  mergeUsageRecords,
  mergedView,
  recordKey,
  sameUsageRecords,
  siteCurrency,
  siteRecordsFromOutcomes,
  totalTokens,
} from "./usageHistory";
import type { RefreshOutcome, UsageRecord } from "./types";

const UPDATED = "2026-06-15T10:00:00.000Z";

function info(patch: Partial<NonNullable<RefreshOutcome["info"]>> = {}): NonNullable<RefreshOutcome["info"]> {
  return {
    balance: null,
    used: null,
    total: null,
    requests: null,
    note: null,
    extras: [],
    raw: null,
    fetchedAt: UPDATED,
    ...patch,
  };
}

function outcome(accountId: string, patch: Partial<NonNullable<RefreshOutcome["info"]>> = {}): RefreshOutcome {
  return { accountId, ok: true, info: info(patch), error: null };
}

function localRec(accountId: string, date: string, cost: number, patch: Partial<UsageRecord> = {}): UsageRecord {
  return {
    accountId,
    date,
    cost,
    currency: "USD",
    requests: null,
    inputTokens: null,
    outputTokens: null,
    tokens: null,
    usedTotal: null,
    source: "local",
    updatedAt: UPDATED,
    ...patch,
  };
}

describe("usageHistory：日期键（时区无关）", () => {
  it("localDateKey 对带偏移的 ISO 串取「自身时区」的日历日", () => {
    expect(localDateKey("2026-06-15T10:00:00.000Z")).toBe("2026-06-15");
    expect(localDateKey("2026-06-15T00:30:00+08:00")).toBe("2026-06-15");
    expect(localDateKey("2026-06-15T23:30:00-11:00")).toBe("2026-06-15");
    expect(localDateKey("2026-06-15T23:59:59+02:00")).toBe("2026-06-15");
    expect(localDateKey("2026-06-15")).toBe("2026-06-15");
    expect(localDateKey("")).toBe("");
    expect(localDateKey(null)).toBe("");
    expect(localDateKey("乱码")).toBe("");
  });

  it("isValidDateKey 拒绝非法日期与格式", () => {
    expect(isValidDateKey("2026-06-15")).toBe(true);
    expect(isValidDateKey("2026-02-29")).toBe(false); // 2026 非闰年
    expect(isValidDateKey("2024-02-29")).toBe(true);
    expect(isValidDateKey("2026-13-01")).toBe(false);
    expect(isValidDateKey("2026-06-31")).toBe(false);
    expect(isValidDateKey("2026-6-5")).toBe(false);
    expect(isValidDateKey("")).toBe(false);
  });

  it("totalTokens 与 reportCsv 同口径", () => {
    expect(totalTokens({ tokens: 100, inputTokens: 1, outputTokens: 2 })).toBe(100);
    expect(totalTokens({ tokens: null, inputTokens: 10, outputTokens: 5 })).toBe(15);
    expect(totalTokens({ tokens: null, inputTokens: 10, outputTokens: null })).toBe(10);
    expect(totalTokens({ tokens: null, inputTokens: null, outputTokens: null })).toBeNull();
  });
});

describe("usageHistory：§1.2 A 站点行", () => {
  it("每个 dailyUsage 日期产出一行，字段原样带上，source=site", () => {
    const rows = siteRecordsFromOutcomes(
      [
        outcome("a1", {
          balance: { amount: 10, currency: "USD" },
          dailyUsage: [
            { date: "2026-06-14", cost: 1.5, costUnit: "USD", requests: 3, inputTokens: 10, outputTokens: 5 },
            { date: "2026-06-15", cost: 2, costUnit: "USD", tokens: 99 },
          ],
        }),
      ],
      UPDATED,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      accountId: "a1",
      date: "2026-06-14",
      cost: 1.5,
      currency: "USD",
      requests: 3,
      inputTokens: 10,
      outputTokens: 5,
      tokens: null,
      usedTotal: null,
      source: "site",
      updatedAt: UPDATED,
    });
    expect(rows[1].tokens).toBe(99);
  });

  it("币种回退：非法币 costUnit（%）→ 余额币种 → UNKNOWN", () => {
    expect(siteCurrency("%", "CNY")).toBe("CNY");
    expect(siteCurrency(null, "CNY")).toBe("CNY");
    expect(siteCurrency("", "USD")).toBe("USD");
    expect(siteCurrency("usd", null)).toBe("USD");
    expect(siteCurrency("%", null)).toBe("UNKNOWN");
    expect(siteCurrency(null, null)).toBe("UNKNOWN");
  });

  it("credits 行照常写入（§1.6：记录保留，只在分析口径排除）", () => {
    const rows = siteRecordsFromOutcomes(
      [outcome("kimi", { dailyUsage: [{ date: "2026-06-15", cost: 5, costUnit: "credits" }] })],
      UPDATED,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].currency).toBe("CREDITS");
    expect(fiatRecords(rows)).toEqual([]); // 但法币口径会排除
  });

  it("刷新失败（ok=false / info 缺失）不产出行；非法日期被丢弃；全空行也不产出（AC-3）", () => {
    const rows = siteRecordsFromOutcomes(
      [
        { accountId: "bad", ok: false, info: null, error: "HTTP 500" },
        // 「仅 cost=null」与「全字段 null」都是无信息行 → 按 AC-3「空日不写」跳过
        outcome("a1", { dailyUsage: [{ date: "乱码", cost: 5 }, { date: "2026-06-15", cost: null }] }),
      ],
      UPDATED,
    );
    expect(rows).toEqual([]);
  });

  it("AC-3 空日不写：全空行（六字段皆 null）跳过，有任一字段有值则保留", () => {
    const rows = siteRecordsFromOutcomes(
      [
        outcome("a1", {
          dailyUsage: [
            // ① 全空占位行 → 跳过
            { date: "2026-06-10" },
            { date: "2026-06-11", cost: null, requests: null, tokens: null, inputTokens: null, outputTokens: null },
            // ② 仅 requests 有值 → 保留
            { date: "2026-06-12", requests: 3 },
            // ③ 仅 tokens 有值 → 保留
            { date: "2026-06-13", tokens: 100 },
            // ④ 仅 cost 有值（0 也算有值）→ 保留
            { date: "2026-06-14", cost: 0 },
            // ⑤ 仅 inputTokens 有值 → 保留
            { date: "2026-06-15", inputTokens: 7 },
          ],
        }),
      ],
      UPDATED,
    );
    expect(rows.map((r) => r.date)).toEqual(["2026-06-12", "2026-06-13", "2026-06-14", "2026-06-15"]);
    // 全空行绝不会被当成「有记录日、cost=0」污染异常日中位数
    expect(rows.some((r) => r.date === "2026-06-10" || r.date === "2026-06-11")).toBe(false);
  });

  it("AC-3：全空行不影响批次生成（buildUsageBatch 不落盘全空站点行）", () => {
    const batch = buildUsageBatch(
      [
        outcome("a1", {
          dailyUsage: [
            // 同一日期两条：全空行 + 仅 requests 行 → 只保留后者
            { date: "2026-06-15" },
            { date: "2026-06-15", requests: 1 },
          ],
        }),
      ],
      [],
      ["a1"],
      UPDATED,
    );
    expect(batch.records).toHaveLength(1);
    expect(batch.records[0].requests).toBe(1);
  });

  it("isEmptyUsageRow 精确判定：只有六字段全 null 才算空；usedTotal 有值不算空", () => {
    const empty = {
      cost: null,
      requests: null,
      tokens: null,
      inputTokens: null,
      outputTokens: null,
      usedTotal: null,
    };
    expect(isEmptyUsageRow(empty)).toBe(true);
    expect(isEmptyUsageRow({ ...empty, cost: 0 })).toBe(false);
    expect(isEmptyUsageRow({ ...empty, requests: 0 })).toBe(false);
    expect(isEmptyUsageRow({ ...empty, tokens: 0 })).toBe(false);
    expect(isEmptyUsageRow({ ...empty, inputTokens: 0 })).toBe(false);
    expect(isEmptyUsageRow({ ...empty, outputTokens: 0 })).toBe(false);
    expect(isEmptyUsageRow({ ...empty, usedTotal: 0 })).toBe(false);
  });

  it("AC-9 关键约束：仅 usedTotal 有值的 B2 基准行仍然写入（首次观察）", () => {
    const rows = localRecordsFromUsedCounter(
      [outcome("kimi", { used: { amount: 1000, currency: "CREDITS" }, balance: null })],
      [],
      UPDATED,
      "2026-06-15",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].usedTotal).toBe(1000);
    expect(rows[0].cost).toBe(0);
    expect(isEmptyUsageRow(rows[0])).toBe(false); // 不会被空行过滤掉
  });
});

describe("usageHistory：§1.2 B2 used 计数器法", () => {
  it("D-2：注入本地日历日后，B2 行日期就是该本地日（不受 UTC 日影响）", () => {
    // 2026-10-15T20:30Z 在 Asia/Shanghai（UTC+8）下的本地日历日是 10-16；
    // 修复前 B2 走 toISOString() 会得到 10-15（日归属错）。
    const rows = localRecordsFromUsedCounter(
      [outcome("kimi", { used: { amount: 1000, currency: "CREDITS" }, balance: null })],
      [],
      "2026-10-15T20:30:00.000Z",
      "2026-10-16",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe("2026-10-16");
    expect(rows[0].date).not.toBe("2026-10-15");
  });

  it("D-2：buildUsageBatch 透传 dateKey 给 B2（端到端本地日归属）", () => {
    const batch = buildUsageBatch(
      [outcome("kimi", { used: { amount: 1000, currency: "CREDITS" }, balance: null })],
      [],
      ["kimi"],
      "2026-10-15T20:30:00.000Z",
      "2026-10-16",
    );
    expect(batch.records).toHaveLength(1);
    expect(batch.records[0].date).toBe("2026-10-16");
    expect(batch.records[0].usedTotal).toBe(1000);
  });

  it("D-2 回退路径：未注入 dateKey 时按 updatedAt 的**显式偏移**取本地日（时区无关断言）", () => {
    // +08:00 的 04:30 → 本地日 2026-10-16（不经 toISOString()，所以与运行机器时区无关）
    const withOffset = localRecordsFromUsedCounter(
      [outcome("kimi", { used: { amount: 1000, currency: "CREDITS" }, balance: null })],
      [],
      "2026-10-16T04:30:00+08:00",
    );
    expect(withOffset[0].date).toBe("2026-10-16");
    // 无时区标识的本地时间串 → 按本机日历（与既有 localDateKey 语义一致）
    const localish = localRecordsFromUsedCounter(
      [outcome("kimi", { used: { amount: 1000, currency: "CREDITS" }, balance: null })],
      [],
      "2026-10-16T23:30:00",
    );
    expect(localish[0].date).toBe("2026-10-16");
  });

  it("首次观察（无 prior usedTotal）→ delta=0，cost=0，但仍写基准行供下次差分", () => {
    const rows = localRecordsFromUsedCounter(
      [outcome("kimi", { used: { amount: 1000, currency: "CREDITS" }, balance: null })],
      [],
      "2026-06-15T10:00:00+08:00",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: "2026-06-15", cost: 0, currency: "CREDITS", usedTotal: 1000, source: "local" });
  });

  it("AC-9：第二次 used 增长 1000→1200 → delta=200，写回 usedTotal=1200", () => {
    const existing = [localRec("kimi", "2026-06-14", 0, { currency: "CREDITS", usedTotal: 1000 })];
    const rows = localRecordsFromUsedCounter(
      [outcome("kimi", { used: { amount: 1200, currency: "CREDITS" }, balance: null })],
      existing,
      "2026-06-15T10:00:00+08:00",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].cost).toBe(200);
    expect(rows[0].usedTotal).toBe(1200);
  });

  it("重复刷新同一状态 → delta=0（幂等）", () => {
    const existing = [localRec("kimi", "2026-06-14", 0, { currency: "CREDITS", usedTotal: 1200 })];
    const rows = localRecordsFromUsedCounter(
      [outcome("kimi", { used: { amount: 1200, currency: "CREDITS" }, balance: null })],
      existing,
      "2026-06-15T10:00:00+08:00",
    );
    expect(rows[0].cost).toBe(0);
  });

  it("有 balance 的账号不走 used 法（走 B1）", () => {
    const rows = localRecordsFromUsedCounter(
      [outcome("a1", { used: { amount: 500, currency: "USD" }, balance: { amount: 10, currency: "USD" } })],
      [],
      "2026-06-15T10:00:00+08:00",
    );
    expect(rows).toEqual([]);
  });

  it("used 减少（重置）→ delta=0，不产生负花费", () => {
    const existing = [localRec("kimi", "2026-06-14", 0, { currency: "CREDITS", usedTotal: 2000 })];
    const rows = localRecordsFromUsedCounter(
      [outcome("kimi", { used: { amount: 100, currency: "CREDITS" }, balance: null })],
      existing,
      "2026-06-15T10:00:00+08:00",
    );
    expect(rows[0].cost).toBe(0);
  });

  it("同日已有 local 行 → cost = 已有 cost + delta（§1.2 B2）", () => {
    const existing = [
      localRec("kimi", "2026-06-15", 30, { currency: "CREDITS", usedTotal: 1000 }),
    ];
    const rows = localRecordsFromUsedCounter(
      [outcome("kimi", { used: { amount: 1050, currency: "CREDITS" }, balance: null })],
      existing,
      "2026-06-15T18:00:00+08:00",
    );
    expect(rows[0].cost).toBe(80); // 30 + 50
  });
});

describe("usageHistory：§1.3 合并优先级与幂等", () => {
  const site = (date: string, cost: number): UsageRecord => ({
    ...localRec("a1", date, cost),
    source: "site",
  });

  it("site 覆盖 local；local 永不覆盖 site", () => {
    const local = localRec("a1", "2026-06-15", 20);
    const fromSite = site("2026-06-15", 5);
    expect(mergeUsageRecords([local, fromSite])[0]).toMatchObject({ cost: 5, source: "site" });
    expect(mergeUsageRecords([fromSite, local])[0]).toMatchObject({ cost: 5, source: "site" });
  });

  it("local → site 升级（站点窗口后移补齐历史日）", () => {
    const local = localRec("a1", "2026-06-14", 20);
    const upgraded = site("2026-06-14", 7);
    const merged = mergedView([local, upgraded]);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe("site");
  });

  it("同 source 同键 → 新值覆盖旧值（同一天多次刷新只留最新）", () => {
    const merged = mergedView([localRec("a1", "2026-06-15", 20), localRec("a1", "2026-06-15", 30)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].cost).toBe(30);
  });

  it("不同账号同一日期互不影响（键含 accountId）", () => {
    const merged = mergedView([localRec("a1", "2026-06-15", 20), localRec("a2", "2026-06-15", 30)]);
    expect(merged).toHaveLength(2);
    expect(recordKey(merged[0])).not.toBe(recordKey(merged[1]));
  });

  it("非法日期键被丢弃", () => {
    expect(mergeUsageRecords([localRec("a1", "2026-6-5", 1), localRec("a1", "2026-02-30", 2)])).toEqual([]);
  });

  it("输出顺序稳定（账号、日期升序），便于幂等比较", () => {
    const merged = mergeUsageRecords([
      localRec("b", "2026-06-15", 1),
      localRec("a", "2026-06-15", 1),
      localRec("a", "2026-06-14", 1),
    ]);
    expect(merged.map((r) => `${r.accountId}/${r.date}`)).toEqual(["a/2026-06-14", "a/2026-06-15", "b/2026-06-15"]);
  });

  it("sameUsageRecords / hasUsageChanges 判定幂等", () => {
    const a = [localRec("a1", "2026-06-15", 20)];
    const b = [localRec("a1", "2026-06-15", 20, { updatedAt: "2026-06-15T23:00:00.000Z" })]; // 只差 updatedAt
    expect(sameUsageRecords(a, b)).toBe(true);
    expect(hasUsageChanges(b, a)).toBe(false);
    expect(hasUsageChanges([localRec("a1", "2026-06-15", 21)], a)).toBe(true);
    expect(hasUsageChanges([localRec("a1", "2026-06-16", 1)], a)).toBe(true);
  });
});

describe("usageHistory：批次生成 buildUsageBatch", () => {
  it("余额由后端入账，前端不再生成会覆盖完整累计的余额重算行", () => {
    const existing = [localRec("a1", "2026-06-15", 11)];
    const batch = buildUsageBatch([outcome("a1", { balance: { amount: 89, currency: "USD" }, used: { amount: 111, currency: "USD" } })], existing, ["a1"], UPDATED);
    expect(batch.records).toEqual([]);
    expect(hasUsageChanges(batch.records, existing)).toBe(false);
  });

  it("余额模式切回used时不复用更早的计数器，之后的增量仍正常累计", () => {
    const existing = [localRec("a1", "2026-06-15", 12, { usedTotal: 100, updatedAt: "2026-06-15T09:00:00Z" })];
    const since = new Map([["a1", "2026-06-15T10:00:00Z"]]);
    const first = buildUsageBatch([outcome("a1", { used: { amount: 103, currency: "USD" } })], existing, ["a1"], "2026-06-15T10:00:00Z", "2026-06-15", since);
    expect(first.records[0].cost).toBe(12);
    expect(first.records[0].usedTotal).toBe(103);
    const next = buildUsageBatch([outcome("a1", { used: { amount: 104, currency: "USD" } })], first.records, ["a1"], "2026-06-15T11:00:00Z", "2026-06-15", since);
    expect(next.records[0].cost).toBe(13);
  });

  it("后端基准未提交的失败轮次不能继续写used批次", () => {
    const result = { ...outcome("a1", { used: { amount: 110, currency: "USD" } }), historyError: "写入失败" };
    const batch = buildUsageBatch([result], [localRec("a1", "2026-06-15", 10, { usedTotal: 100 })], ["a1"], UPDATED);
    expect(batch.records).toEqual([]);
  });

  it("美元日累计不能在used切换后被改成同数额的CREDITS", () => {
    const existing = [localRec("a1", "2026-06-15", 10)];
    const batch = buildUsageBatch([outcome("a1", { used: { amount: 200, currency: "CREDITS" } })], existing, ["a1"], UPDATED, "2026-06-15", new Map([["a1", UPDATED]]));
    expect(batch.records).toEqual([]);
    expect(mergeUsageRecords([...existing, ...batch.records])[0]).toMatchObject({ cost: 10, currency: "USD" });
  });

  it("used模式用精确标识区分同毫秒的纳秒边界，首次观察后正常递增", () => {
    const since = "2026-06-15T10:00:00.000000003Z";
    const existing = [localRec("a1", "2026-06-15", 12, { usedTotal: 100, updatedAt: "2026-06-15T10:00:00.000000001Z" })];
    const map = new Map([["a1", since]]);
    const first = buildUsageBatch([outcome("a1", { used: { amount: 103, currency: "USD" } })], existing, ["a1"], "2026-06-15T10:00:00.000Z", "2026-06-15", map);
    expect(first.records[0]).toMatchObject({ cost: 12, usedTotal: 103, usedModeSince: since });
    const next = buildUsageBatch([outcome("a1", { used: { amount: 104, currency: "USD" } })], first.records, ["a1"], "2026-06-15T10:00:00.001Z", "2026-06-15", map);
    expect(next.records[0].cost).toBe(13);
    const markerOnly = buildUsageBatch([outcome("a1", { used: { amount: 100, currency: "USD" } })], existing, ["a1"], UPDATED, "2026-06-15", map);
    expect(hasUsageChanges(markerOnly.records, existing)).toBe(true);
    const saved = mergeUsageRecords([...existing, ...markerOnly.records]);
    const increment = buildUsageBatch([outcome("a1", { used: { amount: 101, currency: "USD" } })], saved, ["a1"], UPDATED, "2026-06-15", map);
    expect(increment.records[0].cost).toBe(13);
    expect(hasUsageChanges(next.records, next.records)).toBe(false);
  });

  it("前端生成站点行，余额差分由后端独立入账", () => {
    const batch = buildUsageBatch(
      [
        outcome("a1", {
          balance: { amount: 50, currency: "USD" },
          dailyUsage: [{ date: "2026-06-15", cost: 5, costUnit: "USD", requests: 2 }],
        }),
      ],
      [],
      ["a1"],
      UPDATED,
    );
    expect(batch.records).toHaveLength(1);
    expect(batch.records[0]).toMatchObject({ date: "2026-06-15", cost: 5, source: "site" });
  });

  it("只处理传入的 accountIds（启用账号），未列入者不产出行", () => {
    const batch = buildUsageBatch(
      [outcome("a1", { dailyUsage: [{ date: "2026-06-15", cost: 5, costUnit: "USD" }] }), outcome("gone", { dailyUsage: [{ date: "2026-06-15", cost: 9, costUnit: "USD" }] })],
      [],
      ["a1"],
      UPDATED,
    );
    expect(batch.records.map((r) => r.accountId)).toEqual(["a1"]);
  });

  it("余额法与 used 法同日合并：cost 相加", () => {
    const rows = buildUsageBatch(
      [outcome("a1", { used: { amount: 150, currency: "CREDITS" }, balance: null })],
      [localRec("a1", "2026-06-15", 30, { currency: "CREDITS", usedTotal: 100 })],
      ["a1"],
      "2026-06-15T10:00:00+08:00",
    );
    // used 法：delta = 150−100 = 50；已有同日 local 30 → 80
    expect(rows.records).toHaveLength(1);
    expect(rows.records[0].cost).toBe(80);
  });

  it("无任何数据的账号进入 skipped(noData)，不影响其他账号", () => {
    const batch = buildUsageBatch(
      [outcome("a1", { dailyUsage: [{ date: "2026-06-15", cost: 1, costUnit: "USD" }] })],
      [],
      ["a1", "empty-acc"],
      UPDATED,
    );
    expect(batch.records).toHaveLength(1);
    expect(batch.skipped).toEqual([{ accountId: "empty-acc", reason: "noData" }]);
  });

  it("空输入 → 空批次，不崩", () => {
    const batch = buildUsageBatch([], [], [], UPDATED);
    expect(batch.records).toEqual([]);
    expect(batch.skipped).toEqual([]);
  });

  it("AC-3 幂等：同一状态连续生成两次 → 记录等价（不做无意义写盘）", () => {
    const outcomes = [
      outcome("a1", {
        balance: { amount: 70, currency: "USD" },
        dailyUsage: [{ date: "2026-06-15", cost: 5, costUnit: "USD" }],
      }),
    ];
    const first = buildUsageBatch(outcomes, [], ["a1"], UPDATED);
    const second = buildUsageBatch(outcomes, first.records, ["a1"], UPDATED);
    expect(sameUsageRecords(first.records, second.records)).toBe(true);
    expect(hasUsageChanges(second.records, first.records)).toBe(false);
  });

  it("emptyUsageHistory 返回空封套", () => {
    expect(emptyUsageHistory()).toEqual({ version: 1, records: [] });
  });
});
