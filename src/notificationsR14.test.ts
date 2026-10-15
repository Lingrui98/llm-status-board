import { describe, expect, it } from "vitest";
import type { AccountInfo, AppConfig, RefreshOutcome, Settings } from "./types";
import {
  DEFAULT_NOTIFY_THRESHOLDS,
  balanceThresholdFor,
  computeProblemNotifications,
  diffRecovered,
  filterAlertsDisabled,
  isAlertKind,
  isNotifyEnabled,
  resolveAlertSettings,
  resolveNotifyThresholds,
} from "./notifications";

const NOW = "2026-10-10T12:00:00.000Z";

function settings(patch: Partial<Settings> = {}): Settings {
  return { autoRefreshSec: 0, refreshOnStart: false, ...patch };
}

function makeInfo(patch: Partial<AccountInfo> = {}): AccountInfo {
  return {
    balance: null,
    used: null,
    total: null,
    requests: null,
    note: null,
    extras: [],
    raw: null,
    fetchedAt: NOW,
    ...patch,
  };
}

function okOutcome(accountId: string, info: Partial<AccountInfo> = {}): RefreshOutcome {
  return { accountId, ok: true, info: makeInfo(info), error: null };
}

describe("R14 阈值解析（旧配置兼容）", () => {
  it("缺字段的旧配置回退默认值", () => {
    expect(resolveNotifyThresholds(settings())).toEqual(DEFAULT_NOTIFY_THRESHOLDS);
    expect(resolveNotifyThresholds(null)).toEqual(DEFAULT_NOTIFY_THRESHOLDS);
    expect(resolveNotifyThresholds(undefined)).toEqual(DEFAULT_NOTIFY_THRESHOLDS);
    // null 与 undefined 同义（Rust Option 反序列化为 null）
    expect(
      resolveNotifyThresholds(settings({ notifyLowBalanceUsd: null, notifyLowBalanceCny: null, notifyQuotaPercent: null })),
    ).toEqual(DEFAULT_NOTIFY_THRESHOLDS);
  });

  it("配置值覆盖默认值", () => {
    expect(
      resolveNotifyThresholds(
        settings({ notifyLowBalanceUsd: 10, notifyLowBalanceCny: 70, notifyQuotaPercent: 60 }),
      ),
    ).toEqual({ lowBalanceUsd: 10, lowBalanceCny: 70, quotaPercent: 60 });
  });

  it("非法值（负数/超界/NaN）回退默认，不产生不可用阈值", () => {
    expect(resolveNotifyThresholds(settings({ notifyLowBalanceUsd: -1 })).lowBalanceUsd).toBe(1);
    expect(resolveNotifyThresholds(settings({ notifyLowBalanceUsd: 99999 })).lowBalanceUsd).toBe(1);
    expect(resolveNotifyThresholds(settings({ notifyLowBalanceUsd: Number.NaN })).lowBalanceUsd).toBe(1);
    expect(resolveNotifyThresholds(settings({ notifyQuotaPercent: 0 })).quotaPercent).toBe(85);
    expect(resolveNotifyThresholds(settings({ notifyQuotaPercent: 120 })).quotaPercent).toBe(85);
  });

  it("提醒总开关缺省视为开启；insightWindowDays 缺省 14", () => {
    expect(isNotifyEnabled(settings())).toBe(true);
    expect(isNotifyEnabled(null)).toBe(true);
    expect(isNotifyEnabled(settings({ notifyEnabled: false }))).toBe(false);
    const resolved = resolveAlertSettings(settings());
    expect(resolved.enabled).toBe(true);
    expect(resolved.insightWindowDays).toBe(14);
    expect(resolveAlertSettings(settings({ insightWindowDays: 30 })).insightWindowDays).toBe(30);
    expect(resolveAlertSettings(settings({ insightWindowDays: 1 })).insightWindowDays).toBe(14);
  });

  it("余额阈值按币种选择：CNY 集走 CNY 阈值，credits 返回 null", () => {
    const t = { lowBalanceUsd: 10, lowBalanceCny: 70, quotaPercent: 85 };
    expect(balanceThresholdFor("USD", t)).toBe(10);
    expect(balanceThresholdFor("EUR", t)).toBe(10);
    expect(balanceThresholdFor("cny", t)).toBe(70);
    expect(balanceThresholdFor("RMB", t)).toBe(70);
    expect(balanceThresholdFor("credits", t)).toBeNull();
    expect(balanceThresholdFor("", t)).toBe(10); // 未知币种按法币处理
  });

  it("配置类型可用于 AppConfig（编译期契约的运行时锚点）", () => {
    const config: AppConfig = {
      version: 1,
      settings: settings({
        notifyEnabled: false,
        notifyLowBalanceUsd: 2,
        notifyLowBalanceCny: 15,
        notifyQuotaPercent: 90,
        insightWindowDays: 7,
      }),
      accounts: [],
    };
    expect(resolveAlertSettings(config.settings)).toEqual({
      lowBalanceUsd: 2,
      lowBalanceCny: 15,
      quotaPercent: 90,
      enabled: false,
      insightWindowDays: 7,
    });
  });
});

describe("R14 阈值即时生效（AC-6 / AC-7）", () => {
  it("USD 阈值 1→10 后，余额 5 的账号立即产生「余额不足」", () => {
    const outcomes = [okOutcome("acc-5usd", { balance: { amount: 5, currency: "USD" } })];
    const before = computeProblemNotifications(outcomes, {}, DEFAULT_NOTIFY_THRESHOLDS, NOW);
    expect(before.notifications).toHaveLength(0); // 5 ≥ 1 → 不提醒

    const after = computeProblemNotifications(
      outcomes,
      {},
      resolveNotifyThresholds(settings({ notifyLowBalanceUsd: 10 })),
      NOW,
    );
    expect(after.notifications.map((n) => n.id)).toEqual(["lowBalance:acc-5usd"]);
    expect(after.notifications[0].detail).toContain("当前余额 5.00 USD");
    expect(after.notifications[0].detail).toContain("10.00 USD");
  });

  it("CNY 阈值独立生效，不随 USD 阈值漂移", () => {
    const outcomes = [okOutcome("acc-cny", { balance: { amount: 5, currency: "CNY" } })];
    const t = resolveNotifyThresholds(settings({ notifyLowBalanceUsd: 10, notifyLowBalanceCny: 1 }));
    const result = computeProblemNotifications(outcomes, {}, t, NOW);
    expect(result.notifications).toHaveLength(0); // 5 ≥ CNY 阈值 1
  });

  it("配额阈值可配置：90 时 85% 不触发、85 时触发", () => {
    const outcomes = [okOutcome("acc-q", { quotaWindows: [{ window: "5h", usedPercent: 85, resetsAt: null }] })];
    expect(computeProblemNotifications(outcomes, {}, { lowBalanceUsd: 1, lowBalanceCny: 7, quotaPercent: 90 }, NOW).notifications).toHaveLength(0);
    expect(computeProblemNotifications(outcomes, {}, { lowBalanceUsd: 1, lowBalanceCny: 7, quotaPercent: 85 }, NOW).notifications).toHaveLength(1);
  });

  it("总开关关闭：丢弃 lowBalance/quotaFull 及其问题键，refreshError 保留（AC-7）", () => {
    const outcomes = [
      okOutcome("acc-low", {
        balance: { amount: 0.5, currency: "USD" },
        quotaWindows: [{ window: "5h", usedPercent: 99, resetsAt: null }],
      }),
      { accountId: "acc-fail", ok: false, info: null, error: "HTTP 500" },
    ];
    const raw = computeProblemNotifications(outcomes, {}, DEFAULT_NOTIFY_THRESHOLDS, NOW);
    expect(raw.notifications.map((n) => n.kind).sort()).toEqual(["lowBalance", "quotaFull", "refreshError"]);
    expect(raw.problemKeys.size).toBe(3);

    const filtered = filterAlertsDisabled(raw);
    expect(filtered.notifications.map((n) => n.kind)).toEqual(["refreshError"]);
    expect([...filtered.problemKeys]).toEqual(["refreshError:acc-fail"]);
    // 恢复检测以问题键为基准：提醒类问题键不能残留，否则重新开启开关会凭空冒出「已恢复」
    expect(filtered.problemKeys.has("lowBalance:acc-low")).toBe(false);
    expect(filtered.problemKeys.has("quotaFull:acc-low")).toBe(false);
  });
});

describe("R14 D-3：关闭总开关不产生「已恢复」", () => {
  const okIds = new Set(["acc-low", "acc-fail"]);
  const names = { "acc-low": "低余额账号", "acc-fail": "失败账号" };

  it("恢复检测的 shouldRecover 判定可排除提醒类（refreshError 照旧）", () => {
    const prev = new Set(["lowBalance:acc-low", "quotaFull:acc-low", "refreshError:acc-fail"]);
    const cur = new Set<string>(); // 本轮全部消失

    // 关开关：只允许非提醒类（refreshError）产生「已恢复」
    const disabled = diffRecovered(prev, cur, okIds, names, NOW, (kind) => !isAlertKind(kind));
    expect(disabled.map((n) => n.id)).toEqual(["recovered:refreshError:acc-fail"]);
    expect(disabled.some((n) => n.id.includes("lowBalance") || n.id.includes("quotaFull"))).toBe(false);

    // 开开关（默认判定）：三类都能恢复，行为与旧版一致
    const enabled = diffRecovered(prev, cur, okIds, names, NOW);
    expect(enabled).toHaveLength(3);
  });

  it("isAlertKind 只把 lowBalance / quotaFull 视为提醒，recovered 与 refreshError 不受开关影响", () => {
    expect(isAlertKind("lowBalance")).toBe(true);
    expect(isAlertKind("quotaFull")).toBe(true);
    expect(isAlertKind("refreshError")).toBe(false);
    expect(isAlertKind("recovered")).toBe(false);
  });

  it("完整复现（Lead 的 D-3 场景）：阈值 10、余额 5 → 首轮产出 lowBalance；关开关后重算不产生任何 recovered", () => {
    const outcomes = [okOutcome("ds", { balance: { amount: 5, currency: "USD" } })];
    const thresholds = resolveNotifyThresholds(settings({ notifyLowBalanceUsd: 10 }));

    // 首轮（开关开）：产生 lowBalance 问题键
    const round1 = computeProblemNotifications(outcomes, {}, thresholds, NOW);
    const round1Keys = round1.problemKeys;
    expect([...round1Keys]).toEqual(["lowBalance:ds"]);

    // 关开关后重算：filterAlertsDisabled 清掉提醒类问题键
    const round2 = filterAlertsDisabled(computeProblemNotifications(outcomes, {}, thresholds, NOW));
    expect([...round2.problemKeys]).toEqual([]);

    // 恢复检测：关开关时提醒类不得产生「已恢复」
    const spurious = diffRecovered(round1Keys, round2.problemKeys, new Set(["ds"]), {}, NOW, (kind) => !isAlertKind(kind));
    expect(spurious).toEqual([]);
  });
});
